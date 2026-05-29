/// Alternative renderer for the active course's chapter list — a
/// tight grid of numbered lesson cells per chapter instead of the
/// vertical list+ring tree that `ChapterTree` renders.
///
/// **This is not a standalone sidebar.** It's a content component
/// that mounts inside the production Sidebar's `libre__course-body`
/// slot, sharing the surrounding sidebar shell (brand strip,
/// carousel, frosted-glass frame, positioning). The user picks
/// list-vs-grid in Settings → Theme → "Sidebar layout"; CourseGroup
/// reads the choice from `useSidebarVariant()` and swaps which of
/// the two components it renders here.
///
/// Cell states:
///   - filled accent      → completed lesson (shows the lesson-kind
///                          glyph — book / code / brain — so the
///                          stack of done cells doubles as a quick
///                          summary of "what KIND of work did I do
///                          in this chapter?")
///   - accent outline     → currently open lesson
///   - subtle hollow      → pending lesson (shows the lesson #)
///
/// Each cell carries the lesson title in its `title` attribute so
/// the OS-level tooltip surfaces on hover — the cells themselves
/// are too small to host an inline label. We use the native title
/// instead of `@base/primitives/tooltip` because that primitive
/// positions its tooltip absolutely relative to the trigger, and
/// the sidebar's scroll/overflow chain clips the chip when it tries
/// to extend past the sidebar edge. Native tooltips render at the
/// OS layer and don't care about CSS clipping contexts.
///
/// Props mirror `ChapterTree` exactly so the swap inside CourseGroup
/// is a one-line ternary. Context menu callbacks are accepted but
/// currently used only for chapter-level right-clicks; per-lesson
/// right-click is harder to surface inside a single-character cell
/// so it's deferred (the lesson's full row is gone — the affordance
/// would need a context menu of its own to make sense).

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@base/primitives/icon";
import { chevronDown } from "@base/primitives/icon/icons/chevron-down";
import { chevronRight } from "@base/primitives/icon/icons/chevron-right";
import "@base/primitives/icon/icon.css";
import type { Chapter, Lesson } from "../../data/types";
import { iconForKind } from "./labels";
import {
  chapterProgress,
  completionKey,
  lessonStatus,
} from "./variants/types";
import { useT } from "../../i18n/i18n";
import "./ChapterGrid.css";

interface Props {
  chapters: Chapter[];
  courseId: string;
  activeLessonId?: string;
  completed: Set<string>;
  onSelectLesson: (courseId: string, lessonId: string) => void;
  onChapterContextMenu?: (chapter: Chapter, e: React.MouseEvent) => void;
  /// Accepted for parity with ChapterTree but not currently surfaced
  /// — the grid cells are too small to host an obvious right-click
  /// target. If you want to wire it through, attach `onContextMenu`
  /// to each cell button and forward to this callback with the
  /// resolved lesson + isCompleted boolean.
  onLessonContextMenu?: (
    lesson: Lesson,
    isCompleted: boolean,
    e: React.MouseEvent,
  ) => void;
}

