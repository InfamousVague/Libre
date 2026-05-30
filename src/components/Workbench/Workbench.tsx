import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./Workbench.css";

interface Props {
  editor: ReactNode;
  output: ReactNode;
  /// Editor's share of the workbench HEIGHT as a percentage (0–100).
  /// Default 75 — "big editor, small console". Width of the workbench
  /// is a separate state (see `widthStorageKey`) — both are persisted
  /// independently so reshaping height doesn't reset width or vice
  /// versa.
  defaultEditorPct?: number;
  /// Key used to persist the vertical (height) split. `-v3` suffix
  /// because the default moved from 70 to 75 — bumping invalidates
  /// users' previously-persisted custom heights once and lets them
  /// pick up the new default; their next manual drag re-persists.
  storageKey?: string;
  /// Key used to persist the workbench's width as a percentage of its
  /// parent (the lesson pane). Separate key so a fresh install picks up
  /// the new resizable-width default without stomping users who'd set a
  /// height split under the old key.
  widthStorageKey?: string;
  /// Workbench width as a percentage of the lesson pane. Defaults to
  /// 50 (was 62 → 56 → 48; now back at an even 50/50 reader|editor
  /// split). Pairs with the wider sidebar (clamp(300px, 33vw,
  /// 560px)) to land roughly on a 33/33/33 viewport layout when the
  /// sidebar is pinned open, and a clean 50/50 reader|editor split
  /// when the sidebar is collapsed. As with the previous bumps,
  /// existing users' persisted drag would override the new default,
  /// so `widthStorageKey` is rolled `-v2` → `-v3` and pre-cutover
  /// values are forgotten — users who drag after the cutover keep
  /// their own width.
  defaultWorkbenchPct?: number;
  /// When true, the workbench stretches to fill its parent's full
  /// width, ignoring any persisted width and hiding the width-resize
  /// handle. Used by the Playground where the card is the ONLY thing
  /// in the pane — a half-width card there leaves the other half blank.
  /// In lesson view the workbench sits next to the reader, so this
  /// stays off and the user keeps the draggable-width behaviour.
  fillWidth?: boolean;
  /// When true, the drag-resize handle applies its width percentage to
  /// the Workbench's parent element instead of the Workbench itself, and
  /// the Workbench fills its parent (relying on a CSS rule). LessonView
  /// sets this because it wraps the Workbench in
  /// `.libre__lesson-workbench-wrap` so a missing-toolchain banner
  /// can stack above the card — without this flag the wrap's width and
  /// the Workbench's width would nest (48% × 48% ≈ 23% of lesson pane).
  widthControlsParent?: boolean;
}

const MIN_EDITOR_PCT = 25;
const MIN_OUTPUT_PCT = 10;

/// Workbench width bounds as a percentage of the lesson pane width.
/// Floor keeps the editor usable; ceiling keeps at least a slice of the
/// reader visible so the learner can still reference the prose.
// 18% on a 1180px window ≈ 212px — narrow but Monaco's gutter + a few
// chars + the run-button row still fit. The CSS `min-width: 240px`
// becomes the effective floor on smaller windows. Was 28% — too high
// when the user wants the prose pane to dominate (e.g. reading lessons
// where the editor is just a sandbox).
const MIN_WORKBENCH_PCT = 18;
const MAX_WORKBENCH_PCT = 72;

