/**
 * AxisLineDrawingPrimitive — horizontal / vertical / cross line drawing.
 *
 * Stores a single anchor in data coordinates. Horizontal lines consume price,
 * vertical lines consume time, and cross lines consume both. Rendering stays in
 * Lightweight Charts' native primitive pipeline so zoom/pan/interval switches
 * remain stable.
 */

import { dataPointToCoordinate } from "./coordinateUtils.js";
import type {
  AxisLinePrimitiveOptions,
  AxisLineType,
  DrawingAttachedParameter,
  DrawingDataPoint,
  DrawingHit,
  PrimitiveCanvasTarget,
  PrimitivePaneRenderer,
  PrimitivePaneView,
} from "../drawingTypes.js";

interface AxisLineRenderData {
  point: { x: number | null; y: number | null } | null;
  axisLineType: AxisLineType;
  color: string;
  lineWidth: number;
  selected: boolean;
  hovered: boolean;
  isPreview: boolean;
  hidden: boolean;
}

function normalizeAxisLineType(value: unknown): AxisLineType {
  if (value === "vertical" || value === "cross") return value;
  return "horizontal";
}

function isFiniteCoord(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function adjustAlpha(color: string, alpha: number): string {
  if (!color || color === "transparent") return "transparent";
  const a = Math.max(0, Math.min(1, Number(alpha)));

  if (color.startsWith("rgba")) {
    const match = color.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
    if (match) {
      const baseAlpha = Math.max(0, Math.min(1, Number(match[4])));
      return `rgba(${match[1]},${match[2]},${match[3]},${baseAlpha * a})`;
    }
  }

  if (color.startsWith("rgb")) {
    const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (match) return `rgba(${match[1]},${match[2]},${match[3]},${a})`;
  }

  let r = 0, g = 0, b = 0;
  if (color.length === 4) {
    r = parseInt(color.charAt(1).repeat(2), 16);
    g = parseInt(color.charAt(2).repeat(2), 16);
    b = parseInt(color.charAt(3).repeat(2), 16);
  } else if (color.length === 7) {
    r = parseInt(color.slice(1, 3), 16);
    g = parseInt(color.slice(3, 5), 16);
    b = parseInt(color.slice(5, 7), 16);
  } else {
    return color;
  }
  return `rgba(${r},${g},${b},${a})`;
}

class AxisLineRenderer implements PrimitivePaneRenderer {
  _data: AxisLineRenderData | null;

  constructor() {
    this._data = null;
  }

  update(data: AxisLineRenderData): void {
    this._data = data;
  }

  draw(target: PrimitiveCanvasTarget): void {
    const data = this._data;
    if (!data || data.hidden || !data.point) return;
    const point = data.point;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hRatio = scope.horizontalPixelRatio;
      const vRatio = scope.verticalPixelRatio;
      const minRatio = Math.min(hRatio, vRatio);
      const { axisLineType, color, lineWidth, selected, hovered, isPreview } = data;

      const x = isFiniteCoord(point.x) ? point.x * hRatio : null;
      const y = isFiniteCoord(point.y) ? point.y * vRatio : null;
      const hasX = x !== null;
      const hasY = y !== null;
      const drawHorizontal = (axisLineType === "horizontal" || axisLineType === "cross") && hasY;
      const drawVertical = (axisLineType === "vertical" || axisLineType === "cross") && hasX;
      if (!drawHorizontal && !drawVertical) return;

      const cw = scope.bitmapSize.width;
      const ch = scope.bitmapSize.height;
      const scaledWidth = lineWidth * minRatio;

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      if (selected || (hovered && !isPreview)) {
        ctx.strokeStyle = adjustAlpha(color, selected ? 0.18 : 0.14);
        ctx.lineWidth = Math.max(scaledWidth + 10 * minRatio, 12 * minRatio);
        ctx.beginPath();
        if (drawHorizontal && y !== null) {
          ctx.moveTo(0, y);
          ctx.lineTo(cw, y);
        }
        if (drawVertical && x !== null) {
          ctx.moveTo(x, 0);
          ctx.lineTo(x, ch);
        }
        ctx.stroke();
      }

      ctx.strokeStyle = hovered && !selected ? adjustAlpha(color, 0.85) : color;
      ctx.lineWidth = scaledWidth;
      if (isPreview) {
        ctx.setLineDash([6 * hRatio, 4 * hRatio]);
        ctx.globalAlpha = 0.75;
      }

      ctx.beginPath();
      if (drawHorizontal && y !== null) {
        ctx.moveTo(0, y);
        ctx.lineTo(cw, y);
      }
      if (drawVertical && x !== null) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, ch);
      }
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // Draw a single anchor handle when the source anchor is visible.
      if ((selected || isPreview) && x !== null && y !== null) {
        const handleR = (selected ? 6 : 4) * minRatio;
        const handleLineW = (selected ? 2 : 1.5) * minRatio;
        ctx.fillStyle = selected ? "#ffffff" : adjustAlpha(color, 0.45);
        ctx.strokeStyle = color;
        ctx.lineWidth = handleLineW;
        ctx.shadowColor = "rgba(0,0,0,0.3)";
        ctx.shadowBlur = selected ? 4 * minRatio : 0;
        ctx.beginPath();
        ctx.arc(x, y, handleR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      ctx.restore();
    });
  }
}

