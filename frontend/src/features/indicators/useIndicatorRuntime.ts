import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { ChartSessionRuntime } from "../chart-session/chartSessionTypes.js";
import type { MarketDataRuntime } from "../market-data/useMarketDataRuntime.js";
import type { ChartDataCommitMeta } from "../market-data/useChartDataRuntime.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type { IndicatorRangeEvent } from "../market-data/klineContracts.js";
import { useMarketDataWorkspaceResources } from "../market-data/marketDataWorkspaceContext.js";
import type { IndicatorStreamIdentity } from "./sharedIndicatorStreamCoordinator.js";
import { useActiveIndicatorStore } from "./activeIndicatorStore.js";
import type { ActiveIndicatorPersistence } from "./activeIndicatorStore.js";
import { resolveRealtimeHistogramColor } from "./indicatorRealtimeColor.js";
import {
  applyRealtimeIndicatorValuesToLines,
  currentContextualProvisionalIndicatorPreview,
  stageContextualProvisionalIndicatorPreview,
  shouldRetainProvisionalIndicatorPreview,
  type ContextualProvisionalIndicatorPreview,
  type ProvisionalIndicatorPreview,
} from "./indicatorRealtimePreview.js";
import {
  buildIndicatorRealtimeConfigSignature,
  createIndicatorRealtimeValueBatcher,
  type IndicatorRealtimeValueUpdate,
} from "./indicatorRealtimeBatcher.js";
import { computeIndicatorRangeBatch } from "../../services/indicatorApi.js";
import { useIndicatorComputeController } from "./indicatorComputeController.js";
import { parseIntervalParts, parseIntervalSeconds } from "../../utils/intervals.js";
import {
  createIndicatorOutputState,
  filterIndicatorOutputStateByVisibility,
  indicatorOutputReducer,
} from "./indicatorOutputReducer.js";
import { buildIndicatorPaneData } from "./indicatorPaneProjection.js";
import type {
  IndicatorRealtimeMode,
  IndicatorRuntime,
  IndicatorRangeRequestOptions,
  RequestIndicatorRange,
} from "./indicatorRuntimeContract.js";
import { useIndicatorStreamController } from "./indicatorStreamController.js";
import {
  getVisibleHostedIndicators,
  buildHostedSubscriptionMessage,
  resolveIndicatorSubscriptionCachePolicy,
} from "./indicatorWsRuntime.js";
import {
  inferFixedIntervalClosedThrough,
  nextIndicatorBarTime,
  planDeferredRightCatchup,
  planIndicatorCorrectionRefresh,
  planVisibleIndicatorHydrationRange,
  RIGHT_CATCHUP_GRACE_MS,
  resolveInitialHostedRange,
  resolveProgressiveHostedRange,
  selectProgressiveHostedIndicators,
  type IndicatorVisibleNavigationState,
} from "./indicatorRangePlanning.js";
import {
  acquireActiveIndicatorCacheLeases,
  buildIndicatorCacheContext,
  buildIndicatorCacheHydrationSignature,
  buildIndicatorResultCacheKey,
  cacheIndicatorSnapshot,
  getCachedIndicatorComputedSegments,
  getCachedIndicatorMetadata,
  getCachedIndicatorRevision,
  getCachedIndicatorResumeState,
  invalidateCachedIndicatorRange,
  patchCachedIndicatorResult,
  rebaseCachedIndicatorRevision,
  replaceCachedIndicatorRange,
  resolveCachedIndicatorResults,
  snapshotIndicatorResultCacheDiagnostics,
  upsertCachedIndicatorLinePoint,
} from "./indicatorResultCacheStore.js";
import {
  buildIndicatorRuntimeDiagnosticSnapshot,
  registerIndicatorRuntimeDiagnosticSource,
} from "./indicatorRuntimeDiagnostics.js";
import {
  clampIndicatorRangeToClosedThrough,
  normalizeIndicatorRange,
  normalizeIndicatorRevision,
} from "./indicatorRangeCoverage.js";
import { createIndicatorRangeScheduler } from "./indicatorRangeScheduler.js";
import { createIndicatorRangeBatcher } from "./indicatorRangeBatcher.js";
import {
  createIndicatorHydrationScheduler,
  hydrateIndicatorDefinitionsFromCache,
} from "./indicatorHydrationRuntime.js";
import { buildIndicatorRangeLifecycleKey } from "./indicatorRangeLifecycle.js";
import {
  buildIndicatorInitialHydrationSignature,
  buildIndicatorRangeRefreshSignature,
  createCompletedIndicatorRangeRequestLedger,
  createDeferredIndicatorRangeIntentRegistry,
  createDeferredIndicatorRangeWaitRegistry,
  createIndicatorInitialHydrationGate,
  createKeyedIndicatorRetryTimers,
  meaningfulIndicatorRevisionSignature,
  mergePendingIndicatorCorrection,
  resolveDirectIndicatorRangeRevision,
  type PendingIndicatorCorrection,
  type DeferredIndicatorRangeIntent,
  type DeferredIndicatorRangeIntentAttempt,
} from "./indicatorRangeRequestDedupe.js";
import {
  canExecuteHostedHistoricalFallback,
  canRunHostedIndicatorStream,
  canStartIndicatorAutoRightCatchup,
  canStartIndicatorInitialHydration,
  canStartIndicatorProgressiveHydration,
  canStartIndicatorWindowHydration,
  bridgeIndicatorWindowDeltaToComputedCoverage,
  createIndicatorRangeEventSettlementBarrier,
  groupIndicatorWindowDeltaRefreshes,
  indicatorWindowCorrectionCoalesceDelay,
  planIndicatorWindowDeltaRefreshes,
  reconcileConsumedIndicatorRangeRequestIds,
} from "./indicatorWindowDeltaRuntime.js";
import {
  formatIndicatorError,
  mergeIndicatorLines,
  normalizeIndicatorPayload,
  normalizeParamSchema,
  replaceIndicatorLinesRange,
  stringSignature,
} from "./indicatorPayloadRuntime.js";
import type {
  DeferredRightCatchupPlan,
  IndicatorDefinition,
  IndicatorLine,
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
  IndicatorValuesMessage,
} from "./indicatorTypes.js";

export { buildIndicatorRangeLifecycleKey } from "./indicatorRangeLifecycle.js";

interface UseIndicatorRuntimeOptions {
  autoAddVolume?: boolean;
  session?: ChartSessionRuntime;
  marketData?: MarketDataRuntime;
  candleDownColor?: string;
  candleUpColor?: string;
  chartData?: KlineBar[];
  chartDataMeta?: ChartDataCommitMeta | null;
  datasetKey?: string;
  exchange?: string;
  getCurrentVisibleRange?: () => unknown;
  initialHistoryPending?: boolean;
  interval?: string;
  indicatorRangeRequests?: IndicatorRangeEvent[];
  consumeIndicatorRangeRequest?: (requestId: number) => void;
  marketType?: string;
  realtimeEnabled?: boolean;
  requestDemand?: Readonly<{ scope: string; generation: number }> | null;
  seriesReady?: number;
  sessionKey?: string;
  savedVisibleRange?: unknown;
  symbol?: string;
  onIndicatorRemoved?: (indicatorId: string) => void;
  indicatorPersistence?: ActiveIndicatorPersistence | null;
  streamIdentity?: IndicatorStreamIdentity | null;
  workSchedulerCellId?: string;
}

interface ResolvedIndicatorRuntimeInputs {
  candleDownColor: string;
  candleUpColor: string;
  chartData: KlineBar[];
  chartDataMeta: ChartDataCommitMeta | null;
  datasetKey: string;
  exchange: string;
  getCurrentVisibleRange?: () => unknown;
  historyWindowPending: boolean;
  initialHistoryPending: boolean;
  interval: string;
  indicatorRangeRequests: IndicatorRangeEvent[];
  consumeIndicatorRangeRequest?: (requestId: number) => void;
  marketType: string;
  realtimeEnabled: boolean;
  requestDemand: Readonly<{ scope: string; generation: number }> | null;
  seriesReady: number;
  sessionKey: string;
  savedVisibleRange: IndicatorVisibleRange | null;
  symbol: string;
}

interface IndicatorPreviewContext {
  exchange: string;
  interval: string;
  marketType: string;
  sessionKey: string;
  symbol: string;
}

