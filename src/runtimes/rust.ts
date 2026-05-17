import type { RunResult, LogLine, TestResult } from "./types";
import { isDesktop } from "../lib/platform";

/// Rust via local `rustc` (fast path) with a play.rust-lang.org
/// fallback.
///
/// Rust can't be cleanly compiled in-browser for V1 (rustc-as-WASM is huge and
/// slow), so we lean on the public Rust Playground execute endpoint. The
/// service compiles user code with cargo on their infra and returns
/// stdout/stderr. When a lesson has tests, we submit code + test code as a
/// single file with `#[cfg(test)] mod tests { ... }` wrapped around the
/// tests and set `tests: true` to invoke `cargo test`.
///
/// When we later ship a Tauri subprocess fallback (step 9 for swift, same
/// pattern for rust), `runRust` will try local rustc first and fall back to
/// Playground on missing toolchain.
///
/// Resilience notes (added after the verifier surfaced systemic failures):
///   - The Playground occasionally returns 200 with an *error envelope*
///     (`{error: "..."}`) instead of the usual `{success, stdout, stderr}`
///     shape. Every accessor below treats the fields as optional and falls
///     back to `""` so a missing `stdout` can't crash `parseTestResults`.
///   - Network blips are common on the desktop build (CORS preflight
///     races, sleeping radio waking). We retry the fetch ONCE after a
///     short backoff. One retry is the right ceiling — the Playground
///     itself is slow enough that more retries would balloon a verify
///     run, and a second consecutive fail almost always means the
///     service is genuinely down.
///   - Anything that escapes the request/parse pipeline gets caught at
///     the top level and folded into a `RunResult` with `error: ...`.
///     Throwing past `runRust` puts the raw stack trace into the
///     workbench's error pane, which was the original "parseTestResults
///     @ rust.ts:69" symptom.

const PLAYGROUND_URL = "https://play.rust-lang.org/execute";
const TIMEOUT_MS = 20_000;
const RETRY_BACKOFF_MS = 500;

interface PlaygroundResponse {
  /// All three are optional because the Playground sometimes
  /// returns a `{ error: "..." }`-shaped envelope on overload /
  /// rate-limit / transient errors with no `success` field at all.
  success?: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

/// Shape of the Rust backend's `SubprocessResult` (see
/// `src-tauri/src/lib.rs`). `launch_error` is set ONLY when the
/// process couldn't start (rustc missing / not on PATH) — that's
/// our signal to silently fall back to the Playground.
interface SubprocessResult {
  stdout: string;
  stderr: string;
  success: boolean;
  duration_ms: number;
  launch_error: string | null;
}

/// Session cache for "is `rustc` available locally?". `undefined`
/// = not probed yet, `true`/`false` = probed. Memoised so we don't
/// IPC a toolchain probe on every single run; `resetRustcProbe()`
/// clears it after the in-app installer finishes so the very next
/// run picks up the freshly-installed toolchain without a reload.
let rustcAvailable: boolean | undefined;
let rustcProbeInFlight: Promise<boolean> | null = null;

/// Clear the memoised probe — call after `install_language_toolchain`
/// succeeds so `runRust` re-probes and starts using the local fast
/// path immediately. Exported for the RustLocalPrompt to invoke.
export function resetRustcProbe(): void {
  rustcAvailable = undefined;
  rustcProbeInFlight = null;
}

/// Probe once per session whether a local `rustc` exists. Web build
/// always returns false (no Tauri); any probe failure is treated as
/// "not available" so we degrade to the Playground rather than hang.
async function probeRustc(): Promise<boolean> {
  if (!isDesktop) return false;
  if (rustcAvailable !== undefined) return rustcAvailable;
  if (rustcProbeInFlight) return rustcProbeInFlight;
  rustcProbeInFlight = (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const status = await invoke<{ installed?: boolean }>(
        "probe_language_toolchain",
        { language: "rust" },
      );
      rustcAvailable = !!status?.installed;
    } catch {
      // Older binary without the probe command, or IPC failure —
      // assume no local toolchain and use the Playground.
      rustcAvailable = false;
    }
    rustcProbeInFlight = null;
    return rustcAvailable;
  })();
  return rustcProbeInFlight;
}

