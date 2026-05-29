#!/usr/bin/env node
/// Translate one Libre-authored course into the supported non-EN
/// locales using the Anthropic Claude API. Idempotent — re-running
/// only fills in the locales / lessons that don't already have a
/// translation, so a partial run can resume seamlessly.
///
/// Usage:
///   ANTHROPIC_API_KEY=sk-ant-... \
///     node scripts/translate-course.mjs \
///       <courseId-or-path-to-course.json> \
///       --locales ru,es,fr,kr,jp \
///       [--limit 5] \
///       [--force-relock] \
///       [--dry-run]
///
/// Flags:
///   --locales      Comma-separated locales to fill in. Defaults to the
///                  full set (`ru,es,fr,kr,jp`). Use a subset to do one
///                  language at a time and inspect the output.
///   --limit        Cap the number of lessons translated per locale this
///                  run (useful for dry runs or rate-limit budgets).
///                  Defaults to no limit.
///   --force-relock Re-translate every lesson even if a translation
///                  already exists. Off by default — the script skips
///                  lessons where every translatable field is already
///                  populated for the locale.
///   --dry-run      Print what WOULD be translated without making any
///                  API calls or writing any files.
///
/// Output:
///   Mutates `<courseFile>` in place, adding `translations` overlays on
///   the course root, on each chapter, and on each lesson. The shape
///   matches `src/data/locales.ts` (CourseTranslation / ChapterTranslation
///   / LessonTranslation).
///
/// Recipe for translating ALL Libre-authored courses in one pass:
///   for c in a-to-zig a-to-ts hellotrade learning-ledger \
///            challenges-{ruby,lua,dart,haskell,scala,sql,elixir,zig,move,cairo,sway}-handwritten \
///            {rust,go,javascript,python,react-native,c,cpp,java,kotlin,csharp,swift}-challenges \
///            typescript-challenge-pack assembly-challenges-arm64-macos; do
///     node scripts/translate-course.mjs "$c" --locales ru,es,fr,kr,jp
///   done
///
/// API cost notes:
///   - Each lesson sends ~3-5 messages (title, body, objectives, hints/
///     questions). At ~500 input + ~600 output tokens per lesson per
///     locale, a 50-lesson course in 5 locales runs ~$2-4 with Sonnet.
///   - The script serialises requests with a 200ms delay between calls
///     to stay well under the per-minute rate limit. Override with
///     FB_TRANSLATE_DELAY_MS if you have a higher tier.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// ─── Locale config (mirrors src/data/locales.ts) ────────────────
const LOCALE_ENGLISH_NAMES = {
  ru: "Russian",
  es: "Spanish",
  fr: "French",
  kr: "Korean",
  jp: "Japanese",
};
const ALL_NON_EN = Object.keys(LOCALE_ENGLISH_NAMES);

// ─── CLI parse ──────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help") {
  console.log(`Usage: translate-course.mjs <courseId-or-path> [options]

Options:
  --locales <list>   Comma-separated: ru,es,fr,kr,jp (default: all)
  --limit <n>        Cap lessons translated per locale this run
  --force-relock     Re-translate even already-translated lessons
  --dry-run          Don't call the API, don't write files
`);
  process.exit(args[0] === "--help" ? 0 : 1);
}

const courseRef = args[0];
const optLocales = parseFlag(args, "--locales") || ALL_NON_EN.join(",");
const optLimit = parseFlag(args, "--limit");
const optForce = args.includes("--force-relock");
const optDry = args.includes("--dry-run");

const targetLocales = optLocales
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
for (const l of targetLocales) {
  if (!LOCALE_ENGLISH_NAMES[l]) {
    console.error(`Unknown locale: ${l}`);
    console.error(`Supported: ${ALL_NON_EN.join(", ")}`);
    process.exit(1);
  }
}

const limit = optLimit ? Number(optLimit) : Infinity;
const delayMs = Number(process.env.FB_TRANSLATE_DELAY_MS || 200);

