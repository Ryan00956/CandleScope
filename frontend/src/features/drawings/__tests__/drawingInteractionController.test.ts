import assert from "node:assert/strict";
import test from "node:test";

import {
  limitFreehandCapturePositions,
  mergePendingActiveDrawingMove,
} from "../drawingMoveBatch.js";
import type { ActiveDrawingMovePayload, ScreenPoint } from "../drawingTypes.js";
import { malformedFixture, mustBeDefined } from "../../../test/testHelpers.js";

function point(x: number): ScreenPoint {
  return { x, y: x };
}

test("pending pen moves retain every coalesced batch before one RAF", () => {
  const firstEvent = { altKey: false };
  const latestEvent = { altKey: true };
  const pending = malformedFixture<ActiveDrawingMovePayload>({
    tool: "pen",
    pos: point(2),
    positions: [point(1), point(2)],
    e: firstEvent,
  });
  const payload = malformedFixture<ActiveDrawingMovePayload>({
    tool: "pen",
    pos: point(4),
    positions: [point(3), point(4)],
    e: latestEvent,
  });

  const merged = mergePendingActiveDrawingMove(pending, payload);
  assert.strictEqual(merged, pending);
  assert.deepEqual(mustBeDefined(merged).positions, [point(1), point(2), point(3), point(4)]);
  assert.deepEqual(mustBeDefined(merged).pos, point(4));
  assert.strictEqual(mustBeDefined(merged).e, latestEvent);
});

test("pending highlighter batches are bounded while preserving chronological prefix", () => {
  const pending: ActiveDrawingMovePayload = {
    tool: "highlighter",
    pos: point(2),
    positions: [point(1), point(2)],
  };
  const merged = mergePendingActiveDrawingMove(pending, {
    tool: "highlighter",
    pos: point(5),
    positions: [point(3), point(4), point(5)],
  }, 4);

  assert.deepEqual(mustBeDefined(merged).positions, [point(1), point(2), point(3), point(4)]);
  assert.deepEqual(mustBeDefined(merged).pos, point(5));
});

test("non-freehand active moves and tool changes remain latest-wins", () => {
  const linePayload: ActiveDrawingMovePayload = { tool: "line-segment", pos: point(2), positions: [point(2)] };
  assert.strictEqual(mergePendingActiveDrawingMove(
    { tool: "line-segment", pos: point(1), positions: [point(1)] },
    linePayload,
  ), linePayload);

  const highlighterPayload: ActiveDrawingMovePayload = { tool: "highlighter", pos: point(3), positions: [point(3)] };
  assert.strictEqual(mergePendingActiveDrawingMove(
    { tool: "pen", pos: point(2), positions: [point(2)] },
    highlighterPayload,
  ), highlighterPayload);
});

test("near-capacity capture drops an invalid tail before atomic coordinate capture", () => {
  const validPrefix = [point(1), point(2)];
  const invalidTail = { x: 999, y: Number.NaN };
  assert.deepEqual(
    limitFreehandCapturePositions([...validPrefix, invalidTail], 2),
    validPrefix,
  );
  assert.deepEqual(limitFreehandCapturePositions(validPrefix, 0), []);
  assert.deepEqual(limitFreehandCapturePositions(validPrefix, -1), []);
});
