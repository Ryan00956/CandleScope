/**
 * FreehandDrawingPrimitive — Lightweight Charts v5 Plugin API (ISeriesPrimitive)
 *
 * Renders a freehand polyline directly inside the chart's native Canvas
 * rendering pipeline via series.attachPrimitive(). Points are stored in
 * data coordinates (time + price), so they survive timeframe switches
 * and automatically follow pan/zoom with zero lag.
 *
 * Supports:
 *   - Smooth polyline rendering via quadratic Bezier curves
 *   - Square brush rendering for highlighter strokes
 *   - Hover highlight for eraser tool
 *   - Hit-testing for eraser deletion
 */

import {
  normalizeFreehandStroke,
  normalizeLegacyFreehandDataPoints,
} from "../freehandStrokeModel.js";
import {
  dataPointToCoordinate,
  freehandStrokeToCoordinates,
} from "./coordinateUtils.js";
import { isOrdinalAxisTime } from "../../../chart-adapter/coordinateBridge.js";
import type { DrawingCoordinateContext } from "../../../chart-adapter/coordinateBridge.js";
import type {
  BrushShape,
  DrawingAttachedParameter,
  DrawingDataPoint,
  FreehandKind,
  FreehandPrimitiveOptions,
  FreehandStroke,
  PrimitiveCanvasTarget,
  PrimitivePaneRenderer,
  PrimitivePaneView,
  ScreenPoint,
} from "../drawingTypes.js";

interface BitmapPoint {
  bx: number;
  by: number;
}

interface FreehandVisibleRenderData {
  hidden: false;
  paths: ScreenPoint[][];
  color: string;
  lineWidth: number;
  hovered: boolean;
  opacity: number;
  compositeOperation: GlobalCompositeOperation;
  brushShape: BrushShape;
}

type FreehandRenderData = FreehandVisibleRenderData | {
  hidden: true;
  paths: [];
};

const DEFAULT_HIGHLIGHTER_OPACITY = 0.35;
const DEFAULT_HIGHLIGHTER_COMPOSITE_OPERATION: GlobalCompositeOperation = "multiply";

function normalizeFreehandType(value: unknown): FreehandKind {
  return value === "highlighter" ? "highlighter" : "freehand";
}

function normalizeOpacity(value: unknown, fallback = 1): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function normalizeBrushShape(value: unknown, fallback: BrushShape = "round"): BrushShape {
  return value === "square" ? "square" : fallback;
}

function normalizePreviewPoints(value: unknown): Array<ScreenPoint | null> | null {
  if (!Array.isArray(value)) return null;
  const points: Array<ScreenPoint | null> = [];
  for (const point of value) {
    if (point === null) {
      points.push(null);
      continue;
    }
    if (typeof point !== "object" || point === null) return null;
    const candidate = point as Record<string, unknown>;
    if (typeof candidate.x !== "number" || !Number.isFinite(candidate.x)
      || typeof candidate.y !== "number" || !Number.isFinite(candidate.y)) return null;
    points.push({ x: candidate.x, y: candidate.y });
  }
  return points;
}

function splitScreenPaths(points: Array<ScreenPoint | null>): ScreenPoint[][] {
  const paths: ScreenPoint[][] = [];
  let currentPath: ScreenPoint[] = [];
  for (const point of points) {
    if (!point) {
      if (currentPath.length > 0) paths.push(currentPath);
      currentPath = [];
      continue;
    }
    currentPath.push(point);
  }
  if (currentPath.length > 0) paths.push(currentPath);
  return paths;
}

// ── Geometry helper ──

function distToSegment(
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
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}

