import assert from "node:assert/strict";
import test from "node:test";

import {
  createDrawingFrameSnapshotFactory,
  createDrawingViewportSignature,
  drawingFrameRevisionsEqual,
  isDrawingFrameSnapshot,
  type DrawingFrameSnapshotInput,
} from "../drawingFrameSnapshot.js";
import { createDrawingLineageIndex } from "../../features/chart-representation/drawingLineageIndex.js";
import type { DisplayRow } from "../../features/chart-representation/chartRepresentationTypes.js";

function numericRows(...times: number[]): DisplayRow[] {
  return times.map((time) => ({ time }));
}

function ordinalRow(order: number, sourceTime: number, sourceOrdinal = 0): DisplayRow {
  return { time: { order, sourceTime, sourceOrdinal } };
}

function baseInput(
  seriesData: DisplayRow[] = numericRows(100, 200, 300),
): DrawingFrameSnapshotInput {
  return {
    axisKind: "time",
    barSpacing: 6,
    coordinateKey: "BTCUSDT:time:1m:0",
    dpr: 1,
    drawingProjectionConfig: "time:identity",
    drawingViewport: {
      horizontalDomain: "time",
      minHorizontal: 100,
      maxHorizontal: 300,
      minPrice: 80,
      maxPrice: 120,
    },
    heightCssPx: 600,
    projectionKey: "time:identity",
    seriesData,
    sourceInterval: "1m",
    sourceIntervalSeconds: 60,
    sourceTimeHorizon: 300,
    surfaceToken: "surface-a",
    themeKey: "dark",
    viewportKey: "viewport-a",
    widthCssPx: 900,
  };
}

test("snapshot capture is frozen and unchanged input reuses one stable instance", () => {
  const factory = createDrawingFrameSnapshotFactory();
  const input = baseInput();
  const first = factory.capture(input);
  const second = factory.capture(input);

  assert.strictEqual(second, first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Reflect.set(first, "widthCssPx", 1_200), false);
  assert.equal(first.widthCssPx, 900);
  assert.strictEqual(first.seriesData, input.seriesData);
  assert.equal(first.dataRevision, 1);
  assert.equal(first.projectionRevision, 1);
  assert.equal(first.viewportRevision, 1);
  assert.equal(first.themeRevision, 1);
  assert.equal(first.surfaceGeneration, 1);
  assert.equal(first.coordinateIndex.validationCount, 1);
  assert.equal(isDrawingFrameSnapshot(first), true);
  assert.equal(isDrawingFrameSnapshot({ coordinateKey: first.coordinateKey }), false);
});

test("coordinate and projection keys advance only projection revision", () => {
  const factory = createDrawingFrameSnapshotFactory();
  const input = baseInput();
  const initial = factory.capture(input);
  const coordinateChanged = factory.capture({
    ...input,
    coordinateKey: "BTCUSDT:time:1m:1",
  });

  assert.equal(coordinateChanged.coordinateKey, "BTCUSDT:time:1m:1");
  assert.equal(coordinateChanged.projectionRevision, initial.projectionRevision + 1);
  assert.equal(coordinateChanged.dataRevision, initial.dataRevision);
  assert.equal(coordinateChanged.viewportRevision, initial.viewportRevision);
  assert.equal(coordinateChanged.surfaceGeneration, initial.surfaceGeneration);
  assert.notEqual(coordinateChanged.worldRevisionKey, initial.worldRevisionKey);
  assert.strictEqual(coordinateChanged.coordinateIndex, initial.coordinateIndex);

  const projectionChanged = factory.capture({
    ...input,
    coordinateKey: coordinateChanged.coordinateKey,
    drawingProjectionConfig: "time:heikin-ashi",
    projectionKey: "time:heikin-ashi",
  });
  assert.equal(
    projectionChanged.projectionRevision,
    coordinateChanged.projectionRevision + 1,
  );
  assert.equal(projectionChanged.dataRevision, coordinateChanged.dataRevision);
  assert.notEqual(projectionChanged.worldRevisionKey, coordinateChanged.worldRevisionKey);
  assert.strictEqual(projectionChanged.coordinateIndex, coordinateChanged.coordinateIndex);
});

