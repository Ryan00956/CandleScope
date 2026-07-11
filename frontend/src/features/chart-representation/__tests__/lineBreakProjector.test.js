import assert from "node:assert/strict";
import test from "node:test";

import { createProjector } from "../projectorFactory.js";
import { LineBreakProjector } from "../projectors/lineBreakProjector.js";

function row(time, close, customValues) {
  return { time, open: close, high: close, low: close, close, customValues };
}

function body(point) {
  return {
    open: point.open,
    high: point.high,
    low: point.low,
    close: point.close,
  };
}

test("LineBreakProjector validates minimum-tick and Number of Lines options", () => {
  assert.throws(() => new LineBreakProjector({ minTick: 0 }), /positive finite/);
  assert.throws(() => new LineBreakProjector({ numberOfLines: 0 }), /positive safe integer/);
  assert.throws(() => new LineBreakProjector({ numberOfLines: 2.5 }), /positive safe integer/);
});

test("Line Break is registered in the projector factory", () => {
  const projector = createProjector("line-break", { minTick: 0.5, numberOfLines: 4 });

  assert.ok(projector instanceof LineBreakProjector);
  assert.equal(projector.minTick, 0.5);
  assert.equal(projector.numberOfLines, 4);
});

test("the first close anchors and the next different close creates the first line", () => {
  const data = new LineBreakProjector({ minTick: 1 }).project([
    row(1, 10),
    row(2, 10),
    row(3, 12, { venue: "demo" }),
  ]);

  assert.deepEqual(data.map(body), [
    { open: 10, high: 12, low: 10, close: 12 },
  ]);
  assert.deepEqual(data[0].time, { order: 0, sourceTime: 3, sourceOrdinal: 0 });
  assert.equal(data[0].customValues.venue, "demo");
  assert.deepEqual(data[0].customValues.chartProjection, {
    projectorId: "line-break",
    sourceFromTime: 1,
    sourceToTime: 3,
    sourceOrdinal: 0,
    synthetic: true,
    provisional: false,
  });
  assert.deepEqual(data[0].customValues.lineBreak, {
    direction: "up",
    numberOfLines: 3,
    source: "close",
    referenceHigh: 10,
    referenceLow: 10,
  });
});

test("strict breakouts append once and V1 reversals open at the previous low", () => {
  const data = new LineBreakProjector({ minTick: 1, numberOfLines: 3 }).project([
    row(1, 10),
    row(2, 12),
    row(3, 13),
    row(4, 14),
    row(5, 14),
    row(6, 13),
    row(7, 15),
    row(8, 12),
    row(9, 11),
  ]);

  assert.deepEqual(data.map(body), [
    { open: 10, high: 12, low: 10, close: 12 },
    { open: 12, high: 13, low: 12, close: 13 },
    { open: 13, high: 14, low: 13, close: 14 },
    { open: 14, high: 15, low: 14, close: 15 },
    { open: 14, high: 14, low: 11, close: 11 },
  ]);
  assert.deepEqual(data.map((point) => point.time.sourceTime), [2, 3, 4, 7, 9]);
  assert.deepEqual(data.map((point) => point.time.order), [0, 1, 2, 3, 4]);
  assert.deepEqual(data[4].customValues.lineBreak, {
    direction: "down",
    numberOfLines: 3,
    source: "close",
    referenceHigh: 15,
    referenceLow: 12,
  });
});

test("numberOfLines one uses only the latest line envelope", () => {
  const data = new LineBreakProjector({ minTick: 1, numberOfLines: 1 }).project([
    row(1, 10),
    row(2, 12),
    row(3, 11),
    row(4, 10),
    row(5, 9),
    row(6, 11),
  ]);

  assert.deepEqual(data.map(body), [
    { open: 10, high: 12, low: 10, close: 12 },
    { open: 10, high: 10, low: 9, close: 9 },
    { open: 10, high: 11, low: 10, close: 11 },
  ]);
});

test("integer ticks avoid floating point drift", () => {
  const data = new LineBreakProjector({ minTick: 0.01, numberOfLines: 2 }).project([
    row(1, 0.24),
    row(2, 0.3),
    row(3, 0.4),
    row(4, 0.2),
  ]);

  assert.deepEqual(data.map(body), [
    { open: 0.24, high: 0.3, low: 0.24, close: 0.3 },
    { open: 0.3, high: 0.4, low: 0.3, close: 0.4 },
    { open: 0.3, high: 0.3, low: 0.2, close: 0.2 },
  ]);
});

test("checkpoint state retains only the bounded decision window", () => {
  const projector = new LineBreakProjector({ minTick: 1, numberOfLines: 3 });
  const projected = projector.projectWithState([
    row(1, 10),
    row(2, 11),
    row(3, 12),
    row(4, 13),
    row(5, 14),
    row(6, 15),
  ]);

  assert.equal(projected.data.length, 5);
  assert.equal(projected.state.lineWindow.length, 3);
  assert.deepEqual(projected.state.lineWindow.map((line) => line.order), [2, 3, 4]);
  assert.ok(projected.checkpoints.every((checkpoint) => (
    checkpoint.lineWindow.length <= 3
  )));
});

