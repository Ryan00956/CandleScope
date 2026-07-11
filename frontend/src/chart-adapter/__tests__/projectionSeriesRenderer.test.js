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
