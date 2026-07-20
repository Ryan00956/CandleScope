export interface WatchlistPriceSocketSession<TSocket extends object> {
  activate(socket: TSocket): boolean;
  accepts(socket: TSocket): boolean;
  isStopped(): boolean;
  release(socket: TSocket): boolean;
  stop(): TSocket | null;
}

/**
 * Owns the one socket generation allowed to publish into a price store.
 * Effect cleanup permanently stops its session, so a late frame from a
 * StrictMode-replayed or reconnected socket cannot leak into the next setup's
 * shared external store.
 */
export function createWatchlistPriceSocketSession<TSocket extends object>():
WatchlistPriceSocketSession<TSocket> {
  let active: TSocket | null = null;
  let stopped = false;

  return {
    activate(socket) {
      if (stopped || active !== null) return false;
      active = socket;
      return true;
    },
    accepts(socket) {
      return !stopped && active === socket;
    },
    isStopped() {
      return stopped;
    },
    release(socket) {
      if (active !== socket) return false;
      active = null;
      return true;
    },
    stop() {
      if (stopped) return null;
      stopped = true;
      const socket = active;
      active = null;
      return socket;
    },
  };
}
