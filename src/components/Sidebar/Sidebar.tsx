import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@base/primitives/icon";
import { libraryBig } from "@base/primitives/icon/icons/library-big";
import { settings as settingsIcon } from "@base/primitives/icon/icons/settings";
import { download as downloadIcon } from "@base/primitives/icon/icons/download";
import { x as xIcon } from "@base/primitives/icon/icons/x";
import { swords } from "@base/primitives/icon/icons/swords";
import { rotateCcw } from "@base/primitives/icon/icons/rotate-ccw";
import "@base/primitives/icon/icon.css";
import type { Course } from "../../data/types";
import { isChallengePack } from "../../data/types";
import { languageLabel } from "./labels";
import CourseGroup from "./CourseGroup";
import { useT } from "../../i18n/i18n";
import "./Sidebar.css";

interface Props {
  courses: Course[];
  activeCourseId?: string;
  activeLessonId?: string;
  completed: Set<string>;
  onSelectLesson: (courseId: string, lessonId: string) => void;
  /// Opens the course library modal. Used by the empty-state CTA
  /// inside the course tree ("Open Library" button shown when the
  /// user has zero courses installed). Primary nav routes
  /// (Library / Discover / Trees / Playground / Settings) live in
  /// `NavigationRail` now; this prop is the in-tree affordance only.
  onLibrary: () => void;
  onExportCourse?: (courseId: string, courseTitle: string) => void;
  onDeleteCourse?: (courseId: string, courseTitle: string) => void;
  onCourseSettings?: (courseId: string) => void;
  /// Wipe a single lesson's completion. Surfaced via the lesson row's
  /// right-click menu when the lesson is currently marked complete.
  onResetLesson?: (courseId: string, lessonId: string) => void;
  /// Wipe every completion in a chapter. The sidebar passes the chapter's
  /// lesson_ids since completions are stored flat per-lesson (no chapter id
  /// in the schema).
  onResetChapter?: (courseId: string, lessonIds: string[]) => void;
  /// Wipe every completion in a course. Reachable from the course
  /// right-click menu (sits between Export and Delete).
  onResetCourse?: (courseId: string) => void;
  /// Switch the main view to the certificates page. Used by the
  /// MiniCertBanner above the active-course tree — clicking the
  /// banner takes the learner to the gallery of cert artefacts
  /// (earned + in-progress). Optional: if not wired the banner
  /// stops behaving as a button.
  onCertificates?: () => void;
}

