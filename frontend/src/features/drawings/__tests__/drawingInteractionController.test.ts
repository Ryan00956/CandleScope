import assert from "node:assert/strict";
import test from "node:test";

import {
  limitFreehandCapturePositions,
  mergePendingActiveDrawingMove,
} from "../drawingMoveBatch.js";
import {
  canApplyDrawingVisibilityToCurrentPrimitives,
  cancelFreehandPrimitiveOnSurface,
  detachAndRemoveDrawingPrimitive,
  runDrawingPointerTransientBarrier,
  runDrawingSurfaceDisposeBarrier,
} from "../drawingInteractionController.js";
import { prepareDrawingMutationScope } from "../useDrawingPersistenceLifecycle.js";
import type { FreehandDrawingPrimitive } from "../primitives/FreehandDrawingPrimitive.js";
import type {
  ActiveDrawingMovePayload,
  DrawingPrimitive,
  ScreenPoint,
} from "../drawingTypes.js";
import {
  malformedFixture,
  mustBeDefined,
  structuralMock,
} from "../../../test/testHelpers.js";

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

test("failed surface detach preserves the primitive registry for document retry", () => {
  const primitive = structuralMock<DrawingPrimitive>({ id: "drawing-1" });
  const primitives = [primitive];
  let attempts = 0;

  assert.equal(detachAndRemoveDrawingPrimitive(primitives, primitive, () => {
    attempts += 1;
    return false;
  }), false);
  assert.deepEqual(primitives, [primitive]);
  assert.equal(attempts, 1);

  assert.equal(detachAndRemoveDrawingPrimitive(primitives, primitive, () => {
    attempts += 1;
    return true;
  }), true);
  assert.deepEqual(primitives, []);
  assert.equal(attempts, 2);
});

test("freehand cancellation treats no active stroke as success and fails only on detach", () => {
  let detachCalls = 0;
  assert.equal(cancelFreehandPrimitiveOnSurface(null, () => {
    detachCalls += 1;
    return false;
  }), true);
  assert.equal(detachCalls, 0);

  let previewCancels = 0;
  const primitive = structuralMock<FreehandDrawingPrimitive>({
    cancelPreview: () => { previewCancels += 1; },
  });
  assert.equal(cancelFreehandPrimitiveOnSurface(primitive, () => {
    detachCalls += 1;
    return false;
  }), false);
  assert.equal(previewCancels, 1);
  assert.equal(detachCalls, 1);
});

test("surface disposal keeps transient state until the document barrier succeeds", () => {
  const calls: string[] = [];

  assert.equal(runDrawingSurfaceDisposeBarrier(
    () => {
      calls.push("prepare-failed");
      return false;
    },
    () => calls.push("finalize-failed"),
  ), false);
  assert.deepEqual(calls, ["prepare-failed"]);

  assert.equal(runDrawingSurfaceDisposeBarrier(
    () => {
      calls.push("prepare-succeeded");
      return true;
    },
    () => calls.push("finalize-succeeded"),
  ), true);
  assert.deepEqual(calls, [
    "prepare-failed",
    "prepare-succeeded",
    "finalize-succeeded",
  ]);
});

test("pointer commands stop when incompatible preview or freehand cleanup fails", () => {
  const calls: string[] = [];
  assert.equal(runDrawingPointerTransientBarrier({
    activeTool: "position-long",
    pendingTwoPointTool: "line-segment",
    hasPendingTwoPoint: true,
    hasActiveFreehand: false,
    removePreview() { calls.push("preview-failed"); return false; },
    cancelActiveFreehandStroke() { calls.push("freehand-unexpected"); return true; },
  }), false);
  assert.deepEqual(calls, ["preview-failed"]);

  assert.equal(runDrawingPointerTransientBarrier({
    activeTool: "position-long",
    pendingTwoPointTool: null,
    hasPendingTwoPoint: false,
    hasActiveFreehand: true,
    removePreview() { calls.push("preview-unexpected"); return true; },
    cancelActiveFreehandStroke() { calls.push("freehand-failed"); return false; },
  }), false);
  assert.deepEqual(calls, ["preview-failed", "freehand-failed"]);
});

test("matching two-point continuation retains its preview after transient cleanup", () => {
  const calls: string[] = [];
  assert.equal(runDrawingPointerTransientBarrier({
    activeTool: "fibonacci",
    pendingTwoPointTool: "fibonacci",
    hasPendingTwoPoint: true,
    hasActiveFreehand: true,
    removePreview() { calls.push("preview-unexpected"); return true; },
    cancelActiveFreehandStroke() { calls.push("freehand"); return true; },
  }), true);
  assert.deepEqual(calls, ["freehand"]);
});

test("failed same-series scope readiness requests a retry and blocks the mutation", () => {
  let retries = 0;
  const base = {
    activeScope: "BTCUSDT",
    hasSeries: true,
    previousScope: "BTCUSDT",
    requestedScope: "BTCUSDT",
    surfaceScope: "BTCUSDT",
  } as const;

  assert.equal(prepareDrawingMutationScope({
    ...base,
    ready: false,
  }, () => { retries += 1; }), false);
  assert.equal(retries, 1);

  assert.equal(prepareDrawingMutationScope({
    ...base,
    ready: true,
  }, () => { retries += 1; }), true);
  assert.equal(retries, 1);
});

test("requested symbol cannot mutate the previous active document", () => {
  let retries = 0;
  assert.equal(prepareDrawingMutationScope({
    activeScope: "BTCUSDT",
    hasSeries: true,
    previousScope: "BTCUSDT",
    ready: true,
    requestedScope: "ETHUSDT",
    surfaceScope: "BTCUSDT",
  }, () => { retries += 1; }), false);
  assert.equal(retries, 1);
});

test("stale scope may be hidden but cannot be made visible", () => {
  assert.equal(canApplyDrawingVisibilityToCurrentPrimitives(false, true), true);
  assert.equal(canApplyDrawingVisibilityToCurrentPrimitives(false, false), false);
  assert.equal(canApplyDrawingVisibilityToCurrentPrimitives(true, false), true);
});
