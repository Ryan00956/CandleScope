import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { IntervalString } from "../../utils/intervals.js";
import type { ExchangeId, MarketType, SymbolCode } from "../../utils/symbolKey.js";
import type { CommitChartData } from "./klineContracts.js";
import {
  millisecondsToSeconds,
  toEpochMilliseconds,
  toEpochSeconds,
  type EpochSeconds,
  type KlineBar,
} from "./marketDataTypes.js";
import type { SeriesDataFeed } from "./feed/seriesDataFeed.js";
import { planTargetBarRequest } from "./intervalRequestBudget.js";

const LOAD_MORE_PAGE_SIZE = 500;
export const LOAD_MORE_SOURCE_ROW_BUDGET = 10_000;
export const PENDING_PAGE_COOLDOWN_MS = 2_000;

export type LoadMoreLeft = (oldestLoadedTime?: EpochSeconds | null) => Promise<void>;

export type LeftPaginationPhase = "idle" | "loading" | "pending" | "stalled" | "exhausted";

export interface LeftPaginationState {
  sessionKey: string;
  phase: LeftPaginationPhase;
  requestedBefore: EpochSeconds | null;
  nextBefore: EpochSeconds | null;
}

export interface BeforePageProgress {
  phase: Exclude<LeftPaginationPhase, "loading">;
  hasMoreLeft: boolean;
  madeProgress: boolean;
  nextBefore: EpochSeconds | null;
}

export interface PendingBeforePageOwnership {
  requestedBefore: EpochSeconds;
}

export type BeforePageRequestDecision =
  | { action: "join-pending"; before: EpochSeconds }
  | { action: "request"; before: EpochSeconds };

export function resolveBeforePageRequest({
  oldestChartTime,
  oldestLoadedTime,
  nextBefore,
  pendingPage = null,
}: {
  oldestChartTime: EpochSeconds;
  oldestLoadedTime?: EpochSeconds | null;
  nextBefore: EpochSeconds | null;
  pendingPage?: PendingBeforePageOwnership | null;
}): BeforePageRequestDecision {
  if (pendingPage) {
    // A partial page owns its original boundary until it settles. The chart
    // may already contain partial older rows, but using that newer visual
    // oldest value would skip the unresolved portion of this logical page.
    return { action: "join-pending", before: pendingPage.requestedBefore };
  }
  const requestedBoundary = toEpochSeconds(oldestLoadedTime) ?? oldestChartTime;
  return {
    action: "request",
    before: nextBefore == null
      ? requestedBoundary
      : Math.min(nextBefore, requestedBoundary) as EpochSeconds,
  };
}

export function resolveBeforePageProgress({
  hasMore,
  nextBeforeMs,
  pending = false,
  requestedBefore,
  rows,
}: {
  hasMore?: boolean;
  nextBeforeMs?: unknown;
  pending?: boolean;
  requestedBefore: EpochSeconds;
  rows: readonly KlineBar[];
}): BeforePageProgress {
  const parsedNextBeforeMs = toEpochMilliseconds(nextBeforeMs);
  const serverNextBefore = parsedNextBeforeMs == null
    ? null
    : millisecondsToSeconds(parsedNextBeforeMs);
  let oldestIncoming: EpochSeconds | null = null;
  for (const row of rows) {
    const time = toEpochSeconds(row?.time);
    if (time == null || time >= requestedBefore) continue;
    if (oldestIncoming == null || time < oldestIncoming) oldestIncoming = time;
  }
  const nextBefore = serverNextBefore != null && serverNextBefore < requestedBefore
    ? serverNextBefore
    : oldestIncoming;
  const madeProgress = nextBefore != null && nextBefore < requestedBefore;

  if (hasMore === false) {
    return { phase: "exhausted", hasMoreLeft: false, madeProgress, nextBefore };
  }
  if (pending) {
    return {
      phase: "pending",
      hasMoreLeft: true,
      madeProgress,
      // Pending means the requested page is not complete yet. Retrying an
      // older continuation cursor here can skip the unresolved part of the
      // current page, so keep ownership on the same boundary until settled.
      nextBefore: requestedBefore,
    };
  }
  if (!madeProgress) {
    return { phase: "stalled", hasMoreLeft: false, madeProgress: false, nextBefore: null };
  }
  return { phase: "idle", hasMoreLeft: true, madeProgress: true, nextBefore };
}

