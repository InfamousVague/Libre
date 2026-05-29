/// Central keybinding registry.
///
/// Every keyboard shortcut surfaced to the user funnels through this
/// module. There is exactly ONE source of truth — `BINDING_ACTIONS`
/// below — so the Settings → Shortcuts pane, the actual `keydown`
/// listeners (`useKeybinding`), and any UI that wants to display the
/// current combo for an action (e.g. a tooltip showing "Run ⌘R") all
/// agree by construction.
///
/// Design notes:
///   - The "mod" modifier resolves to Cmd on macOS / iOS and Ctrl
///     elsewhere. Action defaults are written using "mod" so we
///     never have to fork the table by platform.
///   - User overrides land in localStorage at `libre:keybindings:overrides`
///     and shadow the defaults on a per-action basis. Resetting an
///     action just removes its entry from the override map.
///   - `parseKeyEvent` normalises 1-char keys to lower-case so Shift+R
///     vs r is preserved purely via the `shift` modifier list — no
///     case mismatches inside `comboMatches`.
///   - Standalone (no-modifier) bindings are allowed only for keys
///     that wouldn't be confused with typing input (Esc, Tab, arrows,
///     Enter when not in a text field). The hook layer enforces the
///     "ignore inside inputs" rule; the registry just exposes the data.

export type Modifier = "mod" | "shift" | "alt";

export interface BindingCombo {
  /// The non-modifier key. For 1-char keys, always lowercase
  /// ("r", "/", ","). For named keys, the DOM event's `key`
  /// value verbatim ("Escape", "ArrowUp", "Enter", "Tab").
  key: string;
  modifiers: ReadonlyArray<Modifier>;
}

export type BindingScope = "global" | "lesson" | "modal";

export type BindingCategory =
  | "Lesson"
  | "Navigation"
  | "App"
  | "Modals";

export interface BindingAction {
  /// Stable id used as the override-map key + the localStorage
  /// migration key if we ever rename a default. Dotted namespace
  /// keeps the categories visually grouped in the source.
  id: string;
  label: string;
  description?: string;
  category: BindingCategory;
  scope: BindingScope;
  defaultCombo: BindingCombo;
}

/// The full action table. ORDER MATTERS — the Shortcuts pane renders
/// actions in the order they appear here within each category, so
/// the most-used action in a category should sit at the top of its
/// run.
export const BINDING_ACTIONS: ReadonlyArray<BindingAction> = [
  // ── Lesson ──────────────────────────────────────────────────────
  {
    id: "lesson.run",
    label: "Run lesson",
    description:
      "Execute the current lesson's verifier — same as clicking the Run button.",
    category: "Lesson",
    scope: "lesson",
    defaultCombo: { key: "r", modifiers: ["mod"] },
  },
  {
    id: "lesson.run.alt",
    label: "Run lesson (alternate)",
    description:
      "A second binding for Run — common chord across IDE-style apps.",
    category: "Lesson",
    scope: "lesson",
    defaultCombo: { key: "Enter", modifiers: ["mod"] },
  },

  // ── Navigation ──────────────────────────────────────────────────
  {
    id: "lesson.next",
    label: "Next lesson",
    description: "Advance to the next lesson in the current chapter.",
    category: "Navigation",
    scope: "lesson",
    defaultCombo: { key: "]", modifiers: ["mod"] },
  },
  {
    id: "lesson.prev",
    label: "Previous lesson",
    description: "Go back to the previous lesson in the current chapter.",
    category: "Navigation",
    scope: "lesson",
    defaultCombo: { key: "[", modifiers: ["mod"] },
  },
  {
    id: "chapter.next",
    label: "Next chapter",
    description: "Jump to the first lesson of the next chapter.",
    category: "Navigation",
    scope: "lesson",
    defaultCombo: { key: "ArrowDown", modifiers: ["mod"] },
  },
  {
    id: "chapter.prev",
    label: "Previous chapter",
    description: "Jump to the first lesson of the previous chapter.",
    category: "Navigation",
    scope: "lesson",
    defaultCombo: { key: "ArrowUp", modifiers: ["mod"] },
  },

  // ── App ─────────────────────────────────────────────────────────
  {
    id: "app.command-palette",
    label: "Open command palette",
    description: "Search and jump to any course, lesson, or action.",
    category: "App",
    scope: "global",
    defaultCombo: { key: "k", modifiers: ["mod"] },
  },
  {
    id: "app.settings",
    label: "Open Settings",
    description: "Open this Settings dialog from anywhere.",
    category: "App",
    scope: "global",
    defaultCombo: { key: ",", modifiers: ["mod"] },
  },
  {
    id: "app.toggle-sidebar",
    label: "Toggle sidebar",
    description: "Collapse or expand the left-side course navigator.",
    category: "App",
    scope: "global",
    defaultCombo: { key: "\\", modifiers: ["mod"] },
  },
  {
    id: "app.shortcuts-overlay",
    label: "Show all keyboard shortcuts",
    description:
      "Open a transient overlay listing every binding — handy while you're learning them.",
    category: "App",
    scope: "global",
    defaultCombo: { key: "/", modifiers: ["mod"] },
  },

  // ── Modals ──────────────────────────────────────────────────────
  {
    id: "modal.close",
    label: "Close modal / dropdown",
    description:
      "Close the topmost modal, dropdown, or transient overlay.",
    category: "Modals",
    scope: "modal",
    defaultCombo: { key: "Escape", modifiers: [] },
  },
];

/// Ordered list of categories — drives the section order in the
/// Shortcuts pane.
export const BINDING_CATEGORIES: ReadonlyArray<BindingCategory> = [
  "Lesson",
  "Navigation",
  "App",
  "Modals",
];

