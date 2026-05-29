#!/usr/bin/env node
/// Bulk-generate challenge packs for languages that don't have one yet.
/// Calls the Anthropic API directly (key read from the app's settings.json)
/// and writes each pack as a `course.json` under
/// `~/Library/Application Support/com.mattssoftware.libre/courses/`,
/// using the same shape the in-app challenge generator produces.
///
/// Two modes:
///   1. New-pack mode (default for unfamiliar languages) — writes a
///      brand-new `challenges-<lang>-<random>` directory.
///   2. Append-to-existing mode (`APPEND=1` or `--append`) — finds
///      the existing `challenges-<lang>-handwritten` (or first match)
///      and appends new lessons to its chapters. Idempotent: re-runs
///      stop once a chapter hits PER_TIER, so you can iteratively
///      raise PER_TIER without losing earlier work.
///
/// Usage:
///   node scripts/bulk-generate-challenges.mjs              # all missing
///   node scripts/bulk-generate-challenges.mjs assembly     # one language
///   node scripts/bulk-generate-challenges.mjs c java       # several
///   APPEND=1 node scripts/bulk-generate-challenges.mjs ruby lua dart
///
/// Env:
///   PER_TIER=10        — challenges per (language, tier). Default 10.
///   DRY_RUN=1          — log what would be generated, don't call API.
///   MODEL=claude-sonnet-4-8  — override the default model.
///   CONCURRENCY=6      — parallel API calls within a pack. Default 6.
///   APPEND=1           — append to existing `challenges-<lang>-*` pack
///                        instead of writing a new one with random suffix.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP_SUPPORT = path.join(
  os.homedir(),
  "Library/Application Support/com.mattssoftware.libre",
);
const COURSES_DIR = path.join(APP_SUPPORT, "courses");
const SETTINGS_PATH = path.join(APP_SUPPORT, "settings.json");

const PER_TIER = Number(process.env.PER_TIER ?? 10);
const DRY_RUN = !!process.env.DRY_RUN;
const MODEL = process.env.MODEL ?? "claude-sonnet-4-8";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 6));
const APPEND = !!process.env.APPEND;
const TIERS = ["easy", "medium", "hard"];