export interface UseChartLoadMoreLeftOptions {
  enabled: boolean;
  symbol: SymbolCode;
  exchange: ExchangeId;
  marketType: MarketType;
  interval: IntervalString;
  nativeIntervalValues: readonly IntervalString[];
  chartData: KlineBar[];
  loading: boolean;
  dataSource: string | null;
  seriesDataFeed: SeriesDataFeed;
  commitMergedChartData: CommitChartData;
}

export function planLoadMorePageSize(
  interval: IntervalString,
  nativeIntervalValues: readonly IntervalString[],
): number {
  return planTargetBarRequest({
    desiredTargetBars: LOAD_MORE_PAGE_SIZE,
    interval,
    nativeIntervals: nativeIntervalValues,
    sourceRowBudget: LOAD_MORE_SOURCE_ROW_BUDGET,
  })?.targetBars ?? LOAD_MORE_PAGE_SIZE;
}

export interface ChartLoadMoreLeftRuntime {
  loadingMoreLeft: boolean;
  setLoadingMoreLeft: Dispatch<SetStateAction<boolean>>;
  hasMoreLeft: boolean;
  setHasMoreLeft: Dispatch<SetStateAction<boolean>>;
  handleNeedMoreLeft: LoadMoreLeft;
  hasActivePaginationOwnership(): boolean;
  paginationState: LeftPaginationState;
  resetPagination(): void;
}

