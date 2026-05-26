#!/usr/bin/env node
/**
 * reset-local-library.mjs
 *
 * Wipes the developer's local Libre state so the next launch
 * re-seeds clean from `src-tauri/resources/bundled-packs/`. Pair with
 * `promote-library-to-bundle.mjs` to "freeze the current library as
 * the shipped set, then reset."
 *
 * What gets wiped (default mode):
 *   - <app_data>/courses/                     — every locally-installed course
 *   - <app_data>/seeded-packs.json            — the seed marker (so re-seed re-extracts)
 *   - <app_data>/progress.sqlite{,-shm,-wal}  — completions / streak / XP history
 *
 * What's PRESERVED by default:
 *   - <app_data>/settings.json                — theme, AI keys, account preferences
 *   - <app_data>/ingest-cache/                — LLM call cache for ingestion runs
 *
 * Pass --hard to also wipe settings.json and ingest-cache (true clean
 * slate as if the app had never run on this machine).
 *
 * Pass --dry-run to see what WOULD be removed without touching disk.
 *
 * The script confirms before removing anything unless --yes is set —
 * one stray invocation could otherwise lose a developer's progress
 * history. The confirm read is from /dev/tty so piping doesn't
 * accidentally auto-yes.
 */

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const BUNDLE_ID = "com.mattssoftware.libre";
const APP_DATA = join(homedir(), "Library", "Application Support", BUNDLE_ID);

const args = new Set(process.argv.slice(2));
const HARD = args.has("--hard");
const DRY_RUN = args.has("--dry-run");
const AUTO_YES = args.has("--yes") || args.has("-y");

const TARGETS_DEFAULT = [
  { path: join(APP_DATA, "courses"), kind: "directory", note: "local courses" },
  { path: join(APP_DATA, "seeded-packs.json"), kind: "file", note: "seed marker" },
  { path: join(APP_DATA, "progress.sqlite"), kind: "file", note: "progress DB" },
  { path: join(APP_DATA, "progress.sqlite-shm"), kind: "file", note: "progress DB (shm)" },
  { path: join(APP_DATA, "progress.sqlite-wal"), kind: "file", note: "progress DB (wal)" },
];

const TARGETS_HARD = [
  { path: join(APP_DATA, "settings.json"), kind: "file", note: "settings (theme / AI keys)" },
  { path: join(APP_DATA, "ingest-cache"), kind: "directory", note: "ingest LLM cache" },
];

function dirSize(path) {
  // `du -sk` returns kilobytes; multiply for byte count. Doesn't matter
  // if it fails — we only use this for the confirmation prompt.
  try {
    const out = execFileSync("/usr/bin/du", ["-sk", path], { encoding: "utf8" });
    return Number(out.split(/\s+/)[0]) * 1024;
  } catch {
    return 0;
  }
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function describe(target) {
  if (!existsSync(target.path)) return null;
  let label;
  try {
    const s = statSync(target.path);
    label = s.isDirectory() ? `${fmtBytes(dirSize(target.path))} dir` : `${fmtBytes(s.size)}`;
  } catch {
    label = "?";
  }
  return `  - ${target.path}   (${target.note}, ${label})`;
}

function confirm(prompt) {
  if (AUTO_YES) return true;
  // Read directly from the controlling tty so a piped stdin doesn't
  // rubber-stamp this. macOS exposes /dev/tty as a readable
  // character device; readFileSync on it blocks until newline, which
  // is what we want.
  process.stdout.write(`${prompt} [y/N] `);
  let answer = "";
  try {
    // Read 1 line from /dev/tty. We can't use readline because the
    // script is sync; the easy hack is to spawn `head -1 < /dev/tty`.
    answer = execFileSync("/bin/sh", ["-c", "read line < /dev/tty && printf %s \"$line\""], {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "inherit"],
    }).trim();
  } catch {
    // No tty (CI / piped). Don't auto-confirm — bail loud.
    console.error("(no tty available to read confirmation; pass --yes to skip prompt)");
    return false;
  }
  return /^y(es)?$/i.test(answer);
}

function main() {
  if (!existsSync(APP_DATA)) {
    console.log(`No app data at ${APP_DATA} — nothing to reset.`);
    return;
  }

  const targets = HARD ? [...TARGETS_DEFAULT, ...TARGETS_HARD] : TARGETS_DEFAULT;
  const present = targets.map((t) => ({ ...t, line: describe(t) })).filter((t) => t.line);

  console.log(`Reset target: ${APP_DATA}`);
  console.log(HARD ? "Mode: HARD (also wipes settings + ingest cache)" : "Mode: default (preserves settings + ingest cache)");
  if (DRY_RUN) console.log("DRY RUN — no files will be removed");
  console.log("");
  if (present.length === 0) {
    console.log("Nothing to remove (all targets already gone).");
    return;
  }
  console.log("Will remove:");
  for (const p of present) console.log(p.line);
  console.log("");

  if (!DRY_RUN) {
    if (!confirm("Proceed?")) {
      console.log("Aborted.");
      process.exit(1);
    }
  }

  for (const t of present) {
    if (DRY_RUN) {
      console.log(`(dry) would remove ${t.path}`);
      continue;
    }
    try {
      rmSync(t.path, { recursive: t.kind === "directory", force: true });
      console.log(`removed ${t.path}`);
    } catch (e) {
      console.error(`failed to remove ${t.path}: ${e.message}`);
    }
  }

  // Sanity-check: re-read seeded-packs.json's seed_version (if it
  // somehow survived) so we can warn about stale state. This shouldn't
  // ever fire in default mode, but if a future script preserves the
  // marker we'd want to flag it.
  const marker = join(APP_DATA, "seeded-packs.json");
  if (existsSync(marker)) {
    try {
      const j = JSON.parse(readFileSync(marker, "utf8"));
      console.warn(`note: seeded-packs.json still present (seed_version=${j.seed_version}); re-seed will be a no-op until removed`);
    } catch { /* ignore */ }
  }

  console.log("");
  console.log("Done. Next launch of Libre will re-seed from bundled-packs/.");
}

main();
