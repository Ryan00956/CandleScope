export interface BacktestRunRecord {
  run_id: string;
  state: string;
  fidelity_mode: string;
  source_event_kind: string;
  config_hash: string;
  config_json?: string;
  dataset_id?: string;
  data_epoch?: string;
  snapshot_hash?: string;
  failure_code?: string | null;
  result?: {
    report_hash?: string;
    fill_hash?: string;
    ambiguity_count?: number;
    fills?: Array<Record<string, string>>;
  };
}

export interface BacktestResearchDatasetIdentity {
  dataset_id: string;
  data_epoch: string;
  snapshot_hash: string;
}

export interface BacktestResearchLaunchContext {
  schema_version: "candlescope.backtest-research-launch-context/1";
  context_id: string;
  context_hash: string;
  source_workspace_id: string | null;
  source_cell_id: string | null;
  strategy_draft_id: string;
  strategy_revision_id: string | null;
  parameters: Record<string, unknown>;
  quick_preset_id: string;
  chart_session: {
    exchange: string;
    market_type: string;
    symbol: string;
    interval: string;
  };
  range: {
    mode: "ALL_AVAILABLE" | "VISIBLE" | "CUSTOM";
    start_time_ms: number | null;
    end_time_ms: number | null;
  };
  dataset_identity: BacktestResearchDatasetIdentity | null;
  latest_run_id: string | null;
  baseline_run_id: string | null;
  created_at_ms: number;
}

export type BacktestResearchLaunchContextInput = Omit<
  BacktestResearchLaunchContext,
  "schema_version" | "context_id" | "context_hash" | "created_at_ms"
>;

