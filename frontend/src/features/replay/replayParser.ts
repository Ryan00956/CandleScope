import {
  REPLAY_COMMAND_TYPES,
  REPLAY_DATA_FIDELITIES,
  REPLAY_ERROR_CODES,
  REPLAY_EVENT_TYPES,
  REPLAY_EXECUTION_FIDELITIES,
  REPLAY_EXECUTION_MODELS,
  REPLAY_PROTOCOL,
  REPLAY_QUALITY_MODES,
  REPLAY_SESSION_STATES,
  REPLAY_SOURCE_KINDS,
} from "./replayTypes.js";
import type {
  ReplayAccount,
  ReplayAnyBarBuilderSnapshot,
  ReplayBarBuilderSnapshot,
  ReplayBarProjectionUpdate,
  ReplayBarReplaceProjection,
  ReplayBarUpdate,
  ReplayBrokerSnapshot,
  ReplayBrokerReport,
  ReplayCapabilities,
  ReplayCatalog,
  ReplayCatalogEntry,
  ReplayCommandResult,
  ReplayCommandType,
  ReplayClosedTrade,
  ReplayCursor,
  ReplayDecimalString,
  ReplayDigest,
  ReplayDisplayBar,
  ReplayErrorCode,
  ReplayErrorEnvelope,
  ReplayFill,
  ReplayJournalEntry,
  ReplayJson,
  ReplayOrder,
  ReplayParsedEvent,
  ReplayPosition,
  ReplayProjection,
  ReplaySequence,
  ReplaySessionConfig,
  ReplaySessionResponse,
  ReplaySessionSnapshot,
  ReplaySourceBar,
  ReplaySourceEvent,
  ReplaySourceTrade,
  ReplaySpeed,
  ReplayTradeBarBuilderSnapshot,
  ReplayTradeFormingBar,
  ReplayWarning,
} from "./replayTypes.js";

const MAX_TIMESTAMP_MS = 253_402_300_799_999;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const SPEEDS = [1, 5, 15, 30, 60, 120, 300, 600, "MAX"] as const;

type UnknownRecord = Record<string, unknown>;

export class ReplayPayloadParseError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ReplayPayloadParseError";
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new ReplayPayloadParseError(path, message);
}

function record(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(path, "expected object");
  }
  return value as UnknownRecord;
}

function exact(value: UnknownRecord, keys: readonly string[], path: string): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  const unknown = actual.filter((key) => !expected.has(key));
  if (missing.length) fail(path, `missing field(s): ${missing.join(", ")}`);
  if (unknown.length) fail(path, `unknown field(s): ${unknown.join(", ")}`);
}

function string(value: unknown, path: string, { nonEmpty = true }: { nonEmpty?: boolean } = {}): string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0)) {
    return fail(path, nonEmpty ? "expected non-empty string" : "expected string");
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path);
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return fail(path, "expected boolean");
  return value;
}

function integer(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    return fail(path, `expected safe integer in [${min}, ${max}]`);
  }
  return value as number;
}

function timestamp(value: unknown, path: string): number {
  return integer(value, path, 0, MAX_TIMESTAMP_MS);
}

function nullableTimestamp(value: unknown, path: string): number | null {
  return value === null ? null : timestamp(value, path);
}

function identifier(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!IDENTIFIER.test(parsed)) return fail(path, "expected safe 1-128 character identifier");
  return parsed;
}

function digest(value: unknown, path: string): ReplayDigest {
  const parsed = string(value, path);
  if (!DIGEST.test(parsed)) return fail(path, "expected sha256 digest");
  return parsed as ReplayDigest;
}

function canonicalDecimal(value: string): string {
  const negative = value.startsWith("-");
  const unsigned = value.replace(/^[+-]/, "");
  const [rawInteger = "", rawFraction = ""] = unsigned.split(".");
  const normalizedInteger = rawInteger.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = rawFraction.replace(/0+$/, "");
  const magnitude = normalizedFraction
    ? `${normalizedInteger}.${normalizedFraction}`
    : normalizedInteger;
  const zero = /^0(?:\.0*)?$/.test(magnitude);
  return negative && !zero ? `-${magnitude}` : magnitude;
}

export function parseReplayDecimal(value: unknown, path = "$"): ReplayDecimalString {
  const parsed = string(value, path);
  if (!DECIMAL.test(parsed)) return fail(path, "expected finite plain Decimal string");
  if (canonicalDecimal(parsed) !== parsed) return fail(path, "expected canonical Decimal string");
  return parsed;
}

function nullableDecimal(value: unknown, path: string): ReplayDecimalString | null {
  return value === null ? null : parseReplayDecimal(value, path);
}

function enumeration<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const parsed = string(value, path);
  if (!allowed.includes(parsed as T)) return fail(path, `unsupported value ${parsed}`);
  return parsed as T;
}

function array<T>(value: unknown, path: string, parse: (item: unknown, itemPath: string) => T): T[] {
  if (!Array.isArray(value)) return fail(path, "expected array");
  return value.map((item, index) => parse(item, `${path}[${index}]`));
}

