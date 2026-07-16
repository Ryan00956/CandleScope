import assert from "node:assert/strict";
import test from "node:test";

import { createDrawingInputPaintFenceTracker } from "./drawing-performance-input-fence.mjs";

function createHarness({
  eventTypes = ["pointermove", "wheel"],
  topKCapacity = 8,
  factory = createDrawingInputPaintFenceTracker,
} = {}) {
  let clockMs = 0;
  let lastRafAtMs = null;
  const frameCallbacks = [];
  const postPaintCallbacks = [];
  const overallFences = [];
  const typeFences = [];
  const tracker = factory({
    eventTypes,
    now: () => clockMs,
    performanceTimeOriginMs: 1_700_000_000_000,
    readLastRafAt: () => lastRafAtMs,
    requestFrame: (callback) => {
      frameCallbacks.push(callback);
    },
    schedulePostPaint: (callback) => {
      postPaintCallbacks.push(callback);
    },
    topKCapacity,
    onOverallFence: (latencyMs) => {
      overallFences.push(latencyMs);
    },
    onTypeFence: (type, latencyMs) => {
      typeFences.push({ type, latencyMs });
    },
  });

  return {
    tracker,
    overallFences,
    typeFences,
    frameCallbacks,
    postPaintCallbacks,
    setTime(value) {
      clockMs = value;
    },
    record(type, eventTimeStampMs = clockMs) {
      return tracker.recordInput({ type, timeStamp: eventTimeStampMs });
    },
    runFrame(atMs) {
      assert.ok(frameCallbacks.length > 0, "expected a queued animation frame");
      clockMs = atMs;
      lastRafAtMs = atMs;
      frameCallbacks.shift()(atMs);
    },
    runPostPaint(atMs) {
      assert.ok(postPaintCallbacks.length > 0, "expected a queued post-paint task");
      clockMs = atMs;
      postPaintCallbacks.shift()();
    },
  };
}

test("is fully self-contained when stringified for browser injection", () => {
  const recreatedFactory = (0, eval)(`(${createDrawingInputPaintFenceTracker.toString()})`);
  const harness = createHarness({ factory: recreatedFactory });

  harness.tracker.beginCycle(1);
  harness.setTime(1);
  assert.equal(harness.record("pointermove", 1_700_000_000_000.5), true);
  harness.tracker.endCycle(1);
  harness.runFrame(5);
  harness.runPostPaint(9);

  const snapshot = harness.tracker.snapshot();
  assert.equal(snapshot.schemaVersion, "drawing-input-paint-fence/v1");
  assert.equal(snapshot.overall.countConservationPassed, true);
  assert.equal(snapshot.inputPaintFenceStats.pointermove.fenceCount, 1);
  assert.equal(snapshot.slowInputPaintFences.entries[0].eventTimeStampMs, 0.5);
});

