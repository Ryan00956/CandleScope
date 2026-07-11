import { LineType } from "lightweight-charts";
import {
  isOhlcMainChartType,
  normalizeMainChartType,
} from "../shared/mainChartTypes.js";

const DEFAULT_UP_COLOR = "#22c55e";
const DEFAULT_DOWN_COLOR = "#ef4444";
const PRICE_LINE_COLOR = "#2962ff";
const TRANSPARENT_BODY_COLOR = "rgba(0, 0, 0, 0)";

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validClose(row) {
  if (row?.__whitespace) return null;
  return finiteNumber(row?.close);
}

function validOhlc(row) {
  if (row?.__whitespace) return null;
  const open = finiteNumber(row?.open);
  const high = finiteNumber(row?.high);
  const low = finiteNumber(row?.low);
  const close = finiteNumber(row?.close);
  return open == null || high == null || low == null || close == null
    ? null
    : { open, high, low, close };
}

function isValidOhlcPoint(point) {
  return finiteNumber(point?.open) != null
    && finiteNumber(point?.high) != null
    && finiteNumber(point?.low) != null
    && finiteNumber(point?.close) != null;
}

function copyOhlcPoint(point) {
  if (!isValidOhlcPoint(point) || point?.time == null) return null;
  return {
    time: point.time,
    open: Number(point.open),
    high: Number(point.high),
    low: Number(point.low),
    close: Number(point.close),
  };
}

function buildHeikinAshiPoint(row, previousPoint = null) {
  const time = row?.time;
  const ohlc = validOhlc(row);
  if (!ohlc || time == null) return { time };

  const close = (ohlc.open + ohlc.high + ohlc.low + ohlc.close) / 4;
  const open = isValidOhlcPoint(previousPoint)
    ? (Number(previousPoint.open) + Number(previousPoint.close)) / 2
    : (ohlc.open + ohlc.close) / 2;
  return {
    time,
    open,
    high: Math.max(ohlc.high, open, close),
    low: Math.min(ohlc.low, open, close),
    close,
  };
}

function withCandlestickColor(point, color) {
  if (!color) return point;
  return {
    ...point,
    color,
    borderColor: color,
    wickColor: color,
  };
}

