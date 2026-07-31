export const REPLAY_PROTOCOL = "replay.v1" as const;

export const REPLAY_SOURCE_KINDS = ["bar", "agg_trade"] as const;
export type ReplaySourceKind = (typeof REPLAY_SOURCE_KINDS)[number];

export const REPLAY_QUALITY_MODES = ["exact", "best_effort"] as const;
export type ReplayQualityMode = (typeof REPLAY_QUALITY_MODES)[number];

export const REPLAY_DATA_FIDELITIES = [
  "EXACT_BAR_COVERAGE",
  // Legacy payload compatibility; current AGG_TRADE sessions use the next value.
  "EXACT_AGG_TRADE_COVERAGE",
  "VERIFIED_AGG_TRADE_APPROXIMATE_BARS",
  "BEST_EFFORT",
] as const;
export type ReplayDataFidelity = (typeof REPLAY_DATA_FIDELITIES)[number];

export const REPLAY_EXECUTION_FIDELITIES = [
  "BAR_CONSERVATIVE",
  "AGG_TRADE_TAPE",
] as const;
export type ReplayExecutionFidelity = (typeof REPLAY_EXECUTION_FIDELITIES)[number];

export const REPLAY_EXECUTION_MODELS = ["paper_linear_v1"] as const;
export type ReplayExecutionModel = (typeof REPLAY_EXECUTION_MODELS)[number];

export const REPLAY_SESSION_STATES = [
  "INITIALIZING",
  "PAUSED",
  "PLAYING",
  "ENDED",
  "ERROR",
] as const;
export type ReplaySessionState = (typeof REPLAY_SESSION_STATES)[number];

export const REPLAY_COMMAND_TYPES = [
  "acquire_controller",
  "release_controller",
  "play",
  "pause",
  "set_speed",
  "step",
  "advance_by",
  "seek_to",
  "place_order",
  "cancel_order",
  "close_position",
  "add_journal_note",
  "reveal_history",
  "end_session",
] as const;
export type ReplayCommandType = (typeof REPLAY_COMMAND_TYPES)[number];

export const REPLAY_EVENT_TYPES = [
  "replay.delta",
  "replay.snapshot",
  "replay.status",
  "replay.bar.replace",
  "replay.bar.append",
  "replay.bar.tick",
  "replay.order",
  "replay.fill",
  "replay.position",
  "replay.account",
  "replay.journal",
  "replay.warning",
  "replay.resync_required",
  "replay.ended",
] as const;
export type ReplayEventType = (typeof REPLAY_EVENT_TYPES)[number];

export const REPLAY_ERROR_CODES = [
  "REPLAY_DISABLED",
  "SESSION_NOT_FOUND",
  "SESSION_ENDED",
  "CONTROLLER_CONFLICT",
  "REVISION_CONFLICT",
  "COMMAND_ID_REUSED",
  "INVALID_STATE_TRANSITION",
  "UNSUPPORTED_SOURCE",
  "UNSUPPORTED_INTERVAL",
  "UNSUPPORTED_EXECUTION_MODEL",
  "NO_ELIGIBLE_WINDOW",
  "DATA_GAP",
  "DATASET_INCOMPLETE",
  "DATASET_MISMATCH",
  "ARCHIVE_DISABLED",
  "ARCHIVE_DEGRADED",
  "SCAN_LIMIT_EXCEEDED",
  "SEEK_REQUIRES_FORK_OR_RESET",
  "ORDER_REJECTED",
  "RISK_LIMIT_EXCEEDED",
  "PERSISTENCE_DEGRADED",
] as const;
export type ReplayErrorCode = (typeof REPLAY_ERROR_CODES)[number];

export type ReplayDecimalString = string;
export type ReplayTimestampMs = number;
export type ReplayRevision = number;
export type ReplaySequence = number;
export type ReplayDigest = `sha256:${string}`;
export type ReplaySpeed = 1 | 5 | 15 | 30 | 60 | 120 | 300 | 600 | "MAX";
export type ReplayJson =
  | null
  | boolean
  | number
  | string
  | readonly ReplayJson[]
  | { readonly [key: string]: ReplayJson };

