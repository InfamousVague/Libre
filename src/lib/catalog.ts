/// Catalog of available courses — both core (bundled with the app)
/// and remote (downloadable). Drives the Library's "show every book
/// the user CAN have, render the ones they don't yet have as
/// placeholders" UX.
///
/// Source format (the JSON served at
/// `libre.academy/starter-courses/manifest.json`):
///
///   {
///     "version": 2,
///     "generatedAt": "2026-04-30T...",
///     "courses": [
///       {
///         "id": "the-rust-programming-language",
///         "packId": "the-rust-programming-language",
///         "title": "The Rust Programming Language",
///         "author": "Steve Klabnik, Carol Nichols",
///         "language": "rust",
///         "file": "the-rust-programming-language.json",
///         "cover": "the-rust-programming-language.jpg",
///         "sizeBytes": 1234567,
///         "archiveSizeBytes": 234567,
///         "tier": "core" | "remote",
///         "packType": "course" | "challenges" | "track",
///         "releaseStatus": "BETA" | "ALPHA" | "UNREVIEWED",
///         "lessonCount": 168
///       },
///       ...
///     ]
///   }
///
/// At runtime we fetch this once per app session, cache in memory,
/// and let `useCourses` merge entries that aren't in the user's
/// installed set as `placeholder: true` Course objects.

import type { Course, LanguageId } from "../data/types";
import { isHiddenCourse } from "./hiddenCourses";

export interface CatalogEntry {
  id: string;
  packId: string;
  title: string;
  author?: string;
  language: LanguageId;
  /// Filename of the course JSON inside `/starter-courses/`. The
  /// install path on every platform is: fetch
  /// `${MANIFEST_BASE}/${file}` and persist via `storage.saveCourse`.
  file: string;
  /// Filename of the cover JPEG inside `/starter-courses/`. We
  /// resolve to a real URL via `coverHref` below.
  cover?: string;
  sizeBytes: number;
  /// Optional — only set when the catalog ships a downloadable .academy
  /// archive alongside the per-course JSON. Course-derived books carry
  /// it (the AI-generated lessons + multi-MB cover JPEGs benefit from
  /// the archive format); Exercism tracks ship JSON-only, so this is
  /// undefined for them. The BookCover placeholder uses it to render
  /// the "X.X MB" hint next to the Install button; absence just hides
  /// the hint.
  archiveSizeBytes?: number;
  tier: "core" | "remote";
  packType?: "course" | "challenges" | "track";
  releaseStatus?: "BETA" | "ALPHA" | "UNREVIEWED" | "PRE-RELEASE";
  lessonCount?: number;
  /// Unlisted flag — see Course.hidden. The catalog layer drops
  /// hidden entries before returning to the UI so Discover never
  /// renders a placeholder tile for them; the manifest still
  /// carries them so direct-link consumers can fetch on demand.
  hidden?: boolean;
}

interface CatalogJson {
  version: number;
  generatedAt?: string;
  courses: CatalogEntry[];
}

/// Catalog URL — points at the static CDN manifest. Same URL on
/// desktop and web; the manifest + per-course JSONs + cover JPEGs all
/// live under `libre.academy/starter-courses/`. Override with the
/// `LIBRE_CATALOG_URL` env var at build time.
const CATALOG_URL_OVERRIDE = (
  import.meta.env.LIBRE_CATALOG_URL as string | undefined
)?.trim();

const DEFAULT_CATALOG_URL =
  "https://libre.academy/starter-courses/manifest.json";

function defaultCatalogUrl(): string {
  return CATALOG_URL_OVERRIDE || DEFAULT_CATALOG_URL;
}

/// Base URL for fetching catalog assets (per-course JSON + cover JPG).
/// Derived from the manifest URL by trimming the trailing `manifest.json`
/// so the same `<id>.json` / `<id>.jpg` filenames work for both platforms.
export function catalogAssetBase(): string {
  return defaultCatalogUrl().replace(/\/manifest\.json$/, "");
}

let cachedPromise: Promise<CatalogEntry[]> | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes (in-memory)
/// Bumped to v2 on 2026-05-10 to invalidate snapshots that included
/// retired books (eloquent-javascript, fluent-react, programming-bitcoin,
/// learning-zig, …). The old key still lives in localStorage on returning
/// installs but is now ignored — it'll be overwritten by the next
/// successful fetch under v2 and can be GC'd by the browser whenever.
const PERSIST_KEY = "libre:catalog-cache-v2";
const PERSIST_TTL_MS = 1000 * 60 * 60 * 24; // 24h (localStorage)

