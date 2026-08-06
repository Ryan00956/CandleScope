import { useEffect, useRef } from "react";
import { symbolKey } from "../../utils/symbolKey.js";
import { getFullCacheEntry } from "../watchlist-full-cache/watchlistFullCacheStore.js";
import type { FullCacheStatus } from "../watchlist-full-cache/watchlistFullCacheTypes.js";
import type { UseChartBackgroundPrefetchOptions } from "./marketDataTypes.js";
import {
  canonicalizeIntervalValue,
  intervalsSemanticallyEquivalent,
} from "../../utils/intervals.js";
import { planTargetBarRequest, type TargetBarRequestPlan } from "./intervalRequestBudget.js";
import {
  FOREGROUND_PRELOAD_QUIET_DWELL_MS,
  ForegroundPreloadGate,
  type PreloadLease,
} from "./foregroundPreloadGate.js";

export const PREFETCH_IDLE_GRACE_MS = FOREGROUND_PRELOAD_QUIET_DWELL_MS;
export const PREFETCH_INTERVAL_GAP_MS = 5_000;
export const PREFETCH_FAILURE_RETRY_BASE_MS = 5_000;
export const PREFETCH_FAILURE_MAX_ATTEMPTS = 3;
const PREFETCH_BUSY_RECHECK_MS = 1_000;
const PREFETCH_BAR_LIMIT = 500;
export const PREFETCH_SOURCE_ROW_BUDGET = 10_000;

export type BackgroundPrefetchLease = PreloadLease;

/**
 * Synchronous arbitration between speculative warming and user-visible chart
 * work. React state will still disable the hook, but foreground callbacks use
 * this gate first so an active prefetch is aborted before their request starts.
 */
export class ChartBackgroundPrefetchPriorityGate extends ForegroundPreloadGate {
  tryAcquire(now = Date.now()): BackgroundPrefetchLease | null {
    return this.tryAcquirePreload(now);
  }
}

export interface BackgroundPrefetchSkipInput {
  activeInterval: string;
  fullCacheRows?: number;
  fullCacheStatus?: FullCacheStatus | null;
  hasMemoryCache: boolean;
  inFlight: boolean;
  interval: string;
  nativeIntervals?: readonly string[];
  sourceRowBudget?: number;
  targetBarLimit?: number;
}

export interface ChartForegroundWorkState {
  activePagination?: boolean;
  indicatorRequests?: number;
  loading?: boolean;
  loadingMoreLeft?: boolean;
  pendingInitial?: boolean;
  pendingRepairs?: number;
  restoringLatestWindow?: boolean;
}

export function hasChartForegroundWork({
  activePagination = false,
  indicatorRequests = 0,
  loading = false,
  loadingMoreLeft = false,
  pendingInitial = false,
  pendingRepairs = 0,
  restoringLatestWindow = false,
}: ChartForegroundWorkState = {}): boolean {
  return loading
    || loadingMoreLeft
    || restoringLatestWindow
    || pendingInitial
    || activePagination
    || pendingRepairs > 0
    || indicatorRequests > 0;
}

export function estimateBackgroundPrefetchSourceRows(
  interval: string,
  nativeIntervals: readonly string[],
  targetBarLimit = PREFETCH_BAR_LIMIT,
): number | null {
  return planBackgroundPrefetchRequest(
    interval,
    nativeIntervals,
    targetBarLimit,
  )?.estimatedSourceRows ?? null;
}

export function planBackgroundPrefetchRequest(
  interval: string,
  nativeIntervals: readonly string[],
  targetBarLimit = PREFETCH_BAR_LIMIT,
  sourceRowBudget = PREFETCH_SOURCE_ROW_BUDGET,
): TargetBarRequestPlan | null {
  return planTargetBarRequest({
    desiredTargetBars: targetBarLimit,
    interval,
    nativeIntervals,
    sourceRowBudget,
  });
}

export class ChartBackgroundPrefetchAttemptLedger {
  private scopeKey = "";
  private scopeGeneration = 0;
  private readonly attemptedIntervals = new Map<string, BackgroundPrefetchAttemptClaim>();
  private readonly failureCounts = new Map<string, number>();

  enterScope(scopeKey: string): void {
    if (scopeKey === this.scopeKey) return;
    this.scopeKey = scopeKey;
    this.scopeGeneration += 1;
    this.attemptedIntervals.clear();
    this.failureCounts.clear();
  }

