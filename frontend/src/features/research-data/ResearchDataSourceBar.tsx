import { t } from "../../i18n/index.js";
import { ordinarySourceLabel } from "./researchDataSourceModel.js";
import type { ResearchSourceRefV1 } from "./researchDataTypes.js";
import { RESEARCH_DATA_LIBRARY_ENABLED } from "./researchDataFlags.js";

export function ResearchDataSourceBar({
  source,
  libraryEnabled = RESEARCH_DATA_LIBRARY_ENABLED,
  currentChartEnabled = true,
  onOpenLibrary,
  onSelectCurrentChart,
}: {
  source: ResearchSourceRefV1 | null;
  libraryEnabled?: boolean;
  currentChartEnabled?: boolean;
  onOpenLibrary(): void;
  onSelectCurrentChart?(): void;
}) {
  const label = source === null
    ? t("research.source.none")
    : ordinarySourceLabel(source.kind);
  return (
    <div className="research-data-source-bar" data-testid="research-data-source-bar">
      <span>{label}</span>
      {source?.kind !== "CURRENT_CHART" && currentChartEnabled && onSelectCurrentChart ? (
        <button type="button" data-testid="research-source-use-current-chart" onClick={onSelectCurrentChart}>
          {t("strategy.useCurrentChart")}
        </button>
      ) : null}
      {libraryEnabled ? (
        <button type="button" onClick={onOpenLibrary}>{t("research.source.openLibrary")}</button>
      ) : null}
    </div>
  );
}
