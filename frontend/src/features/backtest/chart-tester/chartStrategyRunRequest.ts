import {
  BacktestApiError,
  type BacktestApiClient,
  type BacktestQuickPreset,
  type ChartContextResolution,
  type ChartContextResolveRequest,
  type StrategyRevisionRecord,
} from "../backtestApi.js";
import { pollBacktestRunToTerminal, type waitForBacktestPoll } from "../backtestRunClient.js";
import type { BacktestRunRecord } from "../backtestTypes.js";
import type { ResultProjectionIdentity } from "./chartStrategyTesterState.js";
import type { ChartStrategyRunRequest } from "./chartStrategyTesterUiModel.js";

export type ChartStrategyRunApi = Pick<BacktestApiClient,
  | "createStrategyRevision"
  | "resolveChartContext"
  | "materializeChartContext"
  | "smokeStrategyRevision"
  | "validate"
  | "createRun"
  | "getRun"
>;

export type ChartStrategyRunStage =
  | "COMPILING"
  | "RESOLVING"
  | "MATERIALIZING"
  | "VALIDATING"
  | "QUEUED"
  | "RUNNING";

export interface ChartStrategyFrozenRunRequest extends ChartStrategyRunRequest {
  parameterHash: string;
}

export interface ChartStrategyRunDiagnostics {
  code: string;
  message: string;
  action: string;
  details: Record<string, unknown>;
  sourceDiagnostics: Array<Record<string, unknown>>;
}

export type ChartStrategyRunOutcome =
  | {
    kind: "NEEDS_DATA";
    frozen: ChartStrategyFrozenRunRequest;
    revision: StrategyRevisionRecord;
    resolution: ChartContextResolution;
  }
  | {
    kind: "UNSUPPORTED";
    frozen: ChartStrategyFrozenRunRequest;
    revision: StrategyRevisionRecord;
    resolution: ChartContextResolution;
  }
  | {
    kind: "TERMINAL";
    frozen: ChartStrategyFrozenRunRequest;
    revision: StrategyRevisionRecord;
    resolution: ChartContextResolution;
    run: BacktestRunRecord;
    identity: ResultProjectionIdentity;
  };

export class ChartStrategyRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ChartStrategyRunError";
  }
}

export function canonicalChartStrategyJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite values cannot enter Run identity");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalChartStrategyJson).join(",")}]`;
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalChartStrategyJson(source[key])}`
    )).join(",")}}`;
  }
  throw new TypeError("unsupported value in Run identity");
}

export async function chartStrategySha256(value: unknown): Promise<`sha256:${string}`> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new ChartStrategyRunError("HASH_UNAVAILABLE", "SHA-256 is unavailable");
  const bytes = new TextEncoder().encode(canonicalChartStrategyJson(value));
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return `sha256:${[...digest].map((item) => item.toString(16).padStart(2, "0")).join("")}`;
}

function cloneFrozen<T>(value: T): T {
  return JSON.parse(canonicalChartStrategyJson(value)) as T;
}

export async function freezeChartStrategyRunRequest(
  request: ChartStrategyRunRequest,
): Promise<ChartStrategyFrozenRunRequest> {
  const cloned = cloneFrozen(request);
  const parameterHash = await chartStrategySha256(cloned.attachment.parameters);
  return Object.freeze({
    ...cloned,
    session: Object.freeze({ ...cloned.session }),
    attachment: Object.freeze({
      ...cloned.attachment,
      parameters: Object.freeze({ ...cloned.attachment.parameters }),
      customRange: cloned.attachment.customRange
        ? Object.freeze({ ...cloned.attachment.customRange })
        : null,
    }),
    parameterHash,
  });
}

export function chartContextRequestForFrozen(
  frozen: ChartStrategyFrozenRunRequest,
): ChartContextResolveRequest {
  const rangeMode = frozen.attachment.rangeMode;
  const range = frozen.attachment.customRange;
  if (rangeMode !== "ALL_AVAILABLE" && !range) {
    throw new ChartStrategyRunError(
      "RANGE_UNAVAILABLE",
      "the selected chart range is not frozen yet",
      { next_step: "choose all available data or freeze a custom range" },
    );
  }
  return {
    exchange: frozen.session.exchange,
    market_type: frozen.session.marketType,
    symbol: frozen.session.symbol,
    interval: frozen.session.interval,
    range_mode: rangeMode,
    start_time_ms: rangeMode === "ALL_AVAILABLE" ? null : range!.startMs,
    end_time_ms: rangeMode === "ALL_AVAILABLE" ? null : range!.endMs,
    fidelity_preference: frozen.attachment.fidelityPreference,
  };
}

function revisionLanguage(language: ChartStrategyFrozenRunRequest["language"]): string {
  return language === "pine" ? "PINE_SUBSET" : "PYNE_CHART_V1";
}

