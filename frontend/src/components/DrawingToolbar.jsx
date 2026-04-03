/**
 * Drawing toolbar — sits on the left side of the chart area.
 *
 * Buttons: Pen, Eraser, Line, Text, Fibonacci.
 * Left-click toggles the tool on/off.
 * Right-click or double-click on Line opens a flyout to switch between
 * line-segment / line-ray / line-infinite.
 *
 * All drawing is native (Plugin API), no pixel overlays.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_FIB_LEVELS } from "./primitives/FibonacciDrawingPrimitive.js";

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

const TextIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 7V4h16v3" />
    <line x1="12" y1="4" x2="12" y2="20" />
    <line x1="8" y1="20" x2="16" y2="20" />
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

const FibonacciIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="4" x2="20" y2="20" />
    <line x1="3" y1="9" x2="21" y2="9" opacity="0.5" />
    <line x1="3" y1="13" x2="21" y2="13" opacity="0.5" />
    <line x1="3" y1="17" x2="21" y2="17" opacity="0.5" />
    <circle cx="4" cy="4" r="2" fill="currentColor" />
    <circle cx="20" cy="20" r="2" fill="currentColor" />
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

/* ─── Fibonacci levels settings panel ───────────────────── */

const FIB_RANDOM_COLORS = [
  "#e91e63", "#9c27b0", "#673ab7", "#3f51b5", "#2196f3",
  "#00bcd4", "#4caf50", "#8bc34a", "#cddc39", "#ffc107",
  "#ff9800", "#ff5722", "#795548", "#607d8b",
];

