import { useEffect, useState } from "react";
import { Icon } from "@base/primitives/icon";
import { arrowLeft } from "@base/primitives/icon/icons/arrow-left";
import { arrowRight } from "@base/primitives/icon/icons/arrow-right";
import "@base/primitives/icon/icon.css";
import { ShortcutHint } from "../ShortcutHint/ShortcutHint";
import { useT } from "../../i18n/i18n";
import "./LessonNav.css";

interface NeighborLesson {
  id: string;
  title: string;
}

interface Props {
  prev: NeighborLesson | null;
  next: NeighborLesson | null;
  onPrev: () => void;
  onNext: () => void;
  /// Customize the next-button label. For reading-only lessons that aren't yet
  /// marked complete, this becomes something like "Mark read & next →" so the
  /// single button handles both actions.
  nextLabel?: string;
  /// When true, the Next button gets the holographic CTA treatment —
  /// reserved for the "mark read & next" variant on reading-only
  /// lessons that the learner is about to complete by clicking. The
  /// holo overlay reads as "this is the moment, take the action."
  /// Defaults false.
  nextIsCta?: boolean;
  /// Timestamp (ms since epoch) at which an auto-advance is scheduled
  /// to fire, or null when none is pending. When non-null the Next
  /// button paints a circular 3..2..1 countdown ring + digit overlay
  /// that animates until the timer reaches zero — visual confirmation
  /// of "you're about to be moved forward, click anywhere to stop me."
  /// Notion issue #9180e1cfc9e068a8.
  autoAdvanceFireAt?: number | null;
}

/// CSS `text-overflow: ellipsis` only trims at the end, which on a lesson
/// title like "Constructors and the new Keyword" hides the most useful bit —
/// the concept name. Split on the last word (or fall back to character count)
/// so the head can flex-shrink while the tail always stays visible, giving us
/// middle-ellipsis: "Constructors a… Keyword".
function splitForMiddleEllipsis(
  text: string | null | undefined,
): { head: string; tail: string } {
  // Defensive: `text` is typed `string`, but it's fed runtime data
  // (`neighbors.prev/next.title` ← `findNeighbors` ← course JSON).
  // A malformed / partially-seeded course can carry a lesson with
  // no title, which made this `text.length` throw "undefined is
  // not an object" and crashed the whole lesson view on open.
  // Coerce to a safe string instead of trusting the type.
  if (typeof text !== "string" || text.length === 0) {
    return { head: text ?? "", tail: "" };
  }
  const minTail = 4;
  const maxTail = 16;
  for (let i = text.length - minTail; i >= Math.max(1, text.length - maxTail); i--) {
    const ch = text[i];
    if (ch === " " || ch === "-" || ch === "/" || ch === ":") {
      return { head: text.slice(0, i), tail: text.slice(i) };
    }
  }
  const n = Math.min(8, Math.floor(text.length / 3));
  if (n <= 0) return { head: text, tail: "" };
  return { head: text.slice(0, -n), tail: text.slice(-n) };
}

function MiddleTitle({ text }: { text: string | null | undefined }) {
  const safe = typeof text === "string" ? text : "";
  const { head, tail } = splitForMiddleEllipsis(safe);
  return (
    <span className="libre-lesson-nav-title" title={safe}>
      <span className="libre-lesson-nav-title-head">{head}</span>
      {tail && <span className="libre-lesson-nav-title-tail">{tail}</span>}
    </span>
  );
}

/// Total auto-advance duration in ms. Mirrors the `setTimeout` delay
/// in App.tsx's `markCompletedAndCelebrate` — bumped to 3000ms when
/// the countdown ring was introduced so the 3..2..1 sequence has
/// room to read. If App's delay changes, this constant must change
/// in lockstep or the ring will end before / after the actual fire.
const AUTO_ADVANCE_DURATION_MS = 3000;

