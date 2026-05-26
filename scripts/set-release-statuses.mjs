#!/usr/bin/env node
/**
 * set-release-statuses.mjs
 *
 * Editorial promotion pass. Companion to `mark-bundled-prerelease.mjs`
 * (which sets every book to UNREVIEWED in bulk). This script applies
 * an EXPLICIT per-book mapping so we can promote individual courses
 * along the editorial pipeline:
 *
 *   UNREVIEWED  →  ALPHA  →  BETA
 *   (drafts)        (next)    (final polish)
 *
 * Books not in the mapping are LEFT ALONE — keep UNREVIEWED applied
 * from the bulk pass, or whatever they had before. Run after
 * `library:prerelease` so the floor is set, then re-run this anytime
 * the editorial decisions change.
 *
 * Just like the prerelease script, it walks BOTH the bundled
 * `.libre` archives and the local on-disk course.json files, so
 * a future promote-library-to-bundle re-zip won't silently revert
 * the editorial state.
 *
 * Flags: `--dry-run`, `--bundled-only`, `--local-only`.
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

/**
 * Editorial mapping. Anything missing from this object is left at its
 * current value — so the bulk UNREVIEWED marker holds for unreviewed
 * books. Update this map as books move through editorial review.
 *
 * `BETA` = final polish, near release. The Library renders these
 * with the most prominent corner pill.
 * `ALPHA` = in the collection, the default for "ready enough to use
 * but not editorially blessed yet."
 * `UNREVIEWED` = early drafts. Generally we don't write that here
 * because the bulk prerelease script covers them.
 */
const STATUSES = {
  // ───── BETA ─────  Final polish for release
  "the-rust-programming-language": "BETA",
  "learning-go": "BETA",
  // "Learning Svelte" → svelte-tutorial (only Svelte course in the
  // library; the older svelte-5-complete archive was pruned during
  // promote-library-to-bundle).
  "svelte-tutorial": "BETA",
  // Promoted after the EVM runtime + harness pass:
  // 109 exercises run end-to-end against an in-process @ethereumjs/vm,
  // 44 reading lessons cover prereq concepts, smoke-test green.
  "mastering-ethereum": "BETA",

  // ───── ALPHA ─────  Next in the queue
  "mastering-bitcoin": "ALPHA",
  "solana-programs": "ALPHA",
  // RN courses `react-native` + `learning-react-native` are kept at
  // UNREVIEWED since they're mobile-specific and the user said
  // "the react course" singular).
};

const VALID_STATUSES = new Set(["UNREVIEWED", "ALPHA", "BETA"]);
for (const [id, s] of Object.entries(STATUSES)) {
  if (!VALID_STATUSES.has(s)) {
    console.error(`Invalid status for ${id}: ${s}`);
    process.exit(1);
  }
}

function applyMarker(json) {
  const target = STATUSES[json.id];
  if (!target) return { changed: false, skipped: true };
  const before = json.releaseStatus;
  if (before === target) return { changed: false, before, target };
  json.releaseStatus = target;
  return { changed: true, before, target };
}

// ────────── Bundled archives ──────────

function listBundledArchives() {
  if (!existsSync(BUNDLE_DIR)) return [];
  return readdirSync(BUNDLE_DIR)
    .filter((n) => n.endsWith(".academy") || n.endsWith(".libre"))
    .map((n) => join(BUNDLE_DIR, n));
}

function processBundled(path) {
  const tmp = mkdtempSync(join(tmpdir(), "libre-promote-"));
  try {
    execFileSync("/usr/bin/unzip", ["-q", path, "-d", tmp], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    const courseJsonPath = join(tmp, "course.json");
    if (!existsSync(courseJsonPath)) {
      throw new Error(`no course.json at root of ${path}`);
    }
    const json = JSON.parse(readFileSync(courseJsonPath, "utf8"));
    const result = applyMarker(json);
    if (result.skipped) return { id: json.id, status: "skipped" };
    if (!result.changed) {
      return { id: json.id, status: "already", target: result.target };
    }
    if (DRY_RUN) {
      return { id: json.id, status: "would-set", from: result.before, target: result.target };
    }
    writeFileSync(courseJsonPath, JSON.stringify(json, null, 2) + "\n");
    rmSync(path);
    execFileSync("/usr/bin/zip", ["-r", "-q", "-X", path, "."], {
      cwd: tmp,
      stdio: ["ignore", "ignore", "inherit"],
    });
    return { id: json.id, status: "set", from: result.before, target: result.target };
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

function processLocal(path) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  const result = applyMarker(json);
  if (result.skipped) return { id: json.id, status: "skipped" };
  if (!result.changed) {
    return { id: json.id, status: "already", target: result.target };
  }
  if (DRY_RUN) {
    return { id: json.id, status: "would-set", from: result.before, target: result.target };
  }
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  return { id: json.id, status: "set", from: result.before, target: result.target };
}

// ────────── Main ──────────

function summarize(results, label) {
  const set = results.filter((r) => r.status === "set");
  const wouldSet = results.filter((r) => r.status === "would-set");
  const already = results.filter((r) => r.status === "already");
  const errors = results.filter((r) => r.error);
  const promoted = [...set, ...wouldSet];

  console.log(`\n${label}`);
  console.log("─".repeat(label.length));
  if (promoted.length) {
    const verb = DRY_RUN ? "Would promote" : "Promoted";
    console.log(`${verb} (${promoted.length}):`);
    for (const r of promoted) {
      console.log(`  ${DRY_RUN ? "~" : "✓"} ${r.id}: ${r.from ?? "unset"} → ${r.target}`);
    }
  }
  if (already.length) {
    console.log(`Already at target (${already.length}):`);
    for (const r of already) console.log(`  · ${r.id} = ${r.target}`);
  }
  // Books in our mapping but not present in this surface — flag them
  // so a typo'd id surfaces loudly instead of silently no-op'ing.
  const idsTouched = new Set(results.filter((r) => r.id).map((r) => r.id));
  const missing = Object.keys(STATUSES).filter((id) => !idsTouched.has(id));
  if (missing.length) {
    console.log(`In mapping but not found here (${missing.length}):`);
    for (const id of missing) console.log(`  ? ${id}`);
  }
  if (errors.length) {
    console.log(`Errors (${errors.length}):`);
    for (const r of errors) console.log(`  ! ${r.path}: ${r.error}`);
  }
}

function main() {
  if (DRY_RUN) console.log("DRY RUN — no files will be modified");
  console.log(`Mapping: ${Object.keys(STATUSES).length} books to promote`);

  if (!LOCAL_ONLY) {
    console.log(`\n[bundled] scanning ${BUNDLE_DIR}`);
    const archives = listBundledArchives();
    const results = archives.map((path) => {
      try {
        return processBundled(path);
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
          return processLocal(path);
        } catch (e) {
          return { path, error: e instanceof Error ? e.message : String(e) };
        }
      });
      summarize(results, "Local library");
    }
  }

  console.log("");
  if (!DRY_RUN) {
    console.log(`Done. Editorial pipeline applied.`);
  }
}

main();
