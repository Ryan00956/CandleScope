const MAX_EPOCH_SECONDS = 10_000_000_000;

export type JsonRecord = Record<string, unknown>;

export class ApiPayloadError extends TypeError {
  path: string;

  constructor(path: string, message: string) {
    super(`Invalid API payload at ${path}: ${message}`);
    this.name = "ApiPayloadError";
    this.path = path;
  }
}

export interface TransportKlineBar extends JsonRecord {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  is_closed?: boolean;
  quote_volume?: number | null;
  trades?: number | null;
  taker_buy_base?: number | null;
  taker_buy_quote?: number | null;
  order_flow?: TransportKlineOrderFlow | null;
}

export interface TransportKlineOrderFlow extends JsonRecord {
  taker_sell_base: number;
  volume_delta_base: number;
  taker_buy_ratio_base: number | null;
  cvd_contribution_base: number;
}

export interface TransportKlineResponse extends JsonRecord {
  data: TransportKlineBar[];
  all_rows_final?: boolean;
  has_more?: boolean;
  truncated?: boolean;
  next_end_ms?: number | null;
  retry_at_ms?: number | null;
}

export interface ExchangeMarketPayload extends JsonRecord {
  market_type: string;
  product_type: string;
  label: string;
  contract_family?: string | null;
}

export interface ExchangeChannelCapabilityPayload extends JsonRecord {
  channel: string;
  market_types: string[];
  realtime: boolean;
  history: boolean;
  params: JsonRecord;
}

export interface ExchangeCapabilityPayload extends JsonRecord {
  exchange: string;
  name: string;
  markets: ExchangeMarketPayload[];
  native_intervals: string[];
  capability_schema_version?: number;
  channels?: ExchangeChannelCapabilityPayload[];
  protocol_features: string[];
  limits: JsonRecord;
  known_limitations: string[];
}

export interface ExchangeListPayload extends JsonRecord {
  exchanges: ExchangeCapabilityPayload[];
  count?: number;
}

export type SubscriptionTierPayload = "full" | "price" | "none";

export interface SubscriptionPayload extends JsonRecord {
  symbol: string;
  tier: SubscriptionTierPayload;
  intervals?: string[];
  added_at?: number;
  changed?: boolean;
  warning?: string;
}

export interface SubscriptionListPayload extends JsonRecord {
  subscriptions: SubscriptionPayload[];
}

export interface SubscriptionSyncPayload extends JsonRecord {
  synced: number;
  auto_registered: number;
}

export interface SubscriptionRemovalPayload extends JsonRecord {
  symbol: string;
  removed: boolean;
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, path: string): JsonRecord {
  if (!isJsonRecord(value)) {
    throw new ApiPayloadError(path, "expected an object");
  }
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ApiPayloadError(path, "expected a string");
  }
  return value;
}

function expectNonEmptyString(value: unknown, path: string): string {
  const parsed = expectString(value, path);
  if (!parsed.trim()) throw new ApiPayloadError(path, "expected a non-empty string");
  return parsed;
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiPayloadError(path, "expected a finite number");
  }
  return value;
}

function expectNonNegativeInteger(value: unknown, path: string): number {
  const parsed = expectFiniteNumber(value, path);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ApiPayloadError(path, "expected a non-negative integer");
  }
  return parsed;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ApiPayloadError(path, "expected a boolean");
  }
  return value;
}

function expectStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new ApiPayloadError(path, "expected an array");
  return value.map((item, index) => expectString(item, `${path}[${index}]`));
}

function optionalString(record: JsonRecord, key: string, path: string): void {
  if (key in record && record[key] != null) expectString(record[key], `${path}.${key}`);
}

function optionalBoolean(record: JsonRecord, key: string, path: string): void {
  if (key in record && record[key] != null) expectBoolean(record[key], `${path}.${key}`);
}

function optionalFiniteNumber(record: JsonRecord, key: string, path: string): void {
  if (key in record && record[key] != null) expectFiniteNumber(record[key], `${path}.${key}`);
}

function expectNonNegativeNumber(value: unknown, path: string): number {
  const parsed = expectFiniteNumber(value, path);
  if (parsed < 0) throw new ApiPayloadError(path, "expected a non-negative number");
  return parsed;
}

function nullableNonNegativeNumber(
  record: JsonRecord,
  key: string,
  path: string,
): number | null | undefined {
  if (!(key in record)) return undefined;
  if (record[key] == null) return null;
  return expectNonNegativeNumber(record[key], `${path}.${key}`);
}