function screenPathsForSource(source: FreehandDrawingPrimitive): ScreenPoint[][] {
  if (source._previewScreenPoints !== null) {
    return splitScreenPaths(source._previewScreenPoints);
  }
  const series = source._series;
  const chart = source._chart;
  if (!series || !chart) return [];
  const coordinateContext: DrawingCoordinateContext = {};

  if (source._stroke) {
    const paths: ScreenPoint[][] = [];
    let currentPath: ScreenPoint[] = [];
    const horizontalPoints = freehandStrokeToCoordinates(
      chart,
      series,
      source._stroke,
      coordinateContext,
    );
    for (const point of horizontalPoints) {
      const y = point ? series.priceToCoordinate(point.price) : null;
      if (!point || !Number.isFinite(point.x) || typeof y !== "number" || !Number.isFinite(y)) {
        if (currentPath.length > 0) paths.push(currentPath);
        currentPath = [];
        continue;
      }
      currentPath.push({ x: point.x, y });
    }
    if (currentPath.length > 0) paths.push(currentPath);
    return paths;
  }

  // Preserve the legacy v1 time-axis behavior, but never bridge an unresolved
  // legacy point after the same saved stroke is rendered on an ordinal axis.
  const paths: ScreenPoint[][] = [];
  let path: ScreenPoint[] = [];
  let splitOnUnresolved: boolean | null = null;
  for (const dataPoint of source._dataPoints) {
    const x = dataPointToCoordinate(chart, series, dataPoint, coordinateContext);
    const y = series.priceToCoordinate(dataPoint.price);
    if (splitOnUnresolved === null) {
      const firstDataTime = coordinateContext.seriesData?.find(
        (row) => row?.time != null,
      )?.time;
      splitOnUnresolved = isOrdinalAxisTime(firstDataTime);
    }
    if (x != null && y != null) {
      path.push({ x, y });
    } else if (splitOnUnresolved) {
      if (path.length > 0) paths.push(path);
      path = [];
    }
  }
  if (path.length > 0) paths.push(path);
  return paths;
}

function tracePath(
  context: CanvasRenderingContext2D,
  path: BitmapPoint[],
  isSquareBrush: boolean,
): void {
  const first = path[0];
  if (!first) return;
  context.moveTo(first.bx, first.by);
  if (path.length === 2 || isSquareBrush) {
    for (let index = 1; index < path.length; index += 1) {
      const point = path[index];
      if (!point) continue;
      context.lineTo(point.bx, point.by);
    }
    return;
  }

  for (let index = 1; index < path.length - 1; index += 1) {
    const point = path[index];
    const nextPoint = path[index + 1];
    if (!point || !nextPoint) continue;
    const midX = (point.bx + nextPoint.bx) / 2;
    const midY = (point.by + nextPoint.by) / 2;
    context.quadraticCurveTo(point.bx, point.by, midX, midY);
  }
  const last = path[path.length - 1];
  const penultimate = path[path.length - 2];
  if (!last || !penultimate) return;
  context.quadraticCurveTo(
    penultimate.bx,
    penultimate.by,
    last.bx,
    last.by,
  );
}

// ── Pane Renderer ──

class FreehandRenderer implements PrimitivePaneRenderer {
  _data: FreehandRenderData | null;

  constructor() {
    this._data = null;
  }

  update(data: FreehandRenderData): void {
    this._data = data;
  }

  draw(target: PrimitiveCanvasTarget): void {
    const data = this._data;
    if (!data || !Array.isArray(data.paths)) return;
    if (data.hidden) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hRatio = scope.horizontalPixelRatio;
      const vRatio = scope.verticalPixelRatio;
      const { paths, color, lineWidth, hovered, opacity, compositeOperation, brushShape } = data;
      const isSquareBrush = brushShape === "square";

      ctx.save();
      ctx.lineCap = isSquareBrush ? "square" : "round";
      ctx.lineJoin = isSquareBrush ? "bevel" : "round";
      ctx.globalCompositeOperation = hovered ? "source-over" : (compositeOperation || "source-over");

      const scaledWidth = lineWidth * Math.min(hRatio, vRatio);
      ctx.lineWidth = scaledWidth;

      if (hovered) {
        ctx.strokeStyle = "#ff6b6b";
        ctx.globalAlpha = 0.6;
      } else {
        ctx.strokeStyle = color;
        ctx.globalAlpha = normalizeOpacity(opacity, 1);
      }

      ctx.beginPath();
      let traced = false;
      for (const path of paths) {
        if (!Array.isArray(path) || path.length < 2) continue;
        const scaledPath = path.map((point) => ({
          bx: point.x * hRatio,
          by: point.y * vRatio,
        }));
        tracePath(ctx, scaledPath, isSquareBrush);
        traced = true;
      }
      if (traced) ctx.stroke();

      ctx.restore();
    });
  }
}

// ── Pane View ──

class FreehandPaneView implements PrimitivePaneView {
  _source: FreehandDrawingPrimitive;
  _renderer: FreehandRenderer;

  constructor(source: FreehandDrawingPrimitive) {
    this._source = source;
    this._renderer = new FreehandRenderer();
  }