test("freezes the cohort at rAF entry so post-rAF input receives the next fence", () => {
  const harness = createHarness();

  harness.tracker.beginCycle(1);
  harness.setTime(1);
  harness.record("pointermove", 0.5);
  harness.tracker.endCycle(1);
  harness.runFrame(10);

  let snapshot = harness.tracker.snapshot();
  assert.equal(snapshot.overall.frameScheduled, false);
  assert.equal(snapshot.overall.frozenFenceCount, 1);
  assert.equal(snapshot.inputPaintFenceStats.pointermove.frozenEventCount, 1);

  harness.tracker.beginCycle(2);
  harness.setTime(11);
  harness.record("wheel", 10.5);
  harness.tracker.endCycle(2);

  snapshot = harness.tracker.snapshot();
  assert.equal(harness.frameCallbacks.length, 1);
  assert.equal(harness.postPaintCallbacks.length, 1);
  assert.equal(snapshot.inputPaintFenceStats.wheel.pendingEventCount, 1);
  assert.equal(snapshot.inputPaintFenceStats.wheel.postRafInputCount, 0);
  assert.equal(snapshot.inputPaintFenceStats.wheel.inputWhileFrozenCount, 1);
  assert.equal(snapshot.overall.postRafInputCount, 0);
  assert.equal(snapshot.overall.inputWhileFrozenCount, 1);

  harness.runPostPaint(12);
  snapshot = harness.tracker.snapshot();
  assert.deepEqual(harness.overallFences, [11]);
  assert.deepEqual(harness.typeFences, [{ type: "pointermove", latencyMs: 11 }]);
  assert.equal(snapshot.inputPaintFenceStats.pointermove.fenceCount, 1);
  assert.equal(snapshot.inputPaintFenceStats.wheel.fenceCount, 0);
  assert.equal(snapshot.inputPaintFenceStats.wheel.pendingEventCount, 1);

  harness.runFrame(20);
  harness.runPostPaint(22);
  snapshot = harness.tracker.snapshot();
  assert.deepEqual(harness.overallFences, [11, 11]);
  assert.deepEqual(harness.typeFences, [
    { type: "pointermove", latencyMs: 11 },
    { type: "wheel", latencyMs: 11 },
  ]);
  assert.equal(snapshot.overall.fenceCount, 2);
  assert.equal(snapshot.overall.typeFenceCount, 2);
  assert.equal(snapshot.overall.unattributedEventCount, 0);
  assert.equal(snapshot.overall.unattributedFenceCount, 0);
  assert.equal(snapshot.overall.countConservationPassed, true);
  assert.deepEqual(
    snapshot.slowInputPaintFences.entries.map((entry) => ({
      fenceId: entry.fenceId,
      cycle: entry.cycle,
      type: entry.eventType,
      lastRafAtMs: entry.lastRafAtMs,
    })),
    [
      { fenceId: 1, cycle: 1, type: "pointermove", lastRafAtMs: null },
      { fenceId: 2, cycle: 2, type: "wheel", lastRafAtMs: 10 },
    ],
  );
});

test("counts every input and completed fence recorded outside an active cycle", () => {
  const harness = createHarness();

  harness.setTime(1);
  harness.record("pointermove", 0.5);
  harness.setTime(2);
  harness.record("pointermove", 1.5);
  harness.runFrame(10);
  harness.runPostPaint(20);

  const snapshot = harness.tracker.snapshot();
  const stats = snapshot.inputPaintFenceStats.pointermove;
  assert.equal(stats.unattributedEventCount, 2);
  assert.equal(stats.unattributedFenceCount, 1);
  assert.equal(snapshot.overall.unattributedEventCount, 2);
  assert.equal(snapshot.overall.unattributedFenceCount, 1);
  assert.equal(snapshot.overall.countConservationPassed, true);
  assert.equal(snapshot.slowInputPaintFences.entries[0].cycle, null);
});

test("coalesces a type within one frozen cohort and retains its earliest timestamps", () => {
  const harness = createHarness();

  harness.tracker.beginCycle(7);
  harness.setTime(1);
  harness.record("pointermove", 0.25);
  harness.setTime(3);
  harness.record("pointermove", 2.5);
  assert.throws(() => harness.tracker.beginCycle(8), /already active/);
  assert.throws(() => harness.tracker.endCycle(8), /cycle mismatch/);
  harness.tracker.endCycle(7);
  assert.throws(() => harness.tracker.endCycle(7), /cycle mismatch/);
  harness.runFrame(10);
  harness.runPostPaint(20);

  const snapshot = harness.tracker.snapshot();
  const stats = snapshot.inputPaintFenceStats.pointermove;
  const [entry] = snapshot.slowInputPaintFences.entries;
  assert.equal(stats.eventCount, 2);
  assert.equal(stats.completedEventCount, 2);
  assert.equal(stats.fenceCount, 1);
  assert.equal(stats.coalescedEventCount, 1);
  assert.equal(stats.maxEventsPerFence, 2);
  assert.equal(stats.countConservationPassed, true);
  assert.deepEqual(harness.overallFences, [19]);
  assert.deepEqual(harness.typeFences, [{ type: "pointermove", latencyMs: 19 }]);
  assert.deepEqual(entry, {
    fenceId: 1,
    cycle: 7,
    eventType: "pointermove",
    eventCount: 2,
    eventTimeStampMs: 0.25,
    handlerAtMs: 1,
    lastRafAtMs: null,
    rafAtMs: 10,
    postPaintAtMs: 20,
    handlerToRafMs: 9,
    rafToPostPaintMs: 10,
    handlerToPostPaintMs: 19,
  });
  assert.equal(harness.record("pointerdown", 20), false);
  assert.throws(() => harness.tracker.beginCycle(0), /positive safe integer/);
});

