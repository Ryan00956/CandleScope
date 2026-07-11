import assert from "node:assert/strict";
import test from "node:test";

import { chartSeriesTypes } from "../lightweightChartSurface.js";
import {
  buildMainSeriesCrosshairValue,
  buildMainSeriesData,
  buildMainSeriesReferenceOptions,
  buildMainSeriesStyleOptions,
  createMainSeriesPointConverter,
  resolveMainSeriesDeltaStartIndex,
} from "../mainSeriesModel.js";
import { createMainSeries, replaceMainSeries } from "../seriesLifecycle.js";
import {
  MAIN_CHART_TYPES,
  normalizeMainChartType,
} from "../../shared/mainChartTypes.js";

const ROWS = [
  { time: 10, open: 100, high: 112, low: 98, close: 110, volume: 12 },
  { time: 20, open: 110, high: 111, low: 101, close: 104, volume: 15 },
  { time: 30, __whitespace: true },
];

test("all six built-in Lightweight Charts main series types are mapped", () => {
  assert.deepEqual(MAIN_CHART_TYPES, [
    "candlestick",
    "bar",
    "line",
    "area",
    "baseline",
    "histogram",
  ]);

  for (const chartType of MAIN_CHART_TYPES) {
    const calls = [];
    const chart = {
      addSeries: (...args) => {
        calls.push(args);
        return { type: chartType };
      },
    };
    createMainSeries(chart, { chartType, data: ROWS, paneIndex: 0 });
    assert.strictEqual(calls[0][0], chartSeriesTypes[chartType]);
    assert.equal(calls[0][2], 0);
  }
});

test("unknown chart types safely fall back to candlesticks", () => {
  assert.equal(normalizeMainChartType("renko"), "candlestick");
  const calls = [];
  createMainSeries({
    addSeries: (...args) => {
      calls.push(args);
      return {};
    },
  }, { chartType: "renko" });
  assert.strictEqual(calls[0][0], chartSeriesTypes.candlestick);
});

test("OHLC types retain OHLC while value types use the close price", () => {
  for (const chartType of ["candlestick", "bar"]) {
    assert.deepEqual(buildMainSeriesData(ROWS, { chartType }), [
      { time: 10, open: 100, high: 112, low: 98, close: 110 },
      { time: 20, open: 110, high: 111, low: 101, close: 104 },
      { time: 30 },
    ]);
  }

  for (const chartType of ["line", "area", "baseline"]) {
    assert.deepEqual(buildMainSeriesData(ROWS, { chartType }), [
      { time: 10, value: 110 },
      { time: 20, value: 104 },
      { time: 30 },
    ]);
  }
});

test("price columns use close values, price-change colors, and barcolor overrides", () => {
  assert.deepEqual(buildMainSeriesData(ROWS, {
    chartType: "histogram",
    upColor: "green",
    downColor: "red",
    indicatorBarcolors: [{ data: [{ time: 20, color: "purple" }] }],
  }), [
    { time: 10, value: 110, color: "green" },
    { time: 20, value: 104, color: "purple" },
    { time: 30 },
  ]);
});

test("barcolor overrides use fields supported by each OHLC series", () => {
  const indicatorBarcolors = [{ data: [{ time: 10, color: "orange" }] }];
  assert.deepEqual(buildMainSeriesData(ROWS.slice(0, 1), {
    chartType: "bar",
    indicatorBarcolors,
  })[0], {
    time: 10,
    open: 100,
    high: 112,
    low: 98,
    close: 110,
    color: "orange",
  });
  assert.deepEqual(buildMainSeriesData(ROWS.slice(0, 1), {
    chartType: "candlestick",
    indicatorBarcolors,
  })[0], {
    time: 10,
    open: 100,
    high: 112,
    low: 98,
    close: 110,
    color: "orange",
    borderColor: "orange",
    wickColor: "orange",
  });
});

test("baseline and price-column references avoid the library's unhelpful zero defaults", () => {
  assert.deepEqual(buildMainSeriesReferenceOptions("baseline", ROWS), {
    baseValue: { type: "price", price: 110 },
  });
  const histogram = buildMainSeriesReferenceOptions("histogram", ROWS);
  assert.ok(histogram.base > 0);
  assert.ok(histogram.base < 104);
  assert.deepEqual(buildMainSeriesReferenceOptions("line", ROWS), {});
});

test("ordinary chart types do not scan the full window for reference options", () => {
  const rows = new Proxy([], {
    get() {
      throw new Error("rows should not be read");
    },
  });
  assert.deepEqual(buildMainSeriesReferenceOptions("candlestick", rows), {});
  assert.deepEqual(buildMainSeriesReferenceOptions("line", rows), {});
});

test("trimmed deltas rebuild histogram colors from the new first row", () => {
  const rows = [
    { time: 20, close: 90 },
    { time: 30, close: 80 },
  ];
  const delta = {
    type: "tick",
    bar: rows[1],
    trimmedLeft: 1,
  };
  const startIndex = resolveMainSeriesDeltaStartIndex(delta, rows, {
    indexOfTime: () => 1,
  });
  assert.equal(startIndex, 0);
  const toPoint = createMainSeriesPointConverter(rows, {
    chartType: "histogram",
    downColor: "red",
    startIndex,
    upColor: "green",
  });
  assert.deepEqual(rows.map(toPoint), [
    { time: 20, value: 90, color: "green" },
    { time: 30, value: 80, color: "red" },
  ]);
});

test("type-specific styles respect rise and fall colors", () => {
  assert.deepEqual(buildMainSeriesStyleOptions("bar", {
    upColor: "#010203",
    downColor: "#040506",
  }), {
    upColor: "#010203",
    downColor: "#040506",
    openVisible: true,
    thinBars: true,
  });
  const baseline = buildMainSeriesStyleOptions("baseline", {
    upColor: "#010203",
    downColor: "#040506",
  });
  assert.equal(baseline.topLineColor, "#010203");
  assert.equal(baseline.bottomLineColor, "#040506");
  assert.match(baseline.topFillColor1, /^rgba\(1, 2, 3, /);
});

test("switching creates and populates the new series before removing the old one", () => {
  const events = [];
  const oldSeries = { id: "candles", seriesOrder: () => 2 };
  const newSeries = {
    setData: (data) => events.push(["setData", data]),
    setSeriesOrder: (order) => events.push(["setSeriesOrder", order]),
  };
  const chart = {
    addSeries: (definition) => {
      events.push(["addSeries", definition]);
      return newSeries;
    },
    removeSeries: (series) => events.push(["removeSeries", series]),
  };

  const result = replaceMainSeries(chart, oldSeries, {
    chartType: "line",
    data: ROWS,
    paneIndex: 0,
  });

  assert.strictEqual(result.series, newSeries);
  assert.deepEqual(result.data, [
    { time: 10, value: 110 },
    { time: 20, value: 104 },
    { time: 30 },
  ]);
  assert.deepEqual(events.map(([name]) => name), [
    "addSeries",
    "setData",
    "setSeriesOrder",
    "removeSeries",
  ]);
  assert.equal(events[2][1], 2);
  assert.strictEqual(events[3][1], oldSeries);
});

test("single-value charts still publish OHLCV from the raw K-line row", () => {
  assert.deepEqual(buildMainSeriesCrosshairValue(10, ROWS[0]), {
    time: 10,
    open: 100,
    high: 112,
    low: 98,
    close: 110,
    volume: 12,
  });
  assert.equal(buildMainSeriesCrosshairValue(10, { close: 110 }), null);
});
