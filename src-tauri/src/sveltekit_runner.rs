//! SvelteKit project runner.
//!
//! Each lesson gets its own working directory under
//! `<app-data>/sveltekit-runs/<lesson-id>/`, scaffolded with a
//! minimal SvelteKit project (package.json + vite.config.js +
//! svelte.config.js + the lesson's src/ tree). On first run we shell
//! out to `npm install` (slow ~30-60s); subsequent runs reuse the
//! warmed node_modules.
//!
//! The dev server is `vite dev --port 0 --host 127.0.0.1` — port 0
//! means "let the OS pick" so multiple lessons can run concurrently
//! without a port-allocation collision. We tail Vite's stdout looking
//! for the `Local:` line it always prints with the chosen URL, surface
//! that URL to the frontend, and keep the process alive in the
//! background until the next run-or-stop call swaps it out.
//!
//! Lifecycle: one process per lesson id. A second `start` for the
//! same lesson kills the previous process, swaps in fresh files (so
//! Vite's HMR isn't confused by orphan modules), and starts a new
//! dev server. `stop_sveltekit` is exposed for the frontend to
//! tear down on lesson change.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

/// Per-lesson background process handle. We keep just enough state
/// to kill the process and re-spawn cleanly on the next run.
struct RunningServer {
    child: Child,
    /// Resolved `http://127.0.0.1:<port>/` URL. Filled in once Vite
    /// prints its `Local:` startup line.
    url: Option<String>,
}

#[derive(Default)]
pub struct SvelteKitRunners {
    /// Map of `lesson_id` → handle. Wrapped in a Mutex because the
    /// Tauri commands fire from multiple async tasks; HashMap+Mutex
    /// is enough for the contention pattern (one start/stop per
    /// lesson at a time).
    inner: Mutex<HashMap<String, RunningServer>>,
}