function requireString(source: Record<string, string>, name: string): string {
  const value = String(source[name] ?? "").trim();
  if (!value) {
    throw new ChartStrategyRunError(
      "FEE_PRESET_UNKNOWN",
      `quick preset field ${name} is unavailable`,
      { next_step: "select or confirm the market fee preset" },
    );
  }
  return value;
}

function readyRange(resolution: ChartContextResolution): { startTimeMs: number; endTimeMs: number } {
  const startTimeMs = resolution.coverage.requested_start_ms
    ?? resolution.coverage.available_start_ms;
  const endTimeMs = resolution.coverage.requested_end_ms
    ?? resolution.coverage.available_end_ms;
  if (startTimeMs === null || endTimeMs === null || startTimeMs >= endTimeMs) {
    throw new ChartStrategyRunError(
      "DATA_COVERAGE_INCOMPLETE",
      "the immutable chart range has no valid absolute boundaries",
      { next_step: "resolve the chart range again" },
    );
  }
  return { startTimeMs, endTimeMs };
}

function requireReadyIdentity(resolution: ChartContextResolution): {
  datasetId: string;
  dataEpoch: string;
  snapshotHash: string;
} {
  if (resolution.status !== "READY"
    || !resolution.dataset_id
    || !resolution.data_epoch
    || !resolution.snapshot_hash
    || !resolution.coverage.complete) {
    throw new ChartStrategyRunError(
      "CHART_CONTEXT_NOT_READY",
      "chart context is not an immutable READY snapshot",
      { next_step: "resolve or prepare data again" },
    );
  }
  return {
    datasetId: resolution.dataset_id,
    dataEpoch: resolution.data_epoch,
    snapshotHash: resolution.snapshot_hash,
  };
}

export function buildChartStrategyRunBody(input: {
  frozen: ChartStrategyFrozenRunRequest;
  revision: StrategyRevisionRecord;
  resolution: ChartContextResolution;
}): Record<string, unknown> {
  const identity = requireReadyIdentity(input.resolution);
  const range = readyRange(input.resolution);
  const cost = input.resolution.cost_preset;
  const account = input.resolution.account_execution_preset;
  const feeSource = requireString(cost, "fee_source");
  const feeBps = requireString(cost, "fee_bps");
  const presetRevision = requireString(cost, "preset_revision");
  const quickPresetId = String(input.frozen.attachment.quickPresetId
    || input.resolution.quick_preset_id).trim();
  if (!quickPresetId || quickPresetId !== input.resolution.quick_preset_id) {
    throw new ChartStrategyRunError(
      "QUICK_PRESET_MISMATCH",
      "the selected quick preset does not match the resolved market",
      { next_step: "use the resolved market preset and run again" },
    );
  }
  return {
    strategy_revision_id: input.revision.revision_id,
    dataset_id: identity.datasetId,
    data_epoch: identity.dataEpoch,
    snapshot_hash: identity.snapshotHash,
    fidelity_mode: input.resolution.fidelity.mode,
    source_event_kind: input.resolution.fidelity.mode === "BAR_APPROX" ? "BAR" : "AGG_TRADE",
    start_time_ms: range.startTimeMs,
    end_time_ms: range.endTimeMs,
    symbol: input.frozen.session.symbol,
    interval: input.frozen.session.interval,
    warmup_bars: 0,
    parameters: cloneFrozen(input.frozen.attachment.parameters),
    output_mode: input.revision.output_modes.includes("TARGET_POSITION")
      ? "TARGET_POSITION"
      : input.revision.output_modes[0],
    signal_trace_mode: "PAGED_V1",
    account_model: requireString(account, "account_model"),
    contract_data_mode: requireString(account, "contract_data_mode"),
    initial_balance: requireString(account, "initial_cash"),
    slippage_bps: requireString(cost, "slippage_bps"),
    taker_fee_bps: feeBps,
    maker_fee_bps: feeBps,
    fee_source: feeSource,
    funding_rate: "0",
    funding_interval_hours: 8,
    funding_mode: requireString(account, "funding_mode"),
    leverage: requireString(account, "leverage"),
    sizing_policy: requireString(account, "sizing_policy"),
    equity_percent: requireString(account, "equity_percent"),
    execution_model_revision: requireString(account, "execution_model_revision"),
    participation_rate: "0.1",
    latency_ms: 0,
    latency_events: 0,
    order_end_policy: "CANCEL_AT_END",
    exchange: input.frozen.session.exchange,
    market_type: input.frozen.session.marketType,
    gap_policy: "REJECT",
    quick_preset_id: quickPresetId,
    quick_preset_revision: presetRevision,
    chart_range_mode: input.frozen.attachment.rangeMode,
  };
}

