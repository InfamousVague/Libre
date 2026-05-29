//! LLM-powered ingest commands.
//!
//! The pipeline runs as a specialist chain (see INGEST.md §Pipeline):
//!
//!   clean_code      — detect code regions + repair PDF wrap artifacts +
//!                     emit Markdown with properly fenced code blocks.
//!   outline_chapter — plan the lesson breakdown for a chapter.
//!   generate_lesson — fill in a single lesson from its outline stub.
//!   retry_exercise  — ask Claude to fix an exercise that failed validation,
//!                     with the diagnostic attached.
//!
//! Every command calls api.anthropic.com/v1/messages directly over reqwest
//! so the API key stays off the frontend and CORS doesn't apply.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::settings::SettingsState;

const ANTHROPIC_API: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
// Model is now picked per-user in Settings (anthropic_model) and read fresh
// on each call. Default set in settings::Settings::default is sonnet-4-8.
//
// The 4.x Sonnet/Opus family supports up to 64k output tokens. 64k
// comfortably holds:
//   - any single exercise lesson (prose + starter + solution + tests)
//   - a full chapter's worth of clean_code repair (the Flanagan JS Async
//     chapter needed ~22k out tokens; 16k was too tight)
// We err on the high side because Anthropic only charges for tokens actually
// produced — raising the cap has no cost, only the ceiling.
// Per-model output-token ceilings. Anthropic *errors* on over-request
// (it does NOT silently clamp), so we have to send a value each model
// actually supports:
//   - Sonnet 3.7 (legacy)        128K with `output-128k-2025-02-19` beta header
//   - Sonnet 4.x (4, 4.5, 4.8)   64K   (the beta does NOT uplift the 4.x family)
//   - Opus 4.x                   64K
//   - Haiku 4.x                  32K
// 64K is the modern default — enough for the biggest clean_code /
// generate_lesson responses we emit, which peak around 40K tokens for a
// long chapter. The Sonnet 3.7 128K path is preserved for users who pin
// that specific model version, but it's not the default pick anywhere
// in the app.
fn max_tokens_for(model: &str) -> u32 {
    if model.contains("sonnet-3-7") || model.contains("sonnet-3.7") {
        128_000
    } else if model.contains("haiku") {
        32_000
    } else {
        64_000
    }
}

/// Shared cancellation channel for the ingest pipeline. A single Notify
/// across all in-flight LLM calls — when the frontend fires `cancel_ingest`,
/// every outstanding `reqwest` future in `call_llm` wakes and drops its
/// send, which actually tears down the TCP connection (vs the previous
/// behavior where frontend cancels only stopped new requests from starting).
///
/// Subsequent calls register their `.notified()` future AFTER the wake, so
/// they're not pre-cancelled by a stale notify — Notify semantics are "wake
/// the next waiter", not latched.
pub struct IngestCancel(pub std::sync::Arc<tokio::sync::Notify>);

impl Default for IngestCancel {
    fn default() -> Self {
        Self(std::sync::Arc::new(tokio::sync::Notify::new()))
    }
}

/// Fires the cancel notify — every in-flight `call_llm` wakes and returns
/// `Err("cancelled")`. Idempotent: calling it when nothing is listening is
/// a no-op (Notify drops unmatched notifications on the floor unless
/// `notify_one` queues them, which we don't use here).
#[tauri::command]
pub fn cancel_ingest(cancel: tauri::State<'_, IngestCancel>) -> Result<(), String> {
    cancel.0.notify_waiters();
    eprintln!("[llm] ⚠ cancel_ingest fired — waking in-flight requests");
    Ok(())
}

#[derive(Debug, Serialize)]
struct AnthropicRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    system: &'a str,
    messages: Vec<Msg<'a>>,
}

#[derive(Debug, Serialize)]
struct Msg<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Debug, Deserialize)]
struct AnthropicResponse {
    content: Vec<ContentBlock>,
    /// "end_turn" = normal. "max_tokens" = we capped it and the text is truncated
    /// — we need to surface that as a clear error instead of handing a
    /// half-written JSON string to serde.
    stop_reason: Option<String>,
    usage: Option<AnthropicUsage>,
}

#[derive(Debug, Deserialize)]
struct AnthropicUsage {
    input_tokens: u64,
    output_tokens: u64,
}

/// Structured return from every LLM command. Carries the generated text plus
/// accounting metadata the frontend uses to render live progress stats
/// (tokens, cost, elapsed, etc.).
#[derive(Debug, Serialize)]
pub struct LlmResponse {
    pub text: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    _kind: String,
    text: Option<String>,
}

// ---- Stage 1: clean + fence code in raw text --------------------------------

