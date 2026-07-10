import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveDataTimeSet,
  shouldAdvanceIndicatorSeriesReady,
  shouldRequestMoreLeft,
  shouldRestoreChartViewport,
} from "../singleChartPaneLifecycle.js";

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