/// Topic seeds per language. Keeps the generator from repeating the
/// same problem 30 times — each (lang, tier) call cycles through
/// topics so the pack covers a breadth of concepts.
const TOPICS = {
  javascript: ["arrays", "strings", "objects", "closures", "promises", "iteration", "recursion", "regex", "DOM-free utilities", "functional combinators"],
  typescript: ["generics", "discriminated unions", "type guards", "mapped types", "iterators", "promises", "async patterns", "tuple manipulation", "branded types", "utility types"],
  python: ["lists", "dictionaries", "iteration", "comprehensions", "decorators", "generators", "string parsing", "recursion", "classes", "regex"],
  swift: ["optionals", "structs", "enums with associated values", "protocols", "closures", "collections", "string manipulation", "result types", "extensions", "generics"],
  c: ["arrays", "pointers", "strings", "bit manipulation", "structs", "linked lists", "memory layout", "stdio formatting", "math utilities", "loops"],
  cpp: ["std::vector", "std::string", "std::map", "iterators", "lambdas", "templates", "RAII", "smart pointers", "algorithms", "operator overloading"],
  java: ["arrays", "strings", "ArrayList", "HashMap", "OOP basics", "interfaces", "exceptions", "streams", "recursion", "generics"],
  kotlin: ["data classes", "collections", "extensions", "scope functions", "sealed classes", "null safety", "lambdas", "string templates", "coroutines (sync)", "destructuring"],
  csharp: ["LINQ", "lists", "dictionaries", "strings", "records", "pattern matching", "tuples", "extension methods", "delegates", "async (sync demo)"],
  assembly: ["arithmetic exit codes", "conditional logic", "loops with counters", "bit manipulation", "stack frames", "function calls", "memory load/store", "comparisons", "shifts", "register allocation"],
  reactnative: ["text formatting", "list filters", "string parsing", "array transforms", "object manipulation", "validation", "date math", "currency / numbers", "regex", "higher-order utilities"],

  // ── 2026 expansion ──────────────────────────────────────────
  ruby: ["strings", "arrays", "hashes", "blocks and iterators", "modules and mixins", "classes and inheritance", "regular expressions", "enumerable", "symbols", "ranges"],
  lua: ["strings", "tables (array part)", "tables (hash part)", "metatables", "functions and closures", "string patterns", "iterators", "math", "type coercion", "table sort"],
  dart: ["strings", "lists", "maps", "classes", "null safety", "iterables and generators", "futures and async/await", "extension methods", "records", "sealed classes"],
  haskell: ["lists", "strings", "tuples", "pattern matching", "higher-order functions", "type classes", "Maybe and Either", "folds", "let and where", "list comprehensions"],
  scala: ["strings", "lists", "maps", "case classes", "pattern matching", "for-comprehensions", "Option and Either", "traits", "tuples", "implicits"],
  sql: ["select and where", "joins", "group by and aggregates", "subqueries", "ctes", "window functions", "string functions", "case expressions", "set operations", "date arithmetic"],
  elixir: ["lists", "strings", "maps", "pattern matching", "pipe operator", "Enum", "guards", "tuples", "structs", "binaries"],
  zig: ["slices", "arrays", "strings", "structs", "error unions", "optionals", "comptime", "allocators", "tagged unions", "enums"],
  // Move / Cairo / Sway runtimes are stubbed today — content is
  // author-ready for when the toolchains land. Tests use the
  // language's native #[test] form.
  move: ["primitives and arithmetic", "vectors", "structs", "resources", "abilities (key, store, copy, drop)", "modules", "events", "tests", "string utf8", "u64 math"],
  cairo: ["felt252 arithmetic", "arrays", "tuples", "structs", "traits", "options and results", "loops", "tests", "byte arrays", "u32 math"],
  sway: ["primitives", "vectors", "structs", "enums", "abi and contracts", "storage", "options and results", "tests", "u64 math", "string utf8"],
};

const SUPPORTED = Object.keys(TOPICS);

function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    throw new Error(`settings.json not found at ${SETTINGS_PATH}`);
  }
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
}

function existingChallengeLanguages() {
  if (!fs.existsSync(COURSES_DIR)) return new Set();
  const out = new Set();
  for (const d of fs.readdirSync(COURSES_DIR)) {
    if (!d.startsWith("challenges-")) continue;
    const m = /^challenges-([a-z]+)-/.exec(d);
    if (m) out.add(m[1]);
  }
  return out;
}

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
  - Every test MUST contain at least one real assertion exercising learner code with a specific input and a specific expected output.
  - BANNED: tests that just call the function and assert nothing; tests that only check existence/type signature.
  - Provide ≥ 3 assertions covering: normal case, edge case (empty/zero/boundary), and an unusual case.

