import { t } from "../../i18n/index.js";
import { exportDrawingDocument, importSavedDrawings } from "../drawings/core/drawingCodec.js";
import { drawingDocumentRepository } from "../drawings/persistence/drawingDocumentRepository.js";
import { loadActiveIndicators, saveActiveIndicators } from "../indicators/activeIndicatorStore.js";
import type { IndicatorDefinition } from "../indicators/indicatorTypes.js";
import { normalizeSettings, type ChartSettings } from "../settings/chartAppearanceSettings.js";
import { buildLocalAnalysisStorageKey } from "./localAnalysisStore.js";
import type { LocalAnalysisEvent } from "./localAnalysisTypes.js";
import type { LocalDatasetManifest } from "./localDataTypes.js";


function indicatorKey(manifest: LocalDatasetManifest): string {
  return `candlescope:local-indicators:v1:${manifest.dataset_id}:${manifest.data_epoch}`;
}

function drawingScope(manifest: LocalDatasetManifest): string {
  return `local:${manifest.dataset_id}:${manifest.data_epoch}__main`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function captureLocalProjectState(
  manifest: LocalDatasetManifest,
  settings: ChartSettings,
  events: readonly LocalAnalysisEvent[],
): Promise<Record<string, unknown>> {
  const loaded = await drawingDocumentRepository.load(drawingScope(manifest));
  if (loaded.status === "invalid" || loaded.status === "unavailable") {
    throw new Error(t("local.err.drawUnread"));
  }
  const drawings = loaded.status === "found" ? exportDrawingDocument(loaded.document) : [];
  if (drawings === null) throw new Error(t("local.err.drawSerialize"));
  return {
    schema_version: 1,
    dataset_id: manifest.dataset_id,
    data_epoch: manifest.data_epoch,
    events,
    indicators: loadActiveIndicators(indicatorKey(manifest)),
    drawings,
    settings,
  };
}

export async function restoreLocalProjectState(
  manifest: LocalDatasetManifest,
  value: unknown,
): Promise<ChartSettings | null> {
  const state = asRecord(value);
  if (state === null || state.schema_version !== 1 || !Array.isArray(state.events)
    || !Array.isArray(state.indicators) || !Array.isArray(state.drawings)) {
    throw new Error(t("local.err.projectUi"));
  }
  const events = state.events.map((event) => {
    const record = asRecord(event);
    if (record === null) throw new Error(t("local.err.projectEvent"));
    return { ...record, dataset_id: manifest.dataset_id, data_epoch: manifest.data_epoch };
  });
  localStorage.setItem(buildLocalAnalysisStorageKey({
    datasetId: manifest.dataset_id,
    dataEpoch: manifest.data_epoch,
  }), JSON.stringify({
    schema_version: 1,
    dataset_id: manifest.dataset_id,
    data_epoch: manifest.data_epoch,
    events,
  }));
  saveActiveIndicators(
    state.indicators as IndicatorDefinition[],
    indicatorKey(manifest),
  );
  const document = importSavedDrawings(drawingScope(manifest), state.drawings);
  if (document === null) throw new Error(t("local.err.projectDraw"));
  await drawingDocumentRepository.putDocument(document);
  return state.settings === undefined ? null : normalizeSettings(state.settings);
}
