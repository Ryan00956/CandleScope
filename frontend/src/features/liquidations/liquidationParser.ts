import {
  LIQUIDATION_PROTOCOL,
  LIQUIDATION_SAMPLING_MODE,
  LIQUIDATION_SOURCE_QUALITY,
  type LiquidationEvent,
  type LiquidationHistoryPayload,
  type LiquidationPositionSide,
  type LiquidationQualityMetadata,
  type LiquidationRollup,
  type LiquidationSocketMessage,
  type LiquidationStreamKey,
} from "./liquidationTypes.js";

export class LiquidationPayloadError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`Invalid liquidation payload at ${path}: ${message}`);
    this.name = "LiquidationPayloadError";
    this.path = path;
  }
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, path: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LiquidationPayloadError(path, "expected an object");
  }
  return value as JsonRecord;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new LiquidationPayloadError(path, "expected an array");
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LiquidationPayloadError(path, "expected a non-empty string");
  }
  return value.trim();
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LiquidationPayloadError(path, "expected a finite number");
  }
  return value;
}

function nonNegative(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (parsed < 0) throw new LiquidationPayloadError(path, "expected a non-negative number");
  return parsed;
}

function nonNegativeInteger(value: unknown, path: string): number {
  const parsed = nonNegative(value, path);
  if (!Number.isInteger(parsed)) {
    throw new LiquidationPayloadError(path, "expected a non-negative integer");
  }
  return parsed;
}

function nullableInteger(value: unknown, path: string): number | null {
  return value == null ? null : nonNegativeInteger(value, path);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new LiquidationPayloadError(path, "expected a boolean");
  return value;
}

function literal<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  path: string,
): T {
  if (value !== expected) {
    throw new LiquidationPayloadError(path, `expected ${JSON.stringify(expected)}`);
  }
  return expected;
}

function positionSide(value: unknown, path: string): LiquidationPositionSide {
  const parsed = string(value, path).toLowerCase();
  if (parsed !== "long" && parsed !== "short") {
    throw new LiquidationPayloadError(path, "expected long or short");
  }
  return parsed;
}

export function parseLiquidationQuality(
  value: unknown,
  path = "liquidation",
): LiquidationQualityMetadata {
  const source = record(value, path);
  const exchangeUpdateIntervalMs = nonNegativeInteger(
    source.exchange_update_interval_ms,
    `${path}.exchange_update_interval_ms`,
  );
  if (exchangeUpdateIntervalMs <= 0) {
    throw new LiquidationPayloadError(
      `${path}.exchange_update_interval_ms`,
      "expected a positive integer",
    );
  }
  return {
    sourceQuality: literal(
      source.source_quality,
      LIQUIDATION_SOURCE_QUALITY,
      `${path}.source_quality`,
    ),
    sourceExhaustive: literal(source.source_exhaustive, false, `${path}.source_exhaustive`),
    samplingMode: literal(source.sampling_mode, LIQUIDATION_SAMPLING_MODE, `${path}.sampling_mode`),
    lossySnapshot: literal(source.lossy_snapshot, true, `${path}.lossy_snapshot`),
    backfillable: literal(source.backfillable, false, `${path}.backfillable`),
    exchangeUpdateIntervalMs,
  };
}

export function parseLiquidationStreamKey(
  value: unknown,
  path = "liquidation.key",
): LiquidationStreamKey {
  const source = record(value, path);
  literal(source.channel, "liquidation", `${path}.channel`);
  const rawParams = source.params == null ? {} : record(source.params, `${path}.params`);
  const params: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(rawParams)) {
    params[key] = string(rawValue, `${path}.params.${key}`);
  }
  return {
    exchange: string(source.exchange, `${path}.exchange`).toLowerCase(),
    market_type: string(source.market_type, `${path}.market_type`).toLowerCase(),
    symbol: string(source.symbol, `${path}.symbol`).toUpperCase(),
    channel: "liquidation",
    params,
  };
}

