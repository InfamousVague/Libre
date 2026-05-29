/// Retry a single demoted lesson. The ingest pipeline demotes an
/// exercise to a reading lesson after 3 validation failures (logs a
/// note in the body and changes `kind` to `"reading"`). This module
/// targets ONE such lesson by id, re-runs `generate_lesson` for it
/// using the cached chapter markdown from the original ingest, and
/// replaces the lesson in-place if the new attempt validates.
///
/// Unlike `regenExercises`, this doesn't walk the whole course — it's
/// driven by an inline "Retry this exercise" button in the reader, so
/// the user can fix one lesson at a time without paying to regenerate
/// an entire chapter.

import { invoke } from "@tauri-apps/api/core";
import type {
  Course,
  Lesson,
  LanguageId,
} from "../data/types";
import type { IngestEvent, PipelineStats } from "./pipeline";

const MAX_REFERENCE_CHARS = 500_000;
function fitReference(md: string): string {
  if (md.length <= MAX_REFERENCE_CHARS) return md;
  const win = md.slice(0, MAX_REFERENCE_CHARS);
  let idx = win.lastIndexOf("\n## ");
  if (idx < MAX_REFERENCE_CHARS * 0.7) idx = win.lastIndexOf("\n\n");
  if (idx < MAX_REFERENCE_CHARS * 0.7) idx = MAX_REFERENCE_CHARS;
  return win.slice(0, idx) + "\n\n*(Reference truncated.)*\n";
}

export interface RetryLessonOptions {
  bookId: string;
  lessonId: string;
  onProgress: (stage: string, detail?: string) => void;
  onEvent?: (event: IngestEvent) => void;
  onStats?: (stats: PipelineStats) => void;
  signal?: AbortSignal;
}

export class RetryAborted extends Error {
  constructor() {
    super("retry aborted");
    this.name = "RetryAborted";
  }
}

interface LlmResponseTS {
  text: string;
  input_tokens: number;
  output_tokens: number;
  elapsed_ms: number;
}

interface LessonStub {
  id: string;
  kind: "reading" | "exercise" | "quiz" | "mixed";
  title: string;
  intent: string;
}

function parseJsonTolerant<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    /* fall through */
  }
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]) as T;
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

/// Extract the "intent" (short summary of what the learner is supposed
/// to do) from a demoted lesson's body. We strip the demotion note and
/// the reference-solution section that the pipeline appended, and use
/// the first ~400 chars of what's left as the intent hint for the
/// regenerated stub.
function intentFromDemotedBody(body: string, fallback: string): string {
  let cleaned = body
    // Drop the italic demotion note paragraph.
    .replace(
      /\*\(This exercise was demoted to a reading lesson after[^)]*\)\*/gi,
      "",
    )
    // Drop the "## Reference solution" block onwards — it's post-hoc
    // content, not the task the learner needs to do.
    .replace(/\n+##+\s*Reference\s+solution[\s\S]*$/i, "")
    .trim();
  // Collapse whitespace.
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (!cleaned) return fallback;
  return cleaned.length > 400 ? cleaned.slice(0, 400) + "…" : cleaned;
}

