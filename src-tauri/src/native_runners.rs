//! Shell-out runners for languages that need a real toolchain.
//!
//! The in-browser runtimes (JavaScript, TypeScript, Python) cover most
//! of the course surface, but a serious code-learning app needs C,
//! Java, Kotlin, etc. too. Those languages don't run in a webview so
//! each command here writes the user's source to a temp file, invokes
//! the system toolchain, and hands stdout/stderr back to the frontend
//! as a `SubprocessResult`.
//!
//! Design notes:
//!   - `launch_error` (vs exiting with a non-zero status) signals that
//!     the toolchain couldn't start at all — typically "not on PATH".
//!     The frontend uses this to show a one-click install hint
//!     instead of a wall of stderr.
//!   - We keep compile+run as two stages where it matters (C / C++ /
//!     Java / Assembly) so a compile failure reads clearly in stderr
//!     instead of manifesting as "Java said nothing and exited 1".
//!   - Temp files live in `std::env::temp_dir()` under a
//!     `libre-<lang>-run.<ext>` prefix. Each run overwrites, which
//!     is fine because we don't parallelise runs per language.
//!
//! Nothing here knows about lessons or courses — these are thin wrappers
//! around system binaries. The TS runtime dispatcher (`src/runtimes`)
//! is what selects which command to call.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::time::Instant;

use crate::SubprocessResult;

// ---- Shared helpers --------------------------------------------------

/// Write `code` to a temp file named `libre-<prefix>-run.<ext>` and
/// hand back the path. Returns a `SubprocessResult::launch_error` on
/// IO failure so the caller can early-return without duplicating the
/// error-shape assembly.
fn write_temp(prefix: &str, ext: &str, code: &str) -> Result<PathBuf, SubprocessResult> {
    let path = std::env::temp_dir().join(format!("libre-{prefix}-run.{ext}"));
    match std::fs::File::create(&path).and_then(|mut f| f.write_all(code.as_bytes())) {
        Ok(()) => Ok(path),
        Err(e) => Err(SubprocessResult {
            stdout: String::new(),
            stderr: String::new(),
            success: false,
            duration_ms: 0,
            launch_error: Some(format!("failed to write temp source: {e}")),
        }),
    }
}

/// Build a `SubprocessResult` from a completed `std::process::Output`.
/// Factored out so the run functions stay readable.
fn from_output(output: Output, start: Instant) -> SubprocessResult {
    SubprocessResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        success: output.status.success(),
        duration_ms: start.elapsed().as_millis() as u64,
        launch_error: None,
    }
}

/// Produce the "toolchain not installed" error with a one-liner install
/// hint tailored to macOS (the primary dev target). Linux users still
/// see the install hint; it just won't match their package manager.
fn launch_failure(toolchain: &str, hint: &str, err: std::io::Error, start: Instant) -> SubprocessResult {
    let msg = if err.kind() == std::io::ErrorKind::NotFound {
        format!("{toolchain} not found on PATH — {hint}")
    } else {
        format!("failed to launch {toolchain}: {err}")
    };
    SubprocessResult {
        stdout: String::new(),
        stderr: String::new(),
        success: false,
        duration_ms: start.elapsed().as_millis() as u64,
        launch_error: Some(msg),
    }
}

