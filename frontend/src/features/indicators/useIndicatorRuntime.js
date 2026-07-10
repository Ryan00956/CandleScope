import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { useActiveIndicatorStore } from "./activeIndicatorStore";
import { computeIndicatorRange } from "../../services/indicatorApi";
import { useIndicatorComputeController } from "./indicatorComputeController";
import { parseIntervalParts, parseIntervalSeconds } from "../../utils/intervals";
import {
  createIndicatorOutputState,
  indicatorOutputReducer,
} from "./indicatorOutputReducer";
import { buildIndicatorPaneData } from "./indicatorPaneProjection";
import { useIndicatorStreamController } from "./indicatorStreamController";
import {
  getVisibleHostedIndicators,
  buildHostedSubscriptionMessage,
} from "./indicatorWsRuntime";
import {
  estimateOutputWarmupBars,
  planDeferredRightCatchup,
  RIGHT_CATCHUP_GRACE_MS,
  resolveInitialHostedRange,
} from "./indicatorRangePlanning";
import {
  buildIndicatorCacheContext,
  cacheIndicatorSnapshot,
  patchCachedIndicatorResult,
  replaceCachedIndicatorRange,
  resolveCachedIndicatorResults,
  upsertCachedIndicatorLinePoint,
} from "./indicatorResultCacheStore";
import {
  clearIndicatorLineData,
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
    getCurrentVisibleRange: options.getCurrentVisibleRange,
    interval: options.interval ?? sessionView.interval,
    indicatorRangeRequests: options.indicatorRangeRequests ?? marketDataStatus.indicatorRangeRequests ?? [],
    consumeIndicatorRangeRequest: options.consumeIndicatorRangeRequest ?? marketDataActions.consumeIndicatorRangeRequest,
    marketType: options.marketType ?? sessionView.marketType,
    seriesReady: options.seriesReady ?? (marketDataStatus.activeChartReady ? 1 : 0),
    sessionKey: options.sessionKey ?? sessionView.sessionKey,
    savedVisibleRange: options.savedVisibleRange ?? sessionView.savedVisibleRange ?? null,
    symbol: options.symbol ?? sessionView.symbol,
  };
}

const INDICATOR_RANGE_RETRY_MS = 500;
const INDICATOR_HTTP_RANGE_RETRY_MAX_ATTEMPTS = 1;
const INDICATOR_HTTP_RANGE_RETRY_DEFAULT_MS = 3000;
const INDICATOR_HTTP_RANGE_DEDUP_WINDOW_MS = 10_000;
const INDICATOR_HTTP_RANGE_REQUEST_STATE_TTL_MS = 60_000;

export function planIndicatorRangeRetry({
  attempts,
  retryAfterMs,
  maxAttempts = INDICATOR_HTTP_RANGE_RETRY_MAX_ATTEMPTS,
} = {}) {
  const normalizedAttempts = Math.max(0, Math.floor(Number(attempts) || 0));
  const normalizedMaxAttempts = Math.max(0, Math.floor(Number(maxAttempts) || 0));
  if (normalizedAttempts >= normalizedMaxAttempts) {
    return {
      delayMs: null,
      nextAttempts: normalizedAttempts,
      shouldRetry: false,
    };
  }

  const requestedDelayMs = Number(retryAfterMs);
  const delayMs = Number.isFinite(requestedDelayMs) && requestedDelayMs > 0
    ? Math.max(INDICATOR_HTTP_RANGE_RETRY_DEFAULT_MS, Math.floor(requestedDelayMs))
    : INDICATOR_HTTP_RANGE_RETRY_DEFAULT_MS;
  return {
    delayMs,
    nextAttempts: normalizedAttempts + 1,
    shouldRetry: true,
  };
}

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

function requestIndicatorRangeOnce(requestRange, start, end, reason = "range") {
  if (typeof requestRange !== "function") return false;
  const startSec = normalizeRangeBoundary(start);
  const endSec = normalizeRangeBoundary(end);
  if (!startSec || !endSec || startSec > endSec) return false;
  return Boolean(requestRange(startSec, endSec, reason));
}

