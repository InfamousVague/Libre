/// Settings → Accounts. Manage signed-in cloud accounts, each with
/// its own isolated local data root.
///
/// Mental model (the v1.3.16 reframe):
///   - "Local" is the permanent first row — the unauthed pool the
///     app boots into on a fresh install AND the migration target
///     for pre-profile single-pool installs. Can't be deleted.
///   - Every OTHER row is a signed-in cloud account. Adding one =
///     run the cloud sign-in flow; removing one = sign out + erase
///     that account's local data.
///
/// "Add account" path:
///   1. Create a placeholder profile ("Untitled account").
///   2. Switch to it — backend re-points the data root + reloads
///      the webview against the empty profile.
///   3. After reload, this pane sees the active profile has no
///      cloud binding → it surfaces an "Sign in to this account"
///      banner. `onRequestSignIn` (wired from App) opens the
///      SignInDialog. On success, `useLibreCloud.writeUser` calls
///      `set_profile_cloud_account` which auto-renames the
///      placeholder to the cloud user's display name.
///
/// Switching between existing accounts: same hot-swap reload the
/// previous Profiles UX used.

import { useEffect, useState } from "react";
import { Icon } from "@base/primitives/icon";
import { users } from "@base/primitives/icon/icons/users";
import { plus } from "@base/primitives/icon/icons/plus";
import { check } from "@base/primitives/icon/icons/check";
import { trash2 } from "@base/primitives/icon/icons/trash-2";
import "@base/primitives/icon/icon.css";

import SettingsCard, { SettingsPage } from "./SettingsCard";
import { useProfiles } from "../../../hooks/useProfiles";
import type { ProfileMeta } from "../../../hooks/useProfiles";
import { isWeb } from "../../../lib/platform";
import { useT } from "../../../i18n/i18n";
import { DEFAULT_PROFILE_ID } from "../../../lib/profileStore";
import type { UseLibreCloud } from "../../../hooks/useLibreCloud";
import "./ProfilesPane.css";

interface Props {
  cloud: UseLibreCloud;
  /// Open the SignInDialog (wired from App.tsx). Used by the
  /// "Sign in to this account" banner that appears when the
  /// active profile has no cloud binding yet.
  onRequestSignIn?: () => void;
}

/// Pull the most-presentable label for a row: cloud display name
/// > email > the profile's stored name > id-prefix fallback.
function rowLabel(p: ProfileMeta): string {
  if (p.cloud_display_name && p.cloud_display_name.trim().length > 0) {
    return p.cloud_display_name.trim();
  }
  if (p.cloud_email && p.cloud_email.trim().length > 0) {
    return p.cloud_email.trim();
  }
  if (p.name && p.name.trim().length > 0) return p.name.trim();
  return p.id.slice(0, 8);
}

/// One-glyph avatar for the row chip — first letter of the visible
/// label, uppercase. Default profile gets a generic globe-ish
/// stand-in via the bundled `users` icon (handled in the renderer).
function rowInitial(p: ProfileMeta): string {
  const label = rowLabel(p);
  const ch = label.charAt(0).toUpperCase();
  return /[A-Z0-9]/.test(ch) ? ch : "•";
}

