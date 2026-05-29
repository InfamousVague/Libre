#!/usr/bin/env node
/// Targeted regeneration of challenge-pack exercises flagged by the
/// test-quality linter (`tests/content/test-quality.test.ts`).
///
/// Walks every pack on disk, runs the same per-language static checks
/// the linter uses, and for each flagged lesson calls the Anthropic
/// API with the UPDATED `generate_challenge` system prompt (the one
/// with the expanded BANNED-patterns list + "mentally run starter
/// through tests" self-check). Each successful regeneration is
/// written back to the course.json IMMEDIATELY — so a crash or API
/// timeout at lesson N still preserves the first N-1 fixes.
///
/// Usage:
///   node scripts/regenerate-weak-challenges.mjs
///   DRY_RUN=1 node scripts/regenerate-weak-challenges.mjs   # preview
///   MODEL=claude-opus-4-8 node scripts/...                  # stronger model
///   KATA_LANG=python node scripts/...                       # one language
///
/// Cost: Sonnet is ~$0.02 per lesson. 37 weak lessons ≈ $0.75 total.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP_SUPPORT = path.join(
  os.homedir(),
  "Library/Application Support/com.mattssoftware.libre",
);
const COURSES_DIR =
  process.env.KATA_COURSES_DIR ?? path.join(APP_SUPPORT, "courses");
const SETTINGS_PATH = path.join(APP_SUPPORT, "settings.json");

const DRY_RUN = !!process.env.DRY_RUN;
const MODEL = process.env.MODEL ?? "claude-sonnet-4-8";
const LANG_FILTER = process.env.KATA_LANG ?? null;

// The system prompt mirrors the tightened version in
// `src-tauri/src/llm.rs::generate_challenge`. Keeping a verbatim copy
// here so the script is self-contained — if the Rust prompt is
// changed and this one drifts, re-run the linter and you'll know.
const SYSTEM_PROMPT = `You author ONE stand-alone kata-style coding challenge for the Libre app. Given a language, a difficulty tier, and a topic, return a single JSON object:

  {
    "title": "short descriptive title (≤ 60 chars)",
    "body": "markdown problem statement: what to build, input/output shape, 1-2 examples, edge cases",
    "starter": "runnable starter code containing a function stub the learner fills in",
    "solution": "reference solution — MUST pass every assertion in \`tests\`",
    "tests": "language-appropriate test code (see TEST HARNESS rules below)",
    "hints": ["optional", "progressive", "hints"]
  }

DIFFICULTY GUIDE:
  easy   — one concept, ~5-10 lines of solution, obvious approach.
  medium — two concepts composed, 10-25 lines, one non-obvious step.
  hard   — algorithmic or subtle edge cases, 25-60 lines, multiple concepts interacting.

TEST HARNESS — STRONG RULES (non-negotiable):
  - Every test MUST contain at least one real assertion that exercises learner code with a specific input and checks a specific output/state.
  - BANNED patterns (a static linter rejects packs that ship these):
      * Tests that just call the function and assert nothing ("trust the structure" — always passes).
      * Tests that only check the function's type signature or existence ("does it compile" — always passes once parsed).
      * \`let _ = fn(...)\` in a Rust #[test] with no assert after — compile-only.
      * \`func kataTest_x() error { return nil }\` (Go) that never branches to \`return fmt.Errorf(...)\` — always passes.
      * Kotlin / Java / C / C++ / C# tests whose main() prints \`KATA_TEST::name::PASS\` as a literal without any conditional — always passes.
      * A Go starter that returns a \`nil\` channel: reads from it block forever, the sandbox reports 0 tests parsed, and the runtime mis-interprets that as "pass". Give the starter a literal stub like \`return make(chan int)\` instead (still wrong behaviour, but produces real test failures rather than a deadlock).
      * For binary-crate outputs where stdout-capture is impractical (Rust main printing), REFORMULATE the challenge so the learner writes a function that RETURNS the value, and \`main\` just prints it. The tests then \`assert_eq!\` on the function's return — never on stdout.
  - EXACTLY ≥ 3 test cases is a FLOOR, not a target. Provide 4–6 cases covering:
      1. Normal case — the expected everyday input.
      2. Edge case — empty / zero / boundary / single-element / negative / unicode as applicable.
      3. Error / unusual case — invalid input, type mismatch, overflow, or a case most learners forget.
      4. (encouraged) A second normal-case variant with different data to catch hard-coded answers.
  - Before returning, mentally run the STARTER through the tests. At least one test must produce a FAIL when the starter is evaluated — if every assertion happens to pass given the starter's stub output (e.g. tests all compare against \`nil\` / \`""\` / \`0\` which the starter also returns), REWRITE the tests so specific non-default values are required.

Per-language harness:

  TypeScript / JavaScript:
    \`test("name", () => { ... })\` and \`expect(x).toBe(y)\` / \`.toEqual(y)\` / \`.toThrow()\`.
    Solution + starter MUST end with \`module.exports = { ... }\`. Tests import via \`require('./user')\`.

  Python:
    Use the harness: \`@test("name") def fn(): expect(x).to_be(y)\`.
    User code is exposed as \`user\` module; tests do \`from user import thing\`.

  Rust:
    Raw \`#[test] fn ... { assert_eq!(...) }\` functions. The runtime wraps them in \`#[cfg(test)] mod tests { use super::*; ... }\` automatically.

  Go:
    \`func kataTest_<name>() error\` returning nil on pass, \`fmt.Errorf(...)\` on fail. Main() iterates and prints \`KATA_TEST::<name>::PASS\` or \`KATA_TEST::<name>::FAIL::<reason>\`.

  C / C++ / Java / Kotlin / C#:
    Single self-contained translation unit (combine learner code + tests).
    The combined source's \`main()\` MUST iterate all assertions and print EXACTLY:
      \`KATA_TEST::<name>::PASS\` on success
      \`KATA_TEST::<name>::FAIL::<short one-line reason>\` on failure

Return ONLY the JSON object. Begin with \`{\`, end with \`}\`. No markdown fences, no preamble.`;

