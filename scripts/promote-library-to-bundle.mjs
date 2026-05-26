#!/usr/bin/env node
/**
 * promote-library-to-bundle.mjs
 *
 * One-off authoring script. Takes everything currently sitting in the
 * developer's LOCAL Libre library (the macOS app_data_dir's
 * `courses/` folder) and turns it into the canonical set of
 * .libre archives we SHIP under
 * `src-tauri/resources/bundled-packs/`.
 *
 * Run order to "promote my library":
 *   1. node scripts/promote-library-to-bundle.mjs
 *   2. node scripts/reset-local-library.mjs
 *   3. (rebuild + reinstall the app — the new bundled-packs are
 *      baked into the binary so a `make build` / `make` is required)
 *
 * The script is intentionally idempotent: re-running just refreshes
 * archives whose source folders changed, with no side effects to
 * unrelated state.
 *
 * What it does:
 *   - Scans `<app_data_dir>/courses/<course-id>/` for every folder
 *     that has a course.json.
 *   - Zips each folder's contents (FLAT — files at the zip root, not
 *     wrapped in a directory) to
 *     `src-tauri/resources/bundled-packs/<course-id>.libre`.
 *     This matches the layout of the existing bundled archives the
 *     `unzip_to` extractor in courses.rs already accepts.
 *   - PRUNES: any .libre archive in bundled-packs/ that DOESN'T
 *     have a matching local course folder is deleted. The default
 *     posture is "the local library IS the bundled set"; pass
 *     --keep-extra to preserve archives that have no local source.
 *   - Prints a summary table (added / refreshed / pruned).
 *
 * What it does NOT do:
 *   - Modify the local library. It only READS the courses dir.
 *   - Wipe progress, settings, or the seeded-packs marker — that's
 *     `reset-local-library.mjs`.
 *   - Bump SEED_VERSION. That's a manual edit in `src-tauri/src/courses.rs`
 *     so the developer can choose whether existing installs should
 *     refresh on next launch.
 *
 * Implementation note: we shell out to `/usr/bin/zip` rather than
 * pulling in a Node zip library. macOS ships `zip` everywhere, the
 * deflate output is byte-compatible with what the Rust `zip` crate
 * reads, and it keeps this script dependency-free.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BUNDLE_DIR = join(REPO_ROOT, "src-tauri", "resources", "bundled-packs");

// Bundle id from `src-tauri/tauri.conf.json` → resolves the macOS
// app_data_dir. Hardcoding because Tauri also hardcodes this in the
// runtime resolver — they go together.
const BUNDLE_ID = "com.mattssoftware.libre";
const APP_DATA = join(homedir(), "Library", "Application Support", BUNDLE_ID);

// Per-profile migration (May 2026) moved courses from APP_DATA/courses
// to APP_DATA/profiles/<active>/courses. Pick the active profile out
// of profiles.json so promotion targets the current library. Fall
// back to the legacy top-level dir for pre-migration installs.
function resolveCoursesDir() {
  const profilesJson = join(APP_DATA, "profiles.json");
  const profilesRoot = join(APP_DATA, "profiles");
  if (existsSync(profilesJson) && existsSync(profilesRoot)) {
    try {
      const raw = JSON.parse(readFileSync(profilesJson, "utf8"));
      const active = raw.active ?? "default";
      const dir = join(profilesRoot, active, "courses");
      if (existsSync(dir)) return dir;
    } catch {
      // fall through to legacy
    }
  }
  return join(APP_DATA, "courses");
}
const COURSES_DIR = resolveCoursesDir();

const args = new Set(process.argv.slice(2));
const KEEP_EXTRA = args.has("--keep-extra");
const DRY_RUN = args.has("--dry-run");

function abort(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function listCourseFolders() {
  if (!existsSync(COURSES_DIR)) {
    abort(`courses dir not found: ${COURSES_DIR} — open Libre at least once first`);
  }
  return readdirSync(COURSES_DIR).filter((name) => {
    const full = join(COURSES_DIR, name);
    let s;
    try { s = statSync(full); } catch { return false; }
    if (!s.isDirectory()) return false;
    // Must contain a course.json to be a real course folder.
    return existsSync(join(full, "course.json"));
  });
}

/// Bundled-pack archive extensions. `.academy` is the canonical
/// post-rebrand extension; `.libre` is the previous name and
/// remains accepted so promote-runs over a partially-migrated
/// directory don't lose track of existing packs.
const ARCHIVE_EXTS_PROMOTE = [".academy", ".libre"];

function listBundledArchives() {
  if (!existsSync(BUNDLE_DIR)) return [];
  // Returns a Map<id, { name, ext }> so we can later rewrite the
  // archive at its existing path (or upgrade `.libre` → `.academy`
  // by writing the new path + removing the old one).
  const out = new Map();
  for (const name of readdirSync(BUNDLE_DIR)) {
    const ext = ARCHIVE_EXTS_PROMOTE.find((e) => name.endsWith(e));
    if (!ext) continue;
    const id = name.slice(0, -ext.length);
    // Prefer .academy when both extensions exist for the same id.
    if (!out.has(id) || ext === ".academy") {
      out.set(id, { name, ext });
    }
  }
  return out;
}

/**
 * Zip a course folder's CONTENTS (not the folder itself) into a flat
 * archive at dest. We `cd` into the source dir and pass `.` so the zip
 * paths are stored as `course.json`, `cover.png`, etc — no enclosing
 * directory. Matches the existing `bun-complete.libre` layout.
 *
 * `-r` recurses (only matters for any future sub-folders), `-q` keeps
 * stdout clean. `-X` strips extra fields (Spotlight, Finder colours)
 * so the archives are reproducible across machines. We delete any
 * pre-existing archive at dest first because `zip` defaults to
 * APPENDING into an existing file rather than overwriting.
 */
