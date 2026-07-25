import assert from "node:assert/strict";
import test from "node:test";
import {
  applyIndicatorPaneSeriesOrder,
  buildIndicatorSeriesOptions,
  createFutureTimeAxisSeries,
  formatIndicatorNotional,
  INDICATOR_SERIES_INCREMENTAL_GRACE_MS,
  removeSeriesEntries,
  replaceMainSeries,
  resyncSeriesTimeScaleIndexes,
  selectIndicatorPaneAnnotationTarget,
  shouldPreferIndicatorSetData,
} from "../seriesLifecycle.js";
import { chartSeriesTypes } from "../lightweightChartSurface.js";
import { mustBeDefined, structuralMock } from "../../test/testHelpers.js";

type AdapterChart = Parameters<typeof replaceMainSeries>[0];
type AdapterSeries = NonNullable<Parameters<typeof replaceMainSeries>[1]>;
type IndicatorSeries = NonNullable<Parameters<typeof removeSeriesEntries>[1]>[number]["series"];

interface HarnessOptions {
  failNextSetData?: boolean;
}

function createHarness({ failNextSetData = false }: HarnessOptions = {}) {
  const operations: Array<[string, ...unknown[]]> = [];
  const previousData = [{ time: 1, open: 1, high: 2, low: 0, close: 1.5 }];
  const previousSeries = structuralMock<AdapterSeries>({
    data() {
      operations.push(["previous.data"]);
      return previousData;
    },
    seriesOrder() {
      operations.push(["previous.seriesOrder"]);
      return 3;
    },
    setData(data: unknown) {
      operations.push(["previous.setData", data]);
    },
  });
  const nextSeries = structuralMock<AdapterSeries>({
    setData(data: unknown) {
      operations.push(["next.setData", data]);
      if (failNextSetData) throw new Error("setData failed");
    },
    setSeriesOrder(order: number) {
      operations.push(["next.setSeriesOrder", order]);
    },
  });
  const chart = structuralMock<AdapterChart>({
    addSeries() {
      operations.push(["chart.addSeries"]);
      return nextSeries;
    },
    removeSeries(series: unknown) {
      operations.push(["chart.removeSeries", series]);
    },
  });
  return { chart, nextSeries, operations, previousData, previousSeries };
}

test("future time-axis carrier is an invisible line series in the main pane", () => {
  const calls: unknown[][] = [];
  const carrier = structuralMock<ReturnType<typeof createFutureTimeAxisSeries>>({});
  const chart = structuralMock<Parameters<typeof createFutureTimeAxisSeries>[0]>({
    addSeries: (...args: unknown[]) => {
      calls.push(args);
      return carrier;
    },
  });

  assert.equal(createFutureTimeAxisSeries(chart), carrier);
  const addSeriesCall = mustBeDefined(calls[0]);
  assert.strictEqual(addSeriesCall[0], chartSeriesTypes.line);
  assert.deepEqual(addSeriesCall[1], {
    crosshairMarkerVisible: false,
    lastValueVisible: false,
    priceLineVisible: false,
    title: "",
    visible: false,
  });
  assert.equal(addSeriesCall[2], 0);
});

test("indicator pane order keeps histograms below line series", () => {
  const operations: Array<[string, number]> = [];
  const entry = (
    name: string,
    type: "line" | "histogram",
    paneIndex = 1,
    paneId = "indicator",
  ) => ({
    lineConfig: { type },
    paneId,
    paneIndex,
    series: structuralMock<IndicatorSeries>({
      setSeriesOrder(order: number) {
        operations.push([name, order]);
      },
    }),
  });

  const dif = entry("dif", "line");
  const dea = entry("dea", "line");
  const histogram = entry("histogram", "histogram");
  const zeroPaneHistogram = entry("zero-histogram", "histogram", 0);
  const zeroPaneLine = entry("zero-line", "line", 0);
  const mainOverlay = entry("main", "histogram", 2, "main");

  assert.equal(applyIndicatorPaneSeriesOrder([
    dif,
    dea,
    histogram,
    zeroPaneLine,
    zeroPaneHistogram,
    mainOverlay,
  ]), 5);
  assert.deepEqual(operations, [
    ["histogram", 0],
    ["dif", 1],
    ["dea", 2],
    ["zero-histogram", 0],
    ["zero-line", 1],
  ]);
});

test("only volume-pane histograms use volume number formatting", () => {
  assert.deepEqual(
    buildIndicatorSeriesOptions({ type: "histogram", pane: "volume" }).priceFormat,
    { type: "volume" },
  );
  assert.equal(
    buildIndicatorSeriesOptions({ type: "histogram", pane: "separate" }).priceFormat,
    undefined,
  );
});

test("indicator series options preserve hidden state, histogram base, and track price", () => {
  const options = buildIndicatorSeriesOptions({
    type: "histogram",
    pane: "separate",
    base: 25,
    trackPrice: true,
    visible: false,
  });

  assert.equal(options.visible, false);
  assert.equal(options.base, 25);
  assert.equal(options.priceLineVisible, true);
});

