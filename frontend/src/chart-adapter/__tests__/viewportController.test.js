import assert from "node:assert/strict";
import test from "node:test";

import { ViewportController } from "../viewportController.js";

function createChart() {
  const calls = [];
  const timeScale = {
    range: { from: 10, to: 20 },
    options: () => ({ barSpacing: 6 }),
    applyOptions: (options) => calls.push(["applyOptions", options]),
    fitContent: () => calls.push(["fitContent"]),
    setVisibleRange: (range) => calls.push(["setVisibleRange", range]),
    setVisibleLogicalRange: (range) => {
      calls.push(["setVisibleLogicalRange", range]);
      timeScale.range = range;
    },
    getVisibleLogicalRange: () => timeScale.range,
    scrollToPosition: (position, animated) => calls.push(["scrollToPosition", position, animated]),
  };
  return {
    calls,
    chart: { timeScale: () => timeScale },
  };
}

test("fitOnce is idempotent per session", () => {
  const { chart, calls } = createChart();
  const controller = new ViewportController({ chartProvider: () => chart });

  assert.equal(controller.fitOnce("a"), true);
  assert.equal(controller.fitOnce("a"), false);
  assert.equal(controller.fitOnce("b"), true);
  assert.deepEqual(calls, [["fitContent"], ["fitContent"]]);
});

test("interaction lock queues the highest priority intent", () => {
  const { chart, calls } = createChart();
  let unlock;
  const controller = new ViewportController({
    chartProvider: () => chart,
    setTimer: (fn) => {
      unlock = fn;
      return 1;
    },
    clearTimer: () => {},
  });

  controller.markUserInteracting();
  assert.equal(controller.fitOnce("a"), false);
  controller.queueShift(3);
  assert.deepEqual(calls, []);

  unlock();
  assert.deepEqual(calls, [["setVisibleLogicalRange", { from: 13, to: 23 }]]);
});

test("resetSession drops interaction state and queued intents between datasets", () => {
  const { chart, calls } = createChart();
  let unlock;
  const clearedTimers = [];
  const controller = new ViewportController({
    chartProvider: () => chart,
    setTimer: (fn) => {
      unlock = fn;
      return 7;
    },
    clearTimer: (timer) => clearedTimers.push(timer),
  });

  assert.equal(controller.fitOnce("shared-key"), true);
  controller.markUserInteracting();
  assert.equal(controller.applySessionRestore({
    mode: "logical",
    logicalRange: { from: 30, to: 40 },
  }, { sessionKey: "old-dataset" }), false);
  assert.equal(controller.isLocked(), true);

  controller.resetSession();

  assert.deepEqual(clearedTimers, [7]);
  assert.equal(controller.isLocked(), false);
  assert.equal(controller.pendingIntent, null);
  assert.equal(controller.unlockTimer, null);

  // Even if a test invokes the captured callback after clearTimer, the old
  // queued restore has already been discarded and cannot affect the dataset.
  unlock();
  assert.deepEqual(calls, [["fitContent"]]);

  // Fit state is session-local, so the same key is eligible in the new data
  // session instead of inheriting the previous dataset's completed fit.
  assert.equal(controller.fitOnce("shared-key"), true);
  assert.deepEqual(calls, [["fitContent"], ["fitContent"]]);
});

test("transient logical-range failures are contained during dataset replacement", () => {
  const chart = {
    timeScale: () => ({
      getVisibleLogicalRange() {
        throw new Error("Value is null");
      },
    }),
  };
  const controller = new ViewportController({ chartProvider: () => chart });

  assert.equal(controller.captureAnchor([{ time: 100 }]), null);
  assert.equal(controller.applyLogicalShiftNow(1), false);
  assert.equal(controller.queueShift(1), false);
});

test("applySessionRestore applies spacing and time range", () => {
  const { chart, calls } = createChart();
  const controller = new ViewportController({ chartProvider: () => chart });

  assert.equal(controller.applySessionRestore({
    mode: "time",
    barSpacing: 8,
    timeRange: { from: 100, to: 200 },
    scrollPosition: 2,
  }), true);

  assert.deepEqual(calls, [
    ["applyOptions", { barSpacing: 8 }],
    ["setVisibleRange", { from: 100, to: 200 }],
    ["scrollToPosition", 2, false],
  ]);
});

