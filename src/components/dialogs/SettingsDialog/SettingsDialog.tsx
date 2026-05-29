import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "@base/primitives/icon";
import { check as checkIcon } from "@base/primitives/icon/icons/check";
import { x as xIcon } from "@base/primitives/icon/icons/x";
import "@base/primitives/icon/icon.css";
import {
  applyTheme,
  loadTheme,
  THEMES,
  type ThemeName,
} from "../../../theme/themes";
import { resetAccount } from "../../../lib/resetAccount";
import { isMobile } from "../../../lib/platform";
import { useT } from "../../../i18n/i18n";
import type { UseLibreCloud } from "../../../hooks/useLibreCloud";
import type { RealtimeSyncHandle } from "../../../hooks/useRealtimeSync";
import type { Completion } from "../../../hooks/useProgress";
import type { Course } from "../../../data/types";
import ModalBackdrop from "../../Shared/ModalBackdrop";
import AccountSection from "./AccountSection";
import AiPane from "./AiPane";
import DeveloperPane from "./DeveloperPane";
import ProfilesPane from "./ProfilesPane";
import GeneralPane from "./GeneralPane";
import ShortcutsPane from "./ShortcutsPane";
import SoundPane from "./SoundPane";
import HapticsPane from "./HapticsPane";
import DataPane from "./DataPane";
import ThemePane from "./ThemePane";
import SettingsNav, { deriveUserDisplay } from "./SettingsNav";
import { describeAuthProvider } from "./helpers";
import { PANES, type PaneId } from "./panes";
import "./SettingsDialog.css";

interface Props {
  onDismiss: () => void;
  /// Cloud-sync hook instance (shared with App.tsx). Used to render
  /// the Account section. Required — SettingsDialog is only ever
  /// rendered inside App where `cloud` is in scope, so we don't
  /// bother making it optional.
  cloud: UseLibreCloud;
  /// Realtime sync hook handle (also from App.tsx). Drives the
  /// Sync section's status badge, pending-push counter, manual
  /// resync button, and diff view.
  realtime?: RealtimeSyncHandle;
  /// Local completion history. Source of truth for the "On this
  /// device" column of the Sync diff. Optional so the dialog still
  /// renders when called from a surface that doesn't have it.
  history?: readonly Completion[];
  /// Live course list — used to format Sync diff entries with
  /// "Course Title · Lesson Title" instead of raw IDs. Optional.
  courses?: readonly Course[];
  /// Open the sign-in modal. Wired from App.tsx so the Account
  /// section can offer a "Sign in" CTA to signed-out users without
  /// each section having to know about the modal-state plumbing.
  ///
  /// Optional: omitted on the web build, where OAuth has no path
  /// (Tauri-only). When undefined we hide the Account section's
  /// sign-in CTA entirely.
  onRequestSignIn?: () => void;
}

interface Settings {
  anthropic_api_key: string | null;
  anthropic_model: string;
  openai_api_key: string | null;
}

// Legacy `SectionId` is now an alias for the data-driven `PaneId`
// exported from ./panes. Kept under the old name in this file so
// the existing `section === "data"` ladder in the render switch
// below doesn't have to change. New code should reach for `PaneId`
// from panes.ts directly.
type SectionId = PaneId;

