import assert from "node:assert/strict";
import test from "node:test";

import { createDrawingEntity } from "../../core/drawingDocument.js";
import type {
  DrawingEntity,
  DrawingEntityInput,
} from "../../core/drawingDocument.js";
import {
  createDrawingEntityGeometryBounds,
  DRAWING_FREEHAND_BOUNDS_CHUNK_POINTS,
  drawingGeometryBoundsIntersectsViewport,
} from "../drawingBounds.js";
import type {
  BoundedDrawingGeometryBounds,
  DrawingEntityGeometryBounds,
} from "../drawingBounds.js";

function entity(input: DrawingEntityInput): DrawingEntity {
  return createDrawingEntity(input);
}

function bounded(result: DrawingEntityGeometryBounds): BoundedDrawingGeometryBounds {
  assert.equal(result.bounds.kind, "bounded");
  return result.bounds as BoundedDrawingGeometryBounds;
}

test("all nine drawing kinds produce canonical bounds", () => {
  const fixtures: readonly DrawingEntity[] = [
    entity({
      id: "line",
      kind: "line",
      geometry: {
        kind: "line",
        lineType: "line-segment",
        dataPoints: [{ time: 10, price: 5 }, { time: 20, price: 15 }],
      },
      style: { kind: "line", color: "#fff", lineWidth: 2 },
    }),
    entity({
      id: "axis",
      kind: "axis-line",
      geometry: { kind: "axis-line", axisLineType: "horizontal", dataPoint: { time: 15, price: 7 } },
      style: { kind: "axis-line", color: "#fff", lineWidth: 1 },
    }),
    entity({
      id: "angle",
      kind: "angle-measure",
      geometry: {
        kind: "angle-measure",
        dataPoints: [
          { time: 10, price: 10 },
          { time: 12, price: 15 },
          { time: 14, price: 8 },
        ],
      },
      style: { kind: "angle-measure", color: "#fff", lineWidth: 1 },
    }),
    entity({
      id: "text",
      kind: "text",
      geometry: { kind: "text", dataPoint: { time: 11, price: 9 } },
      style: { kind: "text", text: "note" },
    }),
    entity({
      id: "fib",
      kind: "fibonacci",
      geometry: {
        kind: "fibonacci",
        dataPoints: [{ time: 10, price: 2 }, { time: 30, price: 12 }],
      },
      style: { kind: "fibonacci", color: "#fff", lineWidth: 1 },
    }),
    entity({
      id: "position",
      kind: "position",
      geometry: {
        kind: "position",
        direction: "long",
        entryPrice: 10,
        tpPrice: 18,
        slPrice: 6,
        timeRange: { start: { time: 10 }, end: { time: 25 } },
      },
      style: { kind: "position", positionSize: 100 },
    }),
    entity({
      id: "shape",
      kind: "shape",
      geometry: {
        kind: "shape",
        shapeType: "rectangle",
        dataPoints: [{ time: 4, price: 3 }, { time: 9, price: 13 }],
      },
      style: { kind: "shape", color: "#fff", lineWidth: 1 },
    }),
    entity({
      id: "freehand",
      kind: "freehand",
      geometry: {
        kind: "freehand",
        dataPoints: [{ time: 1, price: 2 }, { time: 3, price: 4 }],
      },
      style: { kind: "freehand", color: "#fff", lineWidth: 2 },
    }),
    entity({
      id: "highlighter",
      kind: "highlighter",
      geometry: {
        kind: "highlighter",
        stroke: {
          version: 3,
          sourceProjection: "renko",
          sourceProjectionConfig: "box=1",
          spans: [],
          points: [{ time: 2, price: 6 }, { time: 8, price: 10 }],
        },
      },
      style: { kind: "highlighter", color: "#ff0", lineWidth: 8, opacity: 0.3 },
    }),
  ];

  assert.deepEqual(new Set(fixtures.map((fixture) => fixture.kind)), new Set([
    "line",
    "axis-line",
    "angle-measure",
    "text",
    "fibonacci",
    "position",
    "shape",
    "freehand",
    "highlighter",
  ]));

  for (const fixture of fixtures) {
    const result = createDrawingEntityGeometryBounds(fixture);
    if (fixture.kind === "axis-line") {
      assert.equal(result.bounds.kind, "unbounded");
    } else {
      assert.equal(result.bounds.kind, "bounded", fixture.kind);
    }
  }

  assert.deepEqual(bounded(createDrawingEntityGeometryBounds(fixtures[0] as DrawingEntity)), {
    kind: "bounded",
    horizontalDomain: "time",
    minHorizontal: 10,
    maxHorizontal: 20,
    minPrice: 5,
    maxPrice: 15,
  });
  assert.deepEqual(bounded(createDrawingEntityGeometryBounds(fixtures[5] as DrawingEntity)), {
    kind: "bounded",
    horizontalDomain: "time",
    minHorizontal: 10,
    maxHorizontal: 25,
    minPrice: 6,
    maxPrice: 18,
  });
});

