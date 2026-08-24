import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChartSession } from "../../chart-session/chartSessionTypes.js";
import { t } from "../../../i18n/index.js";
import {
  defaultBacktestApi,
  type BacktestApiClient,
  type BacktestDataset,
  type StrategyRevisionRecord,
} from "../backtestApi.js";
import { parseBacktestResearchEntry } from "../backtestDeepLink.js";
import { isBacktestResearchAdvancedEnabled } from "../backtestFlags.js";
import type {
  BacktestChartData,
  BacktestReport,
  BacktestResearchLaunchContext,
  BacktestRunRecord,
  BacktestStudyRecord,
} from "../backtestTypes.js";
import { getChartStrategyDraftStore } from "../chart-tester/chartStrategyTesterDrafts.js";
import type { StrategyDraftRecord } from "../chart-tester/StrategyDraftStore.js";
import type { PythonStudioGate } from "../pythonStudio.js";
import {
  composeResearchRunDraft,
  composeResearchStudyDraft,
  normalizeResearchRunDraft,
  normalizeResearchStudyDraft,
  parseResearchObjectJson,
  parseResearchRunConfig,
  researchDatasetIdFromAuthority,
  researchObjectJson,
  researchRangeFromAuthority,
  researchRunIsActive,
  researchStudyIsActive,
} from "./backtestResearchAdvancedModel.js";
import {
  researchReturnHref,
  researchSessionFromAuthority,
} from "./backtestResearchModel.js";
import type {
  BacktestResearchRuntime,
  BacktestResearchTask,
} from "./backtestResearchTypes.js";

interface LoadedRunBundle {
  run: BacktestRunRecord;
  report: BacktestReport | null;
  chart: BacktestChartData | null;
}

