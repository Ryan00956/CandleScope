import { accumulateDrawingPerfFrameWork } from "../performance/drawingPerfCounters.js";
import type {
  AxisLineType,
  BasicLineToolId,
  ScreenBox,
  ScreenPoint,
  ShapeType,
} from "../drawingTypes.js";
import {
  clearDrawingOverlayCanvas,
  syncDrawingOverlayCanvas,
} from "./overlayCanvasSurface.js";
import type { DrawingOverlayPlotRect } from "./overlayCanvasSurface.js";
import {
  drawDynamicPositionOverlayDecoration,
} from "./dynamicPositionOverlay.js";
import type {
  DynamicPositionOverlayDecoration,
} from "./dynamicPositionOverlay.js";

export type DynamicAngleOverlayDecoration = Readonly<{
  type: "angle";
  ray: readonly [ScreenPoint, ScreenPoint];
  baseline: readonly [ScreenPoint, ScreenPoint];
  arcPoints: readonly ScreenPoint[];
  label: Readonly<{
    center: ScreenPoint;
    text: string;
  }>;
  color: string;
  lineWidth: number;
  selected: boolean;
}>;

export type DynamicFibonacciLevelOverlay = Readonly<{
  color: string;
  line: readonly [ScreenPoint, ScreenPoint];
  label?: Readonly<{
    anchor: ScreenPoint;
    text: string;
  }>;
}>;

export type DynamicFibonacciOverlayDecoration = Readonly<{
  type: "fibonacci";
  trend: readonly [ScreenPoint, ScreenPoint];
  color: string;
  lineWidth: number;
  levels: readonly DynamicFibonacciLevelOverlay[];
  handles?: readonly ScreenPoint[];
}>;

export type DynamicOverlayDecoration =
  | Readonly<{
      type: "box";
      box: ScreenBox;
      color?: string;
      dashed?: boolean;
      handles?: readonly ScreenPoint[];
    }>
  | Readonly<{
      type: "line";
      from: ScreenPoint;
      to: ScreenPoint;
      color: string;
      lineWidth: number;
      dashed?: boolean;
      extension?: BasicLineToolId;
      handles?: readonly ScreenPoint[];
      label?: Readonly<{
        anchor: ScreenPoint;
        text: string;
      }>;
    }>
  | DynamicAngleOverlayDecoration
  | DynamicFibonacciOverlayDecoration
  | Readonly<{
      type: "axis-line";
      point: ScreenPoint;
      axisLineType: AxisLineType;
      color: string;
      lineWidth: number;
      handles?: readonly ScreenPoint[];
    }>
  | Readonly<{
      type: "shape";
      box: ScreenBox;
      shapeType: ShapeType;
      color: string;
      lineWidth: number;
      fillColor?: string;
      fillOpacity?: number;
      dashed?: boolean;
      handles?: readonly ScreenPoint[];
    }>
  | Readonly<{
      type: "handles";
      handles: readonly ScreenPoint[];
      color: string;
    }>
  | DynamicPositionOverlayDecoration
  | Readonly<{
      type: "cursor-ring";
      center: ScreenPoint;
      color: string;
      radius: number;
    }>;

export interface DynamicOverlayFrame {
  readonly decorations: readonly DynamicOverlayDecoration[];
}

export interface DynamicOverlayControllerOptions {
  readonly canvas: HTMLCanvasElement;
  readonly getPlotRect: () => DrawingOverlayPlotRect | null;
  readonly requestFrame?: (callback: () => void) => unknown;
  readonly cancelFrame?: (handle: unknown) => void;
  readonly now?: () => number;
}

export interface DynamicOverlayControllerSnapshot {
  readonly disposed: boolean;
  readonly pending: boolean;
  readonly paintCount: number;
  readonly decorationCount: number;
}

export interface DynamicOverlayController {
  render(frame: DynamicOverlayFrame): void;
  refreshLayout(): boolean;
  clear(): void;
  flush(): void;
  dispose(): void;
  snapshot(): DynamicOverlayControllerSnapshot;
}

function defaultRequestFrame(callback: () => void): unknown {
  return typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : setTimeout(callback, 0);
}

