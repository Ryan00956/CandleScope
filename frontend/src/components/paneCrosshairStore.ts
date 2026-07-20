export interface PaneCrosshairFrameScheduler {
  request(callback: () => void): number;
  cancel(frameId: number): void;
}

export interface PaneCrosshairStore {
  getSnapshot(): number | null;
  publish(time: number | null | undefined): void;
  clear(): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface PaneCrosshairStoreLifecycle {
  /** Stable facade consumed by render-time subscribers and chart callbacks. */
  readonly store: PaneCrosshairStore;
  /**
   * Own one effect activation. Every activation creates a fresh underlying
   * store; the returned cleanup only disposes that activation's generation.
   */
  activate(): () => void;
}

function browserFrameScheduler(): PaneCrosshairFrameScheduler | null {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return null;
  return {
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (frameId) => window.cancelAnimationFrame(frameId),
  };
}

function normalizeTime(time: number | null | undefined): number | null {
  return typeof time === "number" && Number.isFinite(time) ? time : null;
}

export function createPaneCrosshairStore(
  scheduler: PaneCrosshairFrameScheduler | null = browserFrameScheduler(),
): PaneCrosshairStore {
  let snapshot: number | null = null;
  let pendingSnapshot: number | null = null;
  let frameId: number | null = null;
  let disposed = false;
  const listeners = new Set<() => void>();

  const flush = () => {
    frameId = null;
    if (disposed || snapshot === pendingSnapshot) return;
    snapshot = pendingSnapshot;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => snapshot,
    publish: (time) => {
      if (disposed) return;
      const next = normalizeTime(time);
      if (pendingSnapshot === next) return;
      pendingSnapshot = next;
      if (listeners.size === 0 || !scheduler) {
        flush();
        return;
      }
      if (frameId === null) frameId = scheduler.request(flush);
    },
    clear: () => {
      if (disposed) return;
      if (frameId !== null && scheduler) scheduler.cancel(frameId);
      frameId = null;
      pendingSnapshot = null;
      if (snapshot === null) return;
      snapshot = null;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (frameId !== null && scheduler) scheduler.cancel(frameId);
      frameId = null;
      listeners.clear();
    },
  };
}

/**
 * Bridges a render-stable external-store identity to effect-owned store
 * generations. React StrictMode replays effect cleanup/setup without
 * recreating memoized render state, so an effect must never dispose the same
 * terminal PaneCrosshairStore instance that its replay will reuse.
 */
export function createPaneCrosshairStoreLifecycle(
  createStore: () => PaneCrosshairStore = () => createPaneCrosshairStore(),
): PaneCrosshairStoreLifecycle {
  interface StoreGeneration {
    readonly store: PaneCrosshairStore;
    released: boolean;
  }

  let activeGeneration: StoreGeneration | null = null;
  let unsubscribeActiveStore: (() => void) | null = null;
  let disposed = false;
  const listeners = new Set<() => void>();

  const publishSnapshot = () => {
    for (const listener of listeners) listener();
  };

  const disconnectActiveStore = () => {
    unsubscribeActiveStore?.();
    unsubscribeActiveStore = null;
  };

  const connectActiveStore = () => {
    if (!activeGeneration || unsubscribeActiveStore || listeners.size === 0) return;
    unsubscribeActiveStore = activeGeneration.store.subscribe(publishSnapshot);
  };

  const release = (generation: StoreGeneration) => {
    if (generation.released) return;
    generation.released = true;
    if (activeGeneration === generation) {
      disconnectActiveStore();
      activeGeneration = null;
    }
    generation.store.dispose();
  };

  const store: PaneCrosshairStore = {
    getSnapshot: () => activeGeneration?.store.getSnapshot() ?? null,
    publish: (time) => activeGeneration?.store.publish(time),
    clear: () => activeGeneration?.store.clear(),
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      connectActiveStore();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) disconnectActiveStore();
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const generation = activeGeneration;
      if (generation) release(generation);
      listeners.clear();
    },
  };

  return {
    store,
    activate: () => {
      if (disposed) return () => undefined;
      const previousGeneration = activeGeneration;
      if (previousGeneration) release(previousGeneration);

      const generation: StoreGeneration = {
        store: createStore(),
        released: false,
      };
      activeGeneration = generation;
      connectActiveStore();

      return () => release(generation);
    },
  };
}
