/// Multi-project state + persistence for the Sandbox (the feature
/// formerly known as Playground). Each project is a named
/// workspace with its own file list + language + activity
/// timestamps. The Sandbox view holds an active project at any
/// time; the sidebar lets the user pick + create + delete others.
///
/// Persistence model (Phase 1):
///   - Whole list in `libre:sandbox:v1:projects` as JSON
///   - Active project id in `libre:sandbox:v1:active`
///   - Migration from the previous per-language `libre:playground:v1:*`
///     keys runs once on first load — creates one auto-project per
///     language the user had touched, so no data is lost.
///
/// Phase 2 (next turn) replaces the JSON-blob persistence with
/// real files on disk under `~/Documents/Libre Sandbox/<project>/`
/// via Tauri IPC. The hook's external API stays compatible —
/// `files: WorkbenchFile[]`, `setFiles`, `activeFileIdx`, etc. — so
/// consumers don't have to change when storage flips to disk.
///
/// Out of scope for Phase 1:
///   - Real filesystem persistence (Phase 2)
///   - Git integration (Phase 3)
///   - Project rename + duplicate (follow-up)
///   - Per-project asset bundles (the old playground didn't carry
///     binary assets either; structurally the same gap)

import { useCallback, useEffect, useRef, useState } from "react";
import type { LanguageId, WorkbenchFile } from "../data/types";
import { templateFiles } from "../runtimes/playgroundTemplates";
import {
  SANDBOX_FS_AVAILABLE,
  deleteProject as fsDeleteProject,
  listProjects as fsListProjects,
  loadProject as fsLoadProject,
  saveProject as fsSaveProject,
} from "../lib/sandboxFs";
import { profileKey } from "../lib/profileStore";

// Profile-scoped localStorage mirror of the sandbox project list.
// The on-disk projects dir is already profile-rooted in the Rust
// backend (profiles::sandbox_profile_root); namespacing the mirror
// too keeps a stale cross-profile list from flashing before the
// disk reconcile runs.
const STORAGE_PROJECTS = profileKey("libre:sandbox:v1:projects");
const STORAGE_ACTIVE = profileKey("libre:sandbox:v1:active");
const LEGACY_PLAYGROUND_PREFIX = profileKey("libre:playground:v1:");

export interface SandboxProject {
  /// Stable random id — never shown to the user; React key + the
  /// future on-disk folder name in Phase 2.
  id: string;
  /// Human-facing name. Editable in a future rename pass; for now
  /// it's set at creation time and immutable.
  name: string;
  /// Project's primary language. Determines the run-button routing
  /// + the template seed used when the project is created.
  language: LanguageId;
  /// File list, identical shape to the legacy playground's flat
  /// WorkbenchFile array. Filenames may include `/` — the
  /// SandboxFileTree groups them into nested folders at render time.
  files: WorkbenchFile[];
  /// ISO timestamp of project creation. Used by the switcher to
  /// sort if we ever need to (currently the list renders in the
  /// user's manual order — Phase 1 keeps it simple).
  createdAt: string;
  /// ISO timestamp of the last file mutation. Touched by every
  /// `setFiles` call so the switcher can show "edited 2m ago"
  /// if we want that later.
  updatedAt: string;
}

interface PersistedState {
  projects: SandboxProject[];
  /// May be a stale id (project since deleted) — the hook's
  /// resolution layer falls back to the first project, or to a
  /// freshly-seeded one if the list is empty.
  activeId: string | null;
}