// ── Platform-aware formatting ─────────────────────────────────────

export function isMac(): boolean {
  try {
    return (
      typeof navigator !== "undefined" &&
      /Mac|iPhone|iPad|iPod/.test(navigator.platform)
    );
  } catch {
    return false;
  }
}

/// Pretty key labels for display. Stays platform-agnostic — the
/// modifier glyphs already encode the platform.
function formatKeyLabel(key: string): string {
  switch (key) {
    case " ":
      return "Space";
    case "Escape":
      return "Esc";
    case "ArrowUp":
      return "↑";
    case "ArrowDown":
      return "↓";
    case "ArrowLeft":
      return "←";
    case "ArrowRight":
      return "→";
    case "Enter":
      return "Enter";
    case "Tab":
      return "Tab";
    case "Backspace":
      return "Backspace";
    case "Delete":
      return "Del";
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}

/// Split a combo into its individual key labels: modifiers first
/// (in canonical order), then the main key. UI callers that want
/// to render each key as its own visible key-cap chip consume this
/// directly; `formatBinding` joins them into the legacy string
/// representation for tooltips / aria-labels.
export function formatBindingParts(combo: BindingCombo): string[] {
  const mac = isMac();
  const parts: string[] = [];
  for (const mod of combo.modifiers) {
    if (mod === "mod") parts.push(mac ? "⌘" : "Ctrl");
    if (mod === "alt") parts.push(mac ? "⌥" : "Alt");
    if (mod === "shift") parts.push(mac ? "⇧" : "Shift");
  }
  parts.push(formatKeyLabel(combo.key));
  return parts;
}

/// Render a combo as a human-readable string. Mac uses the symbol
/// glyphs (⌘⇧⌥) concatenated tightly ("⌘⇧R"); Windows / Linux use
/// the Ctrl/Shift/Alt names with `+` separators ("Ctrl+Shift+R").
export function formatBinding(combo: BindingCombo): string {
  return formatBindingParts(combo).join(isMac() ? "" : "+");
}

// ── Override persistence ──────────────────────────────────────────

type OverrideMap = Record<string, BindingCombo>;

const STORAGE_KEY = "libre:keybindings:overrides";

function readOverrides(): OverrideMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeOverrides(map: OverrideMap): void {
  try {
    if (Object.keys(map).length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    }
  } catch {
    /* private mode / quota — give up silently, defaults still work */
  }
}

/// In-memory cache of the override map. Initialised lazily on first
/// read so SSR / Node test contexts don't crash on `localStorage`.
/// Mutations write through both to memory and to disk.
let cache: OverrideMap | null = null;

/// Subscribers re-render when bindings change at runtime (the
/// Settings pane edits the live map and expects sibling UI showing
/// the same binding to update). The listener set is tiny in
/// practice — one entry per Shortcuts-pane mount.
const listeners = new Set<() => void>();

function ensureCache(): OverrideMap {
  if (cache === null) cache = readOverrides();
  return cache;
}

function notify(): void {
  for (const fn of listeners) fn();
}

export function getBinding(actionId: string): BindingCombo | null {
  const overrides = ensureCache();
  if (overrides[actionId]) return overrides[actionId];
  const action = BINDING_ACTIONS.find((a) => a.id === actionId);
  return action ? action.defaultCombo : null;
}

/// Set or clear an override. Pass `null` to remove an override and
/// fall back to the action's default.
export function setBinding(actionId: string, combo: BindingCombo | null): void {
  const overrides = ensureCache();
  if (combo === null) {
    delete overrides[actionId];
  } else {
    overrides[actionId] = combo;
  }
  writeOverrides(overrides);
  notify();
}

/// Drop every override. The next `getBinding` returns the registry
/// defaults again.
export function resetAllBindings(): void {
  cache = {};
  writeOverrides(cache);
  notify();
}

/// Subscribe to override changes. Returns an unsubscribe function.
export function subscribeBindings(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ── Event parsing + comparison ────────────────────────────────────

/// Convert a DOM keyboard event into a `BindingCombo`. The hook
/// layer compares the returned combo against the registered combo
/// for the action being checked.
export function parseKeyEvent(e: KeyboardEvent): BindingCombo {
  const modifiers: Modifier[] = [];
  if (e.metaKey || e.ctrlKey) modifiers.push("mod");
  if (e.shiftKey) modifiers.push("shift");
  if (e.altKey) modifiers.push("alt");
  // Normalise letter / digit keys to lowercase so case differences
  // (Shift uppercasing the event.key) don't leak past parsing.
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return { key, modifiers };
}

/// True when two combos have the same key and the same modifier
/// set. Order-independent — `["mod", "shift"]` matches
/// `["shift", "mod"]`.
export function comboMatches(a: BindingCombo, b: BindingCombo): boolean {
  if (a.key !== b.key) return false;
  if (a.modifiers.length !== b.modifiers.length) return false;
  for (const m of a.modifiers) {
    if (!b.modifiers.includes(m)) return false;
  }
  return true;
}

// ── Conveniences for the Shortcuts pane ──────────────────────────

/// Group actions by category in the registry-defined order. Used
/// by the Shortcuts pane to render section headers.
export function bindingsByCategory(): ReadonlyArray<{
  category: BindingCategory;
  actions: ReadonlyArray<BindingAction>;
}> {
  return BINDING_CATEGORIES.map((category) => ({
    category,
    actions: BINDING_ACTIONS.filter((a) => a.category === category),
  })).filter((group) => group.actions.length > 0);
}

/// Find an action by id. Useful for tooltip components that want
/// to show "Run (⌘R)" without hard-coding the key combo.
export function getAction(actionId: string): BindingAction | undefined {
  return BINDING_ACTIONS.find((a) => a.id === actionId);
}
