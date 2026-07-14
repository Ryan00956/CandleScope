/**
 * FibonacciDrawingPrimitive — Lightweight Charts v5 Plugin API (ISeriesPrimitive)
 *
 * Renders a Fibonacci Retracement tool with user-customizable levels.
 * Two points (A and B) define the trend.
 * Supports:
 *   - Custom level values (including extensions beyond 1)
 *   - Per-level enable/disable and color customization
 *   - Inverted mode (first click = level 1 instead of level 0)
 */

import { dataPointToCoordinate } from "./coordinateUtils.js";
import type {
  DrawingAttachedParameter,
  DrawingDataPoint,
  DrawingHit,
  FibonacciLevel,
  FibonacciPrimitiveOptions,
  PrimitiveCanvasTarget,
  PrimitivePaneRenderer,
  PrimitivePaneView,
} from "../drawingTypes.js";

interface FibRenderPoint {
  x: number | null;
  y: number | null;
}

interface FibRenderData {
  points: FibRenderPoint[];
  logicalAPrice: number;
  logicalBPrice: number;
  color: string;
  lineWidth: number;
  selected: boolean;
  isPreview: boolean;
  hovered: boolean;
  levels: FibonacciLevel[];
  inverted: boolean;
  hidden: boolean;
}

export const DEFAULT_FIB_LEVELS: FibonacciLevel[] = [
  { level: 0, color: "#787b86", enabled: true },
  { level: 0.236, color: "#f44336", enabled: true },
  { level: 0.382, color: "#81c784", enabled: true },
  { level: 0.5, color: "#4caf50", enabled: true },
  { level: 0.618, color: "#009688", enabled: true },
  { level: 0.786, color: "#64b5f6", enabled: true },
  { level: 1, color: "#787b86", enabled: true },
  { level: 1.272, color: "#e040fb", enabled: false },
  { level: 1.618, color: "#ff9800", enabled: false },
  { level: 2.618, color: "#ff5722", enabled: false },
  { level: 3.618, color: "#795548", enabled: false },
  { level: 4.236, color: "#607d8b", enabled: false },
];

class FibRenderer implements PrimitivePaneRenderer {
  _data: FibRenderData | null;

  constructor() {
    this._data = null;
  }

  update(data: FibRenderData): void {
    this._data = data;
  }

