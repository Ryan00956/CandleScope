import { t } from "../../i18n/index.js";
import { ordinarySourceLabel } from "./researchDataSourceModel.js";
import type { ResearchSourceRefV1 } from "./researchDataTypes.js";
import { RESEARCH_DATA_LIBRARY_ENABLED } from "./researchDataFlags.js";

export function ResearchDataSourceBar({
  source,
  libraryEnabled = RESEARCH_DATA_LIBRARY_ENABLED,
  onOpenLibrary,
}: {
  source: ResearchSourceRefV1 | null;
  libraryEnabled?: boolean;
  onOpenLibrary(): void;
}) {
  if (!libraryEnabled && (source === null || source.kind !== "CURRENT_CHART")) {
    return null;
  }
  const label = source === null
    ? t("research.source.none")
    : ordinarySourceLabel(source.kind);
  return (
    <div className="research-data-source-bar" data-testid="research-data-source-bar">
      <span>{label}</span>
      {libraryEnabled ? (
        <button type="button" onClick={onOpenLibrary}>{t("research.source.openLibrary")}</button>
      ) : null}
    </div>
  );
}
