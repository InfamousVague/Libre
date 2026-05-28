#!/usr/bin/env node
/// Extract a curated subset of the bundled .libre packs into
/// `public/starter-courses/` so the web build can fetch them at
/// first-launch and seed IndexedDB.
///
/// We only ship packs whose primary language has a browser-native
/// runtime — anything that needs a system compiler (C / C++ / Java /
/// Kotlin / C# / Assembly / Swift) gets skipped because the web
/// build can't run those lessons anyway. SvelteKit is also skipped
/// (Node sidecar required); plain Svelte 5 CSR works in-browser via
/// the vendored compiler.
///
/// Output:
///   public/starter-courses/manifest.json   — list of {id,title,language,file,size}
///   public/starter-courses/<id>.json       — the full course JSON
///
/// Idempotent: deletes + recreates the directory each run so a pack
/// removed from PACK_IDS doesn't ghost in production. Run once before
/// `vite build` for the web variant; chained automatically by
/// `npm run vendor:web`.

import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  ALL_PACK_IDS,
  tierFor,
  releaseStatusFor,
  isHiddenPack,
  REMOTE_ARCHIVE_BASE,
} from "./course-tiers.mjs";

/// Cover-resize helper. The bundled covers are ~3-4MB unoptimised
/// PNGs (extracted as cover images by the desktop app's
/// `load_course_cover` Tauri command). Shipping 24 of those on a
/// static deploy = ~85MB blob just for thumbnails — wasteful.
///
/// We resize each cover to 480px wide JPEG, quality 78. Result:
/// ~30-70KB per cover, total ~1-1.5MB for the 24-course starter
/// set. Quality is more than enough for the BookCover component
/// which renders at ~150-200px in the library grid.
///
/// Cross-platform tool detection: macOS has `sips` built in,
/// Ubuntu CI runners have `magick` (ImageMagick 7) and/or
/// `convert` (ImageMagick legacy). We try in that order and
/// skip cover output if none are available.
let cachedResizeImpl = null;
function pickResizeImpl() {
  if (cachedResizeImpl !== null) return cachedResizeImpl;
  for (const probe of [
    { cmd: "magick", args: ["-version"] },
    { cmd: "convert", args: ["-version"] },
    { cmd: "sips", args: ["--help"] },
  ]) {
    try {
      execFileSync(probe.cmd, probe.args, { stdio: "ignore" });
      cachedResizeImpl = probe.cmd;
      return probe.cmd;
    } catch {
      // Not installed — try next.
    }
  }
  cachedResizeImpl = "";
  return "";
}

/// Per-language gradient palette for the synthetic-cover fallback.
/// Mirrors `.libre-book--lang-*--no-cover` in BookCover.css so a
/// generated JPEG looks visually consistent with the in-app
/// language-tinted tiles. Tuple shape: `[topColor, bottomColor]`.
/// Languages not in this map fall back to a neutral dark gradient.
const LANG_GRADIENTS = {
  javascript: ["#4e432a", "#262013"],
  typescript: ["#3178c6", "#1a3d6e"],
  python: ["#1f3b5a", "#101d2d"],
  rust: ["#6b2f1e", "#2d140c"],
  swift: ["#6b2b2b", "#2d1212"],
  go: ["#204f5e", "#0e2630"],
  bun: ["#3d3520", "#1d180c"],
  svelte: ["#5c2a16", "#2a120a"],
  solid: ["#1c4d6b", "#0e2535"],
  htmx: ["#3a4252", "#1a1f29"],
  astro: ["#3a2a4d", "#1a0f26"],
  solidity: ["#3a3a3a", "#1a1a1a"],
  reactnative: ["#1c4357", "#0e2330"],
  react: ["#1c4357", "#0e2330"],
  threejs: ["#2d2d2d", "#0c0c0c"],
  // 2026 expansion — gradients tuned to each language's brand
  // colour but flattened toward darker mid-tones so the cover
  // text stays readable.
  ruby: ["#5c1818", "#2a0a0a"],
  lua: ["#1a1a4e", "#0a0a26"],
  dart: ["#1a4d6b", "#0a2535"],
  haskell: ["#3a2c52", "#1a1428"],
  scala: ["#5c1a1a", "#2a0a0a"],
  sql: ["#1f3a52", "#0e1d29"],
  elixir: ["#3a2a4d", "#1a0f26"],
  zig: ["#5c3a0e", "#2b1c08"],
  move: ["#283044", "#10141d"],
  cairo: ["#5c3a1a", "#2a1a0a"],
  sway: ["#1f4d3a", "#0e261d"],
};

