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
  drawingDataPointsToCoordinates,
  freehandStrokeToCoordinates,
} from "./coordinateUtils.js";
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
import {
  accumulateDrawingPerfFrameWork,
  drawingPerfCounters,
} from "../performance/drawingPerfCounters.js";

interface BitmapPoint {
  bx: number;
  by: number;
}

interface FreehandVisibleRenderData {
  hidden: false;
  paths: ScreenPoint[][];
  unresolvedGapIndexes: number[];
  committed: boolean;
  geometryRevision: number;
  attachmentRevision: number;
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
  unresolvedGapIndexes: [];
};

export interface FreehandCommittedPaintAck {
  readonly id: string;
  readonly geometryRevision: number;
  readonly paintSequence: number;
}

export type FreehandCommittedPaintListener = (ack: FreehandCommittedPaintAck) => void;

interface FreehandScreenProjection {
  paths: ScreenPoint[][];
  unresolvedGapIndexes: number[];
}

const DEFAULT_HIGHLIGHTER_OPACITY = 0.35;
const DEFAULT_HIGHLIGHTER_COMPOSITE_OPERATION: GlobalCompositeOperation = "multiply";

function drawingPerfNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function rawPointCountForSource(source: FreehandDrawingPrimitive): number {
  return source._previewScreenPoints?.length
    ?? source._stroke?.points.length
    ?? source._dataPoints.length;
}

function normalizeFreehandType(value: unknown): FreehandKind {
  return value === "highlighter" ? "highlighter" : "freehand";
}