function pruneRangeRequestState(startedAtMap, nowMs) {
  for (const [key, startedAt] of startedAtMap.entries()) {
    if (nowMs - startedAt > INDICATOR_HTTP_RANGE_REQUEST_STATE_TTL_MS) {
      startedAtMap.delete(key);
    }
  }
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

function latestLineTime(indicator) {
  let latest = null;
  for (const line of indicator?.lines || []) {
    for (const point of line?.data || []) {
      const time = normalizeRangeBoundary(point?.time);
      if (!time) continue;
      latest = latest == null ? time : Math.max(latest, time);
    }
  }
  return latest;
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

function resolveMissingHostedRightRange(chartData, hostedIndicators) {
  const end = normalizeRangeBoundary(chartData?.[chartData.length - 1]?.time);
  if (!end) return null;
  const intervalSeconds = inferIntervalSecondsFromChartData(chartData);
  if (!intervalSeconds || intervalSeconds <= 0) return null;

  let start = null;
  for (const indicator of hostedIndicators) {
    const lastIndicatorTime = latestLineTime(indicator);
    if (!lastIndicatorTime) continue;
    const candidateStart = lastIndicatorTime + intervalSeconds;
    if (candidateStart <= end) {
      start = start == null ? candidateStart : Math.min(start, candidateStart);
    }
  }

  if (start == null || start > end) return null;
  return { start, end, intervalSeconds };
}

function isContinuousChartRange(chartData, intervalSeconds) {
  if (!Array.isArray(chartData) || chartData.length < 2) return true;
  if (!intervalSeconds || intervalSeconds <= 0) return true;
  const tolerance = Math.max(1, Math.floor(intervalSeconds * 0.01));
  for (let index = 1; index < chartData.length; index += 1) {
    const prev = Number(chartData[index - 1]?.time);
    const current = Number(chartData[index]?.time);
    if (!Number.isFinite(prev) || !Number.isFinite(current)) return false;
    if (Math.abs((current - prev) - intervalSeconds) > tolerance) return false;
  }
  return true;
}

export function useIndicatorRuntime(options = {}) {
  const {
    candleDownColor,
    candleUpColor,
    chartData,
    chartDataMeta,
    datasetKey,
    exchange,
    getCurrentVisibleRange,
    interval,
    indicatorRangeRequests,
    consumeIndicatorRangeRequest,
    marketType,
    seriesReady,
    sessionKey,
    savedVisibleRange,
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

  const [outputState, outputDispatch] = useReducer(
    indicatorOutputReducer,
    undefined,
    createIndicatorOutputState,
  );

  const removeIndicator = useCallback((indicatorId) => {
    removeActiveIndicator(indicatorId);
    outputDispatch({ type: "remove-indicator", indicatorId });
    onIndicatorRemoved?.(indicatorId);
  }, [onIndicatorRemoved, removeActiveIndicator]);

  const activeIndicatorsRef = useLatestRef(activeIndicators);
  const chartDataRef = useLatestRef(chartData);
  const chartDataMetaRef = useLatestRef(chartDataMeta);
  const candleUpColorRef = useLatestRef(candleUpColor);
  const candleDownColorRef = useLatestRef(candleDownColor);
  const consumedIndicatorRangeRequestIdsRef = useRef(new Set());
  const autoCatchupRangeSignaturesRef = useRef(new Set());
  const autoRightCatchupRangeSignaturesRef = useRef(new Set());
  const autoRightCatchupPendingRef = useRef(null);
  const autoRightCatchupTimerRef = useRef(null);
  const initialHostedRangeSignaturesRef = useRef(new Set());
  const rangeRetryAttemptsRef = useRef(new Map());
  const rangeRequestInFlightRef = useRef(new Set());
  const rangeRequestStartedAtRef = useRef(new Map());
  const [rangeRetryTick, setRangeRetryTick] = useState(0);
  const runtimeContextRef = useLatestRef({
    exchange,
    interval,
    marketType,
    sessionKey,
    symbol,
  });

  const chartDataStatus = chartDataMeta?.status || "idle";
  const chartDataReady = Boolean(chartData?.length && chartDataStatus === "ready");

  const getIndicatorCacheContext = useCallback(() => {
    const requestContext = runtimeContextRef.current;
    return buildIndicatorCacheContext({
      candleDownColor: candleDownColorRef.current,
      candleUpColor: candleUpColorRef.current,
      exchange: requestContext.exchange,
      interval: requestContext.interval,
      marketType: requestContext.marketType,
      symbol: requestContext.symbol,
    });
  }, [candleDownColorRef, candleUpColorRef, runtimeContextRef]);

  const applyWsSnapshot = useCallback((indicatorId, payload) => {
    const error = payload?.ok === false ? formatIndicatorError(payload) : null;
    const schema = normalizeParamSchema(payload?.param_schema);
    const normalized = normalizeIndicatorPayload(payload, indicatorId);
    const indicator = activeIndicatorsRef.current.find((item) => item.id === indicatorId);
    if (!indicator) return;
    if (!error) {
      cacheIndicatorSnapshot(indicator, getIndicatorCacheContext(), normalized, schema);
    }

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
  }, [activeIndicatorsRef, getIndicatorCacheContext, setActiveIndicators]);

  const applyWsPatch = useCallback((indicatorId, payload) => {
    const normalized = normalizeIndicatorPayload(payload, indicatorId);
    const indicator = activeIndicatorsRef.current.find((item) => item.id === indicatorId);
    if (!indicator) return;
    if (payload?.ok !== false) {
      patchCachedIndicatorResult(indicator, getIndicatorCacheContext(), normalized);
    }

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
  }, [activeIndicatorsRef, getIndicatorCacheContext, setActiveIndicators]);

  const applyWsReplaceRange = useCallback((indicatorId, payload) => {
    const normalized = normalizeIndicatorPayload(payload, indicatorId);
    const range = payload?.range;
    const indicator = activeIndicatorsRef.current.find((item) => item.id === indicatorId);
    if (!indicator) return;
    if (payload?.ok !== false) {
      replaceCachedIndicatorRange(indicator, getIndicatorCacheContext(), normalized, range);
    }

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
  }, [activeIndicatorsRef, getIndicatorCacheContext, setActiveIndicators]);

  const applyWsValues = useCallback((indicatorId, values, barTime, isFinal = true) => {
    if (!values || !barTime) return;
    const currentChartData = chartDataRef.current || [];
    const bar = currentChartData.find((item) => item.time === barTime);
    const histogramColor = bar
      ? (bar.close >= bar.open ? candleUpColorRef.current : candleDownColorRef.current)
      : null;

    setActiveIndicators((prev) =>
      prev.map((indicator) => {
        if (indicator.id !== indicatorId || !Array.isArray(indicator.lines)) return indicator;
        if (isFinal) {
          upsertCachedIndicatorLinePoint(
            indicator,
            getIndicatorCacheContext(),
            values,
            barTime,
            histogramColor,
          );
        }
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
  }, [
    candleDownColorRef,
    candleUpColorRef,
    chartDataRef,
    getIndicatorCacheContext,
    setActiveIndicators,
  ]);

  const setIndicatorError = useCallback((indicatorId, error) => {
    setActiveIndicators((prev) =>
      prev.map((indicator) => (indicator.id === indicatorId ? { ...indicator, error } : indicator))
    );
  }, [setActiveIndicators]);

  const requestIndicatorRange = useCallback((start, end, reason = "range", options = {}) => {
    const startSec = normalizeRangeBoundary(start);
    const endSec = normalizeRangeBoundary(end);
    if (!startSec || !endSec || startSec > endSec) return false;

    const targetIds = Array.isArray(options.indicatorIds)
      ? new Set(options.indicatorIds.map((item) => String(item)))
      : null;
    const hostedIndicators = getVisibleHostedIndicators(activeIndicatorsRef.current)
      .filter((indicator) => !targetIds || targetIds.has(String(indicator.id)));
    if (hostedIndicators.length === 0) return false;

    const requestContext = runtimeContextRef.current;
    const contextKey = [
      requestContext.sessionKey,
      requestContext.exchange,
      requestContext.marketType,
      requestContext.symbol,
      requestContext.interval,
    ].join("|");
    const colorContext = {
      candleDownColor: candleDownColorRef.current,
      candleUpColor: candleUpColorRef.current,
      chartData: chartDataRef.current || [],
      chartDataLength: chartDataRef.current?.length || 0,
      exchange: requestContext.exchange,
      interval: requestContext.interval,
      marketType: requestContext.marketType,
      symbol: requestContext.symbol,
    };

    hostedIndicators.forEach((indicator) => {
      const message = buildHostedSubscriptionMessage(indicator, colorContext);
      const retryKey = [
        contextKey,
        indicator.id,
        startSec,
        endSec,
        reason,
        JSON.stringify(message.params || {}),
      ].join("|");
      const rangeRequestKey = [
        contextKey,
        indicator.id,
        message.kind || "",
        message.name || "",
        stringSignature(message.script || ""),
        message.securityMode || "",
        JSON.stringify(message.params || {}),
        startSec,
        endSec,
      ].join("|");
      const nowMs = Date.now();
      pruneRangeRequestState(rangeRequestStartedAtRef.current, nowMs);
      const lastStartedAt = rangeRequestStartedAtRef.current.get(rangeRequestKey) || 0;
      if (
        rangeRequestInFlightRef.current.has(rangeRequestKey)
        || nowMs - lastStartedAt < INDICATOR_HTTP_RANGE_DEDUP_WINDOW_MS
      ) {
        return;
      }
      rangeRequestInFlightRef.current.add(rangeRequestKey);
      rangeRequestStartedAtRef.current.set(rangeRequestKey, nowMs);

      const settleRangeRequest = (ok, detail = {}) => {
        if (typeof options.onSettled === "function") {
          options.onSettled(ok, { indicatorId: indicator.id, ...detail });
        }
      };

      const finishRangeRequest = () => {
        rangeRequestInFlightRef.current.delete(rangeRequestKey);
      };

      const run = async () => {
        try {
          const payload = await computeIndicatorRange({
            clientId: indicator.id,
            kind: message.kind,
            exchange: message.exchange,
            marketType: message.marketType,
            symbol: message.symbol,
            interval: message.interval,
            name: message.name || message.displayName,
            customId: message.customId,
            script: message.script,
            securityMode: message.securityMode,
            params: message.params,
            start: startSec,
            end: endSec,
            reason,
          });
          const latestContext = runtimeContextRef.current;
          const latestContextKey = [
            latestContext.sessionKey,
            latestContext.exchange,
            latestContext.marketType,
            latestContext.symbol,
            latestContext.interval,
          ].join("|");
          if (latestContextKey !== contextKey) {
            finishRangeRequest();
            return;
          }
          if (!activeIndicatorsRef.current.some((item) => item.id === indicator.id)) {
            finishRangeRequest();
            return;
          }

          if (payload?.ok === false) {
            if (payload.code === "INDICATOR_RANGE_EMPTY") {
              rangeRetryAttemptsRef.current.delete(retryKey);
              settleRangeRequest(true, { code: payload.code, payload });
              finishRangeRequest();
              return;
            }
            if (payload.code === "INDICATOR_RANGE_NOT_READY") {
              const attempts = rangeRetryAttemptsRef.current.get(retryKey) || 0;
              const retryPlan = planIndicatorRangeRetry({
                attempts,
                retryAfterMs: payload.detail?.retryAfterMs,
              });
              if (retryPlan.shouldRetry) {
                rangeRetryAttemptsRef.current.set(retryKey, retryPlan.nextAttempts);
                setTimeout(run, retryPlan.delayMs);
                return;
              }
              // Backfill completion/recomputed events are the primary wake-up.
              // Do not turn a readiness probe into an unbounded polling loop,
              // and release dedup so the completion event can retry immediately.
              rangeRetryAttemptsRef.current.delete(retryKey);
              rangeRequestStartedAtRef.current.delete(rangeRequestKey);
              settleRangeRequest(false, {
                code: payload.code,
                deferred: true,
                payload,
              });
              finishRangeRequest();
              return;
            }
            rangeRetryAttemptsRef.current.delete(retryKey);
            if (String(reason || "").startsWith("auto-")) {
              console.warn("Indicator range auto-catchup failed", payload);
            } else {
              setIndicatorError(indicator.id, formatIndicatorError(payload, "Indicator range error"));
            }
            settleRangeRequest(false, { code: payload.code, payload });
            finishRangeRequest();
            return;
          }

          rangeRetryAttemptsRef.current.delete(retryKey);
          applyWsReplaceRange(indicator.id, payload);
          settleRangeRequest(true, { payload });
          finishRangeRequest();
        } catch (err) {
          if (!activeIndicatorsRef.current.some((item) => item.id === indicator.id)) {
            finishRangeRequest();
            return;
          }
          setIndicatorError(indicator.id, err?.message || "Indicator range request failed");
          settleRangeRequest(false, { error: err });
          finishRangeRequest();
        }
      };
      run();
    });

    return true;
  }, [
    activeIndicatorsRef,
    applyWsReplaceRange,
    candleDownColorRef,
    candleUpColorRef,
    chartDataRef,
    runtimeContextRef,
    setIndicatorError,
  ]);

  const { forceHostedSubscriptions } = useIndicatorStreamController({
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
    requestIndicatorRange,
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
      const sent = requestIndicatorRangeOnce(
        requestIndicatorRange,
        request.start,
        request.end,
        request.reason,
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
    autoRightCatchupRangeSignaturesRef.current.clear();
    autoRightCatchupPendingRef.current = null;
    if (autoRightCatchupTimerRef.current) {
      clearTimeout(autoRightCatchupTimerRef.current);
      autoRightCatchupTimerRef.current = null;
    }
    initialHostedRangeSignaturesRef.current.clear();
    rangeRetryAttemptsRef.current.clear();
    rangeRequestInFlightRef.current.clear();
    rangeRequestStartedAtRef.current.clear();
  }, [exchange, interval, marketType, sessionKey, symbol]);

  useEffect(() => {
    if (!chartDataReady || !Array.isArray(chartData) || chartData.length === 0) return;
    const hostedIndicators = getVisibleHostedIndicators(activeIndicators);
    if (hostedIndicators.length === 0) return;

    const currentVisibleRange = typeof getCurrentVisibleRange === "function"
      ? getCurrentVisibleRange()
      : null;
    const initialRange = resolveInitialHostedRange(
      chartData,
      hostedIndicators,
      currentVisibleRange || savedVisibleRange,
    );
    if (!initialRange) return;

    const intervalParts = parseIntervalParts(interval);
    const intervalSeconds = parseIntervalSeconds(interval) || inferIntervalSecondsFromChartData(chartData);
    if (intervalParts?.unit !== "M") {
      const segment = chartData.slice(initialRange.startIndex, initialRange.endIndex + 1);
      if (!isContinuousChartRange(segment, intervalSeconds)) return;
    }

    const signature = buildHostedCatchupSignature({
      exchange,
      marketType,
      symbol,
      interval,
      hostedIndicators,
      start: initialRange.start,
      end: initialRange.end,
    });
    if (initialHostedRangeSignaturesRef.current.has(signature)) return;
    let failed = false;
    if (requestIndicatorRange(initialRange.start, initialRange.end, "initial-visible", {
      onSettled: (ok) => {
        if (!ok && !failed) {
          failed = true;
          initialHostedRangeSignaturesRef.current.delete(signature);
        }
      },
    })) {
      initialHostedRangeSignaturesRef.current.add(signature);
    }
  }, [
    activeIndicators,
    chartData,
    chartDataReady,
    exchange,
    getCurrentVisibleRange,
    interval,
    marketType,
    requestIndicatorRange,
    savedVisibleRange,
    symbol,
  ]);

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

    const sent = requestIndicatorRangeOnce(
      requestIndicatorRange,
      missingRange.start,
      missingRange.end,
      "auto-catchup",
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

  useEffect(() => {
    if (!chartDataReady || !Array.isArray(chartData) || chartData.length === 0) {
      autoRightCatchupPendingRef.current = null;
      if (autoRightCatchupTimerRef.current) {
        clearTimeout(autoRightCatchupTimerRef.current);
        autoRightCatchupTimerRef.current = null;
      }
      return;
    }

    const hostedIndicators = getVisibleHostedIndicators(activeIndicators);
    if (hostedIndicators.length === 0) {
      autoRightCatchupPendingRef.current = null;
      if (autoRightCatchupTimerRef.current) {
        clearTimeout(autoRightCatchupTimerRef.current);
        autoRightCatchupTimerRef.current = null;
      }
      return;
    }

    const missingRange = resolveMissingHostedRightRange(chartData, hostedIndicators);
    if (!missingRange) {
      autoRightCatchupPendingRef.current = null;
      if (autoRightCatchupTimerRef.current) {
        clearTimeout(autoRightCatchupTimerRef.current);
        autoRightCatchupTimerRef.current = null;
      }
      return;
    }

    const signature = buildHostedCatchupSignature({
      exchange,
      marketType,
      symbol,
      interval,
      hostedIndicators,
      start: missingRange.start,
      end: missingRange.end,
    });
    if (autoRightCatchupRangeSignaturesRef.current.has(signature)) return;

    const pendingKey = buildHostedCatchupSignature({
      exchange,
      marketType,
      symbol,
      interval,
      hostedIndicators,
      start: missingRange.start,
      end: "pending-right",
    });
    const pending = planDeferredRightCatchup(
      autoRightCatchupPendingRef.current,
      {
        key: pendingKey,
        signature,
        range: { start: missingRange.start, end: missingRange.end },
      },
      Date.now(),
      RIGHT_CATCHUP_GRACE_MS,
    );
    autoRightCatchupPendingRef.current = pending;

    if (autoRightCatchupTimerRef.current) {
      clearTimeout(autoRightCatchupTimerRef.current);
      autoRightCatchupTimerRef.current = null;
    }

    autoRightCatchupTimerRef.current = setTimeout(() => {
      const latest = autoRightCatchupPendingRef.current;
      autoRightCatchupTimerRef.current = null;
      if (!latest || latest.key !== pendingKey) return;
      if (autoRightCatchupRangeSignaturesRef.current.has(latest.signature)) {
        autoRightCatchupPendingRef.current = null;
        return;
      }
      const sent = requestIndicatorRangeOnce(
        requestIndicatorRange,
        latest.range.start,
        latest.range.end,
        "auto-right-catchup",
      );
      if (sent) {
        autoRightCatchupRangeSignaturesRef.current.add(latest.signature);
        autoRightCatchupPendingRef.current = null;
      }
    }, pending?.delayMs ?? RIGHT_CATCHUP_GRACE_MS);

    return () => {
      if (autoRightCatchupTimerRef.current) {
        clearTimeout(autoRightCatchupTimerRef.current);
        autoRightCatchupTimerRef.current = null;
      }
    };
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
    const cachedEntries = resolveCachedIndicatorResults(activeIndicatorsRef.current, getIndicatorCacheContext());
    const cachedById = new Map(cachedEntries.map((entry) => [entry.indicatorId, entry]));
    setActiveIndicators((prev) =>
      prev.map((indicator) => {
        const cached = cachedById.get(indicator.id);
        return {
          ...indicator,
          lines: cached?.normalized?.lines || clearIndicatorLineData(indicator.lines || []),
          error: null,
          ...(cached?.schema?.length > 0 ? { paramSchema: cached.schema } : {}),
        };
      })
    );
    outputDispatch({ type: "hydrate-cache", entries: cachedEntries });
  }, [
    activeIndicatorsRef,
    exchange,
    getIndicatorCacheContext,
    interval,
    marketType,
    setActiveIndicators,
    symbol,
  ]);

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
