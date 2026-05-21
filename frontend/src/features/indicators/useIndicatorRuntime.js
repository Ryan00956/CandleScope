import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { useActiveIndicatorStore } from "./activeIndicatorStore";
import { useIndicatorComputeController } from "./indicatorComputeController";
import {
  createIndicatorOutputState,
  indicatorOutputReducer,
} from "./indicatorOutputReducer";
import { buildIndicatorPaneData } from "./indicatorPaneProjection";
import { useIndicatorStreamController } from "./indicatorStreamController";
import {
  formatIndicatorError,
  mergeIndicatorLines,
  normalizeIndicatorPayload,
  normalizeParamSchema,
  resolveWsValue,
  upsertLinePoint,
} from "../../runtime/indicators/indicatorPayloadRuntime";

function useLatestRef(value) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function resolveRuntimeInputs(options = {}) {
  const sessionView = options.session?.view || {};
  const marketDataView = options.marketData?.view || {};
  const marketDataStatus = options.marketData?.status || {};

  return {
    candleDownColor: options.candleDownColor,
    candleUpColor: options.candleUpColor,
    chartData: options.chartData ?? marketDataView.bars ?? [],
    chartDataMeta: options.chartDataMeta ?? marketDataView.meta ?? null,
    datasetKey: options.datasetKey ?? sessionView.datasetKey,
    exchange: options.exchange ?? sessionView.exchange ?? "binance",
    interval: options.interval ?? sessionView.interval,
    marketType: options.marketType ?? sessionView.marketType,
    seriesReady: options.seriesReady ?? (marketDataStatus.activeChartReady ? 1 : 0),
    symbol: options.symbol ?? sessionView.symbol,
  };
}

