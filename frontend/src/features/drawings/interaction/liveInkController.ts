import type { ScreenPoint } from "../drawingTypes.js";
import {
  clearDrawingOverlayCanvas,
  syncDrawingOverlayCanvas,
} from "./overlayCanvasSurface.js";
import type { DrawingOverlayPlotRect } from "./overlayCanvasSurface.js";

const LIVE_INK_CHUNK_SIZE = 256;

interface LiveInkChunk {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly breaks: Uint8Array;
}

export interface LiveInkStyle {
  readonly color: string;
  readonly lineWidth: number;
  readonly opacity: number;
  readonly tool: "pen" | "highlighter";
  readonly blendMode?: string;
  readonly brushShape?: "round" | "square";
}

export interface LiveInkPaintStamp {
  readonly scopeKey: string;
  readonly documentRevision: number;
  readonly surfaceGeneration: number;
  readonly viewportRevision?: number;
}

export type LiveInkPaintSubscriber = (
  listener: (stamp: LiveInkPaintStamp) => void,
) => () => void;

export interface LiveInkControllerOptions {
  readonly canvas: HTMLCanvasElement;
  readonly getPlotRect: () => DrawingOverlayPlotRect | null;
  readonly requestFrame?: (callback: () => void) => unknown;
  readonly cancelFrame?: (handle: unknown) => void;
}

export interface LiveInkControllerSnapshot {
  readonly active: boolean;
  readonly disposed: boolean;
  readonly retainingFinalFrame: boolean;
  readonly sampleCount: number;
  readonly chunkCount: number;
  readonly appendedSegmentCount: number;
  readonly historicalReplayCount: number;
  readonly clearCount: number;
}

