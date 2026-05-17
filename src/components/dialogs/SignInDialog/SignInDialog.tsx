import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UseLibreCloud } from "../../../hooks/useLibreCloud";
import { isWeb } from "../../../lib/platform";
import { setPendingOAuthSession } from "../../../lib/oauthSession";
import { track } from "../../../lib/track";
import PasswordField, { PASSWORD_MIN_LENGTH, scorePassword } from "./PasswordField";
import ModalBackdrop from "../../Shared/ModalBackdrop";
import "./SignInDialog.css";

/// Three-tab sign-in modal: email, Apple, Google. Used both by the
/// first-launch prompt and the Settings → Account section.
///
/// All three flows are optional — Libre works without an account
/// (local SQLite + JSON only). Signing in is purely additive: it
/// enables progress sync, course sharing, and cross-device pickup.
///
/// Apple + Google use the relay's browser-OAuth flow: clicking the
/// provider button opens the system browser via the `start_oauth`
/// Tauri command, the user signs in there, and the relay redirects
/// back to `libre://oauth/done?...`. App.tsx's deep-link
/// listener parses the callback and feeds the token to the cloud
/// hook, which materialises the signed-in user. We just need to
/// kick off the redirect and wait for `cloud.signedIn` to flip.

interface Props {
  cloud: UseLibreCloud;
  onClose: () => void;
  /// Optional copy variant. The first-launch prompt uses a softer
  /// "no account" CTA; the Settings entry hides it (the user is
  /// already inside the app and reached this dialog deliberately).
  showSkipButton?: boolean;
  /// Called when the user clicks "Skip / Maybe later".
  onSkip?: () => void;
  /// Optional headline override — first-launch wants a friendlier
  /// "welcome" pitch, Settings wants a plainer "sign in" one.
  headline?: string;
  blurb?: string;
}

/// Email-form sub-mode. Replaces the previous "try login, fall back to
/// signup" auto-flow which dead-ended whenever the user typed the
/// wrong password for an existing account: login 401 → signup 409
/// "account exists" → no path forward in the dialog. Explicit modes
/// give the user a clear next step ("forgot? switch to Sign in" /
/// "no account? switch to Create account") and let us tailor the
/// password input (strength meter on signup, plain on signin).
///
/// `forgot` is a tertiary state reachable from `signIn` only. We
/// treat it as a peer mode here (rather than a separate sub-component)
/// so the same form shell, error slot, and switch-link affordance
/// stay in sync without a second markup tree.
type EmailMode = "signIn" | "signUp" | "forgot";