test("rays, infinite lines, and all axis-line variants stay explicitly unbounded", () => {
  for (const lineType of ["line-ray", "line-infinite"] as const) {
    const result = createDrawingEntityGeometryBounds(entity({
      id: lineType,
      kind: "line",
      geometry: {
        kind: "line",
        lineType,
        dataPoints: [{ time: 10, price: 5 }, { time: 20, price: 15 }],
      },
      style: { kind: "line" },
    }));
    assert.deepEqual(result.bounds, {
      kind: "unbounded",
      axis: "both",
      horizontalDomain: null,
      minHorizontal: null,
      maxHorizontal: null,
      minPrice: null,
      maxPrice: null,
    });
  }

  const expectedAxes = {
    horizontal: "horizontal",
    vertical: "vertical",
    cross: "both",
  } as const;
  for (const axisLineType of ["horizontal", "vertical", "cross"] as const) {
    const result = createDrawingEntityGeometryBounds(entity({
      id: axisLineType,
      kind: "axis-line",
      geometry: { kind: "axis-line", axisLineType, dataPoint: { time: 10, price: 5 } },
      style: { kind: "axis-line" },
    }));
    assert.equal(result.bounds.kind, "unbounded");
    if (result.bounds.kind !== "unbounded") continue;
    assert.equal(result.bounds.axis, expectedAxes[axisLineType]);
    if (axisLineType === "horizontal") {
      assert.equal(result.bounds.minPrice, 5);
      assert.equal(result.bounds.minHorizontal, null);
    } else if (axisLineType === "vertical") {
      assert.equal(result.bounds.minHorizontal, 10);
      assert.equal(result.bounds.minPrice, null);
    } else {
      assert.equal(result.bounds.minHorizontal, null);
      assert.equal(result.bounds.minPrice, null);
    }
  }
});

test("freehand bounds own at most 128 points per chunk and retain boundary segments", () => {
  assert.equal(DRAWING_FREEHAND_BOUNDS_CHUNK_POINTS, 128);
  const points = Array.from({ length: 300 }, (_, index) => ({
    time: index,
    price: index * 2,
  }));
  const result = createDrawingEntityGeometryBounds(entity({
    id: "freehand-300",
    kind: "freehand",
    geometry: { kind: "freehand", dataPoints: points },
    style: { kind: "freehand" },
  }));

  assert.equal(result.pointCount, 300);
  assert.deepEqual(result.gapPointIndexes, []);
  assert.deepEqual(result.chunks.map((chunk) => ({
    start: chunk.startPointIndex,
    end: chunk.endPointIndex,
    segmentStart: chunk.segmentStartPointIndex,
  })), [
    { start: 0, end: 128, segmentStart: 0 },
    { start: 128, end: 256, segmentStart: 127 },
    { start: 256, end: 300, segmentStart: 255 },
  ]);
  for (const chunk of result.chunks) {
    assert.ok(chunk.endPointIndex - chunk.startPointIndex <= 128);
  }
  assert.equal(result.chunks[1]?.bounds.kind, "bounded");
  if (result.chunks[1]?.bounds.kind === "bounded") {
    assert.equal(result.chunks[1].bounds.minHorizontal, 127);
    assert.equal(result.chunks[1].bounds.maxHorizontal, 255);
  }
});

