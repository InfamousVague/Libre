import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type {
  WorkbenchFile,
  Lesson,
  ExerciseLesson,
  MixedLesson,
} from "../data/types";
import { deriveStarterFiles } from "../lib/workbenchFiles";
import { profileKey } from "../lib/profileStore";

/// Per-lesson workbench persistence. Keeps the learner's in-progress code
/// in localStorage keyed on `{courseId, lessonId}` so reopening an exercise
/// restores exactly what they typed, not the starter. Reset returns to
/// starter AND clears the save so the next visit also starts clean.
///
/// The hook stores a "signature" of the starter alongside the files — when
/// a lesson is regenerated (same id, different file shape), the signatures
/// differ and we fall back to the new starter rather than rendering stale
/// content into mismatched filenames.

// Profile-scoped: saved in-progress lesson code is per profile.
// profileKey wraps the prefix; the dynamic {courseId}:{lessonId}
// suffix is appended after, so non-default profiles get
// `libre:p:<id>:libre:workbench:v1:<courseId>:<lessonId>`.
const STORAGE_PREFIX = profileKey("libre:workbench:v1:");

function storageKey(courseId: string, lessonId: string): string {
  return `${STORAGE_PREFIX}${courseId}:${lessonId}`;
}

/// Custom DOM event a "Reset progress" caller fires when the user
/// nukes a course / chapter / lesson via the sidebar context menu.
/// Mounted `useWorkbenchFiles` instances listen for this and reset
/// their in-memory files to the starter set when the event's scope
/// matches their `(courseId, lessonId)`. Without this, resetting a
/// course's progress only cleared completion checkmarks — the
/// learner's last solution stayed in localStorage and re-hydrated
/// the editor on next visit, defeating the reset.
const WORKBENCH_RESET_EVENT = "libre:workbench-reset";
interface WorkbenchResetDetail {
  /// Match scope. Exactly one of these is set:
  /// - `lessonId` set → reset that specific lesson under courseId
  /// - `lessonId` empty + courseId set → reset every lesson in the course
  /// - both empty → reset every workbench (used by Settings → wipe all)
  courseId: string;
  lessonId?: string;
}

/// Drop the saved workbench for a single lesson AND broadcast so a
/// mounted `useWorkbenchFiles` for that lesson re-renders with the
/// starter set immediately (instead of waiting for navigation away
/// and back to remount the hook).
export function clearWorkbenchForLesson(
  courseId: string,
  lessonId: string,
): void {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(storageKey(courseId, lessonId));
    } catch {
      /* private mode or quota — swallow */
    }
  }
  dispatchReset({ courseId, lessonId });
}

/// Drop the saved workbench for every listed lesson under a course.
/// One pass over localStorage so chapters with many lessons stay cheap.
export function clearWorkbenchForChapter(
  courseId: string,
  lessonIds: string[],
): void {
  if (lessonIds.length === 0) return;
  if (typeof localStorage !== "undefined") {
    for (const lessonId of lessonIds) {
      try {
        localStorage.removeItem(storageKey(courseId, lessonId));
      } catch {
        /* swallow */
      }
    }
  }
  // Fire one event per lesson so per-lesson hooks each see their
  // match. (Cheap — typical chapter is <20 lessons.)
  for (const lessonId of lessonIds) {
    dispatchReset({ courseId, lessonId });
  }
}

/// Drop every workbench file saved under a course — used by the
/// "Reset progress" menu item on a course in the sidebar. Walks all
/// localStorage keys with the workbench prefix because we don't keep
/// a separate index of which lessons have been edited.
export function clearWorkbenchForCourse(courseId: string): void {
  if (typeof localStorage !== "undefined") {
    const prefix = `${STORAGE_PREFIX}${courseId}:`;
    try {
      // Collect first then delete — mutating localStorage mid-iteration
      // shifts indices and would skip keys.
      const toRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix)) toRemove.push(key);
      }
      for (const k of toRemove) {
        try {
          localStorage.removeItem(k);
        } catch {
          /* swallow */
        }
      }
    } catch {
      /* swallow */
    }
  }
  dispatchReset({ courseId });
}

function dispatchReset(detail: WorkbenchResetDetail): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent<WorkbenchResetDetail>(WORKBENCH_RESET_EVENT, {
        detail,
      }),
    );
  } catch {
    /* CustomEvent unsupported in some headless environments — drop */
  }
}

/// Signature = sorted filenames joined. Content-agnostic on purpose: if the
/// lesson author tweaks a comment in the starter we still want to restore
/// the learner's edits. It's only the *shape* (file set) that invalidates.
function signatureOf(files: WorkbenchFile[]): string {
  return files
    .map((f) => f.name)
    .sort()
    .join("|");
}

interface PersistedWorkbench {
  signature: string;
  files: WorkbenchFile[];
  savedAt: number;
}

export interface UseWorkbenchFilesResult {
  files: WorkbenchFile[];
  setFiles: React.Dispatch<React.SetStateAction<WorkbenchFile[]>>;
  /// Reverts to the lesson's starter files AND clears the saved copy.
  resetToStarter: () => void;
}

