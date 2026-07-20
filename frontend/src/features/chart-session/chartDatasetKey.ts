import type { ChartSession, DatasetKey } from "./chartSessionTypes.js";
import { canonicalizeIntervalValue } from "../../utils/intervals.js";

export function buildChartDatasetKey<T extends ChartSession>({
  exchange,
  marketType,
  symbol,
  interval,
}: T): DatasetKey {
  return [exchange, marketType, symbol, canonicalizeIntervalValue(interval) || interval].join("-");
}
