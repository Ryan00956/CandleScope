import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { computeIndicatorBatch } from "../../services/indicatorApi.js";
import { markPerf, recordPerfEvent } from "../../runtime/performance/perfMarks.js";
import {
  buildIndicatorComputeParams,
  buildIndicatorOhlcv,
  buildIndicatorOhlcvSignature,
  chunkIndicatorComputeJobs,
  collectIndicatorComputeResults,
  resolveIndicatorComputeDelay,
  resolveSeriesReadyComputeDelay,
  shouldDeferIndicatorCompute,
} from "./indicatorComputeRuntime.js";
import {
  buildIndicatorComputeJobKey,
  buildIndicatorComputeLifecycleKey,
  createIndicatorComputeJobCoordinator,
  resolveLocalIndicatorExecution,
} from "./indicatorComputeJobRuntime.js";
import {
  buildIndicatorCacheContext,
  cacheIndicatorSnapshot,
  removeCachedIndicatorResult,
} from "./indicatorResultCacheStore.js";
import type { ChartDataCommitMeta } from "../market-data/useChartDataRuntime.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type {
  IndicatorComputeRequest,
  IndicatorComputeBatchItem,
  IndicatorComputeBatchJob,
  IndicatorDefinition,
  IndicatorOutputAction,
} from "./indicatorTypes.js";

export interface UseIndicatorComputeControllerOptions {
  activeIndicators: IndicatorDefinition[];
  activeIndicatorsRef: MutableRefObject<IndicatorDefinition[]>;
  candleDownColor: string;
  candleDownColorRef: MutableRefObject<string>;
  candleUpColor: string;
  candleUpColorRef: MutableRefObject<string>;
  chartData: KlineBar[];
  chartDataMeta: ChartDataCommitMeta | null;
  chartDataMetaRef: MutableRefObject<ChartDataCommitMeta | null>;
  chartDataRef: MutableRefObject<KlineBar[]>;
  datasetKey: string;
  exchange: string;
  forceHostedSubscriptions(): void;
  interval: string;
  marketType: string;
  outputDispatch: Dispatch<IndicatorOutputAction>;
  pendingForceComputeRef: MutableRefObject<boolean>;
  seriesReady: number;
  setActiveIndicators: Dispatch<SetStateAction<IndicatorDefinition[]>>;
  symbol: string;
}

export interface IndicatorComputeController {
  computeAll(force?: boolean): Promise<void>;
  computing: boolean;
  recompute(force?: boolean): void;
}

export function buildLocalIndicatorPlanSignature(
  indicators: IndicatorDefinition[],
  candleUpColor: string,
  candleDownColor: string,
): string {
  const keys = indicators
    .filter((indicator) => indicator.executionTarget === "local")
    .map((indicator) => {
      const params = buildIndicatorComputeParams(indicator, {
        candleUpColor,
        candleDownColor,
      });
      return buildIndicatorComputeJobKey({
        indicator,
        lifecycleKey: "indicator-local-plan",
        params,
      });
    })
    .sort();
  return JSON.stringify(keys);
}

export function resolveSubmittedLocalJobKeysById({
  candleDownColor,
  candleUpColor,
  indicators,
  lifecycleKey,
  submittedJobKeys,
}: {
  candleDownColor: string;
  candleUpColor: string;
  indicators: readonly IndicatorDefinition[];
  lifecycleKey: string;
  submittedJobKeys: ReadonlySet<string>;
}): Map<string, string> {
  const result = new Map<string, string>();
  for (const indicator of indicators) {
    if (resolveLocalIndicatorExecution(indicator).kind !== "local") continue;
    const params = buildIndicatorComputeParams(indicator, {
      candleUpColor,
      candleDownColor,
    });
    const jobKey = buildIndicatorComputeJobKey({ indicator, lifecycleKey, params });
    if (submittedJobKeys.has(jobKey)) result.set(indicator.id, jobKey);
  }
  return result;
}

