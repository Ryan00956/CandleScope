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
  normalizeFreehandStrokeV2,
  normalizeLegacyFreehandDataPoints,
} from "../freehandStrokeModel.js";
import {
  dataPointToCoordinate,
  freehandStrokeV2ToCoordinates,
} from "./coordinateUtils.js";

const DEFAULT_HIGHLIGHTER_OPACITY = 0.35;
const DEFAULT_HIGHLIGHTER_COMPOSITE_OPERATION = "multiply";

function normalizeFreehandType(value) {
  return value === "highlighter" ? "highlighter" : "freehand";
}

function normalizeOpacity(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function normalizeBrushShape(value, fallback = "round") {
  return value === "square" ? "square" : fallback;
}

function normalizePreviewPoints(value) {
  if (!Array.isArray(value)) return null;
  const points = [];
  for (const point of value) {
    if (point === null) {
      points.push(null);
      continue;
    }
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
    points.push({ x: point.x, y: point.y });
  }
  return points;
}

function splitScreenPaths(points) {
  const paths = [];
  let currentPath = [];
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

function distToSegment(px, py, ax, ay, bx, by) {
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

function screenPathsForSource(source) {
  if (source._previewScreenPoints !== null) {
    return splitScreenPaths(source._previewScreenPoints);
  }
  const series = source._series;
  const chart = source._chart;
  const coordinateContext = {};

  if (source._stroke) {
    const paths = [];
    let currentPath = [];
    const horizontalPoints = freehandStrokeV2ToCoordinates(
      chart,
      series,
      source._stroke,
      coordinateContext,
    );
    for (const point of horizontalPoints) {
      const y = point ? series.priceToCoordinate(point.price) : null;
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(y)) {
        if (currentPath.length > 0) paths.push(currentPath);
        currentPath = [];
        continue;
      }
      currentPath.push({ x: point.x, y });
    }
    if (currentPath.length > 0) paths.push(currentPath);
    return paths;
  }

  // Preserve the legacy v1 behavior: invalid time-axis points are omitted and
  // the remaining points stay in one path.
  const path = [];
  for (const dataPoint of source._dataPoints) {
    const x = dataPointToCoordinate(chart, series, dataPoint, coordinateContext);
    const y = series.priceToCoordinate(dataPoint.price);
    if (x != null && y != null) path.push({ x, y });
  }
  return path.length > 0 ? [path] : [];
}

function tracePath(context, path, isSquareBrush) {
  context.moveTo(path[0].bx, path[0].by);
  if (path.length === 2 || isSquareBrush) {
    for (let index = 1; index < path.length; index += 1) {
      context.lineTo(path[index].bx, path[index].by);
    }
    return;
  }

  for (let index = 1; index < path.length - 1; index += 1) {
    const midX = (path[index].bx + path[index + 1].bx) / 2;
    const midY = (path[index].by + path[index + 1].by) / 2;
    context.quadraticCurveTo(path[index].bx, path[index].by, midX, midY);
  }
  const last = path[path.length - 1];
  context.quadraticCurveTo(
    path[path.length - 2].bx,
    path[path.length - 2].by,
    last.bx,
    last.by,
  );
}

// ── Pane Renderer ──

class FreehandRenderer {
  constructor() {
    this._data = null;
  }

  update(data) {
    this._data = data;
  }

  draw(target) {
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

class FreehandPaneView {
  constructor(source) {
    this._source = source;
    this._renderer = new FreehandRenderer();
  }

  update() {
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
      hidden: source._hidden,
    });
  }

  renderer() {
    return this._renderer;
  }

  zOrder() {
    return "top";
  }
}

// ── The Primitive ──

export class FreehandDrawingPrimitive {
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
  constructor(opts) {
    this._id = opts.id;
    this._type = normalizeFreehandType(opts.type);
    this._dataPoints = opts.dataPoints || [];
    this._stroke = normalizeFreehandStrokeV2(opts.stroke);
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

  attached({ chart, series, requestUpdate }) {
    this._chart = chart;
    this._series = series;
    this._requestUpdate = requestUpdate;
  }

  detached() {
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  updateAllViews() {
    this._paneView.update();
  }

  paneViews() {
    return [this._paneView];
  }

  // ── Public API ──

  get id() { return this._id; }
  get dataPoints() { return this._dataPoints; }
  get stroke() { return this._stroke; }
  get isPreview() { return this._isPreview; }
  get previewPoints() {
    return this._previewScreenPoints?.map((point) => (point ? { ...point } : null)) || [];
  }
  get color() { return this._color; }
  get lineWidth() { return this._lineWidth; }
  get type() { return this._type; }
  get opacity() { return this._opacity; }
  get compositeOperation() { return this._compositeOperation; }
  get brushShape() { return this._brushShape; }

  addPoint(dp) {
    this._dataPoints.push(dp);
    this._requestUpdate?.();
  }

  setDataPoints(points) {
    this._dataPoints = points;
    this._requestUpdate?.();
  }

  setHovered(v) {
    const next = !!v;
    if (this._hovered !== next) {
      this._hovered = next;
      this._requestUpdate?.();
    }
  }

  /** Replace transient CSS-pixel preview geometry without touching saved data. */
  setPreviewPoints(points) {
    const normalized = normalizePreviewPoints(points);
    if (!normalized || this._previewCancelled) return false;
    this._previewScreenPoints = normalized;
    this._isPreview = true;
    this._requestUpdate?.();
    return true;
  }

  /** Promote a validated v2 stroke and atomically discard all preview state. */
  commitStroke(stroke) {
    const normalized = normalizeFreehandStrokeV2(stroke);
    if (!normalized || this._previewCancelled) return false;
    this._stroke = normalized;
    this._dataPoints = [];
    this._previewScreenPoints = null;
    this._isPreview = false;
    this._requestUpdate?.();
    return true;
  }

  /** Promote a completed legacy source-time stroke out of preview mode. */
  commitDataPoints(points = this._dataPoints) {
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
  cancelPreview() {
    if (!this._isPreview || this._previewCancelled) return false;
    this._previewCancelled = true;
    this._previewScreenPoints = [];
    this._stroke = null;
    this._dataPoints = [];
    this._requestUpdate?.();
    return true;
  }

  setColor(c) {
    this._color = c;
    this._requestUpdate?.();
  }

  setLineWidth(w) {
    this._lineWidth = w;
    this._requestUpdate?.();
  }

  setOpacity(opacity) {
    this._opacity = normalizeOpacity(opacity, this._opacity);
    this._requestUpdate?.();
  }

  setCompositeOperation(compositeOperation) {
    this._compositeOperation = compositeOperation || "source-over";
    this._requestUpdate?.();
  }

  setBrushShape(brushShape) {
    this._brushShape = normalizeBrushShape(brushShape, this._brushShape);
    this._requestUpdate?.();
  }

  setHidden(v, request = true) {
    const next = !!v;
    if (this._hidden !== next) {
      this._hidden = next;
      if (request) this._requestUpdate?.();
    }
  }

  requestUpdate() {
    this._requestUpdate?.();
  }

  // ── Hit testing (screen/CSS-pixel coordinates) ──

  hitTest(x, y, hitRadius = 8) {
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

      // Segments are checked within one resolved path only. A v2 null marker
      // starts a new path and can never create an eraser hit across the gap.
      for (let index = 0; index < screenPoints.length - 1; index += 1) {
        const left = screenPoints[index];
        const right = screenPoints[index + 1];
        if (distToSegment(x, y, left.x, left.y, right.x, right.y) <= totalRadius) {
          return true;
        }
      }
    }

    return false;
  }
}

export default FreehandDrawingPrimitive;
