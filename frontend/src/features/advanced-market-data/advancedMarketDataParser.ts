import {
  ADVANCED_MARKET_CHANNELS,
  type AdvancedMarketChannel,
  type MarketHistoryExcludedRange,
  type MarketHistoryPayload,
  type MarketHistoryState,
  type MarketSnapshotPayload,
  type MarketSocketMessage,
  type MarketStateRecord,
  type MarketStreamKeyPayload,
} from "./advancedMarketDataTypes.js";

export class AdvancedMarketPayloadError extends TypeError {
  path: string;

  constructor(path: string, message: string) {
    super(`Invalid advanced market payload at ${path}: ${message}`);
    this.name = "AdvancedMarketPayloadError";
    this.path = path;
  }
}

type JsonRecord = Record<string, unknown>;

function expectRecord(value: unknown, path: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AdvancedMarketPayloadError(path, "expected an object");
  }
  return value as JsonRecord;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new AdvancedMarketPayloadError(path, "expected a string");
  }
  return value;
}

function expectNonEmptyString(value: unknown, path: string): string {
  const parsed = expectString(value, path).trim();
  if (!parsed) throw new AdvancedMarketPayloadError(path, "expected a non-empty string");
  return parsed;
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AdvancedMarketPayloadError(path, "expected a finite number");
  }
  return value;
}

function expectNonNegativeInteger(value: unknown, path: string): number {
  const parsed = expectFiniteNumber(value, path);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AdvancedMarketPayloadError(path, "expected a non-negative integer");
  }
  return parsed;
}

function expectNullableInteger(value: unknown, path: string): number | null {
  if (value == null) return null;
  return expectNonNegativeInteger(value, path);
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new AdvancedMarketPayloadError(path, "expected a boolean");
  }
  return value;
}

function expectNullableString(value: unknown, path: string): string | null {
  if (value == null) return null;
  return expectString(value, path);
}

function expectHistoryState(value: unknown, path: string): MarketHistoryState {
  const state = expectNonEmptyString(value, path);
  if (state !== "ready" && state !== "pending" && state !== "exhausted") {
    throw new AdvancedMarketPayloadError(path, "expected ready, pending, or exhausted");
  }
  return state;
}

function parseExcludedRanges(value: unknown, path: string): MarketHistoryExcludedRange[] {
  return expectArray(value, path).map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = expectRecord(item, itemPath);
    const startMs = expectNonNegativeInteger(record.start_ms, `${itemPath}.start_ms`);
    const endMs = expectNonNegativeInteger(record.end_ms, `${itemPath}.end_ms`);
    if (endMs < startMs) {
      throw new AdvancedMarketPayloadError(itemPath, "end_ms must be greater than or equal to start_ms");
    }
    return {
      start_ms: startMs,
      end_ms: endMs,
      ...(record.reason == null
        ? {}
        : { reason: expectNonEmptyString(record.reason, `${itemPath}.reason`) }),
    };
  });
}

function expectChannel(value: unknown, path: string): AdvancedMarketChannel {
  const channel = expectNonEmptyString(value, path).toLowerCase();
  if (!(ADVANCED_MARKET_CHANNELS as readonly string[]).includes(channel)) {
    throw new AdvancedMarketPayloadError(path, `unsupported channel ${JSON.stringify(channel)}`);
  }
  return channel as AdvancedMarketChannel;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new AdvancedMarketPayloadError(path, "expected an array");
  return value;
}

function validateChannelData(
  channel: AdvancedMarketChannel,
  data: JsonRecord,
  path: string,
): void {
  const requiredField = {
    mark_price: "mark_price",
    index_price: "index_price",
    funding_rate: "funding_rate",
    open_interest: "open_interest",
    basis: "basis",
  }[channel];
  expectFiniteNumber(data[requiredField], `${path}.${requiredField}`);

  for (const optionalField of [
    "mark_price",
    "index_price",
    "funding_rate",
    "open_interest",
    "open_interest_value",
    "basis",
    "basis_rate",
    "basis_bps",
    "funding_time_ms",
    "next_funding_time_ms",
  ]) {
    if (optionalField in data && data[optionalField] != null) {
      expectFiniteNumber(data[optionalField], `${path}.${optionalField}`);
    }
  }
  if ("is_final" in data && data.is_final != null) {
    expectBoolean(data.is_final, `${path}.is_final`);
  }
  if ("sample_kind" in data && data.sample_kind != null) {
    expectNonEmptyString(data.sample_kind, `${path}.sample_kind`);
  }
}