  draw(target: PrimitiveCanvasTarget): void {
    const data = this._data;
    if (!data || !data.points || data.points.length < 2) return;
    if (data.hidden) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const ratio = scope.horizontalPixelRatio;
      const vRatio = scope.verticalPixelRatio;
      const { points, color, lineWidth, selected, isPreview, hovered, levels, inverted } = data;

      const [a, b] = points;
      if (!a || !b || a.x == null || a.y == null || b.x == null || b.y == null) return;

      const ax = a.x * ratio;
      const ay = a.y * vRatio;
      const bx = b.x * ratio;
      const by = b.y * vRatio;

      const minX = Math.min(ax, bx);
      const maxX = Math.max(ax, bx);

      // When inverted, A=level1, B=level0; otherwise A=level0, B=level1
      const startY = inverted ? by : ay;
      const endY = inverted ? ay : by;
      const priceDiff = endY - startY;

      const startPrice = inverted ? data.logicalBPrice : data.logicalAPrice;
      const endPrice = inverted ? data.logicalAPrice : data.logicalBPrice;
      const logicalPriceDiff = endPrice - startPrice;

      // Use only enabled levels
      const activeLevels = (levels || DEFAULT_FIB_LEVELS).filter((l) => l.enabled);

      ctx.save();

      // Draw trend line from A to B
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const scaledWidth = lineWidth * Math.min(ratio, vRatio);
      ctx.lineWidth = scaledWidth;
      ctx.strokeStyle = hovered && !selected ? adjustAlpha(color, 0.8) : color;

      if (isPreview) {
        ctx.setLineDash([6 * ratio, 4 * ratio]);
        ctx.globalAlpha = 0.7;
      } else {
        ctx.setLineDash([4 * ratio, 4 * ratio]);
      }

      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();

      ctx.setLineDash([]);

      // Sort levels by Y for drawing backgrounds
      const levelData = activeLevels.map((lvl) => {
        const y = startY + priceDiff * lvl.level;
        const logicalPrice = startPrice + logicalPriceDiff * lvl.level;
        return { ...lvl, y, logicalPrice };
      }).sort((a, b) => a.y - b.y);

      // Draw backgrounds between adjacent levels
      ctx.globalAlpha = 0.1;
      for (let i = 0; i < levelData.length - 1; i++) {
        const l1 = levelData[i];
        const l2 = levelData[i + 1];
        if (!l1 || !l2) continue;
        ctx.fillStyle = l2.color;
        ctx.fillRect(minX, l1.y, maxX - minX, l2.y - l1.y);
      }

      ctx.globalAlpha = 1;

      // Draw horizontal lines & text labels
      ctx.font = `${11 * ratio}px sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";

      for (const l of levelData) {
        ctx.strokeStyle = l.color;
        ctx.fillStyle = l.color;
        ctx.lineWidth = scaledWidth;
        ctx.beginPath();
        ctx.moveTo(minX, l.y);
        ctx.lineTo(maxX, l.y);
        ctx.stroke();

        const text = `${l.level} (${l.logicalPrice.toFixed(2)})`;
        ctx.fillText(text, minX + 4 * ratio, l.y - 2 * vRatio);
      }

      ctx.globalAlpha = 1;

      // Draw anchor dots
      if (!selected && !isPreview) {
        const dotR = Math.max(scaledWidth, 3 * Math.min(ratio, vRatio));
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(ax, ay, dotR, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(bx, by, dotR, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      if (isPreview) {
        const dotR = Math.max(scaledWidth, 3 * Math.min(ratio, vRatio));
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(ax, ay, dotR, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Draw selection handles
      if (selected) {
        const handleR = 6 * Math.min(ratio, vRatio);
        const handleLineW = 2 * Math.min(ratio, vRatio);

        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = color;
        ctx.lineWidth = handleLineW;
        ctx.shadowColor = "rgba(0,0,0,0.3)";
        ctx.shadowBlur = 4 * Math.min(ratio, vRatio);

        ctx.beginPath();
        ctx.arc(ax, ay, handleR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(bx, by, handleR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.shadowBlur = 0;

        ctx.strokeStyle = adjustAlpha(color, 0.15);
        ctx.lineWidth = Math.max(scaledWidth + 12 * Math.min(ratio, vRatio), 16 * Math.min(ratio, vRatio));
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }

      ctx.restore();
    });
  }
}

function adjustAlpha(hex: string, alpha: number): string {
  let r = 0, g = 0, b = 0;
  if (hex.length === 4) {
    r = parseInt(hex.charAt(1).repeat(2), 16);
    g = parseInt(hex.charAt(2).repeat(2), 16);
    b = parseInt(hex.charAt(3).repeat(2), 16);
  } else if (hex.length === 7) {
    r = parseInt(hex.slice(1, 3), 16);
    g = parseInt(hex.slice(3, 5), 16);
    b = parseInt(hex.slice(5, 7), 16);
  } else {
    return hex;
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}

class FibPaneView implements PrimitivePaneView {
  _source: FibonacciDrawingPrimitive;
  _renderer: FibRenderer;

  constructor(source: FibonacciDrawingPrimitive) {
    this._source = source;
    this._renderer = new FibRenderer();
  }

  update(): void {
    const source = this._source;
    const series = source._series;
    const chart = source._chart;

    if (!series || !chart) return;
    if (source._hidden) {
      this._renderer.update({
        points: [],
        logicalAPrice: 0,
        logicalBPrice: 0,
        color: source._color,
        lineWidth: source._lineWidth,
        selected: source._selected,
        isPreview: source._isPreview,
        hovered: source._hovered,
        levels: source._levels,
        inverted: source._inverted,
        hidden: true,
      });
      return;
    }

    const points: FibRenderPoint[] = [];
    const coordinateContext = {};

    for (const dp of source._dataPoints) {
      const x = dataPointToCoordinate(chart, series, dp, coordinateContext);
      const y = series.priceToCoordinate(dp.price);
      points.push({ x, y });
    }

    this._renderer.update({
      points,
      logicalAPrice: source._dataPoints[0]?.price ?? 0,
      logicalBPrice: source._dataPoints[1]?.price ?? 0,
      color: source._color,
      lineWidth: source._lineWidth,
      selected: source._selected,
      isPreview: source._isPreview,
      hovered: source._hovered,
      levels: source._levels,
      inverted: source._inverted,
      hidden: source._hidden,
    });
  }

  renderer(): FibRenderer {
    return this._renderer;
  }

  zOrder(): "top" {
    return "top";
  }
}

export class FibonacciDrawingPrimitive {
  _id: string;
  _type: "fibonacci";
  _dataPoints: DrawingDataPoint[];
  _color: string;
  _lineWidth: number;
  _selected: boolean;
  _isPreview: boolean;
  _hovered: boolean;
  _levels: FibonacciLevel[];
  _inverted: boolean;
  _hidden: boolean;
  _series: DrawingAttachedParameter["series"] | null;
  _chart: DrawingAttachedParameter["chart"] | null;
  _paneView: FibPaneView;
  _requestUpdate: (() => void) | null;

  constructor(opts: FibonacciPrimitiveOptions) {
    this._id = opts.id;
    this._dataPoints = opts.dataPoints || [];
    this._color = opts.color || "#0ea5e9";
    this._lineWidth = opts.lineWidth || 2;
    this._selected = opts.selected || false;
    this._isPreview = opts.isPreview || false;
    this._hovered = opts.hovered || false;
    this._type = "fibonacci";
    this._levels = opts.levels || DEFAULT_FIB_LEVELS.map((l) => ({ ...l }));
    this._inverted = opts.inverted || false;
    this._hidden = !!opts.hidden;

    this._series = null;
    this._chart = null;
    this._paneView = new FibPaneView(this);
    this._requestUpdate = null;
  }

  attached({ chart, series, requestUpdate }: DrawingAttachedParameter): void {
    this._chart = chart;
    this._series = series;
    this._requestUpdate = requestUpdate;
  }

  detached(): void {
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  updateAllViews(): void {
    this._paneView.update();
  }

  paneViews(): readonly PrimitivePaneView[] {
    return [this._paneView];
  }

  get id() { return this._id; }
  get dataPoints() { return this._dataPoints; }
  get color() { return this._color; }
  get lineWidth() { return this._lineWidth; }
  get selected() { return this._selected; }
  get levels() { return this._levels; }
  get inverted() { return this._inverted; }

  setDataPoints(points: DrawingDataPoint[]): void {
    this._dataPoints = points;
    this._requestUpdate?.();
  }

  setSelected(v: boolean): void {
    const next = !!v;
    if (this._selected !== next) {
      this._selected = next;
      this._requestUpdate?.();
    }
  }

  setHovered(v: boolean): void {
    const next = !!v;
    if (this._hovered !== next) {
      this._hovered = next;
      this._requestUpdate?.();
    }
  }

  setColor(c: string): void {
    this._color = c;
    this._requestUpdate?.();
  }

  setLineWidth(w: number): void {
    this._lineWidth = w;
    this._requestUpdate?.();
  }

  setPreview(v: boolean): void {
    this._isPreview = v;
    this._requestUpdate?.();
  }

  setLevels(levels: FibonacciLevel[]): void {
    this._levels = levels;
    this._requestUpdate?.();
  }

  setInverted(v: boolean): void {
    this._inverted = v;
    this._requestUpdate?.();
  }

  setHidden(v: boolean, request = true): void {
    const next = !!v;
    if (this._hidden !== next) {
      this._hidden = next;
      if (request) this._requestUpdate?.();
    }
  }

  requestUpdate(): void {
    this._requestUpdate?.();
  }

  hitTest(x: number, y: number): DrawingHit | null {
    if (this._hidden) return null;
    if (!this._series || !this._chart) return null;
    if (this._dataPoints.length < 2) return null;

    const series = this._series;
    const chart = this._chart;
    const coordinateContext = {};
    const screenPoints = this._dataPoints.map((dp) => {
      const sx = dataPointToCoordinate(chart, series, dp, coordinateContext);
      return { x: sx, y: series.priceToCoordinate(dp.price) };
    });

    const [sa, sb] = screenPoints;
    if (!sa || !sb || sa.x == null || sa.y == null || sb.x == null || sb.y == null) return null;

    const HANDLE_RADIUS = 7 + this._lineWidth;
    const LINE_HIT_RADIUS = 8 + this._lineWidth / 2;

    const resolvedScreenPoints = [
      { x: sa.x, y: sa.y },
      { x: sb.x, y: sb.y },
    ];
    for (const [i, pt] of resolvedScreenPoints.entries()) {
      const dx = pt.x - x;
      const dy = pt.y - y;
      if (Math.sqrt(dx * dx + dy * dy) <= HANDLE_RADIUS) {
        return { pointIndex: i };
      }
    }

    if (distToSegment(x, y, sa.x, sa.y, sb.x, sb.y) <= LINE_HIT_RADIUS) {
      return { pointIndex: -1 };
    }

    // Hit test on fib level lines
    const minX = Math.min(sa.x, sb.x);
    const maxX = Math.max(sa.x, sb.x);
    if (x >= minX - LINE_HIT_RADIUS && x <= maxX + LINE_HIT_RADIUS) {
      const startY = this._inverted ? sb.y : sa.y;
      const endY = this._inverted ? sa.y : sb.y;
      const priceDiff = endY - startY;
      const activeLevels = this._levels.filter((l) => l.enabled);
      for (const lvl of activeLevels) {
        const ly = startY + priceDiff * lvl.level;
        if (Math.abs(y - ly) <= LINE_HIT_RADIUS) {
          return { pointIndex: -1 };
        }
      }
    }

    return null;
  }
}

export default FibonacciDrawingPrimitive;
