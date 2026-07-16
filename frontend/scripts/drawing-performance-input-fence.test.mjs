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
  const postRafTaskCallbacks = [];
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
    schedulePostRafTask: (callback) => {
      postRafTaskCallbacks.push(callback);
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
    postRafTaskCallbacks,
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
    runPostRafTask(atMs) {
      assert.ok(postRafTaskCallbacks.length > 0, "expected a queued post-rAF task");
      clockMs = atMs;
      postRafTaskCallbacks.shift()();
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
  harness.runPostRafTask(9);

  const snapshot = harness.tracker.snapshot();
  assert.equal(snapshot.schemaVersion, "drawing-input-post-raf-task/v2");
  assert.equal(snapshot.overall.countConservationPassed, true);
  assert.equal(snapshot.inputPaintFenceStats.pointermove.fenceCount, 1);
  assert.equal(snapshot.slowInputPostRafTaskFences.entries[0].eventTimeStampMs, 0.5);
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
  assert.equal(harness.postRafTaskCallbacks.length, 1);
  assert.equal(snapshot.inputPaintFenceStats.wheel.pendingEventCount, 1);
  assert.equal(snapshot.inputPaintFenceStats.wheel.postRafInputCount, 0);
  assert.equal(snapshot.inputPaintFenceStats.wheel.inputWhileFrozenCount, 1);
  assert.equal(snapshot.overall.postRafInputCount, 0);
  assert.equal(snapshot.overall.inputWhileFrozenCount, 1);

  harness.runPostRafTask(12);
  snapshot = harness.tracker.snapshot();
  assert.deepEqual(harness.overallFences, [11]);
  assert.deepEqual(harness.typeFences, [{ type: "pointermove", latencyMs: 11 }]);
  assert.equal(snapshot.inputPaintFenceStats.pointermove.fenceCount, 1);
  assert.equal(snapshot.inputPaintFenceStats.wheel.fenceCount, 0);
  assert.equal(snapshot.inputPaintFenceStats.wheel.pendingEventCount, 1);

  harness.runFrame(20);
  harness.runPostRafTask(22);
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
    snapshot.slowInputPostRafTaskFences.entries.map((entry) => ({
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
  harness.runPostRafTask(20);

  const snapshot = harness.tracker.snapshot();
  const stats = snapshot.inputPaintFenceStats.pointermove;
  assert.equal(stats.unattributedEventCount, 2);
  assert.equal(stats.unattributedFenceCount, 1);
  assert.equal(snapshot.overall.unattributedEventCount, 2);
  assert.equal(snapshot.overall.unattributedFenceCount, 1);
  assert.equal(snapshot.overall.countConservationPassed, true);
  assert.equal(snapshot.slowInputPostRafTaskFences.entries[0].cycle, null);
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
  harness.runPostRafTask(20);

  const snapshot = harness.tracker.snapshot();
  const stats = snapshot.inputPaintFenceStats.pointermove;
  const [entry] = snapshot.slowInputPostRafTaskFences.entries;
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
    postRafTaskAtMs: 20,
    eventToHandlerMs: 0.75,
    handlerToRafMs: 9,
    rafToPostRafTaskMs: 10,
    handlerToPostRafTaskMs: 19,
    eventToPostRafTaskMs: 19.75,
    conservativeTotalMs: 19.75,
  });
  assert.equal(harness.record("pointerdown", 20), false);
  assert.throws(() => harness.tracker.beginCycle(0), /positive safe integer/);
});

test("dispose invalidates queued frame and post-rAF-task callbacks without publishing them", () => {
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

  const beforePostRafTask = createHarness();
  beforePostRafTask.setTime(1);
  beforePostRafTask.record("pointermove", 0.5);
  beforePostRafTask.runFrame(10);
  assert.equal(beforePostRafTask.tracker.dispose(), true);
  beforePostRafTask.runPostRafTask(20);

  snapshot = beforePostRafTask.tracker.snapshot();
  assert.equal(snapshot.overall.stalePostRafTaskCallbackCount, 1);
  assert.equal(snapshot.overall.legacyAliases.stalePostPaintCallbackCount, 1);
  assert.equal(snapshot.inputPaintFenceStats.pointermove.droppedEventCount, 1);
  assert.equal(snapshot.inputPaintFenceStats.pointermove.fenceCount, 0);
  assert.equal(snapshot.slowInputPostRafTaskFences.observedFenceCount, 0);
  assert.equal(snapshot.overall.countConservationPassed, true);
  assert.deepEqual(beforePostRafTask.typeFences, []);
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
  harness.runPostRafTask(51);

  harness.tracker.beginCycle(2);
  harness.setTime(100);
  harness.record("pointermove", 99.5);
  harness.tracker.endCycle(2);
  harness.runFrame(105);
  harness.runPostRafTask(120);

  const snapshot = harness.tracker.snapshot();
  const slow = snapshot.slowInputPostRafTaskFences;
  assert.equal(slow.schemaVersion, "drawing-input-post-raf-task/v2");
  assert.equal(slow.endpoint, "post-rAF-task");
  assert.equal(slow.timestampAggregation, "per-type-cohort-earliest-independent");
  assert.equal(slow.rankingMetric, "conservativeTotalMs");
  assert.equal(slow.capacity, 2);
  assert.equal(slow.observedFenceCount, 3);
  assert.equal(slow.retainedFenceCount, 2);
  assert.equal(slow.omittedFenceCount, 1);
  assert.equal(slow.performanceTimeOriginMs, 1_700_000_000_000);
  assert.equal(slow.countConservationPassed, true);
  assert.deepEqual(
    slow.entries.map((entry) => [
      entry.conservativeTotalMs,
      entry.fenceId,
      entry.eventType,
    ]),
    [
      [50.5, 1, "pointermove"],
      [49.5, 1, "wheel"],
    ],
  );
  assert.equal(snapshot.inputPaintFenceStats.pointermove.fenceCount, 2);
  assert.equal(snapshot.inputPaintFenceStats.wheel.fenceCount, 1);
  assert.equal(snapshot.overall.fenceCount, 2);
  assert.equal(snapshot.overall.typeFenceCount, 3);
  assert.equal(snapshot.overall.countConservationPassed, true);

  slow.entries[0].conservativeTotalMs = -1;
  assert.equal(
    harness.tracker.snapshot().slowInputPostRafTaskFences.entries[0].conservativeTotalMs,
    50.5,
  );
  const legacy = snapshot.slowInputPaintFences;
  assert.equal(legacy.legacyAlias, true);
  assert.equal(legacy.deprecated, true);
  assert.equal(legacy.endpoint, "post-rAF-task");
  assert.equal(legacy.canonicalProperty, "slowInputPostRafTaskFences");
});

test("retains earliest event and handler timestamps independently", () => {
  const harness = createHarness({ eventTypes: ["pointermove"] });

  harness.tracker.beginCycle(3);
  harness.setTime(10);
  harness.record("pointermove", 9);
  harness.setTime(12);
  // A later handler may carry an older event timestamp. The diagnostic keeps
  // both conservative minima rather than coupling event time to handler time.
  harness.record("pointermove", 2);
  harness.tracker.endCycle(3);
  harness.runFrame(15);
  harness.runPostRafTask(20);

  const [entry] = harness.tracker.snapshot().slowInputPostRafTaskFences.entries;
  assert.deepEqual(entry, {
    fenceId: 1,
    cycle: 3,
    eventType: "pointermove",
    eventCount: 2,
    eventTimeStampMs: 2,
    handlerAtMs: 10,
    lastRafAtMs: null,
    rafAtMs: 15,
    postRafTaskAtMs: 20,
    eventToHandlerMs: 8,
    handlerToRafMs: 5,
    rafToPostRafTaskMs: 5,
    handlerToPostRafTaskMs: 10,
    eventToPostRafTaskMs: 18,
    conservativeTotalMs: 18,
  });
  assert.deepEqual(harness.typeFences, [{ type: "pointermove", latencyMs: 10 }]);
});

test("ranks diagnostics by conservative event-to-post-rAF-task total", () => {
  const harness = createHarness({ eventTypes: ["pointermove"], topKCapacity: 1 });

  harness.tracker.beginCycle(1);
  harness.setTime(1);
  harness.record("pointermove", 0);
  harness.tracker.endCycle(1);
  harness.runFrame(5);
  harness.runPostRafTask(11);

  harness.tracker.beginCycle(2);
  harness.setTime(20);
  harness.record("pointermove", 10);
  harness.tracker.endCycle(2);
  harness.runFrame(25);
  harness.runPostRafTask(29);

  const snapshot = harness.tracker.snapshot();
  const [entry] = snapshot.slowInputPostRafTaskFences.entries;
  // Cycle 2 has lower handler latency (9ms vs 10ms), but the older event
  // timestamp makes its conservative end-to-end diagnostic slower (19ms).
  assert.equal(entry.cycle, 2);
  assert.equal(entry.handlerToPostRafTaskMs, 9);
  assert.equal(entry.eventToPostRafTaskMs, 19);
  assert.equal(entry.conservativeTotalMs, 19);
  assert.deepEqual(harness.typeFences, [
    { type: "pointermove", latencyMs: 10 },
    { type: "pointermove", latencyMs: 9 },
  ]);
});
