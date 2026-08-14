import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { defaultBacktestApi } from "./backtestApi.js";
import type {
  BacktestCapabilities,
  BacktestDataset,
  BacktestSnapshot,
} from "./backtestApi.js";
import BacktestResultChart, { EquityCurve } from "./BacktestResultChart.js";
import { isBacktestEntryEnabled } from "./backtestFlags.js";
import type {
  BacktestReport,
  BacktestChartData,
  BacktestRunRecord,
  BacktestStudyComparison,
  BacktestStudyRecord,
} from "./backtestTypes.js";

const TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const SMA_REVISION = "builtin-sma-cross-v1";
const RSI_REVISION = "builtin-rsi-reversion-v1";
const RSI_WILDER_LONG_SHORT_REVISION = "builtin-rsi-wilder-long-short-v1";
const EXPRESSION_REVISION = "builtin-expression-model-v1";
const COMMAND_REVISION = "builtin-order-command-v1";
const DUAL_CLOCK_MODE = "AGG_TRADE_EXECUTION";
const HISTORICAL_CONTRACT_MODE = "HISTORICAL_CONTRACT_V1";
const ACCOUNT_V2 = "LINEAR_PERP_ONE_WAY_V2";
const HOST_POLICY_REVISION = "HOST_SIZING_RISK_V1";
const EXECUTION_REALISM_V2 = "EXECUTION_REALISM_V2";
const BAR_PATH_SCENARIO = "OHLC_WORST_CASE_STOP_FIRST_V1";
const METRICS_V2 = "BACKTEST_METRICS_V2";
const DEFAULT_COMMAND_SOURCE = `{
  "commands": [
    { "sequence": 5, "action": "OPEN_LONG", "qty": "1", "type": "MARKET" },
    { "sequence": 20, "action": "CLOSE_LONG", "qty": "1", "type": "MARKET" }
  ]
}`;

function timestampLabel(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Date(value).toLocaleString();
}

function hashLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 24 ? `${value.slice(0, 18)}…${value.slice(-6)}` : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function metricLabel(metric: { value: string | null; reason: string | null } | undefined): string {
  if (!metric) return "—";
  return metric.value ?? `— (${metric.reason ?? "NOT_APPLICABLE"})`;
}

