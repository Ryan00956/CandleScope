export const REPLAY_V2_PROTOCOL = "replay.v2" as const;
export const REPLAY_V2_SCHEMA_VERSION = "replay.contract.v2.phase0" as const;

function enumValues<const T extends readonly string[]>(...values: T): Readonly<T> {
  return Object.freeze(values);
}

export const REPLAY_V2_ENUMS = Object.freeze({
  run_state: enumValues("PAUSED", "PLAYING", "ADVANCING", "ENDED", "ERROR"),
  track_state: enumValues("DORMANT", "PREPARING", "READY", "DEGRADED", "ERROR"),
  source_kind: enumValues("BAR", "AGG_TRADE"),
  start_mode: enumValues("MANUAL", "RANDOM"),
  integrity_mode: enumValues("CHALLENGE", "PRACTICE", "SANDBOX"),
  time_disclosure_policy: enumValues(
    "NONE",
    "HIDE_YEAR",
    "HIDE_MONTH",
    "HIDE_DAY",
    "HIDE_HOUR",
    "HIDE_MINUTE",
    "HIDE_ALL",
  ),
  subscription_tier: enumValues("NONE", "WARM", "FULL"),
  capability_kind: enumValues(
    "OHLCV",
    "INDICATORS",
    "AGG_TRADE_TAPE",
    "ORDER_FLOW",
    "OPEN_INTEREST",
    "MARKET_LIQUIDATIONS",
    "MARK_PRICE",
    "INDEX_PRICE",
    "BASIS",
    "FUNDING",
    "ORDER_BOOK",
    "SIMULATED_LIQUIDATION",
  ),
  capability_state: enumValues(
    "AVAILABLE_EXACT",
    "AVAILABLE_APPROX",
    "UNSUPPORTED_NO_HISTORY",
    "UNSUPPORTED_SOURCE_MODE",
    "LOADING",
    "DEGRADED",
  ),
  fast_forward_plan: enumValues(
    "CHECKPOINT_JUMP",
    "AGGREGATE_SCAN",
    "FULL_EVENT_SCAN",
    "BLOCKED",
  ),
  book_mode: enumValues("OFF", "BOOK_ASSISTED_REQUIRED"),
  margin_mode: enumValues("CROSS", "ISOLATED"),
  funding_mode: enumValues("OFF", "HISTORICAL_EXACT", "SANDBOX_FIXED"),
  execution_model: enumValues("TOUCH_OR_TAPE_V2"),
  advance_basis: enumValues(
    "DISPLAY_BAR",
    "BASE_BAR",
    "SOURCE_EVENT",
    "VIRTUAL_TIME",
  ),
  command_type: enumValues(
    "acquire_controller",
    "heartbeat_controller",
    "release_controller",
    "takeover_controller",
    "play",
    "pause",
    "set_speed",
    "step_event",
    "step_base",
    "step_display",
    "advance",
    "advance_by",
    "advance_to",
    "cancel_advance",
    "select_track",
    "set_display_interval",
    "set_chart_type",
    "record_view_action",
    "add_track",
    "set_subscription_tier",
    "remove_unowned_track",
    "place_order",
    "cancel_order",
    "close_position",
    "allocate_isolated_margin",
    "deposit",
    "withdraw",
    "change_fee_policy",
    "change_leverage_cap",
    "change_funding_policy",
    "reveal_time",
    "save",
    "end",
    "fork",
    "start_review",
  ),
  event_type: enumValues(
    "RUN_SNAPSHOT",
    "RUN_STATE_CHANGED",
    "TRACK_PROJECTION",
    "ACCOUNT_PROJECTION",
    "AUDIT_EVENT",
    "ADVANCE_PROGRESS",
    "RESYNC_REQUIRED",
  ),
});

type EnumValue<T extends readonly string[]> = T[number];

export type ReplayV2RunState = EnumValue<typeof REPLAY_V2_ENUMS.run_state>;
export type ReplayV2TrackState = EnumValue<typeof REPLAY_V2_ENUMS.track_state>;
export type ReplayV2SourceKind = EnumValue<typeof REPLAY_V2_ENUMS.source_kind>;
export type ReplayV2StartMode = EnumValue<typeof REPLAY_V2_ENUMS.start_mode>;
export type ReplayV2IntegrityMode = EnumValue<typeof REPLAY_V2_ENUMS.integrity_mode>;
export type ReplayV2TimeDisclosurePolicy = EnumValue<
  typeof REPLAY_V2_ENUMS.time_disclosure_policy
>;
export type ReplayV2SubscriptionTier = EnumValue<typeof REPLAY_V2_ENUMS.subscription_tier>;
export type ReplayV2CapabilityKind = EnumValue<typeof REPLAY_V2_ENUMS.capability_kind>;
export type ReplayV2CapabilityState = EnumValue<typeof REPLAY_V2_ENUMS.capability_state>;
export type ReplayV2AdvanceBasis = EnumValue<typeof REPLAY_V2_ENUMS.advance_basis>;
export type ReplayV2CommandType = EnumValue<typeof REPLAY_V2_ENUMS.command_type>;
export type ReplayV2EventType = EnumValue<typeof REPLAY_V2_ENUMS.event_type>;
export type ReplayV2MarginMode = EnumValue<typeof REPLAY_V2_ENUMS.margin_mode>;
export type ReplayV2FundingMode = EnumValue<typeof REPLAY_V2_ENUMS.funding_mode>;
export type ReplayV2BookMode = EnumValue<typeof REPLAY_V2_ENUMS.book_mode>;

export interface ReplayV2Cursor {
  readonly virtual_time_ms: number;
  readonly source_sequence: number;
  readonly revision: number;
}

export interface ReplayV2TrainingRun {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly run_id: string;
  readonly state: ReplayV2RunState;
  readonly source_kind: ReplayV2SourceKind;
  readonly start_mode: ReplayV2StartMode;
  readonly book_mode: EnumValue<typeof REPLAY_V2_ENUMS.book_mode>;
  readonly integrity_mode: ReplayV2IntegrityMode;
  readonly time_disclosure_policy: ReplayV2TimeDisclosurePolicy;
  readonly initial_equity: string;
  readonly active_rule_revision: number;
  readonly cursor: ReplayV2Cursor;
}

export interface ReplayV2MarketTrack {
  readonly run_id: string;
  readonly track_id: string;
  readonly state: ReplayV2TrackState;
  readonly source_kind: ReplayV2SourceKind;
  readonly subscription_tier: ReplayV2SubscriptionTier;
  readonly cursor: ReplayV2Cursor;
  readonly forced_full_reasons: readonly string[];
  readonly capabilities: Readonly<Partial<Record<ReplayV2CapabilityKind, ReplayV2CapabilityState>>>;
}

export interface ReplayTrainingMarketTrack {
  readonly run_id: string;
  readonly track_id: string;
  readonly stable_ordinal: number;
  readonly adapter_session_id: string | null;
  readonly exchange: string;
  readonly market_type: string;
  readonly symbol: string;
  readonly settlement_asset: string;
  readonly state: ReplayV2TrackState;
  readonly source_kind: ReplayV2SourceKind;
  readonly subscription_tier: ReplayV2SubscriptionTier;
  readonly cursor: ReplayV2Cursor | null;
  readonly forced_full_reasons: readonly string[];
  readonly capabilities: Readonly<Partial<Record<ReplayV2CapabilityKind, ReplayV2CapabilityState>>>;
  readonly public_price: string | null;
  readonly position: Readonly<Record<string, ReplayV2Json>>;
  readonly open_order_count: number;
  readonly degraded_reason: string | null;
  readonly account: Readonly<Record<string, ReplayV2Json>>;
  readonly historical_book: ReplayHistoricalBookProjection;
}

export interface ReplayHistoricalBookProjection {
  readonly mode: ReplayV2BookMode;
  readonly capability_state: ReplayV2CapabilityState;
  readonly status: "OFF" | "READY" | "CLEARED" | "DISABLED";
  readonly execution_fidelity:
    | "NO_BOOK_TOUCH_OR_TAPE_APPROX"
    | "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE";
  readonly queue_exact: false;
  readonly as_of_virtual_time_ms: number | null;
  readonly last_update_id: number | null;
  readonly bids: readonly (readonly [string, string])[];
  readonly asks: readonly (readonly [string, string])[];
  readonly book_hash: `sha256:${string}` | null;
  readonly message: string;
}

