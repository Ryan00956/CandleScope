/**
 * ShapeDrawingPrimitive — Lightweight Charts v5 Plugin API (ISeriesPrimitive)
 *
 * Renders TradingView-style bounded shapes (rectangle / ellipse) directly in
 * Lightweight Charts' native Canvas pipeline. Shape anchors are stored in
 * data coordinates (time + price), so shapes follow pan/zoom and survive
 * timeframe switches.
 */

import { dataPointToCoordinate } from "./coordinateUtils.js";

const HANDLE_KEYS = ["tl", "t", "tr", "r", "br", "b", "bl", "l"];

function normalizeShapeType(value) {
  return value === "ellipse" ? "ellipse" : "rectangle";
}

function normalizeOpacity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.12;
  return Math.max(0, Math.min(1, n));
}

function adjustAlpha(color, alpha) {
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
    r = parseInt(color[1] + color[1], 16);
    g = parseInt(color[2] + color[2], 16);
    b = parseInt(color[3] + color[3], 16);
  } else if (color.length === 7) {
    r = parseInt(color.slice(1, 3), 16);
    g = parseInt(color.slice(3, 5), 16);
    b = parseInt(color.slice(5, 7), 16);
  } else {
    return color;
  }
  return `rgba(${r},${g},${b},${a})`;
}

function drawShapePath(ctx, shapeType, x, y, w, h) {
  ctx.beginPath();
  if (shapeType === "ellipse") {
    ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
  } else {
    ctx.rect(x, y, w, h);
  }
}

function computeHandlePositions(x, y, w, h) {
  return {
    tl: { x, y },
    t:  { x: x + w / 2, y },
    tr: { x: x + w, y },
    r:  { x: x + w, y: y + h / 2 },
    br: { x: x + w, y: y + h },
    b:  { x: x + w / 2, y: y + h },
    bl: { x, y: y + h },
    l:  { x, y: y + h / 2 },
  };
}

function boxFromPoints(a, b) {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x, b.x);
  const bottom = Math.max(a.y, b.y);
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    right,
    bottom,
  };
}

function isPointInBox(x, y, box, margin = 0) {
  return (
    x >= box.x - margin && x <= box.right + margin &&
    y >= box.y - margin && y <= box.bottom + margin
  );
}

function isPointInEllipse(x, y, box, margin = 0) {
  const rx = box.width / 2;
  const ry = box.height / 2;
  if (rx <= 0 || ry <= 0) return false;
  const cx = box.x + rx;
  const cy = box.y + ry;
  const nx = (x - cx) / (rx + margin);
  const ny = (y - cy) / (ry + margin);
  return nx * nx + ny * ny <= 1;
}

class ShapeRenderer {
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
      const minRatio = Math.min(hRatio, vRatio);
      const {
        points,
        shapeType,
        color,
        lineWidth,
        fillColor,
        fillOpacity,
        lineStyle,
        selected,
        hovered,
        isPreview,
      } = data;

      const [a, b] = points;
      if (a.x == null || a.y == null || b.x == null || b.y == null) return;

      const ax = a.x * hRatio;
      const ay = a.y * vRatio;
      const bx = b.x * hRatio;
      const by = b.y * vRatio;
      const left = Math.min(ax, bx);
      const top = Math.min(ay, by);
      const width = Math.abs(bx - ax);
      const height = Math.abs(by - ay);
      if (width < 0.5 || height < 0.5) return;

      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      const fillAlpha = normalizeOpacity(fillOpacity) * (isPreview ? 0.55 : 1);
      if (fillColor && fillColor !== "transparent" && fillAlpha > 0) {
        ctx.fillStyle = adjustAlpha(fillColor, fillAlpha);
        drawShapePath(ctx, shapeType, left, top, width, height);
        ctx.fill();
      }

      const scaledWidth = lineWidth * minRatio;
      ctx.lineWidth = scaledWidth;
      ctx.strokeStyle = hovered && !selected ? adjustAlpha(color, 0.85) : color;

      if (isPreview) {
        ctx.setLineDash([6 * hRatio, 4 * hRatio]);
        ctx.globalAlpha = 0.85;
      } else if (lineStyle === "dashed") {
        ctx.setLineDash([6 * hRatio, 4 * hRatio]);
      } else if (lineStyle === "dotted") {
        ctx.setLineDash([1 * hRatio, 4 * hRatio]);
      }

      drawShapePath(ctx, shapeType, left, top, width, height);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      if (hovered && !selected) {
        ctx.strokeStyle = adjustAlpha(color, 0.18);
        ctx.lineWidth = Math.max(scaledWidth + 10 * minRatio, 12 * minRatio);
        drawShapePath(ctx, shapeType, left, top, width, height);
        ctx.stroke();
      }