function sameReadyContext(left: ChartContextResolution, right: ChartContextResolution): boolean {
  return left.status === "READY"
    && right.status === "READY"
    && left.chart_context_hash === right.chart_context_hash
    && left.dataset_id === right.dataset_id
    && left.data_epoch === right.data_epoch
    && left.snapshot_hash === right.snapshot_hash
    && left.coverage.requested_start_ms === right.coverage.requested_start_ms
    && left.coverage.requested_end_ms === right.coverage.requested_end_ms
    && left.fidelity.mode === right.fidelity.mode;
}

export async function chartStrategyMaterializeKey(
  frozen: ChartStrategyFrozenRunRequest,
  resolution: ChartContextResolution,
): Promise<string> {
  const digest = await chartStrategySha256({
    schema: "CHART_STRATEGY_MATERIALIZE_V1",
    cellScope: frozen.cellScope,
    chartContextHash: resolution.chart_context_hash,
    request: resolution.request,
  });
  return `chart-data:${digest.slice("sha256:".length)}`;
}

export async function chartStrategyRunIdempotencyKey(input: {
  revisionId: string;
  resolution: ChartContextResolution;
  body: Record<string, unknown>;
}): Promise<string> {
  const digest = await chartStrategySha256({
    schema: "CHART_STRATEGY_RUN_V1",
    strategyRevisionId: input.revisionId,
    chartContextHash: input.resolution.chart_context_hash,
    config: input.body,
  });
  return `chart-run:${digest.slice("sha256:".length)}`;
}

function resultIdentity(input: {
  frozen: ChartStrategyFrozenRunRequest;
  revision: StrategyRevisionRecord;
  resolution: ChartContextResolution;
  body: Record<string, unknown>;
  runId: string;
}): ResultProjectionIdentity {
  const immutable = requireReadyIdentity(input.resolution);
  const range = readyRange(input.resolution);
  return {
    cellScope: input.frozen.cellScope,
    chartContextHash: input.resolution.chart_context_hash,
    strategyRevisionId: input.revision.revision_id,
    parameterHash: input.frozen.parameterHash,
    datasetId: immutable.datasetId,
    dataEpoch: immutable.dataEpoch,
    snapshotHash: immutable.snapshotHash,
    startTimeMs: range.startTimeMs,
    endTimeMs: range.endTimeMs,
    executionProfileRevision: String(input.body.execution_model_revision ?? ""),
    runId: input.runId,
  };
}

export async function runChartStrategyBacktest(options: {
  api: ChartStrategyRunApi;
  request: ChartStrategyRunRequest;
  signal?: AbortSignal;
  materializeResolution?: ChartContextResolution | null;
  pollIntervalMs?: number;
  wait?: typeof waitForBacktestPoll;
  onStage?(stage: ChartStrategyRunStage): void;
  onRevision?(revision: StrategyRevisionRecord): void;
  onResolution?(resolution: ChartContextResolution): void;
  onRunCreated?(run: BacktestRunRecord, identity: ResultProjectionIdentity): void;
  onRunUpdate?(run: BacktestRunRecord): void;
}): Promise<ChartStrategyRunOutcome> {
  const frozen = await freezeChartStrategyRunRequest(options.request);
  options.onStage?.("COMPILING");
  const revision = await options.api.createStrategyRevision({
    name: frozen.displayName,
    language: revisionLanguage(frozen.language),
    base_revision_id: null,
    source_text: frozen.source,
    parameter_schema: [],
  }, options.signal);
  options.onRevision?.(revision);
  const contextRequest = chartContextRequestForFrozen(frozen);
  if (options.materializeResolution) {
    options.onStage?.("MATERIALIZING");
    await options.api.materializeChartContext({
      resolution_token: options.materializeResolution.resolution_token,
      user_confirmed: true,
      idempotency_key: await chartStrategyMaterializeKey(frozen, options.materializeResolution),
      ...(options.materializeResolution.dataset_id
        ? { expected_dataset_id: options.materializeResolution.dataset_id }
        : {}),
      ...(options.materializeResolution.data_epoch
        ? { expected_data_epoch: options.materializeResolution.data_epoch }
        : {}),
    }, options.signal);
  }
  options.onStage?.("RESOLVING");
  const resolution = await options.api.resolveChartContext(contextRequest, options.signal);
  options.onResolution?.(resolution);
  if (resolution.status === "NEEDS_DATA") {
    return { kind: "NEEDS_DATA", frozen, revision, resolution };
  }
  if (resolution.status !== "READY") {
    return { kind: "UNSUPPORTED", frozen, revision, resolution };
  }
  const body = buildChartStrategyRunBody({ frozen, revision, resolution });
  const range = readyRange(resolution);
  options.onStage?.("VALIDATING");
  await options.api.smokeStrategyRevision(revision.revision_id, {
    dataset_id: resolution.dataset_id,
    snapshot_hash: resolution.snapshot_hash,
    start_time_ms: range.startTimeMs,
    end_time_ms: Math.min(range.endTimeMs, range.startTimeMs + 7 * 86_400_000),
    parameters: frozen.attachment.parameters,
  }, options.signal);
  await options.api.validate(body, options.signal);
  const refreshed = await options.api.resolveChartContext(contextRequest, options.signal);
  options.onResolution?.(refreshed);
  if (!sameReadyContext(resolution, refreshed)) {
    throw new ChartStrategyRunError(
      "CHART_CONTEXT_CHANGED",
      "chart context changed between validation and Run creation",
      { next_step: "resolve the current chart and run again" },
    );
  }
  const refreshedBody = buildChartStrategyRunBody({ frozen, revision, resolution: refreshed });
  const idempotencyKey = await chartStrategyRunIdempotencyKey({
    revisionId: revision.revision_id,
    resolution: refreshed,
    body: refreshedBody,
  });
  const created = await options.api.createRun(refreshedBody, idempotencyKey, options.signal);
  const identity = resultIdentity({
    frozen,
    revision,
    resolution: refreshed,
    body: refreshedBody,
    runId: created.run_id,
  });
  options.onStage?.(created.state === "QUEUED" ? "QUEUED" : "RUNNING");
  options.onRunCreated?.(created, identity);
  if (created.state === "COMPLETED") {
    return { kind: "TERMINAL", frozen, revision, resolution: refreshed, run: created, identity };
  }
  const terminal = await pollBacktestRunToTerminal({
    api: options.api,
    runId: created.run_id,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.pollIntervalMs === undefined ? {} : { intervalMs: options.pollIntervalMs }),
    ...(options.wait ? { wait: options.wait } : {}),
    onUpdate(run) {
      options.onStage?.(run.state === "QUEUED" ? "QUEUED" : "RUNNING");
      options.onRunUpdate?.(run);
    },
  });
  return { kind: "TERMINAL", frozen, revision, resolution: refreshed, run: terminal, identity };
}

