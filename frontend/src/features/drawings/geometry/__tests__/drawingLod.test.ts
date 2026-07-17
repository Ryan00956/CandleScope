import assert from "node:assert/strict";
import test from "node:test";

import {
  createDrawingLodHierarchy,
  DRAWING_LOD_CONTINUOUS_VIEWPORT_TOLERANCE_CSS_PX,
  DRAWING_LOD_DEFAULT_CACHE_BUDGET_BYTES,
  DRAWING_LOD_MAX_CACHE_BUDGET_BYTES,
  DRAWING_LOD_NORMAL_STATIC_TOLERANCE_CSS_PX,
  DRAWING_LOD_SELECTED_EDIT_TOLERANCE_CSS_PX,
  DRAWING_LOD_SETTLED_EXACT_TOLERANCE_CSS_PX,
  DrawingByteWeightedLruCache,
  selectDrawingLod,
} from "../drawingLod.js";
import type {
  DrawingByteLruRemovalReason,
  DrawingLodHierarchy,
  DrawingLodSelection,
  DrawingLodToleranceClass,
} from "../drawingLod.js";

function coordinateBuffer(points: readonly (readonly [number, number] | null)[]): Float64Array {
  const coordinates = new Float64Array(points.length * 2);
  points.forEach((point, pointIndex) => {
    const offset = pointIndex * 2;
    coordinates[offset] = point?.[0] ?? Number.NaN;
    coordinates[offset + 1] = point?.[1] ?? Number.NaN;
  });
  return coordinates;
}

function indexes(selection: DrawingLodSelection): readonly number[] {
  return Array.from(selection.pointIndexes);
}

function isSubset(subset: DrawingLodSelection, superset: DrawingLodSelection): boolean {
  const values = new Set(superset.pointIndexes);
  return Array.from(subset.pointIndexes).every((pointIndex) => values.has(pointIndex));
}

function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared <= 0
    ? 0
    : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + projection * dx), py - (ay + projection * dy));
}

function maximumSelectionError(
  coordinates: Float64Array,
  selection: DrawingLodSelection,
): number {
  let maximum = 0;
  for (const path of selection.paths) {
    const selected = Array.from(selection.pointIndexes.slice(
      path.selectedIndexOffset,
      path.selectedIndexOffset + path.selectedIndexCount,
    ));
    for (let selectedIndex = 0; selectedIndex + 1 < selected.length; selectedIndex += 1) {
      const startPointIndex = selected[selectedIndex];
      const endPointIndex = selected[selectedIndex + 1];
      assert.notEqual(startPointIndex, undefined);
      assert.notEqual(endPointIndex, undefined);
      if (startPointIndex === undefined || endPointIndex === undefined) continue;
      const ax = coordinates[startPointIndex * 2];
      const ay = coordinates[startPointIndex * 2 + 1];
      const bx = coordinates[endPointIndex * 2];
      const by = coordinates[endPointIndex * 2 + 1];
      assert.notEqual(ax, undefined);
      assert.notEqual(ay, undefined);
      assert.notEqual(bx, undefined);
      assert.notEqual(by, undefined);
      if (ax === undefined || ay === undefined || bx === undefined || by === undefined) continue;
      for (let pointIndex = startPointIndex + 1; pointIndex < endPointIndex; pointIndex += 1) {
        const px = coordinates[pointIndex * 2];
        const py = coordinates[pointIndex * 2 + 1];
        if (px === undefined || py === undefined || !Number.isFinite(px) || !Number.isFinite(py)) continue;
        maximum = Math.max(maximum, pointSegmentDistance(px, py, ax, ay, bx, by));
      }
    }
  }
  return maximum;
}

function select(
  hierarchy: DrawingLodHierarchy,
  toleranceClass: DrawingLodToleranceClass,
  visibleWidthCssPx = 10_000,
): DrawingLodSelection {
  return selectDrawingLod(hierarchy, { toleranceClass, visibleWidthCssPx });
}

test("LOD tolerance classes preserve the Phase 6 CSS-pixel contract", () => {
  assert.equal(DRAWING_LOD_SELECTED_EDIT_TOLERANCE_CSS_PX, 0.35);
  assert.equal(DRAWING_LOD_NORMAL_STATIC_TOLERANCE_CSS_PX, 0.75);
  assert.equal(DRAWING_LOD_CONTINUOUS_VIEWPORT_TOLERANCE_CSS_PX, 1.25);
  assert.equal(DRAWING_LOD_SETTLED_EXACT_TOLERANCE_CSS_PX, 0.5);
});

