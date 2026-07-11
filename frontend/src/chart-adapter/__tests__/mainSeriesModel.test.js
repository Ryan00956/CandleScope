import assert from "node:assert/strict";
import test from "node:test";
import { LineType } from "lightweight-charts";

import { createHighLowSeriesPaneView } from "../highLowSeries.js";
import { chartSeriesTypes } from "../lightweightChartSurface.js";
import {
  buildMainSeriesCrosshairValue,
  buildMainSeriesData,
  buildMainSeriesReferenceOptions,
  buildMainSeriesStyleOptions,
  createMainSeriesPointConverter,
  toMainSeriesPoint,
} from "../mainSeriesModel.js";
import { createMainSeries, replaceMainSeries } from "../seriesLifecycle.js";
import {
  MAIN_CHART_TYPES,
  mainChartSeriesKind,
  normalizeMainChartType,
} from "../../shared/mainChartTypes.js";

const ROWS = [
  { time: 10, open: 100, high: 112, low: 98, close: 110, volume: 12 },
  { time: 20, open: 110, high: 111, low: 101, close: 104, volume: 15 },
  { time: 30, __whitespace: true },
];

test("all eleven main chart types map to their built-in or custom series", () => {
  assert.deepEqual(MAIN_CHART_TYPES, [
    "candlestick",
    "hollow-candlestick",
    "heikin-ashi",
    "bar",
    "high-low",
    "line",
    "line-with-markers",
    "step-line",
    "area",
    "baseline",
    "histogram",
  ]);

  for (const chartType of MAIN_CHART_TYPES) {
    const calls = [];
    const chart = {
      addSeries: (...args) => {
        calls.push(["built-in", ...args]);
        return { type: chartType };
      },
      addCustomSeries: (...args) => {
        calls.push(["custom", ...args]);
        return { type: chartType };
      },
    };
    createMainSeries(chart, { chartType, data: ROWS, paneIndex: 0 });
    const seriesKind = mainChartSeriesKind(chartType);
    if (chartType === "high-low") {
      assert.equal(calls[0][0], "custom");
      assert.equal(typeof calls[0][1].priceValueBuilder, "function");
    } else {
      assert.equal(calls[0][0], "built-in");
      assert.strictEqual(calls[0][1], chartSeriesTypes[seriesKind]);
    }
    assert.equal(calls[0][3], 0);
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

test("ordinary OHLC types retain OHLC while close-value types use close", () => {
  for (const chartType of ["candlestick", "bar"]) {
    assert.deepEqual(buildMainSeriesData(ROWS, { chartType }), [
      { time: 10, open: 100, high: 112, low: 98, close: 110 },
      { time: 20, open: 110, high: 111, low: 101, close: 104 },
      { time: 30 },
    ]);
  }

  for (const chartType of ["line", "line-with-markers", "step-line", "area", "baseline"]) {
    assert.deepEqual(buildMainSeriesData(ROWS, { chartType }), [
      { time: 10, value: 110 },
      { time: 20, value: 104 },
      { time: 30 },
    ]);
  }
});

test("rendered points preserve projection lineage carried in customValues", () => {
  const customValues = {
    chartProjection: {
      projectorId: "identity",
      sourceFromTime: 10,
      sourceToTime: 10,
      sourceOrdinal: 0,
    },
  };
  assert.deepEqual(toMainSeriesPoint({ ...ROWS[0], customValues }, { chartType: "line" }), {
    time: 10,
    value: 110,
    customValues,
  });
});

test("high-low retains the source range and ignores open/close direction when rendering", () => {
  const rows = [
    { time: 10, open: 108, high: 112, low: 98, close: 100 },
    { time: 20, open: 100, high: 112, low: 98, close: 108 },
  ];
  assert.deepEqual(buildMainSeriesData(rows, { chartType: "high-low" }), rows);

  const paneView = createHighLowSeriesPaneView();
  assert.deepEqual(paneView.priceValueBuilder(rows[0]), [112, 98, 100]);
  assert.equal(paneView.isWhitespace({ time: 30 }), true);

  const rectangles = [];
  const context = {
    fillStyle: "",
    fillRect: (...args) => rectangles.push({ args, color: context.fillStyle }),
  };
  paneView.update({
    barSpacing: 10,
    conflationFactor: 1,
    visibleRange: { from: 0, to: 2 },
    bars: rows.map((originalData, index) => ({
      x: 10 + index * 10,
      originalData: index === 0 ? { ...originalData, color: "#123456" } : originalData,
      barColor: index === 0 ? "#fedcba" : "#123456",
    })),
  }, { color: "#abcdef" });
  paneView.renderer().draw({
    useBitmapCoordinateSpace: (draw) => draw({
      context,
      horizontalPixelRatio: 1,
      verticalPixelRatio: 1,
    }),
  }, (price) => 200 - price);

  assert.equal(rectangles.length, 2);
  assert.deepEqual(rectangles[0].args.slice(1), rectangles[1].args.slice(1));
  assert.equal(rectangles[0].color, "#123456");
});

test("hollow candles separate body fill from previous-close trend color", () => {
  const rows = [
    { time: 10, open: 100, high: 108, low: 98, close: 105 },
    { time: 20, open: 110, high: 112, low: 104, close: 106 },
    { time: 30, open: 100, high: 108, low: 99, close: 104 },
    { time: 40, open: 105, high: 106, low: 99, close: 101 },
  ];
  const data = buildMainSeriesData(rows, {
    chartType: "hollow-candlestick",
    upColor: "green",
    downColor: "red",
  });
  assert.deepEqual(data.map(({ color, borderColor, wickColor }) => ({
    color,
    borderColor,
    wickColor,
  })), [
    { color: "rgba(0, 0, 0, 0)", borderColor: "green", wickColor: "green" },
    { color: "green", borderColor: "green", wickColor: "green" },
    { color: "rgba(0, 0, 0, 0)", borderColor: "red", wickColor: "red" },
    { color: "red", borderColor: "red", wickColor: "red" },
  ]);

  assert.deepEqual(toMainSeriesPoint(rows[0], {
    chartType: "hollow-candlestick",
    indicatorColor: "purple",
  }), {
    ...rows[0],
    color: "rgba(0, 0, 0, 0)",
    borderColor: "purple",
    wickColor: "purple",
  });
});

test("Heikin Ashi renders projected semantic OHLC without deriving it again", () => {
  const rows = [
    { time: 10, open: 103, high: 110, low: 90, close: 101.5 },
    { time: 20, open: 102.25, high: 120, low: 100, close: 110.5 },
    { time: 30, __whitespace: true },
    { time: 40, open: 106.375, high: 118, low: 94, close: 106 },
  ];
  const snapshot = structuredClone(rows);
  assert.deepEqual(buildMainSeriesData(rows, { chartType: "heikin-ashi" }), [
    { time: 10, open: 103, high: 110, low: 90, close: 101.5 },
    { time: 20, open: 102.25, high: 120, low: 100, close: 110.5 },
    { time: 30 },
    { time: 40, open: 106.375, high: 118, low: 94, close: 106 },
  ]);
  assert.deepEqual(rows, snapshot);
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

test("tail conversion can rebuild histogram colors from a new first row", () => {
  const rows = [
    { time: 20, close: 90 },
    { time: 30, close: 80 },
  ];
  const toPoint = createMainSeriesPointConverter(rows, {
    chartType: "histogram",
    downColor: "red",
    startIndex: 0,
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

  assert.equal(buildMainSeriesStyleOptions("step-line").lineType, LineType.WithSteps);
  assert.equal(buildMainSeriesStyleOptions("step-line").pointMarkersVisible, false);
  const markedLine = buildMainSeriesStyleOptions("line-with-markers");
  assert.equal(markedLine.lineType, LineType.Simple);
  assert.equal(markedLine.pointMarkersVisible, true);
  assert.equal(markedLine.pointMarkersRadius, 3);
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

test("switching accepts projection-rendered series data without rebuilding it", () => {
  const rendered = [{ time: 10, value: 999 }];
  let received = null;
  const oldSeries = { seriesOrder: () => 0 };
  const nextSeries = {
    setData: (data) => { received = data; },
    setSeriesOrder: () => {},
  };
  const result = replaceMainSeries({
    addSeries: () => nextSeries,
    removeSeries: () => {},
  }, oldSeries, {
    chartType: "line",
    data: ROWS,
    seriesData: rendered,
  });

  assert.strictEqual(received, rendered);
  assert.strictEqual(result.data, rendered);
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

test("crosshair publishes displayed semantic OHLC with source volume", () => {
  assert.deepEqual(buildMainSeriesCrosshairValue(
    10,
    { time: 10, open: 103, high: 112, low: 98, close: 105 },
    {
      volumeRow: ROWS[0],
    },
  ), {
    time: 10,
    open: 103,
    high: 112,
    low: 98,
    close: 105,
    volume: 12,
  });
});
