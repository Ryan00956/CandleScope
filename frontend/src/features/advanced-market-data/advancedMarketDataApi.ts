import { API_BASE, httpBaseToWsBase } from "../../services/apiConfig.js";
import { request } from "../../services/api.js";
import {
  parseMarketHistoryPayload,
  parseMarketSnapshotPayload,
} from "./advancedMarketDataParser.js";
import type {
  AdvancedMarketChannel,
  AdvancedMarketIdentity,
  MarketHistoryPayload,
  MarketSnapshotPayload,
} from "./advancedMarketDataTypes.js";

interface MarketHistoryQuery {
  period?: string | null;
  startMs?: number | null;
  endMs?: number | null;
  limit?: number;
  signal?: AbortSignal;
}

function buildUrl(path: string, params: Record<string, unknown> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
      continue;
    }
    search.set(key, String(value));
  }
  const query = search.toString();
  return `${API_BASE}${path}${query ? `?${query}` : ""}`;
}

export async function fetchAdvancedMarketSnapshot(
  identity: AdvancedMarketIdentity,
  channels: readonly AdvancedMarketChannel[],
  signal?: AbortSignal,
): Promise<MarketSnapshotPayload> {
  const payload = await request(buildUrl("/market/snapshot", {
    exchange: identity.exchange,
    market_type: identity.marketType,
    symbol: identity.symbol,
    channel: channels,
  }), signal === undefined ? {} : { signal });
  return parseMarketSnapshotPayload(payload, "GET /market/snapshot");
}

export async function fetchAdvancedMarketHistory(
  identity: AdvancedMarketIdentity,
  channel: Extract<AdvancedMarketChannel, "funding_rate" | "open_interest">,
  {
    period = null,
    startMs = null,
    endMs = null,
    limit = 1000,
    signal,
  }: MarketHistoryQuery = {},
): Promise<MarketHistoryPayload> {
  const payload = await request(buildUrl("/market/history", {
    exchange: identity.exchange,
    market_type: identity.marketType,
    symbol: identity.symbol,
    channel,
    period,
    start_ms: startMs,
    end_ms: endMs,
    limit,
  }), signal === undefined ? {} : { signal });
  return parseMarketHistoryPayload(payload, `GET /market/history?channel=${channel}`);
}

export function getAdvancedMarketStreamUrl(): string {
  return `${httpBaseToWsBase(API_BASE)}/stream/market`;
}