export default function AccountsPane({ cloud, onRequestSignIn }: Props) {
  const t = useT();
  const { profiles, activeId, loading, error, create, remove, switchTo } =
    useProfiles();

  const [adding, setAdding] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const activeProfile = profiles.find((p) => p.id === activeId) ?? null;
  const activeNeedsSignIn =
    activeProfile !== null &&
    activeProfile.id !== DEFAULT_PROFILE_ID &&
    !activeProfile.cloud_account_id &&
    !cloud.signedIn;

  /// Auto-open the SignInDialog the first time the user lands on a
  /// freshly-added account that hasn't been signed in yet. Only
  /// fires once per render of this pane — the user can dismiss it
  /// and the banner stays in place as a re-entry.
  const [autoOpenedOnce, setAutoOpenedOnce] = useState(false);
  useEffect(() => {
    if (
      activeNeedsSignIn &&
      onRequestSignIn &&
      !autoOpenedOnce &&
      !cloud.busy
    ) {
      setAutoOpenedOnce(true);
      onRequestSignIn();
    }
  }, [activeNeedsSignIn, onRequestSignIn, autoOpenedOnce, cloud.busy]);

  async function handleAddAccount() {
    if (adding) return;
    setAdding(true);
    // Placeholder name; the backend auto-renames to the cloud
    // display name on first successful sign-in within this
    // profile (see profiles.rs::set_profile_cloud_account).
    const meta = await create(t("settings.accountsUntitled"));
    if (!meta) {
      setAdding(false);
      return;
    }
    // Switch to the new account — this reloads the webview, so
    // we don't ever come back from this await. The new session
    // sees `activeNeedsSignIn === true` and auto-opens SignInDialog.
    await switchTo(meta.id);
    setAdding(false);
  }

  return (
    <SettingsPage
      title={t("settings.accountsTitle")}
      description={t("settings.accountsDescription")}
    >
      {isWeb ? (
        <SettingsCard title={t("settings.accountsTitle")}>
          <div className="libre-profiles__web-note">
            {t("settings.accountsWebNote")}
          </div>
        </SettingsCard>
      ) : (
        <>
          {activeNeedsSignIn && onRequestSignIn && (
            <SettingsCard title={t("settings.accountsSignInBannerTitle")}>
              <div className="libre-profiles__web-note">
                {t("settings.accountsSignInBannerBody")}
              </div>
              <div className="libre-profiles__create">
                <button
                  type="button"
                  className="libre-profiles__btn libre-profiles__btn--primary"
                  onClick={onRequestSignIn}
                >
                  {t("settings.accountsSignInBannerButton")}
                </button>
              </div>
            </SettingsCard>
          )}

          <SettingsCard title={t("settings.accountsYours")}>
            {error && <div className="libre-profiles__error">{error}</div>}
            {loading ? (
              <div className="libre-profiles__loading">
                {t("common.loading")}
              </div>
            ) : (
              <ul className="libre-profiles__list">
                {profiles.map((p) => {
                  const isActive = p.id === activeId;
                  const isDefault = p.id === DEFAULT_PROFILE_ID;
                  const label = rowLabel(p);
                  const sub =
                    isDefault
                      ? t("settings.accountsLocalSub")
                      : p.cloud_email && p.cloud_email !== label
                        ? p.cloud_email
                        : p.cloud_account_id
                          ? t("settings.accountsCloudBound")
                          : t("settings.accountsNotSignedIn");
                  return (
                    <li
                      key={p.id}
                      className={
                        "libre-profiles__row" +
                        (isActive ? " libre-profiles__row--active" : "")
                      }
                    >
                      <span
                        className="libre-profiles__avatar"
                        aria-hidden
                      >
                        {isDefault ? (
                          <Icon
                            icon={users}
                            size="sm"
                            color="currentColor"
                          />
                        ) : (
                          <span style={{ fontWeight: 700 }}>
                            {rowInitial(p)}
                          </span>
                        )}
                      </span>

                      <span className="libre-profiles__name">
                        <span>{label}</span>
                        <span className="libre-profiles__cloud-sub">
                          {sub}
                        </span>
                      </span>

                      {isActive ? (
                        <span className="libre-profiles__active-pill">
                          <Icon
                            icon={check}
                            size="xs"
                            color="currentColor"
                          />
                          {t("settings.profilesActive")}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="libre-profiles__btn libre-profiles__btn--switch"
                          onClick={() => void switchTo(p.id)}
                        >
                          {t("settings.profilesSwitch")}
                        </button>
                      )}

                      {/* Local can't be removed (backend enforces).
                          Removing a cloud account = sign out +
                          erase its local data. Two-tap confirm
                          since the data wipe is destructive. */}
                      {!isDefault &&
                        (confirmRemoveId === p.id ? (
                          <button
                            type="button"
                            className="libre-profiles__btn libre-profiles__btn--danger"
                            onClick={() => void remove(p.id)}
                          >
                            {t("settings.accountsRemoveConfirm")}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="libre-profiles__icon-btn libre-profiles__icon-btn--danger"
                            title={t("settings.accountsRemove")}
                            aria-label={t("settings.accountsRemove")}
                            onClick={() => setConfirmRemoveId(p.id)}
                          >
                            <Icon
                              icon={trash2}
                              size="xs"
                              color="currentColor"
                            />
                          </button>
                        ))}
                    </li>
                  );
                })}
              </ul>
            )}
          </SettingsCard>

          <SettingsCard title={t("settings.accountsAddTitle")}>
            <div className="libre-profiles__create">
              <button
                type="button"
                className="libre-profiles__btn libre-profiles__btn--primary"
                onClick={() => void handleAddAccount()}
                disabled={adding}
              >
                <Icon icon={plus} size="xs" color="currentColor" />
                {adding
                  ? t("settings.accountsAdding")
                  : t("settings.accountsAdd")}
              </button>
            </div>
            <div className="libre-profiles__hint">
              {t("settings.accountsAddHint")}
            </div>
          </SettingsCard>
        </>
      )}
    </SettingsPage>
  );
}
