import type { ChartSession } from "../../chart-session/chartSessionTypes.js";
import type {
  BacktestDataset,
  BacktestSnapshot,
} from "../backtestApi.js";
import type {
  BacktestResearchLaunchContext,
  BacktestRunRecord,
} from "../backtestTypes.js";

const DAY_MS = 86_400_000;
const SAFE_REPLAY_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function parseResearchObjectJson(text: string, field: string): Record<string, unknown> {
  return objectValue(JSON.parse(text) as unknown, field);
}

export function parseResearchRunConfig(run: BacktestRunRecord | null): Record<string, unknown> {
  if (!run?.config_json) return {};
  try {
    return objectValue(JSON.parse(run.config_json) as unknown, "Run config");
  } catch {
    return {};
  }
}

export function researchDatasetIdFromAuthority(input: {
  context: BacktestResearchLaunchContext | null;
  run: BacktestRunRecord | null;
  datasets: readonly BacktestDataset[];
}): string {
  const authoritative = input.context?.dataset_identity?.dataset_id ?? input.run?.dataset_id;
  if (authoritative && input.datasets.some((item) => item.dataset_id === authoritative)) {
    return authoritative;
  }
  return input.datasets[0]?.dataset_id ?? "";
}

export function researchRangeFromAuthority(input: {
  context: BacktestResearchLaunchContext | null;
  run: BacktestRunRecord | null;
  dataset: BacktestDataset | null;
}): { startTimeMs: number; endTimeMs: number } {
  const config = parseResearchRunConfig(input.run);
  const start = input.context?.range.start_time_ms
    ?? Number(config.start_time_ms ?? input.dataset?.first_open_ms ?? 0);
  const end = input.context?.range.end_time_ms
    ?? Number(config.end_time_ms ?? input.dataset?.last_close_ms ?? 0);
  return {
    startTimeMs: Number.isFinite(start) ? start : 0,
    endTimeMs: Number.isFinite(end) ? end : 0,
  };
}

export function composeResearchRunDraft(input: {
  context: BacktestResearchLaunchContext | null;
  run: BacktestRunRecord | null;
  dataset: BacktestDataset | null;
  snapshot: BacktestSnapshot | null;
  revisionId: string;
  outputMode?: string | undefined;
  session: ChartSession;
  startTimeMs: number;
  endTimeMs: number;
}): Record<string, unknown> {
  const parsed = parseResearchRunConfig(input.run);
  const existing = parsed.strategy_revision_id === input.revisionId ? parsed : {};
  const fidelityMode = String(existing.fidelity_mode ?? input.run?.fidelity_mode ?? "BAR_APPROX");
  return {
    initial_balance: "10000",
    slippage_bps: "1",
    taker_fee_bps: "0",
    maker_fee_bps: "0",
    funding_rate: "0",
    funding_interval_hours: 8,
    funding_mode: "OFF",
    leverage: "1",
    sizing_policy: "FIXED_QTY_V1",
    fixed_qty: "1",
    fixed_notional: "1000",
    equity_percent: "10",
    risk_per_stop_percent: "1",
    stop_distance: null,
    max_abs_position_qty: "100",
    max_notional: "1000000",
    max_leverage: "20",
    max_order_risk: "10000",
    max_active_orders: 20,
    max_cumulative_fees: "10000",
    max_drawdown_percent: "50",
    daily_loss_limit: null,
    cooldown_events: 0,
    account_model: "LINEAR_PERP_ONE_WAY_V1",
    contract_data_mode: "LEGACY_FIXED_V1",
    execution_model_revision: null,
    participation_rate: null,
    latency_ms: 0,
    latency_events: 0,
    order_end_policy: "CANCEL_AT_END",
    bar_path_scenario: null,
    metrics_version: null,
    risk_free_rate_annual: "0",
    sample_role: "IN_SAMPLE",
    gap_policy: "REJECT",
    signal_trace_mode: "PAGED_V1",
    parameters: input.context?.parameters ?? {},
    warmup_bars: 0,
    output_mode: input.outputMode ?? "TARGET_POSITION",
    ...existing,
    strategy_revision_id: input.revisionId,
    dataset_id: input.dataset?.dataset_id ?? "",
    data_epoch: input.snapshot?.data_epoch ?? input.dataset?.data_epoch ?? "",
    snapshot_hash: input.snapshot?.snapshot_hash ?? "",
    fidelity_mode: fidelityMode,
    source_event_kind: fidelityMode === "BAR_APPROX" ? "BAR" : "AGG_TRADE",
    start_time_ms: input.startTimeMs,
    end_time_ms: input.endTimeMs,
    interval: input.dataset?.interval ?? input.session.interval,
    exchange: input.session.exchange,
    market_type: input.session.marketType,
  };
}

