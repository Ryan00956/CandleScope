import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAngleDynamicOverlayDecoration,
  createDynamicOverlayController,
  type DynamicAngleOverlayDecoration,
} from "../dynamicOverlayController.js";
import { buildDynamicPositionOverlayDecoration } from "../dynamicPositionOverlay.js";

function fixture() {
  const arcs: number[][] = [];
  const boxes: number[][] = [];
  const clears: number[][] = [];
  const dashes: number[][] = [];
  const ellipses: number[][] = [];
  const fills: number[][] = [];
  const lineWidths: number[] = [];
  const moves: number[][] = [];
  const lines: number[][] = [];
  const roundRects: number[][] = [];
  const shadowBlurs: number[] = [];
  const texts: Array<readonly [string, number, number]> = [];
  const transforms: number[][] = [];
  let lineWidth = 1;
  let shadowBlur = 0;
  const context = {
    globalAlpha: 1,
    save() {}, restore() {},
    setTransform(...args: number[]) { transforms.push(args); },
    clearRect(...args: number[]) { clears.push(args); },
    beginPath() {}, closePath() {},
    arc(...args: number[]) { arcs.push(args); },
    fill() {}, fillRect(...args: number[]) { fills.push(args); }, stroke() {},
    ellipse(...args: number[]) { ellipses.push(args); },
    fillText(text: string, x: number, y: number) { texts.push([text, x, y]); },
    measureText(text: string) { return { width: [...text].length * 7 } as TextMetrics; },
    moveTo(...args: number[]) { moves.push(args); },
    lineTo(...args: number[]) { lines.push(args); },
    roundRect(...args: number[]) { roundRects.push(args); },
    setLineDash(args: number[]) { dashes.push([...args]); },
    strokeRect(...args: number[]) { boxes.push(args); },
    get lineWidth() { return lineWidth; },
    set lineWidth(value: number) { lineWidth = value; lineWidths.push(value); },
    get shadowBlur() { return shadowBlur; },
    set shadowBlur(value: number) { shadowBlur = value; shadowBlurs.push(value); },
  } as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  return {
    arcs,
    boxes,
    canvas,
    clears,
    dashes,
    ellipses,
    fills,
    lines,
    lineWidths,
    moves,
    roundRects,
    shadowBlurs,
    texts,
    transforms,
  };
}

function approximatelyEqual(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < 1e-9;
}

function includesPoint(values: readonly number[][], x: number, y: number): boolean {
  return values.some((value) => (
    approximatelyEqual(value[0] ?? Number.NaN, x)
    && approximatelyEqual(value[1] ?? Number.NaN, y)
  ));
}

test("angle decoration builder freezes complete shortest-sweep CSS geometry", () => {
  const from = { x: 80, y: 50 };
  const to = { x: 40, y: 80 };
  const decoration = buildAngleDynamicOverlayDecoration(from, to, "#3b82f6", 2, true);
  assert.ok(decoration);
  assert.equal(Object.isFrozen(decoration), true);
  assert.equal(Object.isFrozen(decoration.ray), true);
  assert.equal(Object.isFrozen(decoration.ray[0]), true);
  assert.equal(Object.isFrozen(decoration.baseline), true);
  assert.equal(Object.isFrozen(decoration.arcPoints), true);
  assert.equal(Object.isFrozen(decoration.label), true);
  assert.deepEqual(decoration.ray, [{ x: 80, y: 50 }, { x: 40, y: 80 }]);
  assert.deepEqual(decoration.baseline, [{ x: 80, y: 50 }, { x: 30, y: 50 }]);
  assert.equal(decoration.arcPoints.length, 9);
  assert.ok(approximatelyEqual(decoration.arcPoints[0]?.x ?? 0, 62));
  assert.ok(approximatelyEqual(decoration.arcPoints[0]?.y ?? 0, 50));
  assert.equal(decoration.label.text, "36.9°");

  from.x = 999;
  to.y = 999;
  assert.deepEqual(decoration.ray, [{ x: 80, y: 50 }, { x: 40, y: 80 }]);
});

