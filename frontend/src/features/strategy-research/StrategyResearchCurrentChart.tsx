import { t } from "../../i18n/index.js";

export function StrategyResearchCurrentChart() {
  return (
    <section
      className="strategy-research-current-chart"
      data-testid="strategy-research-current-chart-unbound"
    >
      <p>{t("strategy.currentChartUnbound")}</p>
      <a href="/" data-testid="strategy-research-open-market-tester">
        {t("strategy.openMarketTester")}
      </a>
    </section>
  );
}
