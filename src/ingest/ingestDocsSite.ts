/// Documentation-site ingest pipeline.
///
/// Given a start URL, this pipeline:
///   1. Extracts the site's sidebar navigation tree (Docusaurus / MkDocs /
///      Sphinx / etc.) so chapters follow the site author's curated
///      structure, not a naive URL-path split.
///   2. Crawls every page in that nav, in nav order, via the Rust
///      `crawl_docs_site` command which attaches chapter markers to each
///      CrawledPage.
///   3. For each chapter: emits a READING lesson per page (with prev/next
///      neighbour context so lessons flow like book chapters), THEN a
///      capstone EXERCISE that synthesizes the chapter's core concepts.
///
/// Falls back to BFS + URL-path grouping when sidebar extraction fails,
/// so sites without a recognizable nav tree still produce something usable.
///
/// Mirrors the architecture of `regenExercises.ts`: single async fn with
/// `onProgress` / `onEvent` / `onStats` / `signal` callbacks, saves the
/// course after every lesson so a crash or cancel leaves the partial
/// result usable.

import { invoke } from "@tauri-apps/api/core";
import type {
  Course,
  LanguageId,
  Lesson,
} from "../data/types";
import type { IngestEvent, PipelineStats } from "./pipeline";

/// Per-page payload from the Rust crawler. Field names match the Rust
/// struct via serde's default snake_case. If the Rust side ever switches
/// serde settings this interface must follow.
interface CrawledPage {
  url: string;
  title: string;
  markdown: string;
  code_block_count: number;
  /// Chapter label attached by the nav-driven crawler. Null when the
  /// crawler fell back to BFS mode — frontend derives chapters from URL
  /// segments in that case.
  chapter: string | null;
  chapter_position: number;
  depth: number;
  inlined_images: number;
}

interface CrawlResult {
  pages: CrawledPage[];
  skipped: string[];
  error: string | null;
}

/// Matches the Rust `NavTree` struct. Leaf pages have `url`; categories
/// have `children`. Nodes can be both.
interface NavTree {
  children: NavNode[];
}
interface NavNode {
  title: string;
  url: string | null;
  children: NavNode[];
}

interface LlmResponseTS {
  text: string;
  input_tokens: number;
  output_tokens: number;
  elapsed_ms: number;
}

export interface DocsIngestOptions {
  bookId: string;
  title: string;
  language: LanguageId;
  startUrl: string;
  maxPages: number;
  maxDepth: number;
  requestDelayMs: number;
  embedImages: boolean;
  modelOverride?: string;
  onProgress: (stage: string, detail?: string) => void;
  onEvent?: (event: IngestEvent) => void;
  onStats?: (stats: PipelineStats) => void;
  signal?: AbortSignal;
}

export class DocsIngestAborted extends Error {
  constructor() {
    super("docs ingest aborted by user");
    this.name = "DocsIngestAborted";
  }
}