interface HostedReadinessOptions {
  indicatorIds?: Iterable<unknown>;
  subscribedIds?: Iterable<unknown> | null;
  waitStartedAt?: number | null;
  now?: number;
  timeoutMs?: number;
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

interface IndicatorRangeTargetRuntime {
  key: string;
  indicator: IndicatorDefinition;
  message: IndicatorSubscribeMessage;
}

interface DirectIndicatorRangeIntentPayload {
  completionSignature?: string;
  indicatorIds: string[];
  kind: "auto-right" | "visible-range" | "ws-fallback";
  reason: string;
  revision?: IndicatorRevision | null;
  waitForSubscription?: boolean;
}

type DirectIndicatorRangeIntent = DeferredIndicatorRangeIntent<
  DirectIndicatorRangeIntentPayload
>;

interface IndicatorRuntimeError extends Error {
  afterEventId?: number;
  code?: string;
  eventReleased?: boolean;
  payload: IndicatorPayloadEnvelope;
  deferred: boolean;
  waitRevision?: IndicatorRevision | null;
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

export type {
  IndicatorRealtimeMode,
  IndicatorRuntime,
} from "./indicatorRuntimeContract.js";

export function resolveIndicatorRealtimeMode(
  webSocketReady: boolean,
  wsStatus: MarketDataRuntime["view"]["wsStatus"] | undefined,
): IndicatorRealtimeMode {
  return webSocketReady && wsStatus !== "fallback"
    ? "enabled"
    : "historical-only";
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
  const initialHistoryPending = options.initialHistoryPending
    ?? marketDataStatus?.initialHistoryPending
    ?? false;
  const realtimeMode = resolveIndicatorRealtimeMode(
    options.session?.status.webSocketReady ?? true,
    marketDataView?.wsStatus,
  );
  const inputs: ResolvedIndicatorRuntimeInputs = {
    candleDownColor: options.candleDownColor || "#ef4444",
    candleUpColor: options.candleUpColor || "#22c55e",
    chartData: options.chartData ?? marketDataView?.bars ?? [],
    chartDataMeta: options.chartDataMeta ?? marketDataView?.meta ?? null,
    datasetKey: options.datasetKey ?? sessionView?.datasetKey ?? "",
    exchange: options.exchange ?? sessionView?.exchange ?? "binance",
    historyWindowPending: Boolean(
      initialHistoryPending
      || marketDataStatus?.loadingMoreLeft
      || (options.chartDataMeta ?? marketDataView?.meta)?.indicatorWindowDeferred === true
    ),
    initialHistoryPending,
    interval: options.interval ?? sessionView?.interval ?? "",
    indicatorRangeRequests: options.indicatorRangeRequests ?? marketDataStatus?.indicatorRangeRequests ?? [],
    marketType: options.marketType ?? sessionView?.marketType ?? "spot",
    realtimeEnabled: options.realtimeEnabled ?? (realtimeMode === "enabled"),
    requestDemand: options.requestDemand ?? marketDataStatus?.requestDemand ?? null,
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
const INDICATOR_CORRECTION_COALESCE_MS = 250;
const INDICATOR_CORRECTION_QUEUE_POLL_MS = 40;
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

/**
 * Range/history hydration is served over HTTP and has no dependency on the
 * realtime socket.  Keep the subscription barrier as an explicit opt-in for
 * callers that actually need it, rather than letting a delayed unrelated ACK
 * hold all historical indicators behind it.
 */
export function shouldWaitForIndicatorRangeSubscription(
  realtimeEnabled: boolean,
  waitForSubscription?: boolean,
): boolean {
  return realtimeEnabled && waitForSubscription === true;
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

function buildIndicatorPreviewContextKey({
  exchange,
  interval,
  marketType,
  sessionKey,
  symbol,
}: IndicatorPreviewContext): string {
  return [sessionKey, exchange, marketType, symbol, interval].join("|");
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
  options: IndicatorRangeRequestOptions = {},
): boolean {
  if (typeof requestRange !== "function") return false;
  const startSec = normalizeRangeBoundary(start);
  const endSec = normalizeRangeBoundary(end);
  if (!startSec || !endSec || startSec > endSec) return false;
  return Boolean(requestRange(startSec, endSec, reason, options));
}

export function isDeferredIndicatorRangeSettlement(
  detail: Record<string, unknown> | null | undefined,
): boolean {
  if (detail?.deferred === true) return true;
  const error = detail?.error;
  return isIndicatorRuntimeError(error) && error.deferred;
}

function latestIndicatorRangeEventId(events: readonly IndicatorRangeEvent[]): number {
  return events.reduce((latest, event) => (
    Number.isFinite(Number(event?.id))
      ? Math.max(latest, Math.floor(Number(event.id)))
      : latest
  ), 0);
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
      indicator.language || "",
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
  interval: string,
): IndicatorRange | null {
  const end = normalizeRangeBoundary(chartData?.[chartData.length - 1]?.time);
  if (!end) return null;
  const intervalSeconds = inferIntervalSecondsFromChartData(chartData);

  let start: number | null = null;
  for (const indicator of hostedIndicators) {
    const lastIndicatorTime = latestLineTime(indicator);
    if (!lastIndicatorTime) continue;
    const candidateStart = nextIndicatorBarTime(
      lastIndicatorTime,
      interval,
      intervalSeconds,
    );
    if (!candidateStart) continue;
    if (candidateStart <= end) {
      start = start == null ? candidateStart : Math.min(start, candidateStart);
    }
  }

  if (start == null || start > end) return null;
  return { start, end };
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
  const marketWorkspaceResources = useMarketDataWorkspaceResources();
  const workScheduler = marketWorkspaceResources?.workScheduler || null;
  const workSchedulerCellId = options.workSchedulerCellId;
  const {
    candleDownColor,
    candleUpColor,
    chartData,
    chartDataMeta,
    datasetKey,
    exchange,
    getCurrentVisibleRange,
    historyWindowPending,
    initialHistoryPending,
    interval,
    indicatorRangeRequests,
    consumeIndicatorRangeRequest,
    marketType,
    realtimeEnabled,
    requestDemand,
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
  } = useActiveIndicatorStore({
    ...(options.autoAddVolume === undefined
      ? {}
      : { autoAddVolume: options.autoAddVolume }),
    onRequireCompute: requireIndicatorCompute,
    ...(options.indicatorPersistence === undefined
      ? {}
      : { persistence: options.indicatorPersistence }),
  });

  const [outputState, outputDispatch] = useReducer(
    indicatorOutputReducer,
    undefined,
    createIndicatorOutputState,
  );
  const [realtimeUnavailableIndicatorContexts, setRealtimeUnavailableIndicatorContexts] = useState<
    Map<string, string>
  >(
    () => new Map(),
  );

  const removeIndicator = useCallback((indicatorId: string) => {
    removeActiveIndicator(indicatorId);
    setRealtimeUnavailableIndicatorContexts((previous) => {
      if (!previous.has(indicatorId)) return previous;
      const next = new Map(previous);
      next.delete(indicatorId);
      return next;
    });
    outputDispatch({ type: "remove-indicator", indicatorId });
    onIndicatorRemoved?.(indicatorId);
  }, [onIndicatorRemoved, removeActiveIndicator]);

  const activeIndicatorsRef = useLatestRef(activeIndicators);
  const chartDataRef = useLatestRef(chartData);
  const chartDataMetaRef = useLatestRef(chartDataMeta);
  const indicatorRangeRequestsRef = useLatestRef(indicatorRangeRequests);
  const historyWindowPendingRef = useLatestRef(historyWindowPending);
  const requestDemandRef = useLatestRef(requestDemand);
  const candleUpColorRef = useLatestRef(candleUpColor);
  const candleDownColorRef = useLatestRef(candleDownColor);
  const provisionalIndicatorPreviewsRef = useRef<
    Map<string, ContextualProvisionalIndicatorPreview>
  >(new Map());
  const consumedIndicatorRangeRequestIdsRef = useRef<Set<number>>(new Set());
  const completedIndicatorRangeRequestsRef = useRef(
    createCompletedIndicatorRangeRequestLedger(),
  );
  const deferredIndicatorRangeWaitsRef = useRef(
    createDeferredIndicatorRangeWaitRegistry(),
  );
  const directIndicatorRangeIntentsRef = useRef(
    createDeferredIndicatorRangeIntentRegistry<DirectIndicatorRangeIntentPayload>(),
  );
  const directIndicatorRangeRetryTimersRef = useRef(createKeyedIndicatorRetryTimers());
  const replayDirectIndicatorRangeIntentsRef = useRef<(
    attempts: DeferredIndicatorRangeIntentAttempt<DirectIndicatorRangeIntentPayload>[],
  ) => void>(() => {});
  const indicatorRangeEventRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRightCatchupRangeSignaturesRef = useRef<Set<string>>(new Set());
  const autoRightCatchupPendingRef = useRef<DeferredRightCatchupPlan | null>(null);
  const autoRightCatchupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialHostedHydrationGateRef = useRef(createIndicatorInitialHydrationGate());
  const progressiveHostedHydrationGateRef = useRef(createIndicatorInitialHydrationGate());
  const initialHostedRangeRetryTimersRef = useRef(createKeyedIndicatorRetryTimers());
  const pendingIndicatorCorrectionsRef = useRef<Map<string, PendingIndicatorCorrection>>(new Map());
  const indicatorCorrectionFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushIndicatorCorrectionsRef = useRef<() => void>(() => {});
  const hostedSubscribedIdsRef = useRef<Set<string>>(new Set());
  const hostedPendingResumePatchIdsRef = useRef<Set<string>>(new Set());
  const hostedSubscriptionSessionKeyRef = useRef<string | null>(null);
  const hostedSubscriptionWaitStartedAtRef = useRef<number | null>(null);
  const hostedSubscriptionWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seriesRevisionRef = useRef<IndicatorRevision | null>(null);
  const visibleRangeEnsureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingVisibleRangeRef = useRef<IndicatorVisibleRange | null>(null);
  const visibleNavigationStateRef = useRef<IndicatorVisibleNavigationState | null>(null);
  const [indicatorRangeScheduler] = useState(() => (
    createIndicatorRangeScheduler<IndicatorRangeTargetRuntime, IndicatorPayloadEnvelope>()
  ));
  const [indicatorRangeBatcher] = useState(() => createIndicatorRangeBatcher<
    IndicatorRangeRequest,
    IndicatorPayloadEnvelope
  >({
    coalesceWindowMs: 40,
    sendBatch: ({ requests, signal }) => computeIndicatorRangeBatch({ requests, signal }),
  }));
  const [indicatorHydrationScheduler] = useState(createIndicatorHydrationScheduler);
  const [rangeRetryTick, setRangeRetryTick] = useState(0);
  const [subscriptionAckTick, setSubscriptionAckTick] = useState(0);
  const [settledInitialHydrationSignature, setSettledInitialHydrationSignature] = useState<
    string | null
  >(null);
  const [hostedStreamStartedLifecycleKey, setHostedStreamStartedLifecycleKey] = useState<
    string | null
  >(null);
  const runtimeContextRef = useLatestRef({
    exchange,
    interval,
    marketType,
    sessionKey,
    symbol,
  });
  const realtimeIndicatorBatcherRef = useRef<
    ReturnType<typeof createIndicatorRealtimeValueBatcher> | null
  >(null);

  const scheduleIndicatorRangeEventRetry = useCallback((
    delayMs = INDICATOR_RANGE_RETRY_MS,
  ) => {
    if (indicatorRangeEventRetryTimerRef.current) return;
    indicatorRangeEventRetryTimerRef.current = setTimeout(() => {
      indicatorRangeEventRetryTimerRef.current = null;
      setRangeRetryTick((tick) => tick + 1);
    }, Math.max(0, Math.floor(Number(delayMs) || 0)));
  }, []);

  const scheduleIndicatorCorrectionFlush = useCallback((
    delayMs = INDICATOR_CORRECTION_COALESCE_MS,
  ) => {
    if (indicatorCorrectionFlushTimerRef.current) {
      clearTimeout(indicatorCorrectionFlushTimerRef.current);
    }
    indicatorCorrectionFlushTimerRef.current = setTimeout(() => {
      indicatorCorrectionFlushTimerRef.current = null;
      flushIndicatorCorrectionsRef.current();
    }, delayMs);
  }, []);

  const scheduleInitialHostedRangeRetry = useCallback((signature: string) => {
    initialHostedRangeRetryTimersRef.current.schedule(signature, () => {
      initialHostedHydrationGateRef.current.release(signature);
      setRangeRetryTick((tick) => tick + 1);
    }, INDICATOR_RANGE_RETRY_MS);
  }, []);

  const resolveRealtimeIndicatorConfigSignature = useCallback((
    indicator: IndicatorDefinition,
  ) => {
    const context = runtimeContextRef.current;
    return buildIndicatorRealtimeConfigSignature(indicator, {
      candleDownColor: candleDownColorRef.current,
      candleUpColor: candleUpColorRef.current,
      chartData: chartDataRef.current || [],
      chartDataLength: chartDataRef.current?.length || 0,
      exchange: context.exchange,
      interval: context.interval,
      marketType: context.marketType,
      symbol: context.symbol,
    });
  }, [
    candleDownColorRef,
    candleUpColorRef,
    chartDataRef,
    runtimeContextRef,
  ]);

  const resolveProvisionalIndicatorPreview = useCallback((indicator: IndicatorDefinition) => {
    const candidate = provisionalIndicatorPreviewsRef.current.get(indicator.id);
    if (!candidate) return null;
    const contextKey = buildIndicatorPreviewContextKey(runtimeContextRef.current);
    const current = currentContextualProvisionalIndicatorPreview(
      candidate,
      contextKey,
      resolveRealtimeIndicatorConfigSignature(indicator),
    );
    if (!current) provisionalIndicatorPreviewsRef.current.delete(indicator.id);
    return current;
  }, [resolveRealtimeIndicatorConfigSignature, runtimeContextRef]);

  const reapplyProvisionalIndicatorPreview = useCallback((
    indicator: IndicatorDefinition,
    lines: IndicatorLine[],
    payload: Partial<IndicatorPayloadEnvelope> | null | undefined,
  ): IndicatorLine[] => {
    const targetIndicator = lines === indicator.lines ? indicator : { ...indicator, lines };
    const candidate = resolveProvisionalIndicatorPreview(targetIndicator);
    if (!candidate) return lines;
    if (!shouldRetainProvisionalIndicatorPreview(candidate.preview, lines, payload)) {
      provisionalIndicatorPreviewsRef.current.delete(indicator.id);
      return lines;
    }
    return applyRealtimeIndicatorValuesToLines({
      ...(candidate.preview.bar ? { bar: candidate.preview.bar } : {}),
      barTime: candidate.preview.barTime,
      candleDownColor: candleDownColorRef.current,
      candleUpColor: candleUpColorRef.current,
      indicator: targetIndicator,
      lines,
      values: candidate.preview.values,
    });
  }, [
    candleDownColorRef,
    candleUpColorRef,
    resolveProvisionalIndicatorPreview,
  ]);

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
  const indicatorHydrationLifecycleKey = `indicator-cache:${indicatorCacheHydrationSignature}`;
  const indicatorHydrationLifecycleKeyRef = useLatestRef(indicatorHydrationLifecycleKey);
  const currentSeriesKey = useMemo(
    () => [sessionKey, exchange, marketType, symbol, interval].join("|"),
    [exchange, interval, marketType, sessionKey, symbol],
  );
  const currentStreamLifecycleKey = useMemo(() => buildIndicatorRangeLifecycleKey(
    currentSeriesKey,
    requestDemand,
  ), [currentSeriesKey, requestDemand]);
  const currentStreamLifecycleKeyRef = useLatestRef(currentStreamLifecycleKey);
  const currentInitialHydrationSignature = useMemo(() => {
    const cacheContext = buildIndicatorCacheContext({
      candleDownColor,
      candleUpColor,
      exchange,
      interval,
      marketType,
      symbol,
    });
    return buildIndicatorInitialHydrationSignature({
      seriesKey: currentSeriesKey,
      requestScope: requestDemand?.scope,
      requestGeneration: requestDemand?.generation,
      targetKeys: getVisibleHostedIndicators(activeIndicators).map((indicator) => (
        buildIndicatorResultCacheKey(indicator, cacheContext)
      )),
    });
  }, [
    activeIndicators,
    candleDownColor,
    candleUpColor,
    exchange,
    interval,
    marketType,
    requestDemand?.generation,
    requestDemand?.scope,
    currentSeriesKey,
    symbol,
  ]);
  const currentInitialHydrationSignatureRef = useLatestRef(currentInitialHydrationSignature);
  const settledInitialHydrationSignatureRef = useLatestRef(
    settledInitialHydrationSignature,
  );
  const canExecuteCurrentWsFallback = useCallback(() => (
    canExecuteHostedHistoricalFallback({
      historyWindowPending: historyWindowPendingRef.current,
      initialHydrationSettled: settledInitialHydrationSignatureRef.current
        === currentInitialHydrationSignatureRef.current,
    })
  ), [
    settledInitialHydrationSignatureRef,
    currentInitialHydrationSignatureRef,
    historyWindowPendingRef,
  ]);
  const indicatorCacheRuntimeLeaseId = useId();
  const indicatorDiagnosticRuntimeId = useId();

  const indicatorDiagnosticStateRef = useLatestRef({
    activeIndicators,
    chartData,
    context: {
      exchange,
      interval,
      marketType,
      sessionKey,
      symbol,
    },
    state: {
      chartDataReady,
      chartDataStatus,
      historyWindowPending,
      initialHistoryPending,
      initialHydrationSettled:
        settledInitialHydrationSignature === currentInitialHydrationSignature,
      realtimeEnabled,
      requestDemand: requestDemand ? { ...requestDemand } : null,
      seriesReady,
    },
  });

  useLayoutEffect(() => registerIndicatorRuntimeDiagnosticSource(
    indicatorDiagnosticRuntimeId,
    () => {
      const current = indicatorDiagnosticStateRef.current;
      return buildIndicatorRuntimeDiagnosticSnapshot({
        ...current,
        cache: snapshotIndicatorResultCacheDiagnostics(),
        state: {
          ...current.state,
          hostedPendingResumePatchIds: Array.from(hostedPendingResumePatchIdsRef.current),
          hostedSubscribedIds: Array.from(hostedSubscribedIdsRef.current),
        },
      });
    },
  ), [
    hostedPendingResumePatchIdsRef,
    hostedSubscribedIdsRef,
    indicatorDiagnosticRuntimeId,
    indicatorDiagnosticStateRef,
  ]);

  useLayoutEffect(() => acquireActiveIndicatorCacheLeases(
    activeIndicatorsRef.current,
    {
      candleDownColor,
      candleUpColor,
      exchange,
      interval,
      marketType,
      symbol,
    },
    `active-indicator-${indicatorCacheRuntimeLeaseId}`,
  ), [
    activeIndicatorsRef,
    candleDownColor,
    candleUpColor,
    exchange,
    indicatorCacheHydrationSignature,
    indicatorCacheRuntimeLeaseId,
    interval,
    marketType,
    symbol,
  ]);

  useLayoutEffect(() => {
    initialHostedHydrationGateRef.current.clear();
    progressiveHostedHydrationGateRef.current.clear();
    autoRightCatchupRangeSignaturesRef.current.clear();
    completedIndicatorRangeRequestsRef.current.clear();
    deferredIndicatorRangeWaitsRef.current.clear();
    directIndicatorRangeIntentsRef.current.clear();
    directIndicatorRangeRetryTimersRef.current.cancelAll();
    pendingIndicatorCorrectionsRef.current.clear();
    initialHostedRangeRetryTimersRef.current.cancelAll();
    if (indicatorCorrectionFlushTimerRef.current) {
      clearTimeout(indicatorCorrectionFlushTimerRef.current);
      indicatorCorrectionFlushTimerRef.current = null;
    }
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

  const markHostedRealtimeUnavailable = useCallback((
    indicatorId: string,
    unavailable: boolean,
  ) => {
    const normalizedId = String(indicatorId);
    const context = runtimeContextRef.current;
    const contextKey = [
      context.sessionKey,
      context.exchange,
      context.marketType,
      context.symbol,
      context.interval,
    ].join("|");
    setRealtimeUnavailableIndicatorContexts((previous) => {
      if (unavailable && previous.get(normalizedId) === contextKey) return previous;
      if (!unavailable && !previous.has(normalizedId)) return previous;
      const next = new Map(previous);
      if (unavailable) next.set(normalizedId, contextKey);
      else next.delete(normalizedId);
      return next;
    });
  }, [runtimeContextRef]);

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
              lines: reapplyProvisionalIndicatorPreview(
                indicator,
                normalized.lines,
                payload,
              ),
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
  }, [
    activeIndicatorsRef,
    getIndicatorCacheContext,
    reapplyProvisionalIndicatorPreview,
    setActiveIndicators,
  ]);

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
              lines: reapplyProvisionalIndicatorPreview(
                indicator,
                mergeIndicatorLines(indicator.lines || [], normalized.lines),
                payload,
              ),
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
  }, [
    activeIndicatorsRef,
    getIndicatorCacheContext,
    markHostedSubscriptionReady,
    reapplyProvisionalIndicatorPreview,
    setActiveIndicators,
  ]);

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
              lines: reapplyProvisionalIndicatorPreview(
                indicator,
                replaceIndicatorLinesRange(indicator.lines || [], normalized.lines, range),
                payload,
              ),
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
  }, [
    activeIndicatorsRef,
    getIndicatorCacheContext,
    reapplyProvisionalIndicatorPreview,
    setActiveIndicators,
  ]);