// ─── Resolve the course file ────────────────────────────────────
function resolveCourseFile(ref) {
  // 1. Absolute / relative path that exists → use as-is.
  if (ref.endsWith(".json") && existsSync(ref)) return ref;
  if (ref.endsWith(".json") && existsSync(path.resolve(ref)))
    return path.resolve(ref);
  // 2. Treat as course id and look in `public/starter-courses/`.
  const starter = path.join(REPO_ROOT, "public", "starter-courses", `${ref}.json`);
  if (existsSync(starter)) return starter;
  throw new Error(`Course not found: ${ref}`);
}

const courseFile = resolveCourseFile(courseRef);
console.log(`📖 Course: ${path.relative(REPO_ROOT, courseFile)}`);
console.log(`🌍 Locales: ${targetLocales.join(", ")}`);
if (optDry) console.log(`(dry run — no API calls, no writes)`);

// ─── Anthropic client (raw fetch, no SDK dep) ───────────────────
// Using fetch directly so this script doesn't add @anthropic-ai/sdk
// to package.json — translation is a once-per-content-update task,
// not part of the runtime, and the SDK's only value here would be a
// thin wrapper around the same JSON POST.
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
let apiKey = null;
if (!optDry) {
  apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set in env.");
    process.exit(1);
  }
}

const MODEL = "claude-sonnet-4-8";
const SYSTEM_PROMPT = (locale) => `You translate technical educational content from English into ${LOCALE_ENGLISH_NAMES[locale]}.

Strict rules:
1. Preserve ALL markdown formatting exactly: headings, lists, blockquotes, links, images, tables, horizontal rules.
2. Preserve ALL code blocks (\`\`\` fences) VERBATIM. Do not translate code, identifiers, comments inside code, language tags, or anything between the fences.
3. Preserve ALL inline backticks: do not translate the text inside backticks (\`like_this\`).
4. Preserve ALL HTML tags and attributes verbatim.
5. Preserve ALL link URLs verbatim (translate only the visible link text).
6. Translate natural-language prose, headings, list items, captions, alt text, and link visible text.
7. Do not translate function names, variable names, file names, paths, URLs, or technical identifiers (whether inline or in prose).
8. Keep the same paragraph structure, bullet count, and numbered-list ordering as the source.
9. Output ONLY the translated text. Do not add commentary, do not wrap in code fences, do not preface with "Here is the translation".

If the input is short (a title, a single phrase, a list item), return ONLY the translated phrase with no extra punctuation or context.`;

