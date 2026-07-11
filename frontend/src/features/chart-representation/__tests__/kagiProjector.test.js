import assert from "node:assert/strict";
import test from "node:test";

import { createProjector } from "../projectorFactory.js";
import { KagiProjector } from "../projectors/kagiProjector.js";

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

test("KagiProjector validates resolved reversal tick options", () => {
  assert.throws(() => new KagiProjector({ minTick: 0 }), /positive finite/);
  assert.throws(() => new KagiProjector({ reversalTicks: 0 }), /positive safe integer/);
  assert.throws(() => new KagiProjector({ reversalTicks: 1.5 }), /positive safe integer/);
});

test("projector factory forwards resolved Kagi options", () => {
  const projector = createProjector("kagi", { minTick: 0.5, reversalTicks: 6 });

  assert.ok(projector instanceof KagiProjector);
  assert.equal(projector.reversalAmount, 3);
});

test("the first leg waits for reversalTicks and same-direction closes replace it", () => {
  const data = new KagiProjector({ minTick: 1, reversalTicks: 3 }).project([
    row(1, 10),
    row(2, 10),
    row(3, 12),
    row(4, 15, { venue: "demo" }),
    row(5, 13),
  ]);

  assert.deepEqual(data.map(body), [
    { open: 10, high: 15, low: 10, close: 15 },
  ]);
  assert.deepEqual(data[0].time, { order: 0, sourceTime: 4, sourceOrdinal: 0 });
  assert.equal(data[0].customValues.venue, "demo");
  assert.deepEqual(data[0].customValues.chartProjection, {
    projectorId: "kagi",
    sourceFromTime: 1,
    sourceToTime: 4,
    sourceOrdinal: 0,
    synthetic: true,
    provisional: false,
  });
  assert.deepEqual(data[0].customValues.kagi, {
    direction: "up",
    state: "yin",
    reversalKind: null,
    turnPrice: null,
    reversalAmount: 3,
    reversalTicks: 3,
    source: "close",
    sections: [{ from: 10, to: 15, style: "yin" }],
  });
});

test("counter move must reach the threshold before a shoulder reversal is appended", () => {
  const data = new KagiProjector({ minTick: 1, reversalTicks: 3 }).project([
    row(1, 10),
    row(2, 15),
    row(3, 13),
    row(4, 12),
    row(5, 11),
  ]);

  assert.deepEqual(data.map(body), [
    { open: 10, high: 15, low: 10, close: 15 },
    { open: 15, high: 15, low: 11, close: 11 },
  ]);
  assert.deepEqual(data.map((point) => point.time.order), [0, 1]);
  assert.equal(data[1].customValues.kagi.reversalKind, "shoulder");
  assert.equal(data[1].customValues.kagi.turnPrice, 15);
  assert.equal(data[1].customValues.chartProjection.sourceFromTime, 2);
  assert.equal(data[1].customValues.chartProjection.sourceToTime, 5);
});

test("down-to-up reversal records a waist without changing Yin state", () => {
  const data = new KagiProjector({ minTick: 1, reversalTicks: 3 }).project([
    row(1, 10),
    row(2, 15),
    row(3, 11),
    row(4, 14),
  ]);

  assert.equal(data.length, 3);
  assert.deepEqual(body(data[2]), { open: 11, high: 14, low: 11, close: 14 });
  assert.equal(data[2].customValues.kagi.reversalKind, "waist");
  assert.equal(data[2].customValues.kagi.turnPrice, 11);
  assert.equal(data[2].customValues.kagi.state, "yin");
});

test("strict shoulder and waist breaks split sections without adding legs", () => {
  const projector = new KagiProjector({ minTick: 1, reversalTicks: 3 });
  const atShoulder = projector.project([
    row(1, 10),
    row(2, 15),
    row(3, 11),
    row(4, 15),
  ]);

  assert.equal(atShoulder.length, 3);
  assert.deepEqual(atShoulder[2].customValues.kagi.sections, [
    { from: 11, to: 15, style: "yin" },
  ]);
  assert.equal(atShoulder[2].customValues.kagi.state, "yin");

  const crossedBoth = projector.project([
    row(1, 10),
    row(2, 15),
    row(3, 11),
    row(4, 16),
    row(5, 13),
    row(6, 11),
    row(7, 10),
  ]);

  assert.equal(crossedBoth.length, 4);
  assert.deepEqual(crossedBoth[2].customValues.kagi.sections, [
    { from: 11, to: 15, style: "yin" },
    { from: 15, to: 16, style: "yang" },
  ]);
  assert.equal(crossedBoth[2].customValues.kagi.state, "yang");
  assert.deepEqual(crossedBoth[3].customValues.kagi.sections, [
    { from: 16, to: 11, style: "yang" },
    { from: 11, to: 10, style: "yin" },
  ]);
  assert.equal(crossedBoth[3].customValues.kagi.state, "yin");
});

