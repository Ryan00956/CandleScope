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
const STUDY_V2 = "BACKTEST_WALK_FORWARD_V2";
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

function boundedRows<T>(rows: readonly T[], limit = 1_000): readonly T[] {
  return rows.length <= limit ? rows : rows.slice(-limit);
}

function RsiTracePane({ items }: { items: Array<{ payload: Record<string, unknown> }> }) {
  const values = items.map((item) => Number(item.payload.rsi)).filter(Number.isFinite).slice(-500);
  if (values.length < 2) return <p className="backtest-empty">启用 debug trace 后显示 RSI pane。</p>;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 1000},${100 - value}`).join(" ");
  return <div className="backtest-rsi-pane" data-testid="rsi-trace-pane">
    <span>RSI · 当前页最多 500 点</span>
    <svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-label="RSI 指标 pane">
      <line x1="0" x2="1000" y1="30" y2="30" /><line x1="0" x2="1000" y1="70" y2="70" />
      <polyline points={points} fill="none" stroke="#a78bfa" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  </div>;
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
  const [revisionName, setRevisionName] = useState("RSI24 研究版");
  const [revisionLanguage, setRevisionLanguage] = useState("BUILTIN_TEMPLATE");
  const [revisionSource, setRevisionSource] = useState("");
  const [smokePassed, setSmokePassed] = useState(false);
  const [signalTrace, setSignalTrace] = useState<Array<{ ordinal: number; event_time_ms: number | null; payload: Record<string, unknown> }>>([]);
  const [compareRunId, setCompareRunId] = useState("");
  const [runComparison, setRunComparison] = useState<Record<string, unknown> | null>(null);
  const [cloneParameter, setCloneParameter] = useState("length");
  const [cloneValue, setCloneValue] = useState("25");
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
  const [reviewBridge, setReviewBridge] = useState<Record<string, unknown> | null>(null);
  const [studyHypothesis, setStudyHypothesis] = useState("RSI24 超卖做多、超买做空的参数邻域能在样本外保持稳定");
  const [studyParameterSpace, setStudyParameterSpace] = useState('{"length":[20,24],"oversold":["25","30"],"overbought":["70"]}');
  const [studyTrainDays, setStudyTrainDays] = useState(110);
  const [studyTestDays, setStudyTestDays] = useState(20);
  const [studyStepDays, setStudyStepDays] = useState(20);
  const [studyPurgeDays, setStudyPurgeDays] = useState(1);
  const [studyEmbargoDays, setStudyEmbargoDays] = useState(1);
  const [studyHoldoutDays, setStudyHoldoutDays] = useState(0);
  const [studyCandidateBudget, setStudyCandidateBudget] = useState(4);
  const [studySeed, setStudySeed] = useState(24);
  const [studyObjective, setStudyObjective] = useState("NET_RETURN");
  const [studyMinTrades, setStudyMinTrades] = useState(1);
  const [studyMaxDrawdown, setStudyMaxDrawdown] = useState("0.5");
  const [studyCostGuard, setStudyCostGuard] = useState(false);
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
    () => studies.some((study) => study.state === "RUNNING"),
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
    if (!selectedStrategy?.parameter_schema.length) return;
    setSchemaParameters(Object.fromEntries(selectedStrategy.parameter_schema.map((field) => [
      String(field.name),
      field.default as string | number | boolean,
    ])));
  }, [selectedStrategy, strategyRevisionId]);

  useEffect(() => {
    setSignalTrace([]);
    if (!selectedRunId || selectedRun?.state !== "COMPLETED") return undefined;
    const controller = new AbortController();
    void defaultBacktestApi.getSignalTrace(selectedRunId, 0, 500, controller.signal)
      .then((page) => setSignalTrace(page.items))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted && !errorMessage(reason).includes("unknown")) setError(errorMessage(reason));
      });
    return () => controller.abort();
  }, [selectedRun?.state, selectedRunId]);

  const handleCreateRevision = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const revision = await defaultBacktestApi.createStrategyRevision({
        name: revisionName, language: revisionLanguage,
        base_revision_id: revisionLanguage === "BUILTIN_TEMPLATE" ? RSI_WILDER_LONG_SHORT_REVISION : null,
        source_text: revisionSource,
        parameter_schema: revisionLanguage === "BUILTIN_TEMPLATE" ? [
          { name: "length", label: "RSI 长度", type: "integer", default: 24, minimum: 2 },
          { name: "oversold", label: "超卖", type: "number", default: 30 },
          { name: "overbought", label: "超买", type: "number", default: 70 },
          { name: "trigger_mode", label: "触发", type: "enum", default: "LEVEL_TARGET_V1", options: ["LEVEL_TARGET_V1"] },
          { name: "debug_trace", label: "保存分页信号 trace", type: "boolean", default: true },
        ] : [],
      });
      const next = await defaultBacktestApi.capabilities();
      setCapabilities(next); setStrategyRevisionId(revision.revision_id); setSmokePassed(false);
      setNotice(`已编译并保存 ${revision.revision_id}；源码、依赖、runtime 与 hash 已冻结。`);
    } catch (reason) { setError(errorMessage(reason)); } finally { setLoading(false); }
  }, [revisionLanguage, revisionName, revisionSource]);

  const handleSmoke = useCallback(async () => {
    if (!snapshot || !selectedDataset) return;
    setLoading(true); setError(null);
    try {
      const maxWindow = Math.min(endTimeMs, startTimeMs + 7 * 86_400_000);
      await defaultBacktestApi.smokeStrategyRevision(strategyRevisionId, {
        dataset_id: selectedDataset.dataset_id, snapshot_hash: snapshot.snapshot_hash,
        start_time_ms: startTimeMs, end_time_ms: maxWindow, parameters: schemaParameters,
      });
      setSmokePassed(true); setNotice("小窗口 smoke 已通过，可以创建长 Run。");
    } catch (reason) { setError(errorMessage(reason)); } finally { setLoading(false); }
  }, [endTimeMs, schemaParameters, selectedDataset, snapshot, startTimeMs, strategyRevisionId]);

  const handleCompareRuns = useCallback(async () => {
    if (!selectedRunId || !compareRunId) return;
    setLoading(true); setError(null);
    try { setRunComparison(await defaultBacktestApi.compareRuns(selectedRunId, compareRunId)); }
    catch (reason) { setError(errorMessage(reason)); } finally { setLoading(false); }
  }, [compareRunId, selectedRunId]);

  const refreshCapabilities = useCallback(async () => setCapabilities(await defaultBacktestApi.capabilities()), []);

  const handleCopyRevision = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const copied = await defaultBacktestApi.copyStrategyRevision(strategyRevisionId, `${revisionName} 副本`);
      await refreshCapabilities(); setStrategyRevisionId(copied.revision_id); setSmokePassed(false);
      setNotice(`已复制为新的不可变 revision ${copied.revision_id}`);
    } catch (reason) { setError(errorMessage(reason)); } finally { setLoading(false); }
  }, [refreshCapabilities, revisionName, strategyRevisionId]);

  const handleArchiveRevision = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      await defaultBacktestApi.archiveStrategyRevision(strategyRevisionId);
      await refreshCapabilities(); setStrategyRevisionId(RSI_WILDER_LONG_SHORT_REVISION); setSmokePassed(false);
      setNotice("Revision 已从新建 Run 目录归档；旧 Run 与报告未改变。");
    } catch (reason) { setError(errorMessage(reason)); } finally { setLoading(false); }
  }, [refreshCapabilities, strategyRevisionId]);

  const handleCloneRun = useCallback(async () => {
    if (!selectedRunId) return;
    const parsed = Number.isFinite(Number(cloneValue)) ? Number(cloneValue) : cloneValue;
    setLoading(true); setError(null);
    try {
      const cloned = await defaultBacktestApi.cloneRun(selectedRunId, cloneParameter, parsed,
        globalThis.crypto?.randomUUID?.() ?? `clone-${Date.now()}`);
      setRuns(await defaultBacktestApi.listRuns()); setSelectedRunId(cloned.run_id);
      setNotice(`已仅修改 ${cloneParameter} 并生成新 Run ${cloned.run_id}`);
    } catch (reason) { setError(errorMessage(reason)); } finally { setLoading(false); }
  }, [cloneParameter, cloneValue, selectedRunId]);

  const handleReviewBridge = useCallback(async () => {
    if (!selectedRunId) return;
    setLoading(true); setError(null);
    try {
      const bridge = await defaultBacktestApi.createReviewBridge(selectedRunId, startTimeMs, endTimeMs);
      setReviewBridge(bridge);
      setNotice(`已创建独立盲态研究 handoff ${String(bridge.bridgeId)}；策略结果仍隐藏。`);
    } catch (reason) { setError(errorMessage(reason)); } finally { setLoading(false); }
  }, [endTimeMs, selectedRunId, startTimeMs]);

  const handleRevealReviewBridge = useCallback(async () => {
    const bridgeId = String(reviewBridge?.bridgeId ?? "");
    if (!bridgeId) return;
    setLoading(true); setError(null);
    try {
      const revealed = await defaultBacktestApi.revealReviewBridge(bridgeId);
      setReviewBridge(revealed);
      setNotice(`研究 handoff ${bridgeId} 已不可逆揭示，可只读比较人工订单与策略订单。`);
    } catch (reason) { setError(errorMessage(reason)); } finally { setLoading(false); }
  }, [reviewBridge]);

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
    if (!selectedStudyId || (!selectedStudy?.oos_report && selectedStudy?.state !== "COMPLETED")) return undefined;
    const controller = new AbortController();
    void defaultBacktestApi.compareStudy(selectedStudyId, controller.signal)
      .then(setStudyComparison)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      });
    return () => controller.abort();
  }, [selectedStudy?.oos_report, selectedStudy?.state, selectedStudyId]);

  const handleDatasetChange = useCallback((nextId: string) => {
    setDatasetId(nextId);
    setSmokePassed(false);
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
        : selectedStrategy?.parameter_schema.some((field) => String(field.name) === "length")
          ? Number(schemaParameters.length ?? 24) + 1 : 0,
      parameters: strategyRevisionId === SMA_REVISION
        ? { fast, slow }
        : strategyRevisionId === RSI_REVISION
          ? { length: rsiLength, oversold: rsiOversold, overbought: rsiOverbought }
          : selectedStrategy?.parameter_schema.length
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
      signal_trace_mode: "PAGED_V1",
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
    let parameterSpace: Record<string, unknown>;
    try {
      parameterSpace = JSON.parse(studyParameterSpace) as Record<string, unknown>;
    } catch {
      setError("RSI24 参数空间必须是合法 JSON 对象。");
      return;
    }
    const dayMs = 86_400_000;
    setLoading(true);
    setError(null);
    try {
      const created = await defaultBacktestApi.createStudy({
        name: `RSI24 Study V2 ${new Date().toLocaleString()}`,
        hypothesis: studyHypothesis,
        study_protocol_revision: STUDY_V2,
        selection_protocol_revision: "TRAIN_CONSTRAINT_OBJECTIVE_SELECT_ONCE_V2",
        strategy_revision_id: RSI_WILDER_LONG_SHORT_REVISION,
        dataset_id: selectedDataset.dataset_id,
        data_epoch: selectedDataset.data_epoch,
        dataset_snapshot_hash: snapshot.snapshot_hash,
        interval: selectedDataset.interval,
        start_ms: startTimeMs,
        end_ms: endTimeMs,
        train_ms: studyTrainDays * dayMs,
        test_ms: studyTestDays * dayMs,
        step_ms: studyStepDays * dayMs,
        purge_ms: studyPurgeDays * dayMs,
        embargo_ms: studyEmbargoDays * dayMs,
        holdout_ms: studyHoldoutDays * dayMs,
        parameter_space: parameterSpace,
        parameters: { trigger_mode: "LEVEL_TARGET_V1" },
        sampler: "grid",
        seed: studySeed,
        candidate_budget: studyCandidateBudget,
        objective: studyObjective,
        constraints: {
          min_closed_trades: studyMinTrades,
          max_drawdown: studyMaxDrawdown,
          min_data_coverage: "1",
          max_ambiguity_ratio: "0",
          max_rejected_ratio: "0",
          cost_plus_25_must_be_positive: studyCostGuard,
          warn_min_long_trades: 1,
          warn_min_short_trades: 1,
        },
        warmup_bars: 29,
        initial_balance: initialBalance,
        slippage_bps: slippageBps,
        taker_fee_bps: takerFeeBps,
        maker_fee_bps: makerFeeBps,
        account_model: ACCOUNT_V2,
        contract_data_mode: HISTORICAL_CONTRACT_MODE,
        funding_mode: "OFF",
        execution_model_revision: EXECUTION_REALISM_V2,
        participation_rate: participationRate,
        metrics_version: METRICS_V2,
        risk_free_rate_annual: riskFreeRateAnnual,
        sizing_policy: "FIXED_QTY_V1",
        fixed_qty: fixedQty,
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
    fixedQty,
    initialBalance,
    makerFeeBps,
    participationRate,
    refreshWorkspace,
    riskFreeRateAnnual,
    selectedDataset,
    slippageBps,
    snapshot,
    startTimeMs,
    studyCandidateBudget,
    studyCostGuard,
    studyEmbargoDays,
    studyHoldoutDays,
    studyHypothesis,
    studyMaxDrawdown,
    studyMinTrades,
    studyObjective,
    studyParameterSpace,
    studyPurgeDays,
    studySeed,
    studyStepDays,
    studyTestDays,
    studyTrainDays,
    takerFeeBps,
  ]);

  const handleRevealHoldout = useCallback(async () => {
    if (!selectedStudy) return;
    setLoading(true);
    setError(null);
    try {
      await defaultBacktestApi.revealStudyHoldout(selectedStudy.study_id);
      setNotice(`Study ${selectedStudy.study_id} 的 holdout 已冻结并仅揭示一次。`);
      await refreshWorkspace();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [refreshWorkspace, selectedStudy]);

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
          <details className="backtest-strategy-workspace" open data-testid="strategy-revision-workspace">
            <summary>StrategyRevision V2 · 创建 / 静态检查 / 编译 / smoke</summary>
            <div className="backtest-form-row three">
              <label>Revision 名称<input value={revisionName} onChange={(event) => setRevisionName(event.target.value)} /></label>
              <label>受限语言<select value={revisionLanguage} onChange={(event) => setRevisionLanguage(event.target.value)}>
                <option value="BUILTIN_TEMPLATE">内置 RSI24 模板</option>
                <option value="PINE_SUBSET">Pine 安全子集</option>
                <option value="PYNE_ORDER_DSL">Pyne 统一订单 DSL</option>
                <option value="EXTERNAL_ARTIFACT_REF">冻结外部模型 artifact 引用</option>
              </select></label>
              <button type="button" disabled={loading} onClick={() => void handleCreateRevision()}>静态检查、编译并保存</button>
            </div>
            {revisionLanguage !== "BUILTIN_TEMPLATE" && <label>源码（不会执行任意代码）
              <textarea rows={6} value={revisionSource} onChange={(event) => setRevisionSource(event.target.value)} />
            </label>}
            {selectedStrategy?.compiled_hash && <div className="backtest-strategy-evidence">
              <strong>{selectedStrategy.runtime_revision}</strong>
              <span>source {hashLabel(selectedStrategy.source_hash)} · artifact {hashLabel(selectedStrategy.compiled_hash)}</span>
              <span>输入 {selectedStrategy.input_modes.join(", ")} · clock {selectedStrategy.signal_clock} · 输出 {selectedStrategy.output_modes.join(", ")}</span>
              <span>明确不支持：{selectedStrategy.unsupported?.join("；")}</span>
              <div className="backtest-form-row three">
                <button type="button" disabled={loading || smokePassed} onClick={() => void handleSmoke()}>{smokePassed ? "smoke 已通过" : "运行 7 天以内 smoke"}</button>
                <button type="button" disabled={loading} onClick={() => void handleCopyRevision()}>复制 revision</button>
                <button type="button" disabled={loading} onClick={() => void handleArchiveRevision()}>归档 revision</button>
              </div>
            </div>}
          </details>
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
          {selectedStrategy && selectedStrategy.parameter_schema.length > 0 && strategyRevisionId !== SMA_REVISION && strategyRevisionId !== RSI_REVISION && (
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
          <button className="backtest-primary" type="submit" disabled={loading || !snapshot || !historicalContractComplete || Boolean(selectedStrategy?.compiled_hash && !smokePassed) || (strategyRevisionId === SMA_REVISION && fast >= slow)}>
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
              {report.fills.length > 1_000 && <p className="backtest-empty">表格仅渲染最后 1,000 行；完整记录保留在验证包中。</p>}
              <div className="backtest-table-wrap">
                <table>
                  <thead><tr><th>订单</th><th>时间</th><th>动作</th><th>方向</th><th>价格</th><th>数量</th><th>费用</th><th>原因</th><th>权威源事件</th></tr></thead>
                  <tbody>
                    {boundedRows(report.fills).map((fill, index) => (
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
                    <tbody>{boundedRows(report.order_events ?? []).map((item, index) => <tr key={`${String(item.order_id ?? "rejected")}-${index}`}>
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
                    <tbody>{boundedRows(report.rejected_orders ?? []).map((rejection, index) => (
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
                  <tbody>{boundedRows(report.performance ? filteredTrades : report.trades ?? []).map((trade) => (
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
                <span>decision {timestampLabel(Number(focusedTrade.decision_time_ms ?? focusedTrade.entry_time_ms))} → accepted {timestampLabel(Number(focusedTrade.order_accepted_time_ms ?? focusedTrade.entry_time_ms))} → fill {timestampLabel(Number(focusedTrade.entry_time_ms))}</span>
                <span>执行影响：延迟 {latencyMs} ms / {latencyEvents} events · 滑点 {slippageBps} bps · 手续费 {focusedTrade.fees ?? "—"} · 资金费 {focusedTrade.funding ?? "—"}</span>
                <small>触发输入只来自当时可见的已完结数据；BAR/aggTrade 均不代表 raw trade、真实盘口或 queue exact。</small>
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
              <RsiTracePane items={signalTrace} />
              <h3 className="backtest-table-title">账户权益</h3>
              <EquityCurve data={report?.performance?.equity_daily ?? chart.equity_curve} drawdown={report?.performance?.drawdown_daily} />
            </>
          ) : <p className="backtest-empty">选择一个已完成 Run 查看开平仓标记和资金曲线。</p>}
        </section>

        <section className="backtest-card backtest-visuals" data-testid="run-compare-workspace">
          <div className="backtest-section-title"><span>05</span><h2>Run 对比与执行精度解释</h2></div>
          <div className="backtest-form-row">
            <label>对比 Run<select value={compareRunId} onChange={(event) => setCompareRunId(event.target.value)}>
              <option value="">选择另一个已完成 Run</option>
              {runs.filter((item) => item.state === "COMPLETED" && item.run_id !== selectedRunId).map((item) => <option key={item.run_id} value={item.run_id}>{item.run_id} · {item.fidelity_mode}</option>)}
            </select></label>
            <button type="button" disabled={!compareRunId || loading} onClick={() => void handleCompareRuns()}>检查兼容并对比</button>
          </div>
          {runComparison && <div className="backtest-strategy-evidence">
            <strong>{runComparison.directComparisonAllowed ? "关键身份兼容：允许直接叠加" : "关键身份不兼容：禁止直接叠加"}</strong>
            <span>差异 {JSON.stringify(runComparison.incompatibleFields ?? [])}</span>
            <span>参数 {JSON.stringify(runComparison.parameterDiff ?? {})}</span>
            <span>交易差异 {JSON.stringify(runComparison.tradeDiff ?? {})}</span>
            <span>成本差异（手续费 / 资金费 / 滑点）{JSON.stringify(runComparison.costDiff ?? {})}</span>
            <span>净值 / 回撤曲线点：{String(((runComparison.left as Record<string, unknown> | undefined)?.equityDaily as unknown[] | undefined)?.length ?? 0)} / {String(((runComparison.left as Record<string, unknown> | undefined)?.drawdownDaily as unknown[] | undefined)?.length ?? 0)} ↔ {String(((runComparison.right as Record<string, unknown> | undefined)?.equityDaily as unknown[] | undefined)?.length ?? 0)} / {String(((runComparison.right as Record<string, unknown> | undefined)?.drawdownDaily as unknown[] | undefined)?.length ?? 0)}</span>
            <span>decision / fill：{JSON.stringify((runComparison.left as Record<string, unknown> | undefined)?.hashes ?? {})} ↔ {JSON.stringify((runComparison.right as Record<string, unknown> | undefined)?.hashes ?? {})}</span>
            <span>{String(runComparison.precisionExplanation ?? "decision/fill hash 共同说明决策与执行差异。")}</span>
          </div>}
          {selectedRun?.state === "COMPLETED" && <div className="backtest-form-row three">
            <label>Clone 单一参数<input value={cloneParameter} onChange={(event) => setCloneParameter(event.target.value)} /></label>
            <label>新值<input value={cloneValue} onChange={(event) => setCloneValue(event.target.value)} /></label>
            <button type="button" disabled={loading} onClick={() => void handleCloneRun()}>生成新不可变 Run</button>
          </div>}
          <div className="backtest-strategy-evidence">
            <strong>回放研究桥：{capabilities?.flags.BACKTEST_REPLAY_REVIEW_BRIDGE_ENABLED ? "已显式启用" : "默认关闭"}</strong>
            <span>桥只传不可变数据引用与只读投影；账户、cursor、checkpoint、UI store 永不共享。</span>
            <small>训练完成前保持盲态；揭盲后才能比较人工订单与策略订单。</small>
            {capabilities?.flags.BACKTEST_REPLAY_REVIEW_BRIDGE_ENABLED && <button type="button" disabled={!selectedRunId || loading} onClick={() => void handleReviewBridge()}>从当前窗口创建独立盲态研究 handoff</button>}
            {reviewBridge && <span>handoff {String(reviewBridge.bridgeId)} · {String(reviewBridge.state)} · 策略投影 {reviewBridge.strategyProjection ? "已揭示" : "隐藏"}</span>}
            {capabilities?.flags.BACKTEST_REPLAY_REVIEW_BRIDGE_ENABLED && reviewBridge?.state === "BLINDED" && <button type="button" disabled={loading} onClick={() => void handleRevealReviewBridge()}>完成后检查并揭示只读对比</button>}
            {reviewBridge?.state === "REVEALED" && <small>{JSON.stringify(reviewBridge.comparison ?? {})}</small>}
          </div>
        </section>

        <section className="backtest-card backtest-studies">
          <div className="backtest-section-title"><span>06</span><h2>Study V2 · Train → Select → Test</h2></div>
          <div className="backtest-strategy-evidence" data-testid="study-v2-contract">
            <strong>BACKTEST_WALK_FORWARD_V2 · RSI24 参数研究</strong>
            <span>Test 数据不会参与选择；每个 fold 只有一份 append-only selection receipt 和一次 TestRun。</span>
            <small>OOS 只拼接 TestRun；回测结果不是实盘批准。BAR 仍不代表唯一 K 线内路径。</small>
          </div>
          <div className="backtest-form-row two">
            <label>研究假设
              <input aria-label="Study hypothesis" value={studyHypothesis} onChange={(event) => setStudyHypothesis(event.target.value)} />
            </label>
            <label>RSI24 参数空间 JSON
              <input aria-label="Study parameter space" value={studyParameterSpace} onChange={(event) => setStudyParameterSpace(event.target.value)} />
            </label>
          </div>
          <div className="backtest-form-row three">
            <label>Train 天数<input aria-label="Train days" type="number" min="1" value={studyTrainDays} onChange={(event) => setStudyTrainDays(Number(event.target.value))} /></label>
            <label>Test 天数<input aria-label="Test days" type="number" min="1" value={studyTestDays} onChange={(event) => setStudyTestDays(Number(event.target.value))} /></label>
            <label>Step 天数<input aria-label="Step days" type="number" min="1" value={studyStepDays} onChange={(event) => setStudyStepDays(Number(event.target.value))} /></label>
          </div>
          <div className="backtest-form-row three">
            <label>Purge 天数<input aria-label="Purge days" type="number" min="0" value={studyPurgeDays} onChange={(event) => setStudyPurgeDays(Number(event.target.value))} /></label>
            <label>Embargo 天数<input aria-label="Embargo days" type="number" min="0" value={studyEmbargoDays} onChange={(event) => setStudyEmbargoDays(Number(event.target.value))} /></label>
            <label>Holdout 天数<input aria-label="Holdout days" type="number" min="0" value={studyHoldoutDays} onChange={(event) => setStudyHoldoutDays(Number(event.target.value))} /></label>
          </div>
          <div className="backtest-form-row three">
            <label>Objective<select aria-label="Study objective" value={studyObjective} onChange={(event) => setStudyObjective(event.target.value)}>
              <option value="NET_RETURN">NET_RETURN</option><option value="SHARPE">SHARPE</option><option value="CALMAR">CALMAR</option><option value="EXPECTANCY">EXPECTANCY</option>
            </select></label>
            <label>Candidate budget<input aria-label="Candidate budget" type="number" min="1" max="64" value={studyCandidateBudget} onChange={(event) => setStudyCandidateBudget(Number(event.target.value))} /></label>
            <label>Sampler seed<input aria-label="Study seed" type="number" value={studySeed} onChange={(event) => setStudySeed(Number(event.target.value))} /></label>
          </div>
          <div className="backtest-form-row three">
            <label>最小完整交易<input aria-label="Minimum closed trades" type="number" min="1" value={studyMinTrades} onChange={(event) => setStudyMinTrades(Number(event.target.value))} /></label>
            <label>最大回撤（0..1）<input aria-label="Study maximum drawdown" value={studyMaxDrawdown} onChange={(event) => setStudyMaxDrawdown(event.target.value)} /></label>
            <label className="backtest-checkbox"><input type="checkbox" checked={studyCostGuard} onChange={(event) => setStudyCostGuard(event.target.checked)} />成本 +25% 后仍为正</label>
          </div>
          <div className="backtest-study-toolbar">
            <p>先冻结 hypothesis、snapshot、fold、预算、objective、constraints 与 tie-break，再交给后台恢复型调度器。</p>
            <button type="button" onClick={handleCreateStudy} disabled={loading || !snapshot || fidelityMode !== "BAR_APPROX" || !studyHypothesis.trim()}>
              创建并启动 RSI24 Study V2
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
                  <small>{study.folds?.length ?? 0} folds · {(study.folds ?? []).reduce((count, fold) => count + fold.train_trials.length, 0) || study.trials.length} train trials · {hashLabel(study.config_hash)}</small>
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
                    {selectedStudy.state === "AWAITING_HOLDOUT" && selectedStudy.holdout?.state === "SEALED" && (
                      <button type="button" onClick={handleRevealHoldout} disabled={loading}>仅揭示一次 Holdout</button>
                    )}
                    <span>{selectedStudy.study_protocol_revision ?? "LEGACY_STUDY_V1"} · {selectedStudy.state}</span>
                  </div>
                  <div className="backtest-strategy-evidence">
                    <strong>{selectedStudy.hypothesis}</strong>
                    <span>Train/Test/Holdout 身份已冻结 · config {hashLabel(selectedStudy.config_hash)}</span>
                  </div>
                  {(selectedStudy.folds?.length ?? 0) > 0 && <div className="backtest-table-wrap" data-testid="study-v2-folds">
                    <table>
                      <thead><tr><th>Fold</th><th>Train</th><th>Test</th><th>状态</th><th>选中参数</th><th>Receipt</th><th>TestRun</th></tr></thead>
                      <tbody>{selectedStudy.folds?.map((fold) => <tr key={fold.fold_id}>
                        <td>{fold.ordinal}</td>
                        <td>{timestampLabel(fold.train_start_ms)} → {timestampLabel(fold.train_end_ms)}<small> purge {fold.purge_ms / 86_400_000}d</small></td>
                        <td>{timestampLabel(fold.test_start_ms)} → {timestampLabel(fold.test_end_ms)}<small> embargo {fold.embargo_ms / 86_400_000}d</small></td>
                        <td>{fold.state}</td>
                        <td>{JSON.stringify(fold.selection_receipt?.selected.params ?? null)}</td>
                        <td>{hashLabel(fold.selection_receipt?.hashes.receipt ?? null)}</td>
                        <td>{fold.test_run?.state ?? "—"}</td>
                      </tr>)}</tbody>
                    </table>
                  </div>}
                  {(selectedStudy.folds?.[0]?.selection_receipt?.candidates.length ?? 0) > 0 && <>
                    <h3 className="backtest-table-title">TRAIN-only 参数热图数据（不是 OOS 排名）</h3>
                    <div className="backtest-monthly-heatmap" data-testid="study-train-heatmap">
                      {selectedStudy.folds?.[0]?.selection_receipt?.candidates.map((candidate) => <div
                        key={candidate.params_hash}
                        className={candidate.evaluation.eligible ? "positive" : "negative"}
                        title={candidate.evaluation.violations.join(", ")}
                      ><span>{JSON.stringify(candidate.params)}</span><strong>{candidate.evaluation.objective_value ?? "不合格"}</strong></div>)}
                    </div>
                  </>}
                  {studyComparison?.ready && studyComparison.oos_report ? (
                    <div data-testid="study-v2-oos">
                      <div className="backtest-metrics">
                        <div><span>OOS folds</span><strong>{studyComparison.oos_report.summary.fold_count}</strong></div>
                        <div><span>OOS return</span><strong>{studyComparison.oos_report.summary.total_return}</strong></div>
                        <div><span>来源</span><strong>{studyComparison.oos_report.sourcePolicy}</strong></div>
                        <div><span>OOS hash</span><strong>{hashLabel(studyComparison.oos_report.hashes.report)}</strong></div>
                      </div>
                      <EquityCurve data={studyComparison.oos_report.equity} />
                      <div className="backtest-table-wrap"><table>
                        <thead><tr><th>Fold</th><th>选中参数</th><th>Train objective</th><th>Test objective</th><th>Gap</th><th>Regime</th><th>Benchmark</th></tr></thead>
                        <tbody>{studyComparison.oos_report.folds.map((fold) => <tr key={fold.ordinal}>
                          <td>{fold.ordinal}</td><td>{JSON.stringify(fold.selected_params)}</td><td>{fold.train_objective}</td><td>{fold.test_objective ?? "—"}</td><td>{fold.train_test_gap ?? "—"}</td><td>{fold.market_regime}</td><td>{fold.benchmark_return ?? "—"}</td>
                        </tr>)}</tbody>
                      </table></div>
                    </div>
                  ) : studyComparison?.ready ? (
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
                  ) : <p className="backtest-empty">后台完成 Train → receipt → 单次 Test 后显示只含 TestRun 的 OOS 曲线。</p>}
                </>
              ) : <p className="backtest-empty">选择一个 Study 查看进度。</p>}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