export interface ReplayFeeModel {
  readonly maker_bps: ReplayDecimalString;
  readonly taker_bps: ReplayDecimalString;
}

export interface ReplaySlippageModel {
  readonly kind: "fixed_bps";
  readonly market_bps: ReplayDecimalString;
}

export interface ReplaySessionConfig {
  readonly protocol: typeof REPLAY_PROTOCOL;
  readonly source_kind: ReplaySourceKind;
  readonly exchange: string;
  readonly market_type: string;
  readonly symbol: string;
  readonly base_interval: string;
  readonly display_interval: string;
  readonly start_policy: "random_eligible" | "manual";
  readonly requested_start_ms: ReplayTimestampMs | null;
  readonly warmup_bars: number;
  readonly horizon_ms: number;
  readonly random_seed: number;
  readonly quality_mode: ReplayQualityMode;
  readonly blind_mode: boolean;
  readonly initial_equity: ReplayDecimalString;
  readonly quote_asset: string;
  readonly execution_model: ReplayExecutionModel;
  readonly fee_model: ReplayFeeModel;
  readonly slippage_model: ReplaySlippageModel;
  readonly max_leverage: ReplayDecimalString;
  readonly pause_on_controller_loss: boolean;
}

export interface ReplayCursor {
  readonly virtual_time_ms: ReplayTimestampMs;
  readonly source_sequence: ReplaySequence;
  readonly last_base_bar_open_ms: ReplayTimestampMs | null;
  readonly last_trade_time_ms: ReplayTimestampMs | null;
  readonly last_agg_trade_id: number | null;
  readonly at_end: boolean;
}

export interface ReplayCommandEnvelope {
  readonly protocol: typeof REPLAY_PROTOCOL;
  readonly command_id: string;
  readonly client_instance_id: string;
  readonly expected_revision: ReplayRevision;
  readonly type: ReplayCommandType;
  readonly payload: Readonly<Record<string, ReplayJson>>;
}

export interface ReplayEventEnvelope {
  readonly type: ReplayEventType;
  readonly protocol: typeof REPLAY_PROTOCOL;
  readonly session_id: string;
  readonly sequence: ReplaySequence;
  readonly sequence_from?: ReplaySequence;
  readonly sequence_to?: ReplaySequence;
  readonly revision: ReplayRevision;
  readonly virtual_time_ms: ReplayTimestampMs;
  readonly state_hash: `sha256:${string}`;
  readonly data_epoch: `sha256:${string}`;
  readonly data: Readonly<Record<string, ReplayJson>>;
}

export interface ReplayErrorPayload {
  readonly code: ReplayErrorCode;
  readonly message: string;
  readonly details: Readonly<Record<string, ReplayJson>>;
}

export interface ReplayErrorEnvelope {
  readonly protocol: typeof REPLAY_PROTOCOL;
  readonly error: ReplayErrorPayload;
}

export interface ReplaySourceCapability {
  readonly enabled: boolean;
  readonly fidelity?: ReplayDataFidelity;
  readonly execution_fidelity?: ReplayExecutionFidelity;
  readonly requires_exact_dataset?: boolean;
  readonly bar_parity_required?: boolean;
  readonly reader?: "paged";
  readonly reason?: string;
}

export interface ReplayCapabilities {
  readonly protocol: typeof REPLAY_PROTOCOL;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly reason?: ReplayErrorCode;
  readonly sources: Readonly<Record<ReplaySourceKind, ReplaySourceCapability>>;
  readonly execution_models: readonly ReplayExecutionModel[];
  readonly limits: {
    readonly max_active_sessions: number;
    readonly max_warmup_bars: number;
    readonly max_bar_dataset_rows: number;
    readonly max_horizon_days: number;
    readonly event_buffer_size: number;
    readonly subscriber_queue: number;
  };
  readonly persistence: {
    readonly opened?: boolean;
    readonly schema_version: number | null;
    readonly degraded: boolean;
    readonly degraded_reason: string | null;
  };
}

