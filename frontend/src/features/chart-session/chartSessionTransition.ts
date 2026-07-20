import type {
  ChartSession,
  ChartSessionKey,
  ChartSessionTransition,
  ChartSessionTransitionType,
} from "./chartSessionTypes.js";
import { canonicalizeIntervalValue } from "../../utils/intervals.js";

export const CHART_SESSION_TRANSITION_TYPES = Object.freeze({
  SYMBOL_CHANGE: "symbol-change",
  INTERVAL_CHANGE: "interval-change",
  MARKET_TYPE_CHANGE: "market-type-change",
  CAPABILITY_CORRECTION: "capability-correction",
} as const satisfies Record<string, ChartSessionTransitionType>);

export function buildChartSessionKey<T extends ChartSession>({
  exchange,
  marketType,
  symbol,
  interval,
}: T): ChartSessionKey {
  return `${exchange}:${marketType}:${symbol}:${canonicalizeIntervalValue(interval) || interval}`;
}

export interface CreateChartSessionTransitionOptions {
  id: number;
  type: ChartSessionTransitionType;
  from: ChartSession;
  to: ChartSession;
}

export function createChartSessionTransition({
  id,
  type,
  from,
  to,
}: CreateChartSessionTransitionOptions): ChartSessionTransition {
  return {
    id,
    type,
    from,
    to,
    fromSessionKey: buildChartSessionKey(from),
    sessionKey: buildChartSessionKey(to),
    createdAt: Date.now(),
  };
}
