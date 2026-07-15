import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { ChartSessionRuntime } from "../chart-session/chartSessionTypes.js";
import type { MarketDataRuntime } from "../market-data/useMarketDataRuntime.js";
import type { ChartDataCommitMeta } from "../market-data/useChartDataRuntime.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type { IndicatorRangeEvent } from "../market-data/klineContracts.js";
import { useActiveIndicatorStore } from "./activeIndicatorStore.js";
import { resolveRealtimeHistogramColor } from "./indicatorRealtimeColor.js";
import { computeIndicatorRangeBatch } from "../../services/indicatorApi.js";
import { useIndicatorComputeController } from "./indicatorComputeController.js";
import { parseIntervalParts, parseIntervalSeconds } from "../../utils/intervals.js";
import {
  createIndicatorOutputState,
  indicatorOutputReducer,
} from "./indicatorOutputReducer.js";
import { buildIndicatorPaneData } from "./indicatorPaneProjection.js";
import { useIndicatorStreamController } from "./indicatorStreamController.js";
import {
  getVisibleHostedIndicators,
  buildHostedSubscriptionMessage,
  resolveIndicatorSubscriptionCachePolicy,
} from "./indicatorWsRuntime.js";
import {
  inferFixedIntervalClosedThrough,
  planDeferredRightCatchup,
  RIGHT_CATCHUP_GRACE_MS,
  resolveInitialHostedRange,
} from "./indicatorRangePlanning.js";
import {
  buildIndicatorCacheContext,
  buildIndicatorCacheHydrationSignature,
  buildIndicatorResultCacheKey,
  cacheIndicatorSnapshot,
  getCachedIndicatorComputedSegments,
  getCachedIndicatorResult,
  getCachedIndicatorResumeState,
  invalidateCachedIndicatorRange,
  patchCachedIndicatorResult,
  rebaseCachedIndicatorRevision,
  replaceCachedIndicatorRange,
  resolveCachedIndicatorResults,
  upsertCachedIndicatorLinePoint,
} from "./indicatorResultCacheStore.js";
import {
  clampIndicatorRangeToClosedThrough,
  normalizeIndicatorRange,
  normalizeIndicatorRevision,
  planIndicatorDirtyRefresh,
} from "./indicatorRangeCoverage.js";
import { createIndicatorRangeScheduler } from "./indicatorRangeScheduler.js";
import { createIndicatorRangeBatcher } from "./indicatorRangeBatcher.js";
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
} from "./indicatorPayloadRuntime.js";
import type {
  DeferredRightCatchupPlan,
  IndicatorDefinition,
  IndicatorLine,
  IndicatorOutputState,
  IndicatorParams,
  IndicatorPayloadEnvelope,
  IndicatorRange,
  IndicatorRangeRequest,
  IndicatorRecomputedMessage,
  IndicatorRevision,
  IndicatorSnapshotMessage,
  IndicatorPatchMessage,
  IndicatorReplaceRangeMessage,
  IndicatorSubscribeMessage,
  IndicatorSubscribedMessage,
  IndicatorVisibleRange,
  IndicatorValuePoint,
  IndicatorValuesMessage,
} from "./indicatorTypes.js";

interface UseIndicatorRuntimeOptions {
  session?: ChartSessionRuntime;
  marketData?: MarketDataRuntime;
  candleDownColor?: string;
  candleUpColor?: string;
  chartData?: KlineBar[];
  chartDataMeta?: ChartDataCommitMeta | null;
  datasetKey?: string;
  exchange?: string;
  getCurrentVisibleRange?: () => unknown;
  interval?: string;
  indicatorRangeRequests?: IndicatorRangeEvent[];
  consumeIndicatorRangeRequest?: (requestId: number) => void;
  marketType?: string;
  seriesReady?: number;
  sessionKey?: string;
  savedVisibleRange?: unknown;
  symbol?: string;
  onIndicatorRemoved?: (indicatorId: string) => void;
}

interface ResolvedIndicatorRuntimeInputs {
  candleDownColor: string;
  candleUpColor: string;
  chartData: KlineBar[];
  chartDataMeta: ChartDataCommitMeta | null;
  datasetKey: string;
  exchange: string;
  getCurrentVisibleRange?: () => unknown;
  interval: string;
  indicatorRangeRequests: IndicatorRangeEvent[];
  consumeIndicatorRangeRequest?: (requestId: number) => void;
  marketType: string;
  seriesReady: number;
  sessionKey: string;
  savedVisibleRange: IndicatorVisibleRange | null;
  symbol: string;
}

interface HostedReadinessOptions {
  indicatorIds?: Iterable<unknown>;
  subscribedIds?: Iterable<unknown> | null;
  waitStartedAt?: number | null;
  now?: number;
  timeoutMs?: number;
}

interface IndicatorRangeRetryOptions {
  attempts?: number;
  retryAfterMs?: unknown;
  maxAttempts?: number;
}

export interface IndicatorRangeRetryPlan {
  delayMs: number | null;
  nextAttempts: number;
  shouldRetry: boolean;
}

interface HostedCatchupSignatureOptions {
  exchange: string;
  marketType: string;
  symbol: string;
  interval: string;
  hostedIndicators: IndicatorDefinition[];
  start: unknown;
  end: unknown;
}

interface IndicatorRangeRequestOptions {
  indicatorIds?: Array<string | number>;
  waitForSubscription?: boolean;
  revision?: unknown;
  onSettled?: (ok: boolean, detail: Record<string, unknown>) => void;
  invalidate?: boolean;
  cascadeRight?: boolean;
}