export interface ReplayTrainingPortfolioV1 {
  readonly schema_version: "replay.training.portfolio.v1";
  readonly fidelity: "PAPER_LINEAR_V1_MULTI_TRACK_ADAPTER";
  readonly settlement_account_shared: true;
  readonly initial_equity: string;
  readonly equity: string;
  readonly cash_balance: string;
  readonly available_equity: string;
  readonly reserved_margin: string;
  readonly margin_used: string;
  readonly realized_pnl: string;
  readonly unrealized_pnl: string;
  readonly fees_paid: string;
  readonly positions: readonly ReplayTrainingPortfolioPosition[];
}

export interface ReplayTrainingContractPortfolio {
  readonly schema_version: "replay.training.portfolio.v2";
  readonly account_model: "TOUCH_OR_TAPE_V2";
  readonly execution_model: "TOUCH_OR_TAPE_V2";
  readonly execution_fidelity:
    | "NO_BOOK_TOUCH_OR_TAPE_APPROX"
    | "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE";
  readonly settlement_account_shared: boolean;
  readonly margin_mode: EnumValue<typeof REPLAY_V2_ENUMS.margin_mode>;
  readonly funding_mode: EnumValue<typeof REPLAY_V2_ENUMS.funding_mode>;
  readonly status: "ACTIVE" | "LIQUIDATING" | "BANKRUPT";
  readonly initial_equity: string;
  readonly equity: string;
  readonly cash_balance: string;
  readonly available_equity: string;
  readonly reserved_margin: string;
  readonly margin_used: string;
  readonly maintenance_margin: string;
  readonly realized_pnl: string;
  readonly unrealized_pnl: string;
  readonly fees_paid: string;
  readonly funding_cashflow: string;
  readonly liquidation_fees_paid: string;
  readonly risk_ratio: string | null;
  readonly positions: readonly ReplayTrainingPortfolioPosition[];
  readonly orders: readonly Readonly<Record<string, ReplayV2Json>>[];
  readonly fills: readonly Readonly<Record<string, ReplayV2Json>>[];
  readonly active_fee_policy: Readonly<Record<string, ReplayV2Json>> | null;
  readonly instrument_rules: readonly Readonly<Record<string, ReplayV2Json>>[];
  readonly isolated_allocations: Readonly<Record<string, ReplayV2Json>>;
  readonly next_funding_time_ms: number | null;
  readonly liquidations: readonly Readonly<Record<string, ReplayV2Json>>[];
  readonly ledger: Readonly<Record<string, ReplayV2Json>>;
  readonly fidelity: Readonly<Record<string, ReplayV2Json>>;
}

export type ReplayTrainingPortfolio = ReplayTrainingPortfolioV1 | ReplayTrainingContractPortfolio;

export interface ReplayTrainingPortfolioPosition {
  readonly track_id: string;
  readonly symbol: string;
  readonly position: Readonly<Record<string, ReplayV2Json>>;
  readonly maintenance_margin?: string;
  readonly isolated_margin?: string;
  readonly margin_equity?: string;
  readonly risk_ratio?: string | null;
  readonly rule_revision?: number;
  readonly rule_hash?: string;
  readonly mark_fidelity?: string;
}

export interface ReplayGlobalClock {
  readonly contract: "replay.playback.v1";
  readonly mode: "ADAPTER" | "ORDERED";
  readonly state: ReplayV2RunState;
  readonly basis: ReplayV2AdvanceBasis;
  readonly rate: number;
  readonly speed: number;
  readonly display_interval: string | null;
  readonly viewer_revision: number | null;
  readonly profile_revision: number;
  readonly reason: string | null;
  readonly generation: number;
  readonly tick: number;
  readonly supported_bases: readonly ReplayV2AdvanceBasis[];
  readonly playback_bases: readonly ReplayV2AdvanceBasis[];
  readonly max_count: number;
  readonly virtual_time_quantum_ms: number;
}

export interface ReplayLaunchWatchlistItem {
  readonly exchange: string;
  readonly market_type: string;
  readonly symbol: string;
}

export interface ReplayLaunchWatchlistGroup {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly items: readonly ReplayLaunchWatchlistItem[];
}

export interface ReplayWatchlistSnapshot {
  readonly schema_version: "replay.watchlist-snapshot.v1";
  readonly groups: readonly ReplayLaunchWatchlistGroup[];
}

export interface ReplayLaunchContext {
  readonly schema_version: "replay.launch-context.v1";
  readonly source: "LIVE_PAGE" | "DIRECT_HUB";
  readonly exchange: string;
  readonly market_type: string;
  readonly symbol: string;
  readonly display_interval: string;
  readonly watchlist_snapshot: ReplayWatchlistSnapshot;
}

export interface ReplayMarketTracksResponse {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly run_id: string;
  readonly ordering_version: "replay.global-order.v1";
  readonly launch_context: ReplayLaunchContext;
  readonly viewer_state: ReplayViewerState;
  readonly tracks: readonly ReplayTrainingMarketTrack[];
  readonly portfolio: ReplayTrainingPortfolio;
  readonly global_clock: ReplayGlobalClock;
}

export type ReplayV2Json = null | string | boolean | number | readonly ReplayV2Json[] | {
  readonly [key: string]: ReplayV2Json;
};

export interface ReplayV2Command {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly run_id: string;
  readonly command_id: string;
  readonly client_instance_id: string;
  readonly expected_revision: number;
  readonly expected_cursor: ReplayV2Cursor;
  readonly type: ReplayV2CommandType;
  readonly payload: Readonly<Record<string, ReplayV2Json>>;
}

export interface ReplayV2Event {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly run_id: string;
  readonly sequence: number;
  readonly revision: number;
  readonly cursor: ReplayV2Cursor;
  readonly type: ReplayV2EventType;
  readonly time_disclosure_policy: ReplayV2TimeDisclosurePolicy;
  readonly capabilities: Readonly<Partial<Record<ReplayV2CapabilityKind, ReplayV2CapabilityState>>>;
  readonly data: Readonly<Record<string, ReplayV2Json>>;
}

export interface ReplayViewerState {
  readonly run_id: string;
  readonly selected_track_id: string;
  readonly display_interval: string;
  readonly chart_type: string;
  readonly visible_range: Readonly<Record<string, ReplayV2Json>> | null;
  readonly pane_layout: Readonly<Record<string, ReplayV2Json>>;
  readonly rail_layout: Readonly<Record<string, ReplayV2Json>>;
  readonly semantic_view_revision: number;
}

export interface ReplayViewerStateResponse {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly viewer_state: ReplayViewerState;
}

export interface ReplayV2ControlCursor {
  readonly virtual_time_ms: number;
  readonly source_sequence: number;
  readonly last_base_bar_open_ms: number | null;
  readonly last_trade_time_ms: number | null;
  readonly last_agg_trade_id: number | null;
  readonly at_end: boolean;
}

export interface ReplayV2CommandResult {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly run_id: string;
  readonly session_id: string;
  readonly command_id: string;
  readonly revision: number;
  readonly sequence: number;
  readonly state: ReplayV2RunState;
  readonly state_hash: `sha256:${string}`;
  readonly cursor: ReplayV2ControlCursor;
  readonly viewer_state: ReplayViewerState;
  readonly data: Readonly<Record<string, ReplayV2Json>>;
}

export interface ReplayAdvanceProgressResponse {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly run_id: string;
  readonly command_id: string;
  readonly progress: Readonly<Record<string, ReplayV2Json>>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MARKET_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const POSITIVE_CANONICAL_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
const CANONICAL_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
const MAX_TIMESTAMP_MS = 253_402_300_799_999;

function objectValue(value: unknown, fieldName: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactObject(
  value: unknown,
  fieldName: string,
  expected: readonly string[],
): Record<string, unknown> {
  const payload = objectValue(value, fieldName);
  const keys = Object.keys(payload);
  const missing = expected.filter((key) => !Object.hasOwn(payload, key));
  const unknown = keys.filter((key) => !expected.includes(key));
  if (missing.length > 0) throw new TypeError(`${fieldName} missing ${missing.join(", ")}`);
  if (unknown.length > 0) throw new TypeError(`${fieldName} has unknown ${unknown.join(", ")}`);
  return payload;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  fieldName: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new TypeError(`${fieldName} is unsupported`);
  }
  return value as T[number];
}

function identifier(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(`${fieldName} must be a safe identifier`);
  }
  return value;
}

