import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { onOpenUrl, getCurrent as getCurrentDeepLinks } from "@tauri-apps/plugin-deep-link";
import {
  type Course,
  filterCourseForDesktop,
  isExerciseKind,
} from "./data/types";
import { getAutoAdvanceEnabled } from "./lib/autoAdvance";
import { Icon } from "@base/primitives/icon";
import { libraryBig } from "@base/primitives/icon/icons/library-big";
import "@base/primitives/icon/icon.css";
import Sidebar from "./components/Sidebar/Sidebar";
import SidebarToggle from "./components/Sidebar/SidebarToggle";
import NavigationRail from "./components/NavigationRail/NavigationRail";
import TopBar from "./components/TopBar/TopBar";
import { Tour } from "./components/Tour/Tour";
import { TOUR_STEPS, type TourPage } from "./components/Tour/tourSteps";
import { stopTourAudio } from "./components/Tour/useTourAudio";
import { stopLessonAudio } from "./hooks/useLessonAudio";
import ChallengesView from "./components/Challenges/ChallengesView";
import PracticeView from "./components/Practice/PracticeView";
import EvmDockBanner from "./components/ChainDock/EvmDockBanner";
import BitcoinDockBanner from "./components/BitcoinChainDock/BitcoinDockBanner";
import SvmDockBanner from "./components/SvmDock/SvmDockBanner";
import TradeDockBanner from "./components/TradeDock/TradeDockBanner";
import ChallengeFrame from "./components/ChallengeFrame/ChallengeFrame";
import LessonView from "./components/Lesson/LessonView";
import {
  findNeighbors,
  slugify,
  findLesson,
  shouldShowEvmDock,
  shouldShowBitcoinDock,
  shouldShowSvmDock,
  shouldShowTradeDock,
} from "./lessonHelpers";
import { useLocalStorageState } from "./hooks/useLocalStorageState";
import { useKeybinding } from "./hooks/useKeybinding";
import ImportDialog from "./components/dialogs/ImportDialog/ImportDialog";
import BulkImportDialog from "./components/dialogs/ImportDialog/BulkImportDialog";
import DocsImportDialog from "./components/dialogs/ImportDialog/DocsImportDialog";
import SettingsDialog from "./components/dialogs/SettingsDialog/SettingsDialog";
import CourseLibrary from "./components/Library/CourseLibrary";
import ArchiveDropOverlay from "./components/Library/ArchiveDropOverlay";
import { useArchiveDrop } from "./hooks/useArchiveDrop";
import { DeferredMount, LoadingPane } from "./components/Shared/DeferredMount";
import LibreLoader from "./components/Shared/LibreLoader";
import { prefetchCovers } from "./hooks/useCourseCover";
import ConfirmDialog from "./components/dialogs/ConfirmDialog/ConfirmDialog";
import CourseSettingsModal from "./components/dialogs/CourseSettings/CourseSettingsModal";
import FloatingIngestPanel from "./components/IngestPanel/FloatingIngestPanel";
import ProfileView from "./components/Profile/ProfileView";
import SandboxView from "./components/Sandbox/SandboxView";
import SandboxSidebar from "./components/Sandbox/SandboxSidebar";
import { useSandboxProjects } from "./hooks/useSandboxProjects";
import { useAchievements } from "./hooks/useAchievements";
import AchievementOverlay from "./components/Achievements/AchievementOverlay";
import AchievementsPage from "./components/Achievements/AchievementsPage";
import SectionCompleteSummary from "./components/Achievements/SectionCompleteSummary";
import CertificatesPage from "./components/Certificates/CertificatesPage";
import PathsPage from "./components/Paths/PathsPage";
import { mintCertificate } from "./data/certificates";
import { notifyCertificatesChanged } from "./hooks/useCertificates";
import { playSound, unlockAudioContext } from "./lib/sfx";
import { isWeb, isMobile } from "./lib/platform";
import { consumePendingOAuthSession } from "./lib/oauthSession";
import { isoToUnixSeconds } from "./lib/timestamps";
import DownloadButton from "./components/DownloadButton/DownloadButton";
import GeneratePackDialog from "./components/dialogs/ChallengePack/GeneratePackDialog";
import { useIngestRun } from "./hooks/useIngestRun";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import AiAssistant from "./components/AiAssistant/AiAssistant";
import MobileApp from "./mobile/MobileApp";
import { InstallBanner } from "./components/banners/InstallBanner/InstallBanner";
import { UpdateBanner } from "./components/banners/UpdateBanner/UpdateBanner";
import CommandPalette from "./components/CommandPalette/CommandPalette";
import { VerifyCourseOverlay, type VerifySessionView } from "./components/VerifyCourse";
import FixApplierDialog from "./components/dialogs/FixApplier/FixApplierDialog";
import {
  verifyCourse,
  verifyAllCourses,
  collectVerifyTargets,
} from "./lib/verify/course";
import { syncBundledToInstalled } from "./lib/courseSync";
import {
  emitEvent as emitVerifierEvent,
} from "./lib/verify/bus";
import { useProgress } from "./hooks/useProgress";
import { useChainActivity } from "./hooks/useChainActivity";
import { useLibreCloud } from "./hooks/useLibreCloud";
import { useRealtimeSync } from "./hooks/useRealtimeSync";
import FirstLaunchPrompt from "./components/dialogs/SignInDialog/FirstLaunchPrompt";
import SetupWizard from "./components/dialogs/SetupWizard/SetupWizard";
import SignInDialog from "./components/dialogs/SignInDialog/SignInDialog";
import { useCourses } from "./hooks/useCourses";
import { useRecentCourses } from "./hooks/useRecentCourses";
import { useStreakAndXp } from "./hooks/useStreakAndXp";
import { useStreakShields } from "./hooks/useStreakShields";
import {
  LIBRARY_INSTALLED_IDS_KEY,
  LIBRARY_MARKER_LESSON_ID,
  isLibraryMarkerRow,
  serializeLibraryAllowlist,
} from "./lib/librarySync";
import { isHiddenCourse } from "./lib/hiddenCourses";
import {
  savePersistedTabs,
  validateTabsAgainstCourses,
  type OpenCourse,
  type TabGroup,
} from "./lib/openTabsState";
import "./App.css";

/// XP value for a given lesson kind. Mirrors the XP_PER_KIND map
/// inside useStreakAndXp.ts (kept module-private there); copying the
/// values is cheaper than re-exporting + re-typing the constant.
function xpForLessonKind(kind: string | undefined): number {
  switch (kind) {
    case "reading": return 5;
    case "quiz": return 10;
    case "exercise":
    case "mixed":
      return 20;
    default: return 0;
  }
}