export interface ReplaySeriesIdentity {
  readonly exchange: string;
  readonly market_type: string;
  readonly symbol: string;
}

export interface ReplayCatalogBounds {
  readonly earliest_open_ms: ReplayTimestampMs;
  readonly latest_source_open_ms: ReplayTimestampMs;
  readonly latest_closed_open_ms: ReplayTimestampMs;
  readonly total_count: number;
}

export interface ReplayEligibleWindowRange {
  readonly interval: string;
  readonly interval_ms: number;
  readonly first_start_ms: ReplayTimestampMs;
  readonly last_start_ms: ReplayTimestampMs;
  readonly count: number;
  readonly warmup_bars: number;
  readonly replay_bars: number;
}

export interface ReplayCatalogEntry {
  readonly identity: ReplaySeriesIdentity;
  readonly base_intervals: readonly string[];
  readonly selected_base_interval: string | null;
  readonly bounds: ReplayCatalogBounds | null;
  readonly gap_summary?: Readonly<Record<string, ReplayJson>>;
  readonly eligible_ranges: readonly ReplayEligibleWindowRange[];
  readonly eligible_window_count: number;
  readonly quality: ReplayDataFidelity | null;
  readonly source_fingerprint?: ReplayDigest;
  readonly catalog_epoch: ReplayDigest;
  readonly limitations: readonly string[];
}

export interface ReplayCatalog {
  readonly protocol: typeof REPLAY_PROTOCOL;
  readonly catalog_epoch: ReplayDigest;
  readonly warmup_bars: number;
  readonly horizon_ms: ReplayTimestampMs;
  readonly quality_mode: ReplayQualityMode;
  readonly blind_mode: boolean;
  readonly entries: readonly ReplayCatalogEntry[];
}

export interface ReplayDisplayBar {
  readonly open_time_ms: ReplayTimestampMs;
  readonly close_time_ms: ReplayTimestampMs;
  readonly open: ReplayDecimalString;
  readonly high: ReplayDecimalString;
  readonly low: ReplayDecimalString;
  readonly close: ReplayDecimalString;
  readonly volume: ReplayDecimalString;
  readonly quote_volume: ReplayDecimalString | null;
  readonly trades: number | null;
  readonly taker_buy_base: ReplayDecimalString | null;
  readonly taker_buy_quote: ReplayDecimalString | null;
  readonly first_base_open_ms: ReplayTimestampMs;
  readonly last_base_open_ms: ReplayTimestampMs;
  readonly component_count: number;
  readonly expected_components: number;
  readonly is_closed: boolean;
  readonly synthetic: boolean;
}

export interface ReplaySourceBar {
  readonly open_time_ms: ReplayTimestampMs;
  readonly close_time_ms: ReplayTimestampMs;
  readonly open: ReplayDecimalString;
  readonly high: ReplayDecimalString;
  readonly low: ReplayDecimalString;
  readonly close: ReplayDecimalString;
  readonly volume: ReplayDecimalString;
  readonly quote_volume: ReplayDecimalString | null;
  readonly trades: number | null;
  readonly taker_buy_base: ReplayDecimalString | null;
  readonly taker_buy_quote: ReplayDecimalString | null;
  readonly source: string;
}

export interface ReplaySourceTrade {
  readonly exchange: string;
  readonly market_type: string;
  readonly symbol: string;
  readonly agg_trade_id: number;
  readonly first_trade_id: number;
  readonly last_trade_id: number;
  readonly price: ReplayDecimalString;
  readonly quantity: ReplayDecimalString;
  readonly quote_quantity: ReplayDecimalString;
  readonly trade_time_ms: ReplayTimestampMs;
  readonly is_buyer_maker: boolean;
  readonly source: string;
}

export type ReplaySourceEvent = ReplaySourceBar | ReplaySourceTrade;