Per-language harness:

  TypeScript / JavaScript:
    \`test("name", () => { ... })\` and \`expect(x).toBe(y)\` / \`.toEqual(y)\` / \`.toThrow()\`.
    Solution + starter MUST end with \`module.exports = { ... }\`. Tests import via \`require('./user')\`.

  Python:
    Use the harness: \`@test("name") def fn(): expect(x).to_be(y)\`.
    User code is exposed as \`user\` module; tests do \`from user import thing\`.

  Swift:
    Run-only. Set \`tests\` to "". Solution must compile and exit 0.

  C / C++ / Java / Kotlin / C#:
    Single self-contained translation unit (combine learner code + tests).
    The combined source's \`main()\` (or \`Main\`/static main) MUST iterate all assertions and print EXACTLY:
      \`KATA_TEST::<name>::PASS\` on success
      \`KATA_TEST::<name>::FAIL::<short one-line reason>\` on failure
    The test runner greps stdout for these lines.
    For Java/Kotlin: pick a single public class name; the test runner names the source file accordingly (\`Main.java\` / \`Main.kt\`). Solution and tests must coexist in this single class.

  Assembly (arm64 macOS):
    Run-only. Set \`tests\` to "".
    The challenge body asks the learner to compute some value and EXIT WITH IT as the process exit code (via \`mov x16, #1; svc #0x80\` on macOS arm64 — the BSD exit syscall).
    The exercise PASSES iff the binary exits with code 0 — phrase the challenge so the correct algorithm naturally produces exit code 0 (e.g. "exit 0 if the bitwise XOR of these three constants equals 42, else exit 1").
    Solution must be a single .s file with \`.global _main\` + \`_main:\` entry, idiomatic AAPCS64. No external libraries.

  Ruby:
    Tests are top-level Ruby code that emits the KATA_TEST stdout protocol via a \`kata_test\` helper the runtime provides. Emit blocks like:
      kata_test "two_positives" do
        raise "expected 5, got #{add(2, 3).inspect}" unless add(2, 3) == 5
      end
    The harness wraps each block in begin/rescue and prints \`KATA_TEST::name::PASS|FAIL::reason\`. Solution + starter define plain top-level methods (no \`def main\`). DO NOT redefine \`kata_test\`.

  Lua:
    Use the test()/expect() harness Fengari ships with the runtime:
      test("name", function() expect(x).to_be(y) end)
    Use \`.to_be\` for primitives, \`.to_equal\` for tables. Solution + starter define plain functions at top level.

  Dart:
    Tests are top-level statements using the runTest() helper the harness provides:
      runTest("name", () { if (got != expected) throw "expected $expected got $got"; });
    Solution + starter define helper functions only — the harness supplies main(). The runtime executes \`dart run\` on the merged source.

  Haskell:
    The starter (and solution) ALREADY ships these lines verbatim — keep them in your output:
      module Main where
      import Control.Exception (try, SomeException, evaluate)
      import System.IO (hSetBuffering, stdout, BufferMode(NoBuffering))
      <function definition the learner edits>
      main :: IO ()
      main = kataMain
    Tests use \`runTest\` and \`expectEq\` (provided by the harness). Emit lines like:
      runTest "name" $ expectEq (myFn 5) 25
    DO NOT define your own main — the kataMain definition the harness supplies will run all tests.

  Scala 3:
    Tests use the runTest helper:
      runTest("name") { if myFn(5) != 25 then throw RuntimeException(s"expected 25, got \${myFn(5)}") }
    Solution + starter define plain functions; the harness supplies @main runTests. The runtime invokes \`scala-cli run\`.

  SQL:
    The runtime executes statements one-by-one against a fresh in-memory SQLite database. Each statement may be preceded by a "-- expect: <n> rows, {row}" comment. Examples:
      -- expect: 1 row, {"total": 6}
      SELECT SUM(v) AS total FROM numbers;
    Starter is the schema setup + a TODO query. Solution is the working query that satisfies the expect comments. Tests can be the same statement(s) as the solution since the expect comments do the asserting — set \`tests\` to the solution.

  Elixir:
    Tests are top-level code using a run_test/2 helper the harness provides:
      run_test "name", fn ->
        unless Solution.fn(5) == 25, do: raise "expected 25"
      end
    Solution + starter define a Solution module (\`defmodule Solution do; def fn(x), do: ...; end\`).

  Zig (0.11+):
    Tests should be raw fn definitions that return \`!void\`:
      fn testName() !void { if (myFn(5) != 25) return error.WrongAnswer; }
    Then add a final-line JSON-array comment listing the cases for the harness:
      // CASES: [["name", "testName"], ["other", "testOther"]]
    The runtime parses that comment, generates a pub fn main() that iterates the cases and emits KATA_TEST::name::PASS|FAIL. Solution + starter declare a \`pub fn name(...)\` the tests call.

  Move / Cairo / Sway:
    Use the language's native \`#[test]\` form with assert!/assert. Runtime is stubbed today — content is author-ready for when toolchains land. Solution must compile and tests must use real assertions on a function return value (no print-only tests).

WRITING GUIDELINES:
  - Title: concrete verb phrase ("Reverse a String", "Implement LRU Cache").
  - Body: lead with what to build, then I/O examples, then constraints. ≤ 150 words of prose.
  - Starter: function signature + a TODO comment. MUST compile.
  - Solution: must pass every assertion you wrote.
  - Hints: 1-3 short progressive nudges. Optional.

Return ONLY the JSON object. Begin with \`{\`, end with \`}\`. No markdown fences, no preamble.`;

