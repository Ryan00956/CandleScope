import { useCallback, useEffect, useRef, useState } from "react";

import { t } from "../../i18n/index.js";
import type { ChartSettings } from "../settings/chartAppearanceSettings.js";
import type { LocalAnalysisEvent } from "../local-data/localAnalysisTypes.js";
import {
  captureLocalProjectState,
  restoreLocalProjectState,
} from "../local-data/localProjectState.js";
import {
  activateLocalRevision,
  compareLocalRevisions,
  exportLocalProject,
  fetchLocalRevisionDetails,
  importLocalProject,
  listLocalDatasets,
  listLocalRevisions,
  listLocalTrash,
  restoreLocalTrash,
  trashLocalDataset,
  updateLocalDataset,
  type LocalDatasetManifest,
  type LocalDatasetRevision,
  type LocalRevisionComparison,
  type LocalRevisionDetails,
  type LocalTrashEntry,
} from "./researchDataApi.js";
import { formatResearchDate, researchLibraryErrorMessage } from "./researchDataFormat.js";
import { ResearchDatasetQuality } from "./ResearchDatasetQuality.js";
import { ResearchDatasetRevisions } from "./ResearchDatasetRevisions.js";

async function activateResearchDatasetRevision(input: {
  manifest: LocalDatasetManifest;
  dataEpoch: string;
  onChanged(preferredId?: string): Promise<void>;
  onRevisionActivated?(manifest: LocalDatasetManifest): void;
  activate?(manifest: LocalDatasetManifest, dataEpoch: string): Promise<LocalDatasetManifest>;
}): Promise<LocalDatasetManifest> {
  const activated = await (input.activate ?? activateLocalRevision)(input.manifest, input.dataEpoch);
  await input.onChanged(input.manifest.dataset_id);
  input.onRevisionActivated?.(activated);
  return activated;
}