test("reused histograms reset an omitted base to the Lightweight Charts default", () => {
  const initial = buildIndicatorSeriesOptions({
    type: "histogram",
    base: 25,
  });
  const update = buildIndicatorSeriesOptions({
    type: "histogram",
  });

  assert.equal(initial.base, 25);
  assert.equal(update.base, 0);
  assert.equal({ ...initial, ...update }.base, 0);
});

test("pane annotations prefer a visible series and fall back when all plots are hidden", () => {
  const hidden = structuralMock<IndicatorSeries>({});
  const visible = structuralMock<IndicatorSeries>({});
  const fallback = structuralMock<IndicatorSeries>({});
  const entries = [
    {
      paneId: "separate-pine-1",
      lineConfig: { visible: false },
      series: hidden,
    },
    {
      paneId: "separate-pine-1",
      lineConfig: { visible: true },
      series: visible,
    },
  ];

  assert.equal(
    selectIndicatorPaneAnnotationTarget(entries, "separate-pine-1", fallback),
    visible,
  );
  assert.equal(
    selectIndicatorPaneAnnotationTarget(
      entries.slice(0, 1),
      "separate-pine-1",
      fallback,
    ),
    fallback,
  );
});

test("liquidation histograms use a symmetric zero scale and compact notional labels", () => {
  const options = buildIndicatorSeriesOptions({
    type: "histogram",
    pane: "advanced-liquidations",
    scale: "symmetric-zero",
    valueFormat: "notional",
  });
  assert.equal(options.base, 0);
  assert.equal(options.baseLineVisible, true);
  const priceFormat = options.priceFormat as {
    type: string;
    formatter(value: number): string;
  };
  assert.equal(priceFormat.type, "custom");
  assert.equal(priceFormat.formatter(1_250_000), "$1.25M");
  assert.equal(priceFormat.formatter(-25_000), "−$25K");
  assert.equal(formatIndicatorNotional(0), "$0");

  const autoscale = options.autoscaleInfoProvider as (
    base: () => unknown,
  ) => { priceRange: { minValue: number; maxValue: number } };
  assert.deepEqual(autoscale(() => ({
    priceRange: { minValue: -25, maxValue: 100 },
    margins: { above: 1, below: 2 },
  })), {
    priceRange: { minValue: -100, maxValue: 100 },
    margins: { above: 1, below: 2 },
  });
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
  assert.deepEqual(mustBeDefined(harness.operations[3])[1], []);
  assert.equal(mustBeDefined(harness.operations[6])[1], harness.previousSeries);
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
  assert.equal(mustBeDefined(harness.operations[5])[1], harness.nextSeries);
  assert.equal(mustBeDefined(harness.operations[6])[1], harness.previousData);
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
  const operations: Array<[string, ...unknown[]]> = [];
  const entries = [1, 2].map((id) => ({
    series: structuralMock<IndicatorSeries>({
      id,
      setData(data: unknown) {
        operations.push(["setData", id, data]);
      },
    }),
  }));
  const chart = structuralMock<AdapterChart>({
    removeSeries(series: { id: number }) {
      operations.push(["removeSeries", series.id]);
    },
  });

  assert.equal(removeSeriesEntries(chart, entries), 2);
  assert.deepEqual(operations, [
    ["setData", 1, []],
    ["removeSeries", 1],
    ["setData", 2, []],
    ["removeSeries", 2],
  ]);
});

test("removeSeriesEntries still detaches a stale series when clearing it fails", () => {
  const removed: unknown[] = [];
  const series = structuralMock<AdapterSeries>({
    setData() {
      throw new Error("already detached");
    },
  });
  const chart = structuralMock<AdapterChart>({
    removeSeries(value: unknown) {
      removed.push(value);
    },
  });

  assert.equal(removeSeriesEntries(chart, [{ series }]), 1);
  assert.deepEqual(removed, [series]);
});

test("interval transitions refresh a series from the complete application snapshot", () => {
  const data = [
    { time: 1 },
    { time: 2, open: 1.5, high: 3, low: 1, close: 2.5, color: "purple" },
  ];
  const writes: unknown[] = [];
  const series = structuralMock<AdapterSeries>({
    data: () => {
      throw new Error("public data projection must not be used for replay");
    },
    setData: (nextData: unknown) => { writes.push(nextData); },
  });

  assert.equal(resyncSeriesTimeScaleIndexes(series, data), data.length);
  assert.deepEqual(writes, [data]);
  assert.strictEqual(writes[0], data);
});

test("series logical-index refresh is a no-op without replayable data", () => {
  assert.equal(resyncSeriesTimeScaleIndexes(null, undefined), 0);
  assert.equal(resyncSeriesTimeScaleIndexes(structuralMock<AdapterSeries>({ setData() {} }), []), 0);
  assert.equal(resyncSeriesTimeScaleIndexes(structuralMock<AdapterSeries>({ setData() {} }), null), 0);
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
