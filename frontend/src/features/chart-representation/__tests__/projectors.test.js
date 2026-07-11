import assert from "node:assert/strict";
import test from "node:test";

import { HeikinAshiProjector } from "../projectors/heikinAshiProjector.js";
import { IdentityProjector } from "../projectors/identityProjector.js";

const rows = [
  { time: 60, open: 100, high: 110, low: 90, close: 106, volume: 1000 },
  { time: 120, open: 106, high: 116, low: 100, close: 112, volume: 1200 },
];

test("HeikinAshiProjector implements the full recursive OHLC formula", () => {
  const [first, second] = new HeikinAshiProjector().project(rows);

  assert.deepEqual(
    { open: first.open, high: first.high, low: first.low, close: first.close },
    { open: 103, high: 110, low: 90, close: 101.5 },
  );
  assert.deepEqual(
    { open: second.open, high: second.high, low: second.low, close: second.close },
    { open: 102.25, high: 116, low: 100, close: 108.5 },
  );
  assert.equal(second.volume, 1200);
  assert.deepEqual(second.customValues.chartProjection, {
    projectorId: "heikin-ashi",
    sourceFromTime: 120,
    sourceToTime: 120,
    sourceOrdinal: 0,
    synthetic: true,
  });
});

test("IdentityProjector preserves source fields and adds LWC customValues lineage", () => {
  const source = {
    time: 60,
    open: 1,
    high: 3,
    low: 0,
    close: 2,
    volume: 42,
    color: "#123456",
    customValues: { venue: "demo" },
  };
  const [display] = new IdentityProjector().project([source]);

  for (const [key, value] of Object.entries(source)) {
    if (key !== "customValues") assert.equal(display[key], value);
  }
  assert.equal(display.customValues.venue, "demo");
  assert.equal(display.customValues.chartProjection.projectorId, "identity");
  assert.equal(display.customValues.chartProjection.sourceFromTime, 60);
});