function marketIdentity(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !MARKET_IDENTITY.test(value)) {
    throw new TypeError(`${fieldName} must be a market identity`);
  }
  return value;
}

function counter(value: unknown, fieldName: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer`);
  }
  return value as number;
}

function timestamp(value: unknown, fieldName: string): number {
  const parsed = counter(value, fieldName);
  if (parsed > MAX_TIMESTAMP_MS) throw new TypeError(`${fieldName} is out of range`);
  return parsed;
}

function nullableCounter(value: unknown, fieldName: string): number | null {
  return value === null ? null : counter(value, fieldName);
}

function nullableTimestamp(value: unknown, fieldName: string): number | null {
  return value === null ? null : timestamp(value, fieldName);
}

function digest(value: unknown, fieldName: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${fieldName} must be a canonical SHA-256 digest`);
  }
  return value as `sha256:${string}`;
}

function positiveDecimal(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !POSITIVE_CANONICAL_DECIMAL.test(value) || value === "0") {
    throw new TypeError(`${fieldName} must be a positive canonical Decimal string`);
  }
  return value;
}

function canonicalDecimal(value: unknown, fieldName: string): string {
  if (
    typeof value !== "string"
    || !CANONICAL_DECIMAL.test(value)
    || value === "-0"
  ) {
    throw new TypeError(`${fieldName} must be a canonical Decimal string`);
  }
  return value;
}

function parseCursor(value: unknown, fieldName: string): ReplayV2Cursor {
  const cursor = exactObject(
    value,
    fieldName,
    ["virtual_time_ms", "source_sequence", "revision"],
  );
  return {
    virtual_time_ms: timestamp(cursor.virtual_time_ms, `${fieldName}.virtual_time_ms`),
    source_sequence: counter(cursor.source_sequence, `${fieldName}.source_sequence`),
    revision: counter(cursor.revision, `${fieldName}.revision`),
  };
}

function jsonValue(value: unknown, fieldName: string): ReplayV2Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`${fieldName} cannot contain binary floats or unsafe integers`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child, index) => jsonValue(child, `${fieldName}[${index}]`));
  }
  const payload = objectValue(value, fieldName);
  return Object.fromEntries(
    Object.entries(payload).map(([key, child]) => [key, jsonValue(child, `${fieldName}.${key}`)]),
  );
}

function jsonObject(value: unknown, fieldName: string): Readonly<Record<string, ReplayV2Json>> {
  const payload = objectValue(value, fieldName);
  return Object.fromEntries(
    Object.entries(payload).map(([key, child]) => [key, jsonValue(child, `${fieldName}.${key}`)]),
  );
}

function capabilities(
  value: unknown,
): Readonly<Partial<Record<ReplayV2CapabilityKind, ReplayV2CapabilityState>>> {
  const payload = objectValue(value, "capabilities");
  const parsed: Partial<Record<ReplayV2CapabilityKind, ReplayV2CapabilityState>> = {};
  for (const [rawKind, rawState] of Object.entries(payload)) {
    const kind = enumValue(rawKind, REPLAY_V2_ENUMS.capability_kind, "capability kind");
    parsed[kind] = enumValue(rawState, REPLAY_V2_ENUMS.capability_state, "capability state");
  }
  return parsed;
}

export function parseReplayV2TrainingRun(value: unknown): ReplayV2TrainingRun {
  const run = exactObject(value, "run", [
    "protocol",
    "run_id",
    "state",
    "source_kind",
    "start_mode",
    "book_mode",
    "integrity_mode",
    "time_disclosure_policy",
    "initial_equity",
    "active_rule_revision",
    "cursor",
  ]);
  if (run.protocol !== REPLAY_V2_PROTOCOL) throw new TypeError(`protocol must be ${REPLAY_V2_PROTOCOL}`);
  return {
    protocol: REPLAY_V2_PROTOCOL,
    run_id: identifier(run.run_id, "run_id"),
    state: enumValue(run.state, REPLAY_V2_ENUMS.run_state, "state"),
    source_kind: enumValue(run.source_kind, REPLAY_V2_ENUMS.source_kind, "source_kind"),
    start_mode: enumValue(run.start_mode, REPLAY_V2_ENUMS.start_mode, "start_mode"),
    book_mode: enumValue(run.book_mode, REPLAY_V2_ENUMS.book_mode, "book_mode"),
    integrity_mode: enumValue(run.integrity_mode, REPLAY_V2_ENUMS.integrity_mode, "integrity_mode"),
    time_disclosure_policy: enumValue(
      run.time_disclosure_policy,
      REPLAY_V2_ENUMS.time_disclosure_policy,
      "time_disclosure_policy",
    ),
    initial_equity: positiveDecimal(run.initial_equity, "initial_equity"),
    active_rule_revision: counter(run.active_rule_revision, "active_rule_revision"),
    cursor: parseCursor(run.cursor, "cursor"),
  };
}

export function parseReplayV2MarketTrack(
  value: unknown,
  expectedSource?: ReplayV2SourceKind,
): ReplayV2MarketTrack {
  const track = exactObject(value, "track", [
    "run_id",
    "track_id",
    "state",
    "source_kind",
    "subscription_tier",
    "cursor",
    "forced_full_reasons",
    "capabilities",
  ]);
  const sourceKind = enumValue(track.source_kind, REPLAY_V2_ENUMS.source_kind, "source_kind");
  if (expectedSource !== undefined && sourceKind !== expectedSource) {
    throw new TypeError("track source_kind must match TrainingRun source_kind");
  }
  if (!Array.isArray(track.forced_full_reasons)) {
    throw new TypeError("forced_full_reasons must be an array");
  }
  const reasons = track.forced_full_reasons.map((reason) => identifier(reason, "forced_full_reasons"));
  if (new Set(reasons).size !== reasons.length) {
    throw new TypeError("forced_full_reasons must be unique");
  }
  return {
    run_id: identifier(track.run_id, "run_id"),
    track_id: identifier(track.track_id, "track_id"),
    state: enumValue(track.state, REPLAY_V2_ENUMS.track_state, "state"),
    source_kind: sourceKind,
    subscription_tier: enumValue(
      track.subscription_tier,
      REPLAY_V2_ENUMS.subscription_tier,
      "subscription_tier",
    ),
    cursor: parseCursor(track.cursor, "cursor"),
    forced_full_reasons: reasons,
    capabilities: capabilities(track.capabilities),
  };
}