export function composeResearchStudyDraft(input: {
  context: BacktestResearchLaunchContext | null;
  dataset: BacktestDataset | null;
  snapshot: BacktestSnapshot | null;
  revisionId: string;
  parameterSchema?: readonly Record<string, unknown>[] | undefined;
  startTimeMs: number;
  endTimeMs: number;
}): Record<string, unknown> {
  const horizonMs = Math.max(0, input.endTimeMs - input.startTimeMs + 1);
  const intervalMs = fixedIntervalMs(input.dataset?.interval ?? input.context?.chart_session.interval ?? "");
  const availableBars = intervalMs === null ? 0 : Math.floor(horizonMs / intervalMs);
  const testBars = Math.max(1, Math.floor(availableBars * 0.2));
  const trainBars = Math.max(1, Math.min(
    availableBars - testBars,
    Math.floor(availableBars * 0.6),
  ));
  const adaptiveWindows = availableBars >= 2 && intervalMs !== null
    ? {
      train_ms: trainBars * intervalMs,
      test_ms: testBars * intervalMs,
      step_ms: testBars * intervalMs,
      purge_ms: 0,
      embargo_ms: 0,
    }
    : {
      train_ms: 110 * DAY_MS,
      test_ms: 20 * DAY_MS,
      step_ms: 20 * DAY_MS,
      purge_ms: DAY_MS,
      embargo_ms: DAY_MS,
    };
  const parameterSpace = Object.fromEntries(
    Object.entries(input.context?.parameters ?? {}).map(([name, value]) => [name, [value]]),
  );
  if (Object.keys(parameterSpace).length === 0) {
    const firstParameter = input.parameterSchema?.find((item) => (
      typeof item.name === "string" && Object.hasOwn(item, "default")
    ));
    if (firstParameter && typeof firstParameter.name === "string") {
      parameterSpace[firstParameter.name] = [firstParameter.default];
    }
  }
  return {
    name: `Research study ${new Date().toISOString().slice(0, 16)}`,
    hypothesis: "Parameters should remain stable out of sample after costs.",
    study_protocol_revision: "BACKTEST_WALK_FORWARD_V2",
    selection_protocol_revision: "TRAIN_CONSTRAINT_OBJECTIVE_SELECT_ONCE_V2",
    strategy_revision_id: input.revisionId,
    dataset_id: input.dataset?.dataset_id ?? "",
    data_epoch: input.snapshot?.data_epoch ?? input.dataset?.data_epoch ?? "",
    dataset_snapshot_hash: input.snapshot?.snapshot_hash ?? "",
    interval: input.dataset?.interval ?? input.context?.chart_session.interval ?? "15m",
    start_ms: input.startTimeMs,
    end_ms: input.endTimeMs,
    ...adaptiveWindows,
    holdout_ms: 0,
    parameter_space: parameterSpace,
    parameters: {},
    sampler: "grid",
    seed: 24,
    candidate_budget: 4,
    objective: "NET_RETURN",
    constraints: {
      min_closed_trades: 1,
      max_drawdown: "0.5",
      min_data_coverage: "1",
      max_ambiguity_ratio: "0",
      max_rejected_ratio: "0",
      cost_plus_25_must_be_positive: false,
      warn_min_long_trades: 1,
      warn_min_short_trades: 1,
    },
    warmup_bars: 0,
    initial_balance: "10000",
    slippage_bps: "1",
    taker_fee_bps: "0",
    maker_fee_bps: "0",
    account_model: "LINEAR_PERP_ONE_WAY_V2",
    contract_data_mode: "HISTORICAL_CONTRACT_V1",
    funding_mode: "OFF",
    execution_model_revision: "EXECUTION_REALISM_V2",
    participation_rate: "0.1",
    metrics_version: "BACKTEST_METRICS_V2",
    risk_free_rate_annual: "0",
    sizing_policy: "FIXED_QTY_V1",
    fixed_qty: "1",
    gap_policy: "REJECT",
  };
}

function fixedIntervalMs(interval: string): number | null {
  const match = /^(\d+)([mhd])$/.exec(interval.trim().toLowerCase());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : DAY_MS;
  return Number.isSafeInteger(amount) && amount > 0 ? amount * unit : null;
}

export function normalizeResearchRunDraft(input: {
  draft: Record<string, unknown>;
  dataset: BacktestDataset;
  snapshot: BacktestSnapshot;
  revisionId: string;
  session: ChartSession;
  startTimeMs: number;
  endTimeMs: number;
}): Record<string, unknown> {
  const fidelityMode = String(input.draft.fidelity_mode ?? "BAR_APPROX");
  return {
    ...input.draft,
    strategy_revision_id: input.revisionId,
    dataset_id: input.dataset.dataset_id,
    data_epoch: input.snapshot.data_epoch,
    snapshot_hash: input.snapshot.snapshot_hash,
    start_time_ms: input.startTimeMs,
    end_time_ms: input.endTimeMs,
    interval: input.dataset.interval,
    exchange: input.session.exchange,
    market_type: input.session.marketType,
    fidelity_mode: fidelityMode,
    source_event_kind: fidelityMode === "BAR_APPROX" ? "BAR" : "AGG_TRADE",
  };
}

export function normalizeResearchStudyDraft(input: {
  draft: Record<string, unknown>;
  dataset: BacktestDataset;
  snapshot: BacktestSnapshot;
  revisionId: string;
  startTimeMs: number;
  endTimeMs: number;
}): Record<string, unknown> {
  return {
    ...input.draft,
    strategy_revision_id: input.revisionId,
    dataset_id: input.dataset.dataset_id,
    data_epoch: input.snapshot.data_epoch,
    dataset_snapshot_hash: input.snapshot.snapshot_hash,
    interval: input.dataset.interval,
    start_ms: input.startTimeMs,
    end_ms: input.endTimeMs,
  };
}

export function researchObjectJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}

export function researchRunIsActive(run: BacktestRunRecord): boolean {
  return !["COMPLETED", "FAILED", "CANCELLED"].includes(run.state);
}

export function researchStudyIsActive(state: string): boolean {
  return ["QUEUED", "RUNNING", "CANCELLING"].includes(state);
}

export function researchReplayHref(bridge: Record<string, unknown> | null): string | null {
  const training = bridge?.trainingRun;
  const direct = training && typeof training === "object" && !Array.isArray(training)
    ? (training as Record<string, unknown>).run_id
    : bridge?.trainingRunId;
  const runId = typeof direct === "string" ? direct : "";
  if (!SAFE_REPLAY_RUN_ID.test(runId)) return null;
  return `/replay.html?run=${encodeURIComponent(runId)}`;
}
