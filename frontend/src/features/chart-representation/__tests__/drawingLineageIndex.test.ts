import assert from "node:assert/strict";
import test from "node:test";

import { createDrawingLineageIndex } from "../drawingLineageIndex.js";
import type { DisplayRow } from "../chartRepresentationTypes.js";
import { mustBeDefined } from "../../../test/testHelpers.js";

function displayRow(order: number, sourceTime: number, sourceOrdinal = 0, {
  from = sourceTime,
  projectorId = "renko",
  to = sourceTime,
}: { from?: number; projectorId?: string; to?: number } = {}): DisplayRow {
  return {
    time: { order, sourceTime, sourceOrdinal },
    customValues: {
      chartProjection: {
        projectorId,
        sourceFromTime: from,
        sourceOrdinal,
        sourceToTime: to,
        synthetic: true,
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
  assert.strictEqual(mustBeDefined(index.rowRanges.at(-1)).row, nextTail);
  assert.equal(index.latestLineage, 9_999);
});

test("stable drawing lineage snapshots do not drift with a mutable store tail", () => {
  const rows = [
    displayRow(0, 100, 0, { from: 80, to: 100 }),
    displayRow(1, 200, 0, { from: 101, to: 200 }),
  ];
  const index = createDrawingLineageIndex(rows);
  const snapshot = index.stableSnapshot();
  const snapshotRevision = snapshot.revision;
  const replacement = displayRow(1, 250, 0, { from: 101, to: 250 });
  const nextRows = [mustBeDefined(rows[0]), replacement];

  assert.notStrictEqual(snapshot, index);
  assert.notStrictEqual(snapshot.exactRowsBySourceTime, index.exactRowsBySourceTime);
  assert.notStrictEqual(snapshot.ordinalRows, index.ordinalRows);
  assert.equal(index.replaceTail({
    previousSeriesData: rows,
    fromOutputIndex: 1,
    insert: [replacement],
    nextSeriesData: nextRows,
  }), true);

  assert.equal(snapshot.revision, snapshotRevision);
  assert.strictEqual(snapshot.seriesData, rows);
  assert.deepEqual(snapshot.exactRowsBySourceTime.get(200), [rows[1]]);
  assert.equal(snapshot.exactRowsBySourceTime.has(250), false);
  assert.deepEqual(snapshot.rowsOverlappingSourceEnvelope({
    fromTime: 150,
    toTime: 200,
  }), { first: rows[1], last: rows[1] });
  assert.strictEqual(index.seriesData, nextRows);
  assert.equal(index.exactRowsBySourceTime.has(200), false);
  assert.deepEqual(index.exactRowsBySourceTime.get(250), [replacement]);
});

test("drawing lineage index restores prefix aggregates after a tail retraction", () => {
  const rows = [
    displayRow(0, 100, 0, { from: 80, to: 100 }),
    displayRow(1, 200, 0, { from: 101, to: 200 }),
    displayRow(2, 200, 1, { from: 101, to: 200 }),
  ];
  const index = createDrawingLineageIndex(rows);
  const nextTail = displayRow(1, 150, 0, { from: 101, to: 150 });
  const nextRows = [mustBeDefined(rows[0]), nextTail];

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

test("drawing lineage index resolves monotonic source envelopes including repeated rows", () => {
  const rows = [
    displayRow(0, 100, 0, { from: 80, to: 100 }),
    displayRow(1, 200, 0, { from: 101, to: 200 }),
    displayRow(2, 200, 1, { from: 200, to: 200 }),
    displayRow(3, 300, 0, { from: 201, to: 300 }),
  ];
  const index = createDrawingLineageIndex(rows);

  assert.deepEqual(index.rowsOverlappingSourceEnvelope({
    fromTime: 200,
    toTime: 200,
  }), {
    first: rows[1],
    last: rows[2],
  });
  assert.deepEqual(index.rowsOverlappingSourceEnvelope({
    fromTime: 90,
    toTime: 250,
  }), {
    first: rows[0],
    last: rows[3],
  });
  assert.equal(index.rowsOverlappingSourceEnvelope({
    fromTime: 301,
    toTime: 400,
  }), null);
});

test("drawing lineage index fails closed for non-monotonic source envelopes", () => {
  const rows = [
    displayRow(0, 300, 0, { from: 200, to: 300 }),
    displayRow(1, 150, 0, { from: 100, to: 150 }),
    displayRow(2, 250, 0, { from: 151, to: 250 }),
  ];
  const index = createDrawingLineageIndex(rows);
  assert.equal(index.rowRangesMonotonic, false);

  assert.equal(index.rowsOverlappingSourceEnvelope({
    fromTime: 140,
    toTime: 220,
  }), null);
});

test("drawing lineage index fails closed across an internal lineage hole", () => {
  const rows = [
    displayRow(0, 10, 0, { from: 0, to: 10 }),
    displayRow(1, 110, 0, { from: 100, to: 110 }),
  ];
  const index = createDrawingLineageIndex(rows);
  assert.equal(index.rowRangesMonotonic, true);

  assert.equal(index.rowsOverlappingSourceEnvelope({
    fromTime: 5,
    toTime: 105,
  }), null);
  assert.deepEqual(index.rowsOverlappingSourceEnvelope({
    fromTime: 100,
    toTime: 105,
  }), { first: rows[1], last: rows[1] });
});

test("drawing lineage index restores coverage groups after replacing a gapped tail", () => {
  const rows = [
    displayRow(0, 10, 0, { from: 0, to: 10 }),
    displayRow(1, 110, 0, { from: 100, to: 110 }),
  ];
  const index = createDrawingLineageIndex(rows);
  const replacement = displayRow(1, 20, 0, { from: 11, to: 20 });
  const nextRows = [mustBeDefined(rows[0]), replacement];

  assert.equal(index.replaceTail({
    previousSeriesData: rows,
    fromOutputIndex: 1,
    insert: [replacement],
    nextSeriesData: nextRows,
  }), true);
  assert.deepEqual(index.rowsOverlappingSourceEnvelope({
    fromTime: 5,
    toTime: 15,
  }), { first: mustBeDefined(rows[0]), last: replacement });
});