function normalizeOpacity(value: unknown, fallback = 1): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function normalizeBrushShape(value: unknown, fallback: BrushShape = "round"): BrushShape {
  return value === "round" || value === "square" ? value : fallback;
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

function squaredDistanceToSegment(
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
  if (lenSq === 0) return (px - ax) ** 2 + (py - ay) ** 2;
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  return (px - projX) ** 2 + (py - projY) ** 2;
}

function hitTestScreenPaths(
  screenPaths: readonly (readonly Readonly<ScreenPoint>[])[],
  x: number,
  y: number,
  radius: number,
): boolean {
  const radiusSquared = radius * radius;
  for (const screenPoints of screenPaths) {
    // The renderer intentionally skips singleton paths because Canvas has
    // no visible segment to stroke. Hit testing must follow the same rule.
    if (screenPoints.length < 2) continue;
    for (const point of screenPoints) {
      const dx = point.x - x;
      const dy = point.y - y;
      if (dx * dx + dy * dy <= radiusSquared) return true;
    }

    // Segments are checked within one resolved path only. An unresolved marker
    // starts a new path and can never create a hit across the gap.
    for (let index = 0; index < screenPoints.length - 1; index += 1) {
      const left = screenPoints[index];
      const right = screenPoints[index + 1];
      if (!left || !right) continue;
      if (squaredDistanceToSegment(x, y, left.x, left.y, right.x, right.y)
        <= radiusSquared) return true;
    }
  }
  return false;
}

function screenProjectionForSource(source: FreehandDrawingPrimitive): FreehandScreenProjection {
  if (source._previewScreenPoints !== null) {
    return {
      paths: splitScreenPaths(source._previewScreenPoints),
      unresolvedGapIndexes: source._previewScreenPoints.flatMap((point, index) => (
        point === null ? [index] : []
      )),
    };
  }
  const series = source._series;
  const chart = source._chart;
  if (!series || !chart) return { paths: [], unresolvedGapIndexes: [] };
  const coordinateContext: DrawingCoordinateContext = {};

  if (source._stroke) {
    const paths: ScreenPoint[][] = [];
    const unresolvedGapIndexes: number[] = [];
    let currentPath: ScreenPoint[] = [];
    const horizontalPoints = freehandStrokeToCoordinates(
      chart,
      series,
      source._stroke,
      coordinateContext,
      {
        cacheToken: source,
        geometryRevision: source._geometryRevision,
      },
    );
    let projectedPointCount = 0;
    for (const [index, point] of horizontalPoints.entries()) {
      const y = point ? series.priceToCoordinate(point.price) : null;
      if (!point || !Number.isFinite(point.x) || typeof y !== "number" || !Number.isFinite(y)) {
        unresolvedGapIndexes.push(index);
        if (currentPath.length > 0) paths.push(currentPath);
        currentPath = [];
        continue;
      }
      currentPath.push({ x: point.x, y });
      projectedPointCount += 1;
    }
    if (currentPath.length > 0) paths.push(currentPath);
    if (projectedPointCount > 0) {
      drawingPerfCounters.recordFinalProjection(projectedPointCount);
    }
    return { paths, unresolvedGapIndexes };
  }

  // Preserve the legacy v1 time-axis behavior, but never bridge an unresolved
  // legacy point after the same saved stroke is rendered on an ordinal axis.
  const paths: ScreenPoint[][] = [];
  const unresolvedGapIndexes: number[] = [];
  let path: ScreenPoint[] = [];
  let splitOnUnresolved: boolean | null = null;
  let projectedPointCount = 0;
  const horizontalCoordinates = drawingDataPointsToCoordinates(
    chart,
    series,
    source._dataPoints,
    coordinateContext,
    {
      cacheToken: source,
      geometryRevision: source._geometryRevision,
    },
  );
  for (let index = 0; index < source._dataPoints.length; index += 1) {
    const dataPoint = source._dataPoints[index];
    if (!dataPoint) continue;
    const x = horizontalCoordinates[index] ?? null;
    const y = series.priceToCoordinate(dataPoint.price);
    if (splitOnUnresolved === null) {
      splitOnUnresolved = coordinateContext.drawingCoordinateIndex?.mode === "ordinal";
    }
    if (x != null && y != null) {
      path.push({ x, y });
      projectedPointCount += 1;
    } else if (splitOnUnresolved) {
      unresolvedGapIndexes.push(index);
      if (path.length > 0) paths.push(path);
      path = [];
    }
  }
  if (path.length > 0) paths.push(path);
  if (projectedPointCount > 0) {
    drawingPerfCounters.recordFinalProjection(projectedPointCount);
  }
  return { paths, unresolvedGapIndexes };
}

function screenPathsForSource(source: FreehandDrawingPrimitive): ScreenPoint[][] {
  return screenProjectionForSource(source).paths;
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
  _source: FreehandDrawingPrimitive;
  _data: FreehandRenderData | null;

  constructor(source: FreehandDrawingPrimitive) {
    this._source = source;
    this._data = null;
  }

  update(data: FreehandRenderData): void {
    this._data = data;
  }

  draw(target: PrimitiveCanvasTarget): void {
    const startedAt = drawingPerfNow();
    const data = this._data;
    if (!data || !Array.isArray(data.paths)) return;
    if (data.hidden) return;

    let painted = false;
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
      if (traced) {
        ctx.stroke();
        painted = true;
      }

      ctx.restore();
    });
    const durationMs = drawingPerfNow() - startedAt;
    accumulateDrawingPerfFrameWork({
      drawingMainThreadMs: durationMs,
      sceneProjectPaintMs: durationMs,
    });
    if (painted) this._source._acknowledgeCommittedPaint(data);
  }
}

// ── Pane View ──

class FreehandPaneView implements PrimitivePaneView {
  _source: FreehandDrawingPrimitive;
  _renderer: FreehandRenderer;

  constructor(source: FreehandDrawingPrimitive) {
    this._source = source;
    this._renderer = new FreehandRenderer(source);
  }

