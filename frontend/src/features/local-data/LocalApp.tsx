import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getLocale, t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import type { ReactNode, RefObject } from "react";
import SingleChartPanes from "../../components/SingleChartPanes.js";
import type { MainSeriesCrosshairValue } from "../../chart-adapter/chartAdapterTypes.js";
import { useChartSurfaceRuntime } from "../../chart-adapter/useChartSurfaceRuntime.js";
import { ChartErrorBoundary } from "../../app/AppProviders.js";
import { drawingToolWhenInteractionReady } from "../../app/drawingInteractionReadiness.js";
import MarketPageFrame from "../../app/MarketPageFrame.js";
import MarketStatusBar from "../../app/MarketStatusBar.js";
import MarketTopBarFrame from "../../app/MarketTopBarFrame.js";
import MarketWorkspaceFrame from "../../app/MarketWorkspaceFrame.js";
import DrawingToolbar from "../../components/DrawingToolbar.js";
import ExportPanel from "../export/ExportPanel.js";
import { useExportRuntime } from "../export/useExportRuntime.js";
import {
  loadUserPrefs,
  updateUserPref,
} from "../chart-session/chartSessionModel.js";
import {
  getVisibleRangeForInterval,
  saveVisibleRangeForInterval,
} from "../chart-session/visibleRangeStorage.js";
import {
  activateLocalRevision,
  cancelLocalImportJob,
  compareLocalRevisions,
  createLocalImportJob,
  exportLocalProject,
  fetchLocalRevisionDetails,
  fetchLocalIndicatorPresets,
  getLocalImportJob,
  importLocalProject,
  listLocalDatasets,
  listLocalRevisions,
  listLocalTrash,
  LocalDataApiError,
  restoreLocalTrash,
  trashLocalDataset,
  updateLocalDataset,
} from "./localDataApi.js";
import type {
  LocalDatasetManifest,
  LocalDatasetRevision,
  LocalImportJob,
  LocalRevisionComparison,
  LocalRevisionDetails,
  LocalTrashEntry,
} from "./localDataTypes.js";
import {
  captureLocalProjectState,
  restoreLocalProjectState,
} from "./localProjectState.js";
import LocalAnalysisPanel from "./LocalAnalysisPanel.js";
import LocalIntervalSelector from "./LocalIntervalSelector.js";
import { createLocalAnalysisMarkerSource } from "./localAnalysisMarkerSource.js";
import {
  EMPTY_LOCAL_ANALYSIS_SNAPSHOT,
  LocalAnalysisEventStore,
} from "./localAnalysisStore.js";
import type {
  LocalAnalysisEvent,
  LocalAnalysisFocusRequest,
} from "./localAnalysisTypes.js";
import {
  buildLocalChartDataMeta,
  useLocalChartRuntime,
} from "./useLocalChartRuntime.js";
import { useLocalIndicatorRuntime } from "./useLocalIndicatorRuntime.js";
import type { IndicatorRuntime } from "../indicators/indicatorRuntimeContract.js";
import type { IndicatorPreset } from "../indicators/indicatorTypes.js";
import IndicatorPanel from "../indicators/IndicatorPanel.js";
import { useDrawingRuntime } from "../drawings/useDrawingRuntime.js";
import type { DrawingRuntime } from "../drawings/useDrawingRuntime.js";
import type { DrawingToolId } from "../drawings/drawingTypes.js";
import SettingsModal from "../settings/SettingsModal.js";
import {
  useChartSettingsRuntime,
} from "../settings/chartAppearanceSettings.js";
import type { ChartSettings } from "../settings/chartAppearanceSettings.js";
import { usePriceScalePrefs } from "../settings/priceScalePrefsRuntime.js";
import {
  createLocalIndicatorCatalog,
  resolveLocalIndicatorSupport,
} from "./localIndicatorCatalog.js";
import { resolveLocalIntervalSupport } from "./localIntervalPolicy.js";


function formatRows(rows: number): string {
  return new Intl.NumberFormat(getLocale()).format(rows);
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(getLocale());
}