function parseReplayTrainingMarketTrack(value: unknown): ReplayTrainingMarketTrack {
  const track = exactObject(value, "market track", [
    "run_id",
    "track_id",
    "stable_ordinal",
    "adapter_session_id",
    "exchange",
    "market_type",
    "symbol",
    "settlement_asset",
    "state",
    "source_kind",
    "subscription_tier",
    "cursor",
    "forced_full_reasons",
    "capabilities",
    "public_price",
    "position",
    "open_order_count",
    "degraded_reason",
    "account",
    "historical_book",
  ]);
  const tier = enumValue(
    track.subscription_tier,
    REPLAY_V2_ENUMS.subscription_tier,
    "market track.subscription_tier",
  );
  const adapterSessionId = nullableIdentifier(
    track.adapter_session_id,
    "market track.adapter_session_id",
  );
  const cursor = track.cursor === null ? null : parseCursor(track.cursor, "market track.cursor");
  if (tier === "FULL" && cursor === null) {
    throw new TypeError("FULL market track requires a cursor");
  }
  if (adapterSessionId === null && (tier !== "NONE" || cursor !== null)) {
    throw new TypeError("unprepared market track must remain NONE without a cursor");
  }
  if (!Array.isArray(track.forced_full_reasons)) {
    throw new TypeError("market track.forced_full_reasons must be an array");
  }
  const reasons = track.forced_full_reasons.map((reason) => (
    identifier(reason, "market track.forced_full_reasons")
  ));
  if (new Set(reasons).size !== reasons.length) {
    throw new TypeError("market track.forced_full_reasons must be unique");
  }
  if (reasons.length > 0 && tier !== "FULL") {
    throw new TypeError("forced market track must remain FULL");
  }
  const degradedReason = track.degraded_reason;
  if (degradedReason !== null && (
    typeof degradedReason !== "string"
    || degradedReason.length < 1
    || degradedReason.length > 500
  )) {
    throw new TypeError("market track.degraded_reason is invalid");
  }
  return {
    run_id: identifier(track.run_id, "market track.run_id"),
    track_id: identifier(track.track_id, "market track.track_id"),
    stable_ordinal: counter(track.stable_ordinal, "market track.stable_ordinal"),
    adapter_session_id: adapterSessionId,
    exchange: identifier(track.exchange, "market track.exchange"),
    market_type: identifier(track.market_type, "market track.market_type"),
    symbol: identifier(track.symbol, "market track.symbol"),
    settlement_asset: identifier(track.settlement_asset, "market track.settlement_asset"),
    state: enumValue(track.state, REPLAY_V2_ENUMS.track_state, "market track.state"),
    source_kind: enumValue(
      track.source_kind,
      REPLAY_V2_ENUMS.source_kind,
      "market track.source_kind",
    ),
    subscription_tier: tier,
    cursor,
    forced_full_reasons: reasons,
    capabilities: capabilities(track.capabilities),
    public_price: track.public_price === null
      ? null
      : positiveDecimal(track.public_price, "market track.public_price"),
    position: jsonObject(track.position, "market track.position"),
    open_order_count: counter(track.open_order_count, "market track.open_order_count"),
    degraded_reason: degradedReason,
    account: jsonObject(track.account, "market track.account"),
    historical_book: parseHistoricalBookProjection(track.historical_book),
  };
}

function parseHistoricalBookProjection(value: unknown): ReplayHistoricalBookProjection {
  const book = exactObject(value, "market track.historical_book", [
    "mode",
    "capability_state",
    "status",
    "execution_fidelity",
    "queue_exact",
    "as_of_virtual_time_ms",
    "last_update_id",
    "bids",
    "asks",
    "book_hash",
    "message",
  ]);
  const mode = enumValue(book.mode, REPLAY_V2_ENUMS.book_mode, "historical book.mode");
  const capabilityState = enumValue(
    book.capability_state,
    REPLAY_V2_ENUMS.capability_state,
    "historical book.capability_state",
  );
  if (!["OFF", "READY", "CLEARED", "DISABLED"].includes(String(book.status))) {
    throw new TypeError("historical book.status is unsupported");
  }
  if (book.execution_fidelity !== "NO_BOOK_TOUCH_OR_TAPE_APPROX"
    && book.execution_fidelity !== "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE") {
    throw new TypeError("historical book execution fidelity is unsupported");
  }
  if (book.queue_exact !== false || !Array.isArray(book.bids) || !Array.isArray(book.asks)) {
    throw new TypeError("historical book queue/level contract is unsupported");
  }
  const levels = (items: readonly unknown[], field: string) => items.map((item, index) => {
    if (!Array.isArray(item) || item.length !== 2) {
      throw new TypeError(`${field}[${index}] must be [price, quantity]`);
    }
    return [
      positiveDecimal(item[0], `${field}[${index}].price`),
      positiveDecimal(item[1], `${field}[${index}].quantity`),
    ] as const;
  });
  const bids = levels(book.bids, "historical book.bids");
  const asks = levels(book.asks, "historical book.asks");
  const asOf = book.as_of_virtual_time_ms === null
    ? null
    : timestamp(book.as_of_virtual_time_ms, "historical book.as_of_virtual_time_ms");
  const lastUpdateId = book.last_update_id === null
    ? null
    : counter(book.last_update_id, "historical book.last_update_id");
  const bookHash = book.book_hash === null ? null : digest(book.book_hash, "historical book.book_hash");
  if (typeof book.message !== "string" || book.message.length > 500) {
    throw new TypeError("historical book.message is invalid");
  }
  if (book.status === "READY") {
    if (mode !== "BOOK_ASSISTED_REQUIRED"
      || capabilityState !== "AVAILABLE_EXACT"
      || asOf === null
      || lastUpdateId === null
      || bookHash === null
      || bids.length === 0
      || asks.length === 0) {
      throw new TypeError("READY historical book projection is incomplete");
    }
  } else if (bids.length > 0 || asks.length > 0 || bookHash !== null) {
    throw new TypeError("non-ready historical book must be visibly cleared");
  }
  return {
    mode,
    capability_state: capabilityState,
    status: book.status as ReplayHistoricalBookProjection["status"],
    execution_fidelity: book.execution_fidelity,
    queue_exact: false,
    as_of_virtual_time_ms: asOf,
    last_update_id: lastUpdateId,
    bids,
    asks,
    book_hash: bookHash,
    message: book.message,
  };
}

