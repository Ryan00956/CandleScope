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
  realtime_transports?: string[];
  history_transports?: string[];
  delivery?: string;
  snapshot?: boolean;
  delta?: boolean;
  sequence?: string;
  resync?: string;
  update_intervals_ms?: number[];
  available_fields?: string[];
  unavailable_fields?: string[];
  known_limitations?: string[];
}

export type ExchangeProviderKind = "ccxt_primary" | "ccxt_unified" | "plugin";
export type ExchangeVerificationLevel = "catalog_only" | "capability_contract" | "shadow" | "soak";
export type ExchangeQualificationLevel = "shadow" | "soak";

export interface ExchangeQualificationPayload extends JsonRecord {
  ccxt_version: string;
  level: ExchangeQualificationLevel;
  verified_at: string;
  market_types: string[];
  channels: string[];
  evidence_id: string;
  duration_seconds?: number | null;
  event_count?: number | null;
}

export interface ExchangeOrderBookProductPayload extends JsonRecord {
  supported: boolean;
  channel: string | null;
  mode: string | null;
  snapshot_mode: "live_snapshot" | "polling_snapshot" | null;
  strict_full_depth: boolean;
}

export interface ExchangeTradeFlowProductPayload extends JsonRecord {
  supported: boolean;
  channel: "agg_trade" | "trade" | null;
  mode: "strict_repairable" | "observational" | null;
  sequence_continuity: boolean;
  history: boolean;
  delivery_mode: "live_stream" | "polling_observational" | null;
}

export type ExchangeAdvancedDeliveryMode =
  | "live_snapshot"
  | "polling_snapshot"
  | "history_only"
  | "live_observational"
  | "polling_observational"
  | "derived_live"
  | "derived_polling";

export interface ExchangeAdvancedChannelProductPayload extends JsonRecord {
  supported: boolean;
  realtime: boolean;
  history: boolean;
  delivery_mode: ExchangeAdvancedDeliveryMode | null;
}

export interface ExchangeAdvancedMarketProductPayload extends JsonRecord {
  supported: boolean;
  channels: Record<string, ExchangeAdvancedChannelProductPayload>;
}

export interface ExchangeMarketProductPayload extends JsonRecord {
  chart: boolean;
  order_book: ExchangeOrderBookProductPayload;
  trade_flow: ExchangeTradeFlowProductPayload;
  advanced_market_data: ExchangeAdvancedMarketProductPayload;
}

export interface ExchangeProductsPayload extends JsonRecord {
  markets: Record<string, ExchangeMarketProductPayload>;
}

export interface ExchangeSupportPayload extends JsonRecord {
  provider: ExchangeProviderKind;
  routable: boolean;
  verification_level: ExchangeVerificationLevel;
  qualification: ExchangeQualificationPayload | null;
  qualifications: ExchangeQualificationPayload[];
  products: ExchangeProductsPayload;
}

export interface CcxtCatalogSummaryPayload extends JsonRecord {
  version: string;
  rest_exchange_ids: number;
  pro_exchange_ids: number;
  watch_ohlcv: number;
  watch_trades: number;
  watch_order_book: number;
  watch_ticker: number;
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
  support?: ExchangeSupportPayload;
}

export interface ExchangeListPayload extends JsonRecord {
  exchanges: ExchangeCapabilityPayload[];
  count?: number;
  ccxt?: CcxtCatalogSummaryPayload;
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
    "reached_latest_closed_bar",
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
  const result: ExchangeChannelCapabilityPayload = {
    ...record,
    channel: expectNonEmptyString(record.channel, `${path}.channel`),
    market_types: expectStringArray(record.market_types, `${path}.market_types`),
    realtime: expectBoolean(record.realtime, `${path}.realtime`),
    history: expectBoolean(record.history, `${path}.history`),
    params: expectRecord(record.params, `${path}.params`),
  };
  for (const key of [
    "realtime_transports",
    "history_transports",
    "available_fields",
    "unavailable_fields",
    "known_limitations",
  ] as const) {
    if (key in record) result[key] = expectStringArray(record[key], `${path}.${key}`);
  }
  for (const key of ["delivery", "sequence", "resync"] as const) {
    if (key in record) result[key] = expectString(record[key], `${path}.${key}`);
  }
  for (const key of ["snapshot", "delta"] as const) {
    if (key in record) result[key] = expectBoolean(record[key], `${path}.${key}`);
  }
  if ("update_intervals_ms" in record) {
    if (!Array.isArray(record.update_intervals_ms)) {
      throw new ApiPayloadError(`${path}.update_intervals_ms`, "expected an array");
    }
    result.update_intervals_ms = record.update_intervals_ms.map((item, index) => (
      expectNonNegativeInteger(item, `${path}.update_intervals_ms[${index}]`)
    ));
  }
  return result;
}

