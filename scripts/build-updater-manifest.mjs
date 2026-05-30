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
///
/// One installer per platform key wins — when multiple assets classify
/// the same way (e.g. CI uploads both .deb and .rpm for Linux), the
/// LAST one through the for-loop in main wins. The `priority()` helper
/// below sorts assets so the preferred installer goes through last and
/// ends up in the manifest. Preference order:
///   Linux:   .AppImage.tar.gz > .AppImage > .deb > .rpm
///   Windows: -setup.exe (NSIS) > .nsis.zip > .msi
///   macOS:   .app.tar.gz   (only OTA-compatible format)
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
  // Linux — full preference list. `.AppImage.tar.gz` (Tauri's
  // updater delta wrapper) is the canonical OTA format; raw
  // `.AppImage`, `.deb`, `.rpm` are CI's fallbacks for distros
  // that the user installs directly. All map to `linux-x86_64`
  // since Tauri's updater client only checks the base key.
  if (name.endsWith(".AppImage.tar.gz")) return "linux-x86_64";
  if (name.endsWith(".AppImage")) return "linux-x86_64";
  if (name.endsWith(".deb")) return "linux-x86_64";
  if (name.endsWith(".rpm")) return "linux-x86_64";
  // Windows — `-setup.exe` (NSIS) is preferred because it supports
  // the updater's silent-background-install path; `.msi` requires
  // UAC elevation. `.nsis.zip` is the Tauri-1-era wrapper format,
  // still accepted for back-compat.
  if (name.endsWith("-setup.exe") || name.endsWith(".nsis.zip")) {
    if (/aarch64|arm64/.test(name)) return "windows-aarch64";
    return "windows-x86_64";
  }
  if (name.endsWith(".msi")) {
    if (/aarch64|arm64/.test(name)) return "windows-aarch64";
    return "windows-x86_64";
  }
  return null;
}

/// Lower number = higher preference. Used to sort assets so the
/// preferred installer for each platform overwrites the lesser ones
/// in the platforms map (which is a last-write-wins object).
function priority(name) {
  if (name.endsWith(".app.tar.gz")) return 0;
  if (name.endsWith(".AppImage.tar.gz")) return 1;
  if (name.endsWith("-setup.exe")) return 2;
  if (name.endsWith(".nsis.zip")) return 3;
  if (name.endsWith(".AppImage")) return 4;
  if (name.endsWith(".deb")) return 5;
  if (name.endsWith(".rpm")) return 6;
  if (name.endsWith(".msi")) return 7;
  return 99;
}

/// Fetch the release as JSON via gh CLI. We use --jq to project just
/// the fields we need so the output stays small.
const releaseJson = execSync(
  `gh release view "${tag}" --repo "${REPO}" --json tagName,publishedAt,assets,body`,
  { encoding: "utf8" },
);
const release = JSON.parse(releaseJson);

/// First pass: collect every (asset, sibling-sig) pair, classified by
/// platform. Skip anything we don't recognise. Walk assets in
/// REVERSE-priority order so the preferred installer for each
/// platform is processed LAST and ends up in the manifest (the
/// platforms map is last-write-wins). Without the sort, .rpm could
/// overwrite .deb (or .msi could overwrite .nsis) just based on
/// upload order.
const platforms = {};
const sigByName = new Map();
for (const a of release.assets) {
  if (a.name.endsWith(".sig")) {
    sigByName.set(a.name.replace(/\.sig$/, ""), a);
  }
}
const orderedAssets = [...release.assets].sort(
  (a, b) => priority(b.name) - priority(a.name),
);
for (const a of orderedAssets) {
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

/// Merge with the existing manifest's platforms if one is present on
/// this release. CI writes latest.json after Linux+Windows finish; the
/// maintainer's local `make deploy` writes it again after the Mac
/// upload. Whichever runs LAST without merging would wipe the other's
/// platform keys — so we read existing first, then overlay only the
/// keys we found assets for on this run. That gives us:
///   - CI alone   → manifest has Linux + Windows
///   - Mac local  → manifest has Mac + (whatever CI already wrote)
///   - Either order, end state has all three.
let mergedPlatforms = platforms;
const existing = release.assets.find((a) => a.name === "latest.json");
if (existing) {
  const existingPath = join(tmpdir(), `libre-existing-manifest-${Date.now()}.json`);
  try {
    execSync(
      `gh release download "${tag}" --repo "${REPO}" --pattern "latest.json" --output "${existingPath}" --clobber`,
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    const prior = JSON.parse(readFileSync(existingPath, "utf8"));
    if (prior && typeof prior === "object" && prior.platforms) {
      mergedPlatforms = { ...prior.platforms, ...platforms };
      const merged = Object.keys(platforms);
      const preserved = Object.keys(prior.platforms).filter((k) => !platforms[k]);
      console.log(
        `[updater] merged with existing manifest — overwriting ${merged.length} key(s) (${merged.join(", ")}), preserving ${preserved.length} (${preserved.join(", ") || "none"})`,
      );
    }
  } catch (e) {
    console.warn(`[updater] couldn't merge existing manifest (${e.message}); writing fresh`);
  } finally {
    try { unlinkSync(existingPath); } catch { /* ignore */ }
  }
}

const manifest = {
  version: release.tagName,
  notes: (release.body || "").trim() || `Libre ${release.tagName}`,
  pub_date: release.publishedAt,
  platforms: mergedPlatforms,
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
