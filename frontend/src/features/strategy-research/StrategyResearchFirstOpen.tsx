import { t } from "../../i18n/index.js";
import { CHART_STRATEGY_TEMPLATES } from "../backtest/chart-tester/chartStrategyTesterUiModel.js";

export function StrategyResearchFirstOpen({
  libraryEnabled,
  runtimeMode,
  onOpenLibrary,
}: {
  libraryEnabled: boolean;
  runtimeMode: "LIVE" | "LOCAL_OFFLINE";
  onOpenLibrary(): void;
}) {
  const templateAction = libraryEnabled ? onOpenLibrary : undefined;
  return (
    <div className="strategy-research-first-open" data-testid="strategy-research-first-open">
      <p className="chart-strategy-eyebrow">{t("chartTester.startEyebrow")}</p>
      <h2>{t("chartTester.startTitle")}</h2>
      <p>{t("strategy.firstOpenLead")}</p>
      <div className="strategy-research-templates" data-testid="strategy-research-templates">
        {CHART_STRATEGY_TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            data-testid={`strategy-research-template-${template.id}`}
            disabled={templateAction === undefined}
            onClick={templateAction ? () => templateAction() : undefined}
          >
            {t(template.nameKey)}
          </button>
        ))}
      </div>
      <div className="strategy-research-first-open-actions">
        <div data-testid="strategy-research-current-chart-unavailable">
          <p>
            {runtimeMode === "LOCAL_OFFLINE"
              ? t("research.source.offlineLiveUnavailable")
              : t("strategy.currentChartUnbound")}
          </p>
          {runtimeMode === "LIVE" ? (
            <a href="/" data-testid="strategy-research-open-market-tester">
              {t("strategy.openMarketTester")}
            </a>
          ) : null}
        </div>
        {libraryEnabled ? (
          <button type="button" data-testid="strategy-research-import-own-data" onClick={onOpenLibrary}>
            {t("research.source.openLibrary")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