export interface ReplayBarUpdate {
  readonly action: "append" | "tick";
  readonly bar: ReplayDisplayBar;
  readonly source_sequence: ReplaySequence;
  readonly base_open_time_ms: ReplayTimestampMs;
  readonly gap_policy: string;
  readonly synthetic_policy: string;
}

export interface ReplayBarUpdateBatch {
  readonly action: "batch";
  readonly updates: readonly ReplayBarUpdate[];
}

export type ReplayBarProjectionUpdate = ReplayBarUpdate | ReplayBarUpdateBatch;

export interface ReplayOrder {
  readonly order_id: string;
  readonly client_order_id: string;
  readonly side: string;
  readonly order_type: string;
  readonly quantity: ReplayDecimalString;
  readonly reduce_only: boolean;
  readonly limit_price: ReplayDecimalString | null;
  readonly stop_price: ReplayDecimalString | null;
  readonly status: string;
  readonly filled_quantity: ReplayDecimalString;
  readonly remaining_quantity: ReplayDecimalString;
  readonly average_fill_price: ReplayDecimalString | null;
  readonly accepted_source_sequence: ReplaySequence;
  readonly created_time_ms: ReplayTimestampMs;
  readonly ordinal: number;
  readonly reserved_margin: ReplayDecimalString;
  readonly status_reason: string | null;
  readonly status_history: readonly string[];
  readonly model_version: string;
}

export interface ReplayFill {
  readonly fill_id: string;
  readonly order_id: string;
  readonly side: string;
  readonly quantity: ReplayDecimalString;
  readonly price: ReplayDecimalString;
  readonly notional: ReplayDecimalString;
  readonly fee: ReplayDecimalString;
  readonly fee_asset: string;
  readonly liquidity: string;
  readonly reason: string;
  readonly source_sequence: ReplaySequence;
  readonly event_time_ms: ReplayTimestampMs;
  readonly synthetic: boolean;
  readonly historical_execution: boolean;
  readonly model_version: string;
}

export interface ReplayClosedTrade {
  readonly trade_id: string;
  readonly order_id: string;
  readonly fill_id: string;
  readonly side: string;
  readonly quantity: ReplayDecimalString;
  readonly entry_price: ReplayDecimalString;
  readonly exit_price: ReplayDecimalString;
  readonly realized_pnl: ReplayDecimalString;
  readonly source_sequence: ReplaySequence;
}

export interface ReplayWarning {
  readonly warning_id: string;
  readonly code: string;
  readonly source_sequence: ReplaySequence;
  readonly order_ids: readonly string[];
  readonly message: string;
}

export interface ReplayPosition {
  readonly quantity: ReplayDecimalString;
  readonly entry_price: ReplayDecimalString | null;
  readonly mark_price: ReplayDecimalString;
  readonly notional: ReplayDecimalString;
  readonly realized_pnl: ReplayDecimalString;
  readonly unrealized_pnl: ReplayDecimalString;
}

export interface ReplayAccount {
  readonly cash_balance: ReplayDecimalString;
  readonly equity: ReplayDecimalString;
  readonly available_equity: ReplayDecimalString;
  readonly margin_used: ReplayDecimalString;
  readonly reserved_margin: ReplayDecimalString;
  readonly realized_pnl: ReplayDecimalString;
  readonly unrealized_pnl: ReplayDecimalString;
  readonly fees_paid: ReplayDecimalString;
  readonly quote_asset: string;
}

export interface ReplayProjection {
  readonly bar_update: ReplayBarProjectionUpdate | null;
  readonly orders: readonly ReplayOrder[];
  readonly fills: readonly ReplayFill[];
  readonly warnings: readonly ReplayWarning[];
  readonly position: ReplayPosition;
  readonly account: ReplayAccount;
}

export interface ReplayJournalEntry {
  readonly entry_id: string;
  readonly virtual_time_ms: ReplayTimestampMs;
  readonly text: string;
}

