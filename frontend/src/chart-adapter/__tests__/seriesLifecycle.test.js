import assert from "node:assert/strict";
import test from "node:test";
import {
  createFutureTimeAxisSeries,
  INDICATOR_SERIES_INCREMENTAL_GRACE_MS,
  removeSeriesEntries,
  replaceMainSeries,
  resyncSeriesTimeScaleIndexes,
  shouldPreferIndicatorSetData,
} from "../seriesLifecycle.js";
import { chartSeriesTypes } from "../lightweightChartSurface.js";

function createHarness({ failNextSetData = false } = {}) {
  const operations = [];
  const previousData = [{ time: 1, open: 1, high: 2, low: 0, close: 1.5 }];
  const previousSeries = {
    data() {
      operations.push(["previous.data"]);
      return previousData;
    },
    seriesOrder() {
      operations.push(["previous.seriesOrder"]);
      return 3;
    },
    setData(data) {
      operations.push(["previous.setData", data]);
    },
  };
  const nextSeries = {
    setData(data) {
      operations.push(["next.setData", data]);
      if (failNextSetData) throw new Error("setData failed");
    },
    setSeriesOrder(order) {
      operations.push(["next.setSeriesOrder", order]);
    },
  };
  const chart = {
    addSeries() {
      operations.push(["chart.addSeries"]);
      return nextSeries;
    },
    removeSeries(series) {
      operations.push(["chart.removeSeries", series]);
    },
  };
  return { chart, nextSeries, operations, previousData, previousSeries };
}

test("future time-axis carrier is an invisible line series in the main pane", () => {
  const calls = [];
  const carrier = {};
  const chart = {
    addSeries: (...args) => {
      calls.push(args);
      return carrier;
    },
  };

  assert.equal(createFutureTimeAxisSeries(chart), carrier);
  assert.strictEqual(calls[0][0], chartSeriesTypes.line);
  assert.deepEqual(calls[0][1], {
    crosshairMarkerVisible: false,
    lastValueVisible: false,
    priceLineVisible: false,
    title: "",
    visible: false,
  });
  assert.equal(calls[0][2], 0);
});

test("replaceMainSeries clears duplicate main-series time points before registering the replacement", () => {
  const harness = createHarness();
  const seriesData = [{ time: 1, value: 1.5 }];

  const result = replaceMainSeries(harness.chart, harness.previousSeries, {
    chartType: "line",
    data: harness.previousData,
    paneIndex: 0,
    seriesData,
  });

  assert.equal(result.series, harness.nextSeries);
  assert.equal(result.data, seriesData);
  assert.deepEqual(harness.operations.map(([name]) => name), [
    "previous.seriesOrder",
    "previous.data",
    "chart.addSeries",
    "previous.setData",
    "next.setData",
    "next.setSeriesOrder",
    "chart.removeSeries",
  ]);
  assert.deepEqual(harness.operations[3][1], []);
  assert.equal(harness.operations[6][1], harness.previousSeries);
});

test("replaceMainSeries restores the previous data if replacement registration fails", () => {
  const harness = createHarness({ failNextSetData: true });

  assert.throws(() => replaceMainSeries(harness.chart, harness.previousSeries, {
    chartType: "line",
    data: harness.previousData,
    paneIndex: 0,
    seriesData: [{ time: 1, value: 1.5 }],
  }), /setData failed/);

  assert.deepEqual(harness.operations.map(([name]) => name), [
    "previous.seriesOrder",
    "previous.data",
    "chart.addSeries",
    "previous.setData",
    "next.setData",
    "chart.removeSeries",
    "previous.setData",
  ]);
  assert.equal(harness.operations[5][1], harness.nextSeries);
  assert.equal(harness.operations[6][1], harness.previousData);
});

test("replaceMainSeries does not leak a replacement if reading rollback data fails", () => {
  const harness = createHarness();
  harness.previousSeries.data = () => {
    harness.operations.push(["previous.data"]);
    throw new Error("data read failed");
  };

  assert.throws(() => replaceMainSeries(harness.chart, harness.previousSeries, {
    chartType: "line",
    data: harness.previousData,
    paneIndex: 0,
    seriesData: [{ time: 1, value: 1.5 }],
  }), /data read failed/);

  assert.deepEqual(harness.operations.map(([name]) => name), [
    "previous.seriesOrder",
    "previous.data",
  ]);
});

test("removeSeriesEntries clears indicator data before detaching each series", () => {
  const operations = [];
  const entries = [1, 2].map((id) => ({
    series: {
      id,
      setData(data) {
        operations.push(["setData", id, data]);
      },
    },
  }));
  const chart = {
    removeSeries(series) {
      operations.push(["removeSeries", series.id]);
    },
  };

  assert.equal(removeSeriesEntries(chart, entries), 2);
  assert.deepEqual(operations, [
    ["setData", 1, []],
    ["removeSeries", 1],
    ["setData", 2, []],
    ["removeSeries", 2],
  ]);
});

test("removeSeriesEntries still detaches a stale series when clearing it fails", () => {
  const removed = [];
  const series = {
    setData() {
      throw new Error("already detached");
    },
  };
  const chart = {
    removeSeries(value) {
      removed.push(value);
    },
  };

  assert.equal(removeSeriesEntries(chart, [{ series }]), 1);
  assert.deepEqual(removed, [series]);
});

test("interval transitions refresh a series from the complete application snapshot", () => {
  const data = [
    { time: 1 },
    { time: 2, open: 1.5, high: 3, low: 1, close: 2.5, color: "purple" },
  ];
  const writes = [];
  const series = {
    data: () => {
      throw new Error("public data projection must not be used for replay");
    },
    setData: (nextData) => writes.push(nextData),
  };

  assert.equal(resyncSeriesTimeScaleIndexes(series, data), data.length);
  assert.deepEqual(writes, [data]);
  assert.strictEqual(writes[0], data);
});

test("series logical-index refresh is a no-op without replayable data", () => {
  assert.equal(resyncSeriesTimeScaleIndexes(null), 0);
  assert.equal(resyncSeriesTimeScaleIndexes({ setData() {} }, []), 0);
  assert.equal(resyncSeriesTimeScaleIndexes({ setData() {} }, null), 0);
});

test("indicator series use setData during their startup grace window", () => {
  assert.equal(shouldPreferIndicatorSetData({
    createdAtMs: 10_000,
    nowMs: 10_000 + INDICATOR_SERIES_INCREMENTAL_GRACE_MS - 1,
  }), true);
  assert.equal(shouldPreferIndicatorSetData({
    createdAtMs: 10_000,
    nowMs: 10_000 + INDICATOR_SERIES_INCREMENTAL_GRACE_MS,
  }), false);
  assert.equal(shouldPreferIndicatorSetData({
    createdAtMs: 10_000,
    nowMs: 99_000,
    usesDerivedAxis: true,
  }), true);
  assert.equal(shouldPreferIndicatorSetData({ createdAtMs: null, nowMs: 99_000 }), true);
});