export default function BacktestApp() {
  const enabled = useMemo(() => isBacktestEntryEnabled(), []);
  const [datasets, setDatasets] = useState<BacktestDataset[]>([]);
  const [capabilities, setCapabilities] = useState<BacktestCapabilities | null>(null);
  const [runs, setRuns] = useState<BacktestRunRecord[]>([]);
  const [studies, setStudies] = useState<BacktestStudyRecord[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [startTimeMs, setStartTimeMs] = useState(0);
  const [endTimeMs, setEndTimeMs] = useState(0);
  const [fast, setFast] = useState(3);
  const [slow, setSlow] = useState(5);
  const [rsiLength, setRsiLength] = useState(14);
  const [rsiOversold, setRsiOversold] = useState(30);
  const [rsiOverbought, setRsiOverbought] = useState(70);
  const [schemaParameters, setSchemaParameters] = useState<Record<string, string | number | boolean>>({});
  const [strategyRevisionId, setStrategyRevisionId] = useState(SMA_REVISION);
  const [strategySource, setStrategySource] = useState("close - open");
  const [commandSource, setCommandSource] = useState(DEFAULT_COMMAND_SOURCE);
  const [fidelityMode, setFidelityMode] = useState("BAR_APPROX");
  const [exchange, setExchange] = useState("binance");
  const [marketType, setMarketType] = useState("usdm");
  const [initialBalance, setInitialBalance] = useState("10000");
  const [slippageBps, setSlippageBps] = useState("1");
  const [takerFeeBps, setTakerFeeBps] = useState("0");
  const [makerFeeBps, setMakerFeeBps] = useState("0");
  const [fundingRate, setFundingRate] = useState("0");
  const [fundingIntervalHours, setFundingIntervalHours] = useState(8);
  const [historicalContractData, setHistoricalContractData] = useState(false);
  const [accountModel, setAccountModel] = useState("LINEAR_PERP_ONE_WAY_V1");
  const [fundingMode, setFundingMode] = useState("OFF");
  const [leverage, setLeverage] = useState("1");
  const [sizingPolicy, setSizingPolicy] = useState("FIXED_QTY_V1");
  const [fixedQty, setFixedQty] = useState("1");
  const [fixedNotional, setFixedNotional] = useState("1000");
  const [equityPercent, setEquityPercent] = useState("10");
  const [riskPerStopPercent, setRiskPerStopPercent] = useState("1");
  const [stopDistance, setStopDistance] = useState("500");
  const [maxAbsPositionQty, setMaxAbsPositionQty] = useState("100");
  const [maxNotional, setMaxNotional] = useState("1000000");
  const [maxLeverage, setMaxLeverage] = useState("20");
  const [maxOrderRisk, setMaxOrderRisk] = useState("10000");
  const [maxActiveOrders, setMaxActiveOrders] = useState(20);
  const [maxCumulativeFees, setMaxCumulativeFees] = useState("10000");
  const [maxDrawdownPercent, setMaxDrawdownPercent] = useState("50");
  const [dailyLossLimit, setDailyLossLimit] = useState("");
  const [cooldownEvents, setCooldownEvents] = useState(0);
  const [executionRealismV2, setExecutionRealismV2] = useState(false);
  const [participationRate, setParticipationRate] = useState("0.1");
  const [latencyMs, setLatencyMs] = useState(0);
  const [latencyEvents, setLatencyEvents] = useState(0);
  const [orderEndPolicy, setOrderEndPolicy] = useState("CANCEL_AT_END");
  const [metricsV2, setMetricsV2] = useState(false);
  const [riskFreeRateAnnual, setRiskFreeRateAnnual] = useState("0");
  const [sampleRole, setSampleRole] = useState("IN_SAMPLE");
  const [tradeSideFilter, setTradeSideFilter] = useState("ALL");
  const [tradeOutcomeFilter, setTradeOutcomeFilter] = useState("ALL");
  const [tradeReasonFilter, setTradeReasonFilter] = useState("");
  const [tradeFromDate, setTradeFromDate] = useState("");
  const [tradeToDate, setTradeToDate] = useState("");
  const [focusedTradeId, setFocusedTradeId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<BacktestSnapshot | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [report, setReport] = useState<BacktestReport | null>(null);
  const [chart, setChart] = useState<BacktestChartData | null>(null);
  const [selectedStudyId, setSelectedStudyId] = useState<string | null>(null);
  const [studyComparison, setStudyComparison] = useState<BacktestStudyComparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedDataset = useMemo(
    () => datasets.find((dataset) => dataset.dataset_id === datasetId) ?? null,
    [datasetId, datasets],
  );
  const selectedRun = useMemo(
    () => runs.find((run) => run.run_id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );
  const selectedStrategy = useMemo(
    () => capabilities?.strategies.find((item) => item.revision_id === strategyRevisionId) ?? null,
    [capabilities, strategyRevisionId],
  );
  const hasActiveRun = useMemo(
    () => runs.some((run) => !TERMINAL_STATES.has(run.state)),
    [runs],
  );
  const selectedStudy = useMemo(
    () => studies.find((study) => study.study_id === selectedStudyId) ?? null,
    [selectedStudyId, studies],
  );
  const hasActiveStudy = useMemo(
    () => studies.some((study) => !TERMINAL_STATES.has(study.state)),
    [studies],
  );
  const contractData = snapshot?.quality.contract_data as {
    status?: string;
    required_roles?: string[];
    role_status?: Record<string, { status?: string; row_count?: number }>;
  } | undefined;
  const contractModeEnabled = historicalContractData || accountModel === ACCOUNT_V2;
  const historicalContractComplete = !contractModeEnabled
    || contractData?.status === "complete";
  const filteredTrades = useMemo(() => (report?.trades ?? []).filter((trade) => {
    const pnl = Number(trade.net_pnl);
    const entry = Number(trade.entry_time_ms);
    const from = tradeFromDate ? new Date(`${tradeFromDate}T00:00:00Z`).getTime() : null;
    const to = tradeToDate ? new Date(`${tradeToDate}T23:59:59.999Z`).getTime() : null;
    return (tradeSideFilter === "ALL" || trade.side === tradeSideFilter)
      && (tradeOutcomeFilter === "ALL" || (tradeOutcomeFilter === "WIN" ? pnl > 0 : pnl < 0))
      && (!tradeReasonFilter || `${trade.entry_reason ?? ""} ${trade.exit_reason ?? ""}`.toLowerCase().includes(tradeReasonFilter.toLowerCase()))
      && (from === null || entry >= from)
      && (to === null || entry <= to);
  }), [report, tradeFromDate, tradeOutcomeFilter, tradeReasonFilter, tradeSideFilter, tradeToDate]);
  const focusedTrade = useMemo(
    () => (report?.trades ?? []).find((trade) => trade.trade_id === focusedTradeId) ?? null,
    [focusedTradeId, report],
  );

  useEffect(() => {
    if (strategyRevisionId !== RSI_WILDER_LONG_SHORT_REVISION || !selectedStrategy) return;
    setSchemaParameters(Object.fromEntries(selectedStrategy.parameter_schema.map((field) => [
      String(field.name),
      field.default as string | number | boolean,
    ])));
  }, [selectedStrategy, strategyRevisionId]);

  const refreshRuns = useCallback(async (signal?: AbortSignal) => {
    const next = await defaultBacktestApi.listRuns(signal);
    setRuns(next);
    setSelectedRunId((current) => current ?? next[0]?.run_id ?? null);
  }, []);

  const refreshWorkspace = useCallback(async (signal?: AbortSignal) => {
    const [nextRuns, nextStudies] = await Promise.all([
      defaultBacktestApi.listRuns(signal),
      defaultBacktestApi.listStudies(signal),
    ]);
    setRuns(nextRuns);
    setStudies(nextStudies);
    setSelectedRunId((current) => current ?? nextRuns[0]?.run_id ?? null);
    setSelectedStudyId((current) => current ?? nextStudies[0]?.study_id ?? null);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      defaultBacktestApi.capabilities(controller.signal),
      defaultBacktestApi.listDatasets(controller.signal),
      defaultBacktestApi.listRuns(controller.signal),
      defaultBacktestApi.listStudies(controller.signal),
    ]).then(([nextCapabilities, nextDatasets, nextRuns, nextStudies]) => {
      setCapabilities(nextCapabilities);
      setDatasets(nextDatasets);
      setRuns(nextRuns);
      setStudies(nextStudies);
      const first = nextDatasets[0];
      if (first) {
        setDatasetId(first.dataset_id);
        setStartTimeMs(first.first_open_ms ?? 0);
        setEndTimeMs(first.last_close_ms ?? 0);
      }
      setSelectedRunId(nextRuns[0]?.run_id ?? null);
      setSelectedStudyId(nextStudies[0]?.study_id ?? null);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [enabled]);

  useEffect(() => {
    if (!enabled || (!hasActiveRun && !hasActiveStudy)) return undefined;
    const timer = window.setInterval(() => {
      void refreshWorkspace().catch((reason: unknown) => setError(errorMessage(reason)));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [enabled, hasActiveRun, hasActiveStudy, refreshWorkspace]);

  useEffect(() => {
    if (!selectedDataset || endTimeMs <= startTimeMs) {
      setSnapshot(null);
      return undefined;
    }
    const controller = new AbortController();
    setSnapshot(null);
    const timer = window.setTimeout(() => {
      void defaultBacktestApi.previewSnapshot({
        dataset_id: selectedDataset.dataset_id,
        data_epoch: selectedDataset.data_epoch,
        start_time_ms: startTimeMs,
        end_time_ms: endTimeMs,
        interval: selectedDataset.interval,
        fidelity_mode: fidelityMode,
        exchange,
        market_type: marketType,
        contract_data_mode: historicalContractData
          || accountModel === ACCOUNT_V2 ? HISTORICAL_CONTRACT_MODE : "LEGACY_FIXED_V1",
        account_model: accountModel,
        funding_mode: fundingMode,
      }, controller.signal).then(setSnapshot).catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [accountModel, endTimeMs, exchange, fidelityMode, fundingMode, historicalContractData, marketType, selectedDataset, startTimeMs]);

  useEffect(() => {
    setReport(null);
    setChart(null);
    if (!selectedRunId || selectedRun?.state !== "COMPLETED") return undefined;
    const controller = new AbortController();
    void Promise.all([
      defaultBacktestApi.getReport(selectedRunId, controller.signal),
      defaultBacktestApi.getChart(selectedRunId, controller.signal),
    ])
      .then(([nextReport, nextChart]) => {
        setReport(nextReport);
        setChart(nextChart);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      });
    return () => controller.abort();
  }, [selectedRun?.state, selectedRunId]);

  useEffect(() => {
    setStudyComparison(null);
    if (!selectedStudyId || selectedStudy?.state !== "COMPLETED") return undefined;
    const controller = new AbortController();
    void defaultBacktestApi.compareStudy(selectedStudyId, controller.signal)
      .then(setStudyComparison)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      });
    return () => controller.abort();
  }, [selectedStudy?.state, selectedStudyId]);

  const handleDatasetChange = useCallback((nextId: string) => {
    setDatasetId(nextId);
    const dataset = datasets.find((item) => item.dataset_id === nextId);
    if (dataset) {
      setStartTimeMs(dataset.first_open_ms ?? 0);
      setEndTimeMs(dataset.last_close_ms ?? 0);
    }
  }, [datasets]);

  const handleCreate = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedDataset || !snapshot) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    const body = {
      strategy_revision_id: strategyRevisionId,
      dataset_id: selectedDataset.dataset_id,
      data_epoch: snapshot.data_epoch,
      snapshot_hash: snapshot.snapshot_hash,
      fidelity_mode: fidelityMode,
      source_event_kind: fidelityMode === "BAR_APPROX" ? "BAR" : "AGG_TRADE",
      start_time_ms: startTimeMs,
      end_time_ms: endTimeMs,
      interval: selectedDataset.interval,
      signal_clock: fidelityMode === DUAL_CLOCK_MODE ? "DERIVED_BAR_CLOSE" : null,
      signal_interval: fidelityMode === DUAL_CLOCK_MODE ? selectedDataset.interval : null,
      execution_clock: fidelityMode === DUAL_CLOCK_MODE ? "NEXT_AGG_TRADE" : null,
      bar_builder: fidelityMode === DUAL_CLOCK_MODE ? "TRADE_DERIVED_COMPLETE_BUCKETS_V1" : null,
      timezone: fidelityMode === DUAL_CLOCK_MODE ? "UTC" : null,
      warmup_bars: strategyRevisionId === SMA_REVISION ? slow
        : strategyRevisionId === RSI_WILDER_LONG_SHORT_REVISION
          ? Number(schemaParameters.length ?? 24) + 1 : 0,
      parameters: strategyRevisionId === SMA_REVISION
        ? { fast, slow }
        : strategyRevisionId === RSI_REVISION
          ? { length: rsiLength, oversold: rsiOversold, overbought: rsiOverbought }
          : strategyRevisionId === RSI_WILDER_LONG_SHORT_REVISION
            ? schemaParameters
          : {},
      strategy_source: strategyRevisionId === COMMAND_REVISION ? commandSource
        : strategyRevisionId === EXPRESSION_REVISION ? strategySource : null,
      output_mode: selectedStrategy?.output_modes[0]
        ?? (strategyRevisionId === COMMAND_REVISION ? "ORDER_INTENT" : "TARGET_POSITION"),
      account_model: accountModel,
      contract_data_mode: contractModeEnabled
        ? HISTORICAL_CONTRACT_MODE : "LEGACY_FIXED_V1",
      initial_balance: initialBalance,
      slippage_bps: slippageBps,
      taker_fee_bps: takerFeeBps,
      maker_fee_bps: makerFeeBps,
      funding_rate: fundingRate,
      funding_interval_hours: fundingIntervalHours,
      funding_mode: accountModel === ACCOUNT_V2 ? fundingMode : "OFF",
      leverage,
      sizing_policy: sizingPolicy,
      fixed_qty: fixedQty,
      fixed_notional: fixedNotional,
      equity_percent: equityPercent,
      risk_per_stop_percent: riskPerStopPercent,
      stop_distance: sizingPolicy === "RISK_PER_STOP_V1" ? stopDistance : null,
      max_abs_position_qty: maxAbsPositionQty,
      max_notional: maxNotional,
      max_leverage: maxLeverage,
      max_order_risk: maxOrderRisk,
      max_active_orders: maxActiveOrders,
      max_cumulative_fees: maxCumulativeFees,
      max_drawdown_percent: maxDrawdownPercent,
      daily_loss_limit: dailyLossLimit || null,
      cooldown_events: cooldownEvents,
      execution_model_revision: executionRealismV2 ? EXECUTION_REALISM_V2 : null,
      participation_rate: executionRealismV2 ? participationRate : null,
      latency_ms: executionRealismV2 && fidelityMode !== "BAR_APPROX" ? latencyMs : 0,
      latency_events: executionRealismV2 && fidelityMode !== "BAR_APPROX" ? latencyEvents : 0,
      order_end_policy: executionRealismV2 ? orderEndPolicy : "CANCEL_AT_END",
      bar_path_scenario: executionRealismV2 && fidelityMode === "BAR_APPROX"
        ? BAR_PATH_SCENARIO : null,
      metrics_version: metricsV2 ? METRICS_V2 : null,
      risk_free_rate_annual: metricsV2 ? riskFreeRateAnnual : "0",
      sample_role: metricsV2 ? sampleRole : "IN_SAMPLE",
      exchange,
      market_type: marketType,
      gap_policy: "REJECT",
    };
    try {
      await defaultBacktestApi.validate(body);
      const run = await defaultBacktestApi.createRun(
        body,
        globalThis.crypto?.randomUUID?.() ?? `bt-${Date.now()}`,
      );
      setSelectedRunId(run.run_id);
      setNotice(`Run ${run.run_id} 已进入后台队列；关闭页面不会取消。`);
      await refreshRuns();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [
    accountModel,
    commandSource,
    contractModeEnabled,
    cooldownEvents,
    dailyLossLimit,
    endTimeMs,
    equityPercent,
    executionRealismV2,
    exchange,
    fast,
    fidelityMode,
    fundingIntervalHours,
    fundingRate,
    fundingMode,
    fixedNotional,
    fixedQty,
    initialBalance,
    latencyEvents,
    latencyMs,
    leverage,
    maxAbsPositionQty,
    maxActiveOrders,
    maxCumulativeFees,
    maxDrawdownPercent,
    maxLeverage,
    maxNotional,
    maxOrderRisk,
    makerFeeBps,
    marketType,
    orderEndPolicy,
    participationRate,
    metricsV2,
    riskFreeRateAnnual,
    sampleRole,
    refreshRuns,
    rsiLength,
    rsiOverbought,
    rsiOversold,
    riskPerStopPercent,
    schemaParameters,
    selectedDataset,
    selectedStrategy,
    slow,
    slippageBps,
    sizingPolicy,
    snapshot,
    startTimeMs,
    strategyRevisionId,
    strategySource,
    stopDistance,
    takerFeeBps,
  ]);

  const handleCancel = useCallback(async () => {
    if (!selectedRun) return;
    setLoading(true);
    setError(null);
    try {
      await defaultBacktestApi.cancelRun(selectedRun.run_id);
      await refreshRuns();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [refreshRuns, selectedRun]);

  const handleCreateStudy = useCallback(async () => {
    if (!selectedDataset || !snapshot) return;
    const horizon = endTimeMs - startTimeMs;
    const testMs = Math.max(1, Math.floor(horizon / 4));
    const trainMs = Math.max(1, horizon - (testMs * 2));
    setLoading(true);
    setError(null);
    try {
      const created = await defaultBacktestApi.createStudy({
        name: `SMA walk-forward ${new Date().toLocaleString()}`,
        hypothesis: "SMA 参数在样本外窗口保持稳定",
        strategy_revision_id: "builtin-sma-cross-v1",
        dataset_id: selectedDataset.dataset_id,
        data_epoch: selectedDataset.data_epoch,
        interval: selectedDataset.interval,
        start_ms: startTimeMs,
        end_ms: endTimeMs,
        train_ms: trainMs,
        test_ms: testMs,
        step_ms: testMs,
        parameter_space: {
          fast: Array.from(new Set([Math.max(1, fast - 1), fast])),
          slow: Array.from(new Set([slow, slow + 2])),
        },
        parameters: {},
        sampler: "grid",
        max_trials: 4,
        warmup_bars: slow + 2,
        initial_balance: initialBalance,
        slippage_bps: slippageBps,
        taker_fee_bps: takerFeeBps,
        gap_policy: "REJECT",
      });
      await defaultBacktestApi.startStudy(created.study_id);
      setSelectedStudyId(created.study_id);
      setNotice(`Study ${created.study_id} 已交给后台调度器；关闭页面不会中断。`);
      await refreshWorkspace();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [
    endTimeMs,
    fast,
    initialBalance,
    refreshWorkspace,
    selectedDataset,
    slow,
    slippageBps,
    snapshot,
    startTimeMs,
    takerFeeBps,
  ]);

  const handleCancelStudy = useCallback(async () => {
    if (!selectedStudy) return;
    setLoading(true);
    setError(null);
    try {
      await defaultBacktestApi.cancelStudy(selectedStudy.study_id);
      await refreshWorkspace();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [refreshWorkspace, selectedStudy]);

  const handleExport = useCallback(async () => {
    if (!selectedRun) return;
    try {
      const bundle = await defaultBacktestApi.exportRun(selectedRun.run_id);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: "application/json",
      });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `${selectedRun.run_id}.backtest.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }, [selectedRun]);

  if (!enabled) {
    return (
      <main className="backtest-app backtest-disabled">
        <h1>策略回测</h1>
        <p>前端入口保持关闭。设置 VITE_BACKTEST_ENTRY_ENABLED=1，并同时启用后端回测 flags。</p>
      </main>
    );
  }

  return (
    <main className="backtest-app">
      <header className="backtest-header">
        <div>
          <span className="backtest-kicker">CANDLESCOPE RESEARCH</span>
          <h1>策略回测工作台</h1>
          <p>不可变本地数据 · 后台 Run · 可验证报告</p>
        </div>
        <div className="backtest-credibility" aria-label="credibility">
          <strong>{report?.report_label ?? fidelityMode}</strong>
          <span>{fidelityMode === "BAR_APPROX"
            ? "BAR 结果不代表 K 线内部唯一顺序，也不是实盘批准。"
            : "按本地校验成交序列撮合；不包含真实排队位置和完整盘口。"}</span>
        </div>
      </header>

      {(error || notice) && (
        <div className={error ? "backtest-message error" : "backtest-message notice"} role="status">
          <span>{error ?? notice}</span>
          <button type="button" onClick={() => { setError(null); setNotice(null); }}>关闭</button>
        </div>
      )}

      <div className="backtest-grid">
        <form className="backtest-card backtest-form" onSubmit={handleCreate}>
          <div className="backtest-section-title">
            <span>01</span><h2>新建 Run</h2>
          </div>
          <label>
            不可变数据集
            <select value={datasetId} onChange={(event) => handleDatasetChange(event.target.value)}>
              {datasets.map((dataset) => (
                <option key={dataset.dataset_id} value={dataset.dataset_id}>
                  {dataset.symbol} · {dataset.interval} · {dataset.name}
                </option>
              ))}
            </select>
          </label>
          {selectedDataset ? (
            <div className="backtest-dataset-meta">
              <span>{selectedDataset.rows.toLocaleString()} bars</span>
              <span>epoch {hashLabel(selectedDataset.data_epoch)}</span>
            </div>
          ) : <p className="backtest-empty">没有可用本地数据，请先导入 CSV。</p>}
          <div className="backtest-form-row">
            <label>
              回测粒度
              <select value={fidelityMode} onChange={(event) => setFidelityMode(event.target.value)}>
                {(capabilities?.fidelity_modes ?? ["BAR_APPROX"]).map((mode) => (
                  <option key={mode} value={mode}>{mode === "BAR_APPROX"
                    ? "按 K 线（近似）"
                    : mode === DUAL_CLOCK_MODE
                      ? "K 线信号 + 后续 aggTrade 执行"
                      : "按成交（aggTrade）"}</option>
                ))}
              </select>
            </label>
            <label>
              策略 / 指标 / 模型
              <select value={strategyRevisionId} onChange={(event) => setStrategyRevisionId(event.target.value)}>
                {(capabilities?.strategies ?? []).map((strategy) => (
                  <option key={strategy.revision_id} value={strategy.revision_id}>{strategy.label}</option>
                ))}
              </select>
            </label>
          </div>
          {selectedStrategy && <p className="backtest-strategy-help">{selectedStrategy.description}</p>}
          {fidelityMode !== "BAR_APPROX" && (
            <div className="backtest-form-row">
              <label>交易所<input value={exchange} onChange={(event) => setExchange(event.target.value)} /></label>
              <label>市场类型<input value={marketType} onChange={(event) => setMarketType(event.target.value)} /></label>
            </div>
          )}
          <label className="backtest-checkbox">
            <input
              type="checkbox"
              checked={contractModeEnabled}
              disabled={accountModel === ACCOUNT_V2}
              onChange={(event) => setHistoricalContractData(event.target.checked)}
            />
            {accountModel === ACCOUNT_V2
              ? "V2 强制使用历史 mark / rules（不会联网补取）"
              : "要求历史 mark / index / funding / rules 完整覆盖（M3）"}
          </label>
          <div className="backtest-form-row three" data-testid="account-v2-config">
            <label>账户模型<select value={accountModel} onChange={(event) => {
              setAccountModel(event.target.value);
              if (event.target.value !== ACCOUNT_V2) setFundingMode("OFF");
            }}>
              {(capabilities?.account_models ?? ["LINEAR_PERP_ONE_WAY_V1"]).map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select></label>
            <label>资金费模式<select value={fundingMode} disabled={accountModel !== ACCOUNT_V2} onChange={(event) => setFundingMode(event.target.value)}>
              {(capabilities?.funding_modes_v2 ?? ["OFF"]).map((mode) => <option key={mode} value={mode}>{mode}</option>)}
            </select></label>
            <label>杠杆<input value={leverage} disabled={accountModel !== ACCOUNT_V2} onChange={(event) => setLeverage(event.target.value)} /></label>
          </div>
          {fidelityMode === DUAL_CLOCK_MODE && selectedDataset && (
            <div className="backtest-strategy-evidence" data-testid="dual-clock-identity">
              <strong>信号周期 {selectedDataset.interval} · UTC</strong>
              <span>信号源 DERIVED_BAR_CLOSE</span>
              <span>执行源 NEXT_AGG_TRADE（聚合成交，不代表 raw trade 或队列真相）</span>
              <span>TRADE_DERIVED_COMPLETE_BUCKETS_V1 · 尾部未完结桶不可见</span>
            </div>
          )}
          <div className="backtest-form-row">
            <label>开始时间（ms）<input type="number" value={startTimeMs} onChange={(event) => setStartTimeMs(Number(event.target.value))} /></label>
            <label>结束时间（ms）<input type="number" value={endTimeMs} onChange={(event) => setEndTimeMs(Number(event.target.value))} /></label>
          </div>
          <div className="backtest-time-hint">
            {timestampLabel(startTimeMs)} → {timestampLabel(endTimeMs)}
          </div>
          {strategyRevisionId === SMA_REVISION && <div className="backtest-form-row">
            <label>Fast SMA<input type="number" min="1" value={fast} onChange={(event) => setFast(Number(event.target.value))} /></label>
            <label>Slow SMA<input type="number" min="2" value={slow} onChange={(event) => setSlow(Number(event.target.value))} /></label>
          </div>}
          {strategyRevisionId === RSI_REVISION && <div className="backtest-form-row three">
            <label>RSI 长度<input type="number" min="2" value={rsiLength} onChange={(event) => setRsiLength(Number(event.target.value))} /></label>
            <label>超卖<input type="number" value={rsiOversold} onChange={(event) => setRsiOversold(Number(event.target.value))} /></label>
            <label>超买<input type="number" value={rsiOverbought} onChange={(event) => setRsiOverbought(Number(event.target.value))} /></label>
          </div>}
          {strategyRevisionId === RSI_WILDER_LONG_SHORT_REVISION && selectedStrategy && (
            <div className="backtest-form-row three" data-testid="strategy-schema-fields">
              {selectedStrategy.parameter_schema.map((field) => {
                const name = String(field.name);
                const label = String(field.label ?? name);
                const type = String(field.type ?? "string");
                const value = schemaParameters[name] ?? (field.default as string | number | boolean);
                if (type === "enum") {
                  const options = Array.isArray(field.options) ? field.options : [];
                  return <label key={name}>{label}<select value={String(value)} onChange={(event) => setSchemaParameters((current) => ({ ...current, [name]: event.target.value }))}>
                    {options.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
                  </select></label>;
                }
                if (type === "boolean") {
                  return <label key={name} className="backtest-checkbox">
                    <input type="checkbox" checked={Boolean(value)} onChange={(event) => setSchemaParameters((current) => ({ ...current, [name]: event.target.checked }))} />
                    {label}
                  </label>;
                }
                return <label key={name}>{label}<input
                  type="number"
                  min={typeof field.minimum === "number" ? field.minimum : undefined}
                  max={typeof field.maximum === "number" ? field.maximum : undefined}
                  value={String(value)}
                  onChange={(event) => setSchemaParameters((current) => ({
                    ...current,
                    [name]: type === "integer" ? Number.parseInt(event.target.value, 10) : Number(event.target.value),
                  }))}
                /></label>;
              })}
            </div>
          )}
          {strategyRevisionId === EXPRESSION_REVISION && <label>
            OHLCV 评分表达式
            <textarea value={strategySource} onChange={(event) => setStrategySource(event.target.value)} rows={4} />
          </label>}
          {strategyRevisionId === COMMAND_REVISION && <label>
            统一订单命令 JSON
            <textarea value={commandSource} onChange={(event) => setCommandSource(event.target.value)} rows={10} spellCheck={false} />
          </label>}
          <div className="backtest-form-row three">
            <label>初始权益<input value={initialBalance} onChange={(event) => setInitialBalance(event.target.value)} /></label>
            <label>滑点 bps<input value={slippageBps} onChange={(event) => setSlippageBps(event.target.value)} /></label>
            <label>Taker 费 bps<input value={takerFeeBps} onChange={(event) => setTakerFeeBps(event.target.value)} /></label>
          </div>
          <div className="backtest-form-row three">
            <label>Maker 费 bps<input value={makerFeeBps} onChange={(event) => setMakerFeeBps(event.target.value)} /></label>
            <label>资金费率/周期<input value={fundingRate} disabled={accountModel === ACCOUNT_V2 && fundingMode !== "FIXED_SCENARIO"} onChange={(event) => setFundingRate(event.target.value)} /></label>
            <label>资金费周期（小时）<input type="number" min="1" max="168" value={fundingIntervalHours} disabled={accountModel === ACCOUNT_V2 && fundingMode !== "FIXED_SCENARIO"} onChange={(event) => setFundingIntervalHours(Number(event.target.value))} /></label>
          </div>
          <label className="backtest-checkbox" data-testid="execution-realism-toggle">
            <input type="checkbox" checked={executionRealismV2} onChange={(event) => setExecutionRealismV2(event.target.checked)} />
            启用成交真实性 V2（默认关闭，形成新的 Run 身份）
          </label>
          <div className="backtest-form-row three" data-testid="execution-realism-config">
            <label>市场成交参与率
              <input value={participationRate} disabled={!executionRealismV2} onChange={(event) => setParticipationRate(event.target.value)} />
            </label>
            <label>延迟毫秒
              <input type="number" min="0" max="60000" value={latencyMs} disabled={!executionRealismV2 || fidelityMode === "BAR_APPROX"} onChange={(event) => setLatencyMs(Number(event.target.value))} />
            </label>
            <label>延迟事件数
              <input type="number" min="0" max="100000" value={latencyEvents} disabled={!executionRealismV2 || fidelityMode === "BAR_APPROX"} onChange={(event) => setLatencyEvents(Number(event.target.value))} />
            </label>
          </div>
          <div className="backtest-form-row">
            <label>区间结束残单
              <select value={orderEndPolicy} disabled={!executionRealismV2} onChange={(event) => setOrderEndPolicy(event.target.value)}>
                <option value="CANCEL_AT_END">结束时取消</option>
                <option value="KEEP_OPEN">保留 OPEN</option>
              </select>
            </label>
            <div className="backtest-strategy-evidence">
              <strong>{fidelityMode === "BAR_APPROX" ? BAR_PATH_SCENARIO : "AGG_TRADE_LATENCY_PARTICIPATION_V2"}</strong>
              <small>{fidelityMode === "BAR_APPROX"
                ? "OHLC 最坏情形是冻结假设，不是 K 线内部历史事实。"
                : "aggTrade 是聚合成交；不声称 raw trade、盘口深度或 queue exact。"}</small>
            </div>
          </div>
          <label className="backtest-checkbox" data-testid="metrics-v2-toggle">
            <input
              type="checkbox"
              checked={metricsV2}
              onChange={(event) => {
                const checked = event.target.checked;
                setMetricsV2(checked);
                if (checked) {
                  setExecutionRealismV2(true);
                  setAccountModel(ACCOUNT_V2);
                  setHistoricalContractData(true);
                }
              }}
            />
            启用报告与绩效指标 V2（默认关闭，要求账户与成交 V2）
          </label>
          <div className="backtest-form-row" data-testid="metrics-v2-config">
            <label>年化无风险利率
              <input value={riskFreeRateAnnual} disabled={!metricsV2} onChange={(event) => setRiskFreeRateAnnual(event.target.value)} />
            </label>
            <label>样本角色
              <select value={sampleRole} disabled={!metricsV2} onChange={(event) => setSampleRole(event.target.value)}>
                <option value="IN_SAMPLE">样本内</option>
                <option value="VALIDATION">验证集</option>
                <option value="OUT_OF_SAMPLE">样本外</option>
              </select>
            </label>
          </div>
          {metricsV2 && <div className="backtest-strategy-evidence">
            <strong>{METRICS_V2} · UTC 日收盘采样 · 365 天年化</strong>
            <small>少于 30 个日收益、少于 365 天、零波动或零交易时显示 null + reason，不伪造 0 或无穷大。</small>
          </div>}
          <div className="backtest-strategy-evidence" data-testid="host-policy-config">
            <strong>{HOST_POLICY_REVISION} · Host 拥有数量与风控真相</strong>
            <small>SIGNAL 经 sizing 变为绝对目标数量；TARGET_POSITION 与 ORDER_INTENT 保留原有绝对数量语义，但同样不能绕过风控。</small>
          </div>
          <div className="backtest-form-row three">
            <label>仓位计算策略
              <select value={sizingPolicy} onChange={(event) => setSizingPolicy(event.target.value)}>
                {(capabilities?.sizing_policies ?? ["FIXED_QTY_V1", "FIXED_NOTIONAL_V1", "EQUITY_PERCENT_V1", "RISK_PER_STOP_V1"]).map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label>固定数量<input value={fixedQty} disabled={sizingPolicy !== "FIXED_QTY_V1"} onChange={(event) => setFixedQty(event.target.value)} /></label>
            <label>固定 USDT 名义<input value={fixedNotional} disabled={sizingPolicy !== "FIXED_NOTIONAL_V1"} onChange={(event) => setFixedNotional(event.target.value)} /></label>
          </div>
          <div className="backtest-form-row three">
            <label>权益百分比 %<input value={equityPercent} disabled={sizingPolicy !== "EQUITY_PERCENT_V1"} onChange={(event) => setEquityPercent(event.target.value)} /></label>
            <label>每次止损风险 %<input value={riskPerStopPercent} disabled={sizingPolicy !== "RISK_PER_STOP_V1"} onChange={(event) => setRiskPerStopPercent(event.target.value)} /></label>
            <label>止损距离（价格）<input value={stopDistance} disabled={sizingPolicy !== "RISK_PER_STOP_V1"} onChange={(event) => setStopDistance(event.target.value)} /></label>
          </div>
          <div className="backtest-form-row three">
            <label>最大绝对仓位<input value={maxAbsPositionQty} onChange={(event) => setMaxAbsPositionQty(event.target.value)} /></label>
            <label>最大名义价值<input value={maxNotional} onChange={(event) => setMaxNotional(event.target.value)} /></label>
            <label>最大杠杆<input value={maxLeverage} onChange={(event) => setMaxLeverage(event.target.value)} /></label>
          </div>
          <div className="backtest-form-row three">
            <label>单笔最大风险<input value={maxOrderRisk} onChange={(event) => setMaxOrderRisk(event.target.value)} /></label>
            <label>最大活动订单<input type="number" min="1" value={maxActiveOrders} onChange={(event) => setMaxActiveOrders(Number(event.target.value))} /></label>
            <label>最大累计手续费<input value={maxCumulativeFees} onChange={(event) => setMaxCumulativeFees(event.target.value)} /></label>
          </div>
          <div className="backtest-form-row three">
            <label>最大回撤停止开仓 %<input value={maxDrawdownPercent} onChange={(event) => setMaxDrawdownPercent(event.target.value)} /></label>
            <label>日内损失上限（可选）<input value={dailyLossLimit} placeholder="留空关闭" onChange={(event) => setDailyLossLimit(event.target.value)} /></label>
            <label>冷却事件数<input type="number" min="0" value={cooldownEvents} disabled={!dailyLossLimit} onChange={(event) => setCooldownEvents(Number(event.target.value))} /></label>
          </div>
          <div className="backtest-snapshot">
            <span className={snapshot && historicalContractComplete ? "ready" : "pending"}>
              {snapshot ? (historicalContractComplete ? "已验证" : "合约数据未完整") : "验证中"}
            </span>
            <div>
              <strong>{(snapshot?.market_row_count ?? snapshot?.row_count)?.toLocaleString() ?? "—"} {fidelityMode === "BAR_APPROX" ? "bars" : "trades"}</strong>
              <small>{hashLabel(snapshot?.snapshot_hash)}</small>
            </div>
          </div>
          {contractModeEnabled && (
            <div className="backtest-strategy-evidence" data-testid="contract-role-status">
              {(contractData?.required_roles ?? ["MARK_INDEX", "FUNDING", "INSTRUMENT_RULES"]).map((role) => (
                <span key={role}>
                  {role}: {contractData?.role_status?.[role]?.status ?? "missing"}
                  {contractData?.role_status?.[role]?.row_count !== undefined
                    ? ` · ${contractData.role_status[role].row_count} rows` : ""}
                </span>
              ))}
              <small>仅使用已导入本地包；不会联网补取。</small>
            </div>
          )}
          <button className="backtest-primary" type="submit" disabled={loading || !snapshot || !historicalContractComplete || (strategyRevisionId === SMA_REVISION && fast >= slow)}>
            {loading ? "处理中…" : "验证并启动后台 Run"}
          </button>
        </form>

        <section className="backtest-card backtest-runs">
          <div className="backtest-section-title"><span>02</span><h2>Runs</h2></div>
          <div className="backtest-run-list">
            {runs.map((run) => (
              <button
                type="button"
                key={run.run_id}
                className={run.run_id === selectedRunId ? "backtest-run active" : "backtest-run"}
                onClick={() => setSelectedRunId(run.run_id)}
              >
                <span className={`backtest-state ${run.state.toLowerCase()}`}>{run.state}</span>
                <strong>{run.run_id.slice(0, 14)}</strong>
                <small>{run.fidelity_mode} · {hashLabel(run.config_hash)}</small>
              </button>
            ))}
            {runs.length === 0 && <p className="backtest-empty">还没有 Run。</p>}
          </div>
          {selectedRun && (
            <div className="backtest-run-actions">
              {!TERMINAL_STATES.has(selectedRun.state) && (
                <button type="button" onClick={handleCancel} disabled={loading}>取消 Run</button>
              )}
              {selectedRun.state === "COMPLETED" && (
                <button type="button" onClick={handleExport}>导出验证包</button>
              )}
              {selectedRun.state === "FAILED" && <span>失败码：{selectedRun.failure_code ?? "UNKNOWN"}</span>}
            </div>
          )}
        </section>

        <section className="backtest-card backtest-report">
          <div className="backtest-section-title"><span>03</span><h2>可信度报告</h2></div>
          {report ? (
            <>
              <div className="backtest-metrics">
                <div><span>报告标签</span><strong>{report.report_label}</strong></div>
                <div><span>成交</span><strong>{report.metrics.fill_count}</strong></div>
                <div><span>完整交易</span><strong>{report.metrics.trade_count ?? 0}</strong></div>
                <div><span>最终权益</span><strong>{String(report.account?.equity ?? "—")}</strong></div>
              </div>
              {report.performance && <div data-testid="metrics-v2-report">
                <div className="backtest-strategy-evidence">
                  <strong>{report.performance.metrics_version} · {report.credibility?.level} · {report.credibility?.sample_role}</strong>
                  <span>总收益 {metricLabel(report.performance.returns.total_return)} · 超额收益 {metricLabel(report.performance.returns.excess_return)}</span>
                  <span>最大回撤 {metricLabel(report.performance.risk.max_drawdown)} · Sharpe {metricLabel(report.performance.risk.sharpe)}</span>
                  <span>Metrics hash {hashLabel(report.performance.metrics_hash)} · 对账 {report.performance.reconciliation.passed ? "PASS" : "FAIL"}</span>
                  <small>账户指标使用 mark-to-market 权益；开放仓位不计入完整交易指标。研究等级不是盈利保证。</small>
                </div>
                <h3 className="backtest-table-title">收益与风险</h3>
                <div className="backtest-metric-sections">
                  <div><span>净盈亏</span><strong>{metricLabel(report.performance.returns.net_pnl)}</strong></div>
                  <div><span>年化收益</span><strong>{metricLabel(report.performance.returns.annualized_return)}</strong></div>
                  <div><span>波动率</span><strong>{metricLabel(report.performance.risk.volatility)}</strong></div>
                  <div><span>Sortino</span><strong>{metricLabel(report.performance.risk.sortino)}</strong></div>
                  <div><span>Calmar</span><strong>{metricLabel(report.performance.risk.calmar)}</strong></div>
                  <div><span>回撤时长 ms</span><strong>{metricLabel(report.performance.risk.drawdown_duration_ms)}</strong></div>
                </div>
                <h3 className="backtest-table-title">交易与成本</h3>
                <div className="backtest-metric-sections">
                  <div><span>胜率</span><strong>{metricLabel(report.performance.trading.win_rate)}</strong></div>
                  <div><span>Profit factor</span><strong>{metricLabel(report.performance.trading.profit_factor)}</strong></div>
                  <div><span>期望</span><strong>{metricLabel(report.performance.trading.expectancy)}</strong></div>
                  <div><span>平均 MAE / MFE</span><strong>{metricLabel(report.performance.trading.average_mae)} / {metricLabel(report.performance.trading.average_mfe)}</strong></div>
                  <div><span>费用 / 资金费</span><strong>{metricLabel(report.performance.execution.fees)} / {metricLabel(report.performance.execution.funding)}</strong></div>
                  <div><span>滑点 / 换手</span><strong>{metricLabel(report.performance.execution.slippage)} / {metricLabel(report.performance.execution.turnover)}</strong></div>
                </div>
                <h3 className="backtest-table-title">数据质量与可信度</h3>
                <div className="backtest-metric-sections" data-testid="metrics-v2-quality">
                  <div><span>缺口 / 重复</span><strong>{String(report.performance.quality.gap_count ?? 0)} / {String(report.performance.quality.duplicate_count ?? 0)}</strong></div>
                  <div><span>警告 / 路径歧义</span><strong>{String(report.performance.quality.warning_count ?? 0)} / {String(report.performance.quality.ambiguity_count ?? 0)}</strong></div>
                  <div><span>拒单 / 部分成交</span><strong>{String(report.performance.execution.rejected_order_count ?? 0)} / {String(report.performance.execution.partial_order_count ?? 0)}</strong></div>
                  <div><span>未成交订单</span><strong>{String(report.performance.execution.unfilled_order_count ?? 0)}</strong></div>
                  <div><span>样本角色</span><strong>{String(report.performance.quality.sample_role ?? "—")}</strong></div>
                  <div><span>指标警告</span><strong>{(report.performance.quality.metric_warnings as string[] | undefined)?.join(", ") || "无"}</strong></div>
                </div>
                <h3 className="backtest-table-title">月度收益（报告字段）</h3>
                <div className="backtest-monthly-heatmap">
                  {report.performance.monthly_returns.map((item) => <div
                    key={item.month}
                    className={Number(item.value) >= 0 ? "positive" : "negative"}
                    title={item.reason ?? item.value ?? ""}
                  ><span>{item.month}</span><strong>{item.value ?? "—"}</strong></div>)}
                </div>
              </div>}
              {report.account_model === ACCOUNT_V2 && <div className="backtest-strategy-evidence" data-testid="account-v2-report">
                <strong>{report.account_model} · {report.funding_mode}</strong>
                <span>钱包 {String(report.account?.wallet_balance ?? "—")} · 未实现 {String(report.account?.unrealized_pnl ?? "—")} · 权益 {String(report.account?.equity ?? "—")}</span>
                <span>初始保证金 {String(report.account?.initial_margin ?? "—")} · 维持保证金 {String(report.account?.maintenance_margin ?? "—")} · 挂单冻结 {String(report.account?.frozen_order_margin ?? "—")}</span>
                <span>可用 {String(report.account?.available_balance ?? "—")} · 杠杆 {String(report.account?.leverage ?? "—")} · 档位 {JSON.stringify(report.account?.maintenance_tier ?? null)}</span>
                <span>已实现 {String(report.account?.cumulative_realized_pnl ?? "—")} · 手续费 {String(report.account?.cumulative_fees ?? "—")} · 资金费 {String(report.account?.cumulative_funding ?? "—")} / {String(report.account?.funding_event_count ?? "0")} periods</span>
                <span>强平 {String(report.account?.liquidation_state ?? "—")} · 破产 {String(report.account?.insolvency_state ?? "—")} · {report.liquidation_model}</span>
                <small>保险基金与 ADL 未建模；成交价不代替历史 mark。</small>
              </div>}
              {report.risk_policy && <div className="backtest-strategy-evidence" data-testid="host-policy-report">
                <strong>{report.risk_policy.policy_revision} · {report.risk_policy.sizing_policy}</strong>
                <span>最大实际仓位 {report.risk_policy.max_actual_abs_position ?? "—"} · 最大实际名义 {report.risk_policy.max_actual_notional ?? "—"}</span>
                <span>峰值权益 {report.risk_policy.peak_equity ?? "—"} · 风险拒单 {report.metrics.risk_rejection_count ?? 0}</span>
                <span>停止原因 {JSON.stringify(report.risk_policy.stop_reasons ?? {})}</span>
              </div>}
              {report.fidelity_mode === DUAL_CLOCK_MODE && <div className="backtest-strategy-evidence" data-testid="dual-clock-report">
                <strong>信号周期 {report.identity?.signal_interval} · {report.identity?.timezone}</strong>
                <span>{report.identity?.signal_clock} → {report.identity?.execution_clock}</span>
                <span>信号事件 {report.metrics.signal_event_count} · 执行事件 {report.metrics.execution_event_count}</span>
                <span>{report.identity?.bar_builder} · aggTrade 非 raw trade / queue exact</span>
              </div>}
              {report.identity?.execution_model_revision === EXECUTION_REALISM_V2 && <div className="backtest-strategy-evidence" data-testid="execution-realism-report">
                <strong>{report.identity.execution_model_revision} · {report.identity.fill_policy}</strong>
                <span>参与率 {String(report.execution_assumptions?.participation_rate ?? "—")} · 延迟 {String(report.execution_assumptions?.latency_ms ?? 0)} ms / {String(report.execution_assumptions?.latency_events ?? 0)} events</span>
                <span>结束策略 {report.identity.order_end_policy} · 场景 {report.identity.bar_path_scenario ?? "AGG_TRADE_PRINT_SEQUENCE"}</span>
                <span>权威事件追踪 {report.fill_trace?.authoritative_event_trace_count ?? 0}/{report.fill_trace?.fill_count ?? 0} · {report.fill_trace?.complete ? "完整" : "不完整"}</span>
                <small>OHLC 路径不是历史事实；aggTrade 不是 raw trade，且不提供 spread、depth 或 queue position 真相。</small>
              </div>}
              {(report.cost_sensitivity?.scenarios?.length ?? 0) > 0 && <>
                <h3 className="backtest-table-title">成本敏感性（稳健性检查，不参与主 Run hash）</h3>
                <div className="backtest-table-wrap" data-testid="cost-sensitivity-table">
                  <table>
                    <thead><tr><th>场景</th><th>状态</th><th>成交</th><th>费用</th><th>最终权益</th><th>残单</th></tr></thead>
                    <tbody>{report.cost_sensitivity?.scenarios?.map((scenario) => <tr key={scenario.name}>
                      <td>{scenario.name}</td><td>{scenario.status}</td>
                      <td>{String(scenario.metrics.fill_count ?? "—")}</td>
                      <td>{String(scenario.metrics.fee_total ?? "—")}</td>
                      <td>{String(scenario.metrics.ending_equity ?? "—")}</td>
                      <td>{String(scenario.metrics.open_order_count ?? "—")}</td>
                    </tr>)}</tbody>
                  </table>
                </div>
              </>}
              <div className="backtest-proof">
                <span>Report hash</span><code title={report.hashes.report ?? ""}>{report.hashes.report}</code>
              </div>
              {report.strategy && <div className="backtest-strategy-evidence" data-testid="strategy-evidence">
                <strong>{report.strategy.revision}</strong>
                <span>指标 {report.strategy.indicatorRevision}</span>
                <span>参数 {report.strategy.length} / {report.strategy.oversold} / {report.strategy.overbought}</span>
                <span>{report.strategy.triggerMode} · warmup {report.strategy.warmupRowsObserved}/{report.strategy.warmupRequirementRows}</span>
                <span>Reason {JSON.stringify(report.strategy.reasonCodes ?? {})}</span>
              </div>}
              <div className="backtest-report-columns">
                <div><h3>适合解释</h3>{report.suitable_for.map((item) => <p key={item}>✓ {item}</p>)}</div>
                <div><h3>不能解释</h3>{report.not_suitable_for.map((item) => <p key={item}>× {item}</p>)}</div>
              </div>
              <h3 className="backtest-table-title">逐笔成交</h3>
              <div className="backtest-table-wrap">
                <table>
                  <thead><tr><th>订单</th><th>时间</th><th>动作</th><th>方向</th><th>价格</th><th>数量</th><th>费用</th><th>原因</th><th>权威源事件</th></tr></thead>
                  <tbody>
                    {report.fills.map((fill, index) => (
                      <tr key={`${String(fill.order_id)}-${index}`}>
                        <td>{String(fill.order_id ?? "")}</td><td>{timestampLabel(Number(fill.event_time_ms))}</td>
                        <td>{String(fill.action ?? "")}</td>
                        <td>{String(fill.side ?? "")}</td>
                        <td>{String(fill.price ?? "")}</td><td>{String(fill.qty ?? "")}</td>
                        <td>{String(fill.fee ?? "0")}</td>
                        <td>{String(fill.reason ?? "")}</td>
                        <td title={String(fill.source_event_hash ?? "")}>{String(fill.source_event_kind ?? "—")} #{String(fill.source_sequence ?? "—")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(report.order_events?.length ?? 0) > 0 && <>
                <h3 className="backtest-table-title">订单生命周期</h3>
                <div className="backtest-table-wrap" data-testid="order-lifecycle-table">
                  <table>
                    <thead><tr><th>序号</th><th>订单</th><th>状态</th><th>事件</th><th>剩余数量</th><th>原因</th></tr></thead>
                    <tbody>{report.order_events?.map((item, index) => <tr key={`${String(item.order_id ?? "rejected")}-${index}`}>
                      <td>{String(item.ordinal ?? index + 1)}</td><td>{String(item.order_id ?? "—")}</td>
                      <td>{String(item.state ?? "")}</td><td>{String(item.sequence ?? "")}</td>
                      <td>{String(item.remaining_qty ?? "—")}</td><td>{String(item.reason ?? "")}</td>
                    </tr>)}</tbody>
                  </table>
                </div>
              </>}
              {(report.rejected_orders?.length ?? 0) > 0 && <>
                <h3 className="backtest-table-title">Host 风控 / 规则拒单</h3>
                <div className="backtest-table-wrap" data-testid="risk-rejection-table">
                  <table>
                    <thead><tr><th>时间</th><th>类别</th><th>原因</th><th>规则</th><th>输入快照</th></tr></thead>
                    <tbody>{report.rejected_orders?.map((rejection, index) => (
                      <tr key={`${String(rejection.sequence ?? "rejected")}-${index}`}>
                        <td>{timestampLabel(Number(rejection.event_time_ms))}</td>
                        <td>{String(rejection.reason ?? "")}</td>
                        <td>{String(rejection.reason_code ?? rejection.reason ?? "")}</td>
                        <td>{String(rejection.rule_revision ?? "—")}</td>
                        <td>{JSON.stringify(rejection.input_snapshot ?? rejection.intent ?? {})}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </>}
              <h3 className="backtest-table-title">每一笔完整交易（FIFO 配对）</h3>
              {report.performance && <div className="backtest-trade-filters" data-testid="trade-filters">
                <select aria-label="交易方向" value={tradeSideFilter} onChange={(event) => setTradeSideFilter(event.target.value)}>
                  <option value="ALL">全部方向</option><option value="LONG">多</option><option value="SHORT">空</option>
                </select>
                <select aria-label="交易结果" value={tradeOutcomeFilter} onChange={(event) => setTradeOutcomeFilter(event.target.value)}>
                  <option value="ALL">全部结果</option><option value="WIN">盈利</option><option value="LOSS">亏损</option>
                </select>
                <input aria-label="起始日期" type="date" value={tradeFromDate} onChange={(event) => setTradeFromDate(event.target.value)} />
                <input aria-label="结束日期" type="date" value={tradeToDate} onChange={(event) => setTradeToDate(event.target.value)} />
                <input aria-label="原因筛选" placeholder="reason" value={tradeReasonFilter} onChange={(event) => setTradeReasonFilter(event.target.value)} />
              </div>}
              <div className="backtest-table-wrap">
                <table>
                  <thead><tr><th>交易</th><th>方向</th><th>开仓时间</th><th>平仓时间</th><th>开仓价</th><th>平仓价</th><th>MAE</th><th>MFE</th><th>原因</th><th>净盈亏</th></tr></thead>
                  <tbody>{(report.performance ? filteredTrades : report.trades ?? []).map((trade) => (
                    <tr key={trade.trade_id} className={trade.trade_id === focusedTradeId ? "selected" : ""} onClick={() => setFocusedTradeId(trade.trade_id ?? null)}>
                      <td>{trade.trade_id}</td><td>{trade.side}</td>
                      <td>{timestampLabel(Number(trade.entry_time_ms))}</td><td>{timestampLabel(Number(trade.exit_time_ms))}</td>
                      <td>{trade.entry_price}</td><td>{trade.exit_price}</td><td>{trade.mae || "—"}</td><td>{trade.mfe || "—"}</td>
                      <td>{trade.entry_reason || "—"} → {trade.exit_reason || "—"}</td><td>{trade.net_pnl}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              {focusedTrade && <div className="backtest-strategy-evidence" data-testid="focused-trade">
                <strong>{focusedTrade.trade_id} 已定位到入场 K 线</strong>
                <span>入场 {focusedTrade.entry_price} · MAE {focusedTrade.mae || "—"} · MFE {focusedTrade.mfe || "—"} · 退出 {focusedTrade.exit_price}</span>
              </div>}
            </>
          ) : (
            <p className="backtest-empty">
              {selectedRun?.state === "COMPLETED" ? "正在加载报告…" : "选择一个已完成 Run 查看报告。"}
            </p>
          )}
        </section>

        <section className="backtest-card backtest-visuals">
          <div className="backtest-section-title"><span>04</span><h2>K 线开平仓与账户资金曲线</h2></div>
          {chart ? (
            <>
              <BacktestResultChart chart={chart} focusTimeMs={focusedTrade ? Number(focusedTrade.entry_time_ms) : null} />
              <h3 className="backtest-table-title">账户权益</h3>
              <EquityCurve data={report?.performance?.equity_daily ?? chart.equity_curve} drawdown={report?.performance?.drawdown_daily} />
            </>
          ) : <p className="backtest-empty">选择一个已完成 Run 查看开平仓标记和资金曲线。</p>}
        </section>

        <section className="backtest-card backtest-studies">
          <div className="backtest-section-title"><span>05</span><h2>Walk-forward Studies</h2></div>
          <div className="backtest-study-toolbar">
            <p>Study 由后台调度器持久化拆分、排队和级联取消；排名只使用 OOS trial。</p>
            <button type="button" onClick={handleCreateStudy} disabled={loading || !snapshot || fidelityMode !== "BAR_APPROX" || strategyRevisionId !== SMA_REVISION}>
              创建并启动 Study
            </button>
          </div>
          <div className="backtest-study-grid">
            <div className="backtest-run-list">
              {studies.map((study) => (
                <button
                  type="button"
                  key={study.study_id}
                  className={study.study_id === selectedStudyId ? "backtest-run active" : "backtest-run"}
                  onClick={() => setSelectedStudyId(study.study_id)}
                >
                  <span className={`backtest-state ${study.state.toLowerCase()}`}>{study.state}</span>
                  <strong>{study.name}</strong>
                  <small>{study.trials.length} trials · {hashLabel(study.config_hash)}</small>
                </button>
              ))}
              {studies.length === 0 && <p className="backtest-empty">还没有 Study。</p>}
            </div>
            <div className="backtest-study-detail">
              {selectedStudy ? (
                <>
                  <div className="backtest-run-actions">
                    {!TERMINAL_STATES.has(selectedStudy.state) && (
                      <button type="button" onClick={handleCancelStudy} disabled={loading}>取消 Study 和子 Runs</button>
                    )}
                    <span>{selectedStudy.trials.filter((trial) => TERMINAL_STATES.has(trial.state)).length}/{selectedStudy.trials.length} terminal</span>
                  </div>
                  {studyComparison?.ready ? (
                    <div className="backtest-table-wrap">
                      <table>
                        <thead><tr><th>排名</th><th>Split</th><th>参数</th><th>OOS 权益</th></tr></thead>
                        <tbody>{studyComparison.ranking.map((trial, index) => (
                          <tr key={`${trial.ordinal}-${trial.split_id}`}>
                            <td>{index + 1}</td><td>{trial.split_id}</td>
                            <td>{JSON.stringify(trial.params)}</td><td>{String(trial.oos_score ?? "—")}</td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                  ) : <p className="backtest-empty">完成后显示同口径 OOS 排名。</p>}
                </>
              ) : <p className="backtest-empty">选择一个 Study 查看进度。</p>}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
