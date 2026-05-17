import { useEffect, useMemo, useRef, useState } from "react";
import {
  Course,
  ExerciseLesson,
  Lesson,
  MixedLesson,
  isExerciseKind,
  isQuiz,
} from "../../data/types";
import { localizedLesson } from "../../data/localize";
import { openExternal } from "../../lib/openExternal";
import { useLocale } from "../../hooks/useLocale";
import { useKeybinding } from "../../hooks/useKeybinding";
import { setRunStatus } from "../../hooks/useRunStatus";
import { fireHaptic } from "../../lib/haptics";
import { track } from "../../lib/track";
import { Icon } from "@base/primitives/icon";
import { panelLeftOpen } from "@base/primitives/icon/icons/panel-left-open";
import "@base/primitives/icon/icon.css";
import LessonReader from "./LessonReader";
import LessonNav from "./LessonNav";
import EditorPane from "../Editor/EditorPane";
import OutputPane from "../Output/OutputPane";
import PhoneToggleButton from "../FloatingPhone/PhoneToggleButton";
import {
  openPhonePopout,
  closePhonePopout,
  makePhonePreviewBus,
  type PhonePreviewMsg,
} from "../../lib/phonePopout";
import Workbench from "../Workbench/Workbench";
import MissingToolchainBanner from "../banners/MissingToolchain/MissingToolchainBanner";
import RustLocalPrompt from "../dialogs/RustLocalPrompt/RustLocalPrompt";
import { useToolchainStatus } from "../../hooks/useToolchainStatus";
import { useLocalStorageState } from "../../hooks/useLocalStorageState";
import QuizView from "../Quiz/QuizView";
import BlocksView from "../Blocks/BlocksView";
import { makeBus, openPoppedWorkbench, closePoppedWorkbench } from "../../lib/workbenchSync";
import { deriveSolutionFiles } from "../../lib/workbenchFiles";
import {
  emitEvent as emitVerifierEvent,
  onCommand as onVerifierCommand,
} from "../../lib/verify/bus";
import { runFiles, isPassing, type RunResult } from "../../runtimes";
import { useWorkbenchFiles } from "../../hooks/useWorkbenchFiles";
import type { Neighbors } from "../../lessonHelpers";
import { useT } from "../../i18n/i18n";

/// Languages that need a local compiler / VM / assembler installed on
/// the host before lessons in them can run. Used by LessonView to
/// decide whether to proactively probe the toolchain + show an install
/// banner. Everything else (JavaScript / TypeScript / Python / Web /
/// Three.js / React Native) runs fully in-browser OR hits an online
/// sandbox (Rust / Go / Swift) so the local machine doesn't need a
/// toolchain. Matches the set of languages `nativeRunners.ts` routes
/// to Tauri `run_*` commands.
const NATIVE_TOOLCHAIN_LANGUAGES = new Set<string>([
  "c",
  "cpp",
  "java",
  "kotlin",
  "csharp",
  "assembly",
]);

