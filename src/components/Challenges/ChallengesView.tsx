/// Tracks — curated linear learning paths, rendered as a 3D
/// hyper-scroll surface.
///
/// The visual is a stack of cards arranged along the camera's
/// Z axis. Wheeling the surface drives a smoothed scroll value;
/// each card's Z is `(baseZ + scroll)` so cards visually fly past
/// the camera as the learner scrolls. Mouse position parallax-
/// tilts the world. Velocity drives a dynamic perspective (FOV)
/// warp so fast scrolls "warp" through the field and slow scrolls
/// read as gentle drift.
///
/// Why hand-rolled instead of a smooth-scroll library: this
/// surface is a single screen with its own scroll pseudo-axis
/// (wheel events instead of the page scrollbar), the math is
/// trivial (lerp + delta), and adding a dep for one component
/// felt wrong. The rAF loop runs only while the surface is
/// mounted + visible.
///
/// Trees were retired in the 2026-05 redesign; tracks are now
/// the sole "outcome-driven sequence" surface. The underlying
/// tree data (`data/trees/`) is still imported here because
/// tracks reference tree node IDs to resolve completion + lesson
/// matches — that data layer is now internal-only.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "@base/primitives/icon";
import { swords } from "@base/primitives/icon/icons/swords";
import { x as xIcon } from "@base/primitives/icon/icons/x";
import { rotateCcw } from "@base/primitives/icon/icons/rotate-ccw";
import "@base/primitives/icon/icon.css";
import type { Course } from "../../data/types";
import {
  isChallengePack,
  isExerciseTrack,
  isKoans,
  isLings,
} from "../../data/types";
import { TREES } from "../../data/trees";
import {
  trackProgressPercent,
  type LearningTrack,
} from "../../data/tracks";
import { useSessionStorageState } from "../../hooks/useLocalStorageState";
import { useT } from "../../i18n/i18n";
import "./ChallengesView.css";

/// Default accent (matches the cover-art palette used elsewhere)
/// for challenge packs that don't ship a per-pack accent. Picked
/// per-pack via a stable hash of the pack id so adjacent packs
/// don't end up sharing a colour by accident.
const CHALLENGE_ACCENTS = [
  "#d4863a",
  "#7c9eff",
  "#9d7cff",
  "#5fb59c",
  "#e87a7a",
  "#e8b85f",
  "#6fb5e8",
  "#c47aff",
];

function accentForPack(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return CHALLENGE_ACCENTS[Math.abs(h) % CHALLENGE_ACCENTS.length];
}

/// Convert a challenge-pack course into a `LearningTrack`-shaped
/// object the existing carousel + grid renderers can consume
/// without any per-card refactor. Most fields map verbatim from
/// the underlying Course; `steps` is left empty because tracks-
/// proper were SkillTree node sequences and challenge packs are
/// flat lesson lists (the carousel doesn't care — it only reads
/// `steps.length` for the meta line, which we patch around via
/// the `progressOverride` prop the card now accepts).
function challengePackAsTrack(pack: Course): LearningTrack {
  const totalLessons = pack.chapters.reduce(
    (n, ch) => n + ch.lessons.length,
    0,
  );
  // Differentiate copy by pack type. Exercism-style tracks
  // (`packType: "track"`) get language-curriculum framing;
  // challenge packs (`packType: "challenges"`) keep the
  // drill-problems framing. Without this, an Exercism track
  // rendered with "drill challenges" copy that didn't match
  // its actual structure — Notion issue #b6fef5af1fa276d1.
  const isTrack = isExerciseTrack(pack);
  const isKoansPack = isKoans(pack);
  const isLingsPack = isLings(pack);
  const lang = pack.language ?? "language";
  return {
    id: pack.id,
    title: pack.title,
    short: pack.language ? pack.language.toUpperCase() : "Pack",
    description:
      pack.description ??
      (isLingsPack
        ? `A rustlings-style ${lang} course — fix the broken snippet in each exercise to make it compile + pass.`
        : isKoansPack
        ? `Classic ${lang} koans — fill-in-the-blanks exercises with inline tests.`
        : isTrack
        ? `An Exercism-style ${lang} track — concept lessons in order, plus practice exercises.`
        : "A pack of short coding challenges to drill the language."),
    accent: accentForPack(pack.id),
    // Neither variant carries an explicit difficulty; default
    // to "intermediate" so the carousel badge reads as a neutral
    // marker rather than implying "easy" or "advanced."
    difficulty: "intermediate",
    estimatedHours: Math.max(1, Math.round(totalLessons / 6)),
    outcome: isLingsPack
      ? `Fix ${totalLessons} ${lang} exercises end-to-end.`
      : isKoansPack
      ? `Meditate through ${totalLessons} ${lang} koans end-to-end.`
      : isTrack
      ? `Work through ${totalLessons} ${lang} lessons end-to-end.`
      : `Drill ${totalLessons} ${lang} challenges end-to-end.`,
    // Synthetic empty step list — the carousel only reads
    // `steps.length` for the meta-line text; we override the
    // displayed step count via the card body's meta computation
    // path below by passing in the lesson count directly.
    steps: [],
  };
}

/// Find the first incomplete lesson in a pack — the natural
/// "resume" target when a learner clicks a challenge card.
/// Falls back to the very first lesson when every lesson is
/// already complete (re-opening a finished pack starts at the
/// beginning so a learner can review).
function firstIncompleteLesson(
  pack: Course,
  completed: Set<string>,
): { courseId: string; lessonId: string } | null {
  for (const chapter of pack.chapters) {
    for (const lesson of chapter.lessons) {
      if (!completed.has(`${pack.id}:${lesson.id}`)) {
        return { courseId: pack.id, lessonId: lesson.id };
      }
    }
  }
  const firstChapter = pack.chapters[0];
  const firstLesson = firstChapter?.lessons[0];
  if (firstLesson) {
    return { courseId: pack.id, lessonId: firstLesson.id };
  }
  return null;
}

/// View modes for the Tracks page.
///   - "hyper" — the 3D fly-through carousel. Default on first
///     visit to Tracks after an app launch; the dramatic intro to
///     the surface.
///   - "grid"  — flat CSS-grid of cards. Faster to scan once the
///     learner has finished the tour. Activated automatically
///     when the learner scrolls to the END of the hyper view
///     (we treat that as "you've seen the catalogue, here's the
///     scannable layout"). Persisted in **sessionStorage** so the
///     "I've already seen the intro" state survives in-session
///     navigations (Tracks → Library → Tracks stays in grid) but
///     resets on every app launch — so a cold restart replays the
///     hyper intro the next time the learner clicks Tracks.
///
/// Within a session the transition is one-way (no in-app toggle
/// back to hyper). A cold app restart is the natural reset point;
/// previous builds persisted to localStorage which made the intro
/// a strict one-time-ever moment, but the wow-factor is more fun
/// when it replays per launch.
type TracksMode = "hyper" | "grid";
const TRACKS_MODE_KEY = "libre:tracks-mode";
/// Legacy localStorage key from when the mode was persisted
/// permanently. Cleaned up on mount so users who already had
/// "grid" written there don't keep skipping the hyper intro after
/// the switch to sessionStorage.
const LEGACY_TRACKS_MODE_KEY = "libre:tracks-mode";