/// Run the merged source through the local `rustc` backend command.
/// Returns a `PlaygroundResponse`-shaped object so the EXISTING
/// `buildResult()` / `parseTestResults()` pipeline consumes local
/// and remote output through one identical path — zero divergence.
///
/// Returns `null` to signal "fall back to the Playground": either
/// the toolchain vanished mid-session (`launch_error`) or the IPC
/// itself failed. A compile error or failing test is NOT a fallback
/// — that's a real result the learner needs to see, so it's mapped
/// through faithfully.
///
/// Mapping rationale:
///   - success → drop stderr. A clean `rustc` compile prints only
///     progress/warnings to stderr; the Playground (cargo) path
///     already hides exactly that on success via the `Finished`
///     check in `buildResult`. Dropping it keeps the two paths
///     visually identical instead of local suddenly surfacing
///     warning noise remote hides.
///   - failure → pass stderr verbatim. `buildResult` uses
///     `tests.length` to tell a compile error (parsed from the
///     rustc `error[EXXXX]` block by `extractCompileError`) apart
///     from a failing-test run (parsed from stdout), so faithful
///     stderr is required for the compile-error branch.
async function runRustLocal(
  merged: string,
  isTest: boolean,
): Promise<PlaygroundResponse | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const raw = await invoke<SubprocessResult>("run_rust", {
      code: merged,
      test: isTest,
    });
    if (raw.launch_error) {
      // rustc not startable (uninstalled / removed since probe) —
      // refresh the cache so we don't keep trying, then fall back.
      rustcAvailable = false;
      return null;
    }
    return {
      success: raw.success,
      stdout: raw.stdout,
      stderr: raw.success ? "" : raw.stderr,
    };
  } catch {
    // IPC failure (command not registered on an older binary,
    // serialization issue, …). Don't surface it — fall back.
    return null;
  }
}

export async function runRust(code: string, testCode?: string): Promise<RunResult> {
  const start = performance.now();
  const isTest = !!testCode;

  // Top-level guard. Anything that makes it out of the inner pipeline
  // — JSON parse error, surprise property access on a malformed body,
  // runtime exception inside parseTestResults — gets folded into a
  // structured RunResult instead of bubbling up as a raw stack trace.
  // The "parseTestResults@rust.ts:69" failures the verifier surfaced
  // were exactly this: a path that threw past runRust and dumped its
  // stack into the workbench error pane.
  try {
    const merged = testCode ? joinCodeAndTests(code, testCode) : code;

    // Local fast path. When a desktop user has `rustc` installed,
    // compile + run on their machine — instant, offline, no shared
    // sandbox queue. `runRustLocal` returns null to mean "couldn't
    // run locally, use the Playground" (toolchain vanished / IPC
    // failure); a compile error or failing test comes back as a
    // real `PlaygroundResponse` and skips the network entirely.
    if (await probeRustc()) {
      const local = await runRustLocal(merged, isTest);
      if (local) return buildResult(local, isTest, start);
    }

    const body = await fetchPlaygroundWithRetry(merged, isTest);
    return buildResult(body, isTest, start);
  } catch (err) {
    return {
      logs: [],
      error: friendlyErrorMessage(err),
      durationMs: performance.now() - start,
      testsExpected: isTest,
    };
  }
}

/// Format a thrown error into a one-line, learner-readable string.
/// We strip the stack so the workbench output doesn't show the
/// internal call site (`parseTestResults@rust.ts:69`) — that's
/// noise to the user and useless to the LLM in a fix-prompt
/// export.
function friendlyErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError") return "Rust Playground request timed out";
    return `Rust Playground error: ${err.message}`;
  }
  return "Rust Playground error";
}

