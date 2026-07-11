import assert from "node:assert/strict";
import test from "node:test";
import { replaceMainSeries } from "../seriesLifecycle.js";

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
