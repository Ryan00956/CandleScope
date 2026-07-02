import assert from "node:assert/strict";
import test from "node:test";

import {
  renderCandleDataTransition,
  renderSeriesDelta,
} from "../seriesDeltaRenderer.js";

function createSeries() {
  const calls = [];
  return {
    calls,
    series: {
      update: (bar) => calls.push(["update", bar]),
      setData: (data) => calls.push(["setData", data]),
    },
  };
}

test("renderSeriesDelta updates ticks directly", () => {
  const { series, calls } = createSeries();

  const result = renderSeriesDelta({
    series,
    delta: { type: "tick", bar: { time: 10, close: 1 }, bars: 1 },
  });

  assert.equal(result, "update");
  assert.deepEqual(calls, [["update", { time: 10, close: 1 }]]);
});

test("renderSeriesDelta appends only added right rows", () => {
  const { series, calls } = createSeries();

  renderSeriesDelta({
    series,
    delta: { type: "append", addedRight: 2 },
    snapshot: [{ time: 10 }, { time: 20 }, { time: 30 }],
  });

  assert.deepEqual(calls, [["update", { time: 20 }], ["update", { time: 30 }]]);
});

test("renderSeriesDelta compensates visible logical range on prepend", () => {
  const { series, calls } = createSeries();
  const compensated = [];

  renderSeriesDelta({
    series,
    delta: { type: "prepend", addedLeft: 3 },
    snapshot: [{ time: 1 }, { time: 2 }],
    viewportController: { compensateInsert: (bars) => compensated.push(bars) },
  });

  assert.deepEqual(calls, [["setData", [{ time: 1 }, { time: 2 }]]]);
  assert.deepEqual(compensated, [3]);
});

test("renderSeriesDelta uses net shift when prepend hits the trim budget", () => {
  const { series, calls } = createSeries();
  const compensated = [];

  renderSeriesDelta({
    series,
    delta: { type: "prepend", addedLeft: 500, trimmedLeft: 500 },
    snapshot: [{ time: 1 }, { time: 2 }],
    viewportController: { compensateInsert: (bars) => compensated.push(bars) },
  });

  assert.deepEqual(calls, [["setData", [{ time: 1 }, { time: 2 }]]]);
  assert.deepEqual(compensated, []);
});

test("renderSeriesDelta escalates trimming ticks to setData", () => {
  const { series, calls } = createSeries();
  const compensated = [];

  renderSeriesDelta({
    series,
    delta: { type: "tick", bar: { time: 30 }, appended: true, trimmedLeft: 1 },
    snapshot: [{ time: 20 }, { time: 30 }],
    viewportController: { compensateInsert: (bars) => compensated.push(bars) },
  });

  assert.deepEqual(calls, [["setData", [{ time: 20 }, { time: 30 }]]]);
  assert.deepEqual(compensated, [-1]);
});

test("renderSeriesDelta prefers anchor-based compensation when possible", () => {
  const { series, calls } = createSeries();
  const shifts = [];
  const viewportController = {
    captureAnchor: (previousRows) => ({ time: previousRows[0].time, index: 0 }),
    applyAnchorShift: (anchor, indexOfTime) => {
      shifts.push(indexOfTime(anchor.time) - anchor.index);
      return true;
    },
    compensateInsert: () => {
      throw new Error("fallback compensation must not run when anchor applies");
    },
  };

  renderSeriesDelta({
    series,
    delta: { type: "mid-merge", addedLeft: 0 },
    snapshot: [{ time: 5 }, { time: 10 }, { time: 20 }],
    previousRows: [{ time: 10 }, { time: 20 }],
    viewportController,
  });

  assert.deepEqual(calls, [["setData", [{ time: 5 }, { time: 10 }, { time: 20 }]]]);
  assert.deepEqual(shifts, [1]);
});

test("renderCandleDataTransition uses trailing updates when possible", () => {
  const { series, calls } = createSeries();

  const result = renderCandleDataTransition({
    series,
    previousData: [{ time: 10, close: 1 }, { time: 20, close: 2 }],
    nextData: [{ time: 10, close: 1 }, { time: 20, close: 3 }, { time: 30, close: 4 }],
  });

  assert.equal(result, "update");
  assert.deepEqual(calls, [["update", { time: 20, close: 3 }], ["update", { time: 30, close: 4 }]]);
});
