import { t } from "../../i18n/index.js";
import {
  ChartStrategyResultContextBar,
  ChartStrategyResultOverview,
} from "../backtest/chart-tester/ChartStrategyResultViews.js";
import type { ChartStrategyResultBundle } from "../backtest/chart-tester/chartStrategyResultCache.js";
import type { ChartStrategyTesterStaleReason } from "../backtest/chart-tester/chartStrategyTesterState.js";
import { useLocale } from "../../i18n/useLocale.js";

export function StrategyResearchResultPanel({
  result,
  stale,
  staleReasons,
  barOnly,
  error,
  runStatus,
}: {
  result: ChartStrategyResultBundle | null;
  stale: boolean;
  staleReasons: readonly ChartStrategyTesterStaleReason[];
  barOnly: boolean;
  error: string | null;
  runStatus: string;
}) {
  const locale = useLocale();
  if (error !== null) {
    return <p className="strategy-research-error" role="alert">{error}</p>;
  }
  if (result === null) {
    return (
      <section data-testid="strategy-research-result-panel" data-run-status={runStatus}>
        <p>{t("strategy.resultSlot")}</p>
        {barOnly ? (
          <p data-testid="strategy-research-bar-only-result">{t("chartTester.result.fidelityFast")}</p>
        ) : null}
      </section>
    );
  }
  return (
    <section
      className="strategy-research-result-panel"
      data-testid="strategy-research-result-panel"
      data-stale={stale ? "true" : "false"}
      data-stale-reasons={staleReasons.join(",")}
      data-fidelity={barOnly ? "BAR_APPROX" : result.run.fidelity_mode}
    >
      <ChartStrategyResultContextBar
        result={result}
        locale={locale}
        stale={stale}
      />
      {barOnly ? (
        <p data-testid="strategy-research-no-precise">{t("chartTester.result.fidelityFast")}</p>
      ) : null}
      <ChartStrategyResultOverview
        result={result}
        stale={stale}
        onOpenTrades={() => undefined}
      />
    </section>
  );
}
