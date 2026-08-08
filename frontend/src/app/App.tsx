import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { ForegroundPreloadGate } from "../features/market-data/foregroundPreloadGate.js";
import { MarketDataWorkspaceProvider } from "../features/market-data/MarketDataWorkspaceProvider.js";
import { useChartWorkspaceRuntime } from "../features/chart-workspace/useChartWorkspaceRuntime.js";
import type { ChartCellId } from "../features/chart-workspace/chartWorkspaceTypes.js";
import {
  ChartLinkCoordinator,
  type ChartLinkViewportIssue,
} from "../features/chart-workspace/chartLinkCoordinator.js";
import { chartCellDrawingScopeBase } from "../features/chart-workspace/chartWorkspaceDrawingLink.js";
import { chartWorkspaceCell } from "../features/chart-workspace/chartWorkspaceDocument.js";
import WorkspaceLayoutTree from "../features/chart-workspace/WorkspaceLayoutTree.js";
import { CHART_WORKSPACE_FEATURE_FLAGS } from "../features/chart-workspace/chartWorkspaceCapacity.js";
import { defaultWorkspaceBus } from "../features/chart-workspace/workspaceBus.js";
import { useChartSettingsRuntime } from "../features/settings/chartAppearanceSettings.js";
import { useCacheLimitsSync } from "../features/settings/cacheLimitSettingsRuntime.js";
import type { IndicatorDefinition } from "../features/indicators/indicatorTypes.js";
import { useFrontendAutoGcRuntime } from "../features/cache-gc/useFrontendAutoGcRuntime.js";
import { useWatchlistRuntime } from "../features/watchlist/useWatchlistRuntime.js";
import { useWatchlistFullCacheRuntime } from "../features/watchlist-full-cache/useWatchlistFullCacheRuntime.js";
import { useReplayEntryCapability } from "../features/replay/useReplayEntryCapability.js";
import { buildLiveReplayLaunchContext } from "../features/replay-launcher/replayLaunchContext.js";
import AppProviders from "./AppProviders.js";
import LiveChartCell from "./LiveChartCell.js";
import type {
  ActiveChartEnvironment,
  WorkspacePortalHosts,
} from "./LiveChartCell.js";
import MarketPageFrame from "./MarketPageFrame.js";
import MarketWorkspaceFrame from "./MarketWorkspaceFrame.js";
import { useMarketRailLayout } from "./useMarketRailLayout.js";
import {
  loadReplayLauncherDialog,
  loadWorkspacePanel,
} from "./lazySurfaceLoaders.js";
import {
  desktopWindowManager,
  type DesktopBootstrap,
} from "../desktop/desktopWindowManager.js";
import "../index.css";
import "../features/plugins/pluginTrustUx.css";

const ReplayLauncherDialog = lazy(loadReplayLauncherDialog);
const WorkspacePanel = lazy(loadWorkspacePanel);

const PHASE8_BUILTIN_INDICATORS: readonly IndicatorDefinition[] = Object.freeze([
  Object.freeze({
    id: "ma",
    name: "MA",
    engineName: "MA",
    kind: "builtin",
    executionTarget: "local",
    params: { period: 20 },
    visible: true,
  }),
  Object.freeze({
    id: "rsi",
    name: "RSI",
    engineName: "RSI",
    kind: "builtin",
    executionTarget: "local",
    params: { period: 14 },
    visible: true,
  }),
]);

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable
    || target.tagName === "INPUT"
    || target.tagName === "TEXTAREA"
    || target.tagName === "SELECT";
}