function defaultCancelFrame(handle: unknown): void {
  if (typeof cancelAnimationFrame === "function" && typeof handle === "number") {
    cancelAnimationFrame(handle);
  } else {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

function finitePoint(point: unknown): point is ScreenPoint {
  return !!point
    && typeof point === "object"
    && Number.isFinite((point as ScreenPoint).x)
    && Number.isFinite((point as ScreenPoint).y);
}

function finitePointPair(value: unknown): value is readonly [ScreenPoint, ScreenPoint] {
  return Array.isArray(value)
    && value.length === 2
    && finitePoint(value[0])
    && finitePoint(value[1]);
}

function freezePoint(point: ScreenPoint): ScreenPoint {
  return Object.freeze({ x: Number(point.x), y: Number(point.y) });
}

function shortestAngleDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function formatAngle(degrees: number): string {
  const rounded = degrees >= 10
    ? Math.round(degrees * 10) / 10
    : Math.round(degrees * 100) / 100;
  return `${rounded.toFixed(rounded % 1 === 0 ? 0 : 1)}°`;
}

/**
 * Build the complete CSS-pixel geometry for one dynamic angle overlay.
 * Raster scaling remains the canvas surface's responsibility.
 */
export function buildAngleDynamicOverlayDecoration(
  from: ScreenPoint,
  to: ScreenPoint,
  color: string,
  lineWidth: number,
  selected: boolean,
): DynamicAngleOverlayDecoration | null {
  if (!finitePoint(from)
    || !finitePoint(to)
    || typeof color !== "string"
    || color.trim().length === 0
    || !Number.isFinite(lineWidth)
    || lineWidth <= 0
    || typeof selected !== "boolean") return null;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance < 0.5) return null;

  const start = freezePoint(from);
  const end = freezePoint(to);
  const refDir = dx >= 0 ? 1 : -1;
  const refLen = Math.max(Math.abs(dx), Math.min(distance, 80), 32);
  const startAngle = refDir > 0 ? 0 : Math.PI;
  const delta = shortestAngleDelta(startAngle, Math.atan2(dy, dx));
  const radius = Math.min(Math.max(18, distance * 0.28), 54);
  const arcSegmentCount = Math.max(8, Math.ceil(Math.abs(delta) * 12));
  const arcPoints: ScreenPoint[] = [];
  for (let index = 0; index <= arcSegmentCount; index += 1) {
    const angle = startAngle + delta * (index / arcSegmentCount);
    arcPoints.push(freezePoint({
      x: start.x + Math.cos(angle) * radius,
      y: start.y + Math.sin(angle) * radius,
    }));
  }
  const labelAngle = startAngle + delta / 2;
  const labelRadius = radius + 16;
  const degrees = Math.abs(delta) * 180 / Math.PI;

  return Object.freeze({
    type: "angle" as const,
    ray: Object.freeze([start, end] as const),
    baseline: Object.freeze([
      start,
      freezePoint({ x: start.x + refDir * refLen, y: start.y }),
    ] as const),
    arcPoints: Object.freeze(arcPoints),
    label: Object.freeze({
      center: freezePoint({
        x: start.x + Math.cos(labelAngle) * labelRadius,
        y: start.y + Math.sin(labelAngle) * labelRadius,
      }),
      text: formatAngle(degrees),
    }),
    color,
    lineWidth,
    selected,
  });
}

function validAngleDecoration(
  item: DynamicAngleOverlayDecoration,
): boolean {
  return finitePointPair(item.ray)
    && finitePointPair(item.baseline)
    && Array.isArray(item.arcPoints)
    && item.arcPoints.length >= 2
    && item.arcPoints.every(finitePoint)
    && !!item.label
    && typeof item.label === "object"
    && finitePoint(item.label.center)
    && typeof item.label.text === "string"
    && item.label.text.length > 0
    && typeof item.color === "string"
    && item.color.trim().length > 0
    && Number.isFinite(item.lineWidth)
    && item.lineWidth > 0
    && typeof item.selected === "boolean";
}

function adjustAlpha(color: string, alpha: number): string {
  if (!color || color === "transparent") return "transparent";
  const normalizedAlpha = Math.max(0, Math.min(1, Number(alpha)));
  if (color.startsWith("rgba")) {
    const match = color.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
    if (match) {
      const baseAlpha = Math.max(0, Math.min(1, Number(match[4])));
      return `rgba(${match[1]},${match[2]},${match[3]},${baseAlpha * normalizedAlpha})`;
    }
  }
  if (color.startsWith("rgb")) {
    const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (match) return `rgba(${match[1]},${match[2]},${match[3]},${normalizedAlpha})`;
  }
  const channels = color.length === 4
    ? [color.charAt(1).repeat(2), color.charAt(2).repeat(2), color.charAt(3).repeat(2)]
    : color.length === 7
      ? [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)]
      : null;
  if (!channels) return color;
  const [red, green, blue] = channels.map((channel) => Number.parseInt(channel ?? "", 16));
  return [red, green, blue].every(Number.isFinite)
    ? `rgba(${red},${green},${blue},${normalizedAlpha})`
    : color;
}