function jsonValue(value: unknown, path: string): ReplayJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return integer(value, path, Number.MIN_SAFE_INTEGER);
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${path}[${index}]`));
  const source = record(value, path);
  const parsed: Record<string, ReplayJson> = {};
  for (const [key, child] of Object.entries(source)) parsed[key] = jsonValue(child, `${path}.${key}`);
  return parsed;
}

function jsonRecord(value: unknown, path: string): Readonly<Record<string, ReplayJson>> {
  const parsed = jsonValue(value, path);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    return fail(path, "expected JSON object");
  }
  return parsed as Readonly<Record<string, ReplayJson>>;
}

function stringList(value: unknown, path: string): string[] {
  return array(value, path, (item, itemPath) => string(item, itemPath));
}

function parseSpeed(value: unknown, path: string): ReplaySpeed {
  if (!SPEEDS.includes(value as ReplaySpeed)) return fail(path, "unsupported replay speed");
  return value as ReplaySpeed;
}

function parseCursor(value: unknown, path: string): ReplayCursor {
  const source = record(value, path);
  exact(source, [
    "virtual_time_ms", "source_sequence", "last_base_bar_open_ms",
    "last_trade_time_ms", "last_agg_trade_id", "at_end",
  ], path);
  return {
    virtual_time_ms: timestamp(source.virtual_time_ms, `${path}.virtual_time_ms`),
    source_sequence: integer(source.source_sequence, `${path}.source_sequence`),
    last_base_bar_open_ms: nullableTimestamp(source.last_base_bar_open_ms, `${path}.last_base_bar_open_ms`),
    last_trade_time_ms: nullableTimestamp(source.last_trade_time_ms, `${path}.last_trade_time_ms`),
    last_agg_trade_id: source.last_agg_trade_id === null
      ? null
      : integer(source.last_agg_trade_id, `${path}.last_agg_trade_id`),
    at_end: bool(source.at_end, `${path}.at_end`),
  };
}

function parseFeeModel(value: unknown, path: string) {
  const source = record(value, path);
  exact(source, ["maker_bps", "taker_bps"], path);
  return {
    maker_bps: parseReplayDecimal(source.maker_bps, `${path}.maker_bps`),
    taker_bps: parseReplayDecimal(source.taker_bps, `${path}.taker_bps`),
  };
}

function parseSlippageModel(value: unknown, path: string) {
  const source = record(value, path);
  exact(source, ["kind", "market_bps"], path);
  if (source.kind !== "fixed_bps") fail(`${path}.kind`, "expected fixed_bps");
  return {
    kind: "fixed_bps" as const,
    market_bps: parseReplayDecimal(source.market_bps, `${path}.market_bps`),
  };
}

export function parseReplaySessionConfig(value: unknown, path = "$"): ReplaySessionConfig {
  const source = record(value, path);
  exact(source, [
    "protocol", "source_kind", "exchange", "market_type", "symbol", "base_interval",
    "display_interval", "start_policy", "requested_start_ms", "warmup_bars", "horizon_ms",
    "random_seed", "quality_mode", "blind_mode", "initial_equity", "quote_asset",
    "execution_model", "fee_model", "slippage_model", "max_leverage",
    "pause_on_controller_loss",
  ], path);
  if (source.protocol !== REPLAY_PROTOCOL) fail(`${path}.protocol`, `expected ${REPLAY_PROTOCOL}`);
  return {
    protocol: REPLAY_PROTOCOL,
    source_kind: enumeration(source.source_kind, REPLAY_SOURCE_KINDS, `${path}.source_kind`),
    exchange: identifier(source.exchange, `${path}.exchange`),
    market_type: identifier(source.market_type, `${path}.market_type`),
    symbol: identifier(source.symbol, `${path}.symbol`),
    base_interval: identifier(source.base_interval, `${path}.base_interval`),
    display_interval: identifier(source.display_interval, `${path}.display_interval`),
    start_policy: enumeration(source.start_policy, ["random_eligible", "manual"] as const, `${path}.start_policy`),
    requested_start_ms: nullableTimestamp(source.requested_start_ms, `${path}.requested_start_ms`),
    warmup_bars: integer(source.warmup_bars, `${path}.warmup_bars`),
    horizon_ms: timestamp(source.horizon_ms, `${path}.horizon_ms`),
    random_seed: integer(source.random_seed, `${path}.random_seed`),
    quality_mode: enumeration(source.quality_mode, REPLAY_QUALITY_MODES, `${path}.quality_mode`),
    blind_mode: bool(source.blind_mode, `${path}.blind_mode`),
    initial_equity: parseReplayDecimal(source.initial_equity, `${path}.initial_equity`),
    quote_asset: identifier(source.quote_asset, `${path}.quote_asset`),
    execution_model: enumeration(source.execution_model, REPLAY_EXECUTION_MODELS, `${path}.execution_model`),
    fee_model: parseFeeModel(source.fee_model, `${path}.fee_model`),
    slippage_model: parseSlippageModel(source.slippage_model, `${path}.slippage_model`),
    max_leverage: parseReplayDecimal(source.max_leverage, `${path}.max_leverage`),
    pause_on_controller_loss: bool(source.pause_on_controller_loss, `${path}.pause_on_controller_loss`),
  };
}

export function parseReplayDisplayBar(value: unknown, path = "$"): ReplayDisplayBar {
  const source = record(value, path);
  exact(source, [
    "open_time_ms", "close_time_ms", "open", "high", "low", "close", "volume",
    "quote_volume", "trades", "taker_buy_base", "taker_buy_quote", "first_base_open_ms",
    "last_base_open_ms", "component_count", "expected_components", "is_closed", "synthetic",
  ], path);
  const parsed: ReplayDisplayBar = {
    open_time_ms: timestamp(source.open_time_ms, `${path}.open_time_ms`),
    close_time_ms: timestamp(source.close_time_ms, `${path}.close_time_ms`),
    open: parseReplayDecimal(source.open, `${path}.open`),
    high: parseReplayDecimal(source.high, `${path}.high`),
    low: parseReplayDecimal(source.low, `${path}.low`),
    close: parseReplayDecimal(source.close, `${path}.close`),
    volume: parseReplayDecimal(source.volume, `${path}.volume`),
    quote_volume: nullableDecimal(source.quote_volume, `${path}.quote_volume`),
    trades: source.trades === null ? null : integer(source.trades, `${path}.trades`),
    taker_buy_base: nullableDecimal(source.taker_buy_base, `${path}.taker_buy_base`),
    taker_buy_quote: nullableDecimal(source.taker_buy_quote, `${path}.taker_buy_quote`),
    first_base_open_ms: timestamp(source.first_base_open_ms, `${path}.first_base_open_ms`),
    last_base_open_ms: timestamp(source.last_base_open_ms, `${path}.last_base_open_ms`),
    component_count: integer(source.component_count, `${path}.component_count`, 1),
    expected_components: integer(source.expected_components, `${path}.expected_components`, 1),
    is_closed: bool(source.is_closed, `${path}.is_closed`),
    synthetic: bool(source.synthetic, `${path}.synthetic`),
  };
  if (parsed.close_time_ms < parsed.open_time_ms) fail(path, "bar close precedes open");
  if (parsed.last_base_open_ms < parsed.first_base_open_ms) fail(path, "bar base range is reversed");
  if (parsed.component_count > parsed.expected_components) fail(path, "bar component count exceeds expected count");
  return parsed;
}

function parseSourceBar(value: unknown, path: string): ReplaySourceBar {
  const source = record(value, path);
  exact(source, [
    "open_time_ms", "close_time_ms", "open", "high", "low", "close", "volume",
    "quote_volume", "trades", "taker_buy_base", "taker_buy_quote", "source",
  ], path);
  const parsed: ReplaySourceBar = {
    open_time_ms: timestamp(source.open_time_ms, `${path}.open_time_ms`),
    close_time_ms: timestamp(source.close_time_ms, `${path}.close_time_ms`),
    open: parseReplayDecimal(source.open, `${path}.open`),
    high: parseReplayDecimal(source.high, `${path}.high`),
    low: parseReplayDecimal(source.low, `${path}.low`),
    close: parseReplayDecimal(source.close, `${path}.close`),
    volume: parseReplayDecimal(source.volume, `${path}.volume`),
    quote_volume: nullableDecimal(source.quote_volume, `${path}.quote_volume`),
    trades: source.trades === null ? null : integer(source.trades, `${path}.trades`),
    taker_buy_base: nullableDecimal(source.taker_buy_base, `${path}.taker_buy_base`),
    taker_buy_quote: nullableDecimal(source.taker_buy_quote, `${path}.taker_buy_quote`),
    source: string(source.source, `${path}.source`),
  };
  if (parsed.close_time_ms < parsed.open_time_ms) fail(path, "source bar close precedes open");
  return parsed;
}

function parseSourceTrade(value: unknown, path: string): ReplaySourceTrade {
  const source = record(value, path);
  exact(source, [
    "exchange", "market_type", "symbol", "agg_trade_id", "first_trade_id",
    "last_trade_id", "price", "quantity", "quote_quantity", "trade_time_ms",
    "is_buyer_maker", "source",
  ], path);
  const parsed: ReplaySourceTrade = {
    exchange: identifier(source.exchange, `${path}.exchange`),
    market_type: identifier(source.market_type, `${path}.market_type`),
    symbol: identifier(source.symbol, `${path}.symbol`),
    agg_trade_id: integer(source.agg_trade_id, `${path}.agg_trade_id`),
    first_trade_id: integer(source.first_trade_id, `${path}.first_trade_id`),
    last_trade_id: integer(source.last_trade_id, `${path}.last_trade_id`),
    price: parseReplayDecimal(source.price, `${path}.price`),
    quantity: parseReplayDecimal(source.quantity, `${path}.quantity`),
    quote_quantity: parseReplayDecimal(source.quote_quantity, `${path}.quote_quantity`),
    trade_time_ms: timestamp(source.trade_time_ms, `${path}.trade_time_ms`),
    is_buyer_maker: bool(source.is_buyer_maker, `${path}.is_buyer_maker`),
    source: string(source.source, `${path}.source`),
  };
  if (parsed.first_trade_id > parsed.last_trade_id) {
    fail(path, "aggregate trade raw ID range is reversed");
  }
  return parsed;
}

function parseSourceEvent(value: unknown, path: string): ReplaySourceEvent {
  const source = record(value, path);
  return Object.hasOwn(source, "trade_time_ms")
    ? parseSourceTrade(source, path)
    : parseSourceBar(source, path);
}

function parseOrder(value: unknown, path: string): ReplayOrder {
  const source = record(value, path);
  exact(source, [
    "order_id", "client_order_id", "side", "order_type", "quantity", "reduce_only",
    "limit_price", "stop_price", "status", "filled_quantity", "remaining_quantity",
    "average_fill_price", "accepted_source_sequence", "created_time_ms", "ordinal",
    "reserved_margin", "status_reason", "status_history", "model_version",
  ], path);
  return {
    order_id: identifier(source.order_id, `${path}.order_id`),
    client_order_id: identifier(source.client_order_id, `${path}.client_order_id`),
    side: string(source.side, `${path}.side`),
    order_type: string(source.order_type, `${path}.order_type`),
    quantity: parseReplayDecimal(source.quantity, `${path}.quantity`),
    reduce_only: bool(source.reduce_only, `${path}.reduce_only`),
    limit_price: nullableDecimal(source.limit_price, `${path}.limit_price`),
    stop_price: nullableDecimal(source.stop_price, `${path}.stop_price`),
    status: string(source.status, `${path}.status`),
    filled_quantity: parseReplayDecimal(source.filled_quantity, `${path}.filled_quantity`),
    remaining_quantity: parseReplayDecimal(source.remaining_quantity, `${path}.remaining_quantity`),
    average_fill_price: nullableDecimal(source.average_fill_price, `${path}.average_fill_price`),
    accepted_source_sequence: integer(source.accepted_source_sequence, `${path}.accepted_source_sequence`),
    created_time_ms: timestamp(source.created_time_ms, `${path}.created_time_ms`),
    ordinal: integer(source.ordinal, `${path}.ordinal`, 1),
    reserved_margin: parseReplayDecimal(source.reserved_margin, `${path}.reserved_margin`),
    status_reason: nullableString(source.status_reason, `${path}.status_reason`),
    status_history: stringList(source.status_history, `${path}.status_history`),
    model_version: string(source.model_version, `${path}.model_version`),
  };
}

function parseFill(value: unknown, path: string): ReplayFill {
  const source = record(value, path);
  exact(source, [
    "fill_id", "order_id", "side", "quantity", "price", "notional", "fee", "fee_asset",
    "liquidity", "reason", "source_sequence", "event_time_ms", "synthetic",
    "historical_execution", "model_version",
  ], path);
  return {
    fill_id: identifier(source.fill_id, `${path}.fill_id`),
    order_id: identifier(source.order_id, `${path}.order_id`),
    side: string(source.side, `${path}.side`),
    quantity: parseReplayDecimal(source.quantity, `${path}.quantity`),
    price: parseReplayDecimal(source.price, `${path}.price`),
    notional: parseReplayDecimal(source.notional, `${path}.notional`),
    fee: parseReplayDecimal(source.fee, `${path}.fee`),
    fee_asset: identifier(source.fee_asset, `${path}.fee_asset`),
    liquidity: string(source.liquidity, `${path}.liquidity`),
    reason: string(source.reason, `${path}.reason`),
    source_sequence: integer(source.source_sequence, `${path}.source_sequence`),
    event_time_ms: timestamp(source.event_time_ms, `${path}.event_time_ms`),
    synthetic: bool(source.synthetic, `${path}.synthetic`),
    historical_execution: bool(source.historical_execution, `${path}.historical_execution`),
    model_version: string(source.model_version, `${path}.model_version`),
  };
}

function parseClosedTrade(value: unknown, path: string): ReplayClosedTrade {
  const source = record(value, path);
  exact(source, [
    "trade_id", "order_id", "fill_id", "side", "quantity", "entry_price",
    "exit_price", "realized_pnl", "source_sequence",
  ], path);
  return {
    trade_id: identifier(source.trade_id, `${path}.trade_id`),
    order_id: identifier(source.order_id, `${path}.order_id`),
    fill_id: identifier(source.fill_id, `${path}.fill_id`),
    side: string(source.side, `${path}.side`),
    quantity: parseReplayDecimal(source.quantity, `${path}.quantity`),
    entry_price: parseReplayDecimal(source.entry_price, `${path}.entry_price`),
    exit_price: parseReplayDecimal(source.exit_price, `${path}.exit_price`),
    realized_pnl: parseReplayDecimal(source.realized_pnl, `${path}.realized_pnl`),
    source_sequence: integer(source.source_sequence, `${path}.source_sequence`),
  };
}

function parseWarning(value: unknown, path: string): ReplayWarning {
  const source = record(value, path);
  exact(source, ["warning_id", "code", "source_sequence", "order_ids", "message"], path);
  return {
    warning_id: identifier(source.warning_id, `${path}.warning_id`),
    code: string(source.code, `${path}.code`),
    source_sequence: integer(source.source_sequence, `${path}.source_sequence`),
    order_ids: array(source.order_ids, `${path}.order_ids`, identifier),
    message: string(source.message, `${path}.message`),
  };
}

function parsePosition(value: unknown, path: string): ReplayPosition {
  const source = record(value, path);
  exact(source, ["quantity", "entry_price", "mark_price", "notional", "realized_pnl", "unrealized_pnl"], path);
  return {
    quantity: parseReplayDecimal(source.quantity, `${path}.quantity`),
    entry_price: nullableDecimal(source.entry_price, `${path}.entry_price`),
    mark_price: parseReplayDecimal(source.mark_price, `${path}.mark_price`),
    notional: parseReplayDecimal(source.notional, `${path}.notional`),
    realized_pnl: parseReplayDecimal(source.realized_pnl, `${path}.realized_pnl`),
    unrealized_pnl: parseReplayDecimal(source.unrealized_pnl, `${path}.unrealized_pnl`),
  };
}

function parseAccount(value: unknown, path: string): ReplayAccount {
  const source = record(value, path);
  exact(source, [
    "cash_balance", "equity", "available_equity", "margin_used", "reserved_margin",
    "realized_pnl", "unrealized_pnl", "fees_paid", "quote_asset",
  ], path);
  return {
    cash_balance: parseReplayDecimal(source.cash_balance, `${path}.cash_balance`),
    equity: parseReplayDecimal(source.equity, `${path}.equity`),
    available_equity: parseReplayDecimal(source.available_equity, `${path}.available_equity`),
    margin_used: parseReplayDecimal(source.margin_used, `${path}.margin_used`),
    reserved_margin: parseReplayDecimal(source.reserved_margin, `${path}.reserved_margin`),
    realized_pnl: parseReplayDecimal(source.realized_pnl, `${path}.realized_pnl`),
    unrealized_pnl: parseReplayDecimal(source.unrealized_pnl, `${path}.unrealized_pnl`),
    fees_paid: parseReplayDecimal(source.fees_paid, `${path}.fees_paid`),
    quote_asset: identifier(source.quote_asset, `${path}.quote_asset`),
  };
}

function parseSingleBarUpdate(value: unknown, path: string): ReplayBarUpdate {
  const source = record(value, path);
  exact(source, ["action", "bar", "source_sequence", "base_open_time_ms", "gap_policy", "synthetic_policy"], path);
  return {
    action: enumeration(source.action, ["append", "tick"] as const, `${path}.action`),
    bar: parseReplayDisplayBar(source.bar, `${path}.bar`),
    source_sequence: integer(source.source_sequence, `${path}.source_sequence`),
    base_open_time_ms: timestamp(source.base_open_time_ms, `${path}.base_open_time_ms`),
    gap_policy: string(source.gap_policy, `${path}.gap_policy`),
    synthetic_policy: string(source.synthetic_policy, `${path}.synthetic_policy`),
  };
}

function parseBarUpdate(value: unknown, path: string): ReplayBarProjectionUpdate | null {
  if (value === null) return null;
  const source = record(value, path);
  if (source.action !== "batch") return parseSingleBarUpdate(source, path);
  exact(source, ["action", "updates"], path);
  const updates = array(source.updates, `${path}.updates`, parseSingleBarUpdate);
  if (updates.length === 0) fail(`${path}.updates`, "batch must contain at least one update");
  return { action: "batch", updates };
}

export function parseReplayProjection(value: unknown, path = "$"): ReplayProjection {
  const source = record(value, path);
  exact(source, ["bar_update", "orders", "fills", "warnings", "position", "account"], path);
  return {
    bar_update: parseBarUpdate(source.bar_update, `${path}.bar_update`),
    orders: array(source.orders, `${path}.orders`, parseOrder),
    fills: array(source.fills, `${path}.fills`, parseFill),
    warnings: array(source.warnings, `${path}.warnings`, parseWarning),
    position: parsePosition(source.position, `${path}.position`),
    account: parseAccount(source.account, `${path}.account`),
  };
}

function parseBarBuilder(value: unknown, path: string): ReplayBarBuilderSnapshot {
  const source = record(value, path);
  exact(source, [
    "schema_version", "base_interval", "display_interval", "base_interval_ms", "display_interval_ms",
    "replay_start_ms", "max_closed_bars", "warmup_count", "warmup_fingerprint", "gap_policy",
    "synthetic_policy", "replay_events_applied", "last_base_open_ms", "active_bar", "closed_bars",
    "closed_count", "closed_prefix_count", "closed_prefix_hash", "closed_chain_hash", "state_hash",
  ], path);
  return {
    schema_version: string(source.schema_version, `${path}.schema_version`),
    base_interval: identifier(source.base_interval, `${path}.base_interval`),
    display_interval: identifier(source.display_interval, `${path}.display_interval`),
    base_interval_ms: integer(source.base_interval_ms, `${path}.base_interval_ms`, 1),
    display_interval_ms: integer(source.display_interval_ms, `${path}.display_interval_ms`, 1),
    replay_start_ms: timestamp(source.replay_start_ms, `${path}.replay_start_ms`),
    max_closed_bars: integer(source.max_closed_bars, `${path}.max_closed_bars`, 1),
    warmup_count: integer(source.warmup_count, `${path}.warmup_count`),
    warmup_fingerprint: digest(source.warmup_fingerprint, `${path}.warmup_fingerprint`),
    gap_policy: string(source.gap_policy, `${path}.gap_policy`),
    synthetic_policy: string(source.synthetic_policy, `${path}.synthetic_policy`),
    replay_events_applied: integer(source.replay_events_applied, `${path}.replay_events_applied`),
    last_base_open_ms: nullableTimestamp(source.last_base_open_ms, `${path}.last_base_open_ms`),
    active_bar: source.active_bar === null ? null : parseReplayDisplayBar(source.active_bar, `${path}.active_bar`),
    closed_bars: array(source.closed_bars, `${path}.closed_bars`, parseReplayDisplayBar),
    closed_count: integer(source.closed_count, `${path}.closed_count`),
    closed_prefix_count: integer(source.closed_prefix_count, `${path}.closed_prefix_count`),
    closed_prefix_hash: digest(source.closed_prefix_hash, `${path}.closed_prefix_hash`),
    closed_chain_hash: digest(source.closed_chain_hash, `${path}.closed_chain_hash`),
    state_hash: digest(source.state_hash, `${path}.state_hash`),
  };
}

function parseTradeFormingBar(value: unknown, path: string): ReplayTradeFormingBar {
  const source = record(value, path);
  exact(source, [
    "open_time_ms", "close_time_ms", "open", "high", "low", "close", "volume",
    "quote_volume", "trades", "taker_buy_base", "taker_buy_quote",
  ], path);
  const parsed: ReplayTradeFormingBar = {
    open_time_ms: timestamp(source.open_time_ms, `${path}.open_time_ms`),
    close_time_ms: timestamp(source.close_time_ms, `${path}.close_time_ms`),
    open: parseReplayDecimal(source.open, `${path}.open`),
    high: parseReplayDecimal(source.high, `${path}.high`),
    low: parseReplayDecimal(source.low, `${path}.low`),
    close: parseReplayDecimal(source.close, `${path}.close`),
    volume: parseReplayDecimal(source.volume, `${path}.volume`),
    quote_volume: parseReplayDecimal(source.quote_volume, `${path}.quote_volume`),
    trades: integer(source.trades, `${path}.trades`, 1),
    taker_buy_base: parseReplayDecimal(source.taker_buy_base, `${path}.taker_buy_base`),
    taker_buy_quote: parseReplayDecimal(source.taker_buy_quote, `${path}.taker_buy_quote`),
  };
  if (parsed.close_time_ms < parsed.open_time_ms) fail(path, "forming bar close precedes open");
  return parsed;
}

function parseTradePublicProjection(value: unknown, path: string): ReplayBarReplaceProjection {
  const source = record(value, path);
  exact(source, [
    "action", "bars", "closed_count", "closed_prefix_count", "replay_events_applied",
    "gap_policy", "synthetic_policy", "source_kind",
  ], path);
  if (source.action !== "replace") fail(`${path}.action`, "expected replace");
  if (source.source_kind !== "AGG_TRADE") fail(`${path}.source_kind`, "expected AGG_TRADE");
  const closedCount = integer(source.closed_count, `${path}.closed_count`);
  const closedPrefixCount = integer(source.closed_prefix_count, `${path}.closed_prefix_count`);
  if (closedPrefixCount > closedCount) fail(path, "closed prefix exceeds closed count");
  return {
    action: "replace",
    bars: array(source.bars, `${path}.bars`, parseReplayDisplayBar),
    closed_count: closedCount,
    closed_prefix_count: closedPrefixCount,
    replay_events_applied: integer(source.replay_events_applied, `${path}.replay_events_applied`),
    gap_policy: string(source.gap_policy, `${path}.gap_policy`),
    synthetic_policy: string(source.synthetic_policy, `${path}.synthetic_policy`),
    source_kind: "AGG_TRADE",
  };
}

function parseTradeIdentity(value: unknown, path: string): readonly [string, string, string] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 3) fail(path, "expected three-part source identity");
  return [
    identifier(value[0], `${path}[0]`),
    identifier(value[1], `${path}[1]`),
    identifier(value[2], `${path}[2]`),
  ];
}

function parseTradeBarBuilder(value: unknown, path: string): ReplayTradeBarBuilderSnapshot {
  const source = record(value, path);
  exact(source, [
    "schema_version", "base_interval", "display_interval", "replay_start_ms",
    "replay_end_time_ms", "max_closed_bars", "synthetic_policy", "bar_builder",
    "public_projection", "forming", "next_base_open_ms", "replay_events_applied",
    "last_trade_time_ms", "last_agg_trade_id", "identity", "previous_close",
    "last_projected_open_ms", "finalized", "state_hash",
  ], path);
  if (source.schema_version !== "replay-trade-bar-builder-state.v1") {
    fail(`${path}.schema_version`, "unsupported aggregate-trade builder schema");
  }
  const nested = parseBarBuilder(source.bar_builder, `${path}.bar_builder`);
  const publicProjection = parseTradePublicProjection(source.public_projection, `${path}.public_projection`);
  const parsed: ReplayTradeBarBuilderSnapshot = {
    schema_version: "replay-trade-bar-builder-state.v1",
    base_interval: identifier(source.base_interval, `${path}.base_interval`),
    display_interval: identifier(source.display_interval, `${path}.display_interval`),
    replay_start_ms: timestamp(source.replay_start_ms, `${path}.replay_start_ms`),
    replay_end_time_ms: timestamp(source.replay_end_time_ms, `${path}.replay_end_time_ms`),
    max_closed_bars: integer(source.max_closed_bars, `${path}.max_closed_bars`, 1),
    synthetic_policy: string(source.synthetic_policy, `${path}.synthetic_policy`),
    bar_builder: nested,
    public_projection: publicProjection,
    forming: source.forming === null ? null : parseTradeFormingBar(source.forming, `${path}.forming`),
    next_base_open_ms: timestamp(source.next_base_open_ms, `${path}.next_base_open_ms`),
    replay_events_applied: integer(source.replay_events_applied, `${path}.replay_events_applied`),
    last_trade_time_ms: nullableTimestamp(source.last_trade_time_ms, `${path}.last_trade_time_ms`),
    last_agg_trade_id: source.last_agg_trade_id === null
      ? null
      : integer(source.last_agg_trade_id, `${path}.last_agg_trade_id`),
    identity: parseTradeIdentity(source.identity, `${path}.identity`),
    previous_close: nullableDecimal(source.previous_close, `${path}.previous_close`),
    last_projected_open_ms: nullableTimestamp(source.last_projected_open_ms, `${path}.last_projected_open_ms`),
    finalized: bool(source.finalized, `${path}.finalized`),
    state_hash: digest(source.state_hash, `${path}.state_hash`),
  };
  if (parsed.replay_end_time_ms < parsed.replay_start_ms) fail(path, "trade replay range is reversed");
  if ((parsed.last_trade_time_ms === null) !== (parsed.last_agg_trade_id === null)) {
    fail(path, "aggregate-trade cursor is partial");
  }
  if (parsed.base_interval !== nested.base_interval
    || parsed.display_interval !== nested.display_interval
    || parsed.replay_start_ms !== nested.replay_start_ms) {
    fail(path, "nested bar builder configuration disagrees");
  }
  if (parsed.synthetic_policy !== nested.synthetic_policy
    || parsed.synthetic_policy !== publicProjection.synthetic_policy
    || parsed.replay_events_applied !== publicProjection.replay_events_applied) {
    fail(path, "public aggregate-trade projection disagrees with builder state");
  }
  return parsed;
}

function parseAnyBarBuilder(value: unknown, path: string): ReplayAnyBarBuilderSnapshot {
  const source = record(value, path);
  return source.schema_version === "replay-trade-bar-builder-state.v1"
    ? parseTradeBarBuilder(source, path)
    : parseBarBuilder(source, path);
}

function parseBrokerSnapshot(value: unknown, path: string): ReplayBrokerSnapshot {
  const source = record(value, path);
  exact(source, [
    "schema_version", "model_version", "config_hash", "bar_builder", "orders", "client_order_ids",
    "fills", "closed_trades", "warnings", "ledger", "position", "account", "next_order", "next_fill",
    "next_trade", "next_warning", "has_trading_activity", "ended", "equity_peak", "max_drawdown", "state_hash",
  ], path);
  return {
    schema_version: string(source.schema_version, `${path}.schema_version`),
    model_version: string(source.model_version, `${path}.model_version`),
    config_hash: digest(source.config_hash, `${path}.config_hash`),
    bar_builder: parseAnyBarBuilder(source.bar_builder, `${path}.bar_builder`),
    orders: array(source.orders, `${path}.orders`, parseOrder),
    client_order_ids: array(source.client_order_ids, `${path}.client_order_ids`, identifier),
    fills: array(source.fills, `${path}.fills`, parseFill),
    closed_trades: array(source.closed_trades, `${path}.closed_trades`, parseClosedTrade),
    warnings: array(source.warnings, `${path}.warnings`, parseWarning),
    ledger: jsonRecord(source.ledger, `${path}.ledger`),
    position: parsePosition(source.position, `${path}.position`),
    account: parseAccount(source.account, `${path}.account`),
    next_order: integer(source.next_order, `${path}.next_order`, 1),
    next_fill: integer(source.next_fill, `${path}.next_fill`, 1),
    next_trade: integer(source.next_trade, `${path}.next_trade`, 1),
    next_warning: integer(source.next_warning, `${path}.next_warning`, 1),
    has_trading_activity: bool(source.has_trading_activity, `${path}.has_trading_activity`),
    ended: bool(source.ended, `${path}.ended`),
    equity_peak: parseReplayDecimal(source.equity_peak, `${path}.equity_peak`),
    max_drawdown: parseReplayDecimal(source.max_drawdown, `${path}.max_drawdown`),
    state_hash: digest(source.state_hash, `${path}.state_hash`),
  };
}

function parseJournalEntry(value: unknown, path: string): ReplayJournalEntry {
  const source = record(value, path);
  exact(source, ["entry_id", "virtual_time_ms", "text"], path);
  return {
    entry_id: identifier(source.entry_id, `${path}.entry_id`),
    virtual_time_ms: timestamp(source.virtual_time_ms, `${path}.virtual_time_ms`),
    text: string(source.text, `${path}.text`),
  };
}

function isTradeBarBuilder(
  builder: ReplayAnyBarBuilderSnapshot,
): builder is ReplayTradeBarBuilderSnapshot {
  return "public_projection" in builder;
}

function publicBuilderBars(builder: ReplayAnyBarBuilderSnapshot): readonly ReplayDisplayBar[] {
  return isTradeBarBuilder(builder)
    ? builder.public_projection.bars
    : [...builder.closed_bars, ...(builder.active_bar ? [builder.active_bar] : [])];
}

type ReplayCausalArtifacts = Pick<
  ReplayBrokerSnapshot | ReplayBrokerReport,
  "orders" | "fills" | "closed_trades" | "warnings"
>;

export function assertReplayArtifactCausality(
  artifacts: ReplayCausalArtifacts,
  sourceSequence: number,
  path = "$",
  publicTime?: number,
): void {
  for (const [index, order] of artifacts.orders.entries()) {
    if (publicTime !== undefined && order.created_time_ms > publicTime) {
      fail(`${path}.orders[${index}]`, "contains future order");
    }
    assertCausalSequence(order.accepted_source_sequence, sourceSequence, `${path}.orders[${index}].accepted_source_sequence`);
  }
  for (const [index, fill] of artifacts.fills.entries()) {
    if (publicTime !== undefined && fill.event_time_ms > publicTime) {
      fail(`${path}.fills[${index}]`, "contains future fill");
    }
    assertCausalSequence(fill.source_sequence, sourceSequence, `${path}.fills[${index}].source_sequence`);
  }
  for (const [index, trade] of artifacts.closed_trades.entries()) {
    assertCausalSequence(trade.source_sequence, sourceSequence, `${path}.closed_trades[${index}].source_sequence`);
  }
  for (const [index, warning] of artifacts.warnings.entries()) {
    assertCausalSequence(warning.source_sequence, sourceSequence, `${path}.warnings[${index}].source_sequence`);
  }
}

function assertNoFutureSnapshot(snapshot: ReplaySessionSnapshot, path: string): void {
  const publicTime = snapshot.cursor.virtual_time_ms;
  const sourceSequence = snapshot.cursor.source_sequence;
  const builder = snapshot.components.bar_builder;
  for (const [index, bar] of publicBuilderBars(builder).entries()) {
    if (bar.open_time_ms > publicTime || bar.last_base_open_ms > publicTime) {
      fail(`${path}.components.bar_builder.public_bars[${index}]`, "contains unrevealed bar time");
    }
  }
  assertReplayArtifactCausality(snapshot.components, sourceSequence, `${path}.components`, publicTime);
  for (const [index, entry] of snapshot.journal.entries()) {
    if (entry.virtual_time_ms > publicTime) fail(`${path}.journal[${index}]`, "contains future journal entry");
  }
}

export function parseReplaySessionSnapshot(value: unknown, path = "$"): ReplaySessionSnapshot {
  const source = record(value, path);
  exact(source, [
    "protocol", "session_id", "state", "revision", "sequence", "cursor", "state_hash", "data_epoch",
    "controller_client_id", "speed", "checkpoint_count", "status_reason", "config", "components",
    "journal", "revealed", "degraded_reason",
  ], path);
  if (source.protocol !== REPLAY_PROTOCOL) fail(`${path}.protocol`, `expected ${REPLAY_PROTOCOL}`);
  const parsed: ReplaySessionSnapshot = {
    protocol: REPLAY_PROTOCOL,
    session_id: identifier(source.session_id, `${path}.session_id`),
    state: enumeration(source.state, REPLAY_SESSION_STATES, `${path}.state`),
    revision: integer(source.revision, `${path}.revision`),
    sequence: integer(source.sequence, `${path}.sequence`),
    cursor: parseCursor(source.cursor, `${path}.cursor`),
    state_hash: digest(source.state_hash, `${path}.state_hash`),
    data_epoch: digest(source.data_epoch, `${path}.data_epoch`),
    controller_client_id: source.controller_client_id === null
      ? null
      : identifier(source.controller_client_id, `${path}.controller_client_id`),
    speed: parseSpeed(source.speed, `${path}.speed`),
    checkpoint_count: integer(source.checkpoint_count, `${path}.checkpoint_count`),
    status_reason: string(source.status_reason, `${path}.status_reason`, { nonEmpty: false }),
    config: parseReplaySessionConfig(source.config, `${path}.config`),
    components: parseBrokerSnapshot(source.components, `${path}.components`),
    journal: array(source.journal, `${path}.journal`, parseJournalEntry),
    revealed: bool(source.revealed, `${path}.revealed`),
    degraded_reason: nullableString(source.degraded_reason, `${path}.degraded_reason`),
  };
  if (parsed.cursor.source_sequence !== parsed.components.bar_builder.replay_events_applied) {
    fail(path, "cursor and bar-builder source sequence disagree");
  }
  if ((parsed.config.source_kind === "agg_trade") !== isTradeBarBuilder(parsed.components.bar_builder)) {
    fail(path, "source kind and bar-builder snapshot disagree");
  }
  assertNoFutureSnapshot(parsed, path);
  return parsed;
}

export function parseReplaySessionResponse(value: unknown, path = "$"): ReplaySessionResponse {
  const source = record(value, path);
  const optional = ["forked", "forked_from_session_id"].filter((key) => Object.hasOwn(source, key));
  exact(source, [
    "protocol", "session_id", "data_fidelity", "execution_fidelity", "snapshot",
    ...optional,
  ], path);
  if (source.protocol !== REPLAY_PROTOCOL) fail(`${path}.protocol`, `expected ${REPLAY_PROTOCOL}`);
  const sessionId = identifier(source.session_id, `${path}.session_id`);
  const snapshot = parseReplaySessionSnapshot(source.snapshot, `${path}.snapshot`);
  if (snapshot.session_id !== sessionId) fail(path, "outer and snapshot session id disagree");
  const dataFidelity = enumeration(source.data_fidelity, REPLAY_DATA_FIDELITIES, `${path}.data_fidelity`);
  const executionFidelity = enumeration(source.execution_fidelity, REPLAY_EXECUTION_FIDELITIES, `${path}.execution_fidelity`);
  const expectedDataFidelity = snapshot.config.source_kind === "agg_trade"
    ? "EXACT_AGG_TRADE_COVERAGE"
    : "EXACT_BAR_COVERAGE";
  const expectedExecutionFidelity = snapshot.config.source_kind === "agg_trade"
    ? "AGG_TRADE_TAPE"
    : "BAR_CONSERVATIVE";
  if (dataFidelity !== expectedDataFidelity || executionFidelity !== expectedExecutionFidelity) {
    fail(path, "session fidelity disagrees with source kind");
  }
  return {
    protocol: REPLAY_PROTOCOL,
    session_id: sessionId,
    data_fidelity: dataFidelity,
    execution_fidelity: executionFidelity,
    snapshot,
    ...(Object.hasOwn(source, "forked") ? { forked: bool(source.forked, `${path}.forked`) } : {}),
    ...(Object.hasOwn(source, "forked_from_session_id")
      ? { forked_from_session_id: identifier(source.forked_from_session_id, `${path}.forked_from_session_id`) }
      : {}),
  };
}

function parseSourceCapability(value: unknown, path: string, sourceKind: "bar" | "agg_trade") {
  const source = record(value, path);
  const enabled = bool(source.enabled, `${path}.enabled`);
  if (!enabled) {
    exact(source, ["enabled", "reason"], path);
    return { enabled, reason: string(source.reason, `${path}.reason`) };
  }
  if (sourceKind === "bar") {
    exact(source, ["enabled", "fidelity"], path);
    return {
      enabled,
      fidelity: enumeration(source.fidelity, REPLAY_DATA_FIDELITIES, `${path}.fidelity`),
    };
  }
  exact(source, [
    "enabled", "fidelity", "execution_fidelity", "requires_exact_dataset", "reader",
  ], path);
  const fidelity = enumeration(source.fidelity, REPLAY_DATA_FIDELITIES, `${path}.fidelity`);
  const executionFidelity = enumeration(
    source.execution_fidelity,
    REPLAY_EXECUTION_FIDELITIES,
    `${path}.execution_fidelity`,
  );
  const requiresExactDataset = bool(source.requires_exact_dataset, `${path}.requires_exact_dataset`);
  if (fidelity !== "EXACT_AGG_TRADE_COVERAGE"
    || executionFidelity !== "AGG_TRADE_TAPE"
    || !requiresExactDataset
    || source.reader !== "paged") {
    fail(path, "aggregate-trade capability is not the exact paged tape contract");
  }
  return {
    enabled,
    fidelity,
    execution_fidelity: executionFidelity,
    requires_exact_dataset: true,
    reader: "paged" as const,
  };
}

export function parseReplayCapabilities(value: unknown, path = "$"): ReplayCapabilities {
  const source = record(value, path);
  const hasReason = Object.hasOwn(source, "reason");
  exact(source, ["protocol", "enabled", "available", ...(hasReason ? ["reason"] : []), "sources", "execution_models", "limits", "persistence"], path);
  if (source.protocol !== REPLAY_PROTOCOL) fail(`${path}.protocol`, `expected ${REPLAY_PROTOCOL}`);
  const sources = record(source.sources, `${path}.sources`);
  exact(sources, ["bar", "agg_trade"], `${path}.sources`);
  const limits = record(source.limits, `${path}.limits`);
  exact(limits, ["max_active_sessions", "max_warmup_bars", "max_bar_dataset_rows", "max_horizon_days", "event_buffer_size", "subscriber_queue"], `${path}.limits`);
  const persistence = record(source.persistence, `${path}.persistence`);
  const hasOpened = Object.hasOwn(persistence, "opened");
  exact(persistence, [...(hasOpened ? ["opened"] : []), "schema_version", "degraded", "degraded_reason"], `${path}.persistence`);
  return {
    protocol: REPLAY_PROTOCOL,
    enabled: bool(source.enabled, `${path}.enabled`),
    available: bool(source.available, `${path}.available`),
    ...(hasReason ? { reason: enumeration(source.reason, REPLAY_ERROR_CODES, `${path}.reason`) } : {}),
    sources: {
      bar: parseSourceCapability(sources.bar, `${path}.sources.bar`, "bar"),
      agg_trade: parseSourceCapability(sources.agg_trade, `${path}.sources.agg_trade`, "agg_trade"),
    },
    execution_models: array(source.execution_models, `${path}.execution_models`, (item, itemPath) => enumeration(item, REPLAY_EXECUTION_MODELS, itemPath)),
    limits: {
      max_active_sessions: integer(limits.max_active_sessions, `${path}.limits.max_active_sessions`),
      max_warmup_bars: integer(limits.max_warmup_bars, `${path}.limits.max_warmup_bars`),
      max_bar_dataset_rows: integer(limits.max_bar_dataset_rows, `${path}.limits.max_bar_dataset_rows`),
      max_horizon_days: integer(limits.max_horizon_days, `${path}.limits.max_horizon_days`),
      event_buffer_size: integer(limits.event_buffer_size, `${path}.limits.event_buffer_size`),
      subscriber_queue: integer(limits.subscriber_queue, `${path}.limits.subscriber_queue`),
    },
    persistence: {
      ...(hasOpened ? { opened: bool(persistence.opened, `${path}.persistence.opened`) } : {}),
      schema_version: persistence.schema_version === null
        ? null
        : integer(persistence.schema_version, `${path}.persistence.schema_version`, 1),
      degraded: bool(persistence.degraded, `${path}.persistence.degraded`),
      degraded_reason: nullableString(persistence.degraded_reason, `${path}.persistence.degraded_reason`),
    },
  };
}

function parseCatalogEntry(value: unknown, path: string, blind: boolean): ReplayCatalogEntry {
  const source = record(value, path);
  const keys = blind
    ? ["identity", "base_intervals", "selected_base_interval", "eligible_window_count", "quality", "limitations", "catalog_epoch", "bounds", "eligible_ranges"]
    : ["identity", "base_intervals", "selected_base_interval", "bounds", "gap_summary", "eligible_ranges", "eligible_window_count", "quality", "source_fingerprint", "limitations", "catalog_epoch"];
  exact(source, keys, path);
  const identitySource = record(source.identity, `${path}.identity`);
  exact(identitySource, ["exchange", "market_type", "symbol"], `${path}.identity`);
  if (blind && source.bounds !== null) {
    fail(`${path}.bounds`, "blind catalog bounds must be null");
  }
  if (blind && Array.isArray(source.eligible_ranges)
    && source.eligible_ranges.length !== 0) {
    fail(`${path}.eligible_ranges`, "blind catalog ranges must be empty");
  }
  const bounds = source.bounds === null ? null : (() => {
    const item = record(source.bounds, `${path}.bounds`);
    exact(item, [
      "earliest_open_ms",
      "latest_source_open_ms",
      "latest_closed_open_ms",
      "total_count",
    ], `${path}.bounds`);
    const parsed = {
      earliest_open_ms: timestamp(item.earliest_open_ms, `${path}.bounds.earliest_open_ms`),
      latest_source_open_ms: timestamp(item.latest_source_open_ms, `${path}.bounds.latest_source_open_ms`),
      latest_closed_open_ms: timestamp(item.latest_closed_open_ms, `${path}.bounds.latest_closed_open_ms`),
      total_count: integer(item.total_count, `${path}.bounds.total_count`, 0),
    };
    if (parsed.latest_source_open_ms < parsed.earliest_open_ms
      || parsed.latest_closed_open_ms < parsed.earliest_open_ms
      || parsed.latest_closed_open_ms > parsed.latest_source_open_ms) {
      fail(`${path}.bounds`, "catalog bounds are not monotonic");
    }
    return parsed;
  })();
  const eligibleRanges = array(source.eligible_ranges, `${path}.eligible_ranges`, (item, itemPath) => {
    const range = record(item, itemPath);
    exact(range, [
      "interval",
      "interval_ms",
      "first_start_ms",
      "last_start_ms",
      "count",
      "warmup_bars",
      "replay_bars",
    ], itemPath);
    const parsed = {
      interval: identifier(range.interval, `${itemPath}.interval`),
      interval_ms: integer(range.interval_ms, `${itemPath}.interval_ms`, 1),
      first_start_ms: timestamp(range.first_start_ms, `${itemPath}.first_start_ms`),
      last_start_ms: timestamp(range.last_start_ms, `${itemPath}.last_start_ms`),
      count: integer(range.count, `${itemPath}.count`, 1),
      warmup_bars: integer(range.warmup_bars, `${itemPath}.warmup_bars`, 0),
      replay_bars: integer(range.replay_bars, `${itemPath}.replay_bars`, 1),
    };
    if (parsed.last_start_ms < parsed.first_start_ms
      || parsed.last_start_ms - parsed.first_start_ms
        !== (parsed.count - 1) * parsed.interval_ms) {
      fail(itemPath, "eligible range count does not match its aligned bounds");
    }
    return parsed;
  });
  return {
    identity: {
      exchange: identifier(identitySource.exchange, `${path}.identity.exchange`),
      market_type: identifier(identitySource.market_type, `${path}.identity.market_type`),
      symbol: identifier(identitySource.symbol, `${path}.identity.symbol`),
    },
    base_intervals: array(source.base_intervals, `${path}.base_intervals`, identifier),
    selected_base_interval: source.selected_base_interval === null
      ? null
      : identifier(source.selected_base_interval, `${path}.selected_base_interval`),
    bounds,
    ...(!blind ? { gap_summary: jsonRecord(source.gap_summary, `${path}.gap_summary`) } : {}),
    eligible_ranges: eligibleRanges,
    eligible_window_count: integer(source.eligible_window_count, `${path}.eligible_window_count`),
    quality: source.quality === null ? null : enumeration(source.quality, REPLAY_DATA_FIDELITIES, `${path}.quality`),
    ...(!blind ? { source_fingerprint: digest(source.source_fingerprint, `${path}.source_fingerprint`) } : {}),
    catalog_epoch: digest(source.catalog_epoch, `${path}.catalog_epoch`),
    limitations: stringList(source.limitations, `${path}.limitations`),
  };
}

export function parseReplayCatalog(value: unknown, path = "$"): ReplayCatalog {
  const source = record(value, path);
  exact(source, ["protocol", "catalog_epoch", "warmup_bars", "horizon_ms", "quality_mode", "blind_mode", "entries"], path);
  if (source.protocol !== REPLAY_PROTOCOL) fail(`${path}.protocol`, `expected ${REPLAY_PROTOCOL}`);
  const blindMode = bool(source.blind_mode, `${path}.blind_mode`);
  const catalogEpoch = digest(source.catalog_epoch, `${path}.catalog_epoch`);
  const entries = array(source.entries, `${path}.entries`, (item, itemPath) => parseCatalogEntry(item, itemPath, blindMode));
  for (const [index, entry] of entries.entries()) {
    if (entry.catalog_epoch !== catalogEpoch) fail(`${path}.entries[${index}].catalog_epoch`, "does not match catalog epoch");
  }
  return {
    protocol: REPLAY_PROTOCOL,
    catalog_epoch: catalogEpoch,
    warmup_bars: integer(source.warmup_bars, `${path}.warmup_bars`),
    horizon_ms: timestamp(source.horizon_ms, `${path}.horizon_ms`),
    quality_mode: enumeration(source.quality_mode, REPLAY_QUALITY_MODES, `${path}.quality_mode`),
    blind_mode: blindMode,
    entries,
  };
}

export function parseReplayErrorEnvelope(value: unknown, path = "$"): ReplayErrorEnvelope {
  const source = record(value, path);
  exact(source, ["protocol", "error"], path);
  if (source.protocol !== REPLAY_PROTOCOL) fail(`${path}.protocol`, `expected ${REPLAY_PROTOCOL}`);
  const error = record(source.error, `${path}.error`);
  exact(error, ["code", "message", "details"], `${path}.error`);
  return {
    protocol: REPLAY_PROTOCOL,
    error: {
      code: enumeration(error.code, REPLAY_ERROR_CODES, `${path}.error.code`),
      message: string(error.message, `${path}.error.message`),
      details: jsonRecord(error.details, `${path}.error.details`),
    },
  };
}

export function parseReplayCommandResult(value: unknown, path = "$"): ReplayCommandResult {
  const source = record(value, path);
  exact(source, ["protocol", "session_id", "command_id", "revision", "sequence", "state", "state_hash", "cursor", "data"], path);
  if (source.protocol !== REPLAY_PROTOCOL) fail(`${path}.protocol`, `expected ${REPLAY_PROTOCOL}`);
  return {
    protocol: REPLAY_PROTOCOL,
    session_id: identifier(source.session_id, `${path}.session_id`),
    command_id: identifier(source.command_id, `${path}.command_id`),
    revision: integer(source.revision, `${path}.revision`),
    sequence: integer(source.sequence, `${path}.sequence`),
    state: enumeration(source.state, REPLAY_SESSION_STATES, `${path}.state`),
    state_hash: digest(source.state_hash, `${path}.state_hash`),
    cursor: parseCursor(source.cursor, `${path}.cursor`),
    data: jsonRecord(source.data, `${path}.data`),
  };
}

function assertProjectionTime(projection: ReplayProjection, virtualTime: number, path: string): void {
  const updates = projection.bar_update === null
    ? []
    : projection.bar_update.action === "batch"
      ? projection.bar_update.updates
      : [projection.bar_update];
  for (const [index, update] of updates.entries()) {
    if (update.base_open_time_ms > virtualTime
      || update.bar.open_time_ms > virtualTime
      || update.bar.last_base_open_ms > virtualTime) {
      fail(`${path}.bar_update.updates[${index}]`, "contains unrevealed bar time");
    }
  }
  for (const [index, fill] of projection.fills.entries()) {
    if (fill.event_time_ms > virtualTime) fail(`${path}.fills[${index}]`, "contains future fill");
  }
  for (const [index, order] of projection.orders.entries()) {
    if (order.created_time_ms > virtualTime) fail(`${path}.orders[${index}]`, "contains future order");
  }
}

function assertCausalSequence(sequence: number, ceiling: number, path: string): void {
  if (sequence > ceiling) fail(path, `causal source sequence ${sequence} exceeds revealed cursor ${ceiling}`);
}

function assertProjectionCausality(projection: ReplayProjection, ceiling: number, path: string): void {
  const updates = projection.bar_update === null
    ? []
    : projection.bar_update.action === "batch"
      ? projection.bar_update.updates
      : [projection.bar_update];
  for (const [index, update] of updates.entries()) {
    assertCausalSequence(update.source_sequence, ceiling, `${path}.bar_update.updates[${index}].source_sequence`);
  }
  for (const [index, order] of projection.orders.entries()) {
    assertCausalSequence(order.accepted_source_sequence, ceiling, `${path}.orders[${index}].accepted_source_sequence`);
  }
  for (const [index, fill] of projection.fills.entries()) {
    assertCausalSequence(fill.source_sequence, ceiling, `${path}.fills[${index}].source_sequence`);
  }
  for (const [index, warning] of projection.warnings.entries()) {
    assertCausalSequence(warning.source_sequence, ceiling, `${path}.warnings[${index}].source_sequence`);
  }
}

function assertProjectionAdvances(projection: ReplayProjection, floor: number, path: string): void {
  const updates = projection.bar_update === null
    ? []
    : projection.bar_update.action === "batch"
      ? projection.bar_update.updates
      : [projection.bar_update];
  for (const [index, update] of updates.entries()) {
    if (update.source_sequence <= floor) {
      fail(`${path}.bar_update.updates[${index}].source_sequence`, "delta projection did not advance beyond the previous source cursor");
    }
  }
  for (const [index, fill] of projection.fills.entries()) {
    if (fill.source_sequence <= floor) {
      fail(`${path}.fills[${index}].source_sequence`, "delta fill did not advance beyond the previous source cursor");
    }
  }
  for (const [index, warning] of projection.warnings.entries()) {
    if (warning.source_sequence <= floor) {
      fail(`${path}.warnings[${index}].source_sequence`, "delta warning did not advance beyond the previous source cursor");
    }
  }
}

export function assertReplayEventCausality(event: ReplayParsedEvent, currentSourceSequence: number): void {
  if (event.type === "replay.delta") {
    const data = event.data as { readonly source_sequence: number; readonly projection: ReplayProjection };
    const sequenceFrom = event.sequence_from ?? event.sequence;
    const sequenceTo = event.sequence_to ?? event.sequence;
    const expectedSourceSequence = currentSourceSequence + (sequenceTo - sequenceFrom + 1);
    if (data.source_sequence !== expectedSourceSequence) {
      fail("$.data.source_sequence", `expected causal source sequence ${expectedSourceSequence}, got ${data.source_sequence}`);
    }
    assertProjectionCausality(data.projection, data.source_sequence, "$.data.projection");
    assertProjectionAdvances(data.projection, currentSourceSequence, "$.data.projection");
    return;
  }
  const projection = (event.data as { readonly projection?: ReplayProjection }).projection;
  if (projection !== undefined) assertProjectionCausality(projection, currentSourceSequence, "$.data.projection");
}

function parseEventData(type: string, value: unknown, path: string, virtualTime: number) {
  const source = record(value, path);
  switch (type) {
    case "replay.snapshot": {
      exact(source, ["reset", "snapshot"], path);
      if (source.reset !== true) fail(`${path}.reset`, "atomic snapshot must reset");
      return { reset: true as const, snapshot: parseReplaySessionSnapshot(source.snapshot, `${path}.snapshot`) };
    }
    case "replay.status": {
      exact(source, ["state", "reason", "speed", "controller_client_id"], path);
      return {
        state: enumeration(source.state, REPLAY_SESSION_STATES, `${path}.state`),
        reason: string(source.reason, `${path}.reason`),
        speed: parseSpeed(source.speed, `${path}.speed`),
        controller_client_id: source.controller_client_id === null ? null : identifier(source.controller_client_id, `${path}.controller_client_id`),
      };
    }
    case "replay.delta": {
      exact(source, ["source_sequence", "source_event", "projection"], path);
      const sourceEvent = parseSourceEvent(source.source_event, `${path}.source_event`);
      const eventTime = "trade_time_ms" in sourceEvent
        ? sourceEvent.trade_time_ms
        : sourceEvent.close_time_ms;
      if (eventTime > virtualTime) fail(`${path}.source_event`, "contains unrevealed source event");
      if (!("trade_time_ms" in sourceEvent)
        && (sourceEvent.open_time_ms > virtualTime || sourceEvent.close_time_ms > virtualTime)) {
        fail(`${path}.source_event`, "contains unrevealed source bar time");
      }
      const projection = parseReplayProjection(source.projection, `${path}.projection`);
      assertProjectionTime(projection, virtualTime, `${path}.projection`);
      const sourceSequence = integer(source.source_sequence, `${path}.source_sequence`);
      assertProjectionCausality(projection, sourceSequence, `${path}.projection`);
      return {
        source_sequence: sourceSequence,
        source_event: sourceEvent,
        projection,
      };
    }
    case "replay.order": {
      exact(source, ["command_type", "projection"], path);
      const projection = parseReplayProjection(source.projection, `${path}.projection`);
      if (projection.bar_update !== null) {
        fail(`${path}.projection.bar_update`, "order event cannot carry a bar update");
      }
      assertProjectionTime(projection, virtualTime, `${path}.projection`);
      return {
        command_type: enumeration(source.command_type, REPLAY_COMMAND_TYPES, `${path}.command_type`) as ReplayCommandType,
        projection,
      };
    }
    case "replay.journal": {
      const entry = parseJournalEntry(source, path);
      if (entry.virtual_time_ms > virtualTime) fail(path, "contains future journal entry");
      return entry;
    }
    case "replay.resync_required": {
      exact(source, ["reset", "reason"], path);
      if (source.reset !== true) fail(`${path}.reset`, "resync must reset");
      return { reset: true as const, reason: string(source.reason, `${path}.reason`) };
    }
    case "replay.ended": {
      exact(source, ["reason", "projection"], path);
      const projection = parseReplayProjection(source.projection, `${path}.projection`);
      assertProjectionTime(projection, virtualTime, `${path}.projection`);
      return { reason: string(source.reason, `${path}.reason`), projection };
    }
    default:
      return fail(path, `unsupported replay event payload for ${type}`);
  }
}

export function parseReplayEvent(value: unknown, path = "$"): ReplayParsedEvent {
  const source = record(value, path);
  const hasSequenceFrom = Object.hasOwn(source, "sequence_from");
  const hasSequenceTo = Object.hasOwn(source, "sequence_to");
  if (hasSequenceFrom !== hasSequenceTo) fail(path, "coalesced sequence range is partial");
  exact(source, [
    "type", "protocol", "session_id", "sequence", "revision", "virtual_time_ms", "state_hash", "data_epoch", "data",
    ...(hasSequenceFrom ? ["sequence_from", "sequence_to"] : []),
  ], path);
  const type = enumeration(source.type, REPLAY_EVENT_TYPES, `${path}.type`);
  if (hasSequenceFrom && type !== "replay.delta") {
    fail(path, "only replay.delta may carry a coalesced sequence range");
  }
  if (source.protocol !== REPLAY_PROTOCOL) fail(`${path}.protocol`, `expected ${REPLAY_PROTOCOL}`);
  const sessionId = identifier(source.session_id, `${path}.session_id`);
  const sequence = integer(source.sequence, `${path}.sequence`) as ReplaySequence;
  const sequenceFrom = hasSequenceFrom
    ? integer(source.sequence_from, `${path}.sequence_from`) as ReplaySequence
    : sequence;
  const sequenceTo = hasSequenceTo
    ? integer(source.sequence_to, `${path}.sequence_to`) as ReplaySequence
    : sequence;
  if (sequenceFrom > sequenceTo) fail(path, "coalesced sequence range is reversed");
  if (sequenceTo !== sequence) fail(path, "coalesced sequence range does not end at envelope sequence");
  const revision = integer(source.revision, `${path}.revision`);
  const virtualTime = timestamp(source.virtual_time_ms, `${path}.virtual_time_ms`);
  const stateHash = digest(source.state_hash, `${path}.state_hash`);
  const dataEpoch = digest(source.data_epoch, `${path}.data_epoch`);
  const data = parseEventData(type, source.data, `${path}.data`, virtualTime);
  if (type === "replay.snapshot" && "snapshot" in data) {
    if (data.snapshot.session_id !== sessionId) fail(path, "snapshot session does not match envelope");
    if (data.snapshot.sequence !== sequence || data.snapshot.revision !== revision) fail(path, "snapshot counters do not match envelope");
    if (data.snapshot.cursor.virtual_time_ms !== virtualTime) fail(path, "snapshot time does not match envelope");
    if (data.snapshot.state_hash !== stateHash || data.snapshot.data_epoch !== dataEpoch) fail(path, "snapshot hashes do not match envelope");
  }
  return {
    type,
    protocol: REPLAY_PROTOCOL,
    session_id: sessionId,
    sequence,
    ...(hasSequenceFrom ? { sequence_from: sequenceFrom, sequence_to: sequenceTo } : {}),
    revision,
    virtual_time_ms: virtualTime,
    state_hash: stateHash,
    data_epoch: dataEpoch,
    data,
  } as ReplayParsedEvent;
}

export interface ReplayJournalResponse {
  readonly protocol: typeof REPLAY_PROTOCOL;
  readonly session_id: string;
  readonly entries: readonly ReplayJournalEntry[];
}

export function parseReplayJournalResponse(value: unknown, path = "$"): ReplayJournalResponse {
  const source = record(value, path);
  exact(source, ["protocol", "session_id", "entries"], path);
  if (source.protocol !== REPLAY_PROTOCOL) fail(`${path}.protocol`, `expected ${REPLAY_PROTOCOL}`);
  return {
    protocol: REPLAY_PROTOCOL,
    session_id: identifier(source.session_id, `${path}.session_id`),
    entries: array(source.entries, `${path}.entries`, parseJournalEntry),
  };
}

export interface ReplayReportResponse {
  readonly protocol: typeof REPLAY_PROTOCOL;
  readonly session_id: string;
  readonly data_fidelity: "EXACT_BAR_COVERAGE" | "EXACT_AGG_TRADE_COVERAGE" | "BEST_EFFORT";
  readonly execution_fidelity: "BAR_CONSERVATIVE" | "AGG_TRADE_TAPE";
  readonly revealed: boolean;
  readonly report: ReplayBrokerReport;
  readonly actual_history?: { readonly replay_start_ms: number; readonly replay_end_open_ms: number };
}

function parseBrokerReport(value: unknown, path: string): ReplayBrokerReport {
  const source = record(value, path);
  exact(source, [
    "schema_version", "config_hash", "model_version", "initial_equity", "final_equity",
    "realized_pnl", "fees_paid", "max_drawdown", "trade_count", "winning_trades",
    "losing_trades", "win_rate", "average_win", "average_loss", "profit_factor",
    "ambiguous_bar_count", "order_count", "fill_count", "ledger_entry_count",
    "ledger_tail_hash", "state_hash", "ended", "orders", "fills", "closed_trades",
    "warnings", "report_hash",
  ], path);
  const report: ReplayBrokerReport = {
    schema_version: string(source.schema_version, `${path}.schema_version`),
    config_hash: digest(source.config_hash, `${path}.config_hash`),
    model_version: string(source.model_version, `${path}.model_version`),
    initial_equity: parseReplayDecimal(source.initial_equity, `${path}.initial_equity`),
    final_equity: parseReplayDecimal(source.final_equity, `${path}.final_equity`),
    realized_pnl: parseReplayDecimal(source.realized_pnl, `${path}.realized_pnl`),
    fees_paid: parseReplayDecimal(source.fees_paid, `${path}.fees_paid`),
    max_drawdown: parseReplayDecimal(source.max_drawdown, `${path}.max_drawdown`),
    trade_count: integer(source.trade_count, `${path}.trade_count`),
    winning_trades: integer(source.winning_trades, `${path}.winning_trades`),
    losing_trades: integer(source.losing_trades, `${path}.losing_trades`),
    win_rate: parseReplayDecimal(source.win_rate, `${path}.win_rate`),
    average_win: parseReplayDecimal(source.average_win, `${path}.average_win`),
    average_loss: parseReplayDecimal(source.average_loss, `${path}.average_loss`),
    profit_factor: nullableDecimal(source.profit_factor, `${path}.profit_factor`),
    ambiguous_bar_count: integer(source.ambiguous_bar_count, `${path}.ambiguous_bar_count`),
    order_count: integer(source.order_count, `${path}.order_count`),
    fill_count: integer(source.fill_count, `${path}.fill_count`),
    ledger_entry_count: integer(source.ledger_entry_count, `${path}.ledger_entry_count`),
    ledger_tail_hash: digest(source.ledger_tail_hash, `${path}.ledger_tail_hash`),
    state_hash: digest(source.state_hash, `${path}.state_hash`),
    ended: bool(source.ended, `${path}.ended`),
    orders: array(source.orders, `${path}.orders`, parseOrder),
    fills: array(source.fills, `${path}.fills`, parseFill),
    closed_trades: array(source.closed_trades, `${path}.closed_trades`, parseClosedTrade),
    warnings: array(source.warnings, `${path}.warnings`, parseWarning),
    report_hash: digest(source.report_hash, `${path}.report_hash`),
  };
  if (report.winning_trades + report.losing_trades > report.trade_count) {
    fail(path, "winning and losing trades exceed trade_count");
  }
  if (report.orders.length !== report.order_count
    || report.fills.length !== report.fill_count
    || report.closed_trades.length !== report.trade_count) {
    fail(path, "report record counts do not reconcile");
  }
  return report;
}

export function parseReplayReportResponse(value: unknown, path = "$"): ReplayReportResponse {
  const source = record(value, path);
  const hasActual = Object.hasOwn(source, "actual_history");
  exact(source, ["protocol", "session_id", "data_fidelity", "execution_fidelity", "revealed", "report", ...(hasActual ? ["actual_history"] : [])], path);
  if (source.protocol !== REPLAY_PROTOCOL) fail(`${path}.protocol`, `expected ${REPLAY_PROTOCOL}`);
  const revealed = bool(source.revealed, `${path}.revealed`);
  if (hasActual !== revealed) {
    fail(path, revealed
      ? "revealed report must include actual_history"
      : "unrevealed report cannot include actual_history");
  }
  let actualHistory: ReplayReportResponse["actual_history"];
  if (hasActual) {
    const actual = record(source.actual_history, `${path}.actual_history`);
    exact(actual, ["replay_start_ms", "replay_end_open_ms"], `${path}.actual_history`);
    actualHistory = {
      replay_start_ms: timestamp(actual.replay_start_ms, `${path}.actual_history.replay_start_ms`),
      replay_end_open_ms: timestamp(actual.replay_end_open_ms, `${path}.actual_history.replay_end_open_ms`),
    };
    if (actualHistory.replay_end_open_ms < actualHistory.replay_start_ms) {
      fail(`${path}.actual_history`, "replay end cannot precede replay start");
    }
  }
  return {
    protocol: REPLAY_PROTOCOL,
    session_id: identifier(source.session_id, `${path}.session_id`),
    data_fidelity: enumeration(source.data_fidelity, REPLAY_DATA_FIDELITIES, `${path}.data_fidelity`),
    execution_fidelity: enumeration(source.execution_fidelity, ["BAR_CONSERVATIVE", "AGG_TRADE_TAPE"] as const, `${path}.execution_fidelity`),
    revealed,
    report: parseBrokerReport(source.report, `${path}.report`),
    ...(actualHistory ? { actual_history: actualHistory } : {}),
  };
}

export function isReplayErrorEnvelope(value: unknown): value is ReplayErrorEnvelope {
  try {
    parseReplayErrorEnvelope(value);
    return true;
  } catch {
    return false;
  }
}

export function replayErrorCode(value: unknown): ReplayErrorCode | null {
  try {
    return parseReplayErrorEnvelope(value).error.code;
  } catch {
    return null;
  }
}