export interface ReplayBarBuilderSnapshot {
  readonly schema_version: string;
  readonly base_interval: string;
  readonly display_interval: string;
  readonly base_interval_ms: number;
  readonly display_interval_ms: number;
  readonly replay_start_ms: ReplayTimestampMs;
  readonly max_closed_bars: number;
  readonly warmup_count: number;
  readonly warmup_fingerprint: ReplayDigest;
  readonly gap_policy: string;
  readonly synthetic_policy: string;
  readonly replay_events_applied: number;
  readonly last_base_open_ms: ReplayTimestampMs | null;
  readonly active_bar: ReplayDisplayBar | null;
  readonly closed_bars: readonly ReplayDisplayBar[];
  readonly closed_count: number;
  readonly closed_prefix_count: number;
  readonly closed_prefix_hash: ReplayDigest;
  readonly closed_chain_hash: ReplayDigest;
  readonly state_hash: ReplayDigest;
}

export interface ReplayBarReplaceProjection {
  readonly action: "replace";
  readonly bars: readonly ReplayDisplayBar[];
  readonly closed_count: number;
  readonly closed_prefix_count: number;
  readonly replay_events_applied: number;
  readonly gap_policy: string;
  readonly synthetic_policy: string;
  readonly source_kind: "AGG_TRADE";
}

export interface ReplayTradeFormingBar {
  readonly open_time_ms: ReplayTimestampMs;
  readonly close_time_ms: ReplayTimestampMs;
  readonly open: ReplayDecimalString;
  readonly high: ReplayDecimalString;
  readonly low: ReplayDecimalString;
  readonly close: ReplayDecimalString;
  readonly volume: ReplayDecimalString;
  readonly quote_volume: ReplayDecimalString;
  readonly trades: number;
  readonly taker_buy_base: ReplayDecimalString;
  readonly taker_buy_quote: ReplayDecimalString;
}

export interface ReplayTradeBarBuilderSnapshot {
  readonly schema_version: "replay-trade-bar-builder-state.v1";
  readonly base_interval: string;
  readonly display_interval: string;
  readonly replay_start_ms: ReplayTimestampMs;
  readonly replay_end_time_ms: ReplayTimestampMs;
  readonly max_closed_bars: number;
  readonly synthetic_policy: string;
  readonly bar_builder: ReplayBarBuilderSnapshot;
  readonly public_projection: ReplayBarReplaceProjection;
  readonly forming: ReplayTradeFormingBar | null;
  readonly next_base_open_ms: ReplayTimestampMs;
  readonly replay_events_applied: number;
  readonly last_trade_time_ms: ReplayTimestampMs | null;
  readonly last_agg_trade_id: number | null;
  readonly identity: readonly [string, string, string] | null;
  readonly previous_close: ReplayDecimalString | null;
  readonly last_projected_open_ms: ReplayTimestampMs | null;
  readonly finalized: boolean;
  readonly state_hash: ReplayDigest;
}

export type ReplayAnyBarBuilderSnapshot = ReplayBarBuilderSnapshot | ReplayTradeBarBuilderSnapshot;

export interface ReplayBrokerSnapshot {
  readonly schema_version: string;
  readonly model_version: string;
  readonly config_hash: ReplayDigest;
  readonly bar_builder: ReplayAnyBarBuilderSnapshot;
  readonly orders: readonly ReplayOrder[];
  readonly client_order_ids: readonly string[];
  readonly fills: readonly ReplayFill[];
  readonly closed_trades: readonly ReplayClosedTrade[];
  readonly warnings: readonly ReplayWarning[];
  readonly ledger: Readonly<Record<string, ReplayJson>>;
  readonly position: ReplayPosition;
  readonly account: ReplayAccount;
  readonly next_order: number;
  readonly next_fill: number;
  readonly next_trade: number;
  readonly next_warning: number;
  readonly has_trading_activity: boolean;
  readonly ended: boolean;
  readonly equity_peak: ReplayDecimalString;
  readonly max_drawdown: ReplayDecimalString;
  readonly state_hash: ReplayDigest;
}

