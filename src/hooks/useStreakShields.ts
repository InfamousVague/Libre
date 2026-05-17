/// Streak shield ("freeze") tracking. A learner gets N shields per
/// ISO week; spending one freezes a single calendar day, and the
/// streak engine treats that frozen day as a phantom completion when
/// computing the current run. When all shields for the week are
/// gone, missed days break the streak normally.
///
/// Two pieces of state live here:
///
///   1. **Per-week budget** (`fb:streak-shields:v1`):
///      `{ weekKey: "YYYY-Www", used: number }`. Resets at the top
///      of every ISO week — we lazily compare the stored weekKey on
///      read instead of running a scheduled job.
///
///   2. **Frozen-days log** (`fb:streak-frozen-days:v1`):
///      `string[]` of `YYYY-MM-DD` keys. Persists forever so the
///      streak can be reconstructed from history alone, week after
///      week. Independent from the budget — once a day is frozen
///      it stays frozen even after the week's budget resets.
///
/// Why this exists:
///   - The base streak rule (`computeStreaks` in useStreakAndXp)
///     only allows a 1-day grace ("alive if today OR yesterday").
///     That punishes one bad day even from years-deep streaks.
///     Duolingo / Boot.dev / Brilliant all ship a freeze affordance
///     — it dramatically reduces churn from one missed day.
///   - Per-week budget rather than ever-renewable so the freeze is
///     a scarce resource the learner manages, not a free pass that
///     turns the streak into a participation trophy.

import { useCallback, useEffect, useState } from "react";
import { profileKey } from "../lib/profileStore";

// Profile-scoped streak shields + frozen-day registry.
const SHIELDS_KEY = profileKey("libre:streak-shields:v1");
const FROZEN_DAYS_KEY = profileKey("libre:streak-frozen-days:v1");
/// Shields refreshed at the top of every ISO week. Two is Duolingo's
/// default — enough to cover the common "missed Tuesday and slept
/// through Thursday" case without making streaks feel free.
export const SHIELDS_PER_WEEK = 2;

interface StoredBudget {
  weekKey: string;
  used: number;
}

/// ISO-week key in the user's local time. Format `YYYY-Www` (e.g.
/// `2026-W18`). Keeping it local (rather than UTC) means the
/// "did I practice this week" perception aligns with the calendar
/// the learner sees on their phone / desktop clock.
export function isoWeekKey(d: Date = new Date()): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  // Set to nearest Thursday: current date + 4 - current day number
  // (ISO weeks: Mon=1..Sun=7, treat Sunday as 7).
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

/// Local-time YYYY-MM-DD key. Same shape useStreakAndXp's localDayKey
/// emits, exposed here so consumers (the stats popover, the streak
/// engine) compute matching keys without re-implementing the format.
export function localDayKey(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function readBudget(): StoredBudget | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(SHIELDS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredBudget;
    if (
      !parsed ||
      typeof parsed.weekKey !== "string" ||
      typeof parsed.used !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeBudget(s: StoredBudget): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SHIELDS_KEY, JSON.stringify(s));
  } catch {
    /* quota / private mode — fine */
  }
}

function readFrozenDays(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(FROZEN_DAYS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function writeFrozenDays(days: string[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(FROZEN_DAYS_KEY, JSON.stringify(days));
  } catch {
    /* ignore */
  }
}

export interface StreakShieldsState {
  /// How many shields the learner has left in the current ISO week.
  /// Always between 0 and `SHIELDS_PER_WEEK`.
  available: number;
  /// Total shields per week. Surfaced so consumers can render
  /// "X of Y used" without re-importing the constant.
  perWeek: number;
  /// Set of calendar days the learner has frozen. The streak engine
  /// reads this and treats each entry as a phantom completion when
  /// computing the current run.
  frozenDays: Set<string>;
  /// Freeze a specific calendar day (YYYY-MM-DD, local time).
  /// Consumes one shield from the current week's budget. No-op when
  /// `available === 0` or when the day is already frozen. Returns
  /// true on success, false otherwise.
  freezeDay: (dayKey: string) => boolean;
  /// ISO-week key the budget refers to.
  weekKey: string;
}

export function useStreakShields(): StreakShieldsState {
  const weekKey = isoWeekKey();
  const [used, setUsed] = useState<number>(() => {
    const stored = readBudget();
    if (!stored) return 0;
    if (stored.weekKey !== weekKey) return 0;
    return Math.min(stored.used, SHIELDS_PER_WEEK);
  });
  const [frozenDays, setFrozenDays] = useState<Set<string>>(
    () => new Set(readFrozenDays()),
  );

  // Re-sync if the week key changes mid-session (an app left open
  // overnight on a Sunday/Monday boundary). Cheap effect — runs only
  // when the parent re-renders after the day rolls.
  useEffect(() => {
    const stored = readBudget();
    if (!stored || stored.weekKey === weekKey) return;
    setUsed(0);
    writeBudget({ weekKey, used: 0 });
  }, [weekKey]);

  const freezeDay = useCallback(
    (dayKey: string): boolean => {
      let didFreeze = false;
      setUsed((prevUsed) => {
        if (prevUsed >= SHIELDS_PER_WEEK) return prevUsed;
        // Skip if the day is already in the frozen set — wasting a
        // shield on a no-op would feel terrible.
        if (frozenDays.has(dayKey)) return prevUsed;
        didFreeze = true;
        const next = prevUsed + 1;
        writeBudget({ weekKey, used: next });
        return next;
      });
      if (didFreeze) {
        setFrozenDays((prev) => {
          if (prev.has(dayKey)) return prev;
          const next = new Set(prev);
          next.add(dayKey);
          writeFrozenDays(Array.from(next));
          return next;
        });
      }
      return didFreeze;
    },
    [weekKey, frozenDays],
  );

  return {
    available: Math.max(0, SHIELDS_PER_WEEK - used),
    perWeek: SHIELDS_PER_WEEK,
    frozenDays,
    freezeDay,
    weekKey,
  };
}