async function callAnthropic({ apiKey, language, difficulty, topic }) {
  const userPrompt = `Language: ${language}\nDifficulty: ${difficulty}\nTopic: ${topic}\n\nGenerate one challenge matching the constraints above. Return ONLY the JSON.`;
  // Up to 5 retries with exponential backoff on 429 / 5xx — same
  // shape as Rust llm.rs::call_llm.
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "output-128k-2025-02-19",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        // Bumped from 4096 — hard challenges with full code + tests
        // routinely hit ~6-8K tokens. 16K leaves headroom for Opus.
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (res.ok) {
      const body = await res.json();
      const text = body.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("") ?? "";
      return { text, usage: body.usage };
    }
    if (res.status === 429 || res.status >= 500) {
      const delay = 2000 * Math.pow(2, attempt);
      const errBody = await res.text().catch(() => "");
      console.warn(
        `  ⚠ ${res.status} ${language}/${difficulty}/${topic}, retry in ${delay}ms (${errBody.slice(0, 80)})`,
      );
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }
  throw new Error(`exhausted retries for ${language}/${difficulty}/${topic}`);
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

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

function packIdFor(language) {
  // Random suffix mirrors the existing `challenges-go-mo9kijkd` pattern.
  const suffix = Math.random().toString(36).slice(2, 10);
  return `challenges-${language}-${suffix}`;
}

function lessonIdFor(language, tier, topic, idx) {
  return `${tier}-${slugify(topic)}-${idx}`;
}

function chapterIdFor(tier) {
  return tier;
}

/// Concurrency pool — N workers race over a shared queue. Each worker
/// pulls the next slot, calls Claude, and pushes the resulting lesson
/// into a shared array. Saves progress every 5 lessons so a SIGINT
/// or rate-limit failure mid-run leaves a usable partial.
async function runWithPool(slots, concurrency, worker) {
  let next = 0;
  async function take() {
    while (true) {
      const i = next++;
      if (i >= slots.length) return;
      try {
        await worker(slots[i], i);
      } catch (e) {
        console.warn(`  ✗ slot ${i}: ${e.message}`);
      }
    }
  }
  await Promise.all(
    Array(Math.min(concurrency, slots.length))
      .fill(0)
      .map(take),
  );
}

/// Find an existing pack dir for `language` so APPEND mode can extend
/// it. Prefers `challenges-<lang>-handwritten` (the convention) and
/// falls back to any `challenges-<lang>-*` directory. Returns null
/// when no match exists.
function findExistingPack(language) {
  if (!fs.existsSync(COURSES_DIR)) return null;
  const handwritten = `challenges-${language}-handwritten`;
  if (fs.existsSync(path.join(COURSES_DIR, handwritten, "course.json"))) {
    return handwritten;
  }
  for (const d of fs.readdirSync(COURSES_DIR)) {
    if (
      d.startsWith(`challenges-${language}-`) &&
      fs.existsSync(path.join(COURSES_DIR, d, "course.json"))
    ) {
      return d;
    }
  }
  return null;
}

function loadOrCreateCourse(language) {
  const existing = APPEND ? findExistingPack(language) : null;
  if (existing) {
    const dir = path.join(COURSES_DIR, existing);
    const course = JSON.parse(
      fs.readFileSync(path.join(dir, "course.json"), "utf8"),
    );
    // Make sure we have the three difficulty chapters.
    for (const tier of TIERS) {
      if (!course.chapters.find((c) => c.id === tier)) {
        course.chapters.push({
          id: tier,
          title: tier[0].toUpperCase() + tier.slice(1),
          lessons: [],
        });
      }
    }
    return { dir, course, isNew: false };
  }
  // New-pack mode (random suffix to mirror the existing convention).
  const packId = packIdFor(language);
  const dir = path.join(COURSES_DIR, packId);
  fs.mkdirSync(dir, { recursive: true });
  const course = {
    id: packId,
    title: `${language[0].toUpperCase() + language.slice(1)} Challenges`,
    author: "Libre",
    language,
    packType: "challenges",
    releaseStatus: "BETA",
    description: `Bulk-generated kata challenges for ${language}.`,
    chapters: TIERS.map((tier) => ({
      id: tier,
      title: tier[0].toUpperCase() + tier.slice(1),
      lessons: [],
    })),
  };
  return { dir, course, isNew: true };
}

function saveCourse(handle) {
  fs.writeFileSync(
    path.join(handle.dir, "course.json"),
    JSON.stringify(handle.course, null, 2) + "\n",
  );
}

function chapterFor(course, tier) {
  return course.chapters.find((c) => c.id === tier);
}

function existingExerciseCounts(course) {
  const out = { easy: 0, medium: 0, hard: 0 };
  for (const ch of course.chapters) {
    if (!TIERS.includes(ch.id)) continue;
    for (const l of ch.lessons) {
      if (l.kind === "exercise" || l.kind === "mixed") out[ch.id]++;
    }
  }
  return out;
}

async function generatePack(apiKey, language) {
  console.log(`\n=== ${language} (APPEND=${APPEND ? "1" : "0"}) ===`);
  const handle = loadOrCreateCourse(language);
  const have = existingExerciseCounts(handle.course);
  const topics = TOPICS[language];

  // Build the slot list for this run — fill each tier up to PER_TIER.
  // Round-robin topics so coverage stays balanced.
  const slots = [];
  for (const tier of TIERS) {
    for (let i = have[tier]; i < PER_TIER; i++) {
      slots.push({ tier, topic: topics[i % topics.length], index: i });
    }
  }

  if (slots.length === 0) {
    console.log(
      `  ✓ already at PER_TIER=${PER_TIER} (E=${have.easy} M=${have.medium} H=${have.hard}) — nothing to do`,
    );
    return { language, generated: 0, before: have, after: have };
  }
  console.log(
    `  → ${slots.length} new (have E=${have.easy} M=${have.medium} H=${have.hard}, target ${PER_TIER}/tier)`,
  );
  if (DRY_RUN) {
    for (const s of slots) console.log(`  [dry] ${s.tier}/${s.topic}#${s.index + 1}`);
    return;
  }

  // Track existing ids so we don't collide on a slug match.
  const ids = new Set(handle.course.chapters.flatMap((c) => c.lessons.map((l) => l.id)));
  let nextId = (lessonId) => {
    let id = lessonId;
    let n = 2;
    while (ids.has(id)) id = `${lessonId}-${n++}`;
    ids.add(id);
    return id;
  };

  let savedSinceLast = 0;
  let totalIn = 0,
    totalOut = 0;

  await runWithPool(slots, CONCURRENCY, async (slot) => {
    const tag = `${language}/${slot.tier}/${slot.topic}#${slot.index + 1}`;
    try {
      const { text, usage } = await callAnthropic({
        apiKey,
        language,
        difficulty: slot.tier,
        topic: slot.topic,
      });
      totalIn += usage?.input_tokens || 0;
      totalOut += usage?.output_tokens || 0;
      const parsed = parseJsonTolerant(text);
      if (!parsed) {
        console.log(`  ✗ ${tag}: unparseable response`);
        return;
      }
      const lesson = {
        id: nextId(lessonIdFor(language, slot.tier, slot.topic, slot.index + 1)),
        kind: "exercise",
        title: parsed.title || `${slot.tier} ${slot.topic} ${slot.index + 1}`,
        body: parsed.body || "",
        language,
        difficulty: slot.tier,
        topic: slot.topic,
        starter: parsed.starter || "",
        solution: parsed.solution || "",
        tests: parsed.tests ?? "",
        hints: parsed.hints || [],
      };
      chapterFor(handle.course, slot.tier).lessons.push(lesson);
      savedSinceLast++;
      if (savedSinceLast >= 5) {
        saveCourse(handle);
        savedSinceLast = 0;
      }
      console.log(`  ✓ ${tag}: "${lesson.title}"`);
    } catch (e) {
      console.log(`  ✗ ${tag}: ${e.message}`);
    }
  });

  saveCourse(handle);
  const after = existingExerciseCounts(handle.course);
  const totalAfter = after.easy + after.medium + after.hard;
  const totalBefore = have.easy + have.medium + have.hard;
  console.log(
    `  wrote ${handle.dir}/course.json (E=${after.easy} M=${after.medium} H=${after.hard}, +${totalAfter - totalBefore})`,
  );
  return {
    language,
    generated: totalAfter - totalBefore,
    before: have,
    after,
    inputTokens: totalIn,
    outputTokens: totalOut,
  };
}

async function main() {
  const requestedLangs = process.argv.slice(2).filter((a) => SUPPORTED.includes(a));
  const existing = existingChallengeLanguages();
  const missing = SUPPORTED.filter((l) => !existing.has(l));
  // In APPEND mode the default target is "every supported language"
  // — we want to top up existing packs, not skip them. In new-pack
  // mode the default stays "languages without a pack yet".
  const defaultLangs = APPEND ? SUPPORTED : missing;
  const langs = requestedLangs.length > 0 ? requestedLangs : defaultLangs;

  console.log(`bulk challenge generator`);
  console.log(`  model:       ${MODEL}`);
  console.log(`  per-tier:    ${PER_TIER}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  append:      ${APPEND}`);
  console.log(`  dry-run:     ${DRY_RUN}`);
  console.log(`  existing:    ${[...existing].sort().join(", ") || "(none)"}`);
  console.log(`  target:      ${langs.join(", ") || "(nothing to do)"}`);

  if (langs.length === 0) return;

  const settings = readSettings();
  const apiKey = settings.anthropic_api_key;
  if (!apiKey) throw new Error("no anthropic_api_key in settings.json");

  const summaries = [];
  for (const lang of langs) {
    try {
      const r = await generatePack(apiKey, lang);
      if (r) summaries.push(r);
    } catch (e) {
      console.error(`✗ ${lang}: ${e.message}`);
      summaries.push({ language: lang, error: e.message });
    }
  }

  // Per-1M-token pricing (USD) — approximate, mirrors the table in
  // src/ingest/generateChallengePack.ts so cost estimates here line
  // up with the in-app dialog.
  const PRICING = {
    "claude-sonnet-4-8": { in: 3, out: 15 },
    "claude-opus-4-8": { in: 15, out: 75 },
    "claude-haiku-4-8": { in: 1, out: 5 },
  };
  const p = PRICING[MODEL] || PRICING["claude-sonnet-4-8"];
  let totalIn = 0,
    totalOut = 0;
  console.log("\nsummary:");
  for (const s of summaries) {
    if (s.error) {
      console.log(`  ${s.language}: FAILED — ${s.error}`);
      continue;
    }
    const a = s.after || { easy: 0, medium: 0, hard: 0 };
    console.log(
      `  ${s.language.padEnd(10)} E=${a.easy} M=${a.medium} H=${a.hard} (+${s.generated})`,
    );
    totalIn += s.inputTokens || 0;
    totalOut += s.outputTokens || 0;
  }
  const usd =
    (totalIn / 1_000_000) * p.in + (totalOut / 1_000_000) * p.out;
  console.log(
    `  TOTAL tokens: in=${totalIn.toLocaleString()} out=${totalOut.toLocaleString()} ≈ $${usd.toFixed(2)}`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