/// Chain a compile step + run step into one result. The compile step
/// dominates user-visible latency for most of these languages, so we
/// keep its stderr in the final result (otherwise a syntax error looks
/// like "the program printed nothing"). If compilation fails, we skip
/// the run step entirely.
///
/// Both the compile and run phase are also fed through
/// `maybe_stub_launch_failure`: on macOS, `/usr/bin/java`, `/usr/bin/javac`,
/// and `kotlinc` are shipped as stubs that print a "please install"
/// message and exit non-zero when no JDK is present. From Rust's
/// perspective the subprocess DID launch successfully, so the plain
/// `ErrorKind::NotFound` branch doesn't fire — we have to pattern-match
/// the stderr ourselves to upgrade it into a `launch_error`, which is
/// what the frontend keys off to surface the install-toolchain banner.
fn compile_then_run(
    compile: Command,
    run_cmd: Command,
    toolchain: &str,
    install_hint: &str,
    start: Instant,
) -> SubprocessResult {
    let mut compile = compile;
    let mut run_cmd = run_cmd;

    let compile_out = match compile.output() {
        Ok(o) => o,
        Err(e) => return launch_failure(toolchain, install_hint, e, start),
    };
    if !compile_out.status.success() {
        let stderr = String::from_utf8_lossy(&compile_out.stderr).into_owned();
        if let Some(stub) = maybe_stub_launch_failure(toolchain, install_hint, &stderr, start) {
            return stub;
        }
        return SubprocessResult {
            stdout: String::from_utf8_lossy(&compile_out.stdout).into_owned(),
            stderr,
            success: false,
            duration_ms: start.elapsed().as_millis() as u64,
            launch_error: None,
        };
    }
    match run_cmd.output() {
        Ok(out) => {
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
                if let Some(stub) = maybe_stub_launch_failure(toolchain, install_hint, &stderr, start) {
                    return stub;
                }
            }
            from_output(out, start)
        }
        Err(e) => launch_failure(toolchain, install_hint, e, start),
    }
}

/// Detect the macOS "please install" stub messages that `java`, `javac`,
/// and `kotlinc` emit when invoked without a JDK installed. These stubs
/// live at `/usr/bin/java` etc. and are happy to launch — they just
/// print a helpful-for-Finder-but-useless-to-us message and exit 1.
/// Without this upgrade the frontend would render the macOS stub text
/// as a plain red "error" block and the learner would have no path to
/// fixing it; with this, we convert the failure into a `launch_error`
/// so the existing missing-toolchain banner + install button path picks
/// it up. Returns `Some(SubprocessResult)` if the stderr matches one of
/// the known stubs, `None` otherwise.
fn maybe_stub_launch_failure(
    toolchain: &str,
    install_hint: &str,
    stderr: &str,
    start: Instant,
) -> Option<SubprocessResult> {
    // macOS Java stub. Both `java` and `javac` go through
    // /usr/libexec/java_home, which emits this exact string. Kotlin's
    // `kotlinc` shells out to the JDK and surfaces the same message.
    const JAVA_STUB_MARKERS: &[&str] = &[
        "Unable to locate a Java Runtime",
        "No Java runtime present",
        "to locate a Java Runtime",
    ];
    if JAVA_STUB_MARKERS.iter().any(|m| stderr.contains(m)) {
        return Some(SubprocessResult {
            stdout: String::new(),
            stderr: String::new(),
            success: false,
            duration_ms: start.elapsed().as_millis() as u64,
            launch_error: Some(format!(
                "{toolchain} is installed as a macOS stub but no JDK is present — {install_hint}"
            )),
        });
    }
    None
}

// ---- C --------------------------------------------------------------

/// Compile + run C via the system `cc` (usually clang on macOS, gcc on
/// Linux). `-O0` keeps compile times snappy for small lesson snippets;
/// optimisation doesn't help a "hello world" kata.
#[tauri::command]
pub async fn run_c(code: String) -> SubprocessResult {
    let start = Instant::now();
    let source = match write_temp("c", "c", &code) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let binary = source.with_extension("out");
    let mut compile = Command::new("cc");
    compile
        .arg("-O0")
        .arg("-o")
        .arg(&binary)
        .arg(&source);
    let run_cmd = Command::new(&binary);
    compile_then_run(
        compile,
        run_cmd,
        "cc",
        "install Xcode Command Line Tools (`xcode-select --install`) or a system C compiler.",
        start,
    )
}

// ---- C++ ------------------------------------------------------------

