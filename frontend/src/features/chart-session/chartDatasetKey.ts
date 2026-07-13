import type { ChartSession, DatasetKey } from "./chartSessionTypes.js";

export function buildChartDatasetKey<T extends ChartSession>({
  exchange,
  marketType,
  symbol,
  interval,
}: T): DatasetKey {
  return [exchange, marketType, symbol, interval].join("-");
}
