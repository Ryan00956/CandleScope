import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { markPerf, recordPerfEvent } from "../../runtime/performance/perfMarks.js";
import {
  intervalsSemanticallyEquivalent,
  type IntervalString,
} from "../../utils/intervals.js";
import type { ExchangeId, MarketType, SymbolCode } from "../../utils/symbolKey.js";
import type { InitialRowsResolution } from "../watchlist-full-cache/watchlistFullCacheTypes.js";
import type {
  CommitChartData,
  FeedCommitMeta,
  FeedResult,
  KlineFetchResult,
  PendingInitialSeries,
} from "./klineContracts.js";
import type {
  CachedChartDataActivation,
  KlineBar,
  TimeRangeSec,
} from "./marketDataTypes.js";
import { numericRange } from "./rangeRuntime.js";
import {
  isKlineResultRepairPending,
  type SeriesDataFeed,
} from "./feed/seriesDataFeed.js";
import {
  initialRepairRetryMode,
  reconcileInitialRepairRetry,
} from "./feed/initialRepairRetryPolicy.js";
import { planTargetBarRequest } from "./intervalRequestBudget.js";
import type { KlineSeriesIdentityInput } from "./klineSeriesIdentity.js";

const INITIAL_BACKFILL_RETRY_MS = 3_000;
const INITIAL_BACKFILL_TIMEOUT_MS = 10_000;
const INITIAL_BACKFILL_MAX_WAIT_MS = 60_000;
export const INITIAL_HISTORY_COUNT_BACK = 1_500;
export const INITIAL_VIEWPORT_COUNT_BACK = 500;
// A 4x4 Cell is only about 300 CSS px wide at the release viewport. 128 bars
// preserves enough context for the shipped MA/RSI/SMA fixtures, then the
// focused Cell uses the existing serialized hydration lane to reach 1,500.
// At the 1,920 px release viewport a 4x4 plot is about 320 CSS pixels wide.
// Sixty-four bars cover it at roughly 5 px/bar; the active cell still hydrates
// to the normal 1,500-bar history after first paint.
export const DENSE_WORKSPACE_VIEWPORT_COUNT_BACK = 64;
export const DENSE_WORKSPACE_CELL_THRESHOLD = 8;

export function shouldEnableWorkspaceIntervalPrefetch(cellCount: number): boolean {
  return Math.max(0, Math.floor(Number(cellCount) || 0)) < DENSE_WORKSPACE_CELL_THRESHOLD;
}
/**
 * The first viewport request is a non-blocking storage probe. A populated
 * page can paint immediately without occupying one of the browser's limited
 * HTTP/1.1 connection slots while a tail repair runs. Empty/pending results
 * enter the existing bounded retry path below, where the long-poll budget is
 * useful for cold backfill.
 */
export const INITIAL_VIEWPORT_PROBE_WAIT_MS = 0;
export const INITIAL_VIEWPORT_MAX_WAIT_MS = 1_500;
export const INITIAL_HISTORY_SOURCE_ROW_BUDGET = 20_000;
export const WARM_CACHE_REVALIDATE_TTL_MS = 60_000;

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

type ActivateCachedChartData = (
  symbol: SymbolCode,
  interval: IntervalString,
  meta?: { source?: string },
) => CachedChartDataActivation | null;

