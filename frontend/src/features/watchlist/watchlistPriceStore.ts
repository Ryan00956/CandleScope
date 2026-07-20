export interface WatchlistPriceTick extends Record<string, unknown> {
  symbol: string;
  price?: number;
  open?: number;
  daily_change?: number;
  daily_change_pct?: number;
  change_pct?: number;
}

export type WatchlistPriceSnapshot = Readonly<Record<string, Readonly<WatchlistPriceTick>>>;

export interface WatchlistPriceStore {
  getSnapshot(): WatchlistPriceSnapshot;
  getSymbolSnapshot(symbol: string): Readonly<WatchlistPriceTick> | undefined;
  subscribe(listener: () => void): () => void;
  subscribeSymbol(symbol: string, listener: () => void): () => void;
}

export interface WatchlistPriceStoreController {
  store: WatchlistPriceStore;
  enqueue(ticks: readonly WatchlistPriceTick[]): void;
  cancelPending(): void;
  dispose(): void;
}

interface WatchlistPriceStoreScheduler {
  request(callback: () => void): unknown;
  cancel(handle: unknown): void;
}

const EMPTY_PRICE_SNAPSHOT: WatchlistPriceSnapshot = Object.freeze({});

function defaultScheduler(): WatchlistPriceStoreScheduler {
  if (typeof requestAnimationFrame === "function" && typeof cancelAnimationFrame === "function") {
    return {
      request: (callback) => requestAnimationFrame(callback),
      cancel: (handle) => cancelAnimationFrame(handle as number),
    };
  }
  return {
    request: (callback) => setTimeout(callback, 0),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function ticksEqual(
  left: Readonly<WatchlistPriceTick> | undefined,
  right: Readonly<WatchlistPriceTick>,
): boolean {
  if (left === right) return true;
  if (!left) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of rightKeys) {
    if (!Object.prototype.hasOwnProperty.call(left, key) || !Object.is(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

function immutableTick(tick: WatchlistPriceTick): Readonly<WatchlistPriceTick> {
  return Object.freeze({ ...tick });
}

/**
 * Latest-only watchlist price publication boundary.
 *
 * WebSocket packets may arrive more frequently than the browser can paint. The
 * controller keeps only the newest tick per symbol until the next animation
 * frame, publishes one immutable snapshot, and only wakes subscribers for
 * symbols whose tick actually changed.
 */
export function createWatchlistPriceStore(
  scheduler: WatchlistPriceStoreScheduler = defaultScheduler(),
): WatchlistPriceStoreController {
  let snapshot = EMPTY_PRICE_SNAPSHOT;
  let scheduledHandle: unknown | null = null;
  let disposed = false;
  const pending = new Map<string, WatchlistPriceTick>();
  const listeners = new Set<() => void>();
  const symbolListeners = new Map<string, Set<() => void>>();

  const flush = (): void => {
    scheduledHandle = null;
    if (disposed || pending.size === 0) return;

    const queued = [...pending.values()];
    pending.clear();
    let next: Record<string, Readonly<WatchlistPriceTick>> | null = null;
    const changedSymbols: string[] = [];

    for (const tick of queued) {
      const immutable = immutableTick(tick);
      if (ticksEqual(snapshot[tick.symbol], immutable)) continue;
      next ??= { ...snapshot };
      next[tick.symbol] = immutable;
      changedSymbols.push(tick.symbol);
    }

    if (!next) return;
    snapshot = Object.freeze(next);

    for (const listener of [...listeners]) listener();
    for (const symbol of changedSymbols) {
      const subscribers = symbolListeners.get(symbol);
      if (!subscribers) continue;
      for (const listener of [...subscribers]) listener();
    }
  };

  const store: WatchlistPriceStore = Object.freeze({
    getSnapshot: () => snapshot,
    getSymbolSnapshot: (symbol: string) => snapshot[symbol],
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeSymbol: (symbol: string, listener: () => void) => {
      let subscribers = symbolListeners.get(symbol);
      if (!subscribers) {
        subscribers = new Set();
        symbolListeners.set(symbol, subscribers);
      }
      subscribers.add(listener);
      return () => {
        subscribers?.delete(listener);
        if (subscribers?.size === 0) symbolListeners.delete(symbol);
      };
    },
  });

  const cancelPending = (): void => {
    if (scheduledHandle !== null) scheduler.cancel(scheduledHandle);
    scheduledHandle = null;
    pending.clear();
  };

  return {
    store,
    enqueue(ticks) {
      if (disposed) return;
      for (const tick of ticks) pending.set(tick.symbol, tick);
      if (pending.size === 0 || scheduledHandle !== null) return;
      scheduledHandle = scheduler.request(flush);
    },
    cancelPending,
    dispose() {
      disposed = true;
      cancelPending();
      listeners.clear();
      symbolListeners.clear();
    },
  };
}
