export function isBacktestEntryEnabled(
  env: Record<string, string | boolean | undefined> = import.meta.env as Record<
    string,
    string | boolean | undefined
  >,
): boolean {
  const raw = String(env.VITE_BACKTEST_ENTRY_ENABLED ?? "0").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
export function isPythonStrategyEntryEnabled(
  env: Record<string, string | boolean | undefined> = import.meta.env as Record<
    string,
    string | boolean | undefined
  >,
): boolean {
  const raw = String(env.VITE_BACKTEST_PYTHON_STRATEGY_ENABLED ?? "0")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export const PYTHON_HOST_OWNS_COPY =
  "Python 只做决策；订单、成交、费用、资金费、账户、报告和 Study 由 CandleScope Host 生成。";

export function isPythonTrustedLocalEnabled(
  env: Record<string, string | boolean | undefined> = import.meta.env as Record<
    string,
    string | boolean | undefined
  >,
): boolean {
  const raw = String(env.VITE_BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED ?? "0")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
