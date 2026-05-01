/**
 * Drawing toolbar — sits on the left side of the chart area.
 *
 * Buttons: Mouse cursor, Pen/Highlighter, Eraser, Line, Shape, Text, Fibonacci, Position (Long/Short).
 * Left-click toggles the tool on/off.
 * Right-click or double-click on Cursor / Pen / Line / Shape opens a flyout to switch variants.
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

const HighlighterIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 20h7" />
    <path d="M13.5 3.5l7 7-8.5 8.5H6.5l7-15.5z" />
    <path d="M12 6l6 6" />
    <path d="M6.5 19L4 21.5" opacity="0.6" />
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

const MouseDefaultIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 3l7.5 17 2.1-7.1L21 10.2 5 3z" />
    <line x1="17" y1="4" x2="17" y2="8" opacity="0.65" />
    <line x1="15" y1="6" x2="19" y2="6" opacity="0.65" />
  </svg>
);

const MouseCrosshairIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 4l6.6 15 1.7-6 5.7-2.3L4 4z" />
    <line x1="17" y1="3" x2="17" y2="9" />
    <line x1="14" y1="6" x2="20" y2="6" />
  </svg>
);

const CursorDotIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 3l7.5 17 2.1-7.1L21 10.2 5 3z" opacity="0.55" />
    <circle cx="17" cy="7" r="2.4" fill="currentColor" stroke="none" />
  </svg>
);

const CursorHighlighterIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 3l7.5 17 2.1-7.1L21 10.2 5 3z" opacity="0.5" />
    <circle cx="17" cy="7" r="4.4" fill="currentColor" stroke="none" opacity="0.28" />
    <circle cx="17" cy="7" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

const MousePlainIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 3l7.5 17 2.1-7.1L21 10.2 5 3z" />
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

const HorizontalLineIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="3" y1="12" x2="21" y2="12" />
    <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
  </svg>
);

const VerticalLineIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="3" x2="12" y2="21" />
    <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
  </svg>
);

const CrossLineIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="12" y1="3" x2="12" y2="21" />
    <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
  </svg>
);

const AngleMeasureIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 20h16" opacity="0.55" strokeDasharray="3 3" />
    <path d="M4 20L18 6" />
    <path d="M9 20a5 5 0 0 0-1.5-3.5" />
    <text x="12.5" y="18" fontSize="6" fill="currentColor" stroke="none">°</text>
  </svg>
);

/* ── Shape tool icons ── */

const RectangleIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="6" width="16" height="12" rx="1.5" />
    <circle cx="4" cy="6" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="20" cy="18" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

const EllipseIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="12" cy="12" rx="8" ry="5.5" />
    <circle cx="4" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="20" cy="12" r="1.6" fill="currentColor" stroke="none" />
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

/* ── Position tool icons ── */

const LongPositionIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="6" width="18" height="3" rx="1" fill="#26a69a" stroke="none" opacity="0.5" />
    <line x1="3" y1="12" x2="21" y2="12" stroke="#2196f3" strokeWidth="2" />
    <rect x="3" y="15" width="18" height="3" rx="1" fill="#ef5350" stroke="none" opacity="0.5" />
    <path d="M12 3l3 4h-6l3-4z" fill="#26a69a" stroke="none" />
    <path d="M12 21l3-4h-6l3 4z" fill="#ef5350" stroke="none" />
  </svg>
);

const ShortPositionIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="6" width="18" height="3" rx="1" fill="#ef5350" stroke="none" opacity="0.5" />
    <line x1="3" y1="12" x2="21" y2="12" stroke="#2196f3" strokeWidth="2" />
    <rect x="3" y="15" width="18" height="3" rx="1" fill="#26a69a" stroke="none" opacity="0.5" />
    <path d="M12 3l3 4h-6l3-4z" fill="#ef5350" stroke="none" />
    <path d="M12 21l3-4h-6l3 4z" fill="#26a69a" stroke="none" />
  </svg>
);

const MagnetIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3h4v7a2 2 0 0 0 4 0V3h4v7a6 6 0 0 1-12 0V3z" />
    <line x1="6" y1="7" x2="10" y2="7" />
    <line x1="14" y1="7" x2="18" y2="7" />
  </svg>
);

const ExportIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    <path d="M12 3v12" />
    <path d="M7 10l5 5 5-5" />
    <rect x="5" y="5" width="14" height="9" rx="2" opacity="0.25" />
  </svg>
);

const CandlestickChartIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="6" y1="4" x2="6" y2="20" />
    <rect x="4" y="8" width="4" height="7" rx="1" fill="currentColor" stroke="none" opacity="0.75" />
    <line x1="12" y1="3" x2="12" y2="21" />
    <rect x="10" y="6" width="4" height="10" rx="1" fill="currentColor" stroke="none" opacity="0.45" />
    <line x1="18" y1="5" x2="18" y2="19" />
    <rect x="16" y="10" width="4" height="5" rx="1" fill="currentColor" stroke="none" opacity="0.75" />
  </svg>
);

const OhlcBarChartIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="7" y1="5" x2="7" y2="19" />
    <line x1="4" y1="9" x2="7" y2="9" />
    <line x1="7" y1="15" x2="10" y2="15" />
    <line x1="13" y1="3" x2="13" y2="21" />
    <line x1="10" y1="7" x2="13" y2="7" />
    <line x1="13" y1="17" x2="16" y2="17" />
    <line x1="19" y1="6" x2="19" y2="18" />
    <line x1="16" y1="12" x2="19" y2="12" />
    <line x1="19" y1="10" x2="22" y2="10" />
  </svg>
);

const ChartLineIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3,17 8,12 12,14 17,7 21,10" />
    <circle cx="8" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="17" cy="7" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

const ChartAreaIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 18l5-6 4 3 5-8 4 4v7H3z" fill="currentColor" stroke="none" opacity="0.22" />
    <polyline points="3,18 8,12 12,15 17,7 21,11" />
    <line x1="3" y1="18" x2="21" y2="18" opacity="0.45" />
  </svg>
);

const ChartBaselineIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="3" y1="12" x2="21" y2="12" strokeDasharray="3 3" opacity="0.55" />
    <path d="M3 12l5-5 4 3 4 7 5-5" />
    <path d="M3 12l5-5 4 3v2H3z" fill="#26a69a" stroke="none" opacity="0.25" />
    <path d="M12 12l4 5 5-5v6h-9z" fill="#ef5350" stroke="none" opacity="0.22" />
  </svg>
);

const ChartHistogramIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="13" width="3" height="6" rx="0.8" fill="currentColor" stroke="none" opacity="0.5" />
    <rect x="9" y="8" width="3" height="11" rx="0.8" fill="currentColor" stroke="none" opacity="0.75" />
    <rect x="14" y="5" width="3" height="14" rx="0.8" fill="currentColor" stroke="none" opacity="0.55" />
    <rect x="19" y="10" width="3" height="9" rx="0.8" fill="currentColor" stroke="none" opacity="0.8" />
    <line x1="3" y1="20" x2="22" y2="20" opacity="0.5" />
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

const CURSOR_VARIANTS = [
  { id: "cursor-default", label: "默认鼠标", icon: MouseDefaultIcon },
  { id: "cursor-crosshair", label: "十字星", icon: MouseCrosshairIcon },
  { id: "cursor-dot", label: "圆点", icon: CursorDotIcon },
  { id: "cursor-highlighter", label: "荧光笔光标", icon: CursorHighlighterIcon },
  { id: "cursor-plain", label: "纯鼠标", icon: MousePlainIcon },
];

const CURSOR_TOOL_IDS = new Set(CURSOR_VARIANTS.map((v) => v.id));

const FREEHAND_VARIANTS = [
  { id: "pen", label: "画笔", icon: PenIcon },
  { id: "highlighter", label: "荧光笔", icon: HighlighterIcon },
];

const FREEHAND_TOOL_IDS = new Set(FREEHAND_VARIANTS.map((v) => v.id));

const LINE_VARIANTS = [
  { id: "line-segment", label: "线段", icon: SegmentIcon },
  { id: "line-ray", label: "射线", icon: RayIcon },
  { id: "line-infinite", label: "直线", icon: InfiniteLineIcon },
  { id: "line-horizontal", label: "水平线", icon: HorizontalLineIcon },
  { id: "line-vertical", label: "垂直线", icon: VerticalLineIcon },
  { id: "line-cross", label: "十字线", icon: CrossLineIcon },
  { id: "angle-measure", label: "角度", icon: AngleMeasureIcon },
];

