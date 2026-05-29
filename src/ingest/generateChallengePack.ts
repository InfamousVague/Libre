/// Generate a challenge-pack `.libre` course on disk from scratch. Unlike
/// `runPipeline` (book ingest) and `regenerateExercises` (per-lesson
/// refresh of an existing course), this builds a brand-new Course whose
/// chapters are difficulty tiers and whose lessons are stand-alone kata
/// problems with a `topic` tag.
///
/// Saves incrementally after each challenge via the same `save_course`
/// path courses use, so a mid-run cancel / crash still leaves a usable
/// (if partial) pack on disk.
///
/// Uses the same PipelineStats shape + IngestEvent stream as book ingest
/// so the floating progress panel renders without modification.

import { invoke } from "@tauri-apps/api/core";
import type {
  Course,
  Chapter,
  ExerciseLesson,
  Difficulty,
  LanguageId,
  WorkbenchFile,
} from "../data/types";
import type { IngestEvent, PipelineStats } from "./pipeline";

export interface GenerateChallengePackOptions {
  language: LanguageId;
  /// Target number of challenges. We distribute roughly 40% easy /
  /// 40% medium / 20% hard, rounding up on easy so short runs (e.g.
  /// 20) still have at least one of every tier.
  count: number;
  /// Anthropic model identifier. When omitted, the backend falls back
  /// to whatever's set in Settings.
  model?: string;
  onProgress: (stage: string, detail?: string) => void;
  onEvent?: (event: IngestEvent) => void;
  onStats?: (stats: PipelineStats) => void;
  signal?: AbortSignal;
}

export class ChallengePackAborted extends Error {
  constructor() {
    super("challenge pack generation aborted");
    this.name = "ChallengePackAborted";
  }
}

interface LlmResponseTS {
  text: string;
  input_tokens: number;
  output_tokens: number;
  elapsed_ms: number;
}

/// Shape the `generate_challenge` LLM response is expected to produce
/// (as a JSON string inside `LlmResponseTS.text`). Single-file challenges
/// set `starter`/`solution`; multi-file use `files`/`solutionFiles`.
interface ChallengePayload {
  title: string;
  body: string;
  starter?: string;
  solution?: string;
  files?: WorkbenchFile[];
  solutionFiles?: WorkbenchFile[];
  tests: string;
  hints?: string[];
}

/// Per-language topic buckets. Kept intentionally broad so a 100-challenge
/// pack can sample across them without the LLM repeating itself. Round-
/// robin assignment in the generator means topic coverage stays balanced
/// regardless of total count.
/// Partial on purpose — not every LanguageId is a valid challenge-pack
/// target. "web" and "threejs" are multi-file meta-languages that don't
/// fit the single-function kata shape, so we omit them. `planBuckets`
/// falls back to the JavaScript topic list when a language isn't in
/// this map.
const TOPICS: Partial<Record<LanguageId, string[]>> = {
  rust: [
    "strings",
    "arrays and slices",
    "iterators",
    "ownership and borrowing",
    "structs and enums",
    "traits and generics",
    "error handling",
    "pattern matching",
    "collections (Vec, HashMap)",
    "lifetimes",
    "closures",
    "concurrency",
  ],
  typescript: [
    "strings",
    "arrays",
    "objects and records",
    "classes",
    "interfaces and types",
    "generics",
    "union and discriminated unions",
    "promises and async/await",
    "iterators and generators",
    "error handling",
    "closures",
    "higher-order functions",
  ],
  go: [
    "strings",
    "slices",
    "maps",
    "structs and methods",
    "interfaces",
    "generics",
    "error handling",
    "concurrency and channels",
    "goroutines",
    "pointers",
    "io and strings",
    "closures",
  ],
  javascript: [
    "strings",
    "arrays",
    "objects",
    "closures",
    "promises and async/await",
    "higher-order functions",
  ],
  python: [
    "strings",
    "lists",
    "dicts",
    "comprehensions",
    "iterators",
    "classes",
  ],
  swift: [
    "strings",
    "arrays",
    "optionals",
    "structs and classes",
    "protocols",
    "closures",
  ],
  // ── 2026 expansion — bulk-generation topic buckets ────────────
  // Pulled from each language's idiomatic surface so the in-app
  // pack generator can sample broadly without repeating itself.
  ruby: [
    "strings",
    "arrays",
    "hashes",
    "blocks and iterators",
    "modules and mixins",
    "classes and inheritance",
    "regular expressions",
    "enumerable",
  ],
  lua: [
    "strings",
    "tables (array part)",
    "tables (hash part)",
    "metatables",
    "functions and closures",
    "string patterns",
    "iterators",
    "math",
  ],
  dart: [
    "strings",
    "lists",
    "maps",
    "classes",
    "null safety",
    "iterables and generators",
    "futures and async/await",
    "extension methods",
  ],
  haskell: [
    "lists",
    "strings",
    "tuples",
    "pattern matching",
    "higher-order functions",
    "type classes",
    "Maybe and Either",
    "folds",
  ],
  scala: [
    "strings",
    "lists",
    "maps",
    "case classes",
    "pattern matching",
    "for-comprehensions",
    "Option and Either",
    "traits",
  ],
  sql: [
    "select and where",
    "joins",
    "group by and aggregates",
    "subqueries",
    "ctes",
    "window functions",
    "string functions",
    "case expressions",
  ],
  elixir: [
    "lists",
    "strings",
    "maps",
    "pattern matching",
    "pipe operator",
    "Enum",
    "guards",
    "tuples",
  ],
  zig: [
    "slices",
    "arrays",
    "strings",
    "structs",
    "error unions",
    "optionals",
    "comptime",
    "allocators",
  ],
  // Move / Cairo / Sway are smart-contract languages with stubbed
  // runtimes today. Topic buckets focus on the resource / contract
  // semantics rather than general algorithms — when the runtimes
  // land the in-app generator can populate from these.
  move: [
    "primitives and arithmetic",
    "vectors",
    "structs",
    "resources",
    "abilities (key, store, copy, drop)",
    "modules",
    "events",
    "tests",
  ],
  cairo: [
    "felt252 arithmetic",
    "arrays",
    "tuples",
    "structs",
    "traits",
    "options and results",
    "loops",
    "tests",
  ],
  sway: [
    "primitives",
    "vectors",
    "structs",
    "enums",
    "abi and contracts",
    "storage",
    "options and results",
    "tests",
  ],
};

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-8": { input: 3, output: 15 },
  "claude-opus-4-8": { input: 15, output: 75 },
  "claude-haiku-4-8": { input: 1, output: 5 },
};

