/// Achievement evaluation engine.
///
/// Pure-function design: `evaluateAchievements(snapshot)` walks the
/// registry, runs each rule against the snapshot, and returns the
/// set of unlocked ids. The hook layer (`useAchievements`) diffs
/// that set against the persisted unlocks to produce "newly
/// unlocked" — those are what the toast/modal layer enqueues.
///
/// Persistence is a JSON blob in `localStorage["libre:achievements:
/// unlocked"]`, shaped as `{ id, unlockedAt }[]`. Local-only for now;
/// the cloud-sync layer can pick this up later via the same
/// piggyback channel `librarySync` uses.
///
/// Cross-platform notes: localStorage is available on both web AND
/// the Tauri WebView (it's just a regular browser API), so we don't
/// need to special-case desktop. The only thing we DO special-case
/// is the storage event for cross-tab sync, which is web-only.

import type {
  Achievement,
  AchievementRule,
  CountedLessonKind,
} from "../data/achievements";
import { ACHIEVEMENTS, getAchievement } from "../data/achievements";
import type { Completion } from "./storage";
import type { Course } from "../data/types";
import { profileKey } from "./profileStore";

/// Persisted unlock record. `unlockedAt` is a Date.now() ms timestamp;
/// we use ms (not seconds) because it's the natural format from
/// `Date.now()` and the tiny precision difference doesn't matter for
/// "when did I unlock this" UX.
export interface UnlockedRecord {
  id: string;
  unlockedAt: number;
}

// Profile-scoped: each profile earns its own achievements / freezes.
const PERSIST_KEY = profileKey("libre:achievements:unlocked");
const STREAK_FREEZES_KEY = profileKey("libre:achievements:freezes-used");

/// Snapshot the engine evaluates against. Built once per evaluation
/// from the live progress + streak state — cheaper than walking
/// `history` repeatedly inside each rule arm.
export interface ProgressSnapshot {
  history: readonly Completion[];
  courses: readonly Course[];
  /// Computed by `useStreakAndXp` — passed through so the engine
  /// doesn't recompute (and we trust the source of truth for these).
  streakDays: number;
  longestStreakDays: number;
  level: number;
  xp: number;
  /// Cumulative count of streak freezes the learner has used. Tracked
  /// independently in localStorage["libre:achievements:freezes-used"];
  /// the streak system increments it when a shield is consumed.
  freezesUsed: number;
}

/// Read the persisted unlock list. Returns [] for missing/corrupt
/// keys — never throws, never blocks rendering. The read happens at
/// hook mount and on each `storage` event for cross-tab sync.
export function readUnlocked(): UnlockedRecord[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is UnlockedRecord =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as UnlockedRecord).id === "string" &&
        typeof (r as UnlockedRecord).unlockedAt === "number",
    );
  } catch {
    return [];
  }
}

export function writeUnlocked(rows: readonly UnlockedRecord[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(rows));
  } catch {
    // Quota / private mode — silently skip. The engine still works
    // in-memory for the current session; persistence is a nice-to-
    // have, not a correctness requirement.
  }
}

export function readFreezesUsed(): number {
  if (typeof localStorage === "undefined") return 0;
  const raw = localStorage.getItem(STREAK_FREEZES_KEY);
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function bumpFreezesUsed(by = 1): number {
  const next = readFreezesUsed() + by;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STREAK_FREEZES_KEY, String(next));
  }
  return next;
}

// ─────────────────────────────────────────────────────────────────
// Derived metrics — computed once per evaluateAchievements() call.
// Each is independent; the build-all-at-once pattern is faster than
// each rule walking history on its own (especially for users with
// thousands of completions).
// ─────────────────────────────────────────────────────────────────

