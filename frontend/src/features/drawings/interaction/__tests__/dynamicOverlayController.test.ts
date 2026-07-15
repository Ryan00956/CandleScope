import assert from "node:assert/strict";
import test from "node:test";

import { createDynamicOverlayController } from "../dynamicOverlayController.js";

function fixture() {
  const boxes: number[][] = [];
  const clears: number[][] = [];
  const ellipses: number[][] = [];
  const moves: number[][] = [];
  const lines: number[][] = [];
  const context = {
    globalAlpha: 1,
    save() {}, restore() {}, setTransform() {},
    clearRect(...args: number[]) { clears.push(args); },
    beginPath() {}, arc() {}, fill() {}, fillRect() {}, stroke() {},
    ellipse(...args: number[]) { ellipses.push(args); },
    moveTo(...args: number[]) { moves.push(args); },
    lineTo(...args: number[]) { lines.push(args); },
    setLineDash() {},
    strokeRect(...args: number[]) { boxes.push(args); },
  } as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  return { boxes, canvas, clears, ellipses, lines, moves };
}

test("dynamic overlay is latest-wins within one animation frame", () => {
  const { boxes, canvas } = fixture();
  const frames: Array<() => void> = [];
  const controller = createDynamicOverlayController({
    canvas,
    getPlotRect: () => ({ x: 20, y: 10, width: 200, height: 100, dpr: 1.5 }),
    requestFrame(callback) { frames.push(callback); return callback; },
    cancelFrame() {},
  });
  assert.equal(controller.refreshLayout(), true);
  assert.equal(canvas.width, 300);
  assert.equal(canvas.height, 150);
  controller.render({ decorations: [{
    type: "box",
    box: { x: 30, y: 20, width: 10, height: 10 },
  }] });
  controller.render({ decorations: [{
    type: "box",
    box: { x: 50, y: 40, width: 20, height: 12 },
  }] });
  assert.equal(frames.length, 1);
  frames.shift()?.();
  assert.deepEqual(boxes, [[30, 30, 20, 12]]);
  assert.equal(canvas.width, 300);
  assert.equal(canvas.height, 150);
  assert.equal(controller.snapshot().paintCount, 1);
  controller.dispose();
  controller.dispose();
  assert.equal(controller.snapshot().disposed, true);
});

test("dynamic overlay paints full axis lines, ellipse drafts, and extended rays", () => {
  const { canvas, ellipses, lines, moves } = fixture();
  const frames: Array<() => void> = [];
  const controller = createDynamicOverlayController({
    canvas,
    getPlotRect: () => ({ x: 0, y: 0, width: 100, height: 50, dpr: 1 }),
    requestFrame(callback) { frames.push(callback); return callback; },
    cancelFrame() {},
  });
  controller.render({ decorations: [
    {
      type: "axis-line",
      point: { x: 25, y: 15 },
      axisLineType: "cross",
      color: "#fff",
      lineWidth: 2,
    },
    {
      type: "shape",
      box: { x: 10, y: 5, width: 40, height: 20 },
      shapeType: "ellipse",
      color: "#fff",
      lineWidth: 2,
    },
    {
      type: "line",
      from: { x: 10, y: 30 },
      to: { x: 20, y: 30 },
      extension: "line-ray",
      color: "#fff",
      lineWidth: 2,
    },
  ] });
  frames.shift()?.();
  assert.deepEqual(moves.slice(0, 2), [[0, 15], [25, 0]]);
  assert.deepEqual(lines.slice(0, 2), [[100, 15], [25, 50]]);
  assert.equal(ellipses.length, 1);
  assert.deepEqual(ellipses[0]?.slice(0, 4), [30, 15, 20, 10]);
  assert.deepEqual(moves.at(-1), [10, 30]);
  assert.equal((lines.at(-1)?.[0] ?? 0) > 100, true);
});

test("unchanged layout refresh preserves the committed handoff frame", () => {
  const { canvas, clears } = fixture();
  const frames: Array<() => void> = [];
  let rect = { x: 20, y: 10, width: 200, height: 100, dpr: 1.5 };
  const controller = createDynamicOverlayController({
    canvas,
    getPlotRect: () => rect,
    requestFrame(callback) { frames.push(callback); return callback; },
    cancelFrame() {},
  });

  assert.equal(controller.refreshLayout(), true);
  controller.render({ decorations: [{
    type: "line",
    from: { x: 30, y: 20 },
    to: { x: 80, y: 60 },
    color: "#fff",
    lineWidth: 2,
  }] });
  frames.shift()?.();
  const clearsAfterDraftPaint = clears.length;

  // React selection/coordinate effects may request an eager layout refresh
  // between document commit and the exact scene paint acknowledgement.
  assert.equal(controller.refreshLayout(), true);
  assert.equal(clears.length, clearsAfterDraftPaint);

  // A real viewport layout change still invalidates the stale pixels.
  rect = { ...rect, width: 220 };
  assert.equal(controller.refreshLayout(), true);
  assert.ok(clears.length > clearsAfterDraftPaint);
});