interface IndicatorRangeTargetRuntime {
  key: string;
  indicator: IndicatorDefinition;
  message: IndicatorSubscribeMessage;
}

type RequestIndicatorRange = (
  start: unknown,
  end: unknown,
  reason?: string,
  options?: IndicatorRangeRequestOptions,
) => boolean;

interface IndicatorRuntimeError extends Error {
  code?: string;
  payload: IndicatorPayloadEnvelope;
  deferred: boolean;
}

type IndicatorReplacePayload = IndicatorReplaceRangeMessage
  | (IndicatorPayloadEnvelope & { range: IndicatorRange });

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asIndicatorVisibleRange(value: unknown): IndicatorVisibleRange | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function isIndicatorRuntimeError(value: unknown): value is IndicatorRuntimeError {
  return value instanceof Error && "deferred" in value && "payload" in value;
}

export interface IndicatorRuntime {
  view: {
    activeIndicators: IndicatorDefinition[];
    mainOverlayLines: ReturnType<typeof buildIndicatorPaneData>["mainOverlayLines"];
    subPanes: ReturnType<typeof buildIndicatorPaneData>["subPanes"];
  } & IndicatorOutputState;
  actions: {
    addIndicator(indicator: IndicatorDefinition): void;
    computeAll(force?: boolean): Promise<void>;
    ensureVisibleIndicatorRange(visibleRange: unknown): boolean;
    recompute(force?: boolean): void;
    removeIndicator(indicatorId: string): void;
    requestIndicatorRange: RequestIndicatorRange;
    toggleVisibility(indicatorId: string): void;
    updateIndicatorParams(indicatorId: string, params: IndicatorParams): void;
    updateIndicatorScript(indicatorId: string, script: string): void;
  };
  status: { computing: boolean };
}

function useLatestRef<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

function resolveRuntimeInputs(
  options: UseIndicatorRuntimeOptions = {},
): ResolvedIndicatorRuntimeInputs {
  const sessionView = options.session?.view;
  const marketDataView = options.marketData?.view;
  const marketDataActions = options.marketData?.actions;
  const marketDataStatus = options.marketData?.status;
  const inputs: ResolvedIndicatorRuntimeInputs = {
    candleDownColor: options.candleDownColor || "#ef4444",
    candleUpColor: options.candleUpColor || "#22c55e",
    chartData: options.chartData ?? marketDataView?.bars ?? [],
    chartDataMeta: options.chartDataMeta ?? marketDataView?.meta ?? null,
    datasetKey: options.datasetKey ?? sessionView?.datasetKey ?? "",
    exchange: options.exchange ?? sessionView?.exchange ?? "binance",
    interval: options.interval ?? sessionView?.interval ?? "",
    indicatorRangeRequests: options.indicatorRangeRequests ?? marketDataStatus?.indicatorRangeRequests ?? [],
    marketType: options.marketType ?? sessionView?.marketType ?? "spot",
    seriesReady: options.seriesReady ?? (marketDataStatus?.activeChartReady ? 1 : 0),
    sessionKey: options.sessionKey ?? sessionView?.sessionKey ?? "",
    savedVisibleRange: asIndicatorVisibleRange(
      options.savedVisibleRange ?? sessionView?.savedVisibleRange ?? null,
    ),
    symbol: options.symbol ?? sessionView?.symbol ?? "",
  };
  if (options.getCurrentVisibleRange !== undefined) {
    inputs.getCurrentVisibleRange = options.getCurrentVisibleRange;
  }
  const consumeIndicatorRangeRequest =
    options.consumeIndicatorRangeRequest ??
    marketDataActions?.consumeIndicatorRangeRequest;
  if (consumeIndicatorRangeRequest !== undefined) {
    inputs.consumeIndicatorRangeRequest = consumeIndicatorRangeRequest;
  }
  return inputs;
}

const INDICATOR_RANGE_RETRY_MS = 500;
const INDICATOR_HTTP_RANGE_RETRY_MAX_ATTEMPTS = 1;
const INDICATOR_HTTP_RANGE_RETRY_DEFAULT_MS = 3000;
export const INDICATOR_SUBSCRIPTION_ACK_TIMEOUT_MS = 2_000;

export function hostedIndicatorRangeRequestsReady({
  indicatorIds = [],
  subscribedIds,
  waitStartedAt,
  now = Date.now(),
  timeoutMs = INDICATOR_SUBSCRIPTION_ACK_TIMEOUT_MS,
}: HostedReadinessOptions = {}): boolean {
  const ids = Array.from(indicatorIds || []).map((value) => String(value));
  if (ids.length === 0) return false;
  const subscribed = subscribedIds instanceof Set
    ? new Set(Array.from(subscribedIds, (value) => String(value)))
    : new Set(Array.from(subscribedIds || [], (value) => String(value)));
  if (ids.every((id) => subscribed.has(id))) return true;
  if (waitStartedAt == null) return false;
  const startedAt = Number(waitStartedAt);
  return Number.isFinite(startedAt) && now - startedAt >= timeoutMs;
}