interface DerivedSnapshot {
  /// Map<lessonKind, count> over the entire history.
  kindCounts: Map<CountedLessonKind, number>;
  /// Set of YYYY-MM-DD strings — distinct calendar days the learner
  /// has any completion on. Used by both lessonsInDay and
  /// weekendDouble.
  daySet: Set<string>;
  /// Map<localDay, count> — used by lessonsInDay.
  perDayCount: Map<string, number>;
  /// Latest completion timestamp per courseId (ms, not s — we
  /// multiply on read). Used by `comeback` so the rule can answer
  /// "did the most recent completion in this course follow a >Nd gap?"
  latestPerCourse: Map<string, number>;
  /// Set of chapter keys (`courseId:chapterIdx`) whose every lesson
  /// has been completed. Cardinality is `chaptersDone`.
  chaptersDoneKeys: Set<string>;
  /// Set of courseIds whose every lesson has been completed.
  /// Cardinality is `booksDone`.
  booksDoneKeys: Set<string>;
  /// Set of courseIds with at least one completion. Cardinality is
  /// `booksTouched`.
  booksTouchedKeys: Set<string>;
  /// Set of language ids touched.
  languagesTouchedKeys: Set<string>;
  /// Sorted (asc) list of completions enriched with the course id +
  /// inferred lesson kind. Used for time-of-day rules + comeback +
  /// weekendDouble; sorting once up front keeps the rules linear.
  enriched: EnrichedCompletion[];
}

interface EnrichedCompletion extends Completion {
  /// Local-time date object materialised once.
  dt: Date;
  /// YYYY-MM-DD in local time.
  dayKey: string;
  /// Local hour (0-23).
  hour: number;
  /// 0 = Sunday, 6 = Saturday — local time.
  weekday: number;
  /// Lesson kind looked up from the courses tree. "unknown" if the
  /// lesson is no longer in the catalog (renamed / retired course
  /// id) — those don't contribute to kind-specific rules.
  lessonKind: CountedLessonKind | "unknown";
}

function deriveSnapshot(snap: ProgressSnapshot): DerivedSnapshot {
  // ── Lookup tables off the courses tree ──────────────────────
  const kindByKey = new Map<string, CountedLessonKind>();
  const lessonsPerCourse = new Map<string, number>();
  const lessonsPerChapter = new Map<string, number>();
  const courseLanguage = new Map<string, string>();
  for (const course of snap.courses) {
    courseLanguage.set(course.id, course.language);
    let courseLessons = 0;
    course.chapters.forEach((ch, chIdx) => {
      const chapterKey = `${course.id}:${chIdx}`;
      lessonsPerChapter.set(chapterKey, ch.lessons.length);
      courseLessons += ch.lessons.length;
      for (const l of ch.lessons) {
        // The Lesson union has `kind` as a discriminator, but the
        // runtime data may carry stray strings — narrow defensively.
        const k = (l as { kind?: string }).kind;
        if (
          k === "reading" ||
          k === "quiz" ||
          k === "exercise" ||
          k === "mixed"
        ) {
          kindByKey.set(`${course.id}:${l.id}`, k);
        }
      }
    });
    lessonsPerCourse.set(course.id, courseLessons);
  }

  // ── Walk history once ───────────────────────────────────────
  const kindCounts: Map<CountedLessonKind, number> = new Map([
    ["reading", 0],
    ["quiz", 0],
    ["exercise", 0],
    ["mixed", 0],
  ]);
  const daySet = new Set<string>();
  const perDayCount = new Map<string, number>();
  const latestPerCourse = new Map<string, number>();
  const completionsPerCourse = new Map<string, number>();
  const chapterCompletions = new Map<string, number>();
  const booksTouchedKeys = new Set<string>();
  const languagesTouchedKeys = new Set<string>();
  const enriched: EnrichedCompletion[] = [];

  // Build a chapterIdx-by-lesson lookup so we can attribute
  // completions to their owning chapter without re-walking course.
  const chapterByLesson = new Map<string, string>();
  for (const course of snap.courses) {
    course.chapters.forEach((ch, chIdx) => {
      for (const l of ch.lessons) {
        chapterByLesson.set(`${course.id}:${l.id}`, `${course.id}:${chIdx}`);
      }
    });
  }

  for (const c of snap.history) {
    const tsMs = c.completed_at * 1000;
    const dt = new Date(tsMs);
    const dayKey = localDayKey(dt);
    const hour = dt.getHours();
    const weekday = dt.getDay();
    const key = `${c.course_id}:${c.lesson_id}`;
    const lessonKind = kindByKey.get(key) ?? "unknown";

    enriched.push({
      ...c,
      dt,
      dayKey,
      hour,
      weekday,
      lessonKind,
    });
    if (lessonKind !== "unknown") {
      kindCounts.set(lessonKind, (kindCounts.get(lessonKind) ?? 0) + 1);
    }
    daySet.add(dayKey);
    perDayCount.set(dayKey, (perDayCount.get(dayKey) ?? 0) + 1);
    if ((latestPerCourse.get(c.course_id) ?? 0) < tsMs) {
      latestPerCourse.set(c.course_id, tsMs);
    }
    completionsPerCourse.set(
      c.course_id,
      (completionsPerCourse.get(c.course_id) ?? 0) + 1,
    );
    const chKey = chapterByLesson.get(key);
    if (chKey) {
      chapterCompletions.set(chKey, (chapterCompletions.get(chKey) ?? 0) + 1);
    }
    booksTouchedKeys.add(c.course_id);
    const lang = courseLanguage.get(c.course_id);
    if (lang) languagesTouchedKeys.add(lang);
  }

  enriched.sort((a, b) => a.completed_at - b.completed_at);

  // ── Collapse chapter / book completion sets ─────────────────
  const chaptersDoneKeys = new Set<string>();
  for (const [key, done] of chapterCompletions) {
    const total = lessonsPerChapter.get(key);
    if (total !== undefined && done >= total && total > 0) {
      chaptersDoneKeys.add(key);
    }
  }
  const booksDoneKeys = new Set<string>();
  for (const [courseId, done] of completionsPerCourse) {
    const total = lessonsPerCourse.get(courseId);
    if (total !== undefined && done >= total && total > 0) {
      booksDoneKeys.add(courseId);
    }
  }

  return {
    kindCounts,
    daySet,
    perDayCount,
    latestPerCourse,
    chaptersDoneKeys,
    booksDoneKeys,
    booksTouchedKeys,
    languagesTouchedKeys,
    enriched,
  };
}