export function useIndicatorRuntime(options = {}) {
  const {
    candleDownColor,
    candleUpColor,
    chartData,
    chartDataMeta,
    datasetKey,
    exchange,
    interval,
    marketType,
    seriesReady,
    symbol,
  } = resolveRuntimeInputs(options);

  const pendingForceComputeRef = useRef(false);
  const requireIndicatorCompute = useCallback(() => {
    pendingForceComputeRef.current = true;
  }, []);

  const {
    activeIndicators,
    setActiveIndicators,
    addIndicator,
    removeIndicator,
    toggleVisibility,
    updateIndicatorParams,
    updateIndicatorScript,
  } = useActiveIndicatorStore({ onRequireCompute: requireIndicatorCompute });

  const [outputState, outputDispatch] = useReducer(
    indicatorOutputReducer,
    undefined,
    createIndicatorOutputState,
  );

  const activeIndicatorsRef = useLatestRef(activeIndicators);
  const chartDataRef = useLatestRef(chartData);
  const chartDataMetaRef = useLatestRef(chartDataMeta);
  const candleUpColorRef = useLatestRef(candleUpColor);
  const candleDownColorRef = useLatestRef(candleDownColor);

  const chartDataStatus = chartDataMeta?.status || "idle";
  const chartDataReady = Boolean(chartData?.length && chartDataStatus === "ready");

  const applyWsSnapshot = useCallback((indicatorId, payload) => {
    const error = payload?.ok === false ? formatIndicatorError(payload) : null;
    const schema = normalizeParamSchema(payload?.param_schema);
    const normalized = normalizeIndicatorPayload(payload, indicatorId);

    setActiveIndicators((prev) =>
      prev.map((indicator) =>
        indicator.id === indicatorId
          ? {
              ...indicator,
              lines: normalized.lines,
              error,
              ...(schema.length > 0 ? { paramSchema: schema } : {}),
            }
          : indicator
      )
    );

    outputDispatch({
      type: "snapshot",
      indicatorId,
      normalized,
      schema,
    });
  }, [setActiveIndicators]);

  const applyWsPatch = useCallback((indicatorId, payload) => {
    const normalized = normalizeIndicatorPayload(payload, indicatorId);

    setActiveIndicators((prev) =>
      prev.map((indicator) =>
        indicator.id === indicatorId
          ? {
              ...indicator,
              lines: mergeIndicatorLines(indicator.lines || [], normalized.lines),
              error: payload?.ok === false ? formatIndicatorError(payload) : null,
            }
          : indicator
      )
    );

    outputDispatch({
      type: "patch",
      indicatorId,
      normalized,
    });
  }, [setActiveIndicators]);

  const applyWsValues = useCallback((indicatorId, values, barTime) => {
    if (!values || !barTime) return;
    const currentChartData = chartDataRef.current || [];
    const bar = currentChartData.find((item) => item.time === barTime);
    const histogramColor = bar
      ? (bar.close >= bar.open ? candleUpColorRef.current : candleDownColorRef.current)
      : null;

    setActiveIndicators((prev) =>
      prev.map((indicator) => {
        if (indicator.id !== indicatorId || !Array.isArray(indicator.lines)) return indicator;
        const isSingleLine = indicator.lines.length === 1 && Object.keys(values).length === 1;
        const lines = indicator.lines.map((line) => {
          const value = resolveWsValue(line, values, isSingleLine);
          if (value === undefined) return line;
          const point = { time: barTime, value };
          if (line.type === "histogram" && histogramColor) {
            point.color = histogramColor;
          }
          return { ...line, data: upsertLinePoint(line.data, point) };
        });
        return { ...indicator, lines, error: null };
      })
    );
  }, [candleDownColorRef, candleUpColorRef, chartDataRef, setActiveIndicators]);

  const setIndicatorError = useCallback((indicatorId, error) => {
    setActiveIndicators((prev) =>
      prev.map((indicator) => (indicator.id === indicatorId ? { ...indicator, error } : indicator))
    );
  }, [setActiveIndicators]);

  const { forceHostedSubscriptions, requestIndicatorRange } = useIndicatorStreamController({
    activeIndicators,
    activeIndicatorsRef,
    applyWsPatch,
    applyWsSnapshot,
    applyWsValues,
    candleDownColor,
    candleDownColorRef,
    candleUpColor,
    candleUpColorRef,
    chartData,
    chartDataMeta,
    chartDataMetaRef,
    chartDataReady,
    chartDataRef,
    exchange,
    interval,
    marketType,
    setIndicatorError,
    symbol,
  });

  const { computeAll, computing, recompute } = useIndicatorComputeController({
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
  });

  useEffect(() => {
    setActiveIndicators((prev) =>
      prev.map((indicator) => ({
        ...indicator,
        lines: [],
        error: null,
      }))
    );
    outputDispatch({ type: "reset-context" });
  }, [exchange, interval, marketType, setActiveIndicators, symbol]);

  const paneData = useMemo(
    () => buildIndicatorPaneData(activeIndicators),
    [activeIndicators],
  );

  const view = useMemo(() => ({
    activeIndicators,
    mainOverlayLines: paneData.mainOverlayLines,
    subPanes: paneData.subPanes,
    markers: outputState.markers,
    fills: outputState.fills,
    hlines: outputState.hlines,
    bgcolors: outputState.bgcolors,
    barcolors: outputState.barcolors,
    signals: outputState.signals,
    paramSchemas: outputState.paramSchemas,
  }), [activeIndicators, outputState, paneData]);

  const actions = useMemo(() => ({
    addIndicator,
    computeAll,
    recompute,
    removeIndicator,
    requestIndicatorRange,
    toggleVisibility,
    updateIndicatorParams,
    updateIndicatorScript,
  }), [
    addIndicator,
    computeAll,
    recompute,
    removeIndicator,
    requestIndicatorRange,
    toggleVisibility,
    updateIndicatorParams,
    updateIndicatorScript,
  ]);

  const status = useMemo(() => ({
    computing,
  }), [computing]);

  return {
    view,
    actions,
    status,
    activeIndicators,
    computing,
    addIndicator,
    removeIndicator,
    toggleVisibility,
    updateIndicatorParams,
    updateIndicatorScript,
    computeAll,
    recompute,
    requestIndicatorRange,
    mainOverlayLines: paneData.mainOverlayLines,
    subPanes: paneData.subPanes,
    markers: outputState.markers,
    fills: outputState.fills,
    hlines: outputState.hlines,
    bgcolors: outputState.bgcolors,
    barcolors: outputState.barcolors,
    signals: outputState.signals,
    paramSchemas: outputState.paramSchemas,
  };
}