function sourceDiagnostics(message: string): Array<Record<string, unknown>> {
  const start = message.indexOf("[");
  if (start < 0) return [];
  try {
    const parsed = JSON.parse(message.slice(start)) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      : [];
  } catch {
    return [];
  }
}

export function chartStrategyRunDiagnostics(error: unknown): ChartStrategyRunDiagnostics {
  const code = error instanceof BacktestApiError || error instanceof ChartStrategyRunError
    ? error.code
    : "BACKTEST_API_UNAVAILABLE";
  const message = error instanceof BacktestApiError
    ? error.apiMessage
    : error instanceof Error
      ? error.message
      : "backtest request failed";
  const details = error instanceof BacktestApiError || error instanceof ChartStrategyRunError
    ? error.details
    : {};
  let action = "retry";
  if (code.includes("FEE") || code.includes("PRESET")) action = "confirm-fee";
  else if (code.includes("INTERVAL")) action = "switch-interval";
  else if (code.includes("FIDELITY")) action = "use-fast";
  else if (code.includes("DATA") || code.includes("SNAPSHOT") || code.includes("CONTEXT")) action = "resolve-data";
  else if (code.includes("PROVIDER") || code.includes("SMOKE")) action = "fix-strategy";
  else if (code.includes("BUDGET") || code === "RUN_CAPACITY_EXCEEDED") action = "wait-and-retry";
  return { code, message, details, action, sourceDiagnostics: sourceDiagnostics(message) };
}

export function quickPresetFromResolution(
  resolution: ChartContextResolution,
): BacktestQuickPreset {
  return {
    id: resolution.quick_preset_id,
    revision: requireString(resolution.cost_preset, "preset_revision"),
    label: resolution.quick_preset_id,
    market_types: [resolution.request.market_type],
    account_model: requireString(resolution.account_execution_preset, "account_model"),
    sizing_policy: requireString(resolution.account_execution_preset, "sizing_policy"),
    equity_percent: requireString(resolution.account_execution_preset, "equity_percent"),
    initial_cash: requireString(resolution.account_execution_preset, "initial_cash"),
    leverage: requireString(resolution.account_execution_preset, "leverage"),
    fee_source: requireString(resolution.cost_preset, "fee_source"),
    fee_bps: requireString(resolution.cost_preset, "fee_bps"),
    slippage_bps: requireString(resolution.cost_preset, "slippage_bps"),
    execution_model_revision: requireString(resolution.account_execution_preset, "execution_model_revision"),
    contract_data_mode: requireString(resolution.account_execution_preset, "contract_data_mode"),
    funding_mode: requireString(resolution.account_execution_preset, "funding_mode"),
  };
}
