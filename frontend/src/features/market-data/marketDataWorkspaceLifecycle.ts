export interface MarketDataWorkspaceFinalizableResources {
  indicatorStreamCoordinator: { closeAll(): void } | null;
  requestCoordinator: { closeAll(): void } | null;
  streamCoordinator: { closeAll(): void };
  workScheduler: { dispose(): void } | null;
}

type EnqueueMicrotask = (callback: () => void) => void;

export function finalizeMarketDataWorkspaceResources(
  resources: MarketDataWorkspaceFinalizableResources,
): void {
  resources.streamCoordinator.closeAll();
  resources.requestCoordinator?.closeAll();
  resources.indicatorStreamCoordinator?.closeAll();
  resources.workScheduler?.dispose();
}

/**
 * Protect state-owned, terminal resources from React development StrictMode's
 * setup -> cleanup -> setup effect replay. A cleanup becomes final only after
 * one microtask without the same resource object being mounted again.
 *
 * Pending finalization is keyed by resource identity so replacing a provider
 * still closes the obsolete generation even if a new generation mounts in the
 * same turn.
 */
export class MarketDataWorkspaceEffectGuard {
  private readonly pendingFinalizations = new Map<
    MarketDataWorkspaceFinalizableResources,
    symbol
  >();

  constructor(
    private readonly enqueueMicrotask: EnqueueMicrotask = (callback) => {
      globalThis.queueMicrotask(callback);
    },
  ) {}

  mount(resources: MarketDataWorkspaceFinalizableResources): () => void {
    this.pendingFinalizations.delete(resources);
    let cleanedUp = false;

    return () => {
      if (cleanedUp) return;
      cleanedUp = true;
      const token = Symbol("market-data-workspace-finalize");
      this.pendingFinalizations.set(resources, token);
      this.enqueueMicrotask(() => {
        if (this.pendingFinalizations.get(resources) !== token) return;
        this.pendingFinalizations.delete(resources);
        finalizeMarketDataWorkspaceResources(resources);
      });
    };
  }
}