async function loadRunBundle(
  api: BacktestApiClient,
  runId: string,
  signal?: AbortSignal,
): Promise<LoadedRunBundle> {
  const run = await api.getRun(runId, signal);
  if (run.state !== "COMPLETED") return { run, report: null, chart: null };
  const [report, chart] = await Promise.allSettled([
    api.getReport(runId, signal),
    api.getChart(runId, signal),
  ]);
  return {
    run,
    report: report.status === "fulfilled" ? report.value : null,
    chart: chart.status === "fulfilled" ? chart.value : null,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadHostRuntimeMode(signal: AbortSignal): Promise<"LIVE" | "LOCAL_OFFLINE" | null> {
  try {
    const response = await fetch("/api/v1/local/capabilities", { signal });
    if (!response.ok) return "LIVE";
    const payload = await response.json() as { runtime_mode?: unknown };
    return payload.runtime_mode === "LIVE" || payload.runtime_mode === "LOCAL_OFFLINE"
      ? payload.runtime_mode
      : null;
  } catch (reason) {
    if (signal.aborted) throw reason;
    return null;
  }
}

function idempotencyKey(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}`;
}

function downloadJson(name: string, payload: Record<string, unknown>): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return;
  const href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  }));
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
}

function selectedDataset(datasets: readonly BacktestDataset[], datasetId: string): BacktestDataset | null {
  return datasets.find((item) => item.dataset_id === datasetId) ?? null;
}

export function useBacktestResearchRuntime(options: {
  api?: BacktestApiClient;
  search?: string;
  advancedEnabled?: boolean;
} = {}): BacktestResearchRuntime {
  const api = options.api ?? defaultBacktestApi;
  const search = options.search ?? (typeof window === "undefined" ? "" : window.location.search);
  const entry = useMemo(() => parseBacktestResearchEntry(search), [search]);
  const advancedEnabled = options.advancedEnabled ?? isBacktestResearchAdvancedEnabled();
  const [selectedTask, setSelectedTask] = useState<BacktestResearchTask | null>(null);
  const [sourceMode, setSourceMode] = useState<BacktestResearchRuntime["view"]["sourceMode"]>("LIVE_REFERENCE");
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [phase, setPhase] = useState<BacktestResearchRuntime["view"]["phase"]>("LOADING");
  const [error, setError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<BacktestResearchRuntime["view"]["capabilities"]>(null);
  const [runtimeMode, setRuntimeMode] = useState<BacktestResearchRuntime["view"]["runtimeMode"]>(null);
  const [launchContext, setLaunchContext] = useState<BacktestResearchLaunchContext | null>(null);
  const [draft, setDraft] = useState<StrategyDraftRecord | null>(null);
  const [revisions, setRevisions] = useState<StrategyRevisionRecord[]>([]);
  const [datasets, setDatasets] = useState<BacktestDataset[]>([]);
  const [runs, setRuns] = useState<BacktestRunRecord[]>([]);
  const [studies, setStudies] = useState<BacktestStudyRecord[]>([]);
  const [activeRun, setActiveRun] = useState<BacktestRunRecord | null>(null);
  const [report, setReport] = useState<BacktestReport | null>(null);
  const [chart, setChart] = useState<BacktestChartData | null>(null);
  const [activeStudy, setActiveStudy] = useState<BacktestStudyRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [selectedDatasetId, setSelectedDatasetId] = useState("");
  const [selectedRevisionId, setSelectedRevisionId] = useState("");
  const [startTimeMs, setStartTimeMs] = useState(0);
  const [endTimeMs, setEndTimeMs] = useState(0);
  const [snapshot, setSnapshot] = useState<BacktestResearchRuntime["view"]["snapshot"]>(null);
  const [runDraftText, setRunDraftText] = useState("{}");
  const [studyDraftText, setStudyDraftText] = useState("{}");
  const [runComparison, setRunComparison] = useState<BacktestResearchRuntime["view"]["runComparison"]>(null);
  const [studyComparison, setStudyComparison] = useState<BacktestResearchRuntime["view"]["studyComparison"]>(null);
  const [signalTrace, setSignalTrace] = useState<BacktestResearchRuntime["view"]["signalTrace"]>([]);
  const [reviewBridge, setReviewBridge] = useState<Record<string, unknown> | null>(null);
  const [pythonGate, setPythonGate] = useState<PythonStudioGate | null>(null);

  const openRun = useCallback(async (runId: string) => {
    try {
      const bundle = await loadRunBundle(api, runId);
      setActiveRun(bundle.run);
      setReport(bundle.report);
      setChart(bundle.chart);
      setRunComparison(null);
      setSignalTrace([]);
      setSourceMode(bundle.chart ? "RUN_RESULT" : "LIVE_REFERENCE");
    } catch (reason) {
      setOperationError(message(reason));
    }
  }, [api]);

  const openStudy = useCallback(async (studyId: string) => {
    try {
      const existing = studies.find((study) => study.study_id === studyId);
      setActiveStudy(existing ?? await api.getStudy(studyId));
      setStudyComparison(null);
    } catch (reason) {
      setOperationError(message(reason));
    }
  }, [api, studies]);

  useEffect(() => {
    if (entry.kind === "invalid") return undefined;
    const controller = new AbortController();
    const task = async () => {
      const [nextCapabilities, nextDatasets, nextRuns, nextStudies, customRevisions] = await Promise.all([
        api.capabilities(controller.signal),
        api.listDatasets(controller.signal),
        api.listRuns(controller.signal),
        api.listStudies(controller.signal),
        api.listStrategyRevisions(controller.signal),
      ]);
      if (controller.signal.aborted) return;
      const nextRuntimeMode = nextCapabilities.runtime_mode
        ?? await loadHostRuntimeMode(controller.signal);
      if (controller.signal.aborted) return;
      const revisionMap = new Map([
        ...nextCapabilities.strategies,
        ...customRevisions,
      ].map((revision) => [revision.revision_id, revision]));
      const nextRevisions = [...revisionMap.values()];

      let nextContext: BacktestResearchLaunchContext | null = null;
      let bundle: LoadedRunBundle | null = null;
      let nextStudy: BacktestStudyRecord | null = null;
      let nextDraft: StrategyDraftRecord | null = null;
      if (entry.kind === "context") {
        nextContext = await api.getResearchLaunchContext(entry.contextId, controller.signal);
        const draftView = await getChartStrategyDraftStore().load(nextContext.strategy_draft_id);
        nextDraft = draftView.record;
        if (nextContext.latest_run_id) {
          bundle = await loadRunBundle(api, nextContext.latest_run_id, controller.signal);
        }
      } else if (entry.kind === "run") {
        bundle = await loadRunBundle(api, entry.runId, controller.signal);
      } else if (entry.kind === "study") {
        nextStudy = nextStudies.find((study) => study.study_id === entry.studyId)
          ?? await api.getStudy(entry.studyId, controller.signal);
      }
      if (controller.signal.aborted) return;

      const nextSession = researchSessionFromAuthority({
        context: nextContext,
        run: bundle?.run ?? null,
        chart: bundle?.chart ?? null,
      });
      const nextDatasetId = researchDatasetIdFromAuthority({
        context: nextContext,
        run: bundle?.run ?? null,
        datasets: nextDatasets,
      });
      const nextDataset = selectedDataset(nextDatasets, nextDatasetId);
      const range = researchRangeFromAuthority({
        context: nextContext,
        run: bundle?.run ?? null,
        dataset: nextDataset,
      });
      const runConfig = parseResearchRunConfig(bundle?.run ?? null);
      const nextRevisionId = nextContext?.strategy_revision_id
        ?? (typeof runConfig.strategy_revision_id === "string" ? runConfig.strategy_revision_id : null)
        ?? nextStudy?.strategy_revision_id
        ?? nextRevisions[0]?.revision_id
        ?? "";

      setCapabilities(nextCapabilities);
      setRuntimeMode(nextRuntimeMode);
      setDatasets(nextDatasets);
      setRuns(nextRuns);
      setStudies(nextStudies);
      setRevisions(nextRevisions);
      setLaunchContext(nextContext);
      setDraft(nextDraft);
      setActiveRun(bundle?.run ?? null);
      setReport(bundle?.report ?? null);
      setChart(bundle?.chart ?? null);
      setActiveStudy(nextStudy);
      setSelectedDatasetId(nextDatasetId);
      setSelectedRevisionId(nextRevisionId);
      setStartTimeMs(range.startTimeMs);
      setEndTimeMs(range.endTimeMs);
      setRunDraftText(researchObjectJson(composeResearchRunDraft({
        context: nextContext,
        run: bundle?.run ?? null,
        dataset: nextDataset,
        snapshot: null,
        revisionId: nextRevisionId,
        outputMode: nextRevisions.find((revision) => revision.revision_id === nextRevisionId)?.output_modes[0],
        session: nextSession,
        startTimeMs: range.startTimeMs,
        endTimeMs: range.endTimeMs,
      })));
      setStudyDraftText(researchObjectJson(composeResearchStudyDraft({
        context: nextContext,
        dataset: nextDataset,
        snapshot: null,
        revisionId: nextRevisionId,
        parameterSchema: nextRevisions.find((revision) => revision.revision_id === nextRevisionId)?.parameter_schema,
        startTimeMs: range.startTimeMs,
        endTimeMs: range.endTimeMs,
      })));
      if (bundle?.chart) setSourceMode("RUN_RESULT");
      const inferredTask = nextContext?.entry_task ?? (entry.kind === "study"
        ? "PARAMETER_ROBUSTNESS"
        : entry.kind === "context" || entry.kind === "run"
          ? "PRECISE_EXECUTION"
          : null);
      if (inferredTask) setSelectedTask((current) => current ?? inferredTask);
      setPhase("READY");
    };
    void task().catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setPhase("ERROR");
      setError(message(reason));
    });
    return () => controller.abort();
  }, [api, entry, refreshRevision]);

  const session = useMemo<ChartSession>(() => researchSessionFromAuthority({
    context: launchContext,
    run: activeRun,
    chart,
  }), [activeRun, chart, launchContext]);
  const activeDataset = useMemo(
    () => selectedDataset(datasets, selectedDatasetId),
    [datasets, selectedDatasetId],
  );

  useEffect(() => {
    if (!advancedEnabled || phase !== "READY" || !activeDataset || endTimeMs <= startTimeMs) {
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      let draftConfig: Record<string, unknown> = {};
      try { draftConfig = parseResearchObjectJson(runDraftText, "Run draft"); } catch { /* draft may be mid-edit */ }
      void api.previewSnapshot({
        dataset_id: activeDataset.dataset_id,
        data_epoch: activeDataset.data_epoch,
        start_time_ms: startTimeMs,
        end_time_ms: endTimeMs,
        interval: activeDataset.interval,
        fidelity_mode: String(draftConfig.fidelity_mode ?? activeRun?.fidelity_mode ?? "BAR_APPROX"),
        exchange: session.exchange,
        market_type: session.marketType,
        contract_data_mode: selectedTask === "PARAMETER_ROBUSTNESS"
          ? "HISTORICAL_CONTRACT_V1"
          : String(draftConfig.contract_data_mode ?? "LEGACY_FIXED_V1"),
        account_model: selectedTask === "PARAMETER_ROBUSTNESS"
          ? "LINEAR_PERP_ONE_WAY_V2"
          : String(draftConfig.account_model ?? "LINEAR_PERP_ONE_WAY_V1"),
        funding_mode: String(draftConfig.funding_mode ?? "OFF"),
      }, controller.signal).then(setSnapshot).catch((reason: unknown) => {
        if (!controller.signal.aborted) setOperationError(message(reason));
      });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    activeDataset,
    activeRun?.fidelity_mode,
    advancedEnabled,
    api,
    endTimeMs,
    phase,
    runDraftText,
    selectedTask,
    session.exchange,
    session.marketType,
    startTimeMs,
  ]);

  const activeRunId = activeRun?.run_id ?? null;
  const activeRunState = activeRun?.state ?? null;
  const activeStudyId = activeStudy?.study_id ?? null;
  const shouldPoll = Boolean(
    (activeRun && researchRunIsActive(activeRun))
    || runs.some(researchRunIsActive)
    || (activeStudy && researchStudyIsActive(activeStudy.state))
    || studies.some((study) => researchStudyIsActive(study.state)),
  );

  useEffect(() => {
    if (!advancedEnabled || !shouldPoll) {
      return undefined;
    }
    let disposed = false;
    const refresh = async () => {
      const [nextRuns, nextStudies] = await Promise.all([api.listRuns(), api.listStudies()]);
      if (disposed) return;
      setRuns(nextRuns);
      setStudies(nextStudies);
      if (activeRunId) {
        const next = nextRuns.find((run) => run.run_id === activeRunId);
        if (next && next.state !== activeRunState) {
          if (next.state === "COMPLETED") {
            const bundle = await loadRunBundle(api, next.run_id);
            if (!disposed) {
              setActiveRun(bundle.run);
              setReport(bundle.report);
              setChart(bundle.chart);
              if (bundle.chart) setSourceMode("RUN_RESULT");
            }
          } else {
            setActiveRun(next);
          }
        }
      }
      if (activeStudyId) {
        const next = nextStudies.find((study) => study.study_id === activeStudyId);
        if (next) setActiveStudy(next);
      }
    };
    void refresh().catch((reason: unknown) => {
      if (!disposed) setOperationError(message(reason));
    });
    const timer = window.setInterval(() => void refresh().catch((reason: unknown) => {
      if (!disposed) setOperationError(message(reason));
    }), 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [activeRunId, activeRunState, activeStudyId, advancedEnabled, api, shouldPoll]);

  const perform = useCallback(async (operation: () => Promise<void>) => {
    if (!advancedEnabled) {
      setOperationError("Advanced research is disabled by VITE_BACKTEST_RESEARCH_ADVANCED_ENABLED=0.");
      return;
    }
    setBusy(true);
    setOperationError(null);
    setNotice(null);
    try {
      await operation();
    } catch (reason) {
      setOperationError(message(reason));
    } finally {
      setBusy(false);
    }
  }, [advancedEnabled]);

  const refreshRuns = useCallback(async () => {
    const next = await api.listRuns();
    setRuns(next);
    return next;
  }, [api]);
  const refreshStudies = useCallback(async () => {
    const next = await api.listStudies();
    setStudies(next);
    return next;
  }, [api]);

  const resetRunDraft = useCallback(() => {
    setRunDraftText(researchObjectJson(composeResearchRunDraft({
      context: launchContext,
      run: activeRun,
      dataset: activeDataset,
      snapshot,
      revisionId: selectedRevisionId,
      outputMode: revisions.find((revision) => revision.revision_id === selectedRevisionId)?.output_modes[0],
      session,
      startTimeMs,
      endTimeMs,
    })));
  }, [activeDataset, activeRun, endTimeMs, launchContext, revisions, selectedRevisionId, session, snapshot, startTimeMs]);
  const resetStudyDraft = useCallback(() => {
    setStudyDraftText(researchObjectJson(composeResearchStudyDraft({
      context: launchContext,
      dataset: activeDataset,
      snapshot,
      revisionId: selectedRevisionId,
      parameterSchema: revisions.find((revision) => revision.revision_id === selectedRevisionId)?.parameter_schema,
      startTimeMs,
      endTimeMs,
    })));
  }, [activeDataset, endTimeMs, launchContext, revisions, selectedRevisionId, snapshot, startTimeMs]);

  const acceptStrategyRevision = useCallback((revision: StrategyRevisionRecord) => {
    setRevisions((current) => [revision, ...current.filter((item) => item.revision_id !== revision.revision_id)]);
    setSelectedRevisionId(revision.revision_id);
  }, []);

  const effectivePhase = entry.kind === "invalid" ? "ERROR" : phase;
  const effectiveError = entry.kind === "invalid" ? entry.message : error;
  return {
    view: {
      phase: effectivePhase,
      error: effectiveError,
      advancedEnabled,
      capabilities,
      runtimeMode,
      selectedTask,
      sourceMode,
      launchContext,
      draft,
      revisions,
      datasets,
      runs,
      studies,
      activeRun,
      report,
      chart,
      activeStudy,
      session,
      returnHref: researchReturnHref(launchContext),
      busy,
      notice,
      operationError,
      selectedDatasetId,
      selectedRevisionId,
      startTimeMs,
      endTimeMs,
      snapshot,
      runDraftText,
      studyDraftText,
      runComparison,
      studyComparison,
      signalTrace,
      reviewBridge,
      pythonGate,
    },
    actions: {
      selectTask: (task) => {
        setSnapshot(null);
        setSelectedTask(task);
      },
      selectSourceMode: setSourceMode,
      openRun,
      openStudy,
      refresh: () => {
        setError(null);
        setPhase("LOADING");
        setRefreshRevision((value) => value + 1);
      },
      selectDataset: (datasetId) => {
        const next = selectedDataset(datasets, datasetId);
        setSelectedDatasetId(next?.dataset_id ?? "");
        setSnapshot(null);
        if (next) {
          setStartTimeMs(next.first_open_ms ?? 0);
          setEndTimeMs(next.last_close_ms ?? 0);
        }
      },
      selectRevision: (revisionId) => {
        const parameterSchema = revisions.find((revision) => revision.revision_id === revisionId)?.parameter_schema;
        setSelectedRevisionId(revisionId);
        setRunDraftText(researchObjectJson(composeResearchRunDraft({
          context: launchContext,
          run: activeRun,
          dataset: activeDataset,
          snapshot,
          revisionId,
          outputMode: revisions.find((revision) => revision.revision_id === revisionId)?.output_modes[0],
          session,
          startTimeMs,
          endTimeMs,
        })));
        setStudyDraftText(researchObjectJson(composeResearchStudyDraft({
          context: launchContext,
          dataset: activeDataset,
          snapshot,
          revisionId,
          parameterSchema,
          startTimeMs,
          endTimeMs,
        })));
      },
      setRange: (start, end) => {
        setSnapshot(null);
        setStartTimeMs(start);
        setEndTimeMs(end);
      },
      setRunDraftText: (text) => {
        setSnapshot(null);
        setRunDraftText(text);
      },
      resetRunDraft,
      setStudyDraftText,
      resetStudyDraft,
      createStrategyRevision: async (body) => perform(async () => {
        const revision = await api.createStrategyRevision(body);
        acceptStrategyRevision(revision);
        setNotice(`Revision ${revision.revision_id} compiled.`);
      }),
      copyStrategyRevision: async () => perform(async () => {
        if (!selectedRevisionId) throw new Error("Select a strategy revision first.");
        const revision = await api.copyStrategyRevision(selectedRevisionId, `Copy of ${selectedRevisionId}`);
        acceptStrategyRevision(revision);
        setNotice(`Revision ${revision.revision_id} copied.`);
      }),
      archiveStrategyRevision: async () => perform(async () => {
        if (!selectedRevisionId) throw new Error("Select a strategy revision first.");
        await api.archiveStrategyRevision(selectedRevisionId);
        const [nextCapabilities, customRevisions] = await Promise.all([
          api.capabilities(),
          api.listStrategyRevisions(),
        ]);
        const next = [...new Map([
          ...nextCapabilities.strategies,
          ...customRevisions,
        ].map((revision) => [revision.revision_id, revision])).values()];
        setCapabilities(nextCapabilities);
        setRevisions(next);
        setSelectedRevisionId(next[0]?.revision_id ?? "");
        setNotice("Revision archived.");
      }),
      smokeStrategyRevision: async () => perform(async () => {
        if (!activeDataset || !snapshot || !selectedRevisionId) {
          throw new Error("Dataset snapshot and strategy revision are required.");
        }
        const config = parseResearchObjectJson(runDraftText, "Run draft");
        await api.smokeStrategyRevision(selectedRevisionId, {
          dataset_id: activeDataset.dataset_id,
          snapshot_hash: snapshot.snapshot_hash,
          start_time_ms: startTimeMs,
          end_time_ms: Math.min(endTimeMs, startTimeMs + 7 * 86_400_000),
          parameters: config.parameters ?? {},
          ...(pythonGate ? {
            python_runtime_mode: pythonGate.runtimeMode,
            python_trusted_confirmed: pythonGate.runtimeMode === "TRUSTED_LOCAL" && pythonGate.trustedConfirmed,
          } : {}),
        });
        setNotice("Strategy smoke test passed.");
      }),
      createRun: async () => perform(async () => {
        if (!activeDataset || !snapshot || !selectedRevisionId) {
          throw new Error("Dataset snapshot and strategy revision are required.");
        }
        const body = normalizeResearchRunDraft({
          draft: parseResearchObjectJson(runDraftText, "Run draft"),
          dataset: activeDataset,
          snapshot,
          revisionId: selectedRevisionId,
          session,
          startTimeMs,
          endTimeMs,
        });
        await api.validate(body);
        const created = await api.createRun(body, idempotencyKey("research-run"));
        await refreshRuns();
        await openRun(created.run_id);
        setNotice(t("research.notice.runCreated", { id: created.run_id }));
      }),
      cancelRun: async () => perform(async () => {
        if (!activeRun) throw new Error("Select a Run first.");
        const next = await api.cancelRun(activeRun.run_id);
        setActiveRun(next);
        await refreshRuns();
        setNotice(`Run ${next.run_id} cancel requested.`);
      }),
      resumeRun: async () => perform(async () => {
        if (!activeRun) throw new Error("Select a Run first.");
        const next = await api.resumeRun(activeRun.run_id);
        setActiveRun(next);
        await refreshRuns();
        setNotice(`Run ${next.run_id} resumed.`);
      }),
      cloneRun: async (parameter, value) => perform(async () => {
        if (!activeRun) throw new Error("Select a Run first.");
        const cloned = await api.cloneRun(activeRun.run_id, parameter, value, idempotencyKey("research-clone"));
        await refreshRuns();
        await openRun(cloned.run_id);
        setNotice(`Run ${cloned.run_id} cloned from ${activeRun.run_id}.`);
      }),
      compareRun: async (otherRunId) => perform(async () => {
        if (!activeRun || !otherRunId) throw new Error("Select two Runs first.");
        setRunComparison(await api.compareRuns(otherRunId, activeRun.run_id));
        setNotice("Run comparison loaded.");
      }),
      exportRun: async () => perform(async () => {
        if (!activeRun) throw new Error("Select a Run first.");
        const payload = await api.exportRun(activeRun.run_id);
        downloadJson(`${activeRun.run_id}.backtest.json`, payload);
        setNotice(`Run ${activeRun.run_id} export generated by the server.`);
      }),
      loadSignalTrace: async () => perform(async () => {
        if (!activeRun) throw new Error("Select a Run first.");
        const page = await api.getSignalTrace(activeRun.run_id, 0, 1_000);
        setSignalTrace(page.items);
        setNotice(t("research.notice.traceLoaded", { count: page.items.length }));
      }),
      createStudy: async () => perform(async () => {
        if (!activeDataset || !snapshot || !selectedRevisionId) {
          throw new Error("Dataset snapshot and strategy revision are required.");
        }
        const revision = revisions.find((item) => item.revision_id === selectedRevisionId);
        if (!revision?.output_modes.includes("SIGNAL")) {
          throw new Error("Study V2 requires a strategy revision that outputs SIGNAL.");
        }
        if ((snapshot.quality.contract_data as Record<string, unknown> | undefined)?.status !== "complete") {
          throw new Error("Study V2 requires complete historical contract roles in the selected snapshot.");
        }
        const body = normalizeResearchStudyDraft({
          draft: parseResearchObjectJson(studyDraftText, "Study draft"),
          dataset: activeDataset,
          snapshot,
          revisionId: selectedRevisionId,
          startTimeMs,
          endTimeMs,
        });
        const created = await api.createStudy(body);
        await refreshStudies();
        setActiveStudy(created);
        setStudyComparison(null);
        setNotice(t("research.notice.studyCreated", { id: created.study_id, state: created.state }));
      }),
      startStudy: async () => perform(async () => {
        if (!activeStudy || activeStudy.state !== "CREATED") {
          throw new Error("Select a Study in CREATED state first.");
        }
        const next = await api.startStudy(activeStudy.study_id);
        setActiveStudy(next);
        await refreshStudies();
        setNotice(t("research.notice.studyStarted", { id: next.study_id }));
      }),
      cancelStudy: async () => perform(async () => {
        if (!activeStudy) throw new Error("Select a Study first.");
        const next = await api.cancelStudy(activeStudy.study_id);
        setActiveStudy(next);
        await refreshStudies();
        setNotice(`Study ${next.study_id} cancel requested.`);
      }),
      revealStudyHoldout: async () => perform(async () => {
        if (!activeStudy) throw new Error("Select a Study first.");
        const next = await api.revealStudyHoldout(activeStudy.study_id);
        setActiveStudy(next);
        await refreshStudies();
        setNotice(`Study ${next.study_id} holdout revealed by the server.`);
      }),
      compareStudy: async () => perform(async () => {
        if (!activeStudy) throw new Error("Select a Study first.");
        setStudyComparison(await api.compareStudy(activeStudy.study_id));
        setNotice("Study comparison loaded.");
      }),
      createReviewBridge: async () => perform(async () => {
        if (!activeRun || activeRun.state !== "COMPLETED") {
          throw new Error("Select a completed Run first.");
        }
        if (capabilities?.flags.BACKTEST_REPLAY_REVIEW_BRIDGE_ENABLED !== true
          || capabilities.flags.BACKTEST_REPLAY_TRAINING_AVAILABLE !== true) {
          throw new Error("Replay TrainingRun runtime is unavailable.");
        }
        const bridge = await api.createReviewBridge(activeRun.run_id, startTimeMs, endTimeMs);
        setReviewBridge(bridge);
        setNotice(t("research.notice.bridgeCreated", { id: String(bridge.bridgeId ?? "") }));
      }),
      revealReviewBridge: async () => perform(async () => {
        const bridgeId = typeof reviewBridge?.bridgeId === "string" ? reviewBridge.bridgeId : "";
        if (!bridgeId) throw new Error("Create a replay review bridge first.");
        const revealed = await api.revealReviewBridge(bridgeId);
        setReviewBridge({ ...reviewBridge, ...revealed });
        setNotice(`Replay review bridge ${bridgeId} revealed by the server.`);
      }),
      setBusy,
      setNotice,
      setOperationError,
      acceptStrategyRevision,
      setPythonGate,
    },
  };
}
