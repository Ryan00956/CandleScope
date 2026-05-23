import { createChart, CandlestickSeries, LineSeries, HistogramSeries, AreaSeries } from "lightweight-charts";

export const chartSeriesTypes = Object.freeze({
  candlestick: CandlestickSeries,
  line: LineSeries,
  histogram: HistogramSeries,
  area: AreaSeries,
});

export function createChartInstance(container, options) {
  return createChart(container, options);
}