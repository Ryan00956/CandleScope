export interface ChartStrategyTesterFlagEnvironment {
  VITE_CHART_STRATEGY_TESTER_ENABLED?: unknown;
}

export function resolveChartStrategyTesterEnabled(
  environment: ChartStrategyTesterFlagEnvironment = {},
): boolean {
  const value = environment.VITE_CHART_STRATEGY_TESTER_ENABLED;
  return value === true || value === 1 || value === "1";
}

function viteEnvironment(): ChartStrategyTesterFlagEnvironment {
  try {
    return {
      VITE_CHART_STRATEGY_TESTER_ENABLED:
        import.meta.env?.VITE_CHART_STRATEGY_TESTER_ENABLED,
    };
  } catch {
    return {};
  }
}

export const CHART_STRATEGY_TESTER_ENABLED = resolveChartStrategyTesterEnabled(
  viteEnvironment(),
);