/// Pack ids we've shipped at some point but pulled from the catalog.
/// Mirrors `RETIRED_PACK_IDS` in `src-tauri/src/courses.rs` — kept in
/// sync by hand because the desktop catalog already filters via that
/// constant, and the web catalog (manifest.json) can have stale entries
/// from a deploy that pre-dates a retirement. Either path produces a
/// CatalogEntry the Discover tab would render unless we drop it here.
///
/// Don't trim the list when adding new retirees; an install that's been
/// dormant since the very first version still needs the older ids
/// filtered on its next launch.
const RETIRED_PACK_IDS: ReadonlySet<string> = new Set([
  // Pre-2026-05 cleanup. NOTE: bun-complete, svelte-5-complete and
  // learning-react-native were briefly listed here but are back in
  // the active catalog as of 2026-05-10 (Discover-cache strays the
  // team decided to keep + author covers for) — kept out of the set.
  "bun-fundamentals",
  "javascript-crash-course",
  "challenges-reactnative-visual",
  // 2026-05-07 cleanup
  "eloquent-javascript",
  "the-modern-javascript-tutorial-fundamentals",
  "you-dont-know-js-yet",
  "you-don-t-know-js-yet",
  "python-crash-course",
  "crafting-interpreters-javascript",
  "crafting-interpreters-js",
  "fluent-react",
  "interactive-web-development-with-three-js-and-a-frame",
  // 2026-05-10 cleanup
  "programming-bitcoin",
  "javascript-the-definitive-guide",
  "introduction-to-computer-organization-arm",
  "functional-light-javascript",
  "functional-light-js",
  "learning-zig",
  // 2026-05-28 cleanup — pruned from bundled-packs in v1.3.8. Filter
  // them client-side too so any v1.3.7 install whose localStorage
  // catalog cache has them won't keep rendering the tiles until SWR
  // revalidation kicks in.
  "hellotrade",
  "open-data-structures",
  "pro-git",
  "svelte-tutorial",
  "tauri-2-fundamentals",
]);

export function isRetiredPack(id: string): boolean {
  return RETIRED_PACK_IDS.has(id);
}

interface PersistedCatalog {
  ts: number;
  entries: CatalogEntry[];
}

/// Read the cached catalog synchronously off localStorage. Used by
/// `useCatalog` to paint a stale-but-good first frame instantly,
/// while the live `fetchCatalog()` revalidates in the background.
/// Returns null when missing, malformed, or older than the TTL —
/// callers fall through to the live fetch in those cases.
export function readPersistedCatalog(): CatalogEntry[] | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedCatalog;
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    if (Date.now() - parsed.ts > PERSIST_TTL_MS) return null;
    // Filter retired ids on read too — the persisted snapshot is what
    // useCatalog paints in the first frame before the network revalidates,
    // and we don't want a 200ms flash of retired tiles. The cache key bump
    // covers most cases, but the same key can persist across multiple
    // retirement waves, so the filter is the durable guard.
    return parsed.entries.filter((e) => !RETIRED_PACK_IDS.has(e.id));
  } catch {
    return null;
  }
}

function writePersistedCatalog(entries: CatalogEntry[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    const payload: PersistedCatalog = { ts: Date.now(), entries };
    localStorage.setItem(PERSIST_KEY, JSON.stringify(payload));
  } catch {
    // Quota exceeded / private mode — silently skip. Next launch
    // just re-fetches; persistence is a paint-speed nicety, not a
    // correctness requirement.
  }
}

/// Fetch the catalog. Cached for `CACHE_TTL_MS` per process so the
/// Library doesn't re-hit the catalog source on every render. Force
/// a refresh with `{ refresh: true }` after a Reapply / Promote
/// flow (rare). Successful fetches also persist to localStorage so
/// the next cold start can paint from cache before the network has
/// settled — see `readPersistedCatalog`.
///
/// Single code path on every platform: fetch the manifest from the
/// libre.academy CDN. Falls back to an empty list on network failure
/// so the Library still renders any courses the user has already
/// installed.
export function fetchCatalog(opts: { refresh?: boolean } = {}): Promise<
  CatalogEntry[]