/// Two-column settings dialog with a left-rail section nav and a right-side
/// scrollable pane. Keeps the panel at a bounded max-height so additional
/// sections never push the Save button off the screen.
export default function SettingsDialog({
  onDismiss,
  cloud,
  realtime,
  history,
  courses,
  onRequestSignIn,
}: Props) {
  const t = useT();
  const [section, setSection] = useState<SectionId>("general");
  const [apiKey, setApiKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [model, setModel] = useState<string>("claude-sonnet-4-8");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // (Sync-courses state moved to DataPane along with the manual-
  // sync row. The dialog used to host both the state and the
  // syncCourses() helper inline when "Data" was its own pane;
  // collapsing into the combined Data & storage pane co-locates
  // everything sync-related in one component.)
  const [theme, setTheme] = useState<ThemeName>(() => loadTheme());
  // Account-section state. `confirmDeleteAccount` follows the same
  // two-tap-confirm pattern that the consolidated "Start fresh"
  // affordance uses so the destructive-action UX is consistent
  // across the dialog.
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  // Account is always in the rail — when signed out the section
  // shows a sign-in CTA so the entry point is discoverable before
  // the learner has an account. The `hint` text on the pane definition
  // swaps to a sign-in nudge so the rail entry reads useful even
  // for a signed-out learner.
  //
  // Web build: drop the rail entry entirely. There's nothing to do
  // in the Account section without a sign-in path, and showing an
  // empty pane is worse than not advertising it.
  const accountAvailable = !!onRequestSignIn || cloud.signedIn;

  // Developer-pane gate. The Developer entry stays hidden until the
  // user taps the version-number chip in the rail footer 10× in
  // quick succession (the Android-style easter egg). Once unlocked,
  // we persist the flag in localStorage so subsequent opens of the
  // dialog show the pane without re-tapping. Cleared only by hand
  // (no in-UI relock — once a learner has found the gate, they've
  // earned the entry).
  const [devUnlocked, setDevUnlocked] = useState<boolean>(() => {
    try {
      return localStorage.getItem("libre:devUnlocked") === "1";
    } catch {
      return false;
    }
  });
  // Tap-counter state for the version-number gesture. Held in a
  // ref (not state) because we don't want every tap to re-render
  // the dialog — only the 10th tap should flip `devUnlocked` and
  // surface the pane. 5-second window resets the counter on idle.
  const versionTapRef = useRef<{ count: number; firstAt: number }>({
    count: 0,
    firstAt: 0,
  });
  const onVersionTap = () => {
    if (devUnlocked) return;
    const now = Date.now();
    const TAPS_NEEDED = 10;
    const WINDOW_MS = 5000;
    const s = versionTapRef.current;
    if (now - s.firstAt > WINDOW_MS) {
      s.count = 1;
      s.firstAt = now;
    } else {
      s.count += 1;
    }
    if (s.count >= TAPS_NEEDED) {
      setDevUnlocked(true);
      try {
        localStorage.setItem("libre:devUnlocked", "1");
      } catch {
        /* private mode / quota — pane unlocks for this session only */
      }
      s.count = 0;
    }
  };

  const visiblePanes = useMemo(() => {
    return PANES.filter((p) => {
      if (p.id === "account" && !accountAvailable) return false;
      if (p.id === "developer" && !devUnlocked) return false;
      // Hide the Haptics pane on desktop — taptic feedback only
      // exists on iOS / phone-form-factor surfaces where the
      // hardware actually wires up to the OS. On macOS / Windows /
      // Linux every cue would no-op, so showing the pane is just
      // dead controls.
      if (p.id === "haptics" && !isMobile) return false;
      return true;
    }).map((p) => {
      // Swap the Account pane's hint when signed out so the rail
      // entry advertises the sign-in CTA the body will render.
      if (p.id === "account" && !cloud.signedIn) {
        return { ...p, hint: t("settings.signInToSync") };
      }
      return p;
    });
  }, [accountAvailable, cloud.signedIn, devUnlocked, t]);

  // If the active section disappears (e.g. user signs out while the
  // dialog is open), fall back to General so we don't render a
  // dangling section pointer with no nav entry.
  useEffect(() => {
    if (!visiblePanes.find((p) => p.id === section)) {
      setSection("general");
    }
  }, [visiblePanes, section]);

  // Derived nav-rail metadata: user profile tile, app version, and
  // the active theme's display label for the rail footer chip.
  // Reading the version is async (Tauri's `getVersion`); we lazy-
  // load the plugin on first mount so the web build doesn't choke
  // on the import.
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const v = await getVersion();
        if (!cancelled) setAppVersion(v);
      } catch {
        /* web build / Tauri unavailable — leave null, footer shortens */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const userDisplay = useMemo(() => {
    if (!cloud.signedIn || typeof cloud.user !== "object" || !cloud.user) {
      return null;
    }
    const providerLabel = describeAuthProvider(cloud.user);
    return deriveUserDisplay(cloud.user, providerLabel, t("settings.signedIn"));
  }, [cloud.signedIn, cloud.user, t]);
  const themeLabel = useMemo(
    () => THEMES.find((t) => t.id === theme)?.label ?? null,
    [theme],
  );

  function handleThemeChange(next: ThemeName) {
    setTheme(next);
    applyTheme(next);
  }

  useEffect(() => {
    invoke<Settings>("load_settings")
      .then((s) => {
        setApiKey(s.anthropic_api_key ?? "");
        setOpenaiKey(s.openai_api_key ?? "");
        if (s.anthropic_model) setModel(s.anthropic_model);
      })
      .catch(() => { /* not in tauri — ignore */ });
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await invoke("save_settings", {
        settings: {
          anthropic_api_key: apiKey.trim() || null,
          anthropic_model: model,
          openai_api_key: openaiKey.trim() || null,
        },
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // `clearAllCourses` + `clearIngestCache` were removed 2026-05-10
  // when the four scattered destructive surfaces (this Data section,
  // the Developer pane's two reset rows) were folded into the single
  // "Start fresh" affordance under Settings → Account. See
  // lib/resetAccount.ts for the consolidated wipe path — it does
  // both `cache_clear` and per-course `delete_course` itself.

  /// Sync newly-bundled course packs into the local install.
  ///
  /// Calls the Rust `refresh_bundled_courses` command which re-runs the
  /// seed routine in force-refresh mode: any NEW pack that landed in
  /// the binary's bundled-packs/ since the last sync gets seeded, and
  /// any EXISTING pack the user still has installed gets re-extracted
  /// so lesson / drill / cover updates land. User-deleted packs stay
  /// deleted (we respect their choice).
  ///
  // syncCourses() helper moved to DataPane alongside the manual-
  // sync row that triggers it. Removing it from SettingsDialog
  // collapses ~40 lines of dialog-level state down to zero — the
  // dialog stays a router, the pane owns its own state.

  return (
    <ModalBackdrop onDismiss={onDismiss}>
      <div className="libre-settings-panel">
        {/* The old top dialog-header (`libre-settings-header`) is
            gone — the "Settings" title now lives inside the nav
            rail (top), matching Cipher's layout. Close button
            becomes a floating × in the panel's top-right corner
            so it's reachable without occupying a dedicated header
            strip. */}
        <button
          type="button"
          className="libre-settings-close-floating"
          onClick={onDismiss}
          aria-label={t("settings.closeAria")}
          title={t("settings.closeTitle")}
        >
          <Icon icon={xIcon} size="xs" color="currentColor" />
        </button>

        <div className="libre-settings-columns">
          <SettingsNav
            panes={visiblePanes}
            activeId={section}
            onPaneSelect={setSection}
            user={userDisplay}
            onProfileClick={() => setSection("account")}
            appVersion={appVersion}
            themeName={themeLabel}
            onVersionTap={onVersionTap}
          />

          <div className="libre-settings-body">
            {/* Migrated panes render their own page-level h2 via
                `SettingsPage`. Unmigrated panes (AiPane, SyncDebugPanel)
                still ship their own internal h3-styled titles. The
                old `libre-settings-body__header` strip that
                duplicated the active pane's title here was removed
                with the dialog-header refactor — Cipher doesn't
                have a body-header strip, and rendering the title
                twice on migrated panes read as a layout bug. */}

            {section === "general" && <GeneralPane />}

            {section === "ai" && (
              <AiPane
                apiKey={apiKey}
                onApiKeyChange={setApiKey}
                openaiKey={openaiKey}
                onOpenaiKeyChange={setOpenaiKey}
                model={model}
                onModelChange={setModel}
              />
            )}

            {section === "theme" && (
              <ThemePane theme={theme} onThemeChange={handleThemeChange} />
            )}
            {section === "sounds" && <SoundPane />}
            {section === "haptics" && <HapticsPane />}

            {section === "shortcuts" && <ShortcutsPane />}

            {section === "data" && (
              <DataPane
                cloud={cloud}
                realtime={realtime}
                history={history}
                courses={courses}
              />
            )}

            {section === "developer" && <DeveloperPane />}

            {section === "profiles" && <ProfilesPane />}

            {section === "account" &&
              onRequestSignIn &&
              !(cloud.signedIn && typeof cloud.user === "object" && cloud.user) && (
                <SignedOutAccountSection
                  cloud={cloud}
                  onRequestSignIn={() => {
                    onRequestSignIn();
                    onDismiss();
                  }}
                />
              )}

            {section === "account" && cloud.signedIn && typeof cloud.user === "object" && cloud.user && (
              <AccountSection
                user={cloud.user}
                signingOut={signingOut}
                deletingAccount={deletingAccount}
                confirmDeleteAccount={confirmDeleteAccount}
                onSignOut={async () => {
                  setSigningOut(true);
                  setError(null);
                  try {
                    await cloud.signOut();
                    // Close the dialog so the user doesn't sit on an
                    // Account section that no longer applies. Defer one
                    // tick so React unmounts cleanly.
                    onDismiss();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setSigningOut(false);
                  }
                }}
                onRequestDeleteConfirm={() => setConfirmDeleteAccount(true)}
                onCancelDelete={() => setConfirmDeleteAccount(false)}
                onConfirmDelete={async () => {
                  setDeletingAccount(true);
                  setError(null);
                  try {
                    await cloud.deleteAccount();
                    onDismiss();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                    setConfirmDeleteAccount(false);
                  } finally {
                    setDeletingAccount(false);
                  }
                }}
                cloud={cloud}
              />
            )}

            {error && <div className="libre-settings-error">{error}</div>}
          </div>
        </div>

        {/* Footer sits outside the scroll body so the Save button is always
            visible regardless of section length. Only the AI section has a
            committable field; on other sections the Save button is hidden
            to avoid implying unsaved state. */}
        <div className="libre-settings-footer">
          {saved && (
            <span className="libre-settings-saved">
              <Icon icon={checkIcon} size="xs" color="currentColor" />
              {t("settings.saved")}
            </span>
          )}
          {section === "ai" && (
            <button
              className="libre-settings-primary"
              onClick={save}
              disabled={saving}
            >
              {saving ? t("settings.saving") : t("settings.save")}
            </button>
          )}
          {section !== "ai" && (
            <span className="libre-settings-footer-hint">
              {t("settings.changesApplyImmediately")}
            </span>
          )}
        </div>
      </div>
    </ModalBackdrop>
  );
}

/// Signed-out variant of the Account pane. Renders the sign-in CTA
/// (the original surface) PLUS the same "Start fresh" affordance the
/// signed-in `<AccountSection>` exposes — local data is wipeable
/// regardless of cloud auth, and a learner who isn't signed in
/// shouldn't have to make an account just to reset progress on the
/// device they're holding. Two-tap confirm UX matches the signed-in
/// version exactly so the muscle memory transfers either way.
function SignedOutAccountSection({
  cloud,
  onRequestSignIn,
}: {
  cloud: UseLibreCloud;
  onRequestSignIn: () => void;
}) {
  const t = useT();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), 5000);
    return () => window.clearTimeout(id);
  }, [armed]);
  return (
    <section>
      <h3 className="libre-settings-section">{t("settings.account")}</h3>
      <p className="libre-settings-blurb">
        {t("settings.signedOutBlurb")}
      </p>
      <button
        type="button"
        className="libre-settings-primary"
        onClick={onRequestSignIn}
      >
        {t("auth.signIn")}
      </button>

      <div
        className="libre-settings-data-row"
        style={{ marginTop: 24 }}
      >
        <div>
          <div className="libre-settings-data-label">{t("settings.startFresh")}</div>
          <div className="libre-settings-data-hint">
            {armed
              ? t("settings.startFreshArmedBody")
              : busy
              ? msg ?? t("settings.resetting")
              : msg
              ? msg
              : t("settings.startFreshBody")}
          </div>
        </div>
        <button
          className="libre-settings-danger"
          disabled={busy}
          onClick={async () => {
            if (!armed) {
              setArmed(true);
              setMsg(null);
              return;
            }
            setArmed(false);
            setBusy(true);
            setMsg(t("settings.resetting"));
            try {
              const report = await resetAccount(cloud);
              setMsg(t("settings.resetReloading", { message: report.message }));
              setTimeout(() => window.location.reload(), 700);
            } catch (e) {
              setMsg(
                t("settings.resetFailed", {
                  error: e instanceof Error ? e.message : String(e),
                }),
              );
              setBusy(false);
            }
          }}
        >
          {busy ? t("settings.resetting") : armed ? t("settings.confirm") : t("settings.startFresh")}
        </button>
      </div>
    </section>
  );
}
