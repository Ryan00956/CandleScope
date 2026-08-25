import { t } from "../../i18n/index.js";
import { CHART_STRATEGY_TEMPLATES } from "../backtest/chart-tester/chartStrategyTesterUiModel.js";

export function StrategyResearchFirstOpen({
  libraryEnabled,
  currentChartEnabled,
  onSelectCurrentChart,
  onOpenLibrary,
}: {
  libraryEnabled: boolean;
  currentChartEnabled: boolean;
  onSelectCurrentChart(): void;
  onOpenLibrary(): void;
}) {
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
            onClick={onSelectCurrentChart}
          >
            {t(template.nameKey)}
          </button>
        ))}
      </div>
      <div className="strategy-research-first-open-actions">
        {currentChartEnabled ? (
          <button type="button" data-testid="strategy-research-use-current-chart" onClick={onSelectCurrentChart}>
            {t("strategy.useCurrentChart")}
          </button>
        ) : (
          <p data-testid="strategy-research-current-chart-unavailable">{t("research.source.offlineLiveUnavailable")}</p>
        )}
        {libraryEnabled ? (
          <button type="button" data-testid="strategy-research-import-own-data" onClick={onOpenLibrary}>
            {t("research.source.openLibrary")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
