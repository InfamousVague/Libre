import { useCallback, useEffect, useState } from "react";
import { profileKey } from "../lib/profileStore";

/// localStorage key for the `{ [courseId]: unixSeconds }` map that tracks
/// the last time each course was opened / focused. Bumped whenever the
/// learner selects a lesson in that course; consumed by the sidebar
/// carousel to sort "recent first".
const STORAGE_KEY = profileKey("libre:recent-courses:v1");

type RecentsMap = Record<string, number>;

function loadInitial(): RecentsMap {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Narrow to the shape we expect — drop anything weird to stay resilient
      // to manual localStorage edits.
      const clean: RecentsMap = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "number" && Number.isFinite(v)) clean[k] = v;
      }
      return clean;
    }
    return {};
  } catch {
    return {};
  }
}

/// Tracks "when was this course last opened" per course id. The carousel
/// uses this to sort recent-first. `touch(courseId)` bumps the timestamp
/// (called from App whenever a lesson is selected) and writes through to
/// localStorage so the order survives an app restart.
///
/// Why not just reuse `history` (completion timestamps)? A learner can
/// be actively working inside a course for days without completing
/// anything — the carousel should surface THAT course at the top, not
/// the last course they happened to finish a lesson in.
export function useRecentCourses() {
  const [recents, setRecents] = useState<RecentsMap>(loadInitial);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(recents));
    } catch {
      // Quota exceeded / private browsing — harmless, the in-memory copy
      // still sorts correctly for this session.
    }
  }, [recents]);

  const touch = useCallback((courseId: string) => {
    const now = Math.floor(Date.now() / 1000);
    setRecents((prev) => {
      // Avoid a re-render if the timestamp we'd write is the same second
      // as what's already stored. Repeated clicks on the same lesson
      // won't thrash localStorage.
      if (prev[courseId] === now) return prev;
      return { ...prev, [courseId]: now };
    });
  }, []);

  return { recents, touch };
}