function parseReplayTrainingPortfolio(value: unknown): ReplayTrainingPortfolio {
  if (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as { schema_version?: unknown }).schema_version === "replay.training.portfolio.v2"
  ) {
    const portfolio = exactObject(value, "portfolio", [
      "schema_version",
      "account_model",
      "execution_model",
      "execution_fidelity",
      "settlement_account_shared",
      "margin_mode",
      "funding_mode",
      "status",
      "initial_equity",
      "cash_balance",
      "equity",
      "available_equity",
      "reserved_margin",
      "margin_used",
      "maintenance_margin",
      "realized_pnl",
      "unrealized_pnl",
      "fees_paid",
      "funding_cashflow",
      "liquidation_fees_paid",
      "risk_ratio",
      "positions",
      "orders",
      "fills",
      "active_fee_policy",
      "instrument_rules",
      "isolated_allocations",
      "next_funding_time_ms",
      "liquidations",
      "ledger",
      "fidelity",
    ]);
    if (
      portfolio.account_model !== "TOUCH_OR_TAPE_V2"
      || portfolio.execution_model !== "TOUCH_OR_TAPE_V2"
      || (portfolio.execution_fidelity !== "NO_BOOK_TOUCH_OR_TAPE_APPROX"
        && portfolio.execution_fidelity !== "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE")
      || typeof portfolio.settlement_account_shared !== "boolean"
      || !["ACTIVE", "LIQUIDATING", "BANKRUPT"].includes(String(portfolio.status))
    ) {
      throw new TypeError("contract portfolio identity is unsupported");
    }
    const objectList = (items: unknown, field: string): unknown[] => {
      if (!Array.isArray(items)) throw new TypeError(`${field} must be an array`);
      return items;
    };
    const rawPositions = objectList(portfolio.positions, "portfolio.positions");
    const rawOrders = objectList(portfolio.orders, "portfolio.orders");
    const rawFills = objectList(portfolio.fills, "portfolio.fills");
    const rawRules = objectList(portfolio.instrument_rules, "portfolio.instrument_rules");
    const rawLiquidations = objectList(portfolio.liquidations, "portfolio.liquidations");
    const positions = rawPositions.map((position, index) => {
      const field = `portfolio.positions[${index}]`;
      const item = exactObject(position, field, [
        "track_id",
        "symbol",
        "position",
        "maintenance_margin",
        "isolated_margin",
        "margin_equity",
        "risk_ratio",
        "rule_revision",
        "rule_hash",
        "mark_fidelity",
      ]);
      return {
        track_id: identifier(item.track_id, `${field}.track_id`),
        symbol: identifier(item.symbol, `${field}.symbol`),
        position: jsonObject(item.position, `${field}.position`),
        maintenance_margin: canonicalDecimal(
          item.maintenance_margin,
          `${field}.maintenance_margin`,
        ),
        isolated_margin: canonicalDecimal(item.isolated_margin, `${field}.isolated_margin`),
        margin_equity: canonicalDecimal(item.margin_equity, `${field}.margin_equity`),
        risk_ratio: item.risk_ratio === null
          ? null
          : canonicalDecimal(item.risk_ratio, `${field}.risk_ratio`),
        rule_revision: counter(item.rule_revision, `${field}.rule_revision`),
        rule_hash: digest(item.rule_hash, `${field}.rule_hash`),
        mark_fidelity: identifier(item.mark_fidelity, `${field}.mark_fidelity`),
      };
    });
    const objectArray = (items: readonly unknown[], field: string) => items.map((item, index) => (
      jsonObject(item, `${field}[${index}]`)
    ));
    return {
      schema_version: "replay.training.portfolio.v2",
      account_model: "TOUCH_OR_TAPE_V2",
      execution_model: "TOUCH_OR_TAPE_V2",
      execution_fidelity: portfolio.execution_fidelity,
      settlement_account_shared: portfolio.settlement_account_shared,
      margin_mode: enumValue(portfolio.margin_mode, REPLAY_V2_ENUMS.margin_mode, "portfolio.margin_mode"),
      funding_mode: enumValue(portfolio.funding_mode, REPLAY_V2_ENUMS.funding_mode, "portfolio.funding_mode"),
      status: portfolio.status as "ACTIVE" | "LIQUIDATING" | "BANKRUPT",
      initial_equity: positiveDecimal(portfolio.initial_equity, "portfolio.initial_equity"),
      cash_balance: canonicalDecimal(portfolio.cash_balance, "portfolio.cash_balance"),
      equity: canonicalDecimal(portfolio.equity, "portfolio.equity"),
      available_equity: canonicalDecimal(portfolio.available_equity, "portfolio.available_equity"),
      reserved_margin: canonicalDecimal(portfolio.reserved_margin, "portfolio.reserved_margin"),
      margin_used: canonicalDecimal(portfolio.margin_used, "portfolio.margin_used"),
      maintenance_margin: canonicalDecimal(portfolio.maintenance_margin, "portfolio.maintenance_margin"),
      realized_pnl: canonicalDecimal(portfolio.realized_pnl, "portfolio.realized_pnl"),
      unrealized_pnl: canonicalDecimal(portfolio.unrealized_pnl, "portfolio.unrealized_pnl"),
      fees_paid: canonicalDecimal(portfolio.fees_paid, "portfolio.fees_paid"),
      funding_cashflow: canonicalDecimal(portfolio.funding_cashflow, "portfolio.funding_cashflow"),
      liquidation_fees_paid: canonicalDecimal(
        portfolio.liquidation_fees_paid,
        "portfolio.liquidation_fees_paid",
      ),
      risk_ratio: portfolio.risk_ratio === null
        ? null
        : canonicalDecimal(portfolio.risk_ratio, "portfolio.risk_ratio"),
      positions,
      orders: objectArray(rawOrders, "portfolio.orders"),
      fills: objectArray(rawFills, "portfolio.fills"),
      active_fee_policy: portfolio.active_fee_policy === null
        ? null
        : jsonObject(portfolio.active_fee_policy, "portfolio.active_fee_policy"),
      instrument_rules: objectArray(rawRules, "portfolio.instrument_rules"),
      isolated_allocations: jsonObject(portfolio.isolated_allocations, "portfolio.isolated_allocations"),
      next_funding_time_ms: portfolio.next_funding_time_ms === null
        ? null
        : counter(portfolio.next_funding_time_ms, "portfolio.next_funding_time_ms"),
      liquidations: objectArray(rawLiquidations, "portfolio.liquidations"),
      ledger: jsonObject(portfolio.ledger, "portfolio.ledger"),
      fidelity: jsonObject(portfolio.fidelity, "portfolio.fidelity"),
    };
  }
  const portfolio = exactObject(value, "portfolio", [
    "schema_version",
    "fidelity",
    "settlement_account_shared",
    "initial_equity",
    "equity",
    "cash_balance",
    "available_equity",
    "reserved_margin",
    "margin_used",
    "realized_pnl",
    "unrealized_pnl",
    "fees_paid",
    "positions",
  ]);
  if (
    portfolio.schema_version !== "replay.training.portfolio.v1"
    || portfolio.fidelity !== "PAPER_LINEAR_V1_MULTI_TRACK_ADAPTER"
    || portfolio.settlement_account_shared !== true
  ) {
    throw new TypeError("portfolio contract is unsupported");
  }
  if (!Array.isArray(portfolio.positions)) {
    throw new TypeError("portfolio.positions must be an array");
  }
  return {
    schema_version: "replay.training.portfolio.v1",
    fidelity: "PAPER_LINEAR_V1_MULTI_TRACK_ADAPTER",
    settlement_account_shared: true,
    initial_equity: positiveDecimal(portfolio.initial_equity, "portfolio.initial_equity"),
    equity: canonicalDecimal(portfolio.equity, "portfolio.equity"),
    cash_balance: canonicalDecimal(portfolio.cash_balance, "portfolio.cash_balance"),
    available_equity: canonicalDecimal(
      portfolio.available_equity,
      "portfolio.available_equity",
    ),
    reserved_margin: canonicalDecimal(portfolio.reserved_margin, "portfolio.reserved_margin"),
    margin_used: canonicalDecimal(portfolio.margin_used, "portfolio.margin_used"),
    realized_pnl: canonicalDecimal(portfolio.realized_pnl, "portfolio.realized_pnl"),
    unrealized_pnl: canonicalDecimal(portfolio.unrealized_pnl, "portfolio.unrealized_pnl"),
    fees_paid: canonicalDecimal(portfolio.fees_paid, "portfolio.fees_paid"),
    positions: portfolio.positions.map((position, index) => {
      const field = `portfolio.positions[${index}]`;
      const item = exactObject(position, field, ["track_id", "symbol", "position"]);
      return {
        track_id: identifier(item.track_id, `${field}.track_id`),
        symbol: identifier(item.symbol, `${field}.symbol`),
        position: jsonObject(item.position, `${field}.position`),
      };
    }),
  };
}

export function parseReplayMarketTracksResponse(value: unknown): ReplayMarketTracksResponse {
  const response = exactObject(value, "market tracks response", [
    "protocol",
    "run_id",
    "ordering_version",
    "launch_context",
    "viewer_state",
    "tracks",
    "portfolio",
    "global_clock",
  ]);
  if (
    response.protocol !== REPLAY_V2_PROTOCOL
    || response.ordering_version !== "replay.global-order.v1"
  ) {
    throw new TypeError("market tracks response contract is unsupported");
  }
  if (!Array.isArray(response.tracks)) {
    throw new TypeError("market tracks response.tracks must be an array");
  }
  const runId = identifier(response.run_id, "market tracks response.run_id");
  const viewer = parseReplayViewerState(response.viewer_state);
  const tracks = response.tracks.map(parseReplayTrainingMarketTrack);
  const launchContext = parseReplayLaunchContext(response.launch_context);
  const primaryTrack = tracks.find((track) => track.stable_ordinal === 1) ?? null;
  if (
    viewer.run_id !== runId
    || tracks.some((track) => track.run_id !== runId)
    || !tracks.some((track) => track.track_id === viewer.selected_track_id)
    || primaryTrack === null
    || primaryTrack.exchange !== launchContext.exchange
    || primaryTrack.market_type !== launchContext.market_type
    || primaryTrack.symbol !== launchContext.symbol
  ) {
    throw new TypeError("market tracks response run/viewer identity is inconsistent");
  }
  return {
    protocol: REPLAY_V2_PROTOCOL,
    run_id: runId,
    ordering_version: "replay.global-order.v1",
    launch_context: launchContext,
    viewer_state: viewer,
    tracks,
    portfolio: parseReplayTrainingPortfolio(response.portfolio),
    global_clock: parseReplayGlobalClock(response.global_clock),
  };
}

