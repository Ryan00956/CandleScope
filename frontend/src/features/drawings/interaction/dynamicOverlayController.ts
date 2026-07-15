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
    }>
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

function finitePoint(point: ScreenPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
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

  const flush = () => {
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

  return {
    render(frame) {
      if (disposed) return;
      pendingFrame = frame;
      if (frameHandle !== null) return;
      frameHandle = requestFrame(flush);
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