  update(recordRebuild = true): void {
    const startedAt = drawingPerfNow();
    const source = this._source;
    const series = source._series;
    const chart = source._chart;

    if (!series || !chart) return;
    if (source._hidden) {
      this._renderer.update({ paths: [], unresolvedGapIndexes: [], hidden: true });
      const durationMs = drawingPerfNow() - startedAt;
      if (recordRebuild) drawingPerfCounters.recordSceneRebuild();
      accumulateDrawingPerfFrameWork({
        geometryKey: source._id,
        drawingMainThreadMs: durationMs,
        sceneProjectPaintMs: durationMs,
        rawPoints: rawPointCountForSource(source),
        renderedPoints: 0,
        visibleEntities: 0,
        culledEntities: 1,
      });
      return;
    }

    const projection = screenProjectionForSource(source);
    const paths = projection.paths;
    const rawPoints = rawPointCountForSource(source);
    const renderedPoints = paths.reduce((sum, path) => sum + path.length, 0);
    this._renderer.update({
      paths,
      unresolvedGapIndexes: projection.unresolvedGapIndexes,
      committed: !source._isPreview && !source._previewCancelled,
      geometryRevision: source._geometryRevision,
      attachmentRevision: source._attachmentRevision,
      color: source._color,
      lineWidth: source._lineWidth,
      opacity: source._opacity,
      compositeOperation: source._compositeOperation,
      brushShape: source._brushShape,
      hovered: source._hovered,
      hidden: false,
    });
    const durationMs = drawingPerfNow() - startedAt;
    if (recordRebuild) drawingPerfCounters.recordSceneRebuild();
    accumulateDrawingPerfFrameWork({
      geometryKey: source._id,
      drawingMainThreadMs: durationMs,
      sceneProjectPaintMs: durationMs,
      rawPoints,
      renderedPoints,
      visibleEntities: renderedPoints > 0 ? 1 : 0,
      culledEntities: renderedPoints > 0 ? 0 : 1,
    });
  }

  renderer(): PrimitivePaneRenderer {
    return this._renderer;
  }

  zOrder(): "top" {
    return "top";
  }
}

interface FreehandViewUpdateBatch {
  readonly members: Set<FreehandDrawingPrimitive>;
  frameOpen: boolean;
  membershipRevision: number;
  processedMembershipRevision: number;
  resetHandle: unknown;
}

const freehandViewUpdateBatches = new WeakMap<object, FreehandViewUpdateBatch>();

function requestFreehandBatchFrameReset(callback: () => void): unknown {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return setTimeout(callback, 0);
}

function freehandBatchForSeries(series: object): FreehandViewUpdateBatch {
  let batch = freehandViewUpdateBatches.get(series);
  if (!batch) {
    batch = {
      members: new Set(),
      frameOpen: false,
      membershipRevision: 0,
      processedMembershipRevision: -1,
      resetHandle: null,
    };
    freehandViewUpdateBatches.set(series, batch);
  }
  return batch;
}

function registerBatchedFreehand(source: FreehandDrawingPrimitive): void {
  const series = source._series;
  if (!series || source._isPreview) return;
  const batch = freehandBatchForSeries(series as object);
  if (batch.members.has(source)) return;
  batch.members.add(source);
  batch.membershipRevision += 1;
}

function unregisterBatchedFreehand(source: FreehandDrawingPrimitive): void {
  const series = source._series;
  if (!series) return;
  const batch = freehandViewUpdateBatches.get(series as object);
  if (!batch?.members.delete(source)) return;
  batch.membershipRevision += 1;
}

function markBatchedFreehandDirty(source: FreehandDrawingPrimitive): void {
  if (!source._viewUpdateBatching || source._isPreview || !source._series) return;
  const batch = freehandViewUpdateBatches.get(source._series as object);
  if (batch?.members.has(source)) batch.membershipRevision += 1;
}