export function parseReplayLaunchContext(value: unknown): ReplayLaunchContext {
  const context = exactObject(value, "replay launch context", [
    "schema_version",
    "source",
    "exchange",
    "market_type",
    "symbol",
    "display_interval",
    "watchlist_snapshot",
  ]);
  if (
    context.schema_version !== "replay.launch-context.v1"
    || (context.source !== "LIVE_PAGE" && context.source !== "DIRECT_HUB")
  ) {
    throw new TypeError("replay launch context contract is unsupported");
  }
  const snapshot = exactObject(context.watchlist_snapshot, "watchlist snapshot", [
    "schema_version",
    "groups",
  ]);
  if (
    snapshot.schema_version !== "replay.watchlist-snapshot.v1"
    || !Array.isArray(snapshot.groups)
    || snapshot.groups.length > 32
  ) {
    throw new TypeError("watchlist snapshot contract is unsupported");
  }
  let itemCount = 0;
  const groupIds = new Set<string>();
  const groups = snapshot.groups.map((value, groupIndex) => {
    const field = `watchlist snapshot.groups[${groupIndex}]`;
    const group = exactObject(value, field, ["id", "name", "color", "items"]);
    const id = identifier(group.id, `${field}.id`);
    if (groupIds.has(id)) throw new TypeError("watchlist snapshot group ids must be unique");
    groupIds.add(id);
    if (!Array.isArray(group.items)) throw new TypeError(`${field}.items must be an array`);
    const identities = new Set<string>();
    const items = group.items.map((value, itemIndex) => {
      const itemField = `${field}.items[${itemIndex}]`;
      const item = exactObject(value, itemField, ["exchange", "market_type", "symbol"]);
      const parsed = {
        exchange: marketIdentity(item.exchange, `${itemField}.exchange`),
        market_type: marketIdentity(item.market_type, `${itemField}.market_type`),
        symbol: marketIdentity(item.symbol, `${itemField}.symbol`),
      };
      const key = `${parsed.exchange}\u0000${parsed.market_type}\u0000${parsed.symbol}`;
      if (identities.has(key)) {
        throw new TypeError("watchlist snapshot group items must be unique");
      }
      identities.add(key);
      itemCount += 1;
      return parsed;
    });
    return {
      id,
      name: displayString(group.name, `${field}.name`, 80),
      color: displayString(group.color, `${field}.color`, 32),
      items,
    };
  });
  if (itemCount > 100) throw new TypeError("watchlist snapshot cannot exceed 100 items");
  return {
    schema_version: "replay.launch-context.v1",
    source: context.source,
    exchange: marketIdentity(context.exchange, "replay launch context.exchange"),
    market_type: marketIdentity(
      context.market_type,
      "replay launch context.market_type",
    ),
    symbol: marketIdentity(context.symbol, "replay launch context.symbol"),
    display_interval: identifier(
      context.display_interval,
      "replay launch context.display_interval",
    ),
    watchlist_snapshot: {
      schema_version: "replay.watchlist-snapshot.v1",
      groups,
    },
  };
}

function parseReplayGlobalClock(value: unknown): ReplayGlobalClock {
  const clock = exactObject(value, "global clock", [
    "contract",
    "mode",
    "state",
    "basis",
    "rate",
    "speed",
    "display_interval",
    "viewer_revision",
    "profile_revision",
    "reason",
    "generation",
    "tick",
    "supported_bases",
    "playback_bases",
    "max_count",
    "virtual_time_quantum_ms",
  ]);
  if (clock.contract !== "replay.playback.v1") {
    throw new TypeError("global clock contract is unsupported");
  }
  if (clock.mode !== "ADAPTER" && clock.mode !== "ORDERED") {
    throw new TypeError("global clock mode is unsupported");
  }
  const state = enumValue(
    clock.state,
    REPLAY_V2_ENUMS.run_state,
    "global clock state",
  );
  const basis = enumValue(
    clock.basis,
    REPLAY_V2_ENUMS.advance_basis,
    "global clock basis",
  );
  const rate = counter(clock.rate, "global clock rate");
  if (rate < 1 || rate > 10_000 || clock.speed !== rate) {
    throw new TypeError("global clock rate/speed alias is unsupported");
  }
  const displayInterval = clock.display_interval === null
    ? null
    : identifier(clock.display_interval, "global clock display_interval");
  const viewerRevision = clock.viewer_revision === null
    ? null
    : counter(clock.viewer_revision, "global clock viewer_revision");
  if (
    (basis === "DISPLAY_BAR")
      !== (displayInterval !== null && viewerRevision !== null)
  ) {
    throw new TypeError("global clock display binding does not match its basis");
  }
  if (clock.reason !== null && typeof clock.reason !== "string") {
    throw new TypeError("global clock reason must be a string or null");
  }
  if (!Array.isArray(clock.supported_bases) || !Array.isArray(clock.playback_bases)) {
    throw new TypeError("global clock basis capabilities must be arrays");
  }
  const supportedBases = clock.supported_bases.map((item) => enumValue(
    item,
    REPLAY_V2_ENUMS.advance_basis,
    "global clock supported basis",
  ));
  const playbackBases = clock.playback_bases.map((item) => enumValue(
    item,
    REPLAY_V2_ENUMS.advance_basis,
    "global clock playback basis",
  ));
  if (
    new Set(supportedBases).size !== supportedBases.length
    || new Set(playbackBases).size !== playbackBases.length
    || playbackBases.some((item) => !supportedBases.includes(item))
    || !playbackBases.includes(basis)
  ) {
    throw new TypeError("global clock basis capabilities are inconsistent");
  }
  const maxCount = counter(clock.max_count, "global clock max_count");
  const quantum = counter(
    clock.virtual_time_quantum_ms,
    "global clock virtual_time_quantum_ms",
  );
  if (maxCount < 1 || quantum < 1) {
    throw new TypeError("global clock limits must be positive");
  }
  return {
    contract: "replay.playback.v1",
    mode: clock.mode,
    state,
    basis,
    rate,
    speed: rate,
    display_interval: displayInterval,
    viewer_revision: viewerRevision,
    profile_revision: counter(
      clock.profile_revision,
      "global clock profile_revision",
    ),
    reason: clock.reason,
    generation: counter(clock.generation, "global clock generation"),
    tick: counter(clock.tick, "global clock tick"),
    supported_bases: supportedBases,
    playback_bases: playbackBases,
    max_count: maxCount,
    virtual_time_quantum_ms: quantum,
  };
}

export function parseReplayV2Command(value: unknown): ReplayV2Command {
  const command = exactObject(value, "command", [
    "protocol",
    "run_id",
    "command_id",
    "client_instance_id",
    "expected_revision",
    "expected_cursor",
    "type",
    "payload",
  ]);
  if (command.protocol !== REPLAY_V2_PROTOCOL) {
    throw new TypeError(`protocol must be ${REPLAY_V2_PROTOCOL}`);
  }
  const expectedRevision = counter(command.expected_revision, "expected_revision");
  const expectedCursor = parseCursor(command.expected_cursor, "expected_cursor");
  if (expectedCursor.revision !== expectedRevision) {
    throw new TypeError("expected_cursor.revision must equal expected_revision");
  }
  return {
    protocol: REPLAY_V2_PROTOCOL,
    run_id: identifier(command.run_id, "run_id"),
    command_id: identifier(command.command_id, "command_id"),
    client_instance_id: identifier(command.client_instance_id, "client_instance_id"),
    expected_revision: expectedRevision,
    expected_cursor: expectedCursor,
    type: enumValue(command.type, REPLAY_V2_ENUMS.command_type, "command type"),
    payload: jsonObject(command.payload, "payload"),
  };
}

export function parseReplayViewerState(value: unknown): ReplayViewerState {
  const viewer = exactObject(value, "viewer_state", [
    "run_id",
    "selected_track_id",
    "display_interval",
    "chart_type",
    "visible_range",
    "pane_layout",
    "rail_layout",
    "semantic_view_revision",
  ]);
  return {
    run_id: identifier(viewer.run_id, "viewer_state.run_id"),
    selected_track_id: identifier(viewer.selected_track_id, "viewer_state.selected_track_id"),
    display_interval: identifier(viewer.display_interval, "viewer_state.display_interval"),
    chart_type: identifier(viewer.chart_type, "viewer_state.chart_type"),
    visible_range: viewer.visible_range === null
      ? null
      : jsonObject(viewer.visible_range, "viewer_state.visible_range"),
    pane_layout: jsonObject(viewer.pane_layout, "viewer_state.pane_layout"),
    rail_layout: jsonObject(viewer.rail_layout, "viewer_state.rail_layout"),
    semantic_view_revision: counter(
      viewer.semantic_view_revision,
      "viewer_state.semantic_view_revision",
    ),
  };
}

