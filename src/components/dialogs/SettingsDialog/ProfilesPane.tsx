/// Settings → Profiles. Manage the local profiles defined in the
/// backend registry: switch (one-click, seamless reload), create,
/// rename, delete. Each profile is a fully isolated data root —
/// separate courses, progress, sandbox projects, achievements,
/// certificates, settings, and (hybrid model) its own cloud
/// sign-in.
///
/// Switching calls `useProfiles().switchTo`, which has the backend
/// re-point the data root then reloads the webview — so there's no
/// manual relaunch and no stale in-memory state carried across.

import { useState } from "react";
import { Icon } from "@base/primitives/icon";
import { users } from "@base/primitives/icon/icons/users";
import { plus } from "@base/primitives/icon/icons/plus";
import { check } from "@base/primitives/icon/icons/check";
import { pencil } from "@base/primitives/icon/icons/pencil";
import { trash2 } from "@base/primitives/icon/icons/trash-2";
import "@base/primitives/icon/icon.css";

import SettingsCard, { SettingsPage } from "./SettingsCard";
import { useProfiles } from "../../../hooks/useProfiles";
import { isWeb } from "../../../lib/platform";
import { useT } from "../../../i18n/i18n";
import { DEFAULT_PROFILE_ID } from "../../../lib/profileStore";
import "./ProfilesPane.css";

export default function ProfilesPane() {
  const t = useT();
  const { profiles, activeId, loading, error, create, rename, remove, switchTo } =
    useProfiles();

  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  async function handleCreate() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    const meta = await create(name);
    setCreating(false);
    if (meta) {
      setNewName("");
      // Offer to jump straight into the new (empty) profile.
      await switchTo(meta.id);
    }
  }

  async function commitRename(id: string) {
    const name = renameValue.trim();
    if (name) await rename(id, name);
    setRenamingId(null);
  }

  return (
    <SettingsPage
      title={t("settings.profilesTitle")}
      description={t("settings.profilesDescription")}
    >
      {isWeb ? (
        <SettingsCard title={t("settings.profilesTitle")}>
          <div className="libre-profiles__web-note">
            {t("settings.profilesWebNote")}
          </div>
        </SettingsCard>
      ) : (
        <>
          <SettingsCard title={t("settings.profilesYours")}>
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
                  const renaming = renamingId === p.id;
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
                        <Icon icon={users} size="sm" color="currentColor" />
                      </span>

                      {renaming ? (
                        <input
                          className="libre-profiles__rename-input"
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void commitRename(p.id);
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          onBlur={() => void commitRename(p.id)}
                          aria-label={t("settings.profilesRename")}
                        />
                      ) : (
                        <span className="libre-profiles__name">
                          {p.name}
                          {p.cloud_account_id && (
                            <span
                              className="libre-profiles__cloud"
                              title={t("settings.profilesCloudBound")}
                            >
                              ☁
                            </span>
                          )}
                        </span>
                      )}

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

                      <button
                        type="button"
                        className="libre-profiles__icon-btn"
                        title={t("settings.profilesRename")}
                        aria-label={t("settings.profilesRename")}
                        onClick={() => {
                          setRenamingId(p.id);
                          setRenameValue(p.name);
                        }}
                      >
                        <Icon
                          icon={pencil}
                          size="xs"
                          color="currentColor"
                        />
                      </button>

                      {/* Default can't be deleted (backend enforces
                          this too); deleting the active profile is
                          allowed — the backend falls back to Default
                          and the hook reloads. Two-tap confirm. */}
                      {!isDefault &&
                        (confirmDeleteId === p.id ? (
                          <button
                            type="button"
                            className="libre-profiles__btn libre-profiles__btn--danger"
                            onClick={() => void remove(p.id)}
                          >
                            {t("settings.profilesDeleteConfirm")}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="libre-profiles__icon-btn libre-profiles__icon-btn--danger"
                            title={t("settings.profilesDelete")}
                            aria-label={t("settings.profilesDelete")}
                            onClick={() => setConfirmDeleteId(p.id)}
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

          <SettingsCard title={t("settings.profilesCreate")}>
            <div className="libre-profiles__create">
              <input
                className="libre-profiles__create-input"
                value={newName}
                placeholder={t("settings.profilesCreatePlaceholder")}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreate();
                }}
                aria-label={t("settings.profilesCreatePlaceholder")}
              />
              <button
                type="button"
                className="libre-profiles__btn libre-profiles__btn--primary"
                onClick={() => void handleCreate()}
                disabled={!newName.trim() || creating}
              >
                <Icon icon={plus} size="xs" color="currentColor" />
                {t("settings.profilesCreate")}
              </button>
            </div>
            <div className="libre-profiles__hint">
              {t("settings.profilesCreateHint")}
            </div>
          </SettingsCard>
        </>
      )}
    </SettingsPage>
  );
}
