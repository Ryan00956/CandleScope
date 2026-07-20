import assert from "node:assert/strict";
import test from "node:test";
import { LineType } from "lightweight-charts";

import { createHighLowSeriesPaneView } from "../highLowSeries.js";
import { createKagiSeriesPaneView } from "../kagiSeries.js";
import { createPointFigureSeriesPaneView } from "../pointFigureSeries.js";
import { chartSeriesTypes } from "../lightweightChartSurface.js";
import {
  buildMainSeriesCrosshairValue,
  buildMainSeriesData,
  buildMainSeriesReferenceOptions,
  buildMainSeriesStyleOptions,
  createMainSeriesPointConverter,
  MainSeriesReferenceTracker,
  toMainSeriesPoint,
} from "../mainSeriesModel.js";
import { createMainSeries, replaceMainSeries } from "../seriesLifecycle.js";
import {
  MAIN_CHART_TYPES,
  normalizeMainChartType,
} from "../../shared/mainChartTypes.js";
import { getChartTypeDescriptor } from "../../features/chart-representation/chartTypeRegistry.js";
import type {
  KagiCustomData,
  PointFigureCustomData,
} from "../chartAdapterTypes.js";
import type { MainChartType } from "../../shared/mainChartTypes.js";
import {
  malformedFixture,
  mustBeDefined,
  structuralMock,
} from "../../test/testHelpers.js";
import { chartCoordinate } from "./chartAdapterTestHelpers.js";

type AdapterChart = Parameters<typeof createMainSeries>[0];
type AdapterSeries = NonNullable<Parameters<typeof replaceMainSeries>[1]>;

function isBuiltInRendererId(value: string): value is keyof typeof chartSeriesTypes {
  return value in chartSeriesTypes;
}

const ROWS = [
  { time: 10, open: 100, high: 112, low: 98, close: 110, volume: 12 },
  { time: 20, open: 110, high: 111, low: 101, close: 104, volume: 15 },
  { time: 30, __whitespace: true },
];

