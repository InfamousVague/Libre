/// Keyboard shortcuts settings pane.
///
/// Lists every action in `BINDING_ACTIONS`, grouped by category,
/// with the current combo rendered as a kbd-style chip. Clicking
/// the chip opens an inline `<ShortcutCapture>` that listens for
/// the next keystroke and persists it via `setBinding`. A small
/// reset arrow next to each chip clears the override (returning
/// the action to its default). A "Reset all" button at the top
/// drops the whole override map in one click.
///
/// The pane subscribes to `subscribeBindings` so external mutators
/// (or another instance of this pane mounted simultaneously) keep
/// each row in sync without prop-drilling. The subscription just
/// bumps a render counter.

import { useEffect, useState } from "react";
import { Icon } from "@base/primitives/icon";
import { pencil } from "@base/primitives/icon/icons/pencil";
import { rotateCcw } from "@base/primitives/icon/icons/rotate-ccw";
import "@base/primitives/icon/icon.css";
import SettingsCard, { SettingsPage } from "./SettingsCard";
import {
  type BindingAction,
  type BindingCombo,
  BINDING_ACTIONS,
  bindingsByCategory,
  formatBinding,
  formatBindingParts,
  isMac,
  getBinding,
  resetAllBindings,
  setBinding,
  subscribeBindings,
} from "../../../lib/keybindings/registry";
import { ShortcutCapture } from "./ShortcutCapture";
import { useT, type TFunction } from "../../../i18n/i18n";
import "./ShortcutsPane.css";

export default function ShortcutsPane() {
  const t = useT();
  // Cheap re-render trigger when the override map mutates. We
  // don't need to mirror the map into state — `getBinding` reads
  // the live cache; this counter just nudges React.
  const [, setTick] = useState(0);
  useEffect(() => subscribeBindings(() => setTick((n) => n + 1)), []);

  // Which row is currently in capture mode. Only one at a time —
  // opening a second row implicitly cancels the first.
  const [editingId, setEditingId] = useState<string | null>(null);

  const groups = bindingsByCategory();

  // Override count, for the "Reset all" button's enabled state +
  // its label ("Reset all (3)").
  const overrideCount = countOverrides();

  return (
    <SettingsPage
      title={t("settings.shortcutsTitle")}
      description={t("settings.shortcutsDescription")}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginTop: -12,
        }}
      >
        <button
          type="button"
          className="libre-shortcuts-pane__reset-all"
          onClick={() => {
            if (overrideCount === 0) return;
            resetAllBindings();
            setEditingId(null);
          }}
          disabled={overrideCount === 0}
          title={
            overrideCount === 0
              ? t("settings.resetAllDisabledHint")
              : t(
                  overrideCount === 1
                    ? "settings.resetAllHint"
                    : "settings.resetAllHintPlural",
                  { count: overrideCount },
                )
          }
        >
          <Icon icon={rotateCcw} size="xs" color="currentColor" />
          {overrideCount === 0
            ? t("settings.resetAll")
            : t("settings.resetAllWithCount", { count: overrideCount })}
        </button>
      </div>

      <div className="libre-shortcuts-pane libre-shortcuts-pane--carded">
        {groups.map(({ category, actions }) => (
          <SettingsCard key={category} title={category}>
            <ul className="libre-shortcuts-pane__rows">
              {actions.map((action) => (
                <ShortcutRow
                  key={action.id}
                  action={action}
                  editing={editingId === action.id}
                  onStartEdit={() => setEditingId(action.id)}
                  onStopEdit={() => setEditingId(null)}
                  t={t}
                />
              ))}
            </ul>
          </SettingsCard>
        ))}
      </div>
    </SettingsPage>
  );
}

interface RowProps {
  action: BindingAction;
  editing: boolean;
  onStartEdit: () => void;
  onStopEdit: () => void;
  t: TFunction;
}