/// Countdown overlay rendered on top of the Next button while an
/// auto-advance is pending. Polls `Date.now()` at requestAnimationFrame
/// cadence (~60fps) so the ring sweeps smoothly from a full
/// circle to empty. Self-contained — owns its own RAF loop, fires
/// `onZero` exactly once when the timer reaches 0, and tears itself
/// down on unmount.
function AutoAdvanceRing({ fireAt }: { fireAt: number }) {
  // Remaining ms as a continuous value so the ring animates smoothly.
  // The visible digit (3 / 2 / 1) is derived from this — Math.ceil
  // so the first frame shows "3" rather than "2" (3000ms ÷ 1000 =
  // exactly 3, which floors to 3 but ceils to 3 too; 2999ms ÷ 1000
  // would floor to 2 but we want "3" until we've actually crossed
  // the 2000ms boundary).
  const [remainingMs, setRemainingMs] = useState(() =>
    Math.max(0, fireAt - Date.now()),
  );
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const r = Math.max(0, fireAt - Date.now());
      setRemainingMs(r);
      if (r > 0) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [fireAt]);
  // Ring fill: full circle at start (remaining = duration), empty
  // circle when remaining = 0. Stroke-dashoffset is the difference
  // between the full circumference and the proportion remaining.
  const radius = 11;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.max(0, Math.min(1, remainingMs / AUTO_ADVANCE_DURATION_MS));
  const offset = circumference * (1 - progress);
  // Digit display: 3..2..1, rounded up so the digit ticks down at
  // each whole-second boundary instead of skipping.
  const digit = Math.max(1, Math.ceil(remainingMs / 1000));
  return (
    <span className="libre-lesson-nav-countdown" aria-hidden>
      <svg
        className="libre-lesson-nav-countdown-ring"
        viewBox="0 0 28 28"
        width="28"
        height="28"
      >
        <circle
          className="libre-lesson-nav-countdown-track"
          cx="14"
          cy="14"
          r={radius}
          fill="none"
        />
        <circle
          className="libre-lesson-nav-countdown-fill"
          cx="14"
          cy="14"
          r={radius}
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <span className="libre-lesson-nav-countdown-digit">{digit}</span>
    </span>
  );
}

/// Prev/Next bar that sits at the end of every lesson. Mirrors Codecademy's
/// linear progression feel — users can advance through a course without
/// opening the sidebar for every step, and reading-only lessons get marked
/// complete as part of pressing Next (see `nextLabel`).
export default function LessonNav({
  prev,
  next,
  onPrev,
  onNext,
  nextLabel,
  nextIsCta = false,
  autoAdvanceFireAt = null,
}: Props) {
  const t = useT();
  // Only paint the countdown when there's an actual pending fire-at
  // AND it's in the future. A `fireAt` in the past would render a
  // negative digit / under-filled ring — guard here so the visual
  // never glitches if App's clearPendingAutoAdvance hasn't propagated
  // yet.
  const showCountdown =
    autoAdvanceFireAt !== null && autoAdvanceFireAt > Date.now();
  return (
    <nav className="libre-lesson-nav" aria-label={t("lessonNav.ariaLabel")}>
      <button
        type="button"
        className="libre-lesson-nav-btn libre-lesson-nav-btn--prev"
        onClick={onPrev}
        disabled={!prev}
        title={prev?.title}
      >
        <span className="libre-lesson-nav-arrow" aria-hidden>
          <Icon icon={arrowLeft} size="sm" color="currentColor" />
        </span>
        <span className="libre-lesson-nav-text">
          <span className="libre-lesson-nav-label">
            {t("lessonNav.previous")}
            {prev && <ShortcutHint actionId="lesson.prev" variant="muted" className="libre-shortcut-hint--gap" />}
          </span>
          {prev && <MiddleTitle text={prev.title} />}
        </span>
      </button>

      <button
        type="button"
        className={
          "libre-lesson-nav-btn libre-lesson-nav-btn--next " +
          (nextIsCta ? "libre-lesson-nav-btn--cta " : "") +
          (showCountdown ? "libre-lesson-nav-btn--counting" : "")
        }
        onClick={onNext}
        disabled={!next}
        title={next?.title}
      >
        {/* Holographic foil retired — the rainbow snake-sparkle
            treatment is now scoped to certificates + the AI
            button so the Next CTA reads as a quiet flat surface. */}
        <span className="libre-lesson-nav-text libre-lesson-nav-text--right">
          <span className="libre-lesson-nav-label">
            {nextLabel ?? t("lessonNav.next")}
            {next && <ShortcutHint actionId="lesson.next" variant="muted" className="libre-shortcut-hint--gap" />}
          </span>
          {next && <MiddleTitle text={next.title} />}
        </span>
        <span className="libre-lesson-nav-arrow" aria-hidden>
          {showCountdown && autoAdvanceFireAt !== null ? (
            <AutoAdvanceRing fireAt={autoAdvanceFireAt} />
          ) : (
            <Icon icon={arrowRight} size="sm" color="currentColor" />
          )}
        </span>
      </button>
    </nav>
  );
}
