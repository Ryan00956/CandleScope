import { useCallback, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { markPerf, recordPerfEvent } from "../../runtime/performance/perfMarks.js";
import type { IntervalString } from "../../utils/intervals.js";
import type { ExchangeId, MarketType, SymbolCode } from "../../utils/symbolKey.js";
import type { InitialRowsResolution } from "../watchlist-full-cache/watchlistFullCacheTypes.js";
import type { CommitChartData, FeedResult, PendingInitialSeries } from "./klineContracts.js";
import type { KlineBar, TimeRangeSec } from "./marketDataTypes.js";
import { numericRange } from "./rangeRuntime.js";
import {
  isKlineResultRepairPending,
  type SeriesDataFeed,
} from "./feed/seriesDataFeed.js";
import {
  initialRepairRetryMode,
  reconcileInitialRepairRetry,
} from "./feed/initialRepairRetryPolicy.js";

const INITIAL_BACKFILL_RETRY_MS = 3_000;
const INITIAL_BACKFILL_TIMEOUT_MS = 10_000;
const INITIAL_BACKFILL_MAX_WAIT_MS = 60_000;
const INITIAL_HISTORY_COUNT_BACK = 1_500;
const OPTIMISTIC_SWITCH_EMPTY_TIMEOUT_MS = 3_000;

type ResolveInitialRows = (
  symbol: SymbolCode,
  interval: IntervalString,
  marketType: MarketType,
  exchange: ExchangeId,
) => InitialRowsResolution | null | undefined;

type ReplaceChartData = (
  symbol: SymbolCode,
  interval: IntervalString,
  rows: KlineBar[],
  meta?: { cache?: boolean; source?: string },
) => void;

export type LoadChartData = (
  symbol: SymbolCode,
  interval: IntervalString,
  marketType?: MarketType,
  exchange?: ExchangeId,
) => Promise<void>;

export interface UseChartInitialLoadOptions {
  exchange: ExchangeId;
  marketType: MarketType;
  getFromCache(symbol: SymbolCode, interval: IntervalString): KlineBar[];
  resolveInitialRows?: ResolveInitialRows | null;
  seriesDataFeed: SeriesDataFeed;
  replaceChartData: ReplaceChartData;
  clearChartData(source?: string, symbol?: SymbolCode, interval?: IntervalString): void;
  markChartDataTransition(symbol: SymbolCode, interval: IntervalString, reason: string): void;
  commitMergedChartData: CommitChartData;
  commitPatchedChartData: CommitChartData;
  pendingInitialHistoryRef: MutableRefObject<PendingInitialSeries | null>;
  updateLastPrice(candidate: KlineBar, interval: IntervalString): void;
  setConnectionStatus: Dispatch<SetStateAction<string>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<unknown | null>>;
  setLoadingMoreLeft: Dispatch<SetStateAction<boolean>>;
  setHasMoreLeft: Dispatch<SetStateAction<boolean>>;
  setCrosshairData(value: null): void;
  setDataSource: Dispatch<SetStateAction<string | null>>;
}

export function useChartInitialLoad({
  exchange,
  marketType,
  getFromCache,
  resolveInitialRows,
  seriesDataFeed,
  replaceChartData,
  clearChartData,
  markChartDataTransition,
  commitMergedChartData,
  commitPatchedChartData,
  pendingInitialHistoryRef,
  updateLastPrice,
  setConnectionStatus,
  setLoading,
  setError,
  setLoadingMoreLeft,
  setHasMoreLeft,
  setCrosshairData,
  setDataSource,
}: UseChartInitialLoadOptions): LoadChartData {
  const abortRef = useRef<AbortController | null>(null);

  return useCallback(async (
    sym: SymbolCode,
    intv: IntervalString,
    mt: MarketType = marketType,
    ex: ExchangeId = exchange,
  ) => {
    markPerf("chart.initialLoad.start", { exchange: ex, marketType: mt, symbol: sym, interval: intv });
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const initialRows = resolveInitialRows?.(sym, intv, mt, ex) || {
      rows: getFromCache(sym, intv),
      tier: undefined,
      source: "memory-cache-hit",
      needsRepair: false,
    };
    const cached = initialRows.rows;
    const hasCacheHit = cached && cached.length > 0;
    let shownInitialData = false;
    let fallbackClearTimer: ReturnType<typeof setTimeout> | null = null;
    let initialRetryStarted = false;
    let stopInitialHistoryRetry: (() => void) | null = null;
    let trackedInitialRepairRange: TimeRangeSec | null = null;
    const markInitialDataShown = () => {
      shownInitialData = true;
      if (fallbackClearTimer) {
        clearTimeout(fallbackClearTimer);
        fallbackClearTimer = null;
      }
    };

    if (hasCacheHit) {
      replaceChartData(sym, intv, cached, {
        cache: initialRows.tier === "watchlist-full",
        source: initialRows.source || "memory-cache-hit",
      });
      const cachedLatest = cached.at(-1);
      if (cachedLatest) updateLastPrice(cachedLatest, intv);
      setConnectionStatus(initialRows.needsRepair ? "loading" : "connected");
      setDataSource(initialRows.source || "memory-cache-hit");
      setLoading(false);
      setError(null);
      markInitialDataShown();
    } else {
      markChartDataTransition(sym, intv, "load-start-optimistic");
      setLoading(true);
      setError(null);
      setConnectionStatus("loading");
      fallbackClearTimer = setTimeout(() => {
        if (controller.signal.aborted || shownInitialData) return;
        clearChartData("load-start-timeout-clear", sym, intv);
      }, OPTIMISTIC_SWITCH_EMPTY_TIMEOUT_MS);
    }

    setLoadingMoreLeft(false);
    setHasMoreLeft(true);
    setCrosshairData(null);
    pendingInitialHistoryRef.current = null;

    const series = { exchange: ex, marketType: mt, symbol: sym, interval: intv };
    const initialEpoch = seriesDataFeed.beginEpoch(series);
    controller.signal.addEventListener("abort", () => {
      seriesDataFeed.cancelSeriesRepairs(series);
      trackedInitialRepairRange = null;
    }, { once: true });

    function commitQuickResult(quickResult: FeedResult | null | undefined): void {
      if (controller.signal.aborted || !quickResult?.data?.length) return;
      markPerf("chart.initialLoad.latest.commit", {
        source: quickResult.source || "unknown",
        bars: quickResult.data.length,
      });
      if (!quickResult.committed) {
        commitPatchedChartData(sym, intv, quickResult.data, {
          seedIfEmpty: true,
          source: "initial-latest",
        });
      }
      const latestTick = quickResult.data[quickResult.data.length - 1];
      if (latestTick) updateLastPrice(latestTick, intv);
      setDataSource(quickResult.source || "unknown");

      if (!shownInitialData) {
        setLoading(false);
        markInitialDataShown();
      }
    }

    function commitHistoryResult(historyResult: FeedResult | null | undefined): void {
      if (controller.signal.aborted) return;
      const repairPending = isKlineResultRepairPending(historyResult);
      let terminalFailed = false;

      recordPerfEvent("chart.initialLoad.history.result", {
        source: historyResult?.source || "unknown",
        bars: historyResult?.data?.length || 0,
        hasTailGap: Boolean(historyResult?.has_tail_gap),
      });

      if (repairPending && historyResult) {
        const pendingInitial = {
          exchange: ex,
          marketType: mt,
          symbol: sym,
          interval: intv,
          range: historyResult.start_ms != null && historyResult.end_ms != null
            ? numericRange(historyResult.start_ms, historyResult.end_ms)
            : null,
        };
        pendingInitialHistoryRef.current = pendingInitial;
        const previousTrackedRange = trackedInitialRepairRange;
        const finalizePending = () => {
          if (
            controller.signal.aborted
            || !seriesDataFeed.isCurrent(series, initialEpoch)
            || !seriesDataFeed.shouldCommitActive(series)
            || pendingInitialHistoryRef.current !== pendingInitial
          ) return;
          pendingInitialHistoryRef.current = null;
          trackedInitialRepairRange = null;
          stopInitialHistoryRetry?.();
          const repairedRows = getFromCache(sym, intv);
          const latest = repairedRows.at(-1);
          if (latest) updateLastPrice(latest, intv);
          setError(null);
          setConnectionStatus("connected");
          setLoading(false);
        };
        const failPending = (reason: string) => {
          if (
            controller.signal.aborted
            || !seriesDataFeed.isCurrent(series, initialEpoch)
            || !seriesDataFeed.shouldCommitActive(series)
            || pendingInitialHistoryRef.current !== pendingInitial
          ) return;
          terminalFailed = true;
          if (trackedInitialRepairRange) {
            seriesDataFeed.clearPendingResultRepair(series, trackedInitialRepairRange);
          }
          pendingInitialHistoryRef.current = null;
          trackedInitialRepairRange = null;
          stopInitialHistoryRetry?.();
          setError(new Error(`K-line history repair stopped: ${reason}`));
          setConnectionStatus("disconnected");
          setLoading(false);
        };
        let trackedRange = seriesDataFeed.trackPendingResultRepair(
          series,
          historyResult,
          finalizePending,
          failPending,
        );
        if (terminalFailed) {
          seriesDataFeed.clearPendingResultRepair(series, trackedRange);
          trackedRange = null;
        } else if (
          previousTrackedRange
          && (
            !trackedRange
            || previousTrackedRange.start !== trackedRange.start
            || previousTrackedRange.end !== trackedRange.end
          )
        ) {
          seriesDataFeed.clearPendingResultRepair(series, previousTrackedRange);
          trackedRange = seriesDataFeed.trackPendingResultRepair(
            series,
            historyResult,
            finalizePending,
            failPending,
          );
        }
        trackedInitialRepairRange = trackedRange;
      } else if (!repairPending) {
        pendingInitialHistoryRef.current = null;
        seriesDataFeed.clearPendingResultRepair(series, trackedInitialRepairRange);
        trackedInitialRepairRange = null;
      }

      const retryMode = initialRepairRetryMode({
        repairPending,
        exactRangeTracked: trackedInitialRepairRange != null,
        terminal: terminalFailed,
      });
      reconcileInitialRepairRetry(retryMode, {
        startBroadRetry: startInitialHistoryRetry,
        stopBroadRetry: () => stopInitialHistoryRetry?.(),
      });

      if (!historyResult?.data?.length) {
        recordPerfEvent("chart.initialLoad.history.empty", {
          exchange: ex,
          marketType: mt,
          symbol: sym,
          interval: intv,
        });
        if (!repairPending) {
          if (historyResult?.history_state === "exhausted") setHasMoreLeft(false);
          setConnectionStatus("connected");
          setLoading(false);
        }
        return;
      }

      markPerf("chart.initialLoad.history.commit", {
        source: historyResult.source || "unknown",
        bars: historyResult.data.length,
      });
      if (!historyResult.committed) {
        commitMergedChartData(sym, intv, historyResult.data, { source: "initial-history" });
      }
      const latest = historyResult.data[historyResult.data.length - 1];
      if (latest) updateLastPrice(latest, intv);
      setError(null);
      setDataSource(historyResult.source || "unknown");
      setConnectionStatus(
        historyResult.source === "mock" || repairPending ? "loading" : "connected",
      );

      if (!shownInitialData) {
        markInitialDataShown();
      }
      setLoading(false);
      void seriesDataFeed.repairVisibleGaps(series, historyResult.data, null, {
        source: "initial-held-gap-planner",
      });
    }

    function startInitialHistoryRetry(): void {
      if (initialRetryStarted) return;
      initialRetryStarted = true;
      markPerf("chart.initialLoad.retry.start", { exchange: ex, marketType: mt, symbol: sym, interval: intv });
      setConnectionStatus("loading");

      let retryTimer: ReturnType<typeof setTimeout> | null = null;
      let safetyTimer: ReturnType<typeof setTimeout> | null = null;
      let stoppedRetrying = false;
      let abortListener: (() => void) | null = null;
      const retryStartedAt = Date.now();
      const stopRetrying = () => {
        if (stoppedRetrying) return;
        stoppedRetrying = true;
        if (retryTimer) clearTimeout(retryTimer);
        if (safetyTimer) clearTimeout(safetyTimer);
        if (abortListener) {
          controller.signal.removeEventListener("abort", abortListener);
          abortListener = null;
        }
        if (stopInitialHistoryRetry === stopRetrying) {
          stopInitialHistoryRetry = null;
          initialRetryStarted = false;
        }
      };
      stopInitialHistoryRetry = stopRetrying;

      const retryInitialHistory = async () => {
        if (controller.signal.aborted || stoppedRetrying) return false;
        try {
          const retryResult = await seriesDataFeed.getBars(series, {
            countBack: INITIAL_HISTORY_COUNT_BACK,
            source: "initial-history-retry",
            signal: controller.signal,
          });
          if (controller.signal.aborted || stoppedRetrying) return false;
          if (retryResult) {
            markPerf("chart.initialLoad.retry.success", {
              source: retryResult.source || "unknown",
              bars: retryResult.data?.length || 0,
            });
            commitHistoryResult(retryResult);
            return !isKlineResultRepairPending(retryResult);
          }
        } catch (retryErr) {
          console.warn("Initial history retry failed:", retryErr);
        }
        return false;
      };

      const scheduleRetry = () => {
        if (controller.signal.aborted || stoppedRetrying) return;
        retryTimer = setTimeout(async () => {
          retryTimer = null;
          const loaded = await retryInitialHistory();
          if (loaded) {
            stopRetrying();
            return;
          }
          if (Date.now() - retryStartedAt < INITIAL_BACKFILL_MAX_WAIT_MS) {
            scheduleRetry();
          } else {
            stopRetrying();
          }
        }, INITIAL_BACKFILL_RETRY_MS);
      };

      scheduleRetry();

      safetyTimer = setTimeout(async () => {
        if (controller.signal.aborted) return;
        if (await retryInitialHistory()) return;
        if (!shownInitialData) {
          markPerf("chart.initialLoad.retry.timeout", { exchange: ex, marketType: mt, symbol: sym, interval: intv });
          setError(new Error(`K-line history unavailable for ${sym}@${intv}`));
          setConnectionStatus("disconnected");
          setLoading(false);
        }
      }, INITIAL_BACKFILL_TIMEOUT_MS);

      abortListener = () => {
        stopRetrying();
        if (fallbackClearTimer) clearTimeout(fallbackClearTimer);
      };
      controller.signal.addEventListener("abort", abortListener, { once: true });
    }

    markPerf("chart.initialLoad.latest.request", { exchange: ex, marketType: mt, symbol: sym, interval: intv, limit: 5 });
    markPerf("chart.initialLoad.history.request", {
      exchange: ex,
      marketType: mt,
      symbol: sym,
      interval: intv,
      countBack: INITIAL_HISTORY_COUNT_BACK,
    });

    await Promise.all([
      seriesDataFeed.getLatest(series, {
        limit: 5,
        source: "initial-latest",
        signal: controller.signal,
        commit: "patch-active",
      })
        .then((result) => {
          markPerf("chart.initialLoad.latest.response", {
            source: result?.source || "unknown",
            bars: result?.data?.length || 0,
          });
          commitQuickResult(result);
        })
        .catch(() => null),
      seriesDataFeed.getBars(series, {
        countBack: INITIAL_HISTORY_COUNT_BACK,
        source: "initial-history",
        signal: controller.signal,
      })
        .then((result) => {
          markPerf("chart.initialLoad.history.response", {
            source: result?.source || "unknown",
            bars: result?.data?.length || 0,
          });
          commitHistoryResult(result);
        })
        .catch(() => {
          if (!controller.signal.aborted) startInitialHistoryRetry();
        }),
    ]);

    if (shownInitialData) {
      setLoading(false);
    }
    if (shownInitialData && fallbackClearTimer) clearTimeout(fallbackClearTimer);
  }, [
    clearChartData,
    commitMergedChartData,
    commitPatchedChartData,
    exchange,
    getFromCache,
    markChartDataTransition,
    marketType,
    pendingInitialHistoryRef,
    replaceChartData,
    resolveInitialRows,
    seriesDataFeed,
    setConnectionStatus,
    setCrosshairData,
    setDataSource,
    setError,
    setHasMoreLeft,
    setLoading,
    setLoadingMoreLeft,
    updateLastPrice,
  ]);
}
