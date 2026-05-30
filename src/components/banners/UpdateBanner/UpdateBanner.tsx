// OTA update banner. On startup, asks the Tauri updater plugin to
// check the configured endpoint for a newer version. If one is
// available, surfaces a small floating banner offering to download
// + install. While the download is in flight, the banner shows
// progress; on completion, swaps the CTA to "Restart now" which
// applies the update and relaunches.
//
// Why a banner and not a modal: updates aren't blocking. The user
// can keep working through their lesson; the banner waits at the
// bottom-right with a low-intensity surface until they're ready.
//
// Where this gets imported: App.tsx mounts it once, top-level. It
// renders nothing while idle — only once an update is detected.
//
// Web build short-circuits to null. The updater plugin throws the
// moment it's invoked outside Tauri, so we gate the import via
// `isDesktop`.

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@base/primitives/icon";
import { downloadCloud } from "@base/primitives/icon/icons/download-cloud";
import { rotateCcw } from "@base/primitives/icon/icons/rotate-ccw";
import { x as xIcon } from "@base/primitives/icon/icons/x";
import "@base/primitives/icon/icon.css";
import { isDesktop } from "../../../lib/platform";
import { useT } from "../../../i18n/i18n";
import "./UpdateBanner.css";

/// Size of the polling interval for "check again" — once an hour is
/// generous; the user usually re-launches the app within that window
/// anyway. Set to 0 to disable polling.
const RECHECK_INTERVAL_MS = 60 * 60 * 1000;

/// localStorage key for remembered "user dismissed this version" so
/// re-mounting the app doesn't re-spam them. We DON'T persist across
/// versions — once a NEW version ships, the banner reappears.
const DISMISSED_KEY = "libre:update-banner-dismissed-version";

type State =
  | { kind: "idle" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; version: string; downloaded: number; total: number }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

interface UpdateBannerProps {
  /// Open the Settings dialog. Wired from App.tsx for two distinct
  /// flows that share one destination:
  ///   - `available` state: the primary "Open Settings" button hands
  ///     off to Settings → General with `autoCheckUpdates: true` so
  ///     the check-for-updates button there auto-fires the moment
  ///     the dialog mounts. Routing the download flow through that
  ///     surface avoids the floating banner trying to install
  ///     in-place (which fails opaquely when the manifest is
  ///     mid-rotation — see commit 282ef0b) and gives the learner
  ///     the richer Settings UI with release notes + progress.
  ///   - `ready` state: the post-install "Restart now" affordance
  ///     redirects into Settings → General's Restart button so the
  ///     canonical restart path is one place — per Notion issue
  ///     #a41bc772db92641f.
  /// Optional in both flows: when absent the banner falls back to
  /// in-place behaviour (download here / relaunch here).
  onOpenSettings?: (opts?: { autoCheckUpdates?: boolean }) => void;
}

