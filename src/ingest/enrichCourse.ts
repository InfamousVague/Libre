/// One-off enrichment pass for an already-generated course. Unlike
/// `regenerateExercises` (which rewrites starters/solutions/tests from
/// scratch) this touches NOTHING in the existing lesson except the two
/// reading-aid fields the new reader uses: `objectives` + `enrichment`.
///
/// Behavior:
///   - Walk every non-quiz lesson in the course.
///   - Skip lessons that already have both `objectives` (non-empty) AND
///     `enrichment` set — re-running is idempotent / resumable.
///   - Call the lightweight `enrich_lesson` backend command with just
///     the lesson's title + body.
///   - Merge the returned fields back into the lesson in-place and save
///     the course to disk after every lesson (crash-safe).
///
/// Emits the same PipelineStats + IngestEvent shape as the book ingest
/// so the existing FloatingIngestPanel renders it without modification.

import { invoke } from "@tauri-apps/api/core";
import type {
  Course,
  LessonEnrichment,
  GlossaryEntry,
  SymbolEntry,
} from "../data/types";
import { isExerciseKind } from "../data/types";
import type { IngestEvent, PipelineStats } from "./pipeline";

export interface EnrichCourseOptions {
  bookId: string;
  onProgress: (stage: string, detail?: string) => void;
  onEvent?: (event: IngestEvent) => void;
  onStats?: (stats: PipelineStats) => void;
  signal?: AbortSignal;
}

export class EnrichAborted extends Error {
  constructor() {
    super("enrichment aborted");
    this.name = "EnrichAborted";
  }
}

interface LlmResponseTS {
  text: string;
  input_tokens: number;
  output_tokens: number;
  elapsed_ms: number;
}

interface EnrichPayload {
  objectives?: string[];
  glossary?: GlossaryEntry[];
  symbols?: SymbolEntry[];
}

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

function parseJsonTolerant<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    /* fall through */
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]) as T;
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

/// Returns true when a lesson ALREADY has full enrichment data — we skip
/// it on this run so re-running the button is cheap and resumable after
/// a partial failure.
function hasFullEnrichment(lesson: {
  objectives?: string[];
  enrichment?: LessonEnrichment;
}): boolean {
  if (!lesson.objectives || lesson.objectives.length === 0) return false;
  if (!lesson.enrichment) return false;
  // Don't require non-empty glossary/symbols — some lessons legitimately
  // have zero of either (e.g. a short intro). The presence of the
  // enrichment object itself is the marker that we've attempted it.
  return true;
}

export async function enrichCourse(opts: EnrichCourseOptions): Promise<void> {
  const { bookId, onProgress, onEvent, onStats, signal } = opts;

  const emit = (e: Omit<IngestEvent, "timestamp">) =>
    onEvent?.({ ...e, timestamp: Date.now() });
  const checkAbort = () => {
    if (signal?.aborted) throw new EnrichAborted();
  };

  const course = await invoke<Course>("load_course", { courseId: bookId });

  // Resolve the active model for cost display. Same pattern as
  // regenExercises / generateChallengePack.
  let displayModel = "claude-sonnet-4-8";
  try {
    const s = await invoke<{ anthropic_model?: string }>("load_settings");
    if (s.anthropic_model) displayModel = s.anthropic_model;
  } catch {
    /* not in Tauri, keep default */
  }

  // Count the lessons we actually need to touch so the progress bar isn't
  // deceptively "5/200" when most are already enriched.
  let totalToEnrich = 0;
  for (const ch of course.chapters) {
    for (const l of ch.lessons) {
      if (l.kind === "quiz") continue; // quizzes skip enrichment
      if (!hasFullEnrichment(l)) totalToEnrich++;
    }
  }

  const stats: PipelineStats = {
    startedAt: Date.now(),
    elapsedMs: 0,
    totalChapters: course.chapters.length,
    chaptersDone: 0,
    lessonsTotal: totalToEnrich,
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
    message:
      totalToEnrich > 0
        ? `enriching "${course.title}" — ${totalToEnrich} lessons need enrichment`
        : `"${course.title}" already fully enriched — nothing to do`,
  });
  pushStats();

  if (totalToEnrich === 0) return;

  for (let chIdx = 0; chIdx < course.chapters.length; chIdx++) {
    const ch = course.chapters[chIdx];
    const chNum = chIdx + 1;
    for (let lIdx = 0; lIdx < ch.lessons.length; lIdx++) {
      checkAbort();
      const lesson = ch.lessons[lIdx];
      if (lesson.kind === "quiz") continue;
      if (hasFullEnrichment(lesson)) continue;

      onProgress(
        `Enriching lesson ${stats.lessonsDone + 1}/${totalToEnrich}`,
        `${lesson.title}`,
      );

      try {
        // For exercise/mixed lessons we enrich against the body prose —
        // the starter/solution/tests already live in their own fields
        // and don't need doc links.
        const body = lesson.body ?? "";
        const primaryLang = isExerciseKind(lesson)
          ? lesson.language
          : course.language;

        const resp = await invoke<LlmResponseTS>("enrich_lesson", {
          language: primaryLang,
          title: lesson.title,
          body,
        });
        stats.apiCalls++;
        stats.inputTokens += resp.input_tokens;
        stats.outputTokens += resp.output_tokens;

        const parsed = parseJsonTolerant<EnrichPayload>(resp.text);
        if (!parsed) {
          emit({
            level: "error",
            stage: "generate",
            chapter: chNum,
            lesson: lesson.id,
            message: `could not parse enrichment response — keeping existing data`,
          });
          stats.validationFailures++;
          pushStats();
          continue;
        }

        // Merge: overwrite ONLY the enrichment fields. Other lesson fields
        // are untouched — this is the whole point of the one-off button.
        if (Array.isArray(parsed.objectives)) {
          lesson.objectives = parsed.objectives.filter(
            (o) => typeof o === "string" && o.trim().length > 0,
          );
        }
        lesson.enrichment = {
          glossary: Array.isArray(parsed.glossary) ? parsed.glossary : [],
          symbols: Array.isArray(parsed.symbols) ? parsed.symbols : [],
        };

        stats.lessonsDone++;
        stats.lessonsByKind[lesson.kind] =
          (stats.lessonsByKind[lesson.kind] ?? 0) + 1;

        // Save after every lesson so a cancel mid-run keeps what has
        // already landed.
        await invoke("save_course", { courseId: bookId, body: course });
        emit({
          level: "info",
          stage: "save",
          chapter: chNum,
          lesson: lesson.id,
          message: `done: enriched "${lesson.title}"`,
        });
        pushStats();
      } catch (e) {
        if (signal?.aborted) throw new EnrichAborted();
        const msg = e instanceof Error ? e.message : String(e);
        emit({
          level: "error",
          stage: "generate",
          chapter: chNum,
          lesson: lesson.id,
          message: `enrich failed: ${msg.slice(0, 200)}`,
        });
        stats.validationFailures++;
        pushStats();
      }
    }
    stats.chaptersDone++;
    pushStats();
  }

  emit({
    level: "info",
    stage: "meta",
    message: `enrichment complete · ${stats.lessonsDone}/${totalToEnrich} lessons updated`,
  });
}