const LANG_GLYPHS = {
  javascript: "JS",
  typescript: "TS",
  python: "PY",
  rust: "RS",
  swift: "SW",
  go: "GO",
  bun: "BN",
  svelte: "SV",
  solid: "SO",
  htmx: "HX",
  astro: "AS",
  solidity: "SL",
  reactnative: "RN",
  react: "RX",
  threejs: "3D",
  c: "C",
  cpp: "C++",
  java: "JV",
  kotlin: "KT",
  csharp: "C#",
  assembly: "ASM",
  // 2026 expansion. Glyphs are 2-3 chars max so they fit the
  // 320×480 cover synthesis without wrapping.
  ruby: "RB",
  lua: "LU",
  dart: "DT",
  haskell: "HS",
  scala: "SC",
  sql: "SQL",
  elixir: "EX",
  zig: "ZG",
  move: "MV",
  cairo: "CR",
  sway: "SW",
};

/// Find a usable .ttf font path. ImageMagick on macOS can't load
/// the system .ttc font collections by name; on Ubuntu it relies on
/// fontconfig which may or may not be set up. Plain .ttf files
/// always work, so we probe the standard locations and use the
/// first one that exists. Returns null when nothing's available
/// (caller skips synthesis in that case).
let cachedFontPath = null;
function pickFontPath() {
  if (cachedFontPath !== null) return cachedFontPath || null;
  const candidates = [
    // macOS — SFNS is always present, ships with every install.
    "/System/Library/Fonts/SFNS.ttf",
    // Ubuntu / Debian — DejaVu is the apt-get default; Liberation
    // ships with most server images via `fonts-liberation`.
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    // Fallback: Noto, often pulled in as a dependency.
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      cachedFontPath = path;
      return path;
    }
  }
  cachedFontPath = "";
  return null;
}

