/// Pending-OAuth session-nonce bridge (desktop deep-link path).
///
/// The OAuth flow generates a 128-bit random `session` id per sign-in
/// attempt. The relay round-trips it back on the
/// `libre://oauth/done?session=…&token=…` callback (see the relay's
/// `build_return_url` — it `append_pair("session", …)` on every
/// return URL, including the desktop scheme).
///
/// The WEB popup path already validates this nonce in-component
/// (origin-pinned postMessage + `oauthSessionRef`). The DESKTOP path
/// couldn't: the deep link is delivered to App.tsx's global listener,
/// a different component from the SignInDialog that started the flow,
/// so there was nowhere to compare against — and the handler applied
/// whatever token arrived. That meant any process/page that could
/// emit `libre://oauth/done?status=ok&token=ATTACKER` could sign the
/// victim into an attacker-controlled account (login-CSRF / account
/// confusion).
///
/// This module is the missing shared channel: the dialog stashes the
/// nonce it generated before launching the browser; the deep-link
/// handler consumes + verifies it. Properties:
///   - localStorage (not sessionStorage) so it survives the cold-start
///     case where clicking the callback URL relaunches the app.
///   - Single-use: `consume` deletes on read so a replayed callback
///     can't be accepted twice.
///   - TTL-bounded: a stale nonce from an abandoned attempt can't sit
///     around indefinitely as a replay target.

const KEY = "libre:oauth:pending-session";
/// 10 minutes — comfortably longer than a real provider round-trip
/// (seconds to a couple of minutes incl. 2FA), short enough that an
/// abandoned attempt's nonce isn't a lingering replay target.
const TTL_MS = 10 * 60 * 1000;

interface Pending {
  id: string;
  ts: number;
}

/// Record the session nonce for an in-flight desktop OAuth attempt.
/// Called by SignInDialog immediately before `invoke("start_oauth")`.
export function setPendingOAuthSession(id: string): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ id, ts: Date.now() } satisfies Pending),
    );
  } catch {
    /* private mode / quota — the deep-link handler will then find no
       pending nonce and (correctly) reject the callback rather than
       fail open. */
  }
}

/// Read + delete the pending nonce. Returns the id only if one was
/// stored and it's still within the TTL; otherwise null. Single-use:
/// the entry is always removed, success or not.
export function consumePendingOAuthSession(): string | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<Pending>;
    if (
      typeof p.id !== "string" ||
      typeof p.ts !== "number" ||
      Date.now() - p.ts > TTL_MS
    ) {
      return null;
    }
    return p.id;
  } catch {
    return null;
  }
}
