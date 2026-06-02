import { createChart, CandlestickSeries, LineSeries, HistogramSeries, AreaSeries } from "lightweight-charts";

export const chartSeriesTypes = Object.freeze({
  candlestick: CandlestickSeries,
  line: LineSeries,
  histogram: HistogramSeries,
  area: AreaSeries,
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

export function createChartInstance(container, options) {
  return createChart(container, options);
}
