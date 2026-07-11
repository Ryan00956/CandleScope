import {
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  createChart,
  createChartEx,
  HistogramSeries,
  LineSeries,
} from "lightweight-charts";
import { createOrdinalHorzScaleBehavior } from "./ordinalHorzScaleBehavior.js";

export const chartSeriesTypes = Object.freeze({
  candlestick: CandlestickSeries,
  bar: BarSeries,
  line: LineSeries,
  histogram: HistogramSeries,
  area: AreaSeries,
  baseline: BaselineSeries,
});

export function buildPaneLayoutOptions({
  separatorColor = "rgba(148, 163, 184, 0.28)",
  separatorHoverColor = "rgba(59, 130, 246, 0.6)",
  enableResize = true,
} = {}) {
  return {
    panes: {
      separatorColor,
      separatorHoverColor,
      enableResize,
    },
  };
}

export function createChartInstance(container, options, { axisMode = "time" } = {}) {
  if (axisMode === "ordinal" || axisMode === "derived-ordinal") {
    return createChartEx(container, createOrdinalHorzScaleBehavior(), options);
  }
  return createChart(container, options);
}