/// Floating left rail. Completion dots fill in as lessons get marked done
/// (unit test passes, mark-read, etc.). The chapter header shows `x / y`
/// lessons complete so users see progress at a glance.
export default function Sidebar({
  courses,
  activeCourseId,
  activeLessonId,
  completed,
  onSelectLesson,
  onLibrary,
  onExportCourse,
  onDeleteCourse,
  onCourseSettings,
  onResetLesson,
  onResetChapter,
  onResetCourse,
  onCertificates,
}: Props) {
  const t = useT();
  /// Open context menu state, positioned at the cursor when a course card
  /// is right-clicked. One menu at a time across the sidebar — opening a
  /// new one closes the previous. Clicking outside, pressing Escape, or
  /// scrolling the sidebar dismisses it.
  const [menu, setMenu] = useState<{
    courseId: string;
    courseTitle: string;
    x: number;
    y: number;
  } | null>(null);

  /// Same shape, separate state slot for the chapter right-click menu —
  /// the data shape differs (chapter title, lesson_ids) so reusing `menu`
  /// would mean a discriminated union. A second slot is simpler.
  const [chapterMenu, setChapterMenu] = useState<{
    courseId: string;
    chapterTitle: string;
    lessonIds: string[];
    x: number;
    y: number;
  } | null>(null);

  /// Lesson right-click menu. Only opened for completed lessons (the only
  /// V1 action is "mark incomplete"); incomplete lessons skip the menu
  /// entirely so the learner doesn't see an empty popover.
  const [lessonMenu, setLessonMenu] = useState<{
    courseId: string;
    lessonId: string;
    lessonTitle: string;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    // One shared close path so a click anywhere outside (or Escape) drops
    // whichever of the three menus is open. Only attach the listeners
    // when something IS open — saves a no-op listener on every render.
    const anyOpen = menu || chapterMenu || lessonMenu;
    if (!anyOpen) return;
    const close = () => {
      setMenu(null);
      setChapterMenu(null);
      setLessonMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // `click` (not `mousedown`) so the click that opens a menu item still
    // hits the item before the dismiss fires. `contextmenu` dismiss on a
    // different card lets the new card open its own menu immediately.
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, chapterMenu, lessonMenu]);

  return (
    <aside className="libre__sidebar">
      {/* Primary nav — vertical list with icon + label. Claude-Code-style:
          full-width rows, clear call-outs, no ambiguity about what each
          chip does. Routes (Profile / Playground) show an active state
          when their view is open; one-shot actions (Library / Import /
          Settings) stay neutral. */}
      {/* Sidebar nav is now a thin trio: Library (which owns all the
          import flows — PDF + bulk PDF + .academy archive), the
          Playground route, and Settings. Profile lives on the top-bar
          streak pill alongside level/XP so it's adjacent to the data
          it belongs with, not hiding in the left rail. */}
      {/* The horizontally-scrollable cover-thumbnail carousel that
          used to live at the very top of the sidebar was retired
          here — switching between recent courses is now the job of
          the open lesson tabs above the workbench. Removing it
          reclaims the sidebar's top edge for the chapter tree, the
          surface that does the most work. */}

      {/* Library / Discover / Trees / Playground / Settings live in
          the navigation rail to the LEFT of this sidebar — see
          components/NavigationRail/NavigationRail.tsx. The sidebar's
          job here is the course tree. */}

      <nav className="libre__nav">
        {(() => {
          // Partition into books vs challenge packs so they render under
          // distinct section headers. Order within each group is preserved
          // (newest-first comes from the caller). We still render a single
          // list when only one kind is present — no empty headers.
          const books = courses.filter((c) => !isChallengePack(c));
          const packs = courses.filter((c) => isChallengePack(c));

          const renderGroup = (
            course: Course,
          ): React.ReactElement => (
            <CourseGroup
              key={course.id}
              course={course}
              isActiveCourse={course.id === activeCourseId}
              activeLessonId={activeLessonId}
              completed={completed}
              onSelectLesson={onSelectLesson}
              onContextMenu={
                onExportCourse || onDeleteCourse || onCourseSettings || onResetCourse
                  ? (e: React.MouseEvent) => {
                      e.preventDefault();
                      setMenu({
                        courseId: course.id,
                        courseTitle: course.title,
                        x: e.clientX,
                        y: e.clientY,
                      });
                    }
                  : undefined
              }
              onChapterContextMenu={
                onResetChapter
                  ? (chapter, e) => {
                      e.preventDefault();
                      setChapterMenu({
                        courseId: course.id,
                        chapterTitle: chapter.title,
                        lessonIds: chapter.lessons.map((l) => l.id),
                        x: e.clientX,
                        y: e.clientY,
                      });
                    }
                  : undefined
              }
              onLessonContextMenu={
                onResetLesson
                  ? (lesson, isCompleted, e) => {
                      // Skip the menu entirely for not-yet-completed
                      // lessons — the only V1 action is reset, and
                      // there's nothing to reset.
                      if (!isCompleted) return;
                      e.preventDefault();
                      setLessonMenu({
                        courseId: course.id,
                        lessonId: lesson.id,
                        lessonTitle: lesson.title,
                        x: e.clientX,
                        y: e.clientY,
                      });
                    }
                  : undefined
              }
              onCertificates={onCertificates}
            />
          );

          // Active course (if any) is lifted to the top of the nav under
          // a "Current" header so the "which course am I in" question is
          // answered before the eye even reaches the list. When you ARE
          // focused on a course, the rest of the sidebar narrows to just
          // that language's challenge packs — other courses would be
          // noise you're not currently using, challenge packs in the
          // same language are the natural practice companion. When no
          // course is active (just launched, or on Profile / Playground),
          // we skip the Current header and show everything under the
          // normal sections so the learner can pick.
          const activeCourse =
            courses.find((c) => c.id === activeCourseId) ?? null;

          // The sidebar is the LEARNER'S BENCH — only show courses the
          // learner has touched (≥1 completed lesson). Untouched courses
          // live on the Library page where the learner goes to *find new
          // things*. Without this filter, a bundled-pack-heavy install
          // dumps 24 sections into the sidebar and turns a working
          // surface into a discovery surface. The active course is an
          // exception — if you JUST opened a course, we want it visible
          // in "Current" even though completion is still 0.
          const isStarted = (c: Course): boolean =>
            c.chapters.some((ch) =>
              ch.lessons.some((l) => completed.has(`${c.id}:${l.id}`)),
            );

          const inactiveBooks = books.filter(
            (c) => c.id !== activeCourseId && isStarted(c),
          );
          // Challenge packs intentionally skip the `isStarted` filter
          // — packs are small, language-pickable practice surfaces, and
          // the "I have a Ruby pack but never saw it because the
          // sidebar hid it until I started a lesson" failure mode is
          // worse than showing 11 unstarted tiles. Books still filter
          // by started so the bench doesn't drown in 30+ untouched
          // long-form courses on a fresh install.
          const inactivePacks = packs.filter((c) => c.id !== activeCourseId);

          // Language-filtered packs when focused on a course. We match
          // the pack's primary language to the active course's language.
          const relevantPacks = activeCourse
            ? inactivePacks.filter((p) => p.language === activeCourse.language)
            : inactivePacks;

          // Empty state: no started courses AND no active course means
          // a brand-new install (or the learner reset everything). Send
          // them to the library — that's where new courses come from.
          const hasAnything =
            !!activeCourse || inactiveBooks.length > 0 || relevantPacks.length > 0;

          // Viewing a lesson — collapse to the active course only.
          // No "Current" section header (it's redundant when the
          // active course is the ONLY thing in the sidebar), no
          // challenge-pack list, no in-progress list, no empty
          // state. The brand wordmark above already provides the
          // visual anchor; placing the course card right under it
          // gives the learner a focused tree to navigate without
          // sibling chrome competing for attention.
          const viewingLesson = !!activeLessonId && !!activeCourse;
          if (viewingLesson) {
            return renderGroup(activeCourse!);
          }

          return (
            <>
              {activeCourse && (
                <>
                  <div className="libre__nav-section">{t("sidebar.sectionCurrent")}</div>
                  {renderGroup(activeCourse)}
                </>
              )}
              {!activeCourse && inactiveBooks.length > 0 && (
                <>
                  <div className="libre__nav-section">{t("sidebar.sectionInProgress")}</div>
                  {inactiveBooks.map(renderGroup)}
                </>
              )}
              {relevantPacks.length > 0 && (
                <>
                  <div className="libre__nav-section libre__nav-section--packs">
                    <span className="libre__nav-section-icon" aria-hidden>
                      <Icon icon={swords} size="xs" color="currentColor" />
                    </span>
                    {activeCourse
                      ? t("sidebar.sectionLanguageChallenges", { language: languageLabel(activeCourse.language) })
                      : t("sidebar.sectionChallengePacks")}
                  </div>
                  {relevantPacks.map(renderGroup)}
                </>
              )}
              {!hasAnything && (
                <div className="libre__nav-empty">
                  <p className="libre__nav-empty-headline">
                    {t("sidebar.emptyHeadline")}
                  </p>
                  <p className="libre__nav-empty-body">
                    {t("sidebar.emptyBody")}
                  </p>
                  <button
                    type="button"
                    className="libre__nav-empty-cta"
                    onClick={onLibrary}
                  >
                    <span aria-hidden>
                      <Icon icon={libraryBig} size="xs" color="currentColor" />
                    </span>
                    {t("sidebar.openLibraryCta")}
                  </button>
                </div>
              )}
            </>
          );
        })()}
      </nav>

      {menu && (onExportCourse || onDeleteCourse || onCourseSettings || onResetCourse) && createPortal(
        <div
          className="libre__context-menu"
          // Position at cursor. Fixed positioning so scroll state doesn't
          // matter — the window-level click listener dismisses us anyway.
          // Portalled to document.body so the sidebar's `backdrop-filter`
          // (which makes the sidebar a containing block for fixed
          // descendants) doesn't clip us.
          style={{ left: menu.x, top: menu.y }}
          // Stop the click from bubbling to window and dismissing before
          // the item's onClick fires.
          onClick={(e) => e.stopPropagation()}
        >
          <div className="libre__context-menu-label">{menu.courseTitle}</div>
          {onCourseSettings && (
            <button
              type="button"
              className="libre__context-menu-item"
              onClick={() => {
                onCourseSettings(menu.courseId);
                setMenu(null);
              }}
            >
              <span className="libre__context-menu-icon" aria-hidden>
                <Icon icon={settingsIcon} size="xs" color="currentColor" />
              </span>
              {t("sidebar.ctxCourseSettings")}
            </button>
          )}
          {onExportCourse && (
            <button
              type="button"
              className="libre__context-menu-item"
              onClick={() => {
                onExportCourse(menu.courseId, menu.courseTitle);
                setMenu(null);
              }}
            >
              <span className="libre__context-menu-icon" aria-hidden>
                <Icon icon={downloadIcon} size="xs" color="currentColor" />
              </span>
              {t("sidebar.ctxExportCourse")}
            </button>
          )}
          {/* Reset progress sits between the safe actions and Delete:
              destructive in that it wipes completion state, but recoverable
              (the lessons are still there to re-complete). Styled like the
              Settings/Export rows, NOT like the Delete row. */}
          {onResetCourse && (
            <button
              type="button"
              className="libre__context-menu-item"
              onClick={() => {
                onResetCourse(menu.courseId);
                setMenu(null);
              }}
            >
              <span className="libre__context-menu-icon" aria-hidden>
                <Icon icon={rotateCcw} size="xs" color="currentColor" />
              </span>
              {t("sidebar.ctxResetProgress")}
            </button>
          )}
          {onDeleteCourse && (
            <>
              {/* Separator between non-destructive and destructive actions. */}
              <div className="libre__context-menu-sep" aria-hidden />
              <button
                type="button"
                className="libre__context-menu-item libre__context-menu-item--danger"
                onClick={() => {
                  onDeleteCourse(menu.courseId, menu.courseTitle);
                  setMenu(null);
                }}
              >
                <span className="libre__context-menu-icon" aria-hidden>
                  <Icon icon={xIcon} size="xs" color="currentColor" />
                </span>
                {t("sidebar.ctxDeleteCourse")}
              </button>
            </>
          )}
        </div>,
        document.body,
      )}

      {chapterMenu && onResetChapter && createPortal(
        <div
          className="libre__context-menu"
          style={{ left: chapterMenu.x, top: chapterMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="libre__context-menu-label">{chapterMenu.chapterTitle}</div>
          <button
            type="button"
            className="libre__context-menu-item"
            onClick={() => {
              onResetChapter(chapterMenu.courseId, chapterMenu.lessonIds);
              setChapterMenu(null);
            }}
          >
            <span className="libre__context-menu-icon" aria-hidden>
              <Icon icon={rotateCcw} size="xs" color="currentColor" />
            </span>
            {t("sidebar.ctxResetChapter")}
          </button>
        </div>,
        document.body,
      )}

      {lessonMenu && onResetLesson && createPortal(
        <div
          className="libre__context-menu"
          style={{ left: lessonMenu.x, top: lessonMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="libre__context-menu-label">{lessonMenu.lessonTitle}</div>
          <button
            type="button"
            className="libre__context-menu-item"
            onClick={() => {
              onResetLesson(lessonMenu.courseId, lessonMenu.lessonId);
              setLessonMenu(null);
            }}
          >
            <span className="libre__context-menu-icon" aria-hidden>
              <Icon icon={rotateCcw} size="xs" color="currentColor" />
            </span>
            {t("sidebar.ctxMarkIncomplete")}
          </button>
        </div>,
        document.body,
      )}
    </aside>
  );
}
