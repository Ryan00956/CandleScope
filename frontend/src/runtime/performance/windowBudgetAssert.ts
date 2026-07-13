import type {
  WindowBudgetAssertOptions,
  WindowBudgetInput,
  WindowBudgetResult,
} from "./performanceTypes.js";

export const DEFAULT_MAX_SERIES_BARS = 10_000;

const GLOBAL_ENABLE_FLAG = "__CANDLESCOPE_WINDOW_BUDGET_ASSERT__";
const GLOBAL_REPORTS_KEY = "__CANDLESCOPE_WINDOW_BUDGET_REPORTS__";

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function viteEnv(): Record<string, unknown> {
  try {
    return import.meta.env || {};
  } catch {
    return {};
  }
}

function globalObject(): Record<string, unknown> | null {
  if (typeof globalThis !== "undefined") return globalThis;
  return null;
}

export function isWindowBudgetAssertEnabled(options: WindowBudgetAssertOptions = {}): boolean {
  if (typeof options.enabled === "boolean") return options.enabled;
  const globalRef = options.globalRef || globalObject();
  if (globalRef?.[GLOBAL_ENABLE_FLAG] === true) return true;

  const env = options.env || viteEnv();
  return Boolean(
    env.DEV
    && (
      env.VITE_CANDLESCOPE_WINDOW_BUDGET_ASSERT === "1"
      || env.VITE_CANDLESCOPE_WINDOW_BUDGET_ASSERT === "true"
    ),
  );
}

function normalizeBudgetInput(input: WindowBudgetInput = {}): WindowBudgetInput & {
  bars: number;
  maxBars: number;
  overBy: number;
} {
  const bars = numberOrNull(input.bars);
  const maxBars = numberOrNull(input.maxBars) || DEFAULT_MAX_SERIES_BARS;
  return {
    ...input,
    bars: bars ?? 0,
    maxBars,
    overBy: Math.max(0, (bars ?? 0) - maxBars),
  };
}

function appendReport(
  report: WindowBudgetResult,
  globalRef: Record<string, unknown> | null,
): void {
  if (!globalRef) return;
  const reports: WindowBudgetResult[] = Array.isArray(globalRef[GLOBAL_REPORTS_KEY])
    ? globalRef[GLOBAL_REPORTS_KEY] as WindowBudgetResult[]
    : [];
  reports.push(report);
  if (reports.length > 100) reports.splice(0, reports.length - 100);
  globalRef[GLOBAL_REPORTS_KEY] = reports;
}

export function assertWindowBudget(
  input: WindowBudgetInput = {},
  options: WindowBudgetAssertOptions = {},
): WindowBudgetResult | null {
  if (!isWindowBudgetAssertEnabled(options)) return null;

  const globalRef = options.globalRef || globalObject();
  const report: WindowBudgetResult = {
    type: "window-budget",
    level: "ok",
    atMs: Date.now(),
    ...normalizeBudgetInput(input),
  };

  if (report.overBy > 0) {
    report.level = "error";
    const log = options.console || console;
    log.error?.("[CandleScope] Active series exceeded window budget", report);
  }

  appendReport(report, globalRef);
  return report;
}