export interface UseSandboxProjectsResult {
  /// All projects, in user-visible order (insertion order). The
  /// sidebar renders this verbatim.
  projects: ReadonlyArray<SandboxProject>;
  /// Currently-focused project. Never null when there's at least
  /// one project; when the list is empty the hook auto-seeds a
  /// single default project so `activeProject` is always defined.
  activeProject: SandboxProject;
  /// Switch which project the editor + tree are pointed at.
  setActiveProjectId: (id: string) => void;
  /// Mint a new project. Returns the created project so callers
  /// can immediately read its id (e.g. to focus a rename input).
  createProject: (name: string, language: LanguageId) => SandboxProject;
  /// Delete a project + its files. If the active project is
  /// deleted, the hook falls back to whichever project is next in
  /// the list, or to a freshly-seeded one if it was the last.
  deleteProject: (id: string) => void;
  /// File-level state for the ACTIVE project. Same shape the old
  /// `usePlaygroundFiles` returned, so the editor's prop wiring
  /// is unchanged.
  files: WorkbenchFile[];
  setFiles: React.Dispatch<React.SetStateAction<WorkbenchFile[]>>;
  /// Reset the active project's files back to the per-language
  /// template (same as the old playground's resetToTemplate).
  resetToTemplate: () => void;
  /// Tab / tree focus inside the active project.
  activeFileIdx: number;
  setActiveFileIdx: React.Dispatch<React.SetStateAction<number>>;
  /// Convenience writer for the language picker — flipping a
  /// project's language re-seeds its files with that language's
  /// template (Phase 1 keeps the simple replacement behaviour;
  /// Phase 2 will preserve files across language changes since
  /// projects on disk shouldn't be wiped on a language flip).
  setActiveLanguage: (next: LanguageId) => void;
}

// ── Storage helpers ──────────────────────────────────────────────

function readPersisted(): PersistedState {
  if (typeof localStorage === "undefined") return { projects: [], activeId: null };
  try {
    const raw = localStorage.getItem(STORAGE_PROJECTS);
    const projects: SandboxProject[] = raw ? JSON.parse(raw) : [];
    const activeId = localStorage.getItem(STORAGE_ACTIVE);
    return { projects: Array.isArray(projects) ? projects : [], activeId };
  } catch {
    return { projects: [], activeId: null };
  }
}

function writePersisted(state: PersistedState): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_PROJECTS, JSON.stringify(state.projects));
    if (state.activeId) localStorage.setItem(STORAGE_ACTIVE, state.activeId);
    else localStorage.removeItem(STORAGE_ACTIVE);
  } catch {
    /* quota / private mode — drop silently, in-memory state is the
       authoritative copy until the next successful write. */
  }
}

function genId(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeProject(
  name: string,
  language: LanguageId,
  files?: WorkbenchFile[],
): SandboxProject {
  const ts = nowIso();
  return {
    id: genId(),
    name,
    language,
    files: files ?? templateFiles(language),
    createdAt: ts,
    updatedAt: ts,
  };
}

/// One-shot migration of the legacy per-language Playground keys.
/// Runs whenever the sandbox project list is EMPTY and at least
/// one `libre:playground:v1:<language>` key exists. Builds one
/// project per language the user had touched and leaves the
/// original keys in place (they're harmless leftover; the user
/// can wipe them via the Data settings if they want).
function migrateFromPlayground(): SandboxProject[] {
  if (typeof localStorage === "undefined") return [];
  const out: SandboxProject[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(LEGACY_PLAYGROUND_PREFIX)) continue;
      const language = key.slice(LEGACY_PLAYGROUND_PREFIX.length) as LanguageId;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { files?: WorkbenchFile[] };
        if (!Array.isArray(parsed.files) || parsed.files.length === 0) continue;
        out.push(
          makeProject(
            `${prettyLang(language)} sandbox`,
            language,
            parsed.files,
          ),
        );
      } catch {
        /* unparseable legacy entry — skip */
      }
    }
  } catch {
    /* localStorage iteration failed — skip migration entirely */
  }
  return out;
}

function prettyLang(language: LanguageId): string {
  // Tiny capitalisation helper for the auto-migrated project name.
  // We could pull from the canonical language-label map but it's
  // not exported as a single source-of-truth; the inline cases
  // here are sufficient for the languages most users will have
  // touched.
  const map: Partial<Record<LanguageId, string>> = {
    javascript: "JavaScript",
    typescript: "TypeScript",
    python: "Python",
    rust: "Rust",
    go: "Go",
    swift: "Swift",
    java: "Java",
    kotlin: "Kotlin",
    c: "C",
    cpp: "C++",
    csharp: "C#",
    assembly: "Assembly",
    web: "Web",
    threejs: "Three.js",
    react: "React",
    reactnative: "React Native",
    solidity: "Solidity",
    vyper: "Vyper",
    svelte: "Svelte",
  };
  return map[language] ?? language;
}

