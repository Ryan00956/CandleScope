import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMainSeriesProjectionPatch,
  materializeMainSeriesProjectionPatch,
  renderMainSeriesProjectionPatch,
} from "../projectionSeriesRenderer.js";
import { buildMainSeriesData } from "../mainSeriesModel.js";

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

  assert.equal(Object.hasOwn(patch, "nextData"), false);
  assert.strictEqual(patch.previousData, previousSeriesData);
  assert.deepEqual({
    kind: patch.kind,
    fromOutputIndex: patch.fromOutputIndex,
    deleteCount: patch.deleteCount,
    insert: patch.insert,
    previousLength: patch.previousLength,
    nextLength: patch.nextLength,
  }, {
    kind: "replace-tail",
    fromOutputIndex: 1,
    deleteCount: 1,
    insert: [
      { time: 20, value: 108 },
      { time: 30, value: 110 },
    ],
    previousLength: 2,
    nextLength: 3,
  });
  assert.deepEqual(materializeMainSeriesProjectionPatch(patch), [
    { time: 10, value: 105 },
    { time: 20, value: 108 },
    { time: 30, value: 110 },
  ]);
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
  assert.deepEqual(
    materializeMainSeriesProjectionPatch(patch).map((point) => point.time),
    [10, 20, 30],
  );
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
      previousData: [{ time: 10 }, { time: 20 }],
      nextLength: 3,
    },
  });

  assert.equal(result.mode, "update");
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

  assert.equal(result.mode, "setData");
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
      previousData: [{ time: 10 }, { time: 20 }],
      nextLength: 2,
    },
  });

  assert.equal(result.mode, "noop");
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
      previousData: [{ time: 10 }, { time: 20 }, { time: 25 }, { time: 35 }],
      nextLength: 5,
    },
  });

  assert.equal(result.mode, "pop-update");
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
      previousData: [{ time: 10 }, { time: 20 }, { time: 30 }],
      nextLength: 2,
    },
  });

  assert.equal(result.mode, "pop-update");
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

  assert.equal(result.mode, "setData");
  assert.deepEqual(events, [["setData", nextData]]);
});

test("projection renderer preserves viewport through setData instead of popping", () => {
  const events = [];
  const viewportEvents = [];
  const nextData = [{ time: 10 }, { time: 20 }, { time: 30 }];
  const result = renderMainSeriesProjectionPatch({
    resolveDisplayAnchorIndex: (time) => ({ 10: 0, 20: 1, 30: 2 }[time] ?? -1),
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
      previousData: [{ time: 10 }, { time: 20 }, { time: 40 }, { time: 50 }],
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

  assert.equal(result.mode, "setData");
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
      previousData: [{ time: 10 }, { time: 15 }, { time: 25 }],
      nextLength: 2,
    },
  });

  assert.equal(result.mode, "setData");
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
      previousData: [{ time: 10 }, { time: 15 }, { time: 25 }],
      nextLength: 4,
    },
  });

  assert.equal(result.mode, "setData");
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
      previousData: [{ time: 10 }, { time: 15 }],
      nextLength: 3,
    },
  });

  assert.equal(result.mode, "setData");
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
    resolveDisplayAnchorIndex: (time) => ({ 5: 0, 10: 1, 20: 2 }[time] ?? -1),
    previousDisplayRows: [{ time: 10 }, { time: 20 }],
    preserveViewport: true,
    series,
    patch: {
      fromOutputIndex: 0,
      deleteCount: 2,
      insert: nextData,
      nextData,
      previousLength: 2,
      previousData: [{ time: 10 }, { time: 20 }],
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

  assert.equal(result.mode, "setData");
  assert.deepEqual(events, [["setData", nextData]]);
  assert.deepEqual(viewportEvents, [
    ["capture", [{ time: 10 }, { time: 20 }]],
    ["apply", { time: 10 }, 1],
  ]);
});

