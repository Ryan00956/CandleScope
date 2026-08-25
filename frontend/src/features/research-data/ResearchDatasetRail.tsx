import type { ReactNode } from "react";

import { t } from "../../i18n/index.js";
import type { LocalDatasetManifest, LocalImportJob } from "./researchDataApi.js";
import { formatResearchRows } from "./researchDataFormat.js";
import { ResearchDataImportForm } from "./ResearchDataImportForm.js";
import type { ResearchImportSubmitInput } from "./useResearchDataLibrary.js";

export function ResearchDatasetRail({
  datasets,
  selectedId,
  importing,
  importJob,
  uploadProgress,
  onSelect,
  onImport,
  onCancelImport,
  management,
  analysis,
}: {
  datasets: LocalDatasetManifest[];
  selectedId: string | null;
  importing: boolean;
  importJob: LocalImportJob | null;
  uploadProgress: number | null;
  onSelect(datasetId: string): void;
  onImport(input: ResearchImportSubmitInput): Promise<unknown>;
  onCancelImport(): void;
  management: ReactNode;
  analysis: ReactNode;
}) {
  return (
    <aside className="local-data-rail" aria-label={t("local.libraryAria")} data-testid="research-dataset-rail">
      <ResearchDataImportForm
        importing={importing}
        importJob={importJob}
        uploadProgress={uploadProgress}
        selected={datasets.find((dataset) => dataset.dataset_id === selectedId) ?? null}
        onCancel={onCancelImport}
        onImport={onImport}
      />
      <section className="local-dataset-library">
        <header>
          <div>
            <span>{t("local.kicker.library")}</span>
            <strong>{t("local.datasets")}</strong>
          </div>
          <small>{t("local.count", { count: datasets.length })}</small>
        </header>
        <div className="local-dataset-list">
          {datasets.length === 0 ? (
            <div className="local-dataset-empty">{t("local.empty")}</div>
          ) : datasets.map((dataset) => (
            <button
              type="button"
              key={dataset.dataset_id}
              className={dataset.dataset_id === selectedId ? "active" : ""}
              data-testid={`research-dataset-${dataset.dataset_id}`}
              onClick={() => onSelect(dataset.dataset_id)}
            >
              <span><strong>{dataset.name}</strong><em>{dataset.symbol} · {dataset.interval} · {dataset.volume_available ? "OHLCV" : "OHLC-only"}</em></span>
              <span><b>{formatResearchRows(dataset.rows)}</b><small>{t("local.gaps", { count: dataset.excluded_range_count })}</small></span>
            </button>
          ))}
        </div>
      </section>
      {management}
      {analysis}
    </aside>
  );
}
