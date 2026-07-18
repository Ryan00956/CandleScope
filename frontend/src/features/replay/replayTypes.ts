export const REPLAY_PROTOCOL = "replay.v1" as const;

export const REPLAY_SOURCE_KINDS = ["bar", "agg_trade"] as const;
export type ReplaySourceKind = (typeof REPLAY_SOURCE_KINDS)[number];

export const REPLAY_QUALITY_MODES = ["exact", "best_effort"] as const;
export type ReplayQualityMode = (typeof REPLAY_QUALITY_MODES)[number];

export const REPLAY_DATA_FIDELITIES = [
  "EXACT_BAR_COVERAGE",
  "EXACT_AGG_TRADE_COVERAGE",
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
  readonly revision: ReplayRevision;
  readonly virtual_time_ms: ReplayTimestampMs;
  readonly state_hash: `sha256:${string}`;
  readonly data_epoch: `sha256:${string}`;
  readonly data: Readonly<Record<string, ReplayJson>>;
}