test("successful append commits the rendered cache in place without reading its prefix", () => {
  const size = 5000;
  const displayRows = Array.from({ length: size + 1 }, (_, index) => ({
    time: index + 1,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
  }));
  const backing = Array.from({ length: size }, (_, index) => ({
    time: index + 1,
    value: 101 + index,
  }));
  let numericReads = 0;
  const previousSeriesData = new Proxy(backing, {
    get(target, property, receiver) {
      if (/^(0|[1-9]\d*)$/.test(String(property))) numericReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const patch = buildMainSeriesProjectionPatch({
    displayRows,
    previousSeriesData,
    projectionPatch: { fromOutputIndex: size },
    renderOptions: { chartType: "line" },
  });

  assert.equal(Object.hasOwn(patch, "nextData"), false);
  const result = renderMainSeriesProjectionPatch({
    patch,
    series: {
      setData: () => assert.fail("append should not rebuild the series"),
      update: () => {},
    },
  });

  assert.equal(result.mode, "update");
  assert.strictEqual(result.nextData, previousSeriesData);
  assert.equal(result.nextData.length, size + 1);
  assert.equal(numericReads, 0);
});

test("successful pop-update commits the rendered cache in place", () => {
  const previousSeriesData = [
    { time: 1, value: 10 },
    { time: 2, value: 12 },
    { time: 3, value: 14 },
    { time: 4, value: 16 },
  ];
  const displayRows = [
    { time: 1, close: 10 },
    { time: 2, close: 12 },
    { time: 5, close: 11 },
  ];
  const patch = buildMainSeriesProjectionPatch({
    displayRows,
    previousSeriesData,
    projectionPatch: { fromOutputIndex: 2 },
    renderOptions: { chartType: "line" },
  });
  const result = renderMainSeriesProjectionPatch({
    patch,
    series: { pop: () => {}, setData: () => {}, update: () => {} },
  });

  assert.equal(result.mode, "pop-update");
  assert.strictEqual(result.nextData, previousSeriesData);
  assert.deepEqual(result.nextData, [
    { time: 1, value: 10 },
    { time: 2, value: 12 },
    { time: 5, value: 11 },
  ]);
});

test("failed incremental rendering materializes recovery data without mutating the old cache", () => {
  const previousSeriesData = [
    { time: 1, value: 10 },
    { time: 2, value: 12 },
  ];
  const original = previousSeriesData.slice();
  const patch = buildMainSeriesProjectionPatch({
    displayRows: [
      { time: 1, close: 10 },
      { time: 2, close: 13 },
      { time: 3, close: 15 },
    ],
    previousSeriesData,
    projectionPatch: { fromOutputIndex: 1 },
    renderOptions: { chartType: "line" },
  });
  let updates = 0;
  let recoveryData = null;
  const result = renderMainSeriesProjectionPatch({
    patch,
    series: {
      setData: (data) => { recoveryData = data; },
      update: () => {
        updates += 1;
        if (updates === 2) throw new Error("update failed");
      },
    },
  });

  assert.equal(result.mode, "setData");
  assert.deepEqual(previousSeriesData, original);
  assert.notStrictEqual(result.nextData, previousSeriesData);
  assert.strictEqual(recoveryData, result.nextData);
  assert.deepEqual(result.nextData.map((point) => point.value), [10, 13, 15]);
});

test("a frozen rendered cache safely falls back to a new committed array", () => {
  const previousSeriesData = Object.freeze([
    { time: 1, value: 10 },
    { time: 2, value: 12 },
  ]);
  const patch = buildMainSeriesProjectionPatch({
    displayRows: [
      { time: 1, close: 10 },
      { time: 2, close: 12 },
      { time: 3, close: 14 },
    ],
    previousSeriesData,
    projectionPatch: { fromOutputIndex: 2 },
    renderOptions: { chartType: "line" },
  });
  const result = renderMainSeriesProjectionPatch({
    patch,
    series: { setData: () => {}, update: () => {} },
  });

  assert.equal(result.mode, "update");
  assert.notStrictEqual(result.nextData, previousSeriesData);
  assert.deepEqual(result.nextData.map((point) => point.value), [10, 12, 14]);
});

test("a failed recovery setData leaves the old rendered cache untouched", () => {
  const previousSeriesData = [
    { time: 1, value: 10 },
    { time: 2, value: 12 },
  ];
  const original = previousSeriesData.slice();
  const patch = buildMainSeriesProjectionPatch({
    displayRows: [
      { time: 1, close: 10 },
      { time: 2, close: 13 },
      { time: 3, close: 15 },
    ],
    previousSeriesData,
    projectionPatch: { fromOutputIndex: 1 },
    renderOptions: { chartType: "line" },
  });

  assert.throws(() => renderMainSeriesProjectionPatch({
    patch,
    series: {
      setData: () => { throw new Error("setData failed"); },
      update: () => { throw new Error("update failed"); },
    },
  }), /setData failed/);
  assert.deepEqual(previousSeriesData, original);
});

test("repeated lazy tail commits stay equivalent to fresh full conversion", () => {
  let displayRows = [];
  let renderedData = [];
  let nextTime = 1;
  let randomState = 0x51ced;
  const random = () => {
    randomState = ((randomState * 1664525) + 1013904223) >>> 0;
    return randomState / 0x100000000;
  };
  const series = { pop: () => {}, setData: () => {}, update: () => {} };

  for (let operation = 0; operation < 240; operation += 1) {
    let fromOutputIndex = displayRows.length;
    const choice = random();
    if (displayRows.length === 0 || choice < 0.55) {
      displayRows = [
        ...displayRows,
        { time: nextTime, close: 80 + Math.floor(random() * 40) },
      ];
      nextTime += 1;
    } else if (choice < 0.82) {
      fromOutputIndex = displayRows.length - 1;
      displayRows = [
        ...displayRows.slice(0, -1),
        { ...displayRows.at(-1), close: 80 + Math.floor(random() * 40) },
      ];
    } else {
      const deleteCount = Math.min(
        displayRows.length,
        1 + Math.floor(random() * 4),
      );
      fromOutputIndex = displayRows.length - deleteCount;
      displayRows = displayRows.slice(0, fromOutputIndex);
    }

    const patch = buildMainSeriesProjectionPatch({
      displayRows,
      previousSeriesData: renderedData,
      projectionPatch: { fromOutputIndex },
      renderOptions: { chartType: "line" },
    });
    const result = renderMainSeriesProjectionPatch({ patch, series });
    renderedData = result.nextData;
    assert.deepEqual(
      renderedData,
      buildMainSeriesData(displayRows, { chartType: "line" }),
      `render cache diverged after operation ${operation}`,
    );
  }
});

test("an invalid tail patch rebuilds from explicit data before touching incremental methods", () => {
  const events = [];
  const nextData = [{ time: 1 }, { time: 2 }, { time: 9 }];
  const result = renderMainSeriesProjectionPatch({
    patch: {
      deleteCount: 1,
      fromOutputIndex: 2,
      insert: [{ time: 9 }],
      nextData,
      nextLength: 5,
      previousLength: 5,
    },
    series: {
      pop: () => events.push("pop"),
      setData: (data) => events.push(["setData", data]),
      update: () => events.push("update"),
    },
  });

  assert.equal(result.mode, "setData");
  assert.strictEqual(result.nextData, nextData);
  assert.deepEqual(events, [["setData", nextData]]);
});

test("an invalid lazy tail patch throws before mutating the series", () => {
  const events = [];
  assert.throws(() => renderMainSeriesProjectionPatch({
    patch: {
      deleteCount: 1,
      fromOutputIndex: 2,
      insert: [{ time: 9 }],
      nextLength: 5,
      previousData: [{ time: 1 }, { time: 2 }, { time: 3 }, { time: 4 }, { time: 5 }],
      previousLength: 5,
    },
    series: {
      pop: () => events.push("pop"),
      setData: () => events.push("setData"),
      update: () => events.push("update"),
    },
  }), /complete rendered tail replacement/);
  assert.deepEqual(events, []);
});

test("a shape-valid explicit patch without previous data rebuilds instead of updating", () => {
  const events = [];
  const nextData = [{ time: 1 }, { time: 2 }, { time: 3 }];
  const result = renderMainSeriesProjectionPatch({
    patch: {
      deleteCount: 0,
      fromOutputIndex: 2,
      insert: [{ time: 3 }],
      nextData,
      nextLength: 3,
      previousLength: 2,
    },
    series: {
      setData: (data) => events.push(["setData", data]),
      update: () => events.push("update"),
    },
  });

  assert.equal(result.mode, "setData");
  assert.strictEqual(result.nextData, nextData);
  assert.deepEqual(events, [["setData", nextData]]);
});

test("a shape-valid lazy patch without previous data throws before updating", () => {
  const events = [];
  assert.throws(() => renderMainSeriesProjectionPatch({
    patch: {
      deleteCount: 0,
      fromOutputIndex: 2,
      insert: [{ time: 3 }],
      nextLength: 3,
      previousLength: 2,
    },
    series: {
      setData: () => events.push("setData"),
      update: () => events.push("update"),
    },
  }), /require previous rendered data/);
  assert.deepEqual(events, []);
});

test("frozen patch objects can materialize and commit incremental data", () => {
  const previousSeriesData = [
    { time: 1, value: 10 },
    { time: 2, value: 12 },
  ];
  const patch = Object.freeze(buildMainSeriesProjectionPatch({
    displayRows: [
      { time: 1, close: 10 },
      { time: 2, close: 12 },
      { time: 3, close: 14 },
    ],
    previousSeriesData,
    projectionPatch: { fromOutputIndex: 2 },
    renderOptions: { chartType: "line" },
  }));
  const result = renderMainSeriesProjectionPatch({
    patch,
    series: { setData: () => {}, update: () => {} },
  });

  assert.equal(result.mode, "update");
  assert.strictEqual(result.nextData, previousSeriesData);
  assert.deepEqual(materializeMainSeriesProjectionPatch(patch), previousSeriesData);
});

test("viewport compensation failure cannot undo a successful data commit", () => {
  const nextData = [{ time: 1 }, { time: 2 }, { time: 3 }];
  const result = renderMainSeriesProjectionPatch({
    resolveDisplayAnchorIndex: () => 0,
    patch: {
      deleteCount: 2,
      fromOutputIndex: 1,
      insert: nextData.slice(1),
      nextData,
      nextLength: 3,
      previousLength: 3,
    },
    preserveViewport: true,
    previousDisplayRows: [{ time: 1 }, { time: 2 }, { time: 4 }],
    series: { setData: () => {} },
    viewportController: {
      applyAnchorShift: () => { throw new Error("viewport failed"); },
      captureAnchor: () => ({ time: 1 }),
    },
  });

  assert.equal(result.mode, "setData");
  assert.strictEqual(result.nextData, nextData);
});

test("performance instrumentation failure cannot interrupt an incremental cache commit", () => {
  const previousSeriesData = [{ time: 1, value: 10 }];
  const patch = buildMainSeriesProjectionPatch({
    displayRows: [{ time: 1, close: 10 }, { time: 2, close: 12 }],
    previousSeriesData,
    projectionPatch: { fromOutputIndex: 1 },
    renderOptions: { chartType: "line" },
  });
  const result = renderMainSeriesProjectionPatch({
    patch,
    recordPerfEvent: () => { throw new Error("telemetry failed"); },
    series: { setData: () => {}, update: () => {} },
  });

  assert.equal(result.mode, "update");
  assert.strictEqual(result.nextData, previousSeriesData);
  assert.equal(result.nextData.length, 2);
});
