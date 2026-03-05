/**
 * Drawing toolbar — sits on the left side of the chart area.
 *
 * Three main buttons: Pen, Eraser, and Line.
 * Left-click toggles the tool on/off.
 * Right-click or double-click on Line opens a flyout to switch between
 * line-segment / line-ray / line-infinite.
 *
 * All drawing is native (Plugin API), no pixel overlays.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";

/* ─── Icons ─────────────────────────────────────────────── */

const PenIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19l7-7 3 3-7 7-3-3z" />
    <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
    <path d="M2 2l7.586 7.586" />
    <circle cx="11" cy="11" r="2" />
  </svg>
);

const EraserIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 20H7L3 16c-.8-.8-.8-2 0-2.8L14.6 1.6c.8-.8 2-.8 2.8 0L21.8 6c.8.8.8 2 0 2.8L12 18.6" />
    <path d="M6 14l4 4" />
    <line x1="2" y1="20" x2="7" y2="20" strokeDasharray="2 2" />
  </svg>
);

/* ── Line tool icons ── */

const SegmentIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="5" y1="19" x2="19" y2="5" />
    <circle cx="5" cy="19" r="2" fill="currentColor" />
    <circle cx="19" cy="5" r="2" fill="currentColor" />
  </svg>
);

const RayIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="5" y1="19" x2="22" y2="2" />
    <circle cx="5" cy="19" r="2" fill="currentColor" />
    <path d="M19 2l3 0l0 3" />
  </svg>
);

const InfiniteLineIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="1" y1="23" x2="23" y2="1" />
    <path d="M1 20l0 3l3 0" />
    <path d="M21 1l3 0l0 3" />
  </svg>
);

/* small indicator triangle rendered in the corner of a tool button */
const CornerTriangle = (
  <svg
    className="tool-variant-indicator"
    width="6"
    height="6"
    viewBox="0 0 6 6"
    style={{ position: "absolute", right: 2, bottom: 2 }}
  >
    <polygon points="6,0 6,6 0,6" fill="currentColor" opacity="0.55" />
  </svg>
);

/* ─── Tool variant definitions ──────────────────────────── */

const LINE_VARIANTS = [
  { id: "line-segment", label: "线段", icon: SegmentIcon },
  { id: "line-ray", label: "射线", icon: RayIcon },
  { id: "line-infinite", label: "直线", icon: InfiniteLineIcon },
];

const LINE_TOOL_IDS = new Set(LINE_VARIANTS.map((v) => v.id));

/* ─── Flyout menu component ─────────────────────────────── */

function ToolFlyout({ variants, currentId, onSelect, onClose, anchorRef }) {
  const menuRef = useRef(null);

  // Close when clicking outside
  useEffect(() => {
    const handler = (e) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose, anchorRef]);

  return (
    <div className="tool-flyout" ref={menuRef}>
      {variants.map((v) => (
        <button
          key={v.id}
          className={`tool-flyout-item ${currentId === v.id ? "selected" : ""}`}
          onClick={() => {
            onSelect(v.id);
            onClose();
          }}
        >
          <span className="tool-flyout-icon">{v.icon}</span>
          <span className="tool-flyout-label">{v.label}</span>
          {currentId === v.id && <span className="tool-flyout-check">✓</span>}
        </button>
      ))}
    </div>
  );
}

/* ─── Main toolbar ──────────────────────────────────────── */