export function parseMarketStreamKey(
  value: unknown,
  path = "market.key",
): MarketStreamKeyPayload {
  const record = expectRecord(value, path);
  const params = record.params == null ? {} : expectRecord(record.params, `${path}.params`);
  return {
    exchange: expectNonEmptyString(record.exchange, `${path}.exchange`).toLowerCase(),
    market_type: expectNonEmptyString(record.market_type, `${path}.market_type`).toLowerCase(),
    symbol: expectNonEmptyString(record.symbol, `${path}.symbol`).toUpperCase(),
    channel: expectChannel(record.channel, `${path}.channel`),
    params: { ...params },
  };
}

export function parseMarketStateRecord(
  value: unknown,
  path = "market.record",
  { revisionRequired = true }: { revisionRequired?: boolean } = {},
): MarketStateRecord {
  const record = expectRecord(value, path);
  const key = parseMarketStreamKey(record.key, `${path}.key`);
  const channel = expectChannel(record.channel, `${path}.channel`);
  if (key.channel !== channel) {
    throw new AdvancedMarketPayloadError(`${path}.channel`, "must match key.channel");
  }
  const data = expectRecord(record.data, `${path}.data`);
  validateChannelData(channel, data, `${path}.data`);
  return {
    key,
    topic: expectNonEmptyString(record.topic, `${path}.topic`),
    channel,
    event_time_ms: expectNonNegativeInteger(record.event_time_ms, `${path}.event_time_ms`),
    received_at_ms: expectNonNegativeInteger(record.received_at_ms, `${path}.received_at_ms`),
    source: expectNonEmptyString(record.source, `${path}.source`),
    sequence: expectNullableInteger(record.sequence, `${path}.sequence`),
    revision: revisionRequired
      ? expectNonNegativeInteger(record.revision, `${path}.revision`)
      : (record.revision == null ? 0 : expectNonNegativeInteger(record.revision, `${path}.revision`)),
    data: { ...data },
  };
}

export function parseMarketSnapshotPayload(
  value: unknown,
  path = "market.snapshot",
): MarketSnapshotPayload {
  const record = expectRecord(value, path);
  if (record.type !== "market.snapshot") {
    throw new AdvancedMarketPayloadError(`${path}.type`, "expected market.snapshot");
  }
  return {
    type: "market.snapshot",
    as_of_ms: expectNonNegativeInteger(record.as_of_ms, `${path}.as_of_ms`),
    data: expectArray(record.data, `${path}.data`).map((item, index) => (
      parseMarketStateRecord(item, `${path}.data[${index}]`)
    )),
    missing: expectArray(record.missing, `${path}.missing`).map((item, index) => (
      parseMarketStreamKey(item, `${path}.missing[${index}]`)
    )),
  };
}

