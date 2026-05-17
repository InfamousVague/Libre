/// Frontend half of the multi-profile feature: per-profile
/// namespacing of localStorage keys + the IndexedDB database name.
///
/// The backend (src-tauri/src/profiles.rs) already scopes the heavy
/// data — courses, progress.sqlite, sandbox projects, settings — by
/// rooting them under `profiles/<active>/`. This module scopes the
/// *frontend-only* per-user state that lives in the browser's
/// localStorage / IndexedDB (achievements, certificates, streak
/// shields, practice history, recents, saved lesson code, the
/// sandbox mirror, the cloud token, …).
///
/// ## Design
///
/// - **Default profile = unprefixed keys.** The backend migrates a
///   pre-profile single-pool install into the `default` profile;
///   mirroring that here means existing users' localStorage stays
///   exactly where it is — zero frontend migration, fully backwards
///   compatible. Only NON-default profiles get a `libre:p:<id>:`
///   prefix.
/// - **Synchronous.** Key constants are evaluated at module import
///   (`const KEY = profileKey("libre:…")`), before any async IPC
///   could resolve. So the active id is read synchronously from a
///   GLOBAL (never-prefixed) cache key, written whenever we learn
///   the real active id from the backend. The backend remains the
///   source of truth; this cache only exists so key resolution can
///   be synchronous at boot. A profile switch updates the cache and
///   then reloads the webview, so the next boot resolves every key
///   to the new profile.
/// - **Web build has no profiles.** Profiles are a desktop feature
///   (the registry + data-root live in the Rust backend). On web
///   `profileKey` is the identity function.

import { isWeb } from "./platform";

/// Global, NEVER-namespaced key holding the last-known active
/// profile id so `profileKey` can resolve synchronously at import
/// time. Authoritative value still comes from the backend's
/// `get_active_profile`; this is just the synchronous mirror.
const ACTIVE_CACHE_KEY = "libre:active-profile";

/// Matches the backend `profiles::DEFAULT_ID`. The default profile
/// is the migrated legacy pool and intentionally uses unprefixed
/// keys.
export const DEFAULT_PROFILE_ID = "default";

let cached: string | null = null;

/// The active profile id, resolved synchronously. Web is always the
/// single implicit default. Reads the cache once and memoises for
/// the lifetime of the page (a switch reloads the page, so the
/// memo is always fresh per profile session).
export function activeProfileId(): string {
  if (isWeb) return DEFAULT_PROFILE_ID;
  if (cached !== null) return cached;
  let id = DEFAULT_PROFILE_ID;
  try {
    const v = localStorage.getItem(ACTIVE_CACHE_KEY);
    if (v && /^[a-z0-9-]{1,64}$/.test(v)) id = v;
  } catch {
    /* private mode — fall back to default */
  }
  cached = id;
  return id;
}

/// Update the synchronous cache after the backend tells us the real
/// active id (boot reconcile) or right before a switch+reload. The
/// cache key is global so it's readable regardless of which profile
/// we're resolving for.
export function setActiveProfileIdCache(id: string): void {
  cached = id;
  try {
    localStorage.setItem(ACTIVE_CACHE_KEY, id);
  } catch {
    /* private mode — `activeProfileId` falls back to default */
  }
}

/// Namespace a per-user localStorage key for the active profile.
/// Identity for the default profile (backwards compatible) and on
/// web; `libre:p:<id>:<key>` for any named profile.
///
/// Only call this for keys that hold genuinely per-profile / earned
/// state (the `ACCOUNT_STATE_KEYS`-shaped set: achievements, certs,
/// streak, practice, recents, saved code, sandbox mirror, cloud
/// token). Global preferences (theme, sound, haptics, keybindings,
/// dev flags, banner dismissals, and the active-profile cache
/// itself) must stay unprefixed and shared across profiles.
export function profileKey(key: string): string {
  const id = activeProfileId();
  if (id === DEFAULT_PROFILE_ID) return key;
  return `libre:p:${id}:${key}`;
}

/// Per-profile IndexedDB database name (web build). Default keeps
/// the historical `libre-v1` so existing web users' data is
/// untouched; named profiles get a suffixed DB.
export function profileDbName(base: string): string {
  const id = activeProfileId();
  if (id === DEFAULT_PROFILE_ID) return base;
  return `${base}-p-${id}`;
}