/// Generate a URL-safe random session id. The relay uses this to
/// correlate the browser-side OAuth flow with the desktop callback,
/// but here we just need something opaque the server side will echo
/// back. 16 bytes of entropy is plenty for a one-shot correlation id.
function generateSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Base64-url without padding — keeps the id ASCII-safe for the
  // backend's `[A-Za-z0-9_-]+` validator and avoids `=` characters
  // that would need URL-encoding.
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export default function SignInDialog({
  cloud,
  onClose,
  showSkipButton = false,
  onSkip,
  headline,
  blurb,
}: Props) {
  const [emailMode, setEmailMode] = useState<EmailMode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  /// Second password field on Create-account mode. Match check below
  /// blocks submit when populated and ≠ password — catches typos in
  /// the masked input before the user commits a password they can't
  /// repeat. Cleared on mode switch so the Sign-in path never sees a
  /// stale confirm value.
  const [passwordConfirm, setPasswordConfirm] = useState("");
  /// Local-only error state for the email tab. We don't surface
  /// `cloud.error` directly anymore because the explicit-mode form
  /// needs more nuanced messaging than the hook's pass-through 401
  /// string ("Email or password didn't match"). Examples:
  ///   - Sign-in 401   → "Email or password didn't match. Forgot? You
  ///                      can also create a new account."
  ///   - Signup 409   → "An account with that email exists — switch
  ///                      to Sign in?"
  /// Cleared on the next submit attempt and on mode switches.
  const [emailError, setEmailError] = useState<string | null>(null);
  /// Shown above the form once a freshly-created account is signed
  /// in. Distinct from the existing `signedIn`-watcher close so the
  /// learner sees a beat of "you're in" copy before the modal closes.
  const [createdNotice, setCreatedNotice] = useState(false);
  /// Shown after a successful password-reset email submit. The relay
  /// returns 204 whether or not the email is registered (anti-
  /// enumeration), so the copy is deliberately ambiguous: "if your
  /// email is on file, you'll get a link." Stays up until the user
  /// clicks back to Sign in.
  const [forgotSent, setForgotSent] = useState(false);
  /// `true` once the user clicks "Continue with Apple/Google" and the
  /// system browser has been launched. We stay in this state until the
  /// deep-link callback fires and `cloud.signedIn` flips. If the user
  /// never finishes the flow, the dialog stays open with a "waiting"
  /// affordance — closing the modal cancels their attempt locally.
  const [awaitingOAuth, setAwaitingOAuth] = useState(false);
  /// Local error for the OAuth path — `cloud.error` only surfaces for
  /// the email + native id_token flows, but `start_oauth` can fail
  /// before the relay ever runs (provider mis-typed, browser open
  /// blocked, etc.).
  const [oauthError, setOauthError] = useState<string | null>(null);

  /// Sign-in submit. Calls the relay's login endpoint and surfaces a
  /// targeted error on 401 ("didn't match"). Other failures
  /// (network down, 503) fall through to whatever message the hook
  /// puts on `cloud.error`.
  const onSignInSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError(null);
    setCreatedNotice(false);
    try {
      await cloud.signInEmail(email, password);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("didn't match") || msg.includes("401")) {
        setEmailError(
          "Email or password didn't match. If you don't have an account yet, switch to Create account.",
        );
      } else {
        setEmailError(msg || "Couldn't sign in. Please try again.");
      }
    }
  };

  /// Create-account submit. Validates length client-side (same 8-char
  /// floor the relay enforces in api/src/routes/auth.rs) AND that
  /// the confirm field matches before posting, so the user gets
  /// immediate feedback instead of a server round-trip 400. On 409
  /// ("already exists") we route the user to the Sign-in tab so
  /// they don't dead-end.
  const onSignUpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError(null);
    setCreatedNotice(false);
    if (password.length < PASSWORD_MIN_LENGTH) {
      setEmailError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    if (password !== passwordConfirm) {
      setEmailError("Passwords don't match. Re-enter both fields.");
      return;
    }
    try {
      // No display_name yet — the user can set one in Settings →
      // Account once they're in. Keeping the modal small.
      await cloud.signUpEmail(email, password);
      setCreatedNotice(true);
      // Don't close yet — the `createdNotice && cloud.signedIn`
      // watcher below handles the dismiss after a short beat so
      // the welcome notice has time to read.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const lower = msg.toLowerCase();
      if (lower.includes("already exists") || msg.includes("409")) {
        setEmailError(
          "An account with that email already exists. Switch to Sign in instead?",
        );
      } else if (lower.includes("password") && lower.includes("8")) {
        setEmailError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
      } else {
        setEmailError(msg || "Couldn't create account. Please try again.");
      }
    }
  };

  /// Reset the local error state + confirm field + forgot-sent
  /// notice when the user switches modes — each mode owns its own
  /// transient state and shouldn't inherit stale messages from the
  /// previous one ("password too short" from signup, "check your
  /// email" from forgot, etc.).
  const switchEmailMode = (next: EmailMode) => {
    setEmailMode(next);
    setEmailError(null);
    setCreatedNotice(false);
    setForgotSent(false);
    setPasswordConfirm("");
  };

  /// Submit the forgot-password email. The relay returns 204 in
  /// every non-error case (no enumeration), so on success we just
  /// flip into a "check your email" view. Errors here only happen
  /// for true server / network failures.
  const onForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError(null);
    setForgotSent(false);
    try {
      await cloud.requestPasswordReset(email);
      setForgotSent(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setEmailError(msg || "Couldn't reach the server. Please try again.");
    }
  };

  /// Inline mismatch hint shown under the confirm field while the
  /// user is still typing. Stays empty until they've entered enough
  /// characters in confirm to plausibly know whether it should match
  /// — flashing "Passwords don't match" after the first keystroke is
  /// noise. Threshold = the shorter of the two fields' lengths
  /// (they're typing into confirm, so we know that length grows by
  /// 1 each keystroke).
  const confirmMismatch =
    emailMode === "signUp" &&
    passwordConfirm.length > 0 &&
    passwordConfirm.length >= Math.min(password.length, 4) &&
    password !== passwordConfirm;

  /// Auto-close once the deep-link path lands and the user record
  /// materialises. Watching `signedIn` (rather than the raw token)
  /// means we wait for the `/me` fetch too — closing earlier could
  /// dump the user into a half-loaded state where `cloud.user` is
  /// still null.
  useEffect(() => {
    if (awaitingOAuth && cloud.signedIn) {
      onClose();
    }
  }, [awaitingOAuth, cloud.signedIn, onClose]);

  /// Email-signup auto-close. `onSignUpSubmit` sets `createdNotice`
  /// after `signUpEmail` resolves (which already flipped `signedIn`
  /// via the same `runAuth` path the sign-in flow uses), then waits
  /// for this watcher to dismiss the dialog. A small delay so the
  /// "Welcome! Account created — signing you in…" notice is actually
  /// readable before the modal disappears — without the delay the
  /// notice would render for a single frame at most. This watcher
  /// is paired with — not folded into — the OAuth one above so the
  /// two flows can evolve their close-timing independently (OAuth
  /// closes the instant the deep-link returns; email signup hangs
  /// on the success notice for a beat).
  useEffect(() => {
    if (createdNotice && cloud.signedIn) {
      const timer = window.setTimeout(onClose, 1200);
      return () => window.clearTimeout(timer);
    }
  }, [createdNotice, cloud.signedIn, onClose]);

  /// Holds the popup-window handle on the web variant so we can poll
  /// `closed` (user dismissed it without finishing) and tear down the
  /// pending state. Desktop doesn't need this — the OS owns the
  /// browser tab.
  const oauthPopupRef = useRef<Window | null>(null);
  const oauthSessionRef = useRef<string | null>(null);
  /// Remembers which provider the user picked when starting the
  /// web OAuth popup. The returned token doesn't carry provider
  /// info, so we stash it here at click-time and read it back in
  /// the postMessage handler to fire `track.signin(provider)` with
  /// the right value. Cleared alongside the popup/session refs.
  const oauthProviderRef = useRef<"apple" | "google" | null>(null);

  /// Web OAuth flow — we can't use `libre://` deep-links from a
  /// browser, so the relay redirects to a `/oauth/done` page on this
  /// origin instead, and that page postMessages the token back to
  /// the opener. The relay's `build_return_url` allow-lists this
  /// origin; passing any other URL falls through to the default
  /// `libre://oauth/done`, which a browser can't follow.
  ///
  /// Returns `true` when the popup was opened so the caller knows
  /// to flip into "awaiting" state. Returns `false` (and surfaces an
  /// error message) when the popup was blocked or another path
  /// fails before we hand off to the provider.
  const startWebOAuth = (provider: "apple" | "google", sessionId: string): boolean => {
    const returnTo = `${window.location.origin}/oauth/done`;
    const url =
      `${cloud.relayUrl}/auth/${provider}/start` +
      `?session=${encodeURIComponent(sessionId)}` +
      `&return_to=${encodeURIComponent(returnTo)}`;
    // Width/height roughly match Google's recommended OAuth popup
    // dimensions — small enough to feel modal, big enough that the
    // provider's own form doesn't horizontally scroll.
    const features = "popup=yes,width=520,height=640";
    const win = window.open(url, "libre-oauth", features);
    if (!win) {
      setOauthError(
        "Couldn't open the sign-in popup — check your browser's pop-up blocker, then try again.",
      );
      return false;
    }
    oauthPopupRef.current = win;
    oauthSessionRef.current = sessionId;
    oauthProviderRef.current = provider;
    return true;
  };

  const startOAuth = async (provider: "apple" | "google") => {
    setOauthError(null);
    try {
      const sessionId = generateSessionId();
      if (isWeb) {
        if (!startWebOAuth(provider, sessionId)) return;
      } else {
        // Stash the nonce so App.tsx's `libre://oauth/done` deep-link
        // handler can verify the callback actually corresponds to
        // THIS sign-in attempt before applying the returned token —
        // without this the desktop path would accept any token a
        // crafted deep link delivered (login-CSRF). The web path
        // doesn't need this; it validates `oauthSessionRef` against
        // the origin-pinned postMessage in-component.
        setPendingOAuthSession(sessionId);
        await invoke("start_oauth", { provider, sessionId });
      }
      setAwaitingOAuth(true);
    } catch (e) {
      setOauthError(e instanceof Error ? e.message : String(e));
    }
  };

  /// Web variant — listen for the popup's postMessage with the minted
  /// token and feed it to the cloud hook (which persists, then fetches
  /// `/me` to materialise the user). Also poll for the popup being
  /// closed without success so we can clear the pending state instead
  /// of leaving the dialog stuck in "Waiting for browser…" forever.
  useEffect(() => {
    if (!isWeb || !awaitingOAuth) return;

    function onMessage(e: MessageEvent) {
      // Origin pinning — only accept the postMessage if it came from
      // our own /oauth/done page. The popup runs on the same origin
      // as the parent (we always send return_to=<our-origin>/oauth/done),
      // so anything else is either a misdirected message we should
      // ignore or an attempted token exfiltration.
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; token?: string; session?: string; error?: string } | null;
      if (!data || data.type !== "libre-oauth") return;
      // Session id check — defends against a stale popup whose token
      // arrives after the user opened a new attempt with a fresh id.
      if (oauthSessionRef.current && data.session !== oauthSessionRef.current) return;
      if (data.token) {
        // Web-OAuth path: the desktop flow goes through
        // `signInApple`/`signInGoogle` in `useLibreCloud` (which
        // already fire `track.signin`), but the web popup hands a
        // pre-minted token to `applyOAuthToken` directly — that
        // call has no provider context. Fire here using the
        // provider we stashed at click time so the dashboard sees
        // the signin event with the correct method.
        const provider = oauthProviderRef.current;
        if (provider) track.signin(provider);
        void cloud.applyOAuthToken(data.token);
      } else if (data.error) {
        setOauthError(data.error);
        setAwaitingOAuth(false);
      }
      try {
        oauthPopupRef.current?.close();
      } catch {
        // Cross-origin popups sometimes throw on close after navigation.
        // Not a problem — the user can dismiss it manually.
      }
      oauthPopupRef.current = null;
      oauthSessionRef.current = null;
      oauthProviderRef.current = null;
    }
    window.addEventListener("message", onMessage);

    // Polling fallback — if the user closes the popup without
    // completing, we never get a postMessage. A 750ms cadence is
    // gentle on the event loop and quick enough that the dialog
    // doesn't feel stuck.
    const closedTimer = window.setInterval(() => {
      const w = oauthPopupRef.current;
      if (w && w.closed) {
        window.clearInterval(closedTimer);
        oauthPopupRef.current = null;
        // Only clear awaitingOAuth if we haven't already signed in
        // (the postMessage path closes the popup AFTER applying the
        // token, and the parent watcher in App.tsx flips `awaiting`
        // off on signedIn).
        if (!cloud.signedIn) setAwaitingOAuth(false);
      }
    }, 750);

    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(closedTimer);
    };
  }, [awaitingOAuth, cloud]);

  return (
    <ModalBackdrop
      onDismiss={onClose}
      zIndex={200}
      className="libre-signin-backdrop-mobile"
    >
      <div
        className="libre-signin-panel"
        role="dialog"
        aria-modal="true"
      >
        <button
          type="button"
          className="libre-signin-close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>

        <h2 className="libre-signin-title">
          {headline ?? "Sign in to Libre"}
        </h2>
        <p className="libre-signin-blurb">
          {blurb ??
            "Optional — sync progress between devices, upload courses, and share them with friends. You can also keep using Libre without an account; everything else still runs locally."}
        </p>

        {/* Email is the primary form — always shown above the
            Apple / Google buttons. Tabs were removed because the
            three flows aren't mutually exclusive: a user typing
            their email shouldn't have to first click "Email" to
            see the form. */}
        <form
          onSubmit={
            emailMode === "signIn"
              ? onSignInSubmit
              : emailMode === "signUp"
                ? onSignUpSubmit
                : onForgotSubmit
          }
          className="libre-signin-form"
        >
          {/* Mode toggle — segmented Sign in / Create account.
              Hidden in `forgot` mode (the form there is a single
              email field, no Sign in vs Create account distinction
              to make). */}
          {emailMode !== "forgot" && (
            <div className="libre-signin-mode-toggle" role="tablist" aria-label="Email account mode">
              <button
                type="button"
                role="tab"
                aria-selected={emailMode === "signIn"}
                className={`libre-signin-mode-btn ${emailMode === "signIn" ? "libre-signin-mode-btn--active" : ""}`}
                onClick={() => switchEmailMode("signIn")}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={emailMode === "signUp"}
                className={`libre-signin-mode-btn ${emailMode === "signUp" ? "libre-signin-mode-btn--active" : ""}`}
                onClick={() => switchEmailMode("signUp")}
              >
                Create account
              </button>
            </div>
          )}

          {/* Forgot-mode header — explain what's about to happen
              before the user types their email. The "check your
              email" success state replaces this prompt entirely so
              the visible affordance always matches the current
              step in the flow. */}
          {emailMode === "forgot" && !forgotSent && (
            <p className="libre-signin-helper">
              Enter your account email and we'll send a link to reset
              your password. The link expires in 1 hour.
            </p>
          )}

          <label className="libre-signin-field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              disabled={cloud.busy || forgotSent}
            />
          </label>

          {/* Password fields — Sign in + Create account only.
              Forgot mode is email-only. */}
          {emailMode !== "forgot" && (
            <>
              {/* Reusable PasswordField — strength meter only shows on
                  Create account where it's actionable. autoComplete
                  flips between current-password (Sign in) and
                  new-password (Create account) so password managers
                  pick the right slot. */}
              <PasswordField
                value={password}
                onChange={setPassword}
                showStrength={emailMode === "signUp"}
                autoComplete={emailMode === "signUp" ? "new-password" : "current-password"}
                required
                disabled={cloud.busy}
                helper={
                  emailMode === "signUp"
                    ? `At least ${PASSWORD_MIN_LENGTH} characters. Mix cases, digits, and symbols for a stronger password.`
                    : null
                }
              />

              {/* Confirm-password field — only on Create account. The
                  inline `error` prop tints the border + replaces the
                  helper line with "Passwords don't match" once the
                  user has typed enough characters that a mismatch is
                  a typo rather than mid-edit. autoComplete=new-password
                  so password managers don't try to fill an existing
                  credential here. */}
              {emailMode === "signUp" && (
                <PasswordField
                  value={passwordConfirm}
                  onChange={setPasswordConfirm}
                  label="Confirm password"
                  showStrength={false}
                  autoComplete="new-password"
                  required
                  disabled={cloud.busy}
                  helper={null}
                  error={confirmMismatch ? "Passwords don't match" : null}
                />
              )}
            </>
          )}

          {emailError && (
            <p className="libre-signin-error">{emailError}</p>
          )}
          {createdNotice && !emailError && emailMode === "signUp" && (
            <p className="libre-signin-helper libre-signin-helper--success">
              Welcome! Account created — signing you in…
            </p>
          )}
          {forgotSent && !emailError && (
            <p className="libre-signin-helper libre-signin-helper--success">
              If that email is on file, a reset link is on its way. Check
              your inbox (and spam folder) — the link expires in 1 hour.
            </p>
          )}

          {/* Submit button — hidden in forgot+sent state since the
              user's next action is to switch back to Sign in via the
              cross-link below. */}
          {!(emailMode === "forgot" && forgotSent) && (
            <button
              type="submit"
              className="libre-signin-primary"
              disabled={
                cloud.busy ||
                email.length === 0 ||
                // Forgot mode is email-only — no password gate. Sign
                // in + Create account both need a password. Create
                // account additionally needs the password to meet the
                // minimum length AND the confirm field to match.
                (emailMode !== "forgot" && password.length === 0) ||
                (emailMode === "signUp" &&
                  (scorePassword(password).belowMinLength ||
                    passwordConfirm.length === 0 ||
                    password !== passwordConfirm))
              }
            >
              {cloud.busy
                ? "…"
                : emailMode === "signIn"
                  ? "Sign in"
                  : emailMode === "signUp"
                    ? "Create account"
                    : "Send reset link"}
            </button>
          )}

          {/* Cross-links — gives the user an unmistakable next step
              when they realise they're on the wrong mode. Sign in
              gets two: "Forgot password?" + "Don't have an account?".
              Buttons instead of <a> tags so we stay inside the dialog. */}
          <p className="libre-signin-switch">
            {emailMode === "signIn" && (
              <>
                <button
                  type="button"
                  className="libre-signin-switch__link"
                  onClick={() => switchEmailMode("forgot")}
                >
                  Forgot password?
                </button>
                {" · "}
                Don't have an account?{" "}
                <button
                  type="button"
                  className="libre-signin-switch__link"
                  onClick={() => switchEmailMode("signUp")}
                >
                  Create one
                </button>
              </>
            )}
            {emailMode === "signUp" && (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  className="libre-signin-switch__link"
                  onClick={() => switchEmailMode("signIn")}
                >
                  Sign in
                </button>
              </>
            )}
            {emailMode === "forgot" && (
              <>
                Remembered it?{" "}
                <button
                  type="button"
                  className="libre-signin-switch__link"
                  onClick={() => switchEmailMode("signIn")}
                >
                  Back to sign in
                </button>
              </>
            )}
          </p>
        </form>

        {/* OR-divider — separates the email form from the OAuth
            alternatives. Pure CSS line-with-text so the dialog
            stays visually balanced even on narrow viewports. */}
        <div
          className="libre-signin-or"
          role="separator"
          aria-label="or"
        >
          <span>or</span>
        </div>

        <div className="libre-signin-oauth">
          <button
            type="button"
            className="libre-signin-oauth-btn libre-signin-oauth-btn--apple"
            onClick={() => void startOAuth("apple")}
            disabled={awaitingOAuth}
          >
            <span className="libre-signin-oauth-glyph" aria-hidden>
              {/* Inline Apple silhouette — see earlier note about
                  the U+F8FF codepoint not rendering under our
                  cascaded font. SVG is what Apple's Sign-In
                  branding guidelines sanction for non-native
                  buttons. */}
              <svg
                viewBox="0 0 18 18"
                width="18"
                height="18"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M14.94 9.97c-.02-2.05 1.68-3.04 1.76-3.09-.96-1.4-2.45-1.59-2.98-1.61-1.27-.13-2.48.74-3.13.74-.65 0-1.65-.72-2.71-.7-1.39.02-2.69.81-3.4 2.05-1.45 2.51-.37 6.22 1.04 8.27.69 1 1.51 2.13 2.58 2.09 1.04-.04 1.43-.67 2.69-.67 1.25 0 1.61.67 2.7.65 1.12-.02 1.83-1.02 2.51-2.03.79-1.16 1.12-2.29 1.14-2.35-.03-.01-2.18-.84-2.2-3.35M12.95 4.18c.57-.69.96-1.65.85-2.6-.82.03-1.81.55-2.4 1.24-.53.61-.99 1.59-.87 2.52.91.07 1.85-.46 2.42-1.16" />
              </svg>
            </span>
            <span>Sign in with Apple</span>
          </button>
          <button
            type="button"
            className="libre-signin-oauth-btn libre-signin-oauth-btn--google"
            onClick={() => void startOAuth("google")}
            disabled={awaitingOAuth}
          >
            <span className="libre-signin-oauth-glyph" aria-hidden>
              <svg viewBox="0 0 18 18" width="18" height="18">
                <path
                  fill="#4285F4"
                  d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
                />
                <path
                  fill="#34A853"
                  d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
                />
                <path
                  fill="#FBBC05"
                  d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
                />
                <path
                  fill="#EA4335"
                  d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
                />
              </svg>
            </span>
            <span>Sign in with Google</span>
          </button>
          {awaitingOAuth && (
            <p className="libre-signin-oauth-waiting">
              Waiting for sign-in… finish in your browser, then we'll bring
              you back automatically.
            </p>
          )}
          {oauthError && (
            <p className="libre-signin-error">{oauthError}</p>
          )}
          {cloud.error && !oauthError && (
            <p className="libre-signin-error">{cloud.error}</p>
          )}
        </div>

        {showSkipButton && (
          <button
            type="button"
            className="libre-signin-skip"
            onClick={() => {
              onSkip?.();
              onClose();
            }}
          >
            Maybe later
          </button>
        )}
      </div>
    </ModalBackdrop>
  );
}