function colorWithAlpha(color, alpha, fallback) {
  const value = String(color || "").trim();
  const shortHex = /^#([0-9a-f]{3})$/i.exec(value);
  const longHex = /^#([0-9a-f]{6})$/i.exec(value);
  const hex = longHex?.[1] || (shortHex?.[1]
    ? shortHex[1].split("").map((part) => `${part}${part}`).join("")
    : null);
  if (!hex) return fallback;
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export function buildIndicatorBarColorMap(indicatorBarcolors = []) {
  const colorMap = new Map();
  for (const group of indicatorBarcolors || []) {
    if (!Array.isArray(group?.data)) continue;
    for (const entry of group.data) {
      if (entry?.time != null && entry.color) colorMap.set(entry.time, entry.color);
    }
  }
  return colorMap;
}

export function toMainSeriesPoint(row, {
  chartType,
  downColor = DEFAULT_DOWN_COLOR,
  indicatorColor = null,
  previousClose = null,
  previousDerivedPoint = null,
  upColor = DEFAULT_UP_COLOR,
} = {}) {
  const resolvedType = normalizeMainChartType(chartType);
  const time = row?.time;
  if (row?.__whitespace || time == null) return { time };

  if (resolvedType === "heikin-ashi") {
    const point = buildHeikinAshiPoint(row, previousDerivedPoint);
    return isValidOhlcPoint(point) ? withCandlestickColor(point, indicatorColor) : point;
  }

  if (isOhlcMainChartType(resolvedType)) {
    const ohlc = validOhlc(row);
    if (!ohlc) return { time };
    const point = { time, ...ohlc };

    if (resolvedType === "high-low") {
      return indicatorColor ? { ...point, color: indicatorColor } : point;
    }

    if (resolvedType === "hollow-candlestick") {
      const reference = finiteNumber(previousClose);
      const trendColor = indicatorColor || (
        reference == null ? (ohlc.close >= ohlc.open ? upColor : downColor)
          : (ohlc.close >= reference ? upColor : downColor)
      );
      return {
        ...point,
        color: ohlc.close >= ohlc.open ? TRANSPARENT_BODY_COLOR : trendColor,
        borderColor: trendColor,
        wickColor: trendColor,
      };
    }

    if (!indicatorColor) return point;
    if (resolvedType === "bar") return { ...point, color: indicatorColor };
    return withCandlestickColor(point, indicatorColor);
  }

  const close = validClose(row);
  if (close == null) return { time };
  if (resolvedType !== "histogram") return { time, value: close };

  const reference = finiteNumber(previousClose);
  return {
    time,
    value: close,
    color: indicatorColor || (reference == null || close >= reference ? upColor : downColor),
  };
}

function previousCloseBefore(rows, startIndex) {
  for (let index = Math.min(startIndex - 1, rows.length - 1); index >= 0; index -= 1) {
    const close = validClose(rows[index]);
    if (close != null) return close;
  }
  return null;
}

function previousHeikinAshiPoint(rows, startIndex, previousSeriesData = []) {
  const lastIndex = Math.min(startIndex - 1, rows.length - 1);
  for (let index = lastIndex; index >= 0; index -= 1) {
    const candidate = previousSeriesData[index];
    if (candidate?.time === rows[index]?.time && isValidOhlcPoint(candidate)) return candidate;
  }

  let previousPoint = null;
  for (let index = 0; index <= lastIndex; index += 1) {
    const point = buildHeikinAshiPoint(rows[index], previousPoint);
    if (isValidOhlcPoint(point)) previousPoint = point;
  }
  return previousPoint;
}

export function createMainSeriesPointConverter(rows = [], {
  chartType,
  downColor = DEFAULT_DOWN_COLOR,
  initialDerivedPoint = null,
  indicatorBarColorMap = null,
  indicatorBarcolors = [],
  previousSeriesData = [],
  startIndex = 0,
  upColor = DEFAULT_UP_COLOR,
} = {}) {
  const resolvedType = normalizeMainChartType(chartType);
  const colorMap = indicatorBarColorMap || buildIndicatorBarColorMap(indicatorBarcolors);
  let previousClose = previousCloseBefore(rows, startIndex);
  let previousDerivedPoint = resolvedType === "heikin-ashi"
    ? previousHeikinAshiPoint(rows, startIndex, previousSeriesData)
    : null;
  let pendingInitialPoint = resolvedType === "heikin-ashi"
    && startIndex === 0
    && initialDerivedPoint?.time === rows[0]?.time
    ? copyOhlcPoint(initialDerivedPoint)
    : null;

  return (row) => {
    const close = validClose(row);
    const indicatorColor = colorMap.get(row?.time) || null;
    const useInitialPoint = pendingInitialPoint?.time === row?.time;
    const point = useInitialPoint
      ? withCandlestickColor(pendingInitialPoint, indicatorColor)
      : toMainSeriesPoint(row, {
        chartType: resolvedType,
        downColor,
        indicatorColor,
        previousClose,
        previousDerivedPoint,
        upColor,
      });
    pendingInitialPoint = null;
    if (close != null) previousClose = close;
    if (resolvedType === "heikin-ashi" && isValidOhlcPoint(point)) previousDerivedPoint = point;
    return point;
  };
}

export function buildMainSeriesData(rows = [], options = {}) {
  const toPoint = createMainSeriesPointConverter(rows, { ...options, startIndex: 0 });
  return (rows || []).map(toPoint);
}

export function resolveMainSeriesDeltaStartIndex(delta, rows = [], store = null) {
  const hasTrim = (delta?.trimmedLeft || 0) > 0 || (delta?.trimmedRight || 0) > 0;
  if (hasTrim) return 0;
  if (delta?.type === "tick" && delta.bar?.time != null) {
    const index = store?.indexOfTime?.(delta.bar.time);
    return Number.isFinite(index) && index >= 0 ? index : Math.max(0, rows.length - 1);
  }
  if (delta?.type === "append" && delta.addedRight > 0) {
    return Math.max(0, rows.length - delta.addedRight);
  }
  return 0;
}

function finiteCloses(rows = []) {
  const closes = [];
  for (const row of rows || []) {
    const close = validClose(row);
    if (close != null) closes.push(close);
  }
  return closes;
}

export function buildMainSeriesReferenceOptions(chartType, rows = []) {
  const resolvedType = normalizeMainChartType(chartType);
  if (resolvedType !== "baseline" && resolvedType !== "histogram") return {};

  if (resolvedType === "baseline") {
    for (const row of rows || []) {
      const close = validClose(row);
      if (close != null) return { baseValue: { type: "price", price: close } };
    }
    return {};
  }

  const closes = finiteCloses(rows);
  if (closes.length === 0) return {};
  let minimum = closes[0];
  let maximum = closes[0];
  for (let index = 1; index < closes.length; index += 1) {
    minimum = Math.min(minimum, closes[index]);
    maximum = Math.max(maximum, closes[index]);
  }
  const spread = maximum - minimum;
  const padding = spread > 0
    ? spread * 0.08
    : Math.max(Math.abs(minimum) * 0.005, 1e-8);
  const candidate = minimum - padding;
  const base = minimum > 0 ? Math.max(minimum * 0.01, candidate) : candidate;
  return { base };
}

export function buildMainSeriesStyleOptions(chartType, {
  downColor = DEFAULT_DOWN_COLOR,
  upColor = DEFAULT_UP_COLOR,
} = {}) {
  const resolvedType = normalizeMainChartType(chartType);
  if (resolvedType === "candlestick"
    || resolvedType === "hollow-candlestick"
    || resolvedType === "heikin-ashi") {
    return {
      upColor,
      downColor,
      borderDownColor: downColor,
      borderUpColor: upColor,
      wickDownColor: downColor,
      wickUpColor: upColor,
    };
  }
  if (resolvedType === "bar") {
    return {
      upColor,
      downColor,
      openVisible: true,
      thinBars: true,
    };
  }
  if (resolvedType === "high-low") {
    return { color: PRICE_LINE_COLOR };
  }
  if (resolvedType === "line"
    || resolvedType === "line-with-markers"
    || resolvedType === "step-line") {
    return {
      color: PRICE_LINE_COLOR,
      lineWidth: 2,
      lineType: resolvedType === "step-line" ? LineType.WithSteps : LineType.Simple,
      pointMarkersVisible: resolvedType === "line-with-markers",
      ...(resolvedType === "line-with-markers" ? { pointMarkersRadius: 3 } : {}),
      crosshairMarkerVisible: true,
    };
  }
  if (resolvedType === "area") {
    return {
      lineColor: PRICE_LINE_COLOR,
      lineWidth: 2,
      topColor: "rgba(41, 98, 255, 0.38)",
      bottomColor: "rgba(41, 98, 255, 0.04)",
      crosshairMarkerVisible: true,
    };
  }
  if (resolvedType === "baseline") {
    return {
      topLineColor: upColor,
      topFillColor1: colorWithAlpha(upColor, 0.28, "rgba(34, 197, 94, 0.28)"),
      topFillColor2: colorWithAlpha(upColor, 0.05, "rgba(34, 197, 94, 0.05)"),
      bottomLineColor: downColor,
      bottomFillColor1: colorWithAlpha(downColor, 0.05, "rgba(239, 68, 68, 0.05)"),
      bottomFillColor2: colorWithAlpha(downColor, 0.28, "rgba(239, 68, 68, 0.28)"),
      lineWidth: 2,
    };
  }
  return { color: upColor };
}

export function buildMainSeriesOptions(chartType, options = {}, rows = []) {
  return {
    ...buildMainSeriesStyleOptions(chartType, options),
    ...buildMainSeriesReferenceOptions(chartType, rows),
  };
}

export function buildMainSeriesCrosshairValue(time, row, {
  chartType,
  displayRow = null,
} = {}) {
  const priceRow = normalizeMainChartType(chartType) === "heikin-ashi" && displayRow
    ? displayRow
    : row;
  const open = finiteNumber(priceRow?.open);
  const high = finiteNumber(priceRow?.high);
  const low = finiteNumber(priceRow?.low);
  const close = finiteNumber(priceRow?.close);
  if (time == null || open == null || high == null || low == null || close == null) return null;
  return {
    time,
    open,
    high,
    low,
    close,
    volume: finiteNumber(row?.volume) || 0,
  };
}