test("hierarchy splits finite paths and forces endpoints on both sides of every gap", () => {
  const raw = coordinateBuffer([
    [0, 0],
    [1, 0.1],
    null,
    [3, 4],
    [4, 5],
    [5, 4],
    null,
    [8, 2],
  ]);
  const before = raw.slice();
  const hierarchy = createDrawingLodHierarchy(raw);

  assert.deepEqual(hierarchy.paths, [
    { startPointIndex: 0, endPointIndex: 2, pointCount: 2 },
    { startPointIndex: 3, endPointIndex: 6, pointCount: 3 },
    { startPointIndex: 7, endPointIndex: 8, pointCount: 1 },
  ]);
  assert.equal(hierarchy.pointCount, 8);
  assert.equal(hierarchy.finitePointCount, 6);
  assert.equal(hierarchy.gapPointCount, 2);
  assert.equal(hierarchy.importanceCssPx[0], Number.POSITIVE_INFINITY);
  assert.equal(hierarchy.importanceCssPx[1], Number.POSITIVE_INFINITY);
  assert.ok(Number.isNaN(hierarchy.importanceCssPx[2]));
  assert.equal(hierarchy.importanceCssPx[3], Number.POSITIVE_INFINITY);
  assert.equal(hierarchy.importanceCssPx[5], Number.POSITIVE_INFINITY);
  assert.ok(Number.isNaN(hierarchy.importanceCssPx[6]));
  assert.equal(hierarchy.importanceCssPx[7], Number.POSITIVE_INFINITY);
  assert.ok(hierarchy.estimatedByteSize >= hierarchy.importanceCssPx.byteLength);

  const selection = select(hierarchy, "continuousViewport");
  assert.deepEqual(indexes(selection), [0, 1, 3, 5, 7]);
  assert.deepEqual(Array.from(selection.pathBreaks), [2, 4]);
  assert.deepEqual(raw, before, "hierarchy construction and selection must not mutate raw points");
});

test("RDP importance produces nested levels whose screen error stays within tolerance", () => {
  const raw = coordinateBuffer(Array.from({ length: 240 }, (_, index) => [
    index * 0.5,
    Math.sin(index * 0.21) * 3 + Math.sin(index * 0.047) * 1.25,
  ] as const));
  const before = raw.slice();
  const hierarchy = createDrawingLodHierarchy(raw);
  const selected = select(hierarchy, "selectedEdit");
  const normal = select(hierarchy, "normalStatic");
  const viewport = select(hierarchy, "continuousViewport");

  assert.ok(selected.selectedPointCount > normal.selectedPointCount);
  assert.ok(normal.selectedPointCount > viewport.selectedPointCount);
  assert.equal(isSubset(viewport, normal), true);
  assert.equal(isSubset(normal, selected), true);
  assert.ok(maximumSelectionError(raw, selected) <= selected.effectiveToleranceCssPx + 1e-9);
  assert.ok(maximumSelectionError(raw, normal) <= normal.effectiveToleranceCssPx + 1e-9);
  assert.ok(maximumSelectionError(raw, viewport) <= viewport.effectiveToleranceCssPx + 1e-9);
  assert.deepEqual(raw, before);
});

test("visible-width pressure raises error tolerance instead of fixed-N sampling", () => {
  const raw = coordinateBuffer(Array.from({ length: 600 }, (_, index) => [
    index * 0.2,
    Math.sin(index * 0.31) * 9 + Math.sin(index * 0.071) * 2.75,
  ] as const));
  const hierarchy = createDrawingLodHierarchy(raw);
  const selection = selectDrawingLod(hierarchy, {
    toleranceClass: "selectedEdit",
    visibleWidthCssPx: 8,
    maxVerticesPerCssPx: 2.5,
  });

  assert.equal(selection.vertexBudget, 20);
  assert.equal(selection.capSatisfied, true);
  assert.ok(selection.selectedPointCount <= selection.vertexBudget);
  assert.ok(selection.effectiveToleranceCssPx > selection.baseToleranceCssPx);
  assert.equal(selection.pointIndexes[0], 0);
  assert.equal(selection.pointIndexes.at(-1), 599);
  for (const pointIndex of selection.pointIndexes.slice(1, -1)) {
    const importance = hierarchy.importanceCssPx[pointIndex];
    assert.ok(importance !== undefined && importance > selection.effectiveToleranceCssPx);
  }
  const deltas = Array.from(selection.pointIndexes.slice(1)).map((pointIndex, index) => (
    pointIndex - Number(selection.pointIndexes[index])
  ));
  assert.ok(new Set(deltas).size > 1, "adaptive error selection must not degenerate into fixed-N sampling");
});