export function canUseWarmCacheWithoutImmediateRevalidation(
  activation: Pick<
    CachedChartDataActivation,
    | "coverage"
    | "historyComplete"
    | "historyRepairPending"
    | "historyValidatedCountBack"
    | "lastTailUpdatedMs"
    | "lastValidatedMs"
    | "rightTruncated"
    | "rows"
  > | null | undefined,
  requiredCountBack: number,
  nowMs = Date.now(),
): boolean {
  if (!activation || !Array.isArray(activation.rows) || activation.rows.length === 0) return false;
  if (!activation.historyComplete || activation.historyRepairPending) return false;
  if (activation.rightTruncated || (activation.coverage?.gaps?.length || 0) > 0) return false;
  const validatedCountBack = Number(activation.historyValidatedCountBack);
  const targetCountBack = Number(requiredCountBack);
  if (
    !Number.isSafeInteger(validatedCountBack)
    || !Number.isSafeInteger(targetCountBack)
    || targetCountBack <= 0
    || validatedCountBack < targetCountBack
  ) return false;
  const lastValidatedMs = activation.lastValidatedMs == null
    ? Number.NEGATIVE_INFINITY
    : Number(activation.lastValidatedMs);
  const lastTailUpdatedMs = activation.lastTailUpdatedMs == null
    ? Number.NEGATIVE_INFINITY
    : Number(activation.lastTailUpdatedMs);
  const freshnessMs = Math.max(
    Number.isFinite(lastValidatedMs) ? lastValidatedMs : Number.NEGATIVE_INFINITY,
    Number.isFinite(lastTailUpdatedMs) ? lastTailUpdatedMs : Number.NEGATIVE_INFINITY,
  );
  const currentMs = Number(nowMs);
  if (!Number.isFinite(freshnessMs) || !Number.isFinite(currentMs)) return false;
  const ageMs = currentMs - freshnessMs;
  return ageMs >= 0 && ageMs <= WARM_CACHE_REVALIDATE_TTL_MS;
}

export function initialHistoryCacheProof(
  result: KlineFetchResult | null | undefined,
  validatedCountBack: number,
): Pick<
  FeedCommitMeta,
  "historyComplete" | "historyRepairPending" | "historyValidatedCountBack"
> {
  const explicitlyComplete = Boolean(
    result
    && result.complete === true
    && result.retryable === false
    && (result.history_state === "ready" || result.history_state === "exhausted")
    && result.verified_contiguous === true
    && result.all_rows_final === true
    && result.has_tail_gap === false
    && result.truncated !== true
    && Array.isArray(result.missing_ranges)
    && result.missing_ranges.length === 0
    && !isKlineResultRepairPending(result)
  );
  return {
    historyComplete: explicitlyComplete,
    historyRepairPending: !explicitlyComplete && isKlineResultRepairPending(result),
    historyValidatedCountBack: explicitlyComplete
      ? Math.max(0, Math.floor(Number(validatedCountBack) || 0))
      : null,
  };
}

export function canFinalizePendingInitialHistory(
  pendingInitial: PendingInitialSeries,
  result: KlineFetchResult | null | undefined,
): boolean {
  const pendingRange = pendingInitial.range;
  const resultRange = numericRange(result?.start_ms, result?.end_ms);
  if (
    !pendingRange
    || !resultRange
    || resultRange.start > pendingRange.start
    || resultRange.end < pendingRange.end
  ) return false;
  return initialHistoryCacheProof(
    result,
    Number(pendingInitial.countBack) || 0,
  ).historyComplete === true;
}

export type LoadChartData = (
  symbol: SymbolCode,
  interval: IntervalString,
  marketType?: MarketType,
  exchange?: ExchangeId,
) => Promise<void>;

export interface UseChartInitialLoadOptions {
  enabled: boolean;
  exchange: ExchangeId;
  marketType: MarketType;
  seriesIdentity?: KlineSeriesIdentityInput;
  nativeIntervalValues: readonly IntervalString[];
  initialViewportCountBackCap?: number;
  getFromCache(symbol: SymbolCode, interval: IntervalString): KlineBar[];
  resolveInitialRows?: ResolveInitialRows | null;
  seriesDataFeed: SeriesDataFeed;
  activateCachedChartData: ActivateCachedChartData;
  detachActiveChartData(symbol: SymbolCode, interval: IntervalString, source?: string): void;
  replaceChartData: ReplaceChartData;
  markChartDataTransition(symbol: SymbolCode, interval: IntervalString, reason: string): void;
  commitMergedChartData: CommitChartData;
  commitPatchedChartData: CommitChartData;
  pendingInitialHistoryRef: MutableRefObject<PendingInitialSeries | null>;
  setInitialHistoryPending: Dispatch<SetStateAction<boolean>>;
  updateLastPrice(candidate: KlineBar, interval: IntervalString): void;
  setConnectionStatus: Dispatch<SetStateAction<string>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<unknown | null>>;
  setLoadingMoreLeft: Dispatch<SetStateAction<boolean>>;
  setHasMoreLeft: Dispatch<SetStateAction<boolean>>;
  setCrosshairData(value: null): void;
  setDataSource: Dispatch<SetStateAction<string | null>>;
}