export type TradeExplanationVariable =
  | { kind: "string"; value: string }
  | { kind: "decimal"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null"; value: null };

export interface TradeExplanationV1 {
  schema: "TRADE_EXPLANATION_V1";
  canonicalization: "JCS_SHA256_V1";
  runId: string;
  tradeId: string | null;
  orderId: string | null;
  fillId: string | null;
  decisionId: string;
  decisionTraceOrdinal: number | null;
  decisionTimeMs: number;
  action: "ENTER" | "EXIT" | "REVERSE" | "REJECT";
  reasonCode: string | null;
  reasonLabel: string | null;
  source: {
    strategyRevisionId: string;
    line: number | null;
    column: number | null;
    conditionId: string | null;
  };
  conditions: Array<{ id: string; label: string; result: boolean | null }>;
  variables: Record<string, TradeExplanationVariable>;
  execution: {
    state: "ACCEPTED" | "FILLED" | "REJECTED" | "CANCELLED";
    reasonCode: string | null;
  };
  completeness: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  omissions: {
    conditionsDropped: number;
    variablesDropped: number;
    valuesTruncated: number;
  };
  evidenceHash: string;
}

export interface BacktestFillRecord extends Record<string, unknown> {
  order_id?: string;
  fill_id?: string;
  sequence?: string | number;
  event_time_ms?: string | number;
  side?: string;
  action?: string;
  price?: string;
  qty?: string;
  fee?: string;
  reason?: string;
  explanation?: TradeExplanationV1;
}

export interface BacktestTradeRecord extends Record<string, unknown> {
  trade_id?: string;
  side?: string;
  entry_time_ms?: string | number;
  exit_time_ms?: string | number;
  entry_price?: string;
  exit_price?: string;
  net_pnl?: string;
  fees?: string;
  entry_explanation?: TradeExplanationV1 | null;
  exit_explanation?: TradeExplanationV1 | null;
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
    risk_rejection_count?: number;
  };
  account?: Record<string, unknown>;
  ledger?: Record<string, unknown>;
  equity_curve?: Array<Record<string, string | number>>;
  orders?: Array<Record<string, unknown>>;
  data_quality?: Record<string, unknown>;
  fill_model?: Record<string, unknown>;
  unmodeled: string[];
  suitable_for: string[];
  not_suitable_for: string[];
  fills: BacktestFillRecord[];
  trades: BacktestTradeRecord[];
  rejected_orders?: Array<Record<string, unknown>>;
  order_events?: Array<Record<string, unknown>>;
  execution_assumptions?: Record<string, unknown>;
  fill_trace?: {
    fill_count: number;
    authoritative_event_trace_count: number;
    complete: boolean;
  };
  cost_sensitivity?: {
    schemaVersion?: string;
    purpose?: string;
    included_in_primary_config_hash?: boolean;
    matrix_hash?: string;
    scenarios?: Array<{
      name: string;
      status: string;
      assumptions: Record<string, unknown>;
      metrics: Record<string, string | number>;
      hashes: Record<string, string>;
    }>;
  };
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
    account_model?: string | null;
    host_policy_revision?: string | null;
    sizing_policy?: string | null;
    risk_policy?: string | null;
    execution_model_revision?: string | null;
    fill_policy?: string | null;
    bar_path_scenario?: string | null;
    order_end_policy?: string | null;
    report_schema?: string | null;
    metrics_version?: string | null;
    equity_sampling?: string | null;
    annualization_days?: number | null;
    risk_free_rate_annual?: string | null;
    benchmark_model?: string | null;
    sample_role?: string | null;
  };
  credibility?: {
    level: string;
    sample_role: string;
    profit_guarantee: boolean;
    open_positions_excluded_from_trade_metrics: boolean;
  };
  performance?: {
    metrics_version: string;
    metrics_hash: string;
    returns: Record<string, MetricValue>;
    risk: Record<string, MetricValue>;
    trading: Record<string, unknown> & {
      trade_count: number;
      win_rate: MetricValue;
      profit_factor: MetricValue;
      expectancy: MetricValue;
      average_mae: MetricValue;
      average_mfe: MetricValue;
    };
    execution: Record<string, unknown> & {
      fees: MetricValue;
      funding: MetricValue;
      slippage: MetricValue;
      turnover: MetricValue;
      exposure_time: MetricValue;
      rejected_order_count: number;
      partial_order_count: number;
      unfilled_order_count: number;
    };
    quality: Record<string, unknown>;
    reconciliation: { passed: boolean; checks: Record<string, boolean> };
    equity_daily: Array<Record<string, string | number>>;
    drawdown_daily: Array<Record<string, string | number>>;
    monthly_returns: Array<{ month: string; value: string | null; reason: string | null }>;
  };
  account_model?: string;
  funding_mode?: string;
  liquidation_model?: string;
  risk_policy?: {
    policy_revision?: string;
    sizing_policy?: string;
    risk_policy?: string;
    max_actual_abs_position?: string;
    max_actual_notional?: string;
    peak_equity?: string | null;
    stop_reasons?: Record<string, number>;
    cooldown_until_sequence?: number;
  };
}

export interface MetricValue {
  value: string | null;
  reason: string | null;
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
  chart_hash: string;
  symbol: string;
  interval: string;
  bars: BacktestChartBar[];
  fills: BacktestFillRecord[];
  rejected_orders?: Array<Record<string, unknown>>;
  equity_curve: Array<Record<string, string | number>>;
  truncated: boolean;
}

export interface SignalTraceItem {
  ordinal: number;
  event_time_ms: number | null;
  payload: Record<string, unknown>;
  row_hash: string;
}

export interface SignalTracePage {
  schema: "SIGNAL_TRACE_V1";
  runId: string;
  items: SignalTraceItem[];
  nextAfter: number | null;
  limit: number;
}

export interface RunCompareMetricDelta {
  left: unknown;
  right: unknown;
  delta: string | null;
}

export interface RunCompareSideV3 {
  runId: string;
  hashes: Record<string, string | null>;
  equity: Array<Record<string, string | number>>;
  equityDaily: Array<Record<string, string | number>>;
  drawdownDaily: Array<Record<string, string | number>>;
  metrics: Record<string, unknown>;
}

export interface RunCompareV3 {
  schema: "RUN_COMPARE_V3";
  directComparisonAllowed: boolean;
  incompatibleFields: string[];
  comparisonContext: { leftHash: string | null; rightHash: string | null };
  precisionExplanation: string | null;
  parameterDiff: Record<string, { left: unknown; right: unknown }>;
  tradeDiff: Record<string, RunCompareMetricDelta>;
  costDiff: Record<string, RunCompareMetricDelta>;
  fingerprintDiff: {
    version: "TRADE_FINGERPRINT_V2";
    available: boolean;
    reason?: string;
    addedCount: number | null;
    removedCount: number | null;
    unchangedCount: number | null;
    added: Array<Record<string, unknown>>;
    removed: Array<Record<string, unknown>>;
  };
  left: RunCompareSideV3;
  right: RunCompareSideV3;
}