#[tauri::command]
pub async fn clean_code(
    settings: State<'_, SettingsState>,
    cancel: State<'_, IngestCancel>,
    chapter_title: String,
    raw_text: String,
) -> Result<LlmResponse, String> {
    let system = r#"You are a PDF-to-Markdown repair tool. Given the raw text of one chapter of a programming book, return a clean Markdown version where:

  - Every code sample is wrapped in a ```lang fenced block with the correct language.
  - Code that was broken across lines by PDF layout is joined back onto the right lines (watch for the classic pattern: a comment ending mid-sentence, then the continuation on the next line).
  - Chapter + section headings become # / ## / ### Markdown headings.
  - Figures and tables become placeholder lines like `[figure: …description…]`.
  - Page numbers, running headers, and "Early Release ebooks" boilerplate are stripped.

Return ONLY the repaired Markdown. No commentary, no code fences around the whole response."#;

    // clean_code is a mechanical reformat (strip boilerplate, fence code,
    // rewrite headings). Sonnet is optimal for this — Opus adds no quality
    // here, just cost + wall-clock time (Opus is ~2x slower at generating
    // output). Pin Sonnet regardless of the user's model pick.
    call_llm(
        &settings,
        &cancel,
        system,
        &format!("Chapter: {chapter_title}\n\n---\n\n{raw_text}"),
        Some("claude-sonnet-4-8"),
        &format!("clean_code[{chapter_title}]"),
    )
    .await
}

// ---- Stage 2: outline the chapter into lesson stubs -------------------------

#[tauri::command]
pub async fn outline_chapter(
    settings: State<'_, SettingsState>,
    cancel: State<'_, IngestCancel>,
    chapter_title: String,
    cleaned_markdown: String,
    language: String,
) -> Result<LlmResponse, String> {
    let system = r#"You plan Codecademy-style interactive lessons from technical-book chapters. Given a cleaned Markdown version of one chapter, return a JSON array of lesson stubs that together cover the chapter. Aim for 8–14 stubs.

Each stub is:

  { "id": "kebab-case-slug", "kind": "reading" | "exercise" | "quiz", "title": "...", "intent": "one sentence summary of what the lesson teaches or asks" }

Guidelines:
  - Alternate reading ⇄ exercise so the user is always either learning or practicing.
  - Insert a "quiz" stub roughly every 4–6 lessons as a checkpoint.
  - Exercises should have a clear, testable task — ideally tied to a concrete API or pattern from the source text.
  - Reading lessons should each cover ONE concept — don't merge multiple topics into a single stub.
  - Ids must be unique within the chapter.

Return ONLY the JSON array. No preamble, no markdown fences."#;

    let prompt = format!(
        "Language (target for exercises): {language}\nChapter title: {chapter_title}\n\n---\n\n{cleaned_markdown}"
    );
    call_llm(
        &settings,
        &cancel,
        system,
        &prompt,
        None,
        &format!("outline_chapter[{chapter_title}]"),
    )
    .await
}

// ---- Stage 3: generate the full content for one lesson stub -----------------

#[tauri::command]
pub async fn generate_lesson(
    settings: State<'_, SettingsState>,
    cancel: State<'_, IngestCancel>,
    chapter_title: String,
    cleaned_markdown: String,
    language: String,
    stub: String,                    // JSON string: { id, kind, title, intent }
    prior_solution: Option<String>,  // if section-progressive and this is a continuation
) -> Result<LlmResponse, String> {
    let system = r#"You author one Codecademy-style lesson at a time for the Libre app. Given the chapter's cleaned Markdown as reference, the target language, and a lesson stub (id, kind, title, intent), return a single JSON object matching one of these shapes depending on kind.

EVERY non-quiz lesson (reading / exercise / mixed) MUST additionally include two top-level enrichment fields:

  "objectives": [ "3 to 5 short bullets (8-14 words each) saying what the learner will KNOW or be able to DO after this lesson" ],
  "enrichment": {
    "glossary": [
      { "term": "closure", "definition": "One-sentence plain-language definition of the term as used in this lesson." }
    ],
    "symbols": [
      {
        "pattern": "Array.prototype.map",
        "signature": "arr.map(callback(item, index?, array?)) -> Array",
        "description": "Creates a new array by applying a function to every element.",
        "docUrl": "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map"
      }
    ]
  }

Enrichment rules:
  - `objectives`: 3-5 bullets, imperative / outcome-focused. Start with verbs ("Explain…", "Write…", "Identify…"). No fluff. Skip this field ONLY for pure quiz lessons.
  - `glossary`: every term-of-art the lesson INTRODUCES (not everyday English). Typical lessons have 2-6 entries. Use the term as it first appears in the body so case/spacing matches. Definitions are ONE sentence, ≤ 25 words, no jargon.
  - `symbols`: every identifier that appears inside backticks in the body and maps to a documented stdlib / built-in / language feature (e.g. `Array.prototype.map`, `Vec::new`, `std::io::Read`, `async/await`, `goroutine`, `fmt.Println`). Skip local variable names or user-defined identifiers.
    - `pattern`: the exact backticked string as the body uses it. If the body writes it multiple different ways (e.g. `map` and `Array.prototype.map`), list both as separate entries pointing at the same doc.
    - `docUrl`: canonical official docs. JS/TS → developer.mozilla.org. Rust → doc.rust-lang.org. Go → pkg.go.dev. Python → docs.python.org. Swift → developer.apple.com or swift.org. NEVER make up URLs — omit the field if you don't know a real one.
    - `signature` and `description` are optional but strongly preferred when the symbol has a stable, well-known shape.

CALLOUTS inside `body`:
  Use GitHub-style callout syntax where helpful. Syntax: a blockquote whose FIRST line is `[!TYPE]` with TYPE ∈ {NOTE, WARNING, TIP, EXAMPLE}. E.g.:

    > [!NOTE]
    > Rust's `String` owns its heap buffer, while `&str` is just a borrowed view.

    > [!WARNING]
    > `unwrap()` panics on `None`. Prefer `?` or a match in production code.

  Use them sparingly — 0-2 per lesson. Overuse blunts the effect.

INLINE PLAYGROUND SANDBOXES inside `body`:
  When the prose says "try it" or demonstrates a small self-contained idea, you MAY emit a fenced code block with the info string `<language> playground` to render it as an inline runnable editor in the reader. Example:

    ```javascript playground
    const xs = [1, 2, 3];
    console.log(xs.map(x => x * 2));
    ```

  Rules:
    - Snippet must be ≤ 10 lines and self-contained (no test harness, no module.exports, no imports of user code).
    - Use sparingly — 0-2 per lesson.
    - Only for the lesson's primary language.

READING:
  { "id": "...", "kind": "reading", "title": "...", "body": "markdown with fenced code blocks", "objectives": [...], "enrichment": { ... } }

EXERCISE (single-file, the default):
  {
    "id": "...", "kind": "exercise", "title": "...",
    "language": "...",
    "body": "markdown prompt explaining the task",
    "starter": "runnable file ending with module.exports = { ... } (JS) or equivalent",
    "solution": "reference solution — must pass every test",
    "tests": "test file using the harness below"
  }

EXERCISE (multi-file, when the task genuinely benefits from multiple files):
  {
    "id": "...", "kind": "exercise", "title": "...",
    "language": "...",
    "body": "markdown prompt",
    "files": [
      { "name": "index.html", "language": "html", "content": "..." },
      { "name": "style.css",  "language": "css",  "content": "..." },
      { "name": "user.js",    "language": "javascript", "content": "..." }
    ],
    "solutionFiles": [ /* same shape as files */ ],
    "starter": "<concatenation of runnable files — kept for legacy single-file runners>",
    "solution": "<concatenation of runnable files in solutionFiles>",
    "tests": "test file (still a single string)"
  }

QUIZ:
  {
    "id": "...", "kind": "quiz", "title": "...",
    "body": "optional short intro (may be empty)",
    "questions": [
      { "kind": "mcq", "prompt": "...", "options": ["a","b","c","d"], "correctIndex": 0, "explanation": "..." },
      { "kind": "short", "prompt": "...", "accept": ["answer-1","alt"], "explanation": "..." }
    ]
  }

When to use multi-file EXERCISE (STRONG RULES — do not shortcut):
  - Rust lessons that teach modules, crates, workspaces, or file organization (e.g. Chapter 7 of the Rust Book — "Packages, Crates, and Modules") MUST ship as multi-file. Do NOT cram `mod foo { ... }` blocks into a single file to simulate multi-file layout — the whole point of the lesson is the filesystem layout.
  - Rust integration-test lessons MUST ship as multi-file with `src/lib.rs` + `tests/integration_test.rs` (and optionally `tests/common/mod.rs`). Integration tests only work in the `tests/` directory — a single-file exercise cannot teach them correctly.
  - Rust Chapter 12-style CLI projects (minigrep) that split logic across `src/main.rs` + `src/lib.rs` MUST ship multi-file once the book has demonstrated the split.
  - Web/UI tasks needing HTML + CSS + JS MUST ship multi-file (`index.html`, `style.css`, `user.js`).
  - Tasks where the book's example is itself shown as multiple files SHOULD mirror that layout.
  - Otherwise default to single-file. Don't split just because you can.

File naming + language:
  - "language" per file: "javascript", "typescript", "python", "rust", "swift", "html", "css", "json", "plaintext"
  - For Rust: use real paths like "src/lib.rs", "src/main.rs", "src/front_of_house.rs", "src/front_of_house/hosting.rs", "tests/integration_test.rs", "Cargo.toml" (Cargo.toml uses language "plaintext")
  - For web: "index.html", "style.css", "user.js"
  - The runnable files must match the lesson's primary `language`. CSS/HTML in a JS lesson are visual support, not executable.
  - `starter` and `solution` (the legacy flat strings) must still be populated. For multi-file, concatenate the runnable files' contents with "// ---- <name> ----\n" separators (or the language's equivalent comment syntax) so legacy single-file runners still work.

TEST HARNESS — pick per `language`:

  If language == "javascript" or "typescript":
    test(name, fn)
    expect(x).toBe(y)
    expect(x).toEqual(y)
    expect(x).toBeTruthy() / toBeFalsy()
    expect(x).toBeGreaterThan(n) / toBeLessThan(n)
    expect(x).toContain(item)
    expect(x).toBeCloseTo(v, digits)
    expect(fn).toThrow()
    require('./user')   // returns the user's module.exports
    Starter + solution MUST end with `module.exports = { ... }`.

  If language == "python":
    test("name of test", lambda: ...) or
    def test_name():
      expect(x).to_be(y)
      expect(x).to_equal(y)
      expect(x).to_be_truthy() / to_be_falsy()
    User code is exposed as the `user` module; import with `from user import X`.

  If language == "rust":
    Standard Rust test syntax — NOT a JavaScript-style harness. Use:
      #[test]
      fn test_xyz() {
          assert_eq!(add(2, 3), 5);
          assert!(condition);
          assert_ne!(a, b);
      }
    Tests are wrapped automatically in `#[cfg(test)] mod tests { use super::*; ... }` by the runtime; emit raw `#[test] fn ... { ... }` functions in the `tests` field, NOT a module declaration.
    For multi-file Rust with integration tests, put the `#[test]` functions directly in `tests/integration_test.rs` as a standalone file and leave `tests` (the legacy string) empty — integration tests live outside src/.
    NEVER write `test("name", || { ... })` or `expect(x).to_be(y)` in Rust — those are JavaScript idioms and will not compile.

  If language == "swift":
    The Swift runtime is run-only (no automated grading in V1). Leave `tests` as an empty string "".

Writing guidelines:
  - Rewrite tight in Libre voice — friendly, terse, no filler. Do not quote long passages from the source verbatim.
  - Use `backticks` for identifiers and ```lang fences for code in lesson bodies.
  - Exercise starters MUST be runnable (no TODO syntax that errors on load) — use comments for TODOs. For Rust exercises, `fn main() { ... }` should compile even with the user's function stubbed to `todo!()`.
  - Quizzes: 3–5 questions, mix of mcq (4 options, one correct) and short-answer. `accept` is a list of equally-valid answers (case/punctuation-insensitive match).

Return ONLY the JSON object. No preamble, no code fences."#;

    let prior = prior_solution
        .as_deref()
        .map(|s| format!("\n\nPrior lesson's solution (use this as the starter for continuity):\n```\n{s}\n```"))
        .unwrap_or_default();

    let prompt = format!(
        "Language: {language}\nChapter: {chapter_title}\nStub: {stub}{prior}\n\n---\n\nChapter source:\n\n{cleaned_markdown}"
    );
    call_llm(
        &settings,
        &cancel,
        system,
        &prompt,
        None,
        &format!("generate_lesson[{}]", &stub),
    )
    .await
}

// ---- Retry: fix an exercise that failed validation --------------------------

#[tauri::command]
pub async fn retry_exercise(
    settings: State<'_, SettingsState>,
    cancel: State<'_, IngestCancel>,
    original_lesson: String, // JSON string of the previous attempt
    failure_reason: String,  // human-readable description of what went wrong
) -> Result<LlmResponse, String> {
    // Output hardening: we've seen Claude slip into prose on retries
    // ("Looking at the failure message, the test is failing because…").
    // The combination below keeps it on-task:
    //   1. Explicit rule + cost-of-failure framing in the system prompt
    //   2. Forced-format cue at the end of the user message
    //   3. A positive example of the expected first character
    //   4. A per-shape reminder about the JSON-only contract
    // The frontend's parseJson also has a prose-stripping fallback as a
    // belt-and-suspenders recovery for the rare slip-through.
    let system = r#"You are fixing a Libre exercise lesson that failed automated validation.

The user will send you the original lesson JSON and a description of the failure. You must return a corrected lesson JSON matching the same schema.

Common failures:
  - "solution did not pass test X" — fix the solution to satisfy that assertion.
  - "starter already passes every test" — add a TODO/stub to the starter so the user has something to implement.
  - "tests reference an identifier the solution does not export" — align the module.exports with the require('./user') in tests.

HARD OUTPUT CONTRACT:
  - Your response MUST begin with the character `{`.
  - Your response MUST end with the character `}`.
  - NO analysis, NO explanation, NO preamble like "Looking at…", NO markdown code fences, NO trailing commentary.
  - The response will be passed directly to JSON.parse. Any other content breaks the build.
  - If you're tempted to explain your reasoning, inline it in the lesson's `body` markdown instead — never outside the JSON."#;

    let prompt = format!(
        "Failure: {failure_reason}\n\nOriginal lesson JSON:\n{original_lesson}\n\n\
         Return ONLY the corrected JSON object. Begin your response with `{{` and nothing else."
    );
    call_llm(&settings, &cancel, system, &prompt, None, "retry_exercise").await
}

// ---- One-off enrichment pass for an already-generated lesson --------------

/// Lighter-weight sibling of `generate_lesson`: takes an existing lesson's
/// title + body and returns ONLY the enrichment payload (`objectives`,
/// `enrichment.glossary`, `enrichment.symbols`). Lets the user upgrade
/// previously-generated courses to the new reading experience without
/// paying to regenerate starters / solutions / tests / hints / prose from
/// scratch.
#[tauri::command]
pub async fn enrich_lesson(
    settings: State<'_, SettingsState>,
    cancel: State<'_, IngestCancel>,
    language: String,
    title: String,
    body: String,
) -> Result<LlmResponse, String> {
    let system = r#"You add reading-experience enrichment to an existing Libre lesson. Given the lesson's language, title, and body markdown, return a JSON object with EXACTLY these three fields — nothing else:

  {
    "objectives": [ "3 to 5 short bullets (8-14 words each), verb-led, describing what the learner KNOWS or can DO after reading" ],
    "glossary": [
      { "term": "closure", "definition": "One-sentence plain-language definition (≤ 25 words) of the term as used in this lesson." }
    ],
    "symbols": [
      {
        "pattern": "Array.prototype.map",
        "signature": "arr.map(callback(item, index?, array?)) -> Array",
        "description": "Creates a new array by applying a function to every element.",
        "docUrl": "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map"
      }
    ]
  }

Rules:
  - `objectives`: 3-5 bullets. Verb-led outcomes, not table-of-contents. Skip entirely (return `"objectives": []`) if this is a pure quiz and there's nothing substantive to learn.
  - `glossary`: every term-of-art the body INTRODUCES (not everyday English). Typical lessons have 2-6 entries. Use the term exactly as it first appears in the body — case and spacing must match so the reader can first-use-underline it. One-sentence plain-language definitions.
  - `symbols`: every identifier that appears inside backticks in the body AND maps to a documented language built-in, stdlib, or widely-known framework API.
    - `pattern`: the exact backticked string as used in the body. If multiple forms appear (`map` and `Array.prototype.map`), list both.
    - `docUrl`: canonical official docs only. JS/TS → developer.mozilla.org. Rust → doc.rust-lang.org. Go → pkg.go.dev. Python → docs.python.org. Swift → developer.apple.com or swift.org. NEVER make up URLs — omit the field if you're not sure.
    - Skip local variables, user-defined identifiers, or function names the lesson itself defines.
  - Do NOT invent signatures or descriptions for symbols you aren't sure about. Better to omit a symbol than to ship wrong docs.

Return ONLY the JSON object. Begin with `{`, end with `}`. No preamble, no markdown fences, no explanation."#;

    let prompt = format!(
        "Language: {language}\nTitle: {title}\n\n---\n\nBody:\n\n{body}"
    );

    call_llm(&settings, &cancel, system, &prompt, None, "enrich_lesson").await
}

// ---- Book metadata detection (for import auto-fill) -----------------------

/// Identify a technical book's primary language, title, and author from an
/// excerpt of its front matter. The frontend extracts the PDF text and
/// passes ~8000 chars (usually enough to cover cover + title page +
/// copyright + ToC beginning); we call Claude with a tight JSON-only
/// prompt and let the frontend parse the response.
#[tauri::command]
pub async fn detect_book_meta(
    settings: State<'_, SettingsState>,
    cancel: State<'_, IngestCancel>,
    excerpt: String,
) -> Result<LlmResponse, String> {
    let system = r#"You identify a technical book's programming language, title, and author from an excerpt of its front matter.

Given up to ~8000 characters from the beginning of the book (cover, title page, copyright, first chapter intro), return a single JSON object:

  { "title": "...", "author": "...", "language": "..." }

Rules:
- `language`: MUST be exactly one of: "javascript" | "typescript" | "python" | "rust" | "swift" | "go" | "c" | "cpp" | "java" | "kotlin" | "csharp" | "assembly". Pick the one the book PRIMARILY teaches — for "JavaScript for Rubyists", return "javascript". For books about CPU architecture, machine code, or instruction sets (ARM, x86, RISC-V, MIPS, 6502), return "assembly". For C++ use "cpp"; for C# use "csharp". If the code examples shown disagree with the title, pick whichever dominates the examples. If the book is clearly not about a programming language (general software design, math, etc.), still pick the closest fit from the allowed set; fall back to "javascript" when truly nothing applies.
- `author`: the primary author(s) as they appear on the title page. Join multiple with " & " (e.g. "Alice Smith & Bob Jones"). Strip academic titles and suffixes ("Dr.", "PhD", "Ph.D.").
- `title`: the book's main title. Drop subtitles and edition numbers. "JavaScript: The Definitive Guide, 7th Edition" → "JavaScript: The Definitive Guide". "Programming Rust, 2nd Edition: Fast, Safe Systems Development" → "Programming Rust".

Return ONLY the JSON object. Begin with `{` and end with `}`. No preamble, no markdown fences, no explanation."#;

    let prompt = format!("Book excerpt:\n\n{excerpt}");

    call_llm(
        &settings,
        &cancel,
        system,
        &prompt,
        None,
        "detect_book_meta",
    )
    .await
}

// ---- Standalone: one kata-style challenge (for challenge packs) ------------

/// Generate a single stand-alone coding challenge. Unlike `generate_lesson`
/// there's no book / chapter context — the language, difficulty tier, and
/// topic bucket are the only inputs. The system prompt is tuned for kata
/// problems: one tight focus, ≥3 strong assertions, NO "does-it-compile"
/// tests. Uses `model_override` when the caller wants to pin Opus for a
/// bulk pack regardless of what's in Settings.
#[tauri::command]
pub async fn generate_challenge(
    settings: State<'_, SettingsState>,
    cancel: State<'_, IngestCancel>,
    language: String,
    difficulty: String,
    topic: String,
    model_override: Option<String>,
) -> Result<LlmResponse, String> {
    let system = r#"You author ONE stand-alone kata-style coding challenge for the Libre app. Given a language, a difficulty tier, and a topic, return a single JSON object:

  {
    "title": "short descriptive title (≤ 60 chars)",
    "body": "markdown problem statement: what to build, input/output shape, 1-2 examples, edge cases",
    "starter": "runnable starter code containing a function stub the learner fills in",
    "solution": "reference solution — MUST pass every assertion in `tests`",
    "tests": "language-appropriate test code (see TEST HARNESS rules below)",
    "hints": ["optional", "progressive", "hints"]
  }

Multi-file variant (use ONLY when the language genuinely needs a split — Rust workspace / integration tests, web HTML+CSS+JS — not for standard single-function katas):
  {
    "title": "...",
    "body": "...",
    "files": [ { "name": "...", "language": "...", "content": "..." }, ... ],
    "solutionFiles": [ ... ],
    "starter": "<concat of files — legacy fallback>",
    "solution": "<concat of solutionFiles — legacy fallback>",
    "tests": "...",
    "hints": [ ... ]
  }

DIFFICULTY GUIDE:
  easy   — one concept, ~5-10 lines of solution, obvious approach.
  medium — two concepts composed (e.g. iterators + structs), 10-25 lines, one non-obvious step.
  hard   — algorithmic or subtle edge cases, 25-60 lines, multiple concepts interacting.

TOPIC: focus the problem around the given topic. If the topic is "iterators", every test should exercise iterator behavior; don't drift into unrelated concepts.

TEST HARNESS — STRONG RULES (non-negotiable):
  - Every test MUST contain at least one real assertion that exercises learner code with a specific input and checks a specific output/state.
  - BANNED patterns (a static linter rejects packs that ship these):
      * Tests that just call the function and assert nothing ("trust the structure" — always passes).
      * Tests that only check the function's type signature or existence ("does it compile" — always passes once parsed).
      * `let _ = fn(...)` in a Rust #[test] with no assert after — compile-only.
      * `func kataTest_x() error { return nil }` (Go) that never branches to `return fmt.Errorf(...)` — always passes.
      * Kotlin / Java / C / C++ / C# tests whose main() prints `KATA_TEST::name::PASS` as a literal without any conditional — always passes.
      * A Go starter that returns a `nil` channel: reads from it block forever, the sandbox reports 0 tests parsed, and the runtime mis-interprets that as "pass". Give the starter a literal stub like `return make(chan int)` instead (still wrong behaviour, but produces real test failures rather than a deadlock).
      * For binary-crate outputs where stdout-capture is impractical (Rust main printing), REFORMULATE the challenge so the learner writes a function that RETURNS the value, and `main` just prints it. The tests then `assert_eq!` on the function's return — never on stdout.
  - EXACTLY ≥ 3 test cases is a FLOOR, not a target. Provide 4–6 cases covering:
      1. Normal case — the expected everyday input.
      2. Edge case — empty / zero / boundary / single-element / negative / unicode as applicable.
      3. Error / unusual case — invalid input, type mismatch, overflow, or a case most learners forget.
      4. (encouraged) A second normal-case variant with different data to catch hard-coded answers.
  - Before returning, mentally run the STARTER through the tests. At least one test must produce a FAIL when the starter is evaluated — if every assertion happens to pass given the starter's stub output (e.g. tests all compare against `nil` / `""` / `0` which the starter also returns), REWRITE the tests so specific non-default values are required.

  Rust:
    Use standard Rust test syntax:
      #[test]
      fn test_reverse_basic() {
          assert_eq!(reverse("hello"), "olleh");
      }
    The runtime wraps your `#[test]` functions in `#[cfg(test)] mod tests { use super::*; ... }` automatically. Emit raw `#[test] fn ... { ... }` functions.
    NEVER use JavaScript idioms (`test("name", || { ... })`, `expect(x).to_be(y)`) in Rust.
    If the task requires printing to stdout, REFORMULATE: make the learner implement a function that RETURNS the string, and have `main` (in `starter`/`solution`) just `println!("{}", user_fn())`. Tests assert on the return value.

  TypeScript / JavaScript:
    Use the Libre harness:
      test("description", () => { ... })
      expect(x).toBe(y)
      expect(x).toEqual(y)
      expect(fn).toThrow()
    Starter + solution MUST end with `module.exports = { ... }` listing every exported symbol. Tests import via `require('./user')`.

  Go:
    The runtime uses a structured-stdout protocol (NOT `go test`, since the Playground can't run it from a single source).
    Your `tests` field MUST be a complete Go source with `func main()` that:
      1. Defines helper functions named `kataTest_<name>() error` — each runs one assertion and returns `nil` on pass, a non-nil `error` (wrap with `fmt.Errorf`) on fail.
      2. From `main()`, iterates over them and prints EXACTLY:
           `KATA_TEST::<name>::PASS` on success
           `KATA_TEST::<name>::FAIL::<short one-line reason>` on failure
    Do NOT import "testing" or use `*testing.T` — the Playground isn't running `go test`.
    Starter + solution are helper functions only (no `func main()`); the test file provides main.
    Example main:
      func main() {
          tests := []struct{ name string; fn func() error }{
              {"test_reverse_basic", kataTest_test_reverse_basic},
              {"test_reverse_empty", kataTest_test_reverse_empty},
          }
          for _, t := range tests {
              if err := t.fn(); err != nil {
                  fmt.Printf("KATA_TEST::%s::FAIL::%s\n", t.name, err.Error())
              } else {
                  fmt.Printf("KATA_TEST::%s::PASS\n", t.name)
              }
          }
      }

  Python:
    Use the Libre harness: `def test_name(): expect(x).to_be(y)`.
    User code is exposed as `user` module; tests do `from user import thing`.

  Swift:
    Run-only (no automated grading). Set `tests` to "".

WRITING GUIDELINES:
  - Title: concrete verb phrase ("Reverse a String", "Count Unique Words", "Implement LRU Cache").
  - Body: lead with what to build, THEN input/output examples, THEN constraints. Use ```lang code fences for snippets. Keep it tight — kata problems are ≤ 150 words of prose.
  - Starter: the function signature + a `TODO: ...` comment in the body. MUST compile. For Rust stubs, use `todo!()`. For TS/Go, return a trivial default.
  - Solution: must pass every test you wrote. Don't write a test you can't satisfy.
  - Hints: 1-3 short progressive nudges. Optional — omit the field if no natural hints.

Return ONLY the JSON object. Begin with `{`, end with `}`. No markdown fences, no preamble."#;

    let prompt = format!(
        "Language: {language}\nDifficulty: {difficulty}\nTopic: {topic}\n\nGenerate one challenge matching the constraints above. Return ONLY the JSON."
    );

    call_llm(
        &settings,
        &cancel,
        system,
        &prompt,
        model_override.as_deref(),
        &format!("generate_challenge[{}/{}/{}]", language, difficulty, topic),
    )
    .await
}

// ---- Docs-site lesson generation --------------------------------------------
//
// One page from a crawled doc site → one lesson. Different from
// `generate_lesson` which assumes the input is a book chapter being split
// into multiple lessons; here each PAGE is already a lesson-sized chunk
// of content, and the desired kind (reading / exercise / quiz) is passed
// in by the caller's heuristic (code-block count, page depth, etc.).

/// `lesson_kind` must be one of "reading", "exercise", or "quiz" — the
/// frontend picks via a simple heuristic (>= 2 code blocks ⇒ exercise,
/// 0-1 ⇒ quiz, reference pages ⇒ reading).
///
/// When the crawl is sidebar-driven, the frontend passes neighbour
/// context (`chapter_title`, previous/next lesson titles, position in
/// chapter) so the generated lesson can reference what the learner just
/// read and hint at what comes next. All four are optional — the BFS
/// fallback path leaves them None and the prompt adapts.
#[tauri::command]
pub async fn generate_lesson_from_docs_page(
    settings: State<'_, SettingsState>,
    cancel: State<'_, IngestCancel>,
    page_url: String,
    page_title: String,
    page_markdown: String,
    language: String,
    lesson_kind: String,
    lesson_id: String,
    chapter_title: Option<String>,
    previous_lesson_title: Option<String>,
    next_lesson_title: Option<String>,
    chapter_position: Option<u32>,
    chapter_total: Option<u32>,
    model_override: Option<String>,
) -> Result<LlmResponse, String> {
    let system = r#"You turn ONE page from an online documentation site into ONE Codecademy-style lesson for the Libre learning app. The input is already lesson-sized — don't try to split it. The input is already cleaned markdown, but may still contain navigation fragments, edit-page links, or other chrome — filter these out silently.

Given:
  - a lesson kind (reading / exercise / quiz) — obey this strictly
  - the target programming language
  - the page's title + source URL (for attribution)
  - the page's main-content markdown

Return ONE JSON object. All lesson kinds use the SAME schema as `generate_lesson`, including the `objectives` + `enrichment` enrichment fields for non-quiz lessons (see fields definition below).

READING lesson shape:
  { "id": "<lesson_id>", "kind": "reading", "title": "...", "body": "markdown with preserved fenced code blocks", "objectives": [...], "enrichment": { "glossary": [...], "symbols": [...] } }

  - REWRITE the docs page into lesson voice — "you will learn", "let's", second-person, teaching tone. Do NOT paste the source verbatim.
  - Keep useful fenced code blocks from the source. Drop or trim reference tables that run more than ~15 rows; summarize with "see the full table on the source page" + a markdown link.
  - Length: 200-600 words of prose. If the source is much longer, condense — the learner can always click through to the original.
  - Attribution: at the END of `body`, add a small markdown note: `_Adapted from [Page Title](url)._`

EXERCISE lesson shape:
  {
    "id": "<lesson_id>", "kind": "exercise", "title": "...",
    "language": "...",
    "body": "markdown prompt (what to build, 2-4 sentences, no boilerplate)",
    "starter": "runnable starter with a `// TODO:` and a tiny scaffold",
    "solution": "reference solution that passes every test",
    "tests": "test code — see TEST HARNESS below",
    "objectives": [...],
    "enrichment": { "glossary": [...], "symbols": [...] }
  }

  - INVENT a small, focused practice task rooted in the page's concept. DO NOT just copy an example verbatim from the source — design a fresh exercise that tests understanding of the SAME idea.
  - Scope: 5-20 lines of solution code. Single-concept, single-function when possible.
  - If the page is too meta or environmental to turn into a code exercise (e.g. "installing Node"), DOWNGRADE to a quiz instead and use the quiz shape below.

QUIZ lesson shape:
  {
    "id": "<lesson_id>", "kind": "quiz", "title": "...",
    "body": "optional 1-2 sentence intro (may be empty string)",
    "questions": [
      { "kind": "mcq", "prompt": "...", "options": ["...", "...", "...", "..."], "correctIndex": 0, "explanation": "..." }
    ]
  }

  - 3-6 questions, mix of mcq (4 options) and short (2-4 accepted answers).
  - Every question targets a concept the source page TEACHES. Don't ask trivia the page doesn't cover.
  - Explanations are 1 sentence, reinforcing WHY the answer is correct.

SHARED RULES:
  - objectives: 3-5 bullets starting with a verb ("Explain...", "Write...", "Identify..."), 8-14 words each.
  - enrichment.glossary: every term-of-art the lesson introduces. 2-6 entries typical. Definitions ≤ 25 words.
  - enrichment.symbols: every backticked identifier that maps to an official stdlib / built-in / language feature. Include canonical docUrl when known (MDN / doc.rust-lang.org / pkg.go.dev / docs.python.org / developer.apple.com). Never fabricate URLs.
  - Use GitHub-style callouts (`> [!NOTE]`, `> [!WARNING]`, `> [!TIP]`, `> [!EXAMPLE]`) where they add value. 0-2 per lesson, max.
  - Use `<language> playground` fences for short runnable demos. 0-2 per lesson.

TEST HARNESS (for EXERCISE only) — pick per `language`:

  JavaScript / TypeScript:
    test("description", () => { ... })
    expect(x).toBe(y) / toEqual(y) / toBeTruthy() / toBeFalsy() / toBeGreaterThan(n) / toBeLessThan(n) / toContain(item) / toBeCloseTo(v, digits)
    expect(fn).toThrow()
    Starter + solution MUST end with `module.exports = { ... }` listing every export.

  Python:
    Use `def test_name(): expect(x).to_be(y)`.
    Learner code is exposed as the `user` module; tests do `from user import foo`.

  Rust:
    Raw #[test] fns. No JS idioms. If output is stdout-based, reformulate so the learner writes a function that RETURNS the value and main prints it.

  Go:
    Structured-stdout protocol — tests are a full Go `func main()` that calls `kataTest_<name>() error` helpers and prints
      KATA_TEST::<name>::PASS
      KATA_TEST::<name>::FAIL::<reason>
    Do NOT use `testing.T`.

  Swift:
    Run-only — set `tests` to "".

  Tests MUST contain ≥ 3 real assertions (normal case, edge case, error/unusual case). No "always passes" stubs.

Return ONLY the JSON object. Begin with `{`, end with `}`. No markdown fences, no preamble."#;

    // Neighbour context block — included in the prompt only when the
    // frontend supplied it. Lets lessons reference what the learner
    // just read ("Building on closures from the previous lesson…") and
    // telegraph what's next, which makes the chapter flow like a book
    // instead of a pile of independent readings.
    let mut context_block = String::new();
    if let Some(ref ch) = chapter_title {
        context_block.push_str(&format!("Chapter: {}\n", ch));
    }
    if let (Some(pos), Some(total)) = (chapter_position, chapter_total) {
        context_block.push_str(&format!(
            "Position in chapter: lesson {} of {}\n",
            pos + 1,
            total
        ));
    }
    if let Some(ref prev) = previous_lesson_title {
        context_block.push_str(&format!("Previous lesson: {}\n", prev));
    }
    if let Some(ref next) = next_lesson_title {
        context_block.push_str(&format!("Next lesson: {}\n", next));
    }
    if !context_block.is_empty() {
        context_block.push_str(
            "\nWhen the Previous lesson is known, WEAVE a short (1-sentence) callback into your opening so the lesson feels continuous — \"Now that you've seen X, let's...\". When the Next lesson is known, close the body with a subtle cliffhanger pointing forward. Don't be heavy-handed; one sentence each.\n",
        );
    }

    let prompt = format!(
        "Lesson kind: {lesson_kind}\nLanguage: {language}\nLesson id: {lesson_id}\nPage title: {page_title}\nSource URL: {page_url}\n{context_block}\n--- PAGE MARKDOWN ---\n{page_markdown}\n--- END PAGE MARKDOWN ---\n\nGenerate ONE lesson of the specified kind. Return ONLY the JSON."
    );

    call_llm(
        &settings,
        &cancel,
        system,
        &prompt,
        model_override.as_deref(),
        &format!("generate_lesson_from_docs_page[{}::{}]", lesson_kind, lesson_id),
    )
    .await
}

/// Generate a single capstone exercise for a chapter of reading
/// lessons. Called AFTER all the readings in a chapter are generated —
/// invents a coding task that exercises the chapter's core concepts so
/// the docs-site course reads like a book ("read a few pages, then
/// practice what you learned").
///
/// `lesson_summaries` is a JSON-encoded array of `{ title, body_snippet }`
/// objects — the frontend assembles it from the already-generated
/// readings' bodies, capped at ~500 chars per snippet so the prompt
/// stays within a reasonable budget even for long chapters.
#[tauri::command]
pub async fn generate_chapter_capstone(
    settings: State<'_, SettingsState>,
    cancel: State<'_, IngestCancel>,
    chapter_title: String,
    language: String,
    lesson_summaries: String,
    lesson_id: String,
    model_override: Option<String>,
) -> Result<LlmResponse, String> {
    let system = r#"You generate ONE capstone coding EXERCISE for a chapter of reading lessons in the Libre learning app. The learner has just read every lesson in the chapter; now they need to practice what they learned.

Your job: invent a small, focused coding task that synthesizes the chapter's CORE concepts into a single practice problem. The exercise should feel like the natural "try it now" cap at the end of a book chapter.

Return ONE JSON object matching the EXERCISE schema (same shape as `generate_lesson` / `generate_lesson_from_docs_page`):
  {
    "id": "<lesson_id>",
    "kind": "exercise",
    "title": "concrete verb phrase, ≤ 60 chars — what the learner will build",
    "language": "<language>",
    "body": "markdown prompt: 3-6 sentences explaining the task + 1-2 concrete examples of input/output. Lead with `> [!EXAMPLE]` showing what 'done' looks like when it's not obvious from the description.",
    "starter": "runnable starter containing a function stub + `// TODO:` comments. MUST compile.",
    "solution": "reference solution that passes every test",
    "tests": "language-appropriate test code (see TEST HARNESS below)",
    "hints": ["1-3 progressive hints. Optional — omit field if no natural hints."],
    "objectives": ["3-5 bullets, imperative, 8-14 words each"],
    "enrichment": {
      "glossary": [{ "term": "...", "definition": "..." }],
      "symbols":  [{ "pattern": "...", "signature": "...", "description": "...", "docUrl": "..." }]
    }
  }

Multi-file variant — use ONLY when the language genuinely needs a split (Rust workspace / integration tests, web HTML+CSS+JS):
  add `files: [{name,language,content}]` and `solutionFiles: [...]` alongside the legacy `starter`/`solution` flat strings.

KEY RULES:
  1. DO NOT copy an example verbatim from the chapter readings. Invent a FRESH problem that exercises the SAME concepts.
  2. Scope: 10-30 lines of solution code. Designed to be solvable in 15-30 minutes by a learner who just read the chapter.
  3. Concept coverage: pull from the chapter's MAIN ideas, not an obscure footnote. The exercise should feel like "the thing this chapter was really teaching".
  4. Title: verb + noun, e.g. "Build a Rate Limiter", "Parse a Config File", "Render a Scene with Lights". Not "Exercise 1" or "Chapter Capstone".
  5. If the chapter is too meta to turn into code (e.g. "How React Native Works" overview) — STILL attempt an exercise: design a SMALL task that requires the learner to APPLY the architectural knowledge (e.g. "identify which of these components re-renders when..." as a quiz-style exercise). Never return a "reading" or "quiz" — the schema above requires kind: "exercise".

TEST HARNESS — pick per `language`:

  JavaScript / TypeScript:
    test("description", () => { ... })
    expect(x).toBe(y) / toEqual(y) / toBeTruthy() / toBeFalsy() / toBeGreaterThan(n) / toBeLessThan(n) / toContain(item) / toBeCloseTo(v, digits)
    expect(fn).toThrow()
    Starter + solution MUST end with `module.exports = { ... }` listing every export.

  Python:
    `def test_name(): expect(x).to_be(y)`; learner code exposed as `user` module; tests do `from user import foo`.

  Rust:
    Raw #[test] fns. Reformulate stdout-printing tasks so the function RETURNS the value and `main` prints it. Never write a test that only checks compilation or calls without asserting — every test needs a real assertion.

  Go:
    Structured-stdout protocol — `func main()` iterates helper `kataTest_<name>() error` and prints
      KATA_TEST::<name>::PASS
      KATA_TEST::<name>::FAIL::<reason>
    Never use `testing.T`.

  Swift:
    Run-only — set `tests` to "".

  EVERY exercise MUST have ≥ 3 real assertions (normal case, edge case, error/unusual case).

Return ONLY the JSON object. Begin with `{`, end with `}`. No markdown fences, no preamble."#;

    let prompt = format!(
        "Chapter title: {chapter_title}\nLanguage: {language}\nLesson id: {lesson_id}\n\n--- CHAPTER LESSONS ---\n{lesson_summaries}\n--- END CHAPTER LESSONS ---\n\nGenerate ONE capstone exercise that lets the learner practice the chapter's core concepts. Return ONLY the JSON."
    );

    call_llm(
        &settings,
        &cancel,
        system,
        &prompt,
        model_override.as_deref(),
        &format!("generate_chapter_capstone[{}::{}]", chapter_title, lesson_id),
    )
    .await
}

// ---- Shared helper ----------------------------------------------------------

/// How many times to retry a single call on retriable statuses (429 rate limit,
/// 529 overloaded, 5xx server errors). Exponential backoff with jitter between
/// attempts. Most overload spikes clear within a minute, so 5 retries gives the
/// pipeline up to ~2 minutes to recover without human intervention.
const MAX_RETRIES: u32 = 5;

async fn call_llm(
    settings: &State<'_, SettingsState>,
    cancel: &State<'_, IngestCancel>,
    system: &str,
    user: &str,
    model_override: Option<&str>,
    label: &str,
) -> Result<LlmResponse, String> {
    let (api_key, user_model) = {
        let s = settings.0.lock();
        (s.anthropic_api_key.clone(), s.anthropic_model.clone())
    };
    let api_key = api_key
        .ok_or_else(|| "No Anthropic API key configured — add one in Settings first.".to_string())?;
    let model = model_override.map(|s| s.to_string()).unwrap_or(user_model);
    let cancel_notify = cancel.0.clone();

    eprintln!(
        "[llm] → {} model={} system_chars={} user_chars={}",
        label,
        model,
        system.len(),
        user.len()
    );

    let max_tokens = max_tokens_for(&model);
    let body = AnthropicRequest {
        model: &model,
        max_tokens,
        system,
        messages: vec![Msg { role: "user", content: user }],
    };

    let client = reqwest::Client::new();
    let start = std::time::Instant::now();

    for attempt in 0..=MAX_RETRIES {
        eprintln!(
            "[llm]   {} attempt {}/{} sending request…",
            label,
            attempt + 1,
            MAX_RETRIES + 1
        );
        let send_started = std::time::Instant::now();
        let send_fut = client
            .post(ANTHROPIC_API)
            .header("x-api-key", &api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            // Opt into extended output tokens on models that support it.
            // Harmless on models that don't — Anthropic documents the header
            // as a no-op when the target model predates the feature.
            .header("anthropic-beta", "output-128k-2025-02-19")
            .header("content-type", "application/json")
            .json(&body)
            .send();
        // tokio::select! races the HTTP future against the cancel notify.
        // When cancel wins, we drop send_fut which tears down the TCP
        // connection — the user gets instant cancellation even mid-stream
        // rather than waiting for a multi-second Claude response to finish.
        let resp = tokio::select! {
            biased;
            _ = cancel_notify.notified() => {
                eprintln!("[llm] ⚠ {} cancelled in-flight", label);
                return Err("cancelled".to_string());
            }
            r = send_fut => r,
        };

        let resp = match resp {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[llm] ✗ {} network error (after {}ms): {e}", label, send_started.elapsed().as_millis());
                if attempt < MAX_RETRIES {
                    sleep_backoff(attempt).await;
                    continue;
                }
                return Err(format!("network error: {e}"));
            }
        };

        let status = resp.status();
        eprintln!("[llm]   {} response {} after {}ms", label, status, send_started.elapsed().as_millis());
        if status.is_success() {
            let parsed: AnthropicResponse = resp
                .json()
                .await
                .map_err(|e| format!("bad response json: {e}"))?;

            if parsed.stop_reason.as_deref() == Some("max_tokens") {
                eprintln!("[llm] ✗ {} truncated at max_tokens", label);
                return Err(format!(
                    "Claude hit the {max_tokens}-token output cap for {model} before \
                     finishing — response was truncated. Switch to Sonnet (128K output) \
                     or split the prompt into smaller chunks."
                ));
            }

            let text: String = parsed
                .content
                .into_iter()
                .filter_map(|b| b.text)
                .collect::<Vec<_>>()
                .join("");
            let (input_tokens, output_tokens) = parsed
                .usage
                .map(|u| (u.input_tokens, u.output_tokens))
                .unwrap_or((0, 0));
            eprintln!(
                "[llm] ✓ {} done in {}ms · {}in / {}out tokens · {} response chars",
                label,
                start.elapsed().as_millis(),
                input_tokens,
                output_tokens,
                text.len(),
            );
            return Ok(LlmResponse {
                text: extract_body(&text),
                input_tokens,
                output_tokens,
                elapsed_ms: start.elapsed().as_millis() as u64,
            });
        }

        // Retriable: 429 (rate limit), 529 (overloaded), 5xx. Non-retriable:
        // 4xx auth/validation — those need human intervention.
        let is_retriable = status.as_u16() == 429
            || status.as_u16() == 529
            || status.is_server_error();

        if !is_retriable || attempt == MAX_RETRIES {
            let text = resp.text().await.unwrap_or_default();
            eprintln!("[llm] ✗ {} {} (non-retriable or exhausted): {}", label, status, text.chars().take(200).collect::<String>());
            // Content-filter blocks are a distinct failure mode worth tagging:
            // retrying never helps (the filter is deterministic on the same
            // content), but the *rest* of the pipeline can usually continue
            // if we skip just this one call. The frontend detects the
            // `CONTENT_FILTERED` prefix and substitutes a placeholder reading
            // lesson instead of aborting the whole ingest.
            if status.as_u16() == 400 && text.contains("content filtering policy") {
                return Err(format!("CONTENT_FILTERED: {text}"));
            }
            return Err(format!("Anthropic API {status}: {text}"));
        }

        // Prefer the server-provided retry-after (seconds) when it's present
        // and sensible — it's what the rate limiter actually wants us to wait.
        // Fall back to exponential backoff if the header is missing or bogus.
        let retry_after_secs = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .filter(|&s| s > 0 && s <= 120); // clamp to 2min max
        if let Some(secs) = retry_after_secs {
            eprintln!(
                "[llm] ! {} Anthropic {} (attempt {}/{}). Server asked us to retry-after {}s…",
                label, status, attempt + 1, MAX_RETRIES + 1, secs
            );
            tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
        } else {
            eprintln!(
                "[llm] ! {} Anthropic {} (attempt {}/{}). Backing off…",
                label, status, attempt + 1, MAX_RETRIES + 1
            );
            sleep_backoff(attempt).await;
        }
    }

    // Loop should always return; this is unreachable but satisfies the
    // compiler when it can't prove the loop exits.
    Err("exhausted retries without a terminal result".to_string())
}

/// Exponential backoff: 2^attempt seconds + up to 1s jitter. Capped at 30s.
/// Attempt 0 → ~1s, 1 → ~2s, 2 → ~4s, 3 → ~8s, 4 → ~16s, 5 → ~30s (capped).
async fn sleep_backoff(attempt: u32) {
    use rand::Rng;
    let base = (1u64 << attempt.min(5)) as u64; // cap exponent at 5 (32s)
    let cap = base.min(30);
    let jitter_ms = rand::thread_rng().gen_range(0..1000);
    let total_ms = cap * 1000 + jitter_ms;
    tokio::time::sleep(std::time::Duration::from_millis(total_ms)).await;
}


/// Strip ```json or ``` fences and trailing whitespace from an LLM reply.
fn extract_body(text: &str) -> String {
    let trimmed = text.trim();
    if let Some(rest) = trimmed.strip_prefix("```json") {
        if let Some(end) = rest.rfind("```") {
            return rest[..end].trim().to_string();
        }
    }
    if let Some(rest) = trimmed.strip_prefix("```") {
        if let Some(end) = rest.rfind("```") {
            return rest[..end].trim().to_string();
        }
    }
    trimmed.to_string()
}

// ---- Back-compat: old command kept as a facade so existing ImportDialog works
//      until it's rewritten to use the three specialist commands.

#[tauri::command]
pub async fn structure_with_llm(
    settings: State<'_, SettingsState>,
    cancel: State<'_, IngestCancel>,
    section_title: String,
    section_text: String,
    language: String,
) -> Result<LlmResponse, String> {
    // Legacy single-pass entry point; runPipeline is the preferred path.
    let legacy_system = r#"You are a single-pass legacy adapter. Return a JSON array of lessons for the Libre app given a chapter of raw text and a target language. Each lesson is either reading or exercise with the schema described in the generate_lesson system prompt. Keep it simple — 6 to 10 lessons."#;
    let prompt = format!("Language: {language}\nSection: {section_title}\n\n{section_text}");
    call_llm(
        &settings,
        &cancel,
        legacy_system,
        &prompt,
        None,
        &format!("legacy_structure_with_llm[{section_title}]"),
    )
    .await
}
