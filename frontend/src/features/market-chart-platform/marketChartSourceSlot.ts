import type { MarketChartSourceRuntime } from "./marketChartSourceRuntime.js";

export class MarketChartSourceSlot {
  private current: MarketChartSourceRuntime | null = null;

  get source(): MarketChartSourceRuntime | null {
    return this.current;
  }

  activate(next: MarketChartSourceRuntime): MarketChartSourceRuntime {
    if (this.current === next) {
      next.resume();
      return next;
    }
    this.current?.dispose();
    this.current = next;
    next.resume();
    return next;
  }

  pause(): void {
    this.current?.pause();
  }

  resume(): void {
    this.current?.resume();
  }

  dispose(): void {
    this.current?.dispose();
    this.current = null;
  }
}