const LINE_TOOL_IDS = new Set(LINE_VARIANTS.map((v) => v.id));

const SHAPE_VARIANTS = [
  { id: "shape-rectangle", label: "矩形", icon: RectangleIcon },
  { id: "shape-ellipse", label: "圆形/椭圆", icon: EllipseIcon },
];

const SHAPE_TOOL_IDS = new Set(SHAPE_VARIANTS.map((v) => v.id));

const POSITION_VARIANTS = [
  { id: "position-long", label: "做多", icon: LongPositionIcon },
  { id: "position-short", label: "做空", icon: ShortPositionIcon },
];

const POSITION_TOOL_IDS = new Set(POSITION_VARIANTS.map((v) => v.id));

const CHART_TYPE_VARIANTS = [
  { id: "candlestick", label: "K线", description: "当前主图默认样式", icon: CandlestickChartIcon },
  { id: "bar", label: "OHLC柱", description: "库支持；暂未接入切换", icon: OhlcBarChartIcon },
  { id: "line", label: "折线", description: "库支持；暂未接入切换", icon: ChartLineIcon },
  { id: "area", label: "面积", description: "库支持；暂未接入切换", icon: ChartAreaIcon },
  { id: "baseline", label: "基准线", description: "库支持；暂未接入切换", icon: ChartBaselineIcon },
  { id: "histogram", label: "柱状", description: "库支持；更适合成交量", icon: ChartHistogramIcon },
];

/* ─── Flyout menu component ─────────────────────────────── */