#[derive(Debug, Deserialize)]
pub struct SveltekitFile {
    /// Path RELATIVE to the project root, e.g.
    /// `src/routes/+page.svelte` or `src/lib/util.ts`.
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct StartResult {
    /// `http://127.0.0.1:<port>/` once Vite is listening, or `null`
    /// if startup hadn't reached the `Local:` line within the boot
    /// window. The frontend treats `null` as a soft failure and
    /// shows the captured logs.
    pub url: Option<String>,
    /// Absolute path the project was scaffolded into. Surfaced so the
    /// frontend can show "your code lives at ..." for debugging /
    /// power-user inspection.
    pub project_dir: String,
    /// Captured output from `npm install` + Vite startup. Empty when
    /// install was skipped (warm node_modules) and Vite started
    /// cleanly.
    pub stdout: String,
    pub stderr: String,
    pub install_ran: bool,
    pub duration_ms: u64,
}

/// Start (or restart) the SvelteKit dev server for `lesson_id`.
///
/// Implementation order:
///   1. Resolve the working dir under <app-data>/sveltekit-runs.
///   2. If a server is already running for this lesson, kill it.
///   3. Write the scaffold (package.json, vite.config.js,
///      svelte.config.js) if missing — they're identical across
///      lessons so we only write once.
///   4. Write every lesson file, OVERWRITING anything from the
///      previous run. We don't try to be clever about diff-only
///      writes; Vite's HMR will pick up the changes.
///   5. Run `npm install` IF `node_modules` doesn't exist. Slow
///      first time, instant otherwise.
///   6. Spawn `vite dev` and tail stdout for the `Local:` URL.
#[tauri::command]
pub async fn start_sveltekit(
    app: AppHandle,
    state: State<'_, SvelteKitRunners>,
    lesson_id: String,
    files: Vec<SveltekitFile>,
) -> Result<StartResult, String> {
    let start = Instant::now();
    let project_dir = lesson_dir(&app, &lesson_id)?;
    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();

    // Stop any running server for this lesson FIRST. Vite hot-reloads
    // gracefully on a file change, but a hard kill before re-scaffold
    // avoids a window where the process is iterating module graphs
    // against half-written files.
    {
        let mut guard = state.inner.lock().map_err(|e| format!("mutex poisoned: {e}"))?;
        if let Some(mut existing) = guard.remove(&lesson_id) {
            let _ = existing.child.kill();
            let _ = existing.child.wait();
        }
    }

    // Scaffold + write user files. Errors here surface back to the
    // frontend before we even try to install — saves the user from
    // a "vite isn't installed" diagnostic when the real problem is a
    // bad path in the lesson definition.
    fs::create_dir_all(&project_dir)
        .map_err(|e| format!("create project dir: {e}"))?;
    write_scaffold_if_missing(&project_dir)?;
    write_lesson_files(&project_dir, &files)?;

    // Resolve the bundled Node + npm + npx paths once. Cheap (a
    // single resource_dir lookup + path joins) and gives us a
    // single env to thread through both `npm install` and `vite
    // dev`. Falls back to system PATH when the bundle didn't ship
    // a Node distribution (dev builds before `npm run vendor:node`
    // gets run, smoke-test environments, etc).
    let node_paths = resolve_node_paths(&app);

    // Skip install when node_modules is already populated. The first
    // lesson on a fresh install pays the cost; every subsequent
    // lesson re-uses the same warmed cache because we re-export the
    // npm cache into a single shared cache dir below.
    let node_modules = project_dir.join("node_modules");
    let install_ran = !node_modules.exists();
    if install_ran {
        emit_log(&app, &lesson_id, "stage", "Installing SvelteKit dependencies (one-time, ~30-60s)…");
        let mut cmd = Command::new(&node_paths.npm);
        cmd.current_dir(&project_dir)
            .arg("install")
            // --no-fund --no-audit drop the chatty trailing summary
            // text so the captured stdout stays scannable.
            .arg("--no-fund")
            .arg("--no-audit")
            // Pin a shared npm cache so subsequent lessons get
            // package re-use even though their project dirs are
            // separate. Without this, every lesson re-downloads
            // SvelteKit + Vite + Svelte from the registry.
            .args(["--cache", &shared_npm_cache(&app)?.to_string_lossy()])
            // PATH includes our bundled-node bin/ so npm's spawn of
            // node-gyp / node finds the same binary the user is
            // running, not whatever's on the system. Falls back to
            // the broadened system PATH if the bundle is missing.
            .env("PATH", node_paths.path_env());
        let out = cmd.output().map_err(|e| format!("spawn npm: {e}"))?;
        stdout_buf.push_str(&String::from_utf8_lossy(&out.stdout));
        stderr_buf.push_str(&String::from_utf8_lossy(&out.stderr));
        if !out.status.success() {
            return Err(format!(
                "npm install failed (status {:?}). stderr tail:\n{}",
                out.status.code(),
                tail(&stderr_buf, 800)
            ));
        }
    }

    // Start Vite. We don't pass --port 0 (Vite's `--port` flag
    // only accepts a positive port, and SvelteKit's vite.config.js
    // overrides the CLI value anyway). Instead we let Vite pick its
    // own port — 5173 by default, auto-bumping if taken — and parse
    // the actual port back from stdout. `--host 127.0.0.1` keeps the
    // dev server bound to localhost so we don't accidentally expose
    // it on the LAN. NO_COLOR=1 + FORCE_COLOR=0 strip ANSI codes
    // from Vite's chalk-coloured output so the URL parser doesn't
    // need to handle escape sequences.
    emit_log(&app, &lesson_id, "stage", "Starting Vite dev server…");
    let mut child = Command::new(&node_paths.npx)
        .current_dir(&project_dir)
        .args(["vite", "dev", "--host", "127.0.0.1"])
        .env("PATH", node_paths.path_env())
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn vite: {e}"))?;

    let url = wait_for_local_url(
        &mut child,
        Duration::from_secs(30),
        &app,
        &lesson_id,
        &mut stdout_buf,
        &mut stderr_buf,
    );

    if url.is_none() && child.try_wait().map(|s| s.is_some()).unwrap_or(false) {
        // Vite died during boot. Surface what we captured so the user
        // can diagnose the failure inline instead of staring at a
        // mute popout.
        return Err(format!(
            "vite dev exited before printing a Local: URL. stderr tail:\n{}",
            tail(&stderr_buf, 800)
        ));
    }

    // Tail stdout/stderr in background threads so the captured logs
    // stream into Tauri events (the frontend can render them as Vite
    // recompiles on every save). Drains until the pipe closes —
    // i.e. the child exits — at which point the threads naturally
    // wind down.
    if let Some(s) = child.stdout.take() {
        spawn_tail_thread(s, app.clone(), lesson_id.clone(), "stdout");
    }
    if let Some(s) = child.stderr.take() {
        spawn_tail_thread(s, app.clone(), lesson_id.clone(), "stderr");
    }

    let result_dir = project_dir.clone();
    let result_url = url.clone();
    {
        let mut guard = state.inner.lock().map_err(|e| format!("mutex poisoned: {e}"))?;
        guard.insert(
            lesson_id,
            RunningServer { child, url },
        );
    }

    Ok(StartResult {
        url: result_url,
        project_dir: result_dir.to_string_lossy().into_owned(),
        stdout: stdout_buf,
        stderr: stderr_buf,
        install_ran,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub async fn stop_sveltekit(
    state: State<'_, SvelteKitRunners>,
    lesson_id: String,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| format!("mutex poisoned: {e}"))?;
    if let Some(mut existing) = guard.remove(&lesson_id) {
        let _ = existing.child.kill();
        let _ = existing.child.wait();
    }
    Ok(())
}

/// Read back the URL we surfaced for `lesson_id` without restarting.
/// Used by the frontend on lesson re-open to re-attach to an
/// already-running dev server (so the iframe doesn't pause on a fresh
/// `npm install` between tab switches).
#[tauri::command]
pub fn current_sveltekit_url(
    state: State<'_, SvelteKitRunners>,
    lesson_id: String,
) -> Option<String> {
    state
        .inner
        .lock()
        .ok()
        .and_then(|g| g.get(&lesson_id).and_then(|s| s.url.clone()))
}

// ---- Internals ----------------------------------------------------------

fn lesson_dir(app: &AppHandle, lesson_id: &str) -> Result<PathBuf, String> {
    // Profile-scoped scratch dir for SvelteKit lesson runs.
    let base = crate::profiles::profile_app_root(app)
        .map_err(|e| format!("resolve profile data dir: {e}"))?;
    // Lesson IDs are caller-controlled and shaped like
    // `basic-sveltekit--02-routing--01-pages`. They're already
    // path-safe by ingest convention but we re-sanitise as a
    // belt-and-suspenders against a future ingest that gets sloppy.
    let safe: String = lesson_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') { c } else { '-' })
        .collect();
    Ok(base.join("sveltekit-runs").join(safe))
}

fn shared_npm_cache(app: &AppHandle) -> Result<PathBuf, String> {
    // Profile-scoped — keeps one profile's node_modules cache from
    // bleeding into another (different installed deps per library).
    let base = crate::profiles::profile_app_root(app)
        .map_err(|e| format!("resolve profile data dir: {e}"))?;
    let dir = base.join("sveltekit-npm-cache");
    fs::create_dir_all(&dir).map_err(|e| format!("create npm cache: {e}"))?;
    Ok(dir)
}

/// Write the SvelteKit boilerplate files (package.json, configs,
/// app.html) once per project dir. Skips files that already exist
/// so we don't clobber an in-progress run.
fn write_scaffold_if_missing(dir: &Path) -> Result<(), String> {
    write_if_missing(dir.join("package.json"), SCAFFOLD_PACKAGE_JSON)?;
    write_if_missing(dir.join("svelte.config.js"), SCAFFOLD_SVELTE_CONFIG)?;
    write_if_missing(dir.join("vite.config.js"), SCAFFOLD_VITE_CONFIG)?;
    fs::create_dir_all(dir.join("src")).map_err(|e| format!("mkdir src: {e}"))?;
    write_if_missing(dir.join("src/app.html"), SCAFFOLD_APP_HTML)?;
    Ok(())
}

fn write_if_missing(path: PathBuf, content: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    fs::write(&path, content).map_err(|e| format!("write {}: {e}", path.display()))
}

fn write_lesson_files(dir: &Path, files: &[SveltekitFile]) -> Result<(), String> {
    for f in files {
        // Defensive — refuse `..` and absolute paths so a malformed
        // lesson can't write outside the scaffold dir.
        if f.path.contains("..") || f.path.starts_with('/') {
            return Err(format!("unsafe lesson file path: {}", f.path));
        }
        let full = dir.join(&f.path);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        fs::write(&full, &f.content)
            .map_err(|e| format!("write {}: {e}", full.display()))?;
    }
    Ok(())
}

/// Drain Vite's stdout for up to `timeout` looking for the `Local:`
/// startup line. Vite v5 prints something like:
///   ```
///     VITE v5.0.0  ready in 320 ms
///     ➜  Local:   http://127.0.0.1:51234/
///     ➜  Network: use --host to expose
///   ```
/// We accept either `Local:` or `local:` (Vite has flip-flopped on
/// casing) and parse out the http://host:port/ URL.
fn wait_for_local_url(
    child: &mut Child,
    timeout: Duration,
    app: &AppHandle,
    lesson_id: &str,
    stdout_buf: &mut String,
    stderr_buf: &mut String,
) -> Option<String> {
    let stdout = child.stdout.take()?;
    let mut reader = BufReader::new(stdout);
    let deadline = Instant::now() + timeout;
    let mut url: Option<String> = None;
    loop {
        if Instant::now() >= deadline {
            break;
        }
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break, // EOF
            Ok(_) => {
                stdout_buf.push_str(&line);
                emit_log(app, lesson_id, "stdout", line.trim_end());
                if let Some(u) = parse_local_url(&line) {
                    url = Some(u);
                    break;
                }
            }
            Err(_) => break,
        }
    }
    // Hand the stdout pipe back so the background tail thread can
    // keep draining it after we've returned.
    child.stdout = Some(reader.into_inner());

    // Drain whatever stderr produced during startup so error
    // messages aren't lost. Best-effort — non-blocking would be
    // cleaner but the OS pipe buffer is plenty for the boot window.
    if let Some(mut e) = child.stderr.take() {
        use std::io::Read;
        let mut buf = String::new();
        let _ = e.read_to_string(&mut buf);
        if !buf.is_empty() {
            stderr_buf.push_str(&buf);
            for line in buf.lines() {
                emit_log(app, lesson_id, "stderr", line);
            }
        }
        child.stderr = Some(e);
    }
    url
}

fn parse_local_url(line: &str) -> Option<String> {
    // Match `http://...:NNNN/` (with or without trailing slash). NO_COLOR=1
    // + FORCE_COLOR=0 should strip ANSI codes from Vite's output, but
    // strip again here defensively — chalk and picocolors both have
    // edge cases where a single-segment escape leaks through, and the
    // resulting `http://...\x1b[39m` URL would 404 on the iframe load.
    let cleaned = strip_ansi(line);
    let lower = cleaned.to_lowercase();
    if !lower.contains("local:") {
        return None;
    }
    let start = cleaned.find("http://")?;
    let bytes = cleaned.as_bytes();
    let mut end = start;
    while end < bytes.len() && !bytes[end].is_ascii_whitespace() {
        end += 1;
    }
    Some(cleaned[start..end].to_string())
}

/// Strip ANSI CSI sequences (`ESC [ ... letter`) from a line. Vite's
/// chalk output occasionally slips a colour code past NO_COLOR
/// (especially for the Local/Network URL highlight); without
/// stripping we end up parsing `http://127.0.0.1:5173/\x1b[39m` and
/// the trailing escape breaks the iframe load.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            i += 2;
            while i < bytes.len() && !bytes[i].is_ascii_alphabetic() {
                i += 1;
            }
            if i < bytes.len() {
                i += 1; // skip the terminator letter (m, K, etc.)
            }
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

fn spawn_tail_thread<R: std::io::Read + Send + 'static>(
    pipe: R,
    app: AppHandle,
    lesson_id: String,
    stream: &'static str,
) {
    thread::Builder::new()
        .name(format!("sveltekit-tail-{stream}-{lesson_id}"))
        .spawn(move || {
            let reader = BufReader::new(pipe);
            for line in reader.lines().map_while(Result::ok) {
                emit_log(&app, &lesson_id, stream, &line);
            }
        })
        .ok();
}

#[derive(Serialize, Clone)]
struct LogPayload<'a> {
    lesson_id: &'a str,
    stream: &'a str,
    text: &'a str,
}