export function parseMarketHistoryPayload(
  value: unknown,
  path = "market.history",
): MarketHistoryPayload {
  const record = expectRecord(value, path);
  if (record.type !== "market.history") {
    throw new AdvancedMarketPayloadError(`${path}.type`, "expected market.history");
  }
  const data = expectArray(record.data, `${path}.data`).map((item, index) => (
    parseMarketStateRecord(item, `${path}.data[${index}]`, { revisionRequired: false })
  ));
  const coverage = expectRecord(record.coverage, `${path}.coverage`);
  const result: MarketHistoryPayload = {
    type: "market.history",
    key: parseMarketStreamKey(record.key, `${path}.key`),
    count: expectNonNegativeInteger(record.count, `${path}.count`),
    data,
    coverage: {
      earliest_ms: expectNullableInteger(coverage.earliest_ms, `${path}.coverage.earliest_ms`),
      latest_ms: expectNullableInteger(coverage.latest_ms, `${path}.coverage.latest_ms`),
      complete: expectBoolean(coverage.complete, `${path}.coverage.complete`),
    },
  };
  if (result.count !== data.length) {
    throw new AdvancedMarketPayloadError(`${path}.count`, "must equal data.length");
  }
  if ("fallback" in record) {
    result.fallback = expectBoolean(record.fallback, `${path}.fallback`);
  }
  if ("has_more" in record) result.has_more = expectBoolean(record.has_more, `${path}.has_more`);
  if ("next_start_ms" in record) {
    result.next_start_ms = expectNullableInteger(record.next_start_ms, `${path}.next_start_ms`);
  }
  if ("next_end_ms" in record) {
    result.next_end_ms = expectNullableInteger(record.next_end_ms, `${path}.next_end_ms`);
  }
  if ("history_state" in record) {
    result.history_state = expectHistoryState(record.history_state, `${path}.history_state`);
  }
  if ("complete" in record) result.complete = expectBoolean(record.complete, `${path}.complete`);
  if ("retryable" in record) result.retryable = expectBoolean(record.retryable, `${path}.retryable`);
  if ("terminal_reason" in record) {
    result.terminal_reason = expectNullableString(record.terminal_reason, `${path}.terminal_reason`);
  }
  if ("earliest_available_ms" in record) {
    result.earliest_available_ms = expectNullableInteger(
      record.earliest_available_ms,
      `${path}.earliest_available_ms`,
    );
  }
  if ("next_before_ms" in record) {
    result.next_before_ms = expectNullableInteger(record.next_before_ms, `${path}.next_before_ms`);
  }
  if ("availability_revision" in record) {
    result.availability_revision = expectNullableString(
      record.availability_revision,
      `${path}.availability_revision`,
    );
  }
  if ("excluded_ranges" in record) {
    result.excluded_ranges = parseExcludedRanges(record.excluded_ranges, `${path}.excluded_ranges`);
  }
  return result;
}

export function parseMarketSocketMessage(
  value: unknown,
  path = "market.websocket",
): MarketSocketMessage {
  const record = expectRecord(value, path);
  const type = expectNonEmptyString(record.type, `${path}.type`);
  if (type === "connected") {
    return {
      type,
      ...(typeof record.protocol === "string" ? { protocol: record.protocol } : {}),
      ...(typeof record.max_subscriptions === "number"
        ? { max_subscriptions: expectNonNegativeInteger(record.max_subscriptions, `${path}.max_subscriptions`) }
        : {}),
    };
  }
  if (type === "subscribed" || type === "unsubscribed") {
    return {
      type,
      ...(typeof record.request_id === "string" ? { request_id: record.request_id } : {}),
      streams: expectArray(record.streams, `${path}.streams`).map((item, index) => (
        parseMarketStreamKey(item, `${path}.streams[${index}]`)
      )),
    };
  }
  if (type === "snapshot") {
    return {
      type,
      ...(typeof record.request_id === "string" ? { request_id: record.request_id } : {}),
      data: expectArray(record.data, `${path}.data`).map((item, index) => (
        parseMarketStateRecord(item, `${path}.data[${index}]`)
      )),
      missing: expectArray(record.missing, `${path}.missing`).map((item, index) => (
        parseMarketStreamKey(item, `${path}.missing[${index}]`)
      )),
    };
  }
  if (type === "update") {
    return {
      type,
      ...(typeof record.protocol === "string" ? { protocol: record.protocol } : {}),
      data: expectArray(record.data, `${path}.data`).map((item, index) => (
        parseMarketStateRecord(item, `${path}.data[${index}]`)
      )),
    };
  }
  if (type === "error") {
    return {
      type,
      ...(typeof record.request_id === "string" ? { request_id: record.request_id } : {}),
      ...(typeof record.code === "string" ? { code: record.code } : {}),
      ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
    };
  }
  throw new AdvancedMarketPayloadError(`${path}.type`, `unsupported message type ${JSON.stringify(type)}`);
}
