import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";

import SingleChartPanes from "../../components/SingleChartPanes.js";
import type { MainSeriesCrosshairValue } from "../../chart-adapter/chartAdapterTypes.js";
import { useChartSurfaceRuntime } from "../../chart-adapter/useChartSurfaceRuntime.js";
import { ChartErrorBoundary } from "../../app/AppProviders.js";
import { drawingToolWhenInteractionReady } from "../../app/drawingInteractionReadiness.js";
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
import { t } from "../../i18n/index.js";
import type { LocalDatasetManifest } from "../local-data/localDataTypes.js";
import {
  formatResearchRows,
} from "../research-data/researchDataFormat.js";
import LocalAnalysisPanel from "../local-data/LocalAnalysisPanel.js";
import LocalIntervalSelector from "../local-data/LocalIntervalSelector.js";
import { createLocalAnalysisMarkerSource } from "../local-data/localAnalysisMarkerSource.js";
import type { LocalAnalysisEventStore } from "../local-data/localAnalysisStore.js";
import type {
  LocalAnalysisEvent,
  LocalAnalysisFocusRequest,
  LocalAnalysisSnapshot,
} from "../local-data/localAnalysisTypes.js";
import {
  buildLocalChartDataMeta,
  useLocalChartRuntime,
} from "../local-data/useLocalChartRuntime.js";
import { useLocalIndicatorRuntime } from "../local-data/useLocalIndicatorRuntime.js";
import type { IndicatorRuntime } from "../indicators/indicatorRuntimeContract.js";
import type { IndicatorPreset } from "../indicators/indicatorTypes.js";
import IndicatorPanel from "../indicators/IndicatorPanel.js";
import { useDrawingRuntime } from "../drawings/useDrawingRuntime.js";
import type { DrawingRuntime } from "../drawings/useDrawingRuntime.js";
import type { DrawingToolId } from "../drawings/drawingTypes.js";
import type { ChartSettings } from "../settings/chartAppearanceSettings.js";
import { usePriceScalePrefs } from "../settings/priceScalePrefsRuntime.js";
import {
  createLocalIndicatorCatalog,
  resolveLocalIndicatorSupport,
} from "../local-data/localIndicatorCatalog.js";
import {
  importedChartDatasetKey,
  importedDrawingKeyBase,
} from "./importedDatasetSource.js";


export function EmptyImportedChart() {
  return (
    <div className="local-chart-empty" data-testid="strategy-research-empty-chart">
      <div className="local-empty-icon">CSV</div>
      <h1>{t("local.emptyTitle")}</h1>
      <p>{t("local.emptyHint")}</p>
    </div>
  );
}

export function ImportedDatasetIntervalStrip({
  manifest,
  interval,
  intervalScope,
  onSelect,
}: {
  manifest: LocalDatasetManifest;
  interval: string;
  intervalScope: string | null;
  onSelect(interval: string): void;
}) {
  return (
    <div className="local-interval-strip" data-testid="strategy-research-interval-strip">
      <LocalIntervalSelector
        key={intervalScope}
        manifest={manifest}
        interval={interval}
        onSelect={onSelect}
      />
      <div className="local-dataset-truthbar">
        <span>
          {`${interval}${interval === manifest.interval ? t("local.sourceData") : t("local.derived", { interval: manifest.interval })} · ${manifest.timezone} · ${formatResearchRows(manifest.rows)} source bars · ${manifest.volume_available ? "OHLCV" : t("local.volumeUnavailable")}`}
        </span>
        <span>{`dataEpoch ${manifest.data_epoch.slice(7, 19)}`}</span>
      </div>
    </div>
  );
}

function StrategyResearchChartPanes({
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
    <div
      className="strategy-research-imported-chart"
      data-testid="strategy-research-imported-chart"
      data-dataset-id={manifest.dataset_id}
      data-data-epoch={manifest.data_epoch}
      data-interval={interval}
    >
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
          drawingKeyBase={importedDrawingKeyBase(manifest)}
          interval={interval}
          loading={runtime.loading || runtime.loadingMore}
          dataMeta={dataMeta}
          onCrosshairMove={onCrosshairMove}
          onNeedMoreLeft={runtime.loadMoreLeft}
          canLoadMoreLeft={runtime.hasMoreLeft}
          canRestoreLatestWindow={false}
          datasetKey={importedChartDatasetKey(manifest, interval)}
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
    </div>
  );
}

export type StrategyResearchImportedChrome = {
  toolbar: ReactNode;
  exportOverlay: ReactNode;
  chart: ReactNode;
  indicatorPanel: ReactNode;
};

export function StrategyResearchImportedWorkspace({
  manifest,
  interval,
  indicatorPresets,
  eventStore,
  focusRequest,
  indicatorPanelOpen,
  onCloseIndicatorPanel,
  onCrosshairMove,
  onActiveIndicatorCountChange,
  pageExportRef,
  settings,
  onSettingsChange,
  resolvedTheme,
  children,
}: {
  manifest: LocalDatasetManifest;
  interval: string;
  indicatorPresets: readonly IndicatorPreset[];
  eventStore: LocalAnalysisEventStore;
  focusRequest: LocalAnalysisFocusRequest | null;
  indicatorPanelOpen: boolean;
  onCloseIndicatorPanel(): void;
  onCrosshairMove(value: MainSeriesCrosshairValue | null): void;
  onActiveIndicatorCountChange(count: number): void;
  pageExportRef: RefObject<HTMLDivElement | null>;
  settings: ChartSettings;
  onSettingsChange(settings: ChartSettings): void;
  resolvedTheme: string;
  children(parts: StrategyResearchImportedChrome): ReactNode;
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

  const toolbar = (
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
  );
  const exportOverlay = exportFlow.view.isOpen ? (
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
  ) : null;
  const chart = (
    <StrategyResearchChartPanes
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
  );
  const indicatorPanel = (
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
  );

  return <>{children({ toolbar, exportOverlay, chart, indicatorPanel })}</>;
}

export function ImportedAnalysisPanel({
  manifest,
  snapshot,
  eventStore,
  crosshair,
  onFocus,
  onError,
}: {
  manifest: LocalDatasetManifest;
  snapshot: LocalAnalysisSnapshot;
  eventStore: LocalAnalysisEventStore;
  crosshair: MainSeriesCrosshairValue | null;
  onFocus(event: LocalAnalysisEvent): void;
  onError(message: string | null): void;
}) {
  return (
    <LocalAnalysisPanel
      key={manifest.data_epoch}
      manifest={manifest}
      snapshot={snapshot}
      eventStore={eventStore}
      crosshair={crosshair}
      onFocus={onFocus}
      onError={onError}
    />
  );
}