export function shouldRequestInitialLatest(
  interval: IntervalString,
  nativeIntervalValues: readonly IntervalString[],
): boolean {
  return nativeIntervalValues.some((nativeInterval) => (
    intervalsSemanticallyEquivalent(interval, nativeInterval)
  ));
}

export interface InitialLoadReadiness {
  initialPaintReady: boolean;
  tailFresh: boolean;
}

/**
 * Decide whether the bounded native-interval tail request is still useful
 * after the non-blocking history probe. Rendering old storage rows and proving
 * that the right edge is current are separate readiness states: a renderable
 * page must not suppress the tail fast path while its repair is pending.
 */
export function shouldRequestInitialLatestForReadiness(
  interval: IntervalString,
  nativeIntervalValues: readonly IntervalString[],
  readiness: InitialLoadReadiness,
): boolean {
  return shouldRequestInitialLatest(interval, nativeIntervalValues)
    && !readiness.tailFresh;
}

export function isInitialHistoryTailFresh(
  result: KlineFetchResult | null | undefined,
): boolean {
  return Boolean(result?.has_tail_gap === false && !isKlineResultRepairPending(result));
}

export function canCommitInitialFeedResult({
  aborted = false,
  active = false,
  currentEpoch = -1,
  expectedEpoch = -1,
  resultActive = true,
  stale = false,
}: {
  aborted?: boolean;
  active?: boolean;
  currentEpoch?: number;
  expectedEpoch?: number;
  resultActive?: boolean;
  stale?: boolean;
} = {}): boolean {
  return !aborted
    && active
    && resultActive !== false
    && !stale
    && currentEpoch === expectedEpoch;
}

export function planInitialHistoryCountBack(
  interval: IntervalString,
  nativeIntervalValues: readonly IntervalString[],
): number {
  return planTargetBarRequest({
    desiredTargetBars: INITIAL_HISTORY_COUNT_BACK,
    interval,
    nativeIntervals: nativeIntervalValues,
    sourceRowBudget: INITIAL_HISTORY_SOURCE_ROW_BUDGET,
  })?.targetBars ?? INITIAL_HISTORY_COUNT_BACK;
}

export function planInitialViewportCountBack(
  interval: IntervalString,
  nativeIntervalValues: readonly IntervalString[],
): number {
  return Math.min(
    INITIAL_VIEWPORT_COUNT_BACK,
    planInitialHistoryCountBack(interval, nativeIntervalValues),
  );
}

export function initialViewportCountBackCapForCellCount(
  visibleCellCount: number,
): number | undefined {
  return Number.isFinite(visibleCellCount)
    && Math.floor(visibleCellCount) >= DENSE_WORKSPACE_CELL_THRESHOLD
    ? DENSE_WORKSPACE_VIEWPORT_COUNT_BACK
    : undefined;
}

/**
 * Release the indicator-window owner created by the original initial-history
 * request. Exact gap polling intentionally owns a separate token, so settling
 * the child repair does not by itself release this parent lifecycle.
 *
 * The caller must first prove that the pending initial request still belongs
 * to the active session. An empty commit is enough: the chart window buffer
 * publishes the staged union and flips `indicatorWindowDeferred` to false
 * without replacing the partially rendered K-lines.
 */