/// Two-pane VERTICAL stack with a draggable horizontal divider for the
/// editor/console split, PLUS a draggable left-edge handle for the
/// whole card's width. Both ratios persist in localStorage.
export default function Workbench({
  editor,
  output,
  defaultEditorPct = 75,
  storageKey = "libre:workbench-split-v3",
  widthStorageKey = "libre:workbench-width-v3",
  defaultWorkbenchPct = 50,
  fillWidth = false,
  widthControlsParent = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // ---- Editor/console height split --------------------------------------
  const [editorPct, setEditorPct] = useState<number>(() => {
    if (typeof localStorage === "undefined") return defaultEditorPct;
    const stored = localStorage.getItem(storageKey);
    const n = stored ? parseFloat(stored) : NaN;
    return Number.isFinite(n) && n >= MIN_EDITOR_PCT && n <= 100 - MIN_OUTPUT_PCT
      ? n
      : defaultEditorPct;
  });
  const splitDraggingRef = useRef(false);

  const onSplitPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      splitDraggingRef.current = true;
    },
    [],
  );
  const onSplitPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!splitDraggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const rel = (e.clientY - rect.top) / rect.height;
      const pct = Math.max(
        MIN_EDITOR_PCT,
        Math.min(100 - MIN_OUTPUT_PCT, rel * 100),
      );
      setEditorPct(pct);
    },
    [],
  );
  const onSplitPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!splitDraggingRef.current) return;
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      splitDraggingRef.current = false;
    },
    [],
  );
  const onSplitDoubleClick = useCallback(() => {
    setEditorPct(defaultEditorPct);
  }, [defaultEditorPct]);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    const id = setTimeout(() => {
      localStorage.setItem(storageKey, editorPct.toFixed(2));
    }, 200);
    return () => clearTimeout(id);
  }, [editorPct, storageKey]);

  // ---- Workbench width (horizontal resize) -----------------------------
  const [workbenchPct, setWorkbenchPct] = useState<number>(() => {
    if (typeof localStorage === "undefined") return defaultWorkbenchPct;
    const stored = localStorage.getItem(widthStorageKey);
    const n = stored ? parseFloat(stored) : NaN;
    return Number.isFinite(n) && n >= MIN_WORKBENCH_PCT && n <= MAX_WORKBENCH_PCT
      ? n
      : defaultWorkbenchPct;
  });
  const widthDraggingRef = useRef(false);

  const onWidthPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      widthDraggingRef.current = true;
    },
    [],
  );
  const onWidthPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!widthDraggingRef.current || !containerRef.current) return;
      // The reader+workbench share a flex-row ancestor. When we control
      // our own width, that's parentElement; when we control the wrap's
      // width (widthControlsParent), parentElement IS the wrap and we
      // need to go up one more level to get the flex-row.
      const self = containerRef.current;
      const sizingBox = widthControlsParent
        ? self.parentElement?.parentElement
        : self.parentElement;
      if (!sizingBox) return;
      const rect = sizingBox.getBoundingClientRect();
      // Workbench is on the right, so drag-from-right is natural:
      // width in px = box.right - pointer.x. pct stays meaningful even
      // as the window resizes because we re-measure every pointer move.
      const widthPx = rect.right - e.clientX;
      const pct = (widthPx / rect.width) * 100;
      setWorkbenchPct(
        Math.max(MIN_WORKBENCH_PCT, Math.min(MAX_WORKBENCH_PCT, pct)),
      );
    },
    [widthControlsParent],
  );
  const onWidthPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!widthDraggingRef.current) return;
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      widthDraggingRef.current = false;
    },
    [],
  );
  const onWidthDoubleClick = useCallback(() => {
    setWorkbenchPct(defaultWorkbenchPct);
  }, [defaultWorkbenchPct]);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    const id = setTimeout(() => {
      localStorage.setItem(widthStorageKey, workbenchPct.toFixed(2));
    }, 200);
    return () => clearTimeout(id);
  }, [workbenchPct, widthStorageKey]);

  // `widthControlsParent` mode: drive the parent element's inline width
  // instead of ours. useLayoutEffect runs before paint so the wrap sizes
  // correctly on the first render without a flash at the fallback 48%.
  useLayoutEffect(() => {
    if (!widthControlsParent || fillWidth) return;
    const parent = containerRef.current?.parentElement;
    if (!parent) return;
    parent.style.width = `${workbenchPct}%`;
    return () => {
      parent.style.width = "";
    };
  }, [workbenchPct, widthControlsParent, fillWidth]);

  return (
    <div
      className={`libre-workbench ${fillWidth ? "libre-workbench--fill" : ""}`}
      ref={containerRef}
      style={fillWidth || widthControlsParent ? undefined : { width: `${workbenchPct}%` }}
    >
      {/* Left-edge drag handle for the card's overall width. Hidden when
          `fillWidth` is set (nothing useful to resize against). */}
      {!fillWidth && (
        <div
          className="libre-workbench-width-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize workbench width"
          onPointerDown={onWidthPointerDown}
          onPointerMove={onWidthPointerMove}
          onPointerUp={onWidthPointerUp}
          onPointerCancel={onWidthPointerUp}
          onDoubleClick={onWidthDoubleClick}
          title="Drag to resize workbench · double-click to reset"
        />
      )}

      <div
        className="libre-workbench-pane libre-workbench-pane--editor"
        style={{ height: `${editorPct}%` }}
      >
        {editor}
      </div>
      <div
        className="libre-workbench-divider"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize editor and console"
        onPointerDown={onSplitPointerDown}
        onPointerMove={onSplitPointerMove}
        onPointerUp={onSplitPointerUp}
        onPointerCancel={onSplitPointerUp}
        onDoubleClick={onSplitDoubleClick}
        title="Drag to resize · double-click to reset"
      >
        <div className="libre-workbench-divider-grip" aria-hidden />
      </div>
      <div
        className="libre-workbench-pane libre-workbench-pane--output"
        style={{ height: `${100 - editorPct}%` }}
      >
        {output}
      </div>
    </div>
  );
}
