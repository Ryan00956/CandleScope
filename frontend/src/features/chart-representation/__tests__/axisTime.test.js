import assert from "node:assert/strict";
import test from "node:test";

import {
  axisTimeKey,
  compareAxisTime,
  findDisplayIndexForAxisAnchor,
  findLastDisplayIndexForSourceTime,
  isOrdinalAxisTime,
  mapSourceTimeRangeToDisplayLogicalRange,
  mapSourceViewportAnchorToDisplayLogicalRange,
  sourceTimeFromAxisTime,
  sourceTimeFromDisplayRow,
  sourceTimeRangeFromDisplayRow,
} from "../axisTime.js";

function ordinal(order, sourceTime, sourceOrdinal = 0) {
  return { order, sourceTime, sourceOrdinal };
}

function displayRow(order, sourceTime, sourceOrdinal = 0, lineage = null) {
  return {
    time: ordinal(order, sourceTime, sourceOrdinal),
    ...(lineage ? {
      customValues: {
        chartProjection: {
          sourceFromTime: lineage.from,
          sourceToTime: lineage.to,
          sourceOrdinal,
        },
      },
    } : {}),
  };
}

test("ordinal axis items require the complete validated public contract", () => {
  assert.equal(isOrdinalAxisTime(ordinal(0, 100, 0)), true);
  assert.equal(isOrdinalAxisTime(100), false);
  assert.equal(isOrdinalAxisTime({ order: 0, sourceTime: 100 }), false);
  assert.equal(isOrdinalAxisTime(ordinal(0, 100, -1)), false);
  assert.equal(isOrdinalAxisTime(ordinal(0, Number.NaN, 0)), false);
});

test("axis keys and comparisons preserve native time and ordinal ordering", () => {
  assert.equal(axisTimeKey(100), "time:100");
  assert.equal(axisTimeKey(ordinal(7, 100, 2)), "order:7");
  assert.equal(axisTimeKey({ order: "7", sourceTime: 100, sourceOrdinal: 2 }), null);

  assert.equal(compareAxisTime(100, 200), -1);
  assert.equal(compareAxisTime(200, 100), 1);
  assert.equal(compareAxisTime(ordinal(4, 300), ordinal(5, 100)), -1);
  assert.equal(compareAxisTime(ordinal(5, 100), ordinal(5, 300)), 0);
});

test("source time resolves from numeric axes, ordinal axes, and display lineage", () => {
  assert.equal(sourceTimeFromAxisTime(123), 123);
  assert.equal(sourceTimeFromAxisTime(ordinal(9, 456, 2)), 456);
  assert.equal(sourceTimeFromAxisTime("456"), null);

  const row = displayRow(9, 456, 2, { from: 400, to: 450 });
  assert.deepEqual(sourceTimeRangeFromDisplayRow(row), { from: 400, to: 450 });
  assert.equal(sourceTimeFromDisplayRow(row), 450);
  assert.deepEqual(sourceTimeRangeFromDisplayRow({ time: 500 }), { from: 500, to: 500 });
  assert.equal(sourceTimeFromDisplayRow({}), null);
});

test("same-source lookup deliberately selects the last emitted brick", () => {
  const rows = [
    displayRow(0, 100, 0),
    displayRow(1, 100, 1),
    displayRow(2, 200, 0),
  ];

  assert.equal(findLastDisplayIndexForSourceTime(rows, 100), 1);
  assert.equal(findLastDisplayIndexForSourceTime(rows, 200), 2);
  assert.equal(findLastDisplayIndexForSourceTime(rows, 150), -1);
});

test("display anchor lookup ignores reassigned output orders", () => {
  const rows = [
    displayRow(0, 50, 0),
    displayRow(1, 100, 0),
    displayRow(2, 200, 0),
  ];

  // The captured order now belongs to source 100 after structural reprojection.
  assert.equal(findDisplayIndexForAxisAnchor(rows, ordinal(1, 200, 0)), 2);
});

