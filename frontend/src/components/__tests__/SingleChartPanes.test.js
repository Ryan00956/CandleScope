import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVisibleRangeSnapshot,
  disposeChartPaneSurface,
  resolveDataTimeSet,
  shouldAdvanceDrawingCoordinateGeneration,
  shouldAdvanceIndicatorSeriesReady,
  shouldPublishUserViewportRange,
  shouldRequestMoreLeft,
  shouldRestoreChartViewport,
} from "../singleChartPaneLifecycle.js";

test("chart disposal detaches drawings and disables auto-size before removal", () => {
  const calls = [];
  disposeChartPaneSurface({
    applyOptions: (options) => calls.push(["options", options]),
    remove: () => calls.push(["remove"]),
  }, {
    beforeRemove: () => calls.push(["drawings"]),
  });

  assert.deepEqual(calls, [
    ["drawings"],
    ["options", { autoSize: false }],
    ["remove"],
  ]);
});

test("chart disposal still removes a surface when disabling auto-size fails", () => {
  const calls = [];
  assert.doesNotThrow(() => disposeChartPaneSurface({
    applyOptions: () => {
      calls.push("options");
      throw new Error("already disposing");
    },
    remove: () => calls.push("remove"),
  }));

  assert.deepEqual(calls, ["options", "remove"]);
});

test("chart disposal continues when drawing teardown fails", () => {
  const calls = [];
  assert.doesNotThrow(() => disposeChartPaneSurface({
    applyOptions: () => calls.push("options"),
    remove: () => calls.push("remove"),
  }, {
    beforeRemove: () => {
      calls.push("drawings");
      throw new Error("stale drawing runtime");
    },
  }));

  assert.deepEqual(calls, ["drawings", "options", "remove"]);
});

test("visible range snapshots include the fitted time and logical coverage", () => {
  assert.deepEqual(buildVisibleRangeSnapshot({
    barSpacing: 0.5,
    logicalRange: { from: -0.5, to: 1_500.5 },
    rightOffset: 0,
    timeRange: { from: 1_640_995_200, to: 1_770_652_800 },
  }), {
    barSpacing: 0.5,
    logical: { from: -0.5, to: 1_500.5 },
    rightOffset: 0,
    rightmostTime: 1_770_652_800,
    time: { from: 1_640_995_200, to: 1_770_652_800 },
  });
});

test("only user-driven viewport changes publish persistence and interactive coverage", () => {
  const range = { from: 0, to: 1_500 };

  assert.equal(shouldPublishUserViewportRange({ range, userInteracted: true }), true);
  assert.equal(shouldPublishUserViewportRange({ range, userInteracted: false }), false);
  assert.equal(shouldPublishUserViewportRange({
    isProgrammatic: true,
    range,
    userInteracted: true,
  }), false);
  assert.equal(shouldPublishUserViewportRange({
    isSyncing: true,
    range,
    userInteracted: true,
  }), false);
});

test("resolveDataTimeSet reuses one empty set until a series store exists", () => {
  const first = resolveDataTimeSet(null);
  const second = resolveDataTimeSet(undefined);
  const storeTimes = new Set([60, 120]);

  assert.strictEqual(second, first);
  assert.strictEqual(
    resolveDataTimeSet({ timeSet: () => storeTimes }),
    storeTimes,
  );
});

test("an empty indicator rebuild does not advance series readiness", () => {
  assert.equal(shouldAdvanceIndicatorSeriesReady(), false);
  assert.equal(shouldAdvanceIndicatorSeriesReady({
    createdSeriesCount: 0,
    paneStructureChanged: false,
    removedSeriesCount: 0,
    structureChanged: false,
  }), false);
});

test("viewport restore waits for full ready history instead of a provisional latest seed", () => {
  const datasetKey = "binance::spot::BTCUSDT::3m";

  assert.equal(shouldRestoreChartViewport({
    dataMeta: { status: "provisional", seriesKey: datasetKey },
    datasetKey,
    hasRows: true,
  }), false);
  assert.equal(shouldRestoreChartViewport({
    dataMeta: { status: "ready", seriesKey: "binance::spot::BTCUSDT::1h" },
    datasetKey,
    hasRows: true,
  }), false);
  assert.equal(shouldRestoreChartViewport({
    dataMeta: { status: "ready", seriesKey: datasetKey },
    datasetKey,
    hasRows: true,
  }), true);
  assert.equal(shouldRestoreChartViewport({
    dataMeta: { status: "ready", seriesKey: datasetKey, source: "kline-ws" },
    datasetKey,
    hasRestored: true,
    hasRows: true,
    lastRestoreSource: "memory-cache-hit",
  }), false);
  assert.equal(shouldRestoreChartViewport({
    dataMeta: { status: "ready", seriesKey: datasetKey, source: "initial-history" },
    datasetKey,
    hasRestored: true,
    hasRows: true,
    lastRestoreSource: "memory-cache-hit",
  }), true);
  assert.equal(shouldRestoreChartViewport({
    dataMeta: { status: "ready", seriesKey: datasetKey, source: "initial-history" },
    datasetKey,
    hasRestored: true,
    hasRows: true,
    lastRestoreSource: "memory-cache-hit",
    userInteracted: true,
  }), false);
  assert.equal(shouldRestoreChartViewport({
    dataMeta: { status: "ready", seriesKey: datasetKey, source: "initial-history" },
    datasetKey,
    hasRows: true,
    userInteracted: true,
  }), false);
});

test("fitting a fresh chart does not auto-load left history before user interaction", () => {
  const request = {
    canLoad: true,
    hasData: true,
    hasHandler: true,
    rangeFrom: 0,
    triggerBars: 20,
  };

  assert.equal(shouldRequestMoreLeft(request), false);
  assert.equal(shouldRequestMoreLeft({ ...request, userInteracted: true }), true);
  assert.equal(shouldRequestMoreLeft({
    ...request,
    rangeFrom: 21,
    userInteracted: true,
  }), false);
});

test("real indicator or pane structure changes advance series readiness", () => {
  for (const change of [
    { createdSeriesCount: 1 },
    { paneStructureChanged: true },
    { removedSeriesCount: 1 },
    { structureChanged: true },
  ]) {
    assert.equal(shouldAdvanceIndicatorSeriesReady(change), true);
  }
});

test("resolved derived projection replacement advances drawing coordinates", () => {
  assert.equal(shouldAdvanceDrawingCoordinateGeneration({
    axisMode: "derived-ordinal",
    canReuseProjection: false,
  }), true);
  assert.equal(shouldAdvanceDrawingCoordinateGeneration({
    axisMode: "derived-ordinal",
    canReuseProjection: true,
  }), false);
  assert.equal(shouldAdvanceDrawingCoordinateGeneration({
    axisMode: "time",
    canReuseProjection: false,
  }), false);
});
