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

import { dataPointToCoordinate } from "./coordinateUtils.js";

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
    if (!data || !data.points || data.points.length < 2) return;
    if (data.hidden) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hRatio = scope.horizontalPixelRatio;
      const vRatio = scope.verticalPixelRatio;
      const { points, color, lineWidth, hovered, opacity, compositeOperation, brushShape } = data;
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

      // Filter out invalid points first
      const valid = [];
      for (const pt of points) {
        if (pt.x != null && pt.y != null) {
          valid.push({ bx: pt.x * hRatio, by: pt.y * vRatio });
        }
      }

      if (valid.length < 2) { ctx.restore(); return; }

      ctx.beginPath();
      ctx.moveTo(valid[0].bx, valid[0].by);

      if (valid.length === 2 || isSquareBrush) {
        // Square brushes should keep hard edges, so draw straight segments
        // instead of smoothing through quadratic curves.
        for (let i = 1; i < valid.length; i++) {
          ctx.lineTo(valid[i].bx, valid[i].by);
        }
      } else {
        // Smooth curve using quadratic Bezier through midpoints:
        // Each original sample point becomes a control point, and
        // the midpoint between consecutive samples becomes the
        // curve endpoint — this produces C1-continuous curves.
        for (let i = 1; i < valid.length - 1; i++) {
          const midX = (valid[i].bx + valid[i + 1].bx) / 2;
          const midY = (valid[i].by + valid[i + 1].by) / 2;
          ctx.quadraticCurveTo(valid[i].bx, valid[i].by, midX, midY);
        }
        // Final segment: curve to the last point
        const last = valid[valid.length - 1];
        ctx.quadraticCurveTo(
          valid[valid.length - 2].bx, valid[valid.length - 2].by,
          last.bx, last.by
        );
      }
      ctx.stroke();

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

    const points = [];

    for (const dp of source._dataPoints) {
      const x = dataPointToCoordinate(chart, series, dp);
      const y = series.priceToCoordinate(dp.price);
      points.push({ x, y });
    }

    this._renderer.update({
      points,
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
    if (this._hovered !== v) {
      this._hovered = v;
      this._requestUpdate?.();
    }
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
    if (!this._series || !this._chart) return false;
    if (this._dataPoints.length < 2) return false;

    const screenPoints = [];

    for (const dp of this._dataPoints) {
      const sx = dataPointToCoordinate(this._chart, this._series, dp);
      const sy = this._series.priceToCoordinate(dp.price);
      if (sx != null && sy != null) {
        screenPoints.push({ x: sx, y: sy });
      }
    }

    const totalRadius = hitRadius + this._lineWidth / 2;

    // Check each point
    for (const pt of screenPoints) {
      const dx = pt.x - x;
      const dy = pt.y - y;
      if (Math.sqrt(dx * dx + dy * dy) <= totalRadius) return true;
    }

    // Check each segment
    for (let i = 0; i < screenPoints.length - 1; i++) {
      const a = screenPoints[i];
      const b = screenPoints[i + 1];
      if (distToSegment(x, y, a.x, a.y, b.x, b.y) <= totalRadius) return true;
    }

    return false;
  }
}

export default FreehandDrawingPrimitive;
