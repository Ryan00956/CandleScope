import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { computeIndicator } from "../../services/indicatorApi";
import { markPerf, recordPerfEvent } from "../../runtime/performance/perfMarks";
import {
  buildRuntimeDataSignature,
  getBuiltinIndicatorName,
  isBuiltinIndicator,
  isWsHostedIndicator,
} from "../../runtime/indicators/indicatorPayloadRuntime";
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
} from "../../runtime/indicators/indicatorComputeRuntime";

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
}) {
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
            const result = await computeIndicator({
              mode: builtin ? "builtin" : "script",
              securityMode: indicator.securityMode,
              name: builtin ? getBuiltinIndicatorName(indicator) : undefined,
              script: indicator.script,
              ohlcv,
              params: computeParams,
              exchange,
              symbol,
              interval,
              marketType,
            });
            return { id: indicator.id, result, visible: indicator.visible };
          } catch (err) {
            return { id: indicator.id, result: { ok: false, error: err.message, lines: [] }, visible: indicator.visible };
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
            updated[index] = {
              ...updated[index],
              lines: mappedLines,
              error,
              ...(newParamSchemas[id] ? { paramSchema: newParamSchemas[id] } : {}),
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
        queueMicrotask(() => computeAll(forceNext));
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
    computeAll(force);
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
        computeAll(true);
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
      computeAll(forceNow);
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
      const timer = setTimeout(() => computeAll(true), delayMs);
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
