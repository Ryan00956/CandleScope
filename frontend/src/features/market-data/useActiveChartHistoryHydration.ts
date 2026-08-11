import { useEffect } from "react";
import { markPerf, recordPerfEvent } from "../../runtime/performance/perfMarks.js";
import type { CommitChartData } from "./klineContracts.js";
import type { MarketSeries } from "./marketDataTypes.js";
import type { SeriesDataFeed } from "./feed/seriesDataFeed.js";
import type { ForegroundPreloadGate } from "./foregroundPreloadGate.js";
import { initialHistoryCacheProof } from "./useChartInitialLoad.js";

export const ACTIVE_HISTORY_HYDRATION_RETRY_BASE_MS = 750;
export const ACTIVE_HISTORY_HYDRATION_RETRY_MAX_MS = 5_000;
export const ACTIVE_HISTORY_HYDRATION_MAX_DURATION_MS = 30_000;
export const ACTIVE_HISTORY_HYDRATION_ROUND_RETRY_BASE_MS = 5_000;
export const ACTIVE_HISTORY_HYDRATION_ROUND_RETRY_MAX_MS = 30_000;
const HYDRATION_GATE_RECHECK_MS = 250;

export type ActiveHistoryHydrationOutcome =
  | "blocked"
  | "complete"
  | "pending"
  | "preempted";

export type HydrationSleep = (delayMs: number, signal: AbortSignal) => Promise<boolean>;

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, Math.max(0, delayMs));
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function activeHistoryHydrationRetryDelayMs(attempt: number): number {
  return Math.min(
    ACTIVE_HISTORY_HYDRATION_RETRY_MAX_MS,
    ACTIVE_HISTORY_HYDRATION_RETRY_BASE_MS * (2 ** Math.max(0, attempt)),
  );
}

export function activeHistoryHydrationContinuationDelayMs(
  outcome: ActiveHistoryHydrationOutcome,
  pendingRound: number,
): number | null {
  if (outcome === "complete") return null;
  if (outcome === "blocked" || outcome === "preempted") {
    return HYDRATION_GATE_RECHECK_MS;
  }
  return Math.min(
    ACTIVE_HISTORY_HYDRATION_ROUND_RETRY_MAX_MS,
    ACTIVE_HISTORY_HYDRATION_ROUND_RETRY_BASE_MS * (2 ** Math.max(0, pendingRound)),
  );
}

export interface RunActiveHistoryHydrationOptions {
  series: MarketSeries;
  sessionKey: string;
  targetCountBack: number;
  seriesDataFeed: SeriesDataFeed;
  priorityGate: ForegroundPreloadGate;
  commitMergedChartData: CommitChartData;
  isCancelled?: () => boolean;
  signal?: AbortSignal;
  maxDurationMs?: number;
  now?: () => number;
  sleep?: HydrationSleep;
}

/**
 * Fill the active chart cache after the viewport contract has settled.
 *
 * The hydration lease outranks ordinary speculative preload but remains fully
 * preemptible by foreground work. Pending probes keep the same lease, so one
 * session cannot repeatedly evict watchlist/chart preload while polling.
 */
export async function runActiveHistoryHydration({
  series,
  sessionKey,
  targetCountBack,
  seriesDataFeed,
  priorityGate,
  commitMergedChartData,
  isCancelled = () => false,
  signal,
  maxDurationMs = ACTIVE_HISTORY_HYDRATION_MAX_DURATION_MS,
  now = Date.now,
  sleep = abortableSleep,
}: RunActiveHistoryHydrationOptions): Promise<ActiveHistoryHydrationOutcome> {
  if (targetCountBack <= 0 || isCancelled() || signal?.aborted) return "preempted";
  const lease = priorityGate.tryAcquireHydration(`active-history-hydration:${sessionKey}`);
  if (!lease) return "blocked";
  const abortLease = () => lease.controller.abort();
  signal?.addEventListener("abort", abortLease, { once: true });

  const epoch = seriesDataFeed.currentEpoch(series);
  const startedAt = now();
  let attempt = 0;
  try {
    while (now() - startedAt < maxDurationMs) {
      if (
        isCancelled()
        || signal?.aborted
        || !priorityGate.isCurrent(lease)
        || !seriesDataFeed.isCurrent(series, epoch)
        || !seriesDataFeed.shouldCommitActive(series)
      ) return "preempted";

      try {
        const result = await seriesDataFeed.getBars(series, {
          countBack: targetCountBack,
          maxWaitMs: 0,
          intent: "active_hydration",
          source: "active-history-hydration",
          // Probe against backend storage without publishing partial ranges to
          // the active SeriesWindowStore. The complete proof below owns the
          // one atomic prepend and keeps chart rows, indicators, and metadata
          // on the same revision.
          commit: "none",
          priority: "hydrate",
          signal: lease.controller.signal,
        });
        if (
          isCancelled()
          || signal?.aborted
          || !priorityGate.isCurrent(lease)
          || !seriesDataFeed.isCurrent(series, epoch)
          || !seriesDataFeed.shouldCommitActive(series)
          || result.stale
          || result.active === false
        ) return "preempted";

        const proof = initialHistoryCacheProof(result, targetCountBack);
        recordPerfEvent("chart.activeHistoryHydration.probe", {
          attempt,
          bars: result.data?.length || 0,
          complete: proof.historyComplete === true,
          exchange: series.exchange,
          marketType: series.marketType,
          symbol: series.symbol,
          interval: series.interval,
        });
        if (proof.historyComplete) {
          commitMergedChartData(series.symbol, series.interval, result.data || [], {
            source: "active-history-hydration",
            deferIndicatorWindow: false,
            ...proof,
          });
          markPerf("chart.activeHistoryHydration.complete", {
            bars: result.data?.length || 0,
            countBack: targetCountBack,
            exchange: series.exchange,
            marketType: series.marketType,
            symbol: series.symbol,
            interval: series.interval,
          });
          return "complete";
        }
      } catch (error) {
        if (lease.controller.signal.aborted || isCancelled() || signal?.aborted) return "preempted";
        console.warn("Active chart history hydration probe failed; retrying", error);
      }

      const remainingMs = maxDurationMs - (now() - startedAt);
      if (remainingMs <= 0) break;
      const delayMs = Math.min(activeHistoryHydrationRetryDelayMs(attempt), remainingMs);
      attempt += 1;
      if (!await sleep(delayMs, lease.controller.signal)) return "preempted";
    }
    return "pending";
  } finally {
    signal?.removeEventListener("abort", abortLease);
    priorityGate.release(lease);
  }
}

