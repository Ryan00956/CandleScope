import type { SubscriptionTier } from "./watchlistTypes.js";

export type WatchlistTierMap = Readonly<Record<string, SubscriptionTier>>;

export interface WatchlistTierMutation {
  readonly generation: number;
  readonly nextTier: SubscriptionTier;
  readonly previousTier: SubscriptionTier;
  readonly symbol: string;
}

export interface WatchlistTierRefresh {
  readonly generation: number;
  readonly pendingAtStart: ReadonlySet<string>;
  readonly revisionsAtStart: ReadonlyMap<string, number>;
}

export interface WatchlistTierResolution {
  readonly symbol: string;
  readonly tier: SubscriptionTier;
}

function hasOwnTier(tiers: WatchlistTierMap, symbol: string): boolean {
  return Object.prototype.hasOwnProperty.call(tiers, symbol);
}

function sameTierMap(left: WatchlistTierMap, right: WatchlistTierMap): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((symbol) => left[symbol] === right[symbol]);
}

/**
 * Coordinates optimistic per-symbol mutations with whole-list refreshes.
 *
 * Revisions survive mutation settlement so a refresh that started before a
 * mutation can never overwrite it with an older server snapshot. Pending-at-
 * start is tracked separately because that refresh may have observed the
 * server before the already-running mutation committed.
 */
export class WatchlistTierMutationCoordinator {
  private readonly revisions = new Map<string, number>();

  private readonly pending = new Map<string, WatchlistTierMutation>();

  private latestRefreshGeneration = 0;

  beginMutation(
    symbol: string,
    previousTier: SubscriptionTier,
    nextTier: SubscriptionTier,
  ): WatchlistTierMutation {
    const generation = (this.revisions.get(symbol) ?? 0) + 1;
    const mutation = { generation, nextTier, previousTier, symbol };
    this.revisions.set(symbol, generation);
    this.pending.set(symbol, mutation);
    return mutation;
  }

  resolveSuccess(
    mutation: WatchlistTierMutation,
    authoritativeTier: SubscriptionTier,
  ): WatchlistTierResolution | null {
    if (this.pending.get(mutation.symbol) !== mutation) return null;
    this.pending.delete(mutation.symbol);
    return { symbol: mutation.symbol, tier: authoritativeTier };
  }

  resolveFailure(mutation: WatchlistTierMutation): WatchlistTierResolution | null {
    if (this.pending.get(mutation.symbol) !== mutation) return null;
    this.pending.delete(mutation.symbol);
    return { symbol: mutation.symbol, tier: mutation.previousTier };
  }

  beginRefresh(): WatchlistTierRefresh {
    this.latestRefreshGeneration += 1;
    return {
      generation: this.latestRefreshGeneration,
      pendingAtStart: new Set(this.pending.keys()),
      revisionsAtStart: new Map(this.revisions),
    };
  }

  mergeRefresh(
    refresh: WatchlistTierRefresh,
    current: WatchlistTierMap,
    server: WatchlistTierMap,
  ): WatchlistTierMap {
    if (refresh.generation !== this.latestRefreshGeneration) return current;
    const symbols = new Set([...Object.keys(current), ...Object.keys(server)]);
    const next: Record<string, SubscriptionTier> = {};
    for (const symbol of symbols) {
      const changedAfterStart = (this.revisions.get(symbol) ?? 0)
        !== (refresh.revisionsAtStart.get(symbol) ?? 0);
      const protectedByMutation = changedAfterStart
        || refresh.pendingAtStart.has(symbol)
        || this.pending.has(symbol);
      if (protectedByMutation) {
        if (hasOwnTier(current, symbol)) next[symbol] = current[symbol] as SubscriptionTier;
      } else if (hasOwnTier(server, symbol)) {
        next[symbol] = server[symbol] as SubscriptionTier;
      }
    }
    return sameTierMap(current, next) ? current : next;
  }

  cancelPending(): void {
    this.pending.clear();
  }
}