test("integer ticks avoid floating point drift", () => {
  const data = new KagiProjector({ minTick: 0.01, reversalTicks: 10 }).project([
    row(1, 0.24),
    row(2, 0.5),
    row(3, 0.4),
  ]);

  assert.deepEqual(data.map(body), [
    { open: 0.24, high: 0.5, low: 0.24, close: 0.5 },
    { open: 0.5, high: 0.5, low: 0.4, close: 0.4 },
  ]);
  assert.equal(data[1].customValues.kagi.reversalAmount, 0.1);
});

test("seeded projection carries the active leg and replaces it on extension", () => {
  const projector = new KagiProjector({ minTick: 1, reversalTicks: 3 });
  const confirmed = projector.projectWithState([
    row(1, 10),
    row(2, 13, { phase: "confirmed" }),
  ]);
  const noChange = projector.projectWithState([row(3, 11)], {
    seedState: confirmed.state,
  });
  const extended = projector.projectWithState([row(3, 15)], {
    seedState: confirmed.state,
  });

  assert.equal(noChange.data.length, 1);
  assert.equal(noChange.data[0].time.order, 0);
  assert.equal(noChange.data[0].time.sourceTime, 2);
  assert.equal(noChange.data[0].customValues.phase, "confirmed");
  assert.deepEqual(extended.data.map(body), [
    { open: 10, high: 15, low: 10, close: 15 },
  ]);
  assert.equal(extended.data[0].time.order, 0);
});

test("seeded reversal retains the carry-in leg and appends the next order", () => {
  const projector = new KagiProjector({ minTick: 1, reversalTicks: 3 });
  const first = projector.projectWithState([row(1, 10), row(2, 15)]);
  const resumed = projector.projectWithState([row(3, 12)], {
    seedState: first.state,
  });

  assert.deepEqual(resumed.data.map(body), [
    { open: 10, high: 15, low: 10, close: 15 },
    { open: 15, high: 15, low: 12, close: 12 },
  ]);
  assert.deepEqual(resumed.data.map((point) => point.time.order), [0, 1]);
});

test("checkpoints restore the active leg across a trimmed source prefix", () => {
  const projector = new KagiProjector({ minTick: 1, reversalTicks: 3 });
  const projected = projector.projectWithState([
    row(1, 10),
    row(2, 15),
    row(3, 13),
    row(4, 12),
  ]);
  const resumed = projector.projectWithState([row(3, 13), row(4, 12)], {
    seedState: projected.checkpoints[2],
  });

  assert.deepEqual(resumed.data.map(body), [
    { open: 10, high: 15, low: 10, close: 15 },
    { open: 15, high: 15, low: 12, close: 12 },
  ]);
  assert.deepEqual(resumed.data.map((point) => point.time.order), [0, 1]);
  assert.throws(
    () => new KagiProjector({ minTick: 1, reversalTicks: 4 })
      .projectWithState([], { seedState: projected.state }),
    /incompatible/,
  );
});

test("provisional projection does not mutate confirmed state or checkpoints", () => {
  const projector = new KagiProjector({ minTick: 1, reversalTicks: 3 });
  const confirmed = projector.projectWithState([
    row(1, 10),
    row(2, 15, { phase: "confirmed" }),
  ]);
  const checkpoint = confirmed.state;
  const trial = projector.projectWithState([row(3, 12, { phase: "trial" })], {
    provisional: true,
    seedState: checkpoint,
  });

  assert.equal(trial.data[0].customValues.chartProjection.provisional, false);
  assert.equal(trial.data[1].customValues.chartProjection.provisional, true);
  assert.equal(trial.checkpoints[0].direction, "up");
  assert.equal(trial.checkpoints[0].legEndTicks, 15);
  assert.equal(checkpoint.direction, "up");
  assert.equal(checkpoint.legEndTicks, 15);
  assert.equal(checkpoint.legCustomValues.phase, "confirmed");

  const resumedConfirmed = projector.projectWithState([row(3, 16)], {
    seedState: checkpoint,
  });
  assert.equal(resumedConfirmed.data.length, 1);
  assert.equal(resumedConfirmed.data[0].close, 16);
  assert.equal(resumedConfirmed.data[0].customValues.chartProjection.provisional, false);
});

test("whitespace and invalid closes do not initialize or advance Kagi state", () => {
  const projected = new KagiProjector({ minTick: 1, reversalTicks: 3 }).projectWithState([
    { time: 1, close: 10, __whitespace: true },
    row(2, ""),
    row(3, 10),
    row(4, 13),
  ]);

  assert.deepEqual(projected.data.map(body), [
    { open: 10, high: 13, low: 10, close: 13 },
  ]);
  assert.equal(projected.data[0].customValues.chartProjection.sourceFromTime, 3);
  assert.equal(projected.checkpoints.length, 4);
});