export function parseLiquidationEvent(
  value: unknown,
  path = "liquidation.event",
): LiquidationEvent {
  const source = record(value, path);
  const orderSide = string(source.order_side, `${path}.order_side`).toUpperCase();
  if (orderSide !== "BUY" && orderSide !== "SELL") {
    throw new LiquidationPayloadError(`${path}.order_side`, "expected BUY or SELL");
  }
  const parsedPositionSide = positionSide(source.position_side, `${path}.position_side`);
  const derivedPositionSide = orderSide === "SELL" ? "long" : "short";
  if (parsedPositionSide !== derivedPositionSide) {
    throw new LiquidationPayloadError(
      `${path}.position_side`,
      "conflicts with the forced-order side",
    );
  }
  literal(source.source_quality, LIQUIDATION_SOURCE_QUALITY, `${path}.source_quality`);
  literal(source.source_exhaustive, false, `${path}.source_exhaustive`);
  return {
    exchange: string(source.exchange, `${path}.exchange`).toLowerCase(),
    marketType: string(source.market_type, `${path}.market_type`).toLowerCase(),
    symbol: string(source.symbol, `${path}.symbol`).toUpperCase(),
    orderSide,
    positionSide: parsedPositionSide,
    filledQuantity: nonNegative(source.filled_quantity, `${path}.filled_quantity`),
    executedNotional: nonNegative(source.executed_notional, `${path}.executed_notional`),
    tradeTimeMs: nonNegativeInteger(source.trade_time_ms, `${path}.trade_time_ms`),
    eventTimeMs: nonNegativeInteger(source.event_time_ms, `${path}.event_time_ms`),
    receivedAtMs: nonNegativeInteger(source.received_at_ms, `${path}.received_at_ms`),
    source: string(source.source, `${path}.source`).toLowerCase(),
    fingerprint: string(source.fingerprint, `${path}.fingerprint`),
  };
}

export function parseLiquidationRollup(
  value: unknown,
  path = "liquidation.rollup",
): LiquidationRollup {
  const source = record(value, path);
  literal(source.period, "1m", `${path}.period`);
  literal(source.source_quality, LIQUIDATION_SOURCE_QUALITY, `${path}.source_quality`);
  if (source.source_exhaustive != null) {
    literal(source.source_exhaustive, false, `${path}.source_exhaustive`);
  }
  const bucketStartMs = nonNegativeInteger(source.bucket_start_ms, `${path}.bucket_start_ms`);
  const bucketEndMs = nonNegativeInteger(source.bucket_end_ms, `${path}.bucket_end_ms`);
  if (bucketEndMs <= bucketStartMs) {
    throw new LiquidationPayloadError(`${path}.bucket_end_ms`, "must be after bucket_start_ms");
  }
  const firstEventTimeMs = nonNegativeInteger(
    source.first_event_time_ms,
    `${path}.first_event_time_ms`,
  );
  const lastEventTimeMs = nonNegativeInteger(
    source.last_event_time_ms,
    `${path}.last_event_time_ms`,
  );
  if (lastEventTimeMs < firstEventTimeMs) {
    throw new LiquidationPayloadError(
      `${path}.last_event_time_ms`,
      "must be at or after first_event_time_ms",
    );
  }
  return {
    exchange: string(source.exchange, `${path}.exchange`).toLowerCase(),
    marketType: string(source.market_type, `${path}.market_type`).toLowerCase(),
    symbol: string(source.symbol, `${path}.symbol`).toUpperCase(),
    period: "1m",
    positionSide: positionSide(source.position_side, `${path}.position_side`),
    bucketStartMs,
    bucketEndMs,
    filledQuantity: nonNegative(source.filled_quantity, `${path}.filled_quantity`),
    filledNotional: nonNegative(source.filled_notional, `${path}.filled_notional`),
    eventCount: nonNegativeInteger(source.event_count, `${path}.event_count`),
    maxEventNotional: nonNegative(source.max_event_notional, `${path}.max_event_notional`),
    firstEventTimeMs,
    lastEventTimeMs,
    isFinal: boolean(source.is_final, `${path}.is_final`),
    revision: nonNegativeInteger(source.revision, `${path}.revision`),
    updatedAtMs: nonNegativeInteger(source.updated_at_ms, `${path}.updated_at_ms`),
  };
}

