import { t, type LocaleId } from "../../i18n/index.js";

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

export function pythonHostOwnsCopy(locale?: LocaleId): string {
  return t("python.hostOwns", {}, locale);
}

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

export function isBacktestResearchEnabled(
  env: Record<string, string | boolean | undefined> = import.meta.env as Record<
    string,
    string | boolean | undefined
  >,
): boolean {
  const raw = String(env.VITE_BACKTEST_RESEARCH_ENABLED ?? "0").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function isBacktestLegacyWorkbenchEnabled(
  env: Record<string, string | boolean | undefined> = import.meta.env as Record<
    string,
    string | boolean | undefined
  >,
): boolean {
  const raw = String(env.VITE_BACKTEST_LEGACY_WORKBENCH_ENABLED ?? "1")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
