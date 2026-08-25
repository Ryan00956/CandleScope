import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ChartSession } from "../chart-session/chartSessionTypes.js";
import { defaultBacktestApi, type ChartContextResolution } from "../backtest/backtestApi.js";
import {
  chartStrategyResultCache,
  type ChartStrategyResultBundle,
} from "../backtest/chart-tester/chartStrategyResultCache.js";
import {
  ChartStrategyRunError,
  chartStrategyRunDiagnostics,
  qualitySummaryFromImportedManifest,
  runResearchBacktest,
} from "../backtest/chart-tester/chartStrategyRunRequest.js";
import { ChartStrategyTesterRuntime } from "../backtest/chart-tester/ChartStrategyTesterRuntime.js";
import type {
  ChartStrategyTesterStaleReason,
  ChartStrategyTesterStatus,
} from "../backtest/chart-tester/chartStrategyTesterState.js";
import type { ChartStrategyRunRequest } from "../backtest/chart-tester/chartStrategyTesterUiModel.js";
import type { LocalDatasetManifest } from "../local-data/localDataTypes.js";
import type { ResearchRuntimeMode, ResearchSourceRefV1 } from "../research-data/researchDataTypes.js";

export function sessionFromResearchSource(
  source: ResearchSourceRefV1 | null,
  imported: LocalDatasetManifest | null,
  interval: string | null,
): ChartSession | null {
  if (source?.kind === "CURRENT_CHART") {
    return {
      exchange: source.exchange,
      marketType: source.marketType,
      symbol: source.symbol,
      interval: source.interval,
    };
  }
  if (source?.kind === "IMPORTED_DATASET" && imported !== null) {
    return {
      exchange: "local",
      marketType: "spot",
      symbol: imported.symbol,
      interval: interval ?? imported.interval,
    };
  }
  return null;
}

export function useStrategyResearchRun(input: {
  source: ResearchSourceRefV1 | null;
  imported: LocalDatasetManifest | null;
  interval: string | null;
  runtimeMode: ResearchRuntimeMode;
  onRunId(runId: string | null): void;
}) {
  const tester = useMemo(() => new ChartStrategyTesterRuntime("strategy-research", null), []);
  const [, setTesterVersion] = useState(0);
  const [result, setResult] = useState<ChartStrategyResultBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsData, setNeedsData] = useState<ChartContextResolution | null>(null);
  const pendingRequestRef = useRef<ChartStrategyRunRequest | null>(null);
  const session = sessionFromResearchSource(input.source, input.imported, input.interval);

  useEffect(() => tester.subscribe(() => setTesterVersion((value) => value + 1)), [tester]);
  useEffect(() => () => tester.dispose(), [tester]);

  useEffect(() => {
    const source = input.source;
    tester.syncInputs(session && source ? {
      session,
      attachment: {
        schemaVersion: 1,
        strategyDraftId: "draft-placeholder",
        strategyRevisionId: null,
        displayName: "",
        language: "pyne",
        parameters: {},
        rangeMode: "ALL_AVAILABLE",
        customRange: null,
        fidelityPreference: "FAST",
        quickPresetId: session.marketType === "spot" ? "CRYPTO_SPOT_STANDARD_V1" : "CRYPTO_PERP_STANDARD_V1",
        autoRun: false,
      },
      draftContentRevision: 0,
      sourceKind: source.kind,
      ...(source.kind === "IMPORTED_DATASET"
        ? { datasetId: source.datasetId, dataEpoch: source.dataEpoch }
        : {}),
    } : null);
  }, [input.source, session, tester]);

  const snapshot = tester.snapshot();
  const barOnly = input.source?.kind === "IMPORTED_DATASET";

  const execute = useCallback(async (request: ChartStrategyRunRequest, materialize?: ChartContextResolution | null) => {
    pendingRequestRef.current = request;
    setError(null);
    const token = tester.beginRequest("RESOLVING");
    try {
      const source = input.source;
      if (source === null) throw new Error("source required");
      if (input.runtimeMode === "LOCAL_OFFLINE" && (source.kind === "CURRENT_CHART" || materialize)) {
        throw new ChartStrategyRunError(
          "OFFLINE_LIVE_SOURCE_UNAVAILABLE",
          "live market data is unavailable in the offline runtime",
          { next_step: "use imported library data" },
        );
      }
      const researchSource = source.kind === "IMPORTED_DATASET" && input.imported
        ? {
          kind: "IMPORTED_DATASET" as const,
          datasetId: source.datasetId,
          dataEpoch: source.dataEpoch,
          interval: input.interval ?? source.interval,
          symbol: input.imported.symbol,
          startTimeMs: input.imported.first_open_ms,
          endTimeMs: input.imported.last_open_ms + 1,
          quality: qualitySummaryFromImportedManifest({
            rows: input.imported.rows,
            excludedRangeCount: input.imported.excluded_range_count,
            volumeAvailable: input.imported.volume_available,
          }),
        }
        : {
          kind: "CURRENT_CHART" as const,
          ...(materialize ? { materializeResolution: materialize } : {}),
        };
      const outcome = await runResearchBacktest({
        api: defaultBacktestApi,
        request,
        source: researchSource,
        onResolution(resolution) {
          tester.dispatch({
            type: "REQUEST_STATUS",
            token,
            status: resolution.status === "NEEDS_DATA" ? "NEEDS_DATA" : "RESOLVING",
          });
        },
        onRunCreated(run, identity) {
          input.onRunId(run.run_id);
          tester.dispatch({
            type: "REQUEST_STATUS",
            token,
            status: run.state === "QUEUED" ? "QUEUED" : "RUNNING",
            activeRunId: run.run_id,
          });
          void identity;
        },
      });
      if (outcome.kind === "NEEDS_DATA") {
        setNeedsData(outcome.resolution);
        tester.dispatch({ type: "REQUEST_STATUS", token, status: "NEEDS_DATA" });
        return;
      }
      setNeedsData(null);
      if (outcome.kind !== "TERMINAL") {
        tester.dispatch({
          type: "REQUEST_FAILED",
          token,
          error: { code: outcome.resolution.status, message: outcome.resolution.status, action: null },
        });
        return;
      }
      tester.dispatch({ type: "REQUEST_COMPLETED", token, identity: outcome.identity });
      const bundle = await chartStrategyResultCache.load(defaultBacktestApi, outcome.run.run_id);
      setResult(bundle);
    } catch (reason) {
      const diagnostics = chartStrategyRunDiagnostics(reason);
      setError(diagnostics.message);
      tester.dispatch({
        type: "REQUEST_FAILED",
        token,
        error: { code: diagnostics.code, message: diagnostics.message, action: diagnostics.action },
      });
    }
  }, [input, tester]);

  const onRun = useCallback((request: ChartStrategyRunRequest) => {
    void execute(request, null);
  }, [execute]);

  const onConfirmNeedsData = useCallback(() => {
    const pending = pendingRequestRef.current;
    if (pending === null || needsData === null) return;
    void execute(pending, needsData);
  }, [execute, needsData]);

  return {
    session,
    barOnly,
    runStatus: snapshot.status as ChartStrategyTesterStatus,
    stale: snapshot.status === "STALE",
    staleReasons: snapshot.staleReasons as ChartStrategyTesterStaleReason[],
    result,
    error,
    needsData: needsData !== null,
    onRun,
    onConfirmNeedsData,
    tester,
  };
}
