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
  type CSSProperties,
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
  ChartStrategyAttachmentRecord,
  ChartLinkGroup,
  ChartWorkspaceCellRole,
  ChartWorkspaceId,
  ChartWindowId,
  ChartWorkspaceSplitDirection,
} from "../features/chart-workspace/chartWorkspaceTypes.js";
import { chartLinkGroupDisplayName } from "../features/chart-workspace/chartWorkspaceI18n.js";
import { chartCellStorageScope } from "../features/chart-workspace/chartWorkspaceLibrary.js";
import type { ChartLinkCoordinator } from "../features/chart-workspace/chartLinkCoordinator.js";
import {
  recordMultiChartCellCommit,
  recordMultiChartCellRender,
} from "../features/chart-workspace/multiChartRenderDiagnostics.js";
import { writeChartCellDragData } from "../features/chart-workspace/chartWorkspaceDrag.js";
import WorkspaceCellLayoutMenu from "../features/chart-workspace/WorkspaceCellLayoutMenu.js";
import {
  workspaceCellDensityForSize,
  type WorkspaceCellDensity,
} from "../features/chart-workspace/chartWorkspaceGeometry.js";
import { useMarketDataRuntime } from "../features/market-data/useMarketDataRuntime.js";
import { useLiveReferenceMarketChartSource } from "../features/market-chart-platform/useLiveReferenceMarketChartSource.js";
import {
  initialViewportCountBackCapForCellCount,
  shouldEnableWorkspaceIntervalPrefetch,
} from "../features/market-data/useChartInitialLoad.js";
import { useMarketDataWorkspaceResources } from "../features/market-data/marketDataWorkspaceContext.js";
import type { ForegroundPreloadGate } from "../features/market-data/foregroundPreloadGate.js";
import { useAdvancedMarketDataRuntime } from "../features/advanced-market-data/useAdvancedMarketDataRuntime.js";
import { useDrawingRuntime } from "../features/drawings/useDrawingRuntime.js";
import type { DrawingToolSelectionRuntime } from "../features/drawings/drawingToolState.js";
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
import { t } from "../i18n/index.js";
import { useLocale } from "../i18n/useLocale.js";
import { LIVE_RAIL_VIEW_IDS } from "../shared/marketRailLayout.js";
import { ALERT_PANEL_OPEN_REQUEST_EVENT } from "../features/alerts/alertDeliveryClient.js";
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
import { CHART_STRATEGY_TESTER_ENABLED } from "../features/backtest/chart-tester/chartStrategyTesterFeature.js";
import type { ChartStrategyTesterEntryState } from "../features/backtest/chart-tester/chartStrategyTesterUiModel.js";
import type { ChartStrategyResultMarkerSource } from "../features/backtest/chart-tester/chartStrategyResultMarkerSource.js";

const ExportPanel = lazy(() => import("../features/export/ExportPanel.js"));
const DrawingToolbar = lazy(() => {
  preloadDrawingEngineHost();
  return import("../features/drawings/DrawingToolbar.js");
});
const RightMarketRail = lazy(() => import("./RightMarketRail.js"));
const loadChartStrategyTesterCellBridge = () => import(
  "../features/backtest/chart-tester/ChartStrategyTesterCellBridge.js"
);
const ChartStrategyTesterCellBridge = lazy(loadChartStrategyTesterCellBridge);
let liveChartCellMountSequence = 0;