test("finite points that fit the vertex budget preserve the uncapped multi-path selection", () => {
  const raw = coordinateBuffer([
    [0, 0], [1, 2], [2, 0], [3, 3], [4, 0],
    null,
    [6, 1], [7, 4], [8, 1], [9, 5], [10, 1],
  ]);
  const hierarchy = createDrawingLodHierarchy(raw);
  assert.equal(hierarchy.finitePointCount, 10);

  const uncapped = selectDrawingLod(hierarchy, {
    toleranceClass: "normalStatic",
    visibleWidthCssPx: 10_000,
    maxVerticesPerCssPx: 2,
  });
  const exactFit = selectDrawingLod(hierarchy, {
    toleranceClass: "normalStatic",
    visibleWidthCssPx: 5,
    maxVerticesPerCssPx: 2,
  });

  assert.equal(exactFit.vertexBudget, hierarchy.finitePointCount);
  assert.equal(exactFit.effectiveToleranceCssPx, exactFit.baseToleranceCssPx);
  assert.equal(exactFit.capSatisfied, true);
  assert.deepEqual(indexes(exactFit), indexes(uncapped));
  assert.deepEqual(Array.from(exactFit.pathBreaks), Array.from(uncapped.pathBreaks));
  assert.deepEqual(exactFit.paths, uncapped.paths);
  for (const path of hierarchy.paths) {
    assert.ok(exactFit.pointIndexes.includes(path.startPointIndex));
    assert.ok(exactFit.pointIndexes.includes(path.endPointIndex - 1));
  }

  const pressured = selectDrawingLod(hierarchy, {
    toleranceClass: "normalStatic",
    visibleWidthCssPx: 2.5,
    maxVerticesPerCssPx: 2,
  });
  assert.equal(pressured.vertexBudget, 5);
  assert.equal(pressured.capSatisfied, true);
  assert.ok(pressured.selectedPointCount <= pressured.vertexBudget);
  assert.ok(pressured.effectiveToleranceCssPx >= pressured.baseToleranceCssPx);
  for (const path of hierarchy.paths) {
    assert.ok(pressured.pointIndexes.includes(path.startPointIndex));
    assert.ok(pressured.pointIndexes.includes(path.endPointIndex - 1));
  }
});

test("forced path endpoints remain even when their count exceeds the pixel budget", () => {
  const raw = coordinateBuffer([
    [0, 0], null, [2, 2], null, [4, 4], null, [6, 6],
  ]);
  const selection = selectDrawingLod(createDrawingLodHierarchy(raw), {
    toleranceClass: "continuousViewport",
    visibleWidthCssPx: 1,
  });

  assert.equal(selection.vertexBudget, 3);
  assert.equal(selection.capSatisfied, false);
  assert.equal(selection.effectiveToleranceCssPx, Number.POSITIVE_INFINITY);
  assert.deepEqual(indexes(selection), [0, 2, 4, 6]);
});

test("balanced hierarchy construction bounds adversarial distance work", () => {
  const pointCount = 8_192;
  const raw = coordinateBuffer(Array.from({ length: pointCount }, (_, index) => [
    index,
    index % 2 === 0 ? -1_000 : 1_000,
  ] as const));
  const hierarchy = createDrawingLodHierarchy(raw);
  const logarithmicWorkBound = pointCount * Math.ceil(Math.log2(pointCount));

  assert.equal(hierarchy.finitePointCount, pointCount);
  assert.ok(hierarchy.distanceCheckCount <= logarithmicWorkBound,
    `distance work ${hierarchy.distanceCheckCount} exceeded ${logarithmicWorkBound}`);
  assert.equal(hierarchy.importanceCssPx[0], Number.POSITIVE_INFINITY);
  assert.equal(hierarchy.importanceCssPx.at(-1), Number.POSITIVE_INFINITY);
});

