import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import IntervalSelector from "../components/IntervalSelector.js";
import { useChartSurfaceRuntime } from "../chart-adapter/useChartSurfaceRuntime.js";
import type { ChartSurfaceVisibleRange } from "../chart-adapter/useChartSurfaceRuntime.js";
import type { MainSeriesCrosshairValue } from "../chart-adapter/chartAdapterTypes.js";
import { useChartSession } from "../features/chart-session/useChartSession.js";
import type { ChartSession } from "../features/chart-session/chartSessionTypes.js";
import type {
  ChartCellCreationMode,
  ChartCellId,
  ChartCellState,
  ChartLinkGroupId,
  ChartWorkspaceCellRole,
  ChartWorkspaceId,
  ChartWorkspaceSplitDirection,
} from "../features/chart-workspace/chartWorkspaceTypes.js";
import { CHART_LINK_GROUP_IDS } from "../features/chart-workspace/chartWorkspaceTypes.js";
import { chartCellStorageScope } from "../features/chart-workspace/chartWorkspaceLibrary.js";
import type { ChartLinkCoordinator } from "../features/chart-workspace/chartLinkCoordinator.js";
import { writeChartCellDragData } from "../features/chart-workspace/chartWorkspaceDrag.js";
import WorkspaceCellLayoutMenu from "../features/chart-workspace/WorkspaceCellLayoutMenu.js";
import { useMarketDataRuntime } from "../features/market-data/useMarketDataRuntime.js";
import type { ForegroundPreloadGate } from "../features/market-data/foregroundPreloadGate.js";
import { useAdvancedMarketDataRuntime } from "../features/advanced-market-data/useAdvancedMarketDataRuntime.js";
import { useDrawingRuntime } from "../features/drawings/useDrawingRuntime.js";
import { useIndicatorRuntime } from "../features/indicators/useIndicatorRuntime.js";
import type { ActiveIndicatorPersistence } from "../features/indicators/activeIndicatorStore.js";
import { useExportRuntime } from "../features/export/useExportRuntime.js";
import type { ChartSettingsRuntime } from "../features/settings/chartAppearanceSettings.js";
import { normalizeSettings } from "../features/settings/chartAppearanceSettings.js";
import { useOrderBookRuntime } from "../features/order-book/useOrderBookRuntime.js";
import { useTradeFlowRuntime } from "../features/trade-flow/useTradeFlowRuntime.js";
import type { WatchlistRuntime } from "../features/watchlist/useWatchlistRuntime.js";
import type { WatchlistSubscriptionContext } from "../features/watchlist/watchlistSubscriptionRuntime.js";
import { usePluginPlatformRuntime } from "../features/plugins/usePluginPlatformRuntime.js";
import PluginPlatformSurfaces, { PluginUiErrorBoundary } from "../features/plugins/PluginPlatformSurfaces.js";
import PluginPlatformToolbar from "../features/plugins/PluginPlatformToolbar.js";
import PluginPlatformStatus from "../features/plugins/PluginPlatformStatus.js";
import PluginLiveControl from "../features/plugins/PluginLiveControl.js";
import { LIVE_RAIL_VIEW_IDS } from "../shared/marketRailLayout.js";
import { buildAppShellViewModel } from "./appShellViewModel.js";
import type {
  AlertsShellRuntime,
  IndicatorShellRuntime,
  PriceScaleShellRuntime,
  SettingsShellRuntime,
} from "./appShellContracts.js";
import type { ChartWorkspaceRailLayout } from "./ChartWorkspace.js";
import type { ReplayEntryCapabilityView } from "../features/replay/useReplayEntryCapability.js";
import { loadUserPrefs, updateUserPref } from "../features/chart-session/chartSessionModel.js";
import { preloadDrawingEngineHost } from "../features/drawings/drawingEngineLoader.js";
import { drawingToolWhenInteractionReady } from "./drawingInteractionReadiness.js";
import ChartCellCanvas from "./ChartCellCanvas.js";
import LazyFeatureSurfaces from "./LazyFeatureSurfaces.js";
import StatusBar from "./StatusBar.js";
import TopBar from "./TopBar.js";

const ExportPanel = lazy(() => import("../features/export/ExportPanel.js"));
const DrawingToolbar = lazy(() => {
  preloadDrawingEngineHost();
  return import("../features/drawings/DrawingToolbar.js");
});
const RightMarketRail = lazy(() => import("./RightMarketRail.js"));

