import type { LanguageId } from "../../data/types";

// Local shape for stage-1 input (per-chapter blob). Distinct from pdfParser's
// RawChapter which carries section-level metadata we flatten down.
export interface ChapterBlob {
  title: string;
  body: string;
}

export interface PipelineOptions {
  pdfPath: string;
  bookId: string;       // slugified id used for cache directory + course id
  title: string;
  author?: string;
  language: LanguageId;
  /** High-level stage label for the main progress line. */
  onProgress: (stage: string, detail?: string) => void;
  /** Optional fine-grained event stream for the verbose log panel. */
  onEvent?: (event: IngestEvent) => void;
  /** Cumulative stats snapshot pushed after each material update. */
  onStats?: (stats: PipelineStats) => void;
  /**
   * When aborted, the pipeline throws at the next cancel checkpoint (between
   * stages / API calls). The per-stage cache means the user can re-run and
   * pick up right where they stopped.
   */
  signal?: AbortSignal;
}

export interface IngestEvent {
  timestamp: number;
  level: "info" | "warn" | "error" | "cache";
  stage: "extract" | "clean" | "outline" | "generate" | "validate" | "retry" | "save" | "meta";
  chapter?: number;
  lesson?: string;
  message: string;
}

/// Rolling counters rendered as a stats bar above the running progress row.
/// Frontend caches the latest value and re-renders it whenever onStats fires.
export interface PipelineStats {
  startedAt: number;        // Date.now() at pipeline start
  elapsedMs: number;
  totalChapters: number;
  chaptersDone: number;
  lessonsTotal: number;     // sum of all outlined stubs across planned chapters
  lessonsDone: number;      // lessons fully generated (and for exercises, validated)
  lessonsByKind: Record<string, number>;
  apiCalls: number;         // Anthropic calls this run (cache hits don't count)
  cacheHits: number;
  validationAttempts: number;
  validationFailures: number; // non-final failures (pre-retry)
  demotedExercises: number;   // exercises that used up all retries → reading
  inputTokens: number;
  outputTokens: number;
  /// Per-million-token cost at the selected model. Unit: USD.
  estimatedCostUsd: number;
  model: string;
}

// Pricing in USD per 1M tokens. Update if Anthropic's prices change.
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-8": { input: 3, output: 15 },
  "claude-opus-4-8":   { input: 15, output: 75 },
  "claude-haiku-4-8":  { input: 1, output: 5 },
};

export function costFor(model: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING[model] ?? MODEL_PRICING["claude-sonnet-4-8"];
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}
