import assert from "node:assert/strict";
import test from "node:test";

import {
  clearIndicatorLineData,
  normalizeIndicatorPayload,
  replaceIndicatorItemsRange,
  replaceIndicatorLinesRange,
  upsertLinePoint,
} from "../indicatorPayloadRuntime.js";
import {
  IndicatorPayloadError,
  parseIndicatorParameterSchemas,
  parseIndicatorPayloadEnvelope,
} from "../indicatorContracts.js";
import { mustBeDefined } from "../../../test/testHelpers.js";

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

test("realtime line upserts use sorted insertion and preserve identity for no-ops", () => {
  const original = [
    { time: 10, value: 1 },
    { time: 30, value: 3 },
  ];
  assert.equal(upsertLinePoint(original, { time: 30, value: 3 }), original);
  assert.deepEqual(upsertLinePoint(original, { time: 20, value: 2 }), [
    { time: 10, value: 1 },
    { time: 20, value: 2 },
    { time: 30, value: 3 },
  ]);
  assert.deepEqual(upsertLinePoint(original, { time: 40, value: 4 }), [
    ...original,
    { time: 40, value: 4 },
  ]);
});

test("parameter schemas omit absent optional fields", () => {
  const schemas = parseIndicatorParameterSchemas([
    { key: "period" },
    { name: "source", label: "Source", default: null, min: 1 },
  ]);

  assert.deepEqual(schemas, [
    { key: "period" },
    { name: "source", label: "Source", default: null, min: 1 },
  ]);
  for (const field of ["label", "type", "default", "min", "max", "step", "options"]) {
    assert.equal(Object.hasOwn(mustBeDefined(schemas[0]), field), false);
  }
});

test("indicator payload parser preserves terminal availability metadata", () => {
  const parsed = parseIndicatorPayloadEnvelope({
    ok: false,
    code: "INDICATOR_RANGE_EMPTY",
    history_state: "exhausted",
    complete: true,
    retryable: false,
    terminal_reason: "source_exhausted",
    earliest_available_ms: 1_700_000_000_000,
    next_before_ms: null,
    availability_revision: "history-v2",
    excluded_ranges: [{
      start_ms: 1_699_999_000_000,
      end_ms: 1_699_999_999_999,
      reason: "market_closed",
    }],
  });

  assert.equal(parsed.history_state, "exhausted");
  assert.equal(parsed.retryable, false);
  assert.equal(parsed.terminal_reason, "source_exhausted");
  assert.deepEqual(parsed.excluded_ranges, [{
    start_ms: 1_699_999_000_000,
    end_ms: 1_699_999_999_999,
    reason: "market_closed",
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

  const line = mustBeDefined(lines[0]);
  assert.deepEqual(line.data, [
    { time: 10, value: 1 },
    { time: 20, value: 200 },
    { time: 40, value: 4 },
  ]);
  assert.deepEqual(line.colorData, [
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

  assert.deepEqual(mustBeDefined(markers[0]).data, [
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

  assert.equal(mustBeDefined(normalized.lines[0]).indicatorId, undefined);
  assert.equal(mustBeDefined(normalized.markers[0]).indicatorId, "ma-1");
  assert.equal(mustBeDefined(normalized.hlines[0]).price, 50);
  const bgcolors = mustBeDefined(normalized.bgcolors);
  const bgcolor = mustBeDefined(bgcolors[0]);
  const regions = mustBeDefined(bgcolor.regions);
  assert.equal(mustBeDefined(regions[0]).time, 10);
  const barcolor = mustBeDefined(normalized.barcolors[0]);
  assert.equal(mustBeDefined(barcolor.data[0]).color, "#def");
  assert.equal(mustBeDefined(normalized.signals[0]).name, "signal");
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