test("span chunks require exact frame projection and keep entity culling fail-open", () => {
  const result = createDrawingEntityGeometryBounds(entity({
    id: "fallback-envelope",
    kind: "freehand",
    geometry: { kind: "freehand", stroke: {
      version: 2,
      sourceProjection: "renko",
      sourceProjectionConfig: "dataset:renko",
      spans: [{
        exact: {
          left: { time: 400, sourceOrdinal: 0 },
          right: { time: 600, sourceOrdinal: 0 },
        },
        fallback: { fromTime: 0, toTime: 1_000, leftRatio: 0.4, rightRatio: 0.6 },
      }],
      points: [
        { span: 0, ratio: 0, price: 10 },
        { span: 0, ratio: 0.1, price: 20 },
      ],
    } },
    style: { kind: "freehand" },
  }));

  assert.equal(result.bounds.kind, "deferred");
  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0]?.requiresExactProjection, true);
});

test("a null resolved freehand point breaks the path and forbids cross-gap chunk overlap", () => {
  const points = Array.from({ length: 300 }, (_, index) => ({ time: index, price: index }));
  const result = createDrawingEntityGeometryBounds(entity({
    id: "freehand-gap",
    kind: "freehand",
    geometry: { kind: "freehand", dataPoints: points },
    style: { kind: "freehand" },
  }), {
    resolveFreehandPoint: ({ canonicalPoint, pointIndex }) => (
      pointIndex === 128 ? null : canonicalPoint
    ),
  });

  assert.deepEqual(result.gapPointIndexes, [128]);
  assert.deepEqual(result.chunks.map((chunk) => ({
    start: chunk.startPointIndex,
    end: chunk.endPointIndex,
    segmentStart: chunk.segmentStartPointIndex,
  })), [
    { start: 0, end: 128, segmentStart: 0 },
    { start: 129, end: 257, segmentStart: 129 },
    { start: 257, end: 300, segmentStart: 256 },
  ]);
  assert.ok(result.chunks.every((chunk) => chunk.segmentStartPointIndex !== 128));
});

test("bounds prefer source time and fail open when domains are incomparable", () => {
  const timeFirst = createDrawingEntityGeometryBounds(entity({
    id: "time-first",
    kind: "line",
    geometry: {
      kind: "line",
      dataPoints: [
        { time: 10, logical: 999, price: 4 },
        { time: 20, logical: 1000, price: 8 },
      ],
    },
    style: { kind: "line" },
  }));
  assert.equal(bounded(timeFirst).minHorizontal, 10);
  assert.equal(bounded(timeFirst).maxHorizontal, 20);

  const mixed = createDrawingEntityGeometryBounds(entity({
    id: "mixed",
    kind: "line",
    geometry: {
      kind: "line",
      dataPoints: [{ time: 1, price: 1 }, { logical: 2, price: 2 }],
    },
    style: { kind: "line" },
  }));
  assert.equal(mixed.bounds.kind, "deferred");
  assert.equal(drawingGeometryBoundsIntersectsViewport(mixed.bounds, {
    horizontalDomain: "time",
    minHorizontal: 100,
    maxHorizontal: 200,
    minPrice: 100,
    maxPrice: 200,
  }), true);
});

test("unbounded axis constraints still cull on their finite dimension", () => {
  const horizontal = createDrawingEntityGeometryBounds(entity({
    id: "horizontal",
    kind: "axis-line",
    geometry: { kind: "axis-line", axisLineType: "horizontal", dataPoint: { time: 5, price: 50 } },
    style: { kind: "axis-line" },
  }));
  assert.equal(drawingGeometryBoundsIntersectsViewport(horizontal.bounds, {
    horizontalDomain: "time",
    minHorizontal: 0,
    maxHorizontal: 10,
    minPrice: 0,
    maxPrice: 10,
  }), false);
  assert.equal(drawingGeometryBoundsIntersectsViewport(horizontal.bounds, {
    horizontalDomain: "time",
    minHorizontal: 1_000,
    maxHorizontal: 2_000,
    minPrice: 45,
    maxPrice: 55,
  }), true);
});