test("viewport-only changes preserve world key and coordinate index", () => {
  const factory = createDrawingFrameSnapshotFactory();
  const input = baseInput();
  const initial = factory.capture(input);
  const panned = factory.capture({ ...input, viewportKey: "viewport-b" });

  assert.equal(panned.viewportRevision, initial.viewportRevision + 1);
  assert.equal(panned.worldRevisionKey, initial.worldRevisionKey);
  assert.equal(panned.dataRevision, initial.dataRevision);
  assert.equal(panned.projectionRevision, initial.projectionRevision);
  assert.equal(panned.lineageIndexRevision, initial.lineageIndexRevision);
  assert.strictEqual(panned.coordinateIndex, initial.coordinateIndex);
  assert.notStrictEqual(panned, initial);

  const unchanged = factory.capture({ ...input, viewportKey: "viewport-b" });
  assert.strictEqual(unchanged, panned);
});

test("atomic culling viewport and bar spacing participate in viewport revision", () => {
  const factory = createDrawingFrameSnapshotFactory();
  const input = baseInput();
  const initial = factory.capture(input);
  const panned = factory.capture({
    ...input,
    drawingViewport: {
      horizontalDomain: "time",
      minHorizontal: 200,
      maxHorizontal: 400,
      minPrice: 80,
      maxPrice: 120,
    },
  });
  assert.equal(panned.viewportRevision, initial.viewportRevision + 1);
  assert.deepEqual(panned.drawingViewport, {
    horizontalDomain: "time",
    minHorizontal: 200,
    maxHorizontal: 400,
    minPrice: 80,
    maxPrice: 120,
  });
  assert.equal(panned.worldRevisionKey, initial.worldRevisionKey);

  const spaced = factory.capture({
    ...input,
    barSpacing: 8,
    drawingViewport: panned.drawingViewport,
  });
  assert.equal(spaced.viewportRevision, panned.viewportRevision + 1);
  assert.equal(spaced.barSpacing, 8);
  assert.equal(isDrawingFrameSnapshot({ ...spaced, drawingViewport: { minPrice: 1 } }), false);
});

test("drawing viewport copies and normalizes logical bounds and public price samples", () => {
  const samples = [
    { price: 120, coordinateCssPx: 0 },
    { price: 100, coordinateCssPx: 300 },
    { price: 80, coordinateCssPx: 600 },
  ];
  const input = baseInput();
  const snapshot = createDrawingFrameSnapshotFactory().capture({
    ...input,
    drawingViewport: {
      ...input.drawingViewport!,
      minLogical: 10,
      maxLogical: 30,
      priceProjectionSamples: samples,
    },
  });

  assert.deepEqual(snapshot.drawingViewport, {
    horizontalDomain: "time",
    minHorizontal: 100,
    maxHorizontal: 300,
    minPrice: 80,
    maxPrice: 120,
    minLogical: 10,
    maxLogical: 30,
    priceProjectionSamples: [
      { price: 120, coordinateCssPx: 0 },
      { price: 100, coordinateCssPx: 300 },
      { price: 80, coordinateCssPx: 600 },
    ],
  });
  assert.notStrictEqual(snapshot.drawingViewport?.priceProjectionSamples, samples);
  assert.notStrictEqual(snapshot.drawingViewport?.priceProjectionSamples?.[0], samples[0]);
  assert.equal(Object.isFrozen(snapshot.drawingViewport), true);
  assert.equal(Object.isFrozen(snapshot.drawingViewport?.priceProjectionSamples), true);
  assert.equal(Object.isFrozen(snapshot.drawingViewport?.priceProjectionSamples?.[0]), true);
  samples[0]!.coordinateCssPx = 999;
  assert.equal(snapshot.drawingViewport?.priceProjectionSamples?.[0]?.coordinateCssPx, 0);

  const insufficient = createDrawingFrameSnapshotFactory().capture({
    ...input,
    drawingViewport: {
      ...input.drawingViewport!,
      minLogical: 30,
      maxLogical: 10,
      priceProjectionSamples: samples.slice(0, 2),
    },
  });
  assert.equal(insufficient.drawingViewport?.minLogical, undefined);
  assert.equal(insufficient.drawingViewport?.maxLogical, undefined);
  assert.equal(insufficient.drawingViewport?.priceProjectionSamples, undefined);

  const nonFinite = createDrawingFrameSnapshotFactory().capture({
    ...input,
    drawingViewport: {
      ...input.drawingViewport!,
      priceProjectionSamples: [
        { price: 120, coordinateCssPx: 0 },
        { price: 100, coordinateCssPx: Number.NaN },
        { price: 80, coordinateCssPx: 600 },
      ],
    },
  });
  assert.equal(nonFinite.drawingViewport?.priceProjectionSamples, undefined);
});