export default function ChapterGrid({
  chapters,
  courseId,
  activeLessonId,
  completed,
  onSelectLesson,
  onChapterContextMenu,
}: Props) {
  const t = useT();
  // (The previous `useIsRunning()` hook here drove an
  // `excited`-foil mode on each completed cell's holographic
  // overlay; both the hologram and the run-status plumbing it
  // depended on are gone now. If a future "currently running"
  // visual returns, re-import `useIsRunning` and key the new
  // treatment off it.)

  // The id of the chapter that contains the currently-active lesson
  // (or null if no lesson is active). Used as the auto-open target
  // when the user navigates between lessons: jumping into a lesson
  // in chapter B from one in chapter A should collapse A and reveal
  // B's cells.
  const activeChapterId = useMemo(() => {
    if (!activeLessonId) return null;
    return (
      chapters.find((c) => c.lessons.some((l) => l.id === activeLessonId))
        ?.id ?? null
    );
  }, [activeLessonId, chapters]);

  // Set of chapter ids the user currently has expanded. Initial
  // state mirrors the auto-open rule: if there's an active lesson,
  // only its containing chapter starts open; if not (e.g. course
  // landing view), every chapter starts open so the user sees the
  // full layout.
  const [openChapters, setOpenChapters] = useState<Set<string>>(() => {
    if (activeChapterId) return new Set([activeChapterId]);
    return new Set(chapters.map((c) => c.id));
  });

  // Auto-collapse trigger: whenever the active CHAPTER changes
  // (not just the active lesson within it), reset to "only that
  // chapter is open." This deliberately respects manual toggles
  // while the user is inside the same chapter — they can pop
  // another chapter open and it'll stay open until they move
  // their lesson focus into a different chapter, at which point
  // we re-fold the sidebar around the new focus.
  const lastActiveChapterRef = useRef<string | null>(activeChapterId);
  useEffect(() => {
    if (activeChapterId === lastActiveChapterRef.current) return;
    lastActiveChapterRef.current = activeChapterId;
    if (activeChapterId) {
      setOpenChapters(new Set([activeChapterId]));
    } else {
      // Active lesson cleared — restore the "all open" default
      // so the course-landing view shows every chapter again.
      setOpenChapters(new Set(chapters.map((c) => c.id)));
    }
  }, [activeChapterId, chapters]);

  const toggleChapter = (id: string) => {
    setOpenChapters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="libre-chgrid">
      <div className="libre-chgrid__chapters">
        {chapters.map((chapter) => {
          const prog = chapterProgress(
            courseId,
            chapter.lessons.map((l) => l.id),
            completed,
          );
          const isOpen = openChapters.has(chapter.id);
          return (
            <section
              key={chapter.id}
              className={
                "libre-chgrid__chapter" +
                (isOpen ? " libre-chgrid__chapter--open" : "")
              }
              aria-label={chapter.title}
              onContextMenu={
                onChapterContextMenu
                  ? (e) => onChapterContextMenu(chapter, e)
                  : undefined
              }
            >
              <button
                type="button"
                className="libre-chgrid__chapter-head"
                onClick={() => toggleChapter(chapter.id)}
                aria-expanded={isOpen}
                aria-controls={`libre-chgrid-cells-${chapter.id}`}
              >
                <Icon
                  icon={isOpen ? chevronDown : chevronRight}
                  size="xs"
                  color="currentColor"
                  className="libre-chgrid__chapter-chevron"
                />
                <span
                  className="libre-chgrid__chapter-title"
                  title={chapter.title}
                >
                  {chapter.title}
                </span>
                <span
                  className="libre-chgrid__chapter-bar"
                  aria-hidden="true"
                  title={t("sidebar.chapterLessonCount", { done: prog.done, total: prog.total })}
                >
                  <span
                    className="libre-chgrid__chapter-bar-fill"
                    style={{ width: `${prog.pct}%` }}
                  />
                </span>
                <span className="libre-chgrid__chapter-count">
                  {prog.done}/{prog.total}
                </span>
              </button>
              {isOpen && (
                <div
                  id={`libre-chgrid-cells-${chapter.id}`}
                  className="libre-chgrid__cells"
                  role="list"
                  aria-label={t("sidebar.chapterLessonsList", { chapter: chapter.title })}
                >
                  {chapter.lessons.map((lesson, i) => {
                    const status = lessonStatus(
                      courseId,
                      lesson.id,
                      completed,
                      activeLessonId,
                    );
                    const isDone = completed.has(
                      completionKey(courseId, lesson.id),
                    );
                    return (
                      <button
                        key={lesson.id}
                        type="button"
                        role="listitem"
                        className={
                          "libre-chgrid__cell libre-chgrid__cell--" + status
                        }
                        onClick={() => onSelectLesson(courseId, lesson.id)}
                        title={lesson.title}
                        aria-label={t(
                          isDone ? "sidebar.lessonCellLabelCompleted" : "sidebar.lessonCellLabel",
                          { n: i + 1, title: lesson.title },
                        )}
                      >
                        {/* The holographic-snake foil that used to
                            overlay completed cells was retired —
                            the done state now reads from the white
                            fill + kind icon alone, with no foil
                            competing for the small cell space. The
                            `isRunning` / `excited` plumbing stays
                            in scope for a future treatment if we
                            re-introduce a "currently running"
                            visual; for now the cell relies on its
                            own state class for that distinction. */}
                        {status === "done" ? (
                          <Icon
                            icon={iconForKind(lesson.kind)}
                            size="base"
                            color="currentColor"
                          />
                        ) : (
                          <span className="libre-chgrid__cell-num">
                            {i + 1}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