function errorMessage(reason: unknown): string {
  if (reason instanceof LocalDataApiError && reason.code === "local_profile_not_active") {
    return t("local.offlineMode");
  }
  return reason instanceof Error ? reason.message : t("local.opFailed");
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function LocalImportForm({
  importing,
  importJob,
  uploadProgress,
  selected,
  onCancel,
  onImport,
}: {
  importing: boolean;
  importJob: LocalImportJob | null;
  uploadProgress: number | null;
  selected: LocalDatasetManifest | null;
  onCancel(): void;
  onImport(input: {
    file: File;
    name: string;
    symbol: string;
    interval: string;
    timezone: string;
    timestampUnit: "auto" | "s" | "ms" | "iso";
    volumeRequired: boolean;
    datasetId?: string;
  }): Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("BTC-USDT");
  const [interval, setInterval] = useState("1m");
  const [timezone, setTimezone] = useState("UTC");
  const [timestampUnit, setTimestampUnit] = useState<"auto" | "s" | "ms" | "iso">("auto");
  const [volumeRequired, setVolumeRequired] = useState(false);
  const [asRevision, setAsRevision] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <form
      className="local-import-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (file === null) return;
        void onImport({
          file,
          name: name.trim() || file.name.replace(/\.csv$/i, ""),
          symbol,
          interval,
          timezone,
          timestampUnit,
          volumeRequired,
          ...(asRevision && selected !== null ? { datasetId: selected.dataset_id } : {}),
        }).then(() => {
          setFile(null);
          setName("");
          if (fileInputRef.current !== null) fileInputRef.current.value = "";
        }).catch(() => undefined);
      }}
    >
      <header>
        <div>
          <span>{t("local.kicker.import")}</span>
          <strong>{t("local.import")}</strong>
        </div>
        <small>{t("local.localOnly")}</small>
      </header>
      <label className="local-file-picker">
        <span>{file?.name ?? t("local.chooseFile")}</span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </label>
      <label>
        {t("local.datasetName")}
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("local.namePh")} />
      </label>
      <div className="local-import-grid">
        <label>
          {t("local.symbol")}
          <input required value={symbol} onChange={(event) => setSymbol(event.target.value)} />
        </label>
        <label>
          {t("local.interval")}
          <input required value={interval} onChange={(event) => setInterval(event.target.value)} placeholder="1m" />
        </label>
        <label>
          {t("local.timezone")}
          <input required value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="UTC" />
        </label>
        <label>
          {t("local.timeFormat")}
          <select value={timestampUnit} onChange={(event) => setTimestampUnit(event.target.value as typeof timestampUnit)}>
            <option value="auto">{t("local.autoDetect")}</option>
            <option value="s">{t("local.unixS")}</option>
            <option value="ms">{t("local.unixMs")}</option>
            <option value="iso">{t("local.iso")}</option>
          </select>
        </label>
        <label>
          {t("local.volume")}
          <select
            value={volumeRequired ? "required" : "optional"}
            onChange={(event) => setVolumeRequired(event.target.value === "required")}
          >
            <option value="optional">{t("local.volumeOptional")}</option>
            <option value="required">{t("local.volumeRequired")}</option>
          </select>
        </label>
      </div>
      <p>{t("local.requiredCols")}</p>
      {selected !== null && (
        <label className="local-revision-choice">
          <input
            type="checkbox"
            checked={asRevision}
            onChange={(event) => setAsRevision(event.target.checked)}
          />
          {t("local.asRevision", { name: selected.name })}
        </label>
      )}
      <button type="submit" disabled={file === null || importing}>
        {importing ? t("local.importing") : t("local.importBtn")}
      </button>
      {importing && (
        <div className="local-import-progress" role="status">
          <div><span>{importJob?.stage ?? "uploading"}</span><b>{importJob ? t("local.rows", { count: formatRows(importJob.processed_rows) }) : `${Math.round((uploadProgress ?? 0) * 100)}%`}</b></div>
          <progress value={importJob?.total_rows ? importJob.processed_rows / importJob.total_rows : (uploadProgress ?? undefined)} />
          <button type="button" onClick={onCancel}>{t("local.cancelImport")}</button>
        </div>
      )}
    </form>
  );
}

function LocalDatasetRail({
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
  onImport: Parameters<typeof LocalImportForm>[0]["onImport"];
  onCancelImport(): void;
  management: ReactNode;
  analysis: ReactNode;
}) {
  return (
    <aside className="local-data-rail" aria-label={t("local.libraryAria")}>
      <LocalImportForm
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
              onClick={() => onSelect(dataset.dataset_id)}
            >
              <span><strong>{dataset.name}</strong><em>{dataset.symbol} · {dataset.interval} · {dataset.volume_available ? "OHLCV" : "OHLC-only"}</em></span>
              <span><b>{formatRows(dataset.rows)}</b><small>{t("local.gaps", { count: dataset.excluded_range_count })}</small></span>
            </button>
          ))}
        </div>
      </section>
      {management}
      {analysis}
    </aside>
  );
}

