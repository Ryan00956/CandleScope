import assert from "node:assert/strict";
import test from "node:test";

import {
  createDrawingInteractionLifecycleRecorder,
} from "../drawingInteractionLifecycle.js";

test("freehand boundary lifecycle emits the strict three-event chart-type receipt", () => {
  let now = Date.parse("2026-07-17T01:00:00.000Z");
  const recorder = createDrawingInteractionLifecycleRecorder({
    now: () => now,
    sessionId: "test-session",
  });

  const started = recorder.beginFreehandGesture();
  assert.equal(started.events.length, 1);
  assert.deepEqual(started.events[0], {
    type: "pointer-down",
    transactionId: "transaction-test-session-1",
    gestureId: "gesture-test-session-1",
    observedAt: "2026-07-17T01:00:00.000Z",
    activeAfter: true,
  });

  now += 1_000;
  const boundary = recorder.markBoundaryChange({
    kind: "chart-type",
    beforeValue: "candlestick",
    afterValue: "line",
  });
  assert.equal(boundary?.events.length, 2);
  // Mirrors cancelActiveFreehandStroke(): ordinary abandon runs as part of
  // physical cleanup, but a marked boundary retains ownership until complete.
  assert.equal(recorder.abandonActiveGesture(), false);

  now += 1_000;
  const completed = recorder.completeBoundaryCancellation("surface-dispose");
  assert.deepEqual(completed, {
    kind: "chart-type",
    transactionId: started.transactionId,
    gestureId: started.gestureId,
    events: [
      started.events[0],
      {
        type: "boundary-change",
        transactionId: started.transactionId,
        gestureId: started.gestureId,
        observedAt: "2026-07-17T01:00:01.000Z",
        boundaryKind: "chart-type",
        beforeValue: "candlestick",
        afterValue: "line",
        activeBefore: true,
      },
      {
        type: "gesture-cancel",
        transactionId: started.transactionId,
        gestureId: started.gestureId,
        observedAt: "2026-07-17T01:00:02.000Z",
        reason: "surface-dispose",
        activeAfter: false,
      },
    ],
  });
  assert.deepEqual(recorder.snapshot(), { active: null, lastCompleted: completed });
  assert.ok(Object.isFrozen(completed));
  assert.ok(Object.isFrozen(completed?.events));
});

test("interval lifecycle requires the matching cancellation owner", () => {
  let now = 100;
  const recorder = createDrawingInteractionLifecycleRecorder({
    now: () => now,
    sessionId: "interval",
  });
  const started = recorder.beginFreehandGesture();
  now += 1;
  recorder.markBoundaryChange({
    kind: "interval",
    beforeValue: "binance:BTCUSDT:1m:time",
    afterValue: "binance:BTCUSDT:5m:time",
  });

  assert.equal(recorder.completeBoundaryCancellation("surface-dispose"), null);
  assert.equal(recorder.snapshot().active?.gestureId, started.gestureId);
  now += 1;
  const completed = recorder.completeBoundaryCancellation("coordinate-change");
  assert.equal(completed?.kind, "interval");
  assert.equal(completed?.events[2].reason, "coordinate-change");
  assert.equal(recorder.snapshot().active, null);
});

test("normal completion and cancellation abandon active telemetry without forging a boundary receipt", () => {
  const recorder = createDrawingInteractionLifecycleRecorder({
    now: () => 0,
    sessionId: "abandon",
  });
  recorder.beginFreehandGesture();
  assert.equal(recorder.abandonActiveGesture(), true);
  assert.deepEqual(recorder.snapshot(), { active: null, lastCompleted: null });

  recorder.beginFreehandGesture();
  assert.equal(recorder.markBoundaryChange({
    kind: "chart-type",
    beforeValue: "candlestick",
    afterValue: "candlestick",
  }), null);
  assert.equal(recorder.abandonActiveGesture(), true);
  assert.deepEqual(recorder.snapshot(), { active: null, lastCompleted: null });
});

test("failed boundary rollback restores the active pointer-down and reset clears both slots", () => {
  const recorder = createDrawingInteractionLifecycleRecorder({
    now: () => 0,
    sessionId: "rollback",
  });
  const started = recorder.beginFreehandGesture();
  recorder.markBoundaryChange({
    kind: "chart-type",
    beforeValue: "candlestick",
    afterValue: "line",
  });

  assert.equal(recorder.abandonActiveGesture(), false);
  assert.equal(recorder.rollbackBoundaryChange(), true);
  assert.deepEqual(recorder.snapshot().active?.events, [started.events[0]]);
  assert.equal(recorder.abandonActiveGesture(), true);

  recorder.beginFreehandGesture();
  recorder.markBoundaryChange({
    kind: "interval",
    beforeValue: "1m",
    afterValue: "5m",
  });
  recorder.completeBoundaryCancellation("coordinate-change");
  assert.notEqual(recorder.snapshot().lastCompleted, null);
  recorder.reset();
  assert.deepEqual(recorder.snapshot(), { active: null, lastCompleted: null });
});