test("data identity changes advance data revision and rebuild numeric coordinate index", () => {
  const factory = createDrawingFrameSnapshotFactory();
  const firstRows = numericRows(100, 200, 300);
  const initial = factory.capture(baseInput(firstRows));
  const nextRows = numericRows(50, 100, 200, 300);
  const updated = factory.capture(baseInput(nextRows));

  assert.equal(updated.dataRevision, initial.dataRevision + 1);
  assert.equal(updated.projectionRevision, initial.projectionRevision);
  assert.notEqual(updated.worldRevisionKey, initial.worldRevisionKey);
  assert.notStrictEqual(updated.coordinateIndex, initial.coordinateIndex);
  assert.strictEqual(updated.seriesData, nextRows);
  assert.deepEqual(Array.from(updated.coordinateIndex.numericTimes ?? []), [50, 100, 200, 300]);
  assert.equal(updated.coordinateIndex.validationCount, 1);
});

test("lineage revision changes rebuild the ordinal coordinate index", () => {
  const rows = [
    ordinalRow(0, 100),
    ordinalRow(1, 200, 0),
    ordinalRow(2, 200, 1),
  ];
  const lineageIndex = createDrawingLineageIndex(rows);
  const factory = createDrawingFrameSnapshotFactory();
  const input: DrawingFrameSnapshotInput = {
    ...baseInput(rows),
    axisKind: "derived-ordinal",
    coordinateKey: "BTCUSDT:renko:10:0",
    drawingProjectionConfig: "derived-ordinal:renko:{\"boxSize\":10}",
    ordinalSeriesIndex: lineageIndex,
    projectionKey: "derived-ordinal:renko:{\"boxSize\":10}",
  };
  const initial = factory.capture(input);

  assert.equal(initial.coordinateIndex.mode, "ordinal");
  assert.equal(initial.lineageIndexRevision, lineageIndex.revision);
  assert.strictEqual(initial.coordinateIndex.findExactOrdinalRow(200, 1), rows[2]);

  lineageIndex.reset(rows);
  const updated = factory.capture(input);
  assert.equal(updated.dataRevision, initial.dataRevision);
  assert.equal(updated.projectionRevision, initial.projectionRevision);
  assert.equal(updated.lineageIndexRevision, initial.lineageIndexRevision + 1);
  assert.notEqual(updated.worldRevisionKey, initial.worldRevisionKey);
  assert.notStrictEqual(updated.coordinateIndex, initial.coordinateIndex);
  assert.strictEqual(updated.coordinateIndex.findExactOrdinalRow(200, 1), rows[2]);
});

test("theme, size, DPR, and surface have independent revision boundaries", () => {
  const factory = createDrawingFrameSnapshotFactory();
  const input = baseInput();
  const initial = factory.capture(input);

  const themed = factory.capture({ ...input, themeKey: "light" });
  assert.equal(themed.themeRevision, initial.themeRevision + 1);
  assert.equal(themed.viewportRevision, initial.viewportRevision);
  assert.equal(themed.surfaceGeneration, initial.surfaceGeneration);
  assert.equal(themed.worldRevisionKey, initial.worldRevisionKey);
  assert.strictEqual(themed.coordinateIndex, initial.coordinateIndex);

  const resized = factory.capture({
    ...input,
    heightCssPx: 720,
    themeKey: "light",
    widthCssPx: 1_280,
  });
  assert.equal(resized.viewportRevision, themed.viewportRevision + 1);
  assert.equal(resized.widthCssPx, 1_280);
  assert.equal(resized.heightCssPx, 720);
  assert.equal(resized.themeRevision, themed.themeRevision);
  assert.equal(resized.worldRevisionKey, themed.worldRevisionKey);
  assert.strictEqual(resized.coordinateIndex, themed.coordinateIndex);

  const dprChanged = factory.capture({
    ...input,
    dpr: 2,
    heightCssPx: 720,
    themeKey: "light",
    widthCssPx: 1_280,
  });
  assert.equal(dprChanged.viewportRevision, resized.viewportRevision + 1);
  assert.equal(dprChanged.dpr, 2);
  assert.equal(dprChanged.worldRevisionKey, resized.worldRevisionKey);
  assert.strictEqual(dprChanged.coordinateIndex, resized.coordinateIndex);

  const newSurface = factory.capture({
    ...input,
    dpr: 2,
    heightCssPx: 720,
    surfaceToken: "surface-b",
    themeKey: "light",
    widthCssPx: 1_280,
  });
  assert.equal(newSurface.surfaceGeneration, dprChanged.surfaceGeneration + 1);
  assert.equal(newSurface.viewportRevision, dprChanged.viewportRevision);
  assert.notEqual(newSurface.worldRevisionKey, dprChanged.worldRevisionKey);
  assert.strictEqual(newSurface.coordinateIndex, dprChanged.coordinateIndex);
});

