/**
 * FreehandDrawingPrimitive — Lightweight Charts v5 Plugin API (ISeriesPrimitive)
 *
 * Renders a freehand polyline directly inside the chart's native Canvas
 * rendering pipeline via series.attachPrimitive(). Points are stored in
 * data coordinates (time + price), so they survive timeframe switches
 * and automatically follow pan/zoom with zero lag.
 *
 * Supports:
 *   - Smooth polyline rendering with configurable color/width
 *   - Hover highlight for eraser tool
 *   - Hit-testing for eraser deletion
 */

import { timeToCoordinateInterpolated } from "./coordinateUtils.js";

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

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hRatio = scope.horizontalPixelRatio;
      const vRatio = scope.verticalPixelRatio;
      const { points, color, lineWidth, hovered } = data;

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      const scaledWidth = lineWidth * Math.min(hRatio, vRatio);
      ctx.lineWidth = scaledWidth;

      if (hovered) {
        ctx.strokeStyle = "#ff6b6b";
        ctx.globalAlpha = 0.6;
      } else {
        ctx.strokeStyle = color;
        ctx.globalAlpha = 1;
      }

      ctx.beginPath();
      let started = false;
      for (const pt of points) {
        if (pt.x == null || pt.y == null) continue;
        const bx = pt.x * hRatio;
        const by = pt.y * vRatio;
        if (!started) {
          ctx.moveTo(bx, by);
          started = true;
        } else {
          ctx.lineTo(bx, by);
        }
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

    const timeScale = chart.timeScale();
    const points = [];

    for (const dp of source._dataPoints) {
      let x = null;
      if (dp.time != null) {
        x = timeScale.timeToCoordinate(dp.time);
        if (x == null || !isFinite(x)) {
          x = timeToCoordinateInterpolated(chart, series, dp.time);
        }
      }
      if ((x == null || !isFinite(x)) && dp.logical != null) {
        x = timeScale.logicalToCoordinate(dp.logical);
      }
      const y = series.priceToCoordinate(dp.price);
      points.push({ x, y });
    }

    this._renderer.update({
      points,
      color: source._color,
      lineWidth: source._lineWidth,
      hovered: source._hovered,
    });
  }

  renderer() {
    return this._renderer;
  }

  zOrder() {
    return "normal";
  }
}

// ── The Primitive ──

export class FreehandDrawingPrimitive {
  /**
   * @param {object} opts
   * @param {string} opts.id - unique identifier
   * @param {{logical: number, price: number}[]} opts.dataPoints - polyline points in data coords
   * @param {string} opts.color - line color (hex)
   * @param {number} opts.lineWidth - line width in CSS pixels
   */
  constructor(opts) {
    this._id = opts.id;
    this._dataPoints = opts.dataPoints || [];
    this._color = opts.color || "#f59e0b";
    this._lineWidth = opts.lineWidth || 2;
    this._hovered = false;

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

  requestUpdate() {
    this._requestUpdate?.();
  }

  // ── Hit testing (screen/CSS-pixel coordinates) ──

  hitTest(x, y, hitRadius = 8) {
    if (!this._series || !this._chart) return false;
    if (this._dataPoints.length < 2) return false;

    const timeScale = this._chart.timeScale();
    const screenPoints = [];

    for (const dp of this._dataPoints) {
      let sx = null;
      if (dp.time != null) {
        sx = timeScale.timeToCoordinate(dp.time);
        if (sx == null || !isFinite(sx)) {
          sx = timeToCoordinateInterpolated(this._chart, this._series, dp.time);
        }
      }
      if ((sx == null || !isFinite(sx)) && dp.logical != null) {
        sx = timeScale.logicalToCoordinate(dp.logical);
      }
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
