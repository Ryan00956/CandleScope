import type {
  OrderBookBook,
  OrderBookIdentity,
  OrderBookLevel,
  OrderBookMode,
  PriceGrouping,
} from "./orderBookTypes.js";

type JsonObject = Record<string, unknown>;

export type ParsedOrderBookMessage =
  | { kind: "connected"; protocol: string }
  | { kind: "subscribed"; requestId: string | null; streams: readonly JsonObject[] }
  | { kind: "unsubscribed"; requestId: string | null }
  | { kind: "records"; initial: boolean; records: readonly OrderBookBook[] }
  | { kind: "stale"; identity: OrderBookIdentity; message: string | null }
  | { kind: "error"; code: string; detail: string; requestId: string | null };

function object(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonObject;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  return string(value, path);
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function optionalFinite(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  return finite(value, path);
}

function integer(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return parsed;
}

function optionalInteger(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  return integer(value, path);
}

function optionalBoolean(value: unknown, path: string, fallback = false): boolean {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function priceGrouping(value: unknown): PriceGrouping {
  const grouping = value === null || value === undefined ? "raw" : string(value, "data.price_grouping");
  if (!["auto", "raw", "10", "100", "1000"].includes(grouping)) {
    throw new Error("data.price_grouping is unsupported");
  }
  return grouping as PriceGrouping;
}

function parseLevels(value: unknown, side: "bids" | "asks"): readonly OrderBookLevel[] {
  if (!Array.isArray(value)) throw new Error(`data.${side} must be an array`);
  const levels = value.map((raw, index): OrderBookLevel => {
    if (!Array.isArray(raw) || raw.length !== 2) {
      throw new Error(`data.${side}[${index}] must be a [price, quantity] tuple`);
    }
    const price = finite(raw[0], `data.${side}[${index}][0]`);
    const quantity = finite(raw[1], `data.${side}[${index}][1]`);
    if (price <= 0 || quantity <= 0) {
      throw new Error(`data.${side}[${index}] must contain positive values`);
    }
    return Object.freeze([price, quantity] as const);
  });
  for (let index = 1; index < levels.length; index += 1) {
    const previous = levels[index - 1]?.[0] ?? 0;
    const current = levels[index]?.[0] ?? 0;
    if ((side === "bids" && current >= previous) || (side === "asks" && current <= previous)) {
      throw new Error(`data.${side} must be strictly price-sorted`);
    }
  }
  return Object.freeze(levels);
}

function parseIdentity(key: JsonObject, data: JsonObject): OrderBookIdentity {
  const exchange = string(key.exchange ?? data.exchange, "key.exchange").toLowerCase();
  const marketType = string(key.market_type ?? data.market_type, "key.market_type").toLowerCase();
  const symbol = string(key.symbol ?? data.symbol, "key.symbol").toUpperCase();
  return Object.freeze({ exchange, marketType, symbol });
}

function derivedMetric(
  supplied: unknown,
  fallback: number | null,
  path: string,
): number | null {
  return supplied === undefined || supplied === null ? fallback : optionalFinite(supplied, path);
}

export function parseOrderBookRecord(value: unknown, mode: OrderBookMode): OrderBookBook {
  const record = object(value, "record");
  const key = object(record.key, "record.key");
  const data = object(record.data, "record.data");
  const expectedChannel = mode === "partial" ? "depth" : "full_depth";
  if (
    string(key.channel, "record.key.channel") !== expectedChannel
    || string(record.channel, "record.channel") !== expectedChannel
  ) {
    throw new Error(`record channel does not match ${expectedChannel}`);
  }
  if (mode === "full" && (data.live !== true || data.stale === true || data.state !== "live")) {
    throw new Error("full order-book record is not an atomic live snapshot");
  }
  const bids = parseLevels(data.bids, "bids");
  const asks = parseLevels(data.asks, "asks");
  const topBid = bids[0]?.[0] ?? null;
  const topAsk = asks[0]?.[0] ?? null;
  if (topBid !== null && topAsk !== null && topBid >= topAsk) {
    throw new Error("order book is crossed or locked");
  }
  const midPrice = topBid !== null && topAsk !== null ? (topBid + topAsk) / 2 : null;
  const spread = topBid !== null && topAsk !== null ? topAsk - topBid : null;
  const spreadBps = spread !== null && midPrice ? (spread / midPrice) * 10_000 : null;
  const keyMode = object(key.params ?? {}, "record.key.params").mode;
  if (keyMode !== mode) {
    throw new Error(`record key mode ${String(keyMode)} does not match ${mode}`);
  }
  const dataMode = data.mode;
  const allowedDataModes = mode === "partial"
    ? ["partial", "partial_top_n"]
    : ["full", "full_depth_reconstructed"];
  if (dataMode !== undefined && !allowedDataModes.includes(String(dataMode))) {
    throw new Error(`record data mode ${String(dataMode)} does not match ${mode}`);
  }
  const notionalImbalance = optionalFinite(data.notional_imbalance, "data.notional_imbalance");
  if (notionalImbalance !== null && Math.abs(notionalImbalance) > 1.0000001) {
    throw new Error("data.notional_imbalance must be between -1 and 1");
  }
  const priceTickSize = optionalFinite(data.price_tick_size, "data.price_tick_size");
  const priceStep = optionalFinite(data.price_step, "data.price_step");
  if (priceTickSize !== null && priceTickSize <= 0) {
    throw new Error("data.price_tick_size must be positive");
  }
  if (priceStep !== null && priceStep <= 0) {
    throw new Error("data.price_step must be positive");
  }

  return Object.freeze({
    mode,
    identity: parseIdentity(key, data),
    topic: string(record.topic, "record.topic"),
    eventTimeMs: integer(record.event_time_ms, "record.event_time_ms"),
    receivedAtMs: integer(record.received_at_ms, "record.received_at_ms"),
    source: string(record.source, "record.source"),
    sequence: optionalInteger(record.sequence, "record.sequence"),
    revision: integer(record.revision, "record.revision"),
    bids,
    asks,
    topBid: derivedMetric(data.best_bid_price ?? data.top_bid, topBid, "data.best_bid_price"),
    topAsk: derivedMetric(data.best_ask_price ?? data.top_ask, topAsk, "data.best_ask_price"),
    midPrice: derivedMetric(data.mid_price, midPrice, "data.mid_price"),
    spread: derivedMetric(data.spread, spread, "data.spread"),
    spreadBps: derivedMetric(data.spread_bps, spreadBps, "data.spread_bps"),
    notionalImbalance,
    updateIntervalMs: optionalInteger(data.update_interval_ms, "data.update_interval_ms"),
    depthLevels: optionalInteger(data.depth_levels, "data.depth_levels"),
    outputLimit: optionalInteger(data.output_limit, "data.output_limit"),
    bookBidLevels: optionalInteger(data.book_bid_levels, "data.book_bid_levels"),
    bookAskLevels: optionalInteger(data.book_ask_levels, "data.book_ask_levels"),
    priceTickSize,
    priceStep,
    priceGrouping: priceGrouping(data.price_grouping),
    aggregationApplied: optionalBoolean(data.aggregation_applied, "data.aggregation_applied"),
    bucketBidLevels: optionalInteger(data.bucket_bid_levels, "data.bucket_bid_levels"),
    bucketAskLevels: optionalInteger(data.bucket_ask_levels, "data.bucket_ask_levels"),
  });
}

function recordsFrom(value: unknown, mode: OrderBookMode): readonly OrderBookBook[] {
  if (!Array.isArray(value)) throw new Error("snapshot.data must be an array");
  return Object.freeze(value.map((record) => parseOrderBookRecord(record, mode)));
}

function staleSnapshot(value: unknown): {
  identity: OrderBookIdentity;
  message: string | null;
} | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const rawRecord of value) {
    const record = object(rawRecord, "snapshot.data[]");
    const data = object(record.data, "snapshot.data[].data");
    if (data.stale === true || data.live === false || data.state === "stale") {
      return {
        identity: parseIdentity(object(record.key, "snapshot.data[].key"), data),
        message: optionalString(data.stale_reason, "snapshot.data[].data.stale_reason"),
      };
    }
  }
  return undefined;
}