test("theme palette colors invalidate a snapshot even when themeKey is stable", () => {
  const factory = createDrawingFrameSnapshotFactory();
  const input = { ...baseInput(), themeKey: "custom" };
  const initial = factory.capture({
    ...input,
    themePalette: { upColor: "#22c55e", downColor: "#ef4444" },
  });
  const recolored = factory.capture({
    ...input,
    themePalette: { upColor: "#00ff88", downColor: "#ff3366" },
  });

  assert.equal(recolored.themeRevision, initial.themeRevision + 1);
  assert.deepEqual(recolored.themePalette, {
    upColor: "#00ff88",
    downColor: "#ff3366",
  });
  assert.notStrictEqual(recolored, initial);
  assert.strictEqual(factory.capture({
    ...input,
    themePalette: { upColor: "#00ff88", downColor: "#ff3366" },
  }), recolored);
});

test("factory reset starts a new independent revision sequence", () => {
  const factory = createDrawingFrameSnapshotFactory();
  const input = baseInput();
  const initial = factory.capture(input);

  factory.reset();
  const reset = factory.capture(input);
  assert.notStrictEqual(reset, initial);
  assert.notStrictEqual(reset.coordinateIndex, initial.coordinateIndex);
  assert.equal(reset.dataRevision, 1);
  assert.equal(reset.projectionRevision, 1);
  assert.equal(reset.viewportRevision, 1);
  assert.equal(reset.themeRevision, 1);
  assert.equal(reset.surfaceGeneration, 1);
});

test("viewport signatures include the real vertical price transform", () => {
  const base = {
    barSpacing: 6,
    heightCssPx: 600,
    logicalRange: { from: 10, to: 20 },
    priceAtBottom: 80,
    priceAtMiddle: 100,
    priceAtTop: 120,
    priceProjectionKey: "normal:false",
    scrollPosition: 0,
  };
  const initial = createDrawingViewportSignature(base);
  const verticallyScaled = createDrawingViewportSignature({
    ...base,
    priceAtBottom: 60,
    priceAtTop: 140,
  });

  assert.equal(typeof initial, "string");
  assert.notEqual(verticallyScaled, initial);
  assert.equal(createDrawingViewportSignature({ ...base, priceAtMiddle: null }), null);
  assert.equal(createDrawingViewportSignature({ ...base, priceAtTop: Number.NaN }), null);
  assert.equal(createDrawingViewportSignature({ ...base, heightCssPx: 0 }), null);
  assert.equal(createDrawingViewportSignature({
    ...base,
    logicalRange: { from: 10, to: Number.POSITIVE_INFINITY },
  }), null);
});

test("frame revision equality covers every worker-visible generation boundary", () => {
  const factory = createDrawingFrameSnapshotFactory();
  const input = baseInput();
  const initial = factory.capture(input);
  const clone = Object.freeze({ ...initial });

  assert.equal(drawingFrameRevisionsEqual(initial, initial), true);
  assert.equal(drawingFrameRevisionsEqual(initial, clone), true);
  assert.equal(drawingFrameRevisionsEqual(initial, { ...clone, viewportRevision: 2 }), false);
  assert.equal(drawingFrameRevisionsEqual(initial, { ...clone, surfaceGeneration: 2 }), false);
  assert.equal(drawingFrameRevisionsEqual(initial, { ...clone, dataRevision: 2 }), false);
  assert.equal(drawingFrameRevisionsEqual(initial, { ...clone, projectionRevision: 2 }), false);
  assert.equal(drawingFrameRevisionsEqual(initial, { ...clone, lineageIndexRevision: 2 }), false);
  assert.equal(drawingFrameRevisionsEqual(initial, { ...clone, themeRevision: 2 }), false);
  assert.equal(drawingFrameRevisionsEqual(initial, { ...clone, widthCssPx: 901 }), false);
  assert.equal(drawingFrameRevisionsEqual(initial, { ...clone, heightCssPx: 601 }), false);
  assert.equal(drawingFrameRevisionsEqual(initial, { ...clone, dpr: 2 }), false);
  assert.equal(drawingFrameRevisionsEqual(initial, { ...clone, barSpacing: 8 }), false);
  assert.equal(drawingFrameRevisionsEqual(initial, {
    ...clone,
    drawingViewport: { ...clone.drawingViewport!, maxPrice: 121 },
  }), false);
  assert.equal(drawingFrameRevisionsEqual(initial, { ...clone, coordinateKey: "other" }), false);
});
