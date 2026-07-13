import type { CacheAccessEvent } from "./cacheGcTypes.js";

const pending: CacheAccessEvent[] = [];
const MAX_PENDING = 200;

interface CacheAccessInput {
  owner?: string;
  key?: string;
  exchange?: string;
  marketType?: string;
  symbol?: string;
  interval?: string;
  action?: string;
  source?: string;
  weight?: unknown;
  detail?: Record<string, unknown>;
}

function normalize(value: unknown, fallback = ""): string {
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
}: CacheAccessInput = {}): CacheAccessEvent | null {
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

export function drainFrontendCacheAccessEvents(limit: unknown = MAX_PENDING): CacheAccessEvent[] {
  const count = Math.max(1, Number(limit || MAX_PENDING));
  return pending.splice(0, count);
}

export function snapshotFrontendCacheAccessEvents(): CacheAccessEvent[] {
  return pending.slice();
}
