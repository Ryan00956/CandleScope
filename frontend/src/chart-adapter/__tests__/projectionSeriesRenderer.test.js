import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMainSeriesProjectionPatch,
  renderMainSeriesProjectionPatch,
} from "../projectionSeriesRenderer.js";

const ROWS = [
  { time: 10, open: 100, high: 110, low: 90, close: 105 },
  { time: 20, open: 105, high: 112, low: 100, close: 108 },
  { time: 30, open: 108, high: 115, low: 106, close: 110 },
];

test("projection patches convert only the replaced display tail", () => {
  const previousSeriesData = [
    { time: 10, value: 105 },
    { time: 20, value: 107 },
  ];
  const patch = buildMainSeriesProjectionPatch({
    displayRows: ROWS,
    previousSeriesData,
    projectionPatch: { fromOutputIndex: 1 },
    renderOptions: { chartType: "line" },
  });

  assert.deepEqual(patch, {
    kind: "replace-tail",
    fromOutputIndex: 1,
    deleteCount: 1,
    insert: [
      { time: 20, value: 108 },
      { time: 30, value: 110 },
    ],
    nextData: [
      { time: 10, value: 105 },
      { time: 20, value: 108 },
      { time: 30, value: 110 },
    ],
    previousLength: 2,
    nextLength: 3,
  });
});

test("projection patches rebuild when rendered data has no reusable prefix", () => {
  const patch = buildMainSeriesProjectionPatch({
    displayRows: ROWS,
    previousSeriesData: [],
    projectionPatch: { fromOutputIndex: ROWS.length },
    renderOptions: { chartType: "line" },
  });

  assert.equal(patch.fromOutputIndex, 0);
  assert.equal(patch.nextLength, ROWS.length);
  assert.deepEqual(patch.nextData.map((point) => point.time), [10, 20, 30]);
});

test("projection renderer incrementally replaces the last point and appends", () => {
  const events = [];
  const series = {
    setData: (data) => events.push(["setData", data]),
    update: (point) => events.push(["update", point]),
  };
  const result = renderMainSeriesProjectionPatch({
    series,
    patch: {
      fromOutputIndex: 1,
      deleteCount: 1,
      insert: [{ time: 20 }, { time: 30 }],
      nextData: [{ time: 10 }, { time: 20 }, { time: 30 }],
      previousLength: 2,
      nextLength: 3,
    },
  });

  assert.equal(result, "update");
  assert.deepEqual(events, [
    ["update", { time: 20 }],
    ["update", { time: 30 }],
  ]);
});

test("projection renderer initializes an empty series with one setData", () => {
  const events = [];
  const nextData = [{ time: 10 }, { time: 20 }];
  const result = renderMainSeriesProjectionPatch({
    series: {
      setData: (data) => events.push(["setData", data]),
      update: (point) => events.push(["update", point]),
    },
    patch: {
      fromOutputIndex: 0,
      deleteCount: 0,
      insert: nextData,
      nextData,
      previousLength: 0,
      nextLength: 2,
    },
  });

  assert.equal(result, "setData");
  assert.deepEqual(events, [["setData", nextData]]);
});

test("projection renderer ignores an unchanged projection patch", () => {
  const events = [];
  const result = renderMainSeriesProjectionPatch({
    series: {
      setData: (data) => events.push(["setData", data]),
      update: (point) => events.push(["update", point]),
    },
    patch: {
      fromOutputIndex: 2,
      deleteCount: 0,
      insert: [],
      nextData: [{ time: 10 }, { time: 20 }],
      previousLength: 2,
      nextLength: 2,
    },
  });

  assert.equal(result, "noop");
  assert.deepEqual(events, []);
});

test("projection renderer pops and rebuilds a small changed suffix", () => {
  const events = [];
  const result = renderMainSeriesProjectionPatch({
    series: {
      pop: (count) => events.push(["pop", count]),
      setData: (data) => events.push(["setData", data]),
      update: (point) => events.push(["update", point]),
    },
    patch: {
      fromOutputIndex: 2,
      deleteCount: 2,
      insert: [{ time: 30 }, { time: 40 }, { time: 50 }],
      nextData: [{ time: 10 }, { time: 20 }, { time: 30 }, { time: 40 }, { time: 50 }],
      previousLength: 4,
      nextLength: 5,
    },
  });

  assert.equal(result, "pop-update");
  assert.deepEqual(events, [
    ["pop", 2],
    ["update", { time: 30 }],
    ["update", { time: 40 }],
    ["update", { time: 50 }],
  ]);
});

test("projection renderer pops a removed synthetic suffix without appending", () => {
  const events = [];
  const result = renderMainSeriesProjectionPatch({
    series: {
      pop: (count) => events.push(["pop", count]),
      setData: (data) => events.push(["setData", data]),
      update: (point) => events.push(["update", point]),
    },
    patch: {
      fromOutputIndex: 2,
      deleteCount: 1,
      insert: [],
      nextData: [{ time: 10 }, { time: 20 }],
      previousLength: 3,
      nextLength: 2,
    },
  });

  assert.equal(result, "pop-update");
  assert.deepEqual(events, [["pop", 1]]);
});

