import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVisibleRangeSnapshot,
  disposeChartPaneSurface,
  hasCurrentDatasetOwnership as hasCurrentDatasetOwnershipProduction,
  removedDrawingSubPaneScopeKeys,
  prepareDrawingSurfaceForSeriesReplacement,
  resolveIntervalTransitionReplayData,
  resolveDataTimeSet,
  shouldAdvanceDrawingCoordinateGeneration,
  shouldAdvanceIndicatorSeriesReady,
  shouldPublishUserViewportRange,
  shouldRequestMoreLeft,
  shouldRestoreChartViewport as shouldRestoreChartViewportProduction,
} from "../singleChartPaneLifecycle.js";
import { structuralMock } from "../../test/testHelpers.js";

function hasCurrentDatasetOwnership(value: object): boolean {
  return hasCurrentDatasetOwnershipProduction(
    structuralMock<NonNullable<Parameters<typeof hasCurrentDatasetOwnershipProduction>[0]>>(value),
  );
}

function shouldRestoreChartViewport(value: object): boolean {
  return shouldRestoreChartViewportProduction(
    structuralMock<NonNullable<Parameters<typeof shouldRestoreChartViewportProduction>[0]>>(value),
  );
}

test("chart disposal detaches drawings and disables auto-size before removal", () => {
  const calls: unknown[] = [];
  assert.equal(disposeChartPaneSurface({
    applyOptions: (options) => calls.push(["options", options]),
    remove: () => calls.push(["remove"]),
  }, {
    beforeRemove: () => { calls.push(["drawings"]); },
    afterRemove: () => { calls.push(["drawings-complete"]); },
  }), true);

  assert.deepEqual(calls, [
    ["drawings"],
    ["options", { autoSize: false }],
    ["remove"],
    ["drawings-complete"],
  ]);
});

test("chart disposal still removes a surface when disabling auto-size fails", () => {
  const calls: unknown[] = [];
  assert.doesNotThrow(() => disposeChartPaneSurface({
    applyOptions: () => {
      calls.push("options");
      throw new Error("already disposing");
    },
    remove: () => calls.push("remove"),
  }));

  assert.deepEqual(calls, ["options", "remove"]);
});

test("chart disposal reports failure and continues when drawing teardown throws", () => {
  const calls: unknown[] = [];
  assert.equal(disposeChartPaneSurface({
    applyOptions: () => calls.push("options"),
    remove: () => calls.push("remove"),
  }, {
    beforeRemove: () => {
      calls.push("drawings");
      throw new Error("stale drawing runtime");
    },
    afterRemove: () => { calls.push("drawings-complete"); },
  }), false);

  assert.deepEqual(calls, ["drawings", "options", "remove", "drawings-complete"]);
});

test("sub-pane drawing cleanup never applies previous ids to a new symbol base", () => {
  assert.deepEqual(removedDrawingSubPaneScopeKeys({
    currentBase: "binance:spot:ETHUSDT",
    currentIds: new Set(["rsi"]),
    previousBase: "binance:spot:BTCUSDT",
    previousIds: new Set(["rsi", "macd"]),
  }), []);
  assert.deepEqual(removedDrawingSubPaneScopeKeys({
    currentBase: "binance:spot:BTCUSDT",
    currentIds: new Set(["rsi"]),
    previousBase: "binance:spot:BTCUSDT",
    previousIds: new Set(["rsi", "macd"]),
  }), ["binance:spot:BTCUSDT__macd"]);
});

test("main-series drawing preparation restores partial and throwing failures", () => {
  const calls: string[] = [];
  assert.equal(prepareDrawingSurfaceForSeriesReplacement(() => {
    calls.push("prepare-false");
    return false;
  }, () => calls.push("restore-false")), false);
  assert.equal(prepareDrawingSurfaceForSeriesReplacement(() => {
    calls.push("prepare-throw");
    throw new Error("partial detach");
  }, () => calls.push("restore-throw")), false);
  assert.equal(prepareDrawingSurfaceForSeriesReplacement(() => {
    calls.push("prepare-success");
    return true;
  }, () => calls.push("restore-unexpected")), true);
  assert.deepEqual(calls, [
    "prepare-false",
    "restore-false",
    "prepare-throw",
    "restore-throw",
    "prepare-success",
  ]);
});

