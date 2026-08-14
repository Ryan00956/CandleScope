export function isBacktestEntryEnabled(
  env: Record<string, string | boolean | undefined> = import.meta.env as Record<
    string,
    string | boolean | undefined
  >,
): boolean {
  const raw = String(env.VITE_BACKTEST_ENTRY_ENABLED ?? "0").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