/// Wrapper that resolves the currently-selected sidebar variant id
/// to its component and renders it with the standard sidebar Props.
export default function App() {
  // Mobile short-circuit. Renders a totally separate component tree
  // (no TopBar, no Sidebar, no editor) when running on a phone-sized
  // device. We bail before instantiating the desktop hooks tree so we
  // don't pay for any of the chrome the mobile UI doesn't use.
  if (isMobile) {
    return <MobileApp />;
  }

  const {
    courses: coursesAll,
    loaded: coursesLoaded,
    refresh: refreshCourses,
    hydrateCourse,
    hydrating,
  } = useCourses();

  /// Silently warm the cover cache once the course list has loaded.
  /// Doesn't gate any UI surface — the static `.libre__bootloader`
  /// already covers the boot-to-mount window — but the warmup means
  /// per-card BookCover hooks read out of a hot module cache the
  /// instant they mount, so the Library shelf paints cleanly without
  /// the "blurry → sharpen" cascade.
  useEffect(() => {
    if (!coursesLoaded || coursesAll.length === 0) return;
    void prefetchCovers(
      coursesAll.map((c) => ({
        courseId: c.id,
        cacheBust: c.coverFetchedAt,
      })),
    );
  }, [coursesLoaded, coursesAll]);

  // `filterCourseForDesktop` used to strip mobile-only drill lesson
  // kinds (puzzle / cloze / micropuzzle) from every desktop nav
  // surface. Those kinds were retired in favour of the unified
  // BlocksData render mode — the helper is now an identity
  // pass-through kept only for ABI compatibility.
  //
  // `hidden` filter: courses are dropped from the public listing if
  // EITHER the saved record has `hidden: true` (fresh seeds get this
  // from the manifest at install time) OR the course id is in the
  // runtime `HIDDEN_COURSE_IDS` allow-list (catches existing local
  // installs from before the flag was added — see `lib/hiddenCourses.ts`
  // for why both checks are needed). Hidden courses stay in
  // `coursesAll` so deep-link lookups by id below can still resolve
  // them — the filter only narrows the LISTING surface.
  const courses = useMemo(
    () =>
      coursesAll
        .map(filterCourseForDesktop)
        .filter((c) => !c.hidden && !isHiddenCourse(c.id)),
    [coursesAll],
  );

  // Always start with NO tabs open — the user lands on the Library
  // route on every launch and re-opens whatever lesson they want
  // from there. Persisted tabs from the previous session aren't
  // auto-restored, but `savePersistedTabs` keeps writing the
  // current snapshot so a future "Resume last session" affordance
  // has data to read.
  const [openTabs, setOpenTabs] = useState<OpenCourse[]>([]);
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  /// Tab-group definitions. Tabs reference a group by id via
  /// `OpenCourse.groupId`; this array carries the human-facing
  /// metadata (name, colour). Created lazily when the user picks
  /// "New group with…" from a tab's right-click menu; pruned in
  /// `validateTabsAgainstCourses` once the last referencing tab
  /// closes. Persisted alongside the tabs themselves.
  const [tabGroups, setTabGroups] = useState<TabGroup[]>([]);

  /// `cmd+K → "Verify this course"` session state. Null when no
  /// verification is in flight or visible. The overlay component
  /// renders this snapshot; mutation happens through `setVerifySession`
  /// + `verifyControllerRef` in the handlers below. We separate the
  /// AbortController from the snapshot so re-renders don't churn the
  /// controller identity.
  const [verifySession, setVerifySession] = useState<VerifySessionView | null>(
    null,
  );
  const verifyControllerRef = useRef<AbortController | null>(null);

  /// `cmd+K → "Apply fixes from prompt"` dialog open state. Null when
  /// closed; otherwise the id of the course to pre-select in the
  /// dropdown. App.tsx owns it so the dialog survives re-renders of
  /// any inner view.
  const [fixApplierForCourseId, setFixApplierForCourseId] = useState<
    string | null
  >(null);

  /// Pre-picked PDF/EPUB path that the unified Add Course flow
  /// passes into ImportDialog so the user doesn't have to re-pick
  /// a file they just selected from the smart picker. Cleared on
  /// dialog dismiss.
  const [preselectedImportPath, setPreselectedImportPath] = useState<
    string | null
  >(null);
  const [importOpen, setImportOpen] = useState(false);
  // Catalog browser modal — discovery surface for the Libre
  // library. Default seed only ships TRPL + Mastering Ethereum +
  // challenges; users add anything else from here.
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [docsImportOpen, setDocsImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /// When the floating UpdateBanner's "Open" button hands the user
  /// off to Settings, it sets this so the General pane auto-fires
  /// its check-for-updates handler on mount. Reset on dialog close
  /// so subsequent opens (Settings nav, version-tap dev-mode etc.)
  /// don't keep auto-checking.
  const [settingsAutoCheckUpdates, setSettingsAutoCheckUpdates] =
    useState(false);
  /// Single entry point for opening the Settings dialog. Optional
  /// `autoCheckUpdates` routes the UpdateBanner's available-state
  /// click through the canonical Settings check flow without each
  /// caller having to touch two state slots in lockstep.
  const openSettings = useCallback(
    (opts?: { autoCheckUpdates?: boolean }) => {
      setSettingsAutoCheckUpdates(opts?.autoCheckUpdates ?? false);
      setSettingsOpen(true);
    },
    [],
  );
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsAutoCheckUpdates(false);
  }, []);
  // Sign-in modal state, opened by the "Sign in" button in the TopBar
  // stats dropdown. Kept separate from `FirstLaunchPrompt` (which has
  // its own one-time-show gate) so signed-out users can re-open it
  // from the dropdown whenever they want.
  const [signInOpen, setSignInOpen] = useState(false);
  // Pending delete request queued by the library / sidebar context menu.
  // Kept in state rather than firing window.confirm() directly so we can
  // render an app-styled modal with Escape + backdrop-click dismissal.
  const [pendingDelete, setPendingDelete] = useState<{
    courseId: string;
    courseTitle: string;
  } | null>(null);

  /// Completion state lives in SQLite; the hook loads on mount and writes
  /// through on markCompleted. Keys are `${courseId}:${lessonId}`.
  const {
    completed,
    history,
    markCompleted,
    markCompletedBatch,
    clearLessonCompletion,
    clearChapterCompletions,
    clearCourseCompletions,
  } = useProgress();

  /// Optional Libre cloud account — bound at the app level so the
  /// first-launch prompt, the Settings → Account section, and the
  /// markCompleted-side-effect sync all share the same hook instance.
  const cloud = useLibreCloud();

  /// Listen for the browser-OAuth callback. The relay redirects to
  /// `libre://oauth/done?session=...&status=ok&token=fb_...` (or
  /// `status=error&error=...&message=...`); the deep-link plugin
  /// surfaces those URLs to us as a stream of strings. We parse the
  /// query params, hand the token to the cloud hook, and let it run
  /// the existing /me-on-mount fetch to materialise the user.
  ///
  /// `getCurrent` covers the cold-start case where the app was
  /// launched by the OS in response to the deep-link itself (the
  /// browser will have just dispatched it, the app boots, and the
  /// URL is waiting for us). `onOpenUrl` handles the warm case:
  /// the app was already running and the OS forwarded the URL.
  ///
  /// We pin the latest `cloud` instance into a ref so the listener
  /// closure can call the up-to-date `applyOAuthToken` without
  /// becoming a render-dep. If we listed `[cloud]` (or even
  /// `[cloud.applyOAuthToken]`) here, the effect would re-run every
  /// time the cloud state changed — re-subscribing the listener AND
  /// re-calling `getCurrentDeepLinks()`. On macOS the latter
  /// sometimes re-delivers the OAuth URL each call, which fires
  /// applyOAuthToken repeatedly — `user` flips to null between each
  /// `/me` resolve, causing the visible auth-state flashing the
  /// learner sees in the TopBar / Settings.
  const cloudRef = useRef(cloud);
  cloudRef.current = cloud;
  useEffect(() => {
    let cancelled = false;
    const handleUrls = (urls: string[]) => {
      for (const raw of urls) {
        try {
          const url = new URL(raw);
          // Defensive guard — the listener fires for any registered
          // scheme, and we only know how to handle our own.
          if (url.protocol !== "libre:") continue;

          // Route on the URL host (the segment after `libre://`):
          //   libre://oauth/done?status=ok&token=…   → cloud sign-in
          //   libre://open?courseId=…&lessonId=…     → land on lesson
          //
          // Unknown hosts are logged + ignored so a future scheme
          // addition doesn't crash older clients that haven't been
          // updated.
          const host = url.host || url.pathname.replace(/^\/+/, "").split("/")[0];

          if (host === "oauth") {
            const status = url.searchParams.get("status");
            const token = url.searchParams.get("token");
            // SECURITY: bind the callback to the in-flight sign-in
            // attempt. The relay round-trips the `session` nonce we
            // generated in SignInDialog (oauth_flow.rs appends it to
            // every return URL). Require it to match the single-use
            // nonce we stashed — otherwise ANY process/page that emits
            // `libre://oauth/done?status=ok&token=ATTACKER` could sign
            // the user into an attacker's account (login-CSRF). No
            // stashed nonce (unsolicited callback / replay) → reject.
            const callbackSession = url.searchParams.get("session");
            const expectedSession = consumePendingOAuthSession();
            if (status === "ok" && token) {
              if (
                !expectedSession ||
                !callbackSession ||
                callbackSession !== expectedSession
              ) {
                console.warn(
                  "[libre] oauth callback rejected: session nonce " +
                    "missing or mismatched — ignoring token (not from " +
                    "an in-app sign-in this client started).",
                );
              } else {
                console.log("[libre] oauth callback: success");
                void cloudRef.current.applyOAuthToken(token);
              }
            } else if (status === "error") {
              console.error(
                `[libre] oauth callback: error ${url.searchParams.get("error")} — ${url.searchParams.get("message")}`,
              );
            } else {
              console.warn(
                `[libre] oauth callback: unrecognised payload ${raw}`,
              );
            }
          } else if (host === "open") {
            // "Open in Libre" handoff from libre.academy. The
            // courseId is required; lessonId is optional (we fall
            // through to the course's first lesson if it's missing or
            // doesn't match anything in the course). We only stash a
            // pendingOpen request — the auto-open + warm-path effects
            // below pick it up and route accordingly.
            const courseId = url.searchParams.get("courseId");
            if (courseId) {
              const lessonId = url.searchParams.get("lessonId") ?? undefined;
              setPendingOpen({ courseId, lessonId });
            } else {
              console.warn(
                `[libre] open deep-link missing courseId: ${raw}`,
              );
            }
          } else {
            console.warn(`[libre] unrecognised deep link host=${host}: ${raw}`);
          }
        } catch (e) {
          console.error("[libre] deep-link: parse failed", e);
        }
      }
    };
    // Cold-start: the app may have been launched by clicking the
    // callback URL in the browser. Drain whatever URL fired the boot.
    void getCurrentDeepLinks()
      .then((urls) => {
        if (!cancelled && urls && urls.length > 0) handleUrls(urls);
      })
      .catch((e) => {
        // getCurrent returns a rejection on web preview / unsupported
        // hosts. Not fatal; the warm-path listener still works in
        // the desktop bundle.
        console.debug("[libre] deep-link getCurrent unavailable:", e);
      });
    // Warm-path listener. Returns an unlisten fn we call on unmount.
    const unlistenPromise = onOpenUrl(handleUrls).catch((e) => {
      console.debug("[libre] deep-link onOpenUrl unavailable:", e);
      return undefined;
    });
    return () => {
      cancelled = true;
      void unlistenPromise.then((fn) => {
        if (typeof fn === "function") fn();
      });
    };
    // Empty deps — run once on mount, unsubscribe on unmount. The
    // closure sees the latest cloud instance via cloudRef.current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /// Real-time cross-device sync. Handles three jobs in one place:
  ///   1. Initial full-pull on sign-in for progress / solutions /
  ///      settings — replaces the older one-shot localStorage-gated
  ///      pull (`libre:cloud:pulled-<uid>`) since the WS bus
  ///      will keep the device live anyway, and re-pulling on every
  ///      reconnect is cheap (a few hundred rows).
  ///   2. WebSocket subscription so a completion / save / setting
  ///      change on a sibling device is reflected here within a
  ///      network round-trip.
  ///   3. Debounced push helpers (`pushProgress`, `pushSolution`,
  ///      `pushSetting`) so the existing local-write paths can fan
  ///      out without re-implementing the batching themselves.
  ///
  /// The applier callbacks fold incoming rows into the same state
  /// the offline app uses (markCompleted for progress, the workbench
  /// localStorage key for solutions, the matching localStorage key
  /// for settings). Idempotent by construction — a no-op echo of a
  /// just-pushed row is harmless.
  const realtime = useRealtimeSync({
    cloud,
    applyProgress: useCallback(
      (
        rows: Array<{
          course_id: string;
          lesson_id: string;
          /// ISO 8601 from the relay. Bulk-applied via
          /// `markCompletedBatch` so a 150-row pull is one React
          /// setState + one storage write instead of 150 of each
          /// (the per-row path was the source of mobile's silently-
          /// failing IDB writes; same hook + same path on desktop
          /// keeps the wire-up consistent).
          completed_at: string;
        }>,
      ) => {
        // Split off library-marker rows (sentinel lesson id) before
        // routing the rest through `markCompletedBatch`. Markers
        // would otherwise show up in `history` as fake completions
        // and skew XP / streak / heatmap math. Desktop doesn't
        // currently consume the markers it pulls (its own course
        // list is authoritative), but we still strip them for
        // hygiene + future use.
        const real = rows.filter((r) => !isLibraryMarkerRow(r));
        markCompletedBatch(
          real.map((r) => ({
            courseId: r.course_id,
            lessonId: r.lesson_id,
            completedAtSec: isoToUnixSeconds(r.completed_at) ?? undefined,
          })),
        );
      },
      [markCompletedBatch],
    ),
    applySolutions: useCallback(
      (
        rows: Array<{ course_id: string; lesson_id: string; content: string }>,
      ) => {
        // Solutions persist under the workbench prefix used by
        // useWorkbenchFiles — write straight there so the next mount
        // of the lesson picks up the synced version. The on-screen
        // editor state for the *currently open* lesson stays put;
        // clobbering it mid-typing on a sibling-device sync would be
        // worse than the small inconsistency until the next reopen.
        for (const r of rows) {
          try {
            // Match the schema useWorkbenchFiles expects:
            // {signature, files, savedAt}. We don't know the
            // signature here (it's derived from starter), so we
            // leave the previous payload in place when present and
            // overwrite only the file blob — useWorkbenchFiles will
            // fall back to starter if signatures don't line up.
            const key = `kata:workbench:v1:${r.course_id}:${r.lesson_id}`;
            const previous = localStorage.getItem(key);
            const sig = previous
              ? (JSON.parse(previous) as { signature?: string }).signature ??
                ""
              : "";
            const parsed = JSON.parse(r.content) as unknown;
            const files = Array.isArray(parsed) ? parsed : null;
            if (!files) continue;
            localStorage.setItem(
              key,
              JSON.stringify({
                signature: sig,
                files,
                savedAt: Date.now(),
              }),
            );
          } catch {
            /* swallow — best-effort sync */
          }
        }
      },
      [],
    ),
    applySettings: useCallback(
      (rows: Array<{ key: string; value: string }>) => {
        for (const r of rows) {
          try {
            // Server-stored JSON; localStorage stores the same JSON
            // string so consumers can JSON.parse the same way they
            // did before sync existed.
            localStorage.setItem(r.key, r.value);
          } catch {
            /* swallow */
          }
        }
      },
      [],
    ),
  });

  /// Bridge `useWorkbenchFiles`' debounced save event into the
  /// realtime sync push pipeline. Without this, edits stayed local;
  /// with it, every keystroke (after the 400ms in-hook debounce
  /// plus the realtime hook's 600ms coalesce) lands on every other
  /// signed-in device.
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (
        ev as CustomEvent<{
          courseId: string;
          lessonId: string;
          files: unknown;
          savedAt?: number;
        }>
      ).detail;
      if (!detail) return;
      let serialized: string;
      try {
        serialized = JSON.stringify(detail.files);
      } catch {
        return;
      }
      realtime.pushSolution({
        course_id: detail.courseId,
        lesson_id: detail.lessonId,
        content: serialized,
        updated_at: new Date(detail.savedAt ?? Date.now()).toISOString(),
      });
    };
    window.addEventListener("libre:workbench-persisted", handler);
    return () => {
      window.removeEventListener("libre:workbench-persisted", handler);
    };
  }, [realtime]);

  /// Publish the desktop's installed-course-id list so the mobile /
  /// web build can mirror it. Both surfaces participate in this
  /// sync — desktop is treated as the authoritative writer (its
  /// bundled-packs are the user's explicit installation choice,
  /// every local change pushes immediately) while mobile defers
  /// until it sees a cloud baseline so its 19-course default seed
  /// doesn't clobber a user's curated desktop library on first
  /// sign-in. See `lib/librarySync.ts` for the full rationale.
  ///
  /// Only runs once `useCourses` has resolved (so we don't publish a
  /// transient empty list during cold-start) and only when signed in
  /// (no point pushing if the relay won't echo it). Coalesces via a
  /// "did the serialised list change?" ref so re-renders that don't
  /// touch the course list are free; the ref is hydrated from
  /// localStorage on mount so a hot-reload doesn't re-fire the same
  /// payload the relay already has.
  const lastPublishedLibraryRef = useRef<string | null>(
    (() => {
      try {
        return localStorage.getItem(LIBRARY_INSTALLED_IDS_KEY);
      } catch {
        return null;
      }
    })(),
  );
  useEffect(() => {
    if (!coursesLoaded || !cloud.signedIn) return;
    const ids = coursesAll.map((c) => c.id);
    const serialized = serializeLibraryAllowlist(ids);
    if (serialized === lastPublishedLibraryRef.current) return;
    lastPublishedLibraryRef.current = serialized;
    // Mirror into localStorage so a cold-start before the cloud
    // round-trips still has the latest snapshot to read on the next
    // boot (matches the pattern applySettings uses on inbound rows).
    try {
      localStorage.setItem(LIBRARY_INSTALLED_IDS_KEY, serialized);
    } catch {
      /* swallow */
    }
    // Canonical settings push. Mobile no longer relies on this for
    // library sync (the marker effect below covers that via the
    // always-available `/progress` endpoint), but we keep it for
    // any downstream consumer that watches the settings stream.
    realtime.pushSetting({
      key: LIBRARY_INSTALLED_IDS_KEY,
      value: serialized,
      updated_at: new Date().toISOString(),
    });
  }, [coursesAll, coursesLoaded, cloud, cloud.signedIn, realtime]);

  /// Library-marker push — separate from the settings push above so
  /// it's NOT gated by the localStorage-cached "did the list
  /// change?" check. The settings push uses that cache to avoid
  /// re-pushing identical payloads, but the cache turns into a trap
  /// for the marker pipeline: if a previous build cached the list
  /// in localStorage WITHOUT ever successfully pushing markers
  /// (which is exactly what happened — the relay had 3293 progress
  /// rows but 0 markers), the early-return fires forever and the
  /// markers never land. We track marker pushes against a separate
  /// ref + localStorage key so a missing-markers state always
  /// re-pushes on next mount.
  const lastPushedMarkersRef = useRef<string | null>(
    (() => {
      try {
        return localStorage.getItem("libre.library.markersPushed.v1");
      } catch {
        return null;
      }
    })(),
  );
  useEffect(() => {
    if (!coursesLoaded || !cloud.signedIn) return;
    const ids = coursesAll.map((c) => c.id);
    const serialized = serializeLibraryAllowlist(ids);
    if (serialized === lastPushedMarkersRef.current) return;
    lastPushedMarkersRef.current = serialized;
    // One marker row per installed course id. Receiving side (see
    // mobile's applyProgress) splits these out before they hit the
    // completion store, so they only signal library membership and
    // never pollute XP / streak math. Fire-and-forget; if the push
    // fails the next courses-change (or the next mount with a
    // different serialized list) tries again.
    const markerRows = coursesAll.map((c) => ({
      course_id: c.id,
      lesson_id: LIBRARY_MARKER_LESSON_ID,
      completed_at: new Date().toISOString(),
    }));
    if (markerRows.length === 0) return;
    cloud
      .pushProgress(markerRows)
      .then(() => {
        try {
          localStorage.setItem(
            "libre.library.markersPushed.v1",
            serialized,
          );
        } catch {
          /* swallow */
        }
      })
      .catch(() => {
        // Reset the ref so the next mount retries.
        lastPushedMarkersRef.current = null;
      });
  }, [coursesAll, coursesLoaded, cloud, cloud.signedIn]);

  /// Timestamp of the last fresh completion (transition from incomplete →
  /// complete). Drives the AI tutor's happy-celebration loop. Plain
  /// markCompleted is idempotent — re-passing a lesson the user has
  /// already finished doesn't re-fire it — so we filter on the
  /// `completed` set up here. The AiAssistant resets to idle on its
  /// own a few seconds later.
  const [celebrateAt, setCelebrateAt] = useState(0);
  /// Pending "auto advance" timer. We schedule a delayed
  /// `selectLesson(nextId)` after a fresh exercise pass when the
  /// learner opted into the auto-advance preference (Settings →
  /// General → Auto-advance after a pass). The id is parked here so
  /// any manual navigation (Prev/Next click, lesson picked from the
  /// sidebar, command-palette jump) can cancel it before it fires —
  /// otherwise the auto-advance would yank the learner away ~1s
  /// after they manually navigated elsewhere, which reads as the
  /// app misbehaving rather than a feature.
  const autoAdvanceTimerRef = useRef<number | null>(null);
  /// Timestamp (ms since epoch) at which the pending auto-advance
  /// will fire. Null when no auto-advance is queued. Surfaced to
  /// LessonView → LessonNav so the Next button can paint a 3..2..1
  /// countdown ring (Notion issue #9180e1cfc9e068a8 — "When auto
  /// advance is on, show a timer with 3…2….1 in a circular
  /// progress bar over the proceed button"). State (not just a
  /// ref) because the LessonNav consumer needs to re-render when
  /// the timer starts / cancels.
  const [autoAdvanceFireAt, setAutoAdvanceFireAt] = useState<number | null>(null);
  const clearPendingAutoAdvance = useCallback(() => {
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
    setAutoAdvanceFireAt(null);
  }, []);
  // Belt-and-braces unmount cleanup so a pending auto-advance timer
  // doesn't fire into a torn-down App (rare — App is the root in the
  // main window — but it can happen in tray/popout surfaces that
  // share the bundle but never render LessonView).
  useEffect(() => clearPendingAutoAdvance, [clearPendingAutoAdvance]);
  function markCompletedAndCelebrate(courseId: string, lessonId: string) {
    const key = `${courseId}:${lessonId}`;
    const isFresh = !completed.has(key);
    if (isFresh) {
      setCelebrateAt(Date.now());
      // Web-only: log the completion as a custom analytics event.
      // Coarse props (courseId + lessonId + kind) — no PII, no
      // sensitive data — so the Plausible dashboard can break
      // "which courses are people finishing?" out by id without
      // touching individual users. No-op on desktop / iOS builds.
      void import("./lib/analytics").then(({ trackEvent }) => {
        trackEvent("lesson.complete", { courseId, lessonId });
      });
      // Compute and stash XP for the lesson so the section summary
      // card can credit "+N XP" without re-walking the lesson body
      // when the section card eventually triggers.
      const course = coursesAll.find((c) => c.id === courseId);
      const lesson = course?.chapters
        .flatMap((c) => c.lessons)
        .find((l) => l.id === lessonId);
      const xp = xpForLessonKind(lesson?.kind);
      lastLessonXpRef.current = xp;
      // Small audible cue per fresh lesson — keeps the rhythm of
      // completion tactile. Larger tier sounds (chime, fanfare) layer
      // on top via the achievement engine's own dispatch.
      playSound("xp-pop", { volume: 0.7 });
    }
    markCompleted(courseId, lessonId);
    // Mirror to the cloud via the realtime sync hook. Coalesces by
    // (course, lesson) inside the hook so bulk completions (e.g. a
    // verifier sweep) collapse into one network call. Fire-and-forget
    // — the local mark already succeeded, the relay is best-effort.
    realtime.pushProgress({
      course_id: courseId,
      lesson_id: lessonId,
      completed_at: new Date().toISOString(),
    });
    // Tell the watch-mode verifier (cmd+K → Verify course) that this
    // lesson is now done. Fires for ALL completion paths — exercise
    // pass, reading + Next, quiz all-correct — so the verifier loop
    // can advance without caring which kind it just finished.
    emitVerifierEvent({ type: "lessonComplete", courseId, lessonId });

    // Auto-advance — opt-in via Settings → General → Auto-advance.
    // Three gates, all required:
    //   - the user actually enabled the preference,
    //   - this was a FRESH pass (no point auto-advancing again on a
    //     re-pass of a lesson already in the completed set — the
    //     learner is probably revisiting deliberately),
    //   - the lesson is a code exercise (kind "exercise" or "mixed").
    //     The user's request was specifically "when a test passes on
    //     a code exercise" — quiz lessons + plain readings have
    //     their own "Next" affordance the learner clicks deliberately.
    // The delay lets the celebration play out — `xp-pop` (~300ms),
    // the AI tutor's celebration loop, and the visual completion
    // tick on the lesson card. 1400ms is enough to register the
    // pass without dragging the rhythm.
    // Re-resolve the lesson here — the existing `course`/`lesson`
    // locals above are scoped inside the `isFresh` branch (for the
    // XP-stashing path), so we can't reach them. Cost of the second
    // walk is negligible against the rest of this function's
    // realtime / verifier / analytics work.
    if (isFresh && getAutoAdvanceEnabled()) {
      const course = coursesAll.find((c) => c.id === courseId);
      const lesson = course?.chapters
        .flatMap((c) => c.lessons)
        .find((l) => l.id === lessonId);
      if (lesson && isExerciseKind(lesson) && course) {
        const next = findNeighbors(course, lessonId).next;
        if (next) {
          clearPendingAutoAdvance();
          // 3-second delay (bumped from 1400ms) so the Next
          // button's circular 3..2..1 countdown has room to tell
          // the story — the timer ring sweeps from full to empty
          // while the digit ticks 3 → 2 → 1. The longer delay
          // also reads as "you have time to look at the celebration
          // before we move on" rather than a yank.
          const fireAt = Date.now() + 3000;
          setAutoAdvanceFireAt(fireAt);
          autoAdvanceTimerRef.current = window.setTimeout(() => {
            autoAdvanceTimerRef.current = null;
            setAutoAdvanceFireAt(null);
            selectLesson(courseId, next.id);
          }, 3000);
        }
      }
    }
  }
  // Stats use the UNFILTERED list so XP / streak / longest-streak stay
  // correct even when the learner racked up completions via drill kinds
  // we hide from the desktop nav. See `filterCourseForDesktop` doc in
  // data/types.ts.
  const shields = useStreakShields();
  const stats = useStreakAndXp(history, coursesAll, shields.frozenDays);

  /// Achievement / sound / animation system. Reactive — re-evaluates
  /// the registry whenever history / streak / level changes and
  /// surfaces the freshly-unlocked rows via `pendingPresentation`
  /// for the AchievementOverlay to drain.
  const achievements = useAchievements(history, coursesAll, stats);

  /// Track section / book completion transitions. We compare the
  /// previous completed Set to the new one whenever it changes;
  /// when the count of completed lessons in a chapter / course
  /// flips from <total to ==total, that's our trigger.
  ///
  /// State is the chapter / book payload to render in the summary
  /// card (null when no card is showing). Two cards never stack —
  /// if a chapter wraps and that chapter was the last one, the book
  /// card supersedes the chapter card (book wins, since the user
  /// gets a card either way and stacking is noisy).
  const [sectionSummary, setSectionSummary] = useState<
    | { kind: "chapter"; courseId: string; chapterIdx: number; xpEarned: number }
    | { kind: "book"; courseId: string; xpEarned: number }
    | null
  >(null);
  const prevCompletedRef = useRef<Set<string>>(completed);
  // Stash the per-lesson XP from the last lesson the learner finished
  // so the section summary can show "+N XP earned" without re-walking
  // the lesson body to look up its kind. Updated by markCompletedAndCelebrate.
  const lastLessonXpRef = useRef<number>(0);
  useEffect(() => {
    const prev = prevCompletedRef.current;
    if (prev === completed) return;
    // Find new completions since last render — should usually be one,
    // but a sync push could land several at once. We only celebrate
    // section completions that close out a chapter / book; sync
    // back-fill of historical completions doesn't get a card (the
    // initRef-style guard below handles cold-start).
    const newKeys: string[] = [];
    for (const k of completed) if (!prev.has(k)) newKeys.push(k);
    prevCompletedRef.current = completed;
    if (newKeys.length === 0) return;
    if (newKeys.length > 5) return; // bulk sync — not user-driven, no card.
    // Walk backwards from the latest key. If completing it closed a
    // chapter and/or a book, surface the right card. We pick the
    // FIRST chapter / book event — typing speeds + Tauri IPC ordering
    // mean a single user action only ever closes one section at a time.
    for (const key of newKeys) {
      const [courseId, lessonId] = key.split(":");
      const course = coursesAll.find((c) => c.id === courseId);
      if (!course) continue;
      const chapterIdx = course.chapters.findIndex((ch) =>
        ch.lessons.some((l) => l.id === lessonId),
      );
      if (chapterIdx < 0) continue;
      const chapter = course.chapters[chapterIdx];
      const allChapterDone = chapter.lessons.every((l) =>
        completed.has(`${courseId}:${l.id}`),
      );
      if (!allChapterDone) continue;
      const allBookDone = course.chapters.every((ch) =>
        ch.lessons.every((l) => completed.has(`${courseId}:${l.id}`)),
      );
      if (allBookDone) {
        setSectionSummary({
          kind: "book",
          courseId,
          xpEarned: lastLessonXpRef.current,
        });
        // Mint a course-completion certificate alongside the
        // celebration card. Idempotent — `mintCertificate` no-ops
        // when the courseId already has a cert (so re-completing
        // after a reset, sync replay, or the same useEffect
        // firing twice in StrictMode dev doesn't duplicate). The
        // recipient name + email get captured at issue time so a
        // future display-name change doesn't rewrite history.
        const totalLessons = course.chapters.reduce(
          (n, ch) => n + ch.lessons.length,
          0,
        );
        const recipientName =
          (typeof cloud.user === "object" && cloud.user?.display_name) ||
          (typeof cloud.user === "object" && cloud.user?.email
            ? cloud.user.email.split("@")[0]
            : null) ||
          "Libre learner";
        const recipientEmail =
          typeof cloud.user === "object" && cloud.user?.email
            ? cloud.user.email
            : undefined;
        // Find the FIRST completion timestamp for this course by
        // walking the history rows. The cert face shows a date
        // range (Started → Completed) so the learner sees the
        // span of the journey, not just the finish line. Falls
        // back to undefined when no history row exists (e.g., a
        // bulk-sync replay where the cert mint fires before
        // history is populated) — the ticket UI hides the row in
        // that case.
        const courseHistory = history.filter((c) => c.course_id === courseId);
        const startedAt =
          courseHistory.length > 0
            ? new Date(
                Math.min(...courseHistory.map((c) => c.completed_at)) * 1000,
              ).toISOString()
            : undefined;
        void mintCertificate({
          courseId,
          courseTitle: course.title,
          courseLanguage: course.language,
          recipientName,
          recipientEmail,
          lessonCount: totalLessons,
          xpEarned: lastLessonXpRef.current,
          startedAt,
        }).then((cert) => {
          // Tell the listing page (if mounted) to re-read so a
          // freshly-earned cert appears without a route flush.
          // Safe to call unconditionally — the hook's listener
          // is a no-op if the page isn't mounted.
          notifyCertificatesChanged();
          // eslint-disable-next-line no-console
          console.log("[libre] minted certificate", cert.id, cert.courseTitle);
        });
      } else {
        setSectionSummary({
          kind: "chapter",
          courseId,
          chapterIdx,
          xpEarned: lastLessonXpRef.current,
        });
      }
      break;
    }
  }, [completed, coursesAll, cloud.user, history]);

  // First user gesture: warm the AudioContext so the very first
  // sound cue plays without the iOS-Safari silent-first-play wart.
  // We listen on `pointerdown` and remove ourselves after the first
  // fire — no-op on subsequent gestures.
  useEffect(() => {
    const onGesture = () => {
      void unlockAudioContext();
      window.removeEventListener("pointerdown", onGesture);
    };
    window.addEventListener("pointerdown", onGesture, { passive: true });
    return () => window.removeEventListener("pointerdown", onGesture);
  }, []);

  /// Reactive flags for "is there transaction state on either
  /// in-process chain right now?" Used to gate the EVM and Bitcoin
  /// dock visibility on lesson view AND on the Sandbox — once a
  /// learner runs a chain lesson, the dock follows them across
  /// views until they hit Reset.
  const chainActivity = useChainActivity();

  /// Per-course "last opened" timestamps for the sidebar carousel. Stored
  /// in localStorage so recent-first ordering survives an app restart.
  /// Updated inside selectLesson so any path that navigates to a course
  /// (tab click, sidebar lesson click, carousel click, library open) feeds
  /// the signal uniformly.
  const { recents: recentCourses, touch: touchRecentCourse } = useRecentCourses();

  /// Ingest run lifted to app level so it survives ImportDialog dismissal.
  /// Every per-lesson save triggers onCourseSaved, which re-fetches the
  /// courses list — the sidebar fills in with new lessons as the pipeline
  /// generates them. Debounced via useCourses' own internal handling.
  const {
    run: ingest,
    start: startIngest,
    startBulk: startBulkIngest,
    startRegenExercises,
    startGenerateChallengePack,
    startDocsIngest,
    startEnrichCourse,
    startRetryLesson,
    cancel: cancelIngest,
    dismiss: dismissIngest,
  } = useIngestRun({ onCourseSaved: () => { refreshCourses(); } });

  /// Course-id of the course whose settings modal is open. `null` when
  /// no settings modal is showing. Opened from the sidebar's right-click
  /// "Course settings…" action.
  const [courseSettingsId, setCourseSettingsId] = useState<string | null>(null);

  /// Which main-pane route is showing. "courses" is the default (welcome /
  /// inline library / lesson view depending on tab state). "profile" and
  /// "sandbox" are dedicated destinations triggered from the sidebar
  /// iconbar. Selecting a lesson anywhere forces back to "courses" so the
  /// learner isn't stuck on a side view after clicking a sidebar item.
  const [view, setViewRaw] = useState<
    | "courses"
    | "profile"
    | "sandbox"
    | "library"
    | "discover"
    | "challenges"
    | "practice"
    | "paths"
    | "achievements"
    | "certificates"
  >("library");

  /// `useTransition` lets us mark the view-switch state update as
  /// non-urgent. React then renders the NEW view in the background
  /// while keeping the CURRENT view interactive. Without this, a
  /// click on Discover (which forces CourseLibrary to remount with
  /// a different scope: re-fold ~150 catalog entries, prefetch
  /// covers, build the section tree) blocked the main thread for
  /// the duration of that mount + first paint — the user perceived
  /// it as "the app freezes for a second then jumps to the new
  /// view." With the transition, the previous view stays painted
  /// (visually identical to before the click), the new view's
  /// render happens on the side, and React swaps when ready.
  /// `isPending` is true during the swap so we can dim the previous
  /// view slightly as a "yes, your click registered" cue without
  /// blanking the screen.
  const [isViewPending, startViewTransition] = useTransition();
  const setView = useCallback(
    (next: typeof view) => {
      // Wrap every external setView in the transition so EVERY
      // view-switch path benefits — sidebar clicks, rail clicks,
      // tour navigation, post-completion routing, etc. The single
      // call site keeps the perceived-latency fix consistent
      // across surfaces.
      //
      // Timing log goes to the dev console so we can see exactly
      // how long each view-swap takes — Library ↔ Discover used to
      // pin the main thread for several seconds because every
      // CourseLibrary mount re-fetched + re-hashed every course.
      // The cache in courseSync.ts now keeps these swaps under
      // ~50ms once warm; the log is the receipt.
      const t0 = performance.now();
      startViewTransition(() => {
        setViewRaw(next);
      });
      // Measure on the next frame — by then React has finished the
      // commit for this transition's first paint.
      requestAnimationFrame(() => {
        // eslint-disable-next-line no-console
        console.log(
          `[nav] → ${next} in ${(performance.now() - t0).toFixed(0)}ms`,
        );
      });
    },
    [startViewTransition],
  );

  /// Challenge-pack generation dialog visibility. Opened from the Profile
  /// page's "Generate challenge pack" CTA; runs through useIngestRun when
  /// submitted and closes itself.
  const [genPackOpen, setGenPackOpen] = useState(false);

  /// Sidebar collapsed state. Persisted so a learner who prefers the
  /// full-width pane (e.g. writing a long exercise) doesn't have to
  /// re-hide the sidebar every launch. Toggled by the top-bar button or
  /// Cmd+\\ (matches VS Code's muscle memory).
  ///
  /// One-shot migration of the legacy `kata:sidebarCollapsed` key to
  /// the modern `libre:` namespace. Runs once at mount; if the new
  /// key already has a value the legacy key just gets removed.
  useEffect(() => {
    try {
      const legacy = localStorage.getItem("libre:sidebarCollapsed");
      if (legacy != null) {
        if (localStorage.getItem("libre:sidebarCollapsed") == null) {
          localStorage.setItem("libre:sidebarCollapsed", legacy);
        }
        localStorage.removeItem("libre:sidebarCollapsed");
      }
    } catch {
      /* private mode — fine to drop */
    }
  }, []);
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorageState<boolean>(
    "libre:sidebarCollapsed",
    false,
    {
      // Stored as "0" / "1" rather than JSON booleans so legacy
      // `kata:sidebarCollapsed` reads pre-migration are interpreted
      // identically.
      serialize: (v) => (v ? "1" : "0"),
      deserialize: (raw) => raw === "1",
    },
  );

  // Hover-reveal is handled in CSS via `:has()` — see App.css. We
  // tried a JS sidebarHover state first but the synthetic onMouse-
  // Enter/Leave events fired unreliably over the Tauri overlay
  // title-bar zone (the OS-level drag-region detection intercepts
  // pointer hits before React's event system sees them on macOS
  // Tauri builds). Native CSS :hover bypasses that entirely.

  // Sandbox projects state — lifted to App level so the project
  // switcher + file tree rendered in the sidebar slot (when
  // view === "sandbox") and SandboxView's editor share one source
  // of truth. The hook persists the whole project list to
  // localStorage under `libre:sandbox:v1:*`; mounting it at App
  // means the persistence stays consistent across view switches
  // without re-instantiating + flushing every time the user enters
  // the sandbox. (Migrates the user's old per-language playground
  // entries on first load — see `useSandboxProjects.ts`.)
  const sandboxProjects = useSandboxProjects("javascript");

  // First-run guided tour. The tour itself never auto-starts anymore
  // — instead we surface a confirmation dialog (`tourPromptOpen`,
  // below) on the very first launch asking the learner whether they
  // want a quick walkthrough. Auto-starting felt ambush-y: a brand
  // new user opens the app and immediately a narrated walkthrough
  // hijacks every nav surface. The opt-in prompt respects "I want to
  // poke around first" while keeping the discovery affordance.
  // Re-triggerable forever from the navigation rail's help icon.
  // Each step's narration MP3 ships under `public/tour-audio/` so
  // the tour works offline on cold launch — no CDN dependency.
  const [tourActive, setTourActive] = useState(false);
  // First-launch prompt state. We show the "Take the tour?" dialog
  // once per device, gated on a separate `:tour-prompted` flag (the
  // legacy `:tour-completed` key is also honoured so existing
  // installs that were upgraded from the auto-start build don't get
  // re-prompted just because they never explicitly marked the tour
  // done). Initialised lazily inside an effect because we want to
  // wait for the cold-start bootloader to fade and FirstLaunchPrompt
  // (the sign-in nudge) to either dismiss or render — stacking two
  // modal backdrops on the very first paint is jarring.
  const [tourPromptOpen, setTourPromptOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let alreadyPrompted = false;
    try {
      alreadyPrompted =
        localStorage.getItem("libre:tour-prompted") === "true" ||
        localStorage.getItem("libre:tour-completed") === "true";
    } catch {
      alreadyPrompted = true; // private mode — never pester
    }
    if (alreadyPrompted) return;
    // Wait until both the bootloader has had a paint AND
    // FirstLaunchPrompt's own ~800ms delay has fired so the two
    // dialogs aren't competing for the user's attention on the same
    // frame. 1600ms is comfortably after FirstLaunchPrompt's open
    // moment but still feels prompt rather than nag-y.
    const id = window.setTimeout(() => {
      if (cancelled) return;
      setTourPromptOpen(true);
    }, 1600);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, []);
  const markTourPrompted = useCallback(() => {
    try {
      localStorage.setItem("libre:tour-prompted", "true");
    } catch {
      /* private-mode — drop the flag silently */
    }
  }, []);
  const handleTourPromptAccept = useCallback(() => {
    markTourPrompted();
    setTourPromptOpen(false);
    stopLessonAudio();
    setTourActive(true);
  }, [markTourPrompted]);
  const handleTourPromptSkip = useCallback(() => {
    markTourPrompted();
    setTourPromptOpen(false);
  }, [markTourPrompted]);
  /// When the tour starts we stop any in-flight lesson audio so the
  /// two narrators don't fight for the listener's ear. The reverse
  /// is implicit — opening the tour calls this; closing leaves the
  /// lesson audio paused (the user can resume manually).
  const handleTourStart = useCallback(() => {
    stopLessonAudio();
    setTourActive(true);
  }, []);
  const handleTourComplete = useCallback(() => {
    setTourActive(false);
    stopTourAudio();
    try {
      localStorage.setItem("libre:tour-completed", "true");
    } catch {
      /* private-mode — drop the flag silently */
    }
  }, []);
  const handleTourNavigate = useCallback(
    (page: string) => {
      // The tour's `step.page` is one of TourPage; the App's `view`
      // happens to overlap exactly. Cast through TourPage for the
      // type-checker's sake; runtime is a no-op.
      setView(page as TourPage);
    },
    [setView],
  );
  // Sidebar toggle. The binding ("app.toggle-sidebar", default ⌘\)
  // is owned by the keybindings registry — see
  // src/lib/keybindings/registry.ts — so the Settings → Shortcuts
  // pane shows + rebinds it alongside every other global chord.
  useKeybinding("app.toggle-sidebar", () => {
    setSidebarCollapsed((v) => !v);
  });

  // Hand off from index.html's inline preloader to our React loader.
  // Runs in a layout-effect (post-DOM-mutate, pre-paint) so the inline
  // preloader fades exactly when `.libre__bootloader` is on screen
  // — no black gap on cold-start. Safe to run once; the safety
  // timeout in main.tsx is a no-op if we got here first.
  useLayoutEffect(() => {
    document.body.classList.add("is-booted");
  }, []);

  /// Global command palette toggle. The binding
  /// ("app.command-palette", default ⌘K) lives in
  /// src/lib/keybindings/registry.ts; the hook handles both the
  /// "fire while inside an input" case (it does NOT fire — the
  /// input keeps the keystroke unless allowInInput is set, which
  /// we don't need here since the palette closes input focus on
  /// open) and the platform fork (⌘ on mac, Ctrl elsewhere). The
  /// palette's own Esc / repeated chord handlers manage close.
  const [paletteOpen, setPaletteOpen] = useState(false);
  useKeybinding("app.command-palette", () => {
    setPaletteOpen((v) => !v);
  });

  /// Open the Settings dialog from anywhere — standard mac chord
  /// ⌘, (Ctrl+, on Windows / Linux). Same registry-driven path as
  /// every other global binding above.
  useKeybinding("app.settings", () => {
    setSettingsOpen(true);
  });

  // Pending-open: a request to land on a specific course+lesson at boot,
  // sourced from either:
  //   - the web build's URL params (`?courseId=…&lessonId=…`) — set when
  //     libre.academy hands the learner over via "Start in browser"
  //     or "Open in Libre".
  //   - a desktop `libre://open?courseId=…&lessonId=…` deep link,
  //     handled by the listener above (which calls setPendingOpen).
  //
  // The state survives the initial render so the auto-open effect below
  // can pick the right course as soon as `coursesLoaded` flips true. On
  // a successful match we clear pendingOpen so a later URL-bar manual
  // edit (or a stale ?courseId in browser history) doesn't yank the
  // learner away from a tab they actively opened.
  const [pendingOpen, setPendingOpen] = useState<{
    courseId: string;
    lessonId?: string;
  } | null>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const courseId = params.get("courseId");
      if (!courseId) return null;
      const lessonId = params.get("lessonId") ?? undefined;
      return { courseId, lessonId };
    } catch {
      return null;
    }
  });

  // On fresh launch (courses loaded, no tabs yet), open a starting lesson
  // as a convenience. Picks the pendingOpen target when one's set + the
  // course exists; otherwise falls back to courses[0]. Skipped on re-mount
  // once the learner has actively opened/closed tabs — closing the last
  // tab should NOT auto-re-open it, the learner wanted the library view.
  // The ref is flipped after the first auto-open OR after any manual
  // selectLesson call so repeated close-all cycles don't keep re-opening.
  //
  // Initial value of `true` always — the app lands on the Library
  // route with no tabs open by default. The auto-open-first-course
  // path used to fire on a true cold start (no persisted snapshot)
  // and pick courses[0] for the user, but that's confusing when
  // the intended landing surface is the Library list itself.
  // Deep-link / pendingOpen flows still set tabs explicitly via
  // selectLesson; only the implicit "open something" pass is
  // disabled here.
  const didAutoOpen = useRef(true);
  useEffect(() => {
    if (didAutoOpen.current) return;
    if (!coursesLoaded || courses.length === 0 || openTabs.length !== 0) return;

    // pendingOpen comes from the deep link's `?courseId=…`; resolve
    // against `coursesAll` (NOT `courses`) so hidden / unlisted
    // courses are still openable by direct URL — that's the whole
    // point of the unlisted flag. Falling back to `courses[0]` uses
    // the filtered list because if no deep link was supplied, we
    // want the user landing on something they can also see in the
    // library.
    let target = pendingOpen
      ? coursesAll.find((c) => c.id === pendingOpen.courseId)
      : undefined;
    if (!target) target = courses[0];

    // Resolve the lesson id: prefer the pendingOpen lessonId if it
    // actually exists in the resolved course, otherwise fall through
    // to the course's first lesson. Guards against stale links to
    // lessons that were renamed or removed.
    const lessonExists =
      pendingOpen?.lessonId &&
      target.id === pendingOpen.courseId &&
      target.chapters.some((ch) =>
        ch.lessons.some((l) => l.id === pendingOpen.lessonId),
      );
    const lessonId = lessonExists
      ? pendingOpen!.lessonId!
      : target.chapters[0]?.lessons[0]?.id;
    if (!lessonId) return;

    didAutoOpen.current = true;
    setOpenTabs([{ courseId: target.id, lessonId }]);
    setPendingOpen(null);

    // Strip ?courseId=… off the URL so a refresh doesn't re-yank
    // them back to this course after they've moved on. Only does the
    // strip when we matched something — leaves a pendingOpen that
    // failed to resolve in the URL so a power user can see what was
    // requested.
    if (pendingOpen) {
      try {
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.hash,
        );
      } catch {
        /* history.replaceState isn't available — fine, no-op */
      }
    }
  }, [coursesLoaded, courses, openTabs.length, pendingOpen]);

  // On-demand install for unlisted / share-by-link courses. When a
  // direct link `?courseId=…` references a course that isn't in
  // IndexedDB (the catalog manifest doesn't carry it, so the
  // first-launch seed didn't pick it up), fall back to fetching
  // `/starter-courses/<id>.json` and saving it with `hidden: true`
  // so it stays out of the listings on next mount but is fully
  // playable for the duration of this visit.
  //
  // Only fires for the Tauri-stub `isWeb` build path. Desktop falls
  // through to the existing catalog/install flow (the manifest is
  // the source of truth there too — if the entry isn't in it, the
  // user can't reach it via deep link).
  const installAttemptRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!pendingOpen) return;
    if (!coursesLoaded) return;
    if (!isWeb) return;
    if (coursesAll.find((c) => c.id === pendingOpen.courseId)) return;
    if (installAttemptRef.current.has(pendingOpen.courseId)) return;
    installAttemptRef.current.add(pendingOpen.courseId);

    void (async () => {
      try {
        const url = `https://libre.academy/starter-courses/${pendingOpen.courseId}.json`;
        const res = await fetch(url, { cache: "no-cache" });
        if (!res.ok) {
          console.warn(
            `[deep-link] no ${url} (HTTP ${res.status})`,
          );
          return;
        }
        const course = (await res.json()) as Course;
        // Force the URL-bar id and stamp `hidden: true` so the
        // course never shows up in Library/Discover/Sidebar after
        // landing — the only path back is the direct link itself.
        const record: Course = {
          ...course,
          id: pendingOpen.courseId,
          hidden: true,
        };
        const { storage } = await import("./lib/storage");
        await storage.saveCourse(pendingOpen.courseId, record);
        await refreshCourses();
      } catch (err) {
        console.warn(
          `[deep-link] on-demand install failed for ${pendingOpen.courseId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    })();
  }, [pendingOpen, coursesLoaded, coursesAll, refreshCourses]);

  // Warm-path: if a deep link arrives after the app's already booted
  // and the learner has tabs open, honour it via selectLesson rather
  // than appending it to the auto-open queue.
  useEffect(() => {
    if (!pendingOpen) return;
    if (!didAutoOpen.current) return; // cold-start path handles it
    if (!coursesLoaded || coursesAll.length === 0) return;
    // Same `coursesAll` rationale as the cold-start path above:
    // hidden courses must be resolvable by deep link, but listings
    // shouldn't see them.
    const course = coursesAll.find((c) => c.id === pendingOpen.courseId);
    if (!course) {
      setPendingOpen(null);
      return;
    }
    const exists =
      pendingOpen.lessonId &&
      course.chapters.some((ch) =>
        ch.lessons.some((l) => l.id === pendingOpen.lessonId),
      );
    const lessonId = exists
      ? pendingOpen.lessonId!
      : course.chapters[0]?.lessons[0]?.id;
    if (!lessonId) return;
    selectLesson(course.id, lessonId);
    setPendingOpen(null);
    // selectLesson is stable enough that listing it as a dep would
    // cause the effect to run on every keystroke (it's recreated each
    // render). pendingOpen + coursesLoaded are the actual triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOpen, coursesLoaded, courses]);

  // Persist tab state on every change. Cheap (<1 KB to localStorage)
  // and synchronous, so the next launch reads exactly what the
  // learner left behind — which course tabs were open, which one was
  // active, plus tab-group definitions. No debounce needed: tab
  // open/close/switch/reorder/group-edit are infrequent events
  // triggered by user clicks, not by every keystroke.
  useEffect(() => {
    savePersistedTabs({
      tabs: openTabs,
      groups: tabGroups,
      activeIndex: activeTabIndex,
    });
  }, [openTabs, tabGroups, activeTabIndex]);

  // Validate restored tabs against the live course list once it loads.
  // A learner who uninstalled a course between sessions would otherwise
  // boot into a tab pointing at a missing course → LessonView would
  // render nothing. Run-once via the ref guard: subsequent course-list
  // mutations (a new install, an update) shouldn't invalidate tabs the
  // learner JUST opened.
  const didValidateRestoredTabs = useRef(false);
  useEffect(() => {
    if (didValidateRestoredTabs.current) return;
    if (!coursesLoaded || courses.length === 0) return;
    didValidateRestoredTabs.current = true;
    if (openTabs.length === 0) return; // nothing to validate
    const cleaned = validateTabsAgainstCourses(
      { tabs: openTabs, activeIndex: activeTabIndex },
      courses,
    );
    if (
      cleaned.tabs.length !== openTabs.length ||
      cleaned.activeIndex !== activeTabIndex
    ) {
      setOpenTabs(cleaned.tabs);
      setActiveTabIndex(cleaned.activeIndex);
      // Stale-uninstall recovery: if EVERY saved tab pointed at a
      // course that's no longer installed, the learner clearly wanted
      // a lesson open (not the library — that would have persisted as
      // `tabs: []`). Re-arm the auto-open ref so the existing
      // courses[0] convenience effect fires on the next render and
      // they land on something instead of an empty shell.
      if (cleaned.tabs.length === 0) {
        didAutoOpen.current = false;
      }
    }
    // openTabs / activeTabIndex deliberately not in deps — this is a
    // one-shot validation against the freshly-loaded course list. We
    // only care about the snapshot at the moment courses become
    // available; subsequent edits are the learner's intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coursesLoaded, courses]);

  const activeTab = openTabs[activeTabIndex];
  // Active-tab lookup goes against `coursesAll` so a tab opened from
  // a deep-link target with `hidden: true` still resolves to a real
  // Course record (otherwise activeCourse drops to null mid-session
  // and the lesson view blanks).
  const activeCourse =
    coursesAll.find((c) => c.id === activeTab?.courseId) ?? null;
  const activeLesson = findLesson(activeCourse, activeTab?.lessonId);

  function selectLesson(courseId: string, lessonId: string) {
    // Cancel any pending auto-advance — if a manual navigation
    // beats the timer to the punch (sidebar click, command palette,
    // Prev/Next button), respect it. When the auto-advance callback
    // itself calls selectLesson, the ref was already nulled inside
    // the timer body so this is a safe no-op for the canonical path.
    clearPendingAutoAdvance();
    // Once the learner has explicitly opened something, the auto-open-
    // first-lesson effect stands down — they're driving.
    didAutoOpen.current = true;
    // Mark this course as "just opened" — the sidebar carousel sorts
    // by these timestamps to keep the most-active course leftmost.
    touchRecentCourse(courseId);
    // Pull in the full course body (starter / solution / tests) if we
    // only have the summary from the initial fast load. No-op if it's
    // already hydrated, so this is safe to fire on every selection.
    // Not awaited — the tab opens immediately and the LessonView
    // re-renders when the full body arrives. This makes "slow click"
    // feel instant while still ensuring the body is available by the
    // time the learner clicks Run.
    void hydrateCourse(courseId);
    // Selecting a lesson always routes back to courses view — otherwise
    // we'd switch the sidebar's active tab silently while the main pane
    // still shows Profile / Sandbox. That's disorienting.
    setView("courses");
    const existing = openTabs.findIndex((t) => t.courseId === courseId);
    if (existing >= 0) {
      const updated = [...openTabs];
      updated[existing] = { courseId, lessonId };
      setOpenTabs(updated);
      setActiveTabIndex(existing);
    } else {
      setOpenTabs([...openTabs, { courseId, lessonId }]);
      setActiveTabIndex(openTabs.length);
    }
  }

  /// Ask for a destination then shell out to the Rust `export_course` command,
  /// which zips the course folder (course.json + any sibling assets) into a
  /// `.academy` archive. We derive a default filename from the course title
  /// so the save sheet starts on a useful name.
  ///
  /// `.academy` is the canonical extension post-rebrand; the picker also
  /// lists `.libre` (the previous name) so a user re-saving over an
  /// older export still sees their existing files.
  async function exportCourse(courseId: string, courseTitle: string) {
    try {
      const defaultName = slugify(courseTitle) + ".academy";
      const destination = await save({
        defaultPath: defaultName,
        filters: [
          { name: "Libre course", extensions: ["academy", "libre", "kata"] },
        ],
        title: `Export "${courseTitle}"`,
      });
      if (!destination) return; // user cancelled
      await invoke("export_course", { courseId, destination });
    } catch (e) {
      // Keep this simple — surface via alert for now. A toast would be nicer
      // but there's no toast system yet; the happy path just succeeds silently.
      const msg = e instanceof Error ? e.message : String(e);
      alert(`Export failed: ${msg}`);
    }
  }

  /// Export every course in the library into a single directory as
  /// `.academy` archives. One prompt, no per-course save sheets.
  /// Failures don't halt the batch — they're collected and surfaced at
  /// the end so a flaky file doesn't strand the rest.
  async function bulkExportLibrary() {
    try {
      if (courses.length === 0) {
        alert("Library is empty — nothing to export.");
        return;
      }
      const destDir = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose destination folder for library export",
      });
      if (typeof destDir !== "string") return;
      const failures: Array<{ title: string; error: string }> = [];
      for (const c of courses) {
        const filename = slugify(c.title) + ".academy";
        const destination = `${destDir}/${filename}`;
        try {
          await invoke("export_course", { courseId: c.id, destination });
        } catch (e) {
          failures.push({
            title: c.title,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      const exported = courses.length - failures.length;
      if (failures.length === 0) {
        alert(`Exported ${exported} course${exported === 1 ? "" : "s"} to ${destDir}`);
      } else {
        const msg = failures.map((f) => `• ${f.title}: ${f.error}`).join("\n");
        alert(
          `Exported ${exported} of ${courses.length}. ${failures.length} failed:\n\n${msg}`,
        );
      }
    } catch (e) {
      alert(
        `Bulk export failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /// Resolve the "resume here" lesson for a course — the first lesson
  /// whose `<courseId>:<lessonId>` key is NOT in `completed`. Walks
  /// chapters + lessons in narrative order so we never jump past an
  /// uncompleted lesson to find a later completed one (the learner
  /// might have marked a downstream lesson done out of order, but
  /// resume should still land them on the earliest gap).
  ///
  /// All complete → falls back to the very last lesson so the
  /// resume CTA still has somewhere to go.
  ///
  /// Returns `undefined` only when the course has no lessons at
  /// all (impossible in practice but defensively typed).
  function findResumeLessonId(course: Course): string | undefined {
    for (const ch of course.chapters) {
      for (const l of ch.lessons) {
        if (!completed.has(`${course.id}:${l.id}`)) return l.id;
      }
    }
    // Every lesson is complete — point at the last lesson so the
    // learner can revisit / re-read rather than ricocheting off
    // an undefined.
    const lastCh = course.chapters[course.chapters.length - 1];
    return lastCh?.lessons[lastCh.lessons.length - 1]?.id;
  }

  /// Resume target for the NavigationRail's play chip + any
  /// "Resume" CTA we ship elsewhere. Picks the course with the
  /// largest `recents` timestamp (i.e. most recently focused) and
  /// pairs it with `findResumeLessonId` so a single click drops
  /// the learner back into where they were.
  ///
  /// Returns `null` when there's no resumable target — fresh
  /// installs (`recents` empty), or every recent course got
  /// uninstalled. Consumers check the null and hide their CTA.
  const resumeTarget = useMemo<
    { course: Course; lessonId: string } | null
  >(() => {
    let bestId: string | null = null;
    let bestTs = -Infinity;
    for (const [id, ts] of Object.entries(recentCourses)) {
      if (ts > bestTs) {
        bestTs = ts;
        bestId = id;
      }
    }
    if (!bestId) return null;
    // `coursesAll` so hidden courses can still resume (the user
    // explicitly opened it — recents wouldn't have the id
    // otherwise). Filtering through the visible `courses` would
    // silently drop a hidden recent and the rail would mysteriously
    // show no Resume chip.
    const course = coursesAll.find((c) => c.id === bestId);
    if (!course) return null;
    const lessonId = findResumeLessonId(course);
    if (!lessonId) return null;
    return { course, lessonId };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentCourses, coursesAll, completed]);

  /// Open a course from the Library view. Reuses the `selectLesson` path
  /// (which upserts an open tab) and targets the user's explicit "where
  /// I left off" if a tab is already open, otherwise the first
  /// uncompleted lesson — the natural resume point. An existing tab
  /// wins because the user EXPLICITLY moved there; we don't want to
  /// silently teleport them back to the frontier if they were
  /// peeking at a later chapter.
  function trackCourseOpen(courseId: string): void {
    // Web-only: which courses get clicked from the library is the
    // top funnel signal for the marketing site. Plausible's
    // dashboard breaks events by props out of the box so
    // `course.open · { courseId: "a-to-ts" }` gives us a per-
    // course click chart with no extra config.
    void import("./lib/analytics").then(({ trackEvent }) => {
      trackEvent("course.open", { courseId });
    });
  }

  function openCourseFromLibrary(courseId: string) {
    trackCourseOpen(courseId);
    // `coursesAll` so deep-link / shared-link entry points can
    // still call this with a hidden course id — Library users
    // never see hidden tiles so they can't reach this code path
    // for one in the first place.
    const c = coursesAll.find((x) => x.id === courseId);
    if (!c) return;
    const existing = openTabs.find((t) => t.courseId === courseId);
    const lessonId = existing?.lessonId ?? findResumeLessonId(c);
    if (!lessonId) return;
    selectLesson(courseId, lessonId);
  }

  /// Queue a delete for confirmation. The actual deletion runs in
  /// `performDelete` once the user clicks Delete in the ConfirmDialog.
  function deleteCourseFromLibrary(courseId: string, courseTitle: string) {
    setPendingDelete({ courseId, courseTitle });
  }

  /// `libre:sandbox-focus` from the AI agent's sandbox tools.
  /// When the agent creates a project / writes a file / applies a
  /// patch, the tool fires this event with the project id + an
  /// optional file path; we switch the main view to the sandbox
  /// so the user sees the work happen in the editor instead of
  /// hunting for it. The SandboxView's own listener takes the
  /// detail and sets activeProjectId / activeFileIdx — see
  /// `useSandboxFocus` in SandboxView.tsx.
  ///
  /// View-switch policy: every non-sandbox view becomes sandbox.
  /// The earlier `view !== "courses"` guard tried to "preserve
  /// the user's lesson context" but had the opposite effect —
  /// `"courses"` is the library shell that hosts BOTH the
  /// library grid AND any open lesson tabs, so the guard
  /// suppressed the switch in the most common case (user on
  /// library, hits Generate, expects to land in the sandbox).
  /// Falling through to a plain switch makes "ask the agent to
  /// build X" feel responsive regardless of where the user was.
  useEffect(() => {
    const onFocus = () => {
      if (view !== "sandbox") setView("sandbox");
    };
    window.addEventListener("libre:sandbox-focus", onFocus);
    return () => window.removeEventListener("libre:sandbox-focus", onFocus);
  }, [view, setView]);

  /// Web-only analytics: fire a pageview + a coarse `view`
  /// custom event whenever the top-level `view` flips between
  /// library / lesson / sandbox / etc. The analytics module
  /// short-circuits to a no-op on the desktop / iOS builds (and
  /// inside popout / tray / dock surfaces) so this useEffect
  /// only does real work on the libre.academy web build. Custom
  /// click events live next to their handlers (`trackEvent` from
  /// `lib/analytics.ts`); the dashboard can also break out
  /// per-view traffic via this coarse one.
  useEffect(() => {
    let cancelled = false;
    void import("./lib/analytics").then(({ trackPageview, trackEvent }) => {
      if (cancelled) return;
      trackPageview();
      trackEvent("view", { view });
    });
    return () => {
      cancelled = true;
    };
  }, [view]);

  /// libre:// link clicks from the AI assistant. The AI's system
  /// prompt includes a catalog of installed courses + lessons with
  /// `libre://course/<id>` / `libre://lesson/<courseId>/<lessonId>`
  /// URLs; the AiChatPanel intercepts clicks on those links and
  /// dispatches `libre:open-course` / `libre:open-lesson`
  /// CustomEvents. Translate those into the existing
  /// `openCourseFromLibrary` / `selectLesson` flows so an AI
  /// recommendation is one click away from opening the actual
  /// lesson.
  useEffect(() => {
    const onCourse = (ev: Event) => {
      const id = (ev as CustomEvent<{ courseId?: string }>).detail
        ?.courseId;
      if (!id) return;
      openCourseFromLibrary(id);
    };
    const onLesson = (ev: Event) => {
      const detail = (
        ev as CustomEvent<{ courseId?: string; lessonId?: string }>
      ).detail;
      if (!detail?.courseId || !detail?.lessonId) return;
      selectLesson(detail.courseId, detail.lessonId);
    };
    window.addEventListener("libre:open-course", onCourse);
    window.addEventListener("libre:open-lesson", onLesson);
    return () => {
      window.removeEventListener("libre:open-course", onCourse);
      window.removeEventListener("libre:open-lesson", onLesson);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coursesAll, openTabs]);

  // (The macOS menu-bar tray bridge that lived here was removed
  // when the tray surface itself was deleted — see the (removed)
  // `mod tray` in src-tauri/src/lib.rs. The in-app floating AI
  // panel + the existing `libre:ask-ai` / `libre:open-course` /
  // `libre:open-lesson` CustomEvent listeners above cover every
  // entry point the tray used to forward into the main window.)

  /// Actually wipe the course: remove the course dir, drop open tabs, clear
  /// the book's ingest cache so a re-import starts fresh. Errors on cache
  /// clear are swallowed because cache may already be gone; the course
  /// delete is the important part.
  async function performDelete(courseId: string) {
    try {
      await invoke("delete_course", { courseId });
      await invoke("cache_clear", { bookId: courseId }).catch((e) => {
        console.warn("[libre] cache_clear after delete failed:", e);
      });
      setOpenTabs((prev) => prev.filter((t) => t.courseId !== courseId));
      await refreshCourses();
    } catch (e) {
      console.error("[libre] delete_course failed:", e);
    } finally {
      setPendingDelete(null);
    }
  }

  /// Import a previously-exported `.libre` (or legacy `.kata`) archive.
  /// Shared importer used by BOTH the file-picker path and the
  /// drag-drop path. Hands `archivePath` (an absolute fs path on
  /// disk) to the Rust `import_course` command which unzips into
  /// the courses dir, then refreshes the sidebar and opens the
  /// first lesson if `andOpen` is true.
  ///
  /// `andOpen` defaults to true. Drag-drop sets it to true only on
  /// the LAST item of a batch — earlier items just import quietly
  /// so the user doesn't see tabs flap open and closed during a
  /// multi-drop.
  async function importArchiveAtPath(
    archivePath: string,
    andOpen: boolean = true,
  ): Promise<string | null> {
    const courseId = await invoke<string>("import_course", { archivePath });
    const fresh = await refreshCourses();
    if (!andOpen) return courseId;
    const imported = fresh.find((c) => c.id === courseId);
    if (!imported || imported.chapters.length === 0) return courseId;
    const firstLessonId = imported.chapters[0].lessons[0]?.id;
    if (!firstLessonId) return courseId;
    setOpenTabs((prev) => {
      const without = prev.filter((t) => t.courseId !== courseId);
      const next = [...without, { courseId, lessonId: firstLessonId }];
      setActiveTabIndex(next.length - 1);
      return next;
    });
    setView("courses");
    return courseId;
  }

  /// Opens the native file picker filtered to all accepted course-
  /// archive extensions (`.academy` + the legacy `.libre` /
  /// `.kata`), then imports the chosen path. Wraps
  /// `importArchiveAtPath` with the picker + error reporting.
  async function importCourseArchive() {
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [
          { name: "Libre course", extensions: ["academy", "libre", "kata"] },
        ],
      });
      if (typeof picked !== "string") return; // user cancelled
      await importArchiveAtPath(picked);
    } catch (e) {
      console.error("[libre] import_course failed:", e);
      alert(
        `Couldn't import course archive: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Track in-flight drag-drop batch so we only "open" the LAST
  // imported course (avoids tab thrash when 5+ files are dropped).
  // Captured by ref because the hook's onImport callback is stable
  // over the component lifetime — we don't want to re-subscribe the
  // Tauri listener every time these change.
  const dropBatchRef = useRef<{ remaining: number }>({ remaining: 0 });
  const archiveDrop = useArchiveDrop({
    onImport: async (archivePath: string) => {
      const remaining = dropBatchRef.current.remaining;
      const isLastInBatch = remaining <= 1;
      try {
        await importArchiveAtPath(archivePath, isLastInBatch);
      } catch (e) {
        console.error("[libre] dropped import failed:", e);
        // Don't alert mid-batch — too noisy if a user dropped 10
        // files and 2 had bad zips. The console error is enough; the
        // overlay already conveys progress.
      } finally {
        dropBatchRef.current.remaining = Math.max(0, remaining - 1);
      }
    },
  });
  // Keep `dropBatchRef.remaining` synced to the progress total. The
  // hook bumps `progress.total` once per batch (single setState at
  // queue start), so this effect runs once per batch + once on
  // teardown — cheap.
  useEffect(() => {
    if (archiveDrop.progress) {
      dropBatchRef.current.remaining =
        archiveDrop.progress.total - archiveDrop.progress.current + 1;
    } else {
      dropBatchRef.current.remaining = 0;
    }
  }, [archiveDrop.progress]);

  function closeTab(index: number) {
    const next = openTabs.filter((_, i) => i !== index);
    setOpenTabs(next);
    if (activeTabIndex >= next.length) {
      setActiveTabIndex(Math.max(0, next.length - 1));
    } else if (activeTabIndex > index) {
      setActiveTabIndex(activeTabIndex - 1);
    }
  }

  /// Drag-reorder one tab from `from` to `to`. The visually-active
  /// tab follows its underlying entry — if you drag the active tab
  /// to a new slot, that slot is now the active index. If you drag
  /// a non-active tab past the active one, activeTabIndex shifts
  /// to track the still-active entry's new position.
  function reorderTab(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return;
    if (from >= openTabs.length || to >= openTabs.length) return;
    setOpenTabs((prev) => {
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setActiveTabIndex((cur) => {
      if (cur === from) return to;
      // Tab moved THROUGH cur — adjust by ±1 to track the same entry.
      if (from < cur && to >= cur) return cur - 1;
      if (from > cur && to <= cur) return cur + 1;
      return cur;
    });
  }

  /// Auto-pick the next colour from the group palette that isn't
  /// already in use. Falls back to "gold" when every palette entry
  /// is taken (rare — would mean 5 active groups). The palette
  /// matches the CSS tokens defined in TopBar.css.
  const TAB_GROUP_PALETTE = ["gold", "coral", "mint", "sky", "lavender"];
  function pickGroupColor(existing: TabGroup[]): string {
    const taken = new Set(existing.map((g) => g.colorToken));
    return TAB_GROUP_PALETTE.find((c) => !taken.has(c)) ?? TAB_GROUP_PALETTE[0];
  }

  /// Set / clear the group on a single tab. Passing `null` for
  /// `groupId` removes the tab from any group it was in. When the
  /// last tab in a group leaves it, the group definition is pruned
  /// (the validator does this on the next render anyway, but doing
  /// it here keeps state minimal between renders).
  function setTabGroup(tabIndex: number, groupId: string | null) {
    if (tabIndex < 0 || tabIndex >= openTabs.length) return;
    setOpenTabs((prev) =>
      prev.map((t, i) =>
        i === tabIndex ? { ...t, groupId: groupId ?? undefined } : t,
      ),
    );
    // Prune any group that now has zero references.
    setTabGroups((prev) => {
      const inUse = new Set<string>();
      openTabs.forEach((t, i) => {
        const effective = i === tabIndex ? groupId ?? undefined : t.groupId;
        if (effective) inUse.add(effective);
      });
      return prev.filter((g) => inUse.has(g.id));
    });
  }

  /// Create a new group containing only the tab at `tabIndex`. The
  /// caller usually follows this with `setTabGroup` on additional
  /// tabs to bring them into the same group, or relies on the
  /// learner adding more via the right-click menu.
  function createGroupForTab(tabIndex: number, name: string) {
    if (tabIndex < 0 || tabIndex >= openTabs.length) return;
    const id = `g_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    const colorToken = pickGroupColor(tabGroups);
    setTabGroups((prev) => [...prev, { id, name, colorToken }]);
    setOpenTabs((prev) =>
      prev.map((t, i) => (i === tabIndex ? { ...t, groupId: id } : t)),
    );
  }

  /// Rename an existing group. No-op when the id is unknown.
  function renameTabGroup(groupId: string, name: string) {
    setTabGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, name } : g)),
    );
  }

  const tabs = openTabs.map((t) => {
    // Tab metadata reads from `coursesAll` so a tab opened on a
    // hidden course (via deep link) still resolves the right
    // title / language / colour for the tab strip — otherwise
    // the chip would render as "Unknown course".
    const c = coursesAll.find((x) => x.id === t.courseId);
    const group = t.groupId
      ? tabGroups.find((g) => g.id === t.groupId)
      : undefined;
    return {
      id: t.courseId,
      label: c?.title ?? t.courseId,
      language: c?.language ?? "javascript",
      groupId: group?.id,
      groupName: group?.name,
      groupColorToken: group?.colorToken,
    };
  });

  return (
    <div
      className={[
        "libre",
        sidebarCollapsed ? "libre--sidebar-collapsed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Fixed top-left sidebar toggle + invisible hover bridge,
          parked to the right of the macOS traffic lights (the
          window is `titleBarStyle: "Overlay"` so we paint into
          the title-bar zone). Click pins / un-pins; hover (when
          pinned-collapsed) reveals the 300px course-tree sidebar
          as a floating overlay above content. The 56px navigation
          rail is NEVER touched by this toggle — it remains
          permanently docked at the left edge. The reveal is
          CSS-driven via `:has()` on `.libre--sidebar-collapsed`
          for reliability over Tauri's drag-region zone. */}
      <SidebarToggle
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
        ariaLabel={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
      />
      {/* Static bootloader — black surface + the spinning ribbon-
          snake + "loading…" label. Pinned over the app while the
          course list is still loading; fades out via the
          `--hidden` modifier once `coursesLoaded` flips true.
          index.html's inline `#preloader` block paints the same
          asset before React mounts, so the handoff between the
          two layers is seamless on cold start. */}
      <div
        className={`libre__bootloader ${
          coursesLoaded ? "libre__bootloader--hidden" : ""
        }`}
        aria-hidden={coursesLoaded}
      >
        <LibreLoader label="loading Libre…" />
      </div>

      {/* Drag-and-drop import overlay. Listens at the app level via
          `useArchiveDrop` so .libre / .kata files can be dropped
          anywhere on the window — the OS-level Tauri webview drop
          handler fires regardless of where in the React tree the
          cursor is. The overlay is purely visual feedback. */}
      <ArchiveDropOverlay
        isDragging={archiveDrop.isDragging}
        isImporting={archiveDrop.isImporting}
        progress={archiveDrop.progress}
      />

      {/* Achievement toast / modal overlay. Receives the queue from
          useAchievements and drains it tier-first — bronze/silver as
          stacked toasts in the top-right column, gold/platinum as
          fullscreen modals. Sits above everything else (z-index 80
          for toasts, 150 for modals). */}
      <AchievementOverlay
        pending={achievements.pendingPresentation}
        onPresented={achievements.markPresented}
      />

      {/* Chapter / book completion summary. Shown once per
          chapter/book the learner just finished; dismissable. The
          chapter version slides up over the lesson view; the book
          version is a fullscreen modal takeover. */}
      {sectionSummary
        ? (() => {
            const course = coursesAll.find(
              (c) => c.id === sectionSummary.courseId,
            );
            if (!course) return null;
            const chapter =
              sectionSummary.kind === "chapter"
                ? course.chapters[sectionSummary.chapterIdx]
                : null;
            const heading =
              sectionSummary.kind === "book"
                ? course.title
                : chapter?.title ??
                  `Chapter ${sectionSummary.chapterIdx + 1}`;
            const subheading =
              sectionSummary.kind === "book"
                ? "Book complete"
                : course.title;
            return (
              <SectionCompleteSummary
                kind={sectionSummary.kind}
                heading={heading}
                subheading={subheading}
                xpEarned={sectionSummary.xpEarned}
                streakDays={stats.streakDays}
                onDismiss={() => setSectionSummary(null)}
              />
            );
          })()
        : null}

      <TopBar
        tabs={tabs}
        groups={tabGroups}
        activeIndex={activeTabIndex}
        onActivate={(i) => {
          // Tabs live in the top bar across every route, so clicking one
          // should always land on the course view — otherwise the learner
          // sees the tab highlight change while still looking at Profile
          // or Sandbox, which feels broken.
          setView("courses");
          setActiveTabIndex(i);
        }}
        onClose={closeTab}
        onReorder={reorderTab}
        onSetTabGroup={setTabGroup}
        onCreateGroup={createGroupForTab}
        onRenameGroup={renameTabGroup}
        stats={stats}
        history={history}
        shields={shields}
        onOpenProfile={() => setView("profile")}
        // The brand wordmark was removed from the top bar (Library
        // already renders it as a hero band, and the rail's Library
        // entry is the canonical "home" affordance). The
        // `onOpenLibrary` prop went with it.
        // Sidebar-collapse toggle moved out of the topbar and into
        // the navigation rail's bottom cluster (NavigationRail.tsx).
        // `sidebarCollapsed` + `onToggleSidebar` no longer flow
        // through TopBar — the rail owns that affordance now.
        // Cloud-sync account row in the stats dropdown. The chip stays
        // hidden while the cloud hook is still booting (`user === null`,
        // briefly during the `me` refetch); once it lands we pass a
        // concrete `signedIn` boolean so the row picks the right shape.
        //
        // Both desktop and web ship the auth chip now. The web variant
        // routes OAuth through a popup window that postMessages the
        // token back via /oauth/done (see SignInDialog `startOAuth`)
        // instead of the desktop's `libre://` deep-link callback.
        // While `cloud.user === null` (booting) we still render
        // `undefined` so the TopBar stays in its skeleton state and
        // doesn't flash a "Sign in" CTA before we know the persisted
        // token's actual status.
        signedIn={cloud.user === null ? undefined : cloud.signedIn}
        userDisplayName={
          cloud.signedIn && typeof cloud.user === "object" && cloud.user
            ? cloud.user.display_name
            : null
        }
        userEmail={
          cloud.signedIn && typeof cloud.user === "object" && cloud.user
            ? cloud.user.email
            : null
        }
        onSignIn={() => setSignInOpen(true)}
        onSignOut={() => {
          void cloud.signOut();
        }}
        // Search trigger sits left of the stats chip; clicking it pops
        // the same CommandPalette that Cmd/Ctrl+K already binds.
        onOpenSearch={() => setPaletteOpen(true)}
        // Feed the inline search input's pool. The TopBarSearch widget
        // filters across all courses + their lessons; clicking a row
        // routes through the same selectLesson path the sidebar uses.
        courses={courses}
        onOpenLesson={selectLesson}
      />

      <div className="libre__body">
        <NavigationRail
          activeView={view}
          onLibrary={() => setView("library")}
          // Resume chip — drops the learner back into their most-
          // recently-focused course at the first uncompleted lesson.
          // Hidden when `resumeTarget` is null (fresh install, or
          // every recent course got uninstalled).
          onResume={
            resumeTarget
              ? () => selectLesson(resumeTarget.course.id, resumeTarget.lessonId)
              : undefined
          }
          resumeLabel={resumeTarget?.course.title}
          onDiscover={() => setView("discover")}
          onChallenges={() => setView("challenges")}
          onPractice={() => setView("practice")}
          onPaths={() => setView("paths")}
          onAchievements={() => setView("achievements")}
          onCertificates={() => setView("certificates")}
          onSandbox={() => setView("sandbox")}
          onSettings={() => setSettingsOpen(true)}
          onStartTour={handleTourStart}
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
          sidebarCollapsed={sidebarCollapsed}
        />
        {/* Sidebar slot. The Sandbox view gets a dedicated project
            switcher + VS Code-style file tree sidebar instead of
            the course/lesson navigator — the sandbox has no
            chapters or lessons, so the regular sidebar's chapter
            tree would render empty there. Every other view keeps
            the production `Sidebar`.

            The sidebar variant choice (Settings → Theme → "Sidebar
            layout") still applies inside the production Sidebar
            for the course view — see `CourseGroup` for the list-
            vs-grid branch on the active course's body. The
            Sandbox sidebar is its own thing entirely; it doesn't
            participate in that variant. */}
        {/* Sidebar wrap. When pinned-open the wrap is
            `display: contents` so the Sidebar inside lays out as
            a normal flex child of `.libre__body`; when pinned-
            collapsed the wrap collapses to zero width and the
            Sidebar inside flips to `position: fixed` so it
            floats as a dropdown overlay (revealed via CSS
            `:has(:hover)` on the toggle + sidebar — see
            App.css). The 56px navigation rail (a sibling of
            this wrap, NOT a descendant) stays untouched. */}
        <div className="libre__sidebar-wrap">
          {view === "sandbox" ? (
            <SandboxSidebar projects={sandboxProjects} />
          ) : (
            <Sidebar
              courses={courses}
              activeCourseId={view === "courses" ? activeCourse?.id : undefined}
              activeLessonId={view === "courses" ? activeLesson?.id : undefined}
              completed={completed}
              recents={recentCourses}
              onSelectLesson={selectLesson}
              onSelectCourse={openCourseFromLibrary}
              onLibrary={() => setView("library")}
              onExportCourse={exportCourse}
              onDeleteCourse={deleteCourseFromLibrary}
              onCourseSettings={(id) => setCourseSettingsId(id)}
              onResetLesson={clearLessonCompletion}
              onResetChapter={clearChapterCompletions}
              onResetCourse={clearCourseCompletions}
              onCertificates={() => setView("certificates")}
            />
          )}
        </div>

        <main className="libre__main">
          {view === "profile" ? (
            <ProfileView
              courses={courses}
              completed={completed}
              history={history}
              stats={stats}
              onOpenLesson={selectLesson}
            />
          ) : view === "sandbox" ? (
            <SandboxView projects={sandboxProjects} />
          ) : view === "challenges" ? (
            <ChallengesView
              courses={courses}
              completed={completed}
              onOpenLesson={(courseId, lessonId) => {
                selectLesson(courseId, lessonId);
                setView("courses");
              }}
            />
          ) : view === "practice" ? (
            <PracticeView
              courses={courses}
              completed={completed}
              history={history}
              onOpenLesson={(courseId, lessonId) => {
                selectLesson(courseId, lessonId);
                setView("courses");
              }}
            />
          ) : view === "paths" ? (
            <PathsPage
              courses={courses}
              completed={completed}
              onOpenCourse={openCourseFromLibrary}
              onBrowseCatalog={() => setView("discover")}
            />
          ) : view === "achievements" ? (
            <AchievementsPage
              unlocked={achievements.unlocked}
              unlockedRecords={achievements.unlockedRecords}
            />
          ) : view === "certificates" ? (
            <CertificatesPage
              courses={courses}
              completed={completed}
              onResume={openCourseFromLibrary}
            />
          ) : view === "library" || view === "discover" ? (
            // Library + Discover both render through CourseLibrary —
            // same chrome (filters / search / view-mode), different
            // dataset slice. The `scope` prop drives the filter:
            // "library" shows installed courses only; "discover"
            // shows catalog placeholders only with install buttons
            // on each card. Sidebar nav controls which one's active.
            //
            // The `key={view}` is load-bearing: without it React
            // reuses the SAME CourseLibrary instance across a
            // library ↔ discover switch, which historically meant
            // useState/useMemo state from one scope could survive
            // into the other. Keying on `view` forces a fresh
            // component instance with its own filter state.
            //
            // We used to wrap this in `<DeferredMount>` to flash a
            // "Loading…" pane during the swap, but combined with
            // `useTransition` (which keeps the previous view
            // painted while React prepares the new one in the
            // background) the loader is just visible noise — it
            // would blank the screen for a frame and THEN show
            // CourseLibrary. The transition delivers the same
            // "register the click instantly" feeling without
            // throwing the previous content away first. The
            // `is-view-pending` class on the wrapper dims the
            // outgoing view by ~30% so the user sees something
            // happen the instant they click, even if the new
            // render takes a beat.
            <div
              className={
                "libre-view-pane" +
                (isViewPending ? " is-view-pending" : "")
              }
            >
              <CourseLibrary
                // Intentionally NO `key={view}` — see CourseLibrary's
                // `useDeferredValue(scope)` for how it handles the
                // library↔discover swap incrementally without
                // unmount/remount. Forcing a fresh instance on every
                // nav freezes the main thread while React mounts a
                // new component, refires every useEffect (cover
                // prefetch, update-check, catalog fetch), and
                // re-renders 30+ cards from scratch. Holding the
                // instance and letting it re-derive its data is
                // dramatically faster, and the deferred memos keep
                // the new card list off the critical path so the
                // chrome paints immediately when the user clicks.
                mode="inline"
                scope={view === "discover" ? "discover" : "library"}
                courses={courses}
                completed={completed}
                hydrating={hydrating}
                onDismiss={() => setView("courses")}
                onOpen={(id) => openCourseFromLibrary(id)}
                // Import / bulk-import / docs-crawl / archive-import
                // all live behind Tauri commands (PDF parsing, file
                // dialog, crawler, etc.). On the web build we pass
                // `undefined` so CourseLibrary's optional-prop checks
                // hide the corresponding buttons rather than calling
                // an Anthropic-backed pipeline that can't run here.
                onImport={isWeb ? undefined : () => setImportOpen(true)}
                onBulkImport={isWeb ? undefined : () => setBulkImportOpen(true)}
                onDocsImport={isWeb ? undefined : () => setDocsImportOpen(true)}
                onImportArchive={isWeb ? undefined : importCourseArchive}
                onExport={isWeb ? undefined : exportCourse}
                onDelete={deleteCourseFromLibrary}
                onSettings={(id) => setCourseSettingsId(id)}
                onBulkExport={isWeb ? undefined : bulkExportLibrary}
                onUpdateCourse={handleReapplyBundledStarter}
                onAddCourse={isWeb ? undefined : handleAddCourse}
                onBrowseCatalog={() => setView("discover")}
                onInstallCatalogEntry={handleInstallCatalogEntry}
              />
            </div>
          ) : courses.length === 0 && coursesLoaded ? (
            // First-launch / empty-library welcome card. Single hero
            // tile with intent copy + the right CTA per build target
            // (web → desktop-app download split-button; desktop →
            // import-a-PDF + open-settings).
            <div className="libre__welcome">
              <div className="libre__welcome-inner">
                <div className="libre__welcome-glyph" aria-hidden>
                  <Icon icon={libraryBig} size="2xl" color="currentColor" weight="light" />
                </div>
                <h1 className="libre__welcome-title">Welcome to Libre</h1>
                <p className="libre__welcome-blurb">
                  {isWeb
                    ? "A browser-native preview. Try the bundled lessons in JavaScript, Python, or Svelte — your progress saves locally and syncs to the cloud once you sign in."
                    : "Turn any technical book into an interactive course. Pick a PDF to import, and Libre will split it into lessons, generate exercises, and let you code along chapter by chapter."}
                </p>
                <div className="libre__welcome-actions">
                  {isWeb ? (
                    <DownloadButton className="libre-download--hero" />
                  ) : (
                    <>
                      <button
                        type="button"
                        className="libre__welcome-primary"
                        onClick={() => setImportOpen(true)}
                      >
                        Import a PDF
                      </button>
                      <button
                        type="button"
                        className="libre__welcome-secondary"
                        onClick={() => setSettingsOpen(true)}
                      >
                        Open Settings
                      </button>
                    </>
                  )}
                </div>
                <p className="libre__welcome-hint">
                  {isWeb
                    ? "Want to import your own PDFs, run C / C++ / Java / Swift, or use the offline AI? Grab the desktop app — it ships every runtime."
                    : "You'll need an Anthropic API key in Settings for the AI-assisted structuring pipeline. Without one, imports fall back to simple section splits."}
                </p>
              </div>
            </div>
          ) : openTabs.length === 0 ? (
            // No tabs open (all closed, or freshly launched before first
            // tab was created) — render the library inline so the learner
            // has a launching pad instead of a blank pane.
            <DeferredMount
              phase="library-empty"
              fallback={<LoadingPane label="Loading library…" />}
            >
              <CourseLibrary
                mode="inline"
                courses={courses}
                completed={completed}
                hydrating={hydrating}
                onDismiss={() => { /* inline mode has no dismiss affordance */ }}
                onOpen={(id) => openCourseFromLibrary(id)}
                onImport={isWeb ? undefined : () => setImportOpen(true)}
                onBulkImport={isWeb ? undefined : () => setBulkImportOpen(true)}
                onDocsImport={isWeb ? undefined : () => setDocsImportOpen(true)}
                onImportArchive={isWeb ? undefined : importCourseArchive}
                onExport={isWeb ? undefined : exportCourse}
                onDelete={deleteCourseFromLibrary}
                onSettings={(id) => setCourseSettingsId(id)}
                onBulkExport={isWeb ? undefined : bulkExportLibrary}
                onUpdateCourse={handleReapplyBundledStarter}
                onAddCourse={isWeb ? undefined : handleAddCourse}
                onBrowseCatalog={() => setView("discover")}
                onInstallCatalogEntry={handleInstallCatalogEntry}
              />
            </DeferredMount>
          ) : activeLesson && activeCourse ? (
            <>
              {/* local-chain dock — appears above any
                  smart-contract lesson so the learner can watch
                  account balances, recent deploys, and tx flow as
                  their tests run. Hides automatically when the
                  active lesson is non-EVM. */}
              {shouldShowEvmDock(activeLesson, activeCourse, {
                hasActivity: chainActivity.evm,
              }) && <EvmDockBanner />}
              {/* Bitcoin equivalent — UTXO/mempool/blocks/recent
                  tx panels above any lesson with `harness: "bitcoin"`,
                  any lesson in a Bitcoin-flavored course, or any
                  view at all once the chain has live state. */}
              {shouldShowBitcoinDock(activeLesson, activeCourse, {
                hasActivity: chainActivity.bitcoin,
              }) && <BitcoinDockBanner />}
              {/* Solana equivalent — slot/SOL/programs/recent tx
                  panels above any lesson with `harness: "solana"`,
                  or any coding lesson inside a Solana challenge
                  pack. Desktop-only (LiteSVM is a Rust napi addon)
                  but the gating helper doesn't enforce that — the
                  web build's "this lesson needs the desktop app"
                  path catches Solana lessons before this mounts. */}
              {shouldShowSvmDock(activeLesson, activeCourse) && (
                <SvmDockBanner />
              )}
              {/* HelloTrade-style API tester. Mounts above any
                  coding lesson with `harness: "trade"` (or in the
                  HelloTrade course by default). Pure HTTP + WS
                  client — runs in mock mode against canned data
                  out of the box and toggles to live mode for the
                  actual staging API. No chain runtime + no
                  backend needed, so it works on web AND
                  desktop. */}
              {shouldShowTradeDock(activeLesson, activeCourse) && (
                <TradeDockBanner />
              )}
              {/* Challenge-pack frame — quiet 1-row strip showing
                  the pack name, difficulty tier, topic chip and
                  position-in-tier when the active lesson belongs
                  to a challenges course. Renders null otherwise so
                  it's safe to mount unconditionally. */}
              <ChallengeFrame course={activeCourse} lesson={activeLesson} />
              <LessonView
              // Key on course+lesson so the editor/code state and quiz answers
              // fully reset when navigating via Prev/Next — otherwise React
              // would reuse stale component state across lessons.
              key={`${activeCourse.id}:${activeLesson.id}`}
              courseId={activeCourse.id}
              courseLanguage={activeCourse.language}
              courseRequiresDevice={activeCourse.requiresDevice}
              isChallenge={activeCourse.packType === "challenges"}
              lesson={activeLesson}
              neighbors={findNeighbors(activeCourse, activeLesson.id)}
              isCompleted={completed.has(`${activeCourse.id}:${activeLesson.id}`)}
              autoAdvanceFireAt={autoAdvanceFireAt}
              onComplete={() => markCompletedAndCelebrate(activeCourse.id, activeLesson.id)}
              onNavigate={(lessonId) => selectLesson(activeCourse.id, lessonId)}
              onRetryLesson={(lessonId) =>
                startRetryLesson(
                  activeCourse.id,
                  lessonId,
                  activeLesson.title.replace(/\s*\(demoted\)\s*$/i, "").trim(),
                )
              }
            />
            </>
          ) : (
            <div className="libre__empty">
              <p>Pick a lesson from the sidebar to get started.</p>
            </div>
          )}
        </main>
      </div>

      {settingsOpen && (
        <SettingsDialog
          cloud={cloud}
          realtime={realtime}
          history={history}
          courses={courses}
          onDismiss={closeSettings}
          onRequestSignIn={() => setSignInOpen(true)}
          autoCheckUpdates={settingsAutoCheckUpdates}
        />
      )}

      {/* First-run guided tour. Mounts unconditionally so the
          `active` prop fully owns visibility — keeps the entrance
          animation in sync with the activation rather than the
          mount lifecycle, and lets the tour spotlight measure
          targets that live on different views without unmount /
          remount each step. */}
      <Tour
        steps={TOUR_STEPS}
        active={tourActive}
        onNavigate={handleTourNavigate}
        onComplete={handleTourComplete}
      />

      {/* First-launch tour invite. Renders ONCE per device on the
          very first session (gated by the `tour-prompted` flag) and
          asks the learner whether they want a quick walkthrough.
          Either button records the prompt-shown decision so this
          dialog never reappears; "Take tour" additionally activates
          the Tour component above. The Help icon on the navigation
          rail can re-trigger the tour any time after that. */}
      {tourPromptOpen && (
        <ConfirmDialog
          title="Take a quick tour?"
          message="A short narrated walkthrough of the main features — about a minute. You can replay it anytime from the Help icon on the left rail."
          confirmLabel="Take tour"
          cancelLabel="Skip"
          onConfirm={handleTourPromptAccept}
          onCancel={handleTourPromptSkip}
        />
      )}

      {genPackOpen && (
        <GeneratePackDialog
          onDismiss={() => setGenPackOpen(false)}
          onStart={(opts) => {
            startGenerateChallengePack(opts);
            setGenPackOpen(false);
          }}
        />
      )}

      {docsImportOpen && (
        <DocsImportDialog
          onDismiss={() => setDocsImportOpen(false)}
          onStart={(opts) => {
            startDocsIngest(opts);
            setDocsImportOpen(false);
          }}
        />
      )}

      {courseSettingsId && (() => {
        const course = courses.find((c) => c.id === courseSettingsId);
        if (!course) return null;
        return (
          <CourseSettingsModal
            course={course}
            onDismiss={() => setCourseSettingsId(null)}
            onExport={() => exportCourse(course.id, course.title)}
            onDelete={() => deleteCourseFromLibrary(course.id, course.title)}
            onRegenerateExercises={() => startRegenExercises(course.id, course.title)}
            onEnrichLessons={() => startEnrichCourse(course.id, course.title)}
            onCoverRefreshed={async (fetchedAt) => {
              // Load the course JSON, bump coverFetchedAt, save it back.
              // Avoids the "stale blob URL" problem the first time a
              // cover is fetched for an existing course — useCourseCover
              // reruns whenever this value changes.
              try {
                const current = await invoke<Course>("load_course", {
                  courseId: course.id,
                });
                current.coverFetchedAt = fetchedAt;
                await invoke("save_course", {
                  courseId: course.id,
                  body: current,
                });
                await refreshCourses();
              } catch (e) {
                console.error("[libre] cover save failed:", e);
              }
            }}
            onChangeLanguage={async (language) => {
              // Load → mutate → save → refresh. Same pattern as the
              // cover-refresh handler above. Only the top-level
              // `language` changes; lesson-level `language` fields are
              // left alone because they're valid in their own right
              // (e.g. a Python course with a quiz lesson whose language
              // is "plaintext" is fine — the quiz doesn't run code).
              const current = await invoke<Course>("load_course", {
                courseId: course.id,
              });
              current.language = language;
              await invoke("save_course", {
                courseId: course.id,
                body: current,
              });
              await refreshCourses();
            }}
            onChangeMetadata={async (patch) => {
              // Title / author / release-status edit. Same load →
              // mutate → save → refresh as the language handler. The
              // patch carries only the keys the user actually changed
              // (modal computes the diff before calling). null on
              // author or releaseStatus clears the field, so the
              // course can fall back to "no byline" / "Unreviewed".
              const current = await invoke<Course>("load_course", {
                courseId: course.id,
              });
              if (typeof patch.title === "string") {
                current.title = patch.title;
              }
              if (patch.author === null) {
                delete (current as { author?: string }).author;
              } else if (typeof patch.author === "string") {
                current.author = patch.author;
              }
              if (patch.releaseStatus === null) {
                delete (current as { releaseStatus?: string }).releaseStatus;
              } else if (patch.releaseStatus !== undefined) {
                current.releaseStatus = patch.releaseStatus;
              }
              await invoke("save_course", {
                courseId: course.id,
                body: current,
              });
              await refreshCourses();
            }}
          />
        );
      })()}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete "${pendingDelete.courseTitle}"?`}
          message={
            `This removes the course, all lesson progress, and the ingest cache from disk. ` +
            `Re-importing the same PDF later will run the full AI pipeline from scratch.\n\n` +
            `This can't be undone.`
          }
          confirmLabel="Delete course"
          cancelLabel="Keep"
          danger
          onConfirm={() => performDelete(pendingDelete.courseId)}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {bulkImportOpen && (
        <BulkImportDialog
          onDismiss={() => setBulkImportOpen(false)}
          onStartQueue={(items) => {
            // Hands off to the queue runner. FloatingIngestPanel shows
            // progress across the batch. Dialog dismisses itself.
            startBulkIngest(items);
          }}
        />
      )}

      {importOpen && (
        <ImportDialog
          onDismiss={() => {
            setImportOpen(false);
            setPreselectedImportPath(null);
          }}
          preselectedPath={preselectedImportPath ?? undefined}
          onStartAiIngest={(opts) => {
            // Fire-and-forget — the pipeline runs detached and the floating
            // panel (below) shows progress. Dialog already closes itself.
            startIngest(opts);
          }}
          onSavedCourse={async (courseId) => {
            // Non-AI path: the deterministic splitter already saved the
            // course. Refresh the sidebar + jump to the first lesson.
            const fresh = await refreshCourses();
            const imported = fresh.find((c) => c.id === courseId);
            if (!imported || imported.chapters.length === 0) return;
            const firstLessonId = imported.chapters[0].lessons[0]?.id;
            if (!firstLessonId) return;
            setOpenTabs((prev) => {
              const without = prev.filter((t) => t.courseId !== courseId);
              const next = [...without, { courseId, lessonId: firstLessonId }];
              setActiveTabIndex(next.length - 1);
              return next;
            });
          }}
        />
      )}

      {ingest.status !== "idle" && (
        <FloatingIngestPanel
          run={ingest}
          onCancel={cancelIngest}
          onDismiss={dismissIngest}
          onOpen={(bookId) => {
            const c = courses.find((x) => x.id === bookId);
            if (!c || c.chapters.length === 0) return;
            const firstLessonId = c.chapters[0].lessons[0]?.id;
            if (!firstLessonId) return;
            setOpenTabs((prev) => {
              const without = prev.filter((t) => t.courseId !== bookId);
              const next = [...without, { courseId: bookId, lessonId: firstLessonId }];
              setActiveTabIndex(next.length - 1);
              return next;
            });
            dismissIngest();
          }}
        />
      )}

      {/* Floating local-LLM tutor. Lives at the root so it persists
          across library / lesson / sandbox / profile routes —
          same character, same conversation state. System prompt is
          rebuilt from the active lesson on each send(). */}
      {/* AI assistant is desktop-only for now — the streaming runs
          via Tauri events from a local Ollama / Anthropic-via-Rust
          path that doesn't have a web equivalent yet. Phase 4 will
          re-enable this on web by streaming directly from
          api.libre.academy once the relay endpoints land. */}
      {!isWeb && (
        <AiAssistant
          lesson={activeLesson}
          course={activeCourse}
          courses={courses}
          completed={completed}
          history={history}
          celebrateAt={celebrateAt}
        />
      )}

      {/* Floating "get the desktop app" upsell — web-only. The
          component self-gates on `isWeb` and a 30-day localStorage
          dismissal, so on desktop this is a no-op render. */}
      <InstallBanner />

      {/* OTA update toast — desktop-only. Self-gates on `isDesktop`
          + the result of a Tauri-updater check. Idle state renders
          null so this is invisible when there's nothing to install.
          `onOpenSettings` lets the post-install "Restart" affordance
          redirect into Settings instead of relaunching directly —
          per Notion issue #a41bc772db92641f, the in-Settings
          restart button is the canonical surface and the banner
          should hand off there. */}
      <UpdateBanner onOpenSettings={openSettings} />

      {/* First-launch sign-in nudge. Self-gates on
          `cloud.user === false` (= no token, not signed in) and on
          a localStorage "permanent dismiss" flag, so this stays
          quiet on every subsequent launch unless the user clicks
          "Skip" without ticking the checkbox.

          Web build: enabled. SignInDialog branches on `isWeb` to
          route OAuth through a popup window that postMessages the
          minted token back to the parent (instead of the desktop's
          `libre://` deep-link callback). Email + password worked
          unchanged on web all along — the dialog just wasn't being
          rendered. */}
      <FirstLaunchPrompt cloud={cloud} />

      {/* Local-AI dependency wizard. Probes for Homebrew + Ollama on
          first launch and walks the user through installing whichever
          is missing. Self-gates on `cloud.user` so it opens AFTER the
          FirstLaunchPrompt above has resolved (signed-in or dismissed)
          rather than stacking on top of it. Web build is a no-op (no
          Tauri commands available). */}
      <SetupWizard cloud={cloud} />

      {/* Re-openable sign-in modal. Driven by the "Sign in" button in
          the TopBar stats dropdown — separate from the first-launch
          prompt above (which has a one-time-show gate of its own).
          The dialog auto-closes on a successful OAuth round-trip
          (deep-link on desktop, postMessage on web) via its internal
          `awaitingOAuth` watcher. */}
      {signInOpen && (
        <SignInDialog
          cloud={cloud}
          onClose={() => setSignInOpen(false)}
        />
      )}

      {/* Cmd+K command palette. Searches across actions + every
          loaded course / lesson. Opening a lesson reuses the same
          selectLesson path the sidebar uses, so tab + recents
          state stay coherent. */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        courses={courses}
        actions={{
          openLibrary: () => setView("library"),
          openSandbox: () => setView("sandbox"),
          openProfile: () => setView("profile"),
          openSettings: () => setSettingsOpen(true),
          importBook: () => setImportOpen(true),
          // Triggering "ask AI" from the palette dispatches the same
          // event the lesson reader's `?` badges fire. Empty detail
          // leaves the panel open without a pre-canned prompt so the
          // learner can type their own question.
          askAi: () => {
            window.dispatchEvent(
              new CustomEvent("libre:ask-ai", {
                detail: { kind: "open" },
              }),
            );
          },
          // "Verify" actions only surface when there's something to
          // verify — an active course (single mode) or any loaded
          // courses at all (multi mode). The palette itself is
          // unaware of these conditions; we just gate the action by
          // making it undefined when not applicable.
          verifyCourse: activeCourse
            ? () => startVerifySingleCourse(activeCourse)
            : undefined,
          verifyAllCourses:
            courses.length > 0
              ? () => startVerifyAllCourses(courses)
              : undefined,
          // Course-mutation actions: only surface when an active
          // course is open so they have a clear target.
          reapplyBundledStarter: activeCourse
            ? () => void handleReapplyBundledStarter(activeCourse.id)
            : undefined,
          applyFixesFromPrompt: activeCourse
            ? () => setFixApplierForCourseId(activeCourse.id)
            : courses.length > 0
              ? () => setFixApplierForCourseId(courses[0].id)
              : undefined,
        }}
        onOpenLesson={(courseId, lessonId) => selectLesson(courseId, lessonId)}
      />

      <VerifyCourseOverlay
        session={verifySession}
        onCancel={cancelVerification}
        onClose={() => {
          // If a run is still in flight when the user clicks ✕, treat
          // it as cancel-and-close so we don't keep producing results
          // into a stale, unrendered session object.
          if (verifyControllerRef.current) cancelVerification();
          setVerifySession(null);
        }}
      />

      {fixApplierForCourseId && (
        <FixApplierDialog
          courses={courses}
          initialCourseId={fixApplierForCourseId}
          onClose={() => setFixApplierForCourseId(null)}
          onApplied={async () => {
            // Re-hydrate so the workbench picks up the patched
            // solution / tests on next Run. We don't auto-close —
            // the user might want to download the updated JSON to
            // promote into the bundled starter.
            if (fixApplierForCourseId) {
              await hydrateCourse(fixApplierForCourseId);
            }
          }}
        />
      )}

    </div>
  );

  /// Kick off `verifyCourse` for one course in WATCH mode — the
  /// editor visibly flips to solution code, the run button visibly
  /// fires, the next button visibly advances, quizzes auto-answer
  /// with green-chip animation. By the end the course shows 100%
  /// completion.
  async function startVerifySingleCourse(course: Course) {
    if (verifyControllerRef.current) return; // ignore re-entry
    const controller = new AbortController();
    verifyControllerRef.current = controller;
    const total = collectVerifyTargets(course).length;
    setVerifySession({
      label: course.title,
      index: 0,
      total,
      current: null,
      results: [],
      done: total === 0,
    });
    // Move to the first lesson immediately so the user sees the
    // course open even before the loop's first iteration kicks in
    // (the loop's own `selectLesson` is idempotent).
    const first = course.chapters[0]?.lessons[0];
    if (first) selectLesson(course.id, first.id);
    try {
      await verifyCourse(course, {
        signal: controller.signal,
        selectLesson,
        markComplete: markCompletedAndCelebrate,
        onProgress: (p) =>
          setVerifySession((s) =>
            s ? { ...s, index: p.index, total: p.total, current: p.current } : null,
          ),
        onResult: (r) =>
          setVerifySession((s) =>
            s ? { ...s, results: [...s.results, r] } : null,
          ),
      });
    } finally {
      verifyControllerRef.current = null;
      setVerifySession((s) => (s ? { ...s, done: true, current: null } : null));
    }
  }

  /// Same shape as the single-course path but loops every loaded
  /// course. The label updates per course so the overlay header
  /// reads "Mastering Ethereum (3 / 8)" while running.
  async function startVerifyAllCourses(allCourses: Course[]) {
    if (verifyControllerRef.current) return;
    const controller = new AbortController();
    verifyControllerRef.current = controller;
    const grandTotal = allCourses.reduce(
      (n, c) => n + collectVerifyTargets(c).length,
      0,
    );
    let runningCount = 0;
    setVerifySession({
      label: `All courses (${allCourses.length})`,
      index: 0,
      total: grandTotal,
      current: null,
      results: [],
      done: grandTotal === 0,
    });
    try {
      await verifyAllCourses(allCourses, {
        signal: controller.signal,
        selectLesson,
        markComplete: markCompletedAndCelebrate,
        onProgress: (mp) => {
          setVerifySession((s) =>
            s
              ? {
                  ...s,
                  label: mp.currentCourse
                    ? `${mp.currentCourse.title} (${mp.courseIndex + 1} / ${mp.totalCourses})`
                    : `All courses (${mp.totalCourses})`,
                  index: runningCount + mp.perCourse.index,
                  current: mp.perCourse.current,
                }
              : null,
          );
        },
        onResult: (r) =>
          setVerifySession((s) =>
            s ? { ...s, results: [...s.results, r] } : null,
          ),
        onCourseComplete: (_course, results) => {
          runningCount += results.length;
        },
      });
    } finally {
      verifyControllerRef.current = null;
      setVerifySession((s) =>
        s ? { ...s, done: true, current: null, index: s.total } : null,
      );
    }
  }

  function cancelVerification() {
    verifyControllerRef.current?.abort();
    verifyControllerRef.current = null;
    setVerifySession((s) => (s ? { ...s, done: true, current: null } : null));
  }

  /// Install a course from the catalog by fetching its JSON from the
  /// libre.academy CDN and persisting it via the storage abstraction.
  /// Same code path on desktop and web — `storage.saveCourse` picks
  /// the platform-appropriate persistence (Tauri IPC writes the JSON
  /// to the user's courses dir; web writes to IndexedDB) under the
  /// hood. After the write lands, refresh the in-memory course list +
  /// hydrate the new course so the placeholder tile in the Library
  /// flips to a real installed cover and the user can click into it
  /// immediately.
  async function handleInstallCatalogEntry(entry: {
    id: string;
    file: string;
    title: string;
  }) {
    try {
      const { jsonHref } = await import("./lib/catalog");
      const url = jsonHref({ file: entry.file } as Parameters<typeof jsonHref>[0]);
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const course = await res.json();
      const { storage } = await import("./lib/storage");
      await storage.saveCourse(entry.id, course);
      await refreshCourses();
      await hydrateCourse(entry.id);
    } catch (e) {
      console.error("[libre] install catalog entry failed:", e);
      alert(
        `Couldn't install ${entry.title}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /// Unified "Add course" handler — replaces the four separate
  /// import buttons (Book / Bulk books / Docs site / Archive) with
  /// a single OS file picker that sniffs each chosen file and
  /// dispatches to the right pipeline:
  ///   * `.academy` / `.libre` / `.kata` / `.zip` →
  ///                                       `importArchiveAtPath`
  ///   * `.pdf` / `.epub` (single)       → ImportDialog with
  ///                                       `preselectedPath`
  ///   * `.pdf` / `.epub` (multi)        → BulkImportDialog (no
  ///                                       pre-fill in v1; user
  ///                                       re-picks inside)
  /// Docs URLs are URL-only so they stay as a separate dropdown
  /// item on AddCourseButton.
  async function handleAddCourse() {
    try {
      const picked = await openDialog({
        multiple: true,
        filters: [
          {
            name: "Course files",
            extensions: ["pdf", "epub", "academy", "libre", "kata", "zip"],
          },
        ],
      });
      if (!picked) return;
      const paths: string[] = Array.isArray(picked) ? picked : [picked];
      const pdfs: string[] = [];
      const archives: string[] = [];
      for (const p of paths) {
        const ext = p.toLowerCase().split(".").pop() ?? "";
        if (ext === "pdf" || ext === "epub") pdfs.push(p);
        else if (
          ext === "academy" ||
          ext === "libre" ||
          ext === "kata" ||
          ext === "zip"
        )
          archives.push(p);
      }

      // Archives import directly via the existing Tauri command —
      // no dialog hop needed. Fire each in sequence; alert ONLY at
      // the end so a user dropping 5 archives doesn't get 5 popups
      // mid-batch.
      const archiveErrors: string[] = [];
      for (const archive of archives) {
        try {
          await importArchiveAtPath(archive);
        } catch (e) {
          archiveErrors.push(
            `${archive}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      if (archiveErrors.length > 0) {
        alert(
          `Some archives failed to import:\n\n${archiveErrors.join("\n")}`,
        );
      }

      if (pdfs.length === 1) {
        // Single PDF/EPUB → open the existing import wizard with
        // the path pre-filled so the user lands on the metadata
        // step immediately instead of re-picking.
        setPreselectedImportPath(pdfs[0]);
        setImportOpen(true);
      } else if (pdfs.length > 1) {
        // Multi PDF/EPUB → bulk import wizard. v1 doesn't pre-fill
        // the queue; user re-selects inside. Acceptable trade-off
        // because bulk runs are rarer than single imports.
        setBulkImportOpen(true);
      }
    } catch (e) {
      console.error("[libre] add course failed:", e);
      alert(
        `Couldn't open the file picker: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /// "Reapply bundled starter" — overwrite the installed copy of a
  /// course with the bundled `public/starter-courses/<id>.json`,
  /// then refresh the in-memory course list so the active tab
  /// picks up the new content. Used from cmd+K AND from the
  /// Library cover badge.
  async function handleReapplyBundledStarter(courseId: string) {
    try {
      await syncBundledToInstalled(courseId);
      // Re-pull the summary list + re-hydrate this course's body
      // so the running app reflects the new content without a
      // page reload.
      await refreshCourses();
      await hydrateCourse(courseId);
    } catch (e) {
      console.error("[libre] reapply bundled starter failed:", e);
    }
  }
}