function localDayKey(dt: Date): string {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ─────────────────────────────────────────────────────────────────
// Rule evaluation.
// ─────────────────────────────────────────────────────────────────

/// True when the rule's condition is satisfied by the snapshot.
/// One arm per AchievementRule kind — narrow with a `switch` on the
/// `kind` discriminator. Add a new arm here when extending the
/// AchievementRule union.
function isRuleSatisfied(
  rule: AchievementRule,
  snap: ProgressSnapshot,
  derived: DerivedSnapshot,
): boolean {
  switch (rule.kind) {
    case "lessonsTotal":
      return snap.history.length >= rule.count;

    case "lessonsKind":
      return (derived.kindCounts.get(rule.lessonKind) ?? 0) >= rule.count;

    case "chaptersDone":
      return derived.chaptersDoneKeys.size >= rule.count;

    case "booksDone":
      return derived.booksDoneKeys.size >= rule.count;

    case "streakDays":
      return snap.streakDays >= rule.count;

    case "longestStreakDays":
      return snap.longestStreakDays >= rule.count;

    case "level":
      return snap.level >= rule.count;

    case "xpTotal":
      return snap.xp >= rule.count;

    case "lessonsInDay": {
      // Any single calendar day with >= count completions wins.
      for (const n of derived.perDayCount.values()) {
        if (n >= rule.count) return true;
      }
      return false;
    }

    case "languagesTouched":
      return derived.languagesTouchedKeys.size >= rule.count;

    case "booksTouched":
      return derived.booksTouchedKeys.size >= rule.count;

    case "completionTime": {
      if ("before" in rule) {
        const limit = parseHHMM(rule.before);
        if (limit === null) return false;
        for (const e of derived.enriched) {
          if (e.hour * 60 + e.dt.getMinutes() < limit) return true;
        }
        return false;
      }
      // after / endBefore form: completion's HH:MM is in [after, endBefore)
      const start = parseHHMM(rule.after);
      const end = parseHHMM(rule.endBefore);
      if (start === null || end === null) return false;
      for (const e of derived.enriched) {
        const mins = e.hour * 60 + e.dt.getMinutes();
        if (mins >= start && mins < end) return true;
      }
      return false;
    }

    case "weekendDouble": {
      // Group completions by ISO-week key. If any week has both a
      // Sat (weekday 6) and a Sun (weekday 0) completion, unlock.
      const byWeek = new Map<string, { sat: boolean; sun: boolean }>();
      for (const e of derived.enriched) {
        const wk = isoWeekKey(e.dt);
        const seen = byWeek.get(wk) ?? { sat: false, sun: false };
        if (e.weekday === 6) seen.sat = true;
        if (e.weekday === 0) seen.sun = true;
        byWeek.set(wk, seen);
        if (seen.sat && seen.sun) return true;
      }
      return false;
    }

    case "comeback": {
      // For each course, look at consecutive completions in time
      // order; if any pair has gap > rule.days days, unlock.
      const gapMs = rule.days * 24 * 60 * 60 * 1000;
      const byCourse = new Map<string, number[]>();
      for (const e of derived.enriched) {
        const list = byCourse.get(e.course_id) ?? [];
        list.push(e.completed_at * 1000);
        byCourse.set(e.course_id, list);
      }
      for (const stamps of byCourse.values()) {
        for (let i = 1; i < stamps.length; i++) {
          if (stamps[i] - stamps[i - 1] > gapMs) return true;
        }
      }
      return false;
    }

    case "freezeUsed":
      return snap.freezesUsed >= rule.count;

    case "lessonsAfterHourCount": {
      // Count distinct days where at least one completion's hour is
      // in [hour, beforeHour). Two completions on the same day at
      // 02:30 and 04:30 count as ONE day toward the threshold.
      const days = new Set<string>();
      for (const e of derived.enriched) {
        if (e.hour >= rule.hour && e.hour < rule.beforeHour) {
          days.add(e.dayKey);
          if (days.size >= rule.count) return true;
        }
      }
      return false;
    }
  }
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number.parseInt(m[1], 10);
  const min = Number.parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/// ISO-week key: year-week, e.g. "2026-W19". Cheaper than building
/// a real Temporal — we just want a stable bucket per week.
function isoWeekKey(dt: Date): string {
  const tmp = new Date(
    Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()),
  );
  const dayNum = tmp.getUTCDay() || 7; // Mon = 1, Sun = 7
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((tmp.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────
// Engine entry points.
// ─────────────────────────────────────────────────────────────────

export interface EvaluateResult {
  /// All achievement ids the snapshot satisfies, including those
  /// already persisted as unlocked. The `useAchievements` hook diffs
  /// this against the persisted set to surface "newly unlocked" ids.
  satisfied: Set<string>;
}

/// Walk every active achievement, return the set of satisfied ids.
/// Pure-functional; safe to call from a useMemo or an effect.
export function evaluateAchievements(snap: ProgressSnapshot): EvaluateResult {
  const derived = deriveSnapshot(snap);
  const satisfied = new Set<string>();
  for (const a of ACHIEVEMENTS) {
    if (a.retired) continue;
    if (isRuleSatisfied(a.trigger, snap, derived)) {
      satisfied.add(a.id);
    }
  }
  return { satisfied };
}

/// Detect achievements that flipped to satisfied compared to the
/// persisted unlocks. Returns the Achievement objects (already
/// resolved from the registry) in tier-priority order — bronze
/// first, platinum last — so the toast queue plays them in
/// crescendo. Any id missing from the registry is dropped silently
/// (covers the "client running an older bundle than the persisted
/// list" edge case).
export function diffUnlocks(
  satisfied: Set<string>,
  persisted: readonly UnlockedRecord[],
): Achievement[] {
  const persistedIds = new Set(persisted.map((r) => r.id));
  const fresh: Achievement[] = [];
  for (const id of satisfied) {
    if (persistedIds.has(id)) continue;
    const a = getAchievement(id);
    if (a) fresh.push(a);
  }
  // Tier ascending so visual presentation crescendos.
  const tierRank: Record<string, number> = {
    bronze: 0,
    silver: 1,
    gold: 2,
    platinum: 3,
  };
  fresh.sort((a, b) => tierRank[a.tier] - tierRank[b.tier]);
  return fresh;
}

/// Persist new unlocks. Idempotent — replays don't duplicate rows.
/// Returns the merged record list so callers don't have to re-read.
export function recordUnlocks(
  freshly: readonly Achievement[],
  unlockedAt: number,
  prior: readonly UnlockedRecord[] = readUnlocked(),
): UnlockedRecord[] {
  if (freshly.length === 0) return [...prior];
  const seen = new Set(prior.map((r) => r.id));
  const merged = [...prior];
  for (const a of freshly) {
    if (seen.has(a.id)) continue;
    merged.push({ id: a.id, unlockedAt });
    seen.add(a.id);
  }
  writeUnlocked(merged);
  return merged;
}