export function planIndicatorRangeRetry({
  attempts,
  retryAfterMs,
  maxAttempts = INDICATOR_HTTP_RANGE_RETRY_MAX_ATTEMPTS,
}: IndicatorRangeRetryOptions = {}): IndicatorRangeRetryPlan {
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

export function isTypedIndicatorRangeWait(
  payload: Partial<IndicatorPayloadEnvelope> | null | undefined,
): boolean {
  const detail = payload?.detail && typeof payload.detail === "object" && !Array.isArray(payload.detail)
    ? payload.detail as Record<string, unknown>
    : {};
  return payload?.code === "INDICATOR_RANGE_NOT_READY" && (
    Number(payload?.__httpStatus) === 202
    || Number.isFinite(Number(detail.waitedMs))
    || Array.isArray(detail.backfillRequestIds)
  );
}

function indicatorAvailabilityValue(
  payload: Partial<IndicatorPayloadEnvelope> | null | undefined,
  field: string,
): unknown {
  const topLevel = recordValue(payload);
  if (topLevel[field] !== undefined) return topLevel[field];
  const detail = recordValue(payload?.detail);
  const availability = recordValue(detail.availability);
  return availability[field] ?? detail[field];
}

export function isResolvedIndicatorRangeEmpty(
  payload: Partial<IndicatorPayloadEnvelope> | null | undefined,
): boolean {
  if (payload?.code !== "INDICATOR_RANGE_EMPTY") return false;
  const historyState = indicatorAvailabilityValue(payload, "history_state");
  const complete = indicatorAvailabilityValue(payload, "complete");
  const retryable = indicatorAvailabilityValue(payload, "retryable");
  return historyState === "exhausted" || complete === true || retryable === false;
}

function abortableDelay(delayMs: number | null, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, delayMs ?? 0);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function indicatorRangePayloadError(
  payload: IndicatorPayloadEnvelope,
  fallback: string,
): IndicatorRuntimeError {
  const error = new Error(formatIndicatorError(payload, fallback)) as IndicatorRuntimeError;
  if (payload.code !== undefined) error.code = payload.code;
  error.payload = payload;
  error.deferred = payload?.code === "INDICATOR_RANGE_NOT_READY";
  return error;
}

function normalizeRangeBoundary(value: unknown): number | null {
  const normalized = Math.floor(Number(value));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function inferIntervalSecondsFromChartData(chartData: KlineBar[] = []): number | null {
  if (!Array.isArray(chartData) || chartData.length < 2) return null;
  const deltas: number[] = [];
  const sampleStart = Math.max(1, chartData.length - 16);
  for (let index = sampleStart; index < chartData.length; index += 1) {
    const current = Number(chartData[index]?.time);
    const prev = Number(chartData[index - 1]?.time);
    const delta = current - prev;
    if (Number.isFinite(delta) && delta > 0) deltas.push(delta);
  }
  if (!deltas.length) return null;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)] ?? null;
}

function requestIndicatorRangeOnce(
  requestRange: RequestIndicatorRange | null | undefined,
  start: unknown,
  end: unknown,
  reason = "range",
): boolean {
  if (typeof requestRange !== "function") return false;
  const startSec = normalizeRangeBoundary(start);
  const endSec = normalizeRangeBoundary(end);
  if (!startSec || !endSec || startSec > endSec) return false;
  return Boolean(requestRange(startSec, endSec, reason));
}