test("adjacent no-output checkpoints share an immutable persistent window", () => {
  const projector = new LineBreakProjector({ minTick: 1, numberOfLines: 3 });
  const projected = projector.projectWithState([
    row(1, 10),
    row(2, 12),
    row(3, 11),
    row(4, 10),
    row(5, 13),
  ]);

  assert.strictEqual(
    projected.checkpoints[0].lineWindow,
    projected.checkpoints[1].lineWindow,
  );
  assert.notStrictEqual(
    projected.checkpoints[1].lineWindow,
    projected.checkpoints[2].lineWindow,
  );
  assert.strictEqual(
    projected.checkpoints[2].lineWindow,
    projected.checkpoints[3].lineWindow,
  );
  assert.strictEqual(
    projected.checkpoints[3].lineWindow,
    projected.checkpoints[4].lineWindow,
  );
  assert.strictEqual(
    projected.checkpoints[2].lineWindow[0],
    projected.checkpoints[4].lineWindow[0],
  );
  assert.notStrictEqual(projected.checkpoints[4].lineWindow, projected.state.lineWindow);
  assert.strictEqual(
    projected.checkpoints[4].lineWindow[0],
    projected.state.lineWindow[0],
  );
  assert.ok(Object.isFrozen(projected.checkpoints[2].lineWindow));
  assert.ok(Object.isFrozen(projected.checkpoints[2].lineWindow[0]));

  const externalSeed = structuredClone(projected.checkpoints[2]);
  const resumed = projector.projectWithState([row(6, 11)], {
    seedState: externalSeed,
  });
  assert.notStrictEqual(resumed.checkpoints[0].lineWindow, externalSeed.lineWindow);
  assert.ok(Object.isFrozen(resumed.checkpoints[0].lineWindow));
  externalSeed.lineWindow[0].closeTicks = 999;
  assert.equal(resumed.state.lineWindow[0].closeTicks, 12);
});

test("seeded projection carries the latest line when retained rows stay inside", () => {
  const projector = new LineBreakProjector({ minTick: 1, numberOfLines: 3 });
  const first = projector.projectWithState([
    row(1, 10),
    row(2, 12, { phase: "confirmed" }),
    row(3, 13),
    row(4, 14),
  ]);
  const resumed = projector.projectWithState([row(5, 13)], {
    seedState: first.state,
  });

  assert.deepEqual(resumed.data.map(body), [
    { open: 13, high: 14, low: 13, close: 14 },
  ]);
  assert.equal(resumed.data[0].time.order, 2);
  assert.equal(resumed.data[0].time.sourceTime, 4);
});

test("checkpoint resume carries the latest line and appends a breakout", () => {
  const projector = new LineBreakProjector({ minTick: 1, numberOfLines: 3 });
  const projected = projector.projectWithState([
    row(1, 10),
    row(2, 12),
    row(3, 13),
    row(4, 14),
    row(5, 15),
  ]);
  const resumed = projector.projectWithState([row(4, 14), row(5, 15)], {
    seedState: projected.checkpoints[3],
  });

  assert.deepEqual(resumed.data.map(body), [
    { open: 12, high: 13, low: 12, close: 13 },
    { open: 13, high: 14, low: 13, close: 14 },
    { open: 14, high: 15, low: 14, close: 15 },
  ]);
  assert.deepEqual(resumed.data.map((point) => point.time.order), [1, 2, 3]);
  assert.throws(
    () => new LineBreakProjector({ minTick: 1, numberOfLines: 2 })
      .projectWithState([], { seedState: projected.state }),
    /incompatible/,
  );
});

test("empty retained source does not carry the active line", () => {
  const projector = new LineBreakProjector({ minTick: 1 });
  const first = projector.projectWithState([row(1, 10), row(2, 12)]);

  assert.deepEqual(projector.projectWithState([], { seedState: first.state }).data, []);
  assert.deepEqual(
    projector.projectWithState([{ time: null, close: 13 }], { seedState: first.state }).data,
    [],
  );
});

test("provisional projection does not mutate confirmed state or checkpoints", () => {
  const projector = new LineBreakProjector({ minTick: 1, numberOfLines: 3 });
  const confirmed = projector.projectWithState([
    row(1, 10),
    row(2, 12, { phase: "confirmed" }),
  ]);
  const checkpoint = confirmed.state;
  const trial = projector.projectWithState([row(3, 13, { phase: "trial" })], {
    provisional: true,
    seedState: checkpoint,
  });

  assert.equal(trial.data[0].customValues.chartProjection.provisional, false);
  assert.equal(trial.data[1].customValues.chartProjection.provisional, true);
  assert.equal(trial.checkpoints[0].nextOrder, 1);
  assert.equal(trial.checkpoints[0].lineWindow.length, 1);
  assert.equal(checkpoint.nextOrder, 1);
  assert.equal(checkpoint.lineWindow.length, 1);
  assert.equal(checkpoint.lineWindow[0].customValues.phase, "confirmed");

  const resumedConfirmed = projector.projectWithState([row(3, 14)], {
    seedState: checkpoint,
  });
  assert.equal(resumedConfirmed.data[1].close, 14);
  assert.equal(resumedConfirmed.data[1].customValues.chartProjection.provisional, false);
});

test("whitespace and invalid closes do not initialize or advance Line Break state", () => {
  const projected = new LineBreakProjector({ minTick: 1 }).projectWithState([
    { time: 1, close: 10, __whitespace: true },
    row(2, ""),
    row(3, 10),
    row(4, 12),
  ]);

  assert.deepEqual(projected.data.map(body), [
    { open: 10, high: 12, low: 10, close: 12 },
  ]);
  assert.equal(projected.data[0].customValues.chartProjection.sourceFromTime, 3);
  assert.equal(projected.checkpoints.length, 4);
});
