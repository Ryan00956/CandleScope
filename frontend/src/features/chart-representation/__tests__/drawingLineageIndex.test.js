import assert from "node:assert/strict";
import test from "node:test";

import { createDrawingLineageIndex } from "../drawingLineageIndex.js";

function displayRow(order, sourceTime, sourceOrdinal = 0, {
  from = sourceTime,
  projectorId = "renko",
  to = sourceTime,
} = {}) {
  return {
    time: { order, sourceTime, sourceOrdinal },
    customValues: {
      chartProjection: {
        projectorId,
        sourceFromTime: from,
        sourceOrdinal,
        sourceToTime: to,
      },
    },
  };
}

test("drawing lineage index replaces only the changed synthetic tail", () => {
  const size = 2_000;
  const previousRows = Array.from(
    { length: size },
    (_, index) => displayRow(index, 1_000 + index),
  );
  const index = createDrawingLineageIndex(previousRows);
  const revision = index.revision;

  for (const row of previousRows.slice(0, -1)) {
    const customValues = row.customValues;
    Object.defineProperty(row, "customValues", {
      configurable: true,
      get() {
        throw new Error("stable prefix metadata was rescanned");
      },
      set(value) {
        Object.defineProperty(row, "customValues", {
          configurable: true,
          value,
          writable: true,
        });
      },
    });
    assert.ok(customValues);
  }

  const nextTail = displayRow(size - 1, 9_999, 2, { from: 2_999, to: 9_999 });
  const nextRows = previousRows.slice(0, -1).concat(nextTail);
  assert.equal(index.replaceTail({
    previousSeriesData: previousRows,
    fromOutputIndex: size - 1,
    insert: [nextTail],
    nextSeriesData: nextRows,
  }), true);

  assert.strictEqual(index.seriesData, nextRows);
  assert.equal(index.revision, revision + 1);
  assert.equal(index.exactRowsBySourceTime.has(1_000 + size - 1), false);
  assert.deepEqual(index.exactRowsBySourceTime.get(9_999), [nextTail]);
  assert.strictEqual(index.rowRanges[index.rowRanges.length - 1].row, nextTail);
  assert.equal(index.latestLineage, 9_999);
});

test("drawing lineage index restores prefix aggregates after a tail retraction", () => {
  const rows = [
    displayRow(0, 100, 0, { from: 80, to: 100 }),
    displayRow(1, 200, 0, { from: 101, to: 200 }),
    displayRow(2, 200, 1, { from: 101, to: 200 }),
  ];
  const index = createDrawingLineageIndex(rows);
  const nextTail = displayRow(1, 150, 0, { from: 101, to: 150 });
  const nextRows = [rows[0], nextTail];

  assert.equal(index.replaceTail({
    previousSeriesData: rows,
    fromOutputIndex: 1,
    insert: [nextTail],
    nextSeriesData: nextRows,
  }), true);

  assert.equal(index.currentProjection, "renko");
  assert.equal(index.latestLineage, 150);
  assert.equal(index.rowRangesMonotonic, true);
  assert.equal(index.exactRowsBySourceTime.has(200), false);
  assert.deepEqual(index.exactRowsBySourceTime.get(150), [nextTail]);
  assert.deepEqual(index.ordinalRows, nextRows);
});

test("drawing lineage reset rolls back atomically when projected metadata throws", () => {
  const initialRows = [displayRow(0, 100), displayRow(1, 200)];
  const index = createDrawingLineageIndex(initialRows);
  const initialExactRows = index.exactRowsBySourceTime;
  const initialRanges = index.rowRanges;
  const initialRevision = index.revision;
  const hostileRow = displayRow(0, 300);
  Object.defineProperty(hostileRow, "customValues", {
    configurable: true,
    get() {
      throw new Error("hostile projection metadata");
    },
  });

  assert.throws(() => index.reset([hostileRow]), /hostile projection metadata/);
  assert.strictEqual(index.seriesData, initialRows);
  assert.strictEqual(index.exactRowsBySourceTime, initialExactRows);
  assert.strictEqual(index.rowRanges, initialRanges);
  assert.equal(index.revision, initialRevision);
  assert.deepEqual(index.ordinalRows, initialRows);
});