function buildHostedCatchupSignature({
  exchange,
  marketType,
  symbol,
  interval,
  hostedIndicators,
  start,
  end,
}: HostedCatchupSignatureOptions): string {
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

function latestLineTime(indicator: IndicatorDefinition): number | null {
  let latest: number | null = null;
  for (const line of indicator?.lines || []) {
    for (const point of line?.data || []) {
      const time = normalizeRangeBoundary(point?.time);
      if (!time) continue;
      latest = latest == null ? time : Math.max(latest, time);
    }
  }
  return latest;
}

function resolveMissingHostedRightRange(
  chartData: KlineBar[],
  hostedIndicators: IndicatorDefinition[],
): (IndicatorRange & { intervalSeconds: number }) | null {
  const end = normalizeRangeBoundary(chartData?.[chartData.length - 1]?.time);
  if (!end) return null;
  const intervalSeconds = inferIntervalSecondsFromChartData(chartData);
  if (!intervalSeconds || intervalSeconds <= 0) return null;

  let start: number | null = null;
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

function isContinuousChartRange(chartData: KlineBar[], intervalSeconds: number | null): boolean {
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

export function useIndicatorRuntime(
  options: UseIndicatorRuntimeOptions = {},
): IndicatorRuntime {
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

  const removeIndicator = useCallback((indicatorId: string) => {
    removeActiveIndicator(indicatorId);
    outputDispatch({ type: "remove-indicator", indicatorId });
    onIndicatorRemoved?.(indicatorId);
  }, [onIndicatorRemoved, removeActiveIndicator]);

  const activeIndicatorsRef = useLatestRef(activeIndicators);
  const chartDataRef = useLatestRef(chartData);
  const chartDataMetaRef = useLatestRef(chartDataMeta);
  const candleUpColorRef = useLatestRef(candleUpColor);
  const candleDownColorRef = useLatestRef(candleDownColor);
  const consumedIndicatorRangeRequestIdsRef = useRef<Set<number>>(new Set());
  const autoRightCatchupRangeSignaturesRef = useRef<Set<string>>(new Set());
  const autoRightCatchupPendingRef = useRef<DeferredRightCatchupPlan | null>(null);
  const autoRightCatchupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialHostedRangeSignaturesRef = useRef<Set<string>>(new Set());
  const hostedSubscribedIdsRef = useRef<Set<string>>(new Set());
  const hostedPendingResumePatchIdsRef = useRef<Set<string>>(new Set());
  const hostedSubscriptionSessionKeyRef = useRef<string | null>(null);
  const hostedSubscriptionWaitStartedAtRef = useRef<number | null>(null);
  const hostedSubscriptionWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seriesRevisionRef = useRef<IndicatorRevision | null>(null);
  const visibleRangeEnsureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingVisibleRangeRef = useRef<IndicatorVisibleRange | null>(null);
  const [indicatorRangeScheduler] = useState(() => (
    createIndicatorRangeScheduler<IndicatorRangeTargetRuntime, IndicatorPayloadEnvelope>()
  ));
  const [indicatorRangeBatcher] = useState(() => createIndicatorRangeBatcher<
    IndicatorRangeRequest,
    IndicatorPayloadEnvelope
  >({
    sendBatch: ({ requests, signal }) => computeIndicatorRangeBatch({ requests, signal }),
  }));
  const [rangeRetryTick, setRangeRetryTick] = useState(0);
  const [subscriptionAckTick, setSubscriptionAckTick] = useState(0);
  const runtimeContextRef = useLatestRef({
    exchange,
    interval,
    marketType,
    sessionKey,
    symbol,
  });

  const chartDataStatus = chartDataMeta?.status || "idle";
  const chartDataReady = Boolean(chartData?.length && chartDataStatus === "ready");
  const indicatorCacheHydrationSignature = useMemo(() => (
    buildIndicatorCacheHydrationSignature(activeIndicators, {
      candleDownColor,
      candleUpColor,
      exchange,
      interval,
      marketType,
      symbol,
    })
  ), [
    activeIndicators,
    candleDownColor,
    candleUpColor,
    exchange,
    interval,
    marketType,
    symbol,
  ]);

  useLayoutEffect(() => {
    initialHostedRangeSignaturesRef.current.clear();
    autoRightCatchupRangeSignaturesRef.current.clear();
  }, [indicatorCacheHydrationSignature]);

  const resetHostedSubscriptionReadiness = useCallback(() => {
    const context = runtimeContextRef.current;
    hostedSubscriptionSessionKeyRef.current = [
      context.sessionKey,
      context.exchange,
      context.marketType,
      context.symbol,
      context.interval,
    ].join("|");
    hostedSubscribedIdsRef.current.clear();
    hostedPendingResumePatchIdsRef.current.clear();
    seriesRevisionRef.current = null;
    hostedSubscriptionWaitStartedAtRef.current = Date.now();
    if (hostedSubscriptionWaitTimerRef.current) {
      clearTimeout(hostedSubscriptionWaitTimerRef.current);
    }
    setSubscriptionAckTick((tick) => tick + 1);
    hostedSubscriptionWaitTimerRef.current = setTimeout(() => {
      hostedSubscriptionWaitTimerRef.current = null;
      setSubscriptionAckTick((tick) => tick + 1);
    }, INDICATOR_SUBSCRIPTION_ACK_TIMEOUT_MS);
  }, [runtimeContextRef]);

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

  const markHostedSubscriptionReady = useCallback((indicatorId: string) => {
    hostedPendingResumePatchIdsRef.current.delete(String(indicatorId));
    hostedSubscribedIdsRef.current.add(String(indicatorId));
    const hostedIds = getVisibleHostedIndicators(activeIndicatorsRef.current).map((item) => String(item.id));
    if (hostedIds.every((id) => hostedSubscribedIdsRef.current.has(id))) {
      if (hostedSubscriptionWaitTimerRef.current) {
        clearTimeout(hostedSubscriptionWaitTimerRef.current);
        hostedSubscriptionWaitTimerRef.current = null;
      }
    }
    setSubscriptionAckTick((tick) => tick + 1);
  }, [activeIndicatorsRef]);

  const markHostedSubscriptionPending = useCallback((indicatorId: string) => {
    hostedSubscribedIdsRef.current.delete(String(indicatorId));
    hostedPendingResumePatchIdsRef.current.delete(String(indicatorId));
    hostedSubscriptionWaitStartedAtRef.current = Date.now();
    if (hostedSubscriptionWaitTimerRef.current) {
      clearTimeout(hostedSubscriptionWaitTimerRef.current);
    }
    hostedSubscriptionWaitTimerRef.current = setTimeout(() => {
      hostedSubscriptionWaitTimerRef.current = null;
      setSubscriptionAckTick((tick) => tick + 1);
    }, INDICATOR_SUBSCRIPTION_ACK_TIMEOUT_MS);
  }, []);

  const applyWsSnapshot = useCallback((indicatorId: string, payload: IndicatorSnapshotMessage) => {
    const error = payload?.ok === false ? formatIndicatorError(payload) : null;
    const schema = normalizeParamSchema(payload?.param_schema);
    const normalized = normalizeIndicatorPayload(payload, indicatorId);
    const indicator = activeIndicatorsRef.current.find((item) => item.id === indicatorId);
    if (!indicator) return;
    const dataRevision = normalizeIndicatorRevision(payload);
    if (dataRevision) seriesRevisionRef.current = dataRevision;
    if (!error) {
      cacheIndicatorSnapshot(
        indicator,
        getIndicatorCacheContext(),
        normalized,
        schema,
        {
          ...(payload.range !== undefined ? { range: payload.range } : {}),
          ...(dataRevision !== null ? { revision: dataRevision } : {}),
        },
      );
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

  const applyWsPatch = useCallback((indicatorId: string, payload: IndicatorPatchMessage) => {
    const normalized = normalizeIndicatorPayload(payload, indicatorId);
    const indicator = activeIndicatorsRef.current.find((item) => item.id === indicatorId);
    if (!indicator) return;
    const dataRevision = normalizeIndicatorRevision(payload);
    if (dataRevision) seriesRevisionRef.current = dataRevision;
    if (payload?.ok !== false) {
      patchCachedIndicatorResult(indicator, getIndicatorCacheContext(), normalized, {
        range: payload?.range,
        revision: dataRevision,
      });
      if (hostedPendingResumePatchIdsRef.current.has(String(indicatorId))) {
        markHostedSubscriptionReady(indicatorId);
      }
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
  }, [activeIndicatorsRef, getIndicatorCacheContext, markHostedSubscriptionReady, setActiveIndicators]);

  const applyWsReplaceRange = useCallback((
    indicatorId: string,
    payload: IndicatorReplacePayload,
  ) => {
    const normalized = normalizeIndicatorPayload(payload, indicatorId);
    const range = payload?.range;
    const indicator = activeIndicatorsRef.current.find((item) => item.id === indicatorId);
    if (!indicator) return;
    const dataRevision = normalizeIndicatorRevision(payload);
    if (dataRevision) seriesRevisionRef.current = dataRevision;
    const resolvedEmpty = isResolvedIndicatorRangeEmpty(payload);
    if (payload?.ok !== false || resolvedEmpty) {
      replaceCachedIndicatorRange(indicator, getIndicatorCacheContext(), normalized, range, {
        revision: dataRevision,
      });
    }

    setActiveIndicators((prev) =>
      prev.map((indicator) =>
        indicator.id === indicatorId
          ? {
              ...indicator,
              lines: replaceIndicatorLinesRange(indicator.lines || [], normalized.lines, range),
              error: payload?.ok === false && !resolvedEmpty ? formatIndicatorError(payload) : null,
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

  const applyWsValues = useCallback((
    indicatorId: string,
    values: Record<string, unknown>,
    barTime: number,
    isFinal = true,
    payload: IndicatorValuesMessage | null = null,
  ) => {
    if (!values || !barTime) return;
    const dataRevision = isFinal ? normalizeIndicatorRevision(payload) : null;
    if (dataRevision) seriesRevisionRef.current = dataRevision;
    const currentChartData = chartDataRef.current || [];
    const payloadBar = payload?.bar;
    const bar = payloadBar && Number(payloadBar.time) === Number(barTime)
      ? payloadBar
      : currentChartData.find((item) => Number(item.time) === Number(barTime));

    setActiveIndicators((prev) =>
      prev.map((indicator) => {
        if (indicator.id !== indicatorId || !Array.isArray(indicator.lines)) return indicator;
        const resolveHistogramColor = (line: IndicatorLine, value: unknown) => (
          resolveRealtimeHistogramColor({
            bar,
            downColor: candleDownColorRef.current,
            indicator,
            line,
            upColor: candleUpColorRef.current,
            value,
          })
        );
        if (isFinal) {
          upsertCachedIndicatorLinePoint(
            indicator,
            getIndicatorCacheContext(),
            values,
            barTime,
            resolveHistogramColor,
          );
          if (dataRevision) {
            rebaseCachedIndicatorRevision(indicator, getIndicatorCacheContext(), dataRevision);
          }
        }
        const isSingleLine = indicator.lines.length === 1 && Object.keys(values).length === 1;
        const lines = indicator.lines.map((line) => {
          const value = resolveWsValue(line, values, isSingleLine);
          if (value === undefined) return line;
          const point: IndicatorValuePoint = { time: barTime, value: Number(value) };
          const histogramColor = resolveHistogramColor(line, value);
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

  const setIndicatorError = useCallback((indicatorId: string, error: string) => {
    setActiveIndicators((prev) =>
      prev.map((indicator) => (indicator.id === indicatorId ? { ...indicator, error } : indicator))
    );
  }, [setActiveIndicators]);

  const requestIndicatorRange: RequestIndicatorRange = useCallback((
    start: unknown,
    end: unknown,
    reason = "range",
    options: IndicatorRangeRequestOptions = {},
  ) => {
    const startSec = normalizeRangeBoundary(start);
    const endSec = normalizeRangeBoundary(end);
    if (!startSec || !endSec || startSec > endSec) return false;

    const targetIds = Array.isArray(options.indicatorIds)
      ? new Set(options.indicatorIds.map((item) => String(item)))
      : null;
    const hostedIndicators = getVisibleHostedIndicators(activeIndicatorsRef.current)
      .filter((indicator) => !targetIds || targetIds.has(String(indicator.id)));
    if (hostedIndicators.length === 0) return false;
    const onSettled = options.onSettled;

    const requestContext = runtimeContextRef.current;
    const contextKey = [
      requestContext.sessionKey,
      requestContext.exchange,
      requestContext.marketType,
      requestContext.symbol,
      requestContext.interval,
    ].join("|");
    const subscriptionGateExempt = options.waitForSubscription === false
      || reason === "recomputed"
      || reason === "ws-history-required";
    if (
      !subscriptionGateExempt
      && (
        hostedSubscriptionSessionKeyRef.current !== contextKey
        || !hostedIndicatorRangeRequestsReady({
          indicatorIds: hostedIndicators.map((indicator) => indicator.id),
          subscribedIds: hostedSubscribedIdsRef.current,
          waitStartedAt: hostedSubscriptionWaitStartedAtRef.current,
        })
      )
    ) {
      return false;
    }
    const cacheContext = getIndicatorCacheContext();
    const cachedRevision = hostedIndicators
      .map((indicator) => getCachedIndicatorResult(indicator, cacheContext)?.revision)
      .find(Boolean);
    const serverRevision = normalizeIndicatorRevision(
      options.revision
        || chartDataMetaRef.current?.dataRevision
        || normalizeIndicatorRevision(chartDataMetaRef.current)
        || seriesRevisionRef.current
        || cachedRevision,
    );
    const inferredClosedThrough = inferFixedIntervalClosedThrough(
      chartDataRef.current,
      requestContext.interval,
    );
    const revision = inferredClosedThrough
      ? {
        ...(serverRevision || {}),
        closedThrough: serverRevision?.closedThrough
          ? Math.min(serverRevision.closedThrough, inferredClosedThrough)
          : inferredClosedThrough,
      }
      : serverRevision;
    const clampedRange = clampIndicatorRangeToClosedThrough(
      { start: startSec, end: endSec },
      revision,
    );
    if (clampedRange.formingOnly) {
      if (onSettled) {
        queueMicrotask(() => {
          for (const indicator of hostedIndicators) {
            onSettled(true, {
              cacheHit: true,
              formingOnly: true,
              indicatorId: indicator.id,
            });
          }
        });
      }
      return true;
    }
    const requestEndSec = clampedRange.range?.end || endSec;
    const step = parseIntervalSeconds(requestContext.interval)
      || inferIntervalSecondsFromChartData(chartDataRef.current)
      || 1;
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
    const targets = hostedIndicators.map((indicator) => ({
      indicator,
      key: buildIndicatorResultCacheKey(indicator, cacheContext),
      message: buildHostedSubscriptionMessage(indicator, colorContext),
    }));

    if (options.invalidate) {
      for (const target of targets) {
        invalidateCachedIndicatorRange(target.indicator, cacheContext, { start: startSec, end: requestEndSec }, {
          cascadeRight: options.cascadeRight !== false,
          revision,
        });
      }
    }

    const scheduled = indicatorRangeScheduler.ensureCoverage({
      sessionKey: contextKey,
      targets,
      range: { start: startSec, end: requestEndSec },
      reason,
      revision,
      step,
      getCoveredSegments: (target) => getCachedIndicatorComputedSegments(
        target.indicator,
        cacheContext,
        revision,
      ),
      execute: async ({ range, reason: scheduledReason, signal, target }) => {
        let attempts = 0;
        while (true) {
          const message = target.message;
          const rangeRequest: IndicatorRangeRequest = {
            clientId: target.indicator.id,
            kind: message.kind,
            exchange: message.exchange,
            marketType: message.marketType,
            symbol: message.symbol,
            interval: message.interval,
            name: message.name || message.displayName,
            params: message.params,
            start: range.start,
            end: range.end,
            reason: scheduledReason,
            signal,
          };
          if (message.customId !== undefined) {
            rangeRequest.customId = message.customId;
          }
          if (message.script !== undefined) rangeRequest.script = message.script;
          if (message.securityMode !== undefined) {
            rangeRequest.securityMode = message.securityMode;
          }
          const payload = await indicatorRangeBatcher.schedule(rangeRequest);
          if (payload?.ok !== false || payload.code === "INDICATOR_RANGE_EMPTY") return payload;
          if (payload.code !== "INDICATOR_RANGE_NOT_READY") {
            throw indicatorRangePayloadError(payload, "Indicator range error");
          }
          if (isTypedIndicatorRangeWait(payload)) {
            throw indicatorRangePayloadError(payload, "Indicator range is not ready");
          }
          const retryPlan = planIndicatorRangeRetry({
            attempts,
            retryAfterMs: recordValue(payload.detail).retryAfterMs,
          });
          if (!retryPlan.shouldRetry) {
            throw indicatorRangePayloadError(payload, "Indicator range is not ready");
          }
          attempts = retryPlan.nextAttempts;
          await abortableDelay(retryPlan.delayMs, signal);
        }
      },
      apply: ({ range, result: payload, target }) => {
        if (payload?.code === "INDICATOR_RANGE_EMPTY" && !isResolvedIndicatorRangeEmpty(payload)) return;
        const currentIndicator = activeIndicatorsRef.current.find((item) => item.id === target.indicator.id);
        if (!currentIndicator) return;
        if (buildIndicatorResultCacheKey(currentIndicator, cacheContext) !== target.key) return;
        const responseRange = normalizeIndicatorRange(payload?.range) || range;
        applyWsReplaceRange(target.indicator.id, {
          ...payload,
          range: responseRange,
        });
      },
      onError: (error, { reason: scheduledReason, target }) => {
        if (isIndicatorRuntimeError(error) && error.deferred) return;
        if (String(scheduledReason || "").startsWith("auto-")) {
          console.warn(
            "Indicator range auto-catchup failed",
            isIndicatorRuntimeError(error) ? error.payload : error,
          );
          return;
        }
        if (activeIndicatorsRef.current.some((item) => item.id === target.indicator.id)) {
          setIndicatorError(
            target.indicator.id,
            error instanceof Error ? error.message : "Indicator range request failed",
          );
        }
      },
      ...(onSettled
        ? {
            onSettled: (ok: boolean, detail = {}) => onSettled(ok, {
              ...detail,
              indicatorId: detail.target?.indicator?.id,
            }),
          }
        : {}),
    });

    return scheduled.accepted;
  }, [
    activeIndicatorsRef,
    applyWsReplaceRange,
    candleDownColorRef,
    candleUpColorRef,
    chartDataMetaRef,
    chartDataRef,
    getIndicatorCacheContext,
    indicatorRangeBatcher,
    indicatorRangeScheduler,
    runtimeContextRef,
    setIndicatorError,
  ]);

  const ensureVisibleIndicatorRange = useCallback((visibleRange: unknown) => {
    pendingVisibleRangeRef.current = asIndicatorVisibleRange(visibleRange);
    if (visibleRangeEnsureTimerRef.current) clearTimeout(visibleRangeEnsureTimerRef.current);
    visibleRangeEnsureTimerRef.current = setTimeout(() => {
      visibleRangeEnsureTimerRef.current = null;
      const currentChartData = chartDataRef.current || [];
      const hostedIndicators = getVisibleHostedIndicators(activeIndicatorsRef.current);
      const desired = resolveInitialHostedRange(
        currentChartData,
        hostedIndicators,
        pendingVisibleRangeRef.current,
      );
      pendingVisibleRangeRef.current = null;
      if (desired) {
        requestIndicatorRange(desired.start, desired.end, "visible-range");
      }
    }, 120);
    return true;
  }, [activeIndicatorsRef, chartDataRef, requestIndicatorRange]);

  const resolveIndicatorResumeState = useCallback((indicator: IndicatorDefinition) => (
    getCachedIndicatorResumeState(indicator, getIndicatorCacheContext())
  ), [getIndicatorCacheContext]);

  const handleIndicatorRecomputed = useCallback((
    indicatorId: string,
    payload: IndicatorRecomputedMessage,
  ) => {
    const indicator = activeIndicatorsRef.current.find((item) => item.id === indicatorId);
    if (!indicator) return;
    const revision = normalizeIndicatorRevision(payload);
    if (revision) seriesRevisionRef.current = revision;
    const dirtyRange = normalizeIndicatorRange(
      revision?.dirtyRange || payload?.dirtyRange || payload?.dirty_range || payload?.range,
    );
    if (!dirtyRange) return;
    const cacheContext = getIndicatorCacheContext();
    invalidateCachedIndicatorRange(indicator, cacheContext, dirtyRange, {
      cascadeRight: true,
      revision,
    });

    const currentChartData = chartDataRef.current || [];
    const visibleRange = typeof getCurrentVisibleRange === "function"
      ? asIndicatorVisibleRange(getCurrentVisibleRange())
      : savedVisibleRange;
    const desired = resolveInitialHostedRange(currentChartData, [indicator], visibleRange);
    const refreshRange = planIndicatorDirtyRefresh(dirtyRange, desired);
    if (!refreshRange) return;
    requestIndicatorRange(
      refreshRange.start,
      refreshRange.end,
      "recomputed",
      { indicatorIds: [indicatorId], revision },
    );
  }, [
    activeIndicatorsRef,
    chartDataRef,
    getCurrentVisibleRange,
    getIndicatorCacheContext,
    requestIndicatorRange,
    savedVisibleRange,
  ]);

  const handleIndicatorSubscribed = useCallback((
    indicatorId: string,
    payload: IndicatorSubscribedMessage,
  ) => {
    const indicator = activeIndicatorsRef.current.find((item) => item.id === indicatorId);
    if (!indicator) return;
    const resumeStatus = payload?.resumeStatus || payload?.resume_status || "legacy";
    if (resumeStatus === "patch") {
      hostedPendingResumePatchIdsRef.current.add(String(indicatorId));
    } else {
      markHostedSubscriptionReady(indicatorId);
    }
    const cacheContext = getIndicatorCacheContext();
    const subscriptionCachePolicy = resolveIndicatorSubscriptionCachePolicy(payload);
    const { revision } = subscriptionCachePolicy;
    if (revision) seriesRevisionRef.current = revision;
    const cachedSegments = getCachedIndicatorComputedSegments(indicator, cacheContext);
    const explicitDirtyRange = subscriptionCachePolicy.dirtyRange;

    // `history_required` only means the server cannot produce a bounded WS
    // resume patch. It does not invalidate compatible frontend history by
    // itself; only an explicit revision invalidation or dirty range does.
    if (!subscriptionCachePolicy.invalidate) {
      if (revision) rebaseCachedIndicatorRevision(indicator, cacheContext, revision);
      return;
    }

    const firstCachedSegment = cachedSegments[0];
    const cachedRange = firstCachedSegment === undefined
      ? null
      : {
          start: cachedSegments.reduce(
            (value, segment) => Math.min(value, segment.start),
            firstCachedSegment.start,
          ),
          end: cachedSegments.reduce(
            (value, segment) => Math.max(value, segment.end),
            firstCachedSegment.end,
          ),
        };
    const invalidRange = explicitDirtyRange
      || normalizeIndicatorRange(
        payload?.range || payload?.resumeRange || payload?.resume_range || payload?.historyRange || payload?.history_range,
      )
      || cachedRange;
    if (invalidRange) {
      invalidateCachedIndicatorRange(indicator, cacheContext, invalidRange, {
        cascadeRight: true,
        revision,
      });
    }

    const currentChartData = chartDataRef.current || [];
    const visibleRange = typeof getCurrentVisibleRange === "function"
      ? asIndicatorVisibleRange(getCurrentVisibleRange())
      : savedVisibleRange;
    const desired = normalizeIndicatorRange(
      payload?.range || payload?.resumeRange || payload?.resume_range || payload?.historyRange || payload?.history_range,
    )
      || resolveInitialHostedRange(currentChartData, [indicator], visibleRange);
    if (desired) {
      requestIndicatorRange(desired.start, desired.end, "ws-history-required", {
        indicatorIds: [indicatorId],
        revision,
      });
    }
  }, [
    activeIndicatorsRef,
    chartDataRef,
    getCurrentVisibleRange,
    getIndicatorCacheContext,
    markHostedSubscriptionReady,
    requestIndicatorRange,
    savedVisibleRange,
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
    getIndicatorResumeState: resolveIndicatorResumeState,
    handleIndicatorRecomputed,
    handleIndicatorSubscriptionPending: markHostedSubscriptionPending,
    handleIndicatorSubscribed,
    interval,
    marketType,
    resetHostedSubscriptionReadiness,
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
      let requestedRange = normalizeIndicatorRange(request);
      if (request.reason === "window-delta") {
        const currentVisibleRange = typeof getCurrentVisibleRange === "function"
          ? asIndicatorVisibleRange(getCurrentVisibleRange())
          : savedVisibleRange;
        requestedRange = resolveInitialHostedRange(
          chartData,
          hostedIndicators,
          currentVisibleRange,
        ) || requestedRange;
      }
      const sent = requestIndicatorRangeOnce(
        requestIndicatorRange,
        requestedRange?.start,
        requestedRange?.end,
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
    getCurrentVisibleRange,
    indicatorRangeRequests,
    interval,
    marketType,
    rangeRetryTick,
    requestIndicatorRange,
    savedVisibleRange,
    sessionKey,
    subscriptionAckTick,
    symbol,
  ]);

  useEffect(() => {
    autoRightCatchupRangeSignaturesRef.current.clear();
    autoRightCatchupPendingRef.current = null;
    if (autoRightCatchupTimerRef.current) {
      clearTimeout(autoRightCatchupTimerRef.current);
      autoRightCatchupTimerRef.current = null;
    }
    if (visibleRangeEnsureTimerRef.current) {
      clearTimeout(visibleRangeEnsureTimerRef.current);
      visibleRangeEnsureTimerRef.current = null;
    }
    pendingVisibleRangeRef.current = null;
    initialHostedRangeSignaturesRef.current.clear();
    consumedIndicatorRangeRequestIdsRef.current.clear();
    hostedSubscribedIdsRef.current.clear();
    hostedPendingResumePatchIdsRef.current.clear();
    seriesRevisionRef.current = null;
    hostedSubscriptionSessionKeyRef.current = [
      sessionKey,
      exchange,
      marketType,
      symbol,
      interval,
    ].join("|");
    hostedSubscriptionWaitStartedAtRef.current = Date.now();
    if (hostedSubscriptionWaitTimerRef.current) {
      clearTimeout(hostedSubscriptionWaitTimerRef.current);
    }
    hostedSubscriptionWaitTimerRef.current = setTimeout(() => {
      hostedSubscriptionWaitTimerRef.current = null;
      setSubscriptionAckTick((tick) => tick + 1);
    }, INDICATOR_SUBSCRIPTION_ACK_TIMEOUT_MS);
    indicatorRangeScheduler.setSession([
      sessionKey,
      exchange,
      marketType,
      symbol,
      interval,
    ].join("|"));
  }, [
    exchange,
    indicatorRangeScheduler,
    interval,
    marketType,
    sessionKey,
    symbol,
  ]);

  useEffect(() => {
    indicatorRangeBatcher.reset();
    return () => {
      if (hostedSubscriptionWaitTimerRef.current) {
        clearTimeout(hostedSubscriptionWaitTimerRef.current);
        hostedSubscriptionWaitTimerRef.current = null;
      }
      if (visibleRangeEnsureTimerRef.current) {
        clearTimeout(visibleRangeEnsureTimerRef.current);
        visibleRangeEnsureTimerRef.current = null;
      }
      indicatorRangeBatcher.dispose();
      indicatorRangeScheduler.dispose();
    };
  }, [indicatorRangeBatcher, indicatorRangeScheduler]);

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
    subscriptionAckTick,
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
    subscriptionAckTick,
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

  useLayoutEffect(() => {
    const cachedEntries = resolveCachedIndicatorResults(activeIndicatorsRef.current, getIndicatorCacheContext());
    const cachedById = new Map(cachedEntries.map((entry) => [entry.indicatorId, entry]));
    setActiveIndicators((prev) =>
      prev.map((indicator) => {
        const cached = cachedById.get(indicator.id);
        return {
          ...indicator,
          lines: cached?.normalized?.lines || clearIndicatorLineData(indicator.lines || []),
          error: null,
          ...(cached && cached.schema.length > 0 ? { paramSchema: cached.schema } : {}),
        };
      })
    );
    outputDispatch({ type: "hydrate-cache", entries: cachedEntries });
  }, [
    activeIndicatorsRef,
    exchange,
    getIndicatorCacheContext,
    interval,
    indicatorCacheHydrationSignature,
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
    ensureVisibleIndicatorRange,
    recompute,
    removeIndicator,
    requestIndicatorRange,
    toggleVisibility,
    updateIndicatorParams,
    updateIndicatorScript,
  }), [
    addIndicator,
    computeAll,
    ensureVisibleIndicatorRange,
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
