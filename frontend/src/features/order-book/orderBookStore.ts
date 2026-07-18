import type {
  OrderBookBook,
  OrderBookConnectionStatus,
  OrderBookExternalStore,
  OrderBookStoreSnapshot,
} from "./orderBookTypes.js";

export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

function defaultFrameScheduler(): FrameScheduler {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return {
      request: (callback) => window.requestAnimationFrame(callback),
      cancel: (handle) => window.cancelAnimationFrame(handle),
    };
  }
  return {
    request: (callback) => globalThis.setTimeout(callback, 16) as unknown as number,
    cancel: (handle) => globalThis.clearTimeout(handle),
  };
}

function initialSnapshot(
  status: OrderBookConnectionStatus = "idle",
  message: string | null = null,
): OrderBookStoreSnapshot {
  return Object.freeze({ status, book: null, message, error: null, version: 0 });
}

export function createOrderBookStore(
  scheduler: FrameScheduler = defaultFrameScheduler(),
): OrderBookExternalStore {
  const listeners = new Set<() => void>();
  let current = initialSnapshot();
  let pendingBook: OrderBookBook | null = null;
  let frameHandle: number | null = null;
  let destroyed = false;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const commit = (next: Omit<OrderBookStoreSnapshot, "version">) => {
    if (destroyed) return;
    current = Object.freeze({ ...next, version: current.version + 1 });
    notify();
  };

  const cancelPending = () => {
    pendingBook = null;
    if (frameHandle !== null) scheduler.cancel(frameHandle);
    frameHandle = null;
  };

  const flush = () => {
    frameHandle = null;
    const book = pendingBook;
    pendingBook = null;
    if (!book || destroyed) return;
    if (
      current.book?.topic === book.topic
      && current.book.revision >= book.revision
    ) return;
    commit({ status: "live", book, message: null, error: null });
  };

  return {
    getSnapshot: () => current,
    getServerSnapshot: () => current,
    subscribe: (listener) => {
      if (destroyed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publishBook: (book) => {
      if (destroyed) return;
      const latest = pendingBook?.topic === book.topic ? pendingBook : current.book;
      if (latest?.topic === book.topic && latest.revision >= book.revision) return;
      pendingBook = book;
      if (frameHandle === null) frameHandle = scheduler.request(flush);
    },
    publishStatus: (status, options = {}) => {
      cancelPending();
      const clearBook = options.clearBook ?? status !== "idle";
      commit({
        status,
        book: clearBook ? null : current.book,
        message: options.message ?? null,
        error: options.error ?? null,
      });
    },
    reset: (status = "idle", message = null) => {
      cancelPending();
      commit({ status, book: null, message, error: null });
    },
    destroy: () => {
      cancelPending();
      destroyed = true;
      listeners.clear();
    },
  };
}