export function releasePendingInitialIndicatorWindow(
  commitMergedChartData: CommitChartData,
  pendingInitial: PendingInitialSeries,
  source: string,
  settledResult?: KlineFetchResult | null,
): boolean {
  const owner = String(pendingInitial.indicatorWindowOwner || "").trim();
  const settledProof = source === "initial-history-settled"
    && canFinalizePendingInitialHistory(pendingInitial, settledResult)
    ? initialHistoryCacheProof(settledResult, Number(pendingInitial.countBack) || 0)
    : null;
  const historyProof = source === "initial-history-settled"
    ? settledProof?.historyComplete === true
      ? settledProof
      : {
          // All tracked children may be gone while their combined quality
          // proof is still incomplete. Release rendering ownership, but do not
          // promote one child (or an unproven aggregate) to the full countBack.
          historyComplete: false,
          historyRepairPending: false,
          historyValidatedCountBack: null,
        }
    : source === "initial-history-terminal"
      ? {
          historyComplete: false,
          historyRepairPending: false,
          historyValidatedCountBack: null,
        }
      : {};
  if (!owner && Object.keys(historyProof).length === 0) return false;
  commitMergedChartData(
    pendingInitial.symbol,
    pendingInitial.interval,
    [],
    {
      source,
      deferIndicatorWindow: false,
      ...(owner ? { indicatorWindowOwner: owner } : {}),
      ...historyProof,
    },
  );
  return Boolean(owner);
}

