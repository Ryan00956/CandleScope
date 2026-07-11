import assert from "node:assert/strict";
import test from "node:test";

import { createProjector } from "../projectorFactory.js";
import { PointFigureProjector } from "../projectors/pointFigureProjector.js";

function row(time, close, customValues) {
  return { time, open: close, high: close, low: close, close, customValues };
}

function body(point) {
  return {
    close: point.close,
    high: point.high,
    low: point.low,
    open: point.open,
  };
}

test("PointFigureProjector validates fixed-box tick and reversal options", () => {
  assert.throws(() => new PointFigureProjector({ boxSize: 0 }), /positive finite/);
  assert.throws(() => new PointFigureProjector({ minTick: -0.01 }), /positive finite/);
  assert.throws(() => new PointFigureProjector({ reversalAmount: 0 }), /positive safe integer/);
  assert.throws(() => new PointFigureProjector({ reversalAmount: 1.5 }), /positive safe integer/);
  assert.throws(
    () => new PointFigureProjector({ boxSize: 0.15, minTick: 0.1 }),
    /integer multiple/,
  );
});

test("projector factory registers Point & Figure runtime options", () => {
  const projector = createProjector("point-and-figure", {
    boxSize: 2,
    minTick: 0.5,
    reversalAmount: 4,
  });
  assert.ok(projector instanceof PointFigureProjector);
  assert.equal(projector.boxTicks, 4);
  assert.equal(projector.reversalAmount, 4);
});

test("close-only projection emits one semantic OHLC item per X/O column", () => {
  const data = new PointFigureProjector({ boxSize: 2, minTick: 0.1 }).project([
    row(1, 52.9),
    row(2, 54),
    row(3, 58.9, { venue: "demo" }),
    row(4, 52),
  ]);

  assert.deepEqual(data.map(body), [
    { open: 54, high: 58, low: 54, close: 58 },
    { open: 56, high: 56, low: 52, close: 52 },
  ]);
  assert.deepEqual(data.map((point) => point.time), [
    { order: 0, sourceTime: 3, sourceOrdinal: 0 },
    { order: 1, sourceTime: 4, sourceOrdinal: 0 },
  ]);
  assert.equal(data[0].customValues.venue, "demo");
  assert.deepEqual(data[0].customValues.chartProjection, {
    projectorId: "point-and-figure",
    sourceFromTime: 1,
    sourceToTime: 3,
    sourceOrdinal: 0,
    synthetic: true,
    provisional: false,
  });
  assert.equal(data[1].customValues.chartProjection.sourceFromTime, 3);
  assert.deepEqual(data[1].customValues.pointAndFigure, {
    direction: "o",
    boxSize: 2,
    reversalAmount: 3,
    source: "close",
  });
});

test("default three-box reversal ignores smaller counter moves and works after O columns", () => {
  const data = new PointFigureProjector({ boxSize: 2, minTick: 1 }).project([
    row(1, 60),
    row(2, 58),
    row(3, 62),
    row(4, 64),
  ]);

  assert.deepEqual(data.map(body), [
    { open: 58, high: 58, low: 58, close: 58 },
    { open: 60, high: 64, low: 60, close: 64 },
  ]);
  assert.deepEqual(
    data.map((point) => point.customValues.pointAndFigure.direction),
    ["o", "x"],
  );
});

test("reversalAmount is configurable down to one box", () => {
  const data = new PointFigureProjector({
    boxSize: 1,
    minTick: 1,
    reversalAmount: 1,
  }).project([
    row(1, 10),
    row(2, 12),
    row(3, 11),
  ]);

  assert.deepEqual(data.map(body), [
    { open: 11, high: 12, low: 11, close: 12 },
    { open: 11, high: 11, low: 11, close: 11 },
  ]);
});

test("integer tick construction avoids floating point drift", () => {
  const data = new PointFigureProjector({ boxSize: 0.1, minTick: 0.01 }).project([
    row(1, 0.24),
    row(2, 0.5),
    row(3, 0.2),
  ]);

  assert.deepEqual(data.map(body), [
    { open: 0.3, high: 0.5, low: 0.3, close: 0.5 },
    { open: 0.4, high: 0.4, low: 0.2, close: 0.2 },
  ]);
});

test("seeded projection replaces an extended column and appends only on reversal", () => {
  const projector = new PointFigureProjector({ boxSize: 1, minTick: 1 });
  const first = projector.projectWithState([row(1, 10), row(2, 11)]);
  const resumed = projector.projectWithState([row(3, 13), row(4, 10)], {
    seedState: first.state,
  });

  assert.deepEqual(first.data.map(body), [
    { open: 11, high: 11, low: 11, close: 11 },
  ]);
  assert.deepEqual(resumed.data.map(body), [
    { open: 11, high: 13, low: 11, close: 13 },
    { open: 12, high: 12, low: 10, close: 10 },
  ]);
  assert.deepEqual(resumed.data.map((point) => point.time.order), [0, 1]);
  assert.equal(resumed.checkpoints.length, 2);
  assert.equal(resumed.state.nextOrder, 2);
});