/// Synthesise a themed JPEG cover for a pack that doesn't ship its
/// own cover.png. Renders a 320×480 (book-ratio) gradient using the
/// language palette, with the language abbreviation big in the
/// upper third and the course title wrapped below. Visual goal:
/// consistent with the in-app `.libre-book--no-cover` fallback
/// so the library shelf reads as one continuous design language —
/// real cover artwork blends with synthetic tiles without an
/// obvious style break.
///
/// Only ImageMagick supports the gradient + caption: composition we
/// need; sips can't do it. So this only fires when magick / convert
/// is available AND we can find a usable .ttf for the text — falls
/// back to no cover otherwise.
function synthesizeCover(language, title, dstJpg) {
  const impl = pickResizeImpl();
  if (impl !== "magick" && impl !== "convert") return false;
  const fontPath = pickFontPath();
  if (!fontPath) return false;
  const [top, bottom] = LANG_GRADIENTS[language] ?? ["#2a2a2a", "#0c0c0c"];
  const glyph = LANG_GLYPHS[language] ?? "·";
  // Trim the title to fit a 2-3 line caption block. ImageMagick's
  // caption: pseudo-image auto-wraps to fit a fixed width, but
  // long titles can overflow vertically; cap at ~60 chars.
  const trimmed = title.length > 60 ? title.slice(0, 57) + "…" : title;
  try {
    execFileSync(impl, [
      "-size", "320x480",
      // Top-bottom gradient with the language palette.
      `gradient:${top}-${bottom}`,
      // Glyph — big, upper third, soft white.
      "-gravity", "north",
      "-fill", "rgba(255,255,255,0.92)",
      "-font", fontPath,
      "-pointsize", "120",
      "-annotate", "+0+90", glyph,
      // Subtitle — language name in the gutter under the glyph.
      "-pointsize", "16",
      "-fill", "rgba(255,255,255,0.6)",
      "-annotate", "+0+230", language.toUpperCase(),
      // Title — wraps inside a 280×140 caption: pseudo-image, then
      // composites onto the gradient at the lower section. Using
      // caption: instead of -annotate gets us word wrapping for free.
      "(", "-size", "280x140",
      "-gravity", "center",
      "-fill", "white",
      "-font", fontPath,
      "-pointsize", "22",
      `caption:${trimmed}`, ")",
      "-gravity", "south",
      "-geometry", "+0+40",
      "-composite",
      // Drop EXIF + interlace + quality to match the resize step.
      "-strip",
      "-interlace", "Plane",
      "-quality", "82",
      dstJpg,
    ], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function resizeCover(srcPng, dstJpg) {
  const impl = pickResizeImpl();
  if (!impl) return false;
  try {
    if (impl === "magick" || impl === "convert") {
      // ImageMagick — same args for both the `magick` (v7) and
      // `convert` (legacy) commands. `-resize 288x>` only shrinks
      // (the `>` qualifier means "resize only if larger");
      // `-strip` drops EXIF; `-sampling-factor 4:2:0` enables
      // chroma-subsampling for ~15% smaller files at no
      // perceptible quality loss for cover art.
      //
      // Sizing rationale (2026-05-10 tighten): Discover grid cards
      // render at ~150px wide (re-measured against the live shelf
      // — earlier "260px" estimate was for the old wide layout
      // before the 11-column dense grid landed). At 150px display,
      // 288px source = 1.92× — perfect retina without paying for
      // bytes the viewer can't perceive. Quality dropped 72 → 68
      // because the new GPT-Image-2 masters are 1344x2016 (vs the
      // earlier 720x1080 set), so the downscale has 4× the source
      // detail to average from — q68 from a 1344x source looks
      // visibly cleaner than q72 from a 720x source did.
      // Net effect: ~40% smaller files at equal-or-better visual
      // quality on the shelf.
      execFileSync(impl, [
        srcPng,
        "-resize", "288x>",
        "-strip",
        "-sampling-factor", "4:2:0",
        "-quality", "68",
        dstJpg,
      ], { stdio: "ignore" });
    } else if (impl === "sips") {
      // macOS sips: -Z is "resize-only-if-larger". sips doesn't
      // expose chroma-subsampling controls — accept the slightly
      // larger output (still well under the old 360px size).
      execFileSync(impl, [
        "-Z", "288",
        "-s", "format", "jpeg",
        "-s", "formatOptions", "68",
        srcPng,
        "--out", dstJpg,
      ], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

let warnedNoResizer = false;
function warnIfNoResizer() {
  if (warnedNoResizer) return;
  if (pickResizeImpl()) return;
  warnedNoResizer = true;
  console.warn(
    "[starter-courses] no image resizer found (tried `magick`, " +
      "`convert`, `sips`). Cover art will be SKIPPED on this run — " +
      "install imagemagick for production builds.",
  );
}
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PACKS_DIR = join(ROOT, "src-tauri", "resources", "bundled-packs");
const OUT = join(ROOT, "public", "starter-courses");
/// Manual cover overrides. A PNG at `cover-overrides/<pack-id>.png`
/// wins over both the in-zip `cover.png` AND the language-tinted
/// synthesiser. This is how we ship freshly-generated artwork for
/// packs whose .libre zip predates the cover (we don't want to
/// re-zip every time a designer re-runs the cover gen). Drop the
/// PNG in, run `node scripts/extract-starter-courses.mjs`, commit
/// both the override PNG and the resulting JPEG. The override path
/// also lets a stale or off-style in-zip cover be quietly replaced
/// without touching the source pack.
const COVER_OVERRIDES = join(ROOT, "cover-overrides");

/// Course-archive extensions in priority order. `.academy` is the
/// canonical extension after the rebrand; `.libre` is the
/// previous name and remains accepted so packs that haven't been
/// renamed on disk still work. The first match for `${id}.<ext>`
/// wins. Mirrors `ARCHIVE_EXTS` in `src-tauri/src/courses.rs`.
const ARCHIVE_EXTS = ["academy", "libre", "kata"];

/// Resolve the on-disk archive path for a pack id. Returns the first
/// `${id}.<ext>` that exists, or null if nothing matches. Lets the
/// build script straddle the renaming window — packs that have been
/// migrated to `.academy` resolve, the ones still on `.libre` do
/// too.
function findPackArchive(packsDir, id) {
  for (const ext of ARCHIVE_EXTS) {
    const candidate = join(packsDir, `${id}.${ext}`);
    if (existsSync(candidate)) {
      return { path: candidate, ext };
    }
  }
  return null;
}

/// Curated browser-compatible starter set. IDs match the archive
/// filenames (without the extension). Order here is the order the
/// library renders them in on first launch.
///
/// Curation rules for what makes the cut:
///   - Primary language is browser-runnable (per platform.ts canRun)
///     — JS, TS, Python, web, three.js, React, RN, Svelte, Solid,
///     HTMX, Astro, Bun, Tauri-as-Rust, Solidity. Rust + Go are
///     also OK because their runtimes proxy to the public playgrounds
///     over HTTP.
///   - Excluded: anything needing a system compiler (C, C++, Java,
///     Kotlin, C#, Assembly, Swift, SvelteKit's Node sidecar). Those
///     stay desktop-only.
// (Legacy PACK_IDS kept inline below for back-compat — the live
// extract loop now reads from `ALL_PACK_IDS` in
// `scripts/course-tiers.mjs` so the catalog + the desktop bundle
// + the web build all share one source of truth. This array is
// reachable as `LEGACY_PACK_IDS` only and isn't used by main().)
const LEGACY_PACK_IDS = [
  // ── Languages-as-a-foundation books ────────────────────────────
  // Long-form books that teach a language end-to-end. Order here is
  // the order the library renders them on first launch.
  "the-rust-programming-language",
  "rust-by-example",
  "the-async-book-rust",
  "the-rustonomicon",
  "eloquent-javascript",
  "the-modern-javascript-tutorial-fundamentals",
  "javascript-the-definitive-guide",
  "you-don-t-know-js-yet",
  "composing-programs",
  "python-crash-course",
  "learning-go",

  // ── Computer-science fundamentals ──────────────────────────────
  "algorithms-erickson",
  "open-data-structures",
  "crafting-interpreters-javascript",
  "pro-git",

  // ── Frameworks + libraries ─────────────────────────────────────
  "learning-svelte",
  "solidjs-fundamentals",
  "htmx-fundamentals",
  "astro-fundamentals",
  "react-native",
  "learning-react-native",
  "fluent-react",
  "tauri-2-fundamentals",
  "interactive-web-development-with-three-js-and-a-frame",

  // ── Smart-contract / web3 / crypto ─────────────────────────────
  "mastering-bitcoin",
  "programming-bitcoin",
  "mastering-ethereum",
  "mastering-lightning-network",
  "vyper-fundamentals-pythonic-smart-contracts",
  "solana-programs-rust-on-the-svm",
  "viem-and-ethers-js-talking-to-ethereum-from-typescript",
  "cryptography-fundamentals-hashes-to-zk",

  // ── Challenge packs ───────────────────────────────────────────
  // One per browser-runnable language. Assembly / C / C++ / C# /
  // Java / Kotlin / Swift live in the desktop bundle but stay out
  // of the web set because their runtimes need a system compiler.
  "javascript-challenges",
  "typescript-challenge-pack",
  "python-challenges",
  "go-challenges",
  "rust-challenges",
  "react-native-challenges",
];

async function main() {
  if (!existsSync(PACKS_DIR)) {
    console.error(
      `[starter-courses] expected packs dir at ${PACKS_DIR} — is the kata repo intact?`,
    );
    process.exit(1);
  }

  // Fresh slate each run — but preserve sidecar courses that the
  // extract pipeline doesn't manage (HelloTrade is a python-generated
  // JSON + a hand-resized cover, committed to git via a `.gitignore`
  // negation rule). A blanket `rm -rf` would wipe them out before
  // the marketing site's CI build copied `public/` into the deploy
  // tree, leaving the live URL `/fishbones/learn/?courseId=hellotrade`
  // 404'ing on the on-demand fetch.
  //
  // Strategy: walk the dir, delete only files matching `<id>.json` /
  // `<id>.jpg` for ids in PACK_IDS_TO_EMIT plus `manifest.json`.
  // Anything else (e.g. hellotrade.json, hellotrade.jpg) survives
  // untouched. (Pre-dir-scan refactor this used ALL_PACK_IDS only;
  // now it covers both the classified set AND every .academy on
  // disk so dynamically-discovered packs get their stale outputs
  // cleaned up too.)
  const { readdir } = await import("node:fs/promises");

  // Build the canonical id list: union of explicitly-classified
  // ALL_PACK_IDS + every .academy/.libre/.kata archive present in
  // PACKS_DIR. Pre-refactor the extract loop only emitted packs in
  // ALL_PACK_IDS, which meant new packs (rustlings, ziglings, every
  // exercism track, every koan, etc.) shipped to bundled-packs but
  // silently vanished from the manifest until someone hand-added
  // them to course-tiers.mjs. Scanning the dir means a new .academy
  // just works — it lands in the manifest as tier="remote" /
  // releaseStatus="UNREVIEWED" via the helpers' defaults.
  const diskIds = (await readdir(PACKS_DIR))
    .map((name) => {
      for (const ext of ARCHIVE_EXTS) {
        if (name.endsWith("." + ext)) return name.slice(0, -(ext.length + 1));
      }
      return null;
    })
    .filter((id) => id !== null);
  const PACK_IDS_TO_EMIT = Array.from(new Set([...ALL_PACK_IDS, ...diskIds]));

  if (existsSync(OUT)) {
    const managed = new Set(["manifest.json"]);
    for (const id of PACK_IDS_TO_EMIT) {
      managed.add(`${id}.json`);
      managed.add(`${id}.jpg`);
    }
    for (const entry of await readdir(OUT)) {
      if (managed.has(entry)) {
        await rm(join(OUT, entry), { force: true });
      }
    }
  }
  await mkdir(OUT, { recursive: true });

  // Surface the missing-resizer warning ONCE up-front rather than
  // burying it in `+ cover.png` absences across 22 lines.
  warnIfNoResizer();

  // Reference the legacy list once so the linter doesn't strip the
  // declaration we kept around for documentation. The live loop
  // pulls from PACK_IDS_TO_EMIT (classified ∪ disk-discovered).
  void LEGACY_PACK_IDS;
  const manifest = [];
  for (const id of PACK_IDS_TO_EMIT) {
    const found = findPackArchive(PACKS_DIR, id);
    if (!found) {
      console.warn(
        `[starter-courses] missing pack: ${join(PACKS_DIR, id)}.{${ARCHIVE_EXTS.join("|")}}, skipping`,
      );
      continue;
    }
    const { path: packPath, ext: packExt } = found;
    // Capture the archive size BEFORE extraction so the catalog can
    // show learners "X MB to download" on the placeholder tile.
    // Cheap stat — both desktop + web manifests get this.
    const archiveStat = await stat(packPath);

    // The archive (whatever extension it carries) is a zip — use the
    // system `unzip` (BSD on macOS, InfoZIP on Linux; both ship by
    // default on the GitHub Actions ubuntu image). Avoids pulling in
    // a JS zip library just for five files at build time.
    const work = await mkdtemp(join(tmpdir(), "fb-starter-"));
    try {
      execFileSync("unzip", ["-q", packPath, "-d", work], { stdio: "pipe" });
      const courseJsonPath = join(work, "course.json");
      if (!existsSync(courseJsonPath)) {
        console.warn(
          `[starter-courses] no course.json inside ${id}.${packExt}, skipping`,
        );
        continue;
      }
      const courseJson = await readFile(courseJsonPath, "utf-8");
      const course = JSON.parse(courseJson);

      const outFile = join(OUT, `${id}.json`);
      await writeFile(outFile, courseJson, "utf-8");
      const info = await stat(outFile);

      // Cover art — four-tier lookup, first match wins:
      //   1. cover-overrides/<pack-id>.png — manual designer drop-in.
      //      Lets us replace stale or missing in-zip covers without
      //      re-zipping the .libre (which often invalidates the
      //      pack's checksum on disk). Also accepts cover-overrides/
      //      <course-id>.png for callers who keep overrides keyed
      //      to the in-zip course id rather than the pack filename.
      //   2. cover.jpg inside the .libre zip — the modern
      //      optimised form (480×720 q85, ~50-100 KB) produced by
      //      `optimize-covers.mjs` and the Rust ingest pipeline.
      //   3. cover.png inside the .libre zip — the legacy form
      //      for archives that haven't been migrated yet.
      //   4. synthesiseCover() — language-tinted gradient + caption.
      //      Last-resort so the library shelf still reads as a
      //      continuous design rather than a mix of real covers +
      //      missing-image squares.
      // All four converge on the same 480px JPEG q78 output so
      // downstream consumers (web manifest, kata library shelf) don't
      // care which path produced it.
      //
      // The cover JPEG is written under BOTH the in-zip course id AND
      // the pack filename slug. The kata web build's `useCourseCover`
      // hook resolves to `/starter-courses/<courseId>.jpg` (it only
      // knows the in-zip id at runtime), while the marketing site's
      // catalog reads the manifest's `cover` field directly. Without
      // the duplicate, packs whose course.id differs from the pack
      // filename (e.g. `rust-async-book` vs `the-async-book-rust`)
      // 404 in the embedded /learn/ shelf and fall back to the
      // language-tinted glyph tile.
      const courseId = course.id || id;
      // Accept both .png and .jpg masters. .png stays the historical
      // default (lossless), but .jpg overrides are way smaller for
      // photographic art (the GPT-Image-2 ribbon covers compress at
      // q88/720px to ~70KB vs ~650KB as PNGs). Both feed `resizeCover`
      // identically since ImageMagick / sips don't care about input
      // format. `.jpg` wins over `.png` when both are present so a
      // designer can drop a leaner replacement in without having to
      // delete the old PNG first.
      const overrideCandidates = [
        join(COVER_OVERRIDES, `${id}.jpg`),
        join(COVER_OVERRIDES, `${courseId}.jpg`),
        join(COVER_OVERRIDES, `${id}.png`),
        join(COVER_OVERRIDES, `${courseId}.png`),
      ];
      const overridePath = overrideCandidates.find((p) => existsSync(p)) ?? null;
      const inZipJpgPath = join(work, "cover.jpg");
      const inZipPngPath = join(work, "cover.png");
      // Manifest references the pack-id JPEG so existing tooling
      // (catalog grid, library shelf desktop) keeps resolving. The
      // course-id copy is the duplicate written below.
      const candidate = `${id}.jpg`;
      const dst = join(OUT, candidate);
      let coverFile;
      let coverSource;
      if (overridePath && resizeCover(overridePath, dst)) {
        coverFile = candidate;
        coverSource = "override";
      } else if (existsSync(inZipJpgPath) && resizeCover(inZipJpgPath, dst)) {
        coverFile = candidate;
        coverSource = "pack-jpg";
      } else if (existsSync(inZipPngPath) && resizeCover(inZipPngPath, dst)) {
        coverFile = candidate;
        coverSource = "pack-png";
      } else if (synthesizeCover(course.language || "javascript", course.title || id, dst)) {
        coverFile = candidate;
        coverSource = "synth";
        console.log(
          `  ↳ synthesised themed cover for ${id} (${course.language})`,
        );
      }
      // Mirror the JPEG under the in-zip course id so the kata web
      // build's `useCourseCover` hook (which keys on courseId, not
      // pack filename) finds the file. Cheap copyFile when the names
      // already match — and a no-op when nothing was written.
      if (coverFile && courseId !== id) {
        const courseDst = join(OUT, `${courseId}.jpg`);
        try {
          await copyFile(dst, courseDst);
        } catch (err) {
          console.warn(
            `[starter-courses] failed to mirror cover ${dst} → ${courseDst}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      // Normalise the editorial tier into the manifest so the
      // marketing site (libre.academy) can group cards by tier
      // without having to fetch each course's full JSON. Legacy
      // `PRE-RELEASE` collapses to `UNREVIEWED` to match the renamed
      // pipeline. Anything missing or unrecognised falls back to
      // `UNREVIEWED` so books default into the bottom section.
      // Editorial tier — first the per-pack override (see
      // `RELEASE_STATUS_OVERRIDES` in course-tiers.mjs) so we can
      // bump a book without repacking its archive, then the in-zip
      // value, then UNREVIEWED as the floor.
      const releaseStatus = releaseStatusFor(id, course.releaseStatus);

      // Quick walk to count visible lessons — useful on the
      // placeholder tile so users know how big a course they're
      // about to install. Don't include drill kinds (puzzle / cloze
      // / micropuzzle) since those are auto-derived and aren't
      // user-visible on desktop.
      let lessonCount = 0;
      for (const ch of course.chapters ?? []) {
        for (const l of ch.lessons ?? []) {
          if (
            l.kind === "exercise" ||
            l.kind === "mixed" ||
            l.kind === "reading" ||
            l.kind === "quiz"
          ) {
            lessonCount++;
          }
        }
      }
      manifest.push({
        id: course.id || id,
        // The pack filename — needed by the desktop downloader to
        // build the archive URL when the in-zip course id differs
        // from the pack slug (rare but happens).
        packId: id,
        title: course.title || id,
        author: course.author,
        language: course.language,
        file: `${id}.json`,
        cover: coverFile,
        sizeBytes: info.size,
        // Size of the .libre zip — used by the desktop
        // downloader's progress UI + by the placeholder tile to show
        // "Y MB" on hover.
        archiveSizeBytes: archiveStat.size,
        // Where the desktop downloader fetches the archive from
        // when the user clicks Install on a remote placeholder.
        // Tracks whichever extension the source bundled-pack
        // actually carries (`.academy` post-rebrand, `.libre`
        // for packs that haven't been migrated yet) so the URL
        // matches what the user will upload to
        // mattssoftware.com/fishbones/courses/. Web build ignores
        // this — it fetches the per-course JSON from `file`
        // (same-origin) instead.
        archiveUrl: `${REMOTE_ARCHIVE_BASE.replace(/\/$/, "")}/${id}.${packExt}`,
        packType: course.packType || "course",
        releaseStatus,
        // Whether this pack is bundled with the app (extracted on
        // first launch + always present) or a remote download
        // (rendered as a placeholder until the user clicks Install).
        // The single source of truth lives in
        // `scripts/course-tiers.mjs`.
        tier: tierFor(id),
        // Hidden packs (see HIDDEN_PACK_IDS in course-tiers.mjs) are
        // installable + reachable via a direct lesson URL but never
        // listed in the Library or Discover grids. Used for partner /
        // preview content we want shippable but not surfaced. Field
        // is OMITTED for non-hidden packs so the manifest stays
        // compact and only carries the flag where it matters.
        ...(isHiddenPack(id) ? { hidden: true } : {}),
        lessonCount,
      });
      console.log(
        `[starter-courses] staged ${id} (${(info.size / 1024).toFixed(0)} KB)` +
          (coverFile ? ` + cover [${coverSource}]` : ""),
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  // ── Placeholder-cover sweep ───────────────────────────────────
  // Walk `cover-overrides/` and emit `<id>.jpg` for any cover whose
  // matching id ISN'T already in the manifest. These are the next-up
  // books we have artwork for but no `.libre` archive yet — the
  // desktop catalog merges these in via remoteCatalogFallback so
  // they appear as install-able placeholders in Discover. Without
  // this sweep, the placeholder tiles fall back to the language-
  // tinted glyph (no covers anywhere on disk for the desktop IPC
  // to find, no JPEGs deployed for the web build to fetch).
  //
  // The sweep doesn't write manifest entries for these — the
  // remoteCatalogFallback list provides the metadata at runtime
  // instead. We only need the JPEG bytes on the deployed CDN so
  // useCourseCover's HTTPS fallback resolves.
  const writtenIds = new Set(manifest.map((m) => m.id));
  let placeholderCovers = 0;
  if (existsSync(COVER_OVERRIDES)) {
    const { readdir: readDir } = await import("node:fs/promises");
    for (const entry of await readDir(COVER_OVERRIDES)) {
      const dot = entry.lastIndexOf(".");
      if (dot < 0) continue;
      const stem = entry.slice(0, dot);
      const ext = entry.slice(dot + 1).toLowerCase();
      if (ext !== "jpg" && ext !== "png") continue;
      if (writtenIds.has(stem)) continue;
      const src = join(COVER_OVERRIDES, entry);
      const dst = join(OUT, `${stem}.jpg`);
      if (resizeCover(src, dst)) {
        placeholderCovers += 1;
      }
    }
  }

  await writeFile(
    join(OUT, "manifest.json"),
    JSON.stringify(
      {
        version: 2,
        generatedAt: new Date().toISOString(),
        archiveBaseUrl: REMOTE_ARCHIVE_BASE,
        courses: manifest,
      },
      null,
      2,
    ),
    "utf-8",
  );
  const coreCount = manifest.filter((m) => m.tier === "core").length;
  const remoteCount = manifest.filter((m) => m.tier === "remote").length;
  console.log(
    `[starter-courses] wrote manifest with ${manifest.length} courses (${coreCount} core, ${remoteCount} remote)` +
      (placeholderCovers > 0
        ? ` + ${placeholderCovers} placeholder cover JPG${placeholderCovers === 1 ? "" : "s"}`
        : ""),
  );
}

main().catch((err) => {
  console.error("[starter-courses] failed:", err);
  process.exit(1);
});
