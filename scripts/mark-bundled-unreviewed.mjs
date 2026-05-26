#!/usr/bin/env node
/**
 * mark-bundled-unreviewed.mjs
 *
 * (Renamed from `mark-bundled-prerelease.mjs` after the editorial-
 * tier rename: `PRE-RELEASE` → `UNREVIEWED` for the bottom-of-
 * library tier. The script also serves as the migration — re-running
 * it overwrites any lingering legacy `"PRE-RELEASE"` value with the
 * new `"UNREVIEWED"`.)
 *
 * Sets `releaseStatus: "UNREVIEWED"` on every shipped book.
 *
 * Targets, in order:
 *   1. Every `.libre` archive in `src-tauri/resources/bundled-packs/`
 *      (the canonical "shipped" set baked into the binary).
 *   2. Every local course folder under
 *      `<app_data>/courses/<id>/course.json` (so a future
 *      promote-library-to-bundle re-zip doesn't overwrite the
 *      marking on the bundled side).
 *
 * Pass `--bundled-only` to skip the local library, or
 * `--local-only` to skip bundled archives. `--dry-run` shows what
 * would change without writing.
 *
 * The marker is the typed `releaseStatus` field on `Course` (see
 * `src/data/types.ts`). Possible values: UNREVIEWED | ALPHA | BETA;
 * we always write "UNREVIEWED" since the user-visible tagging is
 * "drafts that aren't editorially blessed yet". Re-running the
 * script is a safe no-op for any book already marked UNREVIEWED.
 *
 * Implementation:
 *   - For bundled archives: unzip into a tmp dir, edit course.json,
 *     re-zip the contents (FLAT, files at root) over the original.
 *     Same `/usr/bin/zip` pattern as promote-library-to-bundle.mjs.
 *   - For local courses: just edit course.json in place.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BUNDLE_DIR = join(REPO_ROOT, "src-tauri", "resources", "bundled-packs");

const BUNDLE_ID = "com.mattssoftware.libre";
const APP_DATA = join(homedir(), "Library", "Application Support", BUNDLE_ID);
const COURSES_DIR = join(APP_DATA, "courses");

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const BUNDLED_ONLY = args.has("--bundled-only");
const LOCAL_ONLY = args.has("--local-only");
const TARGET_STATUS = "UNREVIEWED";

/**
 * Decide what (if anything) to write to `json.releaseStatus`.
 *
 *   - unset                  → set to UNREVIEWED (new imports default
 *                              to bottom of library)
 *   - "PRE-RELEASE" (legacy) → migrate to UNREVIEWED (rename
 *                              completed; script doubles as the
 *                              one-time migration)
 *   - "UNREVIEWED"           → no-op (already correct)
 *   - "ALPHA" / "BETA"       → SKIP (don't downgrade promoted books;
 *                              caller must use set-release-statuses.mjs
 *                              to demote on purpose)
 *
 * The skip behaviour is the key change vs. the old "set everyone to
 * PRE-RELEASE" hammer — running this script post-promotion is now
 * safe even after individual books have been promoted to ALPHA/BETA.
 */
function applyMarker(json) {
  const before = json.releaseStatus;
  if (before === "ALPHA" || before === "BETA") {
    return { changed: false, before, skipped: "promoted" };
  }
  if (before === TARGET_STATUS) {
    return { changed: false, before };
  }
  json.releaseStatus = TARGET_STATUS;
  return { changed: true, before };
}

// ────────── Bundled (.academy / .libre) ──────────

function listBundledArchives() {
  if (!existsSync(BUNDLE_DIR)) return [];
  return readdirSync(BUNDLE_DIR)
    .filter((n) => n.endsWith(".academy") || n.endsWith(".libre"))
    .map((n) => join(BUNDLE_DIR, n));
}

/**
 * Unzip the archive into a tmp dir, edit course.json, re-zip the
 * tmp contents flat over the original. We extract to a tmp dir
 * rather than streaming-rewrite because the existing `unzip_to`
 * Rust helper accepts both flat and folder-wrapped layouts; doing
 * an extract+rezip normalises everything to the flat layout the
 * existing bundled archives use.
 */
