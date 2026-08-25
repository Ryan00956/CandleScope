import assert from "node:assert/strict";
import test from "node:test";

import { BacktestApiError, type ChartContextResolution, type StrategyRevisionRecord } from "../../backtestApi.js";
import type { BacktestRunRecord } from "../../backtestTypes.js";
import {
  buildChartStrategyRunBody,
  chartStrategyQuickPresetIdForMarket,
  chartStrategyRunDiagnostics,
  freezeChartStrategyRunRequest,
  runChartStrategyBacktest,
  type ChartStrategyRunApi,
} from "../chartStrategyRunRequest.js";
import type { ChartStrategyRunRequest } from "../chartStrategyTesterUiModel.js";

const request: ChartStrategyRunRequest = {
  cellScope: "workspace\u0000cell-1",
  session: {
    exchange: "binance",
    marketType: "usdm",
    symbol: "BTCUSDT",
    interval: "1h",
  },
  draftId: "draft-12345678",
  draftContentRevision: 1,
  displayName: "SMA Cross",
  language: "pyne",
  source: [
    'strategy("SMA Cross")',
    "fast = sma(close, 3)",
    "slow = sma(close, 5)",
    "if crossover(fast, slow)",
    "  target_position(1)",
  ].join("\n"),
  attachment: {
    schemaVersion: 1,
    strategyDraftId: "draft-12345678",
    strategyRevisionId: null,
    displayName: "SMA Cross",
    language: "pyne",
    parameters: { fast: 3, slow: 5 },
    rangeMode: "ALL_AVAILABLE",
    customRange: null,
    fidelityPreference: "FAST",
    quickPresetId: "CRYPTO_PERP_STANDARD_V1",
    autoRun: false,
  },
};

const revision: StrategyRevisionRecord = {
  revision_id: "srv2_chart",
  provider_kind: "PYNE_CHART_V1",
  language: "PYNE_CHART_V1",
  label: "SMA Cross",
  description: "immutable",
  input_modes: ["BAR_CLOSE"],
  output_modes: ["TARGET_POSITION"],
  signal_clock: "EVENT",
  required_features: [],
  warmup_requirement: {},
  parameter_schema: [],
  accepts_source: false,
  source_hash: "sha256:source",
  compiled_hash: "sha256:compiled",
  runtime_revision: "candlescope-strategy-workspace/2",
  reused: false,
};

function resolution(
  status: ChartContextResolution["status"] = "READY",
  suffix = "a",
): ChartContextResolution {
  return {
    schema_version: "candlescope.backtest-chart-context/1",
    status,
    resolution_token: `token-${suffix.padEnd(20, suffix)}`,
    chart_context_hash: `sha256:context-${suffix}`,
    expires_at_ms: 999_999,
    request: {
      exchange: "binance",
      market_type: "usdm",
      symbol: "BTCUSDT",
      interval: "1h",
      range_mode: "ALL_AVAILABLE",
      start_time_ms: null,
      end_time_ms: null,
      fidelity_preference: "FAST",
    },
    dataset_id: status === "READY" ? "local-chart" : null,
    data_epoch: status === "READY" ? "epoch-20260824" : null,
    snapshot_hash: status === "READY" ? `sha256:snapshot-${suffix}` : null,
    coverage: {
      requested_start_ms: status === "READY" ? 1_000 : null,
      requested_end_ms: status === "READY" ? 3_601_000 : null,
      available_start_ms: status === "READY" ? 1_000 : null,
      available_end_ms: status === "READY" ? 3_601_000 : null,
      row_count: status === "READY" ? 2 : null,
      missing_ranges: [],
      complete: status === "READY",
    },
    fidelity: { preference: "FAST", mode: "BAR_APPROX", capabilities: ["BAR_APPROX"] },
    quality_warnings: [],
    quick_preset_id: "CRYPTO_PERP_STANDARD_V1",
    cost_preset: {
      preset_id: "CRYPTO_PERP_STANDARD_V1",
      preset_revision: "1",
      fee_source: "exchange-market-preset",
      fee_bps: "4",
      slippage_bps: "1",
    },
    account_execution_preset: {
      account_model: "LINEAR_PERP_ONE_WAY_V1",
      sizing_policy: "EQUITY_PERCENT_V1",
      equity_percent: "10",
      initial_cash: "10000",
      leverage: "1",
      execution_model_revision: "EXECUTION_REALISM_V2",
      contract_data_mode: "LEGACY_FIXED_V1",
      funding_mode: "OFF",
    },
    materialize: {
      required: status === "NEEDS_DATA",
      estimated_bars: status === "NEEDS_DATA" ? 24 : 0,
    },
  };
}