function costFor(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = MODEL_PRICING[model] ?? MODEL_PRICING["claude-sonnet-4-8"];
  return (
    (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output
  );
}

/// Split `count` into an ordered list of (difficulty, topic) tuples.
/// Difficulty split is ~40/40/20; topic round-robins through the
/// language's topic bucket so coverage stays balanced.
function planBuckets(
  language: LanguageId,
  count: number,
): Array<{ difficulty: Difficulty; topic: string }> {
  const easyCount = Math.ceil(count * 0.4);
  const mediumCount = Math.ceil(count * 0.4);
  const hardCount = count - easyCount - mediumCount;
  // TOPICS is Partial<Record<LanguageId, …>> since not every language
  // has a kata bucket defined. Fall through JS → a last-resort stub so
  // the function is never left with `undefined`.
  const topics =
    TOPICS[language] ?? TOPICS.javascript ?? ["strings", "arrays", "logic"];

  const buckets: Array<{ difficulty: Difficulty; topic: string }> = [];
  const push = (d: Difficulty, n: number) => {
    for (let i = 0; i < n; i++) {
      buckets.push({ difficulty: d, topic: topics[i % topics.length] });
    }
  };
  push("easy", easyCount);
  push("medium", mediumCount);
  push("hard", hardCount);
  return buckets;
}

/// Try JSON.parse on the raw response, falling back to the first
/// `{...}` slice if the model wrapped the JSON in prose or code fences.
function parseJsonTolerant<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    /* fall through */
  }
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]) as T;
    } catch {
      /* fall through */
    }
  }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(raw.slice(first, last + 1)) as T;
    } catch {
      return null;
    }
  }
  return null;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "challenge"
  );
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/// Main entry point. Generates `count` challenges for `language` and
/// saves the resulting Course (with packType: "challenges") incrementally.
export async function generateChallengePack(
  opts: GenerateChallengePackOptions,
): Promise<Course> {
  const { language, count, model, onProgress, onEvent, onStats, signal } = opts;

  const checkAbort = () => {
    if (signal?.aborted) throw new ChallengePackAborted();
  };
  const emit = (e: Omit<IngestEvent, "timestamp">) =>
    onEvent?.({ ...e, timestamp: Date.now() });

  // Resolve the model for stats display. If the backend command ends up
  // reading settings at call time, we still want a best-guess label here
  // so the cost bar isn't empty.
  let displayModel = model ?? "claude-sonnet-4-8";
  if (!model) {
    try {
      const s = await invoke<{ anthropic_model?: string }>("load_settings");
      if (s.anthropic_model) displayModel = s.anthropic_model;
    } catch {
      /* not in Tauri — keep default */
    }
  }

  const buckets = planBuckets(language, count);

  // Pack is one Course with three chapters (easy / medium / hard).
  // Lessons accumulate into the right chapter as they're generated.
  const packId = `challenges-${language}-${Date.now().toString(36)}`;
  const packTitle = `${titleCase(language)} — Challenge Pack`;
  const chapters: Record<Difficulty, Chapter> = {
    easy: { id: "easy", title: "Easy", lessons: [] },
    medium: { id: "medium", title: "Medium", lessons: [] },
    hard: { id: "hard", title: "Hard", lessons: [] },
  };

  const course: Course = {
    id: packId,
    title: packTitle,
    author: "Libre (challenge pack)",
    description: `Generated kata-style challenges for ${titleCase(language)}. Split across three difficulty tiers and topic buckets.`,
    language,
    chapters: [chapters.easy, chapters.medium, chapters.hard],
    packType: "challenges",
  };

  const stats: PipelineStats = {
    startedAt: Date.now(),
    elapsedMs: 0,
    totalChapters: 3,
    chaptersDone: 0,
    lessonsTotal: count,
    lessonsDone: 0,
    lessonsByKind: {},
    apiCalls: 0,
    cacheHits: 0,
    validationAttempts: 0,
    validationFailures: 0,
    demotedExercises: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    model: displayModel,
  };

  const pushStats = () => {
    stats.elapsedMs = Date.now() - stats.startedAt;
    stats.estimatedCostUsd = costFor(
      stats.model,
      stats.inputTokens,
      stats.outputTokens,
    );
    onStats?.({ ...stats, lessonsByKind: { ...stats.lessonsByKind } });
  };

  emit({
    level: "info",
    stage: "meta",
    message: `generating ${count} ${titleCase(language)} challenges (model: ${displayModel})`,
  });
  pushStats();

  const chapterNum = (d: Difficulty) =>
    d === "easy" ? 1 : d === "medium" ? 2 : 3;

  for (let i = 0; i < buckets.length; i++) {
    checkAbort();
    const { difficulty, topic } = buckets[i];
    const chNum = chapterNum(difficulty);

    onProgress(
      `Generating challenge ${i + 1}/${count}`,
      `${difficulty} · ${topic}`,
    );

    try {
      const resp = await invoke<LlmResponseTS>("generate_challenge", {
        language,
        difficulty,
        topic,
        modelOverride: model ?? null,
      });
      stats.apiCalls++;
      stats.inputTokens += resp.input_tokens;
      stats.outputTokens += resp.output_tokens;

      const parsed = parseJsonTolerant<ChallengePayload>(resp.text);
      if (!parsed || !parsed.title || !parsed.tests) {
        emit({
          level: "error",
          stage: "generate",
          chapter: chNum,
          message: `could not parse response for ${difficulty}/${topic} — skipping`,
        });
        stats.validationFailures++;
        pushStats();
        continue;
      }

      const lessonId = `${slug(difficulty)}-${slug(topic)}-${i}`;
      const lesson: ExerciseLesson = {
        id: lessonId,
        kind: "exercise",
        title: parsed.title,
        body: parsed.body ?? "",
        language,
        starter: parsed.starter ?? "",
        solution: parsed.solution ?? "",
        tests: parsed.tests,
        hints: parsed.hints,
        files: parsed.files,
        solutionFiles: parsed.solutionFiles,
        difficulty,
        topic,
      };
      chapters[difficulty].lessons.push(lesson);

      stats.lessonsDone++;
      stats.lessonsByKind["exercise"] =
        (stats.lessonsByKind["exercise"] ?? 0) + 1;

      // Save after every challenge — partial packs are valuable on cancel.
      await invoke("save_course", {
        courseId: packId,
        body: course,
      });
      emit({
        level: "info",
        stage: "save",
        chapter: chNum,
        lesson: lessonId,
        message: `done: added "${parsed.title}" (${difficulty}, ${topic})`,
      });
      pushStats();
    } catch (e) {
      if (signal?.aborted) throw new ChallengePackAborted();
      const msg = e instanceof Error ? e.message : String(e);
      emit({
        level: "error",
        stage: "generate",
        chapter: chNum,
        message: `failed ${difficulty}/${topic}: ${msg.slice(0, 200)}`,
      });
      stats.validationFailures++;
      pushStats();
    }
  }

  stats.chaptersDone = 3;
  pushStats();
  emit({
    level: "info",
    stage: "meta",
    message: `challenge pack complete · ${stats.lessonsDone}/${count} challenges`,
  });

  return course;
}
