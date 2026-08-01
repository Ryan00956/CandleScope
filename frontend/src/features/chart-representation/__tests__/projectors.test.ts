import assert from "node:assert/strict";
import test from "node:test";

import { HeikinAshiProjector } from "../projectors/heikinAshiProjector.js";
import { IdentityProjector } from "../projectors/identityProjector.js";
import { KagiProjector } from "../projectors/kagiProjector.js";
import { LineBreakProjector } from "../projectors/lineBreakProjector.js";
import { PointFigureProjector } from "../projectors/pointFigureProjector.js";
import { RenkoProjector } from "../projectors/renkoProjector.js";
import { mustBeDefined } from "../../../test/testHelpers.js";

const rows = [
  { time: 60, open: 100, high: 110, low: 90, close: 106, volume: 1000 },
  { time: 120, open: 106, high: 116, low: 100, close: 112, volume: 1200 },
];

test("HeikinAshiProjector implements the full recursive OHLC formula", () => {
  const projected = new HeikinAshiProjector().project(rows);
  const first = mustBeDefined(projected[0]);
  const second = mustBeDefined(projected[1]);

  assert.deepEqual(
    { open: first.open, high: first.high, low: first.low, close: first.close },
    { open: 103, high: 110, low: 90, close: 101.5 },
  );
  assert.deepEqual(
    { open: second.open, high: second.high, low: second.low, close: second.close },
    { open: 102.25, high: 116, low: 100, close: 108.5 },
  );
  assert.equal(second.volume, 1200);
  assert.deepEqual(mustBeDefined(second.customValues).chartProjection, {
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
  const display = mustBeDefined(new IdentityProjector().project([source])[0]);

  for (const [key, value] of Object.entries(source)) {
    if (key !== "customValues") assert.equal(display[key], value);
  }
  const customValues = mustBeDefined(display.customValues);
  const projection = mustBeDefined(customValues.chartProjection);
  assert.equal(customValues.venue, "demo");
  assert.equal(projection.projectorId, "identity");
  assert.equal(projection.sourceFromTime, 60);
});

test("derived projectors retain the full revealed source range of coarse rows", () => {
  const coarseRows = [
    {
      time: 100,
      sourceFromTime: 100,
      sourceToTime: 107,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
    },
    {
      time: 115,
      sourceFromTime: 115,
      sourceToTime: 122,
      open: 100,
      high: 130,
      low: 99,
      close: 130,
    },
  ];
  const projectors = [
    new RenkoProjector({ boxSize: 1 }),
    new LineBreakProjector({ numberOfLines: 1 }),
    new KagiProjector({ reversalTicks: 1 }),
    new PointFigureProjector({ boxSize: 1, reversalAmount: 1 }),
  ];

  for (const projector of projectors) {
    const projected = projector.project(coarseRows);
    assert.ok(projected.length > 0, `${projector.id} should emit a row`);
    const latestSourceTo = Math.max(...projected.map((row) => (
      Number(row.customValues?.chartProjection?.sourceToTime)
    )));
    assert.equal(latestSourceTo, 122, projector.id);
  }
});
