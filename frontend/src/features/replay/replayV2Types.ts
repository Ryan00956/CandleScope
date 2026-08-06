export const REPLAY_V2_PROTOCOL = "replay.v3" as const;
export const REPLAY_V2_SCHEMA_VERSION = "replay.contract.v3.phase1" as const;
export const HEDGE_ACCOUNT_FIDELITY =
  "PINNED_PUBLIC_INPUTS_DETERMINISTIC_SIMULATED_PRIVATE_STATE" as const;
export const HEDGE_INSURANCE_ADL_FIDELITY =
  "DETERMINISTIC_SIMULATION_NOT_HISTORICAL_EXCHANGE_FACT" as const;

function enumValues<const T extends readonly string[]>(...values: T): Readonly<T> {
  return Object.freeze(values);
}

export const REPLAY_V2_ENUMS = Object.freeze({
  run_state: enumValues(
    "AWAITING_MARKET",
    "PAUSED",
    "PLAYING",
    "ADVANCING",
    "ENDED",
    "ERROR",
  ),
  track_state: enumValues("DORMANT", "PREPARING", "READY", "DEGRADED", "ERROR"),
  source_kind: enumValues("BAR", "AGG_TRADE"),
  start_mode: enumValues("MANUAL", "RANDOM"),
  visible_history_mode: enumValues("DURATION", "ALL_AVAILABLE"),
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
    "HISTORICAL_MARK_INDEX",
    "HISTORICAL_INSTRUMENT_RULE",
    "HISTORICAL_FEE_POLICY",
    "HISTORICAL_FUNDING",
    "HISTORICAL_L2",
    "SIMULATED_INSURANCE_FUND",
    "SIMULATED_ADL_COHORT",
  ),
  capability_state: enumValues(
    "AVAILABLE_EXACT",
    "AVAILABLE_APPROX",
    "AVAILABLE_EXACT_INPUTS_MODELLED_ACCOUNT",
    "AVAILABLE_PINNED",
    "AVAILABLE_PINNED_CONTINUITY_GATED",
    "AVAILABLE_PINNED_ACCOUNT_WIDE",
    "AVAILABLE_MATERIALIZED",
    "AVAILABLE_MATERIALIZED_ACCOUNT_WIDE",
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
  position_mode: enumValues("ONE_WAY", "HEDGE"),
  funding_mode: enumValues("OFF", "HISTORICAL_EXACT", "SANDBOX_FIXED"),
  account_data_mode: enumValues(
    "APPROX_PROXY",
    "HISTORICAL_EXACT",
    "DETERMINISTIC_SIMULATION",
  ),
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
    "replace_order",
    "cancel_order",
    "cancel_orders",
    "close_position",
    "execute_position_intent",
    "set_position_protection",
    "set_position_leverage",
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
export type ReplayVisibleHistoryMode = EnumValue<
  typeof REPLAY_V2_ENUMS.visible_history_mode
>;
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
export type ReplayV2PositionMode = EnumValue<typeof REPLAY_V2_ENUMS.position_mode>;
export type ReplayV2FundingMode = EnumValue<typeof REPLAY_V2_ENUMS.funding_mode>;
export type ReplayV2AccountDataMode = EnumValue<
  typeof REPLAY_V2_ENUMS.account_data_mode
>;
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

export interface ReplayAccountHistoryRef {
  readonly schema_version: "replay.account-history-ref.v1";
  readonly archive_id: string;
  readonly dataset_epoch: `sha256:${string}`;
  readonly checksum_sha256: `sha256:${string}`;
}

export interface ReplayHedgePublicHistoryRef {
  readonly schema_version: "replay.hedge-public-history-ref.v1";
  readonly archive_id: string;
  readonly dataset_epoch: `sha256:${string}`;
  readonly checksum_sha256: `sha256:${string}`;
}

export interface ReplayHedgeSimulationManifestRef {
  readonly schema_version: "replay.hedge-simulation-manifest-ref.v1";
  readonly manifest_id: string;
  readonly dataset_epoch: `sha256:${string}`;
  readonly checksum_sha256: `sha256:${string}`;
  readonly contract_hash: `sha256:${string}`;
  readonly model_version: string;
}

export interface ReplayHedgeRunBinding {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly schema_version: typeof REPLAY_V2_SCHEMA_VERSION;
  readonly position_mode: "HEDGE";
  readonly account_data_mode: "DETERMINISTIC_SIMULATION";
  readonly margin_mode: ReplayV2MarginMode;
  readonly funding_mode: ReplayV2FundingMode;
  readonly book_mode: ReplayV2BookMode;
  readonly hedge_public_history_ref: ReplayHedgePublicHistoryRef;
  readonly simulation_manifest_ref: ReplayHedgeSimulationManifestRef;
  readonly account_fidelity: typeof HEDGE_ACCOUNT_FIDELITY;
  readonly insurance_adl_fidelity: typeof HEDGE_INSURANCE_ADL_FIDELITY;
}

export interface ReplayAccountHistoryBindingProjection {
  readonly track_id: string;
  readonly archive_id: string;
  readonly dataset_epoch: `sha256:${string}`;
  readonly checksum_sha256: `sha256:${string}`;
  readonly proof_hash: `sha256:${string}`;
  readonly event_chain_tail: `sha256:${string}`;
  readonly archive_generation: number;
  readonly last_event_sequence: number;
  readonly as_of_actual_time_ms: number;
  readonly as_of_virtual_time_ms: number;
  readonly mark_price: string | null;
  readonly index_price: string | null;
  readonly status: "READY" | "DEGRADED";
}

export interface ReplayAccountHistoryProjection {
  readonly mode: ReplayV2AccountDataMode;
  readonly status: "ACTIVE" | "DEGRADED";
  readonly fidelity:
    | "REVEALED_PRICE_PROXY_MODELLED_ACCOUNT"
    | "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT"
    | typeof HEDGE_ACCOUNT_FIDELITY;
  readonly archive_proof_hash: `sha256:${string}` | null;
  readonly bindings: readonly ReplayAccountHistoryBindingProjection[];
  readonly auditor: {
    readonly status: "NOT_RUN" | "PASS" | "FAIL";
    readonly proof_hash: `sha256:${string}` | null;
    readonly differences: readonly Readonly<Record<string, ReplayV2Json>>[];
  };
}

export interface ReplayAccountAuditResponse {
  readonly schema_version: "replay.account-audit.v1";
  readonly status: "PASS" | "FAIL";
  readonly account_audit_status: "PASS" | "FAIL";
  readonly proof_hash: `sha256:${string}`;
  readonly differences: readonly Readonly<Record<string, ReplayV2Json>>[];
  readonly snapshot: Readonly<Record<string, ReplayV2Json>>;
  readonly hedge_input_audit: {
    readonly schema_version: "replay.hedge-input-audit-summary.v1";
    readonly status: "NOT_APPLICABLE" | "PASS" | "FAIL";
    readonly proof_hash: `sha256:${string}` | null;
    readonly difference_count: number;
    readonly difference_hashes: readonly `sha256:${string}`[];
    readonly snapshot_hash: `sha256:${string}` | null;
  };
}

export interface ReplayLiquidationChannelProjection {
  readonly label: string;
  readonly source:
    | "MODELLED_ACCOUNT"
    | "INDEPENDENT_MARKET_LIQUIDATION_FEED";
  readonly fidelity:
    | "AVAILABLE_APPROX_SIMULATED_ACCOUNT"
    | "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT"
    | typeof HEDGE_INSURANCE_ADL_FIDELITY
    | "UNSUPPORTED_NO_HISTORY";
}

export interface ReplayPositionProtectionOrder {
  readonly order_id: string;
  readonly order_type: "STOP_MARKET" | "TAKE_PROFIT_MARKET";
  readonly quantity: string;
  readonly remaining_quantity: string;
  readonly stop_price: string;
  readonly status: "OPEN" | "PARTIALLY_FILLED";
}

export interface ReplayPositionProtection {
  readonly orders: readonly ReplayPositionProtectionOrder[];
}

export interface ReplayLiquidationBookLevel {
  readonly book_level: number;
  readonly price: string;
  readonly quantity: string;
}

export interface ReplayLiquidationBookExecution {
  readonly case_id: string;
  readonly step_sequence: number;
  readonly track_id: string;
  readonly as_of_virtual_time_ms: number;
  readonly last_update_id: number;
  readonly side: "BUY" | "SELL";
  readonly requested_quantity: string;
  readonly visible_quantity: string;
  readonly levels: readonly ReplayLiquidationBookLevel[];
  readonly book_hash: `sha256:${string}`;
  readonly execution_fidelity: "HISTORICAL_L2_VISIBLE_DEPTH_CONSERVATIVE_V1";
  readonly queue_exact: false;
  readonly execution_plan_hash: `sha256:${string}`;
}

export interface ReplayLiquidationBookSnapshot {
  readonly case_id: string;
  readonly track_id: string;
  readonly as_of_virtual_time_ms: number;
  readonly last_update_id: number;
  readonly book_hash: `sha256:${string}`;
  readonly execution_fidelity: "HISTORICAL_L2_VISIBLE_DEPTH_CONSERVATIVE_V1";
  readonly queue_exact: false;
  readonly snapshot_hash: `sha256:${string}`;
}

export interface ReplayLiquidationFill {
  readonly fill_id: string;
  readonly fill_sequence: number;
  readonly price: string;
  readonly quantity: string;
  readonly notional: string;
  readonly trading_fee: string;
  readonly liquidation_fee: string;
  readonly book_level: number | null;
  readonly virtual_time_ms: number;
  readonly source_sequence: number;
  readonly fill_hash: `sha256:${string}`;
}

export interface ReplayLiquidationOrder {
  readonly order_id: string;
  readonly liquidation_leg_id: string;
  readonly order_sequence: number;
  readonly side: "BUY" | "SELL";
  readonly order_type: "MARKET" | "LIMIT";
  readonly requested_quantity: string;
  readonly filled_quantity: string;
  readonly remaining_quantity: string;
  readonly average_price: string | null;
  readonly state: "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "FAILED_CLOSED";
  readonly order_hash: `sha256:${string}`;
  readonly fills: readonly ReplayLiquidationFill[];
}

export interface ReplayInsurancePosting {
  readonly asset: string;
  readonly posting_sequence: number;
  readonly posting_id: string;
  readonly cash_delta: string;
  readonly balance_after: string;
  readonly reason: string;
  readonly posting_hash: `sha256:${string}`;
}

export interface ReplayAdlSelection {
  readonly selection_sequence: number;
  readonly candidate_id: string;
  readonly snapshot_id: string;
  readonly quantity: string;
  readonly price: string;
  readonly notional: string;
  readonly cash_delta: string;
  readonly selection_hash: `sha256:${string}`;
}

export interface ReplayAdlCounterpartyLedgerEntry {
  readonly ledger_sequence: number;
  readonly candidate_id: string;
  readonly snapshot_id: string;
  readonly position_side: "LONG" | "SHORT";
  readonly quantity_before: string;
  readonly quantity_delta: string;
  readonly quantity_after: string;
  readonly takeover_price: string;
  readonly cash_delta: string;
  readonly entry_hash: `sha256:${string}`;
}

export interface ReplayAdlEvent {
  readonly adl_event_id: string;
  readonly snapshot_id: string;
  readonly required_notional: string;
  readonly completed_notional: string;
  readonly state: "PENDING" | "COMPLETED" | "FAILED_CLOSED";
  readonly event_hash: `sha256:${string}`;
  readonly selections: readonly ReplayAdlSelection[];
  readonly counterparty_ledger: readonly ReplayAdlCounterpartyLedgerEntry[];
}

export interface ReplayLiquidationStep {
  readonly step_sequence: number;
  readonly step_type:
    | "CANCEL_ORDERS"
    | "RISK_RECHECK"
    | "PARTIAL_LIQUIDATION"
    | "FULL_LIQUIDATION"
    | "BANKRUPTCY_TRANSFER"
    | "INSURANCE_FUND_SETTLEMENT"
    | "ADL"
    | "COMPLETE"
    | "FAILED_CLOSED";
  readonly state: "PENDING" | "APPLIED" | "FAILED_CLOSED";
  readonly before_snapshot_id: string;
  readonly after_snapshot_id: string | null;
  readonly reason: string;
  readonly step_hash: `sha256:${string}`;
  readonly book_execution: ReplayLiquidationBookExecution | null;
  readonly orders: readonly ReplayLiquidationOrder[];
  readonly insurance_postings: readonly ReplayInsurancePosting[];
  readonly adl_events: readonly ReplayAdlEvent[];
}

export interface ReplayLiquidationLeg {
  readonly liquidation_leg_id: string;
  readonly leg_sequence: number;
  readonly track_id: string;
  readonly position_side: "LONG" | "SHORT";
  readonly trigger_quantity: string;
  readonly trigger_notional: string;
  readonly maintenance_margin: string;
  readonly liquidation_price: string | null;
  readonly bankruptcy_price: string | null;
  readonly takeover_price: string | null;
  readonly liquidation_fee: string;
  readonly target_quantity: string;
  readonly completed_quantity: string;
  readonly state: "PENDING" | "PARTIAL" | "CLOSED" | "TRANSFERRED" | "FAILED_CLOSED";
  readonly component_hash: `sha256:${string}`;
}

export interface ReplayLiquidationCase {
  readonly run_id: string;
  readonly case_id: string;
  readonly case_sequence: number;
  readonly state:
    | "RISK_BREACH_DETECTED"
    | "CANCELING_ORDERS"
    | "RISK_RECHECK"
    | "PARTIAL_LIQUIDATION"
    | "FULL_LIQUIDATION"
    | "BANKRUPTCY_TRANSFER"
    | "INSURANCE_FUND_SETTLEMENT"
    | "ADL"
    | "RECOVERED_AFTER_CANCEL"
    | "COMPLETED"
    | "BANKRUPT"
    | "FAILED_CLOSED";
  readonly trigger_snapshot_id: string;
  readonly final_snapshot_id: string | null;
  readonly trigger_virtual_time_ms: number;
  readonly trigger_source_sequence: number;
  readonly reason: string;
  readonly fidelity: string;
  readonly component_hash: `sha256:${string}`;
  readonly legs: readonly ReplayLiquidationLeg[];
  readonly book_snapshots: readonly ReplayLiquidationBookSnapshot[];
  readonly steps: readonly ReplayLiquidationStep[];
}

export interface ReplayTrainingPortfolioV1 {
  readonly schema_version: "replay.training.portfolio.v1";
  readonly fidelity: "PAPER_LINEAR_V1_MULTI_TRACK_ADAPTER";
  readonly settlement_account_shared: true;
  readonly position_mode: ReplayV2PositionMode;
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
  readonly position_mode: ReplayV2PositionMode;
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
  readonly history: {
    readonly orders_total: number;
    readonly active_orders: number;
    readonly historical_orders: number;
    readonly fills_total: number;
    readonly ledger_entries_total: number;
    readonly page_limit_max: number;
  };
  readonly active_fee_policy: Readonly<Record<string, ReplayV2Json>> | null;
  readonly instrument_rules: readonly Readonly<Record<string, ReplayV2Json>>[];
  readonly isolated_allocations: Readonly<Record<string, ReplayV2Json>>;
  readonly next_funding_time_ms: number | null;
  readonly liquidations: readonly ReplayLiquidationCase[];
  readonly liquidation_recoveries: readonly ReplayLiquidationCase[];
  readonly hedge_state: Readonly<Record<string, ReplayV2Json>>;
  readonly hedge_inputs: ReplayHedgeInputView | null;
  readonly account_history: ReplayAccountHistoryProjection;
  readonly liquidation_channels: {
    readonly simulated_account: ReplayLiquidationChannelProjection;
    readonly historical_market: ReplayLiquidationChannelProjection;
  };
  readonly ledger: Readonly<Record<string, ReplayV2Json>>;
  readonly fidelity: Readonly<Record<string, ReplayV2Json>>;
}

export type ReplayTrainingPortfolio = ReplayTrainingPortfolioV1 | ReplayTrainingContractPortfolio;

export type ReplayAccountRecordType = "ORDERS" | "FILLS" | "LEDGER";
export type ReplayAccountOrderScope = "ACTIVE" | "HISTORY" | "ALL";

export interface ReplayAccountRecordPage {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly schema_version: "replay.training.account-record-page.v1";
  readonly run_id: string;
  readonly record_type: ReplayAccountRecordType;
  readonly order_scope: ReplayAccountOrderScope;
  readonly track_id: string | null;
  readonly items: readonly Readonly<Record<string, ReplayV2Json>>[];
  readonly total_count: number;
  readonly next_cursor: string | null;
}

export interface ReplayTrainingPortfolioPosition {
  readonly track_id: string;
  readonly symbol: string;
  readonly position_side?: "LONG" | "SHORT";
  readonly position: Readonly<Record<string, ReplayV2Json>>;
  readonly maintenance_margin?: string;
  readonly initial_margin?: string;
  readonly liquidation_price?: string | null;
  readonly bankruptcy_price?: string | null;
  readonly accumulated_funding?: string;
  readonly trading_fees?: string;
  readonly liquidation_fees?: string;
  readonly protection?: ReplayPositionProtection;
  readonly leverage?: string;
  readonly risk_tier?: number;
  readonly account_notional?: string;
  readonly isolated_margin?: string;
  readonly isolated_allocation_key?: string;
  readonly position_leg_hash?: `sha256:${string}`;
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
  readonly launch_context: ReplayLaunchContext | null;
  readonly viewer_state: ReplayViewerState;
  readonly tracks: readonly ReplayTrainingMarketTrack[];
  readonly portfolio: ReplayTrainingPortfolio;
  readonly global_clock: ReplayGlobalClock | null;
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
  readonly selected_track_id: string | null;
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

export interface ReplayOrderRequest {
  readonly client_order_id: string;
  readonly side: "BUY" | "SELL";
  readonly order_type: "MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";
  readonly quantity: string;
  readonly reduce_only: boolean;
  readonly limit_price: string | null;
  readonly stop_price: string | null;
  /** Effective leverage ≤ session max; omitted when using max. */
  readonly leverage?: string | null;
  readonly position_side?: "LONG" | "SHORT" | null;
}

export interface ReplayOrderCapacityContext {
  readonly side: "BUY" | "SELL";
  readonly order_type: "MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";
  readonly reduce_only: boolean;
  readonly limit_price: string | null;
  readonly stop_price: string | null;
  readonly leverage?: string | null;
  readonly position_side?: "LONG" | "SHORT" | null;
}

export interface ReplayOrderCapacityRequest {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly expected_revision: number;
  readonly expected_cursor: ReplayV2Cursor;
  readonly position_intent: "NET" | "OPEN";
  readonly context: ReplayOrderCapacityContext;
}

export interface ReplayOrderCapacity {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly schema_version: "replay.order-capacity.v1";
  readonly run_id: string;
  readonly track_id: string;
  readonly position_intent: "NET" | "OPEN";
  readonly revision: number;
  readonly cursor: ReplayV2Cursor;
  readonly state_hash: `sha256:${string}`;
  readonly execution_fidelity: "BAR_CONSERVATIVE" | "AGG_TRADE_TAPE";
  readonly context: ReplayOrderCapacityContext;
  readonly reference_price: string;
  readonly max_quantity: string;
  readonly quote_asset: string;
  readonly max_leverage: string;
}

export interface ReplayTradePlanDraft {
  readonly sizing_mode: "RISK_AMOUNT" | "ACCOUNT_RISK_PERCENT";
  readonly risk_amount: string | null;
  readonly risk_percent: string | null;
  readonly invalidation_price: string;
  readonly target_price: string;
  readonly reason: string;
}

export interface ReplayTradePlanSnapshot {
  readonly schema_version: "replay.trade-plan.snapshot.v1";
  readonly track_id: string;
  readonly client_order_id: string;
  readonly side: "BUY" | "SELL";
  readonly order_type: "MARKET" | "LIMIT";
  readonly sizing_mode: "RISK_AMOUNT" | "ACCOUNT_RISK_PERCENT";
  readonly risk_amount: string;
  readonly risk_percent: string | null;
  readonly account_equity: string;
  readonly entry_price: string;
  readonly invalidation_price: string;
  readonly target_price: string;
  readonly risk_per_unit: string;
  readonly reward_risk_ratio: string;
  readonly quantity: string;
  readonly reason: string;
}

export interface ReplayOrderPreviewRequest {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly expected_revision: number;
  readonly expected_cursor: ReplayV2Cursor;
  readonly position_intent: "NET" | "OPEN";
  readonly order: ReplayOrderRequest;
  readonly trade_plan?: ReplayTradePlanDraft | null;
}

export interface ReplayOrderPreview {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly schema_version: "replay.order-preview.v1" | "replay.order-preview.v2";
  readonly run_id: string;
  readonly track_id: string;
  readonly accepted: true;
  readonly position_intent: "NET" | "OPEN";
  readonly revision: number;
  readonly cursor: ReplayV2Cursor;
  readonly state_hash: `sha256:${string}`;
  readonly execution_fidelity: "BAR_CONSERVATIVE" | "AGG_TRADE_TAPE";
  readonly order: ReplayOrderRequest;
  readonly reference_price: string;
  readonly estimated_fill_price: string;
  readonly estimated_notional: string;
  readonly reserved_margin: string;
  readonly estimated_fee: string;
  readonly fee_basis: "TAKER_WORST_CASE";
  readonly available_equity_after: string;
  readonly max_quantity: string;
  readonly quote_asset: string;
  readonly max_leverage: string;
  readonly trade_plan: ReplayTradePlanSnapshot | null;
}

export interface ReplayTrainingResultPlan {
  readonly plan_id: string;
  readonly plan_hash: `sha256:${string}`;
  readonly sizing_mode: "RISK_AMOUNT" | "ACCOUNT_RISK_PERCENT";
  readonly risk_amount: string;
  readonly risk_percent: string | null;
  readonly entry_price: string;
  readonly invalidation_price: string;
  readonly target_price: string;
  readonly reward_risk_ratio: string;
  readonly quantity: string;
  readonly reason: string;
}

export interface ReplayTrainingResultItem {
  readonly trade_id: string;
  readonly episode_id: string;
  readonly track_id: string;
  readonly symbol: string;
  readonly settlement_asset: string;
  readonly fill_id: string;
  readonly position_side: "BUY" | "SELL";
  readonly quantity: string;
  readonly entry_price: string;
  readonly exit_price: string;
  readonly gross_realized_pnl: string;
  readonly mae: string;
  readonly mfe: string;
  readonly initial_risk_amount: string | null;
  readonly r_multiple: string | null;
  readonly holding_duration_ms: number;
  readonly entry_source_sequence: number;
  readonly exit_source_sequence: number;
  readonly entry_public_time: Readonly<Record<string, ReplayV2Json>>;
  readonly exit_public_time: Readonly<Record<string, ReplayV2Json>>;
  readonly plans: readonly ReplayTrainingResultPlan[];
  readonly review_event_id: string | null;
  readonly excursion_fidelity: "REVEALED_MARK_PATH_CONSERVATIVE";
  readonly pnl_basis: "REALIZED_GROSS_EX_FEES";
}

export interface ReplayTrainingResultsResponse {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly schema_version: "replay.training-results.v1";
  readonly run_id: string;
  readonly summary: {
    readonly trade_count: number;
    readonly win_count: number;
    readonly loss_count: number;
    readonly win_rate: string;
    readonly gross_realized_pnl: string;
    readonly net_realized_pnl: string;
    readonly fees_paid: string;
    readonly average_win: string;
    readonly average_loss: string;
    readonly payoff_ratio: string | null;
    readonly profit_factor: string | null;
    readonly max_drawdown: string;
    readonly average_mae: string;
    readonly average_mfe: string;
    readonly average_r_multiple: string | null;
    readonly average_holding_duration_ms: number;
    readonly planned_trade_count: number;
  };
  readonly items: readonly ReplayTrainingResultItem[];
  readonly returned_count: number;
  readonly truncated: boolean;
  readonly data_fidelity: string;
  readonly execution_fidelity: string;
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

export function parseReplayAccountHistoryRef(
  value: unknown,
  fieldName = "account_history_ref",
): ReplayAccountHistoryRef {
  const reference = exactObject(value, fieldName, [
    "schema_version",
    "archive_id",
    "dataset_epoch",
    "checksum_sha256",
  ]);
  if (reference.schema_version !== "replay.account-history-ref.v1") {
    throw new TypeError(`${fieldName}.schema_version is unsupported`);
  }
  return {
    schema_version: "replay.account-history-ref.v1",
    archive_id: identifier(reference.archive_id, `${fieldName}.archive_id`),
    dataset_epoch: digest(reference.dataset_epoch, `${fieldName}.dataset_epoch`),
    checksum_sha256: digest(reference.checksum_sha256, `${fieldName}.checksum_sha256`),
  };
}

export interface ReplayHedgeInputView {
  readonly schema_version: "replay.hedge-input-view.v2";
  readonly status: "ACTIVE" | "PAUSED" | "QUARANTINED";
  readonly degraded_reason: string | null;
  readonly input_proof_hash: `sha256:${string}`;
  readonly time_domain: "ACTUAL" | "PUBLIC";
  readonly bound_range_start_ms: number;
  readonly bound_range_end_ms: number;
  readonly public: Readonly<Record<string, ReplayV2Json>>;
  readonly simulation: Readonly<Record<string, ReplayV2Json>>;
  readonly projections: readonly Readonly<Record<string, ReplayV2Json>>[];
  readonly track_public: readonly Readonly<Record<string, ReplayV2Json>>[];
  readonly auditor: {
    readonly status: "NOT_RUN" | "PASS" | "FAIL";
    readonly proof_hash: `sha256:${string}` | null;
    readonly difference_count: number;
    readonly difference_hashes: readonly `sha256:${string}`[];
  };
}

export function parseReplayHedgePublicHistoryRef(
  value: unknown,
  fieldName = "hedge_public_history_ref",
): ReplayHedgePublicHistoryRef {
  const reference = exactObject(value, fieldName, [
    "schema_version",
    "archive_id",
    "dataset_epoch",
    "checksum_sha256",
  ]);
  if (reference.schema_version !== "replay.hedge-public-history-ref.v1") {
    throw new TypeError(`${fieldName}.schema_version is unsupported`);
  }
  return {
    schema_version: "replay.hedge-public-history-ref.v1",
    archive_id: identifier(reference.archive_id, `${fieldName}.archive_id`),
    dataset_epoch: digest(reference.dataset_epoch, `${fieldName}.dataset_epoch`),
    checksum_sha256: digest(reference.checksum_sha256, `${fieldName}.checksum_sha256`),
  };
}

export function parseReplayHedgeSimulationManifestRef(
  value: unknown,
  fieldName = "simulation_manifest_ref",
): ReplayHedgeSimulationManifestRef {
  const reference = exactObject(value, fieldName, [
    "schema_version",
    "manifest_id",
    "dataset_epoch",
    "checksum_sha256",
    "contract_hash",
    "model_version",
  ]);
  if (reference.schema_version !== "replay.hedge-simulation-manifest-ref.v1") {
    throw new TypeError(`${fieldName}.schema_version is unsupported`);
  }
  return {
    schema_version: "replay.hedge-simulation-manifest-ref.v1",
    manifest_id: identifier(reference.manifest_id, `${fieldName}.manifest_id`),
    dataset_epoch: digest(reference.dataset_epoch, `${fieldName}.dataset_epoch`),
    checksum_sha256: digest(reference.checksum_sha256, `${fieldName}.checksum_sha256`),
    contract_hash: digest(reference.contract_hash, `${fieldName}.contract_hash`),
    model_version: identifier(reference.model_version, `${fieldName}.model_version`),
  };
}

export function parseReplayHedgeRunBinding(value: unknown): ReplayHedgeRunBinding {
  const binding = exactObject(value, "hedge run binding", [
    "protocol",
    "schema_version",
    "position_mode",
    "account_data_mode",
    "margin_mode",
    "funding_mode",
    "book_mode",
    "hedge_public_history_ref",
    "simulation_manifest_ref",
    "account_fidelity",
    "insurance_adl_fidelity",
  ]);
  if (binding.protocol !== REPLAY_V2_PROTOCOL
    || binding.schema_version !== REPLAY_V2_SCHEMA_VERSION
    || binding.position_mode !== "HEDGE"
    || binding.account_data_mode !== "DETERMINISTIC_SIMULATION"
    || binding.account_fidelity !== HEDGE_ACCOUNT_FIDELITY
    || binding.insurance_adl_fidelity !== HEDGE_INSURANCE_ADL_FIDELITY) {
    throw new TypeError("hedge run binding does not match the replay.v3 contract");
  }
  return {
    protocol: REPLAY_V2_PROTOCOL,
    schema_version: REPLAY_V2_SCHEMA_VERSION,
    position_mode: "HEDGE",
    account_data_mode: "DETERMINISTIC_SIMULATION",
    margin_mode: enumValue(binding.margin_mode, REPLAY_V2_ENUMS.margin_mode, "margin_mode"),
    funding_mode: enumValue(binding.funding_mode, REPLAY_V2_ENUMS.funding_mode, "funding_mode"),
    book_mode: enumValue(binding.book_mode, REPLAY_V2_ENUMS.book_mode, "book_mode"),
    hedge_public_history_ref: parseReplayHedgePublicHistoryRef(
      binding.hedge_public_history_ref,
    ),
    simulation_manifest_ref: parseReplayHedgeSimulationManifestRef(
      binding.simulation_manifest_ref,
    ),
    account_fidelity: HEDGE_ACCOUNT_FIDELITY,
    insurance_adl_fidelity: HEDGE_INSURANCE_ADL_FIDELITY,
  };
}

export function parseReplayAccountAuditResponse(
  value: unknown,
): ReplayAccountAuditResponse {
  const audit = exactObject(value, "account audit", [
    "schema_version",
    "status",
    "account_audit_status",
    "proof_hash",
    "differences",
    "snapshot",
    "hedge_input_audit",
  ]);
  if (audit.schema_version !== "replay.account-audit.v1") {
    throw new TypeError("account audit schema is unsupported");
  }
  const status = enumValue(audit.status, enumValues("PASS", "FAIL"), "account audit.status");
  const accountAuditStatus = enumValue(
    audit.account_audit_status,
    enumValues("PASS", "FAIL"),
    "account audit.account_audit_status",
  );
  if (!Array.isArray(audit.differences)) {
    throw new TypeError("account audit.differences must be an array");
  }
  const differences = audit.differences.map((item, index) => jsonObject(
    item,
    `account audit.differences[${index}]`,
  ));
  const snapshot = jsonObject(audit.snapshot, "account audit.snapshot");
  const rawHedgeAudit = exactObject(
    audit.hedge_input_audit,
    "account audit.hedge_input_audit",
    [
      "schema_version",
      "status",
      "proof_hash",
      "difference_count",
      "difference_hashes",
      "snapshot_hash",
    ],
  );
  if (rawHedgeAudit.schema_version !== "replay.hedge-input-audit-summary.v1") {
    throw new TypeError("HEDGE input audit summary schema is unsupported");
  }
  const hedgeStatus = enumValue(
    rawHedgeAudit.status,
    enumValues("NOT_APPLICABLE", "PASS", "FAIL"),
    "account audit.hedge_input_audit.status",
  );
  const hedgeProofHash = rawHedgeAudit.proof_hash === null
    ? null
    : digest(rawHedgeAudit.proof_hash, "account audit.hedge_input_audit.proof_hash");
  const hedgeDifferenceCount = counter(
    rawHedgeAudit.difference_count,
    "account audit.hedge_input_audit.difference_count",
  );
  if (!Array.isArray(rawHedgeAudit.difference_hashes)) {
    throw new TypeError("account audit.hedge_input_audit.difference_hashes must be an array");
  }
  const hedgeDifferenceHashes = rawHedgeAudit.difference_hashes.map((item, index) => digest(
    item,
    `account audit.hedge_input_audit.difference_hashes[${index}]`,
  ));
  const hedgeSnapshotHash = rawHedgeAudit.snapshot_hash === null
    ? null
    : digest(rawHedgeAudit.snapshot_hash, "account audit.hedge_input_audit.snapshot_hash");
  if (snapshot.schema_version !== "replay.account-audit.v1"
    || (accountAuditStatus === "PASS" && differences.length !== 0)
    || (accountAuditStatus === "FAIL" && differences.length === 0)
    || hedgeDifferenceCount !== hedgeDifferenceHashes.length
    || (hedgeStatus !== "FAIL" && hedgeDifferenceCount !== 0)
    || (hedgeStatus === "FAIL" && hedgeDifferenceCount === 0)
    || (hedgeStatus === "NOT_APPLICABLE"
      ? hedgeProofHash !== null || hedgeSnapshotHash !== null
      : hedgeProofHash === null || hedgeSnapshotHash === null)
    || status !== (
      accountAuditStatus === "PASS" && hedgeStatus !== "FAIL" ? "PASS" : "FAIL"
    )) {
    throw new TypeError("account audit proof is inconsistent");
  }
  return {
    schema_version: "replay.account-audit.v1",
    status,
    account_audit_status: accountAuditStatus,
    proof_hash: digest(audit.proof_hash, "account audit.proof_hash"),
    differences,
    snapshot,
    hedge_input_audit: {
      schema_version: "replay.hedge-input-audit-summary.v1",
      status: hedgeStatus,
      proof_hash: hedgeProofHash,
      difference_count: hedgeDifferenceCount,
      difference_hashes: hedgeDifferenceHashes,
      snapshot_hash: hedgeSnapshotHash,
    },
  };
}

function parseReplayAccountHistoryProjection(
  value: unknown,
): ReplayAccountHistoryProjection {
  const history = exactObject(value, "portfolio.account_history", [
    "mode",
    "status",
    "fidelity",
    "archive_proof_hash",
    "bindings",
    "auditor",
  ]);
  const mode = enumValue(
    history.mode,
    REPLAY_V2_ENUMS.account_data_mode,
    "portfolio.account_history.mode",
  );
  const status = enumValue(
    history.status,
    enumValues("ACTIVE", "DEGRADED"),
    "portfolio.account_history.status",
  );
  const fidelity = enumValue(
    history.fidelity,
    enumValues(
      "REVEALED_PRICE_PROXY_MODELLED_ACCOUNT",
      "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT",
      HEDGE_ACCOUNT_FIDELITY,
    ),
    "portfolio.account_history.fidelity",
  );
  if (!Array.isArray(history.bindings)) {
    throw new TypeError("portfolio.account_history.bindings must be an array");
  }
  const bindings = history.bindings.map((value, index) => {
    const field = `portfolio.account_history.bindings[${index}]`;
    const binding = exactObject(value, field, [
      "track_id",
      "archive_id",
      "dataset_epoch",
      "checksum_sha256",
      "proof_hash",
      "event_chain_tail",
      "archive_generation",
      "last_event_sequence",
      "as_of_actual_time_ms",
      "as_of_virtual_time_ms",
      "mark_price",
      "index_price",
      "status",
    ]);
    return {
      track_id: identifier(binding.track_id, `${field}.track_id`),
      archive_id: identifier(binding.archive_id, `${field}.archive_id`),
      dataset_epoch: digest(binding.dataset_epoch, `${field}.dataset_epoch`),
      checksum_sha256: digest(binding.checksum_sha256, `${field}.checksum_sha256`),
      proof_hash: digest(binding.proof_hash, `${field}.proof_hash`),
      event_chain_tail: digest(binding.event_chain_tail, `${field}.event_chain_tail`),
      archive_generation: counter(binding.archive_generation, `${field}.archive_generation`),
      last_event_sequence: counter(binding.last_event_sequence, `${field}.last_event_sequence`),
      as_of_actual_time_ms: counter(binding.as_of_actual_time_ms, `${field}.as_of_actual_time_ms`),
      as_of_virtual_time_ms: counter(binding.as_of_virtual_time_ms, `${field}.as_of_virtual_time_ms`),
      mark_price: binding.mark_price === null
        ? null
        : canonicalDecimal(binding.mark_price, `${field}.mark_price`),
      index_price: binding.index_price === null
        ? null
        : canonicalDecimal(binding.index_price, `${field}.index_price`),
      status: enumValue(binding.status, enumValues("READY", "DEGRADED"), `${field}.status`),
    } satisfies ReplayAccountHistoryBindingProjection;
  });
  const auditor = exactObject(history.auditor, "portfolio.account_history.auditor", [
    "status",
    "proof_hash",
    "differences",
  ]);
  const auditorStatus = enumValue(
    auditor.status,
    enumValues("NOT_RUN", "PASS", "FAIL"),
    "portfolio.account_history.auditor.status",
  );
  const auditorProof = auditor.proof_hash === null
    ? null
    : digest(auditor.proof_hash, "portfolio.account_history.auditor.proof_hash");
  if (!Array.isArray(auditor.differences)) {
    throw new TypeError("portfolio.account_history.auditor.differences must be an array");
  }
  const differences = auditor.differences.map((item, index) => jsonObject(
    item,
    `portfolio.account_history.auditor.differences[${index}]`,
  ));
  const archiveProof = history.archive_proof_hash === null
    ? null
    : digest(history.archive_proof_hash, "portfolio.account_history.archive_proof_hash");
  if (
    (auditorStatus === "NOT_RUN" && (auditorProof !== null || differences.length > 0))
    || (auditorStatus === "PASS" && (auditorProof === null || differences.length > 0))
    || (auditorStatus === "FAIL" && (auditorProof === null || differences.length === 0))
  ) {
    throw new TypeError("portfolio account auditor proof is inconsistent");
  }
  if (
    (mode === "HISTORICAL_EXACT"
      && (fidelity !== "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT"
        || archiveProof === null
        || bindings.length < 1))
    || (mode === "APPROX_PROXY"
      && (fidelity !== "REVEALED_PRICE_PROXY_MODELLED_ACCOUNT"
        || archiveProof !== null
        || bindings.length !== 0))
    || (mode === "DETERMINISTIC_SIMULATION"
      && (fidelity !== HEDGE_ACCOUNT_FIDELITY
        || archiveProof !== null
        || bindings.length !== 0))
  ) {
    throw new TypeError("portfolio account-history fidelity proof is inconsistent");
  }
  return {
    mode,
    status,
    fidelity,
    archive_proof_hash: archiveProof,
    bindings,
    auditor: {
      status: auditorStatus,
      proof_hash: auditorProof,
      differences,
    },
  };
}

function parseReplayLiquidationChannels(
  value: unknown,
  accountMode: ReplayV2AccountDataMode,
): ReplayTrainingContractPortfolio["liquidation_channels"] {
  const channels = exactObject(value, "portfolio.liquidation_channels", [
    "simulated_account",
    "historical_market",
  ]);
  const parseChannel = (
    value: unknown,
    field: string,
  ): ReplayLiquidationChannelProjection => {
    const channel = exactObject(value, field, ["label", "source", "fidelity"]);
    if (typeof channel.label !== "string" || channel.label.length < 1 || channel.label.length > 64) {
      throw new TypeError(`${field}.label must be a bounded string`);
    }
    return {
      label: channel.label,
      source: enumValue(
        channel.source,
        enumValues("MODELLED_ACCOUNT", "INDEPENDENT_MARKET_LIQUIDATION_FEED"),
        `${field}.source`,
      ),
      fidelity: enumValue(
        channel.fidelity,
        enumValues(
          "AVAILABLE_APPROX_SIMULATED_ACCOUNT",
          "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT",
          HEDGE_INSURANCE_ADL_FIDELITY,
          "UNSUPPORTED_NO_HISTORY",
        ),
        `${field}.fidelity`,
      ),
    };
  };
  const simulated = parseChannel(
    channels.simulated_account,
    "portfolio.liquidation_channels.simulated_account",
  );
  const historical = parseChannel(
    channels.historical_market,
    "portfolio.liquidation_channels.historical_market",
  );
  const expectedSimulatedFidelity = accountMode === "HISTORICAL_EXACT"
    ? "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT"
    : accountMode === "DETERMINISTIC_SIMULATION"
      ? HEDGE_INSURANCE_ADL_FIDELITY
      : "AVAILABLE_APPROX_SIMULATED_ACCOUNT";
  if (
    simulated.source !== "MODELLED_ACCOUNT"
    || simulated.fidelity !== expectedSimulatedFidelity
    || historical.source !== "INDEPENDENT_MARKET_LIQUIDATION_FEED"
    || historical.fidelity !== "UNSUPPORTED_NO_HISTORY"
  ) {
    throw new TypeError("portfolio liquidation channels are conflated or inconsistent");
  }
  return {
    simulated_account: simulated,
    historical_market: historical,
  };
}

function parseReplayHedgeInputView(value: unknown): ReplayHedgeInputView | null {
  if (value === null) return null;
  const input = exactObject(value, "portfolio.hedge_inputs", [
    "schema_version",
    "status",
    "degraded_reason",
    "input_proof_hash",
    "time_domain",
    "bound_range_start_ms",
    "bound_range_end_ms",
    "public",
    "simulation",
    "projections",
    "track_public",
    "auditor",
  ]);
  if (input.schema_version !== "replay.hedge-input-view.v2") {
    throw new TypeError("portfolio.hedge_inputs schema is unsupported");
  }
  const timeDomain = enumValue(
    input.time_domain,
    ["ACTUAL", "PUBLIC"] as const,
    "portfolio.hedge_inputs.time_domain",
  );
  const status = enumValue(
    input.status,
    ["ACTIVE", "PAUSED", "QUARANTINED"] as const,
    "portfolio.hedge_inputs.status",
  );
  if (
    input.degraded_reason !== null
    && (typeof input.degraded_reason !== "string" || input.degraded_reason.length === 0)
  ) {
    throw new TypeError("portfolio.hedge_inputs.degraded_reason is invalid");
  }
  if (
    (status === "ACTIVE" && input.degraded_reason !== null)
    || (status !== "ACTIVE" && input.degraded_reason === null)
  ) {
    throw new TypeError("portfolio.hedge_inputs status and reason are inconsistent");
  }
  const rangeStart = timestamp(
    input.bound_range_start_ms,
    "portfolio.hedge_inputs.bound_range_start_ms",
  );
  const rangeEnd = timestamp(
    input.bound_range_end_ms,
    "portfolio.hedge_inputs.bound_range_end_ms",
  );
  if (rangeEnd < rangeStart) {
    throw new TypeError("portfolio.hedge_inputs range is reversed");
  }
  const parseObjectReceipt = (
    raw: unknown,
    sourceKind: "public" | "simulation",
  ): Readonly<Record<string, ReplayV2Json>> => {
    const idField = sourceKind === "public" ? "archive_id" : "manifest_id";
    const expected = sourceKind === "public"
      ? [
          "archive_id",
          "generation",
          "dataset_epoch",
          "checksum_sha256",
          "event_chain_tail",
          "proof_hash",
          "health",
        ]
      : [
          "manifest_id",
          "generation",
          "dataset_epoch",
          "checksum_sha256",
          "contract_hash",
          "model_version",
          "proof_hash",
          "health",
        ];
    const receipt = exactObject(
      raw,
      `portfolio.hedge_inputs.${sourceKind}`,
      expected,
    );
    identifier(receipt[idField], `portfolio.hedge_inputs.${sourceKind}.${idField}`);
    const generation = counter(
      receipt.generation,
      `portfolio.hedge_inputs.${sourceKind}.generation`,
    );
    if (generation < 1) {
      throw new TypeError(`portfolio.hedge_inputs.${sourceKind}.generation must be positive`);
    }
    digest(receipt.dataset_epoch, `portfolio.hedge_inputs.${sourceKind}.dataset_epoch`);
    digest(receipt.checksum_sha256, `portfolio.hedge_inputs.${sourceKind}.checksum_sha256`);
    digest(receipt.proof_hash, `portfolio.hedge_inputs.${sourceKind}.proof_hash`);
    enumValue(
      receipt.health,
      ["READY", "EVICTED", "QUARANTINED"] as const,
      `portfolio.hedge_inputs.${sourceKind}.health`,
    );
    if (sourceKind === "public") {
      digest(receipt.event_chain_tail, "portfolio.hedge_inputs.public.event_chain_tail");
    } else {
      digest(receipt.contract_hash, "portfolio.hedge_inputs.simulation.contract_hash");
      identifier(receipt.model_version, "portfolio.hedge_inputs.simulation.model_version");
    }
    return jsonObject(receipt, `portfolio.hedge_inputs.${sourceKind}`);
  };
  if (!Array.isArray(input.projections) || input.projections.length !== 2) {
    throw new TypeError("portfolio.hedge_inputs.projections must contain both sources");
  }
  const projections = input.projections.map((raw, index) => {
    const field = `portfolio.hedge_inputs.projections[${index}]`;
    const projection = exactObject(raw, field, [
      "schema_version",
      "source_kind",
      "last_event_sequence",
      "as_of_time_ms",
      "time_domain",
      "state_hash",
      "input_chain_hash",
      "source_component_hash",
    ]);
    if (projection.schema_version !== "replay.hedge-input-public-projection.v1") {
      throw new TypeError(`${field}.schema_version is unsupported`);
    }
    enumValue(projection.source_kind, ["PUBLIC", "SIMULATION"] as const, `${field}.source_kind`);
    counter(projection.last_event_sequence, `${field}.last_event_sequence`);
    const asOfTime = timestamp(projection.as_of_time_ms, `${field}.as_of_time_ms`);
    if (asOfTime < rangeStart || asOfTime > rangeEnd) {
      throw new TypeError(`${field}.as_of_time_ms is outside the bound range`);
    }
    if (enumValue(
      projection.time_domain,
      ["ACTUAL", "PUBLIC"] as const,
      `${field}.time_domain`,
    ) !== timeDomain) {
      throw new TypeError(`${field}.time_domain is inconsistent`);
    }
    digest(projection.state_hash, `${field}.state_hash`);
    digest(projection.input_chain_hash, `${field}.input_chain_hash`);
    digest(projection.source_component_hash, `${field}.source_component_hash`);
    return jsonObject(projection, field);
  });
  const sourceKinds = projections.map((projection) => projection.source_kind);
  if (sourceKinds[0] !== "PUBLIC" || sourceKinds[1] !== "SIMULATION") {
    throw new TypeError("portfolio.hedge_inputs projections are not canonical");
  }
  if (!Array.isArray(input.track_public) || input.track_public.length < 1) {
    throw new TypeError("portfolio.hedge_inputs.track_public must contain a binding");
  }
  const trackPublic = input.track_public.map((raw, index) => {
    const field = `portfolio.hedge_inputs.track_public[${index}]`;
    const binding = exactObject(raw, field, [
      "track_id",
      "archive_id",
      "generation",
      "dataset_epoch",
      "checksum_sha256",
      "event_chain_tail",
      "input_proof_hash",
      "status",
      "degraded_reason",
      "projection",
    ]);
    const trackId = identifier(binding.track_id, `${field}.track_id`);
    identifier(binding.archive_id, `${field}.archive_id`);
    const generation = counter(binding.generation, `${field}.generation`);
    if (generation < 1) throw new TypeError(`${field}.generation must be positive`);
    digest(binding.dataset_epoch, `${field}.dataset_epoch`);
    digest(binding.checksum_sha256, `${field}.checksum_sha256`);
    digest(binding.event_chain_tail, `${field}.event_chain_tail`);
    digest(binding.input_proof_hash, `${field}.input_proof_hash`);
    const bindingStatus = enumValue(
      binding.status,
      ["ACTIVE", "PAUSED", "QUARANTINED"] as const,
      `${field}.status`,
    );
    if (
      binding.degraded_reason !== null
      && (typeof binding.degraded_reason !== "string" || binding.degraded_reason.length === 0)
    ) {
      throw new TypeError(`${field}.degraded_reason is invalid`);
    }
    if (
      (bindingStatus === "ACTIVE" && binding.degraded_reason !== null)
      || (bindingStatus !== "ACTIVE" && binding.degraded_reason === null)
    ) {
      throw new TypeError(`${field} status and reason are inconsistent`);
    }
    const projection = exactObject(binding.projection, `${field}.projection`, [
      "schema_version",
      "run_id",
      "track_id",
      "last_event_sequence",
      "as_of_time_ms",
      "time_domain",
      "state_hash",
      "input_chain_hash",
      "source_component_hash",
    ]);
    if (projection.schema_version !== "replay.hedge-track-public-projection.v2") {
      throw new TypeError(`${field}.projection.schema_version is unsupported`);
    }
    identifier(projection.run_id, `${field}.projection.run_id`);
    if (identifier(projection.track_id, `${field}.projection.track_id`) !== trackId) {
      throw new TypeError(`${field}.projection track identity is inconsistent`);
    }
    counter(projection.last_event_sequence, `${field}.projection.last_event_sequence`);
    const projectionTime = timestamp(
      projection.as_of_time_ms,
      `${field}.projection.as_of_time_ms`,
    );
    if (projectionTime < rangeStart || projectionTime > rangeEnd) {
      throw new TypeError(`${field}.projection time is outside the bound range`);
    }
    if (enumValue(
      projection.time_domain,
      ["ACTUAL", "PUBLIC"] as const,
      `${field}.projection.time_domain`,
    ) !== timeDomain) {
      throw new TypeError(`${field}.projection time domain is inconsistent`);
    }
    digest(projection.state_hash, `${field}.projection.state_hash`);
    digest(projection.input_chain_hash, `${field}.projection.input_chain_hash`);
    digest(
      projection.source_component_hash,
      `${field}.projection.source_component_hash`,
    );
    return jsonObject(binding, field);
  });
  const trackIds = trackPublic.map((binding) => String(binding.track_id));
  if (
    new Set(trackIds).size !== trackIds.length
    || trackIds.some((trackId, index) => index > 0 && trackId <= String(trackIds[index - 1]))
  ) {
    throw new TypeError("portfolio.hedge_inputs.track_public is not unique and canonical");
  }
  const rawAuditor = exactObject(input.auditor, "portfolio.hedge_inputs.auditor", [
    "status",
    "proof_hash",
    "difference_count",
    "difference_hashes",
  ]);
  const auditorStatus = enumValue(
    rawAuditor.status,
    ["NOT_RUN", "PASS", "FAIL"] as const,
    "portfolio.hedge_inputs.auditor.status",
  );
  const auditorProof = rawAuditor.proof_hash === null
    ? null
    : digest(rawAuditor.proof_hash, "portfolio.hedge_inputs.auditor.proof_hash");
  if (
    (auditorStatus === "NOT_RUN" && auditorProof !== null)
    || (auditorStatus !== "NOT_RUN" && auditorProof === null)
    || !Array.isArray(rawAuditor.difference_hashes)
  ) {
    throw new TypeError("portfolio.hedge_inputs auditor is inconsistent");
  }
  const differenceCount = counter(
    rawAuditor.difference_count,
    "portfolio.hedge_inputs.auditor.difference_count",
  );
  const differenceHashes = rawAuditor.difference_hashes.map((item, index) => digest(
    item,
    `portfolio.hedge_inputs.auditor.difference_hashes[${index}]`,
  ));
  if (differenceHashes.length !== differenceCount) {
    throw new TypeError("portfolio.hedge_inputs auditor difference count is inconsistent");
  }
  return {
    schema_version: "replay.hedge-input-view.v2",
    status,
    degraded_reason: input.degraded_reason as string | null,
    input_proof_hash: digest(
      input.input_proof_hash,
      "portfolio.hedge_inputs.input_proof_hash",
    ),
    time_domain: timeDomain,
    bound_range_start_ms: rangeStart,
    bound_range_end_ms: rangeEnd,
    public: parseObjectReceipt(input.public, "public"),
    simulation: parseObjectReceipt(input.simulation, "simulation"),
    projections,
    track_public: trackPublic,
    auditor: {
      status: auditorStatus,
      proof_hash: auditorProof,
      difference_count: differenceCount,
      difference_hashes: differenceHashes,
    },
  };
}

function parseReplayPositionProtection(
  value: unknown,
  field: string,
): ReplayPositionProtection {
  const protection = exactObject(value, field, ["orders"]);
  if (!Array.isArray(protection.orders)) throw new TypeError(`${field}.orders must be an array`);
  return {
    orders: protection.orders.map((value, index) => {
      const orderField = `${field}.orders[${index}]`;
      const order = exactObject(value, orderField, [
        "order_id", "order_type", "quantity", "remaining_quantity", "stop_price", "status",
      ]);
      return {
        order_id: identifier(order.order_id, `${orderField}.order_id`),
        order_type: enumValue(
          order.order_type,
          ["STOP_MARKET", "TAKE_PROFIT_MARKET"] as const,
          `${orderField}.order_type`,
        ),
        quantity: positiveDecimal(order.quantity, `${orderField}.quantity`),
        remaining_quantity: positiveDecimal(
          order.remaining_quantity,
          `${orderField}.remaining_quantity`,
        ),
        stop_price: positiveDecimal(order.stop_price, `${orderField}.stop_price`),
        status: enumValue(
          order.status,
          ["OPEN", "PARTIALLY_FILLED"] as const,
          `${orderField}.status`,
        ),
      };
    }),
  };
}

function parseReplayLiquidationBookExecution(
  value: unknown,
  field: string,
): ReplayLiquidationBookExecution {
  const execution = exactObject(value, field, [
    "case_id", "step_sequence", "track_id", "as_of_virtual_time_ms", "last_update_id",
    "side", "requested_quantity", "visible_quantity", "levels", "book_hash",
    "execution_fidelity", "queue_exact", "execution_plan_hash",
  ]);
  if (!Array.isArray(execution.levels)) throw new TypeError(`${field}.levels must be an array`);
  const queueExact = boolValue(execution.queue_exact, `${field}.queue_exact`);
  if (queueExact) throw new TypeError(`${field}.queue_exact must remain false`);
  return {
    case_id: identifier(execution.case_id, `${field}.case_id`),
    step_sequence: counter(execution.step_sequence, `${field}.step_sequence`),
    track_id: identifier(execution.track_id, `${field}.track_id`),
    as_of_virtual_time_ms: timestamp(
      execution.as_of_virtual_time_ms,
      `${field}.as_of_virtual_time_ms`,
    ),
    last_update_id: counter(execution.last_update_id, `${field}.last_update_id`),
    side: enumValue(execution.side, ["BUY", "SELL"] as const, `${field}.side`),
    requested_quantity: positiveDecimal(
      execution.requested_quantity,
      `${field}.requested_quantity`,
    ),
    visible_quantity: positiveDecimal(
      execution.visible_quantity,
      `${field}.visible_quantity`,
    ),
    levels: execution.levels.map((value, index) => {
      const levelField = `${field}.levels[${index}]`;
      const level = exactObject(value, levelField, ["book_level", "price", "quantity"]);
      return {
        book_level: counter(level.book_level, `${levelField}.book_level`),
        price: positiveDecimal(level.price, `${levelField}.price`),
        quantity: positiveDecimal(level.quantity, `${levelField}.quantity`),
      };
    }),
    book_hash: digest(execution.book_hash, `${field}.book_hash`),
    execution_fidelity: enumValue(
      execution.execution_fidelity,
      ["HISTORICAL_L2_VISIBLE_DEPTH_CONSERVATIVE_V1"] as const,
      `${field}.execution_fidelity`,
    ),
    queue_exact: false,
    execution_plan_hash: digest(
      execution.execution_plan_hash,
      `${field}.execution_plan_hash`,
    ),
  };
}

function parseReplayLiquidationCase(value: unknown, field: string): ReplayLiquidationCase {
  const item = exactObject(value, field, [
    "run_id", "case_id", "case_sequence", "state", "trigger_snapshot_id",
    "final_snapshot_id", "trigger_virtual_time_ms", "trigger_source_sequence", "reason",
    "fidelity", "component_hash", "legs", "book_snapshots", "steps",
  ]);
  if (!Array.isArray(item.legs) || !Array.isArray(item.book_snapshots) || !Array.isArray(item.steps)) {
    throw new TypeError(`${field} timeline collections must be arrays`);
  }
  return {
    run_id: identifier(item.run_id, `${field}.run_id`),
    case_id: identifier(item.case_id, `${field}.case_id`),
    case_sequence: counter(item.case_sequence, `${field}.case_sequence`),
    state: enumValue(item.state, [
      "RISK_BREACH_DETECTED", "CANCELING_ORDERS", "RISK_RECHECK", "PARTIAL_LIQUIDATION",
      "FULL_LIQUIDATION", "BANKRUPTCY_TRANSFER", "INSURANCE_FUND_SETTLEMENT", "ADL",
      "RECOVERED_AFTER_CANCEL", "COMPLETED", "BANKRUPT", "FAILED_CLOSED",
    ] as const, `${field}.state`),
    trigger_snapshot_id: identifier(item.trigger_snapshot_id, `${field}.trigger_snapshot_id`),
    final_snapshot_id: nullableIdentifier(item.final_snapshot_id, `${field}.final_snapshot_id`),
    trigger_virtual_time_ms: timestamp(
      item.trigger_virtual_time_ms,
      `${field}.trigger_virtual_time_ms`,
    ),
    trigger_source_sequence: counter(
      item.trigger_source_sequence,
      `${field}.trigger_source_sequence`,
    ),
    reason: displayString(item.reason, `${field}.reason`, 512),
    fidelity: displayString(item.fidelity, `${field}.fidelity`, 256),
    component_hash: digest(item.component_hash, `${field}.component_hash`),
    legs: item.legs.map((value, index) => {
      const legField = `${field}.legs[${index}]`;
      const leg = exactObject(value, legField, [
        "liquidation_leg_id", "leg_sequence", "track_id", "position_side",
        "trigger_quantity", "trigger_notional", "maintenance_margin", "liquidation_price",
        "bankruptcy_price", "takeover_price", "liquidation_fee", "target_quantity",
        "completed_quantity", "state", "component_hash",
      ]);
      return {
        liquidation_leg_id: identifier(
          leg.liquidation_leg_id,
          `${legField}.liquidation_leg_id`,
        ),
        leg_sequence: counter(leg.leg_sequence, `${legField}.leg_sequence`),
        track_id: identifier(leg.track_id, `${legField}.track_id`),
        position_side: enumValue(
          leg.position_side,
          ["LONG", "SHORT"] as const,
          `${legField}.position_side`,
        ),
        trigger_quantity: canonicalDecimal(leg.trigger_quantity, `${legField}.trigger_quantity`),
        trigger_notional: canonicalDecimal(leg.trigger_notional, `${legField}.trigger_notional`),
        maintenance_margin: canonicalDecimal(
          leg.maintenance_margin,
          `${legField}.maintenance_margin`,
        ),
        liquidation_price: nullableCanonicalDecimal(
          leg.liquidation_price,
          `${legField}.liquidation_price`,
        ),
        bankruptcy_price: nullableCanonicalDecimal(
          leg.bankruptcy_price,
          `${legField}.bankruptcy_price`,
        ),
        takeover_price: nullableCanonicalDecimal(
          leg.takeover_price,
          `${legField}.takeover_price`,
        ),
        liquidation_fee: canonicalDecimal(leg.liquidation_fee, `${legField}.liquidation_fee`),
        target_quantity: canonicalDecimal(leg.target_quantity, `${legField}.target_quantity`),
        completed_quantity: canonicalDecimal(
          leg.completed_quantity,
          `${legField}.completed_quantity`,
        ),
        state: enumValue(
          leg.state,
          ["PENDING", "PARTIAL", "CLOSED", "TRANSFERRED", "FAILED_CLOSED"] as const,
          `${legField}.state`,
        ),
        component_hash: digest(leg.component_hash, `${legField}.component_hash`),
      };
    }),
    book_snapshots: item.book_snapshots.map((value, index) => {
      const snapshotField = `${field}.book_snapshots[${index}]`;
      const snapshot = exactObject(value, snapshotField, [
        "case_id", "track_id", "as_of_virtual_time_ms", "last_update_id", "book_hash",
        "execution_fidelity", "queue_exact", "snapshot_hash",
      ]);
      const queueExact = boolValue(snapshot.queue_exact, `${snapshotField}.queue_exact`);
      if (queueExact) throw new TypeError(`${snapshotField}.queue_exact must remain false`);
      return {
        case_id: identifier(snapshot.case_id, `${snapshotField}.case_id`),
        track_id: identifier(snapshot.track_id, `${snapshotField}.track_id`),
        as_of_virtual_time_ms: timestamp(
          snapshot.as_of_virtual_time_ms,
          `${snapshotField}.as_of_virtual_time_ms`,
        ),
        last_update_id: counter(snapshot.last_update_id, `${snapshotField}.last_update_id`),
        book_hash: digest(snapshot.book_hash, `${snapshotField}.book_hash`),
        execution_fidelity: enumValue(
          snapshot.execution_fidelity,
          ["HISTORICAL_L2_VISIBLE_DEPTH_CONSERVATIVE_V1"] as const,
          `${snapshotField}.execution_fidelity`,
        ),
        queue_exact: false,
        snapshot_hash: digest(snapshot.snapshot_hash, `${snapshotField}.snapshot_hash`),
      };
    }),
    steps: item.steps.map((value, index) => {
      const stepField = `${field}.steps[${index}]`;
      const step = exactObject(value, stepField, [
        "step_sequence", "step_type", "state", "before_snapshot_id", "after_snapshot_id",
        "reason", "step_hash", "book_execution", "orders", "insurance_postings", "adl_events",
      ]);
      if (!Array.isArray(step.orders)
        || !Array.isArray(step.insurance_postings)
        || !Array.isArray(step.adl_events)) {
        throw new TypeError(`${stepField} collections must be arrays`);
      }
      const parseFill = (value: unknown, fillField: string): ReplayLiquidationFill => {
        const fill = exactObject(value, fillField, [
          "fill_id", "fill_sequence", "price", "quantity", "notional", "trading_fee",
          "liquidation_fee", "book_level", "virtual_time_ms", "source_sequence", "fill_hash",
        ]);
        return {
          fill_id: identifier(fill.fill_id, `${fillField}.fill_id`),
          fill_sequence: counter(fill.fill_sequence, `${fillField}.fill_sequence`),
          price: positiveDecimal(fill.price, `${fillField}.price`),
          quantity: positiveDecimal(fill.quantity, `${fillField}.quantity`),
          notional: positiveDecimal(fill.notional, `${fillField}.notional`),
          trading_fee: canonicalDecimal(fill.trading_fee, `${fillField}.trading_fee`),
          liquidation_fee: canonicalDecimal(
            fill.liquidation_fee,
            `${fillField}.liquidation_fee`,
          ),
          book_level: nullableCounter(fill.book_level, `${fillField}.book_level`),
          virtual_time_ms: timestamp(fill.virtual_time_ms, `${fillField}.virtual_time_ms`),
          source_sequence: counter(fill.source_sequence, `${fillField}.source_sequence`),
          fill_hash: digest(fill.fill_hash, `${fillField}.fill_hash`),
        };
      };
      const orders = step.orders.map((value, orderIndex) => {
        const orderField = `${stepField}.orders[${orderIndex}]`;
        const order = exactObject(value, orderField, [
          "order_id", "liquidation_leg_id", "order_sequence", "side", "order_type",
          "requested_quantity", "filled_quantity", "remaining_quantity", "average_price",
          "state", "order_hash", "fills",
        ]);
        if (!Array.isArray(order.fills)) throw new TypeError(`${orderField}.fills must be an array`);
        return {
          order_id: identifier(order.order_id, `${orderField}.order_id`),
          liquidation_leg_id: identifier(
            order.liquidation_leg_id,
            `${orderField}.liquidation_leg_id`,
          ),
          order_sequence: counter(order.order_sequence, `${orderField}.order_sequence`),
          side: enumValue(order.side, ["BUY", "SELL"] as const, `${orderField}.side`),
          order_type: enumValue(
            order.order_type,
            ["MARKET", "LIMIT"] as const,
            `${orderField}.order_type`,
          ),
          requested_quantity: positiveDecimal(
            order.requested_quantity,
            `${orderField}.requested_quantity`,
          ),
          filled_quantity: canonicalDecimal(
            order.filled_quantity,
            `${orderField}.filled_quantity`,
          ),
          remaining_quantity: canonicalDecimal(
            order.remaining_quantity,
            `${orderField}.remaining_quantity`,
          ),
          average_price: nullableCanonicalDecimal(
            order.average_price,
            `${orderField}.average_price`,
          ),
          state: enumValue(order.state, [
            "NEW", "PARTIALLY_FILLED", "FILLED", "CANCELED", "FAILED_CLOSED",
          ] as const, `${orderField}.state`),
          order_hash: digest(order.order_hash, `${orderField}.order_hash`),
          fills: order.fills.map((value, fillIndex) => (
            parseFill(value, `${orderField}.fills[${fillIndex}]`)
          )),
        };
      });
      const insurancePostings = step.insurance_postings.map((value, postingIndex) => {
        const postingField = `${stepField}.insurance_postings[${postingIndex}]`;
        const posting = exactObject(value, postingField, [
          "asset", "posting_sequence", "posting_id", "cash_delta", "balance_after", "reason",
          "posting_hash",
        ]);
        return {
          asset: identifier(posting.asset, `${postingField}.asset`),
          posting_sequence: counter(
            posting.posting_sequence,
            `${postingField}.posting_sequence`,
          ),
          posting_id: identifier(posting.posting_id, `${postingField}.posting_id`),
          cash_delta: canonicalDecimal(posting.cash_delta, `${postingField}.cash_delta`),
          balance_after: canonicalDecimal(posting.balance_after, `${postingField}.balance_after`),
          reason: displayString(posting.reason, `${postingField}.reason`, 512),
          posting_hash: digest(posting.posting_hash, `${postingField}.posting_hash`),
        };
      });
      const adlEvents = step.adl_events.map((value, eventIndex) => {
        const eventField = `${stepField}.adl_events[${eventIndex}]`;
        const event = exactObject(value, eventField, [
          "adl_event_id", "snapshot_id", "required_notional", "completed_notional", "state",
          "event_hash", "selections", "counterparty_ledger",
        ]);
        if (!Array.isArray(event.selections) || !Array.isArray(event.counterparty_ledger)) {
          throw new TypeError(`${eventField} collections must be arrays`);
        }
        return {
          adl_event_id: identifier(event.adl_event_id, `${eventField}.adl_event_id`),
          snapshot_id: identifier(event.snapshot_id, `${eventField}.snapshot_id`),
          required_notional: canonicalDecimal(
            event.required_notional,
            `${eventField}.required_notional`,
          ),
          completed_notional: canonicalDecimal(
            event.completed_notional,
            `${eventField}.completed_notional`,
          ),
          state: enumValue(
            event.state,
            ["PENDING", "COMPLETED", "FAILED_CLOSED"] as const,
            `${eventField}.state`,
          ),
          event_hash: digest(event.event_hash, `${eventField}.event_hash`),
          selections: event.selections.map((value, selectionIndex) => {
            const selectionField = `${eventField}.selections[${selectionIndex}]`;
            const selection = exactObject(value, selectionField, [
              "selection_sequence", "candidate_id", "snapshot_id", "quantity", "price",
              "notional", "cash_delta", "selection_hash",
            ]);
            return {
              selection_sequence: counter(
                selection.selection_sequence,
                `${selectionField}.selection_sequence`,
              ),
              candidate_id: identifier(selection.candidate_id, `${selectionField}.candidate_id`),
              snapshot_id: identifier(selection.snapshot_id, `${selectionField}.snapshot_id`),
              quantity: positiveDecimal(selection.quantity, `${selectionField}.quantity`),
              price: positiveDecimal(selection.price, `${selectionField}.price`),
              notional: positiveDecimal(selection.notional, `${selectionField}.notional`),
              cash_delta: canonicalDecimal(selection.cash_delta, `${selectionField}.cash_delta`),
              selection_hash: digest(selection.selection_hash, `${selectionField}.selection_hash`),
            };
          }),
          counterparty_ledger: event.counterparty_ledger.map((value, ledgerIndex) => {
            const ledgerField = `${eventField}.counterparty_ledger[${ledgerIndex}]`;
            const entry = exactObject(value, ledgerField, [
              "ledger_sequence", "candidate_id", "snapshot_id", "position_side",
              "quantity_before", "quantity_delta", "quantity_after", "takeover_price",
              "cash_delta", "entry_hash",
            ]);
            return {
              ledger_sequence: counter(entry.ledger_sequence, `${ledgerField}.ledger_sequence`),
              candidate_id: identifier(entry.candidate_id, `${ledgerField}.candidate_id`),
              snapshot_id: identifier(entry.snapshot_id, `${ledgerField}.snapshot_id`),
              position_side: enumValue(
                entry.position_side,
                ["LONG", "SHORT"] as const,
                `${ledgerField}.position_side`,
              ),
              quantity_before: canonicalDecimal(
                entry.quantity_before,
                `${ledgerField}.quantity_before`,
              ),
              quantity_delta: canonicalDecimal(
                entry.quantity_delta,
                `${ledgerField}.quantity_delta`,
              ),
              quantity_after: canonicalDecimal(
                entry.quantity_after,
                `${ledgerField}.quantity_after`,
              ),
              takeover_price: positiveDecimal(
                entry.takeover_price,
                `${ledgerField}.takeover_price`,
              ),
              cash_delta: canonicalDecimal(entry.cash_delta, `${ledgerField}.cash_delta`),
              entry_hash: digest(entry.entry_hash, `${ledgerField}.entry_hash`),
            };
          }),
        };
      });
      return {
        step_sequence: counter(step.step_sequence, `${stepField}.step_sequence`),
        step_type: enumValue(step.step_type, [
          "CANCEL_ORDERS", "RISK_RECHECK", "PARTIAL_LIQUIDATION", "FULL_LIQUIDATION",
          "BANKRUPTCY_TRANSFER", "INSURANCE_FUND_SETTLEMENT", "ADL", "COMPLETE",
          "FAILED_CLOSED",
        ] as const, `${stepField}.step_type`),
        state: enumValue(
          step.state,
          ["PENDING", "APPLIED", "FAILED_CLOSED"] as const,
          `${stepField}.state`,
        ),
        before_snapshot_id: identifier(
          step.before_snapshot_id,
          `${stepField}.before_snapshot_id`,
        ),
        after_snapshot_id: nullableIdentifier(
          step.after_snapshot_id,
          `${stepField}.after_snapshot_id`,
        ),
        reason: displayString(step.reason, `${stepField}.reason`, 512),
        step_hash: digest(step.step_hash, `${stepField}.step_hash`),
        book_execution: step.book_execution === null
          ? null
          : parseReplayLiquidationBookExecution(
            step.book_execution,
            `${stepField}.book_execution`,
          ),
        orders,
        insurance_postings: insurancePostings,
        adl_events: adlEvents,
      };
    }),
  };
}

export function parseReplayLiquidationCases(
  value: unknown,
  field = "liquidations",
): readonly ReplayLiquidationCase[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value.map((item, index) => parseReplayLiquidationCase(item, `${field}[${index}]`));
}

export function parseReplayTrainingPortfolio(value: unknown): ReplayTrainingPortfolio {
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
      ...(
        Object.hasOwn(value as object, "position_mode")
          ? ["position_mode"]
          : []
      ),
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
      "history",
      "active_fee_policy",
      "instrument_rules",
      "isolated_allocations",
      "next_funding_time_ms",
      "liquidations",
      "liquidation_recoveries",
      "hedge_state",
      "hedge_inputs",
      "account_history",
      "liquidation_channels",
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
    const rawLiquidationRecoveries = objectList(
      portfolio.liquidation_recoveries,
      "portfolio.liquidation_recoveries",
    );
    const rawHistory = exactObject(portfolio.history, "portfolio.history", [
      "orders_total",
      "active_orders",
      "historical_orders",
      "fills_total",
      "ledger_entries_total",
      "page_limit_max",
    ]);
    const history = {
      orders_total: counter(rawHistory.orders_total, "portfolio.history.orders_total"),
      active_orders: counter(rawHistory.active_orders, "portfolio.history.active_orders"),
      historical_orders: counter(
        rawHistory.historical_orders,
        "portfolio.history.historical_orders",
      ),
      fills_total: counter(rawHistory.fills_total, "portfolio.history.fills_total"),
      ledger_entries_total: counter(
        rawHistory.ledger_entries_total,
        "portfolio.history.ledger_entries_total",
      ),
      page_limit_max: counter(rawHistory.page_limit_max, "portfolio.history.page_limit_max"),
    };
    if (
      history.orders_total !== history.active_orders + history.historical_orders
      || history.active_orders !== rawOrders.length
      || rawFills.length !== 0
      || history.page_limit_max < 1
      || history.page_limit_max > 200
    ) {
      throw new TypeError("portfolio history counters are inconsistent");
    }
    const accountHistory = parseReplayAccountHistoryProjection(portfolio.account_history);
    const liquidationChannels = parseReplayLiquidationChannels(
      portfolio.liquidation_channels,
      accountHistory.mode,
    );
    const positions = rawPositions.map((position, index) => {
      const field = `portfolio.positions[${index}]`;
      const item = exactObject(position, field, [
        "track_id",
        "symbol",
        ...(Object.hasOwn(position as object, "position_side") ? ["position_side"] : []),
        "position",
        "leverage",
        "initial_margin",
        "account_notional",
        "maintenance_margin",
        ...(Object.hasOwn(position as object, "liquidation_price") ? ["liquidation_price"] : []),
        ...(Object.hasOwn(position as object, "bankruptcy_price") ? ["bankruptcy_price"] : []),
        ...(Object.hasOwn(position as object, "accumulated_funding") ? ["accumulated_funding"] : []),
        ...(Object.hasOwn(position as object, "trading_fees") ? ["trading_fees"] : []),
        ...(Object.hasOwn(position as object, "liquidation_fees") ? ["liquidation_fees"] : []),
        ...(Object.hasOwn(position as object, "protection") ? ["protection"] : []),
        "isolated_margin",
        "isolated_allocation_key",
        "risk_tier",
        ...(Object.hasOwn(position as object, "position_leg_hash") ? ["position_leg_hash"] : []),
        "margin_equity",
        "risk_ratio",
        "rule_revision",
        "rule_hash",
        "mark_fidelity",
      ]);
      return {
        track_id: identifier(item.track_id, `${field}.track_id`),
        symbol: identifier(item.symbol, `${field}.symbol`),
        ...(Object.hasOwn(item, "position_side")
          ? {
              position_side: enumValue(
                item.position_side,
                ["LONG", "SHORT"] as const,
                `${field}.position_side`,
              ),
            }
          : {}),
        position: jsonObject(item.position, `${field}.position`),
        leverage: positiveDecimal(item.leverage, `${field}.leverage`),
        initial_margin: canonicalDecimal(
          item.initial_margin,
          `${field}.initial_margin`,
        ),
        account_notional: canonicalDecimal(
          item.account_notional,
          `${field}.account_notional`,
        ),
        maintenance_margin: canonicalDecimal(
          item.maintenance_margin,
          `${field}.maintenance_margin`,
        ),
        ...(Object.hasOwn(item, "liquidation_price")
          ? {
              liquidation_price: nullableCanonicalDecimal(
                item.liquidation_price,
                `${field}.liquidation_price`,
              ),
            }
          : {}),
        ...(Object.hasOwn(item, "bankruptcy_price")
          ? {
              bankruptcy_price: nullableCanonicalDecimal(
                item.bankruptcy_price,
                `${field}.bankruptcy_price`,
              ),
            }
          : {}),
        ...(Object.hasOwn(item, "accumulated_funding")
          ? {
              accumulated_funding: canonicalDecimal(
                item.accumulated_funding,
                `${field}.accumulated_funding`,
              ),
            }
          : {}),
        ...(Object.hasOwn(item, "trading_fees")
          ? { trading_fees: canonicalDecimal(item.trading_fees, `${field}.trading_fees`) }
          : {}),
        ...(Object.hasOwn(item, "liquidation_fees")
          ? {
              liquidation_fees: canonicalDecimal(
                item.liquidation_fees,
                `${field}.liquidation_fees`,
              ),
            }
          : {}),
        ...(Object.hasOwn(item, "protection")
          ? { protection: parseReplayPositionProtection(item.protection, `${field}.protection`) }
          : {}),
        isolated_margin: canonicalDecimal(item.isolated_margin, `${field}.isolated_margin`),
        isolated_allocation_key: identifier(
          item.isolated_allocation_key,
          `${field}.isolated_allocation_key`,
        ),
        risk_tier: counter(item.risk_tier, `${field}.risk_tier`),
        ...(Object.hasOwn(item as object, "position_leg_hash")
          ? { position_leg_hash: digest(item.position_leg_hash, `${field}.position_leg_hash`) }
          : {}),
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
      position_mode: Object.hasOwn(portfolio, "position_mode")
        ? enumValue(portfolio.position_mode, REPLAY_V2_ENUMS.position_mode, "portfolio.position_mode")
        : "ONE_WAY",
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
      history,
      active_fee_policy: portfolio.active_fee_policy === null
        ? null
        : jsonObject(portfolio.active_fee_policy, "portfolio.active_fee_policy"),
      instrument_rules: objectArray(rawRules, "portfolio.instrument_rules"),
      isolated_allocations: jsonObject(portfolio.isolated_allocations, "portfolio.isolated_allocations"),
      next_funding_time_ms: portfolio.next_funding_time_ms === null
        ? null
        : counter(portfolio.next_funding_time_ms, "portfolio.next_funding_time_ms"),
      liquidations: parseReplayLiquidationCases(rawLiquidations, "portfolio.liquidations"),
      liquidation_recoveries: parseReplayLiquidationCases(
        rawLiquidationRecoveries,
        "portfolio.liquidation_recoveries",
      ),
      hedge_state: jsonObject(portfolio.hedge_state, "portfolio.hedge_state"),
      hedge_inputs: parseReplayHedgeInputView(portfolio.hedge_inputs),
      account_history: accountHistory,
      liquidation_channels: liquidationChannels,
      ledger: jsonObject(portfolio.ledger, "portfolio.ledger"),
      fidelity: jsonObject(portfolio.fidelity, "portfolio.fidelity"),
    };
  }
  const portfolio = exactObject(value, "portfolio", [
    "schema_version",
    "fidelity",
    "settlement_account_shared",
    ...(Object.hasOwn(value as object, "position_mode") ? ["position_mode"] : []),
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
    position_mode: Object.hasOwn(portfolio, "position_mode")
      ? enumValue(portfolio.position_mode, REPLAY_V2_ENUMS.position_mode, "portfolio.position_mode")
      : "ONE_WAY",
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
      const item = exactObject(position, field, [
        "track_id",
        "symbol",
        "position",
        ...(Object.hasOwn(position as object, "position_side") ? ["position_side"] : []),
      ]);
      return {
        track_id: identifier(item.track_id, `${field}.track_id`),
        symbol: identifier(item.symbol, `${field}.symbol`),
        ...(Object.hasOwn(item, "position_side")
          ? {
              position_side: enumValue(
                item.position_side,
                ["LONG", "SHORT"] as const,
                `${field}.position_side`,
              ),
            }
          : {}),
        position: jsonObject(item.position, `${field}.position`),
      };
    }),
  };
}

export function parseReplayAccountRecordPage(value: unknown): ReplayAccountRecordPage {
  const page = exactObject(value, "account record page", [
    "protocol",
    "schema_version",
    "run_id",
    "record_type",
    "order_scope",
    "track_id",
    "items",
    "total_count",
    "next_cursor",
  ]);
  if (
    page.protocol !== REPLAY_V2_PROTOCOL
    || page.schema_version !== "replay.training.account-record-page.v1"
    || !Array.isArray(page.items)
  ) {
    throw new TypeError("account record page contract is unsupported");
  }
  const recordType = enumValue(
    page.record_type,
    enumValues("ORDERS", "FILLS", "LEDGER"),
    "account record page.record_type",
  );
  const orderScope = enumValue(
    page.order_scope,
    enumValues("ACTIVE", "HISTORY", "ALL"),
    "account record page.order_scope",
  );
  if (recordType !== "ORDERS" && orderScope !== "ALL") {
    throw new TypeError("account record page order scope is inconsistent");
  }
  if (
    page.next_cursor !== null
    && (
      typeof page.next_cursor !== "string"
      || page.next_cursor.length < 1
      || page.next_cursor.length > 2_048
      || !/^[A-Za-z0-9_-]+$/.test(page.next_cursor)
    )
  ) {
    throw new TypeError("account record page cursor is invalid");
  }
  return {
    protocol: REPLAY_V2_PROTOCOL,
    schema_version: "replay.training.account-record-page.v1",
    run_id: identifier(page.run_id, "account record page.run_id"),
    record_type: recordType,
    order_scope: orderScope,
    track_id: page.track_id === null
      ? null
      : identifier(page.track_id, "account record page.track_id"),
    items: page.items.map((item, index) => jsonObject(
      item,
      `account record page.items[${index}]`,
    )),
    total_count: counter(page.total_count, "account record page.total_count"),
    next_cursor: page.next_cursor as string | null,
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
  const launchContext = response.launch_context === null
    ? null
    : parseReplayLaunchContext(response.launch_context);
  const primaryTrack = tracks.find((track) => track.stable_ordinal === 1) ?? null;
  const emptyRun = tracks.length === 0
    && viewer.selected_track_id === null
    && launchContext === null
    && response.global_clock === null;
  const initializedRun = primaryTrack !== null
    && viewer.selected_track_id !== null
    && launchContext !== null
    && response.global_clock !== null
    && tracks.some((track) => track.track_id === viewer.selected_track_id)
    && primaryTrack.exchange === launchContext.exchange
    && primaryTrack.market_type === launchContext.market_type
    && primaryTrack.symbol === launchContext.symbol;
  if (
    viewer.run_id !== runId
    || tracks.some((track) => track.run_id !== runId)
    || (!emptyRun && !initializedRun)
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
    global_clock: response.global_clock === null
      ? null
      : parseReplayGlobalClock(response.global_clock),
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
    selected_track_id: nullableIdentifier(
      viewer.selected_track_id,
      "viewer_state.selected_track_id",
    ),
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

export type TrainingRunCompatibility = "READY" | "UNAVAILABLE";
export type TrainingRunResumeAction = "SELECT_MARKET" | "OPEN_ADAPTER" | "UNAVAILABLE";
export type TrainingRunEquityStatus = "CURRENT" | "STALE";

export interface TrainingRunCard {
  readonly run_id: string;
  readonly kind: "V2";
  readonly name: string;
  readonly state: ReplayV2RunState;
  readonly source_kind: ReplayV2SourceKind;
  readonly integrity_mode: ReplayV2IntegrityMode;
  readonly time_disclosure_policy: ReplayV2TimeDisclosurePolicy;
  readonly last_symbol: string | null;
  readonly subscribed_track_count: number;
  readonly progress: { readonly source_sequence: number };
  readonly equity: string | null;
  readonly equity_status: TrainingRunEquityStatus;
  readonly settlement_asset: string;
  readonly updated_at_ms: number;
  readonly compatibility: TrainingRunCompatibility;
  readonly resume_action: TrainingRunResumeAction;
  readonly adapter_session_id: string | null;
  readonly status: { readonly code: string; readonly message: string };
  readonly report_available: boolean;
  readonly review_available: boolean;
}

export interface TrainingRunListResponse {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly schema_version: "replay.training.v2";
  readonly items: readonly TrainingRunCard[];
  readonly next_cursor: string | null;
}

export interface TrainingRunMutationResponse {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly created: boolean;
  readonly run: TrainingRunCard;
}

export interface TrainingRunMarketSelectionResponse {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly initialized: true;
  readonly run: TrainingRunCard;
}

function parseReplayOrderRequest(value: unknown, fieldName: string): ReplayOrderRequest {
  const raw = objectValue(value, fieldName);
  const required = [
    "client_order_id",
    "side",
    "order_type",
    "quantity",
    "reduce_only",
    "limit_price",
    "stop_price",
  ] as const;
  for (const key of required) {
    if (!Object.hasOwn(raw, key)) {
      throw new TypeError(`${fieldName} missing ${key}`);
    }
  }
  const unknown = Object.keys(raw).filter((key) => (
    !(required as readonly string[]).includes(key)
      && key !== "leverage"
      && key !== "position_side"
  ));
  if (unknown.length > 0) {
    throw new TypeError(`${fieldName} has unknown ${unknown.join(", ")}`);
  }
  const leverage = !Object.hasOwn(raw, "leverage") || raw.leverage === null || raw.leverage === undefined
    ? null
    : positiveDecimal(raw.leverage, `${fieldName}.leverage`);
  return {
    client_order_id: identifier(raw.client_order_id, `${fieldName}.client_order_id`),
    side: enumValue(raw.side, ["BUY", "SELL"] as const, `${fieldName}.side`),
    order_type: enumValue(
      raw.order_type,
      ["MARKET", "LIMIT", "STOP_MARKET", "TAKE_PROFIT_MARKET"] as const,
      `${fieldName}.order_type`,
    ),
    quantity: positiveDecimal(raw.quantity, `${fieldName}.quantity`),
    reduce_only: boolValue(raw.reduce_only, `${fieldName}.reduce_only`),
    limit_price: raw.limit_price === null
      ? null
      : positiveDecimal(raw.limit_price, `${fieldName}.limit_price`),
    stop_price: raw.stop_price === null
      ? null
      : positiveDecimal(raw.stop_price, `${fieldName}.stop_price`),
    leverage,
    position_side: !Object.hasOwn(raw, "position_side") || raw.position_side === null
      ? null
      : enumValue(raw.position_side, ["LONG", "SHORT"] as const, `${fieldName}.position_side`),
  };
}

function parseReplayOrderCapacityContext(
  value: unknown,
  fieldName: string,
): ReplayOrderCapacityContext {
  const raw = objectValue(value, fieldName);
  const required = [
    "side",
    "order_type",
    "reduce_only",
    "limit_price",
    "stop_price",
  ] as const;
  for (const key of required) {
    if (!Object.hasOwn(raw, key)) throw new TypeError(`${fieldName} missing ${key}`);
  }
  const unknown = Object.keys(raw).filter((key) => (
    !(required as readonly string[]).includes(key)
      && key !== "leverage"
      && key !== "position_side"
  ));
  if (unknown.length > 0) throw new TypeError(`${fieldName} has unknown ${unknown.join(", ")}`);
  return {
    side: enumValue(raw.side, ["BUY", "SELL"] as const, `${fieldName}.side`),
    order_type: enumValue(
      raw.order_type,
      ["MARKET", "LIMIT", "STOP_MARKET", "TAKE_PROFIT_MARKET"] as const,
      `${fieldName}.order_type`,
    ),
    reduce_only: boolValue(raw.reduce_only, `${fieldName}.reduce_only`),
    limit_price: raw.limit_price === null
      ? null
      : positiveDecimal(raw.limit_price, `${fieldName}.limit_price`),
    stop_price: raw.stop_price === null
      ? null
      : positiveDecimal(raw.stop_price, `${fieldName}.stop_price`),
    leverage: !Object.hasOwn(raw, "leverage") || raw.leverage === null || raw.leverage === undefined
      ? null
      : positiveDecimal(raw.leverage, `${fieldName}.leverage`),
    position_side: !Object.hasOwn(raw, "position_side") || raw.position_side === null
      ? null
      : enumValue(raw.position_side, ["LONG", "SHORT"] as const, `${fieldName}.position_side`),
  };
}

function parseReplayTradePlanSnapshot(
  value: unknown,
  fieldName: string,
): ReplayTradePlanSnapshot {
  const plan = exactObject(value, fieldName, [
    "schema_version",
    "track_id",
    "client_order_id",
    "side",
    "order_type",
    "sizing_mode",
    "risk_amount",
    "risk_percent",
    "account_equity",
    "entry_price",
    "invalidation_price",
    "target_price",
    "risk_per_unit",
    "reward_risk_ratio",
    "quantity",
    "reason",
  ]);
  if (plan.schema_version !== "replay.trade-plan.snapshot.v1") {
    throw new TypeError(`${fieldName} schema is unsupported`);
  }
  if (typeof plan.reason !== "string" || !plan.reason.trim() || plan.reason.length > 500) {
    throw new TypeError(`${fieldName}.reason is invalid`);
  }
  return {
    schema_version: "replay.trade-plan.snapshot.v1",
    track_id: identifier(plan.track_id, `${fieldName}.track_id`),
    client_order_id: identifier(plan.client_order_id, `${fieldName}.client_order_id`),
    side: enumValue(plan.side, ["BUY", "SELL"] as const, `${fieldName}.side`),
    order_type: enumValue(plan.order_type, ["MARKET", "LIMIT"] as const, `${fieldName}.order_type`),
    sizing_mode: enumValue(
      plan.sizing_mode,
      ["RISK_AMOUNT", "ACCOUNT_RISK_PERCENT"] as const,
      `${fieldName}.sizing_mode`,
    ),
    risk_amount: positiveDecimal(plan.risk_amount, `${fieldName}.risk_amount`),
    risk_percent: plan.risk_percent === null
      ? null
      : positiveDecimal(plan.risk_percent, `${fieldName}.risk_percent`),
    account_equity: positiveDecimal(plan.account_equity, `${fieldName}.account_equity`),
    entry_price: positiveDecimal(plan.entry_price, `${fieldName}.entry_price`),
    invalidation_price: positiveDecimal(
      plan.invalidation_price,
      `${fieldName}.invalidation_price`,
    ),
    target_price: positiveDecimal(plan.target_price, `${fieldName}.target_price`),
    risk_per_unit: positiveDecimal(plan.risk_per_unit, `${fieldName}.risk_per_unit`),
    reward_risk_ratio: positiveDecimal(
      plan.reward_risk_ratio,
      `${fieldName}.reward_risk_ratio`,
    ),
    quantity: positiveDecimal(plan.quantity, `${fieldName}.quantity`),
    reason: plan.reason.trim(),
  };
}

export function parseReplayOrderPreview(value: unknown): ReplayOrderPreview {
  const rawPreview = objectValue(value, "order preview");
  const schemaVersion = enumValue(
    rawPreview.schema_version,
    ["replay.order-preview.v1", "replay.order-preview.v2"] as const,
    "order preview.schema_version",
  );
  const preview = exactObject(value, "order preview", [
    "protocol",
    "schema_version",
    "run_id",
    "track_id",
    "accepted",
    "position_intent",
    "revision",
    "cursor",
    "state_hash",
    "execution_fidelity",
    "order",
    "reference_price",
    "estimated_fill_price",
    "estimated_notional",
    "reserved_margin",
    "estimated_fee",
    "fee_basis",
    "available_equity_after",
    "max_quantity",
    "quote_asset",
    "max_leverage",
    ...(schemaVersion === "replay.order-preview.v2" ? ["trade_plan"] : []),
  ]);
  if (
    preview.protocol !== REPLAY_V2_PROTOCOL
    || preview.accepted !== true
    || preview.fee_basis !== "TAKER_WORST_CASE"
  ) {
    throw new TypeError("order preview contract is unsupported");
  }
  const revision = counter(preview.revision, "order preview.revision");
  const cursor = parseCursor(preview.cursor, "order preview.cursor");
  if (cursor.revision !== revision) {
    throw new TypeError("order preview cursor revision is inconsistent");
  }
  return {
    protocol: REPLAY_V2_PROTOCOL,
    schema_version: schemaVersion,
    run_id: identifier(preview.run_id, "order preview.run_id"),
    track_id: identifier(preview.track_id, "order preview.track_id"),
    accepted: true,
    position_intent: enumValue(
      preview.position_intent,
      ["NET", "OPEN"] as const,
      "order preview.position_intent",
    ),
    revision,
    cursor,
    state_hash: digest(preview.state_hash, "order preview.state_hash"),
    execution_fidelity: enumValue(
      preview.execution_fidelity,
      ["BAR_CONSERVATIVE", "AGG_TRADE_TAPE"] as const,
      "order preview.execution_fidelity",
    ),
    order: parseReplayOrderRequest(preview.order, "order preview.order"),
    reference_price: positiveDecimal(preview.reference_price, "order preview.reference_price"),
    estimated_fill_price: positiveDecimal(
      preview.estimated_fill_price,
      "order preview.estimated_fill_price",
    ),
    estimated_notional: positiveDecimal(
      preview.estimated_notional,
      "order preview.estimated_notional",
    ),
    reserved_margin: canonicalDecimal(preview.reserved_margin, "order preview.reserved_margin"),
    estimated_fee: canonicalDecimal(preview.estimated_fee, "order preview.estimated_fee"),
    fee_basis: "TAKER_WORST_CASE",
    available_equity_after: canonicalDecimal(
      preview.available_equity_after,
      "order preview.available_equity_after",
    ),
    max_quantity: canonicalDecimal(preview.max_quantity, "order preview.max_quantity"),
    quote_asset: identifier(preview.quote_asset, "order preview.quote_asset"),
    max_leverage: positiveDecimal(preview.max_leverage, "order preview.max_leverage"),
    trade_plan: schemaVersion === "replay.order-preview.v1"
      ? null
      : parseReplayTradePlanSnapshot(preview.trade_plan, "order preview.trade_plan"),
  };
}

export function parseReplayOrderCapacity(value: unknown): ReplayOrderCapacity {
  const capacity = exactObject(value, "order capacity", [
    "protocol",
    "schema_version",
    "run_id",
    "track_id",
    "position_intent",
    "revision",
    "cursor",
    "state_hash",
    "execution_fidelity",
    "context",
    "reference_price",
    "max_quantity",
    "quote_asset",
    "max_leverage",
  ]);
  if (
    capacity.protocol !== REPLAY_V2_PROTOCOL
    || capacity.schema_version !== "replay.order-capacity.v1"
  ) {
    throw new TypeError("order capacity contract is unsupported");
  }
  const revision = counter(capacity.revision, "order capacity.revision");
  const cursor = parseCursor(capacity.cursor, "order capacity.cursor");
  if (cursor.revision !== revision) {
    throw new TypeError("order capacity cursor revision is inconsistent");
  }
  return {
    protocol: REPLAY_V2_PROTOCOL,
    schema_version: "replay.order-capacity.v1",
    run_id: identifier(capacity.run_id, "order capacity.run_id"),
    track_id: identifier(capacity.track_id, "order capacity.track_id"),
    position_intent: enumValue(
      capacity.position_intent,
      ["NET", "OPEN"] as const,
      "order capacity.position_intent",
    ),
    revision,
    cursor,
    state_hash: digest(capacity.state_hash, "order capacity.state_hash"),
    execution_fidelity: enumValue(
      capacity.execution_fidelity,
      ["BAR_CONSERVATIVE", "AGG_TRADE_TAPE"] as const,
      "order capacity.execution_fidelity",
    ),
    context: parseReplayOrderCapacityContext(capacity.context, "order capacity.context"),
    reference_price: positiveDecimal(capacity.reference_price, "order capacity.reference_price"),
    max_quantity: canonicalDecimal(capacity.max_quantity, "order capacity.max_quantity"),
    quote_asset: identifier(capacity.quote_asset, "order capacity.quote_asset"),
    max_leverage: positiveDecimal(capacity.max_leverage, "order capacity.max_leverage"),
  };
}

function parseReplayTrainingResultPlan(
  value: unknown,
  fieldName: string,
): ReplayTrainingResultPlan {
  const plan = exactObject(value, fieldName, [
    "plan_id",
    "plan_hash",
    "sizing_mode",
    "risk_amount",
    "risk_percent",
    "entry_price",
    "invalidation_price",
    "target_price",
    "reward_risk_ratio",
    "quantity",
    "reason",
  ]);
  if (typeof plan.reason !== "string" || !plan.reason.trim() || plan.reason.length > 500) {
    throw new TypeError(`${fieldName}.reason is invalid`);
  }
  return {
    plan_id: identifier(plan.plan_id, `${fieldName}.plan_id`),
    plan_hash: digest(plan.plan_hash, `${fieldName}.plan_hash`),
    sizing_mode: enumValue(
      plan.sizing_mode,
      ["RISK_AMOUNT", "ACCOUNT_RISK_PERCENT"] as const,
      `${fieldName}.sizing_mode`,
    ),
    risk_amount: positiveDecimal(plan.risk_amount, `${fieldName}.risk_amount`),
    risk_percent: plan.risk_percent === null
      ? null
      : positiveDecimal(plan.risk_percent, `${fieldName}.risk_percent`),
    entry_price: positiveDecimal(plan.entry_price, `${fieldName}.entry_price`),
    invalidation_price: positiveDecimal(
      plan.invalidation_price,
      `${fieldName}.invalidation_price`,
    ),
    target_price: positiveDecimal(plan.target_price, `${fieldName}.target_price`),
    reward_risk_ratio: positiveDecimal(
      plan.reward_risk_ratio,
      `${fieldName}.reward_risk_ratio`,
    ),
    quantity: positiveDecimal(plan.quantity, `${fieldName}.quantity`),
    reason: plan.reason.trim(),
  };
}

export function parseReplayTrainingResultsResponse(
  value: unknown,
): ReplayTrainingResultsResponse {
  const response = exactObject(value, "training results", [
    "protocol",
    "schema_version",
    "run_id",
    "summary",
    "items",
    "returned_count",
    "truncated",
    "data_fidelity",
    "execution_fidelity",
  ]);
  if (
    response.protocol !== REPLAY_V2_PROTOCOL
    || response.schema_version !== "replay.training-results.v1"
    || !Array.isArray(response.items)
  ) {
    throw new TypeError("training results contract is unsupported");
  }
  const summary = exactObject(response.summary, "training results.summary", [
    "trade_count",
    "win_count",
    "loss_count",
    "win_rate",
    "gross_realized_pnl",
    "average_win",
    "average_loss",
    "payoff_ratio",
    "average_mae",
    "average_mfe",
    "average_r_multiple",
    "average_holding_duration_ms",
    "planned_trade_count",
    "max_drawdown",
    "profit_factor",
    "fees_paid",
    "net_realized_pnl",
  ]);
  const items = response.items.map((valueItem, index): ReplayTrainingResultItem => {
    const item = exactObject(valueItem, `training results.items[${index}]`, [
      "trade_id",
      "episode_id",
      "track_id",
      "symbol",
      "settlement_asset",
      "fill_id",
      "position_side",
      "quantity",
      "entry_price",
      "exit_price",
      "gross_realized_pnl",
      "mae",
      "mfe",
      "initial_risk_amount",
      "r_multiple",
      "holding_duration_ms",
      "entry_source_sequence",
      "exit_source_sequence",
      "entry_public_time",
      "exit_public_time",
      "plans",
      "review_event_id",
      "excursion_fidelity",
      "pnl_basis",
    ]);
    if (!Array.isArray(item.plans)) throw new TypeError("training result plans must be an array");
    return {
      trade_id: identifier(item.trade_id, `training results.items[${index}].trade_id`),
      episode_id: identifier(item.episode_id, `training results.items[${index}].episode_id`),
      track_id: identifier(item.track_id, `training results.items[${index}].track_id`),
      symbol: marketIdentity(item.symbol, `training results.items[${index}].symbol`),
      settlement_asset: marketIdentity(
        item.settlement_asset,
        `training results.items[${index}].settlement_asset`,
      ),
      fill_id: identifier(item.fill_id, `training results.items[${index}].fill_id`),
      position_side: enumValue(
        item.position_side,
        ["BUY", "SELL"] as const,
        `training results.items[${index}].position_side`,
      ),
      quantity: positiveDecimal(item.quantity, `training results.items[${index}].quantity`),
      entry_price: positiveDecimal(
        item.entry_price,
        `training results.items[${index}].entry_price`,
      ),
      exit_price: positiveDecimal(item.exit_price, `training results.items[${index}].exit_price`),
      gross_realized_pnl: canonicalDecimal(
        item.gross_realized_pnl,
        `training results.items[${index}].gross_realized_pnl`,
      ),
      mae: canonicalDecimal(item.mae, `training results.items[${index}].mae`),
      mfe: canonicalDecimal(item.mfe, `training results.items[${index}].mfe`),
      initial_risk_amount: item.initial_risk_amount === null
        ? null
        : positiveDecimal(
          item.initial_risk_amount,
          `training results.items[${index}].initial_risk_amount`,
        ),
      r_multiple: item.r_multiple === null
        ? null
        : canonicalDecimal(item.r_multiple, `training results.items[${index}].r_multiple`),
      holding_duration_ms: counter(
        item.holding_duration_ms,
        `training results.items[${index}].holding_duration_ms`,
      ),
      entry_source_sequence: counter(
        item.entry_source_sequence,
        `training results.items[${index}].entry_source_sequence`,
      ),
      exit_source_sequence: counter(
        item.exit_source_sequence,
        `training results.items[${index}].exit_source_sequence`,
      ),
      entry_public_time: jsonObject(
        item.entry_public_time,
        `training results.items[${index}].entry_public_time`,
      ),
      exit_public_time: jsonObject(
        item.exit_public_time,
        `training results.items[${index}].exit_public_time`,
      ),
      plans: item.plans.map((plan, planIndex) => parseReplayTrainingResultPlan(
        plan,
        `training results.items[${index}].plans[${planIndex}]`,
      )),
      review_event_id: item.review_event_id === null
        ? null
        : identifier(item.review_event_id, `training results.items[${index}].review_event_id`),
      excursion_fidelity: enumValue(
        item.excursion_fidelity,
        ["REVEALED_MARK_PATH_CONSERVATIVE"] as const,
        `training results.items[${index}].excursion_fidelity`,
      ),
      pnl_basis: enumValue(
        item.pnl_basis,
        ["REALIZED_GROSS_EX_FEES"] as const,
        `training results.items[${index}].pnl_basis`,
      ),
    };
  });
  const parsedSummary = {
    trade_count: counter(summary.trade_count, "training results.summary.trade_count"),
    win_count: counter(summary.win_count, "training results.summary.win_count"),
    loss_count: counter(summary.loss_count, "training results.summary.loss_count"),
    win_rate: canonicalDecimal(summary.win_rate, "training results.summary.win_rate"),
    gross_realized_pnl: canonicalDecimal(
      summary.gross_realized_pnl,
      "training results.summary.gross_realized_pnl",
    ),
    net_realized_pnl: canonicalDecimal(
      summary.net_realized_pnl,
      "training results.summary.net_realized_pnl",
    ),
    fees_paid: canonicalDecimal(summary.fees_paid, "training results.summary.fees_paid"),
    average_win: canonicalDecimal(summary.average_win, "training results.summary.average_win"),
    average_loss: canonicalDecimal(
      summary.average_loss,
      "training results.summary.average_loss",
    ),
    payoff_ratio: summary.payoff_ratio === null
      ? null
      : canonicalDecimal(summary.payoff_ratio, "training results.summary.payoff_ratio"),
    profit_factor: summary.profit_factor === null
      ? null
      : canonicalDecimal(summary.profit_factor, "training results.summary.profit_factor"),
    max_drawdown: canonicalDecimal(
      summary.max_drawdown,
      "training results.summary.max_drawdown",
    ),
    average_mae: canonicalDecimal(summary.average_mae, "training results.summary.average_mae"),
    average_mfe: canonicalDecimal(summary.average_mfe, "training results.summary.average_mfe"),
    average_r_multiple: summary.average_r_multiple === null
      ? null
      : canonicalDecimal(
        summary.average_r_multiple,
        "training results.summary.average_r_multiple",
      ),
    average_holding_duration_ms: counter(
      summary.average_holding_duration_ms,
      "training results.summary.average_holding_duration_ms",
    ),
    planned_trade_count: counter(
      summary.planned_trade_count,
      "training results.summary.planned_trade_count",
    ),
  };
  const returnedCount = counter(response.returned_count, "training results.returned_count");
  if (
    returnedCount !== items.length
    || parsedSummary.win_count + parsedSummary.loss_count > parsedSummary.trade_count
    || parsedSummary.planned_trade_count > parsedSummary.trade_count
    || items.length > parsedSummary.trade_count
  ) {
    throw new TypeError("training results counters are inconsistent");
  }
  if (typeof response.data_fidelity !== "string" || typeof response.execution_fidelity !== "string") {
    throw new TypeError("training results fidelity is invalid");
  }
  return {
    protocol: REPLAY_V2_PROTOCOL,
    schema_version: "replay.training-results.v1",
    run_id: identifier(response.run_id, "training results.run_id"),
    summary: parsedSummary,
    items,
    returned_count: returnedCount,
    truncated: boolValue(response.truncated, "training results.truncated"),
    data_fidelity: response.data_fidelity,
    execution_fidelity: response.execution_fidelity,
  };
}

export interface TrainingRunDeleteResponse {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly deleted: true;
  readonly run_id: string;
  readonly session_ids: readonly string[];
}

export interface TrainingRunReturnResponse {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly run_id: string;
  readonly state: "PAUSED" | "ENDED" | "ERROR";
  readonly checkpointed: boolean;
  readonly released: boolean;
}

export interface TrainingRunCreatePayload {
  readonly protocol: typeof REPLAY_V2_PROTOCOL;
  readonly name: string | null;
  readonly source_kind: ReplayV2SourceKind;
  readonly start_mode: ReplayV2StartMode;
  readonly settlement_asset: string;
  readonly requested_start_ms: number | null;
  readonly random_range_start_ms: number | null;
  readonly random_range_end_ms: number | null;
  readonly indicator_warmup_bars: number;
  readonly visible_history_lookback: {
    readonly mode: ReplayVisibleHistoryMode;
    readonly duration_ms: number | null;
  };
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
  readonly position_mode: ReplayV2PositionMode;
  readonly funding_mode: EnumValue<typeof REPLAY_V2_ENUMS.funding_mode>;
  readonly account_data_mode: ReplayV2AccountDataMode;
  readonly account_fidelity: typeof HEDGE_ACCOUNT_FIDELITY | null;
  readonly insurance_adl_fidelity: typeof HEDGE_INSURANCE_ADL_FIDELITY | null;
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
  readonly market_selection_hint: ReplayLaunchContext | null;
}

export interface TrainingRunMarketSelectionPayload {
  readonly catalog_epoch: string;
  readonly exchange: string;
  readonly market_type: string;
  readonly symbol: string;
  readonly base_interval: string;
  readonly display_interval: string;
  readonly account_history_ref: ReplayAccountHistoryRef | null;
  readonly hedge_public_history_ref: ReplayHedgePublicHistoryRef | null;
  readonly simulation_manifest_ref: ReplayHedgeSimulationManifestRef | null;
}

export interface TrainingRunPreparationPayload {
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
  readonly indicator_warmup_bars: number;
  readonly visible_history_lookback: {
    readonly mode: ReplayVisibleHistoryMode;
    readonly duration_ms: number | null;
  };
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
  readonly position_mode: ReplayV2PositionMode;
  readonly funding_mode: EnumValue<typeof REPLAY_V2_ENUMS.funding_mode>;
  readonly account_data_mode: ReplayV2AccountDataMode;
  readonly account_history_ref: ReplayAccountHistoryRef | null;
  readonly hedge_public_history_ref: ReplayHedgePublicHistoryRef | null;
  readonly simulation_manifest_ref: ReplayHedgeSimulationManifestRef | null;
  readonly account_fidelity: typeof HEDGE_ACCOUNT_FIDELITY | null;
  readonly insurance_adl_fidelity: typeof HEDGE_INSURANCE_ADL_FIDELITY | null;
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
  if (typeof value !== "string" || !CANONICAL_DECIMAL.test(value)) {
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
    "status",
    "report_available",
    "review_available",
  ]);
  const kind = enumValue(card.kind, enumValues("V2"), `${fieldName}.kind`);
  const integrityMode = enumValue(
    card.integrity_mode,
    REPLAY_V2_ENUMS.integrity_mode,
    `${fieldName}.integrity_mode`,
  );
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
    last_symbol: nullableIdentifier(card.last_symbol, `${fieldName}.last_symbol`),
    subscribed_track_count: counter(card.subscribed_track_count, `${fieldName}.subscribed_track_count`),
    progress: { source_sequence: counter(progress.source_sequence, `${fieldName}.progress.source_sequence`) },
    equity: nullableCanonicalDecimal(card.equity, `${fieldName}.equity`),
    equity_status: enumValue(
      card.equity_status,
      enumValues("CURRENT", "STALE"),
      `${fieldName}.equity_status`,
    ),
    settlement_asset: identifier(card.settlement_asset, `${fieldName}.settlement_asset`),
    updated_at_ms: timestamp(card.updated_at_ms, `${fieldName}.updated_at_ms`),
    compatibility: enumValue(
      card.compatibility,
      enumValues("READY", "UNAVAILABLE"),
      `${fieldName}.compatibility`,
    ),
    resume_action: enumValue(
      card.resume_action,
      enumValues("SELECT_MARKET", "OPEN_ADAPTER", "UNAVAILABLE"),
      `${fieldName}.resume_action`,
    ),
    adapter_session_id: nullableIdentifier(
      card.adapter_session_id,
      `${fieldName}.adapter_session_id`,
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
  if (payload.schema_version !== "replay.training.v2") {
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
    schema_version: "replay.training.v2",
    items: payload.items.map((item, index) => parseTrainingRunCard(item, `run list.items[${index}]`)),
    next_cursor: nextCursor,
  };
}

export function parseTrainingRunMutationResponse(value: unknown): TrainingRunMutationResponse {
  const payload = exactObject(value, "run mutation", ["protocol", "created", "run"]);
  if (payload.protocol !== REPLAY_V2_PROTOCOL) {
    throw new TypeError(`protocol must be ${REPLAY_V2_PROTOCOL}`);
  }
  return {
    protocol: REPLAY_V2_PROTOCOL,
    created: boolValue(payload.created, "run mutation.created"),
    run: parseTrainingRunCard(payload.run, "run mutation.run"),
  };
}

export function parseTrainingRunMarketSelectionResponse(
  value: unknown,
): TrainingRunMarketSelectionResponse {
  const payload = exactObject(value, "market selection", [
    "protocol",
    "initialized",
    "run",
  ]);
  if (payload.protocol !== REPLAY_V2_PROTOCOL || payload.initialized !== true) {
    throw new TypeError("market selection response is unsupported");
  }
  return {
    protocol: REPLAY_V2_PROTOCOL,
    initialized: true,
    run: parseTrainingRunCard(payload.run, "market selection.run"),
  };
}

export function parseTrainingRunDeleteResponse(value: unknown): TrainingRunDeleteResponse {
  const payload = exactObject(value, "run deletion", [
    "protocol",
    "deleted",
    "run_id",
    "session_ids",
  ]);
  if (payload.protocol !== REPLAY_V2_PROTOCOL || payload.deleted !== true) {
    throw new TypeError("run deletion response is unsupported");
  }
  if (!Array.isArray(payload.session_ids)) {
    throw new TypeError("run deletion.session_ids must be an array");
  }
  const sessionIds = payload.session_ids.map((sessionId, index) => (
    identifier(sessionId, `run deletion.session_ids[${index}]`)
  ));
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw new TypeError("run deletion.session_ids must be unique");
  }
  return {
    protocol: REPLAY_V2_PROTOCOL,
    deleted: true,
    run_id: identifier(payload.run_id, "run deletion.run_id"),
    session_ids: sessionIds,
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
  if (payload.protocol !== REPLAY_V2_PROTOCOL) {
    throw new TypeError("return-to-Hub response is unsupported");
  }
  const state = enumValue(
    payload.state,
    enumValues("PAUSED", "ENDED", "ERROR"),
    "return to Hub.state",
  );
  return {
    protocol: REPLAY_V2_PROTOCOL,
    run_id: identifier(payload.run_id, "return to Hub.run_id"),
    state,
    checkpointed: boolValue(payload.checkpointed, "return to Hub.checkpointed"),
    released: boolValue(payload.released, "return to Hub.released"),
  };
}