let apiCallCount = 0;
async function translateOne(text, locale) {
  if (!text || !text.trim()) return text;
  apiCallCount += 1;
  if (optDry) return `[${locale}] ${text}`;
  await new Promise((r) => setTimeout(r, delayMs));
  // Retry on transient 429/5xx with capped exponential backoff.
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8192,
        system: SYSTEM_PROMPT(locale),
        messages: [{ role: "user", content: text }],
      }),
    });
    if (resp.status === 429 || resp.status >= 500) {
      const wait = 1000 * Math.pow(2, attempt);
      lastErr = new Error(`HTTP ${resp.status}, retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const json = await resp.json();
    const block = (json.content || []).find((b) => b.type === "text");
    return block ? block.text.trim() : "";
  }
  throw lastErr || new Error("translation failed");
}

async function translateLessonFields(lesson, locale) {
  const out = {};
  if (lesson.title) out.title = await translateOne(lesson.title, locale);
  if (lesson.body) out.body = await translateOne(lesson.body, locale);
  if (Array.isArray(lesson.objectives) && lesson.objectives.length > 0) {
    out.objectives = [];
    for (const o of lesson.objectives) {
      out.objectives.push(await translateOne(o, locale));
    }
  }
  if (Array.isArray(lesson.hints) && lesson.hints.length > 0) {
    out.hints = [];
    for (const h of lesson.hints) {
      out.hints.push(await translateOne(h, locale));
    }
  }
  if (Array.isArray(lesson.questions) && lesson.questions.length > 0) {
    out.questions = [];
    for (const q of lesson.questions) {
      const tq = {};
      if (q.prompt) tq.prompt = await translateOne(q.prompt, locale);
      if (Array.isArray(q.options) && q.options.length > 0) {
        tq.options = [];
        for (const op of q.options) {
          tq.options.push(await translateOne(op, locale));
        }
      }
      if (q.explanation)
        tq.explanation = await translateOne(q.explanation, locale);
      out.questions.push(tq);
    }
  }
  return out;
}

function isLessonFullyTranslated(lesson, locale) {
  const t = lesson?.translations?.[locale];
  if (!t) return false;
  if (lesson.title && !t.title) return false;
  if (lesson.body && !t.body) return false;
  if (Array.isArray(lesson.objectives) && lesson.objectives.length > 0)
    if (
      !Array.isArray(t.objectives) ||
      t.objectives.length !== lesson.objectives.length
    )
      return false;
  if (Array.isArray(lesson.hints) && lesson.hints.length > 0)
    if (!Array.isArray(t.hints) || t.hints.length !== lesson.hints.length)
      return false;
  if (Array.isArray(lesson.questions) && lesson.questions.length > 0)
    if (!Array.isArray(t.questions) || t.questions.length !== lesson.questions.length)
      return false;
  return true;
}

// ─── Walk the course ────────────────────────────────────────────
const course = JSON.parse(await readFile(courseFile, "utf8"));
const lessonCount = course.chapters.reduce(
  (n, c) => n + c.lessons.length,
  0,
);
console.log(`📚 ${course.chapters.length} chapters, ${lessonCount} lessons`);

const startedAt = Date.now();
let writeCount = 0;

for (const locale of targetLocales) {
  console.log(`\n── ${locale.toUpperCase()} (${LOCALE_ENGLISH_NAMES[locale]}) ──`);
  let translatedThisLocale = 0;

  // Course root.
  course.translations ??= {};
  course.translations[locale] ??= {};
  if (optForce || !course.translations[locale].title) {
    if (course.title) {
      course.translations[locale].title = await translateOne(course.title, locale);
    }
  }
  if (optForce || !course.translations[locale].description) {
    if (course.description) {
      course.translations[locale].description = await translateOne(
        course.description,
        locale,
      );
    }
  }

  // Walk chapters + lessons.
  for (const chapter of course.chapters) {
    chapter.translations ??= {};
    chapter.translations[locale] ??= {};
    if (optForce || !chapter.translations[locale].title) {
      if (chapter.title)
        chapter.translations[locale].title = await translateOne(
          chapter.title,
          locale,
        );
    }
    for (const lesson of chapter.lessons) {
      if (translatedThisLocale >= limit) break;
      lesson.translations ??= {};
      if (!optForce && isLessonFullyTranslated(lesson, locale)) continue;
      const tag = `${chapter.id}/${lesson.id}`;
      process.stdout.write(`  ${tag} → ${locale} ... `);
      try {
        lesson.translations[locale] = await translateLessonFields(lesson, locale);
        translatedThisLocale += 1;
        writeCount += 1;
        process.stdout.write("ok\n");
        // Persist after each lesson so a crash mid-run doesn't lose
        // already-translated work — the next invocation picks up where
        // we left off thanks to the `isLessonFullyTranslated` guard.
        if (!optDry)
          await writeFile(courseFile, JSON.stringify(course, null, 2));
      } catch (err) {
        process.stdout.write(`FAIL: ${err.message}\n`);
      }
    }
    if (translatedThisLocale >= limit) {
      console.log(`  (limit reached for ${locale})`);
      break;
    }
  }
  console.log(`  ${translatedThisLocale} lesson(s) translated for ${locale}`);
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(
  `\n✅ Done. ${writeCount} lessons translated, ${apiCallCount} API call(s), ${elapsed}s elapsed.`,
);
console.log(`   Output: ${path.relative(REPO_ROOT, courseFile)}`);

// ─── Helpers ────────────────────────────────────────────────────
function parseFlag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return argv[i + 1] || null;
}