export function parseReplayViewerStateResponse(value: unknown): ReplayViewerStateResponse {
  const response = exactObject(value, "viewer response", ["protocol", "viewer_state"]);
  if (response.protocol !== REPLAY_V2_PROTOCOL) {
    throw new TypeError(`protocol must be ${REPLAY_V2_PROTOCOL}`);
  }
  return {
    protocol: REPLAY_V2_PROTOCOL,
    viewer_state: parseReplayViewerState(response.viewer_state),
  };
}

function parseControlCursor(value: unknown): ReplayV2ControlCursor {
  const cursor = exactObject(value, "command result.cursor", [
    "virtual_time_ms",
    "source_sequence",
    "last_base_bar_open_ms",
    "last_trade_time_ms",
    "last_agg_trade_id",
    "at_end",
  ]);
  return {
    virtual_time_ms: timestamp(cursor.virtual_time_ms, "command result.cursor.virtual_time_ms"),
    source_sequence: counter(cursor.source_sequence, "command result.cursor.source_sequence"),
    last_base_bar_open_ms: nullableTimestamp(
      cursor.last_base_bar_open_ms,
      "command result.cursor.last_base_bar_open_ms",
    ),
    last_trade_time_ms: nullableTimestamp(
      cursor.last_trade_time_ms,
      "command result.cursor.last_trade_time_ms",
    ),
    last_agg_trade_id: nullableCounter(
      cursor.last_agg_trade_id,
      "command result.cursor.last_agg_trade_id",
    ),
    at_end: boolValue(cursor.at_end, "command result.cursor.at_end"),
  };
}

export function parseReplayV2CommandResult(value: unknown): ReplayV2CommandResult {
  const result = exactObject(value, "command result", [
    "protocol",
    "run_id",
    "session_id",
    "command_id",
    "revision",
    "sequence",
    "state",
    "state_hash",
    "cursor",
    "viewer_state",
    "data",
  ]);
  if (result.protocol !== REPLAY_V2_PROTOCOL) {
    throw new TypeError(`protocol must be ${REPLAY_V2_PROTOCOL}`);
  }
  return {
    protocol: REPLAY_V2_PROTOCOL,
    run_id: identifier(result.run_id, "command result.run_id"),
    session_id: identifier(result.session_id, "command result.session_id"),
    command_id: identifier(result.command_id, "command result.command_id"),
    revision: counter(result.revision, "command result.revision"),
    sequence: counter(result.sequence, "command result.sequence"),
    state: enumValue(result.state, REPLAY_V2_ENUMS.run_state, "command result.state"),
    state_hash: digest(result.state_hash, "command result.state_hash"),
    cursor: parseControlCursor(result.cursor),
    viewer_state: parseReplayViewerState(result.viewer_state),
    data: jsonObject(result.data, "command result.data"),
  };
}

export function parseReplayAdvanceProgressResponse(value: unknown): ReplayAdvanceProgressResponse {
  const response = exactObject(value, "advance progress", [
    "protocol", "run_id", "command_id", "progress",
  ]);
  if (response.protocol !== REPLAY_V2_PROTOCOL) {
    throw new TypeError(`protocol must be ${REPLAY_V2_PROTOCOL}`);
  }
  return {
    protocol: REPLAY_V2_PROTOCOL,
    run_id: identifier(response.run_id, "advance progress.run_id"),
    command_id: identifier(response.command_id, "advance progress.command_id"),
    progress: jsonObject(response.progress, "advance progress.progress"),
  };
}

const DISCLOSURE_RANK = new Map(
  REPLAY_V2_ENUMS.time_disclosure_policy.map((policy, rank) => [policy, rank]),
);

export function assertReplayV2NoDisclosureDowngrade(
  authoritative: ReplayV2TimeDisclosurePolicy,
  candidate: ReplayV2TimeDisclosurePolicy,
): void {
  const authoritativeRank = DISCLOSURE_RANK.get(authoritative);
  const candidateRank = DISCLOSURE_RANK.get(candidate);
  if (authoritativeRank === undefined || candidateRank === undefined) {
    throw new TypeError("time_disclosure_policy is unsupported");
  }
  if (candidateRank < authoritativeRank) {
    throw new TypeError("time_disclosure_policy downgrade requires an audited reveal event");
  }
}

export function parseReplayV2Event(
  value: unknown,
  authoritativePolicy?: ReplayV2TimeDisclosurePolicy,
): ReplayV2Event {
  const event = exactObject(value, "event", [
    "protocol",
    "run_id",
    "sequence",
    "revision",
    "cursor",
    "type",
    "time_disclosure_policy",
    "capabilities",
    "data",
  ]);
  if (event.protocol !== REPLAY_V2_PROTOCOL) throw new TypeError(`protocol must be ${REPLAY_V2_PROTOCOL}`);
  const sequence = counter(event.sequence, "sequence");
  if (sequence === 0) throw new TypeError("sequence must be positive");
  const revision = counter(event.revision, "revision");
  const cursor = parseCursor(event.cursor, "cursor");
  if (cursor.revision !== revision) throw new TypeError("cursor.revision must equal event revision");
  const policy = enumValue(
    event.time_disclosure_policy,
    REPLAY_V2_ENUMS.time_disclosure_policy,
    "time_disclosure_policy",
  );
  if (authoritativePolicy !== undefined) {
    assertReplayV2NoDisclosureDowngrade(authoritativePolicy, policy);
  }
  return {
    protocol: REPLAY_V2_PROTOCOL,
    run_id: identifier(event.run_id, "run_id"),
    sequence,
    revision,
    cursor,
    type: enumValue(event.type, REPLAY_V2_ENUMS.event_type, "event type"),
    time_disclosure_policy: policy,
    capabilities: capabilities(event.capabilities),
    data: jsonObject(event.data, "data"),
  };
}

export type TrainingRunKind = "V2" | "LEGACY_V1";
export type TrainingRunCompatibility = "READY" | "LEGACY_ADAPTER" | "LEGACY_V1" | "UNAVAILABLE";
export type TrainingRunResumeAction = "OPEN_ADAPTER" | "OPEN_V1" | "UNAVAILABLE";
export type TrainingRunEquityStatus = "CURRENT" | "STALE" | "UNAVAILABLE";

export interface TrainingRunCard {
  readonly run_id: string;
  readonly kind: TrainingRunKind;
  readonly name: string;
  readonly state: ReplayV2RunState;
  readonly source_kind: ReplayV2SourceKind;
  readonly integrity_mode: ReplayV2IntegrityMode | null;
  readonly time_disclosure_policy: ReplayV2TimeDisclosurePolicy;
  readonly last_symbol: string;
  readonly subscribed_track_count: number;
  readonly progress: { readonly source_sequence: number };
  readonly equity: string | null;
  readonly equity_status: TrainingRunEquityStatus;
  readonly settlement_asset: string;
  readonly updated_at_ms: number;
  readonly compatibility: TrainingRunCompatibility;
  readonly resume_action: TrainingRunResumeAction;
  readonly adapter_session_id: string;
  readonly parent_legacy_session_id: string | null;
  readonly status: { readonly code: string; readonly message: string };
  readonly report_available: boolean;
  readonly review_available: boolean;
}

export interface TrainingRunListResponse {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly schema_version: "replay.training.v1";
  readonly items: readonly TrainingRunCard[];
  readonly next_cursor: string | null;
}

export interface TrainingRunMutationResponse {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly created: boolean;
  readonly migrated: boolean;
  readonly run: TrainingRunCard;
}

export interface TrainingRunReturnResponse {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly run_id: string;
  readonly state: "PAUSED";
  readonly checkpointed: boolean;
  readonly released: boolean;
}

