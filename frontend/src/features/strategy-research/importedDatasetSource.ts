import { RESEARCH_SOURCE_SCHEMA } from "../research-data/researchDataTypes.js";
import type { ImportedDatasetSourceRefV1 } from "../research-data/researchDataTypes.js";
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