interface Props {
  courses: readonly Course[];
  /// `${courseId}:${lessonId}` set — same shape used by the
  /// Sidebar + lesson reader for marking progress.
  completed: Set<string>;
  /// Open a specific lesson by id pair. Wired by App so clicking
  /// a step's matched lesson lands the learner inside the lesson
  /// reader / editor instead of dead-ending in the track view.
  onOpenLesson: (courseId: string, lessonId: string) => void;
  /// Wipe every completion for a course (App's
  /// `clearCourseCompletions`). When wired, right-clicking any
  /// challenge-pack card surfaces a single-item "Reset progress"
  /// floating menu — mirrors the Sidebar's per-course reset
  /// affordance so the user has the same recovery path no matter
  /// which surface they're on. Optional: omitting it just disables
  /// the right-click menu, leaving the card as plain click-to-open.
  onResetCourse?: (courseId: string) => void;
}

/// Viewport-width thresholds for the responsive column tier.
///   - >= WIDE_BREAKPOINT_PX  → 3 columns (the default density;
///     three 266px cards + two ~34px gaps need ~866px of carousel
///     viewport, so we wait until the window itself has ~1300px
///     before committing to 3-up so the sidebar + nav rail haven't
///     eaten our content area).
///   - >= NARROW_BREAKPOINT_PX → 2 columns (mid-range laptops).
///   - below                  → 1 column (tablets / sidebar-collapsed
///     narrow shells reverts to the original single-file fly-through).
const WIDE_BREAKPOINT_PX = 1300;
const NARROW_BREAKPOINT_PX = 900;

/// Compute the active column count for the current viewport. Used
/// by both the maxScroll calculation (row-count → scrollable
/// distance) AND the per-frame card-position math. SSR-safe via
/// the `typeof window` guard.
function activeCardsPerRow(): number {
  if (typeof window === "undefined") return 3;
  if (window.innerWidth >= WIDE_BREAKPOINT_PX) return 3;
  if (window.innerWidth >= NARROW_BREAKPOINT_PX) return 2;
  return 1;
}

/// Horizontal centre-to-centre distance between adjacent cards
/// within a row. Card width is 266px (see ChallengesView.css). 300
/// leaves a ~34px gap between neighbours so adjacent cards don't
/// feel glued together. Ignored when `activeCardsPerRow() === 1`
/// (single-column layout puts every card on the world's X
/// origin).
const X_SPACING = 300;

/// Z-distance between adjacent ROWS in the 3D stack. Bigger
/// values spread the rows further apart along the camera axis
/// (more "fly-through" feel); smaller values pack them tighter.
/// Dropped from the pre-grid 700px → 500px because rows now
/// contain 3 cards each — each row is "denser" visually, so a
/// shorter Z gap still feels cinematic without burying rows
/// behind their neighbours' depth blur.
const Z_GAP = 500;

/// Per-card jitter amounts — applied on top of the grid position
/// to break the rigid column/row pattern into a scattered, more
/// abstract field. Each value is the maximum +/- the per-card
/// hash can pull a coordinate by. Jitter is deterministic
/// (hashed from card idx) so a given card lives at the same
/// scattered position every render — there's no per-frame
/// twitch, just a stable scatter that reads as "thrown" rather
/// than "gridded."
///
/// JITTER_X — ±90px lets cards in adjacent columns visibly
///   overlap, so when you fly through a row you see cards
///   peek out from behind their neighbours rather than seeing
///   a tidy comb of three.
/// JITTER_Y — ±90px varies vertical heights so a row isn't a
///   ruler-flat line; some cards sit higher in the viewport,
///   some lower, simulating "thrown" placement.
/// JITTER_Z — ±200px (40% of Z_GAP) pulls cards forward / back
///   from their row's natural Z plane, so cards from one row
///   can sit IN FRONT of cards from the next row — that's what
///   produces the "see cards behind others" effect during a
///   scroll-through.
/// JITTER_ROT — ±2.5deg adds a static skew on top of the per-
///   frame sine-wave wobble so cards don't all share a single
///   "upright" baseline.
const JITTER_X = 90;
const JITTER_Y = 90;
const JITTER_Z = 200;
const JITTER_ROT = 2.5;

/// Deterministic 0..1 hash from (idx, seed) — FNV-1a flavored.
/// Stable across frames so a card's jitter doesn't twitch; cheap
/// enough to call several times per card per frame.
function hash01(idx: number, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  h = Math.imul(h ^ idx, 0x01000193) >>> 0;
  h = Math.imul(h ^ (idx >>> 8), 0x01000193) >>> 0;
  h = Math.imul(h ^ ((seed << 13) ^ idx), 0x01000193) >>> 0;
  return ((h >>> 0) % 100000) / 100000;
}

/// Same hash mapped to -1..1 so the caller can multiply by a
/// jitter magnitude to get a signed offset.
function hashSigned(idx: number, seed: number): number {
  return hash01(idx, seed) * 2 - 1;
}

/// Scroll-position → camera-Z multiplier. Higher = scrolling
/// covers more Z distance per wheel-tick. 1.4 felt natural with
/// a Magic Mouse / trackpad; 1.0 felt sluggish.
const CAM_SPEED = 1.4;

/// Lerp weight for the smooth-scroll. Lower = heavier / more
/// inertia (Lenis defaults to 0.1). 0.08 matches the demo's
/// "heavy feel" — wheel events queue up and ease in over ~150ms.
const SCROLL_LERP = 0.08;

/// Fade-in distance: cards fully transparent further than
/// `FADE_IN_FAR` behind the camera, opacity ramps to 1 by
/// `FADE_IN_NEAR`. Keeps the far horizon clean instead of
/// painting hundreds of stacked invisible cards.
const FADE_IN_FAR = -2400;
const FADE_IN_NEAR = -1600;

/// Fade-out: cards past the camera (positive Z) fade out
/// before disappearing. The gap between 80 and 320 lets the
/// learner see a card start to pass them before it dissolves —
/// reads as natural depth perception.
const FADE_OUT_NEAR = 80;
const FADE_OUT_FAR = 320;

