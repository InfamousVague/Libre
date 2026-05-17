import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { track } from "../lib/track";
import { profileKey } from "../lib/profileStore";
import { isWeb } from "../lib/platform";

/// Optional cloud-sync hook for the Libre relay.
///
/// All sync is opt-in. When the user hasn't signed in we behave
/// exactly like before — local SQLite + JSON only — so the app stays
/// fully usable without a network round-trip on every interaction.
///
/// State machine:
///   - bootstrap from localStorage (relay URL, token, cached user)
///   - calling `signIn*()` writes the token + user to localStorage
///   - signOut() clears everything (token revoked server-side too)
///   - `pushProgress` / `pullProgress` are no-ops without a token
///
/// The relay URL defaults to a sensible production endpoint but can
/// be overridden via the `LIBRE_RELAY_URL` Vite-time env var or
/// localStorage so test deploys can point at a staging host.

// Profile-scoped (hybrid model): each profile holds its OWN cloud
// session, so signing into account A under "Work" and account B
// under "Personal" keeps the two tokens/users isolated. The relay
// URL override is a developer/deployment preference, not per-user,
// so it stays global — pointing at a staging relay applies to
// every profile.
const TOKEN_KEY = profileKey("libre:cloud:token-v1");
const USER_KEY = profileKey("libre:cloud:user-v1");
const URL_OVERRIDE_KEY = "libre:cloud:url-override-v1";

/// Bind/unbind the active profile to a cloud account id in the
/// backend registry (hybrid model). Best-effort + desktop-only:
/// web has no profile registry, and a registry write failing must
/// never block sign-in. Fire-and-forget.
function bindProfileCloudAccount(accountId: string | null): void {
  if (isWeb) return;
  void (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const active = await invoke<string>("get_active_profile");
      await invoke("set_profile_cloud_account", {
        id: active,
        cloudAccountId: accountId,
      });
    } catch {
      /* registry unavailable / older binary — non-fatal */
    }
  })();
}

const DEFAULT_RELAY_URL = "https://api.libre.academy";

export interface LibreCloudUser {
  id: string;
  email: string | null;
  display_name: string | null;
  has_password: boolean;
  apple_linked: boolean;
  google_linked: boolean;
}

export interface ProgressRow {
  course_id: string;
  lesson_id: string;
  /// ISO 8601 timestamp.
  completed_at: string;
}

export interface SolutionRow {
  course_id: string;
  lesson_id: string;
  /// JSON-stringified array of files for multi-file lessons, or the
  /// raw editor content for single-file harnesses. The hook keeps
  /// this opaque — callers serialize / deserialize at their layer.
  content: string;
  language?: string;
  updated_at: string;
}

export interface SettingRow {
  key: string;
  /// JSON-encoded value. Stays a string on the wire so the table is
  /// agnostic to scalar-vs-object shape.
  value: string;
  updated_at: string;
}

/// Server→client sync event tag. Mirrors the Rust `SyncEvent` enum
/// rendered as `{"type": "...", "rows": [...]}` on the WebSocket.
export type SyncEvent =
  | { type: "hello" }
  | { type: "resync" }
  | { type: "progress"; rows: ProgressRow[] }
  | { type: "solutions"; rows: SolutionRow[] }
  | { type: "settings"; rows: SettingRow[] };

export interface CourseMeta {
  id: string;
  course_slug: string;
  owner_id: string;
  owner_display_name: string | null;
  title: string;
  description: string | null;
  language: string | null;
  visibility: "private" | "unlisted" | "public";
  archive_size: number;
  created_at: string;
  updated_at: string;
}

export interface UseLibreCloud {
  /// Effective relay base URL (env override → localStorage → default).
  relayUrl: string;
  /// Persistent overrides for tests + staging deploys.
  setRelayUrlOverride: (url: string | null) => void;
  /// `null` while booting, `false` when there's no stored token,
  /// the user object once the cached `me` fetch lands.
  user: LibreCloudUser | null | false;
  signedIn: boolean;
  /// In-flight indicator for any of the auth/sync operations.
  busy: boolean;
  /// Last error from any cloud op. Cleared at the start of each call.
  error: string | null;