export interface ReplayBrokerReport {
  readonly schema_version: string;
  readonly config_hash: ReplayDigest;
  readonly model_version: string;
  readonly initial_equity: ReplayDecimalString;
  readonly final_equity: ReplayDecimalString;
  readonly realized_pnl: ReplayDecimalString;
  readonly fees_paid: ReplayDecimalString;
  readonly max_drawdown: ReplayDecimalString;
  readonly trade_count: number;
  readonly winning_trades: number;
  readonly losing_trades: number;
  readonly win_rate: ReplayDecimalString;
  readonly average_win: ReplayDecimalString;
  readonly average_loss: ReplayDecimalString;
  readonly profit_factor: ReplayDecimalString | null;
  readonly ambiguous_bar_count: number;
  readonly order_count: number;
  readonly fill_count: number;
  readonly ledger_entry_count: number;
  readonly ledger_tail_hash: ReplayDigest;
  readonly state_hash: ReplayDigest;
  readonly ended: boolean;
  readonly orders: readonly ReplayOrder[];
  readonly fills: readonly ReplayFill[];
  readonly closed_trades: readonly ReplayClosedTrade[];
  readonly warnings: readonly ReplayWarning[];
  readonly report_hash: ReplayDigest;
}

export interface ReplayActualHistory {
  readonly replay_start_ms: ReplayTimestampMs;
  readonly replay_end_open_ms: ReplayTimestampMs;
}

export interface ReplayCommandTimelineEntry {
  readonly command_id: string;
  readonly type: ReplayCommandType;
  readonly submitted_revision: ReplayRevision;
  readonly acknowledged_revision: ReplayRevision | null;
  readonly submitted_at_ms: number;
  readonly status: "pending" | "acknowledged" | "rejected" | "unknown";
  readonly error_code: string | null;
}

export interface ReplaySessionSnapshot {
  readonly protocol: typeof REPLAY_PROTOCOL;
  readonly session_id: string;
  readonly state: ReplaySessionState;
  readonly revision: ReplayRevision;
  readonly sequence: ReplaySequence;
  readonly cursor: ReplayCursor;
  readonly state_hash: ReplayDigest;
  readonly data_epoch: ReplayDigest;
  readonly controller_client_id: string | null;
  readonly speed: ReplaySpeed;
  readonly checkpoint_count: number;
  readonly status_reason: string;
  readonly config: ReplaySessionConfig;
  readonly components: ReplayBrokerSnapshot;
  readonly journal: readonly ReplayJournalEntry[];
  readonly revealed: boolean;
  readonly degraded_reason: string | null;
}

export interface ReplaySessionResponse {
  readonly protocol: typeof REPLAY_PROTOCOL;
  readonly session_id: string;
  readonly data_fidelity: ReplayDataFidelity;
  readonly execution_fidelity: ReplayExecutionFidelity;
  readonly snapshot: ReplaySessionSnapshot;
  readonly forked?: boolean;
  readonly forked_from_session_id?: string;
}

export interface ReplayCommandResult {
  readonly protocol: typeof REPLAY_PROTOCOL;
  readonly session_id: string;
  readonly command_id: string;
  readonly revision: ReplayRevision;
  readonly sequence: ReplaySequence;
  readonly state: ReplaySessionState;
  readonly state_hash: ReplayDigest;
  readonly cursor: ReplayCursor;
  readonly data: Readonly<Record<string, ReplayJson>>;
}

export type ReplayParsedEvent = Omit<ReplayEventEnvelope, "data"> & {
  readonly data:
    | { readonly reset: true; readonly snapshot: ReplaySessionSnapshot }
    | { readonly state: ReplaySessionState; readonly reason: string; readonly speed: ReplaySpeed; readonly controller_client_id: string | null }
    | { readonly source_sequence: ReplaySequence; readonly source_event: ReplaySourceEvent; readonly projection: ReplayProjection }
    | { readonly command_type: ReplayCommandType; readonly projection: ReplayProjection }
    | ReplayJournalEntry
    | { readonly reset: true; readonly reason: string }
    | { readonly reason: string; readonly projection: ReplayProjection };
};
