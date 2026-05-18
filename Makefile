# Libre — Build, Sign, Notarize, Install
# Usage:
#   make              — full pipeline: build → sign → notarize → install
#   make build        — tauri release build
#   make sign         — post-build signing only (no rebuild)
#   make notarize     — notarize + staple the DMG
#   make install      — install notarized app to /Applications
#   make release      — bump patch, commit, tag, push (no build)
#   make local-release — bump + build + sign + notarize + upload DMG
#   make deploy       — local-release + push libre.academy (site + /learn)
#   make deploy-site  — push libre.academy only (skip the DMG rebuild)
#   make dev          — run in dev mode
#   make clean        — remove build artifacts

SHELL := /bin/bash
ROOT  := $(shell pwd)
TAURI := $(ROOT)/src-tauri

# Load credentials from .env.apple (gitignored)
-include $(ROOT)/.env.apple

export APPLE_SIGNING_IDENTITY

IDENTITY      := $(APPLE_SIGNING_IDENTITY)
APPLE_ID      ?= InfamousVagueRat@gmail.com
TEAM_ID       := $(APPLE_TEAM_ID)
TEAM_ID       ?= F6ZAL7ANAD
VERSION       := $(shell grep '"version"' src-tauri/tauri.conf.json | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')
ARCH          := $(shell uname -m)
ifeq ($(ARCH),arm64)
  ARCH_TAG := aarch64
else ifeq ($(ARCH),x86_64)
  ARCH_TAG := x64
else
  ARCH_TAG := $(ARCH)
endif
APP_BUNDLE    := $(TAURI)/target/release/bundle/macos/Libre.app
DMG           := $(TAURI)/target/release/bundle/dmg/Libre_$(VERSION)_$(ARCH_TAG).dmg
INSTALL_PATH  := /Applications/Libre.app

.PHONY: all build pre-build sign notarize staple install dev release local-release \
        deploy deploy-site deploy-content clean help \
        audio-import audio-upload audio-deploy tour-audio \
        run run-split run-phone run-watch pick-phone pick-watch run-clean \
        release-phone ship-phone

# Marketing site checkout (separate repo). The site's `npm run deploy`
# rebuilds Libre with LIBRE_BASE=/learn/, stages dist-web/ under
# its own public/learn/, builds the Vite site, and rsyncs the result to
# /var/www/libre-academy on the VPS. Override if your laptop has the
# academy repo somewhere else.
ACADEMY_ROOT ?= $(ROOT)/../../Web/libre-academy

# --- iOS / watchOS run config ---------------------------------------------
WATCH_ROOT      := /Users/matt/Development/Apps/LibreWatch
DEVICE_CACHE    := $(ROOT)/.libre-devices.cache
PHONE_BUNDLE_ID := com.mattssoftware.libre
WATCH_BUNDLE_ID := com.mattssoftware.libre.watchkitapp
# CocoaPods needs UTF-8 locale or it bails on unicode in podspecs.
TAURI_ENV       := LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

## Default: full pipeline
all: build sign notarize install
	@echo ""
	@echo "✓ Done — Libre.app installed and notarized"

# --- Pre-build DMG cleanup --------------------------------------------------
# Walks `hdiutil info -plist` for any leftover Libre DMG mounts (the
# read-write images Tauri's bundle_dmg.sh leaves behind when a release
# build crashes mid-bundle) and detaches them. Plist-based — the
# human-readable `hdiutil info` output is too fragile to awk against;
# we shipped broken cleanup patterns from it in v1.0.1 and v1.0.6.
define PRE_BUILD_PY
import json, subprocess, fnmatch, sys
try:
    plist = subprocess.check_output(["hdiutil", "info", "-plist"])
    data = json.loads(subprocess.check_output(
        ["plutil", "-convert", "json", "-o", "-", "-"], input=plist))
except Exception as e:
    print(f"  (could not read hdiutil info: {e})")
    sys.exit(0)
detached = 0
for img in data.get("images", []):
    path = img.get("image-path", "")
    if not fnmatch.fnmatch(path, "*Libre*aarch64.dmg"):
        continue
    entities = img.get("system-entities") or []
    if not entities:
        continue
    dev = entities[0].get("dev-entry")
    if not dev:
        continue
    print(f"  detaching {dev}  (backing: {path})")
    subprocess.run(["hdiutil", "detach", dev, "-force"], check=False)
    detached += 1
if detached == 0:
    print("  no leftover Libre DMG mounts")
endef
export PRE_BUILD_PY

## Clean up leftover Tauri DMG state from a previous crashed build so
## bundle_dmg.sh doesn't fail with "rw image still mounted". `build`
## depends on this — the old manual fix was `hdiutil detach /dev/diskN
## -force` + `rm -f rw.*.dmg`, which we had to debug twice in production
## (v1.0.1, v1.0.6). Idempotent.
pre-build:
	@echo "=== Pre-build: cleaning leftover Tauri DMG state ==="
	@python3 -c "$$PRE_BUILD_PY"
	@rm -f $(TAURI)/target/release/bundle/macos/rw.*.dmg
	@for vol in /Volumes/dmg.*; do \
		[ -e "$$vol" ] || continue; \
		if mount | grep -qF " on $$vol "; then continue; fi; \
		echo "  removing orphan mount-point: $$vol"; \
		rmdir "$$vol" 2>/dev/null || true; \
	done

## Build Tauri release.
##
## TAURI_SIGNING_* env vars trigger the updater plugin to also produce
## `Libre.app.tar.gz` + `.sig` alongside the regular .dmg. These
## are what the OTA updater downloads — without them, installed
## clients can't auto-update. Default key path is the maintainer's
## ~/.tauri/libre-updater.key; override TAURI_SIGNING_KEY_PATH if
## you've stored the key elsewhere.
build: pre-build
	@echo "=== Building Tauri release ==="
	@if [ ! -f "$(TAURI_SIGNING_KEY_PATH)" ]; then \
		echo "WARN: signing key not found at $(TAURI_SIGNING_KEY_PATH);"; \
		echo "      OTA update artifacts won't be signed. Generate via:"; \
		echo "      npx @tauri-apps/cli signer generate -w $(TAURI_SIGNING_KEY_PATH)"; \
	fi
	cd $(ROOT) && \
		TAURI_SIGNING_PRIVATE_KEY="$$(cat $(TAURI_SIGNING_KEY_PATH) 2>/dev/null)" \
		TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(TAURI_SIGNING_KEY_PASSWORD)" \
		npm run tauri build -- --bundles app,dmg

## Tauri OTA-update signing key. Generated once via
## `npx @tauri-apps/cli signer generate -w ~/.tauri/libre-updater.key`;
## the public half of this same keypair is committed to
## `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). Losing the
## private key requires shipping a manual-install version with a
## NEW pubkey to rotate the trust root — keep it backed up.
TAURI_SIGNING_KEY_PATH      ?= $(HOME)/.tauri/libre-updater.key
TAURI_SIGNING_KEY_PASSWORD  ?=

## Post-build: sign everything with hardened runtime + rebuild DMG
sign:
	@echo "=== Signing ==="
	cd $(TAURI) && bash scripts/post-build.sh

## Notarize the DMG with Apple
notarize:
	@echo "=== Notarizing ==="
	@if [ -z "$(APPLE_PASSWORD)" ]; then \
		echo "ERROR: APPLE_PASSWORD not set. Check .env.apple"; exit 1; \
	fi
	xcrun notarytool submit "$(DMG)" \
		--apple-id "$(APPLE_ID)" \
		--team-id "$(TEAM_ID)" \
		--password "$(APPLE_PASSWORD)" \
		--wait
	@echo "=== Stapling ==="
	xcrun stapler staple "$(DMG)"

## Staple notarization ticket to DMG (standalone)
staple:
	@echo "=== Stapling ==="
	xcrun stapler staple "$(DMG)"

## Install notarized app from DMG to /Applications
install: staple
	@echo "=== Installing ==="
	hdiutil attach "$(DMG)" -quiet -nobrowse -mountpoint /tmp/libre-dmg
	rm -rf "$(INSTALL_PATH)"
	ditto /tmp/libre-dmg/Libre.app "$(INSTALL_PATH)"
	hdiutil detach /tmp/libre-dmg -quiet
	@echo "Installed: $(INSTALL_PATH)"
	@spctl --assess --type execute --verbose "$(INSTALL_PATH)" 2>&1

## Dev mode
dev:
	cd $(ROOT) && npm run tauri dev

## Bump version, commit, tag, push (no build)
BUMP ?= patch

release:
	@CURRENT=$(VERSION); \
	IFS='.' read -r MAJOR MINOR PATCH <<< "$$CURRENT"; \
	if [ "$(BUMP)" = "major" ]; then \
		MAJOR=$$((MAJOR + 1)); MINOR=0; PATCH=0; \
	elif [ "$(BUMP)" = "minor" ]; then \
		MINOR=$$((MINOR + 1)); PATCH=0; \
	else \
		PATCH=$$((PATCH + 1)); \
	fi; \
	NEW="$$MAJOR.$$MINOR.$$PATCH"; \
	echo "=== Bumping $$CURRENT → $$NEW ==="; \
	sed -i '' "s/\"version\": \"$$CURRENT\"/\"version\": \"$$NEW\"/" src-tauri/tauri.conf.json; \
	sed -i '' "/^\[package\]/,/^version = / s/^version = .*/version = \"$$NEW\"/" src-tauri/Cargo.toml; \
	sed -i '' "/^name = \"libre\"/,/^version = / s/^version = .*/version = \"$$NEW\"/" src-tauri/Cargo.lock; \
	TAURI_V=$$(grep '"version"' src-tauri/tauri.conf.json | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/'); \
	CARGO_V=$$(grep '^version = ' src-tauri/Cargo.toml | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/'); \
	LOCK_V=$$(grep -A1 '^name = "libre"' src-tauri/Cargo.lock | grep '^version = ' | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/'); \
	if [ "$$TAURI_V" != "$$NEW" ] || [ "$$CARGO_V" != "$$NEW" ] || [ "$$LOCK_V" != "$$NEW" ]; then \
		echo "ERROR: version bump drift detected after sed — files disagree:"; \
		echo "  expected (NEW):       $$NEW"; \
		echo "  tauri.conf.json:      $$TAURI_V"; \
		echo "  Cargo.toml [package]: $$CARGO_V"; \
		echo "  Cargo.lock libre:     $$LOCK_V"; \
		echo "Aborting before commit/tag/push. Fix the version lines by hand and re-run."; \
		exit 1; \
	fi; \
	echo "  version files in sync at $$NEW (tauri.conf.json / Cargo.toml / Cargo.lock)"; \
	git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock; \
	git commit -m "Libre v$$NEW"; \
	git tag -a "v$$NEW" -m "Libre v$$NEW"; \
	git push origin HEAD; \
	git push origin "v$$NEW"; \
	echo ""; \
	echo "✓ v$$NEW tagged and pushed"

## Local release: build + sign + notarize + upload current version to GitHub
## (Use `make release` first if you want to bump the version.) Skips the
## /Applications install step — release publishing shouldn't require
## the user be willing to replace their local copy.
##
## After this finishes, `.github/workflows/desktop-build.yml` is also
## triggered by the same tag push (or already running). It builds Linux
## (.AppImage + .deb) and Windows (.msi + .exe) and APPENDS them to the
## same release within ~25 minutes. macOS is intentionally skipped in CI
## — the signed/notarized DMG can only be produced here, where the
## Apple Developer ID cert lives.
##
## So a complete release flow looks like:
##   make release        → bump + tag + push (triggers CI Linux+Win)
##   make local-release  → build + sign + notarize + publish DMG
##   …wait ~25 min…       CI uploads Linux + Windows assets
##   visit https://github.com/InfamousVague/Libre/releases/latest
local-release: build sign notarize
	@DMG_CURRENT="$(TAURI)/target/release/bundle/dmg/Libre_$(VERSION)_$(ARCH_TAG).dmg"; \
	UPDATER_TARBALL="$(TAURI)/target/release/bundle/macos/Libre.app.tar.gz"; \
	UPDATER_SIG="$$UPDATER_TARBALL.sig"; \
	if [ ! -f "$$DMG_CURRENT" ]; then \
		echo "ERROR: DMG not found at $$DMG_CURRENT"; exit 1; \
	fi; \
	if git rev-parse "v$(VERSION)" >/dev/null 2>&1; then \
		echo "Tag v$(VERSION) already exists — skipping tag creation"; \
	else \
		git tag -a "v$(VERSION)" -m "Libre v$(VERSION)"; \
		git push origin "v$(VERSION)"; \
	fi; \
	gh release view "v$(VERSION)" >/dev/null 2>&1 && { \
		echo "Release v$(VERSION) exists — uploading DMG as asset"; \
		gh release upload "v$(VERSION)" "$$DMG_CURRENT" --clobber; \
	} || { \
		gh release create "v$(VERSION)" \
			"$$DMG_CURRENT" \
			--title "Libre v$(VERSION)" \
			--notes "Signed and notarized macOS release." \
			--latest; \
	}; \
	if [ -f "$$UPDATER_TARBALL" ] && [ -f "$$UPDATER_SIG" ]; then \
		echo "Uploading OTA updater artefacts (Mac):"; \
		cp "$$UPDATER_TARBALL" "/tmp/Libre_$(VERSION)_aarch64.app.tar.gz"; \
		cp "$$UPDATER_SIG" "/tmp/Libre_$(VERSION)_aarch64.app.tar.gz.sig"; \
		gh release upload "v$(VERSION)" \
			"/tmp/Libre_$(VERSION)_aarch64.app.tar.gz" \
			"/tmp/Libre_$(VERSION)_aarch64.app.tar.gz.sig" \
			--clobber; \
		rm -f "/tmp/Libre_$(VERSION)_aarch64.app.tar.gz" "/tmp/Libre_$(VERSION)_aarch64.app.tar.gz.sig"; \
	else \
		echo "WARN: OTA updater tarball missing at $$UPDATER_TARBALL"; \
		echo "      Either TAURI_SIGNING_PRIVATE_KEY isn't set or the build"; \
		echo "      didn't produce updater artefacts. Mac users will not be"; \
		echo "      able to OTA-update from this version."; \
	fi; \
	echo ""; \
	echo "✓ v$(VERSION) released and uploaded"
	@$(MAKE) --no-print-directory update-manifest

## Build + upload `latest.json` (the Tauri OTA updater manifest) for
## the current version. Walks the release's assets, pairs each
## updater bundle with its `.sig` file, and emits the manifest shape
## the updater plugin expects. Idempotent — re-running just clobbers
## the existing latest.json.
##
## Usually invoked automatically as the final step of `local-release`.
## Run by hand when you've manually fixed up a release's assets.
update-manifest:
	@echo ""
	@echo "=== Assembling latest.json for v$(VERSION) ==="
	@node $(ROOT)/scripts/build-updater-manifest.mjs "v$(VERSION)" || { \
		echo "WARN: latest.json build failed (probably some platform's"; \
		echo "      .sig is missing). Re-run after CI finishes uploading."; \
		exit 0; \
	}

## Full ship: cut a GitHub release for the current version, then push
## libre.academy (site copy + /learn/ embed). The download buttons on
## the site fetch GitHub Releases at runtime, so step 1 is what
## "updates the download link" — step 2 just makes sure the embedded
## /learn/ build and any marketing copy you changed go live.
##
## Idempotent: `local-release` clobbers an existing release asset for the
## same version (so re-running after a hot-fix just replaces the DMG),
## and the site rsync uses --delete so stale assets get pruned.
##
## Skip the DMG step entirely with `make deploy-site` (e.g. when you only
## edited /learn/ source or marketing copy and there's nothing new to
## sign).
deploy: local-release deploy-site
	@echo ""
	@echo "✓ Libre v$(VERSION) shipped end-to-end."
	@echo "  Release: https://github.com/InfamousVague/Libre/releases/tag/v$(VERSION)"
	@echo "  Site:    https://libre.academy/"
	@echo "  Learn:   https://libre.academy/learn/"

## Site-only deploy: rebuild Libre for /learn/, build the academy
## site, rsync to VPS. Use after editing marketing copy or when the
## current version's release on GitHub is already up-to-date.
##
## The academy's deploy.mjs reads VPS_PASSWORD from this repo's
## api/.env automatically, so there's no extra credential setup.
##
## Note on blocks data: `npm run build:web` (which the academy's
## deploy.mjs runs) chains `starter:web → blocks:apply` so the
## staged course JSONs always carry blocks payloads, even though
## `extract-starter-courses` re-creates the directory from the
## blocks-free bundled .libre packs. Without that chain, every
## site deploy would silently ship a /learn/ build without blocks.
deploy-site:
	@echo "=== Deploying libre.academy (site + /learn/ embed) ==="
	@if [ ! -d "$(ACADEMY_ROOT)" ]; then \
		echo "ERROR: academy site not found at $(ACADEMY_ROOT)"; \
		echo "       Set ACADEMY_ROOT=/path/to/libre-academy and re-run,"; \
		echo "       or clone the academy repo there."; \
		exit 1; \
	fi
	@if [ ! -f "$(ROOT)/api/.env" ]; then \
		echo "WARN: api/.env missing — academy deploy.mjs will prompt you for"; \
		echo "      VPS_SSH_PASSWORD. Set it in env or in api/.env to avoid the"; \
		echo "      prompt next time."; \
	fi
	cd "$(ACADEMY_ROOT)" && LIBRE_SRC="$(ROOT)" npm run deploy

# --- Audio + content deploy -----------------------------------------------
# Audio MP3s and the manifest live on the academy VPS at
# `/var/www/libre-academy/audio/`, served at
# https://libre.academy/audio/. They're independent of the academy
# site's webroot — `--exclude=audio/` in the academy's deploy rsync
# means a `make deploy-site` won't touch them — so audio gets its own
# pipeline.
#
# Two-step flow because the inputs come from two places:
#   1. `audio-import`  — pull MP3s sitting in $FROM (default ~/Desktop)
#                        into dist/audio/ and rebuild dist/audio/manifest.json
#                        by hashing each lesson body and matching against the
#                        on-disk MP3 filenames. No ElevenLabs API calls.
#   2. `audio-upload`  — rsync dist/audio/ to the VPS via
#                        scripts/upload-lesson-audio.mjs.
#
# `make audio-deploy` chains both. Override the source dir with
# `make audio-deploy FROM=/path/to/dir` if your audio isn't on Desktop.
FROM ?= $(HOME)/Desktop

## Pull local MP3s into dist/audio/ + rebuild the manifest. Idempotent;
## skipped lessons (body changed since synthesis, or never synthesised)
## are reported but don't fail the run.
audio-import:
	cd $(ROOT) && node scripts/import-local-audio.mjs --from "$(FROM)"

## Rsync dist/audio/ → the academy VPS. Uses sshpass with the same
## VPS_PASSWORD chain as the site deploy. Needs `make audio-import`
## (or a prior generate run) to have populated dist/audio/ first.
audio-upload:
	cd $(ROOT) && node scripts/upload-lesson-audio.mjs

## Audio sync end-to-end: import + upload.
audio-deploy: audio-import audio-upload
	@echo ""
	@echo "✓ Audio synced — verify: curl -I https://libre.academy/audio/manifest.json"

## Generate ElevenLabs MP3s for the guided-tour steps.
## Reads `src/components/Tour/tourSteps.json`, synthesises one MP3
## per step into `public/tour-audio/<stepId>.<sha7>.mp3`, and writes
## the bundled manifest the runtime player reads. Idempotent —
## unchanged step text is a cache hit. The MP3s ship with the app
## bundle (no separate upload step) so the tour works offline on
## first launch. Costs a few cents in ElevenLabs credits per full
## run; nothing per re-run when the body text is unchanged.
tour-audio:
	cd $(ROOT) && node scripts/generate-tour-audio.mjs

## Full content deploy: audio (manifest + MP3s) AND the academy site
## (course JSONs with blocks + /learn/ embed). One command, idempotent.
## Use after editing audio, course content, marketing copy, or any
## combination of the three. Skips the desktop binary — for that, run
## `make local-release` separately (it's much slower and rarely needed
## on a content-only push).
deploy-content: audio-deploy deploy-site
	@echo ""
	@echo "✓ Content deployed — audio + academy site live at https://libre.academy/"

## Remove build artifacts
clean:
	rm -rf $(TAURI)/target/release/bundle
	@echo "Cleaned"

# --- iOS phone + watch device runner ---------------------------------------
# `make run`         — pick iPhone + Watch, build/install/launch both
# `make run-phone`   — phone only
# `make run-watch`   — watch only
# `make pick-phone`  / `make pick-watch` — refresh selection without building
# `make run-clean`   — drop the cached selection
#
# Picks are cached in .libre-devices.cache (gitignored). The first run on
# a fresh checkout always prompts; subsequent runs prompt "Use last? (Y/n)".

pick-phone:
	@bash $(ROOT)/scripts/pick-device.sh phone --reuse

pick-watch:
	@bash $(ROOT)/scripts/pick-device.sh watch --reuse

run-clean:
	@rm -f $(DEVICE_CACHE) && echo "Cleared $(DEVICE_CACHE)"

# When `make run` invokes us via sub-make, it already picked both devices —
# avoid prompting "Use last?" again. The standalone case has FB_SKIP_PICK
# unset, so the picker still runs.
# `make release-phone` — install a RELEASE-mode build on the user's
# physical iPhone/iPad. Same flow as `run-phone` (pick device, build,
# install via devicectl, launch) but drops `--debug` so the resulting
# binary is smaller, faster, and ships without the debug symbol bloat.
# The signed app stays installed for the validity window of your
# provisioning profile (7 days on a free Apple ID, ~1 year on a paid
# Developer account) — re-run this target before that window closes
# to refresh, or set up TestFlight if you want the install to never
# expire.
#
# `tauri ios build` always rebuilds the web bundle via the
# `beforeBuildCommand` in tauri.conf.json, so dist/ is fresh on each
# invocation — no manual `npm run build` step needed first.
## Mobile ship: redeploy libre.academy AND install a fresh release-mode
## build on the connected iPhone in one command. Use after a code change
## that affects BOTH the iPad/web path (which loads from the deployed
## site) AND the native iOS app — so a single invocation lands the new
## bits on every mobile surface.
##
## Audio is intentionally NOT touched. `make audio-deploy` covers that
## flow when audio actually changed; bundling it here would slow the
## common case (UI tweak, refresh both surfaces) for no reason. Pair
## the two when you've changed audio + UI:
##   make audio-deploy && make ship-phone
ship-phone: deploy-site release-phone
	@echo ""
	@echo "✓ Mobile shipped end-to-end."
	@echo "  Site:    https://libre.academy/"
	@echo "  Embed:   https://libre.academy/learn/"
	@echo "  Phone:   release-mode v$(VERSION) installed on the cached iPhone"

release-phone:
	@bash $(ROOT)/scripts/pick-device.sh phone --reuse
	@set -eu; \
	. $(DEVICE_CACHE); \
	echo ""; \
	echo "=== Phone (release): $$IPHONE_NAME ($$IPHONE_KIND/$$IPHONE_UDID) ==="; \
	if [ "$$IPHONE_KIND" = "sim" ]; then \
		echo "ERROR: release-phone is for physical devices only"; \
		echo "       (simulator builds don't gain anything from --release"; \
		echo "       and the install path differs from devicectl)."; \
		echo "       Use 'make run-phone' against a sim instead."; \
		exit 1; \
	fi; \
	echo "--- tauri ios build (device, release) ---"; \
	cd $(ROOT) && $(TAURI_ENV) tauri ios build --target aarch64; \
	APP=""; \
	for cand in \
		"$(TAURI)/gen/apple/build/arm64/Libre.app" \
		"$(TAURI)/gen/apple/build/libre_iOS.xcarchive/Products/Applications/Libre.app"; do \
		if [ -d "$$cand" ]; then APP="$$cand"; echo "Found .app: $$cand"; break; fi; \
	done; \
	if [ -z "$$APP" ]; then \
		IPA="$(TAURI)/gen/apple/build/arm64/Libre.ipa"; \
		if [ -f "$$IPA" ]; then \
			echo "--- no .app found; extracting from $$IPA ---"; \
			EXTRACT_DIR="$(TAURI)/gen/apple/build/arm64/_ipa-extract"; \
			rm -rf "$$EXTRACT_DIR"; mkdir -p "$$EXTRACT_DIR"; \
			unzip -q -o "$$IPA" -d "$$EXTRACT_DIR"; \
			APP=$$(ls -d "$$EXTRACT_DIR"/Payload/*.app 2>/dev/null | head -1); \
			[ -d "$$APP" ] && echo "Extracted .app: $$APP"; \
		fi; \
	fi; \
	if [ -z "$$APP" ] || [ ! -d "$$APP" ]; then \
		echo "ERROR: no Libre.app or .ipa produced under $(TAURI)/gen/apple/build/."; \
		echo "Build likely failed — scroll up for tauri/xcodebuild errors."; \
		echo "If signing failed, open src-tauri/gen/apple/libre.xcodeproj in Xcode,"; \
		echo "let it auto-resolve provisioning, then re-run this target."; \
		exit 1; \
	fi; \
	echo "--- devicectl install + launch ---"; \
	xcrun devicectl device install app --device "$$IPHONE_UDID" "$$APP"; \
	xcrun devicectl device process launch --device "$$IPHONE_UDID" --terminate-existing $(PHONE_BUNDLE_ID); \
	echo ""; \
	echo "✓ Libre (release) installed on $$IPHONE_NAME — usable independent of this Mac."; \
	echo "  Provisioning expires per your Apple Developer account's policy"; \
	echo "  (free: 7 days / paid team $(TEAM_ID): ~1 year). Re-run 'make release-phone'"; \
	echo "  to refresh before that window closes."

run-phone: $(if $(FB_SKIP_PICK),,pick-phone)
	@set -eu; \
	. $(DEVICE_CACHE); \
	echo ""; \
	echo "=== Phone: $$IPHONE_NAME ($$IPHONE_KIND/$$IPHONE_UDID) ==="; \
	if [ "$$IPHONE_KIND" = "sim" ]; then \
		echo "--- tauri ios build (sim) ---"; \
		cd $(ROOT) && $(TAURI_ENV) tauri ios build --target aarch64-sim --debug; \
		APP="$(TAURI)/gen/apple/build/arm64-sim/Libre.app"; \
		echo "--- boot + install + launch ---"; \
		xcrun simctl boot "$$IPHONE_UDID" 2>/dev/null || true; \
		open -a Simulator; \
		xcrun simctl install "$$IPHONE_UDID" "$$APP"; \
		xcrun simctl launch "$$IPHONE_UDID" $(PHONE_BUNDLE_ID); \
	else \
		echo "--- tauri ios build (device) ---"; \
		cd $(ROOT) && $(TAURI_ENV) tauri ios build --target aarch64 --debug; \
		APP=""; \
		for cand in \
			"$(TAURI)/gen/apple/build/arm64/Libre.app" \
			"$(TAURI)/gen/apple/build/libre_iOS.xcarchive/Products/Applications/Libre.app"; do \
			if [ -d "$$cand" ]; then APP="$$cand"; echo "Found .app: $$cand"; break; fi; \
		done; \
		if [ -z "$$APP" ]; then \
			IPA="$(TAURI)/gen/apple/build/arm64/Libre.ipa"; \
			if [ -f "$$IPA" ]; then \
				echo "--- no .app found; extracting from $$IPA ---"; \
				EXTRACT_DIR="$(TAURI)/gen/apple/build/arm64/_ipa-extract"; \
				rm -rf "$$EXTRACT_DIR"; mkdir -p "$$EXTRACT_DIR"; \
				unzip -q -o "$$IPA" -d "$$EXTRACT_DIR"; \
				APP=$$(ls -d "$$EXTRACT_DIR"/Payload/*.app 2>/dev/null | head -1); \
				[ -d "$$APP" ] && echo "Extracted .app: $$APP"; \
			fi; \
		fi; \
		if [ -z "$$APP" ] || [ ! -d "$$APP" ]; then \
			echo "ERROR: no Libre.app or .ipa produced under $(TAURI)/gen/apple/build/."; \
			echo "Build likely failed — scroll up for tauri/xcodebuild errors,"; \
			echo "or try 'tauri ios dev --target $$IPHONE_UDID' for a guided run."; \
			exit 1; \
		fi; \
		echo "--- devicectl install + launch ---"; \
		xcrun devicectl device install app --device "$$IPHONE_UDID" "$$APP"; \
		xcrun devicectl device process launch --device "$$IPHONE_UDID" --terminate-existing $(PHONE_BUNDLE_ID); \
	fi; \
	echo "✓ Phone launched."

run-watch: $(if $(FB_SKIP_PICK),,pick-watch)
	@set -eu; \
	. $(DEVICE_CACHE); \
	echo ""; \
	echo "=== Watch: $$WATCH_NAME ($$WATCH_KIND/$$WATCH_UDID) ==="; \
	cd $(WATCH_ROOT); \
	if [ "$$WATCH_KIND" = "sim" ]; then \
		echo "--- xcodebuild (watchOS sim) ---"; \
		xcodebuild -project LibreWatch.xcodeproj -scheme LibreWatch \
			-destination "platform=watchOS Simulator,id=$$WATCH_UDID" \
			-configuration Debug -derivedDataPath build/DerivedData \
			build CODE_SIGNING_ALLOWED=NO | tail -40; \
		APP="$(WATCH_ROOT)/build/DerivedData/Build/Products/Debug-watchsimulator/LibreWatch.app"; \
		echo "--- boot + install + launch ---"; \
		xcrun simctl boot "$$WATCH_UDID" 2>/dev/null || true; \
		open -a Simulator; \
		xcrun simctl install "$$WATCH_UDID" "$$APP"; \
		xcrun simctl launch "$$WATCH_UDID" $(WATCH_BUNDLE_ID); \
	else \
		echo "--- xcodebuild (watchOS device, signed) ---"; \
		xcodebuild -project LibreWatch.xcodeproj -scheme LibreWatch \
			-destination "platform=watchOS,id=$$WATCH_UDID" \
			-configuration Debug -derivedDataPath build/DerivedData \
			build | tail -40; \
		APP="$(WATCH_ROOT)/build/DerivedData/Build/Products/Debug-watchos/LibreWatch.app"; \
		if [ ! -d "$$APP" ]; then \
			echo "ERROR: $$APP not found. Check signing settings (DEVELOPMENT_TEAM=F6ZAL7ANAD)."; \
			exit 1; \
		fi; \
		echo "--- devicectl install + launch ---"; \
		xcrun devicectl device install app --device "$$WATCH_UDID" "$$APP"; \
		xcrun devicectl device process launch --device "$$WATCH_UDID" --terminate-existing $(WATCH_BUNDLE_ID); \
	fi; \
	echo "✓ Watch launched."

# `run` chains both pickers up-front (so all prompts happen before any build),
# then delegates to the per-target recipes with FB_SKIP_PICK=1 so they don't
# re-prompt for the same selection.
run:
	@bash $(ROOT)/scripts/pick-device.sh phone --reuse
	@bash $(ROOT)/scripts/pick-device.sh watch --reuse
	@$(MAKE) --no-print-directory FB_SKIP_PICK=1 run-phone
	@$(MAKE) --no-print-directory FB_SKIP_PICK=1 run-watch

# `run-split` picks both devices in this window, then spawns each build into
# its own Terminal/iTerm window so phone + watch logs stream side-by-side.
# Set FB_TERM=iterm or FB_TERM=terminal to override auto-detection.
run-split:
	@bash $(ROOT)/scripts/pick-device.sh phone --reuse
	@bash $(ROOT)/scripts/pick-device.sh watch --reuse
	@bash $(ROOT)/scripts/run-split.sh

help:
	@echo "Build / release targets:"
	@echo "  make              — full pipeline: build → sign → notarize → install"
	@echo "  make build        — Tauri release build"
	@echo "  make sign         — post-build signing (no rebuild)"
	@echo "  make notarize     — notarize + staple DMG"
	@echo "  make install      — install to /Applications"
	@echo "  make release      — bump patch ($(VERSION) → next), tag, push (no build)"
	@echo "  make local-release — full local build + sign + notarize + upload to GitHub"
	@echo ""
	@echo "Web deploy targets (libre.academy):"
	@echo "  make deploy         — local-release + rsync site + /learn/ to VPS"
	@echo "  make deploy-site    — site + /learn/ (course JSONs + blocks); no DMG"
	@echo "  make deploy-content — audio + site in one shot (no DMG)"
	@echo "  make audio-deploy   — audio only (import from \$$FROM + upload to VPS)"
	@echo "  make audio-import   — pull MP3s from ~/Desktop into dist/audio/"
	@echo "  make audio-upload   — rsync dist/audio/ → VPS"
	@echo "  make tour-audio     — synthesise guided-tour narration MP3s (bundled, ~3min)"
	@echo ""
	@echo "iOS / watchOS run targets (interactive device picker):"
	@echo "  make run          — pick + run phone AND watch (sequential, this window)"
	@echo "  make run-split    — pick + run phone AND watch in two new terminal windows"
	@echo "  make run-phone    — pick + run phone only"
	@echo "  make run-watch    — pick + run watch only"
	@echo "  make pick-phone   — refresh phone selection only"
	@echo "  make pick-watch   — refresh watch selection only"
	@echo "  make run-clean    — drop the cached device selection"
	@echo "  make release-phone — RELEASE-mode build, installed to phone for everyday use"
	@echo "  make ship-phone   — deploy-site + release-phone in one shot"