  claimInterval(interval: string): BackgroundPrefetchAttemptClaim | null {
    const intervalKey = canonicalizeIntervalValue(interval) || interval.trim();
    if (!intervalKey || this.attemptedIntervals.has(intervalKey)) return null;
    const claim: BackgroundPrefetchAttemptClaim = {
      intervalKey,
      scopeGeneration: this.scopeGeneration,
      scopeKey: this.scopeKey,
    };
    this.attemptedIntervals.set(intervalKey, claim);
    return claim;
  }

  releaseInterval(claim: BackgroundPrefetchAttemptClaim): boolean {
    if (!this.ownsClaim(claim)) return false;
    this.attemptedIntervals.delete(claim.intervalKey);
    return true;
  }

  completeInterval(claim: BackgroundPrefetchAttemptClaim): boolean {
    if (!this.ownsClaim(claim)) return false;
    this.failureCounts.delete(claim.intervalKey);
    return true;
  }

  retryAfterFailure(claim: BackgroundPrefetchAttemptClaim): number | null {
    if (!this.ownsClaim(claim)) return null;
    const failureCount = (this.failureCounts.get(claim.intervalKey) || 0) + 1;
    this.failureCounts.set(claim.intervalKey, failureCount);
    if (failureCount >= PREFETCH_FAILURE_MAX_ATTEMPTS) return null;
    this.attemptedIntervals.delete(claim.intervalKey);
    return PREFETCH_FAILURE_RETRY_BASE_MS * (2 ** (failureCount - 1));
  }

  private ownsClaim(claim: BackgroundPrefetchAttemptClaim): boolean {
    return claim.scopeKey === this.scopeKey
      && claim.scopeGeneration === this.scopeGeneration
      && this.attemptedIntervals.get(claim.intervalKey) === claim;
  }
}

export interface BackgroundPrefetchAttemptClaim {
  readonly intervalKey: string;
  readonly scopeGeneration: number;
  readonly scopeKey: string;
}

export function shouldSkipChartBackgroundPrefetch({
  activeInterval,
  fullCacheRows = 0,
  fullCacheStatus = null,
  hasMemoryCache,
  inFlight,
  interval,
  nativeIntervals = [],
  sourceRowBudget = PREFETCH_SOURCE_ROW_BUDGET,
  targetBarLimit = PREFETCH_BAR_LIMIT,
}: BackgroundPrefetchSkipInput): boolean {
  if (intervalsSemanticallyEquivalent(interval, activeInterval) || hasMemoryCache || inFlight) return true;
  if (fullCacheStatus === "loading") return true;
  if (fullCacheRows > 0 && (fullCacheStatus === "warm" || fullCacheStatus === "live")) return true;
  if (nativeIntervals.length > 0) {
    const plan = planBackgroundPrefetchRequest(
      interval,
      nativeIntervals,
      targetBarLimit,
      sourceRowBudget,
    );
    if (plan == null || plan.targetBars <= 0) return true;
  }
  return false;
}