export default function ChallengesView({
  courses,
  completed,
  onOpenLesson,
  onResetCourse,
}: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  /// Right-click context-menu state. Mirrors the Sidebar's pattern:
  /// a single floating menu portalled to body, positioned at the
  /// cursor, dismissed by click-outside / Escape / scroll. Only
  /// surfaces "Reset progress" since that's the one action the
  /// Challenges grid is missing today; if more actions ever land
  /// here (export, settings, delete) extract `ContextMenu` into a
  /// shared component first.
  const [packMenu, setPackMenu] = useState<{
    courseId: string;
    courseTitle: string;
    x: number;
    y: number;
  } | null>(null);

  /// Dismiss the pack menu on any outside click, Escape, or scroll.
  /// Same UX contract as the Sidebar's per-course menu — keeping
  /// them consistent matters because both menus reach into the same
  /// `clearCourseCompletions` action; a learner who used one knows
  /// what the other does.
  useEffect(() => {
    if (!packMenu) return;
    const dismiss = () => setPackMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("click", dismiss);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [packMenu]);

  /// Single entry-point the card renderers call when they see a
  /// right-click. Only opens for real packs (synthetic curated
  /// tracks have no `courseId` to reset) AND only when the host
  /// wired `onResetCourse` — otherwise the menu would render
  /// empty.
  const openPackMenu = onResetCourse
    ? (courseId: string, e: React.MouseEvent) => {
        const pack = courses.find((c) => c.id === courseId);
        if (!pack) return;
        e.preventDefault();
        setPackMenu({
          courseId,
          courseTitle: pack.title,
          x: e.clientX,
          y: e.clientY,
        });
      }
    : undefined;

  // Tracks-page mode, persisted to sessionStorage so the
  // "you've already seen the intro" state survives in-session
  // navigations but resets on every cold launch — the next time
  // the learner opens the app and clicks Tracks, the hyper-scroll
  // intro replays. Default "hyper" for fresh sessions; flips to
  // "grid" once the learner scrolls past the last hyper card.
  // The hook handles SSR / private-mode reads safely.
  const [mode, setMode] = useSessionStorageState<TracksMode>(
    TRACKS_MODE_KEY,
    "hyper",
    {
      serialize: (v) => v,
      deserialize: (raw) => (raw === "grid" ? "grid" : "hyper"),
    },
  );

  // One-shot cleanup of the legacy localStorage key. Users who
  // ran an older build had `libre:tracks-mode = "grid"` written
  // to localStorage permanently — leaving that around would do
  // nothing on its own (we read sessionStorage now), but kicking
  // it out keeps the user's storage tidy and prevents confusion
  // if some future migration tries to read the same key.
  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_TRACKS_MODE_KEY);
    } catch {
      /* private-browsing — no-op */
    }
  }, []);

  // Source list: every installed challenge-pack course, mapped
  // onto the `LearningTrack` shape the carousel renderers
  // expect. The old curated `TRACKS` data has been retired —
  // each card now represents a real challenge pack the learner
  // already has installed, and clicking a card drops them into
  // the pack's first incomplete lesson instead of a separate
  // "track detail" landing page. Kept on a memo keyed by the
  // courses list so re-renders during scroll don't re-allocate
  // the synthetic track objects each frame.
  // Tracks rail surfaces BOTH `packType: "challenges"` (per-language
  // exercise packs) AND `packType: "track"` (Exercism-style
  // curriculums) — Notion issue #b6fef5af1fa276d1 flagged that the
  // Exercism track was missing from this view. The `challengePackAsTrack`
  // adapter is shape-agnostic (it only reads pack.id / title /
  // chapters), so both pack types feed it cleanly.
  const challengeTracks = useMemo<readonly LearningTrack[]>(() => {
    // Featured languages for the In-house Challenges section
    // (Notion follow-up: "rework the default challenges to
    // support some for JS, Rust, Zig and Go in the default").
    // These four sort to the head of the challenges bucket; the
    // rest follow alphabetically. Exercism tracks sort
    // alphabetically among themselves and follow the entire
    // challenges block — the order is: featured challenges →
    // non-featured challenges → Exercism tracks. Applying the
    // sort once at the source keeps the hyper-view intro
    // (first 8 cards) and the grid sections agreeing on order.
    const FEATURED_LANGS = ["javascript", "rust", "zig", "go"] as const;
    const featuredRank = (lang: string | undefined | null): number => {
      const l = (lang ?? "").toLowerCase();
      const idx = FEATURED_LANGS.indexOf(
        l as (typeof FEATURED_LANGS)[number],
      );
      return idx >= 0 ? idx : FEATURED_LANGS.length;
    };
    const adapted = courses
      .filter(
        (c) =>
          isChallengePack(c) ||
          isExerciseTrack(c) ||
          isKoans(c) ||
          isLings(c),
      )
      .map((pack) => ({
        track: challengePackAsTrack(pack),
        kind: (isChallengePack(pack)
          ? "challenges"
          : isLings(pack)
          ? "lings"
          : isKoans(pack)
          ? "koans"
          : "track") as "challenges" | "track" | "koans" | "lings",
        language: pack.language ?? null,
      }));
    // Four-bucket ordering: Exercism tracks first (curated, the
    // historical headline of this page), then the famous *lings
    // family, then koans (both sequential fix-it / fill-in exercise
    // paths), then in-house challenge packs. Reordered from the
    // prior three-bucket layout when the V28 *lings relocation
    // landed.
    const kindRank = {
      track: 0,
      lings: 1,
      koans: 2,
      challenges: 3,
    } as const;
    adapted.sort((a, b) => {
      if (a.kind !== b.kind) return kindRank[a.kind] - kindRank[b.kind];
      if (a.kind === "challenges") {
        const ra = featuredRank(a.language);
        const rb = featuredRank(b.language);
        if (ra !== rb) return ra - rb;
      }
      return a.track.title.localeCompare(b.track.title);
    });
    return adapted.map((row) => row.track);
  }, [courses]);
  // Side-table from track id → pack kind so the grid renderer can
  // split its output into two sections ("In-house challenges" vs
  // "Exercism tracks") without having to drag the original Course
  // object through every level. `LearningTrack` itself stays clean —
  // the shape is shared with the curated `TRACKS` data and we don't
  // want a kind discriminator leaking out there.
  const trackKindById = useMemo(() => {
    const map = new Map<string, "challenges" | "track" | "koans" | "lings">();
    for (const c of courses) {
      if (isChallengePack(c)) map.set(c.id, "challenges");
      else if (isLings(c)) map.set(c.id, "lings");
      else if (isKoans(c)) map.set(c.id, "koans");
      else if (isExerciseTrack(c)) map.set(c.id, "track");
    }
    return map;
  }, [courses]);

  // Per-pack progress (0..1). Computed once per render and passed
  // into the card body via `progressOverride` so the card can
  // display the right fill without trying to walk SkillTree nodes
  // — the synthetic tracks have an empty `steps` array and the
  // tree-walking path would always return 0.
  const packProgress = useMemo(() => {
    const map = new Map<string, number>();
    for (const pack of courses) {
      // Mirror the filter in `challengeTracks` above — keep
      // progress in sync across challenges, Exercism tracks,
      // koans, and *lings.
      if (
        !isChallengePack(pack) &&
        !isExerciseTrack(pack) &&
        !isKoans(pack) &&
        !isLings(pack)
      )
        continue;
      let total = 0;
      let done = 0;
      for (const ch of pack.chapters) {
        for (const lesson of ch.lessons) {
          total += 1;
          if (completed.has(`${pack.id}:${lesson.id}`)) done += 1;
        }
      }
      map.set(pack.id, total === 0 ? 0 : done / total);
    }
    return map;
  }, [courses, completed]);

  // Filter the challenge-pack carousel by the search input. The
  // match runs over title / short / outcome / description /
  // difficulty so a query like "rust" finds the Rust pack,
  // "challenge" or any common token still matches every pack.
  // Falls through to the full list when empty.
  const visibleTracks = useMemo<readonly LearningTrack[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return challengeTracks;
    return challengeTracks.filter((t) => {
      const hay = [
        t.title,
        t.short,
        t.outcome,
        t.description,
        t.difficulty,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [query, challengeTracks]);

  // Open a challenge pack by id — find the first incomplete
  // lesson in that pack and hand off to App's lesson router.
  // No TrackDetail intermediate page any more; challenge packs
  // are flat lesson lists and a learner clicking a card wants
  // to start the next problem, not read a curated description.
  const handleOpenPack = (id: string) => {
    const pack = courses.find((c) => c.id === id);
    if (!pack) return;
    const next = firstIncompleteLesson(pack, completed);
    if (next) onOpenLesson(next.courseId, next.lessonId);
  };

  // The end-of-hyper handoff: when the hyper-scroll reports the
  // learner has reached its last card, flip to grid permanently.
  // Wrapped in a guard so the handler is a no-op if we somehow
  // get repeat fires from the rAF loop — `setMode` is idempotent
  // either way, but skipping the localStorage write on no-ops
  // is cheaper.
  const handleReachedEnd = () => {
    if (mode !== "grid") setMode("grid");
  };

  // Outer container ref — the hyper-scroll's rAF loop writes a
  // `--tracks-end-progress` CSS variable here every frame (0..1
  // based on how close to the last row the camera has flown).
  // CSS uses that variable to fade the grid overlay in as the
  // learner approaches 100% scroll, instead of the previous
  // hard switch that snapped the hyper view out and the grid
  // in at the moment the end fired.
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Curated card set for the hyper intro: interleaves Exercism
  // tracks with *lings, koans, and in-house challenge packs so the
  // fly-through alternates between the four catalogues instead of
  // leading with an all-Exercism block. Cap at 7 cards (Notion
  // follow-up "only show about 7 total challenges so we scroll
  // through faster"). The grid mode underneath still receives the
  // full `visibleTracks` list, so the cap only narrows the intro.
  //
  // Algorithm:
  //   1. Split `visibleTracks` into exercism / lings / koans /
  //      in-house buckets, preserving the source sort within each.
  //   2. Round-robin draw — track, ling, koan, challenge — until
  //      any bucket runs out, then drain the remainders in the
  //      same order.
  //   3. Slice to HYPER_CAP.
  const HYPER_CAP = 7;
  const hyperTracks = useMemo<readonly LearningTrack[]>(() => {
    const ex: LearningTrack[] = [];
    const li: LearningTrack[] = [];
    const ko: LearningTrack[] = [];
    const ch: LearningTrack[] = [];
    for (const t of visibleTracks) {
      const kind = trackKindById.get(t.id);
      if (kind === "track") ex.push(t);
      else if (kind === "lings") li.push(t);
      else if (kind === "koans") ko.push(t);
      else if (kind === "challenges") ch.push(t);
    }
    const mixed: LearningTrack[] = [];
    let ei = 0;
    let li_i = 0;
    let ki = 0;
    let ci = 0;
    while (
      mixed.length < HYPER_CAP &&
      (ei < ex.length ||
        li_i < li.length ||
        ki < ko.length ||
        ci < ch.length)
    ) {
      if (ei < ex.length) mixed.push(ex[ei++]);
      if (mixed.length >= HYPER_CAP) break;
      if (li_i < li.length) mixed.push(li[li_i++]);
      if (mixed.length >= HYPER_CAP) break;
      if (ki < ko.length) mixed.push(ko[ki++]);
      if (mixed.length >= HYPER_CAP) break;
      if (ci < ch.length) mixed.push(ch[ci++]);
    }
    return mixed;
  }, [visibleTracks, trackKindById]);

  return (
    <div ref={rootRef} className={`libre-challenges libre-challenges--${mode}`}>
      <TracksHeader query={query} onQueryChange={setQuery} mode={mode} />
      {/* Content wrapper — flex: 1 + position: relative so the
          grid overlay can absolutely position over JUST the
          hyper viewport area (excluding the header) and the
          inner grid-wrap's `flex: 1` resolves against a flex
          parent. Without this wrapper, the overlay covered the
          header AND the grid-wrap had no flex context, so the
          grid stretched to its natural content height and
          appeared zoomed-in / clipped. */}
      <div className="libre-challenges__content">
        {mode === "hyper" ? (
          <>
            <TracksHyperScroll
              // Mixed + capped curated set — see the `hyperTracks`
              // memo above. Interleaves Exercism with in-house
              // challenges so the fly-through alternates instead
              // of leading with one bucket, and caps at 7 so the
              // intro scrolls past quickly.
              tracks={hyperTracks}
              completed={completed}
              onOpenTrack={handleOpenPack}
              onReachedEnd={handleReachedEnd}
              progressTargetRef={rootRef}
              progressOverrides={packProgress}
              onContextMenuTrack={openPackMenu}
            />
            {/* "Keep scrolling" overlay — fades in over the tail
                of the hyper carousel via the `--tracks-end-progress`
                CSS variable the hyper-scroll writes on the rootRef
                each frame. Sits above the cards but below the grid
                overlay, pointer-events: none so it doesn't
                intercept the scroll wheel that's driving its own
                appearance. Only renders when the hyper view is
                showing a subset of the full catalogue (the cap
                kicked in). */}
            {visibleTracks.length > hyperTracks.length && (
              <div className="libre-challenges__scroll-hint" aria-hidden>
                Keep scrolling →
              </div>
            )}
            {/* Grid overlay — rendered concurrently with the
                hyper view during the final stretch of scroll so
                the two layers can crossfade. Pointer-events are
                gated by CSS so the overlay only accepts clicks
                once it's fully opaque (mode flips to "grid" at
                end-reached and the hyper view unmounts). */}
            <div className="libre-challenges__grid-overlay" aria-hidden>
              <ChallengesGrid
                tracks={visibleTracks}
                completed={completed}
                onOpenTrack={handleOpenPack}
                progressOverrides={packProgress}
                onContextMenuTrack={openPackMenu}
              />
            </div>
          </>
        ) : (
          <ChallengesGrid
            tracks={visibleTracks}
            completed={completed}
            onOpenTrack={handleOpenPack}
            progressOverrides={packProgress}
            kindByTrackId={trackKindById}
            onContextMenuTrack={openPackMenu}
          />
        )}
      </div>

      {/* Pack-card right-click menu. Reuses the Sidebar's
          `libre__context-menu` styles (Sidebar.css is loaded
          globally since the rail is always mounted alongside
          this view) so the affordance reads identically across
          surfaces. Portalled to body so the Challenges grid's
          overflow / transform stack can't clip it. */}
      {packMenu && onResetCourse && createPortal(
        <div
          className="libre__context-menu"
          style={{ left: packMenu.x, top: packMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="libre__context-menu-label">
            {packMenu.courseTitle}
          </div>
          <button
            type="button"
            className="libre__context-menu-item"
            onClick={() => {
              onResetCourse(packMenu.courseId);
              setPackMenu(null);
            }}
          >
            <span className="libre__context-menu-icon" aria-hidden>
              <Icon icon={rotateCcw} size="xs" color="currentColor" />
            </span>
            {t("sidebar.ctxResetProgress")}
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

/// Top strip: title + blurb + search input. Sits above the
/// scroll surface so it stays readable as cards fly past
/// behind it (hyper mode) or above the card grid (grid mode).
/// The search input is the only interactive element up here —
/// the title block is decorative. Blurb copy adapts per mode
/// so the hyper-mode prose ("scroll the catalogue") doesn't
/// confuse a grid-mode visitor who isn't seeing a scroll.
function TracksHeader({
  query,
  onQueryChange,
  mode,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  mode: TracksMode;
}) {
  const t = useT();
  return (
    <header className="libre-challenges__header">
      <div className="libre-challenges__header-text">
        <h1 className="libre-challenges__title">{t("challenges.title")}</h1>
        <p className="libre-challenges__blurb">
          {mode === "hyper" ? t("challenges.blurbHyper") : t("challenges.blurbGrid")}
        </p>
      </div>
      <div className="libre-challenges__search">
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={t("challenges.searchPlaceholder")}
          aria-label={t("challenges.ariaSearch")}
          className="libre-challenges__search-input"
        />
        {query && (
          <button
            type="button"
            className="libre-challenges__search-clear"
            onClick={() => onQueryChange("")}
            aria-label={t("challenges.ariaClear")}
          >
            <Icon icon={xIcon} size="xs" color="currentColor" />
          </button>
        )}
      </div>
    </header>
  );
}

/// 3D scroll surface. Owns the rAF loop, the wheel listener,
/// the mouse-parallax listener, and the per-frame transform
/// writes against each card's DOM node. Fires `onReachedEnd`
/// once when the smoothed scroll converges to the last row —
/// the App promotes the page to grid mode in response, which
/// unmounts this component.
function TracksHyperScroll({
  tracks,
  completed,
  onOpenTrack,
  onReachedEnd,
  progressTargetRef,
  progressOverrides,
  onContextMenuTrack,
}: {
  tracks: readonly LearningTrack[];
  completed: Set<string>;
  onOpenTrack: (id: string) => void;
  onReachedEnd: () => void;
  /// Element to receive the per-frame `--tracks-end-progress`
  /// CSS variable (0..1 = fraction of maxScroll covered). The
  /// parent uses this to fade in a grid overlay as the learner
  /// approaches the end of the carousel, without any React
  /// state updates per frame. Optional — when absent, the rAF
  /// loop just skips the variable write.
  progressTargetRef?: MutableRefObject<HTMLElement | null>;
  /// Per-card progress overrides keyed by `track.id` (0..1).
  /// Used for challenge packs, whose synthetic LearningTrack
  /// has an empty `steps` array — `trackProgressPercent` would
  /// always return 0 because the tree-walker has no steps to
  /// resolve. When this map provides a value for a card's id,
  /// the card displays that progress instead of running the
  /// tree-walk fallback.
  progressOverrides?: ReadonlyMap<string, number>;
  /// Right-click on a card → host opens the pack-actions menu at
  /// the cursor. Optional; when absent the card is plain
  /// click-to-open with no menu.
  onContextMenuTrack?: (courseId: string, e: React.MouseEvent) => void;
}) {
  // Capture latest `onReachedEnd` in a ref so the rAF effect
  // below doesn't rebuild every render. The handler closes over
  // App's `setMode`, which is stable, but defensive against
  // future inlined callbacks.
  const onReachedEndRef = useRef(onReachedEnd);
  useEffect(() => {
    onReachedEndRef.current = onReachedEnd;
  }, [onReachedEnd]);
  // One-shot latch — once we've fired the end handoff, don't
  // fire again. Without this the smooth-scroll's residual
  // oscillation around `maxScroll` (lerp can take a few extra
  // frames to settle exactly) would call the handler multiple
  // times, triggering `setMode` repeatedly and burning state
  // updates.
  const reachedEndOnceRef = useRef(false);
  // Physics state — refs (not state) so the rAF loop doesn't
  // re-render every frame.
  const targetScroll = useRef(0); // accumulates wheel deltas
  const smoothScroll = useRef(0); // lerped toward target
  const velocity = useRef(0); // signed delta per frame
  const mouseX = useRef(0); // -1..1 from screen center
  const mouseY = useRef(0); // -1..1

  // HUD readout — only piece of state we actually re-render
  // (and only at ~10Hz; otherwise the React tree thrashes).
  const [velReadout, setVelReadout] = useState(0);
  const [posReadout, setPosReadout] = useState(0);

  // DOM refs for the elements we mutate in rAF.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  // Map<trackId, HTMLElement> so we can apply per-card
  // transforms without iterating world.children (which would
  // include any pseudo elements / future siblings).
  const cardRefs = useRef(new Map<string, HTMLElement>());

  // Responsive column count. State so the rAF effect re-runs when
  // the viewport crosses the breakpoint (the effect closes over
  // `cardsPerRow`, so re-creating it picks up the new layout
  // without having to bust + rebuild every per-frame closure
  // manually). Initialised from the current viewport so the FIRST
  // render places cards correctly — without the initial read the
  // hyper view would paint at the default (2-col) for one frame
  // before the resize handler kicked in.
  const [cardsPerRow, setCardsPerRow] = useState<number>(() =>
    activeCardsPerRow(),
  );
  useEffect(() => {
    const onResize = () => {
      const next = activeCardsPerRow();
      // `setCardsPerRow` short-circuits when value unchanged, so
      // we can call it on every resize without thrashing renders.
      setCardsPerRow(next);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const trackCount = tracks.length;
  // Total scrollable Z distance. Add 600px tail so the LAST
  // card can fly past the camera before scroll clamps; without
  // it the user can't see the final card in its pass-through
  // position.
  // Scroll bounds are driven by the ROW count (not the card
  // count) — `ceil(trackCount / cardsPerRow)` rounds a partial
  // last row up to a full one so the scroll still terminates
  // cleanly past the bottom row even when trackCount isn't
  // divisible by `cardsPerRow`.
  const rowCount = Math.ceil(trackCount / cardsPerRow);
  // Tail buffer extended from 600 → 800 to cover the worst-case
  // Z-jittered card: a card whose per-card hash pushes it
  // JITTER_Z further back than its row's natural Z needs
  // ~JITTER_Z / CAM_SPEED extra scroll to fly past the camera.
  // 800 covers that comfortably without leaving an awkward
  // dead-air stretch at the end.
  const maxScroll = Math.max(0, (rowCount - 1) * (Z_GAP / CAM_SPEED) + 800);

  useEffect(() => {
    const viewport = viewportRef.current;
    const world = worldRef.current;
    if (!viewport || !world) return;

    let raf = 0;
    let mounted = true;

    // Wheel handler — accumulate deltaY into target scroll,
    // clamped to [0, maxScroll] so the user can't scroll past
    // the start or end. preventDefault stops the parent page
    // from also scrolling.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      targetScroll.current = Math.max(
        0,
        Math.min(maxScroll, targetScroll.current + e.deltaY),
      );
    };

    const onMouseMove = (e: MouseEvent) => {
      // Normalise to -1..1 from the viewport center. We use
      // the viewport bounding rect (not window) so parallax
      // stays calibrated when the sidebar collapses + the
      // surface re-flows wider.
      const rect = viewport.getBoundingClientRect();
      mouseX.current = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
      mouseY.current = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
    };

    // Reset parallax when the cursor leaves the surface so
    // the world doesn't lock at the last seen tilt.
    const onMouseLeave = () => {
      mouseX.current = 0;
      mouseY.current = 0;
    };

    let hudTick = 0;

    const tick = (time: number) => {
      if (!mounted) return;

      // 1. Lerp the smoothed scroll toward the target, then
      //    derive velocity from the per-frame delta. Higher
      //    SCROLL_LERP = snappier; lower = heavier inertia.
      const prevSmooth = smoothScroll.current;
      smoothScroll.current += (targetScroll.current - prevSmooth) * SCROLL_LERP;
      velocity.current = smoothScroll.current - prevSmooth;

      // Per-frame end-of-scroll progress. Written as a CSS
      // variable on the parent so the grid-overlay can fade in
      // via pure CSS without React re-renders. `maxScroll` can
      // be 0 in pathological cases (zero tracks, search filter
      // emptied the list); guard against the divide-by-zero so
      // the variable stays well-formed.
      if (progressTargetRef?.current) {
        const progress =
          maxScroll > 0
            ? Math.min(1, Math.max(0, smoothScroll.current / maxScroll))
            : 0;
        progressTargetRef.current.style.setProperty(
          "--tracks-end-progress",
          progress.toFixed(3),
        );
      }

      // 2. Camera tilt — combines mouse parallax (so the
      //    world leans slightly toward the cursor) with a
      //    scroll-velocity pitch (the world tilts forward
      //    when the learner accelerates). Multipliers are
      //    small (single-digit degrees) so the effect reads
      //    as "alive" rather than "drunk."
      const tiltX = mouseY.current * 4 - velocity.current * 0.08;
      const tiltY = mouseX.current * 4;
      world.style.transform = `rotateX(${tiltX.toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg)`;

      // 3. Dynamic perspective — narrower FOV when scrolling
      //    fast creates a "warp through hyperspace" effect.
      //    Clamped so a very long flick doesn't collapse the
      //    FOV to zero (which would render everything at
      //    infinite z and break the scene).
      const speed = Math.abs(velocity.current);
      const fov = 1400 - Math.min(speed * 5, 700);
      viewport.style.perspective = `${fov.toFixed(0)}px`;

      // 4. Per-card transforms. cameraZ is the scroll position
      //    in Z space; each card's vizZ is (baseZ + cameraZ).
      //    Cards far behind the camera or past it fade out;
      //    the opacity logic is cheap arithmetic so it can
      //    run every frame against every card.
      const cameraZ = smoothScroll.current * CAM_SPEED;
      const t = time * 0.001;
      cardRefs.current.forEach((el) => {
        const idx = Number(el.dataset.idx ?? 0);
        // Deterministic per-card jitter — same hash inputs always
        // produce the same offset, so cards stay anchored at their
        // "thrown" position from frame to frame instead of dancing.
        // Four independent seeds keep X / Y / Z / rotation
        // uncorrelated so the scatter doesn't fall into a visible
        // axis-aligned pattern.
        const jx = hashSigned(idx, 1) * JITTER_X;
        const jy = hashSigned(idx, 2) * JITTER_Y;
        const jz = hashSigned(idx, 3) * JITTER_Z;
        const jrot = hashSigned(idx, 4) * JITTER_ROT;

        // Grid scaffold: column drives X, row drives Z. The
        // scatter on top of this scaffold means cards from the
        // same row no longer sit on a perfect line, and a card
        // from row N+1 can come forward to sit IN FRONT of a row
        // N card thanks to the Z jitter — which is what gives the
        // surface its "see cards peeking out from behind others"
        // feel during the scroll.
        const col = idx % cardsPerRow;
        const row = Math.floor(idx / cardsPerRow);
        const baseZ = -row * Z_GAP + jz;
        const vizZ = baseZ + cameraZ;

        // Opacity: fade in from far, fade out as it passes
        // the camera.
        let alpha = 1;
        if (vizZ < FADE_IN_NEAR) {
          alpha = Math.max(
            0,
            (vizZ - FADE_IN_FAR) / (FADE_IN_NEAR - FADE_IN_FAR),
          );
        } else if (vizZ > FADE_OUT_NEAR) {
          alpha = Math.max(
            0,
            1 - (vizZ - FADE_OUT_NEAR) / (FADE_OUT_FAR - FADE_OUT_NEAR),
          );
        }

        // Skip layout work for fully-transparent cards —
        // skipping cuts the per-frame cost when the
        // catalogue is large.
        if (alpha <= 0.001) {
          if (el.style.opacity !== "0") el.style.opacity = "0";
          return;
        }

        // X position: column-anchored, then scattered by the
        // per-card jitter so adjacent columns visibly overlap
        // instead of sitting in three tidy stripes.
        const xOffset = (col - (cardsPerRow - 1) / 2) * X_SPACING + jx;

        // Gentle idle float — sine wave over time, phased by
        // both row AND column so cards in the same row aren't
        // bobbing in lockstep (which would have read as a
        // single rigid line moving). Velocity dampens the float
        // when scrolling fast so the cards don't also bob,
        // which would feel chaotic.
        const floatDamp = Math.max(0, 1 - speed * 0.02);
        const phase = row * 0.5 + col * 0.9 + hash01(idx, 5) * 6.28;
        const yFloat = Math.sin(t + phase) * 8 * floatDamp;
        const rotZ = Math.sin(t * 0.7 + phase) * 1.5 * floatDamp;

        // Final Y combines the gentle per-frame float with the
        // static per-card jitter; final rotation likewise
        // combines the slow sine-wobble with the static skew.
        const finalY = yFloat + jy;
        const finalRot = rotZ + jrot;

        el.style.opacity = alpha.toFixed(3);
        el.style.transform = `translate3d(${xOffset.toFixed(2)}px, ${finalY.toFixed(2)}px, ${vizZ.toFixed(2)}px) rotateZ(${finalRot.toFixed(2)}deg)`;
      });

      // 5. HUD readouts — update every ~6 frames so the
      //    digits don't jitter at 60fps. The HUD itself is
      //    decorative; an out-of-date by one frame value is
      //    fine.
      hudTick += 1;
      if (hudTick % 6 === 0) {
        setVelReadout(Math.abs(velocity.current));
        setPosReadout(
          maxScroll > 0
            ? Math.round((smoothScroll.current / maxScroll) * 100)
            : 0,
        );
      }

      // 6. End-of-tour detection. When the smooth scroll has
      //    converged to within 2px of `maxScroll` AND the user
      //    has actually scrolled (targetScroll > 0 — guards
      //    the trivial "catalogue is one screen tall" case),
      //    fire `onReachedEnd` exactly once via the latch.
      //    The ChallengesView parent flips mode → "grid" in
      //    response, which unmounts this surface entirely —
      //    so we don't need to worry about cleanup.
      if (
        !reachedEndOnceRef.current &&
        maxScroll > 0 &&
        targetScroll.current > 0 &&
        smoothScroll.current >= maxScroll - 2
      ) {
        reachedEndOnceRef.current = true;
        onReachedEndRef.current();
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    viewport.addEventListener("wheel", onWheel, { passive: false });
    viewport.addEventListener("mousemove", onMouseMove);
    viewport.addEventListener("mouseleave", onMouseLeave);

    return () => {
      mounted = false;
      cancelAnimationFrame(raf);
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("mousemove", onMouseMove);
      viewport.removeEventListener("mouseleave", onMouseLeave);
    };
    // `cardsPerRow` is captured in the closure above (drives the
    // per-frame col / row math). Listing it explicitly here keeps
    // the effect honest in case a future refactor breaks the
    // assumption that `maxScroll` always changes when
    // `cardsPerRow` does.
  }, [maxScroll, cardsPerRow]);

  // Clamp targetScroll back into range when the visible set
  // changes shape (a long search-filtered list scrolled to the
  // end, then cleared, would otherwise leave the camera
  // floating past the new last card).
  useEffect(() => {
    if (targetScroll.current > maxScroll) {
      targetScroll.current = maxScroll;
    }
  }, [maxScroll]);

  if (trackCount === 0) {
    return (
      <div className="libre-challenges__empty">
        <p>No tracks match this search.</p>
      </div>
    );
  }

  return (
    <div ref={viewportRef} className="libre-challenges__viewport">
      <div ref={worldRef} className="libre-challenges__world">
        {tracks.map((track, idx) => (
          <HyperCard
            key={track.id}
            track={track}
            index={idx}
            completed={completed}
            onOpen={() => onOpenTrack(track.id)}
            onContextMenu={
              onContextMenuTrack
                ? (e) => onContextMenuTrack(track.id, e)
                : undefined
            }
            progressOverride={progressOverrides?.get(track.id)}
            registerRef={(el) => {
              if (el) cardRefs.current.set(track.id, el);
              else cardRefs.current.delete(track.id);
            }}
          />
        ))}
      </div>
      <TracksHud
        velocity={velReadout}
        positionPct={posReadout}
        smoothScroll={smoothScroll}
      />
    </div>
  );
}

/// The actual card visual — head / body / foot / progress.
/// Shared between hyper mode (where it's wrapped in a slot
/// that gets per-frame `translate3d` writes) and grid mode
/// (where it sits directly in a CSS grid cell). `variant`
/// drives one CSS modifier so the card can opt out of the
/// 3D-centric `translate(-50%, -50%)` baseline when it's
/// being laid out by a normal flow.
function TrackCardBody({
  track,
  index,
  completed,
  onOpen,
  onContextMenu,
  variant,
  progressOverride,
}: {
  track: LearningTrack;
  index: number;
  completed: Set<string>;
  onOpen: () => void;
  /// Right-click handler — host opens its pack-actions menu at
  /// the cursor. Optional; when absent the card is plain
  /// click-to-open with no menu (preserves the previous behaviour
  /// for callers that haven't wired the new pathway).
  onContextMenu?: (e: React.MouseEvent) => void;
  variant: "hyper" | "grid";
  /// Optional 0..1 progress fraction supplied by the caller.
  /// When present, the card uses it verbatim instead of running
  /// the SkillTree-based `trackProgressPercent` resolver. This
  /// is the path challenge-pack cards take — their synthetic
  /// LearningTrack has no `steps`, so the resolver would read 0.
  progressOverride?: number;
}) {
  const pct =
    progressOverride != null
      ? Math.round(Math.max(0, Math.min(1, progressOverride)) * 100)
      : trackProgressPercent(track, TREES, completed);
  const stepCount = track.steps.length;
  // `stepCount === 0` is the synthetic-track case (challenge packs)
  // — suppress the misleading "0 steps" cell entirely rather than
  // render it. The card body's outcome line already mentions the
  // lesson count for those packs.
  const meta = [
    stepCount > 0
      ? `${stepCount} step${stepCount === 1 ? "" : "s"}`
      : null,
    track.estimatedHours ? `~${track.estimatedHours}h` : null,
    track.difficulty,
  ].filter(Boolean);

  return (
    <button
      type="button"
      className={`libre-challenges__card libre-challenges__card--${variant}`}
      style={{ "--track-accent": track.accent } as CSSProperties}
      onClick={onOpen}
      onContextMenu={onContextMenu}
    >
      <div className="libre-challenges__card-head">
        <span className="libre-challenges__card-tag">
          <span aria-hidden className="libre-challenges__card-tag-icon">
            <Icon
              icon={swords}
              size="xs"
              color="currentColor"
              weight="bold"
            />
          </span>
          <span>{track.short}</span>
        </span>
        <span className="libre-challenges__card-index">
          {String(index + 1).padStart(2, "0")}
        </span>
      </div>
      <div className="libre-challenges__card-body">
        <h2 className="libre-challenges__card-title">{track.title}</h2>
        <p className="libre-challenges__card-outcome">{track.outcome}</p>
        <p className="libre-challenges__card-desc">{track.description}</p>
      </div>
      <div className="libre-challenges__card-foot">
        <span className="libre-challenges__card-meta">{meta.join(" · ")}</span>
        <span className="libre-challenges__card-pct">{pct}%</span>
      </div>
      <div className="libre-challenges__card-progress" aria-hidden>
        <span
          className="libre-challenges__card-progress-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
    </button>
  );
}

/// Hyper-mode card wrapper. The slot div is the 3D-positioned
/// element the rAF loop writes transforms onto; the inner
/// `TrackCardBody` is the visual. Splitting these lets grid
/// mode reuse the body without the slot.
function HyperCard({
  track,
  index,
  completed,
  onOpen,
  onContextMenu,
  registerRef,
  progressOverride,
}: {
  track: LearningTrack;
  index: number;
  completed: Set<string>;
  onOpen: () => void;
  /// Right-click → host opens its pack-actions menu. Forwarded
  /// straight through to TrackCardBody.
  onContextMenu?: (e: React.MouseEvent) => void;
  registerRef: (el: HTMLElement | null) => void;
  /// 0..1 progress fraction for this card, when the surrounding
  /// renderer already knows the answer (e.g., challenge packs).
  /// Forwarded to TrackCardBody where it short-circuits the tree-
  /// walk that would otherwise read 0 for synthetic tracks.
  progressOverride?: number;
}) {
  return (
    <div
      className="libre-challenges__card-slot"
      data-idx={index}
      ref={registerRef}
    >
      <TrackCardBody
        track={track}
        index={index}
        completed={completed}
        onOpen={onOpen}
        onContextMenu={onContextMenu}
        variant="hyper"
        progressOverride={progressOverride}
      />
    </div>
  );
}

/// Grid mode — a CSS grid of TrackCardBodys. No physics, no rAF
/// loop, no perspective. Renders once the learner has finished
/// the hyper tour (or on subsequent loads after the
/// `libre:tracks-mode` flag flipped to "grid"). The grid uses
/// `repeat(auto-fill, minmax(320px, 1fr))` so the layout adapts
/// to whatever main-pane width the learner happens to have —
/// 3 columns on a wide window, 1 on a narrow sidebar-collapsed
/// view. Each card animates in with a staggered fade so the
/// transition from the hyper view doesn't feel abrupt.
///
/// The grid splits its cards into FOUR labelled sections when
/// `kindByTrackId` is provided:
///   1. Exercism tracks (`packType: "track"`)
///   2. *lings (`packType: "lings"`)
///   3. Koans (`packType: "koans"`)
///   4. In-house challenges (`packType: "challenges"`)
///
/// Without the map (e.g. legacy callers using the curated
/// `TRACKS` data) the grid renders as one unsectioned flow.
function ChallengesGrid({
  tracks,
  completed,
  onOpenTrack,
  onContextMenuTrack,
  progressOverrides,
  kindByTrackId,
}: {
  tracks: readonly LearningTrack[];
  completed: Set<string>;
  onOpenTrack: (id: string) => void;
  /// Right-click on a card → host opens the pack-actions menu at
  /// the cursor. Optional; when absent the cards are plain
  /// click-to-open with no menu.
  onContextMenuTrack?: (courseId: string, e: React.MouseEvent) => void;
  /// Per-card progress overrides keyed by `track.id` (0..1).
  /// See TracksHyperScroll's prop docstring for the rationale —
  /// challenge packs ride this rail because their synthetic
  /// LearningTrack has no `steps` for the tree-walker to count.
  progressOverrides?: ReadonlyMap<string, number>;
  /// Optional pack-kind discriminator. When present, the grid
  /// splits its output into four labelled sections (Exercism
  /// tracks, *lings, koans, in-house challenges). When absent /
  /// empty, the grid renders one flat section.
  kindByTrackId?: ReadonlyMap<
    string,
    "challenges" | "track" | "koans" | "lings"
  >;
}) {
  if (tracks.length === 0) {
    return (
      <div className="libre-challenges__empty">
        <p>No challenges match this search.</p>
      </div>
    );
  }
  // Bucket the tracks. The incoming `tracks` array is already
  // sorted at the source (`ChallengesView.challengeTracks`) — Exercism
  // tracks alphabetically, koans alphabetically, then in-house
  // challenges (featured langs first, rest alphabetical). We just
  // split into kind-buckets here without re-sorting.
  // When `kindByTrackId` isn't supplied (curated TRACKS data, or a
  // sparse search result), fall back to a single unlabelled bucket.
  const challenges: LearningTrack[] = [];
  const exercism: LearningTrack[] = [];
  const lings: LearningTrack[] = [];
  const koans: LearningTrack[] = [];
  const unknown: LearningTrack[] = [];
  for (const t of tracks) {
    const kind = kindByTrackId?.get(t.id);
    if (kind === "challenges") challenges.push(t);
    else if (kind === "track") exercism.push(t);
    else if (kind === "lings") lings.push(t);
    else if (kind === "koans") koans.push(t);
    else unknown.push(t);
  }
  const sections: Array<{ key: string; label: string | null; rows: LearningTrack[] }> = [];
  // Section order: Exercism tracks → *lings → Koans → in-house
  // challenges. Mirrors the source-sort order in
  // `ChallengesView.challengeTracks`.
  if (exercism.length > 0) {
    sections.push({
      key: "exercism",
      label: "Exercism tracks",
      rows: exercism,
    });
  }
  if (lings.length > 0) {
    sections.push({
      key: "lings",
      label: "*lings",
      rows: lings,
    });
  }
  if (koans.length > 0) {
    sections.push({
      key: "koans",
      label: "Koans",
      rows: koans,
    });
  }
  if (challenges.length > 0) {
    sections.push({
      key: "challenges",
      label: "In-house challenges",
      rows: challenges,
    });
  }
  if (unknown.length > 0) {
    // Legacy / curated tracks with no kind annotation. Render
    // unlabelled at the end so they still surface but don't fight
    // the labelled sections for the title row.
    sections.push({ key: "unknown", label: null, rows: unknown });
  }
  // Continuous stagger index across all sections so the
  // "materialise in a wave" effect doesn't reset at each section
  // boundary.
  let staggerIdx = 0;
  return (
    <div className="libre-challenges__grid-wrap">
      {sections.map((sec) => (
        <section key={sec.key} className="libre-challenges__grid-section">
          {sec.label && (
            <h2 className="libre-challenges__grid-section-title">{sec.label}</h2>
          )}
          <div className="libre-challenges__grid">
            {sec.rows.map((track) => {
              const cellIdx = staggerIdx++;
              return (
                <div
                  key={track.id}
                  className="libre-challenges__grid-cell"
                  // Staggered mount delay so the grid materialises
                  // in a wave rather than all-at-once — softens the
                  // hand-off from the hyper view.
                  style={
                    {
                      animationDelay: `${Math.min(cellIdx, 16) * 35}ms`,
                    } as CSSProperties
                  }
                >
                  <TrackCardBody
                    track={track}
                    index={cellIdx}
                    completed={completed}
                    onOpen={() => onOpenTrack(track.id)}
                    onContextMenu={
                      onContextMenuTrack
                        ? (e) => onContextMenuTrack(track.id, e)
                        : undefined
                    }
                    variant="grid"
                    progressOverride={progressOverrides?.get(track.id)}
                  />
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/// Minimal HUD pinned to the bottom-left of the surface. Carries
/// just enough telemetry to make the physics feel intentional
/// (scroll position + velocity) without dressing it up as a
/// sci-fi cockpit. Same monospaced detail font the rest of the
/// app uses for telemetry-ish text.
function TracksHud({
  velocity,
  positionPct,
  smoothScroll,
}: {
  velocity: number;
  positionPct: number;
  // Kept here for callers that might want to render a more
  // detailed read-out later (raw scroll px). Unused for now —
  // the percentage display is enough.
  smoothScroll: MutableRefObject<number>;
}) {
  void smoothScroll;
  return (
    <div className="libre-challenges__hud" aria-hidden>
      <span className="libre-challenges__hud-row">
        <span className="libre-challenges__hud-key">POS</span>
        <span className="libre-challenges__hud-val">
          {positionPct.toString().padStart(3, "0")}%
        </span>
      </span>
      <span className="libre-challenges__hud-row">
        <span className="libre-challenges__hud-key">VEL</span>
        <span className="libre-challenges__hud-val">
          {velocity.toFixed(2)}
        </span>
      </span>
    </div>
  );
}
