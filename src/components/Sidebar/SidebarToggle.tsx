/// Fixed-position sidebar toggle chip that sits in the macOS
/// title-bar overlay zone just to the right of the traffic lights.
/// Two roles in one control, mirroring Claude / VS Code / Linear:
///
///   - **Click** → toggles a persistent "pinned" state. Pin-open
///     puts the 300px course-tree sidebar back in flow; pin-closed
///     hides it from flow entirely. The 56px navigation rail is
///     NEVER touched — it's always docked at the left edge.
///   - **Hover (when pinned-closed)** → temporarily reveals the
///     sidebar as a floating overlay above content. Driven by pure
///     CSS `:has(:hover)` in App.css — synthetic React mouse events
///     were unreliable over Tauri's drag-region zone, so we use
///     native `:hover` instead.
///
/// The chip is wrapped in a hover-bridge container so the cursor
/// never crosses an inert gap on its way to the revealed sidebar —
/// see `.libre__sidebar-toggle-wrap` in the matching CSS.

import { Icon } from "@base/primitives/icon";
import { panelLeftClose } from "@base/primitives/icon/icons/panel-left-close";
import { panelLeftOpen } from "@base/primitives/icon/icons/panel-left-open";
import "@base/primitives/icon/icon.css";
import "./SidebarToggle.css";

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  ariaLabel: string;
  title: string;
}

export default function SidebarToggle({
  collapsed,
  onToggle,
  ariaLabel,
  title,
}: Props) {
  return (
    <div className="libre__sidebar-toggle-wrap">
      <button
        type="button"
        className="libre__sidebar-toggle"
        onClick={onToggle}
        // `data-tauri-drag-region` is a flag attribute Tauri checks
        // at the OS level on mousedown. Children of a drag-region
        // ancestor inherit unless they emit the literal STRING
        // "false" — passing `{false}` from React just omits the
        // attribute, which Tauri reads as "not opted out" and the
        // click becomes a window drag instead of registering on
        // this button.
        data-tauri-drag-region="false"
        aria-label={ariaLabel}
        aria-pressed={!collapsed}
        title={title}
      >
        <Icon
          icon={collapsed ? panelLeftOpen : panelLeftClose}
          size="lg"
          color="currentColor"
        />
      </button>
      {/* Invisible hover bridge — extends the toggle's hover
          footprint down + right to cover the gap the cursor would
          otherwise cross on its way to the revealed sidebar. Only
          active when the sidebar is pinned-collapsed (matched by
          a CSS rule on `.libre--sidebar-collapsed` in App.css);
          otherwise it has zero size so it doesn't intercept
          anything. */}
      <span
        className="libre__sidebar-toggle-bridge"
        aria-hidden
        data-tauri-drag-region="false"
      />
    </div>
  );
}