export function parseLiquidationHistoryPayload(
  value: unknown,
  path = "liquidation.history",
): LiquidationHistoryPayload {
  const source = record(value, path);
  literal(source.type, "liquidation.history", `${path}.type`);
  literal(source.protocol, LIQUIDATION_PROTOCOL, `${path}.protocol`);
  const data = array(source.data, `${path}.data`).map((item, index) => (
    parseLiquidationRollup(item, `${path}.data[${index}]`)
  ));
  const count = nonNegativeInteger(source.count, `${path}.count`);
  if (count !== data.length) {
    throw new LiquidationPayloadError(`${path}.count`, "must equal data.length");
  }
  const coverage = record(source.coverage, `${path}.coverage`);
  return {
    type: "liquidation.history",
    protocol: LIQUIDATION_PROTOCOL,
    key: parseLiquidationStreamKey(source.key, `${path}.key`),
    count,
    data,
    hasMore: boolean(source.has_more, `${path}.has_more`),
    coverage: {
      earliestMs: nullableInteger(coverage.earliest_ms, `${path}.coverage.earliest_ms`),
      latestMs: nullableInteger(coverage.latest_ms, `${path}.coverage.latest_ms`),
      allRowsFinal: boolean(coverage.all_rows_final, `${path}.coverage.all_rows_final`),
      observedOnly: literal(coverage.observed_only, true, `${path}.coverage.observed_only`),
    },
    quality: parseLiquidationQuality(source, path),
  };
}

export function parseLiquidationSocketMessage(
  value: unknown,
  path = "liquidation.socket",
): LiquidationSocketMessage {
  const source = record(value, path);
  const type = string(source.type, `${path}.type`);
  if (type === "error") {
    return {
      type,
      requestId: source.request_id == null ? null : string(source.request_id, `${path}.request_id`),
      code: string(source.code, `${path}.code`),
      detail: source.detail == null ? "Liquidation stream error" : string(source.detail, `${path}.detail`),
    };
  }
  literal(source.protocol, LIQUIDATION_PROTOCOL, `${path}.protocol`);
  if (type === "connected") {
    return { type, protocol: LIQUIDATION_PROTOCOL, quality: parseLiquidationQuality(source, path) };
  }
  if (type === "subscribed" || type === "unsubscribed") {
    return {
      type,
      protocol: LIQUIDATION_PROTOCOL,
      requestId: string(source.request_id, `${path}.request_id`),
      streams: array(source.streams, `${path}.streams`).map((item, index) => (
        parseLiquidationStreamKey(item, `${path}.streams[${index}]`)
      )),
      quality: type === "subscribed" ? parseLiquidationQuality(source, path) : null,
    };
  }
  if (type === "recent") {
    return {
      type,
      protocol: LIQUIDATION_PROTOCOL,
      requestId: string(source.request_id, `${path}.request_id`),
      data: array(source.data, `${path}.data`).map((item, index) => (
        parseLiquidationEvent(item, `${path}.data[${index}]`)
      )),
      quality: parseLiquidationQuality(source, path),
    };
  }
  if (type === "liquidation.batch") {
    return {
      type,
      protocol: LIQUIDATION_PROTOCOL,
      sequence: nonNegativeInteger(source.sequence, `${path}.sequence`),
      deliveryContinuity: literal(source.delivery_continuity, true, `${path}.delivery_continuity`),
      resyncRequired: literal(source.resync_required, false, `${path}.resync_required`),
      droppedBefore: literal(source.dropped_before, 0, `${path}.dropped_before`),
      data: array(source.data, `${path}.data`).map((item, index) => (
        parseLiquidationEvent(item, `${path}.data[${index}]`)
      )),
      quality: parseLiquidationQuality(source, path),
    };
  }
  if (type === "resync_required") {
    return {
      type,
      protocol: LIQUIDATION_PROTOCOL,
      code: string(source.code, `${path}.code`),
      sequence: nullableInteger(source.sequence, `${path}.sequence`),
      deliveryContinuity: literal(source.delivery_continuity, false, `${path}.delivery_continuity`),
      resyncRequired: literal(source.resync_required, true, `${path}.resync_required`),
      droppedBefore: nonNegativeInteger(source.dropped_before, `${path}.dropped_before`),
      quality: parseLiquidationQuality(source, path),
    };
  }
  throw new LiquidationPayloadError(`${path}.type`, `unsupported message ${JSON.stringify(type)}`);
}