const DrawingToolbar = memo(function DrawingToolbar({
  activeTool,
  onToolChange,
  penColor,
  onPenColorChange,
  penSize,
  onPenSizeChange,
  onClearAll,
}) {
  // Which line variant is selected (persisted across toggles)
  const [lineVariant, setLineVariant] = useState("line-segment");

  // Flyout open state: null | "line"
  const [flyoutOpen, setFlyoutOpen] = useState(null);

  const lineBtnRef = useRef(null);

  // Double-click timer
  const clickTimerRef = useRef(null);

  const isPenActive = activeTool === "pen";
  const isEraserActive = activeTool === "eraser";
  const isLineActive = LINE_TOOL_IDS.has(activeTool);

  /* ── Pen button handlers ── */
  const handlePenClick = useCallback(() => {
    if (isPenActive) {
      onToolChange(null);
    } else {
      onToolChange("pen");
    }
    setFlyoutOpen(null);
  }, [isPenActive, onToolChange]);

  /* ── Eraser button handlers ── */
  const handleEraserClick = useCallback(() => {
    if (isEraserActive) {
      onToolChange(null);
    } else {
      onToolChange("eraser");
    }
    setFlyoutOpen(null);
  }, [isEraserActive, onToolChange]);

  /* ── Line button handlers ── */
  const handleLineClick = useCallback(() => {
    if (clickTimerRef.current) return;
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      if (isLineActive) {
        onToolChange(null);
      } else {
        onToolChange(lineVariant);
      }
      setFlyoutOpen(null);
    }, 200);
  }, [isLineActive, lineVariant, onToolChange]);

  const handleLineDblClick = useCallback(() => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "line" ? null : "line"));
  }, []);

  const handleLineContextMenu = useCallback((e) => {
    e.preventDefault();
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "line" ? null : "line"));
  }, []);

  const handleSelectLineVariant = useCallback(
    (id) => {
      setLineVariant(id);
      onToolChange(id);
    },
    [onToolChange],
  );

  /* ── Determine which line icon to show ── */
  const currentLineIcon =
    LINE_VARIANTS.find((v) => v.id === lineVariant)?.icon || SegmentIcon;
  const currentLineLabel =
    LINE_VARIANTS.find((v) => v.id === lineVariant)?.label || "线段";

  const showPenOptions = isPenActive;
  const showLineOptions = isLineActive;

  return (
    <div className="drawing-toolbar">
      {/* ── Pen button ── */}
      <div className="drawing-tool-wrapper">
        <button
          className={`drawing-tool-btn ${isPenActive ? "active" : ""}`}
          onClick={handlePenClick}
          title="画笔"
        >
          {PenIcon}
        </button>
      </div>

      {/* ── Eraser button ── */}
      <div className="drawing-tool-wrapper">
        <button
          className={`drawing-tool-btn ${isEraserActive ? "active" : ""}`}
          onClick={handleEraserClick}
          title="橡皮（点击删除绘图元素）"
        >
          {EraserIcon}
        </button>
      </div>

      {/* ── Line button ── */}
      <div className="drawing-tool-wrapper" ref={lineBtnRef}>
        <button
          className={`drawing-tool-btn ${isLineActive ? "active" : ""}`}
          onClick={handleLineClick}
          onDoubleClick={handleLineDblClick}
          onContextMenu={handleLineContextMenu}
          title={`${currentLineLabel}（右键/双击切换模式）`}
        >
          {currentLineIcon}
          {CornerTriangle}
        </button>
        {flyoutOpen === "line" && (
          <ToolFlyout
            variants={LINE_VARIANTS}
            currentId={lineVariant}
            onSelect={handleSelectLineVariant}
            onClose={() => setFlyoutOpen(null)}
            anchorRef={lineBtnRef}
          />
        )}
      </div>

      {/* Divider */}
      <div className="drawing-toolbar-divider" />

      {/* ── Options for pen ── */}
      {showPenOptions && (
        <>
          <div className="drawing-tool-option" title="画笔颜色">
            <input
              type="color"
              className="drawing-color-picker"
              value={penColor}
              onChange={(e) => onPenColorChange(e.target.value)}
            />
          </div>
          <div className="drawing-tool-option" title={`画笔大小: ${penSize}px`}>
            <input
              type="range"
              className="drawing-size-slider"
              min="1"
              max="10"
              value={penSize}
              onChange={(e) => onPenSizeChange(Number(e.target.value))}
            />
          </div>
        </>
      )}

      {/* ── Options for line tools ── */}
      {showLineOptions && (
        <>
          <div className="drawing-tool-option" title="线条颜色">
            <input
              type="color"
              className="drawing-color-picker"
              value={penColor}
              onChange={(e) => onPenColorChange(e.target.value)}
            />
          </div>
          <div className="drawing-tool-option" title={`线条粗细: ${penSize}px`}>
            <input
              type="range"
              className="drawing-size-slider"
              min="1"
              max="10"
              value={penSize}
              onChange={(e) => onPenSizeChange(Number(e.target.value))}
            />
          </div>
        </>
      )}

      {/* Clear all button at the bottom */}
      <div style={{ flex: 1 }} />
      <button
        className="drawing-tool-btn drawing-clear-btn"
        onClick={onClearAll}
        title="清除所有绘图"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 6h18" />
          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
        </svg>
      </button>
    </div>
  );
});

export default DrawingToolbar;