function parseKlineOrderFlow(value: unknown, path: string): TransportKlineOrderFlow | null {
  if (value == null) return null;
  const record = expectRecord(value, path);
  const ratio = record.taker_buy_ratio_base == null
    ? null
    : expectFiniteNumber(record.taker_buy_ratio_base, `${path}.taker_buy_ratio_base`);
  if (ratio !== null && (ratio < 0 || ratio > 1)) {
    throw new ApiPayloadError(`${path}.taker_buy_ratio_base`, "expected a ratio between 0 and 1");
  }
  return {
    ...record,
    taker_sell_base: expectNonNegativeNumber(record.taker_sell_base, `${path}.taker_sell_base`),
    volume_delta_base: expectFiniteNumber(record.volume_delta_base, `${path}.volume_delta_base`),
    taker_buy_ratio_base: ratio,
    cvd_contribution_base: expectFiniteNumber(
      record.cvd_contribution_base,
      `${path}.cvd_contribution_base`,
    ),
  };
}

export function parseKlineBar(value: unknown, path = "kline"): TransportKlineBar {
  const record = expectRecord(value, path);
  const time = expectNonNegativeInteger(record.time, `${path}.time`);
  if (time > MAX_EPOCH_SECONDS) {
    throw new ApiPayloadError(`${path}.time`, "expected unix seconds, received a millisecond-scale value");
  }

  const bar: TransportKlineBar = {
    ...record,
    time,
    open: expectFiniteNumber(record.open, `${path}.open`),
    high: expectFiniteNumber(record.high, `${path}.high`),
    low: expectFiniteNumber(record.low, `${path}.low`),
    close: expectFiniteNumber(record.close, `${path}.close`),
    volume: expectFiniteNumber(record.volume, `${path}.volume`),
  };
  if ("is_closed" in record) {
    bar.is_closed = expectBoolean(record.is_closed, `${path}.is_closed`);
  }
  const quoteVolume = nullableNonNegativeNumber(record, "quote_volume", path);
  if (quoteVolume !== undefined) bar.quote_volume = quoteVolume;
  if ("trades" in record) {
    bar.trades = record.trades == null
      ? null
      : expectNonNegativeInteger(record.trades, `${path}.trades`);
  }
  const takerBuyBase = nullableNonNegativeNumber(record, "taker_buy_base", path);
  if (takerBuyBase !== undefined) bar.taker_buy_base = takerBuyBase;
  const takerBuyQuote = nullableNonNegativeNumber(record, "taker_buy_quote", path);
  if (takerBuyQuote !== undefined) bar.taker_buy_quote = takerBuyQuote;
  if ("order_flow" in record) {
    bar.order_flow = parseKlineOrderFlow(record.order_flow, `${path}.order_flow`);
  }
  return bar;
}

export function parseKlineResponse(
  value: unknown,
  path = "response",
): TransportKlineResponse {
  const record = expectRecord(value, path);
  if (!Array.isArray(record.data)) {
    throw new ApiPayloadError(`${path}.data`, "expected an array");
  }

  const result: TransportKlineResponse = {
    ...record,
    data: record.data.map((item, index) => parseKlineBar(item, `${path}.data[${index}]`)),
  };

  for (const key of [
    "has_more",
    "truncated",
    "has_tail_gap",
    "backfill_triggered",
    "verified_contiguous",
    "all_rows_final",
    "renderable",
  ]) {
    optionalBoolean(record, key, path);
  }
  for (const key of [
    "count",
    "fetched",
    "start_ms",
    "end_ms",
    "effective_end_ms",
    "query_start_ms",
    "query_end_ms",
    "before",
    "bars",
    "retry_at_ms",
  ]) {
    optionalFiniteNumber(record, key, path);
  }
  for (const key of ["exchange", "market_type", "symbol", "interval", "source", "base_interval"]) {
    optionalString(record, key, path);
  }
  if ("next_end_ms" in record && record.next_end_ms != null) {
    result.next_end_ms = expectNonNegativeInteger(record.next_end_ms, `${path}.next_end_ms`);
  }
  if ("has_more" in record) result.has_more = expectBoolean(record.has_more, `${path}.has_more`);
  if ("truncated" in record) result.truncated = expectBoolean(record.truncated, `${path}.truncated`);
  if ("missing_ranges" in record && !Array.isArray(record.missing_ranges)) {
    throw new ApiPayloadError(`${path}.missing_ranges`, "expected an array");
  }
  if ("cache" in record && record.cache != null) expectRecord(record.cache, `${path}.cache`);
  return result;
}

function parseExchangeMarket(value: unknown, path: string): ExchangeMarketPayload {
  const record = expectRecord(value, path);
  const result: ExchangeMarketPayload = {
    ...record,
    market_type: expectNonEmptyString(record.market_type, `${path}.market_type`),
    product_type: expectNonEmptyString(record.product_type, `${path}.product_type`),
    label: expectNonEmptyString(record.label, `${path}.label`),
  };
  if ("contract_family" in record) {
    result.contract_family = record.contract_family == null
      ? null
      : expectString(record.contract_family, `${path}.contract_family`);
  }
  return result;
}