export default function LessonView({
  courseId,
  courseLanguage,
  courseRequiresDevice,
  isChallenge = false,
  lesson: rawLesson,
  neighbors,
  isCompleted,
  autoAdvanceFireAt,
  onComplete,
  onNavigate,
  onRetryLesson,
}: {
  courseId: string;
  /// Primary language of the PARENT course. Used as an override signal
  /// for `runFiles` — when the course is "reactnative", lessons always
  /// run through the RN runtime regardless of how the individual
  /// lesson's `language` field ended up tagged. LLM-generated lessons
  /// sometimes default to "javascript" for JSX code, which otherwise
  /// sends RN source to the JavaScript worker and fails with an
  /// opaque `AsyncFunction@[native code]` blob-URL error.
  courseLanguage: Course["language"];
  /// Pulled off the parent course's `requiresDevice` field. Threaded
  /// through to LessonReader so it can mount the Ledger status pill
  /// next to the time-to-read chip on hardware-wallet courses.
  courseRequiresDevice?: Course["requiresDevice"];
  /// True when the parent course's `packType === "challenges"`.
  /// Drives a `--challenge` modifier class on the lesson layout —
  /// challenge prose is a one-paragraph problem statement, so the
  /// reader pane shrinks to ~30% and the workbench claims the rest.
  /// Defaults to false for compatibility with callers that don't
  /// thread this through.
  isChallenge?: boolean;
  lesson: Lesson;
  neighbors: Neighbors;
  isCompleted: boolean;
  /// Timestamp (ms since epoch) at which an auto-advance is
  /// scheduled to fire, or null when none is pending. Threaded
  /// down to LessonNav so the Next button can paint a 3..2..1
  /// circular countdown. Owned by App.tsx (`autoAdvanceFireAt`)
  /// so a Prev/Next click anywhere in the lesson cancels the
  /// timer + the ring simultaneously.
  autoAdvanceFireAt?: number | null;
  onComplete: () => void;
  onNavigate: (lessonId: string) => void;
  /// Fires when the "Retry this exercise" inline button is clicked on
  /// a demoted lesson. App wires this to `startRetryLesson`.
  onRetryLesson?: (lessonId: string) => void;
}) {
  // Translate the lesson into the user's chosen locale BEFORE any
  // downstream component sees it. Reader, EditorPane (hints), QuizView,
  // BlocksView, the audio + read-cursor hooks — every consumer reads
  // the localized version. Identity-stable when locale is `en` or no
  // overlay exists for this lesson, so React's referential-equality
  // checks downstream still skip re-renders.
  const t = useT();
  const [locale] = useLocale();
  const lesson = useMemo(
    () => localizedLesson(rawLesson, locale),
    [rawLesson, locale],
  );
  const hasExercise = isExerciseKind(lesson);
  /// Lessons that opt into the Trade harness use the API tester
  /// dock above the lesson body as their interactive surface —
  /// the workbench/editor below would just show a placeholder
  /// console.log and would dilute the dock's prominence. We treat
  /// these the same as reading lessons everywhere downstream:
  ///   - the workbench-wrap doesn't render
  ///   - Next auto-completes the lesson on click (no "run tests"
  ///     gate to satisfy)
  const hasTradeHarness =
    "harness" in lesson && lesson.harness === "trade";
  // Multi-file workbench state. We always deal in arrays here — legacy
  // single-file lessons get synthesized into a one-element array by
  // `deriveStarterFiles`. Storing an array even for the single-file case
  // keeps the EditorPane contract uniform.
  // `useWorkbenchFiles` reads from localStorage synchronously on first
  // render so reopening a lesson restores the learner's in-progress code
  // instead of snapping back to the starter. Reset clears the save and
  // returns to starter in one step.
  const { files, setFiles, resetToStarter } = useWorkbenchFiles(
    courseId,
    lesson,
    hasExercise,
  );
  const [activeFileIdx, setActiveFileIdx] = useState(0);
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  // When true, the workbench has been popped out into a separate window and
  // the main-window editor gets hidden in favor of a "currently popped out"
  // placeholder. Reset on lesson change via the parent's keyed remount.
  const [popped, setPopped] = useState(false);

  // Exercise render mode — only meaningful when `lesson.blocks` is present
  // (otherwise the lesson can only be played as a free-form editor).
  // Stored GLOBALLY in localStorage (key `libre:lesson-mode`) rather than
  // per-lesson — flipping the toggle on any lesson with blocks now applies
  // to every other lesson with blocks. The previous per-lesson key
  // (`fb:lesson-mode:<id>`) read as "I want blocks for THIS lesson only,"
  // which was almost never what learners wanted; users who like blocks
  // like them everywhere, and the toggle-on-this-lesson, toggle-off-on-
  // the-next dance was friction. Default stays "editor" on desktop;
  // mobile forces "blocks" (see MobileLesson dispatch — this LessonView
  // is desktop-only).
  const exerciseHasBlocks =
    hasExercise && "blocks" in lesson && !!lesson.blocks;
  const [exerciseMode, setExerciseMode] = useLocalStorageState<
    "editor" | "blocks"
  >("libre:lesson-mode", "editor");
  // Force editor mode when blocks aren't available for THIS lesson. The
  // global flag may say "blocks" but a lesson without a blocks payload
  // can't honour it — falls back to editor mode without touching the
  // stored preference, so the next lesson that DOES have blocks picks
  // up where the learner left off.
  const effectiveExerciseMode: "editor" | "blocks" = exerciseHasBlocks
    ? exerciseMode
    : "editor";

  // React Native courses route their preview through a SEPARATE OS
  // window (the popped phone simulator) instead of a fixed bottom-
  // pane OutputPane. When this is true, the lesson workbench renders
  // the EditorPane full-width and the phone view lives in its own
  // popout. We track an "open" boolean to remember whether the user
  // last asked the popout to be on or off — the next Run auto-opens
  // it, and the toggle button reopens it after dismissal.
  const useFloatingPhone = courseLanguage === "reactnative";
  // Scope keyed on lesson so two RN lessons in different tabs each
  // get their own popout window + bus channel.
  const phoneScope = `lesson:${courseId}:${lesson.id}`;
  // The actual rendered popout window is owned by `lib/phonePopout.ts`
  // — this hook only persists the user's intent ("they want it open")
  // so the next session opens with the same preference. The current
  // value isn't read anywhere; the setter triggers the write-through.
  const [, setFloatingPhoneOpen] = useLocalStorageState<boolean>(
    "libre:floating-phone-open",
    true,
  );
  // Cache the most recent state we pushed to the popout. When the
  // popout opens AFTER the run already happened (or after a reload)
  // it asks us to re-emit via a `request-state` message — without
  // a cache the popout sits forever on the empty placeholder. The
  // ref isn't reactive: it's read inside an event-listener callback,
  // not during render.
  const lastPhoneStateRef = useRef<PhonePreviewMsg | null>(null);
  // Bus the LessonView pushes preview URLs through. The raw bus
  // (`makePhonePreviewBus`) is constructed once per scope and
  // wrapped so each `emit` updates `lastPhoneStateRef` automatically
  // — the seven call sites elsewhere in this file stay unchanged.
  const phoneBus = useMemo(() => {
    if (!useFloatingPhone) return null;
    const raw = makePhonePreviewBus(phoneScope);
    return {
      listen: raw.listen,
      emit: (msg: PhonePreviewMsg) => {
        // Cache everything except the inbound `request-state`
        // handshake so a later re-emit replays the actual state.
        if (msg.type !== "request-state") {
          lastPhoneStateRef.current = msg;
        }
        raw.emit(msg);
      },
    };
  }, [useFloatingPhone, phoneScope]);

  // Reply to the popout's `request-state` handshake with the most
  // recent cached message. Without this, opening the popout after
  // a run already happened leaves it stuck on "run your code to
  // see it here on the simulator." `phoneBus.emit` here triggers
  // our own listener too (Tauri-event broadcast is bidirectional),
  // but the re-emitted message type is `preview` / `console` /
  // `running` — not `request-state` — so we don't loop.
  useEffect(() => {
    if (!phoneBus) return;
    const unlisten = phoneBus.listen((msg: PhonePreviewMsg) => {
      if (msg.type !== "request-state") return;
      const cached = lastPhoneStateRef.current;
      if (cached) phoneBus.emit(cached);
    });
    return unlisten;
  }, [phoneBus]);
  // When the user closes the lesson tab or pops the workbench out,
  // close the popout too — leaving an orphaned phone window for a
  // lesson the user has stopped looking at is just confusing.
  useEffect(() => {
    if (!useFloatingPhone) return;
    return () => {
      void closePhonePopout(phoneScope);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useFloatingPhone, phoneScope]);

  // SvelteKit lessons keep a long-lived `vite dev` process under
  // <app-data>/sveltekit-runs/<id>/. Stop it on lesson tab close
  // so we don't leak Node processes across sessions. Idempotent —
  // backend no-ops when nothing's running.
  useEffect(() => {
    const id = `${courseId}:${lesson.id}`;
    return () => {
      // Lazy-import to avoid loading the runtime module before
      // it's needed (the SvelteKit runtime pulls in extra Tauri
      // event-listener glue).
      void import("../../runtimes/sveltekit").then((m) =>
        m.stopSvelteKit(id),
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, lesson.id]);

  // Proactive toolchain probe. When the lesson's language is one that
  // needs a local compiler (C / C++ / Java / Kotlin / C# / Assembly),
  // hit `probe_language_toolchain` on mount — matches the pattern
  // PlaygroundView uses. If the probe says "not installed" (or
  // installed-but-broken, e.g. the macOS `java` stub without a real
  // JDK), we render the install banner above the workbench so the
  // learner sees it BEFORE clicking Run instead of after a failed
  // compile. Browser-hosted languages (JS/TS/Python/etc.) short-
  // circuit inside `probe_language_toolchain` to installed=true, so
  // the banner never appears for them.
  const [tcRefresh, setTcRefresh] = useState(0);
  // Reading-only lessons don't have a `language` field — only exercise
  // and mixed-content lessons do. Skip the probe entirely for readers.
  const lessonLanguage = hasExercise ? lesson.language : undefined;
  const needsLocalToolchain =
    !!lessonLanguage && NATIVE_TOOLCHAIN_LANGUAGES.has(lessonLanguage);
  const { status: lessonToolchainStatus } = useToolchainStatus(
    needsLocalToolchain ? lessonLanguage! : "",
    tcRefresh,
  );
  const showLessonToolchainBanner =
    needsLocalToolchain &&
    !!lessonToolchainStatus &&
    !lessonToolchainStatus.installed &&
    !!lessonToolchainStatus.install_hint;


  async function handleRun() {
    if (!hasExercise) return;
    setRunning(true);
    // Broadcast the run to the global is-running signal so surfaces
    // outside this view (sidebar's ChapterGrid holograms, future
    // status chrome) can react. Cleared in the same `finally` that
    // resets the local `setRunning(false)` below so the global
    // flag's lifecycle matches the local one exactly. Safe to call
    // even when no subscriber is mounted — the hook no-ops on
    // empty listener sets.
    setRunStatus(true);
    setResult(null);
    // Auto-pop the phone simulator open on every Run so a closed
    // popout surfaces itself when the user actually has output to
    // see. We open the OS window AND set the local "open" state so
    // the toggle button hides and we remember the preference. The
    // popout is idempotent — re-opening when already open just
    // focuses the existing window.
    if (useFloatingPhone) {
      setFloatingPhoneOpen(true);
      void openPhonePopout(phoneScope, lesson.title);
      // Tell the popout we're working on a new run so it can swap
      // to the "running…" placeholder instead of showing a stale
      // preview iframe through the compile.
      phoneBus?.emit({ type: "running" });
    }
    try {
      const tests = "tests" in lesson ? lesson.tests : undefined;
      // Prefer the course's language when it's a whole-app runtime
      // (react native, web, threejs) — those are meta-languages where
      // the RUN behaviour is owned by the course, not the individual
      // lesson. The fix for docs-generated RN courses: the LLM
      // sometimes stamps `lesson.language: "javascript"` for JSX code
      // even though we told it the course is "reactnative". Without
      // this override we'd dispatch to the JS worker and blow up with
      // an AsyncFunction blob error.
      const effectiveLanguage =
        courseLanguage === "reactnative" ||
        courseLanguage === "web" ||
        courseLanguage === "threejs"
          ? courseLanguage
          : lesson.language;
      const harness =
        "harness" in lesson
          ? (lesson as { harness?: "evm" | "solana" }).harness
          : undefined;
      const r = await runFiles(
        effectiveLanguage,
        files,
        tests,
        undefined,
        // Identity passed through to the SvelteKit runner so the
        // long-lived `vite dev` process gets keyed per lesson —
        // re-runs hot-reload the same server instead of spinning
        // up a fresh project dir each time.
        `${courseId}:${lesson.id}`,
        harness,
      );
      // Defensive guard: a runtime can theoretically resolve to
      // undefined (unknown language id slipping past the LanguageId
      // switch, an untyped IPC failure). Surface a friendly error
      // rather than crashing the handler with `r.error` on undefined.
      if (!r) {
        const errResult: RunResult = {
          logs: [],
          error: `No runtime for language "${effectiveLanguage}".`,
          durationMs: 0,
        };
        setResult(errResult);
        emitVerifierEvent({
          type: "runResult",
          lessonId: lesson.id,
          passed: false,
          result: errResult,
        });
        if (useFloatingPhone) {
          phoneBus?.emit({
            type: "console",
            logs: [],
            error: `No runtime for language "${effectiveLanguage}".`,
          });
        }
        return;
      }
      setResult(r);
      const passed = isPassing(r);
      // Analytics: every Run produces one `lesson.run` event with
      // the pass/fail verdict. Distinct from `lesson.complete`
      // (which only fires on first-time pass) so the dashboard
      // can compute pass-rate per course + see how many attempts
      // people take before passing.
      track.lessonRun({
        courseId,
        lessonId: lesson.id,
        language: effectiveLanguage,
        passed,
      });
      // Run-outcome haptic: completion crescendo on pass,
      // error notification on fail. Fires BEFORE the visual
      // result lands so the buzz hits the moment the test
      // verdict is known — "you felt the result, then the
      // green/red flips in front of you." Mobile users get
      // the most out of this; desktop users only feel it on
      // touch laptops or paired devices.
      if (passed) {
        void fireHaptic("completion");
        onComplete();
      } else {
        void fireHaptic("notification-error");
      }
      // Watch-mode verifier: announce the run finished + whether it
      // passed so the verify-course coroutine can advance to the
      // next lesson without polling React state.
      emitVerifierEvent({
        type: "runResult",
        lessonId: lesson.id,
        passed,
        result: r,
      });
      // Push the run outcome to the popped phone simulator. Preview
      // URL when present (RN runtime hands one back from the local
      // Tauri preview server); otherwise the captured logs + error
      // so a failed run is at least readable inside the popout.
      if (useFloatingPhone) {
        if (r.previewUrl) {
          phoneBus?.emit({ type: "preview", url: r.previewUrl });
        } else {
          phoneBus?.emit({
            type: "console",
            logs: r.logs ?? [],
            error: r.error,
          });
        }
      }
    } catch (e) {
      // Tauri IPC failures (missing command, serialization errors),
      // worker init failures — any thrown error from the runtime chain
      // lands here. Render it in the OutputPane so the user sees what
      // went wrong instead of a silent failed run.
      const errMsg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      const errResult: RunResult = {
        logs: [],
        error: errMsg,
        durationMs: 0,
      };
      setResult(errResult);
      emitVerifierEvent({
        type: "runResult",
        lessonId: lesson.id,
        passed: false,
        result: errResult,
      });
      if (useFloatingPhone) {
        phoneBus?.emit({ type: "console", logs: [], error: errMsg });
      }
    } finally {
      setRunning(false);
      setRunStatus(false);
    }
  }

  /// Reset reverts every file to its starter content AND wipes the saved
  /// copy in localStorage so the next lesson-open also starts fresh. Safe
  /// to call always — the hook no-ops when the lesson isn't an exercise.
  function handleReset() {
    resetToStarter();
    setActiveFileIdx(0);
  }

  /// Reveal solution swaps the entire file set to the reference solution.
  /// Clears the run result so the learner sees a fresh state to run against;
  /// gated by EditorPane's confirmation dialog so it can't fire by accident.
  function handleRevealSolution() {
    if (hasExercise) {
      setFiles(deriveSolutionFiles(lesson));
      setActiveFileIdx(0);
      setResult(null);
    }
  }

  /// Per-file edit handler. Immutably replaces the content of files[index].
  /// React re-renders EditorPane with the new array; Monaco picks up the
  /// new value for the active file.
  function handleFileChange(index: number, next: string) {
    setFiles((prev) => {
      if (index < 0 || index >= prev.length) return prev;
      const copy = prev.slice();
      copy[index] = { ...copy[index], content: next };
      return copy;
    });
  }

  const hints =
    hasExercise && "hints" in lesson && lesson.hints ? lesson.hints : undefined;

  // Keep the main window and the popped-out window in sync. The bus chooses
  // Tauri events (for native multi-window) or BroadcastChannel (for vite
  // dev) under the hood — we only see a clean listen/emit API here.
  useEffect(() => {
    if (!hasExercise) return;
    const bus = makeBus(courseId, lesson.id);
    const unlisten = bus.listen((msg, from) => {
      if (from !== "popped") return;
      if (msg.type === "files") setFiles(msg.files);
      if (msg.type === "running") setRunning(true);
      if (msg.type === "result") {
        setResult(msg.result);
        setRunning(false);
      }
      if (msg.type === "complete") onComplete();
      // The popped window fires `hello` once it mounts so we can push it
      // our current files (otherwise it'd load with starter text even if
      // the user had edited here).
      if (msg.type === "hello") {
        bus.emit({ type: "files", files }, "main");
      }
      // Popped window is going away — flip the inline workbench back on
      // so the learner doesn't stare at a "popped out" placeholder over
      // an empty detached window.
      if (msg.type === "closed") {
        setPopped(false);
      }
    });
    return unlisten;
    // `files` intentionally omitted — we re-broadcast via the effect
    // below. Including it here would re-register the listener on every
    // keystroke and drop pending messages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, lesson.id, hasExercise, onComplete]);

  useEffect(() => {
    if (!hasExercise) return;
    const bus = makeBus(courseId, lesson.id);
    bus.emit({ type: "files", files }, "main");
  }, [files, courseId, lesson.id, hasExercise]);

  /// Open the workbench in a detached window. Uses Tauri's WebviewWindow
  /// when available so the popped window lives inside the app; falls back
  /// to window.open for vite dev or if the capability is missing. We pass
  /// the current code through the URL so the popped window paints with
  /// the learner's in-progress code on first render — localStorage isn't
  /// reliably shared across Tauri webview windows.
  async function handlePopOut() {
    if (!hasExercise) return;
    try {
      await openPoppedWorkbench(courseId, lesson.id, lesson.title, files);
      setPopped(true);
    } catch (e) {
      console.error("[libre] pop-out failed:", e);
    }
  }

  /// Hand the current (course, lesson) off to the Libre VSCode
  /// extension via a `vscode://libre-academy.libre/open` URL. The OS
  /// routes the protocol to VSCode (if installed); the extension's
  /// URI handler resolves the course + lesson out of the shared
  /// libre data dir and opens its own panel. Progress writes back
  /// to the same `progress.sqlite` we read so a completion in VSCode
  /// shows up here as a checkmark the next time the page refreshes.
  ///
  /// We don't save the in-flight editor contents here — the extension
  /// only ever reads the lesson's canonical `starter` from
  /// course.json, not whatever's in the desktop app's localStorage.
  /// Once VSCode is launched the user does the rest of their work
  /// there. If they want to come back, they re-open the lesson in
  /// the desktop app and the progress already reflects whatever they
  /// did in VSCode.
  async function handleOpenInVSCode() {
    const encCourse = encodeURIComponent(courseId);
    const encLesson = encodeURIComponent(lesson.id);
    const url = `vscode://libre-academy.libre/open?course=${encCourse}&lesson=${encLesson}`;
    /// `openExternal` shells out to the OS opener, which will route a
    /// `vscode://` URL to the registered VSCode handler. If VSCode
    /// isn't installed the OS shows its own "no handler" dialog —
    /// good enough as a fallback; we don't try to detect VSCode
    /// presence first because there's no reliable cross-platform
    /// probe that doesn't shell out.
    await openExternal(url);
  }

  /// Bring the workbench back into the main window. Closes the popped
  /// window too so we don't leave a zombie detached view. The popped
  /// window's `beforeunload` also emits `closed` which flips our state,
  /// but setting it here too makes the main-window transition instant
  /// instead of waiting for the round-trip.
  async function handleReopenInline() {
    setPopped(false);
    await closePoppedWorkbench(courseId, lesson.id);
  }

  // Reading-only lessons have no run/quiz gate — the Next button stands in
  // as the "I read this" affordance. Exercise/quiz lessons get marked complete
  // when the user actually solves them, so Next there is just navigation.
  // Trade-harness lessons surface their interaction in the dock
  // above the lesson body, not in an editor. From the navigation
  // / completion path's POV they behave exactly like reading
  // lessons — Next auto-marks complete, no Run-the-tests gate.
  const isReadingOnly =
    (!hasExercise && !isQuiz(lesson)) || hasTradeHarness;

  function handleNext() {
    if (!neighbors.next) return;
    if (isReadingOnly && !isCompleted) {
      onComplete();
    }
    onNavigate(neighbors.next.id);
  }
  function handlePrev() {
    if (neighbors.prev) onNavigate(neighbors.prev.id);
  }

  /// Watch-mode verifier wiring. The verifier coroutine (cmd+K →
  /// Verify course) emits commands targeting a specific lesson id;
  /// this LessonView listens and dispatches them to the same
  /// handlers the buttons use, so the editor visibly flips to
  /// solution code, the run button visibly fires, etc.
  ///
  /// We capture the latest handlers via a ref so the listener stays
  /// registered across re-renders without re-binding the window
  /// event each time the closure changes.
  const verifierHandlersRef = useRef({
    handleRevealSolution,
    handleRun,
    handleNext,
  });
  useEffect(() => {
    verifierHandlersRef.current = {
      handleRevealSolution,
      handleRun,
      handleNext,
    };
  });
  useEffect(() => {
    const off = onVerifierCommand((cmd) => {
      if (cmd.lessonId !== lesson.id) return;
      if (cmd.type === "revealSolution")
        verifierHandlersRef.current.handleRevealSolution();
      else if (cmd.type === "run")
        void verifierHandlersRef.current.handleRun();
      else if (cmd.type === "next")
        verifierHandlersRef.current.handleNext();
    });
    return off;
  }, [lesson.id]);

  /// Announce the lesson view is mounted + ready to receive
  /// commands. Fires once per lesson change. The verifier coroutine
  /// awaits this event before dispatching any per-lesson commands so
  /// it doesn't race the previous LessonView's unmount.
  useEffect(() => {
    emitVerifierEvent({
      type: "lessonReady",
      courseId,
      lessonId: lesson.id,
      kind: lesson.kind,
    });
  }, [courseId, lesson.id, lesson.kind]);

  /// Plausible: fire `lesson.start` once per unique lesson mount so
  /// the dashboard can pair it with `lesson.run` for a funnel
  /// ("started → ran → passed"). Keyed on `[courseId, lesson.id]`
  /// — same key the verifier-event effect above uses, so a tab
  /// switch back and forth re-fires (intentional: each visit is
  /// a fresh start for engagement purposes).
  useEffect(() => {
    track.lessonStart({
      courseId,
      lessonId: lesson.id,
      kind: lesson.kind,
    });
  }, [courseId, lesson.id, lesson.kind]);

  // ── Keyboard shortcuts (this view's scope) ───────────────────────
  //
  // `lesson.run` fires the Run handler. `allowInInput: true` is
  // critical here — Run is the one shortcut learners want active
  // while their cursor is in Monaco; without the opt-in, ⌘R would
  // silently do nothing inside the editor. We guard with
  // `hasExercise` so a reading-only lesson doesn't intercept ⌘R
  // (which would otherwise reload the page or hijack the browser
  // shortcut in unhelpful ways).
  //
  // Prev / Next pull straight from the same handlers the nav arrow
  // buttons use, so any side effects (completion-mark, scroll-to-
  // top, etc.) stay identical between mouse and keyboard.
  useKeybinding("lesson.run", () => void handleRun(), {
    enabled: hasExercise,
    allowInInput: true,
  });
  useKeybinding("lesson.run.alt", () => void handleRun(), {
    enabled: hasExercise,
    allowInInput: true,
  });
  useKeybinding("lesson.prev", handlePrev, {
    enabled: !!neighbors.prev,
  });
  useKeybinding("lesson.next", handleNext, {
    enabled: !!neighbors.next,
  });

  // The "mark read & next" variant is the moment we want to
  // celebrate visually — reading-only lessons don't have a Run /
  // submit button to mark completion, so this nav button doubles
  // as the "you finished reading, claim the lesson" CTA. The
  // holographic foil treatment lives on the LessonNav side; we
  // just signal here that this nav slot is in CTA mode.
  const isMarkReadCta =
    isReadingOnly && !isCompleted && !!neighbors.next;
  // Code-challenge / quiz lessons get the same celebration once
  // the learner has actually passed them: tests green (or quiz
  // answered) flips `isCompleted` → true, and the Next button
  // lights up holographic to signal "you solved it, move on."
  // Reading-only lessons are excluded because their CTA window
  // is BEFORE completion (the click IS the completion); for
  // exercise + quiz lessons the CTA window is AFTER completion.
  const isPostPassCta =
    !isReadingOnly && isCompleted && !!neighbors.next;
  const isNextCta = isMarkReadCta || isPostPassCta;
  const nextLabel = isMarkReadCta ? "mark read & next" : "next";

  const nav = (
    <LessonNav
      prev={neighbors.prev}
      next={neighbors.next}
      onPrev={handlePrev}
      onNext={handleNext}
      nextLabel={nextLabel}
      nextIsCta={isNextCta}
      autoAdvanceFireAt={autoAdvanceFireAt ?? null}
    />
  );

  // Quiz lessons are rendered inline under the lesson prose with no editor /
  // output pane — the quiz widget handles its own answer flow. Column layout
  // so reader and quiz stack vertically inside a single scroll container.
  if (isQuiz(lesson)) {
    return (
      <div className="libre__lesson libre__lesson--column">
        <div className="libre__lesson-scroll">
          <LessonReader courseId={courseId} lesson={lesson} requiresDevice={courseRequiresDevice} />
          <QuizView lesson={lesson} onComplete={onComplete} />
          <div className="libre__lesson-nav-wrap">{nav}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`libre__lesson ${
        isChallenge ? "libre__lesson--challenge" : ""
      }`}
    >
      <LessonReader
        courseId={courseId}
        lesson={lesson}
        footer={nav}
        onRetryLesson={onRetryLesson}
        requiresDevice={courseRequiresDevice}
      />
      {/* First-time "compile Rust locally for instant runs" nudge.
          Self-gating: no-ops unless this is a Rust exercise on
          desktop with rustc NOT already installed and the learner
          hasn't permanently dismissed. Rust still works without it
          (Playground fallback) — this just offers the fast path.
          `lessonLanguage` is `undefined` for reading lessons, so
          the component arms only on actual Rust exercises. */}
      <RustLocalPrompt language={lessonLanguage} />
      {hasExercise && !popped && !hasTradeHarness && (
        <div className="libre__lesson-workbench-wrap">
          {showLessonToolchainBanner && lessonToolchainStatus && (
            // Proactive missing-toolchain nudge. Sits above the
            // workbench so the learner doesn't click Run, wait for
            // compile, and THEN discover their JDK is missing — they
            // see "Java isn't installed" with a one-click Install
            // button the moment the lesson opens. `tcRefresh` re-runs
            // the probe after a successful install so this clears
            // itself once the toolchain lands on PATH.
            <MissingToolchainBanner
              status={lessonToolchainStatus}
              onInstalled={() => setTcRefresh((n) => n + 1)}
            />
          )}
          {/* Editor / Blocks toggle moved INTO the editor's header
              (and BlocksView's prompt row when in blocks mode), so
              the workbench-wrap no longer renders a standalone
              toggle here. The mode prop is passed through to
              whichever view is mounted; both views show the same
              segmented control so switching feels symmetric. */}
          {effectiveExerciseMode === "blocks" ? (
            // Blocks mode owns its own template/pool/output layout —
            // no Workbench split, no EditorPane. Verification still
            // routes through `runFiles` and the same OutputPane the
            // editor mode uses (BlocksView includes one inline).
            // `onSolutionAccepted` syncs the editor-mode workbench
            // state with the learner's winning placement, so a
            // toggle back to Editor mode shows working code instead
            // of stale starter — completes the "I solved it in
            // blocks, now let me read the final source" flow.
            <BlocksView
              key={lesson.id}
              lesson={lesson as ExerciseLesson | MixedLesson}
              onComplete={onComplete}
              onSolutionAccepted={(blockFiles) => setFiles(blockFiles)}
              exerciseMode={effectiveExerciseMode}
              onExerciseModeChange={
                exerciseHasBlocks ? setExerciseMode : undefined
              }
            />
          ) : useFloatingPhone ? (
            // RN-course path — editor takes the full workbench width
            // and the phone popout window (lib/phonePopout.ts) carries
            // the preview. We render the EditorPane inside a `solo`
            // wrapper that matches the Workbench's card chrome so the
            // visual weight stays consistent with the JS / Python
            // lesson surfaces.
            <div className="libre__lesson-workbench-solo">
              <EditorPane
                language={lesson.language}
                files={files}
                activeIndex={activeFileIdx}
                onActiveIndexChange={setActiveFileIdx}
                onChange={handleFileChange}
                onRun={handleRun}
                hints={hints}
                onReset={handleReset}
                onRevealSolution={handleRevealSolution}
                onPopOut={handlePopOut}
                onOpenInVSCode={handleOpenInVSCode}
                exerciseMode={
                  exerciseHasBlocks ? effectiveExerciseMode : undefined
                }
                onExerciseModeChange={
                  exerciseHasBlocks ? setExerciseMode : undefined
                }
              />
            </div>
          ) : (
            <Workbench
              widthControlsParent
              // Challenge lessons open the workbench WIDE by default
              // — the prose is a one-paragraph problem statement
              // and the action lives in the workbench. 66% matches
              // the visual width the older flex:1 layout produced
              // (reader ~32% + workbench ~68%) so existing users
              // don't see the column jump on first load. The drag
              // handle still lets them resize narrower or wider
              // within MIN_WORKBENCH_PCT / MAX_WORKBENCH_PCT.
              // Regular lessons fall through to the Workbench's own
              // default (now 62% — bumped per Notion "Update editor
              // default width" so the editor leads the split during
              // exercises while the prose keeps a ~38% reference
              // column).
              defaultWorkbenchPct={isChallenge ? 66 : undefined}
              editor={
                <EditorPane
                  language={lesson.language}
                  files={files}
                  activeIndex={activeFileIdx}
                  onActiveIndexChange={setActiveFileIdx}
                  onChange={handleFileChange}
                  onRun={handleRun}
                  hints={hints}
                  onReset={handleReset}
                  onRevealSolution={handleRevealSolution}
                  onPopOut={handlePopOut}
                onOpenInVSCode={handleOpenInVSCode}
                  exerciseMode={
                    exerciseHasBlocks ? effectiveExerciseMode : undefined
                  }
                  onExerciseModeChange={
                    exerciseHasBlocks ? setExerciseMode : undefined
                  }
                />
              }
              output={
                <OutputPane
                  result={result}
                  running={running}
                  suppressToolchainBanner={showLessonToolchainBanner}
                  language={lesson.language}
                  testsExpected={"tests" in lesson && !!lesson.tests?.trim()}
                />
              }
            />
          )}
        </div>
      )}
      {hasExercise && popped && (
        <button
          className="libre__workbench-popped-pill"
          onClick={handleReopenInline}
          title={t("lesson.popBackTitle")}
        >
          <span className="libre__workbench-popped-pill-icon" aria-hidden>
            <Icon icon={panelLeftOpen} size="xs" color="currentColor" />
          </span>
          <span>{t("lesson.popBackIn")}</span>
        </button>
      )}

      {/* Phone simulator for RN courses now lives in its own OS
          window — opened lazily on first Run, or via this toggle
          button at any time. The popout listens on
          `makePhonePreviewBus(phoneScope)` for new preview URLs we
          push from `handleRun`. The button sits permanently in the
          corner because we can't reliably detect whether the user
          closed the OS window (Tauri webview close events bubble
          inconsistently across platforms), so the cheapest correct
          UX is "always offer to re-open / focus". `openPhonePopout`
          is idempotent — re-opening an already-open popout just
          focuses it. */}
      {useFloatingPhone && hasExercise && !popped && (
        <PhoneToggleButton
          onShow={() => {
            setFloatingPhoneOpen(true);
            void openPhonePopout(phoneScope, lesson.title);
            // If we already have a result for this lesson, replay
            // it into the popout so the freshly-opened window isn't
            // empty until the next Run.
            if (result?.previewUrl) {
              phoneBus?.emit({ type: "preview", url: result.previewUrl });
            } else if (result) {
              phoneBus?.emit({
                type: "console",
                logs: result.logs ?? [],
                error: result.error,
              });
            }
          }}
        />
      )}
    </div>
  );
}