export interface TrainingRunCreatePayload {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly catalog_epoch: string;
  readonly name: string | null;
  readonly source_kind: ReplayV2SourceKind;
  readonly start_mode: ReplayV2StartMode;
  readonly exchange: string;
  readonly market_type: string;
  readonly symbol: string;
  readonly settlement_asset: string;
  readonly base_interval: string;
  readonly display_interval: string;
  readonly requested_start_ms: number | null;
  readonly warmup_bars: number;
  readonly forward_cache_ms: number;
  readonly random_seed: number | null;
  readonly initial_equity: string;
  readonly max_leverage: string;
  readonly maker_fee_bps: string;
  readonly taker_fee_bps: string;
  readonly market_slippage_bps: string;
  readonly integrity_mode: ReplayV2IntegrityMode;
  readonly time_disclosure_policy: ReplayV2TimeDisclosurePolicy;
  readonly book_mode: ReplayV2BookMode;
  readonly margin_mode: EnumValue<typeof REPLAY_V2_ENUMS.margin_mode>;
  readonly funding_mode: EnumValue<typeof REPLAY_V2_ENUMS.funding_mode>;
  readonly fixed_funding_rate: string | null;
  readonly funding_interval_ms: number | null;
  readonly allow_rule_changes: boolean;
  readonly allowed_mutations: readonly Extract<ReplayV2CommandType,
    | "deposit"
    | "withdraw"
    | "change_fee_policy"
    | "change_leverage_cap"
    | "change_funding_policy"
    | "reveal_time"
  >[];
  readonly launch_context?: ReplayLaunchContext | null;
}

function displayString(value: unknown, fieldName: string, maxLength = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new TypeError(`${fieldName} must be a non-empty bounded string`);
  }
  return value;
}

function boolValue(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${fieldName} must be boolean`);
  return value;
}

function nullableIdentifier(value: unknown, fieldName: string): string | null {
  return value === null ? null : identifier(value, fieldName);
}

function nullableCanonicalDecimal(value: unknown, fieldName: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !POSITIVE_CANONICAL_DECIMAL.test(value)) {
    throw new TypeError(`${fieldName} must be a canonical Decimal string or null`);
  }
  return value;
}

function parseTrainingRunCard(value: unknown, fieldName: string): TrainingRunCard {
  const card = exactObject(value, fieldName, [
    "run_id",
    "kind",
    "name",
    "state",
    "source_kind",
    "integrity_mode",
    "time_disclosure_policy",
    "last_symbol",
    "subscribed_track_count",
    "progress",
    "equity",
    "equity_status",
    "settlement_asset",
    "updated_at_ms",
    "compatibility",
    "resume_action",
    "adapter_session_id",
    "parent_legacy_session_id",
    "status",
    "report_available",
    "review_available",
  ]);
  const kind = enumValue(card.kind, enumValues("V2", "LEGACY_V1"), `${fieldName}.kind`);
  const integrityMode = card.integrity_mode === null
    ? null
    : enumValue(card.integrity_mode, REPLAY_V2_ENUMS.integrity_mode, `${fieldName}.integrity_mode`);
  if ((kind === "V2") !== (integrityMode !== null)) {
    throw new TypeError(`${fieldName}.integrity_mode does not match run kind`);
  }
  const progress = exactObject(card.progress, `${fieldName}.progress`, ["source_sequence"]);
  const status = exactObject(card.status, `${fieldName}.status`, ["code", "message"]);
  return {
    run_id: identifier(card.run_id, `${fieldName}.run_id`),
    kind,
    name: displayString(card.name, `${fieldName}.name`),
    state: enumValue(card.state, REPLAY_V2_ENUMS.run_state, `${fieldName}.state`),
    source_kind: enumValue(card.source_kind, REPLAY_V2_ENUMS.source_kind, `${fieldName}.source_kind`),
    integrity_mode: integrityMode,
    time_disclosure_policy: enumValue(
      card.time_disclosure_policy,
      REPLAY_V2_ENUMS.time_disclosure_policy,
      `${fieldName}.time_disclosure_policy`,
    ),
    last_symbol: identifier(card.last_symbol, `${fieldName}.last_symbol`),
    subscribed_track_count: counter(card.subscribed_track_count, `${fieldName}.subscribed_track_count`),
    progress: { source_sequence: counter(progress.source_sequence, `${fieldName}.progress.source_sequence`) },
    equity: nullableCanonicalDecimal(card.equity, `${fieldName}.equity`),
    equity_status: enumValue(
      card.equity_status,
      enumValues("CURRENT", "STALE", "UNAVAILABLE"),
      `${fieldName}.equity_status`,
    ),
    settlement_asset: identifier(card.settlement_asset, `${fieldName}.settlement_asset`),
    updated_at_ms: timestamp(card.updated_at_ms, `${fieldName}.updated_at_ms`),
    compatibility: enumValue(
      card.compatibility,
      enumValues("READY", "LEGACY_ADAPTER", "LEGACY_V1", "UNAVAILABLE"),
      `${fieldName}.compatibility`,
    ),
    resume_action: enumValue(
      card.resume_action,
      enumValues("OPEN_ADAPTER", "OPEN_V1", "UNAVAILABLE"),
      `${fieldName}.resume_action`,
    ),
    adapter_session_id: identifier(card.adapter_session_id, `${fieldName}.adapter_session_id`),
    parent_legacy_session_id: nullableIdentifier(
      card.parent_legacy_session_id,
      `${fieldName}.parent_legacy_session_id`,
    ),
    status: {
      code: identifier(status.code, `${fieldName}.status.code`),
      message: displayString(status.message, `${fieldName}.status.message`, 512),
    },
    report_available: boolValue(card.report_available, `${fieldName}.report_available`),
    review_available: boolValue(card.review_available, `${fieldName}.review_available`),
  };
}

export function parseTrainingRunListResponse(value: unknown): TrainingRunListResponse {
  const payload = exactObject(value, "run list", [
    "protocol",
    "schema_version",
    "items",
    "next_cursor",
  ]);
  if (payload.protocol !== REPLAY_V2_PROTOCOL) {
    throw new TypeError(`protocol must be ${REPLAY_V2_PROTOCOL}`);
  }
  if (payload.schema_version !== "replay.training.v1") {
    throw new TypeError("run list schema_version is unsupported");
  }
  if (!Array.isArray(payload.items)) throw new TypeError("run list items must be an array");
  const nextCursor = payload.next_cursor;
  if (nextCursor !== null && (
    typeof nextCursor !== "string"
    || !/^[A-Za-z0-9_-]{1,1024}$/.test(nextCursor)
  )) {
    throw new TypeError("run list next_cursor is invalid");
  }
  return {
    protocol: REPLAY_V2_PROTOCOL,
    schema_version: "replay.training.v1",
    items: payload.items.map((item, index) => parseTrainingRunCard(item, `run list.items[${index}]`)),
    next_cursor: nextCursor,
  };
}

export function parseTrainingRunMutationResponse(value: unknown): TrainingRunMutationResponse {
  const payload = exactObject(value, "run mutation", ["protocol", "created", "migrated", "run"]);
  if (payload.protocol !== REPLAY_V2_PROTOCOL) {
    throw new TypeError(`protocol must be ${REPLAY_V2_PROTOCOL}`);
  }
  return {
    protocol: REPLAY_V2_PROTOCOL,
    created: boolValue(payload.created, "run mutation.created"),
    migrated: boolValue(payload.migrated, "run mutation.migrated"),
    run: parseTrainingRunCard(payload.run, "run mutation.run"),
  };
}

export function parseTrainingRunReturnResponse(value: unknown): TrainingRunReturnResponse {
  const payload = exactObject(value, "return to Hub", [
    "protocol",
    "run_id",
    "state",
    "checkpointed",
    "released",
  ]);
  if (payload.protocol !== REPLAY_V2_PROTOCOL || payload.state !== "PAUSED") {
    throw new TypeError("return-to-Hub response is unsupported");
  }
  return {
    protocol: REPLAY_V2_PROTOCOL,
    run_id: identifier(payload.run_id, "return to Hub.run_id"),
    state: "PAUSED",
    checkpointed: boolValue(payload.checkpointed, "return to Hub.checkpointed"),
    released: boolValue(payload.released, "return to Hub.released"),
  };
}

const replayV2EnvironmentFlag: unknown = (import.meta as {
  readonly env?: { readonly VITE_REPLAY_PRODUCT_V2_ENABLED?: unknown };
}).env?.VITE_REPLAY_PRODUCT_V2_ENABLED;

export function replayV2ProductFlagEnabled(value: string | boolean | undefined): boolean {
  return value === true || value === "1" || value === "true";
}

export const REPLAY_PRODUCT_V2_ENABLED = replayV2ProductFlagEnabled(
  typeof replayV2EnvironmentFlag === "string" ? replayV2EnvironmentFlag : undefined,
);
