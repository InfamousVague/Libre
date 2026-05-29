/// Slim icon-only rail to the LEFT of the floating sidebar. Holds the
/// app's primary navigation (Library / Sandbox / Discover /
/// Practice / Achievements / Tracks / Trees) plus the persistent
/// footer cluster
/// (Settings + sidebar toggle).
///
/// Why a separate rail instead of more sidebar chrome:
///   - The sidebar collapses entirely when the learner hits Hide
///     Sidebar; with the nav living INSIDE the sidebar, that hid the
///     primary route switcher too. A rail lives outside the sidebar
///     so navigation stays reachable in collapsed mode.
///   - A 56px-wide icon column is much more efficient real estate
///     for nav than the 260px-wide course-tree sidebar — the icons
///     read as a fixed reference column the way macOS sidebars do.
///   - Pinning Settings + the sidebar toggle to the bottom of the
///     rail puts the "infrastructure" controls in a stable corner
///     out of the primary scan path.
///
/// Visual chrome mirrors the sidebar's frosted-glass treatment so the
/// rail and sidebar read as a paired unit despite living in separate
/// containers.

import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@base/primitives/icon";
import { libraryBig } from "@base/primitives/icon/icons/library-big";
import { compass as compassIcon } from "@base/primitives/icon/icons/compass";
import { swords } from "@base/primitives/icon/icons/swords";
import { dumbbell } from "@base/primitives/icon/icons/dumbbell";
import { trophy } from "@base/primitives/icon/icons/trophy";
import { award } from "@base/primitives/icon/icons/award";
import { route } from "@base/primitives/icon/icons/route";
import { terminal as terminalIcon } from "@base/primitives/icon/icons/terminal";
import { settings as settingsIcon } from "@base/primitives/icon/icons/settings";
import { circleHelp } from "@base/primitives/icon/icons/circle-help";
import { play as playIcon } from "@base/primitives/icon/icons/play";
import { Tooltip } from "@base/primitives/tooltip";
import "@base/primitives/icon/icon.css";
import "@base/primitives/tooltip/tooltip.css";
import { formatShortcutForTitle } from "../ShortcutHint/ShortcutHint";
import NotificationDrawer from "./NotificationDrawer";
import { useT } from "../../i18n/i18n";
import "./NavigationRail.css";

export interface NavigationRailProps {
  /// Which main-pane destination is currently showing. Drives the
  /// pill highlight. "courses" / "profile" are valid app routes that
  /// don't map to a rail icon — those return `undefined active` so
  /// no rail row lights up.
  activeView?:
    | "courses"
    | "profile"
    | "sandbox"
    | "library"
    | "discover"
    | "challenges"
    | "practice"
    | "paths"
    | "achievements"
    | "certificates";
  onLibrary: () => void;
  /// Resume-most-recent affordance. When present, surfaces a play
  /// chip at the very top of the rail (above Library) that drops
  /// the learner back into the course they touched most recently,
  /// at the first uncompleted lesson. Hidden when omitted OR when
  /// `resumeLabel` is empty — the App passes both together (the
  /// label is the course title, used as the tooltip; both come
  /// from the same memoised resume-candidate calculation). Keeping
  /// the resolution in App means the rail stays a dumb renderer.
  onResume?: () => void;
  /// Tooltip / aria-label for the resume button — typically the
  /// course title ("Resume: The Rust Programming Language"). The
  /// button only renders when both `onResume` AND a non-empty
  /// label are provided, so a course with no recents shows
  /// nothing rather than a "Resume —" with a blank line.
  resumeLabel?: string;
  /// Discover route — browse catalog books + challenge packs not
  /// yet in the user's library. Optional; embeddings without one
  /// just hide the chip.
  onDiscover?: () => void;
  /// Tracks route — curated linear learning paths. (The Trees
  /// surface was retired in the 2026-05 redesign; Tracks is now
  /// the sole "outcome-driven sequence" affordance.)
  onChallenges?: () => void;
  /// Practice route — review-mode that resurfaces quizzes and
  /// blocks puzzles from courses the learner has already touched.
  /// The rest of the app is linear-by-lesson; Practice is the
  /// random-access "drill weak spots" surface that closes the
  /// learn → review loop.
  onPractice?: () => void;
  /// Paths route — curated, goal-oriented sequences that thread
  /// courses / Exercism tracks / koans / *-lings into a journey
  /// ("entry-level developer", "mobile app developer", "systems
  /// engineer", …). Sits just above Achievements: Paths is the
  /// "here's the map" surface, Achievements/Certificates are the
  /// "here's what you've collected" surfaces — map first, trophies
  /// after. Optional; when omitted the chip just doesn't render.
  onPaths?: () => void;
  /// Achievements route — browse-all surface for the unlock
  /// library. Optional; when omitted the chip just doesn't render.
  onAchievements?: () => void;
  /// Certificates route — browse-all surface for course-completion
  /// certificates. Sits just below Achievements because both
  /// surfaces are "trophy case" affordances; certificates are the
  /// more permanent / shareable artefact, so they go second.
  onCertificates?: () => void;
  /// Sandbox route — free-form coding workspace with multi-project
  /// support (per-project file list + language + git later in the
  /// roadmap). Optional so embeddings that don't ship the sandbox
  /// can just hide the chip.
  onSandbox?: () => void;
  onSettings: () => void;
  /// Re-trigger the guided tour (auto-runs on first launch; this
  /// puts a permanent affordance in the rail so a learner who
  /// dismissed it can come back). Optional — embeddings that
  /// don't ship the tour just hide the row.
  onStartTour?: () => void;
  /// Toggle the floating sidebar's visibility. The icon flips between
  /// panel-left-close (sidebar visible → click to hide) and
  /// panel-left-open (sidebar hidden → click to show). When omitted,
  /// the toggle row simply doesn't render — useful for surfaces that
  /// don't ship a sidebar (popped workbench, phone popout, etc., even
  /// though those don't render this rail today either).
  onToggleSidebar?: () => void;
  sidebarCollapsed?: boolean;
}

