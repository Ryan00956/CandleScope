import { useCallback, useEffect, useMemo, useState } from "react";
import { getLocale, t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import type { FormEvent } from "react";
import { defaultBacktestApi } from "./backtestApi.js";
import type {
  BacktestCapabilities,
  BacktestDataset,
  BacktestSnapshot,
} from "./backtestApi.js";
import BacktestResultChart, { EquityCurve } from "./BacktestResultChart.js";
import { isBacktestTerminalState } from "./backtestRunClient.js";
import {
  projectBacktestReportSummary,
  projectFocusedTrade,
} from "./chart-tester/chartStrategyResultProjection.js";
import {
  isBacktestEntryEnabled,
  isPythonStrategyEntryEnabled,
} from "./backtestFlags.js";
import { backtestRunIdFromSearch } from "./backtestDeepLink.js";
import PythonStudioPanel from "./PythonStudioPanel.js";
import {
  composePythonExport,
  emptyReportIsHidden,
  hostOwnsOrdersCopy,
  isPythonRevision,
  persistPythonStudioState,
  pythonStudyParameterSpace,
  restorePythonStudioState,
  type PythonStudioGate,
} from "./pythonStudio.js";
import type {
  BacktestReport,
  BacktestChartData,
  BacktestRunRecord,
  RunCompareV2,
  SignalTraceItem,
  BacktestStudyComparison,
  BacktestStudyRecord,
} from "./backtestTypes.js";

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
  return new Date(value).toLocaleString(getLocale());
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
  useLocale();
  const values = items.map((item) => Number(item.payload.rsi)).filter(Number.isFinite).slice(-500);
  if (values.length < 2) return <p className="backtest-empty">{t("backtest.rsiEmpty")}</p>;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 1000},${100 - value}`).join(" ");
  return <div className="backtest-rsi-pane" data-testid="rsi-trace-pane">
    <span>{t("backtest.rsiMax")}</span>
    <svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-label={t("backtest.rsiAria")}>
      <line x1="0" x2="1000" y1="30" y2="30" /><line x1="0" x2="1000" y1="70" y2="70" />
      <polyline points={points} fill="none" stroke="#a78bfa" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  </div>;
}

export default function BacktestApp() {
  const locale = useLocale();
  const enabled = useMemo(() => isBacktestEntryEnabled(), []);
  const pythonEnabled = useMemo(() => isPythonStrategyEntryEnabled(), []);
  const restoredStudio = useMemo(() => restorePythonStudioState(pythonEnabled), [pythonEnabled]);
  const deepLinkedRunId = useMemo(() => backtestRunIdFromSearch(
    typeof window === "undefined" ? "" : window.location.search,
  ), []);
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
  const [revisionName, setRevisionName] = useState(() => t("backtest.defaultRevision"));
  const [revisionLanguage, setRevisionLanguage] = useState("BUILTIN_TEMPLATE");
  const [revisionSource, setRevisionSource] = useState("");
  const [smokePassed, setSmokePassed] = useState(false);
  const [signalTrace, setSignalTrace] = useState<SignalTraceItem[]>([]);
  const [compareRunId, setCompareRunId] = useState("");
  const [runComparison, setRunComparison] = useState<RunCompareV2 | null>(null);
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
  const [studyHypothesis, setStudyHypothesis] = useState(() => t("backtest.defaultHypothesis"));
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
  const [pythonGate, setPythonGate] = useState<PythonStudioGate | null>(null);
  const [workspaceHydrated, setWorkspaceHydrated] = useState(false);

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
  const pythonSelected = isPythonRevision(selectedStrategy);
  const hasActiveRun = useMemo(
    () => runs.some((run) => !isBacktestTerminalState(run.state)),
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
  const reportSummary = useMemo(
    () => report === null ? null : projectBacktestReportSummary(report),
    [report],
  );
  const focusedTrade = useMemo(
    () => projectFocusedTrade(report?.trades ?? [], focusedTradeId),
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
          { name: "length", label: t("backtest.rsiLen"), type: "integer", default: 24, minimum: 2 },
          { name: "oversold", label: t("backtest.oversold"), type: "number", default: 30 },
          { name: "overbought", label: t("backtest.overbought"), type: "number", default: 70 },
          { name: "trigger_mode", label: t("backtest.trigger"), type: "enum", default: "LEVEL_TARGET_V1", options: ["LEVEL_TARGET_V1"] },
          { name: "debug_trace", label: t("backtest.debugTrace"), type: "boolean", default: true },
        ] : [],
      });
      const next = await defaultBacktestApi.capabilities();
      setCapabilities(next); setStrategyRevisionId(revision.revision_id); setSmokePassed(false);
      setNotice(t("backtest.noticeCompiled", { id: revision.revision_id }));
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
      setSmokePassed(true); setNotice(t("backtest.noticeSmoke"));
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
      const copied = await defaultBacktestApi.copyStrategyRevision(strategyRevisionId, t("backtest.copySuffix", { name: revisionName }));
      await refreshCapabilities(); setStrategyRevisionId(copied.revision_id); setSmokePassed(false);
      setNotice(t("backtest.noticeCopied", { id: copied.revision_id }));
    } catch (reason) { setError(errorMessage(reason)); } finally { setLoading(false); }
  }, [refreshCapabilities, revisionName, strategyRevisionId]);

  const handleArchiveRevision = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      await defaultBacktestApi.archiveStrategyRevision(strategyRevisionId);
      await refreshCapabilities(); setStrategyRevisionId(RSI_WILDER_LONG_SHORT_REVISION); setSmokePassed(false);
      setNotice(t("backtest.noticeArchived"));
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
      setNotice(t("backtest.noticeCloned", { param: cloneParameter, id: cloned.run_id }));
    } catch (reason) { setError(errorMessage(reason)); } finally { setLoading(false); }
  }, [cloneParameter, cloneValue, selectedRunId]);

  const handleReviewBridge = useCallback(async () => {
    if (!selectedRunId) return;
    setLoading(true); setError(null);
    try {
      const bridge = await defaultBacktestApi.createReviewBridge(selectedRunId, startTimeMs, endTimeMs);
      setReviewBridge(bridge);
      setNotice(t("backtest.noticeHandoff", { id: String(bridge.bridgeId) }));
    } catch (reason) { setError(errorMessage(reason)); } finally { setLoading(false); }
  }, [endTimeMs, selectedRunId, startTimeMs]);

  const handleRevealReviewBridge = useCallback(async () => {
    const bridgeId = String(reviewBridge?.bridgeId ?? "");
    if (!bridgeId) return;
    setLoading(true); setError(null);
    try {
      const revealed = await defaultBacktestApi.revealReviewBridge(bridgeId);
      setReviewBridge(revealed);
      setNotice(t("backtest.noticeRevealed", { id: bridgeId }));
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
      const restoredRevision = restoredStudio?.revisionId
        && nextCapabilities.strategies.some((item) => item.revision_id === restoredStudio.revisionId)
        ? restoredStudio.revisionId
        : null;
      if (restoredRevision) setStrategyRevisionId(restoredRevision);
      if (restoredStudio?.smokePassed) setSmokePassed(true);
      setSelectedRunId(
        deepLinkedRunId && nextRuns.some((item) => item.run_id === deepLinkedRunId)
          ? deepLinkedRunId
          : restoredStudio?.runId && nextRuns.some((item) => item.run_id === restoredStudio.runId)
            ? restoredStudio.runId
            : nextRuns[0]?.run_id ?? null,
      );
      setSelectedStudyId(
        restoredStudio?.studyId && nextStudies.some((item) => item.study_id === restoredStudio.studyId)
          ? restoredStudio.studyId
          : nextStudies[0]?.study_id ?? null,
      );
      setWorkspaceHydrated(true);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [deepLinkedRunId, enabled, restoredStudio]);

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
      python_runtime_mode: pythonSelected ? pythonGate?.runtimeMode ?? "SANDBOXED_LOCAL" : undefined,
      python_trusted_confirmed: pythonSelected
        ? pythonGate?.runtimeMode === "TRUSTED_LOCAL" && Boolean(pythonGate.trustedConfirmed)
        : undefined,
    };
    try {
      await defaultBacktestApi.validate(body);
      const run = await defaultBacktestApi.createRun(
        body,
        globalThis.crypto?.randomUUID?.() ?? `bt-${Date.now()}`,
      );
      setSelectedRunId(run.run_id);
      setNotice(t("backtest.noticeQueued", { id: run.run_id }));
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
    pythonSelected,
    pythonGate,
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

  const handleResume = useCallback(async () => {
    if (!selectedRun) return;
    setLoading(true);
    setError(null);
    try {
      await defaultBacktestApi.resumeRun(selectedRun.run_id);
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
      setError(t("backtest.jsonInvalid"));
      return;
    }
    const dayMs = 86_400_000;
    setLoading(true);
    setError(null);
    try {
      const created = await defaultBacktestApi.createStudy({
        name: t("backtest.rsiStudyName", { when: new Date().toLocaleString(locale) }),
        hypothesis: studyHypothesis,
        study_protocol_revision: STUDY_V2,
        selection_protocol_revision: "TRAIN_CONSTRAINT_OBJECTIVE_SELECT_ONCE_V2",
        strategy_revision_id: pythonSelected ? strategyRevisionId : RSI_WILDER_LONG_SHORT_REVISION,
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
        warmup_bars: pythonSelected
          ? Number(schemaParameters.length ?? schemaParameters.slow ?? schemaParameters.lookback ?? 20) + 1
          : 29,
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
      setNotice(t("backtest.noticeStudyQueued", { id: created.study_id }));
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
    locale,
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
    pythonSelected,
    strategyRevisionId,
    schemaParameters,
  ]);

  const handleRevealHoldout = useCallback(async () => {
    if (!selectedStudy) return;
    setLoading(true);
    setError(null);
    try {
      await defaultBacktestApi.revealStudyHoldout(selectedStudy.study_id);
      setNotice(t("backtest.noticeHoldout", { id: selectedStudy.study_id }));
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
      const payload = pythonSelected
        ? composePythonExport({
          bundleIdentity: pythonGate?.bundleIdentity ?? null,
          runExport: bundle,
        })
        : bundle;
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
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
  }, [pythonGate?.bundleIdentity, pythonSelected, selectedRun]);

  useEffect(() => {
    if (!workspaceHydrated) return;
    persistPythonStudioState(pythonEnabled, {
      revisionId: pythonSelected ? strategyRevisionId : restoredStudio?.revisionId ?? null,
      runId: selectedRunId,
      studyId: selectedStudyId,
      bundleId: pythonGate?.bundleIdentity?.bundle_id ?? restoredStudio?.bundleId ?? null,
      bundleIdentity: pythonGate?.bundleIdentity ?? restoredStudio?.bundleIdentity ?? null,
      smokePassed: pythonSelected ? smokePassed : Boolean(restoredStudio?.smokePassed),
      runtimeMode: pythonGate?.runtimeMode ?? restoredStudio?.runtimeMode ?? "SANDBOXED_LOCAL",
      trustedConfirmed: pythonGate?.trustedConfirmed ?? Boolean(restoredStudio?.trustedConfirmed),
    });
  }, [
    pythonEnabled,
    pythonGate,
    pythonSelected,
    restoredStudio,
    selectedRunId,
    selectedStudyId,
    smokePassed,
    strategyRevisionId,
    workspaceHydrated,
  ]);

  if (!enabled) {
    return (
      <main className="backtest-app backtest-disabled">
        <h1>{t("backtest.disabledTitle")}</h1>
        <p>{t("backtest.disabledHint")}</p>
      </main>
    );
  }

  return (
    <main className="backtest-app">
      <header className="backtest-header">
        <div>
          <span className="backtest-kicker">{t("backtest.researchKicker")}</span>
          <h1>{t("backtest.title")}</h1>
          <p>{t("backtest.subtitle")}</p>
        </div>
        <div className="backtest-credibility" aria-label={t("backtest.credibilityAria")}>
          <strong>{report?.report_label ?? fidelityMode}</strong>
          <span>{fidelityMode === "BAR_APPROX"
            ? t("backtest.barApprox")
            : t("backtest.aggApprox")}</span>
        </div>
      </header>

      {(error || notice) && (
        <div className={error ? "backtest-message error" : "backtest-message notice"} role="status">
          <span>{error ?? notice}</span>
          <button type="button" onClick={() => { setError(null); setNotice(null); }}>{t("backtest.close")}</button>
        </div>
      )}

      <div className="backtest-grid">
        <form className="backtest-card backtest-form" onSubmit={handleCreate}>
          <div className="backtest-section-title">
            <span>01</span><h2>{t("backtest.newRun")}</h2>
          </div>
          <label>
            {t("backtest.dataset")}
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
              <span>{t("backtest.datasetBars", { count: selectedDataset.rows.toLocaleString(locale) })}</span>
              <span>{t("backtest.datasetSource", { source: selectedDataset.source ?? "local_dataset" })}</span>
              <span>{t("backtest.datasetChecksum", { checksum: hashLabel(selectedDataset.checksum ?? selectedDataset.data_epoch) })}</span>
              <span>{t("backtest.datasetGap", {
                count: typeof selectedDataset.gap?.excluded_range_count === "number"
                  ? selectedDataset.gap.excluded_range_count
                  : 0,
              })}</span>
              <span>{t("backtest.datasetRevision", { revision: hashLabel(selectedDataset.revision ?? selectedDataset.data_epoch) })}</span>
            </div>
          ) : <p className="backtest-empty">{t("backtest.noData")}</p>}
          <div className="backtest-form-row">
            <label>
              {t("backtest.fidelity")}
              <select value={fidelityMode} onChange={(event) => setFidelityMode(event.target.value)}>
                {(capabilities?.fidelity_modes ?? ["BAR_APPROX"]).map((mode) => (
                  <option key={mode} value={mode}>{mode === "BAR_APPROX"
                    ? t("backtest.fidelityBar")
                    : mode === DUAL_CLOCK_MODE
                      ? t("backtest.fidelityDual")
                      : t("backtest.fidelityTrade")}</option>
                ))}
              </select>
            </label>
            <label>
              {t("backtest.strategy")}
              <select value={strategyRevisionId} onChange={(event) => setStrategyRevisionId(event.target.value)}>
                {(capabilities?.strategies ?? []).map((strategy) => (
                  <option key={strategy.revision_id} value={strategy.revision_id}>{strategy.label}</option>
                ))}
              </select>
            </label>
          </div>
          {selectedStrategy && <p className="backtest-strategy-help">{selectedStrategy.description}</p>}
          {pythonEnabled && (
            <PythonStudioPanel
              api={defaultBacktestApi}
              loading={loading}
              snapshot={snapshot}
              datasetId={datasetId}
              startTimeMs={startTimeMs}
              endTimeMs={endTimeMs}
              schemaParameters={schemaParameters}
              selectedRevisionId={strategyRevisionId}
              restored={restoredStudio}
              onLoading={setLoading}
              onNotice={setNotice}
              onError={setError}
              onRevisionReady={(revision) => {
                setStrategyRevisionId(revision.revision_id);
                setSmokePassed(false);
                if (revision.parameter_schema?.length) {
                  setStudyParameterSpace(pythonStudyParameterSpace(revision.parameter_schema));
                }
                void defaultBacktestApi.capabilities().then(setCapabilities);
              }}
              onGateChange={setPythonGate}
            />
          )}
          <details className="backtest-strategy-workspace" open data-testid="strategy-revision-workspace">
            <summary>{t("backtest.revisionWorkspace")}</summary>
            <div className="backtest-form-row three">
              <label>{t("backtest.revisionName")}<input value={revisionName} onChange={(event) => setRevisionName(event.target.value)} /></label>
              <label>{t("backtest.language")}<select value={revisionLanguage} onChange={(event) => setRevisionLanguage(event.target.value)}>
                <option value="BUILTIN_TEMPLATE">{t("backtest.builtin")}</option>
                <option value="PINE_SUBSET">{t("backtest.pine")}</option>
                <option value="PYNE_ORDER_DSL">{t("backtest.pyne")}</option>
                <option value="EXTERNAL_ARTIFACT_REF">{t("backtest.external")}</option>
              </select></label>
              <button type="button" disabled={loading} onClick={() => void handleCreateRevision()}>{t("backtest.compileSave")}</button>
            </div>
            {revisionLanguage !== "BUILTIN_TEMPLATE" && <label>{t("backtest.sourceNoExec")}
              <textarea rows={6} value={revisionSource} onChange={(event) => setRevisionSource(event.target.value)} />
            </label>}
            {selectedStrategy?.compiled_hash && <div className="backtest-strategy-evidence">
              <strong>{selectedStrategy.runtime_revision}</strong>
              <span>{t("backtest.sourceArtifact", { source: hashLabel(selectedStrategy.source_hash), artifact: hashLabel(selectedStrategy.compiled_hash) })}</span>
              <span>{t("backtest.inputClock", { input: selectedStrategy.input_modes.join(", "), clock: selectedStrategy.signal_clock, output: selectedStrategy.output_modes.join(", ") })}</span>
              <span>{t("backtest.unsupported", { list: selectedStrategy.unsupported?.join("；") ?? "" })}</span>
              <div className="backtest-form-row three">
                <button type="button" disabled={loading || smokePassed} onClick={() => void handleSmoke()}>{smokePassed ? t("backtest.smokeOk") : t("backtest.smokeRun")}</button>
                <button type="button" disabled={loading} onClick={() => void handleCopyRevision()}>{t("backtest.copyRev")}</button>
                <button type="button" disabled={loading} onClick={() => void handleArchiveRevision()}>{t("backtest.archiveRev")}</button>
              </div>
            </div>}
          </details>
          {fidelityMode !== "BAR_APPROX" && (
            <div className="backtest-form-row">
              <label>{t("backtest.exchange")}<input value={exchange} onChange={(event) => setExchange(event.target.value)} /></label>
              <label>{t("backtest.marketType")}<input value={marketType} onChange={(event) => setMarketType(event.target.value)} /></label>
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
              ? t("backtest.v2Mark")
              : t("backtest.m3Cover")}
          </label>
          <div className="backtest-form-row three" data-testid="account-v2-config">
            <label>{t("backtest.accountModel")}<select value={accountModel} onChange={(event) => {
              setAccountModel(event.target.value);
              if (event.target.value !== ACCOUNT_V2) setFundingMode("OFF");
            }}>
              {(capabilities?.account_models ?? ["LINEAR_PERP_ONE_WAY_V1"]).map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select></label>
            <label>{t("backtest.fundingMode")}<select value={fundingMode} disabled={accountModel !== ACCOUNT_V2} onChange={(event) => setFundingMode(event.target.value)}>
              {(capabilities?.funding_modes_v2 ?? ["OFF"]).map((mode) => <option key={mode} value={mode}>{mode}</option>)}
            </select></label>
            <label>{t("backtest.leverage")}<input value={leverage} disabled={accountModel !== ACCOUNT_V2} onChange={(event) => setLeverage(event.target.value)} /></label>
          </div>
          {fidelityMode === DUAL_CLOCK_MODE && selectedDataset && (
            <div className="backtest-strategy-evidence" data-testid="dual-clock-identity">
              <strong>{t("backtest.signalInterval", { interval: selectedDataset.interval })}</strong>
              <span>{t("backtest.signalSrc")}</span>
              <span>{t("backtest.execSrc")}</span>
              <span>{t("backtest.buckets")}</span>
            </div>
          )}
          <div className="backtest-form-row">
            <label>{t("backtest.startMs")}<input type="number" value={startTimeMs} onChange={(event) => setStartTimeMs(Number(event.target.value))} /></label>
            <label>{t("backtest.endMs")}<input type="number" value={endTimeMs} onChange={(event) => setEndTimeMs(Number(event.target.value))} /></label>
          </div>
          <div className="backtest-time-hint">
            {timestampLabel(startTimeMs)} → {timestampLabel(endTimeMs)}
          </div>
          {strategyRevisionId === SMA_REVISION && <div className="backtest-form-row">
            <label>{t("backtest.fastSma")}<input type="number" min="1" value={fast} onChange={(event) => setFast(Number(event.target.value))} /></label>
            <label>{t("backtest.slowSma")}<input type="number" min="2" value={slow} onChange={(event) => setSlow(Number(event.target.value))} /></label>
          </div>}
          {strategyRevisionId === RSI_REVISION && <div className="backtest-form-row three">
            <label>{t("backtest.rsiLen")}<input type="number" min="2" value={rsiLength} onChange={(event) => setRsiLength(Number(event.target.value))} /></label>
            <label>{t("backtest.oversold")}<input type="number" value={rsiOversold} onChange={(event) => setRsiOversold(Number(event.target.value))} /></label>
            <label>{t("backtest.overbought")}<input type="number" value={rsiOverbought} onChange={(event) => setRsiOverbought(Number(event.target.value))} /></label>
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
            {t("backtest.ohlcvExpr")}
            <textarea value={strategySource} onChange={(event) => setStrategySource(event.target.value)} rows={4} />
          </label>}
          {strategyRevisionId === COMMAND_REVISION && <label>
            {t("backtest.orderJson")}
            <textarea value={commandSource} onChange={(event) => setCommandSource(event.target.value)} rows={10} spellCheck={false} />
          </label>}
          <div className="backtest-form-row three">
            <label>{t("backtest.balance")}<input value={initialBalance} onChange={(event) => setInitialBalance(event.target.value)} /></label>
            <label>{t("backtest.slipBps")}<input value={slippageBps} onChange={(event) => setSlippageBps(event.target.value)} /></label>
            <label>{t("backtest.takerBps")}<input value={takerFeeBps} onChange={(event) => setTakerFeeBps(event.target.value)} /></label>
          </div>
          <div className="backtest-form-row three">
            <label>{t("backtest.makerBps")}<input value={makerFeeBps} onChange={(event) => setMakerFeeBps(event.target.value)} /></label>
            <label>{t("backtest.fundingRate")}<input value={fundingRate} disabled={accountModel === ACCOUNT_V2 && fundingMode !== "FIXED_SCENARIO"} onChange={(event) => setFundingRate(event.target.value)} /></label>
            <label>{t("backtest.fundingHours")}<input type="number" min="1" max="168" value={fundingIntervalHours} disabled={accountModel === ACCOUNT_V2 && fundingMode !== "FIXED_SCENARIO"} onChange={(event) => setFundingIntervalHours(Number(event.target.value))} /></label>
          </div>
          <label className="backtest-checkbox" data-testid="execution-realism-toggle">
            <input type="checkbox" checked={executionRealismV2} onChange={(event) => setExecutionRealismV2(event.target.checked)} />
            {t("backtest.execV2")}
          </label>
          <div className="backtest-form-row three" data-testid="execution-realism-config">
            <label>{t("backtest.participation")}
              <input value={participationRate} disabled={!executionRealismV2} onChange={(event) => setParticipationRate(event.target.value)} />
            </label>
            <label>{t("backtest.latencyMs")}
              <input type="number" min="0" max="60000" value={latencyMs} disabled={!executionRealismV2 || fidelityMode === "BAR_APPROX"} onChange={(event) => setLatencyMs(Number(event.target.value))} />
            </label>
            <label>{t("backtest.latencyEvents")}
              <input type="number" min="0" max="100000" value={latencyEvents} disabled={!executionRealismV2 || fidelityMode === "BAR_APPROX"} onChange={(event) => setLatencyEvents(Number(event.target.value))} />
            </label>
          </div>
          <div className="backtest-form-row">
            <label>{t("backtest.leftover")}
              <select value={orderEndPolicy} disabled={!executionRealismV2} onChange={(event) => setOrderEndPolicy(event.target.value)}>
                <option value="CANCEL_AT_END">{t("backtest.cancelEnd")}</option>
                <option value="KEEP_OPEN">{t("backtest.keepOpen")}</option>
              </select>
            </label>
            <div className="backtest-strategy-evidence">
              <strong>{fidelityMode === "BAR_APPROX" ? BAR_PATH_SCENARIO : "AGG_TRADE_LATENCY_PARTICIPATION_V2"}</strong>
              <small>{fidelityMode === "BAR_APPROX"
                ? t("backtest.ohlcWorst")
                : t("backtest.aggNotRaw")}</small>
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
            {t("backtest.metricsEnable")}
          </label>
          <div className="backtest-form-row" data-testid="metrics-v2-config">
            <label>{t("backtest.riskFree")}
              <input value={riskFreeRateAnnual} disabled={!metricsV2} onChange={(event) => setRiskFreeRateAnnual(event.target.value)} />
            </label>
            <label>{t("backtest.sampleRole")}
              <select value={sampleRole} disabled={!metricsV2} onChange={(event) => setSampleRole(event.target.value)}>
                <option value="IN_SAMPLE">{t("backtest.inSample")}</option>
                <option value="VALIDATION">{t("backtest.validation")}</option>
                <option value="OUT_OF_SAMPLE">{t("backtest.oos")}</option>
              </select>
            </label>
          </div>
          {metricsV2 && <div className="backtest-strategy-evidence">
            <strong>{t("backtest.metricsUtc", { revision: METRICS_V2 })}</strong>
            <small>{t("backtest.metricsHint")}</small>
          </div>}
          <div className="backtest-strategy-evidence" data-testid="host-policy-config">
            <strong>{t("backtest.hostPolicy", { revision: HOST_POLICY_REVISION })}</strong>
            <small>{t("backtest.hostPolicyHint")}</small>
          </div>
          <div className="backtest-form-row three">
            <label>{t("backtest.sizing")}
              <select value={sizingPolicy} onChange={(event) => setSizingPolicy(event.target.value)}>
                {(capabilities?.sizing_policies ?? ["FIXED_QTY_V1", "FIXED_NOTIONAL_V1", "EQUITY_PERCENT_V1", "RISK_PER_STOP_V1"]).map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label>{t("backtest.fixedQty")}<input value={fixedQty} disabled={sizingPolicy !== "FIXED_QTY_V1"} onChange={(event) => setFixedQty(event.target.value)} /></label>
            <label>{t("backtest.fixedNotional")}<input value={fixedNotional} disabled={sizingPolicy !== "FIXED_NOTIONAL_V1"} onChange={(event) => setFixedNotional(event.target.value)} /></label>
          </div>
          <div className="backtest-form-row three">
            <label>{t("backtest.equityPct")}<input value={equityPercent} disabled={sizingPolicy !== "EQUITY_PERCENT_V1"} onChange={(event) => setEquityPercent(event.target.value)} /></label>
            <label>{t("backtest.riskStop")}<input value={riskPerStopPercent} disabled={sizingPolicy !== "RISK_PER_STOP_V1"} onChange={(event) => setRiskPerStopPercent(event.target.value)} /></label>
            <label>{t("backtest.stopDist")}<input value={stopDistance} disabled={sizingPolicy !== "RISK_PER_STOP_V1"} onChange={(event) => setStopDistance(event.target.value)} /></label>
          </div>
          <div className="backtest-form-row three">
            <label>{t("backtest.maxAbsQty")}<input value={maxAbsPositionQty} onChange={(event) => setMaxAbsPositionQty(event.target.value)} /></label>
            <label>{t("backtest.maxNotional")}<input value={maxNotional} onChange={(event) => setMaxNotional(event.target.value)} /></label>
            <label>{t("backtest.maxLev")}<input value={maxLeverage} onChange={(event) => setMaxLeverage(event.target.value)} /></label>
          </div>
          <div className="backtest-form-row three">
            <label>{t("backtest.maxOrderRisk")}<input value={maxOrderRisk} onChange={(event) => setMaxOrderRisk(event.target.value)} /></label>
            <label>{t("backtest.maxActive")}<input type="number" min="1" value={maxActiveOrders} onChange={(event) => setMaxActiveOrders(Number(event.target.value))} /></label>
            <label>{t("backtest.maxFees")}<input value={maxCumulativeFees} onChange={(event) => setMaxCumulativeFees(event.target.value)} /></label>
          </div>
          <div className="backtest-form-row three">
            <label>{t("backtest.maxDdStop")}<input value={maxDrawdownPercent} onChange={(event) => setMaxDrawdownPercent(event.target.value)} /></label>
            <label>{t("backtest.dailyLoss")}<input value={dailyLossLimit} placeholder={t("backtest.dailyPh")} onChange={(event) => setDailyLossLimit(event.target.value)} /></label>
            <label>{t("backtest.cooldown")}<input type="number" min="0" value={cooldownEvents} disabled={!dailyLossLimit} onChange={(event) => setCooldownEvents(Number(event.target.value))} /></label>
          </div>
          <div className="backtest-snapshot">
            <span className={snapshot && historicalContractComplete ? "ready" : "pending"}>
              {snapshot ? (historicalContractComplete ? t("backtest.verified") : t("backtest.incomplete")) : t("backtest.verifying")}
            </span>
            <div>
              <strong>{fidelityMode === "BAR_APPROX"
                ? t("backtest.snapshotBars", { count: (snapshot?.market_row_count ?? snapshot?.row_count)?.toLocaleString(locale) ?? "—" })
                : t("backtest.snapshotTrades", { count: (snapshot?.market_row_count ?? snapshot?.row_count)?.toLocaleString(locale) ?? "—" })}</strong>
              <small>{hashLabel(snapshot?.snapshot_hash)}</small>
            </div>
          </div>
          {contractModeEnabled && (
            <div className="backtest-strategy-evidence" data-testid="contract-role-status">
              {(contractData?.required_roles ?? ["MARK_INDEX", "FUNDING", "INSTRUMENT_RULES"]).map((role) => (
                <span key={role}>
                  {role}: {contractData?.role_status?.[role]?.status ?? "missing"}
                  {contractData?.role_status?.[role]?.row_count !== undefined
                    ? t("backtest.roleRows", { count: contractData.role_status[role].row_count }) : ""}
                </span>
              ))}
              <small>{t("backtest.localOnly")}</small>
            </div>
          )}
          <button className="backtest-primary" type="submit" disabled={loading || !snapshot || !historicalContractComplete || Boolean(selectedStrategy?.compiled_hash && !smokePassed) || (strategyRevisionId === SMA_REVISION && fast >= slow) || (pythonSelected && pythonGate !== null && !pythonGate.canCreateRun)}>
            {loading ? t("backtest.processing") : t("backtest.submit")}
          </button>
        </form>

        <section className="backtest-card backtest-runs">
          <div className="backtest-section-title"><span>02</span><h2>{t("backtest.runsTitle")}</h2></div>
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
            {runs.length === 0 && <p className="backtest-empty">{t("backtest.noRuns")}</p>}
          </div>
          {selectedRun && (
            <div className="backtest-run-actions">
              {!isBacktestTerminalState(selectedRun.state) && (
                <button type="button" onClick={handleCancel} disabled={loading}>{t("backtest.cancelRun")}</button>
              )}
              {selectedRun.state === "COMPLETED" && (
                <button type="button" onClick={handleExport}>{t("backtest.export")}</button>
              )}
              {selectedRun.state === "FAILED" && <span>{t("backtest.failCode", { code: selectedRun.failure_code ?? "UNKNOWN" })}</span>}
              {selectedRun.state === "FAILED" && ["PROVIDER_TIMEOUT", "PROVIDER_CRASH_UNRECOVERABLE", "BACKTEST_STORAGE_TRANSIENT"].includes(selectedRun.failure_code ?? "") && (
                <button type="button" onClick={handleResume} disabled={loading}>{t("backtest.resume")}</button>
              )}
            </div>
          )}
        </section>

        <section className="backtest-card backtest-report">
          <div className="backtest-section-title"><span>03</span><h2>{t("backtest.report")}</h2></div>
          {pythonSelected && report && (
            <div className="backtest-strategy-evidence" data-testid="python-host-owns-report">
              <strong>{t("backtest.pythonHost")}</strong>
              <p>{hostOwnsOrdersCopy()}</p>
              <small>{t("backtest.aggNotQueue")}</small>
            </div>
          )}
          {report && !emptyReportIsHidden({ error, report }) ? (
            <>
              <div className="backtest-metrics">
                <div><span>{t("backtest.reportLabel")}</span><strong>{reportSummary?.reportLabel}</strong></div>
                <div><span>{t("backtest.fills")}</span><strong>{reportSummary?.fillCount}</strong></div>
                <div><span>{t("backtest.trades")}</span><strong>{reportSummary?.tradeCount}</strong></div>
                <div><span>{t("backtest.finalEquity")}</span><strong>{reportSummary?.finalEquity}</strong></div>
              </div>
              {report.performance && <div data-testid="metrics-v2-report">
                <div className="backtest-strategy-evidence">
                  <strong>{report.performance.metrics_version} · {report.credibility?.level} · {report.credibility?.sample_role}</strong>
                  <span>{t("backtest.totalRet", { value: metricLabel(report.performance.returns.total_return), excess: metricLabel(report.performance.returns.excess_return) })}</span>
                  <span>{t("backtest.maxDdSharpe", { dd: metricLabel(report.performance.risk.max_drawdown), sharpe: metricLabel(report.performance.risk.sharpe) })}</span>
                  <span>{t("backtest.metricsHash", { hash: hashLabel(report.performance.metrics_hash), recon: report.performance.reconciliation.passed ? "PASS" : "FAIL" })}</span>
                  <small>{t("backtest.perfHint")}</small>
                </div>
                <h3 className="backtest-table-title">{t("backtest.returnsRisk")}</h3>
                <div className="backtest-metric-sections">
                  <div><span>{t("backtest.netPnl")}</span><strong>{metricLabel(report.performance.returns.net_pnl)}</strong></div>
                  <div><span>{t("backtest.annRet")}</span><strong>{metricLabel(report.performance.returns.annualized_return)}</strong></div>
                  <div><span>{t("backtest.vol")}</span><strong>{metricLabel(report.performance.risk.volatility)}</strong></div>
                  <div><span>Sortino</span><strong>{metricLabel(report.performance.risk.sortino)}</strong></div>
                  <div><span>Calmar</span><strong>{metricLabel(report.performance.risk.calmar)}</strong></div>
                  <div><span>{t("backtest.ddMs")}</span><strong>{metricLabel(report.performance.risk.drawdown_duration_ms)}</strong></div>
                </div>
                <h3 className="backtest-table-title">{t("backtest.tradingCost")}</h3>
                <div className="backtest-metric-sections">
                  <div><span>{t("backtest.winRate")}</span><strong>{metricLabel(report.performance.trading.win_rate)}</strong></div>
                  <div><span>{t("backtest.profitFactor")}</span><strong>{metricLabel(report.performance.trading.profit_factor)}</strong></div>
                  <div><span>{t("backtest.expectancy")}</span><strong>{metricLabel(report.performance.trading.expectancy)}</strong></div>
                  <div><span>{t("backtest.maeMfe")}</span><strong>{metricLabel(report.performance.trading.average_mae)} / {metricLabel(report.performance.trading.average_mfe)}</strong></div>
                  <div><span>{t("backtest.feesFunding")}</span><strong>{metricLabel(report.performance.execution.fees)} / {metricLabel(report.performance.execution.funding)}</strong></div>
                  <div><span>{t("backtest.slipTurnover")}</span><strong>{metricLabel(report.performance.execution.slippage)} / {metricLabel(report.performance.execution.turnover)}</strong></div>
                </div>
                <h3 className="backtest-table-title">{t("backtest.quality")}</h3>
                <div className="backtest-metric-sections" data-testid="metrics-v2-quality">
                  <div><span>{t("backtest.gapsDups")}</span><strong>{String(report.performance.quality.gap_count ?? 0)} / {String(report.performance.quality.duplicate_count ?? 0)}</strong></div>
                  <div><span>{t("backtest.warnAmb")}</span><strong>{String(report.performance.quality.warning_count ?? 0)} / {String(report.performance.quality.ambiguity_count ?? 0)}</strong></div>
                  <div><span>{t("backtest.rejectPartial")}</span><strong>{String(report.performance.execution.rejected_order_count ?? 0)} / {String(report.performance.execution.partial_order_count ?? 0)}</strong></div>
                  <div><span>{t("backtest.unfilled")}</span><strong>{String(report.performance.execution.unfilled_order_count ?? 0)}</strong></div>
                  <div><span>{t("backtest.sampleRole")}</span><strong>{String(report.performance.quality.sample_role ?? "—")}</strong></div>
                  <div><span>{t("backtest.metricWarn")}</span><strong>{(report.performance.quality.metric_warnings as string[] | undefined)?.join(", ") || t("backtest.none")}</strong></div>
                </div>
                <h3 className="backtest-table-title">{t("backtest.monthly")}</h3>
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
                <span>{t("backtest.acctWallet", { wallet: String(report.account?.wallet_balance ?? "—"), unrealized: String(report.account?.unrealized_pnl ?? "—"), equity: String(report.account?.equity ?? "—") })}</span>
                <span>{t("backtest.acctMargin", { im: String(report.account?.initial_margin ?? "—"), mm: String(report.account?.maintenance_margin ?? "—"), frozen: String(report.account?.frozen_order_margin ?? "—") })}</span>
                <span>{t("backtest.acctAvail", { available: String(report.account?.available_balance ?? "—"), leverage: String(report.account?.leverage ?? "—"), tier: JSON.stringify(report.account?.maintenance_tier ?? null) })}</span>
                <span>{t("backtest.acctRealized", { realized: String(report.account?.cumulative_realized_pnl ?? "—"), fees: String(report.account?.cumulative_fees ?? "—"), funding: String(report.account?.cumulative_funding ?? "—"), periods: String(report.account?.funding_event_count ?? "0") })}</span>
                <span>{t("backtest.acctLiq", { liq: String(report.account?.liquidation_state ?? "—"), insolvency: String(report.account?.insolvency_state ?? "—"), model: String(report.liquidation_model ?? "—") })}</span>
                <small>{t("backtest.insAdl")}</small>
              </div>}
              {report.risk_policy && <div className="backtest-strategy-evidence" data-testid="host-policy-report">
                <strong>{report.risk_policy.policy_revision} · {report.risk_policy.sizing_policy}</strong>
                <span>{t("backtest.maxActual", { pos: String(report.risk_policy.max_actual_abs_position ?? "—"), notional: String(report.risk_policy.max_actual_notional ?? "—") })}</span>
                <span>{t("backtest.peakEq", { peak: String(report.risk_policy.peak_equity ?? "—"), rejects: report.metrics.risk_rejection_count ?? 0 })}</span>
                <span>{t("backtest.stopReason", { reasons: JSON.stringify(report.risk_policy.stop_reasons ?? {}) })}</span>
              </div>}
              {report.fidelity_mode === DUAL_CLOCK_MODE && <div className="backtest-strategy-evidence" data-testid="dual-clock-report">
                <strong>{t("backtest.signalInterval", { interval: String(report.identity?.signal_interval ?? "") })} · {report.identity?.timezone}</strong>
                <span>{report.identity?.signal_clock} → {report.identity?.execution_clock}</span>
                <span>{t("backtest.signalEvents", { signals: report.metrics.signal_event_count ?? 0, execs: report.metrics.execution_event_count ?? 0 })}</span>
                <span>{t("backtest.aggNotRawShort", { builder: String(report.identity?.bar_builder ?? "") })}</span>
              </div>}
              {report.identity?.execution_model_revision === EXECUTION_REALISM_V2 && <div className="backtest-strategy-evidence" data-testid="execution-realism-report">
                <strong>{report.identity.execution_model_revision} · {report.identity.fill_policy}</strong>
                <span>{t("backtest.participationDelay", { rate: String(report.execution_assumptions?.participation_rate ?? "—"), ms: String(report.execution_assumptions?.latency_ms ?? 0), events: String(report.execution_assumptions?.latency_events ?? 0) })}</span>
                <span>{t("backtest.endPolicy", { policy: String(report.identity.order_end_policy), scenario: String(report.identity.bar_path_scenario ?? "AGG_TRADE_PRINT_SEQUENCE") })}</span>
                <span>{t("backtest.authTrace", { done: report.fill_trace?.authoritative_event_trace_count ?? 0, total: report.fill_trace?.fill_count ?? 0, status: report.fill_trace?.complete ? t("backtest.complete") : t("backtest.incompleteTrace") })}</span>
                <small>{t("backtest.ohlcNotFact")}</small>
              </div>}
              {(report.cost_sensitivity?.scenarios?.length ?? 0) > 0 && <>
                <h3 className="backtest-table-title">{t("backtest.costSens")}</h3>
                <div className="backtest-table-wrap" data-testid="cost-sensitivity-table">
                  <table>
                    <thead><tr><th>{t("backtest.scenario")}</th><th>{t("backtest.status")}</th><th>{t("backtest.fills")}</th><th>{t("backtest.fee")}</th><th>{t("backtest.finalEquity")}</th><th>{t("backtest.leftoverTh")}</th></tr></thead>
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
                <span>{t("backtest.reportHash")}</span><code title={report.hashes.report ?? ""}>{report.hashes.report}</code>
              </div>
              {report.strategy && <div className="backtest-strategy-evidence" data-testid="strategy-evidence">
                <strong>{report.strategy.revision}</strong>
                <span>{t("backtest.indicator", { rev: report.strategy.indicatorRevision ?? "—" })}</span>
                <span>{t("backtest.params", { a: report.strategy.length ?? "—", b: report.strategy.oversold ?? "—", c: report.strategy.overbought ?? "—" })}</span>
                <span>{t("backtest.warmup", {
                  mode: report.strategy.triggerMode ?? "—",
                  observed: report.strategy.warmupRowsObserved ?? "—",
                  required: report.strategy.warmupRequirementRows ?? "—",
                })}</span>
                <span>{t("backtest.reasonCodes", { reasons: JSON.stringify(report.strategy.reasonCodes ?? {}) })}</span>
              </div>}
              <div className="backtest-report-columns">
                <div><h3>{t("backtest.suitable")}</h3>{report.suitable_for.map((item) => <p key={item}>✓ {item}</p>)}</div>
                <div><h3>{t("backtest.notSuitable")}</h3>{report.not_suitable_for.map((item) => <p key={item}>× {item}</p>)}</div>
              </div>
              <h3 className="backtest-table-title">{t("backtest.fillTable")}</h3>
              {report.fills.length > 1_000 && <p className="backtest-empty">{t("backtest.tableTrunc")}</p>}
              <div className="backtest-table-wrap">
                <table>
                  <thead><tr><th>{t("backtest.order")}</th><th>{t("backtest.time")}</th><th>{t("backtest.action")}</th><th>{t("backtest.side")}</th><th>{t("backtest.price")}</th><th>{t("backtest.qty")}</th><th>{t("backtest.fee")}</th><th>{t("backtest.reason")}</th><th>{t("backtest.authEvent")}</th></tr></thead>
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
                <h3 className="backtest-table-title">{t("backtest.lifecycle")}</h3>
                <div className="backtest-table-wrap" data-testid="order-lifecycle-table">
                  <table>
                    <thead><tr><th>{t("backtest.seq")}</th><th>{t("backtest.order")}</th><th>{t("backtest.status")}</th><th>{t("backtest.event")}</th><th>{t("backtest.remaining")}</th><th>{t("backtest.reason")}</th></tr></thead>
                    <tbody>{boundedRows(report.order_events ?? []).map((item, index) => <tr key={`${String(item.order_id ?? "rejected")}-${index}`}>
                      <td>{String(item.ordinal ?? index + 1)}</td><td>{String(item.order_id ?? "—")}</td>
                      <td>{String(item.state ?? "")}</td><td>{String(item.sequence ?? "")}</td>
                      <td>{String(item.remaining_qty ?? "—")}</td><td>{String(item.reason ?? "")}</td>
                    </tr>)}</tbody>
                  </table>
                </div>
              </>}
              {(report.rejected_orders?.length ?? 0) > 0 && <>
                <h3 className="backtest-table-title">{t("backtest.riskRejects")}</h3>
                <div className="backtest-table-wrap" data-testid="risk-rejection-table">
                  <table>
                    <thead><tr><th>{t("backtest.time")}</th><th>{t("backtest.category")}</th><th>{t("backtest.reason")}</th><th>{t("backtest.rule")}</th><th>{t("backtest.snapshot")}</th></tr></thead>
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
              <h3 className="backtest-table-title">{t("backtest.fifoTrades")}</h3>
              {report.performance && <div className="backtest-trade-filters" data-testid="trade-filters">
                <select aria-label={t("backtest.sideFilter")} value={tradeSideFilter} onChange={(event) => setTradeSideFilter(event.target.value)}>
                  <option value="ALL">{t("backtest.allSides")}</option><option value="LONG">{t("backtest.long")}</option><option value="SHORT">{t("backtest.short")}</option>
                </select>
                <select aria-label={t("backtest.outcomeFilter")} value={tradeOutcomeFilter} onChange={(event) => setTradeOutcomeFilter(event.target.value)}>
                  <option value="ALL">{t("backtest.allOutcomes")}</option><option value="WIN">{t("backtest.win")}</option><option value="LOSS">{t("backtest.loss")}</option>
                </select>
                <input aria-label={t("backtest.fromDate")} type="date" value={tradeFromDate} onChange={(event) => setTradeFromDate(event.target.value)} />
                <input aria-label={t("backtest.toDate")} type="date" value={tradeToDate} onChange={(event) => setTradeToDate(event.target.value)} />
                <input aria-label={t("backtest.reasonFilter")} placeholder={t("backtest.reason")} value={tradeReasonFilter} onChange={(event) => setTradeReasonFilter(event.target.value)} />
              </div>}
              <div className="backtest-table-wrap">
                <table>
                  <thead><tr><th>{t("backtest.trade")}</th><th>{t("backtest.side")}</th><th>{t("backtest.openTime")}</th><th>{t("backtest.closeTime")}</th><th>{t("backtest.openPx")}</th><th>{t("backtest.closePx")}</th><th>MAE</th><th>MFE</th><th>{t("backtest.reason")}</th><th>{t("backtest.netPnl")}</th></tr></thead>
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
                <strong>{t("backtest.located", { id: focusedTrade.tradeId ?? "—" })}</strong>
                <span>{t("backtest.entryExit", { entry: focusedTrade.entryPrice, mae: focusedTrade.mae, mfe: focusedTrade.mfe, exit: focusedTrade.exitPrice })}</span>
                <span>{t("backtest.decisionTrace", {
                  decision: timestampLabel(focusedTrade.decisionTimeMs),
                  accepted: timestampLabel(focusedTrade.acceptedTimeMs),
                  fill: timestampLabel(focusedTrade.fillTimeMs),
                })}</span>
                <span>{t("backtest.execImpact", { ms: latencyMs, events: latencyEvents, slip: slippageBps, fees: focusedTrade.fees, funding: focusedTrade.funding })}</span>
                <small>{t("backtest.triggerHint")}</small>
              </div>}
            </>
          ) : (
            <p className="backtest-empty">
              {error
                ? t("backtest.connFail")
                : selectedRun?.state === "COMPLETED" ? t("backtest.loadingReport") : t("backtest.pickCompleted")}
            </p>
          )}
        </section>

        <section className="backtest-card backtest-visuals">
          <div className="backtest-section-title"><span>04</span><h2>{t("backtest.chartTitle")}</h2></div>
          {chart ? (
            <>
              <BacktestResultChart chart={chart} focusTimeMs={focusedTrade?.chartFocusTimeMs ?? null} />
              <RsiTracePane items={signalTrace} />
              <h3 className="backtest-table-title">{t("backtest.equityTitle")}</h3>
              <EquityCurve data={report?.performance?.equity_daily ?? chart.equity_curve} drawdown={report?.performance?.drawdown_daily} />
            </>
          ) : <p className="backtest-empty">{t("backtest.pickChart")}</p>}
        </section>

        <section className="backtest-card backtest-visuals" data-testid="run-compare-workspace">
          <div className="backtest-section-title"><span>05</span><h2>{t("backtest.compareTitle")}</h2></div>
          <div className="backtest-form-row">
            <label>{t("backtest.compareRun")}<select value={compareRunId} onChange={(event) => setCompareRunId(event.target.value)}>
              <option value="">{t("backtest.pickOther")}</option>
              {runs.filter((item) => item.state === "COMPLETED" && item.run_id !== selectedRunId).map((item) => <option key={item.run_id} value={item.run_id}>{item.run_id} · {item.fidelity_mode}</option>)}
            </select></label>
            <button type="button" disabled={!compareRunId || loading} onClick={() => void handleCompareRuns()}>{t("backtest.checkCompare")}</button>
          </div>
          {runComparison && <div className="backtest-strategy-evidence">
            <strong>{runComparison.directComparisonAllowed ? t("backtest.compatOk") : t("backtest.compatNo")}</strong>
            <span>{t("backtest.diff", { json: JSON.stringify(runComparison.incompatibleFields ?? []) })}</span>
            <span>{t("backtest.paramDiff", { json: JSON.stringify(runComparison.parameterDiff ?? {}) })}</span>
            <span>{t("backtest.tradeDiff")} {JSON.stringify(runComparison.tradeDiff ?? {})}</span>
            <span>{t("backtest.costDiff")} {JSON.stringify(runComparison.costDiff ?? {})}</span>
            <span>{t("backtest.curves", {
              leftEq: String(runComparison.left.equityDaily.length),
              leftDd: String(runComparison.left.drawdownDaily.length),
              rightEq: String(runComparison.right.equityDaily.length),
              rightDd: String(runComparison.right.drawdownDaily.length),
            })}</span>
            <span>{t("backtest.decisionFillHashes", {
              left: JSON.stringify(runComparison.left.hashes),
              right: JSON.stringify(runComparison.right.hashes),
            })}</span>
            <span>{String(runComparison.precisionExplanation ?? t("backtest.precision"))}</span>
          </div>}
          {selectedRun?.state === "COMPLETED" && <div className="backtest-form-row three">
            <label>{t("backtest.cloneParam")}<input value={cloneParameter} onChange={(event) => setCloneParameter(event.target.value)} /></label>
            <label>{t("backtest.newValue")}<input value={cloneValue} onChange={(event) => setCloneValue(event.target.value)} /></label>
            <button type="button" disabled={loading} onClick={() => void handleCloneRun()}>{t("backtest.newImmutable")}</button>
          </div>}
          <div className="backtest-strategy-evidence">
            <strong>{t("backtest.bridge", { state: capabilities?.flags.BACKTEST_REPLAY_REVIEW_BRIDGE_ENABLED ? t("backtest.enabled") : t("backtest.disabledFlag") })}</strong>
            <span>{t("backtest.bridgeHint")}</span>
            <small>{t("backtest.blindHint")}</small>
            {capabilities?.flags.BACKTEST_REPLAY_REVIEW_BRIDGE_ENABLED && <button type="button" disabled={!selectedRunId || loading} onClick={() => void handleReviewBridge()}>{t("backtest.createHandoff")}</button>}
            {reviewBridge && <span>{t("backtest.handoffState", {
              id: String(reviewBridge.bridgeId),
              state: String(reviewBridge.state),
              projection: t("backtest.projection", { state: reviewBridge.strategyProjection ? t("backtest.revealed") : t("backtest.hidden") }),
            })}</span>}
            {capabilities?.flags.BACKTEST_REPLAY_REVIEW_BRIDGE_ENABLED && reviewBridge?.state === "BLINDED" && <button type="button" disabled={loading} onClick={() => void handleRevealReviewBridge()}>{t("backtest.revealCompare")}</button>}
            {reviewBridge?.state === "REVEALED" && <small>{JSON.stringify(reviewBridge.comparison ?? {})}</small>}
          </div>
        </section>

        <section className="backtest-card backtest-studies">
          <div className="backtest-section-title"><span>06</span><h2>{t("backtest.studyTitle")}</h2></div>
          <div className="backtest-strategy-evidence" data-testid="study-v2-contract">
            <strong>{t("backtest.studyContract")}</strong>
            <span>{t("backtest.studyHint")}</span>
            <small>{t("backtest.studyOos")}</small>
          </div>
          <div className="backtest-form-row two">
            <label>{t("backtest.hypothesis")}
              <input aria-label={t("backtest.hypothesis")} value={studyHypothesis} onChange={(event) => setStudyHypothesis(event.target.value)} />
            </label>
            <label>{t("backtest.paramSpace")}
              <input aria-label={t("backtest.paramSpace")} value={studyParameterSpace} onChange={(event) => setStudyParameterSpace(event.target.value)} />
            </label>
          </div>
          <div className="backtest-form-row three">
            <label>{t("backtest.trainDays")}<input aria-label={t("backtest.trainDays")} type="number" min="1" value={studyTrainDays} onChange={(event) => setStudyTrainDays(Number(event.target.value))} /></label>
            <label>{t("backtest.testDays")}<input aria-label={t("backtest.testDays")} type="number" min="1" value={studyTestDays} onChange={(event) => setStudyTestDays(Number(event.target.value))} /></label>
            <label>{t("backtest.stepDays")}<input aria-label={t("backtest.stepDays")} type="number" min="1" value={studyStepDays} onChange={(event) => setStudyStepDays(Number(event.target.value))} /></label>
          </div>
          <div className="backtest-form-row three">
            <label>{t("backtest.purgeDays")}<input aria-label={t("backtest.purgeDays")} type="number" min="0" value={studyPurgeDays} onChange={(event) => setStudyPurgeDays(Number(event.target.value))} /></label>
            <label>{t("backtest.embargoDays")}<input aria-label={t("backtest.embargoDays")} type="number" min="0" value={studyEmbargoDays} onChange={(event) => setStudyEmbargoDays(Number(event.target.value))} /></label>
            <label>{t("backtest.holdoutDays")}<input aria-label={t("backtest.holdoutDays")} type="number" min="0" value={studyHoldoutDays} onChange={(event) => setStudyHoldoutDays(Number(event.target.value))} /></label>
          </div>
          <div className="backtest-form-row three">
            <label>{t("backtest.objective")}<select aria-label={t("backtest.objective")} value={studyObjective} onChange={(event) => setStudyObjective(event.target.value)}>
              <option value="NET_RETURN">NET_RETURN</option><option value="SHARPE">SHARPE</option><option value="CALMAR">CALMAR</option><option value="EXPECTANCY">EXPECTANCY</option>
            </select></label>
            <label>{t("backtest.candidateBudget")}<input aria-label={t("backtest.candidateBudget")} type="number" min="1" max="64" value={studyCandidateBudget} onChange={(event) => setStudyCandidateBudget(Number(event.target.value))} /></label>
            <label>{t("backtest.samplerSeed")}<input aria-label={t("backtest.samplerSeed")} type="number" value={studySeed} onChange={(event) => setStudySeed(Number(event.target.value))} /></label>
          </div>
          <div className="backtest-form-row three">
            <label>{t("backtest.minTrades")}<input aria-label={t("backtest.minTrades")} type="number" min="1" value={studyMinTrades} onChange={(event) => setStudyMinTrades(Number(event.target.value))} /></label>
            <label>{t("backtest.maxDd01")}<input aria-label={t("backtest.maxDd01")} value={studyMaxDrawdown} onChange={(event) => setStudyMaxDrawdown(event.target.value)} /></label>
            <label className="backtest-checkbox"><input type="checkbox" checked={studyCostGuard} onChange={(event) => setStudyCostGuard(event.target.checked)} />{t("backtest.costGuard")}</label>
          </div>
          <div className="backtest-study-toolbar">
            <p>{t("backtest.studyFreeze")}</p>
            <button type="button" onClick={handleCreateStudy} disabled={loading || !snapshot || fidelityMode !== "BAR_APPROX" || !studyHypothesis.trim() || (pythonSelected && !smokePassed)}>
              {pythonSelected ? t("backtest.createPythonStudy") : t("backtest.createRsiStudy")}
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
                  <small>{t("backtest.studySummary", {
                    folds: study.folds?.length ?? 0,
                    trials: (study.folds ?? []).reduce((count, fold) => count + fold.train_trials.length, 0) || study.trials.length,
                    hash: hashLabel(study.config_hash),
                  })}</small>
                </button>
              ))}
              {studies.length === 0 && <p className="backtest-empty">{t("backtest.noStudy")}</p>}
            </div>
            <div className="backtest-study-detail">
              {selectedStudy ? (
                <>
                  <div className="backtest-run-actions">
                    {!isBacktestTerminalState(selectedStudy.state) && (
                      <button type="button" onClick={handleCancelStudy} disabled={loading}>{t("backtest.cancelStudy")}</button>
                    )}
                    {selectedStudy.state === "AWAITING_HOLDOUT" && selectedStudy.holdout?.state === "SEALED" && (
                      <button type="button" onClick={handleRevealHoldout} disabled={loading}>{t("backtest.revealHoldout")}</button>
                    )}
                    <span>{selectedStudy.study_protocol_revision ?? "LEGACY_STUDY_V1"} · {selectedStudy.state}</span>
                  </div>
                  <div className="backtest-strategy-evidence">
                    <strong>{selectedStudy.hypothesis}</strong>
                    <span>{t("backtest.studyFrozen", { hash: hashLabel(selectedStudy.config_hash) })}</span>
                  </div>
                  {(selectedStudy.folds?.length ?? 0) > 0 && <div className="backtest-table-wrap" data-testid="study-v2-folds">
                    <table>
                      <thead><tr><th>{t("backtest.fold")}</th><th>{t("backtest.train")}</th><th>{t("backtest.test")}</th><th>{t("backtest.status")}</th><th>{t("backtest.selectedParams")}</th><th>{t("backtest.receipt")}</th><th>{t("backtest.testRun")}</th></tr></thead>
                      <tbody>{selectedStudy.folds?.map((fold) => <tr key={fold.fold_id}>
                        <td>{fold.ordinal}</td>
                        <td>{timestampLabel(fold.train_start_ms)} → {timestampLabel(fold.train_end_ms)}<small>{t("backtest.purgeShort", { days: fold.purge_ms / 86_400_000 })}</small></td>
                        <td>{timestampLabel(fold.test_start_ms)} → {timestampLabel(fold.test_end_ms)}<small>{t("backtest.embargoShort", { days: fold.embargo_ms / 86_400_000 })}</small></td>
                        <td>{fold.state}</td>
                        <td>{JSON.stringify(fold.selection_receipt?.selected.params ?? null)}</td>
                        <td>{hashLabel(fold.selection_receipt?.hashes.receipt ?? null)}</td>
                        <td>{fold.test_run?.state ?? "—"}</td>
                      </tr>)}</tbody>
                    </table>
                  </div>}
                  {(selectedStudy.folds?.[0]?.selection_receipt?.candidates.length ?? 0) > 0 && <>
                    <h3 className="backtest-table-title">{t("backtest.trainHeatmap")}</h3>
                    <div className="backtest-monthly-heatmap" data-testid="study-train-heatmap">
                      {selectedStudy.folds?.[0]?.selection_receipt?.candidates.map((candidate) => <div
                        key={candidate.params_hash}
                        className={candidate.evaluation.eligible ? "positive" : "negative"}
                        title={candidate.evaluation.violations.join(", ")}
                      ><span>{JSON.stringify(candidate.params)}</span><strong>{candidate.evaluation.objective_value ?? t("backtest.unqualified")}</strong></div>)}
                    </div>
                  </>}
                  {studyComparison?.ready && studyComparison.oos_report ? (
                    <div data-testid="study-v2-oos">
                      <div className="backtest-metrics">
                        <div><span>{t("backtest.oosFolds")}</span><strong>{studyComparison.oos_report.summary.fold_count}</strong></div>
                        <div><span>{t("backtest.oosReturn")}</span><strong>{studyComparison.oos_report.summary.total_return}</strong></div>
                        <div><span>{t("backtest.source")}</span><strong>{studyComparison.oos_report.sourcePolicy}</strong></div>
                        <div><span>{t("backtest.oosHash")}</span><strong>{hashLabel(studyComparison.oos_report.hashes.report)}</strong></div>
                      </div>
                      <EquityCurve data={studyComparison.oos_report.equity} />
                      <div className="backtest-table-wrap"><table>
                        <thead><tr><th>{t("backtest.fold")}</th><th>{t("backtest.selectedParams")}</th><th>{t("backtest.trainObjective")}</th><th>{t("backtest.testObjective")}</th><th>{t("backtest.gap")}</th><th>{t("backtest.regime")}</th><th>{t("backtest.benchmark")}</th></tr></thead>
                        <tbody>{studyComparison.oos_report.folds.map((fold) => <tr key={fold.ordinal}>
                          <td>{fold.ordinal}</td><td>{JSON.stringify(fold.selected_params)}</td><td>{fold.train_objective}</td><td>{fold.test_objective ?? "—"}</td><td>{fold.train_test_gap ?? "—"}</td><td>{fold.market_regime}</td><td>{fold.benchmark_return ?? "—"}</td>
                        </tr>)}</tbody>
                      </table></div>
                    </div>
                  ) : null}
                  {studyComparison?.independent_symbol_robustness ? (
                    <div data-testid="study-basket-robustness">
                      <h3 className="backtest-table-title">{t("backtest.symbolRobust")}</h3>
                      <div className="backtest-metrics">
                        <div><span>{t("backtest.verdict")}</span><strong>{studyComparison.independent_symbol_robustness.verdict?.verdict ?? "—"}</strong></div>
                        <div><span>{t("backtest.singleMarket")}</span><strong>{studyComparison.independent_symbol_robustness.verdict?.single_market_only ? t("backtest.yes") : t("backtest.no")}</strong></div>
                        <div><span>{t("backtest.paramStable")}</span><strong>{studyComparison.independent_symbol_robustness.stability?.stable ? t("backtest.yes") : t("backtest.no")}</strong></div>
                        <div><span>{t("backtest.portfolioSum")}</span><strong>{studyComparison.portfolio_sum_forbidden ? t("backtest.forbidden") : "—"}</strong></div>
                      </div>
                      {(studyComparison.independent_symbol_robustness.independent_oos?.members.length ?? 0) > 0 && (
                        <div className="backtest-table-wrap">
                          <table>
                            <thead><tr><th>{t("backtest.symbol")}</th><th>{t("backtest.regime")}</th><th>OOS</th><th>{t("backtest.run")}</th><th>{t("backtest.report")}</th></tr></thead>
                            <tbody>{studyComparison.independent_symbol_robustness.independent_oos?.members.map((member) => (
                              <tr key={member.dataset_id}>
                                <td>{member.symbol}</td>
                                <td>{member.regime ?? "—"}</td>
                                <td>{member.test_objective ?? "—"}</td>
                                <td>{member.run_id}</td>
                                <td>{hashLabel(member.report_hash)}</td>
                              </tr>
                            ))}</tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  ) : null}
                  {studyComparison?.ready && !studyComparison.oos_report ? (
                    <div className="backtest-table-wrap">
                      <table>
                        <thead><tr><th>{t("backtest.rank")}</th><th>{t("backtest.split")}</th><th>{t("backtest.selectedParams")}</th><th>{t("backtest.oosEquity")}</th></tr></thead>
                        <tbody>{studyComparison.ranking.map((trial, index) => (
                          <tr key={`${trial.ordinal}-${trial.split_id}`}>
                            <td>{index + 1}</td><td>{trial.split_id}</td>
                            <td>{JSON.stringify(trial.params)}</td><td>{String(trial.oos_score ?? "—")}</td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                  ) : null}
                  {!studyComparison?.ready ? (
                    <p className="backtest-empty">{t("backtest.oosEmpty")}</p>
                  ) : null}
                </>
              ) : <p className="backtest-empty">{t("backtest.pickStudy")}</p>}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
