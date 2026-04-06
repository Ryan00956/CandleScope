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
 *
 * Screen-coordinate caching:
 *   During active drawing, each point also carries cached screen
 *   coordinates (_screenX, _screenY) so that the renderer can bypass
 *   the lossy time↔coordinate round-trip and draw exactly where the
 *   mouse was. Once the stroke finishes, the cache is cleared and all
 *   subsequent renders (pan/zoom/timeframe switch) convert from
 *   data coordinates as usual.
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

      if (valid.length === 2) {
        // Only two points — just draw a straight line
        ctx.lineTo(valid[1].bx, valid[1].by);
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

    const timeScale = chart.timeScale();
    const points = [];

    for (const dp of source._dataPoints) {
      // ── Fast path: use cached screen coordinates if available ──
      // During active drawing, the cached screen coords avoid the lossy
      // data-coordinate round-trip, so the line follows the cursor exactly.
      if (dp._screenX != null && dp._screenY != null) {
        points.push({ x: dp._screenX, y: dp._screenY });
        continue;
      }

      // ── Normal path: convert data coordinates to screen ──
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

  /**
   * Add a point during active drawing.
   * @param {object} dp - { time, price } data coordinates
   * @param {number} [screenX] - cached screen x coordinate
   * @param {number} [screenY] - cached screen y coordinate
   */
  addPoint(dp, screenX, screenY) {
    // Attach cached screen coordinates directly to the data point
    // so the renderer can use them without round-tripping through
    // lossy coordinate conversion.
    if (screenX != null && screenY != null) {
      dp._screenX = screenX;
      dp._screenY = screenY;
    }
    this._dataPoints.push(dp);
    this._requestUpdate?.();
  }

  /**
   * Clear cached screen coordinates from all data points.
   * Call this when the stroke finishes so that subsequent renders
   * (after pan/zoom/timeframe change) use proper data-coordinate conversion.
   */
  clearScreenCache() {
    for (const dp of this._dataPoints) {
      delete dp._screenX;
      delete dp._screenY;
    }
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