      if (selected) {
        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = 1 * minRatio;
        ctx.setLineDash([4 * hRatio, 3 * hRatio]);
        ctx.strokeRect(left - 0.5 * hRatio, top - 0.5 * vRatio, width + hRatio, height + vRatio);
        ctx.setLineDash([]);

        const handles = computeHandlePositions(left, top, width, height);
        const handleSize = 7 * minRatio;
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = 1.25 * minRatio;
        ctx.shadowColor = "rgba(0,0,0,0.3)";
        ctx.shadowBlur = 4 * minRatio;
        for (const key of HANDLE_KEYS) {
          const p = handles[key];
          ctx.beginPath();
          ctx.rect(p.x - handleSize / 2, p.y - handleSize / 2, handleSize, handleSize);
          ctx.fill();
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
      }

      ctx.restore();
    });
  }
}

class ShapePaneView {
  constructor(source) {
    this._source = source;
    this._renderer = new ShapeRenderer();
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
      shapeType: source._shapeType,
      color: source._color,
      lineWidth: source._lineWidth,
      fillColor: source._fillColor,
      fillOpacity: source._fillOpacity,
      lineStyle: source._lineStyle,
      selected: source._selected,
      hovered: source._hovered,
      isPreview: source._isPreview,
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

export class ShapeDrawingPrimitive {
  constructor(opts) {
    this._id = opts.id;
    this._type = "shape";
    this._shapeType = normalizeShapeType(opts.shapeType);
    this._dataPoints = opts.dataPoints || [];
    this._color = opts.color || "#f59e0b";
    this._lineWidth = opts.lineWidth || 2;
    this._fillColor = opts.fillColor || this._color;
    this._fillOpacity = normalizeOpacity(opts.fillOpacity);
    this._lineStyle = opts.lineStyle || "solid";
    this._selected = !!opts.selected;
    this._hovered = !!opts.hovered;
    this._isPreview = !!opts.isPreview;
    this._hidden = !!opts.hidden;

    this._series = null;
    this._chart = null;
    this._paneView = new ShapePaneView(this);
    this._requestUpdate = null;
  }

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

  get id() { return this._id; }
  get shapeType() { return this._shapeType; }
  get dataPoints() { return this._dataPoints; }
  get color() { return this._color; }
  get lineWidth() { return this._lineWidth; }
  get fillColor() { return this._fillColor; }
  get fillOpacity() { return this._fillOpacity; }
  get lineStyle() { return this._lineStyle; }
  get selected() { return this._selected; }

  setDataPoints(points) {
    this._dataPoints = points;
    this._requestUpdate?.();
  }

  setSelected(v) {
    const next = !!v;
    if (this._selected !== next) {
      this._selected = next;
      this._requestUpdate?.();
    }
  }

  setHovered(v) {
    const next = !!v;
    if (this._hovered !== next) {
      this._hovered = next;
      this._requestUpdate?.();
    }
  }

  setColor(color) {
    this._color = color;
    this._requestUpdate?.();
  }

  setLineWidth(width) {
    this._lineWidth = width;
    this._requestUpdate?.();
  }

  setFillColor(color) {
    this._fillColor = color;
    this._requestUpdate?.();
  }

  setFillOpacity(opacity) {
    this._fillOpacity = normalizeOpacity(opacity);
    this._requestUpdate?.();
  }

  setLineStyle(style) {
    this._lineStyle = style || "solid";
    this._requestUpdate?.();
  }

  setPreview(v) {
    this._isPreview = !!v;
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

  _screenPoints() {
    if (!this._series || !this._chart || this._dataPoints.length < 2) return null;
    const points = [];

    for (const dp of this._dataPoints) {
      const x = dataPointToCoordinate(this._chart, this._series, dp);
      const y = this._series.priceToCoordinate(dp.price);
      if (x == null || y == null || !isFinite(x) || !isFinite(y)) return null;
      points.push({ x, y });
    }

    return points;
  }

  getBoundingBoxScreen() {
    const points = this._screenPoints();
    if (!points || points.length < 2) return null;
    return boxFromPoints(points[0], points[1]);
  }

  hitTest(x, y) {
    if (this._hidden) return null;
    const box = this.getBoundingBoxScreen();
    if (!box) return null;

    const HANDLE_RADIUS = 7 + this._lineWidth;
    if (this._selected) {
      const handles = computeHandlePositions(box.x, box.y, box.width, box.height);
      for (const key of HANDLE_KEYS) {
        const p = handles[key];
        if (Math.abs(x - p.x) <= HANDLE_RADIUS && Math.abs(y - p.y) <= HANDLE_RADIUS) {
          return { zone: key, handle: key, pointIndex: -1 };
        }
      }
    }

    const HIT_RADIUS = 8 + this._lineWidth / 2;
    if (this._shapeType === "ellipse") {
      if (isPointInEllipse(x, y, box, HIT_RADIUS)) {
        return { zone: "body", pointIndex: -1 };
      }
    } else if (isPointInBox(x, y, box, HIT_RADIUS)) {
      return { zone: "body", pointIndex: -1 };
    }

    return null;
  }
}

export default ShapeDrawingPrimitive;