/// Entry point. Resolves when the course is fully built + saved.
export async function ingestDocsSite(opts: DocsIngestOptions): Promise<Course> {
  const {
    bookId,
    title,
    language,
    startUrl,
    maxPages,
    maxDepth,
    requestDelayMs,
    embedImages,
    modelOverride,
    onProgress,
    onEvent,
    onStats,
    signal,
  } = opts;

  const emit = (e: Omit<IngestEvent, "timestamp">) =>
    onEvent?.({ ...e, timestamp: Date.now() });
  const checkAbort = () => {
    if (signal?.aborted) throw new DocsIngestAborted();
  };

  // Resolve the model pin so the stats panel can cost out tokens.
  let currentModel = modelOverride ?? "claude-sonnet-4-8";
  if (!modelOverride) {
    try {
      const s = await invoke<{ anthropic_model?: string }>("load_settings");
      if (s.anthropic_model) currentModel = s.anthropic_model;
    } catch {
      /* not in Tauri — keep default */
    }
  }

  const stats: PipelineStats = {
    startedAt: Date.now(),
    elapsedMs: 0,
    totalChapters: 0,
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
    model: currentModel,
  };
  const pushStats = () => {
    stats.elapsedMs = Date.now() - stats.startedAt;
    onStats?.({ ...stats, lessonsByKind: { ...stats.lessonsByKind } });
  };
  pushStats();

  // --- Phase 1: nav extraction ---------------------------------------------

  onProgress("Reading site navigation", startUrl);
  emit({
    level: "info",
    stage: "extract",
    message: `fetching nav tree from ${startUrl}`,
  });

  let navTree: NavTree | null = null;
  try {
    const tree = await invoke<NavTree>("extract_docs_nav", { url: startUrl });
    if (tree && tree.children && tree.children.length > 0) {
      navTree = tree;
      const chapterCount = tree.children.length;
      const pageCount = countNavPages(tree);
      emit({
        level: "info",
        stage: "extract",
        message: `found sidebar with ${chapterCount} sections, ${pageCount} pages`,
      });
    } else {
      emit({
        level: "warn",
        stage: "extract",
        message: `no sidebar detected — falling back to BFS crawl + URL-path chapters`,
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit({
      level: "warn",
      stage: "extract",
      message: `nav extraction failed (${msg}) — falling back to BFS crawl`,
    });
  }
  checkAbort();

  // --- Phase 2: crawl -------------------------------------------------------

  onProgress("Crawling pages", navTree ? "following sidebar order" : "BFS");

  const crawl = await invoke<CrawlResult>("crawl_docs_site", {
    config: {
      start_url: startUrl,
      max_pages: maxPages,
      max_depth: maxDepth,
      request_delay_ms: requestDelayMs,
      download_images: embedImages,
      book_id: bookId,
      nav_tree: navTree,
    },
  });
  checkAbort();

  if (crawl.pages.length === 0) {
    emit({
      level: "error",
      stage: "extract",
      message: `crawl returned 0 pages — check URL or site may be JS-rendered`,
    });
    throw new Error("crawl returned 0 pages");
  }

  emit({
    level: "info",
    stage: "extract",
    message: `crawled ${crawl.pages.length} pages${
      crawl.skipped.length > 0 ? ` (${crawl.skipped.length} skipped)` : ""
    }`,
  });
  for (const s of crawl.skipped.slice(0, 10)) {
    emit({ level: "warn", stage: "extract", message: `skipped: ${s}` });
  }

  // --- Phase 3: group pages into chapters ----------------------------------

  const chapters = navTree
    ? groupByChapterField(crawl.pages)
    : groupByUrlPath(crawl.pages, startUrl);

  stats.totalChapters = chapters.length;
  // Each chapter contributes (pages + 1 capstone) lessons. The capstone
  // bump only applies when there's at least one reading in the chapter
  // to anchor the exercise to.
  stats.lessonsTotal = chapters.reduce(
    (acc, c) => acc + c.pages.length + (c.pages.length > 0 ? 1 : 0),
    0,
  );
  pushStats();
  emit({
    level: "info",
    stage: "outline",
    message: `grouped into ${chapters.length} chapter${chapters.length === 1 ? "" : "s"} · ${stats.lessonsTotal} lessons (incl. capstones)`,
  });

  // --- Phase 4: build the course skeleton + save incrementally -------------

  const course: Course = {
    id: bookId,
    title,
    language,
    description: `Generated from ${startUrl}`,
    chapters: chapters.map((c) => ({
      id: c.slug,
      title: c.title,
      lessons: [],
    })),
    sourceType: "docs",
    sourceUrl: startUrl,
  };
  await invoke("save_course", { courseId: bookId, body: course });

  // --- Phase 5: per-chapter lesson + capstone generation -------------------

  for (let ci = 0; ci < chapters.length; ci++) {
    const chapterPlan = chapters[ci];
    const chNum = ci + 1;
    if (chapterPlan.pages.length === 0) {
      stats.chaptersDone++;
      pushStats();
      continue;
    }

    onProgress(
      `Chapter ${chNum}/${chapters.length}`,
      chapterPlan.title,
    );

    // Readings first — one per page, in nav order with prev/next context
    // so they flow like book sections.
    const readings: Lesson[] = [];
    for (let li = 0; li < chapterPlan.pages.length; li++) {
      checkAbort();
      const page = chapterPlan.pages[li];
      const lessonId = `${chapterPlan.slug}-${slug(page.url) || String(li + 1)}`;
      const prevTitle = li > 0 ? chapterPlan.pages[li - 1].title : undefined;
      const nextTitle =
        li < chapterPlan.pages.length - 1
          ? chapterPlan.pages[li + 1].title
          : "the chapter's practice exercise";

      onProgress(
        `Lesson ${stats.lessonsDone + 1}/${stats.lessonsTotal}`,
        `${page.title} · reading`,
      );

      let generated: Lesson | null = null;
      try {
        const resp = await invoke<LlmResponseTS>(
          "generate_lesson_from_docs_page",
          {
            pageUrl: page.url,
            pageTitle: page.title,
            pageMarkdown: truncateForPrompt(page.markdown),
            language,
            lessonKind: "reading",
            lessonId,
            chapterTitle: chapterPlan.title,
            previousLessonTitle: prevTitle ?? null,
            nextLessonTitle: nextTitle ?? null,
            chapterPosition: li,
            chapterTotal: chapterPlan.pages.length,
            modelOverride: modelOverride ?? null,
          },
        );
        stats.apiCalls++;
        stats.inputTokens += resp.input_tokens;
        stats.outputTokens += resp.output_tokens;
        stats.estimatedCostUsd = costFor(
          currentModel,
          stats.inputTokens,
          stats.outputTokens,
        );
        generated = parseJsonTolerant<Lesson>(resp.text);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({
          level: "error",
          stage: "generate",
          chapter: chNum,
          lesson: lessonId,
          message: `LLM call failed: ${msg.slice(0, 200)}`,
        });
        stats.validationFailures++;
      }

      // Fallback: raw markdown as a reading so the chapter stays complete.
      if (!generated) {
        generated = {
          id: lessonId,
          kind: "reading",
          title: page.title,
          body:
            page.markdown +
            `\n\n_Adapted from [${page.title}](${page.url})._`,
        } as Lesson;
        emit({
          level: "warn",
          stage: "generate",
          chapter: chNum,
          lesson: lessonId,
          message: `LLM output unusable — seeded from raw page content`,
        });
      } else {
        generated.id = lessonId;
      }

      readings.push(generated);
      course.chapters[ci].lessons.push(generated);
      stats.lessonsDone++;
      stats.lessonsByKind[generated.kind] =
        (stats.lessonsByKind[generated.kind] ?? 0) + 1;
      await invoke("save_course", { courseId: bookId, body: course });
      emit({
        level: "info",
        stage: "save",
        chapter: chNum,
        lesson: lessonId,
        message: `done: ${generated.title}`,
      });
      pushStats();
    }

    // Capstone — one per chapter. Synthesizes an exercise from the
    // readings we just generated. Skipped if the chapter only had one
    // reading AND it's a landing/index page (too thin a concept base
    // to build a fair exercise on). Heuristic: first-page-only + very
    // short content means "landing", skip the capstone.
    checkAbort();
    const capstoneCoveragePasses = readings.length >= 2 ||
      (readings.length === 1 && (readings[0].body?.length ?? 0) >= 600);
    if (!capstoneCoveragePasses) {
      emit({
        level: "info",
        stage: "meta",
        chapter: chNum,
        message: `skipping capstone for short chapter "${chapterPlan.title}"`,
      });
      stats.chaptersDone++;
      // Adjust the total so the progress % stays accurate.
      stats.lessonsTotal = Math.max(0, stats.lessonsTotal - 1);
      pushStats();
      continue;
    }

    const capstoneId = `${chapterPlan.slug}-capstone`;
    onProgress(
      `Lesson ${stats.lessonsDone + 1}/${stats.lessonsTotal}`,
      `${chapterPlan.title} · capstone exercise`,
    );
    try {
      const summaries = buildLessonSummaries(readings);
      const resp = await invoke<LlmResponseTS>("generate_chapter_capstone", {
        chapterTitle: chapterPlan.title,
        language,
        lessonSummaries: summaries,
        lessonId: capstoneId,
        modelOverride: modelOverride ?? null,
      });
      stats.apiCalls++;
      stats.inputTokens += resp.input_tokens;
      stats.outputTokens += resp.output_tokens;
      stats.estimatedCostUsd = costFor(
        currentModel,
        stats.inputTokens,
        stats.outputTokens,
      );
      const parsed = parseJsonTolerant<Lesson>(resp.text);
      if (parsed) {
        parsed.id = capstoneId;
        course.chapters[ci].lessons.push(parsed);
        stats.lessonsDone++;
        stats.lessonsByKind[parsed.kind] =
          (stats.lessonsByKind[parsed.kind] ?? 0) + 1;
        await invoke("save_course", { courseId: bookId, body: course });
        emit({
          level: "info",
          stage: "save",
          chapter: chNum,
          lesson: capstoneId,
          message: `done: capstone: ${parsed.title}`,
        });
      } else {
        emit({
          level: "warn",
          stage: "generate",
          chapter: chNum,
          lesson: capstoneId,
          message: `capstone JSON unparseable — skipping`,
        });
        stats.validationFailures++;
        // Don't leave a ghost slot in the expected total.
        stats.lessonsTotal = Math.max(0, stats.lessonsTotal - 1);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit({
        level: "error",
        stage: "generate",
        chapter: chNum,
        lesson: capstoneId,
        message: `capstone generation failed: ${msg.slice(0, 200)}`,
      });
      stats.validationFailures++;
      stats.lessonsTotal = Math.max(0, stats.lessonsTotal - 1);
    }

    stats.chaptersDone++;
    pushStats();
  }

  emit({
    level: "info",
    stage: "meta",
    message: `docs ingest complete · ${stats.lessonsDone}/${stats.lessonsTotal} lessons`,
  });
  return course;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ChapterPlan {
  slug: string;
  title: string;
  pages: CrawledPage[];
}

/// Nav-driven grouping. Trusts the `chapter` field the Rust crawler
/// stamped on each page and preserves the order it returned them in.
function groupByChapterField(pages: CrawledPage[]): ChapterPlan[] {
  const byChapter = new Map<string, ChapterPlan>();
  const order: string[] = [];
  for (const p of pages) {
    const name = p.chapter ?? "Documentation";
    if (!byChapter.has(name)) {
      byChapter.set(name, {
        slug: slug(name) || "chapter",
        title: name,
        pages: [],
      });
      order.push(name);
    }
    byChapter.get(name)!.pages.push(p);
  }
  // Preserve insertion order (nav order) but sort each chapter's pages
  // by their recorded chapter_position just in case the crawler
  // reordered under the hood.
  for (const name of order) {
    byChapter.get(name)!.pages.sort((a, b) => a.chapter_position - b.chapter_position);
  }
  // Dedupe slugs if two chapters humanize to the same slug.
  const seen = new Set<string>();
  return order.map((name) => {
    const plan = byChapter.get(name)!;
    let base = plan.slug;
    let i = 2;
    while (seen.has(plan.slug)) {
      plan.slug = `${base}-${i++}`;
    }
    seen.add(plan.slug);
    return plan;
  });
}

/// BFS-fallback grouping — same as the pre-nav behaviour. Used when no
/// sidebar was detected on the site.
function groupByUrlPath(pages: CrawledPage[], startUrl: string): ChapterPlan[] {
  const start = safeUrl(startUrl);
  if (!start) {
    return [{ slug: "docs", title: "Documentation", pages }];
  }
  const rootPath = deriveRootPath(start.pathname);

  const byKey = new Map<string, CrawledPage[]>();
  for (const p of pages) {
    const u = safeUrl(p.url);
    if (!u) continue;
    let rest = u.pathname;
    if (rest.startsWith(rootPath)) {
      rest = rest.slice(rootPath.length);
    }
    rest = rest.replace(/^\/+/, "");
    const firstSegment = rest.split("/")[0] || "overview";
    const key = firstSegment || "overview";
    const bucket = byKey.get(key) ?? [];
    bucket.push(p);
    byKey.set(key, bucket);
  }

  if (byKey.size === 1) {
    const [[, ps]] = [...byKey.entries()];
    return [{ slug: "documentation", title: "Documentation", pages: ps }];
  }

  const groups = [...byKey.entries()].map(([key, pagesInKey]) => ({
    slug: slug(key),
    title: humanizeSegment(key),
    pages: pagesInKey.sort((a, b) => a.depth - b.depth || a.url.localeCompare(b.url)),
    minDepth: Math.min(...pagesInKey.map((p) => p.depth)),
  }));
  groups.sort((a, b) => a.minDepth - b.minDepth || a.slug.localeCompare(b.slug));
  return groups.map((g) => ({ slug: g.slug, title: g.title, pages: g.pages }));
}

/// Recursively counts URL-bearing nodes in a nav tree so the progress
/// log can show "found sidebar with N pages" up front.
function countNavPages(tree: NavTree): number {
  let total = 0;
  const walk = (node: NavNode) => {
    if (node.url) total++;
    for (const c of node.children) walk(c);
  };
  for (const top of tree.children) walk(top);
  return total;
}

/// Build the `lesson_summaries` string the capstone prompt expects. We
/// cap each body at ~500 chars so a large chapter (say, 15 readings)
/// still fits comfortably in a single LLM call. JSON-encoded so the
/// Rust command can pass it through without mangling escapes.
function buildLessonSummaries(readings: Lesson[]): string {
  const items = readings.map((l) => ({
    title: l.title,
    body_snippet: (l.body ?? "").slice(0, 500),
    objectives: (l.objectives ?? []).slice(0, 5),
  }));
  return JSON.stringify(items, null, 2);
}

function deriveRootPath(pathname: string): string {
  const i = pathname.lastIndexOf("/");
  if (i < 0) return "/";
  return pathname.slice(0, i + 1);
}

function safeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/// Cap the prompt at ~60k chars so the LLM cost scales with the page's
/// actual content, not with deep API reference tables that don't add
/// teaching value.
const MAX_PAGE_CHARS = 60_000;
function truncateForPrompt(md: string): string {
  if (md.length <= MAX_PAGE_CHARS) return md;
  return md.slice(0, MAX_PAGE_CHARS) + "\n\n_[source page truncated]_\n";
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || ""
  );
}

function humanizeSegment(seg: string): string {
  const ALL_CAPS = new Set(["api", "cli", "ui", "ux", "sdk", "faq", "ide"]);
  return seg
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => (ALL_CAPS.has(w.toLowerCase()) ? w.toUpperCase() : capitalize(w)))
    .join(" ");
}

function capitalize(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-8": { input: 3, output: 15 },
  "claude-opus-4-8": { input: 15, output: 75 },
  "claude-haiku-4-8": { input: 1, output: 5 },
};

function costFor(model: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING[model] ?? MODEL_PRICING["claude-sonnet-4-8"];
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
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