test("angle decoration builder rejects malformed and collapsed inputs", () => {
  assert.equal(buildAngleDynamicOverlayDecoration(
    { x: Number.NaN, y: 0 }, { x: 10, y: 10 }, "#fff", 2, true,
  ), null);
  assert.equal(buildAngleDynamicOverlayDecoration(
    { x: 10, y: 10 }, { x: 10.2, y: 10.2 }, "#fff", 2, true,
  ), null);
  assert.equal(buildAngleDynamicOverlayDecoration(
    { x: 0, y: 0 }, { x: 10, y: 10 }, " ", 2, true,
  ), null);
  assert.equal(buildAngleDynamicOverlayDecoration(
    { x: 0, y: 0 }, { x: 10, y: 10 }, "#fff", 0, true,
  ), null);
  assert.equal(buildAngleDynamicOverlayDecoration(
    { x: 0, y: 0 }, { x: 10, y: 10 }, "#fff", 2, undefined as unknown as boolean,
  ), null);
});

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

test("selected handle feedback paints endpoints without a dashed bounding box", () => {
  const { arcs, boxes, canvas, dashes } = fixture();
  const frames: Array<() => void> = [];
  const controller = createDynamicOverlayController({
    canvas,
    getPlotRect: () => ({ x: 20, y: 10, width: 200, height: 100, dpr: 1 }),
    requestFrame(callback) { frames.push(callback); return callback; },
    cancelFrame() {},
  });
  controller.render({ decorations: [{
    type: "handles",
    handles: [{ x: 30, y: 20 }, { x: 80, y: 60 }],
    color: "#3b82f6",
  }] });
  frames.shift()?.();

  assert.deepEqual(arcs, [
    [10, 10, 4.5, 0, Math.PI * 2],
    [60, 50, 4.5, 0, Math.PI * 2],
  ]);
  assert.deepEqual(boxes, []);
  assert.deepEqual(dashes, []);
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

test("dynamic line decorations paint fibonacci level and price labels", () => {
  const { canvas, texts } = fixture();
  const frames: Array<() => void> = [];
  const controller = createDynamicOverlayController({
    canvas,
    getPlotRect: () => ({ x: 20, y: 10, width: 200, height: 100, dpr: 1.5 }),
    requestFrame(callback) { frames.push(callback); return callback; },
    cancelFrame() {},
  });
  controller.render({ decorations: [{
    type: "line",
    from: { x: 30, y: 50 },
    to: { x: 130, y: 50 },
    color: "#009688",
    lineWidth: 2,
    label: {
      anchor: { x: 34, y: 48 },
      text: "0.618 (57.08)",
    },
  }] });
  frames.shift()?.();

  assert.deepEqual(texts, [["0.618 (57.08)", 14, 38]]);
});

test("dynamic overlay keeps position fills, badges, and information visible while dragging", () => {
  const { canvas, fills, roundRects, texts } = fixture();
  const frames: Array<() => void> = [];
  const controller = createDynamicOverlayController({
    canvas,
    getPlotRect: () => ({ x: 20, y: 10, width: 240, height: 180, dpr: 2 }),
    requestFrame(callback) { frames.push(callback); return callback; },
    cancelFrame() {},
  });
  const decoration = buildDynamicPositionOverlayDecoration(
    {
      id: "position-drag",
      type: "position",
      direction: "long",
      entryPrice: 100,
      tpPrice: 120,
      slPrice: 90,
      positionSize: 1_000,
      infoPanelOffset: { x: 4, y: -2 },
      timeRange: { start: 40, end: 160 },
    },
    (point) => typeof point.time === "number"
      ? { x: point.time, y: 150 - point.price }
      : null,
    { upColor: "#00aa11", downColor: "#dd0022" },
    108,
  );
  assert.ok(decoration);

  controller.render({ decorations: [decoration] });
  frames.shift()?.();

  assert.equal(fills.length, 2, "TP and SL risk/reward areas remain filled");
  assert.ok(roundRects.length >= 8, "price badges, panel, direction badge, and controls paint");
  assert.ok(texts.some(([text]) => text === "LONG"));
  assert.ok(texts.some(([text]) => text === "入场: "));
  assert.ok(texts.some(([text]) => text === "现价: "));
  assert.ok(texts.some(([text]) => text === "仓位: "));
});

test("dynamic overlay paints structured angle geometry in plot-local CSS pixels", () => {
  const {
    arcs,
    canvas,
    dashes,
    lines,
    lineWidths,
    moves,
    roundRects,
    shadowBlurs,
    texts,
    transforms,
  } = fixture();
  const frames: Array<() => void> = [];
  const controller = createDynamicOverlayController({
    canvas,
    getPlotRect: () => ({ x: 20, y: 10, width: 100, height: 80, dpr: 2 }),
    requestFrame(callback) { frames.push(callback); return callback; },
    cancelFrame() {},
  });
  const decoration = buildAngleDynamicOverlayDecoration(
    { x: 30, y: 30 },
    { x: 70, y: 70 },
    "#3b82f6",
    2,
    true,
  );
  assert.ok(decoration);

  controller.render({ decorations: [decoration] });
  frames.shift()?.();

  assert.equal(canvas.width, 200);
  assert.equal(canvas.height, 160);
  assert.ok(transforms.some((args) => args.join(":") === "2:0:0:2:0:0"));
  assert.ok(includesPoint(moves, 10, 20), "ray starts at plot-local CSS coordinates");
  assert.ok(includesPoint(lines, 50, 60), "ray ends at plot-local CSS coordinates");
  assert.ok(includesPoint(lines, 10 + Math.hypot(40, 40), 20), "baseline is horizontal");
  const secondArc = decoration.arcPoints[1];
  assert.ok(secondArc);
  assert.ok(includesPoint(lines, secondArc.x - 20, secondArc.y - 10));
  assert.ok(dashes.some((dash) => dash.join(":") === "4:4"));
  assert.ok(lineWidths.some((width) => approximatelyEqual(width, 12)), "selected halo width");
  assert.ok(lineWidths.some((width) => approximatelyEqual(width, 1.7)), "arc width");
  assert.deepEqual(
    arcs,
    [[10, 20, 6, 0, Math.PI * 2], [50, 60, 6, 0, Math.PI * 2]],
  );
  const localLabelX = decoration.label.center.x - 20;
  const localLabelY = decoration.label.center.y - 10;
  assert.deepEqual(texts, [["45°", localLabelX, localLabelY + 0.5]]);
  assert.deepEqual(roundRects, [[localLabelX - 15.5, localLabelY - 8.5, 31, 17, 4]]);
  assert.ok(shadowBlurs.includes(8), "shadow blur is scaled explicitly because CTM does not scale it");
});

test("dynamic angle rendering fails closed for incomplete structured geometry", () => {
  const { arcs, canvas, lines, moves, roundRects, texts } = fixture();
  const frames: Array<() => void> = [];
  const controller = createDynamicOverlayController({
    canvas,
    getPlotRect: () => ({ x: 0, y: 0, width: 100, height: 50, dpr: 1 }),
    requestFrame(callback) { frames.push(callback); return callback; },
    cancelFrame() {},
  });
  const valid = buildAngleDynamicOverlayDecoration(
    { x: 10, y: 10 }, { x: 50, y: 30 }, "#fff", 2, true,
  );
  assert.ok(valid);
  const malformed = {
    ...valid,
    arcPoints: Object.freeze([{ x: Number.NaN, y: 20 }]),
  } as unknown as DynamicAngleOverlayDecoration;

  controller.render({ decorations: [malformed] });
  frames.shift()?.();

  assert.deepEqual(moves, []);
  assert.deepEqual(lines, []);
  assert.deepEqual(arcs, []);
  assert.deepEqual(roundRects, []);
  assert.deepEqual(texts, []);
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