export function useChartInitialLoad({
  enabled,
  exchange,
  marketType,
  seriesIdentity,
  nativeIntervalValues,
  initialViewportCountBackCap,
  getFromCache,
  resolveInitialRows,
  seriesDataFeed,
  activateCachedChartData,
  detachActiveChartData,
  replaceChartData,
  markChartDataTransition,
  commitMergedChartData,
  commitPatchedChartData,
  pendingInitialHistoryRef,
  setInitialHistoryPending,
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

  useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort();
      abortRef.current = null;
      return undefined;
    }
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [enabled]);

  return useCallback(async (
    sym: SymbolCode,
    intv: IntervalString,
    mt: MarketType = marketType,
    ex: ExchangeId = exchange,
  ) => {
    if (!enabled) return;
    markPerf("chart.initialLoad.start", { exchange: ex, marketType: mt, symbol: sym, interval: intv });
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setInitialHistoryPending(true);

    const initialRows = resolveInitialRows?.(sym, intv, mt, ex) || {
      rows: getFromCache(sym, intv),
      tier: undefined,
      source: "memory-cache-hit",
      needsRepair: false,
    };
    const cached = initialRows.rows;
    const hasCacheHit = cached && cached.length > 0;
    let initialPaintReady = false;
    let tailFresh = false;
    let initialRetryStarted = false;
    let stopInitialHistoryRetry: (() => void) | null = null;
    let trackedInitialRepairRange: TimeRangeSec | null = null;
    let ownedPendingInitial: PendingInitialSeries | null = null;
    let warmActivation: CachedChartDataActivation | null = null;
    const markInitialDataShown = () => {
      initialPaintReady = true;
    };

    if (hasCacheHit) {
      warmActivation = initialRows.tier === "market-data-memory"
        ? activateCachedChartData(sym, intv, {
            source: initialRows.source || "memory-cache-hit",
          })
        : null;
      const displayedRows = warmActivation?.rows || cached;
      if (!warmActivation) {
        replaceChartData(sym, intv, displayedRows, {
          cache: initialRows.tier === "watchlist-full",
          source: initialRows.source || "memory-cache-hit",
        });
      }
      const cachedLatest = displayedRows.at(-1);
      if (cachedLatest) updateLastPrice(cachedLatest, intv);
      setConnectionStatus(initialRows.needsRepair ? "loading" : "connected");
      setDataSource(initialRows.source || "memory-cache-hit");
      setLoading(false);
      setError(null);
      markInitialDataShown();
    } else {
      markChartDataTransition(sym, intv, "load-start-optimistic");
      detachActiveChartData(sym, intv, "load-start-cold-detach");
      setLoading(true);
      setError(null);
      setConnectionStatus("loading");
    }

    setLoadingMoreLeft(false);
    setHasMoreLeft(true);
    setCrosshairData(null);
    pendingInitialHistoryRef.current = null;

    const series = {
      exchange: ex,
      marketType: mt,
      symbol: sym,
      interval: intv,
      ...(ex === exchange && mt === marketType ? seriesIdentity : {}),
    };
    const initialHistoryCountBack = planInitialHistoryCountBack(intv, nativeIntervalValues);
    const plannedViewportCountBack = planInitialViewportCountBack(intv, nativeIntervalValues);
    const initialViewportCountBack = initialViewportCountBackCap == null
      ? plannedViewportCountBack
      : Math.min(
          plannedViewportCountBack,
          Math.max(1, Math.floor(initialViewportCountBackCap)),
        );
    const initialEpoch = seriesDataFeed.beginEpoch(series);
    controller.signal.addEventListener("abort", () => {
      seriesDataFeed.cancelSeriesRepairs(series);
      trackedInitialRepairRange = null;
      setInitialHistoryPending(false);
    }, { once: true });
    if (canUseWarmCacheWithoutImmediateRevalidation(
      warmActivation,
      initialHistoryCountBack,
    )) {
      markPerf("chart.initialLoad.warmActivation", {
        exchange: ex,
        marketType: mt,
        symbol: sym,
        interval: intv,
        bars: warmActivation?.rows.length || 0,
        revision: warmActivation?.revision ?? null,
      });
      setInitialHistoryPending(false);
      return;
    }
    if (initialViewportCountBack <= 0) {
      setInitialHistoryPending(false);
      setHasMoreLeft(false);
      setLoading(false);
      if (!hasCacheHit) {
        setConnectionStatus("disconnected");
        setError(new Error(`K-line interval ${intv} exceeds the safe source-history budget`));
      }
      return;
    }

    function ownsInitialResult(result: FeedResult | null | undefined): boolean {
      return canCommitInitialFeedResult({
        aborted: controller.signal.aborted,
        active: seriesDataFeed.shouldCommitActive(series),
        currentEpoch: seriesDataFeed.currentEpoch(series),
        expectedEpoch: initialEpoch,
        resultActive: result?.active !== false,
        stale: result?.stale === true,
      });
    }

    function relinquishInitialOwnership(): void {
      if (controller.signal.aborted) return;
      stopInitialHistoryRetry?.();
      seriesDataFeed.clearPendingResultRepair(series, trackedInitialRepairRange);
      trackedInitialRepairRange = null;
      if (
        ownedPendingInitial
        && pendingInitialHistoryRef.current === ownedPendingInitial
      ) {
        pendingInitialHistoryRef.current = null;
      }
      ownedPendingInitial = null;
      setInitialHistoryPending(false);
    }

    function commitQuickResult(quickResult: FeedResult | null | undefined): void {
      if (!ownsInitialResult(quickResult)) {
        relinquishInitialOwnership();
        return;
      }
      if (!quickResult?.data?.length) return;
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
      // /latest may legally return stale storage while a bounded repair is in
      // flight. Only the explicit history-quality contract can prove freshness.
      tailFresh = isInitialHistoryTailFresh(quickResult);

      if (!initialPaintReady) {
        setLoading(false);
        markInitialDataShown();
      }
    }

    function commitHistoryResult(historyResult: FeedResult | null | undefined): boolean {
      if (!ownsInitialResult(historyResult)) {
        relinquishInitialOwnership();
        return false;
      }
      const repairPending = isKlineResultRepairPending(historyResult);
      tailFresh = isInitialHistoryTailFresh(historyResult);
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
          countBack: initialViewportCountBack,
          ...(historyResult.indicatorWindowOwner
            ? { indicatorWindowOwner: historyResult.indicatorWindowOwner }
            : {}),
          range: historyResult.start_ms != null && historyResult.end_ms != null
            ? numericRange(historyResult.start_ms, historyResult.end_ms)
            : null,
        };
        ownedPendingInitial = pendingInitial;
        pendingInitialHistoryRef.current = pendingInitial;
        const previousTrackedRange = trackedInitialRepairRange;
        const finalizePending = (settledResult: KlineFetchResult) => {
          if (
            controller.signal.aborted
            || !seriesDataFeed.isCurrent(series, initialEpoch)
            || !seriesDataFeed.shouldCommitActive(series)
            || pendingInitialHistoryRef.current !== pendingInitial
          ) return;
          if (!canFinalizePendingInitialHistory(pendingInitial, settledResult)) {
            // A defensive fallback for any non-cap resolution path that emits
            // a usable-but-unproven range. Keep the initial lifecycle pending
            // and restore viewport-countBack retry ownership.
            trackedInitialRepairRange = null;
            setConnectionStatus("loading");
            startInitialHistoryRetry();
            return;
          }
          pendingInitialHistoryRef.current = null;
          ownedPendingInitial = null;
          setInitialHistoryPending(false);
          trackedInitialRepairRange = null;
          stopInitialHistoryRetry?.();
          releasePendingInitialIndicatorWindow(
            commitMergedChartData,
            pendingInitial,
            "initial-history-settled",
            settledResult,
          );
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
          ownedPendingInitial = null;
          setInitialHistoryPending(false);
          trackedInitialRepairRange = null;
          stopInitialHistoryRetry?.();
          releasePendingInitialIndicatorWindow(
            commitMergedChartData,
            pendingInitial,
            "initial-history-terminal",
          );
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
        ownedPendingInitial = null;
        setInitialHistoryPending(false);
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

      const historyProof = initialHistoryCacheProof(
        historyResult,
        initialViewportCountBack,
      );
      const historyCommitMeta: FeedCommitMeta = {
        source: "initial-history",
        deferIndicatorWindow: repairPending && !terminalFailed,
        ...(historyResult?.indicatorWindowOwner
          ? { indicatorWindowOwner: historyResult.indicatorWindowOwner }
          : {}),
        ...historyProof,
      };

      if (!historyResult?.data?.length) {
        if (historyResult) {
          commitMergedChartData(sym, intv, [], historyCommitMeta);
        }
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
        return true;
      }

      markPerf("chart.initialLoad.history.commit", {
        source: historyResult.source || "unknown",
        bars: historyResult.data.length,
      });
      if (!historyResult.committed) {
        commitMergedChartData(sym, intv, historyResult.data, historyCommitMeta);
      } else {
        // SeriesDataFeed already applied the rows. Persist the initial-history
        // proof without mutating the store or forcing a second chart dataset.
        commitMergedChartData(sym, intv, [], historyCommitMeta);
      }
      const latest = historyResult.data[historyResult.data.length - 1];
      if (latest) updateLastPrice(latest, intv);
      setError(null);
      setDataSource(historyResult.source || "unknown");
      setConnectionStatus(
        historyResult.source === "mock" || repairPending ? "loading" : "connected",
      );

      if (!initialPaintReady) {
        markInitialDataShown();
      }
      setLoading(false);
      void seriesDataFeed.repairVisibleGaps(series, historyResult.data, null, {
        source: "initial-held-gap-planner",
      });
      return true;
    }

    function startInitialHistoryRetry(): void {
      if (initialRetryStarted) return;
      if (!ownsInitialResult(undefined)) {
        relinquishInitialOwnership();
        return;
      }
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
            countBack: initialViewportCountBack,
            maxWaitMs: INITIAL_VIEWPORT_MAX_WAIT_MS,
            intent: "viewport",
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
            setInitialHistoryPending(false);
            stopRetrying();
          }
        }, INITIAL_BACKFILL_RETRY_MS);
      };

      scheduleRetry();

      safetyTimer = setTimeout(async () => {
        if (controller.signal.aborted) return;
        if (await retryInitialHistory()) return;
        if (!initialPaintReady) {
          markPerf("chart.initialLoad.retry.timeout", { exchange: ex, marketType: mt, symbol: sym, interval: intv });
          setError(new Error(`K-line history unavailable for ${sym}@${intv}`));
          setConnectionStatus("disconnected");
          setLoading(false);
        }
      }, INITIAL_BACKFILL_TIMEOUT_MS);

      abortListener = () => {
        stopRetrying();
      };
      controller.signal.addEventListener("abort", abortListener, { once: true });
    }

    markPerf("chart.initialLoad.history.request", {
      exchange: ex,
      marketType: mt,
      symbol: sym,
      interval: intv,
      countBack: initialViewportCountBack,
    });

    try {
      const result = await seriesDataFeed.getBars(series, {
        countBack: initialViewportCountBack,
        maxWaitMs: INITIAL_VIEWPORT_PROBE_WAIT_MS,
        intent: "viewport",
        source: "initial-history",
        signal: controller.signal,
      });
      markPerf("chart.initialLoad.history.response", {
        source: result?.source || "unknown",
        bars: result?.data?.length || 0,
      });
      if (!commitHistoryResult(result)) return;
    } catch {
      if (!controller.signal.aborted) startInitialHistoryRetry();
    }
    if (!ownsInitialResult(undefined)) {
      relinquishInitialOwnership();
      return;
    }

    // A proven-fresh warm storage page avoids duplicate bootstrap traffic.
    // Renderable-but-stale rows are only initial-paint ready: keep them visible
    // while a bounded native tail request patches the current right edge.
    if (shouldRequestInitialLatestForReadiness(intv, nativeIntervalValues, {
      initialPaintReady,
      tailFresh,
    })) {
      markPerf("chart.initialLoad.latest.request", {
        exchange: ex,
        marketType: mt,
        symbol: sym,
        interval: intv,
        limit: 5,
      });
      await seriesDataFeed.getLatest(series, {
        limit: 5,
        source: "initial-latest",
        signal: controller.signal,
        commit: "patch-active",
        repair: "wait",
        waitMs: INITIAL_VIEWPORT_MAX_WAIT_MS,
      }).then((result) => {
        markPerf("chart.initialLoad.latest.response", {
          source: result?.source || "unknown",
          bars: result?.data?.length || 0,
        });
        commitQuickResult(result);
      }).catch(() => null);
    } else {
      markPerf("chart.initialLoad.latest.skipped", {
        exchange: ex,
        marketType: mt,
        symbol: sym,
        interval: intv,
        reason: tailFresh
          ? "viewport-history-tail-already-fresh"
          : "derived-interval-history-owns-tail",
      });
    }

    if (initialPaintReady) {
      setLoading(false);
    }
  }, [
    activateCachedChartData,
    commitMergedChartData,
    commitPatchedChartData,
    detachActiveChartData,
    enabled,
    exchange,
    getFromCache,
    markChartDataTransition,
    marketType,
    nativeIntervalValues,
    initialViewportCountBackCap,
    pendingInitialHistoryRef,
    replaceChartData,
    resolveInitialRows,
    seriesDataFeed,
    seriesIdentity,
    setConnectionStatus,
    setCrosshairData,
    setDataSource,
    setError,
    setHasMoreLeft,
    setInitialHistoryPending,
    setLoading,
    setLoadingMoreLeft,
    updateLastPrice,
  ]);
}