export function useIndicatorComputeController({
  activeIndicators,
  activeIndicatorsRef,
  candleDownColor,
  candleDownColorRef,
  candleUpColor,
  candleUpColorRef,
  chartData,
  chartDataMeta,
  chartDataMetaRef,
  chartDataRef,
  datasetKey,
  exchange,
  forceHostedSubscriptions,
  interval,
  marketType,
  outputDispatch,
  pendingForceComputeRef,
  seriesReady,
  setActiveIndicators,
  symbol,
}: UseIndicatorComputeControllerOptions): IndicatorComputeController {
  const [computing, setComputing] = useState(false);
  const [jobCoordinator] = useState(() => createIndicatorComputeJobCoordinator());
  const userTriggeredRef = useRef(false);
  const hasExplicitLocalIndicator = activeIndicators.some(
    (indicator) => indicator.executionTarget === "local",
  );
  const desiredDataSignature = useMemo(
    () => hasExplicitLocalIndicator
      ? buildIndicatorOhlcvSignature(chartData || [])
      : "hosted-only",
    [chartData, hasExplicitLocalIndicator],
  );
  const desiredPlanSignature = useMemo(() => buildLocalIndicatorPlanSignature(
    activeIndicators,
    candleUpColor,
    candleDownColor,
  ), [activeIndicators, candleDownColor, candleUpColor]);
  const desiredLifecycleKey = buildIndicatorComputeLifecycleKey({
    dataSignature: JSON.stringify([desiredDataSignature, desiredPlanSignature]),
    datasetKey,
    exchange,
    interval,
    marketType,
    symbol,
  });
  const committedRuntimeRef = useRef({
    context: { datasetKey, exchange, interval, marketType, symbol },
    lifecycleKey: desiredLifecycleKey,
  });

  const computeAll = useCallback(async (force = false) => {
    const showUI = userTriggeredRef.current;
    userTriggeredRef.current = false;
    const currentChartData = chartDataRef.current;
    const currentIndicators = activeIndicatorsRef.current;
    const committedRuntime = committedRuntimeRef.current;
    const context = committedRuntime.context;
    const lifecycleKey = committedRuntime.lifecycleKey;

    if (!currentChartData || currentChartData.length === 0) {
      recordPerfEvent("indicator.compute.skip", { reason: "no-chart-data" });
      return;
    }

    jobCoordinator.activate(lifecycleKey);

    const invalid = new Map<string, string>();
    const localIndicators = currentIndicators.flatMap((indicator) => {
      const resolution = resolveLocalIndicatorExecution(indicator);
      if (resolution.kind === "invalid") {
        invalid.set(indicator.id, resolution.error);
        return [];
      }
      return resolution.kind === "local" ? [{ indicator, execution: resolution.execution }] : [];
    });
    if (invalid.size > 0) {
      setActiveIndicators((previous) => {
        let changed = false;
        const next = previous.map((indicator) => {
          const error = invalid.get(indicator.id);
          if (!error || indicator.error === error) return indicator;
          changed = true;
          return { ...indicator, error };
        });
        return changed ? next : previous;
      });
    }
    if (localIndicators.length === 0) {
      recordPerfEvent("indicator.compute.skip", { reason: "no-local-indicators" });
      return;
    }

    if (showUI) setComputing(true);
    const ohlcv = buildIndicatorOhlcv(currentChartData);
    const targetByJobKey = new Map<string, {
      indicator: IndicatorDefinition;
      job: IndicatorComputeBatchJob;
    }>();
    for (const { indicator, execution } of localIndicators) {
      const params = buildIndicatorComputeParams(indicator, {
        candleUpColor: candleUpColorRef.current,
        candleDownColor: candleDownColorRef.current,
      });
      const jobKey = buildIndicatorComputeJobKey({ indicator, lifecycleKey, params });
      const request: IndicatorComputeRequest = {
        mode: execution.mode,
        ohlcv,
        params,
        exchange: context.exchange,
        symbol: context.symbol,
        interval: context.interval,
        marketType: context.marketType,
      };
      if (execution.name !== undefined) request.name = execution.name;
      if (execution.script !== undefined) request.script = execution.script;
      if (execution.securityMode !== undefined) request.securityMode = execution.securityMode;
      targetByJobKey.set(jobKey, {
        indicator,
        job: { clientId: indicator.id, jobKey, request },
      });
    }
    const jobs = Array.from(targetByJobKey.values()).map((target) => target.job);
    const cacheContext = buildIndicatorCacheContext({
      candleDownColor: candleDownColorRef.current,
      candleUpColor: candleUpColorRef.current,
      exchange: context.exchange,
      interval: context.interval,
      marketType: context.marketType,
      symbol: context.symbol,
    });
    const submittedJobKeys = new Set<string>();
    try {
      const scheduled = await jobCoordinator.schedule<
        IndicatorComputeBatchJob,
        IndicatorComputeBatchItem
      >({
        force,
        isResultComplete: (result) => result.payload.ok === false,
        jobs,
        lifecycleKey,
        execute: async (physicalJobs, signal) => {
          const startedAt = performance.now();
          const chunks = chunkIndicatorComputeJobs(physicalJobs);
          for (const job of physicalJobs) {
            submittedJobKeys.add(job.jobKey);
            removeCachedIndicatorResult(
              targetByJobKey.get(job.jobKey)?.indicator,
              cacheContext,
            );
          }
          markPerf("indicator.compute.start", {
            force,
            indicatorCount: physicalJobs.length,
            bars: currentChartData.length,
            symbol: context.symbol,
            interval: context.interval,
            marketType: context.marketType,
            exchange: context.exchange,
            lifecycleKey,
            physicalRequestCount: chunks.length,
          });
          try {
            const responses = await Promise.all(
              chunks.map((chunk) => computeIndicatorBatch({ jobs: chunk, signal })),
            );
            return responses.flatMap((response) => response.results);
          } finally {
            markPerf("indicator.compute.end", {
              force,
              indicatorCount: physicalJobs.length,
              bars: currentChartData.length,
              symbol: context.symbol,
              interval: context.interval,
              marketType: context.marketType,
              exchange: context.exchange,
              lifecycleKey,
              durationMs: performance.now() - startedAt,
              physicalRequestCount: chunks.length,
            });
          }
        },
      });
      recordPerfEvent("indicator.compute.plan", {
        force,
        lifecycleKey,
        joined: scheduled.joined,
        queued: scheduled.queued,
        skipped: scheduled.skipped,
        stale: scheduled.stale,
      });
      if (scheduled.stale || scheduled.results.length === 0) return;
      if (committedRuntimeRef.current.lifecycleKey !== lifecycleKey) return;

      const acceptedJobKeyById = new Map<string, string>();
      const accepted = scheduled.results.flatMap((result) => {
        const target = targetByJobKey.get(result.jobKey);
        if (!target || result.clientId !== target.indicator.id) return [];
        const currentIndicator = activeIndicatorsRef.current.find(
          (indicator) => indicator.id === target.indicator.id,
        );
        if (!currentIndicator) return [];
        const currentResolution = resolveLocalIndicatorExecution(currentIndicator);
        if (currentResolution.kind !== "local") return [];
        const currentParams = buildIndicatorComputeParams(currentIndicator, {
          candleUpColor: candleUpColorRef.current,
          candleDownColor: candleDownColorRef.current,
        });
        if (buildIndicatorComputeJobKey({
          indicator: currentIndicator,
          lifecycleKey,
          params: currentParams,
        }) !== result.jobKey) return [];
        acceptedJobKeyById.set(currentIndicator.id, result.jobKey);
        return [{
          status: "fulfilled" as const,
          value: {
            id: currentIndicator.id,
            result: result.payload,
            visible: Boolean(currentIndicator.visible),
          },
        }];
      });
      if (accepted.length === 0) return;

      const {
        processedResults,
        allMarkers,
        allFills,
        allHlines,
        allBgcolors,
        allBarcolors,
        allSignals,
        newParamSchemas,
      } = collectIndicatorComputeResults(accepted, { parsed: true });
      const indicatorById = new Map(
        activeIndicatorsRef.current.map((indicator) => [indicator.id, indicator]),
      );
      const cachedJobKeys: string[] = [];
      for (const { id, normalized, error } of processedResults) {
        if (error || !normalized) continue;
        const cached = cacheIndicatorSnapshot(
          indicatorById.get(id),
          cacheContext,
          normalized,
          newParamSchemas[id],
        );
        const jobKey = acceptedJobKeyById.get(id);
        if (cached && jobKey) cachedJobKeys.push(jobKey);
      }
      jobCoordinator.complete(cachedJobKeys);

      startTransition(() => {
        outputDispatch({
          type: "compute-results",
          processedIds: processedResults.map((item) => item.id),
          markers: allMarkers,
          fills: allFills,
          hlines: allHlines,
          bgcolors: allBgcolors,
          barcolors: allBarcolors,
          signals: allSignals,
          paramSchemas: newParamSchemas,
        });

        setActiveIndicators((prev) => {
          const updated = [...prev];
          for (const { id, mappedLines, error } of processedResults) {
            const index = updated.findIndex((indicator) => indicator.id === id);
            if (index === -1) continue;
            const current = updated[index];
            if (current === undefined) continue;
            const paramSchema = newParamSchemas[id];
            updated[index] = {
              ...current,
              lines: mappedLines,
              error,
              ...(paramSchema ? { paramSchema } : {}),
            };
          }
          return updated;
        });
      });
    } catch (error) {
      if (committedRuntimeRef.current.lifecycleKey === lifecycleKey) {
        const message = error instanceof Error ? error.message : String(error);
        const failedJobKeysById = resolveSubmittedLocalJobKeysById({
          candleDownColor: candleDownColorRef.current,
          candleUpColor: candleUpColorRef.current,
          indicators: activeIndicatorsRef.current,
          lifecycleKey,
          submittedJobKeys,
        });
        if (failedJobKeysById.size === 0) return;

        // A transport failure invalidates every physically submitted result.
        // Clear both chart lines and auxiliary trading signals immediately so
        // stale output cannot masquerade as a current computation.
        outputDispatch({
          type: "compute-results",
          processedIds: Array.from(failedJobKeysById.keys()),
          markers: [],
          fills: [],
          hlines: [],
          bgcolors: [],
          barcolors: [],
          signals: [],
          paramSchemas: {},
        });
        setActiveIndicators((previous) => {
          let changed = false;
          const next = previous.map((indicator) => {
            const failedJobKey = failedJobKeysById.get(indicator.id);
            if (!failedJobKey) return indicator;
            if (resolveLocalIndicatorExecution(indicator).kind !== "local") return indicator;
            const params = buildIndicatorComputeParams(indicator, {
              candleUpColor: candleUpColorRef.current,
              candleDownColor: candleDownColorRef.current,
            });
            const currentJobKey = buildIndicatorComputeJobKey({
              indicator,
              lifecycleKey,
              params,
            });
            if (currentJobKey !== failedJobKey) {
              return indicator;
            }
            if ((indicator.lines?.length ?? 0) === 0 && indicator.error === message) {
              return indicator;
            }
            changed = true;
            return { ...indicator, lines: [], error: message };
          });
          return changed ? next : previous;
        });
      }
    } finally {
      if (showUI) {
        setComputing(false);
      }
    }
  }, [
    activeIndicatorsRef,
    candleDownColorRef,
    candleUpColorRef,
    chartDataRef,
    jobCoordinator,
    outputDispatch,
    setActiveIndicators,
  ]);

  const recompute = useCallback((force = true) => {
    userTriggeredRef.current = true;
    forceHostedSubscriptions();
    void computeAll(force);
  }, [computeAll, forceHostedSubscriptions]);

  useLayoutEffect(() => {
    committedRuntimeRef.current = {
      context: { datasetKey, exchange, interval, marketType, symbol },
      lifecycleKey: desiredLifecycleKey,
    };
    jobCoordinator.activate(desiredLifecycleKey);
  }, [
    datasetKey,
    desiredLifecycleKey,
    exchange,
    interval,
    jobCoordinator,
    marketType,
    symbol,
  ]);

  useEffect(() => {
    if (!chartData || chartData.length === 0) return;
    if (activeIndicators.length === 0) return;
    const urgent = pendingForceComputeRef.current;
    pendingForceComputeRef.current = false;

    let fired = false;
    const delayMs = resolveIndicatorComputeDelay({ chartDataMeta, force: urgent });
    if (shouldDeferIndicatorCompute(chartDataMeta)) {
      recordPerfEvent("indicator.compute.deferred", {
        reason: "provisional-chart-data",
        force: false,
        bars: chartData.length,
      });
    }
    const timer = setTimeout(() => {
      fired = true;
      void computeAll(false);
    }, delayMs);
    return () => {
      clearTimeout(timer);
      if (urgent && !fired) {
        pendingForceComputeRef.current = true;
      }
    };
  }, [
    activeIndicators,
    candleDownColor,
    candleUpColor,
    chartData,
    chartDataMeta,
    computeAll,
    pendingForceComputeRef,
  ]);

  useEffect(() => {
    if (seriesReady === 0) return undefined;
    const currentIndicators = activeIndicatorsRef.current;
    const currentChartData = chartDataRef.current;
    const currentMeta = chartDataMetaRef.current;

    if (currentIndicators.length > 0 && currentChartData?.length > 0) {
      const delayMs = resolveSeriesReadyComputeDelay(currentMeta);
      const timer = setTimeout(() => {
        void computeAll(false);
      }, delayMs);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [activeIndicatorsRef, chartDataMetaRef, chartDataRef, computeAll, seriesReady]);

  useEffect(() => () => jobCoordinator.dispose(), [jobCoordinator]);

  return {
    computeAll,
    computing,
    recompute,
  };
}