// ---- Same per-language validators the linter uses. ----
// Kept as a single shared set here (no import cycle with the TS
// test spec) so this script can run standalone via plain `node`.

function lintUniversal(tests, starter, solution) {
  const out = [];
  if (!tests.trim()) {
    out.push("tests body is empty");
    return out;
  }
  if (starter.trim() === solution.trim()) {
    out.push(
      "starter and solution are identical — 'starter fails' cannot be distinguished from 'solution passes'",
    );
  }
  return out;
}

function lintJsTs(tests, starter, solution) {
  const out = lintUniversal(tests, starter, solution);
  const testCalls = (tests.match(/\b(?:test|it)\s*\(/g) || []).length;
  if (testCalls < 3) out.push(`only ${testCalls} test()/it() calls — need ≥ 3`);
  const expectCalls = (tests.match(/\bexpect\s*\(/g) || []).length;
  if (expectCalls < 3) out.push(`only ${expectCalls} expect() calls — need ≥ 3`);
  const matchers = [
    ".toBe(",
    ".toEqual(",
    ".toStrictEqual(",
    ".toContain(",
    ".toBeCloseTo(",
    ".toMatch(",
    ".toBeGreaterThan",
    ".toBeLessThan",
    ".toHaveLength(",
    ".toHaveProperty(",
    ".toThrow(",
  ];
  const hasConcrete = matchers.some((m) => tests.includes(m));
  if (!hasConcrete && expectCalls > 0) {
    out.push("no concrete-value assertions (toBe / toEqual / toContain / etc.)");
  }
  return out;
}

function lintPython(tests, starter, solution) {
  const out = lintUniversal(tests, starter, solution);
  const decorators = (tests.match(/@test\s*\(/g) || []).length;
  if (decorators < 3) out.push(`only ${decorators} @test(...) decorators — need ≥ 3`);
  const expectCalls = (tests.match(/\bexpect\s*\(/g) || []).length;
  if (expectCalls < 3) out.push(`only ${expectCalls} expect() calls — need ≥ 3`);
  const matchers = [".to_be(", ".to_equal(", ".to_contain(", ".to_be_close_to(", ".to_match(", ".to_raise("];
  const hasConcrete = matchers.some((m) => tests.includes(m));
  if (!hasConcrete && expectCalls > 0) out.push("no concrete-value assertions");
  if (!/\bfrom\s+user\s+import\b/.test(tests))
    out.push("tests don't `from user import`");
  return out;
}

function lintRust(tests, starter, solution) {
  const out = lintUniversal(tests, starter, solution);
  const attrs = (tests.match(/#\[test\]/g) || []).length;
  if (attrs < 3) out.push(`only ${attrs} #[test] functions — need ≥ 3`);
  const asserts = (tests.match(/\bassert(?:_eq|_ne)?\s*!\s*\(/g) || []).length;
  if (asserts < 3) out.push(`only ${asserts} assert*! macros — need ≥ 3`);
  return out;
}

function lintGo(tests, starter, solution) {
  const out = lintUniversal(tests, starter, solution);
  const fns = (tests.match(/func\s+kataTest_\w+\s*\(\s*\)\s*error/g) || []).length;
  if (fns < 3) out.push(`only ${fns} kataTest_* fns — need ≥ 3`);
  const erroring = (tests.match(
    /func\s+kataTest_\w+\s*\(\s*\)\s*error\s*\{[\s\S]*?return\s+fmt\.Errorf/g,
  ) || []).length;
  if (erroring < fns)
    out.push(`${fns - erroring} kataTest_* fn(s) never return an error — always pass`);
  if (!/\bfunc\s+main\s*\(\s*\)/.test(tests))
    out.push("tests file has no func main()");
  if (/\breturn\s+nil\s*$/m.test(starter) && /\bchan\b/.test(starter))
    out.push("starter returns a nil channel — reads will block forever");
  return out;
}

function lintKataProtocol(tests, starter, solution, lang, sitePat, siteLabel) {
  const out = lintUniversal(tests, starter, solution);
  if (!tests.includes("KATA_TEST::")) {
    out.push(`tests file never emits KATA_TEST:: marker (${lang})`);
  }
  const sites = (tests.match(sitePat) || []).length;
  if (sites < 3) out.push(`only ${sites} ${siteLabel} — need ≥ 3 (${lang})`);
  const hasPass = /"PASS"/.test(tests);
  const hasFail = /"FAIL"/.test(tests);
  if (tests.includes("KATA_TEST::") && (!hasPass || !hasFail))
    out.push(`no conditional PASS/FAIL emission (${lang})`);
  return out;
}

function lintFor(lang, tests, starter, solution) {
  switch (lang) {
    case "javascript":
    case "typescript":
      return lintJsTs(tests, starter, solution);
    case "python":
      return lintPython(tests, starter, solution);
    case "rust":
      return lintRust(tests, starter, solution);
    case "go":
      return lintGo(tests, starter, solution);
    case "c":
      return lintKataProtocol(tests, starter, solution, "c", /\bkata_test_\w+\s*\(/g, "kata_test_* fn(s)");
    case "cpp":
      return lintKataProtocol(tests, starter, solution, "cpp", /\bkata_test_\w+\s*\(/g, "kata_test_* fn(s)");
    case "java":
      return lintKataProtocol(tests, starter, solution, "java", /\bkataTest\w+\s*\(\s*\)/g, "kataTest* methods");
    case "kotlin":
      return lintKataProtocol(tests, starter, solution, "kotlin", /\bfun\s+kataTest\w+\s*\(\s*\)/g, "fun kataTest* declarations");
    case "csharp":
      return lintKataProtocol(tests, starter, solution, "csharp", /\bRunTest\s*\(\s*"[^"]+"/g, "RunTest(...) invocations");
    default:
      return [];
  }
}

// ---- Anthropic call + JSON recovery ----

function readApiKey() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    throw new Error(`settings.json not found at ${SETTINGS_PATH}`);
  }
  const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  if (!s.anthropic_api_key) {
    throw new Error(
      "no anthropic_api_key in settings.json — open Libre → Settings → AI and paste one in",
    );
  }
  return s.anthropic_api_key;
}

async function callAnthropic({ apiKey, language, difficulty, topic }) {
  const userPrompt = `Language: ${language}\nDifficulty: ${difficulty}\nTopic: ${topic}\n\nGenerate one challenge matching the constraints above. Return ONLY the JSON.`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 6000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  return {
    text: body.content?.[0]?.text ?? "",
    usage: body.usage,
  };
}

function parseJsonTolerant(raw) {
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch { /* fall through */ }
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

// ---- Main ----

function collectWeakLessons() {
  const out = [];
  if (!fs.existsSync(COURSES_DIR)) return out;
  for (const d of fs.readdirSync(COURSES_DIR).sort()) {
    const p = path.join(COURSES_DIR, d, "course.json");
    if (!fs.existsSync(p)) continue;
    let course;
    try {
      course = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    if (course.packType !== "challenges") continue;
    if (LANG_FILTER && course.language !== LANG_FILTER) continue;
    for (let ci = 0; ci < (course.chapters || []).length; ci++) {
      const ch = course.chapters[ci];
      for (let li = 0; li < (ch.lessons || []).length; li++) {
        const l = ch.lessons[li];
        if (l.kind !== "exercise" && l.kind !== "mixed") continue;
        const lang = l.language ?? course.language;
        const starter = collateStarter(l);
        const solution = collateSolution(l);
        const issues = lintFor(lang, l.tests ?? "", starter, solution);
        if (issues.length === 0) continue;
        out.push({
          coursePath: p,
          course,
          chapterIdx: ci,
          lessonIdx: li,
          lesson: l,
          language: lang,
          difficulty: l.difficulty ?? ch.id ?? "medium",
          topic: l.topic ?? guessTopic(ch.id, l.id),
          issues,
        });
      }
    }
  }
  return out;
}

function collateStarter(l) {
  if (l.files && l.files.length > 0) return l.files.map((f) => f.content).join("\n\n");
  return l.starter ?? "";
}
function collateSolution(l) {
  if (l.solutionFiles && l.solutionFiles.length > 0) return l.solutionFiles.map((f) => f.content).join("\n\n");
  return l.solution ?? "";
}

/// Extract a topic hint from the lesson id (conventional format:
/// `<difficulty>-<topic>-<n>` e.g. `medium-recursion-3`). Falls back
/// to the chapter id when the lesson id doesn't match.
function guessTopic(chapterId, lessonId) {
  const m = /^(?:easy|medium|hard)-([a-z0-9-]+?)-\d+$/.exec(lessonId);
  if (m) return m[1].replace(/-/g, " ");
  return chapterId ?? "general";
}

async function regenerateLesson(apiKey, flagged) {
  const { language, difficulty, topic, lesson } = flagged;
  const tag = `${language}/${difficulty}/${lesson.id}`;
  if (DRY_RUN) {
    console.log(`  [dry] would regenerate ${tag}`);
    console.log(`    issues: ${flagged.issues.join(" / ")}`);
    return null;
  }

  let parsed = null;
  let lastError = null;
  // Two shots — if the first regen still lints dirty, ask for a re-do.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { text, usage } = await callAnthropic({ apiKey, language, difficulty, topic });
      parsed = parseJsonTolerant(text);
      if (!parsed) {
        lastError = "unparseable response";
        continue;
      }
      // Post-gen lint. If the regen ITSELF would fail the linter,
      // don't write it to disk — try again.
      const postIssues = lintFor(
        language,
        parsed.tests ?? "",
        parsed.starter ?? "",
        parsed.solution ?? "",
      );
      if (postIssues.length === 0) {
        console.log(
          `  ok ${tag}: "${parsed.title}" (attempt ${attempt}, in=${usage?.input_tokens} out=${usage?.output_tokens})`,
        );
        break;
      }
      lastError = `lint still dirty: ${postIssues.join(" / ")}`;
      parsed = null;
    } catch (e) {
      lastError = e.message;
    }
    if (attempt < 2) console.log(`  retry ${tag}: ${lastError}`);
  }

  if (!parsed) {
    console.log(`  FAIL ${tag}: ${lastError}`);
    return null;
  }
  return parsed;
}

function patchCourseInPlace(flagged, regen) {
  // Preserve the lesson's id + difficulty + topic — only the body /
  // starter / solution / tests / hints get replaced. That keeps the
  // course.json stable across partial runs (re-running won't mutate
  // ids).
  const { coursePath, course, chapterIdx, lessonIdx, lesson } = flagged;
  const next = {
    ...lesson,
    title: regen.title ?? lesson.title,
    body: regen.body ?? lesson.body ?? "",
    starter: regen.starter ?? lesson.starter ?? "",
    solution: regen.solution ?? lesson.solution ?? "",
    tests: regen.tests ?? lesson.tests ?? "",
    hints: Array.isArray(regen.hints) ? regen.hints : lesson.hints ?? [],
  };
  course.chapters[chapterIdx].lessons[lessonIdx] = next;
  fs.writeFileSync(coursePath, JSON.stringify(course, null, 2) + "\n");
}

async function main() {
  const apiKey = DRY_RUN ? "dry-run" : readApiKey();
  const flagged = collectWeakLessons();
  console.log(`Found ${flagged.length} weak lessons to regenerate (model: ${MODEL}${DRY_RUN ? ", DRY_RUN" : ""}).`);
  if (flagged.length === 0) return;

  const byPack = new Map();
  for (const f of flagged) {
    const key = path.dirname(f.coursePath).split("/").pop();
    byPack.set(key, (byPack.get(key) ?? 0) + 1);
  }
  for (const [pack, n] of byPack) console.log(`  ${n}  ${pack}`);

  let fixed = 0;
  let failed = 0;
  for (const f of flagged) {
    const regen = await regenerateLesson(apiKey, f);
    if (!regen) {
      failed++;
      continue;
    }
    if (!DRY_RUN) patchCourseInPlace(f, regen);
    fixed++;
  }

  console.log(`\nDone. fixed=${fixed} failed=${failed} total=${flagged.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
