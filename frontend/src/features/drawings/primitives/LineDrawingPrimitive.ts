/**
 * LineDrawingPrimitive — Lightweight Charts v5 Plugin API (ISeriesPrimitive)
 *
 * Renders a line (segment / ray / infinite) directly inside the chart's native
 * Canvas rendering pipeline via series.attachPrimitive(). The line data is
 * stored in time (Unix timestamp) + price coordinates, so it survives
 * timeframe switches and automatically follows pan/zoom with zero lag.
 *
 * Supports:
 *   - line-segment: a finite segment between two anchor points
 *   - line-ray: extends from point A through point B to infinity
 *   - line-infinite: extends infinitely in both directions through A and B
 *   - selection handles (circles at endpoints) when selected
 *   - hit-testing for selection, endpoint dragging, and whole-line dragging
 */

import { drawingDataPointsToCoordinates } from "./coordinateUtils.js";
import type {
  BasicLineToolId,
  DrawingAttachedParameter,
  DrawingDataPoint,
  DrawingHit,
  LinePrimitiveOptions,
  PrimitiveCanvasTarget,
  PrimitivePaneRenderer,
  PrimitivePaneView,
} from "../drawingTypes.js";
import {
  accumulateDrawingPerfFrameWork,
  drawingPerfCounters,
} from "../performance/drawingPerfCounters.js";

interface ExtendedLineCoordinates {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface LineRenderPoint {
  x: number | null;
  y: number | null;
}

interface LineRenderData {
  points: LineRenderPoint[];
  color: string;
  lineWidth: number;
  lineType: BasicLineToolId;
  selected: boolean;
  isPreview: boolean;
  hovered: boolean;
  hidden: boolean;
}

function drawingPerfNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

// ── Geometry helpers ──

function extendLineCoords(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  type: BasicLineToolId,
  canvasWidth: number,
  canvasHeight: number,
): ExtendedLineCoordinates {
  const dx = bx - ax;
  const dy = by - ay;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / d;
  const uy = dy / d;

  // Use a large extension length based on canvas diagonal
  const len = Math.sqrt(canvasWidth * canvasWidth + canvasHeight * canvasHeight) * 2;

  if (type === "line-segment") {
    return { x1: ax, y1: ay, x2: bx, y2: by };
  }
  if (type === "line-ray") {
    return { x1: ax, y1: ay, x2: ax + ux * len, y2: ay + uy * len };
  }
  // line-infinite
  return {
    x1: ax - ux * len,
    y1: ay - uy * len,
    x2: ax + ux * len,
    y2: ay + uy * len,
  };
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

// Distance from point (px,py) to the infinite line through A and B.
function distToInfiniteLine(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
  return Math.abs(dx * (py - ay) - dy * (px - ax)) / Math.sqrt(lenSq);
}

// Distance from point (px,py) to the ray starting at A and passing through B (extending past B to infinity).
function distToRay(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
  const t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t <= 0) {
    // Projection falls behind A → distance to endpoint A.
    return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
  }
  // Projection is on the ray (t > 0) → perpendicular distance to the line.
  return Math.abs(dx * (py - ay) - dy * (px - ax)) / Math.sqrt(lenSq);
}

// ── Pane Renderer ──

class LineRenderer implements PrimitivePaneRenderer {
  _data: LineRenderData | null;

  constructor() {
    this._data = null;
  }

  update(data: LineRenderData): void {
    this._data = data;
  }

