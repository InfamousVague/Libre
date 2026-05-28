import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Icon } from "@base/primitives/icon";
import { libraryBig } from "@base/primitives/icon/icons/library-big";
import "@base/primitives/icon/icon.css";
import type { Course, LanguageId } from "../../data/types";
import { isChallengePack, isExerciseTrack, isKoans, isLings } from "../../data/types";
import { track } from "../../lib/track";
import BookCover from "./BookCover";
import LibreLoader from "../Shared/LibreLoader";
import CourseContextMenu, { useCourseMenu } from "../Shared/CourseContextMenu";
import { prefetchCovers } from "../../hooks/useCourseCover";
import { useCourseUpdates } from "../../hooks/useCourseUpdates";
import { useCatalog } from "../../hooks/useCatalog";
import { useLocalStorageState } from "../../hooks/useLocalStorageState";
import {
  placeholderCourseFromCatalog,
  coverHref,
  type CatalogEntry,
} from "../../lib/catalog";
import AddCourseButton from "./AddCourseButton";
import CourseCard from "./CourseCard";
import LibraryControls, {
  type SortKey,
  type ViewMode,
} from "./LibraryControls";
import {
  categorizeCourse,
  cryptoChain,
  dedupeChallengePacks,
  type CourseCategory,
  type CryptoChain,
} from "./categorize";
import { useT } from "../../i18n/i18n";
import "./CourseLibrary.css";

/// Library display mode persistence key. `shelf` = tall 2:3 book-cover
/// cards (the default). `grid` = the information-dense card grid.
/// User's choice persists in localStorage.
///
/// Default is shelf — the chibi-Pixar covers ARE the brand surface, and
/// "what's on my shelf" reads faster than a grid of metadata blocks
/// once the artwork is uniform. Users who explicitly pick grid (and
/// persist that pick) keep it; everyone else lands on shelf. This
/// flips an earlier "grid default" call back to where the design
/// originally landed.
const VIEW_MODE_STORAGE_KEY = "libre:library-view-mode";
const VIEW_MODE_DEFAULT: ViewMode = "shelf";

interface Props {
  courses: Course[];
  completed: Set<string>;
  /// Course ids whose full body is still hydrating from disk. Covers for
  /// these ids get a dimmed + spinner overlay. Optional — when omitted,
  /// no covers show a loading state.
  hydrating?: Set<string>;
  onDismiss: () => void;
  onOpen: (courseId: string) => void;
  /// Opens the PDF import wizard. Optional — hidden when the host
  /// can't run the AI-assisted ingest pipeline (e.g. the web build).
  onImport?: () => void;
  /// Opens the multi-PDF bulk import wizard — the learner can queue several
  /// books at once for unattended processing. Optional — hidden when the
  /// host app doesn't support bulk imports (e.g. web build).
  onBulkImport?: () => void;
  /// Opens the docs-site import dialog — crawl a documentation URL
  /// and generate a course from its pages. Optional; hidden when not
  /// wired by the host (keeps this component useful in tests / web
  /// previews that don't have the Tauri crawl command available).
  onDocsImport?: () => void;
  /// Opens a file picker for a previously-exported `.libre` (or legacy
  /// `.kata`) archive and unzips it into the courses dir. Optional — when omitted the button
  /// is hidden (e.g. in environments where the Tauri dialog plugin isn't
  /// available).
  onImportArchive?: () => void;
  onExport?: (courseId: string, courseTitle: string) => void;
  onDelete?: (courseId: string, courseTitle: string) => void;
  /// Opens the per-course settings modal. When wired, right-clicking
  /// any cover in the library (shelf or grid) surfaces a context menu
  /// with Settings / Export / Delete mirroring the sidebar UX.
  onSettings?: (courseId: string) => void;
  /// Bulk-export every course in the library to a chosen directory.
  /// When wired, renders an "Export all" button in the header next to
  /// the Import cluster. Skipped when the host doesn't offer it (e.g.
  /// the web-preview build with no filesystem access).
  onBulkExport?: () => void;
  /// Reapply the bundled `public/starter-courses/<id>.json` over the
  /// installed copy. Wired by App.tsx to `syncBundledToInstalled` +
  /// `refreshCourses`. When supplied, the library shows an "update
  /// available" badge on every course whose bundled hash differs
  /// from its `bundleSha`. Click → run this handler. Optional —
  /// hidden cleanly when the host doesn't wire it (e.g. tests).
  onUpdateCourse?: (courseId: string) => Promise<void> | void;
  /// Smart "Add course" entry point. Opens an OS file picker with
  /// all supported formats (.pdf, .epub, .libre, .kata, .zip,
  /// .json) and dispatches each picked file to the right pipeline.
  /// When supplied, replaces the old 4-segment Book / Bulk books /
  /// Docs site / Archive cluster with a single split button. The
  /// dropdown still surfaces the explicit options for users who
  /// want them.
  onAddCourse?: () => void;
  /// Opens the catalog browser modal — search the official Libre
  /// library and install courses the user doesn't have yet. Distinct
  /// from `onAddCourse` (which is for files the user already has on
  /// disk) and from `onInstallCatalogEntry` (the lower-level install
  /// primitive that the browser modal calls).
  onBrowseCatalog?: () => void;
  /// Install a remote-catalog placeholder. Wired by App.tsx to fetch
  /// the .libre archive (desktop) or course JSON (web), persist
  /// it via storage.saveCourse, then refresh the in-memory list so
  /// the placeholder is replaced with the real installed cover. When
  /// omitted the Library still renders catalog placeholders, but
  /// they're inert (clicking does nothing).
  onInstallCatalogEntry?: (entry: CatalogEntry) => Promise<void> | void;
  /// "modal" (default) — centered overlay with a dimmed backdrop; closed
  /// via the × button or clicking the backdrop.
  /// "inline" — renders inside the current container with no backdrop,
  /// suitable for the "no-tabs-open" empty state. The close × is hidden
  /// since there's no underlying view to return to.
  mode?: "modal" | "inline";
  /// Which slice of the catalog to render. "library" (default) shows
  /// the user's INSTALLED courses only; "discover" shows the catalog
  /// PLACEHOLDERS only (with install buttons on each tile). The
  /// component is rendered with `scope="library"` from the Library
  /// route in the sidebar and `scope="discover"` from the Discover
  /// route, so the two surfaces share filter / search / view-mode
  /// machinery without mixing their content.
  scope?: "library" | "discover";
}