  signUpEmail: (email: string, password: string, displayName?: string) => Promise<void>;
  signInEmail: (email: string, password: string) => Promise<void>;
  signInApple: (identityToken: string, displayName?: string) => Promise<void>;
  signInGoogle: (identityToken: string, displayName?: string) => Promise<void>;
  /// Ask the relay to send a password-reset email. Always resolves
  /// (never rejects) regardless of whether the email is registered —
  /// the relay returns 204 in both cases to avoid leaking which
  /// emails have accounts. UI should show "if your email is on file,
  /// you'll get a link" rather than confirming the address exists.
  requestPasswordReset: (email: string) => Promise<void>;
  /// Submit the token + new password from the reset email. Throws on
  /// 401 ("link is invalid or expired") so the UI can surface it.
  confirmPasswordReset: (token: string, newPassword: string) => Promise<void>;
  /// Adopt a token issued by the browser-OAuth relay flow (Apple SIWA
  /// or Google) without re-running the auth POST. The desktop deep-
  /// link handler calls this once it parses `libre://oauth/done`.
  /// Stores the token + clears the cached user so the existing
  /// `/me`-on-mount effect picks it up and populates the user object.
  applyOAuthToken: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
  deleteAccount: () => Promise<void>;

  /// Pull every progress row the server has for this user. Returns
  /// the rows so the caller can merge them into local state.
  pullProgress: () => Promise<ProgressRow[]>;
  /// Push the local progress array as a bulk upsert. Server-side
  /// merge keeps the newer `completed_at` per (course, lesson).
  pushProgress: (rows: ProgressRow[]) => Promise<void>;
  /// Wipe every progress row on the server for the signed-in user.
  /// Used by the "Reset account" affordance so a clean slate on one
  /// device propagates to every other signed-in device on the next
  /// pull. Returns `true` when the relay confirmed the wipe; returns
  /// `false` if the endpoint isn't implemented (older relay) or the
  /// caller isn't signed in — the local-side reset still goes
  /// through, the cross-device sync just falls back to manual.
  resetProgress: () => Promise<boolean>;

  /// Pull every solution row (the learner's last-saved code per
  /// lesson) the server knows about for this user.
  pullSolutions: () => Promise<SolutionRow[]>;
  /// Push solutions; server keeps the row with the newer
  /// `updated_at` per (course, lesson).
  pushSolutions: (rows: SolutionRow[]) => Promise<void>;

  /// Pull every settings row (free-form user preferences keyed by a
  /// short string).
  pullSettings: () => Promise<SettingRow[]>;
  /// Push settings; LWW per `key`.
  pushSettings: (rows: SettingRow[]) => Promise<void>;

  /// Open a WebSocket to the relay's `/sync/ws` route and stream
  /// every cross-device sync event into `handler`. Auto-reconnects
  /// with exponential backoff (capped at ~10s) so a flaky network
  /// doesn't permanently de-sync the device. Returns a teardown
  /// function the caller invokes on unmount or sign-out. No-ops
  /// (returns a noop teardown) when the user isn't signed in yet.
  subscribeSync: (handler: (event: SyncEvent) => void) => () => void;

  /// Upload a `.libre` archive (Uint8Array) tagged with metadata.
  uploadCourse: (input: {
    courseSlug: string;
    title: string;
    description?: string;
    language?: string;
    visibility: "private" | "unlisted" | "public";
    archive: Uint8Array;
  }) => Promise<CourseMeta>;
  listMyCourses: () => Promise<CourseMeta[]>;
  listPublicCourses: () => Promise<CourseMeta[]>;
  /// Returns the raw archive bytes for `.libre` import.
  downloadCourse: (courseId: string) => Promise<ArrayBuffer>;
  deleteCourse: (courseId: string) => Promise<void>;
}

function readToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function writeToken(t: string | null): void {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode */ }
}
function readUser(): LibreCloudUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) as LibreCloudUser : null;
  } catch { return null; }
}
function writeUser(u: LibreCloudUser | null): void {
  try {
    if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
    else localStorage.removeItem(USER_KEY);
  } catch { /* private mode */ }
  // Hybrid model: keep the backend registry's record of "which
  // cloud account is bound to the active profile" in sync. Every
  // sign-in / sign-out / token-invalidation path funnels through
  // writeUser, so this one hook covers them all. Fire-and-forget;
  // a transient null during the OAuth handoff just unbinds then
  // re-binds on /me success (idempotent, converges correctly).
  bindProfileCloudAccount(u ? u.id : null);
}
function readUrlOverride(): string | null {
  try { return localStorage.getItem(URL_OVERRIDE_KEY); } catch { return null; }
}

function envRelayUrl(): string {
  // Vite-time inline (build-time): VITE_LIBRE_RELAY_URL. Vite
  // augments `import.meta.env` via vite-env.d.ts, so the access is
  // typed without a cast — falls back to the default when the var
  // isn't declared at build time.
  return import.meta.env.VITE_LIBRE_RELAY_URL ?? DEFAULT_RELAY_URL;
}

export function useLibreCloud(): UseLibreCloud {
  const [token, setToken] = useState<string | null>(() => readToken());
  const [user, setUser] = useState<LibreCloudUser | null | false>(() => {
    const cached = readUser();
    if (cached) return cached;
    return readToken() ? null : false;
  });
  const [urlOverride, setUrlOverride] = useState<string | null>(() => readUrlOverride());
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const relayUrl = (urlOverride || envRelayUrl()).replace(/\/$/, "");

  // Refresh `me` on first mount when we have a token but no cached
  // user object. Surfaces revoked tokens (`401`) by clearing local
  // state so the UI shows the sign-in prompt again.
  useEffect(() => {
    if (!token || user !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${relayUrl}/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`me failed: ${res.status}`);
        const me = (await res.json()) as LibreCloudUser;
        if (cancelled) return;
        writeUser(me);
        setUser(me);
      } catch {
        if (cancelled) return;
        // Token bad — drop it.
        writeToken(null);
        writeUser(null);
        setToken(null);
        setUser(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, user, relayUrl]);

  const setRelayUrlOverride = useCallback((u: string | null) => {
    try {
      if (u) localStorage.setItem(URL_OVERRIDE_KEY, u);
      else localStorage.removeItem(URL_OVERRIDE_KEY);
    } catch { /* ignore */ }
    setUrlOverride(u);
  }, []);

  /// Run an auth call (signup/login/oauth). On success, persist token
  /// and user — every flow ends with the same `{ token, user }` JSON.
  const runAuth = useCallback(
    async (path: string, body: unknown): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`${relayUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          // Surface a friendlier message for the common cases. The
          // server intentionally collapses bad-credential and unknown-
          // user into the same 401 to avoid email-existence leaks, so
          // the client can't distinguish them — display generically.
          const msg =
            res.status === 401
              ? "Email or password didn't match."
              : res.status === 409
                ? "An account with that email already exists."
                : res.status === 503
                  ? "That sign-in method isn't configured on the server."
                  : `Sign-in failed (${res.status}).`;
          throw new Error(msg);
        }
        const json = (await res.json()) as { token: string; user: LibreCloudUser };
        writeToken(json.token);
        writeUser(json.user);
        setToken(json.token);
        setUser(json.user);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [relayUrl],
  );

  const deviceLabel = (() => {
    // Cheap fingerprint for the token-list view server-side. Not a
    // security boundary; just a hint to the user (e.g. "MacBook Pro
    // · macOS"). Falls back to a generic label off the navigator UA.
    if (typeof navigator === "undefined") return "desktop";
    const ua = navigator.userAgent;
    if (ua.includes("Macintosh")) return "macOS desktop";
    if (ua.includes("Windows")) return "Windows desktop";
    if (ua.includes("Linux")) return "Linux desktop";
    return "desktop";
  })();

  // Analytics: each successful auth path fires either `signup` or
  // `signin` with the method that produced it. `runAuth` resolves
  // on success and throws on failure, so the `track.*` calls land
  // immediately after the await without an explicit try/catch —
  // failed auths produce no event (the fetch throws before we get
  // there). The signup-vs-signin distinction for the OAuth paths
  // is approximate from the client (we don't yet get a "new user"
  // flag back from /auth/apple|/auth/google); treating them as
  // `signin` is the conservative read. A future server-side
  // signup event from the relay can produce the precise count.
  const signUpEmail = useCallback(
    async (email: string, password: string, displayName?: string) => {
      await runAuth("/auth/signup", {
        email,
        password,
        display_name: displayName,
        device_label: deviceLabel,
      });
      track.signup("email");
    },
    [runAuth, deviceLabel],
  );
  const signInEmail = useCallback(
    async (email: string, password: string) => {
      await runAuth("/auth/login", {
        email,
        password,
        device_label: deviceLabel,
      });
      track.signin("email");
    },
    [runAuth, deviceLabel],
  );
  const signInApple = useCallback(
    async (identityToken: string, displayName?: string) => {
      await runAuth("/auth/apple", {
        identity_token: identityToken,
        display_name: displayName,
        device_label: deviceLabel,
      });
      track.signin("apple");
    },
    [runAuth, deviceLabel],
  );
  const signInGoogle = useCallback(
    async (identityToken: string, displayName?: string) => {
      await runAuth("/auth/google", {
        identity_token: identityToken,
        display_name: displayName,
        device_label: deviceLabel,
      });
      track.signin("google");
    },
    [runAuth, deviceLabel],
  );

  /// Ask the relay to email a reset link. Treats every response as a
  /// success — the relay returns 204 whether or not the email is
  /// registered, so UI can't tell either way. Network failures still
  /// reject (so the UI can show "we couldn't reach the server").
  const requestPasswordReset = useCallback(
    async (email: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`${relayUrl}/auth/password-reset/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        if (!res.ok && res.status !== 204) {
          // 5xx — relay is down. Surface it; the request endpoint
          // never 4xxs (intentionally permissive for enumeration
          // resistance) so any 4xx here would be a programming bug.
          throw new Error(`reset request failed (${res.status})`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [relayUrl],
  );

  /// Submit token + new password to the relay. 401 means the token
  /// was unknown / expired / consumed; 400 means the password failed
  /// the relay's length check. Both surface as thrown errors so the
  /// dialog can render them inline; the UI never auto-signs-in
  /// after a successful confirm — the user re-enters their freshly-
  /// changed password through the normal Sign in path so they
  /// confirm it works.
  const confirmPasswordReset = useCallback(
    async (token: string, newPassword: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`${relayUrl}/auth/password-reset/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, new_password: newPassword }),
        });
        if (res.status === 401) {
          throw new Error("This reset link is invalid or has expired. Request a new one.");
        }
        if (res.status === 400) {
          throw new Error("Password didn't meet the minimum length (8 characters).");
        }
        if (!res.ok && res.status !== 204) {
          throw new Error(`reset confirm failed (${res.status})`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [relayUrl],
  );

  /// Adopt a token from the browser-OAuth deep-link callback. The relay
  /// minted it server-side after exchanging the provider code, so we
  /// just need to persist it locally and let the `/me`-on-mount effect
  /// fetch the user record. Setting `user` to `null` (rather than
  /// `false`) is the trigger — the effect below watches `[token, user]`
  /// and only fires when `user === null`.
  const applyOAuthToken = useCallback(async (t: string) => {
    writeToken(t);
    writeUser(null);
    setToken(t);
    setUser(null);
  }, []);

  const signOut = useCallback(async () => {
    if (token) {
      // Best-effort revoke. Even if the request fails (offline,
      // expired token), we still clear local state — the user clicked
      // "sign out" and shouldn't be left stuck on the dashboard.
      await fetch(`${relayUrl}/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    }
    writeToken(null);
    writeUser(null);
    setToken(null);
    setUser(false);
  }, [token, relayUrl]);

  const deleteAccount = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${relayUrl}/auth/account`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`Delete failed (${res.status})`);
      }
      writeToken(null);
      writeUser(null);
      setToken(null);
      setUser(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, [token, relayUrl]);

  const authFetch = useCallback(
    async (path: string, init: RequestInit = {}): Promise<Response> => {
      if (!token) throw new Error("Not signed in");
      const headers = new Headers(init.headers ?? {});
      headers.set("Authorization", `Bearer ${token}`);
      if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      return fetch(`${relayUrl}${path}`, { ...init, headers });
    },
    [token, relayUrl],
  );

  const pullProgress = useCallback(async (): Promise<ProgressRow[]> => {
    const res = await authFetch("/progress");
    if (!res.ok) throw new Error(`pull failed (${res.status})`);
    return (await res.json()) as ProgressRow[];
  }, [authFetch]);

  const pushProgress = useCallback(
    async (rows: ProgressRow[]) => {
      if (rows.length === 0) return;
      // Chunk in batches of 1000 — server caps at 5000 per request,
      // and smaller chunks make a partial-failure more recoverable.
      for (let i = 0; i < rows.length; i += 1000) {
        const slice = rows.slice(i, i + 1000);
        const res = await authFetch("/progress", {
          method: "PUT",
          body: JSON.stringify({ rows: slice }),
        });
        if (!res.ok && res.status !== 204) {
          throw new Error(`push failed (${res.status})`);
        }
      }
    },
    [authFetch],
  );

  const resetProgress = useCallback(async (): Promise<boolean> => {
    if (!token) return false;
    try {
      const res = await authFetch("/progress", { method: "DELETE" });
      // 200 / 204 — relay wiped the rows. 404 / 405 — older relay
      // doesn't ship the route, fall back to "local-only reset". Any
      // other non-OK is an actual error worth surfacing.
      if (res.ok || res.status === 204) return true;
      if (res.status === 404 || res.status === 405) return false;
      throw new Error(`reset-progress failed (${res.status})`);
    } catch (e) {
      // Network failure / CORS / timeout. Don't block the local
      // wipe — the caller can still finish on this device, and a
      // future re-sync will eventually push the cleared state.
      // eslint-disable-next-line no-console
      console.warn("[cloud] resetProgress fell back to local-only:", e);
      return false;
    }
  }, [token, authFetch]);

  const pullSolutions = useCallback(async (): Promise<SolutionRow[]> => {
    const res = await authFetch("/solutions");
    if (!res.ok) throw new Error(`pull-solutions failed (${res.status})`);
    return (await res.json()) as SolutionRow[];
  }, [authFetch]);

  const pushSolutions = useCallback(
    async (rows: SolutionRow[]) => {
      if (rows.length === 0) return;
      for (let i = 0; i < rows.length; i += 200) {
        const slice = rows.slice(i, i + 200);
        const res = await authFetch("/solutions", {
          method: "PUT",
          body: JSON.stringify({ rows: slice }),
        });
        if (!res.ok && res.status !== 204) {
          throw new Error(`push-solutions failed (${res.status})`);
        }
      }
    },
    [authFetch],
  );

  const pullSettings = useCallback(async (): Promise<SettingRow[]> => {
    const res = await authFetch("/settings");
    if (!res.ok) throw new Error(`pull-settings failed (${res.status})`);
    return (await res.json()) as SettingRow[];
  }, [authFetch]);

  const pushSettings = useCallback(
    async (rows: SettingRow[]) => {
      if (rows.length === 0) return;
      const res = await authFetch("/settings", {
        method: "PUT",
        body: JSON.stringify({ rows }),
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`push-settings failed (${res.status})`);
      }
    },
    [authFetch],
  );

  // Latest token in a ref so subscribeSync's reconnect closure
  // always reads the current value — without this the closure caps
  // the token at sign-in time and a refresh-after-OAuth re-issue
  // would reconnect with a stale bearer.
  const tokenRef = useRef<string | null>(token);
  tokenRef.current = token;
  const relayUrlRef = useRef<string>(relayUrl);
  relayUrlRef.current = relayUrl;

  const subscribeSync = useCallback(
    (handler: (event: SyncEvent) => void): (() => void) => {
      if (!tokenRef.current) return () => {};

      let socket: WebSocket | null = null;
      let stopped = false;
      let backoff = 500;
      let reconnectTimer: number | null = null;
      // Defer the very first connect by a microtask so React 18
      // StrictMode (which mounts every effect twice in dev) doesn't
      // spam "WebSocket is closed before the connection is
      // established" errors. The pattern: mount → opens socket →
      // cleanup fires synchronously → second mount → opens
      // ANOTHER socket. Without the defer, the first socket gets
      // close()'d mid-handshake and the browser logs an error;
      // with the defer, the cleanup flips `stopped` and the
      // deferred connect bails out.
      let initialConnectTimer: number | null = null;

      const wsUrl = (): string => {
        // http(s) → ws(s); always preserve TLS so we don't downgrade.
        const base = relayUrlRef.current.replace(/^http/, "ws");
        const tok = encodeURIComponent(tokenRef.current ?? "");
        return `${base}/sync/ws?token=${tok}`;
      };

      const connect = (): void => {
        if (stopped) return;
        try {
          socket = new WebSocket(wsUrl());
        } catch (e) {
          console.warn("[libre-sync] WS construct failed:", e);
          schedule();
          return;
        }
        socket.addEventListener("open", () => {
          // Reset backoff on a clean connect; the server's `hello`
          // event arrives shortly after.
          backoff = 500;
        });
        socket.addEventListener("message", (ev) => {
          try {
            const data = JSON.parse(ev.data as string) as SyncEvent;
            handler(data);
          } catch (e) {
            console.warn("[libre-sync] bad WS payload:", e);
          }
        });
        socket.addEventListener("close", () => {
          if (!stopped) schedule();
        });
        socket.addEventListener("error", () => {
          // `close` fires after `error` so we let the close handler
          // do the reconnect dance.
        });
      };

      const schedule = (): void => {
        if (stopped) return;
        if (reconnectTimer !== null) return;
        const delay = Math.min(backoff, 10_000);
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          backoff = Math.min(backoff * 2, 10_000);
          connect();
        }, delay);
      };

      // Defer the first connect by a tick so a synchronous
      // mount-cleanup-mount in dev doesn't open + close a socket
      // mid-handshake (which the browser surfaces as a noisy
      // "WebSocket is closed before the connection is established"
      // error). Production behaves identically — one tick is
      // imperceptible.
      initialConnectTimer = window.setTimeout(() => {
        initialConnectTimer = null;
        if (stopped) return;
        connect();
      }, 0);

      return () => {
        stopped = true;
        if (initialConnectTimer !== null) {
          window.clearTimeout(initialConnectTimer);
          initialConnectTimer = null;
        }
        if (reconnectTimer !== null) {
          window.clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (socket) {
          try {
            // Only call close() if the socket is past the handshake.
            // Closing during CONNECTING also produces the browser
            // warning we're trying to avoid; readyState === 0 means
            // the handshake hasn't finished, so we just drop the
            // reference and let the GC + browser tear it down.
            if (socket.readyState === WebSocket.OPEN) {
              socket.close();
            }
          } catch {
            /* swallow */
          }
          socket = null;
        }
      };
    },
    [],
  );

  const uploadCourse = useCallback(
    async (input: {
      courseSlug: string;
      title: string;
      description?: string;
      language?: string;
      visibility: "private" | "unlisted" | "public";
      archive: Uint8Array;
    }): Promise<CourseMeta> => {
      // Convert Uint8Array → base64 in JS — the relay accepts it as a
      // string field to dodge multipart-CORS edge cases.
      let binary = "";
      for (let i = 0; i < input.archive.length; i++) {
        binary += String.fromCharCode(input.archive[i]);
      }
      const archive_b64 = btoa(binary);
      const res = await authFetch("/courses", {
        method: "POST",
        body: JSON.stringify({
          course_slug: input.courseSlug,
          title: input.title,
          description: input.description,
          language: input.language,
          visibility: input.visibility,
          archive_b64,
        }),
      });
      if (!res.ok) throw new Error(`upload failed (${res.status})`);
      return (await res.json()) as CourseMeta;
    },
    [authFetch],
  );

  const listMyCourses = useCallback(async (): Promise<CourseMeta[]> => {
    const res = await authFetch("/courses");
    if (!res.ok) throw new Error(`list failed (${res.status})`);
    return (await res.json()) as CourseMeta[];
  }, [authFetch]);

  const listPublicCourses = useCallback(async (): Promise<CourseMeta[]> => {
    const res = await fetch(`${relayUrl}/courses/public`);
    if (!res.ok) throw new Error(`list-public failed (${res.status})`);
    return (await res.json()) as CourseMeta[];
  }, [relayUrl]);

  const downloadCourse = useCallback(
    async (courseId: string): Promise<ArrayBuffer> => {
      const res = await authFetch(`/courses/${encodeURIComponent(courseId)}`);
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      return await res.arrayBuffer();
    },
    [authFetch],
  );

  const deleteCourse = useCallback(
    async (courseId: string) => {
      const res = await authFetch(`/courses/${encodeURIComponent(courseId)}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`delete failed (${res.status})`);
      }
    },
    [authFetch],
  );

  // Memoise the return shape so the *object identity* is stable
  // unless something on it actually changed. Without this, every
  // render of the consumer (App.tsx) creates a new `cloud` reference,
  // and any effect that takes `cloud` as a dep re-runs every render.
  // For the deep-link `useEffect` that translated into a re-subscribe
  // + re-call of `getCurrentDeepLinks()` on every paint, which on
  // macOS sometimes re-delivered the OAuth callback URL — firing
  // applyOAuthToken repeatedly, which sets `user = null`, flipping
  // `signedIn` false, until `/me` re-resolves. Net effect: visible
  // auth-state flashing in any UI that reads `signedIn`. Memoising
  // here is the single fix that eliminates it.
  return useMemo(
    () => ({
      relayUrl,
      setRelayUrlOverride,
      user,
      // `user` is `false` when we know there's no session, `null`
      // while booting, or the user object when signed in.
      signedIn: typeof user === "object" && user !== null,
      busy,
      error,
      signUpEmail,
      signInEmail,
      signInApple,
      signInGoogle,
      requestPasswordReset,
      confirmPasswordReset,
      applyOAuthToken,
      signOut,
      deleteAccount,
      pullProgress,
      pushProgress,
      resetProgress,
      pullSolutions,
      pushSolutions,
      pullSettings,
      pushSettings,
      subscribeSync,
      uploadCourse,
      listMyCourses,
      listPublicCourses,
      downloadCourse,
      deleteCourse,
    }),
    [
      relayUrl,
      setRelayUrlOverride,
      user,
      busy,
      error,
      signUpEmail,
      signInEmail,
      signInApple,
      signInGoogle,
      requestPasswordReset,
      confirmPasswordReset,
      applyOAuthToken,
      signOut,
      deleteAccount,
      pullProgress,
      pushProgress,
      resetProgress,
      pullSolutions,
      pushSolutions,
      pullSettings,
      pushSettings,
      subscribeSync,
      uploadCourse,
      listMyCourses,
      listPublicCourses,
      downloadCourse,
      deleteCourse,
    ],
  );
}
