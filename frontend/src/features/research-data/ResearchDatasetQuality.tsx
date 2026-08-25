import { getLocale, t } from "../../i18n/index.js";
import type { LocalDatasetManifest, LocalRevisionDetails } from "./researchDataApi.js";
import { formatResearchRows } from "./researchDataFormat.js";

export function ResearchDatasetQuality({
  manifest,
  details,
  revisionCount,
}: {
  manifest: LocalDatasetManifest;
  details: LocalRevisionDetails | null;
  revisionCount: number;
}) {
  return (
    <div className="local-quality-card" data-testid="research-dataset-quality">
      <div><span>{t("local.quality")}</span><strong>{details?.quality.status ?? t("local.reading")}</strong></div>
      <dl>
        <div><dt>{t("local.rowsLabel")}</dt><dd>{formatResearchRows(details?.quality.rows ?? manifest.rows)}</dd></div>
        <div><dt>{t("local.gapsLabel")}</dt><dd>{details?.quality.excluded_ranges.length ?? manifest.excluded_range_count}</dd></div>
        <div><dt>{t("local.noVolume")}</dt><dd>{formatResearchRows(details?.quality.missing_volume_rows ?? 0)}</dd></div>
        <div><dt>{t("local.revisions")}</dt><dd>{manifest.revision_count ?? revisionCount}</dd></div>
      </dl>
      {(details?.quality.excluded_ranges.length ?? 0) > 0 && (
        <ul>{details?.quality.excluded_ranges.slice(0, 3).map((gap) => (
          <li key={`${gap.start_ms}-${gap.end_ms}`}>{t("local.gapBars", { time: new Date(gap.start_ms).toLocaleString(getLocale()), count: gap.missing_bars })}</li>
        ))}</ul>
      )}
    </div>
  );
}