test("dispose invalidates queued frame and post-paint callbacks without publishing them", () => {
  const beforeFrame = createHarness();
  beforeFrame.setTime(1);
  beforeFrame.record("pointermove", 0.5);
  assert.equal(beforeFrame.tracker.dispose(), true);
  assert.equal(beforeFrame.tracker.dispose(), false);
  beforeFrame.runFrame(10);

  let snapshot = beforeFrame.tracker.snapshot();
  assert.equal(snapshot.disposed, true);
  assert.equal(snapshot.overall.staleFrameCallbackCount, 1);
  assert.equal(snapshot.inputPaintFenceStats.pointermove.droppedEventCount, 1);
  assert.equal(snapshot.overall.countConservationPassed, true);
  assert.deepEqual(beforeFrame.overallFences, []);
  assert.equal(beforeFrame.record("pointermove", 10), false);
  assert.throws(() => beforeFrame.tracker.beginCycle(1), /disposed/);

  const beforePostPaint = createHarness();
  beforePostPaint.setTime(1);
  beforePostPaint.record("pointermove", 0.5);
  beforePostPaint.runFrame(10);
  assert.equal(beforePostPaint.tracker.dispose(), true);
  beforePostPaint.runPostPaint(20);

  snapshot = beforePostPaint.tracker.snapshot();
  assert.equal(snapshot.overall.stalePostPaintCallbackCount, 1);
  assert.equal(snapshot.inputPaintFenceStats.pointermove.droppedEventCount, 1);
  assert.equal(snapshot.inputPaintFenceStats.pointermove.fenceCount, 0);
  assert.equal(snapshot.slowInputPaintFences.observedFenceCount, 0);
  assert.equal(snapshot.overall.countConservationPassed, true);
  assert.deepEqual(beforePostPaint.typeFences, []);
});

test("retains a globally bounded deterministic top-K of per-type slow fences", () => {
  const harness = createHarness({ topKCapacity: 2 });

  harness.tracker.beginCycle(1);
  harness.setTime(1);
  harness.record("pointermove", 0.5);
  harness.setTime(2);
  harness.record("wheel", 1.5);
  harness.tracker.endCycle(1);
  harness.runFrame(5);
  harness.runPostPaint(51);

  harness.tracker.beginCycle(2);
  harness.setTime(100);
  harness.record("pointermove", 99.5);
  harness.tracker.endCycle(2);
  harness.runFrame(105);
  harness.runPostPaint(120);

  const snapshot = harness.tracker.snapshot();
  const slow = snapshot.slowInputPaintFences;
  assert.equal(slow.schemaVersion, "drawing-input-paint-fence/v1");
  assert.equal(slow.capacity, 2);
  assert.equal(slow.observedFenceCount, 3);
  assert.equal(slow.retainedFenceCount, 2);
  assert.equal(slow.omittedFenceCount, 1);
  assert.equal(slow.performanceTimeOriginMs, 1_700_000_000_000);
  assert.equal(slow.countConservationPassed, true);
  assert.deepEqual(
    slow.entries.map((entry) => [
      entry.handlerToPostPaintMs,
      entry.fenceId,
      entry.eventType,
    ]),
    [
      [50, 1, "pointermove"],
      [49, 1, "wheel"],
    ],
  );
  assert.equal(snapshot.inputPaintFenceStats.pointermove.fenceCount, 2);
  assert.equal(snapshot.inputPaintFenceStats.wheel.fenceCount, 1);
  assert.equal(snapshot.overall.fenceCount, 2);
  assert.equal(snapshot.overall.typeFenceCount, 3);
  assert.equal(snapshot.overall.countConservationPassed, true);

  slow.entries[0].handlerToPostPaintMs = -1;
  assert.equal(
    harness.tracker.snapshot().slowInputPaintFences.entries[0].handlerToPostPaintMs,
    50,
  );
});
