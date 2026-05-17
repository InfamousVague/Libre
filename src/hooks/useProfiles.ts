/// React surface over the backend profile registry
/// (src-tauri/src/profiles.rs). Profiles are a desktop feature; on
/// web this hook reports a single implicit "Default" and every
/// mutation is a no-op (there's no backend registry to talk to).
///
/// Switching is the "live hot-swap": the backend atomically
/// re-points the data root (reopens progress.sqlite, reloads
/// settings, re-seeds a fresh profile), we update the synchronous
/// key-namespace cache, then reload the webview. To the user it's
/// one click with no manual relaunch; under the hood every hook
/// re-initialises cleanly against the new profile instead of
/// carrying stale in-memory state.

import { useCallback, useEffect, useState } from "react";
import { isWeb } from "../lib/platform";
import {
  setActiveProfileIdCache,
  activeProfileId,
  DEFAULT_PROFILE_ID,
} from "../lib/profileStore";

export interface ProfileMeta {
  id: string;
  name: string;
  created_at: number;
  cloud_account_id: string | null;
}

interface Registry {
  active: string;
  profiles: ProfileMeta[];
}

const WEB_REGISTRY: Registry = {
  active: DEFAULT_PROFILE_ID,
  profiles: [
    {
      id: DEFAULT_PROFILE_ID,
      name: "Default",
      created_at: 0,
      cloud_account_id: null,
    },
  ],
};

async function invokeTauri<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export interface UseProfiles {
  profiles: ProfileMeta[];
  activeId: string;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (name: string) => Promise<ProfileMeta | null>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /// Switch + reload. Resolves only if the switch *failed* — on
  /// success the page is already reloading.
  switchTo: (id: string) => Promise<void>;
}

export function useProfiles(): UseProfiles {
  const [profiles, setProfiles] = useState<ProfileMeta[]>(
    isWeb ? WEB_REGISTRY.profiles : [],
  );
  const [activeId, setActiveId] = useState<string>(activeProfileId());
  const [loading, setLoading] = useState(!isWeb);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (isWeb) return;
    setLoading(true);
    setError(null);
    try {
      const reg = await invokeTauri<Registry>("list_profiles");
      setProfiles(reg.profiles);
      setActiveId(reg.active);
      // Reconcile the synchronous cache with the backend's
      // authoritative active id. If they disagree at boot (manual
      // registry edit, or delete-active fell back to Default) the
      // namespaced key constants were already resolved for the
      // STALE id this render — correct it and reload once so the
      // tree re-resolves against the right profile. The cache-write
      // guard prevents a reload loop (second boot agrees).
      if (reg.active !== activeProfileId()) {
        setActiveProfileIdCache(reg.active);
        window.location.reload();
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (name: string): Promise<ProfileMeta | null> => {
      if (isWeb) return null;
      try {
        const meta = await invokeTauri<ProfileMeta>("create_profile", {
          name,
        });
        await refresh();
        return meta;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    [refresh],
  );

  const rename = useCallback(
    async (id: string, name: string) => {
      if (isWeb) return;
      try {
        await invokeTauri("rename_profile", { id, name });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      if (isWeb) return;
      try {
        const nextActive = await invokeTauri<string>("delete_profile", {
          id,
        });
        // If we deleted the active profile the backend fell back to
        // Default and already re-pointed the data root — mirror
        // that on the frontend and reload so the namespaced keys
        // follow.
        if (nextActive !== activeProfileId()) {
          setActiveProfileIdCache(nextActive);
          window.location.reload();
          return;
        }
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  const switchTo = useCallback(async (id: string) => {
    if (isWeb || id === activeProfileId()) return;
    try {
      // Backend re-points progress.sqlite + settings + seeds a
      // fresh profile, all in this call.
      await invokeTauri("switch_profile", { id });
      // Update the synchronous namespace cache BEFORE reload so the
      // rebooted tree resolves localStorage / IndexedDB keys to the
      // new profile.
      setActiveProfileIdCache(id);
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return {
    profiles,
    activeId,
    loading,
    error,
    refresh,
    create,
    rename,
    remove,
    switchTo,
  };
}