export function ResearchDatasetManagement({
  manifest,
  settings,
  events,
  onChanged,
  onRevisionActivated,
  onSettingsImported,
  onError,
}: {
  manifest: LocalDatasetManifest | null;
  settings: ChartSettings;
  events: readonly LocalAnalysisEvent[];
  onChanged(preferredId?: string): Promise<void>;
  onRevisionActivated?(manifest: LocalDatasetManifest): void;
  onSettingsImported(settings: ChartSettings): void;
  onError(message: string): void;
}) {
  const [revisions, setRevisions] = useState<LocalDatasetRevision[]>([]);
  const [details, setDetails] = useState<LocalRevisionDetails | null>(null);
  const [comparison, setComparison] = useState<LocalRevisionComparison | null>(null);
  const [trash, setTrash] = useState<LocalTrashEntry[]>([]);
  const [archived, setArchived] = useState<LocalDatasetManifest[]>([]);
  const [draftName, setDraftName] = useState(manifest?.name ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const packageInputRef = useRef<HTMLInputElement | null>(null);
  const reloadGenerationRef = useRef(0);

  const reloadMetadata = useCallback(async () => {
    const generation = reloadGenerationRef.current + 1;
    reloadGenerationRef.current = generation;
    const [loadedTrash, allDatasets, loadedRevisions, loadedDetails] = await Promise.all([
      listLocalTrash(),
      listLocalDatasets(undefined, true),
      manifest === null ? Promise.resolve([]) : listLocalRevisions(manifest.dataset_id),
      manifest === null ? Promise.resolve(null) : fetchLocalRevisionDetails(manifest),
    ]);
    if (reloadGenerationRef.current !== generation) return;
    setTrash(loadedTrash);
    setArchived(allDatasets.filter((dataset) => dataset.archived === true));
    setRevisions(loadedRevisions);
    setDetails(loadedDetails);
  }, [manifest]);

  useEffect(() => {
    setDraftName(manifest?.name ?? "");
    setComparison(null);
    void reloadMetadata().catch((reason: unknown) => onError(researchLibraryErrorMessage(reason)));
  }, [manifest, onError, reloadMetadata]);

  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    try {
      await action();
    } catch (reason) {
      onError(researchLibraryErrorMessage(reason));
    } finally {
      setBusy(null);
    }
  }, [onError]);

  return (
    <section className="local-dataset-management" data-testid="research-dataset-management">
      <header>
        <div><span>{t("local.kicker.dataOps")}</span><strong>{t("local.ops")}</strong></div>
        <small>{busy ?? "ready"}</small>
      </header>
      {manifest !== null && (
        <>
          <div className="local-library-actions">
            <input value={draftName} onChange={(event) => setDraftName(event.target.value)} aria-label={t("local.datasetName")} />
            <button type="button" disabled={busy !== null || !draftName.trim() || draftName.trim() === manifest.name} onClick={() => void run("renaming", async () => {
              await updateLocalDataset(manifest.dataset_id, { name: draftName.trim() });
              await onChanged(manifest.dataset_id);
            })}>{t("local.rename")}</button>
            <button type="button" disabled={busy !== null} onClick={() => void run("archiving", async () => {
              await updateLocalDataset(manifest.dataset_id, { archived: true });
              await onChanged();
            })}>{t("local.archive")}</button>
            <button type="button" className="danger" disabled={busy !== null} onClick={() => {
              if (!window.confirm(t("local.trashConfirm", { name: manifest.name }))) return;
              void run("trashing", async () => {
                await trashLocalDataset(manifest.dataset_id);
                await onChanged();
                await reloadMetadata();
              });
            }}>{t("local.trash")}</button>
          </div>
          <ResearchDatasetQuality
            manifest={manifest}
            details={details}
            revisionCount={revisions.length}
          />
          <ResearchDatasetRevisions
            manifest={manifest}
            revisions={revisions}
            comparison={comparison}
            busy={busy}
            onCompare={(dataEpoch) => void run("comparing", async () => {
              setComparison(await compareLocalRevisions(manifest.dataset_id, dataEpoch, manifest.data_epoch));
            })}
            onActivate={(dataEpoch) => void run("switching", async () => {
              await activateResearchDatasetRevision({
                manifest,
                dataEpoch,
                onChanged,
                ...(onRevisionActivated === undefined ? {} : { onRevisionActivated }),
              });
            })}
          />
          <button type="button" className="local-project-export" disabled={busy !== null} onClick={() => void run("exporting", async () => {
            const state = await captureLocalProjectState(manifest, settings, events);
            await exportLocalProject(manifest, state);
          })}>{t("local.exportProject")}</button>
        </>
      )}
      <label className="local-project-import">
        <span>{t("local.importProject")}</span>
        <input
          ref={packageInputRef}
          type="file"
          accept=".csproject,application/zip,application/vnd.candlescope.local-project+zip"
          disabled={busy !== null}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void run("importing project", async () => {
              const imported = await importLocalProject(file);
              await onChanged(imported.dataset_id);
              const importedSettings = await restoreLocalProjectState(imported.dataset, imported.client_state);
              if (importedSettings !== null) onSettingsImported(importedSettings);
              await onChanged(imported.dataset_id);
            }).finally(() => {
              if (packageInputRef.current !== null) packageInputRef.current.value = "";
            });
          }}
        />
      </label>
      {archived.length > 0 && (
        <div className="local-trash-list">
          <strong>{t("local.archived")}</strong>
          {archived.map((dataset) => (
            <div key={dataset.dataset_id}><span>{dataset.name}<small>{dataset.symbol} · {dataset.interval}</small></span><button type="button" disabled={busy !== null} onClick={() => void run("unarchiving", async () => {
              await updateLocalDataset(dataset.dataset_id, { archived: false });
              await onChanged(dataset.dataset_id);
            })}>{t("local.restoreLibrary")}</button></div>
          ))}
        </div>
      )}
      {trash.length > 0 && (
        <div className="local-trash-list">
          <strong>{t("local.recycle")}</strong>
          {trash.slice(0, 3).map((entry) => (
            <div key={entry.trash_id}><span>{entry.name}<small>{formatResearchDate(entry.deleted_at)}</small></span><button type="button" disabled={busy !== null} onClick={() => void run("restoring", async () => {
              const restored = await restoreLocalTrash(entry.trash_id);
              await onChanged(restored.dataset_id);
            })}>{t("local.restore")}</button></div>
          ))}
        </div>
      )}
    </section>
  );
}