test("minimum importance floor preserves supported selections while pruning refinement work", () => {
  const raw = coordinateBuffer(Array.from({ length: 1_024 }, (_, index) => [
    index,
    Math.sin(index * 0.04) * 20 + Math.sin(index * 0.2),
  ] as const));
  const complete = createDrawingLodHierarchy(raw);
  const pruned = createDrawingLodHierarchy(raw, { minimumImportanceCssPx: 0.5 });
  const completeSelection = selectDrawingLod(complete, {
    toleranceClass: "settledExact",
    simplificationToleranceCssPx: 0.5,
    visibleWidthCssPx: 1_024,
  });
  const prunedSelection = selectDrawingLod(pruned, {
    toleranceClass: "settledExact",
    simplificationToleranceCssPx: 0.5,
    visibleWidthCssPx: 1_024,
  });

  assert.deepEqual(indexes(prunedSelection), indexes(completeSelection));
  assert.ok(pruned.distanceCheckCount < complete.distanceCheckCount);
  assert.throws(
    () => createDrawingLodHierarchy(raw, { minimumImportanceCssPx: -0.1 }),
    /minimum importance/,
  );
  assert.throws(
    () => createDrawingLodHierarchy(raw, { importanceBuffer: new Float64Array(2) }),
    /importance buffer length/,
  );
});

test("explicit simplification tolerance is validated within its LOD class", () => {
  const hierarchy = createDrawingLodHierarchy(coordinateBuffer([
    [0, 0], [1, 0.1], [2, 0],
  ]));
  assert.equal(selectDrawingLod(hierarchy, {
    toleranceClass: "normalStatic",
    simplificationToleranceCssPx: 0.25,
    visibleWidthCssPx: 100,
  }).baseToleranceCssPx, 0.25);
  assert.throws(() => selectDrawingLod(hierarchy, {
    toleranceClass: "normalStatic",
    simplificationToleranceCssPx: 0.8,
    visibleWidthCssPx: 100,
  }), /simplification tolerance/i);
});

test("byte-weighted LRU evicts least-recently-used bytes and exposes an immutable snapshot", () => {
  const removals: Array<readonly [string, string, DrawingByteLruRemovalReason]> = [];
  const cache = new DrawingByteWeightedLruCache<string, string>({
    budgetBytes: 10,
    onRemove(value, key, reason) {
      removals.push([key, value, reason]);
    },
  });

  assert.equal(cache.set("a", "A", 6), true);
  assert.equal(cache.set("b", "B", 4), true);
  assert.equal(cache.get("a"), "A", "get must refresh recency");
  assert.equal(cache.get("missing"), undefined);
  assert.equal(cache.set("c", "C", 4), true);
  assert.equal(cache.totalBytes(), 10, "byte gauges must not materialize snapshot keys");
  assert.deepEqual(cache.snapshot(), {
    budgetBytes: 10,
    hardLimitBytes: DRAWING_LOD_MAX_CACHE_BUDGET_BYTES,
    totalBytes: 10,
    entryCount: 2,
    hitCount: 1,
    missCount: 1,
    budgetEvictionCount: 1,
    disposed: false,
    keysOldestFirst: ["a", "c"],
  });
  assert.deepEqual(removals, [["b", "B", "budget"]]);

  assert.equal(cache.delete("a"), true);
  cache.clear();
  assert.deepEqual(removals.slice(-2), [
    ["a", "A", "delete"],
    ["c", "C", "clear"],
  ]);
  assert.equal(cache.snapshot().totalBytes, 0);
  assert.equal(cache.totalBytes(), 0);
});

test("LRU enforces default/hard budgets and cleans replacement, oversize, and dispose values", () => {
  const defaultCache = new DrawingByteWeightedLruCache<string, string>();
  assert.equal(defaultCache.snapshot().budgetBytes, DRAWING_LOD_DEFAULT_CACHE_BUDGET_BYTES);

  const removals: Array<readonly [string, DrawingByteLruRemovalReason]> = [];
  const cache = new DrawingByteWeightedLruCache<string, string>({
    budgetBytes: DRAWING_LOD_MAX_CACHE_BUDGET_BYTES + 1,
    onRemove(value, _key, reason) {
      removals.push([value, reason]);
    },
  });
  assert.equal(cache.snapshot().budgetBytes, DRAWING_LOD_MAX_CACHE_BUDGET_BYTES);
  assert.equal(cache.set("key", "first", 1), true);
  assert.equal(cache.set("key", "second", 2), true);
  assert.deepEqual(removals, [["first", "replace"]]);

  assert.equal(cache.set("oversize", "large", DRAWING_LOD_MAX_CACHE_BUDGET_BYTES + 1), false);
  assert.deepEqual(removals.at(-1), ["large", "oversize"]);
  cache.dispose();
  assert.equal(cache.snapshot().disposed, true);
  assert.equal(cache.snapshot().entryCount, 0);
  assert.deepEqual(removals.at(-1), ["second", "dispose"]);
  assert.equal(cache.set("late", "late-value", 1), false);
  assert.deepEqual(removals.at(-1), ["late-value", "dispose"]);
});