export function useChartBackgroundPrefetch({
  symbol,
  exchange,
  marketType,
  activeInterval,
  trackedIntervals,
  nativeIntervals,
  hasCache,
  seriesDataFeed,
  enabled,
  priorityGate,
  isForegroundBusy,
}: UseChartBackgroundPrefetchOptions & {
  priorityGate?: ForegroundPreloadGate;
  isForegroundBusy?: () => boolean;
}): void {
  const inFlightRef = useRef(new Set<string>());
  const attemptLedgerRef = useRef(new ChartBackgroundPrefetchAttemptLedger());
  const defaultPriorityGateRef = useRef<ChartBackgroundPrefetchPriorityGate | null>(null);
  if (defaultPriorityGateRef.current == null) {
    defaultPriorityGateRef.current = new ChartBackgroundPrefetchPriorityGate();
  }
  const prefetchPriority = priorityGate || defaultPriorityGateRef.current;

  useEffect(() => {
    if (!enabled) {
      prefetchPriority.yieldToForeground();
      return undefined;
    }
    // Becoming eligible marks the end of foreground ownership, not the start
    // of an immediate speculative window. Require a complete quiet grace from
    // this transition before touching another interval, without aborting an
    // already-admitted active-chart hydration request.
    prefetchPriority.requireQuietDwell();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const currentSymbolKey = symbolKey(symbol, marketType, exchange);
    attemptLedgerRef.current.enterScope(currentSymbolKey);

    const schedule = (delayMs: number) => {
      if (cancelled) return;
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void prefetchOne();
      }, Math.max(0, delayMs));
    };

    const prefetchOne = async () => {
      if (cancelled) return;
      if (isForegroundBusy?.()) {
        prefetchPriority.yieldToForeground();
        schedule(PREFETCH_BUSY_RECHECK_MS);
        return;
      }
      const priorityWaitMs = prefetchPriority.waitMs();
      if (priorityWaitMs > 0) {
        schedule(Number.isFinite(priorityWaitMs) ? priorityWaitMs : PREFETCH_BUSY_RECHECK_MS);
        return;
      }

      for (const intv of trackedIntervals) {
        if (cancelled) return;
        const canonicalInterval = canonicalizeIntervalValue(intv) || intv;
        const key = `${currentSymbolKey}\u0000${canonicalInterval}`;
        const fullCacheEntry = getFullCacheEntry(currentSymbolKey, canonicalInterval);
        if (shouldSkipChartBackgroundPrefetch({
          activeInterval,
          fullCacheRows: fullCacheEntry?.rows.length || 0,
          fullCacheStatus: fullCacheEntry?.status || null,
          hasMemoryCache: hasCache(symbol, canonicalInterval, { marketType, exchange }),
          inFlight: inFlightRef.current.has(key),
          interval: canonicalInterval,
          nativeIntervals,
        })) continue;
        const attemptClaim = attemptLedgerRef.current.claimInterval(canonicalInterval);
        if (!attemptClaim) continue;
        const lease = prefetchPriority.tryAcquirePreload("chart-background-prefetch");
        if (!lease) {
          attemptLedgerRef.current.releaseInterval(attemptClaim);
          const waitMs = prefetchPriority.waitMs();
          schedule(Number.isFinite(waitMs)
            ? Math.max(PREFETCH_BUSY_RECHECK_MS, waitMs)
            : PREFETCH_BUSY_RECHECK_MS);
          return;
        }
        const prefetchPlan = planBackgroundPrefetchRequest(
          canonicalInterval,
          nativeIntervals,
        );
        const targetBarLimit = prefetchPlan?.targetBars ?? PREFETCH_BAR_LIMIT;

        inFlightRef.current.add(key);
        let nextDelayMs = PREFETCH_INTERVAL_GAP_MS;
        try {
          await seriesDataFeed.getLatest(
            { exchange, marketType, symbol, interval: canonicalInterval },
            {
              limit: targetBarLimit,
              source: "background-prefetch",
              apiSource: "background-prefetch",
              commit: "cache",
              priority: "preload",
              signal: lease.controller.signal,
            },
          );
          if (!prefetchPriority.isCurrent(lease)) {
            attemptLedgerRef.current.releaseInterval(attemptClaim);
          } else {
            attemptLedgerRef.current.completeInterval(attemptClaim);
          }
        } catch {
          // Best-effort warming only; active interval loading owns user-visible errors.
          if (lease.controller.signal.aborted) {
            // Foreground work preempted this attempt before it could warm the
            // cache. Let a future genuinely idle window retry it.
            attemptLedgerRef.current.releaseInterval(attemptClaim);
          } else {
            const retryDelayMs = attemptLedgerRef.current.retryAfterFailure(attemptClaim);
            if (retryDelayMs != null) nextDelayMs = Math.max(nextDelayMs, retryDelayMs);
          }
        } finally {
          inFlightRef.current.delete(key);
          prefetchPriority.release(lease);
        }
        if (!cancelled) schedule(nextDelayMs);
        return;
      }
    };

    const initialWaitMs = prefetchPriority.waitMs();
    schedule(Number.isFinite(initialWaitMs)
      ? Math.max(PREFETCH_BUSY_RECHECK_MS, initialWaitMs)
      : PREFETCH_BUSY_RECHECK_MS);
    return () => {
      cancelled = true;
      if (timer != null) clearTimeout(timer);
      prefetchPriority.yieldToForeground();
    };
  }, [
    activeInterval,
    enabled,
    exchange,
    hasCache,
    isForegroundBusy,
    marketType,
    nativeIntervals,
    prefetchPriority,
    seriesDataFeed,
    symbol,
    trackedIntervals,
  ]);
}