/// Browse-all-courses screen. Full-pane modal with language filter chips,
/// sort dropdown, and a responsive grid of course cards. Each card shows
/// progress + lesson count and offers Open / Export / Delete via a hover
/// action row. Empty state invites the user to import their first book.
export default function CourseLibrary({
  courses,
  completed,
  hydrating,
  onDismiss,
  onOpen,
  onImport,
  onBulkImport,
  onDocsImport,
  onImportArchive,
  onExport,
  onDelete,
  onSettings,
  onBulkExport,
  onUpdateCourse,
  onAddCourse,
  onBrowseCatalog,
  onInstallCatalogEntry,
  mode = "modal",
  scope = "library",
}: Props) {
  const isInline = mode === "inline";
  const ctxMenu = useCourseMenu();
  const t = useT();

  // Deferred scope. The chrome (header title, count, filter pills)
  // reads `scope` directly, so it commits IMMEDIATELY when the user
  // clicks Discover — they see "Discover" and the right count
  // within a frame. The heavy `enriched` + `filtered` memos below
  // read `derivedScope` instead, which lags one render behind under
  // load. React renders the chrome first with the new scope, lets
  // the browser paint, THEN computes the new card list with the
  // updated derivedScope and renders again.
  //
  // This is the structural fix for the multi-second freeze users
  // hit on Library ↔ Discover navigation: the work to derive
  // 50+ catalog placeholders + filter + sort + diff against the
  // old card list takes hundreds of ms on a modest CPU, and
  // putting it on the critical path delayed the entire view swap.
  // Deferring it via React's concurrent scheduler keeps the chrome
  // responsive and lets the body stream in once the work finishes.
  //
  // The `isCardListPending` flag below drives the dim-and-hint
  // affordance so the user knows fresh cards are on their way
  // rather than thinking the click was lost.
  const derivedScope = useDeferredValue(scope);
  const isCardListPending = derivedScope !== scope;
  // Top-level domain filter — All / Crypto / Programming. Sits above
  // the language pills so picking "Crypto" narrows everything below
  // to blockchain material, then language pills further refine within
  // that scope.
  const [categoryFilter, setCategoryFilter] = useState<
    "all" | CourseCategory
  >("all");
  // Chain sub-filter, only visible when categoryFilter === "crypto".
  // Reset to "all" any time the user navigates away from Crypto.
  const [chainFilter, setChainFilter] = useState<"all" | CryptoChain>("all");
  const [langFilter, setLangFilter] = useState<"all" | LanguageId>("all");
  // Kind toggle — separate the two course archetypes the library
  // mixes today: full-length books (chapter-major prose with
  // exercises) vs handcrafted challenge packs (flat list of
  // increasing-difficulty exercises). The default is "all" so a fresh
  // visit shows everything; toggling restricts to one bucket.
  const [kindFilter, setKindFilter] = useState<
    "all" | "books" | "tracks"
  >("all");
  const [sortBy, setSortBy] = useState<SortKey>("name");
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useLocalStorageState<ViewMode>(
    VIEW_MODE_STORAGE_KEY,
    VIEW_MODE_DEFAULT,
    {
      // String values (not JSON-objects) — store/read raw so users
      // who manually peek at localStorage see `"shelf"` rather than
      // `"\"shelf\""`. Validate the read so legacy / corrupt values
      // fall back to the default rather than rendering as `undefined`.
      serialize: (v) => v,
      deserialize: (raw) => (raw === "shelf" ? "shelf" : "grid"),
    },
  );

  // Warm the module-level cover cache up front so each BookCover
  // pulls from a cache hit instead of firing its own IPC. Fire-and-
  // forget — we used to gate a full-page overlay on this resolving,
  // but the overlay flashed on every window-refocus (since the
  // effect re-ran and the prefetch resolved synchronously from the
  // cache the second+ time, briefly toggling false → true). Each
  // BookCover already has a per-card loading affordance for the
  // rare un-prefetched first paint — that's plenty.
  useEffect(() => {
    if (courses.length === 0) return;
    void prefetchCovers(
      courses.map((c) => ({ courseId: c.id, cacheBust: c.coverFetchedAt })),
    );
  }, [courses]);

  // Per-course "update available" map. Each course's bundled JSON
  // gets fetched + hashed on mount; cells with the badge fire
  // `onUpdateCourse` when clicked. The hook also exposes `recheck`
  // so we can clear the badge immediately after a successful update
  // instead of waiting for the next mount.
  const { updates, recheck } = useCourseUpdates(courses);

  // Remote-catalog entries — anything in the catalog that isn't
  // already installed gets rendered as a semi-opaque placeholder
  // tile. The catalog is fetched once per app session (cached in
  // src/lib/catalog.ts).
  const { catalog, loaded: catalogLoaded } = useCatalog();
  const installedIds = useMemo(
    () => new Set(courses.map((c) => c.id)),
    [courses],
  );
  const placeholderEntries = useMemo(
    () => catalog.filter((e) => !installedIds.has(e.id)),
    [catalog, installedIds],
  );
  const placeholderCourses = useMemo(
    () => placeholderEntries.map(placeholderCourseFromCatalog),
    [placeholderEntries],
  );
  // Map id → catalog entry for the install click handler — we need
  // the original entry (with `file`, etc.), not just the synthetic
  // placeholder Course.
  const entryById = useMemo(() => {
    const m = new Map<string, CatalogEntry>();
    for (const e of catalog) m.set(e.id, e);
    return m;
  }, [catalog]);

  // Per-course "currently installing" tracker so the placeholder
  // tile can show a spinner + disable click while a download is in
  // flight. Mirrors the updatingIds pattern below.
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set());

  const handleInstallClick = async (courseId: string) => {
    if (!onInstallCatalogEntry) return;
    if (installingIds.has(courseId)) return;
    const entry = entryById.get(courseId);
    if (!entry) return;
    setInstallingIds((prev) => {
      const next = new Set(prev);
      next.add(courseId);
      return next;
    });
    try {
      await onInstallCatalogEntry(entry);
      // Successful install only — failures throw, skipping this
      // line. `source` is derived from the scope prop the host
      // passes (Library view vs. Discover view); both mount the
      // same CourseLibrary component, so this single fire site
      // covers both surfaces. The import-dialog + agent-tool
      // install paths fire their own events from their own
      // handlers (see ImportDialog + aiTools/tools.ts).
      track.courseInstall({
        courseId,
        source: scope === "discover" ? "discover" : "library",
      });
    } finally {
      setInstallingIds((prev) => {
        const next = new Set(prev);
        next.delete(courseId);
        return next;
      });
    }
  };

  // Per-course "currently updating" tracker so the cover badge can
  // render a spinner + disable clicks while a sync is in-flight.
  // Without this the user got zero feedback during the multi-second
  // fetch + write + hydrate cycle and tended to click the badge
  // again, which is a no-op (the handler ignores re-entry) but felt
  // like nothing was happening.
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set());

  const handleUpdateClick = async (courseId: string) => {
    if (!onUpdateCourse) return;
    if (updatingIds.has(courseId)) return; // re-entry guard
    setUpdatingIds((prev) => {
      const next = new Set(prev);
      next.add(courseId);
      return next;
    });
    try {
      await onUpdateCourse(courseId);
      await recheck(courseId);
    } finally {
      setUpdatingIds((prev) => {
        const next = new Set(prev);
        next.delete(courseId);
        return next;
      });
    }
  };

  // Pre-compute per-course progress so sorting + display share one walk.
  // Scope-aware on purpose: in `library` scope `enriched` only carries
  // installed courses; in `discover` scope it only carries the catalog
  // placeholders. Doing the split HERE (rather than relying on a
  // downstream `.filter(scope ? ... )`) guarantees a placeholder can
  // never leak into a library render even if a later filter is
  // skipped or rewritten — a defensive belt-and-suspenders after a
  // bug report where switching Discover → Library briefly showed
  // uninstalled tiles in the library view.
  const enriched = useMemo(() => {
    if (derivedScope === "discover") {
      return placeholderCourses.map((c) => ({
        course: c,
        total: 0,
        done: 0,
        pct: 0,
      }));
    }
    // Library-side dedupe by (language, packType) for challenge packs.
    // The auto-gen-challenges flow used to mint nanoID-suffixed packs
    // (`challenges-go-mo9kijkd`) that survived alongside the canonical
    // `challenges-go-handwritten` ones, producing visible duplicates
    // in the Library grid. Prefer the `-handwritten`-suffixed canonical
    // version when both are installed; fall back to alphabetical id
    // when neither matches the canonical naming.
    const dedupedCourses = dedupeChallengePacks(courses);
    return dedupedCourses.map((c) => {
      let total = 0;
      let done = 0;
      for (const ch of c.chapters) {
        for (const l of ch.lessons) {
          total += 1;
          if (completed.has(`${c.id}:${l.id}`)) done += 1;
        }
      }
      return {
        course: c,
        total,
        done,
        pct: total > 0 ? done / total : 0,
      };
    });
  }, [derivedScope, courses, completed, placeholderCourses]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return enriched
      // Tracks + challenge packs live EXCLUSIVELY in the dedicated
      // Tracks page on the LIBRARY scope — per Notion issue
      // #8950f6efe915713b follow-up. On the DISCOVER scope the
      // strip is lifted: the catalogue surface needs to show every
      // installable pack including tracks + challenges, otherwise
      // a learner can't find / install them from there. So the
      // strip is scoped to `library` only.
      .filter(
        (e) =>
          derivedScope === "discover" ||
          (!isExerciseTrack(e.course) &&
            !isChallengePack(e.course) &&
            !isKoans(e.course) &&
            !isLings(e.course)),
      )
      // Belt + suspenders: the scope-aware `enriched` above already
      // partitions installed vs placeholder, but keeping the
      // explicit filter here means an accidental future change to
      // `enriched` can't silently mix the two surfaces.
      .filter((e) =>
        derivedScope === "discover"
          ? !!e.course.placeholder
          : !e.course.placeholder,
      )
      .filter(
        (e) =>
          categoryFilter === "all" ||
          categorizeCourse(e.course) === categoryFilter,
      )
      // Chain filter only takes effect when category is crypto —
      // there's no chain on a programming course to compare against.
      .filter(
        (e) =>
          categoryFilter !== "crypto" ||
          chainFilter === "all" ||
          cryptoChain(e.course) === chainFilter,
      )
      .filter((e) => langFilter === "all" || e.course.language === langFilter)
      // No kind filter — the library is books-only after the
      // track / challenge strip above. `kindFilter` is kept on the
      // state shape for back-compat (existing callers + the
      // filter-popover plumbing), but every non-"all" value would
      // produce the same books-only result by construction.
      .filter((e) => {
        if (kindFilter === "all") return true;
        if (kindFilter === "tracks") return false; // none survive the strip
        return (
          !isChallengePack(e.course) &&
          !isExerciseTrack(e.course) &&
          !isKoans(e.course) &&
          !isLings(e.course)
        );
      })
      .filter((e) =>
        q === ""
          ? true
          : e.course.title.toLowerCase().includes(q) ||
            (e.course.author ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => {
        switch (sortBy) {
          case "progress":
            return b.pct - a.pct;
          case "lessons":
            return b.total - a.total;
          case "name":
          default:
            return a.course.title.localeCompare(b.course.title);
        }
      });
  }, [
    enriched,
    derivedScope,
    categoryFilter,
    chainFilter,
    langFilter,
    kindFilter,
    sortBy,
    query,
  ]);

  // Section layout depends on scope:
  //   - library: books only (tracks + challenge packs are stripped
  //     upstream by the `filtered` predicate so they live on the
  //     dedicated Tracks page exclusively).
  //   - discover: books AND tracks each in their own labelled
  //     section so a learner browsing the catalog can find every
  //     installable pack. Challenges fold into the Tracks lane
  //     here (mirrors the Tracks-page bucketing).
  const sections = useMemo(() => {
    if (filtered.length === 0) return [];
    if (derivedScope !== "discover") {
      return [
        {
          key: "books",
          label: t("library.books"),
          blurb: t("library.booksBlurb"),
          rows: filtered,
        },
      ];
    }
    const books: typeof filtered = [];
    const tracks: typeof filtered = [];
    for (const e of filtered) {
      // Koans + *lings share the Challenges-page lane with Exercism
      // tracks + in-house challenge packs (see `ChallengesView`'s
      // filter). In Discover scope we mirror that bucketing so the
      // catalog mirrors the surface where the learner will
      // eventually find each pack.
      if (
        isExerciseTrack(e.course) ||
        isChallengePack(e.course) ||
        isKoans(e.course) ||
        isLings(e.course)
      ) {
        tracks.push(e);
      } else {
        books.push(e);
      }
    }
    const out: Array<{
      key: string;
      label: string;
      blurb: string;
      rows: typeof filtered;
    }> = [];
    if (books.length > 0) {
      out.push({
        key: "books",
        label: t("library.books"),
        blurb: t("library.booksBlurb"),
        rows: books,
      });
    }
    if (tracks.length > 0) {
      out.push({
        key: "tracks",
        label: t("library.tracks"),
        blurb: t("library.tracksBlurb"),
        rows: tracks,
      });
    }
    return out;
  }, [filtered, derivedScope, t]);

  // Count courses per category so the top-level toggle can show
  // badges. Always uses the full enriched set — the badge needs to
  // tell you "how many crypto courses TOTAL exist", regardless of
  // the lang/kind narrowing further down.
  const categoryCounts = useMemo(() => {
    let crypto = 0;
    let programming = 0;
    for (const e of enriched) {
      if (categorizeCourse(e.course) === "crypto") crypto += 1;
      else programming += 1;
    }
    return { crypto, programming, all: crypto + programming };
  }, [enriched]);

  // Count courses per chain WITHIN the crypto subset. Used to render
  // the chain pills (Bitcoin / Ethereum / Solana / Other). Always
  // ignores the chain filter itself — otherwise picking "Bitcoin"
  // would zero out every other pill's count.
  const chainCounts = useMemo(() => {
    const m = new Map<CryptoChain, number>();
    let total = 0;
    for (const e of enriched) {
      if (categorizeCourse(e.course) !== "crypto") continue;
      const chain = cryptoChain(e.course);
      m.set(chain, (m.get(chain) ?? 0) + 1);
      total += 1;
    }
    return { byChain: m, all: total };
  }, [enriched]);

  // Count courses per language so the filter chips can show badges and
  // hide languages with zero courses (unless they're the active filter).
  // Counts are scoped to the active category + chain — picking
  // "Crypto > Ethereum" hides Python (since no Ethereum-Python course
  // exists), keeps Solidity / TypeScript visible.
  const countByLang = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of enriched) {
      if (
        categoryFilter !== "all" &&
        categorizeCourse(e.course) !== categoryFilter
      ) {
        continue;
      }
      if (
        categoryFilter === "crypto" &&
        chainFilter !== "all" &&
        cryptoChain(e.course) !== chainFilter
      ) {
        continue;
      }
      m.set(e.course.language, (m.get(e.course.language) ?? 0) + 1);
    }
    return m;
  }, [enriched, categoryFilter, chainFilter]);

  // Count books / tracks / challenges so the kind toggle can show
  // badges. Scope-aware: on the LIBRARY scope, tracks + challenge
  // packs are forced to 0 (the kind-filter UI then collapses to a
  // single "books" bucket and self-hides via LibraryControls'
  // `kindBucketsPresent >= 2` check). On the DISCOVER scope all
  // three lanes count, so the filter popover surfaces a real
  // Books / Tracks toggle. Only counts within the current
  // category + chain + language filters so the numbers track what's
  // actually visible after upstream filters narrow the set.
  const kindCounts = useMemo(() => {
    let books = 0;
    let tracks = 0;
    let challenges = 0;
    const isDiscover = derivedScope === "discover";
    for (const e of enriched) {
      const challengeP = isChallengePack(e.course);
      const trackP = isExerciseTrack(e.course);
      const koanP = isKoans(e.course);
      const lingsP = isLings(e.course);
      // Library scope: skip non-book packs entirely so the kind
      // counts agree with the books-only `filtered` stream.
      if (!isDiscover && (challengeP || trackP || koanP || lingsP)) continue;
      if (
        categoryFilter !== "all" &&
        categorizeCourse(e.course) !== categoryFilter
      ) {
        continue;
      }
      if (
        categoryFilter === "crypto" &&
        chainFilter !== "all" &&
        cryptoChain(e.course) !== chainFilter
      ) {
        continue;
      }
      if (langFilter !== "all" && e.course.language !== langFilter) continue;
      // Koans + *lings + in-house challenge packs all feed the
      // "challenges" bucket — the dedicated Challenges page treats
      // them as siblings, so the Library counter reflects the same
      // grouping.
      if (challengeP || koanP || lingsP) challenges += 1;
      else if (trackP) tracks += 1;
      else books += 1;
    }
    return { books, tracks, challenges, all: books + tracks + challenges };
  }, [enriched, derivedScope, categoryFilter, chainFilter, langFilter]);

  // "Update all" button — docks into the right edge of the first
  // section header (Books / count / blurb / [Update all]). Was
  // previously a standalone row between the controls strip and the
  // first section's cards, with a redundant "N books have updates
  // available" text label to the left of the button. The text said
  // the same thing the button's own label already says ("Update all
  // (N)"), so this trims to just the button and lifts it onto the
  // header's row to free up the vertical space.
  //
  // Computed here (outside the section maps) so both shelf-mode and
  // grid-mode rendering can drop the same JSX into their per-section
  // headers without duplicating the pending-id computation.
  const pendingUpdateIds = Object.entries(updates)
    .filter(([id, hasUpdate]) => hasUpdate && !updatingIds.has(id))
    .map(([id]) => id);
  const inflightUpdateCount = courses.filter((c) =>
    updatingIds.has(c.id),
  ).length;
  const hasAnyUpdates =
    pendingUpdateIds.length > 0 || inflightUpdateCount > 0;
  // Per-batch progress tracker — separate from `updatingIds` (which
  // holds the per-course in-flight set the per-book buttons use)
  // because we need the batch's ORIGINAL total to stay constant as
  // books complete, and we need a monotonically increasing "current
  // book" index so the label reads "Updating 1/3 → 2/3 → 3/3"
  // instead of "Updating 1/3 → 1/2 → 1/1" as `pendingUpdateIds`
  // shrinks under our feet.
  const [updateBatch, setUpdateBatch] = useState<{
    total: number;
    done: number;
  } | null>(null);
  const handleUpdateAll = async () => {
    // Snapshot the ids ONCE at click time. Resolving them inside the
    // loop body would re-read `pendingUpdateIds` (computed from React
    // state) every iteration, but that closure was captured at render
    // start — we'd re-update books already in flight, or skip newly
    // arrived ones. Snapshotting up front makes the batch boundary
    // explicit.
    const ids = [...pendingUpdateIds];
    if (ids.length === 0) return;
    setUpdateBatch({ total: ids.length, done: 0 });
    try {
      // Sequential — the per-book sync reads a fresh disk snapshot
      // for each, and N parallel writes would thrash both the disk
      // and the React render path.
      for (let i = 0; i < ids.length; i++) {
        await handleUpdateClick(ids[i]);
        setUpdateBatch((b) => (b ? { ...b, done: i + 1 } : b));
      }
    } finally {
      setUpdateBatch(null);
    }
  };
  // While a batch is running, the label shows "Updating k/N" where k
  // is the 1-based index of the book CURRENTLY being synced. Capped
  // at `total` so the final tick after the last completion doesn't
  // briefly read "Updating 4/3" before the batch state clears.
  const batchInProgress = updateBatch !== null;
  const batchCurrent = updateBatch
    ? Math.min(updateBatch.done + 1, updateBatch.total)
    : 0;
  const updateAllButton = hasAnyUpdates ? (
    <button
      type="button"
      className="libre-library-section-update-btn"
      onClick={handleUpdateAll}
      disabled={batchInProgress || pendingUpdateIds.length === 0}
      title="Re-sync each updated book against its bundled source"
      aria-label={
        batchInProgress
          ? `Updating book ${batchCurrent} of ${updateBatch!.total}`
          : `Update all ${pendingUpdateIds.length} ${pendingUpdateIds.length === 1 ? "book" : "books"}`
      }
    >
      {batchInProgress
        ? `Updating ${batchCurrent}/${updateBatch!.total}`
        : `Update all (${pendingUpdateIds.length})`}
    </button>
  ) : null;

  // The panel content is identical in both modes; only the wrapper differs:
  // modal wraps with a full-viewport backdrop, inline just renders in place.
  const panel = (
    <div
      className={`libre-library-panel ${isInline ? "libre-library-panel--inline" : ""}`}
      onClick={(e) => e.stopPropagation()}
    >
        <div className="libre-library-header">
          {/* Title block — back to the pre-logo treatment. The
              Libre.academy wordmark moved out to the sidebar, so
              the page identity here is just "Library" / "Discover"
              + the count metadata. */}
          <div className="libre-library-titleblock">
            <span className="libre-library-title">
              {scope === "discover" ? t("library.headerDiscover") : t("library.headerLibrary")}
            </span>
            <span className="libre-library-subtitle">
              {scope === "discover"
                ? placeholderCourses.length === 1
                  ? t("library.subtitleInstall", { count: placeholderCourses.length })
                  : t("library.subtitleInstallPlural", { count: placeholderCourses.length })
                : courses.length === 1
                  ? t("library.subtitle", { count: courses.length })
                  : t("library.subtitlePlural", { count: courses.length })}
            </span>
          </div>
          <div className="libre-library-header-actions">
            {/* Single "Import" label + a segmented cluster of destinations.
                Beats repeating "Import from PDF…", "Import archive…",
                "Bulk import…" three times — the label answers "what do
                these buttons do" once; each segment is just the NAME of
                the thing being imported. */}
            {/* Single "Add course" split button replaces the old
                four-button cluster. The smart-pick path covers PDFs,
                EPUBs, archives and JSON exports; the dropdown caret
                surfaces the explicit alternatives (bulk wizard,
                docs URL, archive picker) for users who want them. */}
            {onAddCourse && (
              <AddCourseButton
                onSmartPick={onAddCourse}
                onBulkPdfs={onBulkImport}
                onDocsUrl={onDocsImport}
                onArchive={onImportArchive}
                onBrowseCatalog={onBrowseCatalog}
              />
            )}
            {/* On web (no onAddCourse), still surface the catalog
                browser as a standalone button — web users can't
                import files from disk, but they should still be
                able to add catalog books. */}
            {!onAddCourse && onBrowseCatalog && (
              <button
                type="button"
                className="libre-library-import"
                onClick={onBrowseCatalog}
              >
                {t("library.browseCatalog")}
              </button>
            )}
            {/* Fallback: when the host hasn't wired the new
                onAddCourse handler (e.g. on web build, or in
                tests), fall back to the legacy "Book" button so
                the library still has a visible import entry. */}
            {!onAddCourse && onImport && (
              <button
                className="libre-library-import-seg libre-library-import-seg--primary"
                onClick={onImport}
                title={t("library.importBookTitle")}
              >
                {t("library.importBook")}
              </button>
            )}
            {onBulkExport && (
              <button
                className="libre-library-bulk-export"
                onClick={onBulkExport}
                disabled={filtered.length === 0 && courses.length === 0}
                title={t("library.exportAllTitle")}
              >
                {t("library.exportAll")}
              </button>
            )}
            {!isInline && (
              <button className="libre-library-close" onClick={onDismiss} aria-label={t("library.closeAria")}>
                ×
              </button>
            )}
          </div>
        </div>

        {/*
          "Update all" banner. Surfaces above the grid when one or more
          installed courses have a pending update (the same condition
          that makes individual book covers show their per-tile Update
          badge). Sums the badges into a single click so a learner who
          launches after a long break doesn't have to update each book
          one-at-a-time.

          Pending updates are computed from the same `updates` map the
          per-cover badges read, minus anything already in flight via
          `updatingIds`. This avoids re-firing in-flight syncs and
          gives the banner a real-time count as updates complete.

          The body is also where the hero artwork and the
          search/filter controls live now — the hero scrolls away
          with the cards, the controls sticky-pin to the top of the
          scroll viewport so search + filter stay reachable without
          competing with the brand band for vertical space.
        */}
        <div
          className={
            "libre-library-body" +
            (isCardListPending ? " is-deferred-pending" : "")
          }
        >
          {/* Search + filter strip. Lives INSIDE the body so it can
              `position: sticky; top: 0;` against the body's scroll
              container — the hero above scrolls past it on the way
              up, the cards below scroll under it on the way down,
              and search + filter pills stay one tap away regardless
              of scroll depth. */}
          {courses.length > 0 && (
            <LibraryControls
              // ── filter state ──
              categoryFilter={categoryFilter}
              chainFilter={chainFilter}
              langFilter={langFilter}
              kindFilter={kindFilter}
              // ── filter setters (each clears downstream as needed) ──
              onSetCategory={(c) => {
                setCategoryFilter(c);
                setChainFilter("all");
                setLangFilter("all");
              }}
              onSetChain={(c) => {
                setChainFilter(c);
                setLangFilter("all");
              }}
              onSetLang={setLangFilter}
              onSetKind={setKindFilter}
              // ── counts (drive both badges and visibility rules) ──
              categoryCounts={categoryCounts}
              chainCounts={chainCounts}
              countByLang={countByLang}
              kindCounts={kindCounts}
              totalCourses={courses.length}
              // ── tools ──
              query={query}
              onSetQuery={setQuery}
              sortBy={sortBy}
              onSetSort={setSortBy}
              viewMode={viewMode}
              onSetViewMode={setViewMode}
            />
          )}
          {/* Update-all callout no longer renders as its own row —
              the button now docks into the section header's right
              edge (see `updateAllButton` below + the section-head
              maps for shelf / grid mode). The screen-reader-friendly
              text label was dropped per the design tweak; the button
              itself carries the count + busy state so AT users still
              get the full status via aria-label on the button. */}

          {derivedScope === "discover" && !catalogLoaded ? (
            // Catalog fetch in flight. The desktop build hits a Tauri
            // command that walks the bundled-packs dir; the web build
            // fetches a static JSON manifest. Either way, on cold
            // start the catalog can take a moment — show the
            // LibreLoader instead of the misleading "No courses
            // yet" or "No matches" empty states.
            //
            // Reads derivedScope (not scope) so we don't briefly
            // flash "Loading catalog…" while React is still
            // committing the chrome of a discover→library swap; the
            // body keeps showing the previous Library cards until
            // the deferred recomputation lands.
            <div className="libre-library-empty">
              <LibreLoader size="md" label="Loading catalog…" />
            </div>
          ) : courses.length === 0 && derivedScope !== "discover" ? (
            <div className="libre-library-empty">
              <div className="libre-library-empty-glyph" aria-hidden>
                <Icon icon={libraryBig} size="2xl" color="currentColor" weight="light" />
              </div>
              <div className="libre-library-empty-title">No courses yet</div>
              <div className="libre-library-empty-blurb">
                {onImport
                  ? "Import your first book to get started. Libre splits a PDF or EPUB into lessons and generates exercises with the Claude API, or you can import a `.academy` course someone else shared."
                  : "Sign in to sync courses from another device, or grab the desktop app to ingest your own books."}
              </div>
              <div className="libre-library-empty-actions">
                {onImport ? (
                  <button className="libre-library-empty-primary" onClick={onImport}>
                    Import a book…
                  </button>
                ) : (
                  <a
                    className="libre-library-empty-primary"
                    href="https://github.com/InfamousVague/Kata/releases/latest"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Get the desktop app
                  </a>
                )}
                {onImportArchive && (
                  <button
                    className="libre-library-empty-secondary"
                    onClick={onImportArchive}
                  >
                    Import .academy archive…
                  </button>
                )}
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="libre-library-empty">
              <div className="libre-library-empty-title">No matches</div>
              <div className="libre-library-empty-blurb">
                Try clearing the filter or searching for a different title.
              </div>
            </div>
          ) : viewMode === "shelf" ? (
            // Shelf mode — each release-status tier gets its own
            // labelled section. Section heading + blurb sit above the
            // cover grid; the inner .libre-library-shelf keeps its
            // original layout so card sizing is unchanged.
            <div className="libre-library-sections">
              {sections.map((sec, secIdx) => (
                <section
                  key={sec.key}
                  className={`libre-library-section libre-library-section--${sec.key}`}
                  aria-label={sec.label}
                >
                  <header className="libre-library-section-head">
                    <h2 className="libre-library-section-title">
                      {sec.label}
                    </h2>
                    <span className="libre-library-section-count">
                      {sec.rows.length}
                    </span>
                    <span className="libre-library-section-blurb">
                      {sec.blurb}
                    </span>
                    {/* Update-all button docks into the FIRST section's
                        header only — the action is global (re-syncs every
                        pending book regardless of which section it's in)
                        so showing it once at the top of the page is the
                        natural single anchor. */}
                    {secIdx === 0 && updateAllButton}
                  </header>
                  {sec.key === "tracks" ? (
                    // Tracks always use the dense CourseCard layout,
                    // even in shelf view. Tracks have no cover art
                    // (the language identity is carried by the
                    // CourseCard's LanguageChip in the header), so a
                    // shelf of large fallback tiles would feel sparse;
                    // CourseCard's title + author + progress + lesson
                    // count is the right info-density for a curriculum
                    // tile and matches how an installed track surfaces
                    // when opened.
                    <div className="libre-library-grid">
                      {sec.rows.map((e, idx) => (
                        <CourseCard
                          key={e.course.id}
                          style={{ "--libre-ripple-i": idx } as React.CSSProperties}
                          course={e.course}
                          total={e.total}
                          done={e.done}
                          pct={e.pct}
                          onOpen={() => onOpen(e.course.id)}
                          onContextMenu={
                            onExport || onDelete || onSettings || onUpdateCourse
                              ? (ev) =>
                                  ctxMenu.show(e.course, ev, {
                                    hasUpdate: !!updates[e.course.id],
                                  })
                              : undefined
                          }
                          placeholder={e.course.placeholder}
                          installing={installingIds.has(e.course.id)}
                          onInstall={
                            e.course.placeholder && onInstallCatalogEntry
                              ? () => void handleInstallClick(e.course.id)
                              : undefined
                          }
                          hasUpdate={
                            !e.course.placeholder &&
                            !!onUpdateCourse &&
                            !!updates[e.course.id]
                          }
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="libre-library-shelf">
                      {sec.rows.map((e, idx) => (
                        <BookCover
                          key={e.course.id}
                          // --libre-ripple-i drives the staggered mount
                          // animation in CourseLibrary.css. Linear by
                          // index so cards animate in across the shelf
                          // in document order, capped at MAX_RIPPLE_I
                          // via the CSS `min()` so giant shelves don't
                          // produce a multi-second tail.
                          style={{ "--libre-ripple-i": idx } as React.CSSProperties}
                          course={e.course}
                          progress={e.pct}
                          loading={hydrating?.has(e.course.id)}
                          onOpen={() => onOpen(e.course.id)}
                          onContextMenu={
                            // Placeholders have no installed-course
                            // context menu (Export / Delete / Settings
                            // need an installed copy on disk).
                            !e.course.placeholder &&
                            (onExport || onDelete || onSettings || onUpdateCourse)
                              ? (ev) =>
                                  ctxMenu.show(e.course, ev, {
                                    hasUpdate: !!updates[e.course.id],
                                  })
                              : undefined
                          }
                          hasUpdate={
                            !e.course.placeholder &&
                            !!onUpdateCourse &&
                            !!updates[e.course.id]
                          }
                          updating={updatingIds.has(e.course.id)}
                          onUpdate={
                            !e.course.placeholder && onUpdateCourse
                              ? () => void handleUpdateClick(e.course.id)
                              : undefined
                          }
                          placeholder={e.course.placeholder}
                          installing={installingIds.has(e.course.id)}
                          placeholderCoverUrl={
                            e.course.placeholder
                              ? coverHref(entryById.get(e.course.id)!)
                              : undefined
                          }
                          onInstall={
                            e.course.placeholder && onInstallCatalogEntry
                              ? () => void handleInstallClick(e.course.id)
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  )}
                </section>
              ))}
            </div>
          ) : (
            // Grid mode — same sectioning rule, different inner layout.
            <div className="libre-library-sections">
              {sections.map((sec, secIdx) => (
                <section
                  key={sec.key}
                  className={`libre-library-section libre-library-section--${sec.key}`}
                  aria-label={sec.label}
                >
                  <header className="libre-library-section-head">
                    <h2 className="libre-library-section-title">
                      {sec.label}
                    </h2>
                    <span className="libre-library-section-count">
                      {sec.rows.length}
                    </span>
                    <span className="libre-library-section-blurb">
                      {sec.blurb}
                    </span>
                    {/* See comment on the shelf-mode map above —
                        same global single-anchor for the update-all
                        action. */}
                    {secIdx === 0 && updateAllButton}
                  </header>
                  <div className="libre-library-grid">
                    {sec.rows.map((e, idx) => (
                        <CourseCard
                          key={e.course.id}
                          // See the matching --libre-ripple-i comment on
                          // the shelf-mode map above. Same staggered
                          // mount animation, same custom property.
                          style={{ "--libre-ripple-i": idx } as React.CSSProperties}
                          course={e.course}
                          total={e.total}
                          done={e.done}
                          pct={e.pct}
                          onOpen={() => onOpen(e.course.id)}
                          onContextMenu={
                            // Right-click surfaces the same context
                            // menu the BookCover view uses — Reinstall /
                            // Export / Settings / Reset / Delete. The
                            // grid card no longer renders inline action
                            // buttons; the menu is the single action
                            // surface.
                            onExport || onDelete || onSettings || onUpdateCourse
                              ? (ev) =>
                                  ctxMenu.show(e.course, ev, {
                                    hasUpdate: !!updates[e.course.id],
                                  })
                              : undefined
                          }
                          // Discover-mode: install affordance per
                          // tile. Mirrors the BookCover treatment in
                          // book view so both view modes can install
                          // a catalog entry without bouncing through
                          // the modal.
                          placeholder={e.course.placeholder}
                          installing={installingIds.has(e.course.id)}
                          onInstall={
                            e.course.placeholder && onInstallCatalogEntry
                              ? () => void handleInstallClick(e.course.id)
                              : undefined
                          }
                          hasUpdate={
                            !e.course.placeholder &&
                            !!onUpdateCourse &&
                            !!updates[e.course.id]
                          }
                        />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
        <CourseContextMenu
          menu={ctxMenu.menu}
          onDismiss={ctxMenu.close}
          onSettings={onSettings}
          onExport={onExport}
          onUpdate={
            onUpdateCourse
              ? (courseId) => {
                  void onUpdateCourse(courseId);
                }
              : undefined
          }
          onDelete={onDelete}
        />
    </div>
  );

  // In inline mode, render just the panel so it flows in its parent
  // container. In modal mode, wrap in a backdrop and intercept clicks.
  if (isInline) return panel;
  return (
    <div className="libre-library-backdrop" onClick={onDismiss}>
      {panel}
    </div>
  );
}