function zipCourseFolder(srcDir, destArchive) {
  if (DRY_RUN) return 0;
  if (existsSync(destArchive)) rmSync(destArchive);
  execFileSync(
    "/usr/bin/zip",
    ["-r", "-q", "-X", destArchive, "."],
    { cwd: srcDir, stdio: ["ignore", "ignore", "inherit"] },
  );
  return statSync(destArchive).size;
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function main() {
  console.log(`[promote] reading local library from: ${COURSES_DIR}`);
  console.log(`[promote] writing bundled archives to: ${BUNDLE_DIR}`);
  if (DRY_RUN) console.log(`[promote] DRY RUN — no files will be written`);
  if (KEEP_EXTRA) console.log(`[promote] --keep-extra — orphan archives will be preserved`);

  if (!existsSync(BUNDLE_DIR)) {
    if (!DRY_RUN) mkdirSync(BUNDLE_DIR, { recursive: true });
  }

  const localIds = listCourseFolders();
  const bundledMap = listBundledArchives();
  const bundledIds = new Set(bundledMap.keys());

  if (localIds.length === 0) {
    abort(`local library is empty — nothing to promote`);
  }

  const added = [];
  const refreshed = [];
  for (const id of localIds) {
    const src = join(COURSES_DIR, id);
    // Always WRITE under `.academy` (the canonical post-rebrand
    // extension). If a `.libre` legacy archive exists for the
    // same id, drop it after the new one lands so we don't ship
    // both extensions for the same course.
    const dest = join(BUNDLE_DIR, `${id}.academy`);
    const existing = bundledMap.get(id);
    const wasAlready = bundledIds.has(id);
    const size = zipCourseFolder(src, dest);
    if (existing && existing.ext === ".libre" && !DRY_RUN) {
      const legacyPath = join(BUNDLE_DIR, existing.name);
      if (existsSync(legacyPath)) rmSync(legacyPath);
    }
    (wasAlready ? refreshed : added).push({ id, size });
  }

  const localSet = new Set(localIds);
  const orphans = [...bundledIds].filter((id) => !localSet.has(id));
  const pruned = [];
  if (!KEEP_EXTRA) {
    for (const id of orphans) {
      const existing = bundledMap.get(id);
      if (!existing) continue;
      const path = join(BUNDLE_DIR, existing.name);
      if (!DRY_RUN) rmSync(path);
      pruned.push(id);
    }
  }

  console.log("");
  console.log(`Added (${added.length}):`);
  for (const { id, size } of added) {
    console.log(`  + ${id} ${DRY_RUN ? "" : `(${fmtBytes(size)})`}`);
  }
  console.log("");
  console.log(`Refreshed (${refreshed.length}):`);
  for (const { id, size } of refreshed) {
    console.log(`  ~ ${id} ${DRY_RUN ? "" : `(${fmtBytes(size)})`}`);
  }
  console.log("");
  if (KEEP_EXTRA) {
    console.log(`Orphans (kept, ${orphans.length}):`);
    for (const id of orphans) console.log(`  ? ${id}`);
  } else {
    console.log(`Pruned (${pruned.length}):`);
    for (const id of pruned) console.log(`  - ${id}`);
  }
  console.log("");
  console.log(`Bundled-packs now reflects ${localIds.length} local courses.`);
  if (!DRY_RUN) {
    console.log(`Next step:`);
    console.log(`  node scripts/reset-local-library.mjs`);
    console.log(`  make                 # rebuild + sign + notarize + install`);
  }
}

main();
