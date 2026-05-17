/// Per-card practice history + spaced-repetition scheduling.
///
/// Lives in localStorage rather than the SQLite/IndexedDB backends
/// because:
///   1. The data is per-device drilling state, not progress that
///      needs cross-device sync. (If a learner drills 50 cards on
///      their phone, then opens the desktop, we don't want to
///      claim those cards as "solved" there.)
///   2. The schema is small — one entry per attempted card — and
///      reads cluster by card id, which localStorage handles fine
///      at our card volume (<3k cards × small attempt history per
///      card).
///   3. Avoids a Rust migration / IndexedDB version bump for a
///      v1 feature we'll likely iterate on.
///
/// If we later want sync, swap the backend without changing the
/// hook's surface — the schema is already stable.

import { useCallback, useEffect, useState } from "react";
import { profileKey } from "../lib/profileStore";

const STORAGE_KEY = profileKey("libre-practice-history-v1");

/// Tracks per-card attempt history + computes the next-due date
/// using a tiny Anki-flavoured schedule.
export interface PracticeHistory {
  /// Most recent attempt per card, keyed by card id.
  byCard: Record<string, CardState>;
  /// Append an attempt result. Computes the new schedule and
  /// persists.
  log(cardId: string, correct: boolean): void;
  /// Cards due now, given the full deck. Sorted by oldest-due first.
  /// `pool` is the candidate list — usually all available cards;
  /// the function filters to those due today (or never attempted).
  dueCards<T extends { card: { id: string } }>(pool: T[]): T[];
  /// Build a recommended Daily session of N cards: due-cards first,
  /// then unattempted cards (concept gaps), then reinforce-most-
  /// recently-correct.
  dailyDeck<T extends { card: { id: string } }>(pool: T[], size: number): T[];
}

export interface CardState {
  /// Last attempt's correctness. Drives the next-due computation
  /// (a hit lengthens the interval; a miss shortens it).
  lastCorrect: boolean;
  /// Epoch seconds of the most-recent attempt.
  lastAt: number;
  /// Streak of consecutive correct attempts. Resets to 0 on miss.
  /// Drives the SM-2-ish interval-doubling.
  streak: number;
  /// Next-due epoch seconds. The card is "due" when now >= dueAt.
  dueAt: number;
  /// Total attempts ever (informational; surfaced in profile stats).
  attempts: number;
  /// Total correct attempts (for hit-rate display).
  correctCount: number;
}

/// Interval ladder for the next-due computation. Streak index N is
/// applied to a correct answer that lands the learner at streak N.
/// Picked to feel quick on the early reps and stretch out at the
/// retention end of the curve.
///
///   streak 1: due in 10 minutes
///   streak 2: due in 1 hour
///   streak 3: due in 1 day
///   streak 4: due in 3 days
///   streak 5: due in 7 days
///   streak 6: due in 14 days
///   streak 7: due in 30 days
///   streak 8+: due in 60 days
///
/// On a miss we reset streak to 0 and re-due in 5 minutes — same
/// "fresh card" treatment as a never-seen card.
const HIT_INTERVALS_SECONDS = [
  10 * 60, // streak 1
  60 * 60, // streak 2
  24 * 60 * 60, // streak 3
  3 * 24 * 60 * 60, // streak 4
  7 * 24 * 60 * 60, // streak 5
  14 * 24 * 60 * 60, // streak 6
  30 * 24 * 60 * 60, // streak 7
];
const HIT_INTERVAL_MAX = 60 * 24 * 60 * 60; // 60 days
const MISS_INTERVAL_SECONDS = 5 * 60; // 5 min

function intervalForStreak(streak: number): number {
  if (streak <= 0) return MISS_INTERVAL_SECONDS;
  const idx = streak - 1;
  if (idx < HIT_INTERVALS_SECONDS.length) return HIT_INTERVALS_SECONDS[idx];
  return HIT_INTERVAL_MAX;
}

function loadFromStorage(): Record<string, CardState> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
    return {};
  } catch {
    return {};
  }
}

function saveToStorage(byCard: Record<string, CardState>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(byCard));
  } catch {
    // Quota exceeded or private mode — fail silently. The Practice
    // tab still works; the schedule just resets per-session.
  }
}