class AxisLinePaneView implements PrimitivePaneView {
  _source: AxisLineDrawingPrimitive;
  _renderer: AxisLineRenderer;

  constructor(source: AxisLineDrawingPrimitive) {
    this._source = source;
    this._renderer = new AxisLineRenderer();
  }

  update(): void {
    const source = this._source;
    const series = source._series;
    const chart = source._chart;
    if (!series || !chart) return;
    if (source._hidden) {
      this._renderer.update({
        point: null,
        axisLineType: source._axisLineType,
        color: source._color,
        lineWidth: source._lineWidth,
        selected: source._selected,
        hovered: source._hovered,
        isPreview: source._isPreview,
        hidden: true,
      });
      return;
    }

    const dp = source._dataPoint;
    const coordinateContext = {};
    const x = dp ? dataPointToCoordinate(chart, series, dp, coordinateContext) : null;
    let y: number | null = null;

    if (dp?.price != null) {
      y = series.priceToCoordinate(dp.price);
    }

    this._renderer.update({
      point: { x, y },
      axisLineType: source._axisLineType,
      color: source._color,
      lineWidth: source._lineWidth,
      selected: source._selected,
      hovered: source._hovered,
      isPreview: source._isPreview,
      hidden: source._hidden,
    });
  }

  renderer(): AxisLineRenderer {
    return this._renderer;
  }

  zOrder(): "top" {
    return "top";
  }
}

export class AxisLineDrawingPrimitive {
  _id: string;
  _type: "axis-line";
  _axisLineType: AxisLineType;
  _dataPoint: DrawingDataPoint | null;
  _color: string;
  _lineWidth: number;
  _selected: boolean;
  _hovered: boolean;
  _isPreview: boolean;
  _hidden: boolean;
  _series: DrawingAttachedParameter["series"] | null;
  _chart: DrawingAttachedParameter["chart"] | null;
  _paneView: AxisLinePaneView;
  _requestUpdate: (() => void) | null;

  constructor(opts: AxisLinePrimitiveOptions) {
    this._id = opts.id;
    this._type = "axis-line";
    this._axisLineType = normalizeAxisLineType(opts.axisLineType);
    this._dataPoint = opts.dataPoint || null;
    this._color = opts.color || "#f59e0b";
    this._lineWidth = opts.lineWidth || 2;
    this._selected = !!opts.selected;
    this._hovered = !!opts.hovered;
    this._isPreview = !!opts.isPreview;
    this._hidden = !!opts.hidden;

    this._series = null;
    this._chart = null;
    this._paneView = new AxisLinePaneView(this);
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
  get type() { return this._type; }
  get axisLineType() { return this._axisLineType; }
  get dataPoint() { return this._dataPoint; }
  get color() { return this._color; }
  get lineWidth() { return this._lineWidth; }
  get selected() { return this._selected; }

  setDataPoint(point: DrawingDataPoint | null): void {
    this._dataPoint = point;
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

  setColor(color: string): void {
    this._color = color;
    this._requestUpdate?.();
  }

  setLineWidth(width: number): void {
    this._lineWidth = width;
    this._requestUpdate?.();
  }

  setPreview(v: boolean): void {
    this._isPreview = !!v;
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

  _screenPoint(): { x: number | null; y: number | null } | null {
    if (!this._series || !this._chart || !this._dataPoint) return null;
    const dp = this._dataPoint;
    const coordinateContext = {};
    const x = dataPointToCoordinate(this._chart, this._series, dp, coordinateContext);
    let y = null;

    if (dp.price != null) {
      y = this._series.priceToCoordinate(dp.price);
    }

    return { x, y };
  }

  hitTest(x: number, y: number): DrawingHit | null {
    if (this._hidden) return null;
    const point = this._screenPoint();
    if (!point) return null;

    const hasX = isFiniteCoord(point.x);
    const hasY = isFiniteCoord(point.y);
    const HANDLE_RADIUS = 7 + this._lineWidth;
    const LINE_HIT_RADIUS = 8 + this._lineWidth / 2;

    if (this._selected && hasX && hasY) {
      const dx = (point.x ?? x) - x;
      const dy = (point.y ?? y) - y;
      if (Math.hypot(dx, dy) <= HANDLE_RADIUS) {
        return { pointIndex: 0, zone: "center" };
      }
    }

    const horizontalDist = hasY && (this._axisLineType === "horizontal" || this._axisLineType === "cross")
      ? Math.abs((point.y ?? y) - y)
      : Infinity;
    const verticalDist = hasX && (this._axisLineType === "vertical" || this._axisLineType === "cross")
      ? Math.abs((point.x ?? x) - x)
      : Infinity;

    if (horizontalDist <= LINE_HIT_RADIUS || verticalDist <= LINE_HIT_RADIUS) {
      return {
        pointIndex: -1,
        zone: horizontalDist <= verticalDist ? "horizontal" : "vertical",
      };
    }

    return null;
  }
}

export default AxisLineDrawingPrimitive;
