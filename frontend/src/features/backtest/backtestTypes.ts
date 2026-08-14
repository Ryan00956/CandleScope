export interface BacktestRunRecord {
  run_id: string;
  state: string;
  fidelity_mode: string;
  source_event_kind: string;
  config_hash: string;
  failure_code?: string | null;
  result?: {
    report_hash?: string;
    fill_hash?: string;
    ambiguity_count?: number;
    fills?: Array<Record<string, string>>;
  };
}

export interface BacktestReport {
  schemaVersion: string;
  runId: string;
  fidelity_mode: string;
  source_event_kind: string;
  report_label: string;
  hashes: Record<string, string | null>;
  metrics: {
    fill_count: number;
    ambiguity_count: number;
    rejected_order_count: number;
    trade_count: number;
    winning_trade_count: number;
    win_rate: string;
    realized_net_pnl: string;
    signal_event_count?: number;
    execution_event_count?: number;
  };
  account?: Record<string, string | boolean | null>;
  ledger?: Record<string, unknown>;
  equity_curve?: Array<Record<string, string | number>>;
  orders?: Array<Record<string, unknown>>;
  data_quality?: Record<string, unknown>;
  fill_model?: Record<string, unknown>;
  unmodeled: string[];
  suitable_for: string[];
  not_suitable_for: string[];
  fills: Array<Record<string, string>>;
  trades: Array<Record<string, string>>;
  rejected_orders?: Array<Record<string, unknown>>;
  strategy?: {
    revision?: string;
    indicatorRevision?: string;
    length?: number;
    oversold?: string;
    overbought?: string;
    triggerMode?: string;
    warmupRequirementRows?: number;
    warmupRowsObserved?: number;
    reasonCodes?: Record<string, number>;
    decisionDebugTrace?: Array<Record<string, unknown>>;
  };
  identity?: {
    signal_clock?: string | null;
    signal_interval?: string | null;
    execution_clock?: string | null;
    bar_builder?: string | null;
    timezone?: string | null;
  };
}

export interface BacktestChartBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BacktestChartData {
  run_id: string;
  symbol: string;
  interval: string;
  bars: BacktestChartBar[];
  fills: Array<Record<string, string>>;
  equity_curve: Array<Record<string, string | number>>;
  truncated: boolean;
}

export interface BacktestTrialRecord {
  trial_id: string;
  ordinal: number;
  split_id: string;
  params_json: string;
  run_id?: string | null;
  state: string;
}

export interface BacktestStudyRecord {
  study_id: string;
  name: string;
  hypothesis: string;
  state: string;
  strategy_revision_id: string;
  config_hash: string;
  trials: BacktestTrialRecord[];
}

export interface BacktestStudyComparison {
  study_id: string;
  ready: boolean;
  completed_trial_count: number;
  ranking: Array<{
    ordinal: number;
    split_id: string;
    params: Record<string, unknown>;
    oos_score: string | number | null;
    selection_warning: string;
  }>;
}

export const STREAM_EVENTS = [
  "RUN_STATE",
  "PROGRESS",
  "WARNING",
  "CHECKPOINT",
  "ACCOUNT_DELTA",
  "ORDER_DELTA",
  "REPORT_READY",
  "TERMINAL",
  "RESYNC_REQUIRED",
] as const;
