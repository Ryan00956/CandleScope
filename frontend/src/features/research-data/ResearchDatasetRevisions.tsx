import { t } from "../../i18n/index.js";
import type {
  LocalDatasetManifest,
  LocalDatasetRevision,
  LocalRevisionComparison,
} from "./researchDataApi.js";
import { formatResearchDate, formatResearchRows } from "./researchDataFormat.js";

export function ResearchDatasetRevisions({
  revisions,
  comparison,
  busy,
  onCompare,
  onActivate,
}: {
  manifest: LocalDatasetManifest;
  revisions: LocalDatasetRevision[];
  comparison: LocalRevisionComparison | null;
  busy: string | null;
  onCompare(dataEpoch: string): void;
  onActivate(dataEpoch: string): void;
}) {
  return (
    <>
      <div className="local-revision-list" data-testid="research-dataset-revisions">
        <strong>{t("local.revisionHistory")}</strong>
        {revisions.map((revision) => (
          <div key={revision.data_epoch} className={revision.current ? "current" : ""}>
            <span><b>{revision.data_epoch.slice(7, 17)}</b><small>{t("local.revisionRows", { date: formatResearchDate(revision.imported_at), rows: formatResearchRows(revision.rows), status: revision.quality_status })}</small></span>
            {revision.current ? <em>{t("local.current")}</em> : <span className="local-revision-actions">
              <button type="button" disabled={busy !== null} onClick={() => onCompare(revision.data_epoch)}>{t("local.compare")}</button>
              <button type="button" disabled={busy !== null} onClick={() => {
                if (!window.confirm(t("local.switchConfirm"))) return;
                onActivate(revision.data_epoch);
              }}>{t("local.switchRevision")}</button>
            </span>}
          </div>
        ))}
      </div>
      {comparison !== null && (
        <div className="local-revision-comparison">
          <span>{t("local.diff")}</span>
          <b>{t("local.diffStats", { added: comparison.added, removed: comparison.removed, changed: comparison.changed, unchanged: comparison.unchanged })}</b>
        </div>
      )}
    </>
  );
}
