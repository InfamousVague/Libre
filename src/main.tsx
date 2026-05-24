import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { applyTheme, loadTheme } from "./theme/themes";
import { prewarmCoursesSummary } from "./hooks/useCourses";
import { isMobile } from "./lib/platform";
// Base library's design tokens FIRST (light `:root` + `[data-theme=
// "dark"]` blocks), then our theme overrides, then app shell styles.
// The order is load-bearing: the base kit's `[data-theme="dark"]`
// rule and our `[data-theme-name="synthwave"]` / `"claude-code-dark"`
// / `"ayu-mirage"` / etc. rules both have specificity (0,0,1,0) and
// define the same tokens (`--color-bg-primary`, `--color-text-primary`,
// etc.). With same specificity, last-loaded wins — loading base
// FIRST means our per-theme overrides actually apply instead of
// getting clobbered by `[data-theme="dark"]` snapping every dark
// theme back to the same generic palette.
//
// IMPORTANT: do NOT also `@import "...tokens.css"` from inside
// `App.css` or any other downstream stylesheet. CSS @imports get
// inlined at the position of the @import directive, which would
// re-load tokens.css AFTER themes.css inside that file and clobber
// our theme overrides again. Removed the App.css @import for
// exactly this reason; keep it removed.
import "@mattmattmattmatt/base/site/styles/tokens.css";
import "./theme/themes.css";
import "./App.css";
import { I18nProvider } from "./i18n/i18n";

// Boot-phase markers. Pushed to the dev console buffer (devconsole.js
// patched console.log before this script even started parsing) so we
// have a timeline of where startup time goes — critical for the iPad
// case where the app freezes mid-boot and there's no Web Inspector.
//
// Search the console output for "[boot]" to see the sequence.
const tBoot0 = performance.now();
function bootLog(label: string) {
  // eslint-disable-next-line no-console
  console.log(`[boot] +${(performance.now() - tBoot0).toFixed(0)}ms ${label}`);
}
bootLog("main.tsx start");

// Apply the user's chosen theme (or system preference for the first-run
// default) before React mounts so we don't flash the wrong palette.
applyTheme(loadTheme());
bootLog("theme applied");

// Global link interceptor. Routes every external-URL click to the
// OS default browser on desktop (Tauri), or `window.open(_blank)` on
// web — so the WebView / SPA never navigates away from the app and
// traps the user with no way back. See
// `lib/installLinkInterceptor.ts` for the full rationale. Installed
// here (pre-mount, pre-paint) so the very first click works.
void import("./lib/installLinkInterceptor").then((m) =>
  m.installLinkInterceptor(),
);
bootLog("link interceptor installed");

// Analytics — web-only, no-op everywhere else. Imported lazily so
// the desktop / mobile bundles don't even include the module (Vite
// + the `isWeb` guard inside the module elide the script-injection
// path at build time). Auto-skips popout / dock surfaces so they
// don't double-count as independent pageviews.
void import("./lib/analytics").then((m) => m.init());

const params = new URLSearchParams(window.location.search);
const isPopped = params.get("popped") === "1";
const isPhone = params.get("phone") === "1";
// Standalone local chain-style dock windows. Each mounts only the
// matching chain UI in popout variant — see
// `lib/evm/dockPopout.ts`, `lib/bitcoin/dockPopout.ts`, and
// `lib/svm/dockPopout.ts` for the open-side helpers.
const isEvmDock = params.get("evmDock") === "1";
const isBtcDock = params.get("btcDock") === "1";
const isSvmDock = params.get("svmDock") === "1";
const popoutMode = isPopped || isPhone || isEvmDock || isBtcDock || isSvmDock;

// Kick off the courses-summary IPC BEFORE React mounts. Skip on the
// popout / dock variants — they don't render the library so warming
// it just wastes a roundtrip. By the time the lazy App or MobileApp
// chunk loads and `useCourses`'s effect runs, the IPC has typically
// already settled, and the library renders against fresh data on the
// first paint instead of waiting on a post-mount round-trip.
if (!popoutMode) {
  prewarmCoursesSummary();
  bootLog("courses prewarm fired");
}

// Pick the right page lazily so we only download + parse the chunk
// the user actually needs. Critical on iPad: the desktop App pulls in
// Monaco, the multi-pane editor, ingest panel, AI assistant, and
// every dock variant at module-eval time. That single import tree
// blocks the iPad's main thread for seconds on cold launch — long
// enough that the inline preloader never advances and even the
// pre-React tap zone (devconsole.js's pink corner box) freezes
// mid-gesture. With `React.lazy`, main.tsx's own chunk stays small
// (this file + theme + storage prewarm) and the heavy code only
// loads after first paint, so the preloader stays alive and
// responsive while React's chunk downloads in the background.
//
// The Suspense fallback is `null` on purpose — the inline preloader
// in index.html is already painted and the body's `is-booted` class
// hasn't been added yet (App / MobileApp does that on first commit),
// so the user sees the preloader the whole time.
const Page = (() => {
  if (isEvmDock) {
    return lazy(() =>
      import("./components/ChainDock/ChainDock").then((m) => ({
        default: () => <m.ChainDock variant="popout" />,
      })),
    );
  }
  if (isBtcDock) {
    return lazy(() =>
      import("./components/BitcoinChainDock/BitcoinChainDock").then((m) => ({
        default: () => <m.BitcoinChainDock variant="popout" />,
      })),
    );
  }
  if (isSvmDock) {
    return lazy(() =>
      import("./components/SvmDock/SvmDock").then((m) => ({
        default: () => <m.SvmDock variant="popout" />,
      })),
    );
  }
  if (isPhone) return lazy(() => import("./components/PhonePopout/PhonePopoutView"));
  if (isPopped) return lazy(() => import("./components/Workbench/PoppedWorkbench"));
  return isMobile
    ? lazy(() => import("./mobile/MobileApp"))
    : lazy(() => import("./App"));
})();

bootLog(`page picked: ${isMobile ? "MobileApp" : popoutMode ? "popout" : "App"}`);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* I18nProvider wraps every page variant (App, MobileApp, all
        the popout / dock surfaces) so `useT()` is callable from
        anywhere in the tree. The provider's persisted locale is
        loaded synchronously from localStorage at mount, so the
        first paint already has the correct language. */}
    <I18nProvider>
      <Suspense fallback={null}>
        <Page />
      </Suspense>
    </I18nProvider>
  </React.StrictMode>,
);
bootLog("createRoot.render scheduled");

// Hand off from the inline index.html preloader to React's in-app
// bootloader. `is-booted` fades the preloader out via the CSS rule in
// index.html; App's `.libre__bootloader` (or MobileApp's
// `.m-app__boot`) takes over until the course list resolves.
//
// The handoff is now driven by App / MobileApp via a `useLayoutEffect`
// so the inline preloader stays visible until React has actually
// committed its first render — previously the eager
// `queueMicrotask`/`setTimeout(0)` fired before React painted on slow
// devices (esp. iOS WebKit cold-starting the bundle), leaving a black
// gap between the inline preloader fading and the React loader
// appearing. The 6s safety timeout below only kicks in if React fails
// to mount entirely (e.g. a syntax error in a downstream module, or
// the iPad gets so jammed loading the lazy chunk it never paints) —
// at that point the user is going to see *something* broken, but at
// least the preloader doesn't camp the screen forever. Bumped from
// 4s → 6s to give the lazy chunk extra headroom on cold iPad launches.
setTimeout(() => {
  if (!document.body.classList.contains("is-booted")) {
    bootLog("safety timeout hit — forcing is-booted");
    document.body.classList.add("is-booted");
  }
}, 6000);