  update(): void {
    const source = this._source;
    const series = source._series;
    const chart = source._chart;

    if (!series || !chart) return;
    if (source._hidden) {
      this._renderer.update({ paths: [], hidden: true });
      return;
    }

    const paths = screenPathsForSource(source);

    this._renderer.update({
      paths,
      color: source._color,
      lineWidth: source._lineWidth,
      opacity: source._opacity,
      compositeOperation: source._compositeOperation,
      brushShape: source._brushShape,
      hovered: source._hovered,
      hidden: false,
    });
  }

  renderer(): PrimitivePaneRenderer {
    return this._renderer;
  }

  zOrder(): "top" {
    return "top";
  }
}

// ── The Primitive ──

export class FreehandDrawingPrimitive {
  _id: string;
  _type: FreehandKind;
  _dataPoints: DrawingDataPoint[];
  _stroke: FreehandStroke | null;
  _previewScreenPoints: Array<ScreenPoint | null> | null;
  _isPreview: boolean;
  _previewCancelled: boolean;
  _color: string;
  _lineWidth: number;
  _opacity: number;
  _compositeOperation: GlobalCompositeOperation;
  _brushShape: BrushShape;
  _hovered: boolean;
  _hidden: boolean;
  _series: DrawingAttachedParameter["series"] | null;
  _chart: DrawingAttachedParameter["chart"] | null;
  _paneView: FreehandPaneView;
  _requestUpdate: (() => void) | null;

  /**
   * @param {object} opts
   * @param {string} opts.id - unique identifier
   * @param {{time: number, price: number}[]} opts.dataPoints - polyline points in data coords
   * @param {string} opts.color - line color (hex)
   * @param {number} opts.lineWidth - line width in CSS pixels
   * @param {"freehand"|"highlighter"} [opts.type] - drawing subtype
   * @param {number} [opts.opacity] - stroke opacity, 0..1
   * @param {string} [opts.compositeOperation] - Canvas composite mode
  * @param {"round"|"square"} [opts.brushShape] - brush cap/join shape
   */
  constructor(opts: FreehandPrimitiveOptions) {
    this._id = opts.id;
    this._type = normalizeFreehandType(opts.type);
    this._dataPoints = opts.dataPoints || [];
    this._stroke = normalizeFreehandStroke(opts.stroke);
    const previewPoints = opts.previewPoints === undefined
      ? null
      : normalizePreviewPoints(opts.previewPoints);
    this._previewScreenPoints = previewPoints;
    this._isPreview = !!opts.isPreview || previewPoints !== null;
    this._previewCancelled = false;
    this._color = opts.color || "#f59e0b";
    this._lineWidth = opts.lineWidth || 2;
    this._opacity = normalizeOpacity(
      opts.opacity,
      this._type === "highlighter" ? DEFAULT_HIGHLIGHTER_OPACITY : 1,
    );
    this._compositeOperation = opts.compositeOperation || (
      this._type === "highlighter" ? DEFAULT_HIGHLIGHTER_COMPOSITE_OPERATION : "source-over"
    );
    this._brushShape = normalizeBrushShape(
      opts.brushShape,
      this._type === "highlighter" ? "square" : "round",
    );
    this._hovered = false;
    this._hidden = !!opts.hidden;

    this._series = null;
    this._chart = null;
    this._paneView = new FreehandPaneView(this);
    this._requestUpdate = null;
  }

  // ── ISeriesPrimitive interface ──

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

  paneViews(): PrimitivePaneView[] {
    return [this._paneView];
  }

  // ── Public API ──

  get id(): string { return this._id; }
  get dataPoints(): DrawingDataPoint[] { return this._dataPoints; }
  get stroke(): FreehandStroke | null { return this._stroke; }
  get isPreview(): boolean { return this._isPreview; }
  get previewPoints(): Array<ScreenPoint | null> {
    return this._previewScreenPoints?.map((point) => (point ? { ...point } : null)) || [];
  }
  get color(): string { return this._color; }
  get lineWidth(): number { return this._lineWidth; }
  get type(): FreehandKind { return this._type; }
  get opacity(): number { return this._opacity; }
  get compositeOperation(): GlobalCompositeOperation { return this._compositeOperation; }
  get brushShape(): BrushShape { return this._brushShape; }

  addPoint(dp: DrawingDataPoint): void {
    this._dataPoints.push(dp);
    this._requestUpdate?.();
  }

