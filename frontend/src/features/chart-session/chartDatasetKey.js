export function buildChartDatasetKey({ exchange, marketType, symbol, interval }) {
  return [exchange, marketType, symbol, interval].join("-");
}
