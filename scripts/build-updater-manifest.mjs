#!/usr/bin/env node
/// Build (or refresh) the `latest.json` file the Tauri OTA updater
/// pulls from a release. Walks the release's assets via `gh`,
/// pairs each `.app.tar.gz` / `.AppImage.tar.gz` / `.nsis.zip`
/// (or `.msi.zip`) with its sibling `.sig` file, and emits the
/// manifest shape Tauri expects:
///
///   {
///     "version": "v0.1.10",
///     "notes": "…",
///     "pub_date": "2026-05-04T01:00:00Z",
///     "platforms": {
///       "darwin-aarch64":  { "signature": "...", "url": "..." },
///       "linux-x86_64":    { "signature": "...", "url": "..." },
///       "windows-x86_64":  { "signature": "...", "url": "..." }
///     }
///   }
///
/// Then uploads it to the same release as `latest.json`. Tauri's
/// updater is configured (in `tauri.conf.json` plugins.updater) to
/// fetch from
/// `https://github.com/InfamousVague/Libre/releases/latest/download/latest.json`
/// — the `/latest/download/<filename>` redirect resolves to the
/// most recent release's `latest.json`.
///
/// Why not let `tauri-action` generate this in CI? It does, but
/// PER-PLATFORM, with the same filename — so the matrix overwrites
/// itself and the final `latest.json` only carries the LAST
/// platform. This script runs once at the end of the release flow
/// (CI's post-matrix job and `make local-release` both invoke it)
/// and produces a complete manifest with every platform that
/// uploaded an updater artefact.
///
/// Usage:
///   node scripts/build-updater-manifest.mjs <tag>
///
/// Auth: relies on `gh` being authenticated (uses the user's
/// existing github.com login token; CI uses GITHUB_TOKEN).

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tag = process.argv[2];
if (!tag) {
  console.error("usage: build-updater-manifest.mjs <tag>");
  process.exit(1);
}

// Canonical repo name post-rename. The old `InfamousVague/Libre`
// GitHub-side-redirects to `Libre.academy` for git pushes, but
// `gh release view/upload/create` calls quirk through the redirect
// (silent 404s / wrong-repo uploads) — caused v1.3.5's mac assets
// to never land on the release. Hardcoding the current name avoids
// the redirect entirely.
const REPO = "InfamousVague/Libre.academy";

/// Map a Tauri updater asset filename → (platform key, raw url) pair.
/// Platform keys follow the conventions Tauri's updater expects, see
/// https://v2.tauri.app/plugin/updater/#platform-keys
function classify(name) {
  // macOS — `.app.tar.gz` / `Libre_x_aarch64.app.tar.gz`
  if (name.endsWith(".app.tar.gz")) {
    if (/x86_64|x64/.test(name)) return "darwin-x86_64";
    if (/aarch64|arm64/.test(name)) return "darwin-aarch64";
    // Universal binary — Tauri's updater uses `darwin-aarch64`
    // for both Apple Silicon and Intel users running an ARM build
    // because the universal binary handles the architecture
    // selection internally. Default to aarch64 unless the filename
    // is explicit.
    return "darwin-aarch64";
  }
  // Linux — `.AppImage.tar.gz` (the Tauri updater AppImage delta
  // wrapper) preferred, but Tauri 2 + the post-matrix manifest job
  // also produce raw `.AppImage` / `.deb` / `.rpm` with sibling
  // `.sig` files. Match those too so Linux entries appear in
  // latest.json.
  if (name.endsWith(".AppImage.tar.gz")) return "linux-x86_64";
  if (name.endsWith(".AppImage")) return "linux-x86_64";
  // Windows — Tauri 2 emits `.exe` (NSIS installer) and `.msi`
  // directly, NOT `.nsis.zip`/`.msi.zip` (Tauri 1 wrappers). The
  // updater calls the .exe with silent-install flags. Prefer
  // `.exe` over `.msi` since NSIS supports the updater's silent-
  // background-install path; .msi requires admin elevation.
  if (name.endsWith("-setup.exe") || name.endsWith(".nsis.zip")) {
    if (/aarch64|arm64/.test(name)) return "windows-aarch64";
    return "windows-x86_64";
  }
  return null;
}

/// Fetch the release as JSON via gh CLI. We use --jq to project just
/// the fields we need so the output stays small.
const releaseJson = execSync(
  `gh release view "${tag}" --repo "${REPO}" --json tagName,publishedAt,assets,body`,
  { encoding: "utf8" },
);
const release = JSON.parse(releaseJson);

/// First pass: collect every (asset, sibling-sig) pair, classified by
/// platform. Skip anything we don't recognise.
const platforms = {};
const sigByName = new Map();
for (const a of release.assets) {
  if (a.name.endsWith(".sig")) {
    sigByName.set(a.name.replace(/\.sig$/, ""), a);
  }
}
for (const a of release.assets) {
  const key = classify(a.name);
  if (!key) continue;
  const sigAsset = sigByName.get(a.name);
  if (!sigAsset) {
    console.warn(`[updater] no .sig found for ${a.name} — skipping`);
    continue;
  }
  // Read the .sig content. GitHub doesn't expose .sig contents in
  // the metadata so we have to download it. Sigs are tiny (~500
  // bytes), no caching needed.
  const sigPath = join(tmpdir(), `fbsig-${Date.now()}-${a.name}.sig`);
  try {
    execSync(
      `gh release download "${tag}" --repo "${REPO}" --pattern "${a.name}.sig" --output "${sigPath}" --clobber`,
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    const signature = readFileSync(sigPath, "utf8").trim();
    platforms[key] = {
      signature,
      url: a.url || `https://github.com/${REPO}/releases/download/${tag}/${a.name}`,
    };
    console.log(`[updater] ${key} ← ${a.name}`);
  } catch (e) {
    console.warn(`[updater] couldn't read sig for ${a.name}: ${e.message}`);
  } finally {
    try {
      unlinkSync(sigPath);
    } catch {
      /* ignore */
    }
  }
}

if (Object.keys(platforms).length === 0) {
  console.error(
    `[updater] no signed updater assets found on ${tag}.\n` +
      `Run a release that has TAURI_SIGNING_PRIVATE_KEY set so the build\n` +
      `produces .sig files. Without those, OTA can't verify updates.`,
  );
  process.exit(1);
}

const manifest = {
  version: release.tagName,
  notes: (release.body || "").trim() || `Libre ${release.tagName}`,
  pub_date: release.publishedAt,
  platforms,
};

// IMPORTANT: the file MUST be named exactly `latest.json` on disk
// before we hand it to `gh release upload`. The `#display-name`
// suffix gh supports is purely cosmetic — it changes the label in
// the GitHub UI but the asset URL still uses the original filename.
// And the updater endpoint
//   github.com/.../releases/latest/download/latest.json
// resolves on filename match, so a mis-named asset breaks OTA
// silently. (v0.1.12's first run uploaded `libre-latest-…json`,
// which clients hitting `/latest.json` would 404 on.)
import { mkdtempSync } from "node:fs";

const stagingDir = mkdtempSync(join(tmpdir(), "libre-manifest-"));
const manifestPath = join(stagingDir, "latest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`\n[updater] manifest written to ${manifestPath}:`);
console.log(JSON.stringify(manifest, null, 2));

execSync(
  `gh release upload "${tag}" "${manifestPath}" --repo "${REPO}" --clobber`,
  { stdio: "inherit" },
);
console.log(`\n[updater] uploaded to ${tag} as latest.json`);
unlinkSync(manifestPath);
