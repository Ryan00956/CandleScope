import type { MarketChartSourceRuntime } from "./marketChartSourceRuntime.js";

type EnqueueMicrotask = (callback: () => void) => void;

/**
 * Makes terminal source disposal compatible with React development StrictMode's
 * setup -> cleanup -> setup replay without weakening real unmount cleanup.
 */
export class MarketChartSourceEffectGuard {
  private readonly pending = new Map<MarketChartSourceRuntime, symbol>();

  constructor(
    private readonly enqueueMicrotask: EnqueueMicrotask = (callback) => {
      globalThis.queueMicrotask(callback);
    },
  ) {}

  mount(source: MarketChartSourceRuntime): () => void {
    this.pending.delete(source);
    let cleanedUp = false;
    return () => {
      if (cleanedUp) return;
      cleanedUp = true;
      const token = Symbol("market-chart-source-dispose");
      this.pending.set(source, token);
      this.enqueueMicrotask(() => {
        if (this.pending.get(source) !== token) return;
        this.pending.delete(source);
        source.dispose();
      });
    };
  }
}

export const marketChartSourceEffectGuard = new MarketChartSourceEffectGuard();