function parseExchangeQualification(
  value: unknown,
  path: string,
): ExchangeQualificationPayload {
  const record = expectRecord(value, path);
  const level = expectNonEmptyString(record.level, `${path}.level`);
  if (level !== "shadow" && level !== "soak") {
    throw new ApiPayloadError(`${path}.level`, "expected shadow or soak");
  }
  const result: ExchangeQualificationPayload = {
    ...record,
    ccxt_version: expectNonEmptyString(record.ccxt_version, `${path}.ccxt_version`),
    level,
    verified_at: expectNonEmptyString(record.verified_at, `${path}.verified_at`),
    market_types: expectStringArray(record.market_types, `${path}.market_types`),
    channels: expectStringArray(record.channels, `${path}.channels`),
    evidence_id: expectNonEmptyString(record.evidence_id, `${path}.evidence_id`),
  };
  if ("duration_seconds" in record) {
    result.duration_seconds = record.duration_seconds == null
      ? null
      : expectNonNegativeInteger(record.duration_seconds, `${path}.duration_seconds`);
  }
  if ("event_count" in record) {
    result.event_count = record.event_count == null
      ? null
      : expectNonNegativeInteger(record.event_count, `${path}.event_count`);
  }
  return result;
}

function nullableString(value: unknown, path: string): string | null {
  return value == null ? null : expectNonEmptyString(value, path);
}

function parseExchangeProducts(value: unknown, path: string): ExchangeProductsPayload {
  const record = expectRecord(value, path);
  const rawMarkets = expectRecord(record.markets, `${path}.markets`);
  const markets: Record<string, ExchangeMarketProductPayload> = {};
  for (const [marketType, rawMarket] of Object.entries(rawMarkets)) {
    const marketPath = `${path}.markets.${marketType}`;
    const market = expectRecord(rawMarket, marketPath);
    const orderBook = expectRecord(market.order_book, `${marketPath}.order_book`);
    const tradeFlow = expectRecord(market.trade_flow, `${marketPath}.trade_flow`);
    const tradeChannel = nullableString(tradeFlow.channel, `${marketPath}.trade_flow.channel`);
    if (tradeChannel !== null && tradeChannel !== "agg_trade" && tradeChannel !== "trade") {
      throw new ApiPayloadError(`${marketPath}.trade_flow.channel`, "unsupported trade channel");
    }
    const tradeMode = nullableString(tradeFlow.mode, `${marketPath}.trade_flow.mode`);
    if (tradeMode !== null && tradeMode !== "strict_repairable" && tradeMode !== "observational") {
      throw new ApiPayloadError(`${marketPath}.trade_flow.mode`, "unsupported trade mode");
    }
    const snapshotMode = nullableString(
      orderBook.snapshot_mode,
      `${marketPath}.order_book.snapshot_mode`,
    );
    if (snapshotMode !== null && snapshotMode !== "live_snapshot" && snapshotMode !== "polling_snapshot") {
      throw new ApiPayloadError(
        `${marketPath}.order_book.snapshot_mode`,
        "unsupported order-book snapshot mode",
      );
    }
    const tradeDeliveryMode = nullableString(
      tradeFlow.delivery_mode,
      `${marketPath}.trade_flow.delivery_mode`,
    );
    if (tradeDeliveryMode !== null
      && tradeDeliveryMode !== "live_stream"
      && tradeDeliveryMode !== "polling_observational") {
      throw new ApiPayloadError(
        `${marketPath}.trade_flow.delivery_mode`,
        "unsupported trade-flow delivery mode",
      );
    }
    const advanced = "advanced_market_data" in market
      ? expectRecord(market.advanced_market_data, `${marketPath}.advanced_market_data`)
      : { supported: false, channels: {} };
    const rawAdvancedChannels = expectRecord(
      advanced.channels,
      `${marketPath}.advanced_market_data.channels`,
    );
    const advancedChannels: Record<string, ExchangeAdvancedChannelProductPayload> = {};
    const advancedModes = new Set<string>([
      "live_snapshot",
      "polling_snapshot",
      "history_only",
      "live_observational",
      "polling_observational",
      "derived_live",
      "derived_polling",
    ]);
    for (const [channel, rawChannel] of Object.entries(rawAdvancedChannels)) {
      const channelPath = `${marketPath}.advanced_market_data.channels.${channel}`;
      const advancedChannel = expectRecord(rawChannel, channelPath);
      const deliveryMode = nullableString(
        advancedChannel.delivery_mode,
        `${channelPath}.delivery_mode`,
      );
      if (deliveryMode !== null && !advancedModes.has(deliveryMode)) {
        throw new ApiPayloadError(`${channelPath}.delivery_mode`, "unsupported delivery mode");
      }
      advancedChannels[channel.toLowerCase()] = {
        ...advancedChannel,
        supported: expectBoolean(advancedChannel.supported, `${channelPath}.supported`),
        realtime: expectBoolean(advancedChannel.realtime, `${channelPath}.realtime`),
        history: expectBoolean(advancedChannel.history, `${channelPath}.history`),
        delivery_mode: deliveryMode as ExchangeAdvancedDeliveryMode | null,
      };
    }
    markets[marketType.toLowerCase()] = {
      ...market,
      chart: expectBoolean(market.chart, `${marketPath}.chart`),
      order_book: {
        ...orderBook,
        supported: expectBoolean(orderBook.supported, `${marketPath}.order_book.supported`),
        channel: nullableString(orderBook.channel, `${marketPath}.order_book.channel`),
        mode: nullableString(orderBook.mode, `${marketPath}.order_book.mode`),
        snapshot_mode: snapshotMode,
        strict_full_depth: expectBoolean(
          orderBook.strict_full_depth,
          `${marketPath}.order_book.strict_full_depth`,
        ),
      },
      trade_flow: {
        ...tradeFlow,
        supported: expectBoolean(tradeFlow.supported, `${marketPath}.trade_flow.supported`),
        channel: tradeChannel,
        mode: tradeMode,
        sequence_continuity: expectBoolean(
          tradeFlow.sequence_continuity,
          `${marketPath}.trade_flow.sequence_continuity`,
        ),
        history: expectBoolean(tradeFlow.history, `${marketPath}.trade_flow.history`),
        delivery_mode: tradeDeliveryMode as ExchangeTradeFlowProductPayload["delivery_mode"],
      },
      advanced_market_data: {
        ...advanced,
        supported: expectBoolean(
          advanced.supported,
          `${marketPath}.advanced_market_data.supported`,
        ),
        channels: advancedChannels,
      },
    };
  }
  return { ...record, markets };
}