test("seeded projection carries the active column when retained rows do not change it", () => {
  const projector = new PointFigureProjector({ boxSize: 1, minTick: 1 });
  const first = projector.projectWithState([row(1, 10), row(2, 11, { venue: "seed" })]);
  const resumed = projector.projectWithState([row(3, 11)], {
    seedState: first.state,
  });

  assert.deepEqual(resumed.data.map(body), [
    { open: 11, high: 11, low: 11, close: 11 },
  ]);
  assert.equal(resumed.data[0].time.order, 0);
  assert.equal(resumed.data[0].time.sourceTime, 2);
  assert.equal(resumed.data[0].customValues.venue, "seed");
  assert.equal(resumed.state.columnOrder, 0);
});

test("seeded projection does not carry a column into an empty source window", () => {
  const projector = new PointFigureProjector({ boxSize: 1, minTick: 1 });
  const first = projector.projectWithState([row(1, 10), row(2, 11)]);
  const resumed = projector.projectWithState([], { seedState: first.state });

  assert.deepEqual(resumed.data, []);
  assert.equal(resumed.state.columnOrder, 0);
});

test("checkpoints preserve the path before each source row", () => {
  const projector = new PointFigureProjector({ boxSize: 1, minTick: 1 });
  const projected = projector.projectWithState([
    row(1, 10),
    row(2, 12),
    row(3, 9),
  ]);

  const resumed = projector.projectWithState([row(3, 9)], {
    seedState: projected.checkpoints[2],
  });
  assert.deepEqual(resumed.data.map(body), [
    { open: 11, high: 12, low: 11, close: 12 },
    { open: 11, high: 11, low: 9, close: 9 },
  ]);
  assert.deepEqual(resumed.data.map((point) => point.time.order), [0, 1]);
  assert.throws(
    () => new PointFigureProjector({ boxSize: 2, minTick: 1 })
      .projectWithState([], { seedState: projected.state }),
    /incompatible/,
  );
});

test("provisional projection state is carried in source lineage", () => {
  const data = new PointFigureProjector({ boxSize: 1, minTick: 1 }).project(
    [row(1, 10), row(2, 11)],
    { provisional: true },
  );

  assert.equal(data[0].customValues.chartProjection.provisional, true);
});

test("provisional seeded projection does not mutate confirmed state or checkpoints", () => {
  const projector = new PointFigureProjector({ boxSize: 1, minTick: 1 });
  const confirmed = projector.projectWithState([
    row(1, 10),
    row(2, 11, { phase: "confirmed" }),
  ]);
  const confirmedCheckpoint = confirmed.state;

  const trial = projector.projectWithState([row(3, 13, { phase: "trial" })], {
    provisional: true,
    seedState: confirmedCheckpoint,
  });

  assert.equal(trial.data.length, 1);
  assert.equal(trial.data[0].high, 13);
  assert.equal(trial.data[0].customValues.chartProjection.provisional, true);
  assert.equal(trial.checkpoints[0].columnHighTicks, 11);
  assert.equal(trial.checkpoints[0].columnCustomValues.phase, "confirmed");
  assert.equal(confirmedCheckpoint.columnHighTicks, 11);
  assert.equal(confirmedCheckpoint.columnSourceToTime, 2);
  assert.equal(confirmedCheckpoint.columnCustomValues.phase, "confirmed");

  const resumedConfirmed = projector.projectWithState([row(3, 12)], {
    seedState: confirmedCheckpoint,
  });
  assert.equal(resumedConfirmed.data[0].high, 12);
  assert.equal(resumedConfirmed.data[0].customValues.chartProjection.provisional, false);
});

test("provisional reversal keeps the confirmed column and marks only the new column projected", () => {
  const projector = new PointFigureProjector({ boxSize: 1, minTick: 1 });
  const confirmed = projector.projectWithState([
    row(1, 10),
    row(2, 13),
  ]);
  const trial = projector.projectWithState([row(3, 10)], {
    provisional: true,
    seedState: confirmed.state,
  });

  assert.deepEqual(
    trial.data.map((point) => [
      point.customValues.pointAndFigure.direction,
      point.customValues.chartProjection.provisional,
    ]),
    [["x", false], ["o", true]],
  );
});

test("whitespace and invalid closes do not initialize or advance columns", () => {
  const projector = new PointFigureProjector({ boxSize: 1, minTick: 1 });
  const projected = projector.projectWithState([
    { time: 1, close: 10, __whitespace: true },
    row(2, ""),
    row(3, 10),
    row(4, 11),
  ]);

  assert.deepEqual(projected.data.map(body), [
    { open: 11, high: 11, low: 11, close: 11 },
  ]);
  assert.equal(projected.data[0].customValues.chartProjection.sourceFromTime, 3);
  assert.equal(projected.checkpoints.length, 4);
});