export interface WorkspacePortalHosts {
  topBar: HTMLElement | null;
  intervalSelector: HTMLElement | null;
  drawingToolbar: HTMLElement | null;
  rightRail: HTMLElement | null;
  featureSurfaces: HTMLElement | null;
  bottomPanel: HTMLElement | null;
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
  windowId: ChartWindowId;
  cell: ChartCellState;
  linkGroup: ChartLinkGroup | null;
  linkedDrawingScopeBase: string;
  layoutRole: ChartWorkspaceCellRole | null;
  active: boolean;
  maximized: boolean;
  obscured: boolean;
  layoutCellIds: readonly ChartCellId[];
  maxCellsPerWindow: number;
  layoutEditingDisabled?: boolean;
  pageExportRef: RefObject<HTMLDivElement | null>;
  foregroundPreloadGate: ForegroundPreloadGate;
  drawingToolSelection: DrawingToolSelectionRuntime;
  globalSettings: ChartSettingsRuntime;
  watchlist: WatchlistRuntime;
  marketRail: ChartWorkspaceRailLayout;
  replayEntry: ReplayEntryCapabilityView;
  portalHosts: WorkspacePortalHosts;
  workspaceControls: ReactNode;
  linkCoordinator: ChartLinkCoordinator;
  onActivate(cellId: ChartCellId): void;
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
  strategyPanelOpen: boolean;
  onStrategyPanelOpenChange(open: boolean): void;
  onStrategyAttachmentChange(
    cellId: ChartCellId,
    attachment: ChartStrategyAttachmentRecord | null,
  ): void;
  onOpenReplayLauncher(): void;
  onActiveEnvironmentChange(cellId: ChartCellId, environment: ActiveChartEnvironment): void;
}

