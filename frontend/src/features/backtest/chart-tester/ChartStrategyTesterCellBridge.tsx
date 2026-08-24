import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ChartSession } from "../../chart-session/chartSessionTypes.js";
import type { ChartStrategyAttachmentRecord } from "../../chart-workspace/chartWorkspaceTypes.js";
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
  onAttachmentChange(attachment: ChartStrategyAttachmentRecord | null): void;
  onEntryStateChange(state: ChartStrategyTesterEntryState): void;
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
  onAttachmentChange,
  onEntryStateChange,
  onClosePanel,
}: ChartStrategyTesterCellBridgeProps) {
  const draftStore = useMemo(() => getChartStrategyDraftStore(), []);
  const cellScope = `${workspaceId}\u0000${cellId}`;
  const [runtimeState, setRuntimeState] = useState(() => (
    createChartStrategyTesterState(null, cellScope)
  ));
  const [resolution, setResolution] = useState<ChartContextResolution | null>(null);
  const [sourceDiagnostics, setSourceDiagnostics] = useState<Array<Record<string, unknown>>>([]);
  const [pendingDataDraftRevision, setPendingDataDraftRevision] = useState<number | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const pendingDataRef = useRef<{
    request: ChartStrategyRunRequest;
    resolution: ChartContextResolution;
  } | null>(null);
  const activeIdentityRef = useRef<ResultProjectionIdentity | null>(null);
  const [loadedDraftRevision, setLoadedDraftRevision] = useState<{
    draftId: string;
    revision: number | null;
  } | null>(null);
  const activeDraftId = attachment?.strategyDraftId ?? null;
  const draftContentRevision = activeDraftId !== null
    && loadedDraftRevision?.draftId === activeDraftId
    ? loadedDraftRevision.revision
    : null;
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
  }, [active, attachment, cellId, cellScope, draftContentRevision, panelOpen, session, workspaceId]);

  useEffect(() => {
    const draftId = attachment?.strategyDraftId;
    if (!draftId) return undefined;
    let cancelled = false;
    void draftStore.load(draftId).then((view) => {
      if (cancelled) return;
      setLoadedDraftRevision({
        draftId,
        revision: view.record ? strategyDraftContentRevision(view.record.source) : null,
      });
    });
    const unsubscribe = draftStore.subscribe((id, view) => {
      if (id === draftId) {
        setLoadedDraftRevision({
          draftId,
          revision: view.record ? strategyDraftContentRevision(view.record.source) : null,
        });
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [attachment?.strategyDraftId, draftStore]);

  useEffect(() => () => {
    runtimeFactory.release(workspaceId, cellId);
  }, [cellId, workspaceId]);

  const startRun = useCallback((
    request: ChartStrategyRunRequest,
    materializeResolution: ChartContextResolution | null = null,
  ) => {
    if (inFlightRef.current) return;
    const runtime = runtimeFactory.get(workspaceId, cellId);
    if (!runtime) return;
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
        return;
      }
      pendingDataRef.current = null;
      setPendingDataDraftRevision(null);
      if (outcome.kind === "UNSUPPORTED") {
        runtime.dispatch({ type: "REQUEST_STATUS", token, status: "UNSUPPORTED" });
        return;
      }
      if (outcome.run.state === "COMPLETED") {
        runtime.dispatch({ type: "REQUEST_COMPLETED", token, identity: outcome.identity });
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
      if (inFlightRef.current === task) inFlightRef.current = null;
    });
    inFlightRef.current = task;
  }, [cellId, onAttachmentChange, workspaceId]);

  const handleRunRequest = useCallback((request: ChartStrategyRunRequest) => {
    pendingDataRef.current = null;
    setPendingDataDraftRevision(null);
    setResolution(null);
    startRun(request);
  }, [startRun]);

  const handlePrepareData = useCallback(() => {
    const pending = pendingDataRef.current;
    if (!pending) return;
    startRun(pending.request, pending.resolution);
  }, [startRun]);

  const handleStopObserving = useCallback(() => {
    const runtime = runtimeFactory.get(workspaceId, cellId);
    if (!runtime) return;
    runtime.abortRequests("user stopped observing the Run; backend Run was not cancelled");
    runtime.dispatch({ type: "STOP_OBSERVING" });
    inFlightRef.current = null;
  }, [cellId, workspaceId]);

  const handleResumeObserving = useCallback(() => {
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
  }, [cellId, workspaceId]);

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
      onPrepareData={handlePrepareData}
      onStopObserving={handleStopObserving}
      onResumeObserving={handleResumeObserving}
      onSourceDirty={() => setSourceDiagnostics([])}
      onClose={onClosePanel}
    />,
    bottomPanelHost,
  );
}
