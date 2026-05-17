// eslint-disable-next-line import/first -- this module is otherwise
// import-free; the profile-namespace helper is the only dependency.
import { profileKey } from "./profileStore";

/// Persists which tabs the learner had open at the moment of the
/// last write. Currently the app boots with `openTabs = []` (Library
/// route) every time, so we don't *re-hydrate* from this snapshot —
/// but we keep writing it so a future "Resume last session" button
/// (or telemetry) has something to read.
///
/// `validateTabsAgainstCourses` is exported because callers that DO
/// want to consume a snapshot (e.g. a future resume flow) need to
/// drop tabs whose course/lesson was uninstalled before re-mounting.
///
/// Storage key is versioned (`v1`) so a future change to the snapshot
/// shape can ship without tripping on an old shape's leftovers — bump
/// the version, ignore the old key, write the new one.
///
/// We deliberately use `localStorage` (synchronous, available before
/// React paints) rather than going through `lib/storage.ts` (async,
/// SQLite/IndexedDB-backed). The state is small (< 1 KB) and tolerates
/// loss.

export interface OpenCourse {
  courseId: string;
  lessonId: string;
  /// Group membership — when set, the tab participates in a tab
  /// group identified by this id. A `TabGroup` entry with the same
  /// id lives in the snapshot's `groups` array carrying the group's
  /// name + colour. Tabs with no `groupId` are loose. Reordering
  /// doesn't enforce group contiguity (tabs in the same group can
  /// be visually scattered) — the colored bottom border is the
  /// only group-membership signal.
  groupId?: string;
}

/// A group of tabs sharing a name + colour. Created on demand from
/// the right-click menu ("New group with…"); destroyed implicitly
/// when its last member tab leaves it.
export interface TabGroup {
  id: string;
  name: string;
  /// Token reference into the group-colour palette (see TopBar.css's
  /// `--libre-tab-group-color-*` definitions). Stored as the token's
  /// suffix ("gold", "coral", "mint", "sky", "lavender") rather than
  /// a hex so a theme swap re-tints groups without re-saving state.
  colorToken: string;
}

export interface PersistedTabsSnapshot {
  tabs: OpenCourse[];
  /// Group definitions for any tab whose `groupId` is set. May be
  /// empty even when tabs[] has entries (everything ungrouped).
  /// Optional in the type so v1 snapshots (without groups) still
  /// deserialise cleanly — the loader normalises a missing array
  /// to `[]` on read.
  groups?: TabGroup[];
  activeIndex: number;
}

// Profile-scoped: open-tab snapshots reference per-profile courses.
const STORAGE_KEY = profileKey("libre:open-tabs:v2");
/// Legacy v1 storage key (no `groups`). Migrated on first load to
/// the v2 shape with `groups: []` — see `loadPersistedTabs`.
const STORAGE_KEY_V1 = profileKey("libre:open-tabs:v1");

/// Write the current open-tabs state. Silently no-ops when storage is
/// unavailable or write fails — losing one update doesn't break the
/// app, and surfacing the error would be noise.
export function savePersistedTabs(snapshot: PersistedTabsSnapshot): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* quota / private mode — fine, we'll try again next change */
  }
}

/// Drop tabs whose course or lesson no longer exists in the current
/// installed library. Stale references would crash LessonView — better
/// to silently filter and let the learner re-pick from the library.
///
/// Also drops `TabGroup` entries no longer referenced by any
/// surviving tab, and clamps `activeIndex` into the new tabs[]
/// range so the active-tab pointer never goes out of bounds.
export function validateTabsAgainstCourses(
  snapshot: PersistedTabsSnapshot,
  courses: ReadonlyArray<{ id: string; chapters: ReadonlyArray<{ lessons: ReadonlyArray<{ id: string }> }> }>,
): PersistedTabsSnapshot {
  const valid = snapshot.tabs.filter((t) => {
    const course = courses.find((c) => c.id === t.courseId);
    if (!course) return false;
    return course.chapters.some((ch) => ch.lessons.some((l) => l.id === t.lessonId));
  });
  // Always emit a normalised `groups` array (empty when missing)
  // so downstream consumers don't need to handle the undefined case.
  const referencedGroups = new Set(
    valid.map((t) => t.groupId).filter((id): id is string => !!id),
  );
  const groups = (snapshot.groups ?? []).filter((g) => referencedGroups.has(g.id));
  if (
    valid.length === snapshot.tabs.length &&
    groups.length === (snapshot.groups ?? []).length
  ) {
    return { ...snapshot, groups };
  }
  // At least one tab or group was filtered out — clamp the active
  // index to the surviving range. If the active tab was the one
  // removed we land on the same position (or the last surviving tab
  // if we ran off the end).
  const activeIndex = Math.min(snapshot.activeIndex, Math.max(0, valid.length - 1));
  return { tabs: valid, groups, activeIndex };
}

/// Read the persisted snapshot, transparently migrating the v1
/// (groupless) shape to v2 if the user is launching after a version
/// upgrade. Returns null when nothing is stored OR the stored payload
/// is unparseable. The caller is responsible for further validation
/// against the current course list (see `validateTabsAgainstCourses`).
export function loadPersistedTabs(): PersistedTabsSnapshot | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const v2 = localStorage.getItem(STORAGE_KEY);
    if (v2) {
      const parsed = JSON.parse(v2) as PersistedTabsSnapshot;
      if (parsed && Array.isArray(parsed.tabs)) {
        return { ...parsed, groups: parsed.groups ?? [] };
      }
    }
    // Fall back to v1: tabs + activeIndex, no groups. Migrate on
    // first read by writing the v2 shape and removing the v1 key.
    const v1 = localStorage.getItem(STORAGE_KEY_V1);
    if (v1) {
      const parsed = JSON.parse(v1) as { tabs?: OpenCourse[]; activeIndex?: number };
      if (parsed && Array.isArray(parsed.tabs)) {
        const migrated: PersistedTabsSnapshot = {
          tabs: parsed.tabs,
          groups: [],
          activeIndex: parsed.activeIndex ?? 0,
        };
        savePersistedTabs(migrated);
        try {
          localStorage.removeItem(STORAGE_KEY_V1);
        } catch {
          /* ignore */
        }
        return migrated;
      }
    }
  } catch {
    /* corrupt payload — fall through to null */
  }
  return null;
}