export interface RecentRunCompareV1 {
  schema: "RUN_COMPARE_RECENT_V1";
  currentRunId: string;
  baselineRunId: string | null;
  comparison: RunCompareV3 | null;
}

export interface BacktestTrialRecord {
  trial_id: string;
  ordinal: number;
  split_id: string;
  params_json: string;
  run_id?: string | null;
  state: string;
}

export interface BacktestTrainTrialRecord {
  train_trial_id: string;
  candidate_ordinal: number;
  params_json: string;
  params_hash: string;
  run_id?: string | null;
  state: string;
  objective_value?: string | null;
  eligible?: number | null;
  violations_json?: string | null;
  warnings_json?: string | null;
}

export interface BacktestSelectionReceipt {
  schemaVersion: string;
  objective: string;
  tieBreak: string;
  selected: {
    candidate_ordinal: number;
    params: Record<string, unknown>;
    params_hash: string;
    objective_value: string;
  };
  candidates: Array<{
    candidate_ordinal: number;
    params: Record<string, unknown>;
    params_hash: string;
    evaluation: {
      eligible: boolean;
      objective_value: string | null;
      violations: string[];
      warnings: string[];
    };
  }>;
  hashes: { receipt: string };
}

export interface BacktestStudyFold {
  fold_id: string;
  ordinal: number;
  train_start_ms: number;
  train_end_ms: number;
  test_start_ms: number;
  test_end_ms: number;
  purge_ms: number;
  embargo_ms: number;
  state: string;
  test_run_id?: string | null;
  train_trials: BacktestTrainTrialRecord[];
  selection_receipt?: BacktestSelectionReceipt | null;
  test_run?: BacktestRunRecord | null;
}

export interface BacktestOosReport {
  schemaVersion: string;
  sourcePolicy: string;
  folds: Array<{
    ordinal: number;
    receipt_hash: string;
    selected_params: Record<string, unknown>;
    test_run_id: string;
    train_objective: string;
    test_objective: string | null;
    train_test_gap: string | null;
    benchmark_return: string | null;
    always_flat_return: string;
    market_regime: string;
  }>;
  equity: Array<Record<string, string | number>>;
  summary: {
    fold_count: number;
    initial_equity: string;
    final_equity: string;
    total_return: string;
  };
  robustness: Record<string, unknown>;
  hashes: { report: string };
}

export interface BacktestStudyRecord {
  study_id: string;
  name: string;
  hypothesis: string;
  state: string;
  strategy_revision_id: string;
  config_hash: string;
  trials: BacktestTrialRecord[];
  config_json?: string;
  study_schema?: string;
  study_protocol_revision?: string;
  identity?: Record<string, unknown>;
  folds?: BacktestStudyFold[];
  holdout?: {
    state: string;
    start_ms: number;
    end_ms: number;
    reveal_receipt_hash?: string | null;
    run_id?: string | null;
  } | null;
  oos_report?: BacktestOosReport | null;
  dataset_basket?: Record<string, unknown> | null;
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
  folds?: BacktestStudyFold[];
  oos_report?: BacktestOosReport | null;
  selection_warning?: string;
  dataset_basket?: Record<string, unknown> | null;
  portfolio_sum_forbidden?: boolean;
  multi_market_enabled?: boolean;
  independent_symbol_robustness?: {
    verdict?: {
      verdict: string;
      flags: string[];
      single_market_only: boolean;
      positive_oos_symbols: string[];
    };
    stability?: {
      stable: boolean;
      distinct_winner_count: number;
      selected_params_hash?: string | null;
    };
    independent_oos?: {
      portfolioSumForbidden: boolean;
      members: Array<{
        symbol: string;
        dataset_id: string;
        run_id: string;
        report_hash: string;
        test_objective?: string | null;
        regime?: string;
      }>;
    };
  } | null;
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
