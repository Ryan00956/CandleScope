import assert from "node:assert/strict";
import test from "node:test";

import {
  createDrawingCoordinateIndex,
  type NumericTimeSearchResult,
} from "../drawingCoordinateIndex.js";
import { createDrawingLineageIndex } from "../../features/chart-representation/drawingLineageIndex.js";
import type { DisplayRow } from "../../features/chart-representation/chartRepresentationTypes.js";

function numericRows(...times: number[]): DisplayRow[] {
  return times.map((time) => ({ time }));
}

function ordinalRow(order: number, sourceTime: number, sourceOrdinal: number): DisplayRow {
  return { time: { order, sourceTime, sourceOrdinal } };
}

function compact(result: NumericTimeSearchResult | null): object | null {
  if (!result) return null;
  return {
    exactIndex: result.exactIndex,
    leftIndex: result.leftIndex,
    position: result.position,
    ratio: result.ratio,
    rightIndex: result.rightIndex,
    targetTime: result.targetTime,
  };
}

test("numeric coordinate index validates once and exposes Float64 exact lookup", () => {
  const rows = numericRows(100, 200, 400);
  const index = createDrawingCoordinateIndex(rows);

  assert.equal(index.mode, "numeric");
  assert.equal(index.valid, true);
  assert.equal(index.issue, null);
  assert.equal(index.validationCount, 1);
  assert.equal(index.stats.numericValidationCount, 1);
  assert.ok(index.numericTimes instanceof Float64Array);
  assert.deepEqual(Array.from(index.numericTimes), [100, 200, 400]);
  assert.equal(index.findExactNumericIndex(200), 1);
  assert.strictEqual(index.findExactNumericRow(400), rows[2]);
  assert.equal(index.findExactNumericIndex(250), null);

  index.searchNumericTime(250);
  index.searchNumericTime(300);
  assert.equal(index.validationCount, 1);
});

test("numeric binary search preserves exact, fractional, and absolute extrapolation semantics", () => {
  const index = createDrawingCoordinateIndex(numericRows(100, 200, 400));

  assert.deepEqual(compact(index.searchNumericTime(200)), {
    exactIndex: 1,
    leftIndex: 1,
    position: "exact",
    ratio: 0,
    rightIndex: 1,
    targetTime: 200,
  });
  assert.deepEqual(compact(index.searchNumericTime(250)), {
    exactIndex: null,
    leftIndex: 1,
    position: "between",
    ratio: 0.25,
    rightIndex: 2,
    targetTime: 250,
  });
  assert.deepEqual(compact(index.searchNumericTime(50)), {
    exactIndex: null,
    leftIndex: 0,
    position: "before",
    ratio: -0.5,
    rightIndex: 1,
    targetTime: 50,
  });
  assert.deepEqual(compact(index.searchNumericTime(500)), {
    exactIndex: null,
    leftIndex: 1,
    position: "after",
    ratio: 1.5,
    rightIndex: 2,
    targetTime: 500,
  });
  assert.equal(index.searchNumericTime(Number.NaN), null);
});

test("ordered numeric batch uses one merge-walk", () => {
  const index = createDrawingCoordinateIndex(numericRows(100, 200, 400, 800));
  const resolved = index.resolveNumericBatch([50, 100, 150, 400, 400, 900]);

  assert.deepEqual(resolved.map(compact), [
    {
      exactIndex: null,
      leftIndex: 0,
      position: "before",
      ratio: -0.5,
      rightIndex: 1,
      targetTime: 50,
    },
    {
      exactIndex: 0,
      leftIndex: 0,
      position: "exact",
      ratio: 0,
      rightIndex: 0,
      targetTime: 100,
    },
    {
      exactIndex: null,
      leftIndex: 0,
      position: "between",
      ratio: 0.5,
      rightIndex: 1,
      targetTime: 150,
    },
    {
      exactIndex: 2,
      leftIndex: 2,
      position: "exact",
      ratio: 0,
      rightIndex: 2,
      targetTime: 400,
    },
    {
      exactIndex: 2,
      leftIndex: 2,
      position: "exact",
      ratio: 0,
      rightIndex: 2,
      targetTime: 400,
    },
    {
      exactIndex: null,
      leftIndex: 2,
      position: "after",
      ratio: 1.25,
      rightIndex: 3,
      targetTime: 900,
    },
  ]);
  assert.equal(index.stats.numericBatchMergeWalkCount, 1);
  assert.equal(index.stats.numericBatchFallbackCount, 0);
  assert.equal(index.stats.numericBinarySearchCount, 0);
});

