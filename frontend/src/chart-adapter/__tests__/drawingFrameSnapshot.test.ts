import assert from "node:assert/strict";
import test from "node:test";

import {
  createDrawingFrameSnapshotFactory,
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
    coordinateKey: "BTCUSDT:time:1m:0",
    dpr: 1,
    drawingProjectionConfig: "time:identity",
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
