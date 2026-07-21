import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { computeIndicator } from "../../services/indicatorApi.js";
import { markPerf, recordPerfEvent } from "../../runtime/performance/perfMarks.js";
import {
  buildRuntimeDataSignature,
  getBuiltinIndicatorName,
  isBuiltinIndicator,
  isWsHostedIndicator,
} from "./indicatorPayloadRuntime.js";
import {
  buildCandleColorKey,
  buildIndicatorComputeParams,
  buildIndicatorMutationSignature,
  buildIndicatorOhlcv,
  collectIndicatorComputeResults,
  hasVolumeIndicator,
  resolveIndicatorComputeDelay,
  resolveSeriesReadyComputeDelay,
  shouldDeferIndicatorCompute,
} from "./indicatorComputeRuntime.js";
import {
  buildIndicatorCacheContext,
  cacheIndicatorSnapshot,
} from "./indicatorResultCacheStore.js";
import type { ChartDataCommitMeta } from "../market-data/useChartDataRuntime.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type {
  IndicatorComputeRequest,
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
  const lastComputeSignatureRef = useRef("");
  const queuedRecomputeRef = useRef(false);
  const queuedForceRecomputeRef = useRef(false);
  const computingRef = useRef(false);
  const userTriggeredRef = useRef(false);
  const prevDatasetKeyRef = useRef(datasetKey);
  const prevCandleColorsRef = useRef(buildCandleColorKey(candleUpColor, candleDownColor));
  const prevIndicatorSignatureRef = useRef("");

  const computeAll = useCallback(async (force = false) => {
    if (computingRef.current) {
      queuedRecomputeRef.current = true;
      queuedForceRecomputeRef.current = queuedForceRecomputeRef.current || force;
      return;
    }
    computingRef.current = true;

    const currentChartData = chartDataRef.current;
    const currentIndicators = activeIndicatorsRef.current;

    if (!currentChartData || currentChartData.length === 0) {
      recordPerfEvent("indicator.compute.skip", { reason: "no-chart-data" });
      computingRef.current = false;
      return;
    }

    const dataSignature = buildRuntimeDataSignature(currentChartData, chartDataMetaRef.current);
    if (!force && dataSignature === lastComputeSignatureRef.current) {
      recordPerfEvent("indicator.compute.skip", { reason: "same-data-signature" });
      computingRef.current = false;
      return;
    }
    lastComputeSignatureRef.current = dataSignature;

    const indicators = currentIndicators.filter(
      (indicator) => !isWsHostedIndicator(indicator) && (indicator.script || indicator.name || indicator.id)
    );
    if (indicators.length === 0) {
      recordPerfEvent("indicator.compute.skip", { reason: "no-local-indicators" });
      computingRef.current = false;
      return;
    }

    const showUI = userTriggeredRef.current;
    if (showUI) setComputing(true);
    markPerf("indicator.compute.start", {
      force,
      indicatorCount: indicators.length,
      bars: currentChartData.length,
      symbol,
      interval,
      marketType,
      exchange,
    });

    const ohlcv = buildIndicatorOhlcv(currentChartData);

    try {
      const results = await Promise.allSettled(
        indicators.map(async (indicator) => {
          try {
            const computeParams = buildIndicatorComputeParams(indicator, {
              candleUpColor: candleUpColorRef.current,
              candleDownColor: candleDownColorRef.current,
            });
            const builtin = isBuiltinIndicator(indicator);
            const request: IndicatorComputeRequest = {
              mode: builtin ? "builtin" : "script",
              ohlcv,
              params: computeParams,
              exchange,
              symbol,
              interval,
              marketType,
            };
            if (indicator.securityMode !== undefined) {
              request.securityMode = indicator.securityMode;
            }
            if (builtin) request.name = getBuiltinIndicatorName(indicator);
            if (indicator.script !== undefined) {
              request.script = indicator.script;
              if (indicator.language !== undefined) request.language = indicator.language;
            }
            const result = await computeIndicator(request);
            return { id: indicator.id, result, visible: Boolean(indicator.visible) };
          } catch (err) {
            return {
              id: indicator.id,
              result: {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
                lines: [],
              },
              visible: Boolean(indicator.visible),
            };
          }
        })
      );

      const {
        processedResults,
        allMarkers,
        allFills,
        allHlines,
        allBgcolors,
        allBarcolors,
        allSignals,
        newParamSchemas,
      } = collectIndicatorComputeResults(results);
      const indicatorById = new Map(indicators.map((indicator) => [indicator.id, indicator]));
      const cacheContext = buildIndicatorCacheContext({
        candleDownColor: candleDownColorRef.current,
        candleUpColor: candleUpColorRef.current,
        exchange,
        interval,
        marketType,
        symbol,
      });
      for (const { id, normalized, error } of processedResults) {
        if (error || !normalized) continue;
        cacheIndicatorSnapshot(indicatorById.get(id), cacheContext, normalized, newParamSchemas[id]);
      }

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
    } finally {
      markPerf("indicator.compute.end", {
        force,
        indicatorCount: indicators.length,
        bars: currentChartData.length,
        symbol,
        interval,
        marketType,
        exchange,
      });
      computingRef.current = false;
      if (showUI) {
        setComputing(false);
        userTriggeredRef.current = false;
      }

      if (queuedRecomputeRef.current) {
        const forceNext = queuedForceRecomputeRef.current;
        queuedRecomputeRef.current = false;
        queuedForceRecomputeRef.current = false;
        queueMicrotask(() => {
          void computeAll(forceNext);
        });
      }
    }
  }, [
    activeIndicatorsRef,
    candleDownColorRef,
    candleUpColorRef,
    chartDataMetaRef,
    chartDataRef,
    exchange,
    interval,
    marketType,
    outputDispatch,
    setActiveIndicators,
    symbol,
  ]);

  const recompute = useCallback((force = true) => {
    userTriggeredRef.current = true;
    lastComputeSignatureRef.current = "";
    forceHostedSubscriptions();
    void computeAll(force);
  }, [computeAll, forceHostedSubscriptions]);

  useEffect(() => {
    if (datasetKey !== prevDatasetKeyRef.current) {
      prevDatasetKeyRef.current = datasetKey;
      lastComputeSignatureRef.current = "";
      prevIndicatorSignatureRef.current = "";
      pendingForceComputeRef.current = true;
    }
  }, [datasetKey, pendingForceComputeRef]);

  useEffect(() => {
    const colorKey = buildCandleColorKey(candleUpColor, candleDownColor);
    if (colorKey !== prevCandleColorsRef.current) {
      prevCandleColorsRef.current = colorKey;
      if (hasVolumeIndicator(activeIndicatorsRef.current)) {
        lastComputeSignatureRef.current = "";
        pendingForceComputeRef.current = true;
        void computeAll(true);
      }
    }
  }, [activeIndicatorsRef, candleDownColor, candleUpColor, computeAll, pendingForceComputeRef]);

  useEffect(() => {
    if (!chartData || chartData.length === 0) return;
    if (activeIndicators.length === 0) return;

    const signature = buildIndicatorMutationSignature(activeIndicators);
    const signatureChanged = signature !== prevIndicatorSignatureRef.current;
    if (signatureChanged) {
      prevIndicatorSignatureRef.current = signature;
      pendingForceComputeRef.current = true;
    }

    const forceNow = pendingForceComputeRef.current;
    const dataChanged = buildRuntimeDataSignature(chartData, chartDataMeta) !== lastComputeSignatureRef.current;
    if (!forceNow && !dataChanged) return;

    if (forceNow) {
      pendingForceComputeRef.current = false;
    }

    let fired = false;
    const delayMs = resolveIndicatorComputeDelay({ chartDataMeta, force: forceNow });
    if (shouldDeferIndicatorCompute(chartDataMeta)) {
      recordPerfEvent("indicator.compute.deferred", {
        reason: "provisional-chart-data",
        force: forceNow,
        bars: chartData.length,
      });
    }
    const timer = setTimeout(() => {
      fired = true;
      void computeAll(forceNow);
    }, delayMs);
    return () => {
      clearTimeout(timer);
      if (forceNow && !fired) {
        pendingForceComputeRef.current = true;
      }
    };
  }, [activeIndicators, chartData, chartDataMeta, computeAll, pendingForceComputeRef]);

  useEffect(() => {
    if (seriesReady === 0) return undefined;
    lastComputeSignatureRef.current = "";
    prevIndicatorSignatureRef.current = "";
    pendingForceComputeRef.current = true;

    const currentIndicators = activeIndicatorsRef.current;
    const currentChartData = chartDataRef.current;
    const currentMeta = chartDataMetaRef.current;

    if (currentIndicators.length > 0 && currentChartData?.length > 0) {
      const delayMs = resolveSeriesReadyComputeDelay(currentMeta);
      const timer = setTimeout(() => {
        void computeAll(true);
      }, delayMs);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [activeIndicatorsRef, chartDataMetaRef, chartDataRef, computeAll, pendingForceComputeRef, seriesReady]);

  return {
    computeAll,
    computing,
    recompute,
  };
}
