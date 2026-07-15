/**
 * AngleMeasurementPrimitive — visual angle measurement tool.
 *
 * Two anchors define the measured direction. The first point is the vertex;
 * the second point defines the measured ray. A dashed horizontal baseline,
 * angle arc, and degree label are rendered in screen space.
 */

import { drawingDataPointsToCoordinates } from "./coordinateUtils.js";
import type {
  AnglePrimitiveOptions,
  DrawingAttachedParameter,
  DrawingDataPoint,
  DrawingHit,
  PrimitiveCanvasTarget,
  PrimitivePaneRenderer,
  PrimitivePaneView,
  ScreenBox,
  ScreenPoint,
} from "../drawingTypes.js";

interface AngleGeometry {
  refDir: number;
  refLen: number;
  startAngle: number;
  delta: number;
  radius: number;
  degrees: number;
  labelAngle: number;
  labelX: number;
  labelY: number;
}

interface AngleRenderPoint {
  x: number | null;
  y: number | null;
}

interface AngleRenderData {
  points: AngleRenderPoint[];
  color: string;
  lineWidth: number;
  selected: boolean;
  hovered: boolean;
  isPreview: boolean;
  hidden: boolean;
  setLabelBox: (box: ScreenBox | null) => void;
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

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  return Math.hypot(px - projX, py - projY);
}

function shortestAngleDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function formatAngle(degrees: number): string {
  if (!Number.isFinite(degrees)) return "--°";
  const rounded = degrees >= 10 ? Math.round(degrees * 10) / 10 : Math.round(degrees * 100) / 100;
  return `${rounded.toFixed(rounded % 1 === 0 ? 0 : 1)}°`;
}

function angleBetweenIsWithin(pointAngle: number, startAngle: number, delta: number): boolean {
  const pointDelta = shortestAngleDelta(startAngle, pointAngle);
  if (delta >= 0) return pointDelta >= -0.08 && pointDelta <= delta + 0.08;
  return pointDelta <= 0.08 && pointDelta >= delta - 0.08;
}

function computeGeometry(a: ScreenPoint, b: ScreenPoint): AngleGeometry | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.5) return null;

  const refDir = dx >= 0 ? 1 : -1;
  const refLen = Math.max(Math.abs(dx), Math.min(distance, 80), 32);
  const startAngle = refDir > 0 ? 0 : Math.PI;
  const lineAngle = Math.atan2(dy, dx);
  const delta = shortestAngleDelta(startAngle, lineAngle);
  const radius = Math.min(Math.max(18, distance * 0.28), 54);
  const degrees = Math.abs(delta) * 180 / Math.PI;
  const labelAngle = startAngle + delta / 2;
  const labelRadius = radius + 16;

  return {
    refDir,
    refLen,
    startAngle,
    delta,
    radius,
    degrees,
    labelAngle,
    labelX: a.x + Math.cos(labelAngle) * labelRadius,
    labelY: a.y + Math.sin(labelAngle) * labelRadius,
  };
}

class AngleRenderer implements PrimitivePaneRenderer {
  _data: AngleRenderData | null;

  constructor() {
    this._data = null;
  }

  update(data: AngleRenderData): void {
    this._data = data;
  }

