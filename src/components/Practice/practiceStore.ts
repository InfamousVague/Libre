/// localStorage-backed store for `PracticeRecord` state.
///
/// Why localStorage instead of the existing `storage` (SQLite /
/// IndexedDB) abstraction: practice state is per-device review
/// metadata, not user-facing content. Trying to round-trip it
/// through the `storage` layer would require a schema migration
/// AND a Tauri command pair, which is overkill for a client-only
/// derivable signal. localStorage is synchronous, zero-config,
/// and survives reloads — exactly what the session runner needs.
///
/// The store exposes a small mutable singleton with three pieces:
///
///   1. `loadAllRecords()` — eager read of every record, returned
///      as a Map keyed by item id. Reads from localStorage once
///      per call (no in-memory cache; the calling React state
///      owns the latest snapshot).
///
///   2. `gradeAttempt(item, correct)` — read the prior record,
///      run the SM-2 scheduler, write back. Returns the new
///      record so the caller can update its UI without re-reading.
///
///   3. `summariseStats(items, records)` — derive `PracticeStats`
///      from a freshly-harvested item list + record map. Pure;
///      no IO. Lives here because the daily-counter math
///      depends on the shape both sides agree on.
///
/// All keys are namespaced under `libre:practice:` so a
/// future reset / migration can wipe the whole namespace cleanly.

import type { PracticeItem, PracticeRecord, PracticeStats } from "./types";
import { difficultyBoost, gradeAttempt as runScheduler } from "./practiceSchedule";
import { profileKey } from "../../lib/profileStore";

// Profile-scoped: each profile has its own SRS schedule + records.
const STORAGE_KEY = profileKey("libre:practice:records:v1");

/// Today's attempts log. Stored separately from records so we
/// don't have to walk every record to count today's attempts.
/// Shape: { dayKey: "YYYY-MM-DD", attempts: n, correct: n }.
const TODAY_KEY = profileKey("libre:practice:today:v1");

interface TodayCounter {
  dayKey: string;
  attempts: number;
  correct: number;
}

function localDayKey(now: number): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/// Load every record. Returns an empty Map when localStorage is
/// missing or the payload is corrupt — review state is best-effort,
/// never load-bearing.
export function loadAllRecords(): Map<string, PracticeRecord> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return new Map();
    const out = new Map<string, PracticeRecord>();
    for (const [id, rec] of Object.entries(parsed)) {
      if (looksLikeRecord(rec)) out.set(id, rec as PracticeRecord);
    }
    return out;
  } catch {
    return new Map();
  }
}

function looksLikeRecord(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.lastSeen === "number" &&
    typeof r.attempts === "number" &&
    typeof r.correct === "number" &&
    typeof r.ease === "number" &&
    typeof r.intervalMs === "number" &&
    typeof r.dueAt === "number"
  );
}

function saveAllRecords(records: Map<string, PracticeRecord>): void {
  try {
    const obj: Record<string, PracticeRecord> = {};
    records.forEach((rec, id) => {
      obj[id] = rec;
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    /* localStorage full / private mode — drop the write */
  }
}

function loadToday(now: number): TodayCounter {
  const fallback: TodayCounter = {
    dayKey: localDayKey(now),
    attempts: 0,
    correct: 0,
  };
  try {
    const raw = localStorage.getItem(TODAY_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.dayKey === "string" &&
      typeof parsed.attempts === "number" &&
      typeof parsed.correct === "number"
    ) {
      const today = localDayKey(now);
      // If yesterday's counter is still in storage, reset it so
      // the daily-target ring starts at zero on the new day.
      if (parsed.dayKey !== today) return fallback;
      return parsed as TodayCounter;
    }
  } catch {
    /* fall through */
  }
  return fallback;
}

function saveToday(counter: TodayCounter): void {
  try {
    localStorage.setItem(TODAY_KEY, JSON.stringify(counter));
  } catch {
    /* drop */
  }
}

/// Grade one attempt and persist. Returns the freshly-computed
/// record so the caller can update its UI without re-loading the
/// whole map. Also bumps today's counter.
export function gradeAttempt(
  item: PracticeItem,
  correct: boolean,
  now: number = Date.now(),
): PracticeRecord {
  const records = loadAllRecords();
  const prior = records.get(item.id) ?? null;
  const next = runScheduler(
    prior,
    item.id,
    correct,
    now,
    difficultyBoost(item.difficulty),
  );
  records.set(item.id, next);
  saveAllRecords(records);

  const today = loadToday(now);
  today.attempts += 1;
  if (correct) today.correct += 1;
  saveToday(today);

  // Notify any open practice surfaces (the view header in
  // particular) to re-read stats. We use a custom DOM event
  // because PracticeView and PracticeSession are sibling routes
  // that don't share React context.
  try {
    window.dispatchEvent(
      new CustomEvent("libre:practice-graded", {
        detail: { id: item.id, correct },
      }),
    );
  } catch {
    /* SSR / non-DOM — drop */
  }

  return next;
}

/// Wipe every record. Used by Settings → Reset progress (we want
/// review state to clear with progress so a "start over" actually
/// starts over). Also clears today's counter.
export function resetPracticeState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(TODAY_KEY);
    window.dispatchEvent(new CustomEvent("libre:practice-graded"));
  } catch {
    /* drop */
  }
}

/// Pure stats summary over a freshly-harvested item list and a
/// record map. The view header passes BOTH so the result is
/// stable across a re-render that only changes one of them.
export function summariseStats(
  items: readonly PracticeItem[],
  records: ReadonlyMap<string, PracticeRecord>,
  now: number = Date.now(),
): PracticeStats {
  const today = loadToday(now);
  let totalSeen = 0;
  let dueCount = 0;
  let weakCount = 0;
  for (const item of items) {
    const rec = records.get(item.id);
    if (!rec) continue;
    totalSeen += 1;
    if (rec.dueAt <= now) dueCount += 1;
    if (rec.attempts >= 2 && rec.correct / rec.attempts < 0.6) weakCount += 1;
  }
  return {
    totalSeen,
    dueCount,
    weakCount,
    attemptsToday: today.attempts,
    correctToday: today.correct,
  };
}