  const flushRealtimeIndicatorValues = useCallback((
    updates: readonly IndicatorRealtimeValueUpdate[],
  ) => {
    const contextKey = buildIndicatorPreviewContextKey(runtimeContextRef.current);
    const currentUpdates = updates.filter((update) => update.contextKey === contextKey);
    if (currentUpdates.length === 0) return;
    const updatesByIndicator = new Map<string, IndicatorRealtimeValueUpdate[]>();
    for (const update of currentUpdates) {
      const queued = updatesByIndicator.get(update.indicatorId) ?? [];
      queued.push(update);
      updatesByIndicator.set(update.indicatorId, queued);
    }
    const hasFinalUpdate = currentUpdates.some((update) => update.isFinal);
    const cacheContext = hasFinalUpdate ? getIndicatorCacheContext() : null;

    setActiveIndicators((prev) => {
      let changed = false;
      const next = prev.map((indicator) => {
        const indicatorConfigSignature = resolveRealtimeIndicatorConfigSignature(indicator);
        const queued = updatesByIndicator.get(indicator.id)?.filter(
          (update) => update.indicatorConfigSignature === indicatorConfigSignature,
        );
        if (!queued?.length || !Array.isArray(indicator.lines)) return indicator;
        let lines = indicator.lines;
        for (const update of queued) {
          const bar = update.bar;
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
          if (update.isFinal && cacheContext) {
            upsertCachedIndicatorLinePoint(
              indicator,
              cacheContext,
              update.values,
              update.barTime,
              resolveHistogramColor,
            );
            const dataRevision = normalizeIndicatorRevision(update.payload);
            if (dataRevision) {
              rebaseCachedIndicatorRevision(indicator, cacheContext, dataRevision);
            }
          }
          lines = applyRealtimeIndicatorValuesToLines({
            ...(bar ? { bar } : {}),
            barTime: update.barTime,
            candleDownColor: candleDownColorRef.current,
            candleUpColor: candleUpColorRef.current,
            indicator,
            lines,
            values: update.values,
          });
        }
        if (lines === indicator.lines && indicator.error == null) return indicator;
        changed = true;
        return { ...indicator, lines, error: null };
      });
      return changed ? next : prev;
    });
  }, [
    candleDownColorRef,
    candleUpColorRef,
    getIndicatorCacheContext,
    resolveRealtimeIndicatorConfigSignature,
    runtimeContextRef,
    setActiveIndicators,
  ]);

  useLayoutEffect(() => {
    const batcher = createIndicatorRealtimeValueBatcher({
      isUpdateCurrent: (update) => {
        const indicator = activeIndicatorsRef.current.find(
          (candidate) => candidate.id === update.indicatorId,
        );
        return Boolean(indicator
          && resolveRealtimeIndicatorConfigSignature(indicator)
            === update.indicatorConfigSignature);
      },
      onFlush: flushRealtimeIndicatorValues,
      ...(workScheduler && workSchedulerCellId
        ? { scheduler: workScheduler.frameScheduler(workSchedulerCellId) }
        : {}),
    });
    realtimeIndicatorBatcherRef.current = batcher;
    provisionalIndicatorPreviewsRef.current.clear();
    return () => {
      batcher.clear();
      if (realtimeIndicatorBatcherRef.current === batcher) {
        realtimeIndicatorBatcherRef.current = null;
      }
    };
  }, [
    activeIndicatorsRef,
    exchange,
    flushRealtimeIndicatorValues,
    interval,
    marketType,
    resolveRealtimeIndicatorConfigSignature,
    sessionKey,
    symbol,
    workScheduler,
    workSchedulerCellId,
  ]);