  setDataPoints(points: DrawingDataPoint[]): void {
    this._dataPoints = points;
    this._requestUpdate?.();
  }

  setHovered(v: boolean): void {
    const next = !!v;
    if (this._hovered !== next) {
      this._hovered = next;
      this._requestUpdate?.();
    }
  }

  /** Replace transient CSS-pixel preview geometry without touching saved data. */
  setPreviewPoints(points: unknown): boolean {
    const normalized = normalizePreviewPoints(points);
    if (!normalized || this._previewCancelled) return false;
    this._previewScreenPoints = normalized;
    this._isPreview = true;
    this._requestUpdate?.();
    return true;
  }

  /** Append one validated pointer-frame delta without cloning the full draft. */
  appendPreviewPoints(points: unknown): boolean {
    const normalized = normalizePreviewPoints(points);
    if (!normalized || this._previewCancelled) return false;
    if (normalized.length === 0) return true;
    if (this._previewScreenPoints === null) this._previewScreenPoints = [];
    this._previewScreenPoints.push(...normalized);
    this._isPreview = true;
    this._requestUpdate?.();
    return true;
  }

  /** Promote a validated v2/v3 stroke and atomically discard all preview state. */
  commitStroke(stroke: unknown): boolean {
    const normalized = normalizeFreehandStroke(stroke);
    if (!normalized || this._previewCancelled) return false;
    this._stroke = normalized;
    this._dataPoints = [];
    this._previewScreenPoints = null;
    this._isPreview = false;
    this._requestUpdate?.();
    return true;
  }

  /** Promote a completed legacy source-time stroke out of preview mode. */
  commitDataPoints(points: unknown = this._dataPoints): boolean {
    const normalized = normalizeLegacyFreehandDataPoints(points);
    if (!normalized || this._previewCancelled) return false;
    this._dataPoints = normalized;
    this._stroke = null;
    this._previewScreenPoints = null;
    this._isPreview = false;
    this._requestUpdate?.();
    return true;
  }

  /** Make an abandoned preview inert while keeping it persistence-filtered. */
  cancelPreview(): boolean {
    if (!this._isPreview || this._previewCancelled) return false;
    this._previewCancelled = true;
    this._previewScreenPoints = [];
    this._stroke = null;
    this._dataPoints = [];
    this._requestUpdate?.();
    return true;
  }

  setColor(c: string): void {
    this._color = c;
    this._requestUpdate?.();
  }

  setLineWidth(w: number): void {
    this._lineWidth = w;
    this._requestUpdate?.();
  }

  setOpacity(opacity: unknown): void {
    this._opacity = normalizeOpacity(opacity, this._opacity);
    this._requestUpdate?.();
  }

  setCompositeOperation(compositeOperation: GlobalCompositeOperation | null | undefined): void {
    this._compositeOperation = compositeOperation || "source-over";
    this._requestUpdate?.();
  }

  setBrushShape(brushShape: unknown): void {
    this._brushShape = normalizeBrushShape(brushShape, this._brushShape);
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

  // ── Hit testing (screen/CSS-pixel coordinates) ──

  hitTest(x: number, y: number, hitRadius = 8): boolean {
    if (this._hidden) return false;
    if (this._isPreview) return false;
    if (!this._series || !this._chart) return false;
    if (this._stroke ? this._stroke.points.length < 2 : this._dataPoints.length < 2) return false;

    const screenPaths = screenPathsForSource(this);

    const totalRadius = hitRadius + this._lineWidth / 2;

    // Check each point
    for (const screenPoints of screenPaths) {
      // The renderer intentionally skips singleton paths because Canvas has
      // no visible segment to stroke. Hit testing must follow the same rule.
      if (screenPoints.length < 2) continue;
      for (const point of screenPoints) {
        const dx = point.x - x;
        const dy = point.y - y;
        if (Math.sqrt(dx * dx + dy * dy) <= totalRadius) return true;
      }

      // Segments are checked within one resolved path only. An unresolved marker
      // starts a new path and can never create an eraser hit across the gap.
      for (let index = 0; index < screenPoints.length - 1; index += 1) {
        const left = screenPoints[index];
        const right = screenPoints[index + 1];
        if (!left || !right) continue;
        if (distToSegment(x, y, left.x, left.y, right.x, right.y) <= totalRadius) {
          return true;
        }
      }
    }

    return false;
  }
}

export default FreehandDrawingPrimitive;
