import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { useActiveIndicatorStore } from "./activeIndicatorStore";
import { useIndicatorComputeController } from "./indicatorComputeController";
import { parseIntervalSeconds } from "../../utils/intervals";
import {
  createIndicatorOutputState,
  indicatorOutputReducer,
} from "./indicatorOutputReducer";
import { buildIndicatorPaneData } from "./indicatorPaneProjection";
import { useIndicatorStreamController } from "./indicatorStreamController";
import {
  getVisibleHostedIndicators,
} from "./indicatorWsRuntime";
import {
  formatIndicatorError,
  mergeIndicatorLines,
  normalizeIndicatorPayload,
  normalizeParamSchema,
  replaceIndicatorLinesRange,
  resolveWsValue,
  stringSignature,
  upsertLinePoint,
} from "./indicatorPayloadRuntime";

function useLatestRef(value) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

function resolveRuntimeInputs(options = {}) {
  const sessionView = options.session?.view || {};
  const marketDataView = options.marketData?.view || {};
  const marketDataActions = options.marketData?.actions || {};
  const marketDataStatus = options.marketData?.status || {};

  return {
    candleDownColor: options.candleDownColor,
    candleUpColor: options.candleUpColor,
    chartData: options.chartData ?? marketDataView.bars ?? [],
    chartDataMeta: options.chartDataMeta ?? marketDataView.meta ?? null,
    datasetKey: options.datasetKey ?? sessionView.datasetKey,
    exchange: options.exchange ?? sessionView.exchange ?? "binance",
    interval: options.interval ?? sessionView.interval,
    indicatorRangeRequests: options.indicatorRangeRequests ?? marketDataStatus.indicatorRangeRequests ?? [],
    consumeIndicatorRangeRequest: options.consumeIndicatorRangeRequest ?? marketDataActions.consumeIndicatorRangeRequest,
    marketType: options.marketType ?? sessionView.marketType,
    seriesReady: options.seriesReady ?? (marketDataStatus.activeChartReady ? 1 : 0),
    sessionKey: options.sessionKey ?? sessionView.sessionKey,
    symbol: options.symbol ?? sessionView.symbol,
  };
}

const INDICATOR_RANGE_REQUEST_MAX_BARS = 5_000;
const INDICATOR_RANGE_RETRY_MS = 500;

function normalizeRangeBoundary(value) {
  const normalized = Math.floor(Number(value));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function inferIntervalSecondsFromChartData(chartData = []) {
  if (!Array.isArray(chartData) || chartData.length < 2) return null;
  const deltas = [];
  const sampleStart = Math.max(1, chartData.length - 16);
  for (let index = sampleStart; index < chartData.length; index += 1) {
    const current = Number(chartData[index]?.time);
    const prev = Number(chartData[index - 1]?.time);
    const delta = current - prev;
    if (Number.isFinite(delta) && delta > 0) deltas.push(delta);
  }
  if (!deltas.length) return null;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)];
}

function requestIndicatorRangeInChunks(requestRange, start, end, intervalSeconds) {
  if (typeof requestRange !== "function") return false;
  const startSec = normalizeRangeBoundary(start);
  const endSec = normalizeRangeBoundary(end);
  if (!startSec || !endSec || startSec > endSec) return false;

  if (!intervalSeconds || intervalSeconds <= 0) {
    return Boolean(requestRange(startSec, endSec));
  }

  let sentAny = false;
  const chunkSpan = (INDICATOR_RANGE_REQUEST_MAX_BARS - 1) * intervalSeconds;
  for (
    let chunkStart = startSec;
    chunkStart <= endSec;
    chunkStart += INDICATOR_RANGE_REQUEST_MAX_BARS * intervalSeconds
  ) {
    const chunkEnd = Math.min(endSec, chunkStart + chunkSpan);
    sentAny = Boolean(requestRange(chunkStart, chunkEnd)) || sentAny;
  }
  return sentAny;
}

function buildHostedCatchupSignature({
  exchange,
  marketType,
  symbol,
  interval,
  hostedIndicators,
  start,
  end,
}) {
  const indicatorSig = hostedIndicators
    .map((indicator) => [
      indicator.id,
      indicator.engineName || "",
      stringSignature(indicator.script || ""),
      indicator.securityMode || "",
      JSON.stringify(indicator.params || {}),
    ].join(":"))
    .sort()
    .join("|");
  return [exchange, marketType, symbol, interval, start, end, indicatorSig].join("::");
}