  draw(target: PrimitiveCanvasTarget): void {
    const data = this._data;
    if (!data || !data.points || data.points.length < 2) return;
    if (data.hidden) return;
    const startedAt = drawingPerfNow();

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const ratio = scope.horizontalPixelRatio;
      const vRatio = scope.verticalPixelRatio;
      const { points, color, lineWidth, lineType, selected, isPreview, hovered } = data;

      const [a, b] = points;
      if (!a || !b || a.x == null || a.y == null || b.x == null || b.y == null) return;

      // Scale to bitmap coords
      const ax = a.x * ratio;
      const ay = a.y * vRatio;
      const bx = b.x * ratio;
      const by = b.y * vRatio;

      const cw = scope.bitmapSize.width;
      const ch = scope.bitmapSize.height;

      const ext = extendLineCoords(ax, ay, bx, by, lineType, cw, ch);

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // Draw main line
      const scaledWidth = lineWidth * Math.min(ratio, vRatio);
      ctx.lineWidth = scaledWidth;
      ctx.strokeStyle = hovered && !selected ? adjustAlpha(color, 0.8) : color;

      if (isPreview) {
        ctx.setLineDash([6 * ratio, 4 * ratio]);
        ctx.globalAlpha = 0.7;
      }

      ctx.beginPath();
      ctx.moveTo(ext.x1, ext.y1);
      ctx.lineTo(ext.x2, ext.y2);
      ctx.stroke();

      if (isPreview) {
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      // Draw endpoint dots for segments (non-selected)
      if (!selected && lineType === "line-segment" && !isPreview) {
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

      // Draw preview anchor dot
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

        // Handle A
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = color;
        ctx.lineWidth = handleLineW;
        ctx.shadowColor = "rgba(0,0,0,0.3)";
        ctx.shadowBlur = 4 * Math.min(ratio, vRatio);
        ctx.beginPath();
        ctx.arc(ax, ay, handleR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Handle B
        ctx.beginPath();
        ctx.arc(bx, by, handleR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Draw invisible wider hit area indicator via a subtle highlight
        ctx.strokeStyle = adjustAlpha(color, 0.15);
        ctx.lineWidth = Math.max(scaledWidth + 12 * Math.min(ratio, vRatio), 16 * Math.min(ratio, vRatio));
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }

      ctx.restore();
    });
    const durationMs = drawingPerfNow() - startedAt;
    accumulateDrawingPerfFrameWork({
      drawingMainThreadMs: durationMs,
      sceneProjectPaintMs: durationMs,
    });
  }
}

function adjustAlpha(hex: string, alpha: number): string {
  // Convert hex to rgba
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

// ── Pane View ──

class LinePaneView implements PrimitivePaneView {
  _source: LineDrawingPrimitive;
  _renderer: LineRenderer;

  constructor(source: LineDrawingPrimitive) {
    this._source = source;
    this._renderer = new LineRenderer();
  }

  update(): void {
    // Called by the chart before rendering. Convert data coords → screen coords.
    const startedAt = drawingPerfNow();
    const source = this._source;
    const series = source._series;
    const chart = source._chart;

    if (!series || !chart) return;
    if (source._hidden) {
      this._renderer.update({
        points: [],
        color: source._color,
        lineWidth: source._lineWidth,
        lineType: source._lineType,
        selected: source._selected,
        isPreview: source._isPreview,
        hovered: source._hovered,
        hidden: true,
      });
      const durationMs = drawingPerfNow() - startedAt;
      drawingPerfCounters.recordSceneRebuild();
      accumulateDrawingPerfFrameWork({
        geometryKey: source._id,
        drawingMainThreadMs: durationMs,
        sceneProjectPaintMs: durationMs,
        rawPoints: source._dataPoints.length,
        renderedPoints: 0,
        visibleEntities: 0,
        culledEntities: 1,
      });
      return;
    }

    const points: LineRenderPoint[] = [];
    const coordinateContext = {};
    let projectedPointCount = 0;
    const horizontalCoordinates = drawingDataPointsToCoordinates(
      chart,
      series,
      source._dataPoints,
      coordinateContext,
      { cacheToken: source, geometryRevision: source._geometryRevision },
    );

    for (const [index, dp] of source._dataPoints.entries()) {
      const x = horizontalCoordinates[index] ?? null;
      const y = series.priceToCoordinate(dp.price);
      points.push({ x, y });
      if (typeof x === "number" && Number.isFinite(x)
        && typeof y === "number" && Number.isFinite(y)) {
        projectedPointCount += 1;
      }
    }
    if (projectedPointCount > 0) {
      drawingPerfCounters.recordFinalProjection(projectedPointCount);
    }

    this._renderer.update({
      points,
      color: source._color,
      lineWidth: source._lineWidth,
      lineType: source._lineType,
      selected: source._selected,
      isPreview: source._isPreview,
      hovered: source._hovered,
      hidden: source._hidden,
    });
    const durationMs = drawingPerfNow() - startedAt;
    const renderable = projectedPointCount >= 2;
    drawingPerfCounters.recordSceneRebuild();
    accumulateDrawingPerfFrameWork({
      geometryKey: source._id,
      drawingMainThreadMs: durationMs,
      sceneProjectPaintMs: durationMs,
      rawPoints: source._dataPoints.length,
      renderedPoints: renderable ? 2 : 0,
      visibleEntities: renderable ? 1 : 0,
      culledEntities: renderable ? 0 : 1,
    });
  }

  renderer(): LineRenderer {
    return this._renderer;
  }

  zOrder(): "top" {
    return "top";
  }
}

// ── The Primitive (ISeriesPrimitive implementation) ──

export class LineDrawingPrimitive {
  _id: string;
  _lineType: BasicLineToolId;
  _dataPoints: DrawingDataPoint[];
  _color: string;
  _lineWidth: number;
  _selected: boolean;
  _isPreview: boolean;
  _hovered: boolean;
  _hidden: boolean;
  _geometryRevision: number;
  _series: DrawingAttachedParameter["series"] | null;
  _chart: DrawingAttachedParameter["chart"] | null;
  _paneView: LinePaneView;
  _requestUpdate: (() => void) | null;

  /**
   * @param {object} opts
   * @param {string} opts.id - unique identifier
   * @param {string} opts.lineType - "line-segment" | "line-ray" | "line-infinite"
   * @param {{logical: number, price: number}[]} opts.dataPoints - two anchor points in data coords
   * @param {string} opts.color - line color (hex)
   * @param {number} opts.lineWidth - line width in CSS pixels
   * @param {boolean} [opts.selected] - whether this line is currently selected
   * @param {boolean} [opts.isPreview] - whether this is a preview line (dashed)
   * @param {boolean} [opts.hovered] - whether this line is hovered
   */
  constructor(opts: LinePrimitiveOptions) {
    this._id = opts.id;
    this._lineType = opts.lineType ?? "line-segment";
    this._dataPoints = opts.dataPoints || [];
    this._color = opts.color || "#f59e0b";
    this._lineWidth = opts.lineWidth || 2;
    this._selected = opts.selected || false;
    this._isPreview = opts.isPreview || false;
    this._hovered = opts.hovered || false;
    this._hidden = !!opts.hidden;
    this._geometryRevision = 1;

    this._series = null;
    this._chart = null;
    this._paneView = new LinePaneView(this);

    // Callbacks
    this._requestUpdate = null;
  }

  // ── ISeriesPrimitive interface ──

  attached({ chart, series, requestUpdate }: DrawingAttachedParameter): void {
    this._chart = chart;
    this._series = series;
    this._requestUpdate = () => {
      drawingPerfCounters.recordRequestUpdate();
      requestUpdate();
    };
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

  // ── Public API ──

  get id() { return this._id; }
  get lineType() { return this._lineType; }
  get dataPoints() { return this._dataPoints; }
  get color() { return this._color; }
  get lineWidth() { return this._lineWidth; }
  get selected() { return this._selected; }
  get geometryRevision() { return this._geometryRevision; }

  setDataPoints(points: DrawingDataPoint[]): void {
    this._dataPoints = points;
    this._geometryRevision += 1;
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

  // ── Hit testing (in screen/CSS-pixel coordinates) ──

  /**
   * Returns hit info or null.
   * @param {number} x - screen x relative to chart pane
   * @param {number} y - screen y relative to chart pane
   * @returns {{ pointIndex: number } | null}
   *   pointIndex: 0 or 1 for endpoint hit, -1 for body hit
   */
  hitTestGeometry(x: number, y: number): DrawingHit | null {
    if (this._hidden) return null;
    if (!this._series || !this._chart) return null;
    if (this._dataPoints.length < 2) return null;

    const series = this._series;
    const chart = this._chart;
    const coordinateContext = {};
    const horizontalCoordinates = drawingDataPointsToCoordinates(
      chart,
      series,
      this._dataPoints,
      coordinateContext,
      { cacheToken: this, geometryRevision: this._geometryRevision },
    );
    const screenPoints = this._dataPoints.map((dp, index) => {
      const x = horizontalCoordinates[index] ?? null;
      return { x, y: series.priceToCoordinate(dp.price) };
    });

    const [sa, sb] = screenPoints;
    if (!sa || !sb || sa.x == null || sa.y == null || sb.x == null || sb.y == null) return null;

    const HANDLE_RADIUS = 7 + this._lineWidth;
    const LINE_HIT_RADIUS = 8 + this._lineWidth / 2;

    // Check endpoints
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

    // Check body — use the appropriate distance function so the entire visible
    // line (including ray/infinite extensions) is hit-testable, not just A→B.
    let bodyDist: number;
    if (this._lineType === "line-infinite") {
      bodyDist = distToInfiniteLine(x, y, sa.x, sa.y, sb.x, sb.y);
    } else if (this._lineType === "line-ray") {
      bodyDist = distToRay(x, y, sa.x, sa.y, sb.x, sb.y);
    } else {
      bodyDist = distToSegment(x, y, sa.x, sa.y, sb.x, sb.y);
    }
    if (bodyDist <= LINE_HIT_RADIUS) {
      return { pointIndex: -1 };
    }

    return null;
  }
}

export default LineDrawingPrimitive;