test("projection renderer uses setData for a large changed suffix", () => {
  const events = [];
  const previousLength = 80;
  const nextData = Array.from({ length: 16 }, (_, index) => ({ time: index + 1 }));
  const result = renderMainSeriesProjectionPatch({
    series: {
      pop: (count) => events.push(["pop", count]),
      setData: (data) => events.push(["setData", data]),
      update: (point) => events.push(["update", point]),
    },
    patch: {
      fromOutputIndex: 10,
      deleteCount: 70,
      insert: nextData.slice(10),
      nextData,
      previousLength,
      nextLength: nextData.length,
    },
  });

  assert.equal(result, "setData");
  assert.deepEqual(events, [["setData", nextData]]);
});

test("projection renderer preserves viewport through setData instead of popping", () => {
  const events = [];
  const viewportEvents = [];
  const nextData = [{ time: 10 }, { time: 20 }, { time: 30 }];
  const result = renderMainSeriesProjectionPatch({
    indexOfDisplayTime: (time) => ({ 10: 0, 20: 1, 30: 2 }[time] ?? -1),
    preserveViewport: true,
    previousDisplayRows: [{ time: 10 }, { time: 20 }, { time: 40 }, { time: 50 }],
    series: {
      pop: (count) => events.push(["pop", count]),
      setData: (data) => events.push(["setData", data]),
      update: (point) => events.push(["update", point]),
    },
    patch: {
      fromOutputIndex: 2,
      deleteCount: 2,
      insert: [{ time: 30 }],
      nextData,
      previousLength: 4,
      nextLength: 3,
    },
    viewportController: {
      captureAnchor: () => {
        viewportEvents.push("capture");
        return { time: 20 };
      },
      applyAnchorShift: (anchor, resolver) => {
        viewportEvents.push(["apply", resolver(anchor.time)]);
      },
    },
  });

  assert.equal(result, "setData");
  assert.deepEqual(events, [["setData", nextData]]);
  assert.deepEqual(viewportEvents, ["capture", ["apply", 1]]);
});

test("projection renderer restores full data when pop throws", () => {
  const events = [];
  const nextData = [{ time: 10 }, { time: 20 }];
  const result = renderMainSeriesProjectionPatch({
    series: {
      pop: () => {
        events.push(["pop"]);
        throw new Error("pop failed");
      },
      setData: (data) => events.push(["setData", data]),
      update: (point) => events.push(["update", point]),
    },
    patch: {
      fromOutputIndex: 1,
      deleteCount: 2,
      insert: [{ time: 20 }],
      nextData,
      previousLength: 3,
      nextLength: 2,
    },
  });

  assert.equal(result, "setData");
  assert.deepEqual(events, [["pop"], ["setData", nextData]]);
});

test("projection renderer restores full data after a partial pop-update failure", () => {
  const events = [];
  const nextData = [{ time: 10 }, { time: 20 }, { time: 30 }, { time: 40 }];
  let updates = 0;
  const result = renderMainSeriesProjectionPatch({
    series: {
      pop: (count) => events.push(["pop", count]),
      setData: (data) => events.push(["setData", data]),
      update: (point) => {
        updates += 1;
        events.push(["update", point]);
        if (updates === 2) throw new Error("update failed");
      },
    },
    patch: {
      fromOutputIndex: 1,
      deleteCount: 2,
      insert: [{ time: 20 }, { time: 30 }, { time: 40 }],
      nextData,
      previousLength: 3,
      nextLength: 4,
    },
  });

  assert.equal(result, "setData");
  assert.deepEqual(events, [
    ["pop", 2],
    ["update", { time: 20 }],
    ["update", { time: 30 }],
    ["setData", nextData],
  ]);
});

test("projection renderer restores full data when a tail update throws", () => {
  const events = [];
  const nextData = [{ time: 10 }, { time: 20 }, { time: 30 }];
  let updates = 0;
  const result = renderMainSeriesProjectionPatch({
    series: {
      setData: (data) => events.push(["setData", data]),
      update: (point) => {
        updates += 1;
        events.push(["update", point]);
        if (updates === 2) throw new Error("update failed");
      },
    },
    patch: {
      fromOutputIndex: 1,
      deleteCount: 1,
      insert: [{ time: 20 }, { time: 30 }],
      nextData,
      previousLength: 2,
      nextLength: 3,
    },
  });

  assert.equal(result, "setData");
  assert.deepEqual(events, [
    ["update", { time: 20 }],
    ["update", { time: 30 }],
    ["setData", nextData],
  ]);
});

test("projection renderer rebuilds structural tails", () => {
  const events = [];
  const viewportEvents = [];
  const series = {
    setData: (data) => events.push(["setData", data]),
    update: (point) => events.push(["update", point]),
  };
  const nextData = [{ time: 5 }, { time: 10 }, { time: 20 }];
  const result = renderMainSeriesProjectionPatch({
    indexOfDisplayTime: (time) => ({ 5: 0, 10: 1, 20: 2 }[time] ?? -1),
    previousDisplayRows: [{ time: 10 }, { time: 20 }],
    preserveViewport: true,
    series,
    patch: {
      fromOutputIndex: 0,
      deleteCount: 2,
      insert: nextData,
      nextData,
      previousLength: 2,
      nextLength: 3,
    },
    viewportController: {
      captureAnchor: (rows) => {
        viewportEvents.push(["capture", rows]);
        return { time: 10 };
      },
      applyAnchorShift: (anchor, resolver) => {
        viewportEvents.push(["apply", anchor, resolver(anchor.time)]);
      },
    },
  });

  assert.equal(result, "setData");
  assert.deepEqual(events, [["setData", nextData]]);
  assert.deepEqual(viewportEvents, [
    ["capture", [{ time: 10 }, { time: 20 }]],
    ["apply", { time: 10 }, 1],
  ]);
});