export function useChartLoadMoreLeft({
  enabled,
  symbol,
  exchange,
  marketType,
  interval,
  nativeIntervalValues,
  chartData,
  loading,
  dataSource,
  seriesDataFeed,
  commitMergedChartData,
}: UseChartLoadMoreLeftOptions): ChartLoadMoreLeftRuntime {
  const sessionKey = `${exchange}:${marketType}:${symbol}:${interval}`;
  const [loadingMoreLeft, setLoadingMoreLeftState] = useState(false);
  const [hasMoreLeft, setHasMoreLeftState] = useState(true);
  const [paginationState, setPaginationState] = useState<LeftPaginationState>({
    sessionKey,
    phase: "idle",
    requestedBefore: null,
    nextBefore: null,
  });
  const loadingMoreLeftRef = useRef(false);
  const hasMoreLeftRef = useRef(true);
  const sessionKeyRef = useRef(sessionKey);
  const sessionGenerationRef = useRef(0);
  const nextBeforeRef = useRef<EpochSeconds | null>(null);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const pendingBeforePageRef = useRef<(
    PendingBeforePageOwnership & {
      sessionGeneration: number;
      sessionKey: string;
    }
  ) | null>(null);
  type RequestPage = (
    oldestLoadedTime?: EpochSeconds | null,
  ) => Promise<void>;
  const inflightRef = useRef<{
    requestId: number;
    sessionKey: string;
    promise: Promise<void>;
  } | null>(null);

  const setLoadingMoreLeft = useCallback<Dispatch<SetStateAction<boolean>>>((next) => {
    const value = typeof next === "function" ? next(loadingMoreLeftRef.current) : next;
    loadingMoreLeftRef.current = value;
    setLoadingMoreLeftState(value);
  }, []);
  const setHasMoreLeft = useCallback<Dispatch<SetStateAction<boolean>>>((next) => {
    const value = typeof next === "function" ? next(hasMoreLeftRef.current) : next;
    hasMoreLeftRef.current = value;
    setHasMoreLeftState(value);
  }, []);

  const oldestChartTime = chartData[0]?.time ?? null;
  const loadMorePageSize = planLoadMorePageSize(interval, nativeIntervalValues);

  const resetPagination = useCallback(() => {
    sessionGenerationRef.current += 1;
    nextBeforeRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    inflightRef.current = null;
    pendingBeforePageRef.current = null;
    setLoadingMoreLeft(false);
    setHasMoreLeft(true);
    setPaginationState({
      sessionKey,
      phase: "idle",
      requestedBefore: null,
      nextBefore: null,
    });
  }, [sessionKey, setHasMoreLeft, setLoadingMoreLeft]);

  useEffect(() => {
    sessionKeyRef.current = sessionKey;
    resetPagination();
    return () => {
      sessionGenerationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      inflightRef.current = null;
      pendingBeforePageRef.current = null;
    };
  }, [resetPagination, sessionKey]);

  useEffect(() => {
    const ownership = pendingBeforePageRef.current;
    if (!ownership) return;
    const feedPending = seriesDataFeed.getPendingBeforePage({
      exchange,
      marketType,
      symbol,
      interval,
    });
    if (feedPending?.before === ownership.requestedBefore) return;
    pendingBeforePageRef.current = null;
    nextBeforeRef.current = null;
    setPaginationState((current) => (
      current.sessionKey === sessionKey && current.phase === "pending"
        ? { ...current, phase: "idle", nextBefore: null }
        : current
    ));
  }, [chartData, exchange, interval, marketType, seriesDataFeed, sessionKey, symbol]);

  const requestPage = useCallback<RequestPage>(
    (oldestLoadedTime): Promise<void> => {
      const series = { exchange, marketType, symbol, interval };
      const feedPending = seriesDataFeed.getPendingBeforePage(series);
      let pendingOwnership = pendingBeforePageRef.current;
      if (
        pendingOwnership
        && (
          pendingOwnership.sessionGeneration !== sessionGenerationRef.current
          || pendingOwnership.sessionKey !== sessionKey
          || feedPending?.before !== pendingOwnership.requestedBefore
        )
      ) {
        pendingBeforePageRef.current = null;
        nextBeforeRef.current = null;
        pendingOwnership = null;
      }
      if (!pendingOwnership && feedPending) {
        pendingOwnership = {
          requestedBefore: feedPending.before,
          sessionGeneration: sessionGenerationRef.current,
          sessionKey,
        };
        pendingBeforePageRef.current = pendingOwnership;
      }
      if (
        !enabled
        || loading
        || !hasMoreLeftRef.current
        || dataSource === "mock"
        || sessionKeyRef.current !== sessionKey
      ) {
        return Promise.resolve();
      }
      const currentInflight = inflightRef.current;
      if (currentInflight?.sessionKey === sessionKey) return currentInflight.promise;
      if (loadingMoreLeftRef.current) {
        return Promise.resolve();
      }
      if (loadMorePageSize <= 0) {
        pendingBeforePageRef.current = null;
        setHasMoreLeft(false);
        setPaginationState({
          sessionKey,
          phase: "exhausted",
          requestedBefore: null,
          nextBefore: null,
        });
        return Promise.resolve();
      }
      if (oldestChartTime == null) {
        return Promise.resolve();
      }

      const requestDecision = resolveBeforePageRequest({
        oldestChartTime,
        ...(oldestLoadedTime === undefined ? {} : { oldestLoadedTime }),
        nextBefore: nextBeforeRef.current,
        pendingPage: pendingOwnership,
      });
      if (requestDecision.action === "join-pending") return Promise.resolve();
      const before = requestDecision.before;
      if (seriesDataFeed.isBeforePageCoolingDown(series)) {
        return Promise.resolve();
      }

      const generation = sessionGenerationRef.current;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      const controller = new AbortController();
      abortRef.current = controller;
      setLoadingMoreLeft(true);
      setPaginationState({
        sessionKey,
        phase: "loading",
        requestedBefore: before,
        nextBefore: nextBeforeRef.current,
      });

      const ownsRequest = () => (
        sessionGenerationRef.current === generation
        && sessionKeyRef.current === sessionKey
        && inflightRef.current?.requestId === requestId
      );
      const inflight = {
        requestId,
        sessionKey,
        promise: Promise.resolve(),
      };
      inflightRef.current = inflight;
      const promise = (async () => {
        try {
          const result = await seriesDataFeed.requestBeforePage(series, {
            before,
            bars: loadMorePageSize,
            source: "history-before-page",
            signal: controller.signal,
            // Cursor progress + the hook-level inflight gate make successful
            // user-driven pagination safe to continue immediately after a
            // commit without falling into the feed's generic cooldown gap.
            cooldownMs: 0,
            pendingCooldownMs: PENDING_PAGE_COOLDOWN_MS,
          });
          if (!ownsRequest()) return;
          if (result.skipped) {
            if (result.reason === "history-exhausted") {
              pendingBeforePageRef.current = null;
              nextBeforeRef.current = null;
              setHasMoreLeft(false);
              setPaginationState({
                sessionKey,
                phase: "exhausted",
                requestedBefore: before,
                nextBefore: null,
              });
            } else if (pendingBeforePageRef.current) {
              const ownership = pendingBeforePageRef.current;
              setPaginationState({
                sessionKey,
                phase: "pending",
                requestedBefore: ownership.requestedBefore,
                nextBefore: ownership.requestedBefore,
              });
            } else {
              setPaginationState({
                sessionKey,
                phase: "idle",
                requestedBefore: before,
                nextBefore: nextBeforeRef.current,
              });
            }
            return;
          }
          if (result.stale || result.active === false) {
            pendingBeforePageRef.current = null;
            setPaginationState({
              sessionKey,
              phase: "idle",
              requestedBefore: before,
              nextBefore: nextBeforeRef.current,
            });
            return;
          }
          const older = result.data || [];

          if (older.length > 0) {
            if (!result.committed) {
              commitMergedChartData(symbol, interval, older, {
                source: "history-before-page",
                deferIndicatorWindow: Boolean(result.pending),
                ...(result.indicatorWindowOwner
                  ? { indicatorWindowOwner: result.indicatorWindowOwner }
                  : {}),
              });
            }
            void seriesDataFeed.repairVisibleGaps(series, older, null, {
              source: "before-page-gap-planner",
              maxScanBars: loadMorePageSize + 2,
            });
          }

          const progress = resolveBeforePageProgress({
            ...(result.has_more === undefined ? {} : { hasMore: result.has_more }),
            nextBeforeMs: result.next_before_ms,
            pending: Boolean(result.pending),
            requestedBefore: before,
            rows: older,
          });
          nextBeforeRef.current = progress.nextBefore;
          setHasMoreLeft(progress.hasMoreLeft);
          setPaginationState({
            sessionKey,
            phase: progress.phase,
            requestedBefore: before,
            nextBefore: progress.nextBefore,
          });

          if (result.pending && progress.hasMoreLeft) {
            console.log(`[LoadMoreLeft] Partial page returned for ${interval}; repair remains pending`);
            const ownership = {
              requestedBefore: before,
              sessionGeneration: generation,
              sessionKey,
            };
            pendingBeforePageRef.current = ownership;
          } else {
            pendingBeforePageRef.current = null;
          }
        } catch (err) {
          if (!ownsRequest()) return;
          pendingBeforePageRef.current = null;
          const indicatorWindowOwner = seriesDataFeed.getPendingBeforePage(series)
            ?.indicatorWindowOwner;
          commitMergedChartData(symbol, interval, [], {
            source: "history-before-page-terminal",
            deferIndicatorWindow: false,
            ...(indicatorWindowOwner ? { indicatorWindowOwner } : {}),
          });
          console.error("Load older data failed:", err);
          setPaginationState({
            sessionKey,
            phase: "idle",
            requestedBefore: before,
            nextBefore: nextBeforeRef.current,
          });
        } finally {
          if (ownsRequest()) {
            inflightRef.current = null;
            if (abortRef.current === controller) abortRef.current = null;
            setLoadingMoreLeft(false);
          }
        }
      })();
      inflight.promise = promise;
      return promise;
    },
    [
      commitMergedChartData,
      dataSource,
      enabled,
      exchange,
      interval,
      loadMorePageSize,
      loading,
      marketType,
      oldestChartTime,
      seriesDataFeed,
      sessionKey,
      setHasMoreLeft,
      setLoadingMoreLeft,
      symbol,
    ],
  );
  const handleNeedMoreLeft = useCallback<LoadMoreLeft>(
    (oldestLoadedTime) => requestPage(oldestLoadedTime),
    [requestPage],
  );
  const hasActivePaginationOwnership = useCallback(() => {
    const feedPending = seriesDataFeed.getPendingBeforePage({
      exchange,
      marketType,
      symbol,
      interval,
    });
    const ownership = pendingBeforePageRef.current;
    if (ownership && feedPending?.before !== ownership.requestedBefore) {
      pendingBeforePageRef.current = null;
      nextBeforeRef.current = null;
    }
    return loadingMoreLeftRef.current || inflightRef.current != null || feedPending != null;
  }, [exchange, interval, marketType, seriesDataFeed, symbol]);

  return {
    loadingMoreLeft,
    setLoadingMoreLeft,
    hasMoreLeft,
    setHasMoreLeft,
    handleNeedMoreLeft,
    hasActivePaginationOwnership,
    paginationState,
    resetPagination,
  };
}
