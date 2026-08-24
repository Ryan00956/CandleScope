import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChartSession } from "../../chart-session/chartSessionTypes.js";
import { defaultBacktestApi, type BacktestApiClient } from "../backtestApi.js";
import { parseBacktestResearchEntry } from "../backtestDeepLink.js";
import type {
  BacktestChartData,
  BacktestReport,
  BacktestResearchLaunchContext,
  BacktestRunRecord,
  BacktestStudyRecord,
} from "../backtestTypes.js";
import { getChartStrategyDraftStore } from "../chart-tester/chartStrategyTesterDrafts.js";
import type { StrategyDraftRecord } from "../chart-tester/StrategyDraftStore.js";
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
  signal: AbortSignal,
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

export function useBacktestResearchRuntime(options: {
  api?: BacktestApiClient;
  search?: string;
} = {}): BacktestResearchRuntime {
  const api = options.api ?? defaultBacktestApi;
  const search = options.search ?? (typeof window === "undefined" ? "" : window.location.search);
  const entry = useMemo(() => parseBacktestResearchEntry(search), [search]);
  const [selectedTask, setSelectedTask] = useState<BacktestResearchTask | null>(null);
  const [sourceMode, setSourceMode] = useState<BacktestResearchRuntime["view"]["sourceMode"]>("LIVE_REFERENCE");
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [phase, setPhase] = useState<BacktestResearchRuntime["view"]["phase"]>("LOADING");
  const [error, setError] = useState<string | null>(null);
  const [runtimeMode, setRuntimeMode] = useState<BacktestResearchRuntime["view"]["runtimeMode"]>(null);
  const [launchContext, setLaunchContext] = useState<BacktestResearchLaunchContext | null>(null);
  const [draft, setDraft] = useState<StrategyDraftRecord | null>(null);
  const [revisions, setRevisions] = useState<BacktestResearchRuntime["view"]["revisions"]>([]);
  const [datasets, setDatasets] = useState<BacktestResearchRuntime["view"]["datasets"]>([]);
  const [runs, setRuns] = useState<BacktestRunRecord[]>([]);
  const [studies, setStudies] = useState<BacktestStudyRecord[]>([]);
  const [activeRun, setActiveRun] = useState<BacktestRunRecord | null>(null);
  const [report, setReport] = useState<BacktestReport | null>(null);
  const [chart, setChart] = useState<BacktestChartData | null>(null);
  const [activeStudy, setActiveStudy] = useState<BacktestStudyRecord | null>(null);

  const openRun = useCallback(async (runId: string) => {
    const controller = new AbortController();
    try {
      const bundle = await loadRunBundle(api, runId, controller.signal);
      setActiveRun(bundle.run);
      setReport(bundle.report);
      setChart(bundle.chart);
      setSourceMode(bundle.chart ? "RUN_RESULT" : "LIVE_REFERENCE");
    } catch (reason) {
      setError(message(reason));
    }
  }, [api]);

  const openStudy = useCallback(async (studyId: string) => {
    try {
      const existing = studies.find((study) => study.study_id === studyId);
      setActiveStudy(existing ?? await api.getStudy(studyId));
    } catch (reason) {
      setError(message(reason));
    }
  }, [api, studies]);

  useEffect(() => {
    if (entry.kind === "invalid") {
      return undefined;
    }
    const controller = new AbortController();
    const task = async () => {
      const [capabilities, nextDatasets, nextRuns, nextStudies, customRevisions] = await Promise.all([
        api.capabilities(controller.signal),
        api.listDatasets(controller.signal),
        api.listRuns(controller.signal),
        api.listStudies(controller.signal),
        api.listStrategyRevisions(controller.signal),
      ]);
      if (controller.signal.aborted) return;
      const nextRuntimeMode = capabilities.runtime_mode
        ?? await loadHostRuntimeMode(controller.signal);
      if (controller.signal.aborted) return;
      setRuntimeMode(nextRuntimeMode);
      setDatasets(nextDatasets);
      setRuns(nextRuns);
      setStudies(nextStudies);
      const revisionMap = new Map([
        ...capabilities.strategies,
        ...customRevisions,
      ].map((revision) => [revision.revision_id, revision]));
      setRevisions([...revisionMap.values()]);

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
      setLaunchContext(nextContext);
      setDraft(nextDraft);
      setActiveRun(bundle?.run ?? null);
      setReport(bundle?.report ?? null);
      setChart(bundle?.chart ?? null);
      setActiveStudy(nextStudy);
      if (bundle?.chart) setSourceMode("RUN_RESULT");
      const inferredTask = entry.kind === "study"
        ? "PARAMETER_ROBUSTNESS"
        : entry.kind === "context" || entry.kind === "run"
          ? "PRECISE_EXECUTION"
          : null;
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

  const effectivePhase = entry.kind === "invalid" ? "ERROR" : phase;
  const effectiveError = entry.kind === "invalid" ? entry.message : error;
  return {
    view: {
      phase: effectivePhase,
      error: effectiveError,
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
    },
    actions: {
      selectTask: setSelectedTask,
      selectSourceMode: setSourceMode,
      openRun,
      openStudy,
      refresh: () => {
        setError(null);
        setPhase("LOADING");
        setRefreshRevision((value) => value + 1);
      },
    },
  };
}
