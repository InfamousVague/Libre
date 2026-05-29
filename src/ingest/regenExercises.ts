/// Targeted regeneration of a course's exercise lessons.
///
/// Readings and quizzes are cheap to regenerate but also the safest lesson
/// kinds — they mostly can't be broken by a bad prompt. Exercises are the
/// expensive-to-fix content: wrong test syntax, wrong file layout, invalid
/// starters. This function rebuilds ONLY the exercise/mixed lessons,
/// preserving everything else in the saved course.
///
/// Uses the cached outline + cleaned-markdown from the original ingest, so
/// no re-extract / re-clean / re-outline work — just one generate_lesson
/// call per exercise, saved back to disk immediately.

import { invoke } from "@tauri-apps/api/core";
import type {
  Course,
  ExerciseLesson,
  Lesson,
  LanguageId,
  MixedLesson,
} from "../data/types";
import type { IngestEvent, PipelineStats } from "./pipeline";

interface LessonStub {
  id: string;
  kind: "reading" | "exercise" | "quiz" | "mixed";
  title: string;
  intent: string;
}

interface LlmResponseTS {
  text: string;
  input_tokens: number;
  output_tokens: number;
  elapsed_ms: number;
}

export interface RegenOptions {
  bookId: string;
  onProgress: (stage: string, detail?: string) => void;
  onEvent?: (event: IngestEvent) => void;
  onStats?: (stats: PipelineStats) => void;
  signal?: AbortSignal;
}

export class RegenAborted extends Error {
  constructor() {
    super("aborted");
    this.name = "RegenAborted";
  }
}

const MAX_REFERENCE_CHARS = 500_000;
function fitReference(md: string): string {
  if (md.length <= MAX_REFERENCE_CHARS) return md;
  const window = md.slice(0, MAX_REFERENCE_CHARS);
  let idx = window.lastIndexOf("\n## ");
  if (idx < MAX_REFERENCE_CHARS * 0.7) idx = window.lastIndexOf("\n\n");
  if (idx < MAX_REFERENCE_CHARS * 0.7) idx = MAX_REFERENCE_CHARS;
  return window.slice(0, idx) + "\n\n*(Reference truncated.)*\n";
}