export function useWorkbenchFiles(
  courseId: string,
  lesson: Lesson,
  hasExercise: boolean,
): UseWorkbenchFilesResult {
  // Recompute the starter whenever the lesson changes. Including only
  // `lesson.id` (rather than the full lesson object) keeps the memo stable
  // during edits that don't change the lesson shape. `hasExercise` has
  // already been checked upstream in LessonView — we cast the lesson to
  // the exercise union here so `deriveStarterFiles` accepts it.
  const starter = useMemo(
    () =>
      hasExercise
        ? deriveStarterFiles(lesson as ExerciseLesson | MixedLesson)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lesson.id, hasExercise],
  );

  // Synchronous read in the initializer so the first render already has the
  // restored content — avoids a flash of starter text on reopen.
  const [files, setFiles] = useState<WorkbenchFile[]>(() => {
    if (!hasExercise) return [];
    if (typeof localStorage === "undefined") return starter;
    try {
      const raw = localStorage.getItem(storageKey(courseId, lesson.id));
      if (!raw) return starter;
      const parsed = JSON.parse(raw) as PersistedWorkbench;
      if (parsed.signature !== signatureOf(starter)) return starter;
      if (!Array.isArray(parsed.files) || parsed.files.length === 0) return starter;
      return parsed.files;
    } catch {
      return starter;
    }
  });

  // When the parent keys this hook on `${courseId}:${lessonId}` (see App.tsx
  // LessonView), each new lesson gets a fresh hook instance so we don't need
  // to re-read storage mid-lifecycle. Still, keep a ref so the debounced
  // save effect always writes the latest files rather than the closure's
  // stale snapshot at the time of the last keystroke.
  const latestFilesRef = useRef(files);
  latestFilesRef.current = files;

  // Debounced write-through. 400ms settles fast typing without feeling laggy
  // when the learner hits Run right after an edit. Tracks the pending
  // timeout so the unmount flush below can cancel-and-write synchronously
  // if the learner navigates away mid-debounce.
  const pendingSaveRef = useRef<number | null>(null);
  const writeNow = useCallback(() => {
    if (!hasExercise) return;
    if (typeof localStorage === "undefined") return;
    try {
      const payload: PersistedWorkbench = {
        signature: signatureOf(starter),
        files: latestFilesRef.current,
        savedAt: Date.now(),
      };
      localStorage.setItem(
        storageKey(courseId, lesson.id),
        JSON.stringify(payload),
      );
      // Notify any cloud-sync listener so the same edit fans out to
      // the user's other devices via the realtime sync bus. Decoupled
      // through a CustomEvent so this hook stays unaware of network
      // concerns — the only listener today is `App`'s `useRealtimeSync`
      // glue, but anything else can subscribe (e.g. an analytics
      // sink) without re-wiring the hook signature.
      try {
        window.dispatchEvent(
          new CustomEvent("libre:workbench-persisted", {
            detail: {
              courseId,
              lessonId: lesson.id,
              files: latestFilesRef.current,
              savedAt: Date.now(),
            },
          }),
        );
      } catch {
        /* CustomEvent unsupported (some headless harnesses) — drop */
      }
    } catch {
      /* QuotaExceeded or private-mode — drop silently; in-memory state
         is still correct for the current session. */
    }
  }, [hasExercise, starter, courseId, lesson.id]);

  useEffect(() => {
    if (!hasExercise) return;
    if (typeof localStorage === "undefined") return;
    pendingSaveRef.current = window.setTimeout(() => {
      writeNow();
      pendingSaveRef.current = null;
    }, 400);
    return () => {
      if (pendingSaveRef.current !== null) {
        window.clearTimeout(pendingSaveRef.current);
        pendingSaveRef.current = null;
      }
    };
  }, [files, hasExercise, writeNow]);

  // Unmount flush — if the learner switches lessons (or closes the window)
  // mid-debounce, the cleanup above cancels the pending save. Without this,
  // the last burst of keystrokes would never hit disk. The separate
  // unmount-only effect runs AFTER the debounce cleanup so we can tell the
  // difference between "debounced save fired cleanly" (pendingSaveRef ===
  // null) and "cancelled mid-debounce" (ref still set by the unmount
  // observer below). We always flush on unmount to be safe — writing the
  // same bytes twice is a no-op from the learner's POV.
  useEffect(() => {
    return () => {
      writeNow();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetToStarter = useCallback(() => {
    setFiles(starter);
    try {
      localStorage.removeItem(storageKey(courseId, lesson.id));
    } catch {
      /* ignore — best-effort cleanup */
    }
  }, [starter, courseId, lesson.id]);

  /// Listen for a "Reset progress" broadcast from the sidebar context
  /// menu. Without this, a course-level reset only cleared the
  /// completion checkmarks while the live editor kept showing the
  /// learner's last solution (re-saved from the in-memory `files`
  /// state on the next debounce). Now any mounted instance whose
  /// scope matches the event resets its in-memory files to starter,
  /// matching the user's mental model that "reset" puts the lesson
  /// back to the way it was before they typed anything.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!hasExercise) return;
    const onReset = (ev: Event) => {
      const detail = (ev as CustomEvent<{
        courseId: string;
        lessonId?: string;
      }>).detail;
      if (!detail) return;
      // Course-only event matches every mounted lesson under that
      // course; per-lesson event must match this lesson exactly.
      const matchesCourse = detail.courseId === courseId;
      const matchesLesson =
        !detail.lessonId || detail.lessonId === lesson.id;
      if (!matchesCourse || !matchesLesson) return;
      // Reset to starter without writing to localStorage — the
      // dispatcher already cleared the saved copy. Suppressing the
      // debounce write that the next state change would queue is
      // handled implicitly: the unmount/effect-cleanup chain only
      // writes whatever's in `latestFilesRef.current`, which we
      // overwrite to `starter` on the next render via setFiles.
      setFiles(starter);
    };
    window.addEventListener(
      "libre:workbench-reset",
      onReset as EventListener,
    );
    return () => {
      window.removeEventListener(
        "libre:workbench-reset",
        onReset as EventListener,
      );
    };
  }, [courseId, lesson.id, hasExercise, starter]);

  return { files, setFiles, resetToStarter };
}