export function UpdateBanner({
  onOpenSettings,
}: UpdateBannerProps = {}): React.ReactElement | null {
  // Web build never has the updater plugin. Bail early so the
  // dynamic import below doesn't even run.
  if (!isDesktop) return null;

  const t = useT();
  const [state, setState] = useState<State>({ kind: "idle" });
  const dismissedFor = useRef<string | null>(
    typeof localStorage !== "undefined"
      ? localStorage.getItem(DISMISSED_KEY)
      : null,
  );

  // Run the check on mount + on a recurring interval. Each check
  // dynamically imports the plugin so the web build can omit it
  // entirely (Vite tree-shakes the import out when isDesktop is
  // statically false at build time).
  useEffect(() => {
    let cancelled = false;
    const runCheck = async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (cancelled) return;
        if (!update) {
          setState({ kind: "idle" });
          return;
        }
        if (dismissedFor.current === update.version) {
          // User already said "not now" for this version. Stay
          // hidden until the next version ships.
          return;
        }
        setState({
          kind: "available",
          version: update.version,
          notes: update.body ?? "",
        });
      } catch (e) {
        // Network blip, GitHub 503, manifest temporarily missing.
        // Quietly swallow — we'll retry on the next interval.
        // Log so the maintainer can debug from devtools.
        // eslint-disable-next-line no-console
        console.warn("[updater] check failed:", e);
      }
    };
    void runCheck();
    if (RECHECK_INTERVAL_MS > 0) {
      const id = window.setInterval(runCheck, RECHECK_INTERVAL_MS);
      return () => {
        cancelled = true;
        window.clearInterval(id);
      };
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const onDownload = useCallback(async () => {
    if (state.kind !== "available") return;
    setState({
      kind: "downloading",
      version: state.version,
      downloaded: 0,
      total: 0,
    });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) {
        setState({ kind: "error", message: t("banners.updateNoLongerAvailable") });
        return;
      }
      // The downloadAndInstall API streams progress events. We use
      // them to animate the banner's progress bar.
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            setState({
              kind: "downloading",
              version: update.version,
              downloaded: 0,
              total,
            });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setState({
              kind: "downloading",
              version: update.version,
              downloaded,
              total,
            });
            break;
          case "Finished":
            setState({ kind: "ready", version: update.version });
            break;
        }
      });
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [state]);

  const onRestart = useCallback(async () => {
    // When the host provides an `onOpenSettings` hook, hand off to
    // the Settings → General "Restart now" button instead of
    // relaunching directly. This keeps the canonical restart
    // affordance in one place (the Settings pane has more space
    // for an "are you sure / what's about to happen" confirmation
    // surface, plus it's where the user goes when something looks
    // wrong with the update). Falls back to the direct relaunch
    // when no host wiring is present (e.g. legacy callers).
    if (onOpenSettings) {
      onOpenSettings();
      return;
    }
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      // If relaunch fails the user can quit + reopen manually. The
      // update is already staged on disk at this point, so the next
      // launch picks it up automatically.
      // eslint-disable-next-line no-console
      console.error("[updater] relaunch failed:", e);
    }
  }, [onOpenSettings]);

  /// Available-state primary action — instead of starting the install
  /// in-place (the old onDownload flow), redirect into Settings →
  /// General with autoCheckUpdates so the canonical check-for-updates
  /// button there fires immediately. Settings has progress UI +
  /// release-notes affordances the floating banner doesn't, and
  /// rerouting through it sidesteps the "install fails silently
  /// because the floating banner caught a stale manifest" failure
  /// mode that used to dead-end the upgrade flow.
  const onOpenInSettings = useCallback(() => {
    if (onOpenSettings) {
      onOpenSettings({ autoCheckUpdates: true });
      return;
    }
    // No host wiring — fall back to the direct download so the toast
    // doesn't become a dead button on legacy callers that haven't
    // been updated to the new flow yet.
    void onDownload();
  }, [onOpenSettings, onDownload]);

  const onDismiss = useCallback(() => {
    if (state.kind !== "available") {
      // Mid-download dismiss does the same — record dismissal of
      // the in-flight version so we don't badger them again.
    }
    const v =
      state.kind === "available" ||
      state.kind === "downloading" ||
      state.kind === "ready"
        ? state.version
        : null;
    if (v && typeof localStorage !== "undefined") {
      localStorage.setItem(DISMISSED_KEY, v);
      dismissedFor.current = v;
    }
    setState({ kind: "idle" });
  }, [state]);

  if (state.kind === "idle") return null;

  // Ready-state gets a louder treatment — pulse glow, larger surface,
  // top-centred so the AI orb in the bottom-right doesn't obscure it.
  // The download is finished and there's nothing to do BUT click
  // restart, so the banner shouldn't read like a passive notification.
  const readyMod =
    state.kind === "ready" ? " libre-update-banner--ready" : "";

  return (
    <div
      className={`libre-update-banner${readyMod}`}
      role="status"
      aria-live="polite"
    >
      <div className="libre-update-banner__icon" aria-hidden>
        <Icon
          icon={state.kind === "ready" ? rotateCcw : downloadCloud}
          size="sm"
          color="currentColor"
        />
      </div>
      <div className="libre-update-banner__body">
        {state.kind === "available" && (
          <>
            <div className="libre-update-banner__title">
              {t("banners.updateReady", { version: state.version })}
            </div>
            <div className="libre-update-banner__sub">
              {t("banners.updateReadySub")}
            </div>
          </>
        )}
        {state.kind === "downloading" && (
          <>
            <div className="libre-update-banner__title">
              {t("banners.updateDownloading", { version: state.version })}
            </div>
            <div className="libre-update-banner__progress" aria-hidden>
              <div
                className="libre-update-banner__progress-bar"
                style={{
                  width:
                    state.total > 0
                      ? `${Math.min(100, (state.downloaded / state.total) * 100)}%`
                      : "5%",
                }}
              />
            </div>
            <div className="libre-update-banner__sub">
              {state.total > 0
                ? t("banners.updateDownloadedFmt", {
                    done: formatBytes(state.downloaded),
                    total: formatBytes(state.total),
                  })
                : t("banners.updateDownloadedOnly", {
                    done: formatBytes(state.downloaded),
                  })}
            </div>
          </>
        )}
        {state.kind === "ready" && (
          <>
            <div className="libre-update-banner__title">
              {t("banners.updateInstalled", { version: state.version })}
            </div>
            <div className="libre-update-banner__sub">
              {t("banners.updateInstalledSub")}
            </div>
          </>
        )}
        {state.kind === "error" && (
          <>
            <div className="libre-update-banner__title">
              {t("banners.updateFailed")}
            </div>
            <div className="libre-update-banner__sub">{state.message}</div>
          </>
        )}
      </div>
      <div className="libre-update-banner__actions">
        {state.kind === "available" && (
          <button
            type="button"
            className="libre-update-banner__btn libre-update-banner__btn--primary"
            onClick={onOpenInSettings}
          >
            {t("banners.install")}
          </button>
        )}
        {state.kind === "ready" && (
          <button
            type="button"
            className="libre-update-banner__btn libre-update-banner__btn--primary libre-update-banner__btn--restart"
            onClick={() => void onRestart()}
            autoFocus
          >
            <Icon icon={rotateCcw} size="xs" color="currentColor" />
            <span>{t("banners.restartNow")}</span>
          </button>
        )}
        <button
          type="button"
          className="libre-update-banner__btn libre-update-banner__btn--ghost"
          onClick={onDismiss}
          aria-label={t("banners.dismiss")}
          title={t("banners.dismiss")}
        >
          <Icon icon={xIcon} size="xs" color="currentColor" />
        </button>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