export function usePracticeHistory(): PracticeHistory {
  const [byCard, setByCard] = useState<Record<string, CardState>>(() =>
    loadFromStorage(),
  );

  // Persist on every change. Cheap enough at our volume that we
  // don't need a debounce.
  useEffect(() => {
    saveToStorage(byCard);
  }, [byCard]);

  const log = useCallback((cardId: string, correct: boolean) => {
    setByCard((prev) => {
      const now = Math.floor(Date.now() / 1000);
      const existing = prev[cardId];
      const streak = correct ? (existing?.streak ?? 0) + 1 : 0;
      const dueAt = now + intervalForStreak(streak);
      const next: CardState = {
        lastCorrect: correct,
        lastAt: now,
        streak,
        dueAt,
        attempts: (existing?.attempts ?? 0) + 1,
        correctCount: (existing?.correctCount ?? 0) + (correct ? 1 : 0),
      };
      return { ...prev, [cardId]: next };
    });
  }, []);

  const dueCards = useCallback(
    <T extends { card: { id: string } }>(pool: T[]): T[] => {
      const now = Math.floor(Date.now() / 1000);
      return pool
        .filter((entry) => {
          const state = byCard[entry.card.id];
          if (!state) return true; // never attempted = due
          return now >= state.dueAt;
        })
        .sort((a, b) => {
          const sa = byCard[a.card.id];
          const sb = byCard[b.card.id];
          // Never-attempted first (highest priority for new content).
          if (!sa && !sb) return 0;
          if (!sa) return -1;
          if (!sb) return 1;
          // Then by oldest-due-first.
          return sa.dueAt - sb.dueAt;
        });
    },
    [byCard],
  );

  const dailyDeck = useCallback(
    <T extends { card: { id: string } }>(pool: T[], size: number): T[] => {
      // Build the deck in three layers:
      //   1. Cards due now (ranked by oldest-due first).
      //   2. Cards never attempted (concept gaps the learner hasn't
      //      seen yet). Shuffled so the same set of unattempted
      //      cards doesn't always lead.
      //   3. Cards seen recently AND correctly — gentle reinforcement
      //      of stuff the learner just nailed.
      // We fill in priority order until we hit `size`.
      const now = Math.floor(Date.now() / 1000);
      const due: T[] = [];
      const unattempted: T[] = [];
      const reinforce: T[] = [];
      for (const entry of pool) {
        const state = byCard[entry.card.id];
        if (!state) {
          unattempted.push(entry);
          continue;
        }
        if (now >= state.dueAt) {
          due.push(entry);
        } else if (state.lastCorrect) {
          reinforce.push(entry);
        }
        // Cards in cooldown after a miss aren't included — the
        // miss-due is short (5 min) so they'll resurface in the
        // due bucket on the next session.
      }
      // Sort due by oldest first.
      due.sort((a, b) => {
        const sa = byCard[a.card.id]!;
        const sb = byCard[b.card.id]!;
        return sa.dueAt - sb.dueAt;
      });
      // Shuffle the unattempted + reinforce buckets so the daily
      // deck doesn't read as alphabetical.
      shuffle(unattempted);
      shuffle(reinforce);
      // Reinforce: take the most-recently-correct first.
      reinforce.sort((a, b) => {
        const sa = byCard[a.card.id]!;
        const sb = byCard[b.card.id]!;
        return sb.lastAt - sa.lastAt;
      });
      const out: T[] = [];
      const targetUnattempted = Math.ceil(size * 0.4);
      const targetDue = Math.ceil(size * 0.4);
      // 1. Due cards (up to 40% of size, but greedy if more are
      //    available and unattempted is short).
      for (const x of due) {
        if (out.length >= targetDue) break;
        out.push(x);
      }
      // 2. Unattempted cards.
      for (const x of unattempted) {
        if (out.length >= targetDue + targetUnattempted) break;
        out.push(x);
      }
      // 3. Top off with reinforce, then any remaining due / unattempted.
      const remaining: T[] = [
        ...reinforce,
        ...due.slice(out.filter((o) => due.includes(o)).length),
        ...unattempted.slice(out.filter((o) => unattempted.includes(o)).length),
      ];
      for (const x of remaining) {
        if (out.length >= size) break;
        if (out.includes(x)) continue;
        out.push(x);
      }
      return out;
    },
    [byCard],
  );

  return { byCard, log, dueCards, dailyDeck };
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
