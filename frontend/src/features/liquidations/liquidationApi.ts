import { request } from "../../services/api.js";
import { API_BASE, httpBaseToWsBase } from "../../services/apiConfig.js";
import { parseLiquidationHistoryPayload } from "./liquidationParser.js";
import type {
  LiquidationHistoryPayload,
  LiquidationIdentity,
  LiquidationPositionSide,
} from "./liquidationTypes.js";

interface LiquidationHistoryQuery {
  positionSide: LiquidationPositionSide;
  startMs: number;
  endMs: number;
  limit?: number;
  signal?: AbortSignal;
}

export async function fetchLiquidationHistory(
  identity: LiquidationIdentity,
  {
    positionSide,
    startMs,
    endMs,
    limit = 5000,
    signal,
  }: LiquidationHistoryQuery,
): Promise<LiquidationHistoryPayload> {
  const search = new URLSearchParams({
    exchange: identity.exchange,
    market_type: identity.marketType,
    symbol: identity.symbol,
    period: "1m",
    position_side: positionSide,
    start_ms: String(startMs),
    end_ms: String(endMs),
    limit: String(limit),
  });
  const payload = await request(
    `${API_BASE}/liquidations/history?${search.toString()}`,
    signal === undefined ? {} : { signal },
  );
  return parseLiquidationHistoryPayload(
    payload,
    `GET /liquidations/history?position_side=${positionSide}`,
  );
}

export function getLiquidationStreamUrl(): string {
  return `${httpBaseToWsBase(API_BASE)}/stream/liquidations`;
}