test("applySessionRestore applies anchor restore with right offset", () => {
  const { chart, calls } = createChart();
  const controller = new ViewportController({ chartProvider: () => chart });

  assert.equal(controller.applySessionRestore({
    mode: "anchor",
    barSpacing: 10,
    rightOffset: 4,
    rightmostTime: 123,
  }), true);

  // rightOffset carries scrollPosition semantics and must never be written
  // into the timeScale rightOffset option (permanent whitespace setting).
  assert.deepEqual(calls, [
    ["applyOptions", { barSpacing: 10 }],
    ["scrollToPosition", 4, false],
  ]);
});

test("restoreProjectionRange owns logical writes and falls back to fit", () => {
  const { chart, calls } = createChart();
  const controller = new ViewportController({ chartProvider: () => chart });

  assert.equal(controller.restoreProjectionRange(
    { from: 2, to: 12 },
    { barSpacing: 9 },
  ), true);
  assert.equal(controller.restoreProjectionRange(null), true);
  assert.deepEqual(calls, [
    ["applyOptions", { barSpacing: 9 }],
    ["setVisibleLogicalRange", { from: 2, to: 12 }],
    ["fitContent"],
  ]);
});

test("queueShift accumulates shifts during one interaction", () => {
  const { chart, calls } = createChart();
  let unlock;
  const controller = new ViewportController({
    chartProvider: () => chart,
    setTimer: (fn) => {
      unlock = fn;
      return 1;
    },
    clearTimer: () => {},
  });

  controller.markUserInteracting();
  controller.queueShift(3);
  controller.queueShift(-1);
  assert.deepEqual(calls, []);

  unlock();
  assert.deepEqual(calls, [["setVisibleLogicalRange", { from: 12, to: 22 }]]);
});

test("applyAnchorShift shifts by the anchor index delta", () => {
  const { chart, calls } = createChart();
  const controller = new ViewportController({ chartProvider: () => chart });

  const anchor = controller.captureAnchor([
    { time: 100 }, { time: 110 }, { time: 120 }, { time: 130 },
    { time: 140 }, { time: 150 }, { time: 160 }, { time: 170 },
    { time: 180 }, { time: 190 }, { time: 200 },
  ]);
  assert.deepEqual(anchor, { time: 200, index: 10, screenOffset: 0 });

  assert.equal(controller.applyAnchorShift(anchor, () => 14), true);
  assert.deepEqual(calls, [["setVisibleLogicalRange", { from: 14, to: 24 }]]);
});

test("applyAnchorShift does not double compensate an auto-rebased prepend", () => {
  const { chart, calls } = createChart();
  const controller = new ViewportController({ chartProvider: () => chart });
  const anchor = controller.captureAnchor([
    { time: 100 }, { time: 110 }, { time: 120 }, { time: 130 },
    { time: 140 }, { time: 150 }, { time: 160 }, { time: 170 },
    { time: 180 }, { time: 190 }, { time: 200 },
  ]);

  chart.timeScale().range = { from: 14, to: 24 };

  assert.equal(controller.applyAnchorShift(anchor, () => 14), true);
  assert.deepEqual(calls, []);
});

test("structural compensation bypasses the interaction lock", () => {
  const { chart, calls } = createChart();
  let unlock;
  const controller = new ViewportController({
    chartProvider: () => chart,
    setTimer: (fn) => {
      unlock = fn;
      return 1;
    },
    clearTimer: () => {},
  });

  controller.markUserInteracting();
  assert.equal(controller.compensateInsert(3), true);
  assert.deepEqual(calls, [["setVisibleLogicalRange", { from: 13, to: 23 }]]);

  unlock();
  assert.deepEqual(calls, [["setVisibleLogicalRange", { from: 13, to: 23 }]]);
});