function extendDynamicLine(
  from: ScreenPoint,
  to: ScreenPoint,
  extension: BasicLineToolId | undefined,
  rect: DrawingOverlayPlotRect,
): readonly [ScreenPoint, ScreenPoint] {
  if (!extension || extension === "line-segment") return [from, to];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance <= Number.EPSILON) return [from, to];
  const length = Math.hypot(rect.width, rect.height) * 2;
  const ux = dx / distance;
  const uy = dy / distance;
  if (extension === "line-ray") {
    return [from, { x: from.x + ux * length, y: from.y + uy * length }];
  }
  return [
    { x: from.x - ux * length, y: from.y - uy * length },
    { x: from.x + ux * length, y: from.y + uy * length },
  ];
}

function fallbackAngleLabelWidth(text: string): number {
  return [...text].reduce((width, character) => (
    width + (character.charCodeAt(0) > 0xff ? 11 : 11 * 0.62)
  ), 0);
}

function drawDynamicAngleDecoration(
  context: CanvasRenderingContext2D,
  item: DynamicAngleOverlayDecoration,
  rect: DrawingOverlayPlotRect,
): void {
  if (!validAngleDecoration(item)) return;
  const localPoint = (point: ScreenPoint): ScreenPoint => ({
    x: point.x - rect.x,
    y: point.y - rect.y,
  });
  const ray = item.ray.map(localPoint) as unknown as readonly [ScreenPoint, ScreenPoint];
  const baseline = item.baseline.map(localPoint) as unknown as readonly [ScreenPoint, ScreenPoint];
  const arcPoints = item.arcPoints.map(localPoint);
  const labelCenter = localPoint(item.label.center);
  const firstArcPoint = arcPoints[0];
  if (!firstArcPoint) return;

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";

  if (item.selected) {
    context.strokeStyle = adjustAlpha(item.color, 0.18);
    context.lineWidth = Math.max(item.lineWidth + 10, 12);
    context.beginPath();
    context.moveTo(ray[0].x, ray[0].y);
    context.lineTo(ray[1].x, ray[1].y);
    context.stroke();
  }

  context.strokeStyle = item.color;
  context.lineWidth = item.lineWidth;
  context.beginPath();
  context.moveTo(ray[0].x, ray[0].y);
  context.lineTo(ray[1].x, ray[1].y);
  context.stroke();

  context.save();
  context.globalAlpha = 0.65;
  context.setLineDash([4, 4]);
  context.beginPath();
  context.moveTo(baseline[0].x, baseline[0].y);
  context.lineTo(baseline[1].x, baseline[1].y);
  context.stroke();
  context.restore();

  context.setLineDash([]);
  context.globalAlpha = 1;
  context.strokeStyle = item.color;
  context.lineWidth = Math.max(1.5, item.lineWidth * 0.85);
  context.beginPath();
  context.moveTo(firstArcPoint.x, firstArcPoint.y);
  for (let index = 1; index < arcPoints.length; index += 1) {
    const point = arcPoints[index];
    if (point) context.lineTo(point.x, point.y);
  }
  context.stroke();

  context.font = "600 11px sans-serif";
  context.textBaseline = "middle";
  context.textAlign = "center";
  let labelTextWidth = fallbackAngleLabelWidth(item.label.text);
  try {
    const measuredWidth = context.measureText(item.label.text).width;
    if (Number.isFinite(measuredWidth) && measuredWidth >= 0) labelTextWidth = measuredWidth;
  } catch {
    // The same deterministic fallback used by scene projection keeps drafts paintable.
  }
  const boxWidth = labelTextWidth + 10;
  const boxHeight = 17;
  const boxLeft = labelCenter.x - boxWidth / 2;
  const boxTop = labelCenter.y - boxHeight / 2;
  context.fillStyle = "rgba(15, 23, 42, 0.86)";
  context.strokeStyle = adjustAlpha(item.color, 0.55);
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(boxLeft, boxTop, boxWidth, boxHeight, 4);
  context.fill();
  context.stroke();
  context.fillStyle = item.color;
  context.fillText(item.label.text, labelCenter.x, labelCenter.y + 0.5);

  const handleRadius = item.selected ? 6 : 3.5;
  context.fillStyle = item.selected ? "#ffffff" : adjustAlpha(item.color, 0.5);
  context.strokeStyle = item.color;
  context.lineWidth = item.selected ? 2 : 1.25;
  context.shadowColor = "rgba(0,0,0,0.3)";
  context.shadowBlur = item.selected ? 4 * rect.dpr : 0;
  for (const point of ray) {
    context.beginPath();
    context.arc(point.x, point.y, handleRadius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
  context.shadowBlur = 0;
  context.restore();
}

function validFibonacciDecoration(item: DynamicFibonacciOverlayDecoration): boolean {
  return finitePointPair(item.trend)
    && typeof item.color === "string"
    && item.color.trim().length > 0
    && Number.isFinite(item.lineWidth)
    && item.lineWidth > 0
    && item.levels.every((level) => (
      !!level
      && typeof level.color === "string"
      && level.color.trim().length > 0
      && finitePointPair(level.line)
      && (level.label === undefined || (
        !!level.label
        && finitePoint(level.label.anchor)
        && typeof level.label.text === "string"
        && level.label.text.length > 0
      ))
    ));
}

/** Paint a complete Fibonacci draft, including the legacy 10% level bands. */
function drawDynamicFibonacciDecoration(
  context: CanvasRenderingContext2D,
  item: DynamicFibonacciOverlayDecoration,
  rect: DrawingOverlayPlotRect,
): void {
  if (!validFibonacciDecoration(item)) return;
  const localPoint = (point: ScreenPoint): ScreenPoint => ({
    x: point.x - rect.x,
    y: point.y - rect.y,
  });
  const trend = item.trend.map(localPoint) as unknown as readonly [ScreenPoint, ScreenPoint];
  const levels = item.levels.map((level) => {
    const line = level.line.map(localPoint) as unknown as readonly [ScreenPoint, ScreenPoint];
    return {
      ...level,
      line,
      y: (line[0].y + line[1].y) / 2,
      ...(level.label
        ? { label: { ...level.label, anchor: localPoint(level.label.anchor) } }
        : {}),
    };
  }).sort((left, right) => left.y - right.y);
  const minX = Math.min(trend[0].x, trend[1].x);
  const maxX = Math.max(trend[0].x, trend[1].x);

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = item.color;
  context.lineWidth = item.lineWidth;
  context.setLineDash([6, 4]);
  context.beginPath();
  context.moveTo(trend[0].x, trend[0].y);
  context.lineTo(trend[1].x, trend[1].y);
  context.stroke();
  context.setLineDash([]);

  context.globalAlpha = 0.1;
  for (let index = 0; index < levels.length - 1; index += 1) {
    const first = levels[index];
    const second = levels[index + 1];
    if (!first || !second) continue;
    context.fillStyle = second.color;
    context.fillRect(minX, first.y, maxX - minX, second.y - first.y);
  }
  context.globalAlpha = 1;

  context.font = "11px sans-serif";
  context.textAlign = "left";
  context.textBaseline = "bottom";
  for (const level of levels) {
    context.strokeStyle = level.color;
    context.fillStyle = level.color;
    context.lineWidth = item.lineWidth;
    context.beginPath();
    context.moveTo(level.line[0].x, level.line[0].y);
    context.lineTo(level.line[1].x, level.line[1].y);
    context.stroke();
    if (level.label) {
      context.fillText(level.label.text, level.label.anchor.x, level.label.anchor.y);
    }
  }
  context.restore();
}

export function createDynamicOverlayController({
  canvas,
  getPlotRect,
  requestFrame = defaultRequestFrame,
  cancelFrame = defaultCancelFrame,
  now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
}: DynamicOverlayControllerOptions): DynamicOverlayController {
  let disposed = false;
  let pendingFrame: DynamicOverlayFrame | null = null;
  let frameHandle: unknown = null;
  let layoutKey: string | null = null;
  let context: CanvasRenderingContext2D | null = null;
  let paintCount = 0;
  let decorationCount = 0;

  const clear = () => {
    pendingFrame = null;
    clearDrawingOverlayCanvas(canvas, context ?? canvas.getContext("2d"));
    decorationCount = 0;
  };

  const drawHandle = (
    target: CanvasRenderingContext2D,
    point: ScreenPoint,
    rect: DrawingOverlayPlotRect,
    color: string,
  ) => {
    if (!finitePoint(point)) return;
    target.beginPath();
    target.arc(point.x - rect.x, point.y - rect.y, 4.5, 0, Math.PI * 2);
    target.fillStyle = "#ffffff";
    target.fill();
    target.lineWidth = 1.5;
    target.strokeStyle = color;
    target.stroke();
  };

  const refreshLayout = (): boolean => {
    if (disposed) return false;
    const layout = syncDrawingOverlayCanvas(canvas, getPlotRect(), layoutKey);
    if (!layout) {
      clear();
      layoutKey = null;
      context = null;
      return false;
    }
    layoutKey = layout.key;
    context = layout.context;
    // Setting a canvas bitmap size clears its pixels, so a real plot-layout
    // change already retires the old frame. When the layout is unchanged,
    // preserve the current interaction frame: selection state can re-render
    // while a committed draft is waiting for its exact scene-paint ack, and a
    // redundant refresh must not create a blank handoff frame.
    if (layout.changed) clearDrawingOverlayCanvas(canvas, context);
    return true;
  };

  const paintPendingFrame = () => {
    frameHandle = null;
    const frame = pendingFrame;
    pendingFrame = null;
    if (disposed || !frame) return;
    const startedAt = now();
    const layout = syncDrawingOverlayCanvas(canvas, getPlotRect(), layoutKey);
    if (!layout) {
      clear();
      return;
    }
    layoutKey = layout.key;
    context = layout.context;
    clearDrawingOverlayCanvas(canvas, context);
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const item of frame.decorations) {
      if (item.type === "box") {
        const { box } = item;
        if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) continue;
        context.strokeStyle = item.color ?? "#3b82f6";
        context.lineWidth = 1;
        context.setLineDash(item.dashed === false ? [] : [4, 3]);
        context.strokeRect(
          box.x - layout.rect.x,
          box.y - layout.rect.y,
          box.width,
          box.height,
        );
        context.setLineDash([]);
        for (const handle of item.handles ?? []) {
          drawHandle(context, handle, layout.rect, item.color ?? "#3b82f6");
        }
      } else if (item.type === "handles") {
        for (const handle of item.handles) {
          drawHandle(context, handle, layout.rect, item.color);
        }
      } else if (item.type === "line") {
        if (!finitePoint(item.from) || !finitePoint(item.to)) continue;
        const [from, to] = extendDynamicLine(
          item.from,
          item.to,
          item.extension,
          layout.rect,
        );
        context.strokeStyle = item.color;
        context.lineWidth = item.lineWidth;
        context.setLineDash(item.dashed ? [6, 4] : []);
        context.beginPath();
        context.moveTo(from.x - layout.rect.x, from.y - layout.rect.y);
        context.lineTo(to.x - layout.rect.x, to.y - layout.rect.y);
        context.stroke();
        context.setLineDash([]);
        if (item.label
          && finitePoint(item.label.anchor)
          && typeof item.label.text === "string"
          && item.label.text.length > 0) {
          context.fillStyle = item.color;
          context.font = "11px sans-serif";
          context.textAlign = "left";
          context.textBaseline = "bottom";
          context.fillText(
            item.label.text,
            item.label.anchor.x - layout.rect.x,
            item.label.anchor.y - layout.rect.y,
          );
        }
        for (const handle of item.handles ?? []) {
          drawHandle(context, handle, layout.rect, item.color);
        }
      } else if (item.type === "angle") {
        drawDynamicAngleDecoration(context, item, layout.rect);
      } else if (item.type === "fibonacci") {
        drawDynamicFibonacciDecoration(context, item, layout.rect);
        for (const handle of item.handles ?? []) {
          drawHandle(context, handle, layout.rect, item.color);
        }
      } else if (item.type === "axis-line") {
        if (!finitePoint(item.point)) continue;
        const x = item.point.x - layout.rect.x;
        const y = item.point.y - layout.rect.y;
        context.strokeStyle = item.color;
        context.lineWidth = item.lineWidth;
        context.beginPath();
        if (item.axisLineType === "horizontal" || item.axisLineType === "cross") {
          context.moveTo(0, y);
          context.lineTo(layout.rect.width, y);
        }
        if (item.axisLineType === "vertical" || item.axisLineType === "cross") {
          context.moveTo(x, 0);
          context.lineTo(x, layout.rect.height);
        }
        context.stroke();
        for (const handle of item.handles ?? [item.point]) {
          drawHandle(context, handle, layout.rect, item.color);
        }
      } else if (item.type === "shape") {
        const { box } = item;
        if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) continue;
        const x = box.x - layout.rect.x;
        const y = box.y - layout.rect.y;
        context.save();
        context.strokeStyle = item.color;
        context.lineWidth = item.lineWidth;
        context.setLineDash(item.dashed ? [6, 4] : []);
        if (item.fillColor && (item.fillOpacity ?? 0) > 0) {
          context.fillStyle = item.fillColor;
          context.globalAlpha = Math.max(0, Math.min(1, item.fillOpacity ?? 0));
          if (item.shapeType === "ellipse") {
            context.beginPath();
            context.ellipse(
              x + box.width / 2,
              y + box.height / 2,
              Math.abs(box.width / 2),
              Math.abs(box.height / 2),
              0,
              0,
              Math.PI * 2,
            );
            context.fill();
          } else {
            context.fillRect(x, y, box.width, box.height);
          }
          context.globalAlpha = 1;
        }
        if (item.shapeType === "ellipse") {
          context.beginPath();
          context.ellipse(
            x + box.width / 2,
            y + box.height / 2,
            Math.abs(box.width / 2),
            Math.abs(box.height / 2),
            0,
            0,
            Math.PI * 2,
          );
          context.stroke();
        } else {
          context.strokeRect(x, y, box.width, box.height);
        }
        context.restore();
        for (const handle of item.handles ?? []) {
          drawHandle(context, handle, layout.rect, item.color);
        }
      } else if (item.type === "position") {
        drawDynamicPositionOverlayDecoration(context, item, layout.rect);
      } else if (finitePoint(item.center)) {
        context.beginPath();
        context.arc(
          item.center.x - layout.rect.x,
          item.center.y - layout.rect.y,
          item.radius,
          0,
          Math.PI * 2,
        );
        context.strokeStyle = item.color;
        context.lineWidth = 2;
        context.stroke();
      }
    }
    context.restore();
    paintCount += 1;
    decorationCount = frame.decorations.length;
    const durationMs = Math.max(0, now() - startedAt);
    accumulateDrawingPerfFrameWork({
      activeOverlayCpuMs: durationMs,
      drawingMainThreadMs: durationMs,
    });
  };

  const flush = () => {
    if (frameHandle !== null) {
      cancelFrame(frameHandle);
      frameHandle = null;
    }
    paintPendingFrame();
  };

  return {
    render(frame) {
      if (disposed) return;
      pendingFrame = frame;
      if (frameHandle !== null) return;
      frameHandle = requestFrame(paintPendingFrame);
    },
    refreshLayout,
    clear() {
      if (frameHandle !== null) {
        cancelFrame(frameHandle);
        frameHandle = null;
      }
      clear();
    },
    flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frameHandle !== null) cancelFrame(frameHandle);
      frameHandle = null;
      clear();
      layoutKey = null;
      context = null;
    },
    snapshot: () => Object.freeze({
      disposed,
      pending: frameHandle !== null,
      paintCount,
      decorationCount,
    }),
  };
}