test("unsorted or partly invalid batches fall back safely and preserve input order", () => {
  const index = createDrawingCoordinateIndex(numericRows(100, 200, 400));
  const resolved = index.resolveNumericBatch([400, 150, Number.NaN, 100]);

  assert.deepEqual(resolved.map(compact), [
    {
      exactIndex: 2,
      leftIndex: 2,
      position: "exact",
      ratio: 0,
      rightIndex: 2,
      targetTime: 400,
    },
    {
      exactIndex: null,
      leftIndex: 0,
      position: "between",
      ratio: 0.5,
      rightIndex: 1,
      targetTime: 150,
    },
    null,
    {
      exactIndex: 0,
      leftIndex: 0,
      position: "exact",
      ratio: 0,
      rightIndex: 0,
      targetTime: 100,
    },
  ]);
  assert.equal(index.stats.numericBatchMergeWalkCount, 0);
  assert.equal(index.stats.numericBatchFallbackCount, 1);
  assert.equal(index.stats.numericBinarySearchCount, 3);
});

test("duplicate, unordered, mixed, and invalid numeric data fail closed", () => {
  const duplicate = createDrawingCoordinateIndex(numericRows(100, 100, 200));
  const unordered = createDrawingCoordinateIndex(numericRows(100, 90, 200));
  const mixedRows = [
    { time: 100 },
    ordinalRow(1, 200, 0),
  ] as DisplayRow[];
  const mixed = createDrawingCoordinateIndex(mixedRows);
  const invalid = createDrawingCoordinateIndex([
    { time: 100 },
    { time: Number.NaN },
  ]);

  assert.equal(duplicate.issue, "duplicate-time");
  assert.equal(unordered.issue, "unordered-time");
  assert.equal(mixed.issue, "mixed-axis-time");
  assert.equal(invalid.issue, "invalid-numeric-row");
  for (const index of [duplicate, unordered, mixed, invalid]) {
    assert.equal(index.mode, "invalid");
    assert.equal(index.valid, false);
    assert.equal(index.validationCount, 1);
    assert.equal(index.numericTimes, null);
    assert.equal(index.findExactNumericIndex(100), null);
    assert.equal(index.searchNumericTime(150), null);
    assert.deepEqual(index.resolveNumericBatch([100, 150]), [null, null]);
  }
});

test("ordinal coordinate index reuses lineage and caches same-time ordinals", () => {
  const rows = [
    ordinalRow(0, 100, 0),
    ordinalRow(1, 200, 0),
    ordinalRow(2, 200, 1),
    ordinalRow(3, 200, 2),
  ];
  const lineageIndex = createDrawingLineageIndex(rows);
  const index = createDrawingCoordinateIndex(rows, { lineageIndex });

  assert.equal(index.mode, "ordinal");
  assert.equal(index.valid, true);
  assert.equal(index.validationCount, 0);
  assert.equal(index.lineageRevision, lineageIndex.revision);
  assert.strictEqual(index.findExactOrdinalRow(200, 0), rows[1]);
  assert.strictEqual(index.findExactOrdinalRow(200, 2), rows[3]);
  assert.equal(index.findExactOrdinalRow(200, 9), null);
  assert.equal(index.stats.ordinalSameTimeCacheBuildCount, 1);

  assert.strictEqual(index.findExactOrdinalRow(100, 0), rows[0]);
  assert.equal(index.stats.ordinalSameTimeCacheBuildCount, 2);
  assert.equal(index.findExactOrdinalRow(200, -1), null);
  assert.equal(index.findExactOrdinalRow(Number.NaN, 0), null);

  lineageIndex.reset(rows);
  assert.equal(index.findExactOrdinalRow(200, 1), null);
});

test("ordinal coordinate index rejects missing, mismatched, and ambiguous lineage", () => {
  const rows = [ordinalRow(0, 100, 0), ordinalRow(1, 100, 0)];
  const missing = createDrawingCoordinateIndex(rows);
  const foreignRows = [ordinalRow(0, 100, 0)];
  const foreignLineage = createDrawingLineageIndex(foreignRows);
  const mismatched = createDrawingCoordinateIndex(rows, { lineageIndex: foreignLineage });
  const lineageIndex = createDrawingLineageIndex(rows);
  const ambiguous = createDrawingCoordinateIndex(rows, { lineageIndex });

  assert.equal(missing.issue, "ordinal-lineage-missing");
  assert.equal(mismatched.issue, "ordinal-lineage-mismatch");
  assert.equal(missing.findExactOrdinalRow(100, 0), null);
  assert.equal(mismatched.findExactOrdinalRow(100, 0), null);
  assert.equal(ambiguous.findExactOrdinalRow(100, 0), null);
  assert.equal(ambiguous.stats.ordinalSameTimeCacheBuildCount, 1);
});