> {
  if (
    !opts.refresh &&
    cachedPromise &&
    Date.now() - cachedAt < CACHE_TTL_MS
  ) {
    return cachedPromise;
  }
  // Dedupe-by-id at the layer boundary as a safety net — the manifest
  // generator shouldn't emit duplicates, but the cache snapshot we
  // merge could carry a stale id under a renamed pack.
  cachedPromise = fetchCatalogJson()
    .then(dedupeById)
    // Drop unlisted entries — they're shareable-by-link only, the
    // manifest still carries them so the on-demand fetch in
    // App.tsx's deep-link path can pull the JSON when a visitor
    // arrives via `?courseId=…`. Two checks for the same reason
    // App.tsx + MobileApp.tsx have two: the per-entry flag covers
    // freshly-fetched manifests, the runtime id-set covers
    // localStorage-cached catalog snapshots from before the flag
    // existed (a returning visitor whose previous fetchCatalog
    // wrote a cache without the hidden flag in any entry — without
    // this second check the cache would silently leak hidden books
    // back onto the Discover grid until the SWR revalidation
    // finished).
    .then((entries) =>
      entries.filter(
        (e) => !e.hidden && !isHiddenCourse(e.id) && !RETIRED_PACK_IDS.has(e.id),
      ),
    )
    .then((entries) => {
      // Persist successful fetches so the next launch can paint
      // from cache before this network round-trip completes. Empty
      // results aren't persisted — those tend to come from a
      // transient network failure (the hook returns [] on error)
      // and overwriting a good cache with [] would defeat the
      // point of the cache.
      if (entries.length > 0) writePersistedCatalog(entries);
      return entries;
    });
  cachedAt = Date.now();
  return cachedPromise;
}

/// Collapse catalog entries by id, keeping the first occurrence.
/// Stable order — important so a learner navigating Discover doesn't
/// see tiles shuffle between renders.
function dedupeById(entries: CatalogEntry[]): CatalogEntry[] {
  const seen = new Set<string>();
  const out: CatalogEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

async function fetchCatalogJson(): Promise<CatalogEntry[]> {
  const url = defaultCatalogUrl();
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as CatalogJson;
    return Array.isArray(body.courses) ? body.courses : [];
  } catch (e) {
    console.warn(
      `[catalog] failed to fetch ${url}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
}

/// Resolve a catalog entry's cover field into a full URL. Same path
/// on every platform — covers live alongside the manifest at
/// `libre.academy/starter-courses/<id>.jpg`.
export function coverHref(entry: CatalogEntry): string | undefined {
  if (!entry.cover) return undefined;
  return `${catalogAssetBase()}/${entry.cover}`;
}

/// Resolve a catalog entry's `file` field into a full URL for the
/// per-course JSON. The install handler fetches this URL and persists
/// the parsed Course via `storage.saveCourse`.
export function jsonHref(entry: CatalogEntry): string {
  return `${catalogAssetBase()}/${entry.file}`;
}

/// Build a synthetic `Course` from a catalog entry — used as a
/// placeholder in the Library grid until the user installs it.
/// The shape matches a real Course closely enough that BookCover
/// renders without tripping; `placeholder: true` flags it so the
/// click handler fires Download instead of Open.
export function placeholderCourseFromCatalog(entry: CatalogEntry): Course {
  return {
    id: entry.id,
    title: entry.title,
    author: entry.author,
    language: entry.language,
    chapters: [], // empty — placeholders have no lessons until installed
    packType: entry.packType,
    releaseStatus: entry.releaseStatus,
    placeholder: true,
    downloadUrl: jsonHref(entry),
    archiveSize: entry.archiveSizeBytes,
    tier: entry.tier,
    /// Cache-bust the placeholder cover URL using the catalog
    /// cover-set version. `useCourseCover` keys its in-memory + IPC
    /// cache on `${courseId}:${cacheBust ?? 0}` — without this, every
    /// placeholder tile hashes to `${id}:0` for the lifetime of the
    /// install, so a returning user keeps seeing the cover that was
    /// in the bundled archive when they first launched even after
    /// we ship new artwork. Bumping CATALOG_COVER_VERSION below
    /// produces a fresh key, the IPC re-reads cover.jpg, and the
    /// shelf paints the current art.
    coverFetchedAt: CATALOG_COVER_VERSION,
  };
}

/// Bump this any time the bundled-archive cover set is regenerated.
/// Drives cache-busting for placeholder tiles in the Library — see
/// `placeholderCourseFromCatalog` above. Format is YYYYMMDD as a
/// number (date the new cover set landed) for easy git-blame.
///
/// 20260510 — Refresh full library + tighten resize parameters
///            (288x432 q68 web / 384x576 q78 bundle).
const CATALOG_COVER_VERSION = 20260510;