async function fetchPlaygroundWithRetry(
  merged: string,
  isTest: boolean,
): Promise<PlaygroundResponse> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(
        PLAYGROUND_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: "stable",
            mode: "debug",
            edition: "2021",
            crateType: "bin",
            tests: isTest,
            code: merged,
            backtrace: false,
          }),
        },
        TIMEOUT_MS,
      );
      // Some failure modes (502, rate limit overlay) return non-JSON
      // bodies. Catch the parse error so we can still retry.
      const body = (await res.json()) as PlaygroundResponse;
      return body;
    } catch (err) {
      lastErr = err;
      // Last attempt — re-throw so the outer try/catch can fold it
      // into a RunResult.
      if (attempt === 1) break;
      await delay(RETRY_BACKOFF_MS);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function buildResult(
  body: PlaygroundResponse,
  isTest: boolean,
  start: number,
): RunResult {
  // Defensive everywhere: the Playground envelope is optional all
  // the way down. Treat missing fields as empty strings so we can't
  // trigger TypeErrors on .split / .test / .replace calls below.
  const stdout = body.stdout ?? "";
  const stderr = body.stderr ?? "";

  const logs: LogLine[] = [];
  if (stdout) logs.push({ level: "log", text: stdout.trimEnd() });
  if (stderr && !isCompileSuccess(stderr)) {
    // cargo emits progress like "Compiling playground v0.0.1 ..." to stderr
    // even on success. Only surface stderr lines that look like real errors.
    const filtered = filterCompilerNoise(stderr);
    if (filtered) logs.push({ level: "error", text: filtered });
  }

  // Error-envelope short-circuit: if the Playground returned
  // `{error: "..."}` with no stdout/stderr, surface the message
  // directly. Without this branch the user sees a misleading
  // "compilation failed" with empty logs.
  if (body.error && !stdout && !stderr) {
    return {
      logs,
      error: `Rust Playground: ${body.error}`,
      durationMs: performance.now() - start,
      testsExpected: isTest,
    };
  }

  const tests = isTest ? parseTestResults(stdout) : undefined;

  // A compile error means `success: false` with no tests run. We
  // also enter this branch when `success` itself is missing — a
  // malformed envelope shouldn't masquerade as a successful run.
  if (body.success !== true && (!tests || tests.length === 0)) {
    return {
      logs,
      error: extractCompileError(stderr) || "compilation failed",
      durationMs: performance.now() - start,
      testsExpected: isTest,
    };
  }

  return {
    logs,
    tests,
    durationMs: performance.now() - start,
    testsExpected: isTest,
  };
}

/// Merge user code and test code into a single crate source. The user writes
/// ordinary functions at the top level; the test file's #[test] functions
/// go into a `#[cfg(test)] mod kata_tests { ... }` block that imports the
/// parent scope via `use super::*;`.
export function joinCodeAndTests(userCode: string, testCode: string): string {
  // Ensure the file has a main() so cargo run / test is happy even if the
  // user's starter didn't include one.
  const mainFallback = /\bfn\s+main\s*\(/.test(userCode) ? "" : "\nfn main() {}\n";
  // Earlier this wrapper carried `#[allow(unused_imports)]` on the
  // `use super::*;` line to mask "unused import" warnings when a
  // test's body didn't reference anything from the parent scope.
  // That approach BACKFIRES against starters that ship
  // `#![forbid(unused_imports)]` at the file level (Rustlings does
  // this in `smart_pointers3`, `clippy3`, and a handful of other
  // exercises to make learners wire up imports deliberately):
  // `forbid` overrules `allow`, so the annotation itself fires
  // error E0453 — a hard compile error the user can't fix
  // without editing the test wrapper.
  //
  // Correct approach: don't paper over the warning at all. Lesson
  // authors of compile-only tests are expected to add a single
  // reference to a parent-scope item (`let _ = main;` is the
  // canonical pattern — `main` exists in every starter or our
  // fallback) so the import is genuinely used. The synthetic
  // `COMPILE_ONLY_TEST` template in `scripts/import-rustlings.mjs`
  // bakes this in for every compile-only exercise we generate.
  // Inline the test body WITHOUT re-indenting. The earlier
  // implementation called `indent(testCode, 4)` to align the
  // tests visually under the `mod kata_tests {` block, but that
  // pass prepends 4 spaces to EVERY non-empty line — including
  // continuation lines INSIDE multi-line string literals. The
  // canonical victim was `hashmaps3`: its `const RESULTS = "…\n…"`
  // multi-line literal got 4 leading spaces baked into every team
  // name except the first, so `scores.get("England")` worked but
  // every other lookup silently missed. Rust doesn't care about
  // indentation, so dropping the call keeps the code valid and
  // the embedded string content pristine.
  return `${userCode}${mainFallback}

#[cfg(test)]
mod kata_tests {
    use super::*;
${testCode}
}
`;
}

// `indent()` was retired alongside its sole caller in
// `joinCodeAndTests` — the per-line space prefix it added was
// corrupting continuation lines inside multi-line string
// literals (see the comment in `joinCodeAndTests` for the
// canonical victim). Kept here as a commented-out stub for
// anyone tracing through git blame; do NOT reintroduce it
// without a parser-aware variant that respects string literals.

/// Parse the cargo test output lines. They look like:
///   test tests::foo ... ok
///   test tests::bar ... FAILED
/// plus a blockish "failures:" section after all tests run listing the
/// assertion message under each name.
///
/// `stdout` is `string | undefined | null` defensively — the Playground
/// sometimes returns an envelope without it, and a `.split` call on
/// undefined was the original "parseTestResults crashed" symptom.
export function parseTestResults(stdout: string | undefined | null): TestResult[] {
  if (!stdout) return [];
  const lines = stdout.split("\n");
  const results: TestResult[] = [];
  const failureMsgs = new Map<string, string>();

  // Pass 1: test summary lines. The optional ` - should panic`
  // suffix appears between the test name and `... STATUS` for
  // tests annotated `#[should_panic]`. Without it the regex would
  // skip those tests entirely → empty `results` → the lesson
  // looked failed-with-no-tests even though every test passed.
  for (const line of lines) {
    const m = /^test\s+([\w:]+)(?:\s+-\s+should\s+panic)?\s+\.\.\.\s+(ok|FAILED|ignored)\b/.exec(line);
    if (!m) continue;
    const name = m[1].replace(/^kata_tests::/, "");
    if (m[2] === "ok") results.push({ name, passed: true });
    else if (m[2] === "FAILED") results.push({ name, passed: false });
    // ignored is skipped
  }

  // Pass 2: failure blocks like
  //   ---- kata_tests::foo stdout ----
  //   thread 'kata_tests::foo' panicked at 'assertion ...'
  for (let i = 0; i < lines.length; i++) {
    const m = /^----\s+([\w:]+)\s+stdout\s+----$/.exec(lines[i]);
    if (!m) continue;
    const name = m[1].replace(/^kata_tests::/, "");
    const msgLines: string[] = [];
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith("---- ") && lines[j].trim() !== "") {
      msgLines.push(lines[j]);
      j++;
    }
    failureMsgs.set(name, msgLines.join("\n").trim());
    i = j;
  }

  // Attach messages
  return results.map((r) =>
    r.passed ? r : { ...r, error: failureMsgs.get(r.name) || "test failed" }
  );
}

function isCompileSuccess(stderr: string | undefined | null): boolean {
  if (!stderr) return false;
  return /Finished\b/.test(stderr);
}

function filterCompilerNoise(stderr: string | undefined | null): string {
  if (!stderr) return "";
  return stderr
    .split("\n")
    .filter(
      (l) =>
        !/^\s*Compiling\b/.test(l) &&
        !/^\s*Finished\b/.test(l) &&
        !/^\s*Running\b/.test(l) &&
        l.trim().length > 0
    )
    .join("\n");
}

function extractCompileError(stderr: string | undefined | null): string | undefined {
  if (!stderr) return undefined;
  // Grab the first `error[EXXXX]:` block, which is usually the most useful.
  const match = /(error(?:\[E\d+\])?:.*?)(?=\n\n|\nwarning:|$)/s.exec(stderr);
  if (match) return match[1].trim();
  // Fallback to anything stderr-y
  const filtered = filterCompilerNoise(stderr);
  return filtered || undefined;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