test("all fifteen main chart types map to their built-in or custom series", () => {
  assert.deepEqual(MAIN_CHART_TYPES, [
    "candlestick",
    "hollow-candlestick",
    "heikin-ashi",
    "renko",
    "point-and-figure",
    "kagi",
    "line-break",
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
    const calls: Array<["built-in" | "custom", ...unknown[]]> = [];
    const chart = structuralMock<AdapterChart>({
      addSeries: (...args: unknown[]) => {
        calls.push(["built-in", ...args]);
        return structuralMock<AdapterSeries>({ type: chartType });
      },
      addCustomSeries: (...args: unknown[]) => {
        calls.push(["custom", ...args]);
        return structuralMock<AdapterSeries>({ type: chartType });
      },
    });
    createMainSeries(chart, { chartType, data: ROWS, paneIndex: 0 });
    const call = mustBeDefined(calls[0]);
    const rendererId = getChartTypeDescriptor(chartType).rendererId;
    if (chartType === "high-low" || chartType === "point-and-figure" || chartType === "kagi") {
      assert.equal(call[0], "custom");
      const renderer = call[1];
      assert.equal(
        renderer !== null
          && typeof renderer === "object"
          && "priceValueBuilder" in renderer
          ? typeof renderer.priceValueBuilder
          : "undefined",
        "function",
      );
    } else {
      assert.equal(call[0], "built-in");
      assert.equal(isBuiltInRendererId(rendererId), true);
      if (isBuiltInRendererId(rendererId)) {
        assert.strictEqual(call[1], chartSeriesTypes[rendererId]);
      }
    }
    assert.equal(call[3], 0);
  }
});

test("unknown chart types safely fall back to candlesticks", () => {
  assert.equal(normalizeMainChartType(malformedFixture<MainChartType>("range")), "candlestick");
  const calls: unknown[][] = [];
  createMainSeries(structuralMock<AdapterChart>({
    addSeries: (...args: unknown[]) => {
      calls.push(args);
      return structuralMock<AdapterSeries>({});
    },
  }), { chartType: malformedFixture<MainChartType>("range") });
  assert.strictEqual(mustBeDefined(calls[0])[0], chartSeriesTypes.candlestick);
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
  assert.deepEqual(toMainSeriesPoint(structuralMock<Parameters<typeof toMainSeriesPoint>[0]>({
    ...ROWS[0],
    customValues,
  }), { chartType: "line" }), {
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
  assert.deepEqual(paneView.priceValueBuilder(mustBeDefined(rows[0])), [112, 98, 100]);
  assert.equal(paneView.isWhitespace({ time: 30 }), true);

  const rectangles: Array<{ args: number[]; color: CanvasRenderingContext2D["fillStyle"] }> = [];
  const context = structuralMock<CanvasRenderingContext2D>({
    fillStyle: "",
    fillRect: (...args: number[]) => { rectangles.push({ args, color: context.fillStyle }); },
  });
  paneView.update(structuralMock<Parameters<typeof paneView.update>[0]>({
    barSpacing: 10,
    conflationFactor: 1,
    visibleRange: { from: 0, to: 2 },
    bars: rows.map((originalData, index) => ({
      x: 10 + index * 10,
      originalData: index === 0 ? { ...originalData, color: "#123456" } : originalData,
      barColor: index === 0 ? "#fedcba" : "#123456",
    })),
  }), { ...paneView.defaultOptions(), color: "#abcdef" });
  paneView.renderer().draw(structuralMock<Parameters<ReturnType<typeof paneView.renderer>["draw"]>[0]>({
    useBitmapCoordinateSpace: (draw: (scope: {
      context: CanvasRenderingContext2D;
      horizontalPixelRatio: number;
      verticalPixelRatio: number;
    }) => void) => draw({
      context,
      horizontalPixelRatio: 1,
      verticalPixelRatio: 1,
    }),
  }), (price: number) => chartCoordinate(200 - price), false);

  assert.equal(rectangles.length, 2);
  const firstRectangle = mustBeDefined(rectangles[0]);
  const secondRectangle = mustBeDefined(rectangles[1]);
  assert.deepEqual(firstRectangle.args.slice(1), secondRectangle.args.slice(1));
  assert.equal(firstRectangle.color, "#123456");
});

test("Point & Figure retains semantic OHLC and custom column metadata", () => {
  const row = {
    time: 10,
    open: 101,
    high: 103,
    low: 101,
    close: 103,
    customValues: {
      pointAndFigure: { boxSize: 1, direction: "x", reversalAmount: 3, source: "close" },
    },
  };
  assert.deepEqual(buildMainSeriesData([row], { chartType: "point-and-figure" }), [row]);
  const paneView = createPointFigureSeriesPaneView();
  const pointFigureRow = structuralMock<PointFigureCustomData>(row);
  assert.deepEqual(paneView.priceValueBuilder(pointFigureRow), [103, 101, 103]);
  assert.equal(paneView.isWhitespace(pointFigureRow), false);
});

test("Kagi retains semantic OHLC and custom leg metadata", () => {
  const row = {
    time: 10,
    open: 101,
    high: 105,
    low: 101,
    close: 105,
    customValues: {
      kagi: {
        direction: "up",
        sections: [{ from: 101, to: 105, style: "yin" }],
        source: "close",
        state: "yin",
      },
    },
  };
  assert.deepEqual(buildMainSeriesData([row], { chartType: "kagi" }), [row]);
  const paneView = createKagiSeriesPaneView();
  const kagiRow = structuralMock<KagiCustomData>(row);
  assert.deepEqual(paneView.priceValueBuilder(kagiRow), [105, 101, 105]);
  assert.equal(paneView.isWhitespace(kagiRow), false);
});

test("Line Break retains synthetic OHLC and breakout metadata", () => {
  const row = {
    time: 10,
    open: 101,
    high: 105,
    low: 101,
    close: 105,
    customValues: {
      lineBreak: { direction: "up", numberOfLines: 3, source: "close" },
    },
  };
  assert.deepEqual(buildMainSeriesData([row], { chartType: "line-break" }), [row]);
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

  const firstRow = mustBeDefined(rows[0]);
  assert.deepEqual(toMainSeriesPoint(firstRow, {
    chartType: "hollow-candlestick",
    indicatorColor: "purple",
  }), {
    ...firstRow,
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

test("derived rows reuse source barcolors while exact ordinal colors take precedence", () => {
  const exactTime = { order: 0, sourceTime: 10, sourceOrdinal: 0 };
  const siblingTime = { order: 1, sourceTime: 10, sourceOrdinal: 1 };
  const rows = [
    { time: exactTime, open: 100, high: 102, low: 99, close: 101 },
    { time: siblingTime, open: 101, high: 103, low: 100, close: 102 },
  ];

  const data = buildMainSeriesData(rows, {
    chartType: "renko",
    indicatorBarcolors: [{
      data: [
        { time: 10, color: "purple" },
        { time: exactTime, color: "orange" },
      ],
    }],
  });

  assert.deepEqual(data.map(({ color, borderColor, wickColor }) => ({
    color,
    borderColor,
    wickColor,
  })), [
    { color: "orange", borderColor: "orange", wickColor: "orange" },
    { color: "purple", borderColor: "purple", wickColor: "purple" },
  ]);
});

test("baseline and price-column references avoid the library's unhelpful zero defaults", () => {
  assert.deepEqual(buildMainSeriesReferenceOptions("baseline", ROWS), {
    baseValue: { type: "price", price: 110 },
  });
  const histogram = buildMainSeriesReferenceOptions("histogram", ROWS);
  assert.ok(Number(histogram.base) > 0);
  assert.ok(Number(histogram.base) < 104);
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

test("histogram reference tracker updates realtime tail deltas without rescanning the window", () => {
  const tracker = new MainSeriesReferenceTracker();
  let rows = [
    { time: 10, close: 1 },
    { time: 20, close: 2 },
    { time: 30, close: 3 },
  ];

  assert.deepEqual(
    tracker.resolve("histogram", rows),
    buildMainSeriesReferenceOptions("histogram", rows),
  );
  assert.equal(tracker.fullHistogramScanCount, 1);

  rows = [rows[0]!, rows[1]!, { time: 30, close: 2.5 }];
  assert.deepEqual(
    tracker.resolve("histogram", rows, { type: "tick", replaced: true }),
    buildMainSeriesReferenceOptions("histogram", rows),
  );
  assert.equal(tracker.fullHistogramScanCount, 1);

  rows = [rows[1]!, rows[2]!, { time: 40, close: 4 }];
  assert.deepEqual(
    tracker.resolve("histogram", rows, {
      type: "tick",
      appended: true,
      trimmedLeft: 1,
    }),
    buildMainSeriesReferenceOptions("histogram", rows),
  );
  assert.equal(tracker.fullHistogramScanCount, 1);

  rows = [rows[0]!, rows[1]!, { time: 40, close: 1.5 }];
  assert.deepEqual(
    tracker.resolve("histogram", rows, { type: "tick", replaced: true }),
    buildMainSeriesReferenceOptions("histogram", rows),
  );
  assert.equal(tracker.fullHistogramScanCount, 1);

  rows = [rows[0]!, { time: 30, close: 9 }, rows[2]!];
  assert.deepEqual(
    tracker.resolve("histogram", rows, { type: "mid-merge" }),
    buildMainSeriesReferenceOptions("histogram", rows),
  );
  assert.equal(tracker.fullHistogramScanCount, 2);
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
  assert.match(String(baseline.topFillColor1), /^rgba\(1, 2, 3, /);

  assert.equal(buildMainSeriesStyleOptions("step-line").lineType, LineType.WithSteps);
  assert.equal(buildMainSeriesStyleOptions("step-line").pointMarkersVisible, false);
  const markedLine = buildMainSeriesStyleOptions("line-with-markers");
  assert.equal(markedLine.lineType, LineType.Simple);
  assert.equal(markedLine.pointMarkersVisible, true);
  assert.equal(markedLine.pointMarkersRadius, 3);
  assert.deepEqual(buildMainSeriesStyleOptions("point-and-figure", {
    upColor: "green",
    downColor: "red",
  }), {
    upColor: "green",
    downColor: "red",
    lineWidth: 2,
  });
  assert.deepEqual(buildMainSeriesStyleOptions("kagi", {
    upColor: "green",
    downColor: "red",
  }), {
    upColor: "green",
    downColor: "red",
    lineWidth: 2,
    thickLineWidth: 4,
  });
  assert.deepEqual(buildMainSeriesStyleOptions("line-break", {
    upColor: "green",
    downColor: "red",
  }), {
    upColor: "green",
    downColor: "red",
    borderDownColor: "red",
    borderUpColor: "green",
    wickVisible: false,
  });
});

test("switching creates and populates the new series before removing the old one", () => {
  const events: Array<[string, unknown]> = [];
  const oldSeries = structuralMock<AdapterSeries>({ id: "candles", seriesOrder: () => 2 });
  const newSeries = structuralMock<AdapterSeries>({
    setData: (data: unknown) => { events.push(["setData", data]); },
    setSeriesOrder: (order: number) => { events.push(["setSeriesOrder", order]); },
  });
  const chart = structuralMock<AdapterChart>({
    addSeries: (definition: unknown) => {
      events.push(["addSeries", definition]);
      return newSeries;
    },
    removeSeries: (series: unknown) => { events.push(["removeSeries", series]); },
  });

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
  assert.equal(mustBeDefined(events[2])[1], 2);
  assert.strictEqual(mustBeDefined(events[3])[1], oldSeries);
});

test("switching accepts projection-rendered series data without rebuilding it", () => {
  const rendered = [{ time: 10, value: 999 }];
  let received: unknown = null;
  const oldSeries = structuralMock<AdapterSeries>({ seriesOrder: () => 0 });
  const nextSeries = structuralMock<AdapterSeries>({
    setData: (data: unknown) => { received = data; },
    setSeriesOrder: () => {},
  });
  const result = replaceMainSeries(structuralMock<AdapterChart>({
    addSeries: () => nextSeries,
    removeSeries: () => {},
  }), oldSeries, {
    chartType: "line",
    data: ROWS,
    seriesData: rendered,
  });

  assert.strictEqual(received, rendered);
  assert.strictEqual(result.data, rendered);
});

test("single-value charts still publish OHLCV from the raw K-line row", () => {
  assert.deepEqual(buildMainSeriesCrosshairValue(10, mustBeDefined(ROWS[0])), {
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
      volumeRow: mustBeDefined(ROWS[0]),
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

test("derived chart crosshair does not present one source bar as synthetic volume", () => {
  assert.deepEqual(buildMainSeriesCrosshairValue(
    10,
    { time: 10, open: 101, high: 103, low: 101, close: 103 },
    {
      includeVolume: false,
      volumeRow: mustBeDefined(ROWS[0]),
    },
  ), {
    time: 10,
    open: 101,
    high: 103,
    low: 101,
    close: 103,
    volume: null,
  });
});