export function parseOrderBookSocketMessage(
  raw: unknown,
  mode: OrderBookMode,
): ParsedOrderBookMessage {
  const message = object(raw, "message");
  const type = string(message.type, "message.type");
  if (type === "connected") {
    return { kind: "connected", protocol: string(message.protocol, "message.protocol") };
  }
  if (type === "subscribed") {
    if (!Array.isArray(message.streams)) throw new Error("message.streams must be an array");
    return {
      kind: "subscribed",
      requestId: optionalString(message.request_id, "message.request_id"),
      streams: Object.freeze(message.streams.map((stream, index) => object(stream, `message.streams[${index}]`))),
    };
  }
  if (type === "unsubscribed") {
    return { kind: "unsubscribed", requestId: optionalString(message.request_id, "message.request_id") };
  }
  if (type === "snapshot") {
    if (mode === "full") {
      const stale = staleSnapshot(message.data);
      if (stale !== undefined) return { kind: "stale", ...stale };
    }
    return { kind: "records", initial: true, records: recordsFrom(message.data, mode) };
  }
  if (type === "order_book.snapshot" && mode === "partial") {
    return { kind: "records", initial: false, records: [parseOrderBookRecord(message.data, mode)] };
  }
  if (type === "full_order_book.snapshot" && mode === "full") {
    if (message.state !== undefined && message.state !== "live") {
      throw new Error("full order-book snapshot must be live");
    }
    return { kind: "records", initial: false, records: [parseOrderBookRecord(message.data, mode)] };
  }
  if (type === "full_order_book.status" && mode === "full") {
    if (message.state !== "stale") throw new Error("full order-book status must be stale");
    const record = object(message.data, "message.data");
    const data = object(record.data, "message.data.data");
    return {
      kind: "stale",
      identity: parseIdentity(object(record.key, "message.data.key"), data),
      message: optionalString(data.stale_reason, "message.data.data.stale_reason"),
    };
  }
  if (type === "error") {
    return {
      kind: "error",
      code: string(message.code, "message.code"),
      detail: optionalString(message.detail, "message.detail") || "Order-book stream error",
      requestId: optionalString(message.request_id, "message.request_id"),
    };
  }
  throw new Error(`unsupported order-book message type: ${type}`);
}
