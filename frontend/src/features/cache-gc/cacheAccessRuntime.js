const pending = [];
const MAX_PENDING = 200;

function normalize(value, fallback = "") {
  return String(value ?? fallback).trim();
}

export function recordFrontendCacheAccess({
  owner = "frontend",
  key = "",
  exchange = "binance",
  marketType = "spot",
  symbol = "",
  interval = "*",
  action = "frontend-access",
  source = "frontend",
  weight = null,
  detail = {},
} = {}) {
  if (!symbol) return null;
  const event = {
    owner,
    key,
    exchange: normalize(exchange, "binance").toLowerCase(),
    marketType: normalize(marketType, "spot").toLowerCase(),
    symbol: normalize(symbol).toUpperCase(),
    interval: normalize(interval, "*") || "*",
    action,
    source,
    weight,
    detail,
    occurredAtMs: Date.now(),
  };
  pending.push(event);
  if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
  return event;
}

export function drainFrontendCacheAccessEvents(limit = MAX_PENDING) {
  const count = Math.max(1, Number(limit || MAX_PENDING));
  return pending.splice(0, count);
}

export function snapshotFrontendCacheAccessEvents() {
  return pending.slice();
}