test("display anchor lookup preserves or predecessor-clamps a 1:N source ordinal", () => {
  const rows = [
    displayRow(4, 100, 0),
    displayRow(5, 100, 2),
    displayRow(6, 200, 0),
  ];

  assert.equal(findDisplayIndexForAxisAnchor(rows, ordinal(20, 100, 2)), 1);
  assert.equal(findDisplayIndexForAxisAnchor(rows, ordinal(20, 100, 1)), 0);
  assert.equal(findDisplayIndexForAxisAnchor(rows, ordinal(20, 100, 3)), 1);

  // If every surviving ordinal is to the right, clamp to the first successor.
  assert.equal(
    findDisplayIndexForAxisAnchor([displayRow(5, 100, 2)], ordinal(20, 100, 0)),
    0,
  );
});

test("display anchor lookup uses lineage before causal predecessor fallback", () => {
  const rows = [
    displayRow(0, 100, 0, { from: 80, to: 100 }),
    displayRow(1, 280, 0, { from: 50, to: 280 }),
    displayRow(2, 280, 1, { from: 150, to: 280 }),
    displayRow(3, 280, 2, { from: 150, to: 280 }),
    displayRow(4, 300, 0, { from: 101, to: 300 }),
    displayRow(5, 500, 0, { from: 401, to: 500 }),
  ];

  // Prefer the containing lineage that closes nearest the target, then starts
  // latest, then the last emitted output for an otherwise identical range.
  assert.equal(findDisplayIndexForAxisAnchor(rows, 200), 3);
  assert.equal(findDisplayIndexForAxisAnchor(rows, 350), 4);
});

test("display anchor lookup falls to the first retained row after a left trim", () => {
  const rows = [
    displayRow(10, 300, 0),
    displayRow(11, 400, 0),
  ];

  assert.equal(findDisplayIndexForAxisAnchor(rows, ordinal(2, 200, 0)), 0);
  assert.equal(findDisplayIndexForAxisAnchor([], ordinal(2, 200, 0)), -1);
  assert.equal(findDisplayIndexForAxisAnchor(rows, { order: 2 }), -1);
});

test("source-time ranges map to every overlapping projected element", () => {
  const rows = [
    displayRow(0, 100, 0),
    displayRow(1, 100, 1),
    displayRow(2, 200, 0, { from: 150, to: 200 }),
    displayRow(3, 300, 0),
  ];

  assert.deepEqual(
    mapSourceTimeRangeToDisplayLogicalRange(rows, { from: 100, to: 200 }),
    { from: 0, to: 2 },
  );
  assert.deepEqual(
    mapSourceTimeRangeToDisplayLogicalRange(rows, { from: 125, to: 175 }),
    { from: 2, to: 2 },
  );
  assert.equal(mapSourceTimeRangeToDisplayLogicalRange(rows, { from: 400, to: 500 }), null);
  assert.equal(mapSourceTimeRangeToDisplayLogicalRange(rows, { from: 200, to: 100 }), null);
});

test("viewport anchors preserve span and horizontal offset across projections", () => {
  const rows = [
    displayRow(0, 100, 0),
    displayRow(1, 100, 1),
    displayRow(2, 200, 0),
    displayRow(3, 300, 0),
  ];

  assert.deepEqual(mapSourceViewportAnchorToDisplayLogicalRange(rows, {
    sourceTime: 100,
    logicalSpan: 4,
    screenOffset: -0.5,
  }), { from: -2.5, to: 1.5 });

  // A source bar that emitted no brick falls back to the latest brick at or
  // before that source time.
  assert.deepEqual(mapSourceViewportAnchorToDisplayLogicalRange(rows, {
    sourceTime: 250,
    logicalSpan: 2,
    screenOffset: 0,
  }), { from: 0, to: 2 });

  // An anchor older than the projected window uses the first available brick.
  assert.deepEqual(mapSourceViewportAnchorToDisplayLogicalRange(rows, {
    sourceTime: 50,
    logicalSpan: 2,
    screenOffset: 0,
  }), { from: -2, to: 0 });
  assert.equal(mapSourceViewportAnchorToDisplayLogicalRange([], {
    sourceTime: 100,
    logicalSpan: 2,
  }), null);
});