fn emit_log(app: &AppHandle, lesson_id: &str, stream: &str, text: &str) {
    let _ = app.emit(
        "sveltekit-log",
        LogPayload {
            lesson_id,
            stream,
            text,
        },
    );
}

fn tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("…{}", &s[s.len() - max..])
    }
}

/// Concrete paths to the bundled Node toolchain. We resolve both
/// once per `start_sveltekit` call and thread them into every spawn
/// — re-resolving inside spawn loops would just be repeated path
/// joins for no gain.
struct NodePaths {
    /// Absolute path to the `node` binary. Used directly when we
    /// want to invoke node (currently we don't; npm/npx wrap it).
    /// Stays on the struct so we have it available when stage 3
    /// adds a "run a one-shot script" path.
    #[allow(dead_code)]
    node: PathBuf,
    /// Absolute path to npm. On *nix this is the symlink under
    /// `bin/npm` which resolves into the npm-cli.js relative to
    /// the bin dir; the symlink's relative target survives our
    /// extraction so it still works post-bundle.
    npm: PathBuf,
    /// Absolute path to npx (same shape as npm).
    npx: PathBuf,
    /// Directory containing node + npm + npx. Prepended to the
    /// spawned child's PATH so any `node` / `npm` shell-out from
    /// inside npm itself (lifecycle scripts, node-gyp, etc) hits
    /// the bundled tools rather than the user's system Node.
    bin_dir: PathBuf,
    /// True when we resolved out of the shipped resources dir.
    /// False when we're falling back to system PATH (dev builds
    /// before the fetch script has run, smoke tests, etc).
    bundled: bool,
}

