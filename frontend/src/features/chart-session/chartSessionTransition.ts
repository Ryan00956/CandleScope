import type {
  ChartSession,
  ChartSessionKey,
  ChartSessionTransition,
  ChartSessionTransitionType,
} from "./chartSessionTypes.js";
import { canonicalizeIntervalValue } from "../../utils/intervals.js";
import {
  isLegacyKlineSeriesIdentity,
  klineSeriesIdentityKey,
} from "../market-data/klineSeriesIdentity.js";

export const CHART_SESSION_TRANSITION_TYPES = Object.freeze({
  SYMBOL_CHANGE: "symbol-change",
  INTERVAL_CHANGE: "interval-change",
  MARKET_TYPE_CHANGE: "market-type-change",
  CAPABILITY_CORRECTION: "capability-correction",
} as const satisfies Record<string, ChartSessionTransitionType>);

export function buildChartSessionKey<T extends ChartSession>(session: T): ChartSessionKey {
  const { exchange, marketType, symbol, interval } = session;
  const routed = `${exchange}:${marketType}:${symbol}:${canonicalizeIntervalValue(interval) || interval}`;
  return isLegacyKlineSeriesIdentity(exchange, session)
    ? routed
    : `${klineSeriesIdentityKey(exchange, session)}:${routed}`;
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

export type ControlledSessionApplyDecision = "ack" | "hold" | "apply";

/**
 * Local toolbar edits render before the workspace document echoes them.
 * Hold any intermediate document key while local state has un-echoed edits;
 * apply only when the cell is idle (local still matches the last applied key).
 */
export function decideControlledSessionApply(
  controlledSessionKey: string,
  sessionKey: string,
  lastControlledSessionKey: string | null,
): ControlledSessionApplyDecision {
  if (controlledSessionKey === sessionKey) return "ack";
  if (lastControlledSessionKey !== null && sessionKey !== lastControlledSessionKey) {
    return "hold";
  }
  return "apply";
}