function updateBatchedFreehandViews(source: FreehandDrawingPrimitive): void {
  const series = source._series;
  if (!series) return;
  registerBatchedFreehand(source);
  const batch = freehandBatchForSeries(series as object);
  if (batch.frameOpen
    && batch.processedMembershipRevision === batch.membershipRevision) return;
  batch.frameOpen = true;
  batch.processedMembershipRevision = batch.membershipRevision;
  for (const member of batch.members) member._paneView.update(false);
  drawingPerfCounters.recordSceneRebuild();
  if (batch.resetHandle !== null) return;
  batch.resetHandle = requestFreehandBatchFrameReset(() => {
    batch.resetHandle = null;
    batch.frameOpen = false;
  });
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
  _geometryRevision: number;
  _viewUpdateBatching: boolean;
  _committedPaintListeners: Set<FreehandCommittedPaintListener>;
  _paintSequence: number;
  _attachmentRevision: number;
  _disposed: boolean;

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
    this._geometryRevision = 1;
    this._viewUpdateBatching = false;
    this._committedPaintListeners = new Set();
    this._paintSequence = 0;
    this._attachmentRevision = 0;
    this._disposed = false;
  }

  // ── ISeriesPrimitive interface ──

  attached({ chart, series, requestUpdate }: DrawingAttachedParameter): void {
    if (this._disposed) return;
    this._attachmentRevision += 1;
    this._chart = chart;
    this._series = series;
    this._requestUpdate = () => {
      drawingPerfCounters.recordRequestUpdate();
      requestUpdate();
    };
    if (this._viewUpdateBatching) registerBatchedFreehand(this);
  }

  detached(): void {
    if (this._viewUpdateBatching) unregisterBatchedFreehand(this);
    this._attachmentRevision += 1;
    this._committedPaintListeners.clear();
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.detached();
  }

  updateAllViews(): void {
    if (this._viewUpdateBatching && !this._isPreview) {
      updateBatchedFreehandViews(this);
    } else {
      this._paneView.update();
    }
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
  get geometryRevision(): number { return this._geometryRevision; }

  /** Subscribe to completed committed bitmap strokes. Detached/disposed instances drop all listeners. */
  subscribeCommittedPaint(listener: FreehandCommittedPaintListener): () => void {
    if (this._disposed || typeof listener !== "function") return () => {};
    const listeners = this._committedPaintListeners;
    listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(listener);
    };
  }

  /** Renderer-only acknowledgement; stale plans and non-committed states fail closed. */
  _acknowledgeCommittedPaint(data: FreehandVisibleRenderData): void {
    if (!data.committed
      || this._disposed
      || this._hidden
      || this._isPreview
      || this._previewCancelled
      || !this._chart
      || !this._series
      || data.geometryRevision !== this._geometryRevision
      || data.attachmentRevision !== this._attachmentRevision) {
      return;
    }
    this._paintSequence += 1;
    const ack = Object.freeze({
      id: this._id,
      geometryRevision: data.geometryRevision,
      paintSequence: this._paintSequence,
    });
    for (const listener of Array.from(this._committedPaintListeners)) {
      if (!this._committedPaintListeners.has(listener)) continue;
      try {
        listener(ack);
      } catch {
        // Paint acknowledgement observers must never break the chart renderer.
      }
    }
  }

  /** Phase 4 keeps freehand as legacy primitives but batches their viewport projection once per surface frame. */
  setViewUpdateBatching(enabled: boolean): void {
    const next = !!enabled;
    if (next === this._viewUpdateBatching) return;
    if (this._viewUpdateBatching) unregisterBatchedFreehand(this);
    this._viewUpdateBatching = next;
    if (next) registerBatchedFreehand(this);
  }

  /** Read-only snapshot of the exact screen paths most recently supplied to the visible renderer. */
  getParityScreenSnapshot(): Readonly<{
    hidden: boolean;
    paths: readonly (readonly Readonly<ScreenPoint>[])[];
    unresolvedGapIndexes: readonly number[];
  }> | null {
    const data = this._paneView._renderer._data;
    if (!data) return null;
    return Object.freeze({
      hidden: data.hidden,
      // Renderer updates replace these arrays; they are never mutated after
      // publication. Expose the coherent last-paint view without cloning every
      // point during a low-frequency parity sample.
      paths: data.paths,
      unresolvedGapIndexes: data.unresolvedGapIndexes,
    });
  }

  /** Exact legacy freehand hit semantics over the coherent last-painted paths. */
  hitTestParityScreenSnapshot(x: number, y: number, hitRadius = 8): boolean {
    if (this._hidden || this._isPreview) return false;
    const data = this._paneView._renderer._data;
    if (!data || data.hidden) return false;
    return hitTestScreenPaths(data.paths, x, y, hitRadius + this._lineWidth / 2);
  }

  addPoint(dp: DrawingDataPoint): void {
    this._dataPoints.push(dp);
    this._geometryRevision += 1;
    markBatchedFreehandDirty(this);
    this._requestUpdate?.();
  }

  setDataPoints(points: DrawingDataPoint[]): void {
    this._dataPoints = points;
    this._geometryRevision += 1;
    markBatchedFreehandDirty(this);
    this._requestUpdate?.();
  }

  setHovered(v: boolean): void {
    const next = !!v;
    if (this._hovered !== next) {
      this._hovered = next;
      markBatchedFreehandDirty(this);
      this._requestUpdate?.();
    }
  }

  /** Replace transient CSS-pixel preview geometry without touching saved data. */
  setPreviewPoints(points: unknown): boolean {
    const normalized = normalizePreviewPoints(points);
    if (!normalized || this._previewCancelled) return false;
    if (this._viewUpdateBatching) unregisterBatchedFreehand(this);
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
    if (this._viewUpdateBatching) unregisterBatchedFreehand(this);
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
    if (this._viewUpdateBatching) registerBatchedFreehand(this);
    this._geometryRevision += 1;
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
    if (this._viewUpdateBatching) registerBatchedFreehand(this);
    this._geometryRevision += 1;
    this._requestUpdate?.();
    return true;
  }

  /** Make an abandoned preview inert while keeping it persistence-filtered. */
  cancelPreview(): boolean {
    if (!this._isPreview || this._previewCancelled) return false;
    this._previewCancelled = true;
    if (this._viewUpdateBatching) unregisterBatchedFreehand(this);
    this._previewScreenPoints = [];
    this._stroke = null;
    this._dataPoints = [];
    this._geometryRevision += 1;
    this._requestUpdate?.();
    return true;
  }

  setColor(c: string): void {
    this._color = c;
    markBatchedFreehandDirty(this);
    this._requestUpdate?.();
  }

  setLineWidth(w: number): void {
    this._lineWidth = w;
    markBatchedFreehandDirty(this);
    this._requestUpdate?.();
  }

  setOpacity(opacity: unknown): void {
    this._opacity = normalizeOpacity(opacity, this._opacity);
    markBatchedFreehandDirty(this);
    this._requestUpdate?.();
  }

  setCompositeOperation(compositeOperation: GlobalCompositeOperation | null | undefined): void {
    this._compositeOperation = compositeOperation || "source-over";
    markBatchedFreehandDirty(this);
    this._requestUpdate?.();
  }

  setBrushShape(brushShape: unknown): void {
    this._brushShape = normalizeBrushShape(brushShape, this._brushShape);
    markBatchedFreehandDirty(this);
    this._requestUpdate?.();
  }

  setHidden(v: boolean, request = true): void {
    const next = !!v;
    if (this._hidden !== next) {
      this._hidden = next;
      markBatchedFreehandDirty(this);
      if (request) this._requestUpdate?.();
    }
  }

  requestUpdate(): void {
    this._requestUpdate?.();
  }

  // ── Hit testing (screen/CSS-pixel coordinates) ──

  hitTestGeometry(x: number, y: number, hitRadius = 8): boolean {
    if (this._hidden) return false;
    if (this._isPreview) return false;
    if (!this._series || !this._chart) return false;
    if (this._stroke ? this._stroke.points.length < 2 : this._dataPoints.length < 2) return false;

    const screenPaths = screenPathsForSource(this);
    return hitTestScreenPaths(screenPaths, x, y, hitRadius + this._lineWidth / 2);
  }
}

export default FreehandDrawingPrimitive;