  draw(target: PrimitiveCanvasTarget): void {
    const data = this._data;
    if (!data || data.hidden || !data.points || data.points.length < 2) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hRatio = scope.horizontalPixelRatio;
      const vRatio = scope.verticalPixelRatio;
      const minRatio = Math.min(hRatio, vRatio);
      const { points, color, lineWidth, selected, hovered, isPreview, setLabelBox } = data;

      const [a, b] = points;
      if (!a || !b || !isFiniteCoord(a.x) || !isFiniteCoord(a.y) || !isFiniteCoord(b.x) || !isFiniteCoord(b.y)) {
        setLabelBox?.(null);
        return;
      }

      // Geometry is defined in CSS pixels, exactly like hit testing and the
      // scene projector. Only rasterization is scaled to bitmap coordinates.
      // This keeps the visible arc/label invariant across DPR values.
      const cssA = { x: Number(a.x), y: Number(a.y) };
      const cssB = { x: Number(b.x), y: Number(b.y) };
      const geometry = computeGeometry(cssA, cssB);
      if (!geometry) {
        setLabelBox?.(null);
        return;
      }
      const sa = { x: cssA.x * hRatio, y: cssA.y * vRatio };
      const sb = { x: cssB.x * hRatio, y: cssB.y * vRatio };

      const scaledWidth = lineWidth * minRatio;
      const text = formatAngle(geometry.degrees);

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      if (selected || hovered) {
        ctx.strokeStyle = adjustAlpha(color, selected ? 0.18 : 0.14);
        ctx.lineWidth = Math.max(scaledWidth + 10 * minRatio, 12 * minRatio);
        ctx.beginPath();
        ctx.moveTo(sa.x, sa.y);
        ctx.lineTo(sb.x, sb.y);
        ctx.stroke();
      }

      ctx.strokeStyle = hovered && !selected ? adjustAlpha(color, 0.85) : color;
      ctx.lineWidth = scaledWidth;

      if (isPreview) {
        ctx.setLineDash([6 * hRatio, 4 * hRatio]);
        ctx.globalAlpha = 0.78;
      }

      // Main measurement ray.
      ctx.beginPath();
      ctx.moveTo(sa.x, sa.y);
      ctx.lineTo(sb.x, sb.y);
      ctx.stroke();

      // Horizontal baseline.
      ctx.save();
      ctx.globalAlpha = isPreview ? 0.55 : 0.65;
      ctx.setLineDash([4 * hRatio, 4 * hRatio]);
      ctx.beginPath();
      ctx.moveTo(sa.x, sa.y);
      ctx.lineTo(sa.x + geometry.refDir * geometry.refLen * hRatio, sa.y);
      ctx.stroke();
      ctx.restore();

      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // Angle arc.
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5 * minRatio, scaledWidth * 0.85);
      ctx.beginPath();
      ctx.ellipse(
        sa.x,
        sa.y,
        geometry.radius * hRatio,
        geometry.radius * vRatio,
        0,
        geometry.startAngle,
        geometry.startAngle + geometry.delta,
        geometry.delta < 0,
      );
      ctx.stroke();

      // Label.
      const fontSize = 11 * minRatio;
      const padX = 5 * hRatio;
      const padY = 3 * vRatio;
      ctx.font = `600 ${fontSize}px sans-serif`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      const textWidth = ctx.measureText(text).width;
      const boxW = textWidth + padX * 2;
      const boxH = fontSize + padY * 2;
      const labelX = geometry.labelX * hRatio;
      const labelY = geometry.labelY * vRatio;
      const boxX = labelX - boxW / 2;
      const boxY = labelY - boxH / 2;

      ctx.fillStyle = "rgba(15, 23, 42, 0.86)";
      ctx.strokeStyle = adjustAlpha(color, 0.55);
      ctx.lineWidth = 1 * minRatio;
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxW, boxH, 4 * minRatio);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillText(text, labelX, labelY + 0.5 * vRatio);

      setLabelBox?.({
        x: boxX / hRatio,
        y: boxY / vRatio,
        width: boxW / hRatio,
        height: boxH / vRatio,
      });

      // Anchor dots / handles.
      const handleR = (selected ? 6 : 3.5) * minRatio;
      const handleLineW = (selected ? 2 : 1.25) * minRatio;
      ctx.fillStyle = selected ? "#ffffff" : adjustAlpha(color, 0.5);
      ctx.strokeStyle = color;
      ctx.lineWidth = handleLineW;
      ctx.shadowColor = "rgba(0,0,0,0.3)";
      ctx.shadowBlur = selected ? 4 * minRatio : 0;
      for (const p of [sa, sb]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, handleR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.shadowBlur = 0;

      ctx.restore();
    });
  }
}

class AnglePaneView implements PrimitivePaneView {
  _source: AngleMeasurementPrimitive;
  _renderer: AngleRenderer;

  constructor(source: AngleMeasurementPrimitive) {
    this._source = source;
    this._renderer = new AngleRenderer();
  }

  update(): void {
    const source = this._source;
    const series = source._series;
    const chart = source._chart;
    if (!series || !chart) return;
    source._parityLabelBox = null;
    if (source._hidden) {
      source._labelBox = null;
      this._renderer.update({
        points: [],
        color: source._color,
        lineWidth: source._lineWidth,
        selected: source._selected,
        hovered: source._hovered,
        isPreview: source._isPreview,
        hidden: true,
        setLabelBox: (box: ScreenBox | null) => {
          source._labelBox = box;
          source._parityLabelBox = box;
        },
      });
      return;
    }

    const points: AngleRenderPoint[] = [];
    const coordinateContext = {};

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
    }