export interface LiveInkController {
  start(style: LiveInkStyle, firstPoint: ScreenPoint): boolean;
  appendFrame(points: readonly (ScreenPoint | null)[]): number;
  finish(): boolean;
  retainUntilPaint(ticket: LiveInkPaintStamp, subscribe: LiveInkPaintSubscriber): void;
  refreshLayout(): boolean;
  cancel(): void;
  clear(): void;
  dispose(): void;
  snapshot(): LiveInkControllerSnapshot;
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

function finitePoint(point: ScreenPoint | null): point is ScreenPoint {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function exactPaintStamp(ticket: LiveInkPaintStamp, stamp: LiveInkPaintStamp): boolean {
  return ticket.scopeKey === stamp.scopeKey
    && ticket.documentRevision === stamp.documentRevision
    && ticket.surfaceGeneration === stamp.surfaceGeneration
    && (ticket.viewportRevision === undefined
      || ticket.viewportRevision === stamp.viewportRevision);
}

export function createLiveInkController({
  canvas,
  getPlotRect,
  requestFrame = defaultRequestFrame,
  cancelFrame = defaultCancelFrame,
}: LiveInkControllerOptions): LiveInkController {
  const chunks: LiveInkChunk[] = [];
  let sampleCount = 0;
  let style: LiveInkStyle | null = null;
  let active = false;
  let disposed = false;
  let retainingFinalFrame = false;
  let layoutKey: string | null = null;
  let context: CanvasRenderingContext2D | null = null;
  let rect: DrawingOverlayPlotRect | null = null;
  let appendedSegmentCount = 0;
  let historicalReplayCount = 0;
  let clearCount = 0;
  let paintUnsubscribe: (() => void) | null = null;
  let handoffFrame: unknown = null;
  let handoffGeneration = 0;

  const resetHandoff = () => {
    handoffGeneration += 1;
    paintUnsubscribe?.();
    paintUnsubscribe = null;
    if (handoffFrame !== null) cancelFrame(handoffFrame);
    handoffFrame = null;
    retainingFinalFrame = false;
  };

  const resetSamples = () => {
    chunks.length = 0;
    sampleCount = 0;
  };

  const appendSample = (point: ScreenPoint | null): number => {
    const index = sampleCount;
    const chunkIndex = Math.floor(index / LIVE_INK_CHUNK_SIZE);
    const offset = index % LIVE_INK_CHUNK_SIZE;
    let chunk = chunks[chunkIndex];
    if (!chunk) {
      chunk = {
        x: new Float64Array(LIVE_INK_CHUNK_SIZE),
        y: new Float64Array(LIVE_INK_CHUNK_SIZE),
        breaks: new Uint8Array(LIVE_INK_CHUNK_SIZE),
      };
      chunks.push(chunk);
    }
    if (finitePoint(point)) {
      chunk.x[offset] = point.x;
      chunk.y[offset] = point.y;
    } else {
      chunk.x[offset] = Number.NaN;
      chunk.y[offset] = Number.NaN;
      chunk.breaks[offset] = 1;
    }
    sampleCount += 1;
    return index;
  };

  const readSample = (index: number): ScreenPoint | null => {
    if (index < 0 || index >= sampleCount) return null;
    const chunk = chunks[Math.floor(index / LIVE_INK_CHUNK_SIZE)];
    const offset = index % LIVE_INK_CHUNK_SIZE;
    if (!chunk || chunk.breaks[offset] === 1) return null;
    const x = chunk.x[offset];
    const y = chunk.y[offset];
    return typeof x === "number"
      && typeof y === "number"
      && Number.isFinite(x)
      && Number.isFinite(y)
      ? { x, y }
      : null;
  };

  const configurePaint = (target: CanvasRenderingContext2D, current: LiveInkStyle) => {
    target.lineCap = current.brushShape === "square" ? "square" : "round";
    target.lineJoin = current.brushShape === "square" ? "bevel" : "round";
    target.lineWidth = current.lineWidth;
    target.strokeStyle = current.color;
    target.globalAlpha = 1;
    target.globalCompositeOperation = "source-over";
    canvas.style.opacity = String(current.tool === "highlighter" ? current.opacity : 1);
    canvas.style.mixBlendMode = current.blendMode ?? "normal";
  };

  const drawRange = (
    startIndex: number,
    endIndex: number,
    countAsAppend = true,
  ): number => {
    if (!context || !rect || !style || endIndex - startIndex < 1) return 0;
    let segments = 0;
    context.save();
    configurePaint(context, style);
    for (let index = Math.max(1, startIndex); index < endIndex; index += 1) {
      const previous = readSample(index - 1);
      const current = readSample(index);
      if (!previous || !current) continue;
      context.beginPath();
      context.moveTo(previous.x - rect.x, previous.y - rect.y);
      context.lineTo(current.x - rect.x, current.y - rect.y);
      context.stroke();
      segments += 1;
    }
    context.restore();
    if (countAsAppend) appendedSegmentCount += segments;
    return segments;
  };

  const ensureLayout = (): boolean => {
    const layout = syncDrawingOverlayCanvas(canvas, getPlotRect(), layoutKey);
    if (!layout) return false;
    const changed = layout.changed;
    layoutKey = layout.key;
    context = layout.context;
    rect = layout.rect;
    if (changed && sampleCount > 1 && style) {
      clearDrawingOverlayCanvas(canvas, context);
      drawRange(0, sampleCount, false);
      historicalReplayCount += 1;
    }
    return true;
  };

  const clear = () => {
    resetHandoff();
    clearDrawingOverlayCanvas(canvas, context ?? canvas.getContext("2d"));
    resetSamples();
    style = null;
    active = false;
    canvas.style.opacity = "1";
    canvas.style.mixBlendMode = "normal";
    clearCount += 1;
  };

  return {
    start(nextStyle, firstPoint) {
      if (disposed
        || !finitePoint(firstPoint)
        || !Number.isFinite(nextStyle.lineWidth)
        || nextStyle.lineWidth <= 0
        || !Number.isFinite(nextStyle.opacity)
        || nextStyle.opacity < 0
        || nextStyle.opacity > 1) return false;
      clear();
      style = Object.freeze({ ...nextStyle });
      active = true;
      if (!ensureLayout()) {
        clear();
        return false;
      }
      appendSample(firstPoint);
      configurePaint(context as CanvasRenderingContext2D, style);
      return true;
    },
    appendFrame(points) {
      if (disposed || !active || !style || points.length === 0) return 0;
      if (!ensureLayout()) {
        clear();
        return 0;
      }
      const startIndex = sampleCount;
      let appended = 0;
      for (const point of points) {
        appendSample(point);
        appended += 1;
      }
      drawRange(startIndex, sampleCount);
      // The enclosing interaction-frame measurement includes this synchronous
      // append. Recording it again would double-count and dilute per-rAF p95.
      return appended;
    },
    finish() {
      if (disposed || !active) return false;
      active = false;
      retainingFinalFrame = true;
      return true;
    },
    retainUntilPaint(ticket, subscribe) {
      if (disposed || !retainingFinalFrame) return;
      resetHandoff();
      retainingFinalFrame = true;
      const generation = handoffGeneration;
      paintUnsubscribe = subscribe((stamp) => {
        if (disposed
          || generation !== handoffGeneration
          || !exactPaintStamp(ticket, stamp)) return;
        paintUnsubscribe?.();
        paintUnsubscribe = null;
        handoffFrame = requestFrame(() => {
          handoffFrame = null;
          if (disposed || generation !== handoffGeneration) return;
          clear();
        });
      });
    },
    refreshLayout: ensureLayout,
    cancel: clear,
    clear,
    dispose() {
      if (disposed) return;
      clear();
      disposed = true;
      context = null;
      rect = null;
      layoutKey = null;
    },
    snapshot: () => Object.freeze({
      active,
      disposed,
      retainingFinalFrame,
      sampleCount,
      chunkCount: chunks.length,
      appendedSegmentCount,
      historicalReplayCount,
      clearCount,
    }),
  };
}
