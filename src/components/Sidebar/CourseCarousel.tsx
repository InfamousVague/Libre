import { useLayoutEffect, useMemo, useRef } from "react";
import type { Course } from "../../data/types";
import { useCourseCover } from "../../hooks/useCourseCover";
import { carouselGlyph, courseProgress } from "./labels";
import { useT } from "../../i18n/i18n";

/// FLIP animation constants. Must stay in sync with
/// `.libre__carousel-item` width (74) and `.libre__carousel-scroll`
/// gap (10) in Sidebar.css. We hardcode rather than measuring at runtime
/// because the values are stable and per-render DOM reads are wasted work.
const CAROUSEL_CARD_WIDTH_PX = 74;
const CAROUSEL_CARD_GAP_PX = 10;
const CAROUSEL_CARD_STEP_PX = CAROUSEL_CARD_WIDTH_PX + CAROUSEL_CARD_GAP_PX;
const CAROUSEL_SLIDE_MS = 350;

/// Horizontal-scrolling thumbnail row in the sidebar header. Ordered by
/// last-opened timestamp (see `useRecentCourses`) so the course the
/// learner was just in lands at the left edge — regardless of whether
/// they completed a lesson in it. Courses with no open-timestamp fall
/// to the right in their natural array order. Hidden when there are
/// < 2 courses — switching is pointless.
///
/// Reorder behaviour uses FLIP animation: when a click bumps a book to
/// the front, the user sees the book GLIDE from its old slot to slot 0
/// rather than teleporting. Neighbours also slide down by one to fill
/// the hole. Feels like a real reshuffle instead of a jarring jump.
export default function CourseCarousel({
  courses,
  recents,
  completed,
  onSelectCourse,
  onContextMenu,
}: {
  courses: Course[];
  recents: Record<string, number>;
  /// Lesson completion set (keys: `${courseId}:${lessonId}`). Used to
  /// draw a per-cover progress strip so the carousel gives at-a-glance
  /// "how far am I in each book" signal.
  completed: Set<string>;
  onSelectCourse: (courseId: string) => void;
  onContextMenu?: (course: Course, e: React.MouseEvent) => void;
}) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  /// Each course's index at the END of the previous render. We compare
  /// against the current sort to figure out which cards moved and by
  /// how many slots — that delta drives the invert-translate step of
  /// the FLIP animation.
  const prevIndicesRef = useRef<Map<string, number>>(new Map());

  const sorted = useMemo(() => {
    // Only courses the learner has actually opened (have a recents
    // entry). Discovery happens on the Library page now — the sidebar
    // carousel is "jump back to where you were", not "browse what
    // exists". Without this filter a fresh install would dump all 24
    // bundled courses into the carousel and bury the one or two the
    // learner is actually working on.
    return courses
      .filter((c) => recents[c.id] !== undefined)
      .sort((a, b) => (recents[b.id] ?? 0) - (recents[a.id] ?? 0));
  }, [courses, recents]);

  useLayoutEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    // Build the new index map fresh each render so we can compare to
    // the stashed previous map. Using a Map (not a Record) because
    // forEach over entries is cleaner and reads better in the loops
    // below.
    const newIndices = new Map<string, number>();
    sorted.forEach((c, i) => newIndices.set(c.id, i));

    const prev = prevIndicesRef.current;
    prevIndicesRef.current = newIndices;

    // First render: nothing to animate from. Also skips the case where
    // the carousel mounted with < 2 courses and is only now crossing
    // the threshold — we'd rather the row appear in place than have
    // a multi-card cascade of slides on first show.
    if (prev.size === 0) return;

    // Invert step: any card whose index changed gets an inline
    // translateX that puts it BACK at its old visual position. We
    // collect them into an array so the subsequent play step doesn't
    // have to re-query the DOM.
    const animating: HTMLElement[] = [];
    for (const [id, newIdx] of newIndices) {
      const prevIdx = prev.get(id);
      if (prevIdx === undefined || prevIdx === newIdx) continue;
      const el = scrollEl.querySelector<HTMLElement>(
        `[data-course-id="${CSS.escape(id)}"]`,
      );
      if (!el) continue;
      const deltaX = (prevIdx - newIdx) * CAROUSEL_CARD_STEP_PX;
      el.style.transition = "none";
      el.style.transform = `translateX(${deltaX}px)`;
      animating.push(el);
    }

    if (animating.length === 0) return;

    // Force a synchronous layout so the browser commits the invert
    // transforms before we queue the play. Without this, some browsers
    // will batch the two style changes and skip straight to identity.
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    scrollEl.offsetWidth;

    // Play step: on the next frame, enable the transition and clear
    // the inline transform so each card animates from its old position
    // (invert) back to identity (its new slot).
    const rafId = requestAnimationFrame(() => {
      for (const el of animating) {
        el.style.transition = `transform ${CAROUSEL_SLIDE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
        el.style.transform = "";
      }
    });

    // Once the slide finishes, release the inline `transition` so the
    // base CSS transition (0.18s on hover scale) takes over again.
    // Small buffer on the timeout so we don't cut off the last frame.
    const cleanupId = window.setTimeout(() => {
      for (const el of animating) {
        el.style.transition = "";
      }
    }, CAROUSEL_SLIDE_MS + 50);

    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(cleanupId);
    };
  }, [sorted]);

  if (sorted.length < 2) return null;

  return (
    <div className="libre__carousel" aria-label={t("sidebar.ariaCarousel")}>
      <div className="libre__carousel-scroll" ref={scrollRef}>
        {sorted.map((c) => (
          <CarouselItem
            key={c.id}
            course={c}
            progress={courseProgress(c, completed)}
            onClick={() => onSelectCourse(c.id)}
            onContextMenu={
              onContextMenu ? (e) => onContextMenu(c, e) : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}

/// Single cover thumbnail in the carousel. Shows the extracted cover if
/// one exists; otherwise a language-tinted mini-tile with the short
/// language code. Same cover-loading path as BookCover — the hook
/// dedupes repeat requests across mounts.
function CarouselItem({
  course,
  progress,
  onClick,
  onContextMenu,
}: {
  course: Course;
  /// Fraction 0..1 of completed lessons. Drives the bottom progress
  /// strip over the cover. Also surfaces in the tooltip so hovering a
  /// thumbnail gives a concrete "x of y" number.
  progress: { pct: number; done: number; total: number };
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const coverUrl = useCourseCover(course.id, course.coverFetchedAt);
  const hasCover = !!coverUrl;
  const { pct, done, total } = progress;
  const pctLabel =
    total === 0
      ? ""
      : pct === 1
      ? " · complete"
      : pct === 0
      ? " · not started"
      : ` · ${done}/${total} lessons`;

  return (
    <button
      type="button"
      data-course-id={course.id}
      className={`libre__carousel-item libre__carousel-item--lang-${course.language} ${
        hasCover ? "" : "libre__carousel-item--no-cover"
      }`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={`${course.title}${pctLabel}`}
      aria-label={`Open ${course.title}${pctLabel}`}
    >
      {hasCover ? (
        <img
          className="libre__carousel-cover"
          src={coverUrl}
          alt=""
          loading="lazy"
          draggable={false}
        />
      ) : (
        <span className="libre__carousel-glyph" aria-hidden>
          {carouselGlyph(course.language)}
        </span>
      )}
      {/* Title + author overlay with a dark gradient, matching the
          library shelf's BookCover treatment so carousel thumbs read
          as miniaturized versions of the same card. Only shown when
          there's a cover — fallback tiles already surface the title
          via the language-tinted block itself. */}
      {hasCover && (
        <>
          <span className="libre__carousel-shadow" aria-hidden />
          <span className="libre__carousel-label">
            <span className="libre__carousel-label-title">{course.title}</span>
            {course.author && (
              <span className="libre__carousel-label-author">
                {course.author}
              </span>
            )}
          </span>
        </>
      )}
      {/* Progress strip along the bottom edge of the cover. Shown for
          every course (even 0%) so the carousel reads as a consistent
          row of status bars — uniform height keeps the cover row from
          jumping when the learner's first completion lands. */}
      {total > 0 && (
        <span className="libre__carousel-progress" aria-hidden>
          <span
            className="libre__carousel-progress-fill"
            style={{ width: `${Math.round(pct * 100)}%` }}
          />
        </span>
      )}
    </button>
  );
}