function paramInt(params, key, fallback) {
  const value = Number.parseInt(params?.[key], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function estimateOutputWarmupBars(indicator) {
  const name = String(indicator?.engineName || "").toUpperCase();
  const params = indicator?.params || {};
  if (name === "VOL") return 0;
  if (name === "MA" || name === "SMA" || name === "BOLL") {
    return Math.max(0, paramInt(params, "period", 20) - 1);
  }
  if (name === "EMA") return Math.max(0, paramInt(params, "period", 20) - 1);
  if (name === "RSI" || name === "ATR") return paramInt(params, "period", 14);
  if (name === "MACD") {
    return paramInt(params, "slow", 26) + paramInt(params, "signal", 9);
  }
  return Math.max(0, paramInt(params, "warmup", 0));
}

function earliestLineTime(indicator) {
  let earliest = null;
  for (const line of indicator?.lines || []) {
    for (const point of line?.data || []) {
      const time = normalizeRangeBoundary(point?.time);
      if (!time) continue;
      earliest = earliest == null ? time : Math.min(earliest, time);
    }
  }
  return earliest;
}

function resolveMissingHostedRange(chartData, hostedIndicators) {
  const start = normalizeRangeBoundary(chartData?.[0]?.time);
  if (!start) return null;
  const intervalSeconds = inferIntervalSecondsFromChartData(chartData);
  if (!intervalSeconds || intervalSeconds <= 0) return null;

  let end = null;
  for (const indicator of hostedIndicators) {
    const firstIndicatorTime = earliestLineTime(indicator);
    if (!firstIndicatorTime) continue;
    const warmupBars = estimateOutputWarmupBars(indicator);
    const candidateEnd = firstIndicatorTime - ((warmupBars + 1) * intervalSeconds);
    if (candidateEnd >= start) {
      end = end == null ? candidateEnd : Math.max(end, candidateEnd);
    }
  }

  if (end == null || end < start) return null;
  return { start, end, intervalSeconds };
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
    indicatorRangeRequests,
    consumeIndicatorRangeRequest,
    marketType,
    seriesReady,
    sessionKey,
    symbol,
  } = resolveRuntimeInputs(options);
  const onIndicatorRemoved = options.onIndicatorRemoved;

  const pendingForceComputeRef = useRef(false);
  const requireIndicatorCompute = useCallback(() => {
    pendingForceComputeRef.current = true;
  }, []);

  const {
    activeIndicators,
    setActiveIndicators,
    addIndicator,
    removeIndicator: removeActiveIndicator,
    toggleVisibility,
    updateIndicatorParams,
    updateIndicatorScript,
  } = useActiveIndicatorStore({ onRequireCompute: requireIndicatorCompute });

  const removeIndicator = useCallback((indicatorId) => {
    removeActiveIndicator(indicatorId);
    onIndicatorRemoved?.(indicatorId);
  }, [onIndicatorRemoved, removeActiveIndicator]);

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
  const consumedIndicatorRangeRequestIdsRef = useRef(new Set());
  const autoCatchupRangeSignaturesRef = useRef(new Set());
  const [rangeRetryTick, setRangeRetryTick] = useState(0);

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

  const applyWsReplaceRange = useCallback((indicatorId, payload) => {
    const normalized = normalizeIndicatorPayload(payload, indicatorId);
    const range = payload?.range;

    setActiveIndicators((prev) =>
      prev.map((indicator) =>
        indicator.id === indicatorId
          ? {
              ...indicator,
              lines: replaceIndicatorLinesRange(indicator.lines || [], normalized.lines, range),
              error: payload?.ok === false ? formatIndicatorError(payload) : null,
            }
          : indicator
      )
    );

    outputDispatch({
      type: "replace-range",
      indicatorId,
      normalized,
      range,
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
    applyWsReplaceRange,
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

  useEffect(() => {
    const hostedIndicators = getVisibleHostedIndicators(activeIndicators);
    if (hostedIndicators.length === 0) {
      for (const request of indicatorRangeRequests) {
        if (!request || request.sessionKey !== sessionKey) continue;
        consumeIndicatorRangeRequest?.(request.id);
      }
      return undefined;
    }

    let needsRetry = false;
    for (const request of indicatorRangeRequests) {
      if (!request || request.sessionKey !== sessionKey) continue;
      if (consumedIndicatorRangeRequestIdsRef.current.has(request.id)) continue;
      consumedIndicatorRangeRequestIdsRef.current.add(request.id);
      const intervalSeconds = parseIntervalSeconds(request.interval || interval)
        || inferIntervalSecondsFromChartData(chartData);
      const sent = requestIndicatorRangeInChunks(
        requestIndicatorRange,
        request.start,
        request.end,
        intervalSeconds,
      );
      if (sent) {
        consumeIndicatorRangeRequest?.(request.id);
      } else {
        consumedIndicatorRangeRequestIdsRef.current.delete(request.id);
        needsRetry = true;
      }
    }
    if (!needsRetry) return undefined;
    const timer = setTimeout(() => setRangeRetryTick((tick) => tick + 1), INDICATOR_RANGE_RETRY_MS);
    return () => clearTimeout(timer);
  }, [
    activeIndicators,
    chartData,
    consumeIndicatorRangeRequest,
    exchange,
    indicatorRangeRequests,
    interval,
    marketType,
    rangeRetryTick,
    requestIndicatorRange,
    sessionKey,
    symbol,
  ]);

  useEffect(() => {
    autoCatchupRangeSignaturesRef.current.clear();
  }, [exchange, interval, marketType, sessionKey, symbol]);

  useEffect(() => {
    if (!chartDataReady || !Array.isArray(chartData) || chartData.length === 0) {
      return;
    }

    const hostedIndicators = getVisibleHostedIndicators(activeIndicators);
    if (hostedIndicators.length === 0) return;

    const missingRange = resolveMissingHostedRange(chartData, hostedIndicators);
    if (!missingRange) return;

    const signature = buildHostedCatchupSignature({
      exchange,
      marketType,
      symbol,
      interval,
      hostedIndicators,
      start: missingRange.start,
      end: missingRange.end,
    });
    if (autoCatchupRangeSignaturesRef.current.has(signature)) return;

    const sent = requestIndicatorRangeInChunks(
      requestIndicatorRange,
      missingRange.start,
      missingRange.end,
      missingRange.intervalSeconds,
    );
    if (sent) {
      autoCatchupRangeSignaturesRef.current.add(signature);
    }
  }, [
    activeIndicators,
    chartData,
    chartDataReady,
    exchange,
    interval,
    marketType,
    requestIndicatorRange,
    symbol,
  ]);

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
  };
}