/// Strip the "(demoted)" suffix the pipeline appended when demoting.
function undemoteTitle(title: string): string {
  return title.replace(/\s*\(demoted\)\s*$/i, "").trim() || title;
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

/// Retry one demoted lesson. Returns nothing — side effects are the
/// `save_course` call and the event stream. FloatingIngestPanel tracks
/// progress via the passed-in callbacks.
export async function retryLesson(opts: RetryLessonOptions): Promise<void> {
  const { bookId, lessonId, onProgress, onEvent, onStats, signal } = opts;

  const emit = (e: Omit<IngestEvent, "timestamp">) =>
    onEvent?.({ ...e, timestamp: Date.now() });
  const checkAbort = () => {
    if (signal?.aborted) throw new RetryAborted();
  };

  const course = await invoke<Course>("load_course", { courseId: bookId });

  // Locate the lesson + its chapter.
  let chIdx = -1;
  let lIdx = -1;
  let existing: Lesson | null = null;
  for (let i = 0; i < course.chapters.length; i++) {
    const found = course.chapters[i].lessons.findIndex(
      (l) => l.id === lessonId,
    );
    if (found >= 0) {
      chIdx = i;
      lIdx = found;
      existing = course.chapters[i].lessons[found];
      break;
    }
  }
  if (!existing || chIdx < 0) {
    throw new Error(`lesson "${lessonId}" not found in course "${bookId}"`);
  }

  // Look up the display model for stats costing. Mirrors the other
  // pipelines — best-effort, non-fatal if Settings isn't readable.
  let displayModel = "claude-sonnet-4-8";
  try {
    const s = await invoke<{ anthropic_model?: string }>("load_settings");
    if (s.anthropic_model) displayModel = s.anthropic_model;
  } catch {
    /* not in Tauri — keep default */
  }

  const stats: PipelineStats = {
    startedAt: Date.now(),
    elapsedMs: 0,
    totalChapters: 1,
    chaptersDone: 0,
    lessonsTotal: 1,
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

  const ch = course.chapters[chIdx];
  const chNum = chIdx + 1;
  const pad = String(chNum).padStart(2, "0");
  const cleanTitle = undemoteTitle(existing.title);

  onProgress(`Retrying "${cleanTitle}"`, `chapter ${chNum}: ${ch.title}`);
  emit({
    level: "info",
    stage: "meta",
    chapter: chNum,
    lesson: existing.id,
    message: `▶ retrying exercise "${cleanTitle}"`,
  });
  pushStats();

  // Pull the cached cleaned-markdown for this chapter (same cache key
  // regenExercises uses). If it's missing — older ingest that didn't
  // reach the clean stage — fall back to concatenating the chapter's
  // lesson bodies so the LLM has *something* to reference.
  checkAbort();
  const cleanedRaw = await invoke<string | null>("cache_read", {
    bookId,
    key: `clean/chapter-${pad}.md`,
  });
  const cleanedMd = cleanedRaw
    ? fitReference(cleanedRaw)
    : ch.lessons.map((l) => `## ${l.title}\n\n${l.body ?? ""}`).join("\n\n");

  // Build a fresh stub. We ALWAYS request `kind: "exercise"` — that's
  // the whole point of the retry; the demoted-reading version isn't what
  // the learner wanted.
  const intent = intentFromDemotedBody(
    existing.body ?? "",
    cleanTitle,
  );
  const stub: LessonStub = {
    id: existing.id,
    kind: "exercise",
    title: cleanTitle,
    intent,
  };

  // Language — prefer the lesson's own field if it's an exercise-kind,
  // else fall back to the course's primary language.
  const language: LanguageId =
    (existing.kind === "exercise" || existing.kind === "mixed") &&
    "language" in existing &&
    existing.language
      ? existing.language
      : course.language;

  // Invalidate any cache for this single lesson so the generator
  // doesn't serve us a stale copy of the same demoted output. Error
  // here is non-fatal — cache miss is fine.
  await invoke("cache_write", {
    bookId,
    key: `lessons/chapter-${pad}/${slug(existing.id)}.json.old`,
    contents: "",
  }).catch(() => {
    /* ignore */
  });

  try {
    const resp = await invoke<LlmResponseTS>("generate_lesson", {
      chapterTitle: ch.title,
      cleanedMarkdown: cleanedMd,
      language,
      stub: JSON.stringify(stub),
      priorSolution: null,
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
        lesson: existing.id,
        message: `could not parse response — leaving demoted version in place`,
      });
      stats.validationFailures++;
      pushStats();
      return;
    }

    // Preserve the id (Claude might rename it) and swap in.
    parsed.id = existing.id;
    course.chapters[chIdx].lessons[lIdx] = parsed;

    stats.lessonsDone++;
    stats.lessonsByKind[parsed.kind] =
      (stats.lessonsByKind[parsed.kind] ?? 0) + 1;

    await invoke("save_course", { courseId: bookId, body: course });
    emit({
      level: "info",
      stage: "save",
      chapter: chNum,
      lesson: existing.id,
      message: `done: retry succeeded — "${parsed.title}" (${parsed.kind})`,
    });
    pushStats();
  } catch (e) {
    if (signal?.aborted) throw new RetryAborted();
    const msg = e instanceof Error ? e.message : String(e);
    emit({
      level: "error",
      stage: "generate",
      chapter: chNum,
      lesson: existing.id,
      message: `retry failed: ${msg.slice(0, 200)}`,
    });
    stats.validationFailures++;
    pushStats();
    throw e;
  }
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "lesson"
  );
}
