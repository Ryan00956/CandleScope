import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import type { MainSeriesCrosshairValue } from "../../chart-adapter/chartAdapterTypes.js";
import MarketPageFrame from "../../app/MarketPageFrame.js";
import MarketStatusBar from "../../app/MarketStatusBar.js";
import MarketTopBarFrame from "../../app/MarketTopBarFrame.js";
import MarketWorkspaceFrame from "../../app/MarketWorkspaceFrame.js";
import type { LocalDatasetManifest } from "./localDataTypes.js";
import { ResearchDatasetManagement } from "../research-data/ResearchDatasetManagement.js";
import { ResearchDatasetRail } from "../research-data/ResearchDatasetRail.js";
import { formatResearchDate } from "../research-data/researchDataFormat.js";
import { useResearchDataLibrary } from "../research-data/useResearchDataLibrary.js";
import {
  EMPTY_LOCAL_ANALYSIS_SNAPSHOT,
  LocalAnalysisEventStore,
} from "./localAnalysisStore.js";
import type {
  LocalAnalysisEvent,
  LocalAnalysisFocusRequest,
} from "./localAnalysisTypes.js";
import { useLocalIntervalSelection } from "./useLocalIntervalSelection.js";
import SettingsModal from "../settings/SettingsModal.js";
import { useChartSettingsRuntime } from "../settings/chartAppearanceSettings.js";
import {
  EmptyImportedChart,
  ImportedAnalysisPanel,
  ImportedDatasetIntervalStrip,
  StrategyResearchImportedWorkspace,
} from "../strategy-research/StrategyResearchChart.js";


export default function LocalApp() {
  useLocale();
  const pageExportRef = useRef<HTMLDivElement | null>(null);
  const { settings, setSettings, resolvedTheme } = useChartSettingsRuntime();
  const library = useResearchDataLibrary();
  const {
    datasets,
    indicatorPresets,
    selectedId,
    selected,
    loadingLibrary,
    importing,
    importJob,
    uploadProgress,
    error,
    setError,
    setSelectedId,
    refresh,
    handleImport,
    cancelImport,
  } = library;
  const [indicatorPanelOpen, setIndicatorPanelOpen] = useState(false);
  const [activeIndicatorCount, setActiveIndicatorCount] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lastCrosshair, setLastCrosshair] = useState<MainSeriesCrosshairValue | null>(null);
  const [focusRequest, setFocusRequest] = useState<LocalAnalysisFocusRequest | null>(null);
  const { intervalScope, selectedInterval, handleIntervalSelect } = useLocalIntervalSelection(
    selected,
    (message) => setError(message),
  );

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

  const management = (
    <ResearchDatasetManagement
      manifest={selected}
      settings={settings}
      events={analysisSnapshot.events}
      onChanged={refresh}
      onSettingsImported={setSettings}
      onError={setError}
    />
  );

  const analysis = selected !== null && analysisStore !== null ? (
    <ImportedAnalysisPanel
      manifest={selected}
      snapshot={analysisSnapshot}
      eventStore={analysisStore}
      crosshair={lastCrosshair}
      onFocus={focusAnalysisEvent}
      onError={setError}
    />
  ) : null;

  const railFor = (manifest: LocalDatasetManifest | null) => (
    <ResearchDatasetRail
      datasets={datasets}
      selectedId={manifest?.dataset_id ?? selectedId}
      importing={importing}
      importJob={importJob}
      uploadProgress={uploadProgress}
      onSelect={setSelectedId}
      onImport={handleImport}
      onCancelImport={cancelImport}
      management={management}
      analysis={manifest === null ? null : analysis}
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
      intervalSelector={
        selected !== null && selectedInterval !== null ? (
          <ImportedDatasetIntervalStrip
            manifest={selected}
            interval={selectedInterval}
            intervalScope={intervalScope}
            onSelect={handleIntervalSelect}
          />
        ) : (
          <div className="local-interval-strip">
            <div className="local-dataset-truthbar">
              <span>{t("local.waitData")}</span>
              <span>{t("local.sourceKind")}</span>
            </div>
          </div>
        )
      }
      workspace={(
        selected && analysisStore && selectedInterval ? (
          <StrategyResearchImportedWorkspace
            key={selected.data_epoch}
            manifest={selected}
            interval={selectedInterval}
            indicatorPresets={indicatorPresets}
            eventStore={analysisStore}
            focusRequest={focusRequest}
            indicatorPanelOpen={indicatorPanelOpen}
            onCloseIndicatorPanel={() => setIndicatorPanelOpen(false)}
            onCrosshairMove={(value) => {
              if (value !== null) setLastCrosshair(value);
            }}
            onActiveIndicatorCountChange={setActiveIndicatorCount}
            pageExportRef={pageExportRef}
            settings={settings}
            onSettingsChange={setSettings}
            resolvedTheme={resolvedTheme}
          >
            {({ toolbar, exportOverlay, chart, indicatorPanel }) => (
              <>
                <MarketWorkspaceFrame
                  toolbar={toolbar}
                  exportOverlay={exportOverlay}
                  chart={chart}
                  rightRail={railFor(selected)}
                />
                {indicatorPanel}
              </>
            )}
          </StrategyResearchImportedWorkspace>
        ) : (
          <MarketWorkspaceFrame
            toolbar={null}
            exportOverlay={null}
            chart={<EmptyImportedChart />}
            rightRail={railFor(null)}
          />
        )
      )}
      featureSurfaces={(
        <>
          <span data-testid="local-app-compat-shell" hidden />
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
          right={selected ? <>{t("local.statusRight", { events: analysisSnapshot.events.length, gaps: selected.excluded_range_count, date: formatResearchDate(selected.imported_at) })}</> : loadingLibrary ? t("local.waitingLibrary") : t("local.noDataset")}
        />
      )}
    />
  );
}
