export interface ChartStrategyTesterFlagEnvironment {
  VITE_CHART_STRATEGY_TESTER_ENABLED?: unknown;
  VITE_CHART_TRADE_EXPLANATION_ENABLED?: unknown;
  VITE_CHART_RUN_COMPARE_ENABLED?: unknown;
  VITE_CHART_STRATEGY_AUTO_RUN_ENABLED?: unknown;
}

function strictEnabled(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function enabledByDefault(value: unknown): boolean {
  return value === undefined ? true : strictEnabled(value);
}

export function resolveChartStrategyTesterEnabled(
  environment: ChartStrategyTesterFlagEnvironment = {},
): boolean {
  return enabledByDefault(environment.VITE_CHART_STRATEGY_TESTER_ENABLED);
}

export function resolveChartTradeExplanationEnabled(
  environment: ChartStrategyTesterFlagEnvironment = {},
): boolean {
  return strictEnabled(environment.VITE_CHART_TRADE_EXPLANATION_ENABLED);
}

export function resolveChartRunCompareEnabled(
  environment: ChartStrategyTesterFlagEnvironment = {},
): boolean {
  return enabledByDefault(environment.VITE_CHART_RUN_COMPARE_ENABLED);
}

export function resolveChartStrategyAutoRunEnabled(
  environment: ChartStrategyTesterFlagEnvironment = {},
): boolean {
  return enabledByDefault(environment.VITE_CHART_STRATEGY_AUTO_RUN_ENABLED);
}

function viteEnvironment(): ChartStrategyTesterFlagEnvironment {
  try {
    return {
      VITE_CHART_STRATEGY_TESTER_ENABLED:
        import.meta.env?.VITE_CHART_STRATEGY_TESTER_ENABLED,
      VITE_CHART_TRADE_EXPLANATION_ENABLED:
        import.meta.env?.VITE_CHART_TRADE_EXPLANATION_ENABLED,
      VITE_CHART_RUN_COMPARE_ENABLED:
        import.meta.env?.VITE_CHART_RUN_COMPARE_ENABLED,
      VITE_CHART_STRATEGY_AUTO_RUN_ENABLED:
        import.meta.env?.VITE_CHART_STRATEGY_AUTO_RUN_ENABLED,
    };
  } catch {
    return {};
  }
}

export const CHART_STRATEGY_TESTER_ENABLED = resolveChartStrategyTesterEnabled(
  viteEnvironment(),
);

export const CHART_TRADE_EXPLANATION_ENABLED = resolveChartTradeExplanationEnabled(
  viteEnvironment(),
);

export const CHART_RUN_COMPARE_ENABLED = resolveChartRunCompareEnabled(
  viteEnvironment(),
);

export const CHART_STRATEGY_AUTO_RUN_ENABLED = resolveChartStrategyAutoRunEnabled(
  viteEnvironment(),
);