interface RailItemProps {
  icon: string;
  label: string;
  onClick: () => void;
  active?: boolean;
  /// The active-state ring is drawn via a `--active` modifier class;
  /// the title attribute carries the visible label since the rail
  /// itself is icon-only. Same vocabulary the MobileTabBar uses.
  pressed?: boolean;
}

function RailItem({ icon, label, onClick, active, pressed }: RailItemProps) {
  return (
    <Tooltip content={label} placement="right" delay={120}>
      <button
        type="button"
        className={
          "libre-nav-rail__item" +
          (active ? " libre-nav-rail__item--active" : "")
        }
        onClick={onClick}
        aria-label={label}
        aria-pressed={pressed}
      >
        {/* size="xl" — bumped up from the original "sm" so the rail
            glyphs read as primary-nav, but stepped down from "2xl"
            which crowded the 40×40 button. xl (22px) leaves ~9px
            of ring inside the button for hover / active contrast. */}
        <Icon icon={icon} size="xl" color="currentColor" />
      </button>
    </Tooltip>
  );
}

export default function NavigationRail({
  activeView,
  onLibrary,
  onResume,
  resumeLabel,
  onDiscover,
  onChallenges,
  onPractice,
  onPaths,
  onAchievements,
  onCertificates,
  onSandbox,
  onSettings,
  onStartTour,
  // `onToggleSidebar` / `sidebarCollapsed` are still declared on
  // the props interface so existing call sites pass through
  // without a refactor, but the rail no longer renders the
  // toggle — that moved to the fixed `<SidebarToggle />` chip
  // anchored next to the macOS traffic lights (see App.tsx).
}: NavigationRailProps) {
  const t = useT();
  // Sliding-pill indicator: a single absolutely-positioned element
  // animates its `top` between the active rail button's positions
  // rather than the highlight snapping from one button to another.
  // We measure the active button's offset relative to the top
  // cluster after every render that affects which button is active
  // OR which buttons are present (sign-in toggling Trees / Discover
  // visibility, etc.) so the pill stays glued to the right anchor.
  // Using `useLayoutEffect` so the measurement happens before paint
  // — without it the pill snaps to top:0 on the first frame and
  // visibly leaps into place a microframe later.
  const topRef = useRef<HTMLDivElement>(null);
  const [pillTop, setPillTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const top = topRef.current;
    if (!top) {
      setPillTop(null);
      return;
    }
    const activeBtn = top.querySelector(
      ".libre-nav-rail__item--active",
    ) as HTMLElement | null;
    if (!activeBtn) {
      // Active route doesn't have a rail icon (e.g. "courses" or
      // "profile" routes). Hide the pill so an old position doesn't
      // float over the rail looking stuck.
      setPillTop(null);
      return;
    }
    const topRect = top.getBoundingClientRect();
    const btnRect = activeBtn.getBoundingClientRect();
    setPillTop(btnRect.top - topRect.top);
    // Re-measure when conditional items toggle visibility — without
    // these in the deps, a rail item appearing (e.g. user signs in
    // and Trees becomes available) would shift the active button's
    // offset without re-running the effect, leaving the pill
    // misaligned.
  }, [activeView, onDiscover, onChallenges, onPractice, onPaths, onAchievements, onCertificates, onSandbox]);

  return (
    <nav className="libre-nav-rail" aria-label={t("nav.primaryNavigation")}>
      <div className="libre-nav-rail__top" ref={topRef}>
        {pillTop !== null && (
          <span
            className="libre-nav-rail__pill"
            style={{ transform: `translateY(${pillTop}px)` }}
            aria-hidden
          >
            {/* Flat accent pill — the iridescent foil treatment is
                now reserved for certificates + the AI assistant
                button. The active-route indicator is intentionally
                quiet so it reads as a state hint rather than a
                second CTA. */}
          </span>
        )}
        {/* Order rationale (top → bottom):
              0. Resume       — when the learner has a course in
                               recents, the very first chip is a
                               play button that drops them right
                               back in. Hidden on first launch
                               (no recents) and after a deliberate
                               library teardown.
              1. Library      — the home + most-visited surface
              2. Sandbox      — open-ended editor + project workspace,
                               surfaced near the top so devs can dive
                               in without first picking a course
              3. Discover     — catalog browser; sits next to
                               Sandbox because both are entry
                               points for "I want to start something"
              4. Practice     — review-mode for cards already opened;
                               middle of the rail because it's a
                               recurring rhythm, not a one-off start
              5. Achievements — unlock browser; below Practice so
                               the run-of-day affordances cluster
                               above the trophy case
              6. Certificates — permanent / shareable artefacts of
                               course completion (the more durable
                               cousin of the Achievements browser)
              7. Tracks       — curated linear paths anchored at
                               the bottom of the rail; the
                               outcome-driven on-ramp for learners
                               who haven't picked a book yet. (The
                               Trees skill-DAG surface that used
                               to live below Tracks was retired in
                               the 2026-05 redesign.)
        */}
        {onResume && resumeLabel && (
          <RailItem
            icon={playIcon}
            label={`${t("nav.resumePrefix")} ${resumeLabel}`}
            onClick={onResume}
          />
        )}
        <RailItem
          icon={libraryBig}
          label={t("nav.library")}
          onClick={onLibrary}
          active={activeView === "library"}
        />
        {/* Challenges lifted directly under Library — the library is
            books-only and exercise-driven content (Exercism tracks +
            in-house challenge packs + koans) is the natural next
            category in the catalogue hierarchy, so the two icons sit
            together visually. The page was called "Tracks" until the
            V27 koans ingest; "Tracks" is being held in reserve as a
            slot for a future feature, so the user-facing label moved
            to "Challenges" and the icon flipped from train-track to
            crossed swords to match the gamified-challenge metaphor. */}
        {onChallenges && (
          <RailItem
            icon={swords}
            label={t("nav.challenges")}
            onClick={onChallenges}
            active={activeView === "challenges"}
          />
        )}
        {onSandbox && (
          <RailItem
            icon={terminalIcon}
            label={t("nav.sandbox")}
            onClick={onSandbox}
            active={activeView === "sandbox"}
          />
        )}
        {onDiscover && (
          <RailItem
            icon={compassIcon}
            label={t("nav.discover")}
            onClick={onDiscover}
            active={activeView === "discover"}
          />
        )}
        {onPractice && (
          <RailItem
            icon={dumbbell}
            label={t("nav.practice")}
            onClick={onPractice}
            active={activeView === "practice"}
          />
        )}
        {onPaths && (
          <RailItem
            icon={route}
            label={t("nav.paths")}
            onClick={onPaths}
            active={activeView === "paths"}
          />
        )}
        {onAchievements && (
          <RailItem
            icon={trophy}
            label={t("nav.achievements")}
            onClick={onAchievements}
            active={activeView === "achievements"}
          />
        )}
        {onCertificates && (
          <RailItem
            icon={award}
            label={t("nav.certificates")}
            onClick={onCertificates}
            active={activeView === "certificates"}
          />
        )}
      </div>
      <div className="libre-nav-rail__bottom">
        {/* Bottom cluster, top → bottom: sidebar toggle, notification
            bell, help, settings. The sidebar toggle anchors the top
            of this group (the most common bottom-rail interaction),
            with the bell just below it so the unread chip lives
            next to a frequently-clicked button without sitting on
            top of the navigation list above. Settings is at the
            very bottom (conventional Mac-app spot) with help docked
            one row up so the "I need a hint" affordance sits beside
            the knob it usually nudges the user toward. */}
        {/* The sidebar toggle that used to live here was moved to a
            fixed-position chip just to the right of the macOS
            traffic lights (see `<SidebarToggle />` in App.tsx).
            The `onToggleSidebar` / `sidebarCollapsed` props are
            still accepted on this component so existing call
            sites pass through cleanly — they're just unused in
            the rail now. */}
        <NotificationDrawer />
        {onStartTour && (
          <RailItem
            icon={circleHelp}
            label={t("nav.takeTour")}
            onClick={onStartTour}
          />
        )}
        <RailItem
          icon={settingsIcon}
          label={formatShortcutForTitle(t("nav.settings"), "app.settings")}
          onClick={onSettings}
        />
      </div>
    </nav>
  );
}