/// Regenerate every exercise/mixed lesson in the given book. Saves after
/// each lesson so a crash/cancel still leaves the course in a usable state.
export async function regenerateExercises(opts: RegenOptions): Promise<void> {
  const { bookId, onProgress, onEvent, onStats, signal } = opts;

  const emit = (e: Omit<IngestEvent, "timestamp">) =>
    onEvent?.({ ...e, timestamp: Date.now() });
  const checkAbort = () => {
    if (signal?.aborted) throw new RegenAborted();
  };

  // Load the existing course — if it's not on disk, nothing to regen.
  const course = await invoke<Course>("load_course", { courseId: bookId });
  emit({
    level: "info",
    stage: "meta",
    message: `regenerating exercises for "${course.title}" (${course.chapters.length} chapters)`,
  });

  // Stats shape matches runPipeline's PipelineStats so the same FloatingIngestPanel
  // renders without modification.
  const stats: PipelineStats = {
    startedAt: Date.now(),
    elapsedMs: 0,
    totalChapters: course.chapters.length,
    chaptersDone: 0,
    lessonsTotal: 0,
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
    model: "claude-sonnet-4-8",
  };
  // Count target exercises up front so progress has a denominator.
  for (const ch of course.chapters) {
    for (const l of ch.lessons) {
      if (l.kind === "exercise" || l.kind === "mixed") stats.lessonsTotal++;
    }
  }
  const pushStats = () => {
    stats.elapsedMs = Date.now() - stats.startedAt;
    onStats?.({ ...stats, lessonsByKind: { ...stats.lessonsByKind } });
  };
  pushStats();

  // Per-chapter loop: pull cleaned markdown + outline stubs from cache,
  // regenerate each exercise/mixed lesson.
  for (let ci = 0; ci < course.chapters.length; ci++) {
    const ch = course.chapters[ci];
    const chNum = ci + 1;
    const pad = String(chNum).padStart(2, "0");

    const exercises = ch.lessons.filter(
      (l) => l.kind === "exercise" || l.kind === "mixed",
    );
    if (exercises.length === 0) {
      stats.chaptersDone++;
      pushStats();
      continue;
    }

    // Load cleaned markdown for this chapter from cache. If missing (unusual
    // — would mean an older ingest that didn't complete), fall back to the
    // lesson bodies concatenated.
    onProgress(
      `Regenerating ch ${chNum}/${course.chapters.length} · ${exercises.length} exercises`,
      ch.title,
    );
    const cleanedRaw = await invoke<string | null>("cache_read", {
      bookId,
      key: `clean/chapter-${pad}.md`,
    });
    const cleanedMd = cleanedRaw
      ? fitReference(cleanedRaw)
      : ch.lessons.map((l) => `## ${l.title}\n\n${l.body ?? ""}`).join("\n\n");

    // Load cached outline stubs so we can feed the same stub Claude was
    // given originally. If missing, synthesize from the lesson itself.
    let stubs: LessonStub[] = [];
    const outlineRaw = await invoke<string | null>("cache_read", {
      bookId,
      key: `outlines/chapter-${pad}.json`,
    });
    if (outlineRaw) {
      try {
        stubs = JSON.parse(outlineRaw) as LessonStub[];
      } catch {
        /* bad outline JSON — fall through */
      }
    }

    let priorSolution: string | undefined;
    for (let li = 0; li < ch.lessons.length; li++) {
      checkAbort();
      const existing = ch.lessons[li];
      if (existing.kind !== "exercise" && existing.kind !== "mixed") {
        // Reading/quiz — nothing to regenerate. `priorSolution` is updated
        // after each successful regen below, so continuity hints still flow.
        continue;
      }
      // Match by id; synthesize a stub from the existing lesson if the
      // outline cache doesn't have one (e.g. lesson was regenerated after
      // a pipeline change).
      const stub =
        stubs.find((s) => s.id === existing.id) ??
        ({
          id: existing.id,
          kind: existing.kind,
          title: existing.title,
          intent:
            existing.body?.slice(0, 200).replace(/\n/g, " ") ??
            "(no intent recovered)",
        } as LessonStub);

      onProgress(
        `Regenerating lesson ${stats.lessonsDone + 1}/${stats.lessonsTotal}`,
        `${existing.title} · ${stub.kind}`,
      );

      // Invalidate the lesson cache so save_lesson cache reads can't
      // resurrect the old buggy output.
      await invoke("cache_write", {
        bookId,
        key: `lessons/chapter-${pad}/${slug(stub.id)}.json.old`,
        contents: "",
      }).catch(() => {
        /* ignore */
      });

      try {
        const resp = await invoke<LlmResponseTS>("generate_lesson", {
          chapterTitle: ch.title,
          cleanedMarkdown: cleanedMd,
          language: (course.language ?? "javascript") as LanguageId,
          stub: JSON.stringify(stub),
          priorSolution: priorSolution ?? null,
        });
        stats.apiCalls++;
        stats.inputTokens += resp.input_tokens;
        stats.outputTokens += resp.output_tokens;

        const parsed = parseJsonTolerant<Lesson>(resp.text);
        if (!parsed) {
          emit({
            level: "error",
            stage: "generate",
            chapter: chNum,
            lesson: stub.id,
            message: `could not parse response — keeping existing lesson`,
          });
          stats.validationFailures++;
          pushStats();
          continue;
        }
        // Preserve the existing id on the off chance Claude renamed it.
        parsed.id = existing.id;
        ch.lessons[li] = parsed;

        if ((parsed as MixedLesson | ExerciseLesson).solution) {
          priorSolution = (parsed as MixedLesson | ExerciseLesson).solution;
        }

        stats.lessonsDone++;
        stats.lessonsByKind[parsed.kind] =
          (stats.lessonsByKind[parsed.kind] ?? 0) + 1;

        // Save the course with the updated lesson immediately.
        await invoke("save_course", {
          courseId: bookId,
          body: course,
        });
        emit({
          level: "info",
          stage: "save",
          chapter: chNum,
          lesson: stub.id,
          message: `done: regenerated "${parsed.title}" (${parsed.kind})`,
        });
        pushStats();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({
          level: "error",
          stage: "generate",
          chapter: chNum,
          lesson: stub.id,
          message: `regeneration failed: ${msg.slice(0, 200)}`,
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
    message: `regeneration complete · ${stats.lessonsDone} lessons updated`,
  });
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "x"
  );
}

function parseJsonTolerant<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    /* fall through */
  }
  const fence = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]) as T;
    } catch {
      /* fall through */
    }
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1)) as T;
    } catch {
      /* fall through */
    }
  }
  return null;
}