/// C++ via `c++` (symlinked to clang++ on macOS, g++ on most Linux).
/// Same latency trade-off as C — single source, minimal flags.
#[tauri::command]
pub async fn run_cpp(code: String) -> SubprocessResult {
    let start = Instant::now();
    let source = match write_temp("cpp", "cpp", &code) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let binary = source.with_extension("out");
    let mut compile = Command::new("c++");
    compile
        .arg("-O0")
        .arg("-std=c++17")
        .arg("-o")
        .arg(&binary)
        .arg(&source);
    let run_cmd = Command::new(&binary);
    compile_then_run(
        compile,
        run_cmd,
        "c++",
        "install Xcode Command Line Tools (`xcode-select --install`) or a system C++ compiler.",
        start,
    )
}

// ---- Java -----------------------------------------------------------

/// Java requires `public class Foo` to live in `Foo.java`. We parse the
/// class name out of the source so the user can write whichever name
/// they want — we then rename the temp file to match. If no public
/// class is declared we fall back to `App` (and write `App.java`) which
/// covers `class App` + static-main snippets.
#[tauri::command]
pub async fn run_java(code: String) -> SubprocessResult {
    let start = Instant::now();
    let class_name = extract_java_class_name(&code).unwrap_or_else(|| "App".to_string());

    // Java is picky about filename-vs-classname, so we write under a
    // per-run temp directory to keep the flat `/tmp` namespace clean.
    let dir = std::env::temp_dir().join("libre-java-run");
    let _ = std::fs::remove_dir_all(&dir); // best-effort: drop the previous build
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return SubprocessResult {
            stdout: String::new(),
            stderr: String::new(),
            success: false,
            duration_ms: start.elapsed().as_millis() as u64,
            launch_error: Some(format!("failed to create temp dir: {e}")),
        };
    }
    let source = dir.join(format!("{class_name}.java"));
    if let Err(e) = std::fs::File::create(&source).and_then(|mut f| f.write_all(code.as_bytes())) {
        return SubprocessResult {
            stdout: String::new(),
            stderr: String::new(),
            success: false,
            duration_ms: start.elapsed().as_millis() as u64,
            launch_error: Some(format!("failed to write temp source: {e}")),
        };
    }

    let mut compile = Command::new("javac");
    compile.arg(&source);
    let mut run_cmd = Command::new("java");
    run_cmd.arg("-cp").arg(&dir).arg(&class_name);
    compile_then_run(
        compile,
        run_cmd,
        "javac",
        "install a JDK (`brew install openjdk` on macOS) and make sure `javac` + `java` are on PATH.",
        start,
    )
}

