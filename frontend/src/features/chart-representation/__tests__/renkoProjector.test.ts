import assert from "node:assert/strict";
import test from "node:test";

import { createProjector } from "../projectorFactory.js";
import { RenkoProjector } from "../projectors/renkoProjector.js";
import type {
  DisplayRow,
  ProjectionCustomValues,
  SourceBar,
} from "../chartRepresentationTypes.js";
import { mustBeDefined } from "../../../test/testHelpers.js";

function at<T>(values: readonly T[], index: number): T {
  return mustBeDefined(values[index]);
}

function row(
  time: number,
  close: number,
  customValues: ProjectionCustomValues = {},
): SourceBar {
  return { time, open: close, high: close, low: close, close, customValues };
}

function body(point: DisplayRow) {
  return {
    close: point.close,
    high: point.high,
    low: point.low,
    open: point.open,
  };
}

test("RenkoProjector validates fixed-box tick options", () => {
  assert.throws(() => new RenkoProjector({ boxSize: 0 }), /positive finite/);
  assert.throws(() => new RenkoProjector({ minTick: -0.01 }), /positive finite/);
  assert.throws(
    () => new RenkoProjector({ boxSize: 0.15, minTick: 0.1 }),
    /integer multiple/,
  );
});

test("traditional Renko anchors to the lower box grid and emits full continuation bricks", () => {
  const projector = new RenkoProjector({ boxSize: 2, minTick: 0.1 });
  const data = projector.project([
    row(1, 52.9),
    row(2, 53.9),
    row(3, 54),
    row(4, 58.9),
  ]);

  assert.deepEqual(data.map(body), [
    { open: 52, high: 54, low: 52, close: 54 },
    { open: 54, high: 56, low: 54, close: 56 },
    { open: 56, high: 58, low: 56, close: 58 },
  ]);
  assert.deepEqual(data.map((point) => point.time), [
    { order: 0, sourceTime: 3, sourceOrdinal: 0 },
    { order: 1, sourceTime: 4, sourceOrdinal: 0 },
    { order: 2, sourceTime: 4, sourceOrdinal: 1 },
  ]);
  assert.deepEqual(at(data, 0).customValues.chartProjection, {
    projectorId: "renko",
    sourceFromTime: 1,
    sourceToTime: 3,
    sourceOrdinal: 0,
    synthetic: true,
    provisional: false,
  });
  assert.equal(at(data, 1).customValues.chartProjection.sourceFromTime, 3);
  assert.equal(at(data, 2).customValues.chartProjection.sourceFromTime, 4);
});

test("traditional Renko requires two boxes for reversal and renders no wick", () => {
  const data = new RenkoProjector({ boxSize: 2, minTick: 1 }).project([
    row(1, 52),
    row(2, 54),
    row(3, 51),
    row(4, 50, { venue: "demo" }),
  ]);

  assert.equal(data.length, 2);
  assert.deepEqual(body(at(data, 0)), { open: 52, high: 54, low: 52, close: 54 });
  assert.deepEqual(body(at(data, 1)), { open: 52, high: 52, low: 50, close: 50 });
  assert.equal(at(data, 1).customValues.venue, "demo");
  assert.equal(at(data, 1).customValues.renko.direction, "down");
  assert.equal(at(data, 1).customValues.renko.wickPolicy, "none");
  assert.equal(at(data, 1).customValues.chartProjection.sourceFromTime, 2);
  assert.equal(at(data, 1).customValues.chartProjection.sourceToTime, 4);
});

test("traditional Renko applies the same two-box reversal rule after a down brick", () => {
  const data = new RenkoProjector({ boxSize: 2, minTick: 1 }).project([
    row(1, 60),
    row(2, 58),
    row(3, 61),
    row(4, 62),
  ]);

  assert.deepEqual(data.map(body), [
    { open: 60, high: 60, low: 58, close: 58 },
    { open: 60, high: 62, low: 60, close: 62 },
  ]);
});

test("integer tick construction does not leak floating point drift", () => {
  const data = new RenkoProjector({ boxSize: 0.1, minTick: 0.01 }).project([
    row(1, 0.24),
    row(2, 0.5),
  ]);

  assert.deepEqual(data.map(body), [
    { open: 0.2, high: 0.3, low: 0.2, close: 0.3 },
    { open: 0.3, high: 0.4, low: 0.3, close: 0.4 },
    { open: 0.4, high: 0.5, low: 0.4, close: 0.5 },
  ]);
});

test("Renko checkpoints resume projection without re-anchoring", () => {
  const projector = new RenkoProjector({ boxSize: 2, minTick: 1 });
  const first = projector.projectWithState([row(1, 52), row(2, 54)]);
  const resumed = projector.projectWithState([row(3, 51), row(4, 50)], {
    seedState: first.state,
  });

  assert.deepEqual(resumed.data.map(body), [
    { open: 52, high: 52, low: 50, close: 50 },
  ]);
  assert.equal(at(resumed.data, 0).time.order, 1);
  assert.equal(resumed.checkpoints.length, 2);
});

test("projector factory forwards Renko runtime options", () => {
  const projector = createProjector("renko", { boxSize: 5, minTick: 0.5 });

  assert.ok(projector instanceof RenkoProjector);
  assert.equal(projector.boxTicks, 10);
});

test("provisional projection state is carried in source lineage", () => {
  const data = new RenkoProjector({ boxSize: 1, minTick: 1 }).project(
    [row(1, 10), row(2, 11)],
    { provisional: true },
  );

  assert.equal(at(data, 0).customValues.chartProjection.provisional, true);
});