// ── Hook ─────────────────────────────────────────────────────────

export function useSandboxProjects(
  defaultLanguage: LanguageId = "javascript",
): UseSandboxProjectsResult {
  // Initialise state synchronously from storage so the first
  // render already has the right project list. If the storage is
  // empty, run the legacy-Playground migration once; if THAT
  // produces nothing, seed a single starter project so the
  // sidebar never renders "no projects."
  const [persisted, setPersisted] = useState<PersistedState>(() => {
    const initial = readPersisted();
    if (initial.projects.length > 0) return initial;
    const migrated = migrateFromPlayground();
    if (migrated.length > 0) {
      return { projects: migrated, activeId: migrated[0].id };
    }
    const seed = makeProject(
      `${prettyLang(defaultLanguage)} sandbox`,
      defaultLanguage,
    );
    return { projects: [seed], activeId: seed.id };
  });

  // Resolve the active project — `activeId` may point at a
  // since-deleted project, in which case fall back to the first.
  const activeProject =
    persisted.projects.find((p) => p.id === persisted.activeId) ??
    persisted.projects[0];

  // Active file index. Held separately from persisted state since
  // we don't need to remember focus across reloads, only across
  // project switches within a session. Reset to 0 on project
  // switch via the effect below.
  const [activeFileIdx, setActiveFileIdx] = useState<number>(0);
  const lastActiveIdRef = useRef(activeProject.id);
  useEffect(() => {
    if (lastActiveIdRef.current !== activeProject.id) {
      lastActiveIdRef.current = activeProject.id;
      setActiveFileIdx(0);
    }
  }, [activeProject.id]);

  // Debounced write-through to localStorage. Mirrors usePlaygroundFiles's
  // pattern — 400ms after the last mutation, flush. Unmount flush
  // isn't strictly needed since the persisted-state object lives at
  // the App level and only unmounts on page close (where
  // localStorage doesn't accept writes anyway), but we keep it as a
  // safety net.
  useEffect(() => {
    const handle = window.setTimeout(() => writePersisted(persisted), 400);
    return () => window.clearTimeout(handle);
  }, [persisted]);

  // ── Disk sync (desktop only) ─────────────────────────────────
  //
  // The localStorage layer above gives us a synchronous boot — first
  // render already has the right project list. We layer disk
  // persistence on top so projects ALSO live as real folders under
  // `~/Documents/Libre Sandbox/<id>/`:
  //   * On mount, async-pull the disk listing and reconcile. If the
  //     disk is empty but localStorage has projects, we treat that
  //     as a first-desktop-launch migration and push the
  //     localStorage projects to disk. If the disk has more
  //     projects than localStorage (e.g. user edited a file via VS
  //     Code while Libre was closed), the disk listing wins.
  //   * On every project mutation, debounce-save the changed
  //     project to disk. The diff is computed against
  //     `lastDiskStateRef` so we only write the projects that
  //     actually changed, not the whole list.
  //   * On project delete, fire-and-forget rm -rf on the project
  //     folder.

  const lastDiskStateRef = useRef<Map<string, SandboxProject>>(new Map());
  const diskReadyRef = useRef(false);

  // Pull the disk listing into in-memory state. Extracted so it
  // can run both on mount AND in response to external mutations
  // (e.g. the AI agent's tools write to Rust directly, then fire
  // `libre:sandbox-refresh` to nudge us to re-read).
  const reconcileFromDisk = useCallback(async () => {
    if (!SANDBOX_FS_AVAILABLE) return;
    try {
      const onDisk = await fsListProjects();
      if (onDisk.length === 0) {
        // No disk projects yet. On first launch we run the
        // localStorage → disk migration; on re-pulls after that
        // a missing disk state means everything was deleted
        // out-of-band so we leave in-memory state alone.
        if (!diskReadyRef.current) {
          for (const project of persisted.projects) {
            const full = await fsLoadProject(project.id).catch(() => null);
            if (full) continue;
            await fsSaveProject(
              {
                id: project.id,
                name: project.name,
                language: project.language,
                createdAt: project.createdAt,
                updatedAt: project.updatedAt,
              },
              project.files,
            ).catch(() => undefined);
          }
        }
      } else {
        // Hydrate full bodies in parallel, then atomically
        // replace in-memory state. Mirrors the mount pull —
        // re-using the same path means agent-driven mutations
        // and user-driven mutations converge on identical
        // shape + ordering rules.
        const full = await Promise.all(
          onDisk.map((m) => fsLoadProject(m.id).catch(() => null)),
        );
        const merged: SandboxProject[] = full
          .filter((p): p is NonNullable<typeof p> => p !== null)
          .map((p) => ({
            id: p.id,
            name: p.name,
            language: p.language,
            files: p.files.map((f) => ({
              name: f.name,
              language: f.language as WorkbenchFile["language"],
              content: f.content,
              readOnly: f.readOnly,
            })),
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
          }));
        if (merged.length > 0) {
          setPersisted((prev) => {
            const stillValid = merged.some((p) => p.id === prev.activeId);
            return {
              projects: merged,
              activeId: stillValid ? prev.activeId : merged[0].id,
            };
          });
          // Refresh the dirty-tracker snapshot too — without
          // this, the next mutation effect would see every
          // re-pulled project as "different from disk" and
          // pointlessly round-trip them back out.
          lastDiskStateRef.current = new Map(merged.map((p) => [p.id, p]));
        }
      }
      diskReadyRef.current = true;
    } catch {
      /* disk unavailable — stay on localStorage-only path */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initial pull. Runs once per mount.
  useEffect(() => {
    void reconcileFromDisk();
  }, [reconcileFromDisk]);

  // Listen for external refresh nudges. The AI agent's tools
  // mutate the sandbox via the Rust commands directly (because
  // they run in module scope and don't have access to the hook
  // setter); after each mutation they dispatch
  // `libre:sandbox-refresh` so we re-pull the disk listing here.
  // Without this the agent's writes would land on disk but the
  // sidebar wouldn't reflect them until the next mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onRefresh = () => {
      void reconcileFromDisk();
    };
    window.addEventListener("libre:sandbox-refresh", onRefresh);
    return () => window.removeEventListener("libre:sandbox-refresh", onRefresh);
  }, [reconcileFromDisk]);

  // Debounced disk write-back. Compares the current state against
  // the last-known disk snapshot and writes only the projects whose
  // file list / metadata changed. Runs on every persisted change
  // but the work is gated on `diskReadyRef` so initial pull doesn't
  // race the first write.
  useEffect(() => {
    if (!SANDBOX_FS_AVAILABLE) return;
    if (!diskReadyRef.current) return;
    const handle = window.setTimeout(() => {
      const prev = lastDiskStateRef.current;
      const writes: Promise<void>[] = [];
      for (const project of persisted.projects) {
        const last = prev.get(project.id);
        if (last === project) continue;
        writes.push(
          fsSaveProject(
            {
              id: project.id,
              name: project.name,
              language: project.language,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
            },
            project.files,
          ).catch(() => undefined),
        );
      }
      // Detect deletions and unlink them from disk.
      const liveIds = new Set(persisted.projects.map((p) => p.id));
      for (const id of prev.keys()) {
        if (!liveIds.has(id)) {
          writes.push(fsDeleteProject(id).catch(() => undefined));
        }
      }
      // Update the snapshot AFTER kicking off the writes. Subsequent
      // ticks compare against this snapshot, so a write that's
      // in-flight when another mutation lands gets reissued with the
      // latest content — correct behaviour for a debounced save.
      lastDiskStateRef.current = new Map(
        persisted.projects.map((p) => [p.id, p]),
      );
      void Promise.all(writes);
    }, 800);
    return () => window.clearTimeout(handle);
  }, [persisted]);

  // ── Mutators ────────────────────────────────────────────────

  const setActiveProjectId = useCallback((id: string) => {
    setPersisted((prev) => {
      if (prev.activeId === id) return prev;
      // Forgive the "id isn't in projects yet" case. The AI agent
      // mutates disk → fires `libre:sandbox-refresh` → fires
      // `libre:sandbox-focus`. Refresh is async (re-read JSON
      // from disk), so the focus often arrives BEFORE the
      // projects array has been updated to include the new id.
      // The previous strict guard `return prev` made the active-
      // project switch silently no-op in that race, so the
      // sandbox UI stayed pointed at whatever was active before
      // the agent created the new project.
      //
      // Instead: accept the id optimistically. `activeProject`
      // resolution falls back to projects[0] when the id can't
      // be matched, so the UI doesn't crash in the brief window
      // before the refresh completes — and once the refresh
      // lands, the projects array contains the matching entry
      // and the activeId starts pointing at it correctly.
      return { ...prev, activeId: id };
    });
  }, []);

  const createProject = useCallback(
    (name: string, language: LanguageId): SandboxProject => {
      const project = makeProject(name.trim() || "Untitled", language);
      setPersisted((prev) => ({
        projects: [...prev.projects, project],
        activeId: project.id,
      }));
      return project;
    },
    [],
  );

  const deleteProject = useCallback((id: string) => {
    setPersisted((prev) => {
      const remaining = prev.projects.filter((p) => p.id !== id);
      // If the user deleted the last project, seed a fresh
      // starter so the sandbox is never empty.
      if (remaining.length === 0) {
        const seed = makeProject(
          `${prettyLang(defaultLanguage)} sandbox`,
          defaultLanguage,
        );
        return { projects: [seed], activeId: seed.id };
      }
      const nextActive =
        prev.activeId === id ? remaining[0].id : prev.activeId;
      return { projects: remaining, activeId: nextActive };
    });
  }, [defaultLanguage]);

  // File-level setters for the active project. We expose them as
  // a React.Dispatch-shaped setter so callers can do
  // `setFiles((prev) => ...)` exactly like the old hook returned.
  const setFiles = useCallback<
    React.Dispatch<React.SetStateAction<WorkbenchFile[]>>
  >((updater) => {
    setPersisted((prev) => {
      const idx = prev.projects.findIndex((p) => p.id === prev.activeId);
      if (idx < 0) return prev;
      const target = prev.projects[idx];
      const nextFiles =
        typeof updater === "function"
          ? (updater as (prev: WorkbenchFile[]) => WorkbenchFile[])(target.files)
          : updater;
      if (nextFiles === target.files) return prev;
      const nextProjects = prev.projects.slice();
      nextProjects[idx] = {
        ...target,
        files: nextFiles,
        updatedAt: nowIso(),
      };
      return { ...prev, projects: nextProjects };
    });
  }, []);

  const resetToTemplate = useCallback(() => {
    setPersisted((prev) => {
      const idx = prev.projects.findIndex((p) => p.id === prev.activeId);
      if (idx < 0) return prev;
      const target = prev.projects[idx];
      const nextProjects = prev.projects.slice();
      nextProjects[idx] = {
        ...target,
        files: templateFiles(target.language),
        updatedAt: nowIso(),
      };
      return { ...prev, projects: nextProjects };
    });
    setActiveFileIdx(0);
  }, []);

  const setActiveLanguage = useCallback((next: LanguageId) => {
    setPersisted((prev) => {
      const idx = prev.projects.findIndex((p) => p.id === prev.activeId);
      if (idx < 0) return prev;
      const target = prev.projects[idx];
      if (target.language === next) return prev;
      // Language change re-seeds the project's files with the new
      // language's template. Phase 1 simplification — Phase 2's
      // on-disk model will preserve existing files since the
      // project is then a real folder, not a per-language blob.
      const nextProjects = prev.projects.slice();
      nextProjects[idx] = {
        ...target,
        language: next,
        files: templateFiles(next),
        updatedAt: nowIso(),
      };
      return { ...prev, projects: nextProjects };
    });
    setActiveFileIdx(0);
  }, []);

  return {
    projects: persisted.projects,
    activeProject,
    setActiveProjectId,
    createProject,
    deleteProject,
    files: activeProject.files,
    setFiles,
    resetToTemplate,
    activeFileIdx,
    setActiveFileIdx,
    setActiveLanguage,
  };
}
