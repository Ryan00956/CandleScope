export const CHART_SESSION_TRANSITION_TYPES = Object.freeze({
  SYMBOL_CHANGE: "symbol-change",
  INTERVAL_CHANGE: "interval-change",
  MARKET_TYPE_CHANGE: "market-type-change",
  CAPABILITY_CORRECTION: "capability-correction",
});

export function buildChartSessionKey({ exchange, marketType, symbol, interval }) {
  return `${exchange}:${marketType}:${symbol}:${interval}`;
}

export function createChartSessionTransition({ id, type, from, to }) {
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
