import type { AggregateTrade, TradeFlowSide } from "./tradeFlowTypes.js";

const PROTOCOL = "tradeflow.v1";

export class TradeFlowPayloadError extends TypeError {
  constructor(path: string, message: string) {
    super(`Invalid TradeFlow payload at ${path}: ${message}`);
    this.name = "TradeFlowPayloadError";
  }
}

type JsonRecord = Record<string, unknown>;

export type ParsedTradeFlowSocketMessage =
  | { kind: "connected"; protocol: string }
  | { kind: "subscribed"; protocol: string; requestId: string | null; streams: JsonRecord[] }
  | { kind: "recent"; protocol: string; requestId: string | null; records: AggregateTrade[] }
  | {
    kind: "batch";
    protocol: string;
    sequence: number;
    continuity: boolean;
    resyncRequired: boolean;
    records: AggregateTrade[];
  }
  | { kind: "resync"; protocol: string; message: string }
  | { kind: "error"; requestId: string | null; code: string; detail: string }
  | { kind: "unsubscribed" };

function record(value: unknown, path: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TradeFlowPayloadError(path, "expected an object");
  }
  return value as JsonRecord;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TradeFlowPayloadError(path, "expected a non-empty string");
  }
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TradeFlowPayloadError(path, "expected a finite number");
  }
  return value;
}

function nonNegative(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (parsed < 0) throw new TradeFlowPayloadError(path, "expected a non-negative number");
  return parsed;
}

function integer(value: unknown, path: string): number {
  const parsed = nonNegative(value, path);
  if (!Number.isSafeInteger(parsed)) {
    throw new TradeFlowPayloadError(path, "expected a non-negative safe integer");
  }
  return parsed;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TradeFlowPayloadError(path, "expected a boolean");
  return value;
}

function nullableInteger(value: unknown, path: string): number | null {
  return value == null ? null : integer(value, path);
}

function protocol(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (parsed !== PROTOCOL) throw new TradeFlowPayloadError(path, `unsupported protocol ${parsed}`);
  return parsed;
}

export function parseAggregateTrade(value: unknown, path = "trade"): AggregateTrade {
  const raw = record(value, path);
  const aggressorSide = string(raw.aggressor_side, `${path}.aggressor_side`) as TradeFlowSide;
  if (aggressorSide !== "buy" && aggressorSide !== "sell") {
    throw new TradeFlowPayloadError(`${path}.aggressor_side`, "expected buy or sell");
  }
  const isBuyerMaker = boolean(raw.is_buyer_maker, `${path}.is_buyer_maker`);
  if ((aggressorSide === "buy") === isBuyerMaker) {
    throw new TradeFlowPayloadError(path, "aggressor_side disagrees with is_buyer_maker");
  }
  return {
    exchange: string(raw.exchange, `${path}.exchange`).toLowerCase(),
    marketType: string(raw.market_type, `${path}.market_type`).toLowerCase(),
    symbol: string(raw.symbol, `${path}.symbol`).toUpperCase(),
    aggTradeId: integer(raw.agg_trade_id, `${path}.agg_trade_id`),
    price: nonNegative(raw.price, `${path}.price`),
    quantity: nonNegative(raw.quantity, `${path}.quantity`),
    quoteQuantity: nonNegative(raw.quote_quantity, `${path}.quote_quantity`),
    tradeTimeMs: integer(raw.trade_time_ms, `${path}.trade_time_ms`),
    eventTimeMs: integer(raw.event_time_ms, `${path}.event_time_ms`),
    receivedAtMs: integer(raw.received_at_ms, `${path}.received_at_ms`),
    isBuyerMaker,
    aggressorSide,
    source: string(raw.source, `${path}.source`),
    firstTradeId: nullableInteger(raw.first_trade_id, `${path}.first_trade_id`),
    lastTradeId: nullableInteger(raw.last_trade_id, `${path}.last_trade_id`),
  };
}

function parseTrades(value: unknown, path: string): AggregateTrade[] {
  if (!Array.isArray(value)) throw new TradeFlowPayloadError(path, "expected an array");
  return value.map((item, index) => parseAggregateTrade(item, `${path}[${index}]`));
}

export function parseTradeFlowSocketMessage(value: unknown): ParsedTradeFlowSocketMessage {
  const raw = record(value, "message");
  const type = string(raw.type, "message.type");
  if (type === "error") {
    return {
      kind: "error",
      requestId: typeof raw.request_id === "string" ? raw.request_id : null,
      code: string(raw.code, "message.code"),
      detail: typeof raw.detail === "string" ? raw.detail : "TradeFlow request failed",
    };
  }
  if (type === "unsubscribed") return { kind: "unsubscribed" };
  const parsedProtocol = protocol(raw.protocol, "message.protocol");
  if (type === "connected") return { kind: "connected", protocol: parsedProtocol };
  if (type === "subscribed") {
    if (!Array.isArray(raw.streams)) {
      throw new TradeFlowPayloadError("message.streams", "expected an array");
    }
    return {
      kind: "subscribed",
      protocol: parsedProtocol,
      requestId: typeof raw.request_id === "string" ? raw.request_id : null,
      streams: raw.streams.map((item, index) => record(item, `message.streams[${index}]`)),
    };
  }
  if (type === "recent") {
    return {
      kind: "recent",
      protocol: parsedProtocol,
      requestId: typeof raw.request_id === "string" ? raw.request_id : null,
      records: parseTrades(raw.data, "message.data"),
    };
  }
  if (type === "trade.batch") {
    return {
      kind: "batch",
      protocol: parsedProtocol,
      sequence: integer(raw.sequence, "message.sequence"),
      continuity: boolean(raw.continuity, "message.continuity"),
      resyncRequired: boolean(raw.resync_required, "message.resync_required"),
      records: parseTrades(raw.data, "message.data"),
    };
  }
  if (type === "resync_required") {
    const dropped = raw.dropped_before == null ? null : integer(raw.dropped_before, "message.dropped_before");
    return {
      kind: "resync",
      protocol: parsedProtocol,
      message: dropped ? `后端检测到成交投递缺口（丢失至少 ${dropped} 条）` : "后端要求重新同步成交序列",
    };
  }
  throw new TradeFlowPayloadError("message.type", `unsupported message type ${type}`);
}