function LiveWorkspaceApp() {
  const workspaceBus = CHART_WORKSPACE_FEATURE_FLAGS.multiChart64Enabled
    ? defaultWorkspaceBus(desktopWindowManager.windowId)
    : null;
  const workspace = useChartWorkspaceRuntime({ windowId: desktopWindowManager.windowId });
  const [desktopBootstrap, setDesktopBootstrap] = useState<DesktopBootstrap>(
    desktopWindowManager.cachedBootstrap,
  );
  const [desktopError, setDesktopError] = useState<string | null>(null);
  const [desktopWindowVisible, setDesktopWindowVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const capacityProbeMetricsRef = useRef({
    startedAt: 0,
    longTasks: [] as Array<{ startTime: number; duration: number; focused: boolean }>,
    inputLatencies: [] as number[],
    longTaskKeys: new Set<string>(),
  });
  const settings = useChartSettingsRuntime();
  const replayEntry = useReplayEntryCapability();
  const marketRailLayout = useMarketRailLayout();
  const pageExportRef = useRef<HTMLDivElement | null>(null);
  const [linkCoordinator] = useState(
    () => new ChartLinkCoordinator(
      workspace.view.document,
      workspace.view.activeWorkspaceId,
    ),
  );
  const [viewportLinkIssue, setViewportLinkIssue] = useState<ChartLinkViewportIssue | null>(
    () => linkCoordinator.getViewportIssue(),
  );
  useEffect(() => {
    let cancelled = false;
    void desktopWindowManager.getBootstrap().then((bootstrap) => {
      if (!cancelled) setDesktopBootstrap(bootstrap);
    }).catch((error: unknown) => {
      if (!cancelled) setDesktopError(error instanceof Error ? error.message : "桌面壳握手失败");
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!workspace.view.ready
      || desktopBootstrap.mode !== "native"
      || !desktopBootstrap.multiWindowEnabled
      || desktopWindowManager.windowId !== "main-window") return undefined;
    let cancelled = false;
    void desktopWindowManager.reconcileWorkspace(
      workspace.view.activeWorkspaceId,
      workspace.view.document,
    ).then((result) => {
      if (cancelled) return;
      setDesktopBootstrap(desktopWindowManager.cachedBootstrap);
      setDesktopError(result.ok ? null : `${result.code}: ${result.message || "窗口拓扑被拒绝"}`);
    }).catch((error: unknown) => {
      if (!cancelled) setDesktopError(error instanceof Error ? error.message : "窗口拓扑同步失败");
    });
    return () => {
      cancelled = true;
    };
  }, [
    desktopBootstrap.mode,
    desktopBootstrap.multiWindowEnabled,
    workspace.view.activeWorkspaceId,
    workspace.view.document,
    workspace.view.ready,
  ]);
  useEffect(() => {
    if (desktopWindowManager.windowId !== "main-window") return undefined;
    const unsubscribeClose = desktopWindowManager.onCloseRequested(({ windowId }) => {
      workspace.actions.closeWindow(windowId);
    });
    const unsubscribePlacement = desktopWindowManager.onPlacement((placement) => {
      workspace.actions.updateWindowPlacement(placement.windowId, placement);
    });
    const unsubscribeLifecycle = desktopWindowManager.onLifecycle((event) => {
      workspace.actions.updateWindowPlacement(event.windowId, event.placement);
    });
    return () => {
      unsubscribeClose();
      unsubscribePlacement();
      unsubscribeLifecycle();
    };
  }, [workspace.actions]);
  useLayoutEffect(() => {
    linkCoordinator.updateDocument(
      workspace.view.document,
      workspace.view.activeWorkspaceId,
    );
  }, [linkCoordinator, workspace.view.activeWorkspaceId, workspace.view.document]);
  useEffect(
    () => linkCoordinator.connectWorkspaceBus(workspaceBus),
    [linkCoordinator, workspaceBus],
  );
  useEffect(() => {
    if (!workspaceBus) return undefined;
    const report = () => workspaceBus.reportWindow({
      focused: document.hasFocus(),
      visible: document.visibilityState !== "hidden",
    });
    const reportWithVisibility = () => {
      setDesktopWindowVisible(document.visibilityState !== "hidden");
      report();
    };
    reportWithVisibility();
    const unsubscribeLifecycle = desktopWindowManager.onLifecycle(reportWithVisibility);
    document.addEventListener("visibilitychange", reportWithVisibility);
    window.addEventListener("focus", reportWithVisibility);
    window.addEventListener("blur", reportWithVisibility);
    return () => {
      unsubscribeLifecycle();
      document.removeEventListener("visibilitychange", reportWithVisibility);
      window.removeEventListener("focus", reportWithVisibility);
      window.removeEventListener("blur", reportWithVisibility);
    };
  }, [workspaceBus]);
  useEffect(() => {
    const capacityProbe = new URLSearchParams(location.search).get("capacityProbe");
    if (capacityProbe !== "phase7" && capacityProbe !== "phase8") return undefined;
    const metrics = capacityProbeMetricsRef.current;
    if (metrics.startedAt === 0) metrics.startedAt = performance.now();
    let longTaskObserver: PerformanceObserver | null = null;
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          if (entry.startTime < metrics.startedAt) return;
          const key = `${entry.startTime}:${entry.duration}`;
          if (metrics.longTaskKeys.has(key)) return;
          metrics.longTaskKeys.add(key);
          metrics.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
            focused: document.hasFocus(),
          });
        });
      });
      longTaskObserver.observe({ type: "longtask", buffered: true });
    } catch {
      // Older Chromium builds may not expose the Long Tasks observer.
    }
    const recordInput = () => {
      const startedAt = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        metrics.inputLatencies.push(Math.max(0, performance.now() - startedAt));
      }));
    };
    document.addEventListener("mousemove", recordInput, true);
    const target = window as typeof window & {
      __CANDLESCOPE_PHASE7_CONTROL__?: {
        configure64(): void;
        configureBaseline(symbol?: string): void;
        configureHealth(symbols: string[]): void;
        configureW2(symbols: string[]): void;
        configureW3(symbols: string[]): void;
        resetMetrics(): void;
        metrics(): unknown;
        snapshot(): unknown;
      };
    };
    const configureScenario = (symbols: string[], indicators: readonly IndicatorDefinition[]) => {
      const cellIds = Object.keys(workspace.view.document.cells).sort();
      if (cellIds.length !== 64 || symbols.length !== 64) {
        throw new Error("Phase 8 scenario requires exactly 64 Cell ids and symbols");
      }
      flushSync(() => {
        workspace.actions.configureCells(cellIds.map((cellId, index) => ({
          cellId,
          session: {
            exchange: "binance",
            marketType: "spot",
            symbol: symbols[index]!,
            interval: "1m",
          },
          indicators: indicators.map((indicator) => ({
            ...indicator,
            params: { ...(indicator.params || {}) },
          })),
        })));
      });
    };
    const handle = {
      configure64: () => {
        workspace.actions.setLayout("grid-16");
        workspace.actions.createWindow();
        workspace.actions.createWindow();
        workspace.actions.createWindow();
      },
      configureBaseline: (symbol = "BTCUSDT") => {
        const cellIds = Object.keys(workspace.view.document.cells).sort();
        if (cellIds.length !== 64) {
          throw new Error("Phase 8 baseline requires exactly 64 Cell ids");
        }
        configureScenario(cellIds.map(() => symbol), []);
      },
      configureHealth: (symbols: string[]) => {
        if (symbols.length !== 64 || new Set(symbols).size !== 64) {
          throw new Error("Phase 8 health selection requires exactly 64 unique symbols");
        }
        configureScenario(symbols, []);
      },
      configureW2: (symbols: string[]) => {
        const cellIds = Object.keys(workspace.view.document.cells).sort();
        if (cellIds.length !== 64 || symbols.length !== 64 || new Set(symbols).size !== 64) {
          throw new Error("Phase 7 W2 requires exactly 64 unique Cell ids and symbols");
        }
        configureScenario(symbols, []);
        workspace.actions.updateLinkGroupSettings("A", { market: false, interval: false, crosshair: true });
        Object.values(workspace.view.document.windows).forEach((windowState) => {
          workspace.actions.setCellLinkGroup(windowState.activeCellId, "A");
        });
      },
      configureW3: (symbols: string[]) => {
        if (symbols.length !== 64 || new Set(symbols).size !== 64) {
          throw new Error("Phase 8 W3 requires exactly 64 unique symbols");
        }
        configureScenario(symbols, PHASE8_BUILTIN_INDICATORS);
      },
      resetMetrics: () => {
        metrics.startedAt = performance.now();
        metrics.longTasks.length = 0;
        metrics.inputLatencies.length = 0;
        metrics.longTaskKeys.clear();
      },
      metrics: () => ({
        durationMs: Math.max(0, performance.now() - metrics.startedAt),
        longTasks: metrics.longTasks.slice(),
        inputLatencies: metrics.inputLatencies.slice(),
      }),
      snapshot: () => ({
        workspaceId: workspace.view.activeWorkspaceId,
        document: workspace.view.document,
        windowId: desktopWindowManager.windowId,
        ready: workspace.view.ready,
        status: workspace.status,
      }),
    };
    target.__CANDLESCOPE_PHASE7_CONTROL__ = handle;
    return () => {
      longTaskObserver?.disconnect();
      document.removeEventListener("mousemove", recordInput, true);
      if (target.__CANDLESCOPE_PHASE7_CONTROL__ === handle) delete target.__CANDLESCOPE_PHASE7_CONTROL__;
    };
  }, [workspace.actions, workspace.status, workspace.view]);
  useEffect(() => {
    if (!workspaceBus || !workspace.view.ready || !desktopWindowVisible) return undefined;
    let active = true;
    void workspaceBus.requestPreview(workspace.view.activeCellId).then((result) => {
      if (active && !result.ok) setDesktopError(`${result.code}: ${result.message || "预览 lane 已满"}`);
    });
    return () => {
      active = false;
      workspaceBus.releasePreview(workspace.view.activeCellId);
    };
  }, [desktopWindowVisible, workspace.view.activeCellId, workspace.view.ready, workspaceBus]);
  useEffect(
    () => linkCoordinator.subscribeViewportIssue(setViewportLinkIssue),
    [linkCoordinator],
  );
  useEffect(() => {
    const target = window as typeof window & {
      __CANDLESCOPE_MULTI_CHART_CAPACITY__?: unknown;
      __CANDLESCOPE_CHART_LINK_DIAGNOSTICS__?: {
        snapshot: () => ReturnType<ChartLinkCoordinator["snapshot"]>;
        publishCrosshair: ChartLinkCoordinator["publishCrosshair"];
        publishTimeAnchor: ChartLinkCoordinator["publishTimeAnchor"];
        publishDateRange: ChartLinkCoordinator["publishDateRange"];
      };
    };
    const capacityProbe = new URLSearchParams(location.search).get("capacityProbe");
    if (target.__CANDLESCOPE_MULTI_CHART_CAPACITY__ === undefined
      && capacityProbe !== "phase7"
      && capacityProbe !== "phase8") return;
    const diagnostics = {
      snapshot: () => linkCoordinator.snapshot(),
      publishCrosshair: linkCoordinator.publishCrosshair.bind(linkCoordinator),
      publishTimeAnchor: linkCoordinator.publishTimeAnchor.bind(linkCoordinator),
      publishDateRange: linkCoordinator.publishDateRange.bind(linkCoordinator),
    };
    target.__CANDLESCOPE_CHART_LINK_DIAGNOSTICS__ = diagnostics;
    return () => {
      if (target.__CANDLESCOPE_CHART_LINK_DIAGNOSTICS__ === diagnostics) {
        delete target.__CANDLESCOPE_CHART_LINK_DIAGNOSTICS__;
      }
    };
  }, [linkCoordinator]);
  useEffect(() => {
    if (!workspaceBus) return undefined;
    const target = window as typeof window & {
      __CANDLESCOPE_WORKSPACE_BUS__?: { snapshot(): Promise<Record<string, unknown>> };
    };
    const handle = { snapshot: () => workspaceBus.diagnostics() };
    target.__CANDLESCOPE_WORKSPACE_BUS__ = handle;
    return () => {
      if (target.__CANDLESCOPE_WORKSPACE_BUS__ === handle) delete target.__CANDLESCOPE_WORKSPACE_BUS__;
    };
  }, [workspaceBus]);
  const [foregroundPreloadGate] = useState(() => new ForegroundPreloadGate());
  const [activeEnvironment, setActiveEnvironment] = useState<{
    workspaceId: string;
    workspaceRuntimeKey: string;
    cellId: ChartCellId;
    value: ActiveChartEnvironment;
  } | null>(null);
  const [showReplayLauncher, setShowReplayLauncher] = useState(false);
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false);
  const currentActiveEnvironment = activeEnvironment?.workspaceId === workspace.view.activeWorkspaceId
    && activeEnvironment.workspaceRuntimeKey === workspace.view.runtimeKey
    ? activeEnvironment
    : null;

  const watchlist = useWatchlistRuntime(currentActiveEnvironment
    ? { subscriptionContext: currentActiveEnvironment.value.subscriptionContext }
    : {});
  const marketRail = useMemo(() => ({
    openViewIds: marketRailLayout.openViewIds,
    panelCollapsed: marketRailLayout.panelCollapsed,
    onToggleView: marketRailLayout.actions.toggleView,
    onCloseView: marketRailLayout.actions.closeView,
    onTogglePanelCollapsed: marketRailLayout.actions.togglePanelCollapsed,
    viewHeights: marketRailLayout.viewHeights,
    onViewHeightChange: marketRailLayout.actions.setViewHeight,
  }), [
    marketRailLayout.actions.closeView,
    marketRailLayout.actions.setViewHeight,
    marketRailLayout.actions.togglePanelCollapsed,
    marketRailLayout.actions.toggleView,
    marketRailLayout.openViewIds,
    marketRailLayout.panelCollapsed,
    marketRailLayout.viewHeights,
  ]);

  const {
    cacheLimits,
    ephemeralCacheBars,
    frontendCacheBudgetBytes,
    sqliteStorageBudgetBytes,
    storageRowLimitsEnabled,
  } = settings.settings;
  useCacheLimitsSync({
    cacheLimits,
    ephemeralCacheBars,
    sqliteStorageBudgetBytes,
    storageRowLimitsEnabled,
  });
  const frontendAutoGcPolicy = useMemo(() => ({
    maxEstimatedBytes: frontendCacheBudgetBytes,
  }), [frontendCacheBudgetBytes]);
  useFrontendAutoGcRuntime({
    chartDataCacheDiagnostics: currentActiveEnvironment?.value.cacheDiagnostics ?? null,
    policy: frontendAutoGcPolicy,
    trimChartDataCacheEntries: currentActiveEnvironment?.value.trimCacheEntries ?? null,
  });

  const activeSession = workspace.view.activeCell.session;
  const activeSubscriptionContext = currentActiveEnvironment?.value.subscriptionContext;
  useWatchlistFullCacheRuntime({
    enabled: currentActiveEnvironment?.value.marketDataReady === true,
    foregroundPreloadGate,
    watchlists: watchlist.view.watchlists,
    subscriptionTiers: watchlist.view.subscriptionTiers,
    exchangeCatalog: activeSubscriptionContext?.exchangeCatalog ?? null,
    exchangeCatalogStatus: activeSubscriptionContext?.exchangeCatalogStatus ?? "loading",
    customIntervalRecords: activeSubscriptionContext?.customIntervalRecords ?? [],
    currentSession: activeSession,
  });

  const openReplayLauncher = useCallback(() => setShowReplayLauncher(true), []);
  const closeReplayLauncher = useCallback(() => setShowReplayLauncher(false), []);
  const closeWorkspacePanel = useCallback(() => setWorkspacePanelOpen(false), []);
  const replayLaunchContext = useMemo(() => showReplayLauncher
    ? buildLiveReplayLaunchContext({
        exchange: activeSession.exchange,
        marketType: activeSession.marketType,
        symbol: activeSession.symbol,
        displayInterval: activeSession.interval,
        watchlists: watchlist.view.watchlists,
      })
    : null, [activeSession, showReplayLauncher, watchlist.view.watchlists]);

  const handleActiveEnvironmentChange = useCallback((
    cellId: ChartCellId,
    value: ActiveChartEnvironment,
  ) => {
    setActiveEnvironment({
      workspaceId: workspace.view.activeWorkspaceId,
      workspaceRuntimeKey: workspace.view.runtimeKey,
      cellId,
      value,
    });
  }, [workspace.view.activeWorkspaceId, workspace.view.runtimeKey]);

  const toggleWorkspaceMaximize = workspace.actions.toggleMaximize;
  useEffect(() => {
    if (workspace.view.window.maximizedCellId == null) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      toggleWorkspaceMaximize(workspace.view.window.maximizedCellId!);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleWorkspaceMaximize, workspace.view.window.maximizedCellId]);

  const undoWorkspaceLayout = workspace.actions.undoLayout;
  const redoWorkspaceLayout = workspace.actions.redoLayout;
  const layoutLocked = workspace.view.layoutLocked;
  const canUndoWorkspaceLayout = workspace.view.canUndoLayout;
  const canRedoWorkspaceLayout = workspace.view.canRedoLayout;
  useEffect(() => {
    if (layoutLocked || (!canUndoWorkspaceLayout && !canRedoWorkspaceLayout)) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey)
        || event.altKey
        || isEditableKeyboardTarget(event.target)) return;
      const key = event.key.toLocaleLowerCase();
      const command = key === "z" && !event.shiftKey
        ? "undo"
        : (key === "y" && !event.shiftKey) || (key === "z" && event.shiftKey)
          ? "redo"
          : null;
      if (command === null
        || (command === "undo" && !canUndoWorkspaceLayout)
        || (command === "redo" && !canRedoWorkspaceLayout)) return;
      event.preventDefault();
      if (command === "undo") undoWorkspaceLayout();
      else redoWorkspaceLayout();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    canRedoWorkspaceLayout,
    canUndoWorkspaceLayout,
    layoutLocked,
    redoWorkspaceLayout,
    undoWorkspaceLayout,
  ]);

  const [topBarHost, setTopBarHost] = useState<HTMLElement | null>(null);
  const [intervalSelectorHost, setIntervalSelectorHost] = useState<HTMLElement | null>(null);
  const [drawingToolbarHost, setDrawingToolbarHost] = useState<HTMLElement | null>(null);
  const [rightRailHost, setRightRailHost] = useState<HTMLElement | null>(null);
  const [featureSurfacesHost, setFeatureSurfacesHost] = useState<HTMLElement | null>(null);
  const [statusBarHost, setStatusBarHost] = useState<HTMLElement | null>(null);
  const portalHosts = useMemo<WorkspacePortalHosts>(() => ({
    topBar: topBarHost,
    intervalSelector: intervalSelectorHost,
    drawingToolbar: drawingToolbarHost,
    rightRail: rightRailHost,
    featureSurfaces: featureSurfacesHost,
    statusBar: statusBarHost,
  }), [
    drawingToolbarHost,
    featureSurfacesHost,
    intervalSelectorHost,
    rightRailHost,
    statusBarHost,
    topBarHost,
  ]);
  const workspaceControls = useMemo(() => (
    <button
      type="button"
      className={`indicator-toggle-btn workspace-toggle-btn ${workspacePanelOpen ? "active" : ""}`}
      data-save-state={workspace.status.saveState}
      onPointerEnter={loadWorkspacePanel}
      onMouseEnter={loadWorkspacePanel}
      onFocus={loadWorkspacePanel}
      onClick={() => setWorkspacePanelOpen((open) => !open)}
      aria-label={`图表工作区：${workspace.view.activeWorkspaceName}，${workspace.view.layoutCellIds.length} 个图表`}
      aria-expanded={workspacePanelOpen}
      title={`图表工作区 · ${workspace.view.activeWorkspaceName} · ${workspace.view.layoutCellIds.length} 图`}
    >
      <span className="workspace-toggle-icon" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="workspace-toggle-badge" aria-hidden="true">
        {workspace.view.layoutCellIds.length}
      </span>
    </button>
  ), [
    workspace.status.saveState,
    workspace.view.activeWorkspaceName,
    workspace.view.layoutCellIds.length,
    workspacePanelOpen,
  ]);
  const gridClassName = [
    "multi-chart-grid",
    `layout-${workspace.view.layout}`,
    workspace.view.window.maximizedCellId ? "has-maximized-cell" : "",
  ].filter(Boolean).join(" ");

  return (
    <>
      <MarketPageFrame
        rootRef={pageExportRef}
        topBar={<div className="workspace-portal-host" ref={setTopBarHost} />}
        intervalSelector={<div className="workspace-portal-host" ref={setIntervalSelectorHost} />}
        workspace={(
          <MarketWorkspaceFrame
            toolbar={<div className="workspace-portal-host" ref={setDrawingToolbarHost} />}
            exportOverlay={null}
            chart={(
              <div
                className={gridClassName}
                data-workspace-layout={workspace.view.layout}
                data-workspace-id={workspace.view.activeWorkspaceId}
                data-window-id={workspace.view.window.id}
                data-layout-locked={workspace.view.layoutLocked ? "true" : "false"}
                aria-busy={!workspace.view.ready}
              >
                <WorkspaceLayoutTree
                  tree={workspace.view.window.layoutTree}
                  maximizedCellId={workspace.view.window.maximizedCellId}
                  disabled={!workspace.view.ready || workspace.view.layoutLocked}
                  onSplitRatioChange={workspace.actions.setLayoutRatio}
                  onCellDrop={workspace.actions.swapCells}
                  renderCell={(cellId, layoutRole, obscured) => (
                    <LiveChartCell
                      key={`${workspace.view.runtimeKey}:${cellId}`}
                      workspaceId={workspace.view.activeWorkspaceId}
                      windowId={workspace.view.window.id}
                      cell={chartWorkspaceCell(workspace.view.document, cellId)}
                      linkedDrawingScopeBase={chartCellDrawingScopeBase(
                        workspace.view.activeWorkspaceId,
                        workspace.view.document,
                        cellId,
                      )}
                      layoutRole={layoutRole}
                      active={workspace.view.activeCellId === cellId}
                      maximized={workspace.view.window.maximizedCellId === cellId}
                      obscured={obscured}
                      layoutCellIds={workspace.view.layoutCellIds}
                      maxCellsPerWindow={workspace.view.maxCellsPerWindow}
                      layoutEditingDisabled={!workspace.view.ready || workspace.view.layoutLocked}
                      pageExportRef={pageExportRef}
                      foregroundPreloadGate={foregroundPreloadGate}
                      globalSettings={settings}
                      watchlist={watchlist}
                      marketRail={marketRail}
                      replayEntry={replayEntry}
                      portalHosts={portalHosts}
                      workspaceControls={workspaceControls}
                      linkCoordinator={linkCoordinator}
                      onActivate={workspace.actions.setActiveCell}
                      onLinkGroupChange={workspace.actions.setCellLinkGroup}
                      onSplitCell={workspace.actions.splitCell}
                      onCloseCell={workspace.actions.closeCell}
                      onSwapCells={workspace.actions.swapCells}
                      onToggleMaximize={workspace.actions.toggleMaximize}
                      onSessionChange={workspace.actions.updateCellSession}
                      onChartSettingsChange={workspace.actions.updateCellChartSettings}
                      onPriceScaleChange={workspace.actions.updateCellPriceScale}
                      onIndicatorsChange={workspace.actions.updateCellIndicators}
                      onOpenReplayLauncher={openReplayLauncher}
                      onActiveEnvironmentChange={handleActiveEnvironmentChange}
                    />
                  )}
                />
              </div>
            )}
            rightRail={<div className="workspace-portal-host" ref={setRightRailHost} />}
          />
        )}
        featureSurfaces={<div className="workspace-portal-host" ref={setFeatureSurfacesHost} />}
        statusBar={<div className="workspace-portal-host" ref={setStatusBarHost} />}
      />
      {featureSurfacesHost && workspacePanelOpen && createPortal(
        <Suspense fallback={(
          <div className="workspace-panel-overlay">
            <aside className="workspace-panel workspace-panel-loading" aria-label="正在加载图表工作区" />
          </div>
        )}>
          <WorkspacePanel
            isOpen
            onClose={closeWorkspacePanel}
            runtime={workspace}
            desktop={{
              mode: desktopBootstrap.mode,
              multiWindowEnabled: desktopBootstrap.multiWindowEnabled,
              displayCount: desktopBootstrap.displayCount,
              error: desktopError,
            }}
            viewportIssue={viewportLinkIssue}
          />
        </Suspense>,
        featureSurfacesHost,
      )}
      {showReplayLauncher && replayLaunchContext !== null && (
        <Suspense fallback={null}>
          <ReplayLauncherDialog
            launchContext={replayLaunchContext}
            onRequestClose={closeReplayLauncher}
          />
        </Suspense>
      )}
    </>
  );
}

export default function App() {
  return (
    <AppProviders>
      <MarketDataWorkspaceProvider>
        <LiveWorkspaceApp />
      </MarketDataWorkspaceProvider>
    </AppProviders>
  );
}
