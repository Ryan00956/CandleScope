import assert from "node:assert/strict";
import test from "node:test";

import {
  clearIndicatorLineData,
  normalizeIndicatorPayload,
  replaceIndicatorItemsRange,
  replaceIndicatorLinesRange,
} from "../indicatorPayloadRuntime.js";
import { IndicatorPayloadError } from "../indicatorContracts.js";

test("clearIndicatorLineData keeps line identity and style while clearing timed data", () => {
  const cleared = clearIndicatorLineData([{
    id: "hist",
    outputName: "volume",
    pane: "volume",
    type: "histogram",
    color: "#f59e0b",
    data: [{ time: 10, value: 100 }],
    colorData: [{ time: 10, color: "#22c55e" }],
  }]);

  assert.deepEqual(cleared, [{
    id: "hist",
    outputName: "volume",
    pane: "volume",
    type: "histogram",
    color: "#f59e0b",
    data: [],
    colorData: [],
  }]);
});

test("replaceIndicatorLinesRange replaces only the target time window", () => {
  const lines = replaceIndicatorLinesRange(
    [{
      outputName: "ma",
      data: [
        { time: 10, value: 1 },
        { time: 20, value: 2 },
        { time: 30, value: 3 },
        { time: 40, value: 4 },
      ],
      colorData: [
        { time: 10, color: "#111" },
        { time: 20, color: "#222" },
        { time: 30, color: "#333" },
        { time: 40, color: "#444" },
      ],
    }],
    [{
      outputName: "ma",
      data: [{ time: 20, value: 200 }],
      colorData: [{ time: 20, color: "#abc" }],
    }],
    { start: 20, end: 30 },
  );

  assert.deepEqual(lines[0].data, [
    { time: 10, value: 1 },
    { time: 20, value: 200 },
    { time: 40, value: 4 },
  ]);
  assert.deepEqual(lines[0].colorData, [
    { time: 10, color: "#111" },
    { time: 20, color: "#abc" },
    { time: 40, color: "#444" },
  ]);
});

test("replaceIndicatorItemsRange deletes stale timed items inside the target window", () => {
  const markers = replaceIndicatorItemsRange(
    [{
      id: "marker",
      indicatorId: "ma-1",
      data: [
        { time: 10, text: "keep-left" },
        { time: 20, text: "drop" },
        { time: 30, text: "drop-too" },
        { time: 40, text: "keep-right" },
      ],
    }],
    [{
      id: "marker",
      indicatorId: "ma-1",
      data: [{ time: 30, text: "new" }],
    }],
    { start: 20, end: 30 },
  );

  assert.deepEqual(markers[0].data, [
    { time: 10, text: "keep-left" },
    { time: 30, text: "new" },
    { time: 40, text: "keep-right" },
  ]);
});

test("normalizeIndicatorPayload parses every unified annotation output kind", () => {
  const normalized = normalizeIndicatorPayload({
    ok: true,
    series: [{
      id: "ma:line",
      localId: "ma",
      pane: "main",
      type: "line",
      data: [{ time: 10, value: 100 }],
      style: { title: "MA", color: "#abc", lineWidth: 2, lineStyle: 0 },
    }],
    annotations: [
      { id: "m", pane: "main", type: "marker", data: [{ time: 10, text: "M" }], style: {} },
      { id: "h", pane: "main", type: "hline", data: [{ value: 50 }], style: {} },
      { id: "bg", pane: "main", type: "bgcolor", data: [{ time: 10, endTime: 20 }], style: {} },
      { id: "bar", pane: "main", type: "barcolor", data: [{ time: 10, color: "#def" }], style: {} },
      { id: "signal", pane: "main", type: "signal", data: [{ time: 10, text: "buy" }], style: {} },
    ],
  }, "ma-1");

  assert.equal(normalized.lines[0].indicatorId, undefined);
  assert.equal(normalized.markers[0].indicatorId, "ma-1");
  assert.equal(normalized.hlines[0].price, 50);
  assert.equal(normalized.bgcolors[0].regions[0].time, 10);
  assert.equal(normalized.barcolors[0].data[0].color, "#def");
  assert.equal(normalized.signals[0].name, "signal");
});

test("normalizeIndicatorPayload rejects malformed line points", () => {
  assert.throws(
    () => normalizeIndicatorPayload({
      ok: true,
      lines: [{ outputName: "ma", data: [{ time: "10", value: 1 }] }],
    }, "ma-1"),
    (error) => error instanceof IndicatorPayloadError && error.path === "indicator.lines[0].data[0].time",
  );
});

test("normalizeIndicatorPayload rejects unknown unified annotation kinds", () => {
  assert.throws(
    () => normalizeIndicatorPayload({
      ok: true,
      annotations: [{ id: "future", pane: "main", type: "future", data: [], style: {} }],
    }, "ma-1"),
    (error) => error instanceof IndicatorPayloadError && error.path === "indicator.annotations[0].type",
  );
});
