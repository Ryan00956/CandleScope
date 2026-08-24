import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ChartSession } from "../../chart-session/chartSessionTypes.js";
import type { ChartStrategyAttachmentRecord } from "../../chart-workspace/chartWorkspaceTypes.js";
import { SeriesWindowStore } from "../../market-data/window/seriesWindowStore.js";
import type { ChartSurfaceVisibleRange } from "../../../chart-adapter/useChartSurfaceRuntime.js";
import { parseIntervalSeconds } from "../../../utils/intervals.js";
import { defaultBacktestApi, type ChartContextResolution } from "../backtestApi.js";
import { pollBacktestRunToTerminal } from "../backtestRunClient.js";
import { ChartStrategyTesterRuntimeFactory } from "./ChartStrategyTesterRuntime.js";
import {
  getChartStrategyDraftStore,
  strategyDraftContentRevision,
} from "./chartStrategyTesterDrafts.js";
import type {
  ChartStrategyRunRequest,
  ChartStrategyTesterEntryState,
} from "./chartStrategyTesterUiModel.js";
import {
  chartStrategyRunDiagnostics,
  runChartStrategyBacktest,
} from "./chartStrategyRunRequest.js";
import {
  createChartStrategyTesterState,
  currentChartStrategyTesterToken,
  type ResultProjectionIdentity,
} from "./chartStrategyTesterState.js";
import ChartStrategyTesterPanel from "./ChartStrategyTesterPanel.js";
import {
  chartStrategyResultCache,
  type ChartStrategyResultBundle,
} from "./chartStrategyResultCache.js";
import {
  createChartStrategyResultMarkerSource,
  type ChartStrategyResultMarkerSource,
} from "./chartStrategyResultMarkerSource.js";
import { t } from "../../../i18n/index.js";
import { useLocale } from "../../../i18n/useLocale.js";
import type { RecentRunCompareV1 } from "../backtestTypes.js";
import {
  CHART_RUN_COMPARE_ENABLED,
  CHART_STRATEGY_AUTO_RUN_ENABLED,
  CHART_TRADE_EXPLANATION_ENABLED,
} from "./chartStrategyTesterFeature.js";
import type { TradeExplanationSelection } from "./ChartStrategyResultViews.js";
import type { StrategyDraftRecord } from "./StrategyDraftStore.js";
import {
  CHART_STRATEGY_AUTO_RUN_DEBOUNCE_MS,
  chartStrategyAutoRunCoordinator,
  shouldScheduleChartStrategyAutoRun,
  type ChartStrategyAutoRunContext,
  type ChartStrategyAutoRunPauseReason,
} from "./chartStrategyAutoRunCoordinator.js";
import "./chartStrategyTester.css";

const runtimeFactory = new ChartStrategyTesterRuntimeFactory(true);

export interface ChartStrategyTesterCellBridgeProps {
  workspaceId: string;
  cellId: string;
  session: ChartSession;
  attachment: ChartStrategyAttachmentRecord | null;
  active: boolean;
  panelOpen: boolean;
  bottomPanelHost: HTMLElement | null;
  seriesStore: SeriesWindowStore | null;
  getCurrentVisibleRange(): ChartSurfaceVisibleRange | null;
  onMarkerSourceChange(source: ChartStrategyResultMarkerSource | null): void;
  onLocateTrade(timeMs: number): void;
  onAttachmentChange(attachment: ChartStrategyAttachmentRecord | null): void;
  onEntryStateChange(state: ChartStrategyTesterEntryState): void;
  onOpenPanel(): void;
  onClosePanel(): void;
}