function ShortcutRow({ action, editing, onStartEdit, onStopEdit, t }: RowProps) {
  const current = getBinding(action.id);
  const isOverridden = !sameCombo(current, action.defaultCombo);

  function handleCapture(combo: BindingCombo) {
    // Resolve conflicts: if another action is already bound to the
    // exact same combo, clear that other binding first so the
    // newest assignment wins. The user gets an inline note
    // explaining the swap. (We could refuse the rebind instead;
    // letting the user override and explaining the consequence is
    // friendlier for a single-user app.)
    const conflict = findConflict(action.id, combo);
    if (conflict) {
      setBinding(conflict.id, makeUnbound(conflict.id));
    }
    setBinding(action.id, combo);
    onStopEdit();
  }

  return (
    <li className="libre-shortcuts-pane__row">
      <div className="libre-shortcuts-pane__row-text">
        <span className="libre-shortcuts-pane__row-label">{action.label}</span>
        {action.description && (
          <span className="libre-shortcuts-pane__row-desc">
            {action.description}
          </span>
        )}
      </div>
      <div className="libre-shortcuts-pane__row-actions">
        {editing ? (
          <ShortcutCapture onCapture={handleCapture} onCancel={onStopEdit} />
        ) : (
          <button
            type="button"
            className={
              "libre-shortcuts-pane__chip" +
              (isOverridden ? " libre-shortcuts-pane__chip--custom" : "")
            }
            onClick={onStartEdit}
            title={t("settings.clickToRebind")}
            aria-label={t("settings.bindingAria", {
              action: action.label,
              combo: formatBinding(current!),
            })}
          >
            {/* One <kbd> per key part (modifiers first, main key
                last) so each renders as its own visible key cap
                inside the chip's "input"-style container. Non-Mac
                callers get a `+` separator between caps the way
                native shortcut UIs (VSCode, Slack) display them;
                Mac concatenates with no glue since the chord
                glyphs (⌘⇧⌥) already read as a sequence. */}
            <span className="libre-shortcuts-pane__keys" aria-hidden>
              {formatBindingParts(current!).flatMap((part, i, arr) => {
                const cap = (
                  <kbd
                    key={`k${i}`}
                    className="libre-shortcuts-pane__key"
                  >
                    {part}
                  </kbd>
                );
                const needsPlus = !isMac() && i < arr.length - 1;
                return needsPlus
                  ? [
                      cap,
                      <span
                        key={`p${i}`}
                        className="libre-shortcuts-pane__key-plus"
                        aria-hidden
                      >
                        +
                      </span>,
                    ]
                  : [cap];
              })}
            </span>
            <Icon icon={pencil} size="xs" color="currentColor" />
          </button>
        )}
        <button
          type="button"
          className="libre-shortcuts-pane__reset"
          onClick={() => setBinding(action.id, null)}
          disabled={!isOverridden}
          title={
            isOverridden
              ? t("settings.resetToDefault", {
                  combo: formatBinding(action.defaultCombo),
                })
              : t("settings.bindingAlreadyDefault")
          }
          aria-label={t("settings.resetActionAria", { action: action.label })}
        >
          <Icon icon={rotateCcw} size="xs" color="currentColor" />
        </button>
      </div>
    </li>
  );
}

// ── Helpers ─────────────────────────────────────────────────────

function sameCombo(
  a: BindingCombo | null,
  b: BindingCombo | null,
): boolean {
  if (!a || !b) return a === b;
  if (a.key !== b.key) return false;
  if (a.modifiers.length !== b.modifiers.length) return false;
  for (const m of a.modifiers) if (!b.modifiers.includes(m)) return false;
  return true;
}

function countOverrides(): number {
  let n = 0;
  for (const a of BINDING_ACTIONS) {
    const cur = getBinding(a.id);
    if (!sameCombo(cur, a.defaultCombo)) n += 1;
  }
  return n;
}

function findConflict(
  selfId: string,
  combo: BindingCombo,
): BindingAction | null {
  for (const a of BINDING_ACTIONS) {
    if (a.id === selfId) continue;
    const cur = getBinding(a.id);
    if (cur && sameCombo(cur, combo)) return a;
  }
  return null;
}

/// We don't have a "this action has no binding" state in the
/// registry — clearing an override returns the default. So when
/// resolving a conflict, we substitute a sentinel combo that
/// matches nothing real. A combo with a literal empty-string key
/// can never be produced by `parseKeyEvent` (which always reads
/// `e.key`, non-empty in browsers), so it's a safe "off" marker.
function makeUnbound(_id: string): BindingCombo {
  return { key: "", modifiers: [] };
}