    this._renderer.update({
      points,
      color: source._color,
      lineWidth: source._lineWidth,
      selected: source._selected,
      hovered: source._hovered,
      isPreview: source._isPreview,
      hidden: source._hidden,
      setLabelBox: (box: ScreenBox | null) => {
        source._labelBox = box;
        source._parityLabelBox = box;
      },
    });
  }

  renderer(): AngleRenderer {
    return this._renderer;
  }

  zOrder(): "top" {
    return "top";
  }
}

export class AngleMeasurementPrimitive {
  _id: string;
  _type: "angle-measure";
  _dataPoints: DrawingDataPoint[];
  _color: string;
  _lineWidth: number;
  _selected: boolean;
  _hovered: boolean;
  _isPreview: boolean;
  _hidden: boolean;
  _geometryRevision: number;
  _labelBox: ScreenBox | null;
  _parityLabelBox: ScreenBox | null;
  _series: DrawingAttachedParameter["series"] | null;
  _chart: DrawingAttachedParameter["chart"] | null;
  _paneView: AnglePaneView;
  _requestUpdate: (() => void) | null;

  constructor(opts: AnglePrimitiveOptions) {
    this._id = opts.id;
    this._type = "angle-measure";
    this._dataPoints = opts.dataPoints || [];
    this._color = opts.color || "#f59e0b";
    this._lineWidth = opts.lineWidth || 2;
    this._selected = !!opts.selected;
    this._hovered = !!opts.hovered;
    this._isPreview = !!opts.isPreview;
    this._hidden = !!opts.hidden;
    this._geometryRevision = 1;
    this._labelBox = null;
    this._parityLabelBox = null;

    this._series = null;
    this._chart = null;
    this._paneView = new AnglePaneView(this);
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
  get dataPoints() { return this._dataPoints; }
  get color() { return this._color; }
  get lineWidth() { return this._lineWidth; }
  get selected() { return this._selected; }
  get geometryRevision() { return this._geometryRevision; }
  getParityLabelBox(): Readonly<ScreenBox> | null {
    return this._parityLabelBox ? Object.freeze({ ...this._parityLabelBox }) : null;
  }

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

  _screenPoints(): ScreenPoint[] | null {
    if (!this._series || !this._chart || this._dataPoints.length < 2) return null;
    const points = [];
    const coordinateContext = {};
    const horizontalCoordinates = drawingDataPointsToCoordinates(
      this._chart,
      this._series,
      this._dataPoints,
      coordinateContext,
      { cacheToken: this, geometryRevision: this._geometryRevision },
    );

    for (const [index, dp] of this._dataPoints.entries()) {
      const x = horizontalCoordinates[index] ?? null;
      const y = this._series.priceToCoordinate(dp.price);
      if (!isFiniteCoord(x) || !isFiniteCoord(y)) return null;
      points.push({ x, y });
    }

    return points;
  }

  hitTestGeometry(x: number, y: number): DrawingHit | null {
    if (this._hidden) return null;

    if (this._labelBox) {
      const b = this._labelBox;
      if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) {
        return { pointIndex: -1, zone: "label" };
      }
    }

    const points = this._screenPoints();
    if (!points || points.length < 2) return null;
    const [a, b] = points;
    if (!a || !b) return null;

    const HANDLE_RADIUS = 7 + this._lineWidth;
    const LINE_HIT_RADIUS = 8 + this._lineWidth / 2;

    for (let i = 0; i < 2; i++) {
      const pt = i === 0 ? a : b;
      if (Math.hypot(pt.x - x, pt.y - y) <= HANDLE_RADIUS) {
        return { pointIndex: i, zone: i === 0 ? "vertex" : "ray" };
      }
    }

    if (distToSegment(x, y, a.x, a.y, b.x, b.y) <= LINE_HIT_RADIUS) {
      return { pointIndex: -1, zone: "line" };
    }

    const geometry = computeGeometry(a, b);
    if (!geometry) return null;
    const refEndX = a.x + geometry.refDir * geometry.refLen;
    if (distToSegment(x, y, a.x, a.y, refEndX, a.y) <= LINE_HIT_RADIUS) {
      return { pointIndex: -1, zone: "baseline" };
    }

    const dx = x - a.x;
    const dy = y - a.y;
    const dist = Math.hypot(dx, dy);
    const pointAngle = Math.atan2(dy, dx);
    if (
      Math.abs(dist - geometry.radius) <= LINE_HIT_RADIUS &&
      angleBetweenIsWithin(pointAngle, geometry.startAngle, geometry.delta)
    ) {
      return { pointIndex: -1, zone: "arc" };
    }

    return null;
  }
}

export default AngleMeasurementPrimitive;