function completed(): BacktestRunRecord {
  return {
    run_id: "bt_chart",
    state: "COMPLETED",
    fidelity_mode: "BAR_APPROX",
    source_event_kind: "BAR",
    config_hash: "sha256:config",
  };
}

function apiWithResolutions(
  values: ChartContextResolution[],
  calls: string[],
  keys: string[] = [],
): ChartStrategyRunApi {
  let index = 0;
  return {
    async createStrategyRevision(body) {
      calls.push(`revision:${String(body.language)}`);
      return revision;
    },
    async resolveChartContext() {
      calls.push("resolve");
      return values[Math.min(index++, values.length - 1)]!;
    },
    async materializeChartContext(body) {
      calls.push(`materialize:${body.user_confirmed}`);
      return values[Math.min(index, values.length - 1)]!;
    },
    async smokeStrategyRevision() {
      calls.push("smoke");
      return { ok: true };
    },
    async validate() {
      calls.push("validate");
      return { ok: true };
    },
    async createRun(_body, key) {
      calls.push("create");
      keys.push(key);
      return { ...completed(), state: "QUEUED" };
    },
    async getRun() {
      calls.push("get");
      return completed();
    },
  };
}

test("freezes source/parameters and creates a stable expanded quick Run", async () => {
  const frozen = await freezeChartStrategyRunRequest(request);
  assert.match(frozen.parameterHash, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(frozen.attachment.parameters, request.attachment.parameters);
  const body = buildChartStrategyRunBody({ frozen, revision, resolution: resolution() });
  assert.equal(body.strategy_revision_id, revision.revision_id);
  assert.equal(body.taker_fee_bps, "4");
  assert.equal(body.maker_fee_bps, "4");
  assert.equal(body.quick_preset_revision, "1");
  assert.equal(body.dataset_id, "local-chart");
  assert.equal(body.strategy_source, undefined);
  assert.equal(body.chart_cell_scope, request.cellScope);
  assert.equal(body.strategy_draft_id, request.draftId);
});

test("freezes the market fee preset from the session, not a stale attachment", async () => {
  assert.equal(chartStrategyQuickPresetIdForMarket("spot"), "CRYPTO_SPOT_STANDARD_V1");
  assert.equal(chartStrategyQuickPresetIdForMarket("usdm"), "CRYPTO_PERP_STANDARD_V1");
  const frozen = await freezeChartStrategyRunRequest({
    ...request,
    session: { ...request.session, marketType: "spot" },
  });
  assert.equal(frozen.attachment.quickPresetId, "CRYPTO_SPOT_STANDARD_V1");
  const spotResolution = resolution();
  spotResolution.request = { ...spotResolution.request, market_type: "spot" };
  spotResolution.quick_preset_id = "CRYPTO_SPOT_STANDARD_V1";
  spotResolution.cost_preset = {
    ...spotResolution.cost_preset,
    preset_id: "CRYPTO_SPOT_STANDARD_V1",
  };
  const body = buildChartStrategyRunBody({
    frozen,
    revision,
    resolution: spotResolution,
  });
  assert.equal(body.quick_preset_id, "CRYPTO_SPOT_STANDARD_V1");
});

test("READY follows revision-resolve-smoke-validate-reresolve-create-poll", async () => {
  const calls: string[] = [];
  const keys: string[] = [];
  const api = apiWithResolutions([resolution(), resolution()], calls, keys);
  const outcome = await runChartStrategyBacktest({
    api,
    request,
    pollIntervalMs: 0,
  });
  assert.equal(outcome.kind, "TERMINAL");
  assert.deepEqual(calls, [
    "revision:PYNE_CHART_V1",
    "resolve",
    "smoke",
    "validate",
    "resolve",
    "create",
    "get",
  ]);
  assert.match(keys[0]!, /^chart-run:[0-9a-f]{64}$/);
  const secondCalls: string[] = [];
  await runChartStrategyBacktest({
    api: apiWithResolutions([resolution(), resolution()], secondCalls, keys),
    request,
    pollIntervalMs: 0,
  });
  assert.equal(keys[0], keys[1]);
});

test("an idempotent completed Run is reused without polling or retry", async () => {
  const calls: string[] = [];
  const api = apiWithResolutions([resolution(), resolution()], calls);
  api.createRun = async () => {
    calls.push("create");
    return completed();
  };
  api.getRun = async () => {
    calls.push("get");
    return completed();
  };
  const outcome = await runChartStrategyBacktest({ api, request, pollIntervalMs: 0 });
  assert.equal(outcome.kind, "TERMINAL");
  assert.equal(outcome.kind === "TERMINAL" ? outcome.run.state : null, "COMPLETED");
  assert.equal(calls.filter((call) => call === "create").length, 1);
  assert.equal(calls.includes("get"), false);
});

test("NEEDS_DATA stops for confirmation and materialize always re-resolves", async () => {
  const needs = resolution("NEEDS_DATA");
  const firstCalls: string[] = [];
  const first = await runChartStrategyBacktest({
    api: apiWithResolutions([needs], firstCalls),
    request,
  });
  assert.equal(first.kind, "NEEDS_DATA");
  assert.deepEqual(firstCalls, ["revision:PYNE_CHART_V1", "resolve"]);

  const nextCalls: string[] = [];
  const next = await runChartStrategyBacktest({
    api: apiWithResolutions([resolution(), resolution()], nextCalls),
    request,
    materializeResolution: needs,
    pollIntervalMs: 0,
  });
  assert.equal(next.kind, "TERMINAL");
  assert.deepEqual(nextCalls.slice(0, 3), [
    "revision:PYNE_CHART_V1",
    "materialize:true",
    "resolve",
  ]);
});

test("validate/create drift fails before create", async () => {
  const calls: string[] = [];
  await assert.rejects(
    runChartStrategyBacktest({
      api: apiWithResolutions([resolution("READY", "a"), resolution("READY", "b")], calls),
      request,
      pollIntervalMs: 0,
    }),
    (error: unknown) => (
      error instanceof Error
      && "code" in error
      && error.code === "CHART_CONTEXT_CHANGED"
    ),
  );
  assert.equal(calls.includes("create"), false);
});

test("unknown fees fail closed and provider diagnostics remain located", async () => {
  const frozen = await freezeChartStrategyRunRequest(request);
  const missingFee = resolution();
  delete missingFee.cost_preset.fee_source;
  assert.throws(
    () => buildChartStrategyRunBody({ frozen, revision, resolution: missingFee }),
    /fee_source/,
  );
  const error = new BacktestApiError(
    "PROVIDER_PROTOCOL_VIOLATION",
    'compile failed: [{"line":8,"column":19,"message":"unknown target"}]',
    { next_step: "fix source" },
    409,
  );
  const diagnostics = chartStrategyRunDiagnostics(error);
  assert.equal(diagnostics.action, "fix-strategy");
  assert.deepEqual(diagnostics.sourceDiagnostics[0], {
    line: 8,
    column: 19,
    message: "unknown target",
  });
});

test("backend Run capacity is actionable and never hidden behind generic retry", () => {
  const diagnostics = chartStrategyRunDiagnostics(new BacktestApiError(
    "RUN_CAPACITY_EXCEEDED",
    "backtest Run capacity is temporarily exhausted",
    { retryable: true, retry_after_ms: 1000 },
    429,
  ));
  assert.equal(diagnostics.action, "wait-and-retry");
  assert.equal(diagnostics.details.retryable, true);
  assert.equal(diagnostics.details.retry_after_ms, 1000);
});
