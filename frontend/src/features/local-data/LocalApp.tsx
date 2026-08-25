import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { t } from "../../i18n/index.js";
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
import type {
  LocalDatasetManifest,
  LocalImportJob,
} from "./localDataTypes.js";
import { ResearchDatasetManagement } from "../research-data/ResearchDatasetManagement.js";
import { ResearchDatasetRail } from "../research-data/ResearchDatasetRail.js";
import {
  formatResearchDate,
  formatResearchRows,
} from "../research-data/researchDataFormat.js";
import {
  useResearchDataLibrary,
  type ResearchImportSubmitInput,
} from "../research-data/useResearchDataLibrary.js";
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
  onImport(input: ResearchImportSubmitInput): Promise<void>;
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
          <ResearchDatasetRail
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
  const [intervalSelection, setIntervalSelection] = useState<{
    scope: string;
    value: string;
  } | null>(null);

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
  }, [intervalScope, selected, setError]);
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
            <span>{selected ? `${selectedInterval}${selectedInterval === selected.interval ? t("local.sourceData") : t("local.derived", { interval: selected.interval })} · ${selected.timezone} · ${formatResearchRows(selected.rows)} source bars · ${selected.volume_available ? "OHLCV" : t("local.volumeUnavailable")}` : t("local.waitData")}</span>
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
              <ResearchDatasetRail
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
          right={selected ? <>{t("local.statusRight", { events: analysisSnapshot.events.length, gaps: selected.excluded_range_count, date: formatResearchDate(selected.imported_at) })}</> : loadingLibrary ? t("local.waitingLibrary") : t("local.noDataset")}
        />
      )}
    />
  );
}