export default function ChartStrategyTesterCellBridge({
  workspaceId,
  cellId,
  session,
  attachment,
  active,
  panelOpen,
  bottomPanelHost,
  seriesStore,
  getCurrentVisibleRange,
  onMarkerSourceChange,
  onLocateTrade,
  onAttachmentChange,
  onEntryStateChange,
  onOpenPanel,
  onClosePanel,
}: ChartStrategyTesterCellBridgeProps) {
  const locale = useLocale();
  const draftStore = useMemo(() => getChartStrategyDraftStore(), []);
  const cellScope = `${workspaceId}\u0000${cellId}`;
  const [runtimeState, setRuntimeState] = useState(() => (
    createChartStrategyTesterState(null, cellScope)
  ));
  const [resolution, setResolution] = useState<ChartContextResolution | null>(null);
  const [sourceDiagnostics, setSourceDiagnostics] = useState<Array<Record<string, unknown>>>([]);
  const [result, setResult] = useState<ChartStrategyResultBundle | null>(null);
  const [resultLoading, setResultLoading] = useState(false);
  const [resultError, setResultError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<RecentRunCompareV1 | null>(null);
  const [selectedExplanation, setSelectedExplanation] = useState<TradeExplanationSelection | null>(null);
  const [pendingDataDraftRevision, setPendingDataDraftRevision] = useState<number | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const inFlightOriginRef = useRef<"MANUAL" | "AUTO" | null>(null);
  const inFlightSubmittedRef = useRef(false);
  const pendingDataRef = useRef<{
    request: ChartStrategyRunRequest;
    resolution: ChartContextResolution;
  } | null>(null);
  const activeIdentityRef = useRef<ResultProjectionIdentity | null>(null);
  const [loadedDraftSnapshot, setLoadedDraftSnapshot] = useState<{
    draftId: string;
    record: StrategyDraftRecord | null;
  } | null>(null);
  const activeDraftId = attachment?.strategyDraftId ?? null;
  const loadedDraft = activeDraftId !== null
    && loadedDraftSnapshot?.draftId === activeDraftId
    ? loadedDraftSnapshot.record
    : null;
  const draftContentRevision = loadedDraft
    ? strategyDraftContentRevision(loadedDraft.source)
    : null;
  const [autoRunPauseReason, setAutoRunPauseReason] = useState<ChartStrategyAutoRunPauseReason | null>(() => (
    !CHART_STRATEGY_AUTO_RUN_ENABLED
      ? "FLAG_DISABLED"
      : attachment?.autoRun === false
        ? "USER_DISABLED"
        : attachment?.fidelityPreference === "PRECISE"
          ? "PRECISE_REQUIRES_MANUAL"
          : null
  ));
  const previousAutoContextRef = useRef<ChartStrategyAutoRunContext | null>(null);
  const pendingAutoIntentRef = useRef<{ contextKey: string; generation: number } | null>(null);
  const cancelAutoDebounceRef = useRef<(() => void) | null>(null);
  const autoRunAttachmentKey = attachment?.strategyDraftId
    ? JSON.stringify({
      draftId: attachment.strategyDraftId,
      parameters: attachment.parameters,
      rangeMode: attachment.rangeMode,
      customRange: attachment.customRange,
      fidelityPreference: attachment.fidelityPreference,
      quickPresetId: attachment.quickPresetId,
    })
    : null;
  const autoRunContext = useMemo<ChartStrategyAutoRunContext>(() => ({
    sessionKey: `${session.exchange}\u0000${session.marketType}\u0000${session.symbol}\u0000${session.interval}`,
    attachmentKey: autoRunAttachmentKey,
    enabled: attachment?.autoRun === true,
  }), [attachment?.autoRun, autoRunAttachmentKey, session.exchange, session.interval,
    session.marketType, session.symbol]);
  const autoRunContextKey = `${autoRunContext.sessionKey}\u0000${autoRunContext.attachmentKey ?? ""}\u0000${autoRunContext.enabled ? "1" : "0"}`;
  const projectionSeriesStore = useMemo(() => seriesStore ?? new SeriesWindowStore({
    intervalSeconds: parseIntervalSeconds(session.interval),
    seriesKey: `chart-strategy:${cellScope}`,
  }), [cellScope, seriesStore, session.interval]);
  const resultMarkerLabels = useMemo(() => {
    void locale;
    return {
      actions: {
        OPEN_LONG: t("backtest.openLong"),
        CLOSE_LONG: t("backtest.closeLong"),
        OPEN_SHORT: t("backtest.openShort"),
        CLOSE_SHORT: t("backtest.closeShort"),
        ADD_LONG: t("backtest.addLong"),
        ADD_SHORT: t("backtest.addShort"),
        REDUCE_LONG: t("backtest.reduceLong"),
        REDUCE_SHORT: t("backtest.reduceShort"),
        REVERSE_TO_LONG: t("backtest.reverseLong"),
        REVERSE_TO_SHORT: t("backtest.reverseShort"),
      },
      rejection: t("backtest.reject"),
    };
  }, [locale]);
  const resultMarkerSource = useMemo(() => createChartStrategyResultMarkerSource({
    seriesStore: projectionSeriesStore,
    labels: resultMarkerLabels,
    onActivate(evidence) {
      if (!CHART_TRADE_EXPLANATION_ENABLED) return;
      setSelectedExplanation({
        id: evidence.markerId,
        title: evidence.kind === "REJECTION"
          ? t("chartTester.explain.rejectionTitle")
          : t("chartTester.explain.fillTitle"),
        items: [{
          label: evidence.kind === "REJECTION"
            ? t("chartTester.explain.rejection")
            : t("chartTester.explain.fill"),
          explanation: evidence.explanation,
        }],
      });
      onOpenPanel();
    },
  }), [onOpenPanel, projectionSeriesStore, resultMarkerLabels]);

  useLayoutEffect(() => {
    resultMarkerSource.setVisibleRange(getCurrentVisibleRange());
    onMarkerSourceChange(resultMarkerSource);
    return () => {
      onMarkerSourceChange(null);
      resultMarkerSource.dispose();
    };
  }, [getCurrentVisibleRange, onMarkerSourceChange, resultMarkerSource]);

  useLayoutEffect(() => {
    const runtime = runtimeFactory.get(workspaceId, cellId);
    if (!runtime) return;
    runtime.syncInputs(attachment ? {
      session,
      attachment,
      draftContentRevision,
    } : null);
  }, [attachment, cellId, draftContentRevision, session, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    const runtime = runtimeFactory.activate({
      workspaceId,
      cellId,
      attachment,
      session,
      draftContentRevision,
      editorOpen: active && panelOpen,
    });
    runtime?.setMarkerSource(resultMarkerSource);
    const publish = (nextState: typeof runtimeState) => {
      if (!cancelled) setRuntimeState(nextState);
    };
    const unsubscribe = runtime?.subscribe(publish);
    queueMicrotask(() => publish(
      runtime?.snapshot() ?? createChartStrategyTesterState(null, cellScope),
    ));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [active, attachment, cellId, cellScope, draftContentRevision, panelOpen, resultMarkerSource, session, workspaceId]);

  useEffect(() => {
    const identity = runtimeState.resultIdentity;
    if (!identity || runtimeState.status !== "COMPLETED") return undefined;
    const controller = new AbortController();
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setResultLoading(true);
      setResultError(null);
      setComparison(null);
      setSelectedExplanation(null);
    });
    void chartStrategyResultCache.load(defaultBacktestApi, identity.runId, controller.signal)
      .then((bundle) => {
        if (cancelled) return;
        const runtime = runtimeFactory.get(workspaceId, cellId);
        const current = runtime?.snapshot();
        if (!runtime || !current || current.resultIdentity?.runId !== identity.runId) return;
        setResult(bundle);
        runtime.setResultReference(bundle);
        if (current.projectionVisible) resultMarkerSource.setResult(bundle.chart);
        else resultMarkerSource.clear();
        if (CHART_RUN_COMPARE_ENABLED) {
          void defaultBacktestApi.compareRecentRun(identity.runId, controller.signal)
            .then((value) => {
              if (!cancelled) setComparison(value);
            })
            .catch(() => {
              if (!cancelled && !controller.signal.aborted) setComparison(null);
            });
        }
      })
      .catch((reason: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setResultError(reason instanceof Error ? reason.message : t("chartTester.result.unavailable"));
      })
      .finally(() => {
        if (!cancelled) setResultLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [cellId, resultMarkerSource, runtimeState.resultIdentity, runtimeState.status, workspaceId]);

  useEffect(() => {
    if (result && runtimeState.projectionVisible
      && runtimeState.resultIdentity?.runId === result.run.run_id) {
      resultMarkerSource.setResult(result.chart);
    } else {
      resultMarkerSource.clear();
    }
  }, [result, resultMarkerSource, runtimeState.projectionVisible, runtimeState.resultIdentity?.runId]);

  useEffect(() => {
    const draftId = attachment?.strategyDraftId;
    if (!draftId) return undefined;
    let cancelled = false;
    void draftStore.load(draftId).then((view) => {
      if (cancelled) return;
      setLoadedDraftSnapshot({
        draftId,
        record: view.record,
      });
    });
    const unsubscribe = draftStore.subscribe((id, view) => {
      if (id === draftId) {
        setLoadedDraftSnapshot({
          draftId,
          record: view.record,
        });
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [attachment?.strategyDraftId, draftStore]);

  useEffect(() => () => {
    cancelAutoDebounceRef.current?.();
    chartStrategyAutoRunCoordinator.releaseScope(workspaceId, cellScope);
    runtimeFactory.release(workspaceId, cellId);
  }, [cellId, cellScope, workspaceId]);

  const startRun = useCallback((
    request: ChartStrategyRunRequest,
    materializeResolution: ChartContextResolution | null = null,
    origin: "MANUAL" | "AUTO" = "MANUAL",
  ): Promise<void> | null => {
    if (inFlightRef.current) return null;
    const runtime = runtimeFactory.get(workspaceId, cellId);
    if (!runtime) return null;
    const token = runtime.beginRequest("RESOLVING");
    const controller = new AbortController();
    const untrack = runtime.trackAbortController(controller);
    setSourceDiagnostics([]);
    const task = runChartStrategyBacktest({
      api: defaultBacktestApi,
      request,
      signal: controller.signal,
      materializeResolution,
      onStage(stage) {
        if (origin === "AUTO") setAutoRunPauseReason(null);
        const status = stage === "QUEUED"
          ? "QUEUED"
          : stage === "RUNNING"
            ? "RUNNING"
            : "RESOLVING";
        runtime.dispatch({ type: "REQUEST_STATUS", token, status });
      },
      onRevision(revision) {
        runtime.dispatch({
          type: "BIND_STRATEGY_REVISION",
          token,
          strategyRevisionId: revision.revision_id,
        });
        onAttachmentChange({
          ...request.attachment,
          strategyRevisionId: revision.revision_id,
        });
      },
      onResolution(next) {
        const current = currentChartStrategyTesterToken(runtime.snapshot());
        if (current.generation === token.generation) setResolution(next);
      },
      onRunCreated(run, identity) {
        inFlightSubmittedRef.current = true;
        activeIdentityRef.current = identity;
        runtime.dispatch({
          type: "REQUEST_STATUS",
          token,
          status: run.state === "QUEUED" ? "QUEUED" : "RUNNING",
          activeRunId: run.run_id,
        });
      },
      onRunUpdate(run) {
        runtime.dispatch({
          type: "REQUEST_STATUS",
          token,
          status: run.state === "QUEUED" ? "QUEUED" : "RUNNING",
          activeRunId: run.run_id,
        });
      },
    }).then((outcome) => {
      if (outcome.kind === "NEEDS_DATA") {
        pendingDataRef.current = { request, resolution: outcome.resolution };
        setPendingDataDraftRevision(request.draftContentRevision);
        runtime.dispatch({ type: "REQUEST_STATUS", token, status: "NEEDS_DATA" });
        if (origin === "AUTO") setAutoRunPauseReason("NEEDS_DATA_CONFIRMATION");
        return;
      }
      pendingDataRef.current = null;
      setPendingDataDraftRevision(null);
      if (outcome.kind === "UNSUPPORTED") {
        runtime.dispatch({ type: "REQUEST_STATUS", token, status: "UNSUPPORTED" });
        if (origin === "AUTO") setAutoRunPauseReason("UNSUPPORTED_CONTEXT");
        return;
      }
      if (outcome.run.state === "COMPLETED") {
        runtime.dispatch({ type: "REQUEST_COMPLETED", token, identity: outcome.identity });
        if (origin === "AUTO") setAutoRunPauseReason(null);
      } else {
        runtime.dispatch({
          type: "REQUEST_FAILED",
          token,
          error: {
            code: outcome.run.failure_code ?? outcome.run.state,
            message: outcome.run.state === "CANCELLED"
              ? "the backend Run was cancelled"
              : "the backend Run failed",
            action: "retry",
          },
        });
      }
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      const diagnostics = chartStrategyRunDiagnostics(reason);
      if (origin === "AUTO" && diagnostics.code === "RUN_CAPACITY_EXCEEDED") {
        setAutoRunPauseReason("BACKEND_BUSY");
      }
      setSourceDiagnostics(diagnostics.sourceDiagnostics);
      runtime.dispatch({
        type: "REQUEST_FAILED",
        token,
        error: {
          code: diagnostics.code,
          message: diagnostics.message,
          action: diagnostics.action,
        },
      });
    }).finally(() => {
      untrack();
      if (inFlightRef.current === task) {
        inFlightRef.current = null;
        inFlightOriginRef.current = null;
        inFlightSubmittedRef.current = false;
      }
    });
    inFlightOriginRef.current = origin;
    inFlightSubmittedRef.current = false;
    inFlightRef.current = task;
    return task;
  }, [cellId, onAttachmentChange, workspaceId]);

  const cancelPendingAutoRun = useCallback(() => {
    cancelAutoDebounceRef.current?.();
    cancelAutoDebounceRef.current = null;
    pendingAutoIntentRef.current = null;
    chartStrategyAutoRunCoordinator.cancelPending(workspaceId, cellScope);
  }, [cellScope, workspaceId]);

  const handleRunRequest = useCallback((request: ChartStrategyRunRequest) => {
    cancelPendingAutoRun();
    pendingDataRef.current = null;
    setPendingDataDraftRevision(null);
    setResolution(null);
    const existing = inFlightRef.current;
    if (existing && inFlightOriginRef.current === "AUTO" && !inFlightSubmittedRef.current) {
      runtimeFactory.get(workspaceId, cellId)?.abortRequests("manual Run preempted unsubmitted auto Run");
      void existing.then(
        () => { void startRun(request); },
        () => { void startRun(request); },
      );
      return;
    }
    void startRun(request);
  }, [cancelPendingAutoRun, cellId, startRun, workspaceId]);

  const handlePrepareData = useCallback(() => {
    const pending = pendingDataRef.current;
    if (!pending) return;
    cancelPendingAutoRun();
    void startRun(pending.request, pending.resolution);
  }, [cancelPendingAutoRun, startRun]);

  useEffect(() => {
    const previous = previousAutoContextRef.current;
    previousAutoContextRef.current = autoRunContext;
    const runtime = runtimeFactory.get(workspaceId, cellId);
    if (!runtime || !attachment) return undefined;
    if (!CHART_STRATEGY_AUTO_RUN_ENABLED) {
      cancelPendingAutoRun();
      queueMicrotask(() => setAutoRunPauseReason("FLAG_DISABLED"));
      return undefined;
    }
    if (!attachment.autoRun) {
      cancelPendingAutoRun();
      queueMicrotask(() => setAutoRunPauseReason("USER_DISABLED"));
      return undefined;
    }
    if (attachment.fidelityPreference !== "FAST") {
      cancelPendingAutoRun();
      queueMicrotask(() => setAutoRunPauseReason("PRECISE_REQUIRES_MANUAL"));
      return undefined;
    }
    if (shouldScheduleChartStrategyAutoRun(previous, autoRunContext)) {
      pendingAutoIntentRef.current = {
        contextKey: autoRunContextKey,
        generation: runtime.snapshot().generation,
      };
    }
    const pending = pendingAutoIntentRef.current;
    if (!pending || pending.contextKey !== autoRunContextKey) return undefined;
    const draftLoaded = loadedDraftSnapshot?.draftId === attachment.strategyDraftId;
    if (!draftLoaded) return undefined;
    if (!loadedDraft) {
      pendingAutoIntentRef.current = null;
      queueMicrotask(() => setAutoRunPauseReason("DRAFT_UNAVAILABLE"));
      return undefined;
    }
    cancelAutoDebounceRef.current?.();
    pending.generation = runtime.snapshot().generation;
    const request: ChartStrategyRunRequest = {
      cellScope,
      session: { ...session },
      draftId: loadedDraft.id,
      draftContentRevision: strategyDraftContentRevision(loadedDraft.source),
      displayName: loadedDraft.displayName,
      language: loadedDraft.language,
      source: loadedDraft.source,
      attachment: {
        ...attachment,
        parameters: { ...attachment.parameters },
        customRange: attachment.customRange ? { ...attachment.customRange } : null,
      },
    };
    queueMicrotask(() => setAutoRunPauseReason("WAITING_DEBOUNCE"));
    const timer = globalThis.setTimeout(() => {
      const releaseTimer = cancelAutoDebounceRef.current;
      cancelAutoDebounceRef.current = null;
      releaseTimer?.();
      const intent = pendingAutoIntentRef.current;
      pendingAutoIntentRef.current = null;
      const currentRuntime = runtimeFactory.get(workspaceId, cellId);
      const latestContext = previousAutoContextRef.current;
      if (!intent || intent.contextKey !== autoRunContextKey
        || !latestContext?.enabled
        || latestContext.sessionKey !== autoRunContext.sessionKey
        || latestContext.attachmentKey !== autoRunContext.attachmentKey
        || !currentRuntime
        || currentRuntime.snapshot().generation !== intent.generation) return;
      chartStrategyAutoRunCoordinator.enqueue({
        workspaceId,
        cellScope,
        generation: intent.generation,
        onQueueState(state) {
          setAutoRunPauseReason(state === "QUEUED" ? "WORKSPACE_QUEUE" : null);
        },
        async execute() {
          const activeRuntime = runtimeFactory.get(workspaceId, cellId);
          const latest = previousAutoContextRef.current;
          if (!activeRuntime || activeRuntime.snapshot().generation !== intent.generation
            || latest?.sessionKey !== autoRunContext.sessionKey
            || latest.attachmentKey !== autoRunContext.attachmentKey
            || !latest.enabled) return;
          const existing = inFlightRef.current;
          if (existing) await existing.catch(() => undefined);
          const refreshedRuntime = runtimeFactory.get(workspaceId, cellId);
          if (!refreshedRuntime || refreshedRuntime.snapshot().generation !== intent.generation) return;
          const task = startRun(request, null, "AUTO");
          if (task) await task;
        },
      });
    }, CHART_STRATEGY_AUTO_RUN_DEBOUNCE_MS);
    cancelAutoDebounceRef.current = runtime.trackTimer(timer);
    return () => {
      if (pendingAutoIntentRef.current?.contextKey !== autoRunContextKey) return;
      cancelAutoDebounceRef.current?.();
      cancelAutoDebounceRef.current = null;
    };
  }, [attachment, autoRunContext, autoRunContextKey, cancelPendingAutoRun, cellId, cellScope,
    loadedDraft, loadedDraftSnapshot?.draftId, session, startRun, workspaceId]);

  const handleStopObserving = useCallback(() => {
    cancelPendingAutoRun();
    const runtime = runtimeFactory.get(workspaceId, cellId);
    if (!runtime) return;
    runtime.abortRequests("user stopped observing the Run; backend Run was not cancelled");
    runtime.dispatch({ type: "STOP_OBSERVING" });
    inFlightRef.current = null;
  }, [cancelPendingAutoRun, cellId, workspaceId]);

  const handleResumeObserving = useCallback(() => {
    cancelPendingAutoRun();
    if (inFlightRef.current) return;
    const runtime = runtimeFactory.get(workspaceId, cellId);
    const runId = runtime?.snapshot().activeRunId;
    const identity = activeIdentityRef.current;
    if (!runtime || !runId || !identity) return;
    const token = runtime.beginRequest("RUNNING");
    runtime.dispatch({ type: "REQUEST_STATUS", token, status: "RUNNING", activeRunId: runId });
    const controller = new AbortController();
    const untrack = runtime.trackAbortController(controller);
    const task = pollBacktestRunToTerminal({
      api: defaultBacktestApi,
      runId,
      signal: controller.signal,
      onUpdate(run) {
        runtime.dispatch({
          type: "REQUEST_STATUS",
          token,
          status: run.state === "QUEUED" ? "QUEUED" : "RUNNING",
          activeRunId: run.run_id,
        });
      },
    }).then((run) => {
      if (run.state === "COMPLETED") {
        runtime.dispatch({ type: "REQUEST_COMPLETED", token, identity });
      } else {
        runtime.dispatch({
          type: "REQUEST_FAILED",
          token,
          error: {
            code: run.failure_code ?? run.state,
            message: run.state === "CANCELLED" ? "the backend Run was cancelled" : "the backend Run failed",
            action: "retry",
          },
        });
      }
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      const diagnostics = chartStrategyRunDiagnostics(reason);
      runtime.dispatch({
        type: "REQUEST_FAILED",
        token,
        error: {
          code: diagnostics.code,
          message: diagnostics.message,
          action: diagnostics.action,
        },
      });
    }).finally(() => {
      untrack();
      if (inFlightRef.current === task) inFlightRef.current = null;
    });
    inFlightRef.current = task;
  }, [cancelPendingAutoRun, cellId, workspaceId]);

  if (!active || !panelOpen || !bottomPanelHost) return null;
  return createPortal(
    <ChartStrategyTesterPanel
      cellScope={`${workspaceId}\u0000${cellId}`}
      session={session}
      attachment={attachment}
      draftStore={draftStore}
      onAttachmentChange={onAttachmentChange}
      onEntryStateChange={onEntryStateChange}
      onRunRequest={handleRunRequest}
      runState={runtimeState}
      resolution={resolution}
      sourceDiagnostics={sourceDiagnostics}
      pendingDataDraftRevision={pendingDataDraftRevision}
      result={result}
      resultLoading={resultLoading}
      resultError={resultError}
      comparison={comparison}
      autoRunPauseReason={autoRunPauseReason}
      selectedExplanation={selectedExplanation}
      onSelectExplanation={(selection) => {
        if (CHART_TRADE_EXPLANATION_ENABLED) setSelectedExplanation(selection);
      }}
      onCloseExplanation={() => setSelectedExplanation(null)}
      onLocateTrade={onLocateTrade}
      onPrepareData={handlePrepareData}
      onStopObserving={handleStopObserving}
      onResumeObserving={handleResumeObserving}
      onSourceDirty={() => setSourceDiagnostics([])}
      onClose={onClosePanel}
    />,
    bottomPanelHost,
  );
}