function markBundled(path) {
  const tmp = mkdtempSync(join(tmpdir(), "libre-mark-"));
  try {
    execFileSync("/usr/bin/unzip", ["-q", path, "-d", tmp], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    const courseJsonPath = join(tmp, "course.json");
    if (!existsSync(courseJsonPath)) {
      // Some archives might wrap content in a top-level dir. We
      // intentionally don't handle that case here — every archive
      // in our repo is flat post-promote-library-to-bundle.
      throw new Error(`no course.json at root of ${path}`);
    }
    const json = JSON.parse(readFileSync(courseJsonPath, "utf8"));
    const result = applyMarker(json);
    if (result.skipped === "promoted") {
      return { id: json.id, status: "promoted", target: result.before };
    }
    if (!result.changed) return { id: json.id, status: "already" };
    const { before } = result;
    if (DRY_RUN) return { id: json.id, status: "would-mark", from: before };
    writeFileSync(courseJsonPath, JSON.stringify(json, null, 2) + "\n");
    // Re-zip flat — match the `bun-complete.libre`-style layout
    // the existing extractor expects (course.json + cover.png at root).
    rmSync(path);
    execFileSync("/usr/bin/zip", ["-r", "-q", "-X", path, "."], {
      cwd: tmp,
      stdio: ["ignore", "ignore", "inherit"],
    });
    return { id: json.id, status: "marked", from: before };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ────────── Local library ──────────

function listLocalCourseJson() {
  if (!existsSync(COURSES_DIR)) return [];
  return readdirSync(COURSES_DIR)
    .map((id) => join(COURSES_DIR, id, "course.json"))
    .filter((p) => {
      try { return statSync(p).isFile(); } catch { return false; }
    });
}

function markLocal(path) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  const result = applyMarker(json);
  if (result.skipped === "promoted") {
    return { id: json.id, status: "promoted", target: result.before };
  }
  if (!result.changed) return { id: json.id, status: "already" };
  const { before } = result;
  if (DRY_RUN) return { id: json.id, status: "would-mark", from: before };
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  return { id: json.id, status: "marked", from: before };
}

// ────────── Main ──────────

function summarize(results, label) {
  const marked = results.filter((r) => r.status === "marked");
  const wouldMark = results.filter((r) => r.status === "would-mark");
  const already = results.filter((r) => r.status === "already");
  const promoted = results.filter((r) => r.status === "promoted");
  const errors = results.filter((r) => r.error);

  console.log(`\n${label}`);
  console.log("─".repeat(label.length));
  if (marked.length) {
    console.log(`Marked UNREVIEWED (${marked.length}):`);
    for (const r of marked) console.log(`  ✓ ${r.id} (was ${r.from ?? "unset"})`);
  }
  if (wouldMark.length) {
    console.log(`Would mark (${wouldMark.length}):`);
    for (const r of wouldMark) console.log(`  ~ ${r.id} (was ${r.from ?? "unset"})`);
  }
  if (promoted.length) {
    console.log(`Skipped — already promoted (${promoted.length}):`);
    for (const r of promoted) console.log(`  · ${r.id} (${r.target})`);
  }
  if (already.length) {
    console.log(`Already UNREVIEWED (${already.length}):`);
    for (const r of already) console.log(`  · ${r.id}`);
  }
  if (errors.length) {
    console.log(`Errors (${errors.length}):`);
    for (const r of errors) console.log(`  ! ${r.path}: ${r.error}`);
  }
}

function main() {
  if (DRY_RUN) console.log("DRY RUN — no files will be modified");

  if (!LOCAL_ONLY) {
    console.log(`[bundled] scanning ${BUNDLE_DIR}`);
    const archives = listBundledArchives();
    const results = archives.map((path) => {
      try {
        return markBundled(path);
      } catch (e) {
        return { path, error: e instanceof Error ? e.message : String(e) };
      }
    });
    summarize(results, "Bundled archives");
  }

  if (!BUNDLED_ONLY) {
    console.log(`\n[local] scanning ${COURSES_DIR}`);
    const jsons = listLocalCourseJson();
    if (jsons.length === 0) {
      console.log(`  (no local courses found — skip)`);
    } else {
      const results = jsons.map((path) => {
        try {
          return markLocal(path);
        } catch (e) {
          return { path, error: e instanceof Error ? e.message : String(e) };
        }
      });
      summarize(results, "Local library");
    }
  }

  console.log("");
  if (!DRY_RUN) {
    console.log(`Done. Books are tagged ${TARGET_STATUS}.`);
    console.log(`The BookCover corner-pill + CourseLibrary section heading`);
    console.log(`already render this field — no UI changes needed.`);
  }
}

main();