impl NodePaths {
    /// Build a PATH for spawned children that prepends our bundled
    /// `bin/` (when present) so npm's lifecycle scripts pick up the
    /// matching node, then appends Homebrew's typical install
    /// prefixes so a fallback-to-system path still finds Node + npm.
    fn path_env(&self) -> String {
        let extras = [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
        ];
        let current = std::env::var("PATH").unwrap_or_default();
        let mut parts: Vec<String> = Vec::new();
        if self.bundled {
            parts.push(self.bin_dir.to_string_lossy().into_owned());
        }
        for p in current.split(':') {
            if !p.is_empty() && !parts.iter().any(|x| x == p) {
                parts.push(p.to_string());
            }
        }
        for e in extras {
            if !parts.iter().any(|x| x == e) {
                parts.push(e.to_string());
            }
        }
        parts.join(":")
    }
}

/// Resolve paths to node + npm + npx. Prefers the bundle's shipped
/// runtime under `<resources>/node/`; falls back to bare names
/// (resolved by the child process via PATH) when the bundle is
/// missing. The fallback keeps dev-mode iteration working when
/// `npm run fetch:node` hasn't been run since the runtime dir
/// was last cleaned.
fn resolve_node_paths(app: &AppHandle) -> NodePaths {
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|p| p.join("resources").join("node"));
    if let Some(bundle_root) = bundled {
        let bin_dir = if cfg!(windows) {
            bundle_root.clone()
        } else {
            bundle_root.join("bin")
        };
        let node = bin_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        let npm = bin_dir.join(if cfg!(windows) { "npm.cmd" } else { "npm" });
        let npx = bin_dir.join(if cfg!(windows) { "npx.cmd" } else { "npx" });
        if node.exists() && npm.exists() && npx.exists() {
            return NodePaths {
                node,
                npm,
                npx,
                bin_dir,
                bundled: true,
            };
        }
    }
    // Fallback — bare names. Command::new resolves via the env we
    // hand it; path_env() pads with Homebrew prefixes so a GUI
    // launch still finds /opt/homebrew/bin/node.
    NodePaths {
        node: PathBuf::from("node"),
        npm: PathBuf::from("npm"),
        npx: PathBuf::from("npx"),
        bin_dir: PathBuf::from("/usr/bin"),
        bundled: false,
    }
}


// ---- Scaffold templates -------------------------------------------------

const SCAFFOLD_PACKAGE_JSON: &str = r#"{
  "name": "libre-sveltekit-lesson",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview"
  },
  "devDependencies": {
    "@sveltejs/adapter-auto": "^3.0.0",
    "@sveltejs/kit": "^2.5.0",
    "@sveltejs/vite-plugin-svelte": "^3.0.0",
    "svelte": "^4.2.7",
    "vite": "^5.0.3"
  }
}
"#;

const SCAFFOLD_SVELTE_CONFIG: &str = r#"import adapter from '@sveltejs/adapter-auto';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter()
  }
};
export default config;
"#;

const SCAFFOLD_VITE_CONFIG: &str = r#"import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    // Tauri spawns the dev server on the user's machine; binding to
    // 127.0.0.1 keeps it off the LAN. The popped phone window
    // inside Tauri loads the URL we capture from stdout.
    host: '127.0.0.1',
    strictPort: false
  }
});
"#;

const SCAFFOLD_APP_HTML: &str = r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    %sveltekit.head%
  </head>
  <body>
    <div id="svelte">%sveltekit.body%</div>
  </body>
</html>
"#;