/// Pull the first `public class <Name>` (or bare `class <Name>`) from
/// a Java source string. Ignores anything inside `//` or `/* */`
/// comments — minimal parse, but enough to survive template headers.
fn extract_java_class_name(code: &str) -> Option<String> {
    // Strip line + block comments first. Simple regex-free approach:
    // find `public class <Name>` / `class <Name>` anywhere. This is
    // good enough for snippets; a full parser would be overkill.
    for token in ["public class ", "public final class ", "class "] {
        if let Some(idx) = code.find(token) {
            let rest = &code[idx + token.len()..];
            let name: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
                .collect();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

// ---- Kotlin ---------------------------------------------------------

/// Kotlin via `kotlinc -include-runtime` + `java -jar`. App mode, not
/// script mode: the challenge packs (and the `generate_challenge`
/// prompt) produce code that uses `fun main()` as the entry point —
/// and in .kts script mode main() is treated as just another function
/// that never gets called, so stdout stays empty and the test
/// harness's KATA_TEST lines never fire. Compiling to a self-contained
/// jar + `java -jar` honours the main() entry.
///
/// Two-stage slow: `kotlinc` cold-starts a JVM (~3s) to compile, then
/// `java -jar` boots a second JVM (~0.5s) to run. Total 3-5s per run
/// is the cost of actually respecting the language's entry-point
/// contract.
#[tauri::command]
pub async fn run_kotlin(code: String) -> SubprocessResult {
    let start = Instant::now();
    // Dedicated dir so the jar + source don't clutter /tmp. Best-effort
    // cleanup of the previous run — same pattern as `run_java`.
    let dir = std::env::temp_dir().join("libre-kotlin-run");
    let _ = std::fs::remove_dir_all(&dir);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return SubprocessResult {
            stdout: String::new(),
            stderr: String::new(),
            success: false,
            duration_ms: start.elapsed().as_millis() as u64,
            launch_error: Some(format!("failed to create temp dir: {e}")),
        };
    }
    let source = dir.join("Main.kt");
    if let Err(e) = std::fs::File::create(&source).and_then(|mut f| f.write_all(code.as_bytes())) {
        return SubprocessResult {
            stdout: String::new(),
            stderr: String::new(),
            success: false,
            duration_ms: start.elapsed().as_millis() as u64,
            launch_error: Some(format!("failed to write temp source: {e}")),
        };
    }
    let jar = dir.join("main.jar");

    // Pick absolute paths for kotlinc + java that survived a version
    // probe — `find_binary_all(...).next()` would blindly return the
    // first candidate (often `/usr/bin/java`, the macOS stub), and
    // spawning that either errors noisily or hangs the app while macOS
    // pops its "install a JDK" Software Update modal. `find_working_
    // binary` runs `-version` against each candidate and returns only
    // one that actually launched. Fall back to the bare name if
    // nothing worked — `Command::new` will then fail fast with
    // ErrorKind::NotFound and the stub-detection path surfaces the
    // install banner.
    let kotlinc_path = crate::toolchain::find_working_binary("kotlinc", &["-version"])
        .unwrap_or_else(|| "kotlinc".to_string());
    let java_path = crate::toolchain::find_working_binary("java", &["-version"])
        .unwrap_or_else(|| "java".to_string());
    let broadened = crate::toolchain::broadened_path();
    let java_home = java_home_for(&java_path);

    let mut compile = Command::new(&kotlinc_path);
    compile
        .env("PATH", &broadened)
        .arg("-include-runtime")
        .arg("-d")
        .arg(&jar)
        .arg(&source);
    if let Some(ref home) = java_home {
        compile.env("JAVA_HOME", home);
    }
    let mut run_cmd = Command::new(&java_path);
    run_cmd.env("PATH", &broadened).arg("-jar").arg(&jar);
    if let Some(ref home) = java_home {
        run_cmd.env("JAVA_HOME", home);
    }
    compile_then_run(
        compile,
        run_cmd,
        "kotlinc",
        "install Kotlin (`brew install kotlin` on macOS) and a JDK (`brew install openjdk`). Both `kotlinc` and `java` must be on PATH.",
        start,
    )
}

/// Given a working `java` binary path, walk up to its JDK root so we
/// can set `JAVA_HOME`. A Homebrew openjdk install lives at
/// `/opt/homebrew/opt/openjdk/bin/java` with the JDK home at
/// `/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home`, but
/// we conservatively walk `bin/..` first which works for most
/// distributions (Linux `/usr/lib/jvm/*/bin/java` too). Returns None
/// when we can't derive a plausible home — caller falls back to not
/// setting JAVA_HOME rather than pointing it at the wrong thing.
fn java_home_for(java_path: &str) -> Option<String> {
    let p = std::path::Path::new(java_path);
    // Resolve symlinks so `/opt/homebrew/opt/openjdk/bin/java` lands on
    // the real Cellar entry. If canonicalize fails (permission, broken
    // link), fall back to the original path.
    let real = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    // Typical layout: <JAVA_HOME>/bin/java. Two `parent()` hops up.
    let home = real.parent()?.parent()?;
    if home.join("bin").join("java").exists() {
        return Some(home.to_string_lossy().into_owned());
    }
    None
}

// ---- C# -------------------------------------------------------------

/// C# via `dotnet script` (the community `dotnet-script` global tool,
/// installed with `dotnet tool install -g dotnet-script`). That tool
/// is the only low-friction way to run a single `.csx` file without
/// scaffolding a project. If it's missing we surface an install hint
/// pointing at the `dotnet tool install` command.
#[tauri::command]
pub async fn run_csharp(code: String) -> SubprocessResult {
    let start = Instant::now();
    let source = match write_temp("csharp", "csx", &code) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let output = match Command::new("dotnet").arg("script").arg(&source).output() {
        Ok(o) => o,
        Err(e) => {
            return launch_failure(
                "dotnet",
                "install the .NET SDK (`brew install --cask dotnet-sdk` on macOS), then `dotnet tool install -g dotnet-script`.",
                e,
                start,
            );
        }
    };
    // `dotnet script` itself prints an error message if the
    // `dotnet-script` subcommand isn't installed — pass that through
    // verbatim so the user sees exactly what dotnet said to do.
    from_output(output, start)
}

// ---- Assembly -------------------------------------------------------

/// Assembly: assemble with `as`, link with `ld`, run the executable.
/// We target the host architecture with whatever syscall ABI the user
/// wrote — this isn't an emulator, just a thin shell over the native
/// tools. Keeps lessons honest (users see real-world linker errors)
/// at the cost of a learning curve for absolute beginners.
///
/// Linker flags differ between macOS (needs `-lSystem` + SDK path) and
/// Linux (nothing extra). We detect at runtime via `cfg!(target_os)`
/// so a single binary works on either host without the user having to
/// pick a variant.
#[tauri::command]
pub async fn run_asm(code: String) -> SubprocessResult {
    let start = Instant::now();
    let source = match write_temp("asm", "s", &code) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let obj_path = source.with_extension("o");
    let bin_path = source.with_extension("out");

    // Assemble.
    let mut assemble = Command::new("as");
    assemble.arg("-o").arg(&obj_path).arg(&source);
    let assemble_out = match assemble.output() {
        Ok(o) => o,
        Err(e) => {
            return launch_failure(
                "as",
                "install a system assembler (Xcode Command Line Tools on macOS, `binutils` on Linux).",
                e,
                start,
            );
        }
    };
    if !assemble_out.status.success() {
        // Prefix stderr with a stage marker so the output pane makes
        // it obvious WHICH step failed. Falls back to a hint when the
        // toolchain exits non-zero with no error text — common on
        // Intel Macs where the default arm64 template won't assemble.
        let raw = String::from_utf8_lossy(&assemble_out.stderr).into_owned();
        let body = if raw.trim().is_empty() {
            "assembler produced no output. If you're on an Intel Mac, the default template uses arm64 syscalls — rewrite it for x86_64 or switch hosts.".to_string()
        } else {
            raw
        };
        return SubprocessResult {
            stdout: String::from_utf8_lossy(&assemble_out.stdout).into_owned(),
            stderr: format!("as (assemble) failed: {}\n{}", assemble_out.status, body),
            success: false,
            duration_ms: start.elapsed().as_millis() as u64,
            launch_error: None,
        };
    }

    // Link. macOS wants `-lSystem` + the SDK path; Linux just needs
    // the object file. We keep the entry symbol as the default (`_main`
    // on macOS, `_start` on Linux) so users write the ABI they expect.
    let mut link = Command::new("ld");
    link.arg("-o").arg(&bin_path).arg(&obj_path);
    if cfg!(target_os = "macos") {
        link.arg("-lSystem");
        // `xcrun --show-sdk-path` points at the active SDK's Frameworks
        // directory, which `ld` needs as `-syslibroot` on modern Xcode.
        if let Ok(out) = Command::new("xcrun")
            .args(["-sdk", "macosx", "--show-sdk-path"])
            .output()
        {
            if out.status.success() {
                let sdk = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !sdk.is_empty() {
                    link.arg("-syslibroot").arg(sdk);
                }
            }
        }
    }

    let link_out = match link.output() {
        Ok(o) => o,
        Err(e) => {
            return launch_failure(
                "ld",
                "install the linker (Xcode Command Line Tools on macOS, `binutils` on Linux).",
                e,
                start,
            );
        }
    };
    if !link_out.status.success() {
        let raw = String::from_utf8_lossy(&link_out.stderr).into_owned();
        let body = if raw.trim().is_empty() {
            "linker produced no output. Check that your entry symbol matches the platform (`_main` on macOS, `_start` on Linux).".to_string()
        } else {
            raw
        };
        return SubprocessResult {
            stdout: String::from_utf8_lossy(&link_out.stdout).into_owned(),
            stderr: format!("ld (link) failed: {}\n{}", link_out.status, body),
            success: false,
            duration_ms: start.elapsed().as_millis() as u64,
            launch_error: None,
        };
    }

    // Run.
    let run_out = match Command::new(&bin_path).output() {
        Ok(o) => o,
        Err(e) => {
            return launch_failure(
                bin_path.to_string_lossy().as_ref(),
                "built but couldn't execute — check the binary's permissions.",
                e,
                start,
            );
        }
    };
    // A successful assemble+link run is a success even if the user's program
    // exits non-zero — exit codes are meaningful output for low-level code
    // (the default template deliberately returns 42 to demonstrate the exit
    // syscall). Surface the exit code in stdout so it renders as program
    // output instead of a generic "no output captured" error.
    let stdout = String::from_utf8_lossy(&run_out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&run_out.stderr).into_owned();
    let code_note = match run_out.status.code() {
        Some(c) if c != 0 => format!(
            "{}program exited with code {c}\n",
            if stdout.is_empty() { "" } else { "\n" },
        ),
        _ => String::new(),
    };
    SubprocessResult {
        stdout: format!("{stdout}{code_note}"),
        stderr,
        success: true,
        duration_ms: start.elapsed().as_millis() as u64,
        launch_error: None,
    }
}

// ── 2026 expansion: simple-CLI runners ─────────────────────────────
//
// Five languages whose toolchain is "one binary takes a source file
// and runs it" — Ruby (`ruby`), Elixir (`elixir`), Haskell
// (`runghc` from GHC), Scala (`scala-cli`), and Dart (`dart`). No
// compile step, no per-language temp directory, no class-name
// parsing. Each just shells out via `simple_run_one_file` below.
//
// Languages that need a project structure (Move, Cairo, Sway —
// each looks for a manifest file at the working dir) are NOT here;
// they remain as "coming soon" stubs in the JS layer until we wire
// per-Run scaffolding (write a Cargo.toml-equivalent + invoke the
// project-aware CLI).

/// Generic single-file CLI runner: write `code` to a temp file with
/// the given extension, then exec `binary <args> <temp>` — capture
/// stdout/stderr, surface launch failures with a friendly install
/// hint. Used by every simple-CLI-shaped language below.
fn simple_run_one_file(
    binary: &str,
    extra_args: &[&str],
    prefix: &str,
    extension: &str,
    install_hint: &str,
    code: String,
) -> SubprocessResult {
    let start = Instant::now();
    let source = match write_temp(prefix, extension, &code) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let mut cmd = Command::new(binary);
    for a in extra_args {
        cmd.arg(a);
    }
    cmd.arg(&source);
    match cmd.output() {
        Ok(o) => from_output(o, start),
        Err(e) => launch_failure(binary, install_hint, e, start),
    }
}

// ---- Ruby -----------------------------------------------------------

/// `ruby <file>`. macOS ships a system Ruby (Apple's bundled MRI)
/// that's installed by default; on Linux it's a one-liner via the
/// distro package manager.
#[tauri::command]
pub async fn run_ruby(code: String) -> SubprocessResult {
    simple_run_one_file(
        "ruby",
        &[],
        "ruby",
        "rb",
        "install Ruby (`brew install ruby` / `apt install ruby`).",
        code,
    )
}

// ---- Elixir ---------------------------------------------------------

/// `elixir <file>`. Lessons use `.exs` (Elixir script) so we don't
/// require a Mix project. Pure module-level expressions work fine
/// at this size.
#[tauri::command]
pub async fn run_elixir(code: String) -> SubprocessResult {
    simple_run_one_file(
        "elixir",
        &[],
        "elixir",
        "exs",
        "install Elixir (`brew install elixir` on macOS, `asdf install elixir` for cross-platform).",
        code,
    )
}

// ---- Haskell --------------------------------------------------------

/// `runghc <file>`. `runghc` is bundled with every GHC install and
/// runs Haskell as a script (compile+run in one shot, throws away
/// the binary). For lesson-sized snippets that's the right choice
/// — `ghc` would leave .hi / .o droppings beside the temp source.
#[tauri::command]
pub async fn run_haskell(code: String) -> SubprocessResult {
    simple_run_one_file(
        "runghc",
        &[],
        "haskell",
        "hs",
        "install GHC via Homebrew (`brew install ghc`).",
        code,
    )
}

// ---- Scala ----------------------------------------------------------

/// `scala-cli run <file>`. scala-cli is the modern recommended way
/// to run Scala scripts — it handles dependency resolution + JVM
/// boot automatically. The classic `scala` REPL would also work
/// but scala-cli is the path Scala 3 docs steer learners toward.
#[tauri::command]
pub async fn run_scala(code: String) -> SubprocessResult {
    simple_run_one_file(
        "scala-cli",
        &["run"],
        "scala",
        "scala",
        "install scala-cli (`brew install Virtuslab/scala-cli/scala-cli` or see https://scala-cli.virtuslab.org/install).",
        code,
    )
}

// ---- Dart -----------------------------------------------------------

/// `dart run <file>`. The `dart` command resolves to the Dart SDK
/// binary; `run <file>` executes a single .dart entrypoint without
/// requiring a `pubspec.yaml`. Most lesson-sized programs work.
#[tauri::command]
pub async fn run_dart(code: String) -> SubprocessResult {
    simple_run_one_file(
        "dart",
        &["run"],
        "dart",
        "dart",
        "install the Dart SDK (`brew install dart-sdk` or see https://dart.dev/get-dart).",
        code,
    )
}

// ---- Zig ------------------------------------------------------------

/// Run a Zig source file. Two modes, picked by the caller via the
/// `mode` argument:
///
///   - `"test"` — `zig test <file>`. Compiles + runs every
///     `test "name" { ... }` block, printing one
///     `N/M slug.test.<name>...(OK|FAIL [(reason)])` line per case to
///     stderr. Used by lesson runs (the merged source carries
///     starter + hidden test cases) so learners see per-test pass /
///     fail with leak detection from `std.testing.allocator`.
///
///   - `"run"` — `zig run <file>`. Compiles + executes `pub fn main`
///     and pipes its stdout / stderr through verbatim. Used by the
///     Playground where the user's code is a script with `pub fn
///     main`; running it as `zig test` would only collect test blocks
///     and never call `main`, which manifested as "All 0 tests
///     passed." with no Hello-world output (the bug this split fixes).
///
/// `mode` is intentionally a string, not an enum — keeps the IPC
/// payload trivial and lets the JS side pick mode from a single
/// boolean (`testCode != null ? "test" : "run"`).
///
/// Output parsing happens in `runtimes/nativeRunners.ts::runZig`.
#[tauri::command]
pub async fn run_zig(code: String, mode: Option<String>) -> SubprocessResult {
    let zig_subcommand = match mode.as_deref() {
        // Default to `test` for backwards-compat with any caller that
        // omits `mode`. Lesson runs always pass "test"; Playground
        // passes "run".
        Some("run") => "run",
        Some("test") | None => "test",
        Some(other) => {
            return SubprocessResult {
                stdout: String::new(),
                stderr: format!(
                    "internal error: unknown zig run mode {other:?} (expected \"test\" or \"run\")"
                ),
                success: false,
                duration_ms: 0,
                launch_error: Some(format!(
                    "unknown zig mode {other:?}; expected \"test\" or \"run\""
                )),
            };
        }
    };
    simple_run_one_file(
        "zig",
        &[zig_subcommand],
        "zig",
        "zig",
        "install Zig (`brew install zig` on macOS, or grab a tarball from https://ziglang.org/download/).",
        code,
    )
}

// ---- Rust -----------------------------------------------------------

/// Compile + run the learner's Rust locally via `rustc`. This is the
/// OPTIONAL fast path: `runtimes/rust.ts` prefers it when a local
/// toolchain is present and silently falls back to the public Rust
/// Playground (`play.rust-lang.org/execute`) otherwise — so a missing
/// rustc is never a hard failure, just a slower run.
///
/// `test` mirrors `run_zig`'s `mode`: the JS side passes it as a
/// single boolean (`testCode != null`). When true we compile with
/// `--test`, which links libtest and produces a harness binary whose
/// stdout is EXACTLY the `test kata_tests::foo ... ok` format the
/// Playground path already emits — so `rust.ts::parseTestResults`
/// consumes local + remote output through one identical code path
/// with zero divergence. When false we build an ordinary binary and
/// run it (Playground "run" equivalent).
///
/// Edition 2021 + `-O0` mirror the Playground request body in
/// `rust.ts` (`{ edition: "2021", mode: "debug" }`) so behaviour is
/// consistent whichever path actually executes — a lesson that
/// compiles remotely must compile locally too.
///
/// PATH is broadened on BOTH the compile and the run command:
/// rustup installs `rustc` to `~/.cargo/bin`, which a Finder-launched
/// GUI app's minimal PATH doesn't include (`broadened_path()` adds
/// it). The run command inherits it too because some rustup setups
/// resolve the dynamic std/sysroot relative to the toolchain dir.
#[tauri::command]
pub async fn run_rust(code: String, test: Option<bool>) -> SubprocessResult {
    let start = Instant::now();
    let source = match write_temp("rust", "rs", &code) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let binary = source.with_extension("out");
    let broadened = crate::toolchain::broadened_path();

    let mut compile = Command::new("rustc");
    compile
        .env("PATH", &broadened)
        .arg("--edition")
        .arg("2021")
        // No-optimization, fast compile. `-O0` is gcc/clang syntax —
        // rustc parses `-O` as a value-less optimize flag, then sees
        // `0` as a stray positional and bails with
        //   `error: Unrecognized option: '0'`
        // which surfaced in the user's output pane as a compile
        // error on otherwise-valid Rust code. The correct rustc
        // syntax is `-C opt-level=0` (also the implicit default for
        // a non-`-O` build, but stating it explicitly preserves the
        // original intent + makes a future `--release` toggle easy).
        .arg("-C")
        .arg("opt-level=0")
        .arg("-o")
        .arg(&binary)
        .arg(&source);
    // `--test` builds the libtest harness binary (the
    // `#[cfg(test)] mod kata_tests` block joinCodeAndTests wraps the
    // user's tests in). Without it those test fns are dead code and
    // the binary just runs `main`, so a lesson would always report
    // "0 tests".
    if test.unwrap_or(false) {
        compile.arg("--test");
    }

    let mut run_cmd = Command::new(&binary);
    run_cmd.env("PATH", &broadened);

    compile_then_run(
        compile,
        run_cmd,
        "rustc",
        "install Rust via rustup (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`) or use the in-app prompt.",
        start,
    )
}