export interface WorkspacePortalHosts {
  topBar: HTMLElement | null;
  intervalSelector: HTMLElement | null;
  drawingToolbar: HTMLElement | null;
  rightRail: HTMLElement | null;
  featureSurfaces: HTMLElement | null;
  statusBar: HTMLElement | null;
}

export interface ActiveChartEnvironment {
  subscriptionContext: WatchlistSubscriptionContext;
  marketDataReady: boolean;
  cacheDiagnostics: () => Record<string, unknown>;
  trimCacheEntries: ReturnType<typeof useMarketDataRuntime>["status"]["trimCacheEntries"];
}

export interface LiveChartCellProps {
  workspaceId: ChartWorkspaceId;
  cell: ChartCellState;
  linkedDrawingScopeBase: string;
  layoutRole: ChartWorkspaceCellRole | null;
  active: boolean;
  maximized: boolean;
  layoutCellIds: readonly ChartCellId[];
  layoutEditingDisabled?: boolean;
  pageExportRef: RefObject<HTMLDivElement | null>;
  foregroundPreloadGate: ForegroundPreloadGate;
  globalSettings: ChartSettingsRuntime;
  watchlist: WatchlistRuntime;
  marketRail: ChartWorkspaceRailLayout;
  replayEntry: ReplayEntryCapabilityView;
  portalHosts: WorkspacePortalHosts;
  workspaceControls: ReactNode;
  linkCoordinator: ChartLinkCoordinator;
  onActivate(cellId: ChartCellId): void;
  onLinkGroupChange(cellId: ChartCellId, group: ChartLinkGroupId | null): void;
  onSplitCell(
    cellId: ChartCellId,
    direction: ChartWorkspaceSplitDirection,
    creationMode: ChartCellCreationMode,
  ): void;
  onCloseCell(cellId: ChartCellId): void;
  onSwapCells(firstCellId: ChartCellId, secondCellId: ChartCellId): void;
  onToggleMaximize(cellId: ChartCellId): void;
  onSessionChange(cellId: ChartCellId, session: ChartSession): void;
  onChartSettingsChange(cellId: ChartCellId, settings: ReturnType<typeof normalizeSettings>): void;
  onPriceScaleChange(cellId: ChartCellId, value: ChartCellState["priceScale"]): void;
  onIndicatorsChange(cellId: ChartCellId, indicators: ChartCellState["indicators"]): void;
  onOpenReplayLauncher(): void;
  onActiveEnvironmentChange(cellId: ChartCellId, environment: ActiveChartEnvironment): void;
}