test("chart disposal reports explicit drawing failure while still releasing the chart", () => {
  const calls: string[] = [];
  assert.equal(disposeChartPaneSurface({
    applyOptions: () => calls.push("options"),
    remove: () => calls.push("remove"),
  }, {
    beforeRemove: () => {
      calls.push("drawings");
      return false;
    },
    afterRemove: () => { calls.push("drawings-complete"); },
  }), false);

  assert.deepEqual(calls, ["drawings", "options", "remove", "drawings-complete"]);
});

test("chart disposal invalidates drawing credentials even when remove throws", () => {
  const calls: string[] = [];
  assert.equal(disposeChartPaneSurface({
    remove: () => {
      calls.push("remove");
      throw new Error("remove failed");
    },
  }, {
    afterRemove: () => { calls.push("drawings-complete"); },
  }), false);
  assert.deepEqual(calls, ["remove", "drawings-complete"]);
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
    resolveDataTimeSet(structuralMock<NonNullable<Parameters<typeof resolveDataTimeSet>[0]>>({
      timeSet: () => storeTimes,
    })),
    storeTimes,
  );
});

test("indicator reconciliation requires metadata and store ownership for the current dataset", () => {
  const datasetKey = "binance-spot-BTCUSDT-5m";
  const currentStore = { seriesKey: datasetKey };

  assert.equal(hasCurrentDatasetOwnership({
    dataMeta: { status: "provisional", seriesKey: datasetKey },
    datasetKey,
    seriesStore: currentStore,
  }), true);
  assert.equal(hasCurrentDatasetOwnership({
    dataMeta: { seriesKey: "binance-spot-BTCUSDT-1m" },
    datasetKey,
    seriesStore: currentStore,
  }), false);
  assert.equal(hasCurrentDatasetOwnership({
    dataMeta: { seriesKey: datasetKey },
    datasetKey,
    seriesStore: { seriesKey: "binance-spot-BTCUSDT-1m" },
  }), false);
  assert.equal(hasCurrentDatasetOwnership({
    dataMeta: { optimistic: true, seriesKey: datasetKey },
    datasetKey,
    seriesStore: currentStore,
  }), false);
});

test("interval replay prefers committed data and never restores old data onto a replacement series", () => {
  const scheduledSeries = {};
  const replacementSeries = {};
  const fallbackData = [{ time: 1 }];
  const committedData = [{ time: 2 }];

  assert.strictEqual(resolveIntervalTransitionReplayData({
    currentData: committedData,
    currentGeneration: 2,
    currentSeries: scheduledSeries,
    fallbackData,
    scheduledGeneration: 1,
    scheduledSeries,
  }), committedData);
  assert.strictEqual(resolveIntervalTransitionReplayData({
    currentData: [],
    currentGeneration: 1,
    currentSeries: scheduledSeries,
    fallbackData,
    scheduledGeneration: 1,
    scheduledSeries,
  }), fallbackData);
  assert.deepEqual(resolveIntervalTransitionReplayData({
    currentData: [],
    currentGeneration: 2,
    currentSeries: scheduledSeries,
    fallbackData,
    scheduledGeneration: 1,
    scheduledSeries,
  }), []);
  assert.equal(resolveIntervalTransitionReplayData({
    currentData: null,
    currentGeneration: 2,
    currentSeries: scheduledSeries,
    fallbackData,
    scheduledGeneration: 1,
    scheduledSeries,
  }), null);
  assert.deepEqual(resolveIntervalTransitionReplayData({
    currentData: [],
    currentGeneration: 1,
    currentSeries: replacementSeries,
    fallbackData,
    scheduledGeneration: 1,
    scheduledSeries,
  }), []);
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
