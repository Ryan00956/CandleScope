import assert from "node:assert/strict";
import test from "node:test";

import { ViewportController } from "../viewportController.js";
import {
  malformedFixture,
  mustBeDefined,
  structuralMock,
} from "../../test/testHelpers.js";

type ViewportOptions = NonNullable<ConstructorParameters<typeof ViewportController>[0]>;
type AdapterChart = NonNullable<ReturnType<NonNullable<ViewportOptions["chartProvider"]>>>;
type ViewportTimer = ReturnType<NonNullable<ViewportOptions["setTimer"]>>;

function timerFixture(id: number): ViewportTimer {
  return structuralMock<ViewportTimer>({ id });
}

function createChart() {
  const calls: Array<[string, ...unknown[]]> = [];
  const timeScale = {
    range: { from: 10, to: 20 },
    options: () => ({ barSpacing: 6, rightOffset: 5 }),
    applyOptions: (options: unknown) => { calls.push(["applyOptions", options]); },
    fitContent: () => { calls.push(["fitContent"]); },
    setVisibleRange: (range: unknown) => { calls.push(["setVisibleRange", range]); },
    setVisibleLogicalRange: (range: { from: number; to: number }) => {
      calls.push(["setVisibleLogicalRange", range]);
      timeScale.range = range;
    },
    getVisibleLogicalRange: () => timeScale.range,
    scrollToPosition: (position: number, animated: boolean) => {
      calls.push(["scrollToPosition", position, animated]);
    },
  };
  return {
    calls,
    chart: structuralMock<AdapterChart>({ timeScale: () => timeScale }),
    timeScale,
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

test("semantic fit excludes render-only future time-axis points", () => {
  const { chart, calls } = createChart();
  const controller = new ViewportController({
    chartProvider: () => chart,
    contentLogicalRangeProvider: () => ({ from: 0, to: 99 }),
  });

  assert.equal(controller.fitOnce("semantic"), true);
  assert.deepEqual(calls, [
    ["setVisibleLogicalRange", { from: 0, to: 104 }],
  ]);
});

test("semantic fit falls back when the content provider has no usable range", () => {
  const { chart, calls } = createChart();
  const controller = new ViewportController({
    chartProvider: () => chart,
    contentLogicalRangeProvider: () => null,
  });

  assert.equal(controller.fitOnce("fallback"), true);
  assert.deepEqual(calls, [["fitContent"]]);
});

test("interaction lock queues the highest priority intent", () => {
  const { chart, calls } = createChart();
  let unlock: (() => void) | undefined;
  const timer = timerFixture(1);
  const controller = new ViewportController({
    chartProvider: () => chart,
    setTimer: (fn) => {
      unlock = fn;
      return timer;
    },
    clearTimer: () => {},
  });

  controller.markUserInteracting();
  assert.equal(controller.fitOnce("a"), false);
  controller.queueShift(3);
  assert.deepEqual(calls, []);

  mustBeDefined(unlock)();
  assert.deepEqual(calls, [["setVisibleLogicalRange", { from: 13, to: 23 }]]);
});

test("resetSession drops interaction state and queued intents between datasets", () => {
  const { chart, calls } = createChart();
  let unlock: (() => void) | undefined;
  const timer = timerFixture(7);
  const clearedTimers: ViewportTimer[] = [];
  const controller = new ViewportController({
    chartProvider: () => chart,
    setTimer: (fn) => {
      unlock = fn;
      return timer;
    },
    clearTimer: (timer) => clearedTimers.push(timer),
  });

  assert.equal(controller.fitOnce("shared-key"), true);
  controller.markUserInteracting();
  assert.equal(controller.applySessionRestore(malformedFixture<
    Parameters<ViewportController["applySessionRestore"]>[0]
  >({
    mode: "logical",
    logicalRange: { from: 30, to: 40 },
  }), { sessionKey: "old-dataset" }), false);
  assert.equal(controller.isLocked(), true);

  controller.resetSession();

  assert.deepEqual(clearedTimers, [timer]);
  assert.equal(controller.isLocked(), false);

  // Even if a test invokes the captured callback after clearTimer, the old
  // queued restore has already been discarded and cannot affect the dataset.
  mustBeDefined(unlock)();
  assert.deepEqual(calls, [["fitContent"]]);

  // Fit state is session-local, so the same key is eligible in the new data
  // session instead of inheriting the previous dataset's completed fit.
  assert.equal(controller.fitOnce("shared-key"), true);
  assert.deepEqual(calls, [["fitContent"], ["fitContent"]]);
});

test("transient logical-range failures are contained during dataset replacement", () => {
  const chart = structuralMock<AdapterChart>({
    timeScale: () => ({
      getVisibleLogicalRange() {
        throw new Error("Value is null");
      },
    }),
  });
  const controller = new ViewportController({ chartProvider: () => chart });

  assert.equal(controller.captureAnchor([{ time: 100 }]), null);
  assert.equal(controller.applyLogicalShiftNow(1), false);
  assert.equal(controller.queueShift(1), false);
});

test("applySessionRestore applies spacing and time range", () => {
  const { chart, calls } = createChart();
  const controller = new ViewportController({ chartProvider: () => chart });

  assert.equal(controller.applySessionRestore(malformedFixture<
    Parameters<ViewportController["applySessionRestore"]>[0]
  >({
    mode: "time",
    barSpacing: 8,
    timeRange: { from: 100, to: 200 },
    scrollPosition: 2,
  })), true);

  assert.deepEqual(calls, [
    ["applyOptions", { barSpacing: 8 }],
    ["setVisibleRange", { from: 100, to: 200 }],
    ["scrollToPosition", 2, false],
  ]);
});

test("applySessionRestore applies anchor restore with right offset", () => {
  const { chart, calls } = createChart();
  const controller = new ViewportController({ chartProvider: () => chart });

  assert.equal(controller.applySessionRestore(malformedFixture<
    Parameters<ViewportController["applySessionRestore"]>[0]
  >({
    mode: "anchor",
    barSpacing: 10,
    rightOffset: 4,
    rightmostTime: 123,
  })), true);

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
  let unlock: (() => void) | undefined;
  const timer = timerFixture(2);
  const controller = new ViewportController({
    chartProvider: () => chart,
    setTimer: (fn) => {
      unlock = fn;
      return timer;
    },
    clearTimer: () => {},
  });

  controller.markUserInteracting();
  controller.queueShift(3);
  controller.queueShift(-1);
  assert.deepEqual(calls, []);

  mustBeDefined(unlock)();
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
  const { chart, calls, timeScale } = createChart();
  const controller = new ViewportController({ chartProvider: () => chart });
  const anchor = controller.captureAnchor([
    { time: 100 }, { time: 110 }, { time: 120 }, { time: 130 },
    { time: 140 }, { time: 150 }, { time: 160 }, { time: 170 },
    { time: 180 }, { time: 190 }, { time: 200 },
  ]);

  timeScale.range = { from: 14, to: 24 };

  assert.equal(controller.applyAnchorShift(anchor, () => 14), true);
  assert.deepEqual(calls, []);
});

test("structural compensation bypasses the interaction lock", () => {
  const { chart, calls } = createChart();
  let unlock: (() => void) | undefined;
  const timer = timerFixture(3);
  const controller = new ViewportController({
    chartProvider: () => chart,
    setTimer: (fn) => {
      unlock = fn;
      return timer;
    },
    clearTimer: () => {},
  });

  controller.markUserInteracting();
  assert.equal(controller.compensateInsert(3), true);
  assert.deepEqual(calls, [["setVisibleLogicalRange", { from: 13, to: 23 }]]);

  mustBeDefined(unlock)();
  assert.deepEqual(calls, [["setVisibleLogicalRange", { from: 13, to: 23 }]]);
});