function parseExchangeSupport(value: unknown, path: string): ExchangeSupportPayload {
  const record = expectRecord(value, path);
  const provider = expectNonEmptyString(record.provider, `${path}.provider`);
  if (!(["ccxt_primary", "ccxt_unified", "plugin"] as const).includes(
    provider as ExchangeProviderKind,
  )) {
    throw new ApiPayloadError(`${path}.provider`, "unsupported provider kind");
  }
  const verificationLevel = expectNonEmptyString(
    record.verification_level,
    `${path}.verification_level`,
  );
  if (!(["catalog_only", "capability_contract", "shadow", "soak"] as const).includes(
    verificationLevel as ExchangeVerificationLevel,
  )) {
    throw new ApiPayloadError(`${path}.verification_level`, "unsupported verification level");
  }
  const qualification = record.qualification == null
    ? null
    : parseExchangeQualification(record.qualification, `${path}.qualification`);
  let qualifications: ExchangeQualificationPayload[];
  if ("qualifications" in record) {
    if (!Array.isArray(record.qualifications)) {
      throw new ApiPayloadError(`${path}.qualifications`, "expected an array");
    }
    qualifications = record.qualifications.map((item, index) => (
      parseExchangeQualification(item, `${path}.qualifications[${index}]`)
    ));
  } else {
    qualifications = qualification ? [qualification] : [];
  }
  return {
    ...record,
    provider: provider as ExchangeProviderKind,
    routable: expectBoolean(record.routable, `${path}.routable`),
    verification_level: verificationLevel as ExchangeVerificationLevel,
    qualification,
    qualifications,
    products: "products" in record
      ? parseExchangeProducts(record.products, `${path}.products`)
      : { markets: {} },
  };
}

function parseCcxtCatalogSummary(value: unknown, path: string): CcxtCatalogSummaryPayload {
  const record = expectRecord(value, path);
  const result: CcxtCatalogSummaryPayload = {
    ...record,
    version: expectNonEmptyString(record.version, `${path}.version`),
    rest_exchange_ids: expectNonNegativeInteger(record.rest_exchange_ids, `${path}.rest_exchange_ids`),
    pro_exchange_ids: expectNonNegativeInteger(record.pro_exchange_ids, `${path}.pro_exchange_ids`),
    watch_ohlcv: expectNonNegativeInteger(record.watch_ohlcv, `${path}.watch_ohlcv`),
    watch_trades: expectNonNegativeInteger(record.watch_trades, `${path}.watch_trades`),
    watch_order_book: expectNonNegativeInteger(record.watch_order_book, `${path}.watch_order_book`),
    watch_ticker: expectNonNegativeInteger(record.watch_ticker, `${path}.watch_ticker`),
  };
  for (const key of [
    "watch_mark_price",
    "watch_funding_rate",
    "watch_liquidations",
    "fetch_funding_rate_history",
    "fetch_open_interest",
    "fetch_open_interest_history",
  ]) {
    if (key in record) result[key] = expectNonNegativeInteger(record[key], `${path}.${key}`);
  }
  return result;
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
  if ("support" in record) {
    result.support = parseExchangeSupport(record.support, `${path}.support`);
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
  if ("ccxt" in record) result.ccxt = parseCcxtCatalogSummary(record.ccxt, `${path}.ccxt`);
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