function FibLevelsPanel({ levels, onLevelsChange, inverted, onInvertedChange, onClose, anchorRef }) {
  const panelRef = useRef(null);
  const [newLevelInput, setNewLevelInput] = useState("");

  useEffect(() => {
    const handler = (e) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose, anchorRef]);

  const toggleLevel = (idx) => {
    const next = levels.map((l, i) => i === idx ? { ...l, enabled: !l.enabled } : l);
    onLevelsChange(next);
  };

  const changeLevelColor = (idx, color) => {
    const next = levels.map((l, i) => i === idx ? { ...l, color } : l);
    onLevelsChange(next);
  };

  const removeLevel = (idx) => {
    const next = levels.filter((_, i) => i !== idx);
    onLevelsChange(next);
  };

  const addCustomLevel = () => {
    const val = parseFloat(newLevelInput);
    if (isNaN(val)) return;
    if (levels.some((l) => Math.abs(l.level - val) < 0.0001)) return;
    const color = FIB_RANDOM_COLORS[levels.length % FIB_RANDOM_COLORS.length];
    const next = [...levels, { level: val, color, enabled: true }].sort((a, b) => a.level - b.level);
    onLevelsChange(next);
    setNewLevelInput("");
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") addCustomLevel();
    e.stopPropagation();
  };

  const isDefault = (lvl) => DEFAULT_FIB_LEVELS.some((d) => Math.abs(d.level - lvl.level) < 0.0001);

  return (
    <div className="fib-levels-panel" ref={panelRef}>
      <div className="fib-levels-header">
        <span>斐波那契设置</span>
        <button className="fib-levels-close" onClick={onClose}>✕</button>
      </div>

      {/* Inverted toggle */}
      <div className="fib-invert-row">
        <label className="fib-invert-label">
          <span>第一次点击定义</span>
          <button
            className={`fib-invert-btn ${!inverted ? "active" : ""}`}
            onClick={() => onInvertedChange(false)}
          >
            0
          </button>
          <button
            className={`fib-invert-btn ${inverted ? "active" : ""}`}
            onClick={() => onInvertedChange(true)}
          >
            1
          </button>
        </label>
      </div>

      <div className="fib-levels-divider" />

      {/* Level list */}
      <div className="fib-levels-list">
        {levels.map((lvl, idx) => (
          <div key={idx} className="fib-level-row">
            <input
              type="checkbox"
              checked={lvl.enabled}
              onChange={() => toggleLevel(idx)}
              className="fib-level-check"
            />
            <input
              type="color"
              value={lvl.color}
              onChange={(e) => changeLevelColor(idx, e.target.value)}
              className="fib-level-color"
            />
            <span className={`fib-level-value ${!lvl.enabled ? "disabled" : ""}`}>
              {lvl.level}
            </span>
            {!isDefault(lvl) && (
              <button className="fib-level-remove" onClick={() => removeLevel(idx)} title="删除">
                ✕
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Add custom level */}
      <div className="fib-add-level-row">
        <input
          type="text"
          className="fib-add-level-input"
          placeholder="添加比例 (如 1.414)"
          value={newLevelInput}
          onChange={(e) => setNewLevelInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button className="fib-add-level-btn" onClick={addCustomLevel}>+</button>
      </div>
    </div>
  );
}

/* ─── Font size options ─────────────────────────────────── */

const FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32];

/* ─── Main toolbar ──────────────────────────────────────── */

const DrawingToolbar = memo(function DrawingToolbar({
  activeTool,
  onToolChange,
  penColor,
  onPenColorChange,
  penSize,
  onPenSizeChange,
  onClearAll,
  // Text settings
  textFontSize = 14,
  onTextFontSizeChange,
  textBold = false,
  onTextBoldChange,
  textItalic = false,
  onTextItalicChange,
  // Fibonacci settings
  fibLevels,
  onFibLevelsChange,
  fibInverted = false,
  onFibInvertedChange,
}) {
  // Which line variant is selected (persisted across toggles)
  const [lineVariant, setLineVariant] = useState("line-segment");

  // Flyout open state: null | "line" | "fib-levels"
  const [flyoutOpen, setFlyoutOpen] = useState(null);

  const lineBtnRef = useRef(null);
  const fibBtnRef = useRef(null);

  // Double-click timer
  const clickTimerRef = useRef(null);

  const isPenActive = activeTool === "pen";
  const isEraserActive = activeTool === "eraser";
  const isLineActive = LINE_TOOL_IDS.has(activeTool);
  const isTextActive = activeTool === "text";
  const isFibonacciActive = activeTool === "fibonacci";

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

  /* ── Text button handlers ── */
  const handleTextClick = useCallback(() => {
    if (isTextActive) {
      onToolChange(null);
    } else {
      onToolChange("text");
    }
    setFlyoutOpen(null);
  }, [isTextActive, onToolChange]);

  /* ── Fibonacci button handlers ── */
  const handleFibonacciClick = useCallback(() => {
    if (isFibonacciActive) {
      onToolChange(null);
    } else {
      onToolChange("fibonacci");
    }
    setFlyoutOpen(null);
  }, [isFibonacciActive, onToolChange]);

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
  const showTextOptions = isTextActive;
  const showFibonacciOptions = isFibonacciActive;

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

      {/* ── Text button ── */}
      <div className="drawing-tool-wrapper">
        <button
          className={`drawing-tool-btn ${isTextActive ? "active" : ""}`}
          onClick={handleTextClick}
          title="文字标注（点击放置，双击编辑）"
        >
          {TextIcon}
        </button>
      </div>

      {/* ── Fibonacci button ── */}
      <div className="drawing-tool-wrapper" ref={fibBtnRef}>
        <button
          className={`drawing-tool-btn ${isFibonacciActive ? "active" : ""}`}
          onClick={handleFibonacciClick}
          onContextMenu={(e) => {
            e.preventDefault();
            setFlyoutOpen((prev) => (prev === "fib-levels" ? null : "fib-levels"));
          }}
          onDoubleClick={() => {
            setFlyoutOpen((prev) => (prev === "fib-levels" ? null : "fib-levels"));
          }}
          title="斐波那契回撤（右键/双击打开设置）"
        >
          {FibonacciIcon}
          {CornerTriangle}
        </button>
        {flyoutOpen === "fib-levels" && (
          <FibLevelsPanel
            levels={fibLevels || DEFAULT_FIB_LEVELS}
            onLevelsChange={(levels) => onFibLevelsChange?.(levels)}
            inverted={fibInverted}
            onInvertedChange={(v) => onFibInvertedChange?.(v)}
            onClose={() => setFlyoutOpen(null)}
            anchorRef={fibBtnRef}
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
      {(showLineOptions || showFibonacciOptions) && (
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

      {/* ── Options for text tool ── */}
      {showTextOptions && (
        <>
          <div className="drawing-tool-option" title="文字颜色">
            <input
              type="color"
              className="drawing-color-picker"
              value={penColor}
              onChange={(e) => onPenColorChange(e.target.value)}
            />
          </div>
          <div className="drawing-tool-option" title="字号">
            <select
              className="drawing-font-size-select"
              value={textFontSize}
              onChange={(e) => onTextFontSizeChange?.(Number(e.target.value))}
            >
              {FONT_SIZES.map((s) => (
                <option key={s} value={s}>{s}px</option>
              ))}
            </select>
          </div>
          <div className="drawing-tool-option">
            <button
              className={`drawing-tool-btn drawing-format-btn ${textBold ? "active" : ""}`}
              onClick={() => onTextBoldChange?.(!textBold)}
              title="加粗"
              style={{ fontWeight: "bold", fontSize: 14, minWidth: 28 }}
            >
              B
            </button>
          </div>
          <div className="drawing-tool-option">
            <button
              className={`drawing-tool-btn drawing-format-btn ${textItalic ? "active" : ""}`}
              onClick={() => onTextItalicChange?.(!textItalic)}
              title="斜体"
              style={{ fontStyle: "italic", fontSize: 14, minWidth: 28 }}
            >
              I
            </button>
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