function parseExchangeChannelCapability(
  value: unknown,
  path: string,
): ExchangeChannelCapabilityPayload {
  const record = expectRecord(value, path);
  return {
    ...record,
    channel: expectNonEmptyString(record.channel, `${path}.channel`),
    market_types: expectStringArray(record.market_types, `${path}.market_types`),
    realtime: expectBoolean(record.realtime, `${path}.realtime`),
    history: expectBoolean(record.history, `${path}.history`),
    params: expectRecord(record.params, `${path}.params`),
  };
}

export function parseExchangeCapability(
  value: unknown,
  path = "response",
): ExchangeCapabilityPayload {
  const record = expectRecord(value, path);
  if (!Array.isArray(record.markets)) throw new ApiPayloadError(`${path}.markets`, "expected an array");
  if ("channels" in record && !Array.isArray(record.channels)) {
    throw new ApiPayloadError(`${path}.channels`, "expected an array");
  }
  const result: ExchangeCapabilityPayload = {
    ...record,
    exchange: expectNonEmptyString(record.exchange, `${path}.exchange`),
    name: expectNonEmptyString(record.name, `${path}.name`),
    markets: record.markets.map((item, index) => parseExchangeMarket(item, `${path}.markets[${index}]`)),
    native_intervals: expectStringArray(record.native_intervals, `${path}.native_intervals`),
    protocol_features: expectStringArray(record.protocol_features, `${path}.protocol_features`),
    limits: expectRecord(record.limits, `${path}.limits`),
    known_limitations: expectStringArray(record.known_limitations, `${path}.known_limitations`),
  };
  if ("capability_schema_version" in record) {
    const schemaVersion = expectNonNegativeInteger(
      record.capability_schema_version,
      `${path}.capability_schema_version`,
    );
    if (schemaVersion < 1) {
      throw new ApiPayloadError(`${path}.capability_schema_version`, "expected an integer of at least 1");
    }
    result.capability_schema_version = schemaVersion;
  }
  if (Array.isArray(record.channels)) {
    result.channels = record.channels.map((item, index) => (
      parseExchangeChannelCapability(item, `${path}.channels[${index}]`)
    ));
  }
  return result;
}

export function parseExchangeListResponse(
  value: unknown,
  path = "response",
): ExchangeListPayload {
  const record = expectRecord(value, path);
  if (!Array.isArray(record.exchanges)) {
    throw new ApiPayloadError(`${path}.exchanges`, "expected an array");
  }
  const result: ExchangeListPayload = {
    ...record,
    exchanges: record.exchanges.map((item, index) => (
      parseExchangeCapability(item, `${path}.exchanges[${index}]`)
    )),
  };
  if ("count" in record) result.count = expectNonNegativeInteger(record.count, `${path}.count`);
  return result;
}

export function parseSubscription(
  value: unknown,
  path = "response",
): SubscriptionPayload {
  const record = expectRecord(value, path);
  const tier = expectString(record.tier, `${path}.tier`);
  if (tier !== "full" && tier !== "price" && tier !== "none") {
    throw new ApiPayloadError(`${path}.tier`, `unsupported tier ${JSON.stringify(tier)}`);
  }
  const result: SubscriptionPayload = {
    ...record,
    symbol: expectNonEmptyString(record.symbol, `${path}.symbol`),
    tier,
  };
  if ("intervals" in record) result.intervals = expectStringArray(record.intervals, `${path}.intervals`);
  if ("added_at" in record) result.added_at = expectNonNegativeInteger(record.added_at, `${path}.added_at`);
  if ("changed" in record) result.changed = expectBoolean(record.changed, `${path}.changed`);
  if ("warning" in record) result.warning = expectString(record.warning, `${path}.warning`);
  return result;
}

export function parseSubscriptionListResponse(
  value: unknown,
  path = "response",
): SubscriptionListPayload {
  const record = expectRecord(value, path);
  if (!Array.isArray(record.subscriptions)) {
    throw new ApiPayloadError(`${path}.subscriptions`, "expected an array");
  }
  return {
    ...record,
    subscriptions: record.subscriptions.map((item, index) => (
      parseSubscription(item, `${path}.subscriptions[${index}]`)
    )),
  };
}

export function parseSubscriptionSyncResponse(
  value: unknown,
  path = "response",
): SubscriptionSyncPayload {
  const record = expectRecord(value, path);
  return {
    ...record,
    synced: expectNonNegativeInteger(record.synced, `${path}.synced`),
    auto_registered: expectNonNegativeInteger(record.auto_registered, `${path}.auto_registered`),
  };
}

export function parseSubscriptionRemovalResponse(
  value: unknown,
  path = "response",
): SubscriptionRemovalPayload {
  const record = expectRecord(value, path);
  return {
    ...record,
    symbol: expectNonEmptyString(record.symbol, `${path}.symbol`),
    removed: expectBoolean(record.removed, `${path}.removed`),
  };
}