function LiveChartCell({
  workspaceId,
  cell,
  linkedDrawingScopeBase,
  layoutRole,
  active,
  maximized,
  layoutCellIds,
  layoutEditingDisabled = false,
  pageExportRef,
  foregroundPreloadGate,
  globalSettings,
  watchlist,
  marketRail,
  replayEntry,
  portalHosts,
  workspaceControls,
  linkCoordinator,
  onActivate,
  onLinkGroupChange,
  onSplitCell,
  onCloseCell,
  onSwapCells,
  onToggleMaximize,
  onSessionChange,
  onChartSettingsChange,
  onPriceScaleChange,
  onIndicatorsChange,
  onOpenReplayLauncher,
  onActiveEnvironmentChange,
}: LiveChartCellProps) {
  const chartSurface = useChartSurfaceRuntime();
  const cellStorageScope = chartCellStorageScope(workspaceId, cell.id);
  const realtimePriceRef = useRef<number | null>(null);
  const handleSessionChange = useCallback((session: ChartSession) => {
    onSessionChange(cell.id, session);
  }, [cell.id, onSessionChange]);
  const chartSession = useChartSession({
    chartSurfaceActions: chartSurface.actions,
    initialSession: cell.session,
    controlledSession: cell.session,
    onSessionChange: handleSessionChange,
    visibleRangeScope: cellStorageScope,
  });
  useEffect(
    () => linkCoordinator.register(cell.id, chartSurface.actions, workspaceId),
    [cell.id, chartSurface.actions, linkCoordinator, workspaceId],
  );
  const plugins = usePluginPlatformRuntime({
    exchange: chartSession.view.exchange,
    marketType: chartSession.view.marketType,
    symbol: chartSession.view.symbol,
    interval: chartSession.view.interval,
  });
  const marketData = useMarketDataRuntime({
    session: chartSession,
    realtimePriceRef,
    foregroundPreloadGate,
    backgroundPrefetchEnabled: active,
  });
  const advancedMarketData = useAdvancedMarketDataRuntime({
    session: chartSession,
    dataMeta: marketData.view.meta,
    seriesStore: marketData.view.seriesStore,
  });
  const drawingScopeBase = linkedDrawingScopeBase;
  const drawings = useDrawingRuntime({
    chartSurfaceActions: chartSurface.actions,
    drawingScopeBase,
    session: chartSession,
  });

  const combinedSettings = useMemo(() => normalizeSettings({
    ...globalSettings.settings,
    ...cell.chartSettings,
  }), [cell.chartSettings, globalSettings.settings]);
  const combinedSettingsRef = useRef(combinedSettings);
  useLayoutEffect(() => {
    combinedSettingsRef.current = combinedSettings;
  }, [combinedSettings]);
  const setCombinedSettings = useCallback<Dispatch<SetStateAction<ReturnType<typeof normalizeSettings>>>>((action) => {
    const current = combinedSettingsRef.current;
    const next = normalizeSettings(typeof action === "function" ? action(current) : action);
    onChartSettingsChange(cell.id, next);
    globalSettings.setSettings(next);
  }, [cell.id, globalSettings, onChartSettingsChange]);

  const [priceScale, setPriceScale] = useState(cell.priceScale);
  const setInvertScale = useCallback((invertScale: boolean) => {
    setPriceScale((current) => {
      const next = { ...current, invertScale };
      onPriceScaleChange(cell.id, next);
      return next;
    });
  }, [cell.id, onPriceScaleChange]);
  const setPriceScaleMode = useCallback((priceScaleMode: number) => {
    setPriceScale((current) => {
      const next = { ...current, priceScaleMode };
      onPriceScaleChange(cell.id, next);
      return next;
    });
  }, [cell.id, onPriceScaleChange]);

  const [initialIndicators] = useState(cell.indicators);
  const indicatorPersistence = useMemo<ActiveIndicatorPersistence>(() => ({
    load: () => initialIndicators,
    save: (indicators) => onIndicatorsChange(cell.id, indicators),
  }), [cell.id, initialIndicators, onIndicatorsChange]);

  const [showSettings, setShowSettings] = useState(false);
  const [showIndicatorPanel, setShowIndicatorPanel] = useState(false);
  const [showAlertsPanel, setShowAlertsPanel] = useState(false);
  const openIndicatorPanel = useCallback(() => setShowIndicatorPanel(true), []);
  const closeIndicatorPanel = useCallback(() => setShowIndicatorPanel(false), []);
  const toggleIndicatorPanel = useCallback(() => setShowIndicatorPanel((value) => !value), []);
  const openSettingsPanel = useCallback(() => setShowSettings(true), []);
  const closeSettingsPanel = useCallback(() => setShowSettings(false), []);
  const openAlertsPanel = useCallback(() => setShowAlertsPanel(true), []);
  const closeAlertsPanel = useCallback(() => setShowAlertsPanel(false), []);
  const toggleAlertsPanel = useCallback(() => setShowAlertsPanel((value) => !value), []);

  const indicators = useIndicatorRuntime({
    session: chartSession,
    marketData,
    candleUpColor: combinedSettings.upColor,
    candleDownColor: combinedSettings.downColor,
    getCurrentVisibleRange: chartSurface.actions.getVisibleRange,
    onIndicatorRemoved: drawings.actions.handleIndicatorRemoved,
    indicatorPersistence,
  });
  const exportFlow = useExportRuntime({
    session: chartSession,
    resolvedTheme: globalSettings.resolvedTheme,
    chartSurfaceActions: chartSurface.actions,
    pageExportRef,
    drawings,
    loadUserPrefs,
    updateUserPref,
  });

  const orderBookOpen = active && marketRail.openViewIds.includes(LIVE_RAIL_VIEW_IDS.orderBook);
  const tradeFlowOpen = active && (
    marketRail.openViewIds.includes(LIVE_RAIL_VIEW_IDS.tape)
    || marketRail.openViewIds.includes(LIVE_RAIL_VIEW_IDS.profile)
  );
  const orderBook = useOrderBookRuntime({
    identity: {
      exchange: chartSession.view.exchange,
      marketType: chartSession.view.marketType,
      symbol: chartSession.view.symbol,
    },
    orderBookOpen,
  });
  const tradeFlow = useTradeFlowRuntime({
    identity: {
      exchange: chartSession.view.exchange,
      marketType: chartSession.view.marketType,
      symbol: chartSession.view.symbol,
    },
    interval: chartSession.view.interval,
    seriesStore: marketData.view.seriesStore,
    buyColor: combinedSettings.upColor,
    sellColor: combinedSettings.downColor,
    tradeFlowOpen,
  });

  const indicatorRuntime = useMemo<IndicatorShellRuntime>(() => ({
    view: { ...indicators.view, isPanelOpen: showIndicatorPanel },
    actions: {
      ...indicators.actions,
      openPanel: openIndicatorPanel,
      closePanel: closeIndicatorPanel,
      togglePanel: toggleIndicatorPanel,
    },
    status: indicators.status,
  }), [
    closeIndicatorPanel,
    indicators.actions,
    indicators.status,
    indicators.view,
    openIndicatorPanel,
    showIndicatorPanel,
    toggleIndicatorPanel,
  ]);
  const settingsRuntime = useMemo<SettingsShellRuntime>(() => ({
    view: {
      settings: combinedSettings,
      resolvedTheme: globalSettings.resolvedTheme,
      isOpen: showSettings,
    },
    actions: {
      update: setCombinedSettings,
      openPanel: openSettingsPanel,
      closePanel: closeSettingsPanel,
    },
    status: {},
  }), [
    closeSettingsPanel,
    combinedSettings,
    globalSettings.resolvedTheme,
    openSettingsPanel,
    setCombinedSettings,
    showSettings,
  ]);
  const priceScaleRuntime = useMemo<PriceScaleShellRuntime>(() => ({
    view: priceScale,
    actions: { setInvertScale, setPriceScaleMode },
    status: {},
  }), [priceScale, setInvertScale, setPriceScaleMode]);
  const alertsRuntime = useMemo<AlertsShellRuntime>(() => ({
    view: { isOpen: showAlertsPanel },
    actions: {
      openPanel: openAlertsPanel,
      closePanel: closeAlertsPanel,
      togglePanel: toggleAlertsPanel,
    },
    status: {},
  }), [
    closeAlertsPanel,
    openAlertsPanel,
    showAlertsPanel,
    toggleAlertsPanel,
  ]);

  // The pure builder only reads declarative view/actions/status fields. Some
  // runtime contracts also carry opaque refs, which the React lint rule cannot
  // distinguish from refs that would be dereferenced during render.
  // eslint-disable-next-line react-hooks/refs
  const model = useMemo(() => buildAppShellViewModel({
    session: {
      view: chartSession.view,
      actions: chartSession.actions,
      status: chartSession.status,
    },
    marketData,
    advancedMarketData,
    drawings,
    indicators: indicatorRuntime,
    settings: settingsRuntime,
    priceScale: priceScaleRuntime,
    watchlist,
    orderBook,
    tradeFlow,
    marketRail,
    exportFlow,
    alerts: alertsRuntime,
    replayEntry,
    onOpenReplayLauncher,
  }), [
    advancedMarketData,
    alertsRuntime,
    chartSession.actions,
    chartSession.status,
    chartSession.view,
    drawings,
    exportFlow,
    indicatorRuntime,
    marketData,
    marketRail,
    onOpenReplayLauncher,
    orderBook,
    priceScaleRuntime,
    replayEntry,
    settingsRuntime,
    tradeFlow,
    watchlist,
  ]);

  const upstreamCrosshairMoveRef = useRef(
    model.chartWorkspace.chart.chartProps.onCrosshairMove,
  );
  useLayoutEffect(() => {
    upstreamCrosshairMoveRef.current = model.chartWorkspace.chart.chartProps.onCrosshairMove;
  }, [
    model.chartWorkspace.chart.chartProps.onCrosshairMove,
  ]);
  const handleLinkedCrosshairMove = useCallback((value: MainSeriesCrosshairValue | null) => {
    upstreamCrosshairMoveRef.current?.(value);
    linkCoordinator.publishCrosshair(
      cell.id,
      typeof value?.time === "number" ? value.time : null,
    );
  }, [cell.id, linkCoordinator]);
  const handleLinkedViewportRangeChange = useCallback((range: ChartSurfaceVisibleRange) => {
    if (typeof range.rightmostTime === "number") {
      linkCoordinator.publishTimeAnchor(cell.id, range.rightmostTime);
    }
    if (range.time) linkCoordinator.publishDateRange(cell.id, range.time);
  }, [cell.id, linkCoordinator]);

  const chartModel = useMemo(() => ({
    ...model.chartWorkspace.chart,
    chartProps: {
      ...model.chartWorkspace.chart.chartProps,
      ref: chartSurface.ref,
      drawingKeyBase: drawingScopeBase,
      paneLayoutScope: cellStorageScope,
      onCrosshairMove: handleLinkedCrosshairMove,
      onUserViewportRangeChange: handleLinkedViewportRangeChange,
    },
  }), [
    cellStorageScope,
    chartSurface.ref,
    drawingScopeBase,
    handleLinkedCrosshairMove,
    handleLinkedViewportRangeChange,
    model.chartWorkspace.chart,
  ]);
  const featureSurfaces = useMemo(() => ({
    ...model.lazySurfaces,
    settingsModal: { ...model.lazySurfaces.settingsModal, plugins },
  }), [model.lazySurfaces, plugins]);
  const [drawingInteractionReady, setDrawingInteractionReady] = useState(false);
  const drawingToolbarProps = useMemo(() => ({
    ...model.chartWorkspace.drawingToolbar,
    activeTool: drawingToolWhenInteractionReady(
      model.chartWorkspace.drawingToolbar.activeTool,
      drawingInteractionReady,
    ),
    drawingInteractionReady,
  }), [drawingInteractionReady, model.chartWorkspace.drawingToolbar]);

  useEffect(() => {
    if (!active) return;
    onActiveEnvironmentChange(cell.id, {
      subscriptionContext: {
        exchangeCatalog: chartSession.view.exchangeCatalog,
        exchangeCatalogStatus: chartSession.status.exchangeCatalogStatus,
        customIntervalRecords: chartSession.view.customIntervalRecords,
      },
      marketDataReady: chartSession.status.marketDataReady,
      cacheDiagnostics: marketData.status.cacheDiagnostics,
      trimCacheEntries: marketData.status.trimCacheEntries,
    });
  }, [
    active,
    cell.id,
    chartSession.status.exchangeCatalogStatus,
    chartSession.status.marketDataReady,
    chartSession.view.customIntervalRecords,
    chartSession.view.exchangeCatalog,
    marketData.status.cacheDiagnostics,
    marketData.status.trimCacheEntries,
    onActiveEnvironmentChange,
  ]);

  const activate = useCallback(() => onActivate(cell.id), [cell.id, onActivate]);
  const toggleMaximize = useCallback(() => {
    onActivate(cell.id);
    onToggleMaximize(cell.id);
  }, [cell.id, onActivate, onToggleMaximize]);

  return (
    <>
      <section
        className={`multi-chart-cell${active ? " active" : ""}${maximized ? " maximized" : ""}`}
        data-chart-cell-id={cell.id}
        data-active={active ? "true" : "false"}
        data-layout-role={layoutRole ?? "standard"}
        data-link-group={cell.linkGroup ?? "none"}
        data-link-role={cell.linkRole}
        onPointerDown={activate}
      >
        <header className="multi-chart-cell-header" onDoubleClick={toggleMaximize}>
          <span className={`multi-chart-cell-status ${marketData.view.wsStatus}`} aria-hidden="true" />
          <button
            type="button"
            className="multi-chart-cell-drag-handle"
            draggable={!layoutEditingDisabled && !maximized && layoutCellIds.length > 1}
            aria-label={`拖动图 ${cell.id.slice("cell-".length)} 交换位置`}
            aria-disabled={layoutEditingDisabled || maximized || layoutCellIds.length <= 1}
            title={layoutCellIds.length > 1 ? "拖动到另一图表以交换位置" : "拆分后可拖动交换"}
            onDragStart={(event) => {
              if (layoutEditingDisabled || maximized || layoutCellIds.length <= 1) {
                event.preventDefault();
                return;
              }
              writeChartCellDragData(event.dataTransfer, cell.id);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            ⠿
          </button>
          {layoutRole && (
            <span className={`multi-chart-cell-role role-${layoutRole}`}>
              {layoutRole === "main" ? "主图" : "确认图"}
            </span>
          )}
          <strong>{chartSession.view.symbol}</strong>
          <span>{chartSession.view.interval}</span>
          <span className="multi-chart-cell-market">
            {chartSession.view.exchange} · {chartSession.view.marketType}
          </span>
          <label className="multi-chart-cell-link" data-link-group={cell.linkGroup ?? "none"}>
            <span className="sr-only">联动组</span>
            {cell.linkGroup && (
              <span
                className="multi-chart-cell-link-role"
                aria-label={cell.linkRole === "source"
                  ? "源图"
                  : cell.linkRole === "destination" ? "目标图" : "双向图"}
                title={cell.linkRole === "source"
                  ? "源图：只发送品种、周期与视图联动"
                  : cell.linkRole === "destination"
                    ? "目标图：只接收品种、周期与视图联动"
                    : "双向发送和接收品种、周期与视图联动"}
              >
                {cell.linkRole === "source" ? "源" : cell.linkRole === "destination" ? "目" : "↔"}
              </span>
            )}
            <select
              aria-label={`${cell.id} 联动组`}
              value={cell.linkGroup ?? ""}
              onChange={(event) => onLinkGroupChange(
                cell.id,
                (event.currentTarget.value || null) as ChartLinkGroupId | null,
              )}
              onDoubleClick={(event) => event.stopPropagation()}
              title={cell.linkGroup ? `联动组 ${cell.linkGroup}` : "独立图表"}
            >
              <option value="">独立</option>
              {CHART_LINK_GROUP_IDS.map((group) => (
                <option key={group} value={group}>组 {group}</option>
              ))}
            </select>
          </label>
          <WorkspaceCellLayoutMenu
            cellId={cell.id}
            layoutCellIds={layoutCellIds}
            disabled={layoutEditingDisabled || maximized}
            onSplit={onSplitCell}
            onClose={onCloseCell}
            onSwap={onSwapCells}
          />
          <button
            type="button"
            className="multi-chart-cell-maximize"
            onClick={(event) => {
              event.stopPropagation();
              toggleMaximize();
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            aria-label={maximized ? "还原图表" : "最大化图表"}
            title={maximized ? "还原图表" : "最大化图表"}
          >
            {maximized ? "↙" : "↗"}
          </button>
        </header>
        <div className="multi-chart-cell-canvas">
          <ChartCellCanvas
            chart={chartModel}
            tradeFlow={tradeFlow}
            pluginMarkerSource={plugins.view.markerSource}
            pluginChartLayerSource={plugins.view.chartLayerSource}
            drawingInteractionReady={drawingInteractionReady}
            onDrawingInteractionReadyChange={setDrawingInteractionReady}
          />
          {active && model.chartWorkspace.exportPanel.isOpen && (
            <Suspense fallback={null}>
              <ExportPanel {...model.chartWorkspace.exportPanel} />
            </Suspense>
          )}
        </div>
      </section>

      {active && portalHosts.topBar && createPortal(
        <TopBar
          {...model.topBar}
          extensionControls={(
            <>
              {workspaceControls}
              <PluginUiErrorBoundary>
                <PluginPlatformToolbar runtime={plugins} />
              </PluginUiErrorBoundary>
            </>
          )}
        />,
        portalHosts.topBar,
      )}
      {active && portalHosts.intervalSelector && createPortal(
        <IntervalSelector {...model.intervalSelector} />,
        portalHosts.intervalSelector,
      )}
      {active && portalHosts.drawingToolbar && createPortal(
        <Suspense fallback={<div className="drawing-toolbar drawing-toolbar-loading" aria-hidden="true" />}>
          <DrawingToolbar {...drawingToolbarProps} />
        </Suspense>,
        portalHosts.drawingToolbar,
      )}
      {active && portalHosts.rightRail && createPortal(
        <Suspense fallback={<div className="right-market-rail market-rail-loading" aria-hidden="true" />}>
          <RightMarketRail
            watchlist={model.chartWorkspace.watchlist}
            orderBook={model.chartWorkspace.orderBook}
            tradeFlow={model.chartWorkspace.tradeFlow}
            openViewIds={marketRail.openViewIds}
            onToggleView={marketRail.onToggleView}
            viewHeights={marketRail.viewHeights}
            onViewHeightChange={marketRail.onViewHeightChange}
          />
        </Suspense>,
        portalHosts.rightRail,
      )}
      {active && portalHosts.featureSurfaces && createPortal(
        <>
          <LazyFeatureSurfaces surfaces={featureSurfaces} />
          <PluginUiErrorBoundary>
            <PluginLiveControl runtime={plugins} />
          </PluginUiErrorBoundary>
          <PluginPlatformSurfaces runtime={plugins} />
        </>,
        portalHosts.featureSurfaces,
      )}
      {active && portalHosts.statusBar && createPortal(
        <StatusBar
          status={model.statusBar}
          extensions={(
            <PluginUiErrorBoundary>
              <PluginPlatformStatus runtime={plugins} />
            </PluginUiErrorBoundary>
          )}
        />,
        portalHosts.statusBar,
      )}
    </>
  );
}

export default React.memo(LiveChartCell);
