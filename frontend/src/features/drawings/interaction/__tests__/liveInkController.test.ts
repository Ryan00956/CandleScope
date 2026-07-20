import assert from "node:assert/strict";
import test from "node:test";

import { createLiveInkController } from "../liveInkController.js";

interface ContextLog {
  clears: number;
  lineTos: Array<readonly [number, number]>;
  moveTos: Array<readonly [number, number]>;
  strokes: number;
}

function canvasFixture() {
  const log: ContextLog = { clears: 0, lineTos: [], moveTos: [], strokes: 0 };
  const context = {
    lineCap: "butt",
    lineJoin: "miter",
    lineWidth: 1,
    strokeStyle: "#000",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    save() {},
    restore() {},
    setTransform() {},
    clearRect() { log.clears += 1; },
    beginPath() {},
    moveTo(x: number, y: number) { log.moveTos.push([x, y]); },
    lineTo(x: number, y: number) { log.lineTos.push([x, y]); },
    stroke() { log.strokes += 1; },
  } as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  return { canvas, context, log };
}

const rect = Object.freeze({ x: 40, y: 5, width: 300, height: 180, dpr: 2 });

test("live ink owns an exact DPR plot canvas and appends only new segments", () => {
  const { canvas, log } = canvasFixture();
  const controller = createLiveInkController({ canvas, getPlotRect: () => rect });
  assert.equal(controller.start({
    tool: "pen",
    color: "#f59e0b",
    lineWidth: 2,
    opacity: 1,
  }, { x: 50, y: 15 }), true);
  assert.equal(canvas.width, 600);
  assert.equal(canvas.height, 360);
  assert.equal(canvas.style.left, "40px");
  assert.equal(canvas.style.top, "5px");

  assert.equal(controller.appendFrame([{ x: 60, y: 25 }, { x: 70, y: 35 }]), 2);
  assert.deepEqual(log.moveTos, [[10, 10], [20, 20]]);
  assert.deepEqual(log.lineTos, [[20, 20], [30, 30]]);
  assert.equal(controller.appendFrame([{ x: 80, y: 45 }]), 1);
  assert.deepEqual(log.moveTos.at(-1), [30, 30]);
  assert.deepEqual(log.lineTos.at(-1), [40, 40]);
  assert.equal(controller.snapshot().appendedSegmentCount, 3);
  assert.equal(controller.snapshot().historicalReplayCount, 0);
});

test("4096 live samples grow in fixed typed chunks without historical redraw", () => {
  const { canvas, log } = canvasFixture();
  const controller = createLiveInkController({ canvas, getPlotRect: () => rect });
  assert.equal(controller.start({
    tool: "pen",
    color: "#fff",
    lineWidth: 1,
    opacity: 1,
  }, { x: 41, y: 6 }), true);
  const points = Array.from({ length: 4095 }, (_, index) => ({
    x: 42 + index * 0.01,
    y: 7 + index * 0.01,
  }));
  controller.appendFrame(points);
  assert.equal(controller.snapshot().sampleCount, 4096);
  assert.equal(controller.snapshot().chunkCount, 16);
  assert.equal(controller.snapshot().appendedSegmentCount, 4095);
  assert.equal(controller.snapshot().historicalReplayCount, 0);
  assert.equal(log.strokes, 4095);
});

test("highlighter applies opacity once to its whole dedicated canvas", () => {
  const { canvas, context } = canvasFixture();
  const controller = createLiveInkController({ canvas, getPlotRect: () => rect });
  assert.equal(controller.start({
    tool: "highlighter",
    color: "#fde047",
    lineWidth: 16,
    opacity: 0.28,
    blendMode: "multiply",
  }, { x: 50, y: 20 }), true);
  controller.appendFrame([
    { x: 80, y: 20 },
    { x: 50, y: 20 },
  ]);
  assert.equal(canvas.style.opacity, "0.28");
  assert.equal(canvas.style.mixBlendMode, "multiply");
  assert.equal(context.globalAlpha, 1);
  assert.equal(context.globalCompositeOperation, "source-over");
});

test("final ink survives stale paint and clears atomically on a covering viewport paint", () => {
  const { canvas } = canvasFixture();
  const listeners = new Set<(stamp: {
    scopeKey: string;
    documentRevision: number;
    surfaceGeneration: number;
    viewportRevision: number;
  }) => void>();
  const controller = createLiveInkController({
    canvas,
    getPlotRect: () => rect,
  });
  controller.start({ tool: "pen", color: "#fff", lineWidth: 2, opacity: 1 }, { x: 50, y: 20 });
  controller.appendFrame([{ x: 60, y: 30 }]);
  assert.equal(controller.finish(), true);
  controller.retainUntilPaint(
    { scopeKey: "BTC", documentRevision: 7, surfaceGeneration: 3, viewportRevision: 11 },
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  );

  for (const listener of listeners) {
    listener({ scopeKey: "BTC", documentRevision: 6, surfaceGeneration: 3, viewportRevision: 12 });
  }
  assert.equal(controller.snapshot().sampleCount, 2);
  for (const listener of listeners) {
    listener({ scopeKey: "ETH", documentRevision: 8, surfaceGeneration: 3, viewportRevision: 12 });
    listener({ scopeKey: "BTC", documentRevision: 8, surfaceGeneration: 4, viewportRevision: 12 });
  }
  assert.equal(controller.snapshot().sampleCount, 2);
  for (const listener of listeners) {
    listener({ scopeKey: "BTC", documentRevision: 7, surfaceGeneration: 3, viewportRevision: 12 });
  }
  assert.equal(controller.snapshot().sampleCount, 0);
  assert.equal(controller.snapshot().retainingFinalFrame, false);
});

test("a synchronously replayed covering paint clears ink and disposes its listener", () => {
  const { canvas } = canvasFixture();
  const controller = createLiveInkController({ canvas, getPlotRect: () => rect });
  const ticket = {
    scopeKey: "BTC",
    documentRevision: 7,
    surfaceGeneration: 3,
    viewportRevision: 11,
  };
  let disposeCount = 0;
  controller.start({ tool: "pen", color: "#fff", lineWidth: 2, opacity: 1 }, { x: 50, y: 20 });
  controller.appendFrame([{ x: 60, y: 30 }]);
  assert.equal(controller.finish(), true);
  controller.retainUntilPaint(ticket, (listener) => {
    listener(ticket);
    return () => { disposeCount += 1; };
  });
  assert.equal(controller.snapshot().sampleCount, 0);
  assert.equal(controller.snapshot().retainingFinalFrame, false);
  assert.equal(disposeCount, 1);
});

test("cancel and dispose synchronously release samples and pending handoff", () => {
  const { canvas } = canvasFixture();
  const controller = createLiveInkController({ canvas, getPlotRect: () => rect });
  controller.start({ tool: "pen", color: "#fff", lineWidth: 2, opacity: 1 }, { x: 50, y: 20 });
  controller.appendFrame([{ x: 60, y: 30 }]);
  controller.cancel();
  assert.equal(controller.snapshot().sampleCount, 0);
  controller.dispose();
  controller.dispose();
  assert.equal(controller.snapshot().disposed, true);
});