  const applyWsValues = useCallback((
    indicatorId: string,
    values: Record<string, unknown>,
    barTime: number,
    isFinal = true,
    payload: IndicatorValuesMessage | null = null,
    sourceSubscriptionSignature?: string,
  ) => {
    if (!values || !barTime) return;
    const indicator = activeIndicatorsRef.current.find((candidate) => candidate.id === indicatorId);
    if (!indicator) return;
    const currentIndicatorConfigSignature = resolveRealtimeIndicatorConfigSignature(indicator);
    // Every production value message originates in IndicatorStreamConnection,
    // which attaches the signature of the subscription that actually received
    // it. Missing provenance or a late frame from the previous same-id config
    // must fail closed before it can touch preview, revision, frame, or cache
    // state. The batcher repeats this check at flush time for config changes
    // that happen after a valid value was queued.
    if (
      !sourceSubscriptionSignature
      || sourceSubscriptionSignature !== currentIndicatorConfigSignature
    ) {
      return;
    }
    const indicatorConfigSignature = sourceSubscriptionSignature;
    const dataRevision = isFinal ? normalizeIndicatorRevision(payload) : null;
    if (dataRevision) seriesRevisionRef.current = dataRevision;
    const currentChartData = chartDataRef.current || [];
    const payloadBar = payload?.bar;
    const tailBar = currentChartData.at(-1);
    const bar = payloadBar && Number(payloadBar.time) === Number(barTime)
      ? payloadBar
      : Number(tailBar?.time) === Number(barTime)
        ? tailBar
        : currentChartData.find((item) => Number(item.time) === Number(barTime));
    const contextKey = buildIndicatorPreviewContextKey(runtimeContextRef.current);
    const preview: ProvisionalIndicatorPreview = { barTime, values };
    if (bar) preview.bar = bar;
    const shouldEnqueue = stageContextualProvisionalIndicatorPreview({
      currentContextKey: contextKey,
      currentIndicatorConfigSignature,
      incomingIndicatorConfigSignature: indicatorConfigSignature,
      indicatorId,
      isFinal,
      preview,
      previews: provisionalIndicatorPreviewsRef.current,
    });
    // A delayed preview for an older forming bar must not overwrite the newer
    // provisional point or enter the frame batch. Values always retain their
    // exact timestamp; they are never aligned by a nearby candle index.
    if (!shouldEnqueue) return;

    realtimeIndicatorBatcherRef.current?.enqueue({
      ...(bar ? { bar } : {}),
      barTime,
      contextKey,
      indicatorId,
      indicatorConfigSignature,
      isFinal,
      payload,
      values,
    });
  }, [
    activeIndicatorsRef,
    chartDataRef,
    resolveRealtimeIndicatorConfigSignature,
    runtimeContextRef,
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
    const deferForQueuedCorrection = reason === "initial-progressive"
      || reason === "initial-visible"
      || reason === "visible-range"
      || reason === "auto-right-catchup"
      || String(reason).startsWith("window-");
    if (
      deferForQueuedCorrection
      && hostedIndicators.some((indicator) => (
        pendingIndicatorCorrectionsRef.current.has(String(indicator.id))
      ))
    ) {
      return false;
    }
    const onSettled = options.onSettled;

    const requestContext = runtimeContextRef.current;
    const currentRequestDemand = requestDemandRef.current;
    const contextKey = [
      requestContext.sessionKey,
      requestContext.exchange,
      requestContext.marketType,
      requestContext.symbol,
      requestContext.interval,
    ].join("|");
    const requestLifecycleKey = buildIndicatorRangeLifecycleKey(
      contextKey,
      currentRequestDemand,
    );
    if (
      shouldWaitForIndicatorRangeSubscription(
        realtimeEnabled,
        options.waitForSubscription,
      )
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
      .map((indicator) => getCachedIndicatorRevision(indicator, cacheContext))
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
    const allTargets = hostedIndicators.map((indicator) => ({
      indicator,
      key: buildIndicatorResultCacheKey(indicator, cacheContext),
      message: buildHostedSubscriptionMessage(indicator, colorContext),
    }));
    const blockedTargets = allTargets.filter((target) => (
      deferredIndicatorRangeWaitsRef.current.blocks({
        seriesKey: contextKey,
        targetKey: target.key,
        range: { start: startSec, end: requestEndSec },
        revision,
      })
    ));
    const blockedTargetKeys = new Set(blockedTargets.map((target) => target.key));
    const targets = allTargets.filter((target) => !blockedTargetKeys.has(target.key));
    if (blockedTargets.length > 0 && onSettled) {
      queueMicrotask(() => {
        for (const target of blockedTargets) {
          onSettled(false, {
            deferred: true,
            indicatorId: target.indicator.id,
            range: { start: startSec, end: requestEndSec },
          });
        }
      });
    }
    if (targets.length === 0) return true;

    if (options.invalidate) {
      for (const target of targets) {
        invalidateCachedIndicatorRange(target.indicator, cacheContext, { start: startSec, end: requestEndSec }, {
          cascadeRight: options.cascadeRight !== false,
          revision,
        });
      }
    }

    const scheduled = indicatorRangeScheduler.ensureCoverage({
      sessionKey: requestLifecycleKey,
      targets,
      range: { start: startSec, end: requestEndSec },
      reason,
      revision,
      interval: requestContext.interval,
      step,
      getCoveredSegments: (target) => getCachedIndicatorComputedSegments(
        target.indicator,
        cacheContext,
        revision,
      ),
      execute: async ({ range, reason: scheduledReason, signal, target }) => {
        // Capture the event frontier before starting physical work. A history
        // completion can arrive while this HTTP request is in flight; using
        // the post-response frontier would lose that wakeup permanently.
        const afterEventId = latestIndicatorRangeEventId(indicatorRangeRequestsRef.current);
        const revisionAtDispatch = seriesRevisionRef.current || normalizeIndicatorRevision(revision);
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
          ...(currentRequestDemand
            ? {
                requestScope: currentRequestDemand.scope,
                requestGeneration: currentRequestDemand.generation,
              }
            : {}),
        };
        if (message.customId !== undefined) {
          rangeRequest.customId = message.customId;
        }
        if (message.script !== undefined) rangeRequest.script = message.script;
        if (message.language !== undefined) {
          rangeRequest.language = message.language;
        }
        if (message.securityMode !== undefined) {
          rangeRequest.securityMode = message.securityMode;
        }
        const requestRange = () => indicatorRangeBatcher.schedule(rangeRequest);
        const payload = await (workScheduler && workSchedulerCellId
          ? workScheduler.run(workSchedulerCellId, "indicator-range", requestRange)
          : requestRange());
        if (payload?.ok !== false || payload.code === "INDICATOR_RANGE_EMPTY") return payload;
        if (payload.code === "INDICATOR_RANGE_NOT_READY") {
          const waitRevision = normalizeIndicatorRevision(payload) || revision;
          const currentRevision = seriesRevisionRef.current;
          const revisionAdvancedDuringRequest = Boolean(
            currentRevision
            && meaningfulIndicatorRevisionSignature(currentRevision)
              !== meaningfulIndicatorRevisionSignature(revisionAtDispatch),
          );
          if (waitRevision && !revisionAdvancedDuringRequest) {
            seriesRevisionRef.current = waitRevision;
          }
          deferredIndicatorRangeWaitsRef.current.block({
            afterEventId,
            range,
            revision: waitRevision,
            seriesKey: contextKey,
            targetKey: target.key,
          });
          const releasedForEvents = deferredIndicatorRangeWaitsRef.current.releaseForEvents(
            contextKey,
            indicatorRangeRequestsRef.current,
          );
          const releasedForRevision = revisionAdvancedDuringRequest && currentRevision
            ? deferredIndicatorRangeWaitsRef.current.releaseForRevision(
                contextKey,
                currentRevision,
              )
            : 0;
          const error = indicatorRangePayloadError(payload, "Indicator range is not ready");
          error.afterEventId = afterEventId;
          error.eventReleased = releasedForEvents + releasedForRevision > 0;
          error.waitRevision = waitRevision;
          throw error;
        }
        throw indicatorRangePayloadError(payload, "Indicator range error");
      },
      apply: ({ range, result: payload, target }) => {
        if (currentStreamLifecycleKeyRef.current !== requestLifecycleKey) return;
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
            onSettled: (ok: boolean, detail = {}) => {
              const runtimeError = isIndicatorRuntimeError(detail.error) ? detail.error : null;
              const settlement = {
                ...detail,
                afterEventId: runtimeError?.afterEventId,
                deferred: runtimeError?.deferred === true,
                eventReleased: runtimeError?.eventReleased === true,
                indicatorId: detail.target?.indicator?.id,
                waitRevision: runtimeError?.waitRevision,
              };
              onSettled(ok, settlement);
              if (runtimeError?.deferred && runtimeError.eventReleased) {
                queueMicrotask(() => {
                  initialHostedHydrationGateRef.current.releasePending();
                  setRangeRetryTick((tick) => tick + 1);
                  scheduleIndicatorCorrectionFlush();
                });
              }
            },
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
    currentStreamLifecycleKeyRef,
    getIndicatorCacheContext,
    indicatorRangeBatcher,
    indicatorRangeRequestsRef,
    indicatorRangeScheduler,
    realtimeEnabled,
    requestDemandRef,
    runtimeContextRef,
    scheduleIndicatorCorrectionFlush,
    setIndicatorError,
    workScheduler,
    workSchedulerCellId,
  ]);

  const executeDirectIndicatorRangeIntent = useCallback((
    key: string,
    expectedVersion?: number,
  ): boolean => {
    const registry = directIndicatorRangeIntentsRef.current;
    const attempt = registry.begin(key, expectedVersion);
    if (!attempt) return false;
    const { intent, version } = attempt;
    const payload = intent.payload;
    const requestContext = runtimeContextRef.current;
    const currentSeriesKey = [
      requestContext.sessionKey,
      requestContext.exchange,
      requestContext.marketType,
      requestContext.symbol,
      requestContext.interval,
    ].join("|");
    if (intent.seriesKey !== currentSeriesKey) {
      registry.complete(intent.key, version);
      directIndicatorRangeRetryTimersRef.current.cancel(intent.key);
      return false;
    }
    if (payload.kind === "ws-fallback" && !canExecuteCurrentWsFallback()) {
      registry.fail(intent.key, version);
      directIndicatorRangeRetryTimersRef.current.cancel(intent.key);
      return false;
    }
    const effectiveRevision = resolveDirectIndicatorRangeRevision(
      seriesRevisionRef.current,
      payload.revision,
    );
    const afterEventId = latestIndicatorRangeEventId(indicatorRangeRequestsRef.current);
    const indicatorIds = payload.indicatorIds.filter((indicatorId) => (
      activeIndicatorsRef.current.some((indicator) => indicator.id === indicatorId)
    ));
    const replayReleased = (
      released: DeferredIndicatorRangeIntentAttempt<DirectIndicatorRangeIntentPayload>[],
    ) => {
      if (released.length === 0) return;
      queueMicrotask(() => replayDirectIndicatorRangeIntentsRef.current(released));
    };
    const settleFailure = (detail: Record<string, unknown>) => {
      if (isDeferredIndicatorRangeSettlement(detail)) {
        const waitRevision = normalizeIndicatorRevision(detail.waitRevision)
          || effectiveRevision;
        if (!registry.defer(intent.key, version, {
          afterEventId: detail.afterEventId ?? afterEventId,
          revision: waitRevision,
        })) return;
        if (detail.eventReleased === true) {
          if (registry.release(intent.key, version)) replayReleased([attempt]);
          return;
        }
        const releasedForEvents = registry.releaseForEvents(
          intent.seriesKey,
          indicatorRangeRequestsRef.current,
        );
        const releasedForRevision = seriesRevisionRef.current
          ? registry.releaseForRevision(intent.seriesKey, seriesRevisionRef.current)
          : [];
        replayReleased([...releasedForEvents, ...releasedForRevision]);
        return;
      }
      if (!registry.fail(intent.key, version)) return;
      directIndicatorRangeRetryTimersRef.current.schedule(intent.key, () => {
        replayDirectIndicatorRangeIntentsRef.current([attempt]);
      }, INDICATOR_RANGE_RETRY_MS);
    };
    const settleSuccess = () => {
      if (!registry.complete(intent.key, version)) return;
      directIndicatorRangeRetryTimersRef.current.cancel(intent.key);
      if (payload.kind === "auto-right" && payload.completionSignature) {
        autoRightCatchupRangeSignaturesRef.current.add(payload.completionSignature);
        if (autoRightCatchupPendingRef.current?.signature === payload.completionSignature) {
          autoRightCatchupPendingRef.current = null;
        }
      } else if (payload.kind === "visible-range") {
        pendingVisibleRangeRef.current = null;
      }
    };

    if (indicatorIds.length === 0) {
      settleSuccess();
      return true;
    }
    const settle = createIndicatorRangeEventSettlementBarrier({
      indicatorIds,
      onFailure: settleFailure,
      onSuccess: settleSuccess,
    });
    const accepted = requestIndicatorRange(
      intent.range.start,
      intent.range.end,
      payload.reason,
      {
        indicatorIds,
        ...(effectiveRevision ? { revision: effectiveRevision } : {}),
        ...(payload.waitForSubscription !== undefined
          ? { waitForSubscription: payload.waitForSubscription }
          : {}),
        onSettled: settle,
      },
    );
    if (!accepted) settleFailure({ deferred: false });
    return true;
  }, [
    activeIndicatorsRef,
    canExecuteCurrentWsFallback,
    indicatorRangeRequestsRef,
    requestIndicatorRange,
    runtimeContextRef,
  ]);

  useLayoutEffect(() => {
    replayDirectIndicatorRangeIntentsRef.current = (attempts) => {
      const seen = new Set<string>();
      for (const attempt of attempts) {
        const signature = `${attempt.intent.key}:${attempt.version}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        executeDirectIndicatorRangeIntent(attempt.intent.key, attempt.version);
      }
    };
  }, [executeDirectIndicatorRangeIntent]);

  const queueDirectIndicatorRangeIntent = useCallback((
    intent: DirectIndicatorRangeIntent,
    { deferExecution = false }: { deferExecution?: boolean } = {},
  ): boolean => {
    const version = directIndicatorRangeIntentsRef.current.remember(intent);
    if (version == null) return false;
    if (!deferExecution) executeDirectIndicatorRangeIntent(intent.key, version);
    return true;
  }, [executeDirectIndicatorRangeIntent]);

  useEffect(() => {
    if (!canExecuteCurrentWsFallback()) return;
    const requestContext = runtimeContextRef.current;
    const seriesKey = [
      requestContext.sessionKey,
      requestContext.exchange,
      requestContext.marketType,
      requestContext.symbol,
      requestContext.interval,
    ].join("|");
    const ready = directIndicatorRangeIntentsRef.current
      .readyForSeries(seriesKey)
      .filter(({ intent }) => intent.payload.kind === "ws-fallback");
    if (ready.length > 0) replayDirectIndicatorRangeIntentsRef.current(ready);
  }, [
    canExecuteCurrentWsFallback,
    settledInitialHydrationSignature,
    currentInitialHydrationSignature,
    historyWindowPending,
    runtimeContextRef,
  ]);

  const ensureVisibleIndicatorRange = useCallback((visibleRange: unknown) => {
    pendingVisibleRangeRef.current = asIndicatorVisibleRange(visibleRange);
    if (visibleRangeEnsureTimerRef.current) clearTimeout(visibleRangeEnsureTimerRef.current);
    const attempt = () => {
      visibleRangeEnsureTimerRef.current = null;
      const currentChartData = chartDataRef.current || [];
      if (!canStartIndicatorWindowHydration({
        chartDataLength: currentChartData.length,
        historyWindowPending: historyWindowPendingRef.current,
      })) return;
      const hostedIndicators = getVisibleHostedIndicators(activeIndicatorsRef.current);
      if (hostedIndicators.length === 0) {
        pendingVisibleRangeRef.current = null;
        return;
      }
      const desired = resolveInitialHostedRange(
        currentChartData,
        hostedIndicators,
        pendingVisibleRangeRef.current,
      );
      if (!desired) {
        pendingVisibleRangeRef.current = null;
        return;
      }
      const requestContext = runtimeContextRef.current;
      const seriesKey = [
        requestContext.sessionKey,
        requestContext.exchange,
        requestContext.marketType,
        requestContext.symbol,
        requestContext.interval,
      ].join("|");
      const hydrationPlan = planVisibleIndicatorHydrationRange({
        chartData: currentChartData,
        desired,
        interval: requestContext.interval,
        previous: visibleNavigationStateRef.current,
        seriesKey,
      });
      const cacheContext = getIndicatorCacheContext();
      const currentDemand = requestDemandRef.current;
      const targetKeys = hostedIndicators.map((indicator) => (
        buildIndicatorResultCacheKey(indicator, cacheContext)
      )).sort();
      if (queueDirectIndicatorRangeIntent({
        fingerprint: JSON.stringify([
          "visible-range-v1",
          hydrationPlan.range.start,
          hydrationPlan.range.end,
          targetKeys,
          currentDemand?.scope || "",
          currentDemand?.generation ?? "",
        ]),
        key: `visible-range:${seriesKey}`,
        payload: {
          indicatorIds: hostedIndicators.map((indicator) => indicator.id),
          kind: "visible-range",
          reason: "visible-range",
        },
        range: hydrationPlan.range,
        seriesKey,
      })) {
        visibleNavigationStateRef.current = hydrationPlan.nextState;
        return;
      }
      // A queued correction owns this target until older revision work has
      // drained. Preserve the latest viewport and retry instead of dropping
      // the user's pan intent or launching concurrent full-range work.
      visibleRangeEnsureTimerRef.current = setTimeout(attempt, 120);
    };
    visibleRangeEnsureTimerRef.current = setTimeout(attempt, 120);
    return true;
  }, [
    activeIndicatorsRef,
    chartDataRef,
    getIndicatorCacheContext,
    historyWindowPendingRef,
    queueDirectIndicatorRangeIntent,
    requestDemandRef,
    runtimeContextRef,
  ]);

  useEffect(() => {
    if (historyWindowPending || !pendingVisibleRangeRef.current) return;
    ensureVisibleIndicatorRange(pendingVisibleRangeRef.current);
  }, [ensureVisibleIndicatorRange, historyWindowPending]);

  const resolveIndicatorResumeState = useCallback((indicator: IndicatorDefinition) => (
    getCachedIndicatorResumeState(indicator, getIndicatorCacheContext())
  ), [getIndicatorCacheContext]);

  const queueIndicatorCorrection = useCallback((
    correction: PendingIndicatorCorrection,
    preferQueuedRevision = false,
  ) => {
    pendingIndicatorCorrectionsRef.current.set(
      correction.indicatorId,
      mergePendingIndicatorCorrection(
        pendingIndicatorCorrectionsRef.current.get(correction.indicatorId),
        correction,
        preferQueuedRevision,
      ),
    );
  }, []);

  const flushIndicatorCorrections = useCallback(() => {
    if (historyWindowPendingRef.current) return;
    const requestContext = runtimeContextRef.current;
    const seriesKey = [
      requestContext.sessionKey,
      requestContext.exchange,
      requestContext.marketType,
      requestContext.symbol,
      requestContext.interval,
    ].join("|");
    const cacheContext = getIndicatorCacheContext();
    const currentRequestDemand = requestDemandRef.current;
    const inFlightTargetKeys = new Set(
      indicatorRangeScheduler.snapshot().inFlight.map((task) => task.targetKey),
    );
    let waitingForOlderWork = false;

    for (const correction of Array.from(pendingIndicatorCorrectionsRef.current.values())) {
      if (correction.seriesKey !== seriesKey) {
        pendingIndicatorCorrectionsRef.current.delete(correction.indicatorId);
        continue;
      }
      if (inFlightTargetKeys.has(correction.targetKey)) {
        waitingForOlderWork = true;
        continue;
      }
      pendingIndicatorCorrectionsRef.current.delete(correction.indicatorId);
      const indicator = activeIndicatorsRef.current.find(
        (item) => item.id === correction.indicatorId,
      );
      if (
        !indicator
        || buildIndicatorResultCacheKey(indicator, cacheContext) !== correction.targetKey
      ) continue;

      const currentChartData = chartDataRef.current || [];
      const visibleRange = typeof getCurrentVisibleRange === "function"
        ? asIndicatorVisibleRange(getCurrentVisibleRange())
        : savedVisibleRange;
      const desired = resolveInitialHostedRange(currentChartData, [indicator], visibleRange);
      const correctionPlan = planIndicatorCorrectionRefresh(
        correction.dirtyRange,
        desired,
        indicator,
        requestContext.interval,
      );
      if (!correctionPlan) continue;
      const refreshSignature = correctionPlan.requestRange
        ? buildIndicatorRangeRefreshSignature({
            seriesKey,
            requestScope: currentRequestDemand?.scope,
            requestGeneration: currentRequestDemand?.generation,
            targetKey: correction.targetKey,
            requestRange: correctionPlan.requestRange,
            invalidateRange: correctionPlan.affectedRange,
            cascadeRight: correctionPlan.cascadeRight,
            revision: correction.revision,
          })
        : null;
      if (
        refreshSignature
        && completedIndicatorRangeRequestsRef.current.has(refreshSignature)
      ) continue;

      invalidateCachedIndicatorRange(
        indicator,
        cacheContext,
        correctionPlan.affectedRange,
        {
          cascadeRight: correctionPlan.cascadeRight,
          revision: correction.revision,
        },
      );
      if (!correctionPlan.requestRange) continue;
      const sent = requestIndicatorRange(
        correctionPlan.requestRange.start,
        correctionPlan.requestRange.end,
        "recomputed",
        {
          indicatorIds: [correction.indicatorId],
          revision: correction.revision,
          onSettled: (ok, detail) => {
            if (String(detail.indicatorId || "") !== String(correction.indicatorId)) return;
            if (ok) {
              if (refreshSignature) {
                completedIndicatorRangeRequestsRef.current.remember(refreshSignature);
              }
              if (pendingIndicatorCorrectionsRef.current.has(correction.indicatorId)) {
                scheduleIndicatorCorrectionFlush();
              }
              return;
            }
            if (refreshSignature) {
              completedIndicatorRangeRequestsRef.current.forget(refreshSignature);
            }
            // The WS controller will not replay a consumed recomputed event.
            // Preserve it until a later attempt succeeds, merging it beneath
            // any newer revision already queued for this target.
            queueIndicatorCorrection(correction, true);
            if (!isDeferredIndicatorRangeSettlement(detail)) {
              scheduleIndicatorCorrectionFlush(INDICATOR_RANGE_RETRY_MS);
            }
          },
        },
      );
      if (!sent) {
        queueIndicatorCorrection(correction, true);
        scheduleIndicatorCorrectionFlush(INDICATOR_RANGE_RETRY_MS);
      }
    }
    if (waitingForOlderWork && pendingIndicatorCorrectionsRef.current.size > 0) {
      scheduleIndicatorCorrectionFlush(INDICATOR_CORRECTION_QUEUE_POLL_MS);
    }
  }, [
    activeIndicatorsRef,
    chartDataRef,
    getCurrentVisibleRange,
    getIndicatorCacheContext,
    historyWindowPendingRef,
    indicatorRangeScheduler,
    queueIndicatorCorrection,
    requestDemandRef,
    requestIndicatorRange,
    runtimeContextRef,
    savedVisibleRange,
    scheduleIndicatorCorrectionFlush,
  ]);

  useLayoutEffect(() => {
    flushIndicatorCorrectionsRef.current = flushIndicatorCorrections;
  }, [flushIndicatorCorrections]);

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
    const requestContext = runtimeContextRef.current;
    const seriesKey = [
      requestContext.sessionKey,
      requestContext.exchange,
      requestContext.marketType,
      requestContext.symbol,
      requestContext.interval,
    ].join("|");
    const targetKey = buildIndicatorResultCacheKey(indicator, cacheContext);
    const releasedWaits = revision
      ? deferredIndicatorRangeWaitsRef.current.releaseForRevision(seriesKey, revision)
      : 0;
    const releasedDirectIntents = revision
      ? directIndicatorRangeIntentsRef.current.releaseForRevision(seriesKey, revision)
      : [];
    if (revision) {
      // Mark older work stale immediately, but let its physical request drain.
      // The merged latest correction starts only after this target is idle.
      indicatorRangeScheduler.supersedeRevision({
        abortInFlight: false,
        revision,
        sessionKey: buildIndicatorRangeLifecycleKey(
          seriesKey,
          requestDemandRef.current,
        ),
        targetKeys: [targetKey],
      });
    }
    if (releasedDirectIntents.length > 0) {
      // The scheduler must observe the new revision before any deferred direct
      // intent is replayed; otherwise an old WS fallback can downgrade it.
      replayDirectIndicatorRangeIntentsRef.current(releasedDirectIntents);
    }
    if (releasedWaits > 0) {
      initialHostedHydrationGateRef.current.releasePending();
      setRangeRetryTick((tick) => tick + 1);
    }
    queueIndicatorCorrection({
      dirtyRange,
      indicatorId,
      revision,
      seriesKey,
      targetKey,
    });
    if (!historyWindowPendingRef.current) scheduleIndicatorCorrectionFlush();
  }, [
    activeIndicatorsRef,
    getIndicatorCacheContext,
    historyWindowPendingRef,
    indicatorRangeScheduler,
    queueIndicatorCorrection,
    requestDemandRef,
    runtimeContextRef,
    scheduleIndicatorCorrectionFlush,
  ]);

  useEffect(() => {
    if (
      historyWindowPending
      || pendingIndicatorCorrectionsRef.current.size === 0
    ) return;
    scheduleIndicatorCorrectionFlush();
  }, [historyWindowPending, scheduleIndicatorCorrectionFlush]);

  const handleIndicatorSubscribed = useCallback((
    indicatorId: string,
    payload: IndicatorSubscribedMessage,
  ) => {
    const indicator = activeIndicatorsRef.current.find((item) => item.id === indicatorId);
    if (!indicator) return;
    const requestContext = runtimeContextRef.current;
    const seriesKey = [
      requestContext.sessionKey,
      requestContext.exchange,
      requestContext.marketType,
      requestContext.symbol,
      requestContext.interval,
    ].join("|");
    const cacheContext = getIndicatorCacheContext();
    const targetKey = buildIndicatorResultCacheKey(indicator, cacheContext);
    const queueWsFallback = (
      range: IndicatorRange,
      reason: string,
      revision: IndicatorRevision | null = null,
      waitForSubscription?: boolean,
    ) => {
      const currentDemand = requestDemandRef.current;
      const intent: DirectIndicatorRangeIntent = {
        fingerprint: JSON.stringify([
          "ws-fallback-v1",
          reason,
          range.start,
          range.end,
          targetKey,
          meaningfulIndicatorRevisionSignature(revision),
          currentDemand?.scope || "",
          currentDemand?.generation ?? "",
        ]),
        key: `ws-fallback:${seriesKey}:${indicatorId}`,
        payload: {
          indicatorIds: [indicatorId],
          kind: "ws-fallback",
          reason,
          ...(revision ? { revision } : {}),
          ...(waitForSubscription !== undefined ? { waitForSubscription } : {}),
        },
        range,
        revision,
        seriesKey,
      };
      queueDirectIndicatorRangeIntent(intent, {
        deferExecution: !canExecuteCurrentWsFallback(),
      });
    };
    if (payload?.subscriptionStatus === "failed" || payload?.ok === false) {
      markHostedRealtimeUnavailable(indicatorId, true);
      markHostedSubscriptionReady(indicatorId);
      const failureMessage = payload?.failure?.message
        || payload?.errorDetail?.message
        || payload?.error
        || "Indicator realtime subscription is unavailable";
      setIndicatorError(
        indicatorId,
        `${failureMessage}；已切换为 HTTP 已收盘值补齐。`,
      );
      const currentChartData = chartDataRef.current || [];
      const visibleRange = typeof getCurrentVisibleRange === "function"
        ? asIndicatorVisibleRange(getCurrentVisibleRange())
        : savedVisibleRange;
      const desired = resolveInitialHostedRange(currentChartData, [indicator], visibleRange);
      if (desired) {
        queueWsFallback(
          { start: desired.start, end: desired.end },
          "ws-subscription-failed",
          null,
          false,
        );
      }
      return;
    }
    markHostedRealtimeUnavailable(indicatorId, false);
    const resumeStatus = payload?.resumeStatus || payload?.resume_status || "legacy";
    if (resumeStatus === "patch") {
      hostedPendingResumePatchIdsRef.current.add(String(indicatorId));
    } else {
      markHostedSubscriptionReady(indicatorId);
    }
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
      queueWsFallback(desired, "ws-history-required", revision);
    }
  }, [
    activeIndicatorsRef,
    canExecuteCurrentWsFallback,
    chartDataRef,
    getCurrentVisibleRange,
    getIndicatorCacheContext,
    markHostedSubscriptionReady,
    markHostedRealtimeUnavailable,
    queueDirectIndicatorRangeIntent,
    requestDemandRef,
    runtimeContextRef,
    savedVisibleRange,
    setIndicatorError,
  ]);

  const hostedSubscriptionUpdatesReady = settledInitialHydrationSignature
    === currentInitialHydrationSignature;
  const hostedStreamDataReady = canRunHostedIndicatorStream({
    chartDataReady,
    initialHydrationSettled: hostedSubscriptionUpdatesReady,
    streamStartedForSeries: hostedStreamStartedLifecycleKey === currentStreamLifecycleKey,
  });

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
    chartDataReady: hostedStreamDataReady,
    chartDataRef,
    exchange,
    historyWindowPending,
    getIndicatorResumeState: resolveIndicatorResumeState,
    handleIndicatorRecomputed,
    handleIndicatorSubscriptionPending: markHostedSubscriptionPending,
    handleIndicatorSubscribed,
    interval,
    marketType,
    realtimeEnabled,
    resetHostedSubscriptionReadiness,
    setIndicatorError,
    subscriptionUpdatesReady: hostedSubscriptionUpdatesReady,
    symbol,
    streamCoordinator: marketWorkspaceResources?.indicatorStreamCoordinator || null,
    streamIdentity: options.streamIdentity || null,
  });

  useEffect(() => {
    const requestContext = runtimeContextRef.current;
    const seriesKey = [
      requestContext.sessionKey,
      requestContext.exchange,
      requestContext.marketType,
      requestContext.symbol,
      requestContext.interval,
    ].join("|");
    const released = deferredIndicatorRangeWaitsRef.current.releaseForEvents(
      seriesKey,
      indicatorRangeRequests,
    );
    const releasedDirectIntents = directIndicatorRangeIntentsRef.current.releaseForEvents(
      seriesKey,
      indicatorRangeRequests,
    );
    if (releasedDirectIntents.length > 0) {
      replayDirectIndicatorRangeIntentsRef.current(releasedDirectIntents);
    }
    if (released > 0) {
      initialHostedHydrationGateRef.current.releasePending();
      queueMicrotask(() => setRangeRetryTick((tick) => tick + 1));
      scheduleIndicatorCorrectionFlush();
    }
  }, [indicatorRangeRequests, runtimeContextRef, scheduleIndicatorCorrectionFlush]);

  useEffect(() => {
    reconcileConsumedIndicatorRangeRequestIds(
      consumedIndicatorRangeRequestIdsRef.current,
      indicatorRangeRequests,
      sessionKey,
    );
    const hostedIndicators = getVisibleHostedIndicators(activeIndicators);
    if (hostedIndicators.length === 0) {
      for (const request of indicatorRangeRequests) {
        if (!request || request.sessionKey !== sessionKey) continue;
        consumeIndicatorRangeRequest?.(request.id);
      }
      return undefined;
    }

    const currentVisibleRange = typeof getCurrentVisibleRange === "function"
      ? asIndicatorVisibleRange(getCurrentVisibleRange())
      : savedVisibleRange;
    const desiredRange = resolveInitialHostedRange(
      chartData,
      hostedIndicators,
      currentVisibleRange,
    );
    const cacheContext = getIndicatorCacheContext();
    const requestContext = runtimeContextRef.current;
    const currentRequestDemand = requestDemandRef.current;
    const seriesKey = [
      requestContext.sessionKey,
      requestContext.exchange,
      requestContext.marketType,
      requestContext.symbol,
      requestContext.interval,
    ].join("|");
    const currentRevision = normalizeIndicatorRevision(
      chartDataMetaRef.current?.dataRevision
        || normalizeIndicatorRevision(chartDataMetaRef.current)
        || seriesRevisionRef.current,
    );
    let nextCoalesceDelay: number | null = null;
    for (const request of indicatorRangeRequests) {
      if (!request || request.sessionKey !== sessionKey) continue;
      if (consumedIndicatorRangeRequestIdsRef.current.has(request.id)) continue;
      const coalesceDelay = indicatorWindowCorrectionCoalesceDelay(request);
      if (coalesceDelay > 0) {
        nextCoalesceDelay = nextCoalesceDelay == null
          ? coalesceDelay
          : Math.min(nextCoalesceDelay, coalesceDelay);
        continue;
      }
      consumedIndicatorRangeRequestIdsRef.current.add(request.id);
      reconcileConsumedIndicatorRangeRequestIds(
        consumedIndicatorRangeRequestIdsRef.current,
        indicatorRangeRequests,
        sessionKey,
      );
      const plannedRefreshes = planIndicatorWindowDeltaRefreshes(
        request,
        desiredRange,
        hostedIndicators,
        requestContext.interval,
        chartData,
      ).map(({ indicator, plan }) => ({
        indicator,
        plan: request.reason === "window-mid-merge" && plan.requestRange
          ? {
              ...plan,
              requestRange: bridgeIndicatorWindowDeltaToComputedCoverage(
                plan.requestRange,
                desiredRange,
                getCachedIndicatorComputedSegments(indicator, cacheContext, currentRevision),
              ),
            }
          : plan,
      }));
      if (plannedRefreshes.some(({ indicator }) => (
        pendingIndicatorCorrectionsRef.current.has(String(indicator.id))
      ))) {
        consumedIndicatorRangeRequestIdsRef.current.delete(request.id);
        scheduleIndicatorCorrectionFlush(0);
        scheduleIndicatorRangeEventRetry(INDICATOR_CORRECTION_QUEUE_POLL_MS);
        continue;
      }
      if (plannedRefreshes.length === 0) {
        consumeIndicatorRangeRequest?.(request.id);
        continue;
      }

      const refreshSignatures = new Map<string, string>();
      const refreshes = plannedRefreshes.filter(({ indicator, plan }) => {
        if (!plan.requestRange) return true;
        const signature = buildIndicatorRangeRefreshSignature({
          seriesKey,
          requestScope: currentRequestDemand?.scope,
          requestGeneration: currentRequestDemand?.generation,
          targetKey: buildIndicatorResultCacheKey(indicator, cacheContext),
          requestRange: plan.requestRange,
          invalidateRange: plan.invalidateRange,
          cascadeRight: plan.cascadeRight,
          revision: currentRevision,
        });
        if (!signature) return true;
        refreshSignatures.set(String(indicator.id), signature);
        return !completedIndicatorRangeRequestsRef.current.has(signature);
      });
      if (refreshes.length === 0) {
        consumeIndicatorRangeRequest?.(request.id);
        continue;
      }

      for (const { indicator, plan } of refreshes) {
        if (plan.invalidateRange) {
          invalidateCachedIndicatorRange(indicator, cacheContext, plan.invalidateRange, {
            cascadeRight: plan.cascadeRight,
            revision: currentRevision,
          });
        } else if (request.reason === "window-prepend" && plan.requestRange && currentRevision) {
          // A prepend introduces a new left segment.  Rebase already computed
          // segments to the new revision without throwing them away globally.
          invalidateCachedIndicatorRange(indicator, cacheContext, plan.requestRange, {
            cascadeRight: false,
            revision: currentRevision,
          });
        }
      }
      const requestGroups = groupIndicatorWindowDeltaRefreshes(refreshes);

      if (requestGroups.length === 0) {
        consumeIndicatorRangeRequest?.(request.id);
        continue;
      }

      const settleBarrier = createIndicatorRangeEventSettlementBarrier({
        indicatorIds: requestGroups.flatMap((group) => group.indicatorIds),
        onFailure: (detail) => {
          consumedIndicatorRangeRequestIdsRef.current.delete(request.id);
          if (!isDeferredIndicatorRangeSettlement(detail)) {
            scheduleIndicatorRangeEventRetry();
          }
        },
        onSuccess: () => consumeIndicatorRangeRequest?.(request.id),
      });
      const settle = (ok: boolean, detail: Record<string, unknown> = {}) => {
        const indicatorId = String(detail.indicatorId || "");
        const signature = refreshSignatures.get(indicatorId);
        if (signature) {
          if (ok) completedIndicatorRangeRequestsRef.current.remember(signature);
          else completedIndicatorRangeRequestsRef.current.forget(signature);
        }
        settleBarrier(ok, detail);
      };
      for (const { indicatorIds, range } of requestGroups) {
        const sent = requestIndicatorRangeOnce(
          requestIndicatorRange,
          range.start,
          range.end,
          request.reason,
          {
            indicatorIds,
            onSettled: settle,
            revision: currentRevision,
            waitForSubscription: false,
          },
        );
        if (sent) continue;
        settle(false, { indicatorId: indicatorIds[0] });
        break;
      }
    }
    if (nextCoalesceDelay != null) {
      scheduleIndicatorRangeEventRetry(nextCoalesceDelay);
    }
    return undefined;
  }, [
    activeIndicators,
    chartData,
    chartDataMetaRef,
    consumeIndicatorRangeRequest,
    exchange,
    getIndicatorCacheContext,
    getCurrentVisibleRange,
    indicatorRangeRequests,
    interval,
    marketType,
    rangeRetryTick,
    requestIndicatorRange,
    requestDemandRef,
    runtimeContextRef,
    savedVisibleRange,
    scheduleIndicatorCorrectionFlush,
    scheduleIndicatorRangeEventRetry,
    sessionKey,
    subscriptionAckTick,
    symbol,
  ]);

  useLayoutEffect(() => {
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
    visibleNavigationStateRef.current = null;
    initialHostedHydrationGateRef.current.clear();
    progressiveHostedHydrationGateRef.current.clear();
    completedIndicatorRangeRequestsRef.current.clear();
    deferredIndicatorRangeWaitsRef.current.clear();
    directIndicatorRangeIntentsRef.current.clear();
    directIndicatorRangeRetryTimersRef.current.cancelAll();
    pendingIndicatorCorrectionsRef.current.clear();
    consumedIndicatorRangeRequestIdsRef.current.clear();
    if (indicatorRangeEventRetryTimerRef.current) {
      clearTimeout(indicatorRangeEventRetryTimerRef.current);
      indicatorRangeEventRetryTimerRef.current = null;
    }
    initialHostedRangeRetryTimersRef.current.cancelAll();
    if (indicatorCorrectionFlushTimerRef.current) {
      clearTimeout(indicatorCorrectionFlushTimerRef.current);
      indicatorCorrectionFlushTimerRef.current = null;
    }
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
    indicatorRangeScheduler.setSession(currentStreamLifecycleKey);
  }, [
    currentStreamLifecycleKey,
    exchange,
    indicatorRangeScheduler,
    interval,
    marketType,
    sessionKey,
    symbol,
  ]);

  useEffect(() => {
    const pendingIndicatorCorrections = pendingIndicatorCorrectionsRef.current;
    const initialHostedHydrationGate = initialHostedHydrationGateRef.current;
    const progressiveHostedHydrationGate = progressiveHostedHydrationGateRef.current;
    const initialHostedRangeRetryTimers = initialHostedRangeRetryTimersRef.current;
    const deferredIndicatorRangeWaits = deferredIndicatorRangeWaitsRef.current;
    const directIndicatorRangeIntents = directIndicatorRangeIntentsRef.current;
    const directIndicatorRangeRetryTimers = directIndicatorRangeRetryTimersRef.current;
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
      if (indicatorRangeEventRetryTimerRef.current) {
        clearTimeout(indicatorRangeEventRetryTimerRef.current);
        indicatorRangeEventRetryTimerRef.current = null;
      }
      initialHostedRangeRetryTimers.cancelAll();
      directIndicatorRangeRetryTimers.cancelAll();
      if (indicatorCorrectionFlushTimerRef.current) {
        clearTimeout(indicatorCorrectionFlushTimerRef.current);
        indicatorCorrectionFlushTimerRef.current = null;
      }
      pendingIndicatorCorrections.clear();
      initialHostedHydrationGate.clear();
      progressiveHostedHydrationGate.clear();
      deferredIndicatorRangeWaits.clear();
      directIndicatorRangeIntents.clear();
      indicatorRangeBatcher.dispose();
      indicatorRangeScheduler.dispose();
    };
  }, [indicatorRangeBatcher, indicatorRangeScheduler]);

  useEffect(() => {
    if (!canStartIndicatorProgressiveHydration({
      chartDataLength: chartData.length,
      chartDataReady,
      initialHistoryPending,
    })) return;
    const hostedIndicators = getVisibleHostedIndicators(activeIndicators);
    if (hostedIndicators.length === 0) return;

    // The chart's live visible range can still describe the previous interval
    // during a series transition. Base the opportunistic pass on the current
    // partial dataset instead of issuing a misleading two-bar preview.
    const initialRange = resolveInitialHostedRange(
      chartData,
      hostedIndicators,
      null,
    );
    if (!initialRange) return;
    const progressiveRange = resolveProgressiveHostedRange(
      chartData,
      initialRange,
      interval,
    );
    if (!progressiveRange) return;
    const progressiveIndicators = selectProgressiveHostedIndicators(
      hostedIndicators,
      progressiveRange,
    );
    if (progressiveIndicators.length === 0) return;

    const signature = currentInitialHydrationSignature;
    const gate = progressiveHostedHydrationGateRef.current;
    const progressiveTargets = progressiveIndicators.flatMap((indicator) => {
      const targetSignature = JSON.stringify([signature, indicator.id]);
      return gate.begin(targetSignature)
        ? [{ id: indicator.id, signature: targetSignature }]
        : [];
    });
    if (progressiveTargets.length === 0) return;
    const indicatorIds = progressiveTargets.map((target) => target.id);
    const completeTargets = () => {
      for (const target of progressiveTargets) gate.complete(target.signature);
    };
    const settle = createIndicatorRangeEventSettlementBarrier({
      indicatorIds,
      // This pass is opportunistic. A deferred or failed preview must not
      // retry in waves while the K-line owner is still extending the window;
      // the authoritative initial-visible pass runs after owner settlement.
      onFailure: completeTargets,
      onSuccess: completeTargets,
      waitForAllTargetsOnFailure: true,
    });
    const accepted = requestIndicatorRange(
      progressiveRange.start,
      progressiveRange.end,
      "initial-progressive",
      {
        indicatorIds,
        onSettled: settle,
        // The preview is deliberately HTTP-only and must not wait for the
        // realtime subscription handshake of the still-loading series.
        waitForSubscription: false,
      },
    );
    if (!accepted) completeTargets();
  }, [
    activeIndicators,
    chartData,
    chartDataReady,
    currentInitialHydrationSignature,
    historyWindowPending,
    initialHistoryPending,
    interval,
    requestIndicatorRange,
  ]);

  useEffect(() => {
    if (!canStartIndicatorInitialHydration({
      chartDataLength: chartData.length,
      chartDataReady,
      historyWindowPending,
    })) return;
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

    const signature = currentInitialHydrationSignature;
    if (!initialHostedHydrationGateRef.current.begin(signature)) return;
    const settle = createIndicatorRangeEventSettlementBarrier({
      indicatorIds: hostedIndicators.map((indicator) => indicator.id),
      onFailure: (detail) => {
        if (!isDeferredIndicatorRangeSettlement(detail)) {
          // A terminal attempt may be retried, but it must not starve every
          // healthy indicator's realtime stream. Historical WS fallbacks are
          // released by the same settlement latch and remain scheduler-deduped.
          initialHostedHydrationGateRef.current.release(signature);
          if (currentInitialHydrationSignatureRef.current === signature) {
            setSettledInitialHydrationSignature(signature);
            setHostedStreamStartedLifecycleKey(currentStreamLifecycleKey);
          }
          scheduleInitialHostedRangeRetry(signature);
        }
      },
      onSuccess: () => {
        initialHostedHydrationGateRef.current.complete(signature);
        if (currentInitialHydrationSignatureRef.current === signature) {
          setSettledInitialHydrationSignature(signature);
          setHostedStreamStartedLifecycleKey(currentStreamLifecycleKey);
        }
      },
      waitForAllTargetsOnFailure: true,
    });
    const accepted = requestIndicatorRange(
      initialRange.start,
      initialRange.end,
      "initial-visible",
      {
        indicatorIds: hostedIndicators.map((indicator) => indicator.id),
        onSettled: settle,
      },
    );
    if (!accepted) {
      scheduleInitialHostedRangeRetry(signature);
      return;
    }
    visibleNavigationStateRef.current = planVisibleIndicatorHydrationRange({
      chartData,
      desired: initialRange,
      interval,
      previous: null,
      seriesKey: currentSeriesKey,
    }).nextState;
    // A viewport callback may have been retained while the K-line owner was
    // pending. This accepted initial request was planned from the latest
    // viewport and supersedes that deferred callback, preventing a second
    // all-indicator batch shortly after the final window becomes ready.
    pendingVisibleRangeRef.current = null;
    if (visibleRangeEnsureTimerRef.current) {
      clearTimeout(visibleRangeEnsureTimerRef.current);
      visibleRangeEnsureTimerRef.current = null;
    }
    autoRightCatchupPendingRef.current = null;
    if (autoRightCatchupTimerRef.current) {
      clearTimeout(autoRightCatchupTimerRef.current);
      autoRightCatchupTimerRef.current = null;
    }
  }, [
    activeIndicators,
    chartData,
    chartDataReady,
    currentInitialHydrationSignature,
    currentInitialHydrationSignatureRef,
    currentSeriesKey,
    currentStreamLifecycleKey,
    exchange,
    getCurrentVisibleRange,
    historyWindowPending,
    interval,
    marketType,
    rangeRetryTick,
    requestDemandRef,
    requestIndicatorRange,
    savedVisibleRange,
    scheduleInitialHostedRangeRetry,
    sessionKey,
    subscriptionAckTick,
    symbol,
  ]);

  useEffect(() => {
    const clearPendingAutoRight = () => {
      autoRightCatchupPendingRef.current = null;
      if (autoRightCatchupTimerRef.current) {
        clearTimeout(autoRightCatchupTimerRef.current);
        autoRightCatchupTimerRef.current = null;
      }
    };
    if (
      !chartDataReady
      || !Array.isArray(chartData)
      || chartData.length === 0
      || historyWindowPending
    ) {
      clearPendingAutoRight();
      return;
    }

    const hostedIndicators = getVisibleHostedIndicators(activeIndicators);
    if (hostedIndicators.length === 0) {
      clearPendingAutoRight();
      return;
    }

    const seriesKey = [sessionKey, exchange, marketType, symbol, interval].join("|");
    const currentDemand = requestDemandRef.current;
    const initialHydrationSignature = currentInitialHydrationSignature;
    if (!canStartIndicatorAutoRightCatchup({
      chartDataLength: chartData.length,
      chartDataReady,
      historyWindowPending,
      initialHydrationPending: initialHostedHydrationGateRef.current.isPending(
        initialHydrationSignature,
      ),
    })) {
      clearPendingAutoRight();
      return;
    }

    const missingRange = resolveMissingHostedRightRange(chartData, hostedIndicators, interval);
    if (!missingRange) {
      clearPendingAutoRight();
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
    const directIntentKey = `auto-right:${seriesKey}`;
    const directIntentFingerprint = JSON.stringify([
      "auto-right-catchup-v1",
      signature,
      currentDemand?.scope || "",
      currentDemand?.generation ?? "",
    ]);
    if (
      directIndicatorRangeIntentsRef.current.has(
        directIntentKey,
        directIntentFingerprint,
      )
    ) return;

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
      if (
        historyWindowPendingRef.current
        || initialHostedHydrationGateRef.current.isPending(initialHydrationSignature)
      ) {
        autoRightCatchupPendingRef.current = null;
        return;
      }
      if (autoRightCatchupRangeSignaturesRef.current.has(latest.signature)) {
        autoRightCatchupPendingRef.current = null;
        return;
      }
      queueDirectIndicatorRangeIntent({
        fingerprint: directIntentFingerprint,
        key: directIntentKey,
        payload: {
          completionSignature: latest.signature,
          indicatorIds: hostedIndicators.map((indicator) => indicator.id),
          kind: "auto-right",
          reason: "auto-right-catchup",
        },
        range: latest.range,
        seriesKey,
      });
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
    currentInitialHydrationSignature,
    exchange,
    historyWindowPending,
    historyWindowPendingRef,
    interval,
    marketType,
    queueDirectIndicatorRangeIntent,
    requestDemandRef,
    sessionKey,
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
    if (!realtimeEnabled) {
      realtimeIndicatorBatcherRef.current?.clear();
      provisionalIndicatorPreviewsRef.current.clear();
    }
  }, [realtimeEnabled]);

  useLayoutEffect(() => {
    indicatorHydrationScheduler.activate(indicatorHydrationLifecycleKey);
    // Context ownership changes synchronously: the first chart commit must not
    // retain outputs from the previous product/config. Warm line arrays are
    // cheap stable cache views, so publish them now without cloning.
    outputDispatch({ type: "reset-context" });
    const cachedEntries = resolveCachedIndicatorResults(
      activeIndicatorsRef.current,
      getIndicatorCacheContext(),
    );
    setActiveIndicators((previous) => hydrateIndicatorDefinitionsFromCache(
      previous,
      cachedEntries,
      { clearMissing: true },
    ));
  }, [
    activeIndicatorsRef,
    getIndicatorCacheContext,
    indicatorHydrationLifecycleKey,
    indicatorHydrationScheduler,
    outputDispatch,
    setActiveIndicators,
  ]);

  useEffect(() => {
    const cacheContext = getIndicatorCacheContext();
    const currentIndicators = activeIndicatorsRef.current;
    if (
      buildIndicatorCacheHydrationSignature(currentIndicators, cacheContext)
      !== indicatorCacheHydrationSignature
    ) return undefined;

    const contentVersion = currentIndicators.map((indicator) => (
      getCachedIndicatorMetadata(indicator, cacheContext)?.contentVersion ?? "missing"
    )).join("|");
    indicatorHydrationScheduler.schedule({
      lifecycleKey: indicatorHydrationLifecycleKey,
      contentSignature: indicatorCacheHydrationSignature,
      contentVersion,
      isCurrent: (identity) => (
        indicatorHydrationLifecycleKeyRef.current === identity.lifecycleKey
      ),
      run: (identity) => {
        if (indicatorHydrationLifecycleKeyRef.current !== identity.lifecycleKey) return;
        const currentContext = getIndicatorCacheContext();
        const indicators = activeIndicatorsRef.current;
        if (
          buildIndicatorCacheHydrationSignature(indicators, currentContext)
          !== indicatorCacheHydrationSignature
        ) return;

        // Resolve at execution time so a WS/range update that lands while the
        // task is deferred wins over the snapshot observed when it was queued.
        const cachedEntries = resolveCachedIndicatorResults(indicators, currentContext);
        setActiveIndicators((previous) => {
          if (
            buildIndicatorCacheHydrationSignature(previous, currentContext)
            !== indicatorCacheHydrationSignature
          ) return previous;
          return hydrateIndicatorDefinitionsFromCache(
            previous,
            cachedEntries,
            { clearMissing: false },
          );
        });
        if (indicatorHydrationLifecycleKeyRef.current === identity.lifecycleKey) {
          outputDispatch({ type: "hydrate-cache", entries: cachedEntries });
        }
      },
    });
    return () => indicatorHydrationScheduler.cancel();
  }, [
    activeIndicatorsRef,
    getIndicatorCacheContext,
    indicatorCacheHydrationSignature,
    indicatorHydrationLifecycleKey,
    indicatorHydrationLifecycleKeyRef,
    indicatorHydrationScheduler,
    outputDispatch,
    setActiveIndicators,
  ]);

  const visibleOutputState = useMemo(
    () => filterIndicatorOutputStateByVisibility(
      outputState,
      activeIndicators,
    ),
    [activeIndicators, outputState],
  );

  const paneData = useMemo(
    () => buildIndicatorPaneData(activeIndicators, {
      markers: visibleOutputState.markers,
      fills: visibleOutputState.fills,
      hlines: visibleOutputState.hlines,
      bgcolors: visibleOutputState.bgcolors,
    }),
    [
      activeIndicators,
      visibleOutputState.bgcolors,
      visibleOutputState.fills,
      visibleOutputState.hlines,
      visibleOutputState.markers,
    ],
  );

  const view = useMemo(() => ({
    activeIndicators,
    mainOverlayLines: paneData.mainOverlayLines,
    subPanes: paneData.subPanes,
    markers: visibleOutputState.markers,
    fills: visibleOutputState.fills,
    hlines: visibleOutputState.hlines,
    bgcolors: visibleOutputState.bgcolors,
    barcolors: visibleOutputState.barcolors,
    signals: visibleOutputState.signals,
    paramSchemas: visibleOutputState.paramSchemas,
  }), [activeIndicators, paneData, visibleOutputState]);

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

  const hasRealtimeUnavailableHostedIndicator = useMemo(() => (
    getVisibleHostedIndicators(activeIndicators).some(
      (indicator) => realtimeUnavailableIndicatorContexts.get(indicator.id) === [
        sessionKey,
        exchange,
        marketType,
        symbol,
        interval,
      ].join("|"),
    )
  ), [
    activeIndicators,
    exchange,
    interval,
    marketType,
    realtimeUnavailableIndicatorContexts,
    sessionKey,
    symbol,
  ]);

  const status = useMemo(() => ({
    computing,
    realtimeMode: !realtimeEnabled
      ? "historical-only" as const
      : hasRealtimeUnavailableHostedIndicator
        ? "degraded" as const
        : "enabled" as const,
  }), [computing, hasRealtimeUnavailableHostedIndicator, realtimeEnabled]);

  return {
    view,
    actions,
    status,
  };
}
