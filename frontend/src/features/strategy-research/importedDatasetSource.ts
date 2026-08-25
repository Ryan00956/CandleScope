import { RESEARCH_SOURCE_SCHEMA } from "../research-data/researchDataTypes.js";
import type { ImportedDatasetSourceRefV1, ResearchSourceRefV1 } from "../research-data/researchDataTypes.js";
import type { LocalDatasetManifest } from "../local-data/localDataTypes.js";


export function importedDatasetSourceFromManifest(
  manifest: Pick<LocalDatasetManifest, "dataset_id" | "data_epoch" | "interval">,
  interval: string = manifest.interval,
): ImportedDatasetSourceRefV1 {
  return {
    schemaVersion: RESEARCH_SOURCE_SCHEMA,
    kind: "IMPORTED_DATASET",
    datasetId: manifest.dataset_id,
    dataEpoch: manifest.data_epoch,
    interval,
  };
}

export function importedChartDatasetKey(
  manifest: Pick<LocalDatasetManifest, "dataset_id" | "data_epoch">,
  interval: string,
): string {
  return `local:${manifest.dataset_id}:${manifest.data_epoch}:${interval}`;
}

export function importedDrawingKeyBase(
  manifest: Pick<LocalDatasetManifest, "dataset_id" | "data_epoch">,
): string {
  return `local:${manifest.dataset_id}:${manifest.data_epoch}`;
}

export function preferredLibrarySelectedId(
  source: ResearchSourceRefV1 | null,
  datasets: ReadonlyArray<Pick<LocalDatasetManifest, "dataset_id">>,
): string | null {
  if (source?.kind === "IMPORTED_DATASET") {
    const match = datasets.find((dataset) => dataset.dataset_id === source.datasetId);
    if (match !== undefined) return match.dataset_id;
  }
  return datasets[0]?.dataset_id ?? null;
}

export function importedManifestForSource(
  source: ResearchSourceRefV1 | null,
  selected: LocalDatasetManifest | null,
): LocalDatasetManifest | null {
  if (source?.kind !== "IMPORTED_DATASET" || selected === null) return null;
  if (selected.dataset_id !== source.datasetId || selected.data_epoch !== source.dataEpoch) {
    return null;
  }
  return selected;
}

export function researchSourceIdentity(source: ResearchSourceRefV1 | null): string {
  if (source?.kind === "IMPORTED_DATASET") {
    return `imported:${source.datasetId}:${source.dataEpoch}`;
  }
  if (source?.kind === "CURRENT_CHART") {
    return `chart:${source.workspaceId}:${source.cellId}:${source.exchange}:${source.marketType}:${source.symbol}:${source.interval}`;
  }
  if (source?.kind === "COMPLETED_RUN") {
    return `run:${source.runId}`;
  }
  return "";
}