function LiveChartCell({
  workspaceId,
  windowId,
  cell,
  linkGroup,
  linkedDrawingScopeBase,
  layoutRole,
  active,
  maximized,
  obscured,
  layoutCellIds,
  maxCellsPerWindow,
  layoutEditingDisabled = false,
  pageExportRef,
  foregroundPreloadGate,
  drawingToolSelection,
  globalSettings,
  watchlist,
  marketRail,
  replayEntry,
  portalHosts,
  workspaceControls,
  linkCoordinator,
  onActivate,
  onSplitCell,
  onCloseCell,
  onSwapCells,
  onToggleMaximize,
  onSessionChange,
  onChartSettingsChange,
  onPriceScaleChange,
  onIndicatorsChange,
  strategyPanelOpen,
  onStrategyPanelOpenChange,
  onStrategyAttachmentChange,
  onOpenReplayLauncher,
  onActiveEnvironmentChange,
}: LiveChartCellProps) {
  recordMultiChartCellRender(cell.id);
  useLocale();
  const marketWorkspaceResources = useMarketDataWorkspaceResources();
  const linkGroupName = linkGroup ? chartLinkGroupDisplayName(linkGroup) : null;
  const sectionRef = useRef<HTMLElement | null>(null);
  const [density, setDensity] = useState<WorkspaceCellDensity>("full");
  const strategyEntryRef = useRef<HTMLButtonElement | null>(null);
  const strategyAttachmentKey = cell.strategyAttachment
    ? cell.strategyAttachment.strategyDraftId ?? "__attached__"
    : "__detached__";
  const [strategyEntrySnapshot, setStrategyEntrySnapshot] = useState<{
    attachmentKey: string;
    state: ChartStrategyTesterEntryState;
  }>(() => ({
    attachmentKey: strategyAttachmentKey,
    state: cell.strategyAttachment ? "editing" : "unattached",
  }));
  const strategyEntryState = strategyEntrySnapshot.attachmentKey === strategyAttachmentKey
    ? strategyEntrySnapshot.state
    : cell.strategyAttachment ? "editing" : "unattached";
  const handleStrategyEntryStateChange = useCallback((state: ChartStrategyTesterEntryState) => {
    setStrategyEntrySnapshot({ attachmentKey: strategyAttachmentKey, state });
  }, [strategyAttachmentKey]);
  const closeStrategyPanel = useCallback(() => {
    onStrategyPanelOpenChange(false);
    globalThis.setTimeout(() => {
      const currentEntry = document.querySelector<HTMLButtonElement>(
        `[data-chart-strategy-entry="${CSS.escape(cell.id)}"]`,
      );
      (currentEntry ?? strategyEntryRef.current)?.focus();
    }, 0);
  }, [cell.id, onStrategyPanelOpenChange]);
  const openStrategyPanel = useCallback(() => {
    onStrategyPanelOpenChange(true);
  }, [onStrategyPanelOpenChange]);
  const handleStrategyAttachmentChange = useCallback((attachment: ChartStrategyAttachmentRecord | null) => {
    onStrategyAttachmentChange(cell.id, attachment);
  }, [cell.id, onStrategyAttachmentChange]);
  const strategyEntryControl = CHART_STRATEGY_TESTER_ENABLED ? (
    <button
      ref={strategyEntryRef}
      type="button"
      className="chart-strategy-entry-button"
      data-chart-strategy-entry={cell.id}
      data-state={strategyEntryState}
      aria-expanded={strategyPanelOpen}
      aria-controls="chart-strategy-tester-panel"
      onPointerEnter={() => { void loadChartStrategyTesterCellBridge(); }}
      onMouseEnter={() => { void loadChartStrategyTesterCellBridge(); }}
      onFocus={() => { void loadChartStrategyTesterCellBridge(); }}
      onClick={() => onStrategyPanelOpenChange(!strategyPanelOpen)}
    >
      {t("chartTester.entry")}
      <span>
        {cell.strategyAttachment
          ? `${cell.strategyAttachment.displayName} · ${t(`chartTester.entryState.${strategyEntryState}`)}`
          : t("chartTester.entryState.unattached")}
      </span>
    </button>
  ) : null;
  useLayoutEffect(() => {
    recordMultiChartCellCommit(cell.id);
  });
  const [mountToken] = useState(() => {
    liveChartCellMountSequence += 1;
    return `${cell.id}:${liveChartCellMountSequence}`;
  });
  useLayoutEffect(() => {
    const element = sectionRef.current;
    if (!element) return undefined;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const next = workspaceCellDensityForSize(rect.width, rect.height);
      setDensity((current) => current === next ? current : next);
    };
    update();
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
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
  useEffect(
    () => chartSurface.actions.subscribeDrawingRevision((scopeKey, revision) => {
      linkCoordinator.publishDrawingRevision(cell.id, scopeKey, revision);
    }),
    [cell.id, chartSurface.actions, linkCoordinator],
  );
  const plugins = usePluginPlatformRuntime({
    exchange: chartSession.view.exchange,
    marketType: chartSession.view.marketType,
    symbol: chartSession.view.symbol,
    interval: chartSession.view.interval,
  });
  const initialViewportCountBackCap = initialViewportCountBackCapForCellCount(
    layoutCellIds.length,
  );
  const marketData = useMarketDataRuntime({
    session: chartSession,
    realtimePriceRef,
    foregroundPreloadGate,
    backgroundPrefetchEnabled: active,
    intervalPrefetchEnabled: active
      && shouldEnableWorkspaceIntervalPrefetch(layoutCellIds.length),
    schedulerCellId: cell.id,
    workspaceId,
    windowId,
    ...(initialViewportCountBackCap === undefined
      ? {}
      : { initialViewportCountBackCap }),
  });
  const liveSourceSession = useMemo<ChartSession>(() => ({
    exchange: chartSession.view.exchange,
    marketType: chartSession.view.marketType,
    symbol: chartSession.view.symbol,
    interval: chartSession.view.interval,
  }), [
    chartSession.view.exchange,
    chartSession.view.interval,
    chartSession.view.marketType,
    chartSession.view.symbol,
  ]);
  const liveReferenceSource = useLiveReferenceMarketChartSource({
    sourceId: `live:${workspaceId}:${windowId}:${cell.id}`,
    session: liveSourceSession,
    datasetKey: chartSession.view.datasetKey,
    marketData,
    paused: obscured,
  });
  const sourceMarketData = liveReferenceSource.marketData;

  const workTier = obscured ? "hidden" : active ? "focused" : "visible-secondary";
  const workScheduler = marketWorkspaceResources?.workScheduler;
  useLayoutEffect(() => {
    if (!workScheduler) return undefined;
    return workScheduler.registerCell(cell.id);
  }, [cell.id, workScheduler]);
  useLayoutEffect(() => {
    workScheduler?.setCellTier(cell.id, workTier);
  }, [cell.id, workScheduler, workTier]);
  const advancedMarketData = useAdvancedMarketDataRuntime({
    session: chartSession,
    dataMeta: sourceMarketData.view.meta,
    seriesStore: sourceMarketData.view.seriesStore,
  });
  const drawingScopeBase = linkedDrawingScopeBase;
  const drawings = useDrawingRuntime({
    chartSurfaceActions: chartSurface.actions,
    drawingScopeBase,
    drawingToolSelection,
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

  const indicatorPersistence = useMemo<ActiveIndicatorPersistence>(() => ({
    controlled: true,
    load: () => cell.indicators,
    save: (indicators) => onIndicatorsChange(cell.id, indicators),
  }), [cell.id, cell.indicators, onIndicatorsChange]);

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
  useEffect(() => {
    if (!active) return undefined;
    const handleOpenRequest = () => openAlertsPanel();
    window.addEventListener(ALERT_PANEL_OPEN_REQUEST_EVENT, handleOpenRequest);
    return () => window.removeEventListener(ALERT_PANEL_OPEN_REQUEST_EVENT, handleOpenRequest);
  }, [active, openAlertsPanel]);
  const indicatorStreamIdentity = useMemo(
    () => ({ workspaceId, windowId, cellId: cell.id }),
    [cell.id, windowId, workspaceId],
  );

  const indicators = useIndicatorRuntime({
    // Workspace schema v8 persists an explicit indicator list for every cell.
    // An empty list is therefore intentional (and is required by capacity
    // scenarios such as S3), not a signal to inject the legacy VOL default.
    autoAddVolume: false,
    session: chartSession,
    marketData: sourceMarketData,
    candleUpColor: combinedSettings.upColor,
    candleDownColor: combinedSettings.downColor,
    getCurrentVisibleRange: chartSurface.actions.getVisibleRange,
    onIndicatorRemoved: drawings.actions.handleIndicatorRemoved,
    indicatorPersistence,
    realtimeEnabled: !obscured,
    streamIdentity: indicatorStreamIdentity,
    workSchedulerCellId: cell.id,
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
    seriesStore: sourceMarketData.view.seriesStore,
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
    marketData: sourceMarketData,
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
    sourceMarketData,
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
  const pendingLinkedViewportRangeRef = useRef<ChartSurfaceVisibleRange | null>(null);
  const linkedViewportFrameRef = useRef<number | null>(null);
  const flushLinkedViewportRange = useCallback(() => {
    linkedViewportFrameRef.current = null;
    const range = pendingLinkedViewportRangeRef.current;
    pendingLinkedViewportRangeRef.current = null;
    if (!range) return;
    if (typeof range.rightmostTime === "number") {
      linkCoordinator.publishTimeAnchor(cell.id, range.rightmostTime);
    }
    if (range.time) linkCoordinator.publishDateRange(cell.id, range.time);
  }, [cell.id, linkCoordinator]);
  const handleLinkedViewportRangeChange = useCallback((range: ChartSurfaceVisibleRange) => {
    pendingLinkedViewportRangeRef.current = range;
    if (linkedViewportFrameRef.current !== null) return;
    linkedViewportFrameRef.current = requestAnimationFrame(flushLinkedViewportRange);
  }, [flushLinkedViewportRange]);
  const strategyMarkerSourceRef = useRef<ChartStrategyResultMarkerSource | null>(null);
  const [strategyMarkerSource, setStrategyMarkerSource] = useState<ChartStrategyResultMarkerSource | null>(null);
  const handleStrategyMarkerSourceChange = useCallback((source: ChartStrategyResultMarkerSource | null) => {
    strategyMarkerSourceRef.current = source;
    setStrategyMarkerSource(source);
  }, []);
  const upstreamViewportRangeChangeRef = useRef(
    model.chartWorkspace.chart.chartProps.onViewportRangeChange,
  );
  useLayoutEffect(() => {
    upstreamViewportRangeChangeRef.current = model.chartWorkspace.chart.chartProps.onViewportRangeChange;
  }, [model.chartWorkspace.chart.chartProps.onViewportRangeChange]);
  const handleChartViewportRangeChange = useCallback((range: ChartSurfaceVisibleRange) => {
    upstreamViewportRangeChangeRef.current?.(range);
    strategyMarkerSourceRef.current?.setVisibleRange(range);
  }, []);
  const handleLocateStrategyTrade = useCallback((timeMs: number) => {
    const timeSeconds = timeMs / 1_000;
    chartSurface.actions.setLinkedVisibleTimeAnchor(timeSeconds);
    chartSurface.actions.setLinkedCrosshairTime(timeSeconds);
  }, [chartSurface.actions]);
  useEffect(() => () => {
    if (linkedViewportFrameRef.current !== null) {
      cancelAnimationFrame(linkedViewportFrameRef.current);
      linkedViewportFrameRef.current = null;
    }
    pendingLinkedViewportRangeRef.current = null;
  }, [flushLinkedViewportRange]);

  const chartModel = useMemo(() => ({
    ...model.chartWorkspace.chart,
    chartProps: {
      ...model.chartWorkspace.chart.chartProps,
      ref: chartSurface.ref,
      drawingKeyBase: drawingScopeBase,
      paneLayoutScope: cellStorageScope,
      onCrosshairMove: handleLinkedCrosshairMove,
      onViewportRangeChange: handleChartViewportRangeChange,
      onUserViewportRangeChange: handleLinkedViewportRangeChange,
    },
  }), [
    cellStorageScope,
    chartSurface.ref,
    drawingScopeBase,
    handleLinkedCrosshairMove,
    handleLinkedViewportRangeChange,
    handleChartViewportRangeChange,
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
      cacheDiagnostics: sourceMarketData.status.cacheDiagnostics,
      trimCacheEntries: sourceMarketData.status.trimCacheEntries,
    });
  }, [
    active,
    cell.id,
    chartSession.status.exchangeCatalogStatus,
    chartSession.status.marketDataReady,
    chartSession.view.customIntervalRecords,
    chartSession.view.exchangeCatalog,
    sourceMarketData.status.cacheDiagnostics,
    sourceMarketData.status.trimCacheEntries,
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
        ref={sectionRef}
        className={`multi-chart-cell${active ? " active" : ""}${maximized ? " maximized" : ""}`}
        data-chart-cell-id={cell.id}
        data-runtime-mount-token={mountToken}
        data-market-chart-source-mode={liveReferenceSource.mode}
        data-market-chart-source-state={obscured ? "PAUSED" : liveReferenceSource.lifecycle}
        data-density={density}
        data-rendering-paused={obscured ? "true" : "false"}
        data-market-data-ready={sourceMarketData.status.barCount > 0 ? "true" : "false"}
        data-market-data-settled={sourceMarketData.status.barCount > 0
          && !sourceMarketData.view.loading
          && !sourceMarketData.status.initialHistoryPending
          && !sourceMarketData.status.loadingMoreLeft
          ? "true"
          : "false"}
        data-work-tier={workScheduler?.tier(cell.id) || "fallback"}
        data-active={active ? "true" : "false"}
        data-layout-role={layoutRole ?? "standard"}
        data-link-group={cell.linkGroupId ?? "none"}
        role="group"
        aria-label={t("chart.aria", { symbol: chartSession.view.symbol, interval: chartSession.view.interval })}
        tabIndex={obscured ? -1 : active ? 0 : -1}
        onFocus={activate}
        onPointerDown={activate}
      >
        <header className="multi-chart-cell-header" onDoubleClick={toggleMaximize}>
          <span className={`multi-chart-cell-status ${sourceMarketData.view.wsStatus}`} aria-hidden="true" />
          <button
            type="button"
            className="multi-chart-cell-drag-handle"
            draggable={!layoutEditingDisabled && !maximized && layoutCellIds.length > 1}
            aria-label={t("chart.dragAria", { n: cell.id.slice("cell-".length) })}
            aria-disabled={layoutEditingDisabled || maximized || layoutCellIds.length <= 1}
            title={layoutCellIds.length > 1 ? t("chart.dragTitle") : t("chart.dragNeedSplit")}
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
              {layoutRole === "main" ? t("chart.roleMain") : t("chart.roleConfirm")}
            </span>
          )}
          <strong>{chartSession.view.symbol}</strong>
          <span>{chartSession.view.interval}</span>
          <span className="multi-chart-cell-market">
            {chartSession.view.exchange} · {chartSession.view.marketType}
          </span>
          {linkGroup && (
            <span
              className="multi-chart-cell-link"
              data-link-group={linkGroup.id}
              style={{ "--chart-link-group-color": linkGroup.color } as CSSProperties}
              title={linkGroup.parentId
                ? t("chart.linkChild", { name: linkGroupName ?? linkGroup.name })
                : t("chart.linkRoot", { name: linkGroupName ?? linkGroup.name })}
            >
              <span className="multi-chart-cell-link-role" aria-hidden="true">
                {linkGroup.parentId ? "↓" : "↔"}
              </span>
              {linkGroupName}
            </span>
          )}
          <WorkspaceCellLayoutMenu
            cellId={cell.id}
            layoutCellIds={layoutCellIds}
            maxCellsPerWindow={maxCellsPerWindow}
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
            aria-label={maximized ? t("chart.restore") : t("chart.maximize")}
            title={maximized ? t("chart.restore") : t("chart.maximize")}
          >
            {maximized ? "↙" : "↗"}
          </button>
        </header>
        <div className="multi-chart-cell-canvas">
          <ChartCellCanvas
            chart={chartModel}
            source={liveReferenceSource}
            tradeFlow={tradeFlow}
            strategyMarkerSource={strategyMarkerSource}
            pluginMarkerSource={plugins.view.markerSource}
            pluginChartLayerSource={plugins.view.chartLayerSource}
            drawingInteractionReady={drawingInteractionReady}
            onDrawingInteractionReadyChange={setDrawingInteractionReady}
            paused={obscured}
          />
          {active && model.chartWorkspace.exportPanel.isOpen && (
            <Suspense fallback={null}>
              <ExportPanel {...model.chartWorkspace.exportPanel} />
            </Suspense>
          )}
        </div>
      </section>

      {CHART_STRATEGY_TESTER_ENABLED
        && (cell.strategyAttachment !== null || (active && strategyPanelOpen)) && (
          <Suspense fallback={null}>
            <ChartStrategyTesterCellBridge
              workspaceId={workspaceId}
              cellId={cell.id}
              session={cell.session}
              attachment={cell.strategyAttachment}
              active={active}
              panelOpen={strategyPanelOpen}
              bottomPanelHost={portalHosts.bottomPanel}
              seriesStore={sourceMarketData.view.seriesStore}
              getCurrentVisibleRange={chartSurface.actions.getVisibleRange}
              onMarkerSourceChange={handleStrategyMarkerSourceChange}
              onLocateTrade={handleLocateStrategyTrade}
              onAttachmentChange={handleStrategyAttachmentChange}
              onEntryStateChange={handleStrategyEntryStateChange}
              onOpenPanel={openStrategyPanel}
              onClosePanel={closeStrategyPanel}
            />
          </Suspense>
        )}

      {active && portalHosts.topBar && createPortal(
        <TopBar
          {...model.topBar}
          identityAccessory={strategyEntryControl}
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
            panelCollapsed={marketRail.panelCollapsed ?? false}
            onToggleView={marketRail.onToggleView}
            {...(marketRail.onCloseView === undefined
              ? {}
              : { onCloseView: marketRail.onCloseView })}
            {...(marketRail.onTogglePanelCollapsed === undefined
              ? {}
              : { onTogglePanelCollapsed: marketRail.onTogglePanelCollapsed })}
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
