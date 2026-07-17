import assert from "node:assert/strict";
import test from "node:test";

import type { DrawingRenderRevisionStamp } from "../../engine/drawingRenderScheduler.js";
import {
  createDrawingScreenDisplayList,
  hitTestDrawingScreenDisplayList,
} from "../../rendering/drawingDisplayList.js";
import type { ProjectedDrawingEntity } from "../../rendering/drawingDisplayList.js";
import {
  createDrawingHitIndex,
  DRAWING_HIT_INDEX_CELL_SIZE_CSS_PX,
  hitTestDrawingHitIndex,
  queryDrawingHitIndex,
} from "../drawingHitIndex.js";

const stamp: DrawingRenderRevisionStamp = Object.freeze({
  scopeKey: "hit-index",
  documentRevision: 1,
  surfaceGeneration: 2,
  dataRevision: 3,
  projectionRevision: 4,
  lineageIndexRevision: 5,
  viewportRevision: 6,
  themeRevision: 7,
  widthCssPx: 800,
  heightCssPx: 400,
  dpr: 1.5,
});

function polyline(
  id: string,
  points: readonly number[],
  bbox: readonly [number, number, number, number],
  tolerance = 6,
): ProjectedDrawingEntity {
  return {
    id,
    kind: "freehand",
    geometryRevision: 1,
    styleRevision: 1,
    style: { kind: "freehand", color: "#f59e0b", lineWidth: 2 },
    points: new Float64Array(points),
    bbox,
    hitZones: [{
      kind: "polyline",
      pointOffset: 0,
      pointCount: points.length / 2,
      tolerance,
      result: { body: true },
    }],
  };
}

test("uniform grid indexes every crossed cell of a long segment", () => {
  const list = createDrawingScreenDisplayList(stamp, [
    polyline("long", [-1_000, 200, 2_000, 200], [0, 200, 800, 200]),
  ]);
  const index = createDrawingHitIndex(list);

  assert.equal(index.stats.cellSizeCssPx, DRAWING_HIT_INDEX_CELL_SIZE_CSS_PX);
  assert.equal(index.stats.segmentCount, 1);
  assert.ok(index.stats.bucketCount >= Math.ceil(800 / DRAWING_HIT_INDEX_CELL_SIZE_CSS_PX));
  assert.deepEqual(hitTestDrawingHitIndex(index, 401, 203), {
    entityId: "long",
    kind: "freehand",
    body: true,
  });
  assert.ok(queryDrawingHitIndex(index, 401, 203).candidateSegmentCount <= 1);
});

test("short-segment AABB indexing preserves tolerance hits across cell boundaries", () => {
  const list = createDrawingScreenDisplayList(stamp, [
    polyline("boundary", [60, 60, 68, 68], [60, 60, 68, 68], 8),
  ]);
  const index = createDrawingHitIndex(list);
  const probes = [
    [55, 60],
    [73, 68],
    [64, 55],
    [64, 73],
  ] as const;

  assert.equal(index.stats.segmentReferenceCount, 4);
  for (const [x, y] of probes) {
    assert.deepEqual(
      hitTestDrawingHitIndex(index, x, y),
      hitTestDrawingScreenDisplayList(list, x, y),
    );
  }
});

test("indexed polyline candidates preserve gaps and canonical z-order", () => {
  const lower = polyline("lower", [10, 80, 790, 80], [10, 80, 790, 80]);
  const gappedTop = polyline("top", [
    10, 80,
    300, 80,
    Number.NaN, Number.NaN,
    500, 80,
    790, 80,
  ], [10, 80, 790, 80]);
  const list = createDrawingScreenDisplayList(stamp, [lower, gappedTop]);
  const index = createDrawingHitIndex(list);

  assert.equal(hitTestDrawingHitIndex(index, 200, 80)?.entityId, "top");
  assert.equal(hitTestDrawingHitIndex(index, 600, 80)?.entityId, "top");
  assert.equal(hitTestDrawingHitIndex(index, 400, 80)?.entityId, "lower");
});

test("selected handles stay first even when they lie outside the indexed bbox", () => {
  const entity: ProjectedDrawingEntity = {
    id: "selected",
    kind: "shape",
    geometryRevision: 1,
    styleRevision: 1,
    style: { kind: "shape", color: "#fff", lineWidth: 2 },
    points: new Float64Array([300, 150, 360, 210]),
    bbox: [300, 150, 360, 210],
    handles: new Float64Array([120, 100]),
    handleNames: ["outside"],
    handleResults: [{ handle: "outside", pointIndex: 0 }],
    handleTolerance: 8,
    hitZones: [{
      kind: "box",
      pointOffset: 0,
      pointCount: 2,
      tolerance: 4,
      result: { body: true },
    }],
  };
  const list = createDrawingScreenDisplayList(stamp, [entity]);
  const index = createDrawingHitIndex(list);
  assert.equal(queryDrawingHitIndex(index, 120, 100).candidateEntityCount, 0);
  assert.deepEqual(hitTestDrawingHitIndex(index, 120, 100, "selected"), {
    entityId: "selected",
    kind: "shape",
    handle: "outside",
    pointIndex: 0,
  });
});

test("uniform grid is exact-parity with the sequential oracle over 1000 queries", () => {
  const entities: ProjectedDrawingEntity[] = [];
  for (let row = 0; row < 16; row += 1) {
    const y = 12 + row * 23;
    entities.push(polyline(
      `stroke-${row}`,
      [-50, y, 180, y + 8, 420, y - 5, 850, y + 3],
      [0, y - 5, 800, y + 8],
      5,
    ));
  }
  const list = createDrawingScreenDisplayList(stamp, entities);
  const index = createDrawingHitIndex(list, 32);
  let maximumCandidates = 0;
  for (let queryIndex = 0; queryIndex < 1_000; queryIndex += 1) {
    const x = (queryIndex * 37 + 11) % 801;
    const y = (queryIndex * 53 + 7) % 401;
    const query = queryDrawingHitIndex(index, x, y);
    maximumCandidates = Math.max(maximumCandidates, query.candidateEntityCount);
    assert.deepEqual(
      hitTestDrawingHitIndex(index, x, y),
      hitTestDrawingScreenDisplayList(list, x, y),
      `query ${queryIndex} at ${x},${y}`,
    );
  }
  assert.ok(maximumCandidates < entities.length);
  assert.ok(index.stats.segmentReferenceCount > index.stats.segmentCount);
});