function ToolFlyout({ variants, currentId, onSelect, onClose, anchorRef, className = "" }) {
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
    <div className={`tool-flyout ${className}`.trim()} ref={menuRef}>
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
          <span className="tool-flyout-label">
            <span className="tool-flyout-label-main">{v.label}</span>
            {v.description && <span className="tool-flyout-description">{v.description}</span>}
          </span>
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

/* ─── Position settings panel ────────────────────────────── */

function PositionSettingsPanel({ positionSize, onPositionSizeChange, onClose, anchorRef }) {
  const panelRef = useRef(null);
  const [localSize, setLocalSize] = useState(String(positionSize || 1000));

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

  const handleSizeChange = (val) => {
    setLocalSize(val);
    const num = parseFloat(val);
    if (!isNaN(num) && num > 0) {
      onPositionSizeChange(num);
    }
  };

  const presets = [100, 500, 1000, 5000, 10000, 50000];

  return (
    <div className="position-settings-panel" ref={panelRef}>
      <div className="fib-levels-header">
        <span>仓位设置</span>
        <button className="fib-levels-close" onClick={onClose}>✕</button>
      </div>
      <div className="fib-levels-divider" />
      <div className="position-size-section">
        <label className="position-size-label">仓位金额 ($)</label>
        <input
          type="number"
          className="position-size-input"
          value={localSize}
          onChange={(e) => handleSizeChange(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          min="0"
          step="100"
        />
        <div className="position-size-presets">
          {presets.map((p) => (
            <button
              key={p}
              className={`position-size-preset ${Number(localSize) === p ? "active" : ""}`}
              onClick={() => handleSizeChange(String(p))}
            >
              {p >= 1000 ? `${p / 1000}K` : p}
            </button>
          ))}
        </div>
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
  drawingsHidden = false,
  onToggleDrawingsHidden,
  drawingSnapEnabled = true,
  onDrawingSnapEnabledChange,
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
  // Position settings
  positionSize = 1000,
  onPositionSizeChange,
  // Current stylable selection. The regular stroke controls update both this
  // existing drawing and the default style for subsequently created drawings.
  selectedDrawing = null,
  onSelectedDrawingStyleChange,
  exportPanelOpen = false,
  exportInProgress = false,
  onToggleExportPanel,
}) {
  // Which tool variants are selected (persisted across toggles)
  const [cursorVariant, setCursorVariant] = useState("cursor-default");
  const [freehandVariant, setFreehandVariant] = useState("pen");
  const [lineVariant, setLineVariant] = useState("line-segment");
  const [shapeVariant, setShapeVariant] = useState("shape-rectangle");
  const [posVariant, setPosVariant] = useState("position-long");
  const [chartType, setChartType] = useState("candlestick");

  // Flyout open state: null | "chart-type" | "cursor" | "freehand" | "line" | "shape" | "fib-levels" | "position" | "position-settings"
  const [flyoutOpen, setFlyoutOpen] = useState(null);

  const chartTypeBtnRef = useRef(null);
  const cursorBtnRef = useRef(null);
  const freehandBtnRef = useRef(null);
  const lineBtnRef = useRef(null);
  const shapeBtnRef = useRef(null);
  const fibBtnRef = useRef(null);
  const posBtnRef = useRef(null);

  // Double-click timer
  const cursorClickTimerRef = useRef(null);
  const freehandClickTimerRef = useRef(null);
  const clickTimerRef = useRef(null);
  const shapeClickTimerRef = useRef(null);
  const posClickTimerRef = useRef(null);

  const isCursorActive = CURSOR_TOOL_IDS.has(activeTool);
  const isFreehandActive = FREEHAND_TOOL_IDS.has(activeTool);
  const isEraserActive = activeTool === "eraser";
  const isLineActive = LINE_TOOL_IDS.has(activeTool);
  const isShapeActive = SHAPE_TOOL_IDS.has(activeTool);
  const isTextActive = activeTool === "text";
  const isFibonacciActive = activeTool === "fibonacci";
  const isPositionActive = POSITION_TOOL_IDS.has(activeTool);

  const currentChartType = CHART_TYPE_VARIANTS.find((v) => v.id === chartType) || CHART_TYPE_VARIANTS[0];

  const handleChartTypeClick = useCallback(() => {
    setFlyoutOpen((prev) => (prev === "chart-type" ? null : "chart-type"));
  }, []);

  const handleSelectChartType = useCallback((id) => {
    setChartType(id);
  }, []);

  /* ── Passive cursor button handlers ── */
  const handleCursorClick = useCallback(() => {
    if (cursorClickTimerRef.current) return;
    cursorClickTimerRef.current = setTimeout(() => {
      cursorClickTimerRef.current = null;
      onToolChange(isCursorActive ? activeTool : cursorVariant);
      setFlyoutOpen(null);
    }, 200);
  }, [activeTool, cursorVariant, isCursorActive, onToolChange]);

  const handleCursorDblClick = useCallback(() => {
    if (cursorClickTimerRef.current) {
      clearTimeout(cursorClickTimerRef.current);
      cursorClickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "cursor" ? null : "cursor"));
  }, []);

  const handleCursorContextMenu = useCallback((e) => {
    e.preventDefault();
    if (cursorClickTimerRef.current) {
      clearTimeout(cursorClickTimerRef.current);
      cursorClickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "cursor" ? null : "cursor"));
  }, []);

  const handleSelectCursorVariant = useCallback(
    (id) => {
      setCursorVariant(id);
      onToolChange(id);
    },
    [onToolChange],
  );

  /* ── Pen / highlighter button handlers ── */
  const handleFreehandClick = useCallback(() => {
    if (freehandClickTimerRef.current) return;
    freehandClickTimerRef.current = setTimeout(() => {
      freehandClickTimerRef.current = null;
      if (isFreehandActive) {
        onToolChange(null);
      } else {
        onToolChange(freehandVariant);
      }
      setFlyoutOpen(null);
    }, 200);
  }, [freehandVariant, isFreehandActive, onToolChange]);

  const handleFreehandDblClick = useCallback(() => {
    if (freehandClickTimerRef.current) {
      clearTimeout(freehandClickTimerRef.current);
      freehandClickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "freehand" ? null : "freehand"));
  }, []);

  const handleFreehandContextMenu = useCallback((e) => {
    e.preventDefault();
    if (freehandClickTimerRef.current) {
      clearTimeout(freehandClickTimerRef.current);
      freehandClickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "freehand" ? null : "freehand"));
  }, []);

  const handleSelectFreehandVariant = useCallback(
    (id) => {
      setFreehandVariant(id);
      onToolChange(id);
    },
    [onToolChange],
  );

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

  /* ── Determine which passive cursor icon to show ── */
  const currentCursorId = isCursorActive ? activeTool : cursorVariant;
  const currentCursorIcon =
    CURSOR_VARIANTS.find((v) => v.id === currentCursorId)?.icon || MouseDefaultIcon;
  const currentCursorLabel =
    CURSOR_VARIANTS.find((v) => v.id === currentCursorId)?.label || "默认鼠标";

  /* ── Determine which freehand icon to show ── */
  const currentFreehandId = isFreehandActive ? activeTool : freehandVariant;
  const currentFreehandIcon =
    FREEHAND_VARIANTS.find((v) => v.id === currentFreehandId)?.icon || PenIcon;
  const currentFreehandLabel =
    FREEHAND_VARIANTS.find((v) => v.id === currentFreehandId)?.label || "画笔";

  /* ── Determine which line icon to show ── */
  const currentLineIcon =
    LINE_VARIANTS.find((v) => v.id === lineVariant)?.icon || SegmentIcon;
  const currentLineLabel =
    LINE_VARIANTS.find((v) => v.id === lineVariant)?.label || "线段";

  /* ── Shape button handlers ── */
  const handleShapeClick = useCallback(() => {
    if (shapeClickTimerRef.current) return;
    shapeClickTimerRef.current = setTimeout(() => {
      shapeClickTimerRef.current = null;
      if (isShapeActive) {
        onToolChange(null);
      } else {
        onToolChange(shapeVariant);
      }
      setFlyoutOpen(null);
    }, 200);
  }, [isShapeActive, shapeVariant, onToolChange]);

  const handleShapeDblClick = useCallback(() => {
    if (shapeClickTimerRef.current) {
      clearTimeout(shapeClickTimerRef.current);
      shapeClickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "shape" ? null : "shape"));
  }, []);

  const handleShapeContextMenu = useCallback((e) => {
    e.preventDefault();
    if (shapeClickTimerRef.current) {
      clearTimeout(shapeClickTimerRef.current);
      shapeClickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "shape" ? null : "shape"));
  }, []);

  const handleSelectShapeVariant = useCallback(
    (id) => {
      setShapeVariant(id);
      onToolChange(id);
    },
    [onToolChange],
  );

  const currentShapeIcon =
    SHAPE_VARIANTS.find((v) => v.id === shapeVariant)?.icon || RectangleIcon;
  const currentShapeLabel =
    SHAPE_VARIANTS.find((v) => v.id === shapeVariant)?.label || "矩形";

  /* ── Position button handlers ── */
  const handlePositionClick = useCallback(() => {
    if (posClickTimerRef.current) return;
    posClickTimerRef.current = setTimeout(() => {
      posClickTimerRef.current = null;
      if (isPositionActive) {
        onToolChange(null);
      } else {
        onToolChange(posVariant);
      }
      setFlyoutOpen(null);
    }, 200);
  }, [isPositionActive, posVariant, onToolChange]);

  const handlePositionDblClick = useCallback(() => {
    if (posClickTimerRef.current) {
      clearTimeout(posClickTimerRef.current);
      posClickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "position" ? null : "position"));
  }, []);

  const handlePositionContextMenu = useCallback((e) => {
    e.preventDefault();
    if (posClickTimerRef.current) {
      clearTimeout(posClickTimerRef.current);
      posClickTimerRef.current = null;
    }
    setFlyoutOpen((prev) => (prev === "position" ? null : "position"));
  }, []);

  const handleSelectPositionVariant = useCallback(
    (id) => {
      setPosVariant(id);
      onToolChange(id);
    },
    [onToolChange],
  );

  /* ── Determine which position icon to show ── */
  const currentPosIcon =
    POSITION_VARIANTS.find((v) => v.id === posVariant)?.icon || LongPositionIcon;
  const currentPosLabel =
    POSITION_VARIANTS.find((v) => v.id === posVariant)?.label || "做多";

  const showPenOptions = isFreehandActive;
  const freehandOptionLabel = currentFreehandLabel;
  const showLineOptions = isLineActive;
  const showShapeOptions = isShapeActive;
  const showTextOptions = isTextActive;
  const showFibonacciOptions = isFibonacciActive;
  const showPositionOptions = isPositionActive;

  const handleStrokeColorChange = useCallback((color) => {
    onPenColorChange?.(color);
    if (selectedDrawing) {
      onSelectedDrawingStyleChange?.({ color });
    }
  }, [onPenColorChange, onSelectedDrawingStyleChange, selectedDrawing]);

  const handleStrokeSizeChange = useCallback((lineWidth) => {
    onPenSizeChange?.(lineWidth);
    if (selectedDrawing) {
      onSelectedDrawingStyleChange?.({ lineWidth });
    }
  }, [onPenSizeChange, onSelectedDrawingStyleChange, selectedDrawing]);

  const handleExportClick = useCallback(() => {
    setFlyoutOpen(null);
    onToggleExportPanel?.();
  }, [onToggleExportPanel]);

  return (
    <div className="drawing-toolbar">
      {/* ── Chart type selector (UI only; no series switching yet) ── */}
      <div className="drawing-tool-wrapper chart-type-tool-wrapper" ref={chartTypeBtnRef}>
        <button
          type="button"
          className={`drawing-tool-btn chart-type-tool-btn ${flyoutOpen === "chart-type" ? "active" : ""}`}
          onClick={handleChartTypeClick}
          title={`图表类型：${currentChartType.label}（仅 UI，暂不切换图表）`}
          aria-label={`图表类型：${currentChartType.label}`}
        >
          {currentChartType.icon}
          {CornerTriangle}
        </button>
        {flyoutOpen === "chart-type" && (
          <ToolFlyout
            variants={CHART_TYPE_VARIANTS}
            currentId={chartType}
            onSelect={handleSelectChartType}
            onClose={() => setFlyoutOpen(null)}
            anchorRef={chartTypeBtnRef}
            className="chart-type-flyout"
          />
        )}
      </div>

      <div className="drawing-toolbar-divider" />

      {/* ── Passive cursor / mouse mode button ── */}
      <div className="drawing-tool-wrapper" ref={cursorBtnRef}>
        <button
          className={`drawing-tool-btn ${isCursorActive ? "active" : ""}`}
          onClick={handleCursorClick}
          onDoubleClick={handleCursorDblClick}
          onContextMenu={handleCursorContextMenu}
          title={`${currentCursorLabel}（右键/双击切换鼠标样式）`}
        >
          {currentCursorIcon}
          {CornerTriangle}
        </button>
        {flyoutOpen === "cursor" && (
          <ToolFlyout
            variants={CURSOR_VARIANTS}
            currentId={currentCursorId}
            onSelect={handleSelectCursorVariant}
            onClose={() => setFlyoutOpen(null)}
            anchorRef={cursorBtnRef}
          />
        )}
      </div>

      {/* ── Pen / highlighter button ── */}
      <div className="drawing-tool-wrapper" ref={freehandBtnRef}>
        <button
          className={`drawing-tool-btn ${isFreehandActive ? "active" : ""}`}
          onClick={handleFreehandClick}
          onDoubleClick={handleFreehandDblClick}
          onContextMenu={handleFreehandContextMenu}
          title={`${currentFreehandLabel}（右键/双击切换画笔类型）`}
        >
          {currentFreehandIcon}
          {CornerTriangle}
        </button>
        {flyoutOpen === "freehand" && (
          <ToolFlyout
            variants={FREEHAND_VARIANTS}
            currentId={currentFreehandId}
            onSelect={handleSelectFreehandVariant}
            onClose={() => setFlyoutOpen(null)}
            anchorRef={freehandBtnRef}
          />
        )}
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

      {/* ── Shape button ── */}
      <div className="drawing-tool-wrapper" ref={shapeBtnRef}>
        <button
          className={`drawing-tool-btn ${isShapeActive ? "active" : ""}`}
          onClick={handleShapeClick}
          onDoubleClick={handleShapeDblClick}
          onContextMenu={handleShapeContextMenu}
          title={`${currentShapeLabel}（右键/双击切换形状，Shift 锁定正方形/正圆）`}
        >
          {currentShapeIcon}
          {CornerTriangle}
        </button>
        {flyoutOpen === "shape" && (
          <ToolFlyout
            variants={SHAPE_VARIANTS}
            currentId={shapeVariant}
            onSelect={handleSelectShapeVariant}
            onClose={() => setFlyoutOpen(null)}
            anchorRef={shapeBtnRef}
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

      {/* ── Position button ── */}
      <div className="drawing-tool-wrapper" ref={posBtnRef}>
        <button
          className={`drawing-tool-btn ${isPositionActive ? "active" : ""}`}
          onClick={handlePositionClick}
          onDoubleClick={handlePositionDblClick}
          onContextMenu={handlePositionContextMenu}
          title={`${currentPosLabel}（右键/双击切换多空）`}
        >
          {currentPosIcon}
          {CornerTriangle}
        </button>
        {flyoutOpen === "position" && (
          <ToolFlyout
            variants={POSITION_VARIANTS}
            currentId={posVariant}
            onSelect={handleSelectPositionVariant}
            onClose={() => setFlyoutOpen(null)}
            anchorRef={posBtnRef}
          />
        )}
        {flyoutOpen === "position-settings" && (
          <PositionSettingsPanel
            positionSize={positionSize}
            onPositionSizeChange={onPositionSizeChange}
            onClose={() => setFlyoutOpen(null)}
            anchorRef={posBtnRef}
          />
        )}
      </div>

      {/* ── Snap toggle ── */}
      <div className="drawing-tool-wrapper">
        <button
          className={`drawing-tool-btn ${drawingSnapEnabled ? "active" : ""}`}
          onClick={() => onDrawingSnapEnabledChange?.(!drawingSnapEnabled)}
          title={drawingSnapEnabled ? "吸附已开启（Alt 临时关闭）" : "吸附已关闭"}
        >
          {MagnetIcon}
        </button>
      </div>

      {/* Divider */}
      <div className="drawing-toolbar-divider" />

      {/* ── Options for pen / highlighter ── */}
      {showPenOptions && (
        <>
          <div className="drawing-tool-option" title={`${freehandOptionLabel}颜色`}>
            <input
              type="color"
              className="drawing-color-picker"
              value={penColor}
              onChange={(e) => handleStrokeColorChange(e.target.value)}
            />
          </div>
          <div className="drawing-tool-option" title={`${freehandOptionLabel}大小: ${penSize}px`}>
            <input
              type="range"
              className="drawing-size-slider"
              min="1"
              max="10"
              value={penSize}
              onChange={(e) => handleStrokeSizeChange(Number(e.target.value))}
            />
          </div>
        </>
      )}

      {/* ── Options for line / shape tools ── */}
      {(showLineOptions || showShapeOptions || showFibonacciOptions) && (
        <>
          <div className="drawing-tool-option" title="线条颜色">
            <input
              type="color"
              className="drawing-color-picker"
              value={penColor}
              onChange={(e) => handleStrokeColorChange(e.target.value)}
            />
          </div>
          <div className="drawing-tool-option" title={`线条粗细: ${penSize}px`}>
            <input
              type="range"
              className="drawing-size-slider"
              min="1"
              max="10"
              value={penSize}
              onChange={(e) => handleStrokeSizeChange(Number(e.target.value))}
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

      {/* ── Options for position tool ── */}
      {showPositionOptions && (
        <>
          <div className="drawing-tool-option" title="仓位金额">
            <button
              className="drawing-tool-btn drawing-format-btn position-settings-trigger"
              onClick={() => setFlyoutOpen((prev) => (prev === "position-settings" ? null : "position-settings"))}
              title="仓位设置"
              style={{ fontSize: 11, minWidth: 50 }}
            >
              ${positionSize >= 1000 ? `${(positionSize / 1000).toFixed(positionSize % 1000 === 0 ? 0 : 1)}K` : positionSize}
            </button>
          </div>
        </>
      )}

      {/* Clear all button at the bottom */}
      <div style={{ flex: 1 }} />
      <button
        className={`drawing-tool-btn drawing-export-btn ${exportPanelOpen ? "active" : ""}`}
        onClick={handleExportClick}
        disabled={exportInProgress}
        title={exportInProgress ? "正在导出图片..." : "截图 / 导出图片"}
      >
        {ExportIcon}
      </button>
      <button
        className={`drawing-tool-btn drawing-hide-btn ${drawingsHidden ? "active" : ""}`}
        onClick={onToggleDrawingsHidden}
        title={drawingsHidden ? "显示所有绘图" : "隐藏所有绘图"}
      >
        {drawingsHidden ? (
          // Eye-off icon
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.77 19.77 0 0 1 5.06-5.94" />
            <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.86 19.86 0 0 1-3.17 4.19" />
            <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        ) : (
          // Eye icon
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
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