export interface UseActiveChartHistoryHydrationOptions {
  enabled: boolean;
  series: MarketSeries;
  sessionKey: string;
  viewportCountBack: number;
  targetCountBack: number;
  historyComplete: boolean;
  historyRepairPending: boolean;
  validatedCountBack: number | null;
  seriesDataFeed: SeriesDataFeed;
  priorityGate: ForegroundPreloadGate;
  commitMergedChartData: CommitChartData;
}

export function shouldStartActiveHistoryHydration({
  enabled,
  historyComplete,
  historyRepairPending,
  targetCountBack,
  validatedCountBack,
  viewportCountBack,
}: Pick<
  UseActiveChartHistoryHydrationOptions,
  | "enabled"
  | "historyComplete"
  | "historyRepairPending"
  | "targetCountBack"
  | "validatedCountBack"
  | "viewportCountBack"
>): boolean {
  const validated = Number(validatedCountBack);
  return enabled
    && historyComplete
    && !historyRepairPending
    && targetCountBack > 0
    && viewportCountBack > 0
    && Number.isSafeInteger(validated)
    && validated >= viewportCountBack
    && validated < targetCountBack;
}

export function useActiveChartHistoryHydration({
  enabled,
  series,
  sessionKey,
  viewportCountBack,
  targetCountBack,
  historyComplete,
  historyRepairPending,
  validatedCountBack,
  seriesDataFeed,
  priorityGate,
  commitMergedChartData,
}: UseActiveChartHistoryHydrationOptions): void {
  const { exchange, marketType, symbol, interval } = series;
  useEffect(() => {
    if (!shouldStartActiveHistoryHydration({
      enabled,
      historyComplete,
      historyRepairPending,
      targetCountBack,
      validatedCountBack,
      viewportCountBack,
    })) return undefined;

    let cancelled = false;
    const controller = new AbortController();
    let running = false;
    let pendingRound = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (delayMs: number) => {
      if (cancelled || running) return;
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void hydrate();
      }, Math.max(0, delayMs));
    };
    const hydrate = async () => {
      if (cancelled || running) return;
      running = true;
      const outcome = await runActiveHistoryHydration({
        series: { exchange, marketType, symbol, interval },
        sessionKey,
        targetCountBack,
        seriesDataFeed,
        priorityGate,
        commitMergedChartData,
        isCancelled: () => cancelled,
        signal: controller.signal,
      });
      running = false;
      if (cancelled) return;
      const continuationDelayMs = activeHistoryHydrationContinuationDelayMs(
        outcome,
        pendingRound,
      );
      if (outcome === "pending") pendingRound += 1;
      if (continuationDelayMs != null) schedule(continuationDelayMs);
    };
    const unsubscribe = priorityGate.subscribe(() => schedule(0));
    schedule(0);

    return () => {
      cancelled = true;
      controller.abort();
      if (timer != null) clearTimeout(timer);
      unsubscribe();
      priorityGate.cancelQueued(`active-history-hydration:${sessionKey}`);
    };
  }, [
    commitMergedChartData,
    enabled,
    exchange,
    historyComplete,
    historyRepairPending,
    interval,
    marketType,
    priorityGate,
    seriesDataFeed,
    sessionKey,
    symbol,
    targetCountBack,
    validatedCountBack,
    viewportCountBack,
  ]);
}