function LocalDatasetManagement({
  manifest,
  settings,
  events,
  onChanged,
  onSettingsImported,
  onError,
}: {
  manifest: LocalDatasetManifest | null;
  settings: ChartSettings;
  events: readonly LocalAnalysisEvent[];
  onChanged(preferredId?: string): Promise<void>;
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

  const reloadMetadata = useCallback(async () => {
    const [loadedTrash, allDatasets, loadedRevisions, loadedDetails] = await Promise.all([
      listLocalTrash(),
      listLocalDatasets(undefined, true),
      manifest === null ? Promise.resolve([]) : listLocalRevisions(manifest.dataset_id),
      manifest === null ? Promise.resolve(null) : fetchLocalRevisionDetails(manifest),
    ]);
    setTrash(loadedTrash);
    setArchived(allDatasets.filter((dataset) => dataset.archived === true));
    setRevisions(loadedRevisions);
    setDetails(loadedDetails);
  }, [manifest]);

  useEffect(() => {
    setDraftName(manifest?.name ?? "");
    setComparison(null);
    void reloadMetadata().catch((reason: unknown) => onError(errorMessage(reason)));
  }, [manifest, onError, reloadMetadata]);

  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    try {
      await action();
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  }, [onError]);

  return (
    <section className="local-dataset-management">
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
          <div className="local-quality-card">
            <div><span>{t("local.quality")}</span><strong>{details?.quality.status ?? t("local.reading")}</strong></div>
            <dl>
              <div><dt>{t("local.rowsLabel")}</dt><dd>{formatRows(details?.quality.rows ?? manifest.rows)}</dd></div>
              <div><dt>{t("local.gapsLabel")}</dt><dd>{details?.quality.excluded_ranges.length ?? manifest.excluded_range_count}</dd></div>
              <div><dt>{t("local.noVolume")}</dt><dd>{formatRows(details?.quality.missing_volume_rows ?? 0)}</dd></div>
              <div><dt>{t("local.revisions")}</dt><dd>{manifest.revision_count ?? revisions.length}</dd></div>
            </dl>
            {(details?.quality.excluded_ranges.length ?? 0) > 0 && (
              <ul>{details?.quality.excluded_ranges.slice(0, 3).map((gap) => (
                <li key={`${gap.start_ms}-${gap.end_ms}`}>{t("local.gapBars", { time: new Date(gap.start_ms).toLocaleString(getLocale()), count: gap.missing_bars })}</li>
              ))}</ul>
            )}
          </div>
          <div className="local-revision-list">
            <strong>{t("local.revisionHistory")}</strong>
            {revisions.map((revision) => (
              <div key={revision.data_epoch} className={revision.current ? "current" : ""}>
                <span><b>{revision.data_epoch.slice(7, 17)}</b><small>{t("local.revisionRows", { date: formatDate(revision.imported_at), rows: formatRows(revision.rows), status: revision.quality_status })}</small></span>
                {revision.current ? <em>{t("local.current")}</em> : <span className="local-revision-actions">
                  <button type="button" disabled={busy !== null} onClick={() => void run("comparing", async () => {
                    setComparison(await compareLocalRevisions(manifest.dataset_id, revision.data_epoch, manifest.data_epoch));
                  })}>{t("local.compare")}</button>
                  <button type="button" disabled={busy !== null} onClick={() => {
                    if (!window.confirm(t("local.switchConfirm"))) return;
                    void run("switching", async () => {
                      await activateLocalRevision(manifest, revision.data_epoch);
                      await onChanged(manifest.dataset_id);
                    });
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
            <div key={entry.trash_id}><span>{entry.name}<small>{formatDate(entry.deleted_at)}</small></span><button type="button" disabled={busy !== null} onClick={() => void run("restoring", async () => {
              const restored = await restoreLocalTrash(entry.trash_id);
              await onChanged(restored.dataset_id);
            })}>{t("local.restore")}</button></div>
          ))}
        </div>
      )}
    </section>
  );
}

function LocalChart({
  manifest,
  interval,
  runtime,
  dataMeta,
  eventStore,
  focusRequest,
  indicators,
  chartSurfaceRef,
  drawings,
  drawingTool,
  settings,
  resolvedTheme,
  invertScale,
  priceScaleMode,
  savedVisibleRange,
  onVisibleRangeChange,
  onInvertScaleChange,
  onPriceScaleModeChange,
  onDrawingInteractionReadyChange,
  onRemoveIndicator,
  onCrosshairMove,
}: {
  manifest: LocalDatasetManifest;
  interval: string;
  runtime: ReturnType<typeof useLocalChartRuntime>;
  dataMeta: ReturnType<typeof buildLocalChartDataMeta>;
  eventStore: LocalAnalysisEventStore;
  focusRequest: LocalAnalysisFocusRequest | null;
  indicators: IndicatorRuntime;
  chartSurfaceRef: ReturnType<typeof useChartSurfaceRuntime>["ref"];
  drawings: DrawingRuntime;
  drawingTool: DrawingToolId | null;
  settings: ChartSettings;
  resolvedTheme: string;
  invertScale: boolean;
  priceScaleMode: number;
  savedVisibleRange: ReturnType<typeof getVisibleRangeForInterval>;
  onVisibleRangeChange(range: unknown): void;
  onInvertScaleChange(value: boolean): void;
  onPriceScaleModeChange(mode: number): void;
  onDrawingInteractionReadyChange(ready: boolean): void;
  onRemoveIndicator(indicatorId: string): void;
  onCrosshairMove(value: MainSeriesCrosshairValue | null): void;
}) {
  const focusTime = runtime.focusTime;
  const markerSource = useMemo(() => createLocalAnalysisMarkerSource({
    eventStore,
    seriesStore: runtime.seriesStore,
    interval,
  }), [eventStore, interval, runtime.seriesStore]);
  useEffect(() => {
    if (focusRequest === null) return undefined;
    let active = true;
    void focusTime(focusRequest.time).then((available) => {
      if (active && available) {
        chartSurfaceRef.current?.setLinkedVisibleTimeAnchor(focusRequest.time);
      }
    });
    return () => { active = false; };
  }, [chartSurfaceRef, focusRequest, focusTime]);

  return (
    <>
      {runtime.error !== null && (
        <div className="local-chart-error" role="alert">
          <span>{runtime.error}</span>
          <button type="button" onClick={runtime.retry}>{t("replay.retry")}</button>
        </div>
      )}
      <ChartErrorBoundary>
        <SingleChartPanes
          ref={chartSurfaceRef}
          seriesStore={runtime.seriesStore}
          symbol={manifest.symbol}
          drawingKeyBase={`local:${manifest.dataset_id}:${manifest.data_epoch}`}
          interval={interval}
          loading={runtime.loading || runtime.loadingMore}
          dataMeta={dataMeta}
          onCrosshairMove={onCrosshairMove}
          onNeedMoreLeft={runtime.loadMoreLeft}
          canLoadMoreLeft={runtime.hasMoreLeft}
          canRestoreLatestWindow={false}
          datasetKey={`local:${manifest.dataset_id}:${manifest.data_epoch}:${interval}`}
          upColor={settings.upColor}
          downColor={settings.downColor}
          chartType={settings.chartType}
          renkoBoxSizeMode={settings.renkoBoxSizeMode}
          renkoAtrLength={settings.renkoAtrLength}
          renkoBoxSize={settings.renkoBoxSize}
          pointFigureBoxSizeMode={settings.pointFigureBoxSizeMode}
          pointFigureAtrLength={settings.pointFigureAtrLength}
          pointFigureBoxSize={settings.pointFigureBoxSize}
          pointFigureReversalAmount={settings.pointFigureReversalAmount}
          kagiReversalMode={settings.kagiReversalMode}
          kagiAtrLength={settings.kagiAtrLength}
          kagiReversalAmount={settings.kagiReversalAmount}
          lineBreakNumberOfLines={settings.lineBreakNumberOfLines}
          theme={resolvedTheme}
          customBg={settings.customBg}
          timezone={settings.timezone ?? manifest.timezone}
          savedVisibleRange={savedVisibleRange}
          onViewportRangeChange={indicators.actions.ensureVisibleIndicatorRange}
          onVisibleRangeChange={onVisibleRangeChange}
          followLatest={false}
          externalMarkerSource={markerSource}
          drawingTool={drawingTool}
          onDrawingToolChange={drawings.actions.setDrawingTool}
          onDrawingInteractionReadyChange={onDrawingInteractionReadyChange}
          penColor={drawings.view.penColor}
          penSize={drawings.view.penSize}
          textFontSize={drawings.view.textFontSize}
          textBold={drawings.view.textBold}
          textItalic={drawings.view.textItalic}
          fibLevels={drawings.view.fibLevels}
          fibInverted={drawings.view.fibInverted}
          positionSize={drawings.view.positionSize}
          drawingSnapEnabled={drawings.view.drawingSnapEnabled}
          drawingContinuousEnabled={drawings.view.drawingContinuousEnabled}
          onSelectedDrawingChange={drawings.actions.handleSelectedDrawingChange}
          mainOverlayLines={indicators.view.mainOverlayLines}
          subPanes={indicators.view.subPanes}
          indicatorMarkers={indicators.view.markers}
          indicatorFills={indicators.view.fills}
          indicatorHlines={indicators.view.hlines}
          indicatorBgcolors={indicators.view.bgcolors}
          indicatorBarcolors={indicators.view.barcolors}
          invertScale={invertScale}
          onInvertScaleChange={onInvertScaleChange}
          priceScaleMode={priceScaleMode}
          onPriceScaleModeChange={onPriceScaleModeChange}
          onRemoveSubPane={(pane) => {
            if (pane.owner?.kind === "indicator") {
              onRemoveIndicator(pane.owner.id);
            }
          }}
        />
      </ChartErrorBoundary>
    </>
  );
}

function LocalDatasetWorkspace({
  manifest,
  interval,
  indicatorPresets,
  eventStore,
  focusRequest,
  datasets,
  importing,
  importJob,
  uploadProgress,
  onSelect,
  onImport,
  onCancelImport,
  management,
  analysis,
  indicatorPanelOpen,
  onCloseIndicatorPanel,
  onCrosshairMove,
  onActiveIndicatorCountChange,
  pageExportRef,
  settings,
  onSettingsChange,
  resolvedTheme,
}: {
  manifest: LocalDatasetManifest;
  interval: string;
  indicatorPresets: readonly IndicatorPreset[];
  eventStore: LocalAnalysisEventStore;
  focusRequest: LocalAnalysisFocusRequest | null;
  datasets: LocalDatasetManifest[];
  importing: boolean;
  importJob: LocalImportJob | null;
  uploadProgress: number | null;
  onSelect(datasetId: string): void;
  onImport: Parameters<typeof LocalImportForm>[0]["onImport"];
  onCancelImport(): void;
  management: ReactNode;
  analysis: ReactNode;
  indicatorPanelOpen: boolean;
  onCloseIndicatorPanel(): void;
  onCrosshairMove(value: MainSeriesCrosshairValue | null): void;
  onActiveIndicatorCountChange(count: number): void;
  pageExportRef: RefObject<HTMLDivElement | null>;
  settings: ChartSettings;
  onSettingsChange(settings: ChartSettings): void;
  resolvedTheme: string;
}) {
  const chartSurface = useChartSurfaceRuntime();
  const chartRuntime = useLocalChartRuntime(manifest, interval);
  const subscribeSeries = useCallback(
    (listener: () => void) => chartRuntime.seriesStore.subscribe(listener),
    [chartRuntime.seriesStore],
  );
  const getSeriesVersion = useCallback(
    () => Number(chartRuntime.seriesStore.version),
    [chartRuntime.seriesStore],
  );
  const seriesVersion = useSyncExternalStore(
    subscribeSeries,
    getSeriesVersion,
    getSeriesVersion,
  );
  const bars = useMemo(() => {
    void seriesVersion;
    return chartRuntime.seriesStore.snapshot();
  }, [chartRuntime.seriesStore, seriesVersion]);
  const dataMeta = useMemo(() => buildLocalChartDataMeta(
    chartRuntime.seriesStore,
    chartRuntime.loading || chartRuntime.loadingMore ? "loading" : "ready",
    seriesVersion,
  ), [
    chartRuntime.loading,
    chartRuntime.loadingMore,
    chartRuntime.seriesStore,
    seriesVersion,
  ]);
  const indicators = useLocalIndicatorRuntime({
    manifest,
    interval,
    bars,
    chartDataMeta: dataMeta,
    seriesVersion,
    candleUpColor: settings.upColor,
    candleDownColor: settings.downColor,
  });
  const drawings = useDrawingRuntime({
    chartSurfaceActions: chartSurface.actions,
    session: null,
  });
  const priceScale = usePriceScalePrefs({ loadUserPrefs, updateUserPref });
  const exportFlow = useExportRuntime({
    session: null,
    metadata: {
      exchange: "local",
      marketType: manifest.dataset_id,
      symbol: manifest.symbol,
      interval,
    },
    resolvedTheme,
    chartSurfaceActions: chartSurface.actions,
    pageExportRef,
    drawings,
    loadUserPrefs,
    updateUserPref,
  });
  const indicatorCatalog = useMemo(
    () => createLocalIndicatorCatalog(indicatorPresets),
    [indicatorPresets],
  );
  const savedVisibleRange = useMemo(() => getVisibleRangeForInterval(
    manifest.symbol,
    interval,
    manifest.dataset_id,
    "local",
  ), [interval, manifest.dataset_id, manifest.symbol]);
  const handleVisibleRangeChange = useCallback((range: unknown) => {
    saveVisibleRangeForInterval(
      manifest.symbol,
      interval,
      range,
      manifest.dataset_id,
      "local",
      dataMeta,
    );
  }, [dataMeta, interval, manifest.dataset_id, manifest.symbol]);
  const [drawingInteractionReady, setDrawingInteractionReady] = useState(false);
  const drawingTool = drawingToolWhenInteractionReady(
    drawings.view.drawingTool,
    drawingInteractionReady,
  );
  const removeIndicator = useCallback((indicatorId: string) => {
    drawings.actions.handleIndicatorRemoved(indicatorId);
    indicators.actions.removeIndicator(indicatorId);
  }, [drawings.actions, indicators.actions]);
  useEffect(() => {
    onActiveIndicatorCountChange(indicators.view.activeIndicators.length);
  }, [indicators.view.activeIndicators.length, onActiveIndicatorCountChange]);
  return (
    <>
      <MarketWorkspaceFrame
        toolbar={(
          <DrawingToolbar
            activeTool={drawingTool}
            onToolChange={drawings.actions.setDrawingTool}
            drawingInteractionReady={drawingInteractionReady}
            penColor={drawings.view.penColor}
            onPenColorChange={drawings.actions.setPenColor}
            penSize={drawings.view.penSize}
            onPenSizeChange={drawings.actions.setPenSize}
            onClearAll={drawings.actions.handleClearDrawing}
            drawingsHidden={drawings.view.drawingsHidden}
            onToggleDrawingsHidden={drawings.actions.handleToggleDrawingsHidden}
            drawingSnapEnabled={drawings.view.drawingSnapEnabled}
            onDrawingSnapEnabledChange={drawings.actions.handleDrawingSnapEnabledChange}
            drawingContinuousEnabled={drawings.view.drawingContinuousEnabled}
            onDrawingContinuousEnabledChange={drawings.actions.handleDrawingContinuousEnabledChange}
            textFontSize={drawings.view.textFontSize}
            onTextFontSizeChange={drawings.actions.setTextFontSize}
            textBold={drawings.view.textBold}
            onTextBoldChange={drawings.actions.setTextBold}
            textItalic={drawings.view.textItalic}
            onTextItalicChange={drawings.actions.setTextItalic}
            fibLevels={drawings.view.fibLevels}
            onFibLevelsChange={drawings.actions.handleFibLevelsChange}
            fibInverted={drawings.view.fibInverted}
            onFibInvertedChange={drawings.actions.handleFibInvertedChange}
            positionSize={drawings.view.positionSize}
            onPositionSizeChange={drawings.actions.handlePositionSizeChange}
            selectedDrawing={drawings.view.selectedDrawing}
            onSelectedDrawingStyleChange={drawings.actions.handleSelectedDrawingStyleChange}
            exportPanelOpen={exportFlow.view.isOpen}
            exportInProgress={exportFlow.status.inProgress}
            onToggleExportPanel={exportFlow.actions.togglePanel}
            chartType={settings.chartType}
            onChartTypeChange={(chartType) => onSettingsChange({ ...settings, chartType })}
          />
        )}
        exportOverlay={exportFlow.view.isOpen ? (
          <ExportPanel
            isOpen={exportFlow.view.isOpen}
            options={exportFlow.view.options}
            onOptionsChange={exportFlow.actions.updateOptions}
            onExport={exportFlow.actions.exportChart}
            onClose={exportFlow.actions.closePanel}
            inProgress={exportFlow.status.inProgress}
            error={exportFlow.view.error}
            notice={exportFlow.view.notice}
            metadata={exportFlow.view.metadata}
            loading={chartRuntime.loading || chartRuntime.loadingMore}
            indicatorComputing={indicators.status.computing}
            preview={exportFlow.view.preview}
          />
        ) : null}
        chart={(
          <LocalChart
            manifest={manifest}
            interval={interval}
            runtime={chartRuntime}
            dataMeta={dataMeta}
            eventStore={eventStore}
            focusRequest={focusRequest}
            indicators={indicators}
            chartSurfaceRef={chartSurface.ref}
            drawings={drawings}
            drawingTool={drawingTool}
            settings={settings}
            resolvedTheme={resolvedTheme}
            invertScale={priceScale.invertScale}
            priceScaleMode={priceScale.priceScaleMode}
            savedVisibleRange={savedVisibleRange}
            onVisibleRangeChange={handleVisibleRangeChange}
            onInvertScaleChange={priceScale.handleInvertScaleChange}
            onPriceScaleModeChange={priceScale.handlePriceScaleModeChange}
            onDrawingInteractionReadyChange={setDrawingInteractionReady}
            onRemoveIndicator={removeIndicator}
            onCrosshairMove={onCrosshairMove}
          />
        )}
        rightRail={(
          <LocalDatasetRail
            datasets={datasets}
            selectedId={manifest.dataset_id}
            importing={importing}
            importJob={importJob}
            uploadProgress={uploadProgress}
            onSelect={onSelect}
            onImport={onImport}
            onCancelImport={onCancelImport}
            management={management}
            analysis={analysis}
          />
        )}
      />
      <IndicatorPanel
        staticCatalog={indicatorCatalog}
        allowCustomIndicators={false}
        customIndicatorsUnavailableReason={t("local.offlineRuntime")}
        isOpen={indicatorPanelOpen}
        onClose={onCloseIndicatorPanel}
        activeIndicators={indicators.view.activeIndicators}
        paramSchemas={indicators.view.paramSchemas}
        onAddIndicator={indicators.actions.addIndicator}
        onRemoveIndicator={removeIndicator}
        onToggleVisibility={indicators.actions.toggleVisibility}
        onUpdateParams={indicators.actions.updateIndicatorParams}
        onUpdateScript={indicators.actions.updateIndicatorScript}
        computing={indicators.status.computing}
        realtimeMode="historical-only"
        onRecompute={indicators.actions.recompute}
        resolveIndicatorSupport={(indicator) => resolveLocalIndicatorSupport(
          indicator,
          manifest,
        )}
        modeNotice={{
          label: interval === manifest.interval ? t("local.csvSource") : t("local.derivedLabel", { interval }),
          description: interval === manifest.interval
            ? t("local.modeSource")
            : t("local.modeDerived", { interval, source: manifest.interval }),
        }}
      />
    </>
  );
}

function EmptyChart() {
  return (
    <div className="local-chart-empty">
      <div className="local-empty-icon">CSV</div>
      <h1>{t("local.emptyTitle")}</h1>
      <p>{t("local.emptyHint")}</p>
    </div>
  );
}

export default function LocalApp() {
  useLocale();
  const pageExportRef = useRef<HTMLDivElement | null>(null);
  const { settings, setSettings, resolvedTheme } = useChartSettingsRuntime();
  const [datasets, setDatasets] = useState<LocalDatasetManifest[]>([]);
  const [indicatorPresets, setIndicatorPresets] = useState<IndicatorPreset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importJob, setImportJob] = useState<LocalImportJob | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const importAbortRef = useRef<AbortController | null>(null);
  const importJobRef = useRef<LocalImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [indicatorPanelOpen, setIndicatorPanelOpen] = useState(false);
  const [activeIndicatorCount, setActiveIndicatorCount] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lastCrosshair, setLastCrosshair] = useState<MainSeriesCrosshairValue | null>(null);
  const [focusRequest, setFocusRequest] = useState<LocalAnalysisFocusRequest | null>(null);
  const [intervalSelection, setIntervalSelection] = useState<{
    scope: string;
    value: string;
  } | null>(null);

  const refresh = useCallback(async (preferredId?: string) => {
    const loaded = await listLocalDatasets();
    setDatasets(loaded);
    setSelectedId((current) => {
      const candidate = preferredId ?? current;
      if (candidate && loaded.some((dataset) => dataset.dataset_id === candidate)) return candidate;
      return loaded[0]?.dataset_id ?? null;
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingLibrary(true);
    Promise.all([
      listLocalDatasets(controller.signal),
      fetchLocalIndicatorPresets(controller.signal),
    ]).then(([loaded, presets]) => {
      setDatasets(loaded);
      setIndicatorPresets(presets);
      setSelectedId(loaded[0]?.dataset_id ?? null);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingLibrary(false);
    });
    return () => controller.abort();
  }, []);

  const selected = useMemo(
    () => datasets.find((dataset) => dataset.dataset_id === selectedId) ?? null,
    [datasets, selectedId],
  );
  const intervalScope = selected === null
    ? null
    : `${selected.dataset_id}:${selected.data_epoch}`;
  const selectedInterval = useMemo(() => {
    if (selected === null) return null;
    if (intervalSelection?.scope !== intervalScope) return selected.interval;
    const support = resolveLocalIntervalSupport(selected, intervalSelection.value);
    return support.supported ? support.target : selected.interval;
  }, [intervalScope, intervalSelection, selected]);

  useEffect(() => {
    if (selected === null || intervalScope === null) {
      setIntervalSelection(null);
      return;
    }
    const storageKey = `candlescope:local-interval:v1:${intervalScope}`;
    let value = selected.interval;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored !== null) {
        const support = resolveLocalIntervalSupport(selected, stored);
        if (support.supported) value = support.target;
      }
    } catch {
      // Storage availability must not block local chart access.
    }
    setIntervalSelection({ scope: intervalScope, value });
  }, [intervalScope, selected]);

  const handleIntervalSelect = useCallback((value: string) => {
    if (selected === null || intervalScope === null) return;
    const support = resolveLocalIntervalSupport(selected, value);
    if (!support.supported) {
      setError(support.message);
      return;
    }
    setIntervalSelection({ scope: intervalScope, value: support.target });
    setError(null);
    try {
      window.localStorage.setItem(
        `candlescope:local-interval:v1:${intervalScope}`,
        support.target,
      );
    } catch {
      // The selection still works for this session when persistence is unavailable.
    }
  }, [intervalScope, selected]);
  const analysisStore = useMemo(() => selected === null ? null : new LocalAnalysisEventStore({
    datasetId: selected.dataset_id,
    dataEpoch: selected.data_epoch,
  }), [selected]);
  const subscribeAnalysis = useCallback((listener: () => void) => (
    analysisStore?.subscribe(listener) ?? (() => undefined)
  ), [analysisStore]);
  const getAnalysisSnapshot = useCallback(() => (
    analysisStore?.getSnapshot() ?? EMPTY_LOCAL_ANALYSIS_SNAPSHOT
  ), [analysisStore]);
  const analysisSnapshot = useSyncExternalStore(
    subscribeAnalysis,
    getAnalysisSnapshot,
    () => EMPTY_LOCAL_ANALYSIS_SNAPSHOT,
  );

  useEffect(() => {
    setLastCrosshair(null);
    setFocusRequest(null);
    setIndicatorPanelOpen(false);
    setActiveIndicatorCount(0);
  }, [selected?.data_epoch, selected?.dataset_id]);

  useEffect(() => {
    setLastCrosshair(null);
    setFocusRequest(null);
  }, [selectedInterval]);

  const focusAnalysisEvent = useCallback((event: LocalAnalysisEvent) => {
    setFocusRequest((current) => ({
      requestId: (current?.requestId ?? 0) + 1,
      time: event.time,
    }));
  }, []);

  const handleImport: Parameters<typeof LocalImportForm>[0]["onImport"] = async (input) => {
    setImporting(true);
    setImportJob(null);
    setUploadProgress(0);
    setError(null);
    const controller = new AbortController();
    importAbortRef.current = controller;
    try {
      let job = await createLocalImportJob(input, {
        signal: controller.signal,
        onUploadProgress: setUploadProgress,
      });
      importJobRef.current = job;
      setImportJob(job);
      setUploadProgress(1);
      while (job.status === "queued" || job.status === "running") {
        await wait(250);
        job = await getLocalImportJob(job.job_id);
        importJobRef.current = job;
        setImportJob(job);
      }
      if (job.status === "completed" && job.dataset !== null) {
        await refresh(job.dataset.dataset_id);
      } else if (job.status !== "cancelled") {
        throw new LocalDataApiError(
          job.error?.message ?? t("local.importFailed"),
          422,
          job.error?.code ?? "import_failed",
        );
      }
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(errorMessage(reason));
      throw reason;
    } finally {
      importAbortRef.current = null;
      importJobRef.current = null;
      setImporting(false);
      setImportJob(null);
      setUploadProgress(null);
    }
  };

  const cancelImport = useCallback(() => {
    importAbortRef.current?.abort();
    const jobId = importJobRef.current?.job_id;
    if (jobId !== undefined) {
      void cancelLocalImportJob(jobId).then((job) => {
        importJobRef.current = job;
        setImportJob(job);
      }).catch((reason: unknown) => setError(errorMessage(reason)));
    }
  }, []);

  const management = (
    <LocalDatasetManagement
      manifest={selected}
      settings={settings}
      events={analysisSnapshot.events}
      onChanged={refresh}
      onSettingsImported={setSettings}
      onError={setError}
    />
  );

  return (
    <MarketPageFrame
      rootRef={pageExportRef}
      topBar={(
        <MarketTopBarFrame
          source="local"
          brandIcon="◫"
          brandText="CandleScope Analyze"
          identity={selected ? (
            <div className="local-top-identity">
              <strong>{selected.symbol}</strong>
              <span>{selected.name}</span>
            </div>
          ) : null}
          controls={<>
            <button
              type="button"
              className="settings-btn"
              onClick={() => setSettingsOpen(true)}
              title={t("shell.settings")}
              aria-label={t("shell.settings")}
            >
              ⚙️
            </button>
            <button
              type="button"
              className={`indicator-toggle-btn ${indicatorPanelOpen ? "active" : ""}`}
              disabled={selected === null}
              onClick={() => setIndicatorPanelOpen((open) => !open)}
              title={t("shell.indicators")}
            >
              📊
              {activeIndicatorCount > 0 && (
                <span className="indicator-badge">{activeIndicatorCount}</span>
              )}
            </button>
            <span className="local-offline-badge">{t("local.badge")}</span>
          </>}
          trailing={<span className="local-network-truth">{t("local.trailing")}</span>}
        />
      )}
      intervalSelector={(
        <div className="local-interval-strip">
          {selected !== null && selectedInterval !== null && (
            <LocalIntervalSelector
              key={intervalScope}
              manifest={selected}
              interval={selectedInterval}
              onSelect={handleIntervalSelect}
            />
          )}
          <div className="local-dataset-truthbar">
            <span>{selected ? `${selectedInterval}${selectedInterval === selected.interval ? t("local.sourceData") : t("local.derived", { interval: selected.interval })} · ${selected.timezone} · ${formatRows(selected.rows)} source bars · ${selected.volume_available ? "OHLCV" : t("local.volumeUnavailable")}` : t("local.waitData")}</span>
            <span>{selected ? `dataEpoch ${selected.data_epoch.slice(7, 19)}` : "source: local_dataset"}</span>
          </div>
        </div>
      )}
      workspace={(
        selected && analysisStore ? (
          <LocalDatasetWorkspace
            key={selected.data_epoch}
            manifest={selected}
            interval={selectedInterval ?? selected.interval}
            indicatorPresets={indicatorPresets}
            eventStore={analysisStore}
            focusRequest={focusRequest}
            datasets={datasets}
            importing={importing}
            importJob={importJob}
            uploadProgress={uploadProgress}
            onSelect={setSelectedId}
            onImport={handleImport}
            onCancelImport={cancelImport}
            management={management}
            indicatorPanelOpen={indicatorPanelOpen}
            onCloseIndicatorPanel={() => setIndicatorPanelOpen(false)}
            analysis={(
              <LocalAnalysisPanel
                key={selected.data_epoch}
                manifest={selected}
                snapshot={analysisSnapshot}
                eventStore={analysisStore}
                crosshair={lastCrosshair}
                onFocus={focusAnalysisEvent}
                onError={setError}
              />
            )}
            onCrosshairMove={(value) => {
              if (value !== null) setLastCrosshair(value);
            }}
            onActiveIndicatorCountChange={setActiveIndicatorCount}
            pageExportRef={pageExportRef}
            settings={settings}
            onSettingsChange={setSettings}
            resolvedTheme={resolvedTheme}
          />
        ) : (
          <MarketWorkspaceFrame
            toolbar={null}
            exportOverlay={null}
            chart={<EmptyChart />}
            rightRail={(
              <LocalDatasetRail
                datasets={datasets}
                selectedId={selectedId}
                importing={importing}
                importJob={importJob}
                uploadProgress={uploadProgress}
                onSelect={setSelectedId}
                onImport={handleImport}
                onCancelImport={cancelImport}
                management={management}
                analysis={null}
              />
            )}
          />
        )
      )}
      featureSurfaces={(
        <>
          {error !== null && (
            <div className="local-global-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)}>{t("backtest.close")}</button>
            </div>
          )}
          <SettingsModal
            isOpen={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            settings={settings}
            onUpdate={setSettings}
            currentSymbol={selected?.symbol ?? ""}
            currentMarketType={selected?.dataset_id ?? "local"}
            currentExchange="local"
            allowedCategories={["appearance", "about"]}
            backendFeaturesEnabled={false}
            dataWorkbenchEnabled={false}
          />
        </>
      )}
      statusBar={(
        <MarketStatusBar
          source="local"
          connectionStatus={error === null ? "offline-ready" : "error"}
          left={<><span className="status-dot connected" />{t("local.status.ready")}</>}
          right={selected ? <>{t("local.statusRight", { events: analysisSnapshot.events.length, gaps: selected.excluded_range_count, date: formatDate(selected.imported_at) })}</> : loadingLibrary ? t("local.waitingLibrary") : t("local.noDataset")}
        />
      )}
    />
  );
}
