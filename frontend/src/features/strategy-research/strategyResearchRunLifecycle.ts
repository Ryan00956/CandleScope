import type { ChartStrategyTesterRuntime } from "../backtest/chart-tester/ChartStrategyTesterRuntime.js";

export type StrategyResearchRunDisposalScheduler = (callback: () => void) => void;

export class StrategyResearchRunEffectGuard {
  private generation = 0;

  constructor(
    private readonly schedule: StrategyResearchRunDisposalScheduler = (callback) => {
      globalThis.queueMicrotask(callback);
    },
  ) {}

  mount(runtime: Pick<ChartStrategyTesterRuntime, "dispose">): () => void {
    const generation = ++this.generation;
    let cleaned = false;
    return () => {
      if (cleaned) return;
      cleaned = true;
      this.schedule(() => {
        if (this.generation === generation) runtime.dispose();
      });
    };
  }
}
