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
import { ForegroundPreloadGate } from "../features/market-data/foregroundPreloadGate.js";
import { MarketDataWorkspaceProvider } from "../features/market-data/MarketDataWorkspaceProvider.js";
import { useChartWorkspaceRuntime } from "../features/chart-workspace/useChartWorkspaceRuntime.js";
import type {
  ChartCellId,
  ChartLinkGroupId,
  ChartLinkGroupSettings,
  ChartWorkspaceLayout,
  ChartWorkspaceTemplateId,
} from "../features/chart-workspace/chartWorkspaceTypes.js";
import { CHART_LINK_GROUP_IDS } from "../features/chart-workspace/chartWorkspaceTypes.js";
import { ChartLinkCoordinator } from "../features/chart-workspace/chartLinkCoordinator.js";
import WorkspaceLayoutTree from "../features/chart-workspace/WorkspaceLayoutTree.js";
import WorkspaceSwitcher from "../features/chart-workspace/WorkspaceSwitcher.js";
import { useChartSettingsRuntime } from "../features/settings/chartAppearanceSettings.js";
import { useCacheLimitsSync } from "../features/settings/cacheLimitSettingsRuntime.js";
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
import { loadReplayLauncherDialog } from "./lazySurfaceLoaders.js";
import "../index.css";
import "../features/plugins/pluginTrustUx.css";

const ReplayLauncherDialog = lazy(loadReplayLauncherDialog);

const LAYOUT_OPTIONS: ReadonlyArray<{
  id: ChartWorkspaceTemplateId;
  label: string;
  glyph: string;
}> = [
  { id: "single", label: "单图", glyph: "□" },
  { id: "split-vertical", label: "左右双图", glyph: "▯▯" },
  { id: "split-horizontal", label: "上下双图", glyph: "▭" },
  { id: "main-confirmation", label: "主图与确认图", glyph: "◧" },
  { id: "quad", label: "四图", glyph: "▦" },
];

function WorkspaceLayoutControls({
  layout,
  disabled,
  onChange,
}: {
  layout: ChartWorkspaceLayout;
  disabled?: boolean;
  onChange(layout: ChartWorkspaceTemplateId): void;
}) {
  return (
    <div className="workspace-layout-controls" role="group" aria-label="图表布局">
      {LAYOUT_OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`workspace-layout-button${layout === option.id ? " active" : ""}`}
          onClick={() => onChange(option.id)}
          disabled={disabled}
          aria-pressed={layout === option.id}
          aria-label={option.label}
          title={option.label}
        >
          <span aria-hidden="true">{option.glyph}</span>
        </button>
      ))}
    </div>
  );
}

const LINK_SETTING_OPTIONS: ReadonlyArray<{
  key: keyof ChartLinkGroupSettings;
  label: string;
  title: string;
}> = [
  { key: "market", label: "品种", title: "同步交易所、市场类型和品种" },
  { key: "interval", label: "周期", title: "同步图表周期" },
  { key: "crosshair", label: "十字线", title: "按市场时间同步十字线" },
  { key: "timeRange", label: "时间", title: "同步可视时间范围" },
];

function WorkspaceLinkControls({
  activeCellId,
  group,
  settings,
  disabled,
  onGroupChange,
  onSettingsChange,
}: {
  activeCellId: ChartCellId;
  group: ChartLinkGroupId | null;
  settings: ChartLinkGroupSettings | null;
  disabled?: boolean;
  onGroupChange(cellId: ChartCellId, group: ChartLinkGroupId | null): void;
  onSettingsChange(group: ChartLinkGroupId, patch: Partial<ChartLinkGroupSettings>): void;
}) {
  return (
    <div className="workspace-link-controls" data-link-group={group ?? "none"}>
      <label className="workspace-link-group-select">
        <span>联动</span>
        <select
          aria-label="活动图联动组"
          disabled={disabled}
          value={group ?? ""}
          onChange={(event) => onGroupChange(
            activeCellId,
            (event.currentTarget.value || null) as ChartLinkGroupId | null,
          )}
        >
          <option value="">独立</option>
          {CHART_LINK_GROUP_IDS.map((candidate) => (
            <option key={candidate} value={candidate}>组 {candidate}</option>
          ))}
        </select>
      </label>
      {group && settings && (
        <div className="workspace-link-setting-list" role="group" aria-label={`联动组 ${group} 同步项目`}>
          {LINK_SETTING_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              className="workspace-link-setting"
              aria-pressed={settings[option.key]}
              title={option.title}
              disabled={disabled}
              onClick={() => onSettingsChange(group, {
                [option.key]: !settings[option.key],
              })}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LiveWorkspaceApp() {
  const workspace = useChartWorkspaceRuntime();
  const settings = useChartSettingsRuntime();
  const replayEntry = useReplayEntryCapability();
  const marketRailLayout = useMarketRailLayout();
  const pageExportRef = useRef<HTMLDivElement | null>(null);
  const [linkCoordinator] = useState(
    () => new ChartLinkCoordinator(workspace.view.document),
  );
  useLayoutEffect(() => {
    linkCoordinator.updateDocument(workspace.view.document);
  }, [linkCoordinator, workspace.view.document]);
  const [foregroundPreloadGate] = useState(() => new ForegroundPreloadGate());
  const [activeEnvironment, setActiveEnvironment] = useState<{
    workspaceId: string;
    workspaceRuntimeKey: string;
    cellId: ChartCellId;
    value: ActiveChartEnvironment;
  } | null>(null);
  const [showReplayLauncher, setShowReplayLauncher] = useState(false);
  const currentActiveEnvironment = activeEnvironment?.workspaceId === workspace.view.activeWorkspaceId
    && activeEnvironment.workspaceRuntimeKey === workspace.view.runtimeKey
    ? activeEnvironment
    : null;

  const watchlist = useWatchlistRuntime(currentActiveEnvironment
    ? { subscriptionContext: currentActiveEnvironment.value.subscriptionContext }
    : {});
  const marketRail = useMemo(() => ({
    openViewIds: marketRailLayout.openViewIds,
    onToggleView: marketRailLayout.actions.toggleView,
    viewHeights: marketRailLayout.viewHeights,
    onViewHeightChange: marketRailLayout.actions.setViewHeight,
  }), [
    marketRailLayout.actions.setViewHeight,
    marketRailLayout.actions.toggleView,
    marketRailLayout.openViewIds,
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
    if (workspace.view.document.maximizedCellId == null) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      toggleWorkspaceMaximize(workspace.view.document.maximizedCellId!);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleWorkspaceMaximize, workspace.view.document.maximizedCellId]);

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
    <div className="workspace-top-controls">
      <WorkspaceSwitcher
        activeWorkspaceId={workspace.view.activeWorkspaceId}
        activeWorkspaceName={workspace.view.activeWorkspaceName}
        workspaces={workspace.view.workspaces}
        ready={workspace.view.ready}
        saveState={workspace.status.saveState}
        persistenceMode={workspace.status.persistenceMode}
        error={workspace.status.error}
        onSwitch={workspace.actions.switchWorkspace}
        onCreate={workspace.actions.createWorkspace}
        onDuplicate={workspace.actions.duplicateWorkspace}
        onRename={workspace.actions.renameWorkspace}
        onDelete={workspace.actions.deleteWorkspace}
      />
      <WorkspaceLayoutControls
        layout={workspace.view.layout}
        disabled={!workspace.view.ready}
        onChange={workspace.actions.setLayout}
      />
      <WorkspaceLinkControls
        activeCellId={workspace.view.activeCellId}
        group={workspace.view.activeCell.linkGroup}
        settings={workspace.view.activeCell.linkGroup
          ? workspace.view.document.linkGroups[workspace.view.activeCell.linkGroup]
          : null}
        disabled={!workspace.view.ready}
        onGroupChange={workspace.actions.setCellLinkGroup}
        onSettingsChange={workspace.actions.updateLinkGroupSettings}
      />
    </div>
  ), [
    workspace.actions.createWorkspace,
    workspace.actions.deleteWorkspace,
    workspace.actions.duplicateWorkspace,
    workspace.actions.renameWorkspace,
    workspace.actions.setCellLinkGroup,
    workspace.actions.setLayout,
    workspace.actions.switchWorkspace,
    workspace.actions.updateLinkGroupSettings,
    workspace.status.error,
    workspace.status.persistenceMode,
    workspace.status.saveState,
    workspace.view.activeCell.linkGroup,
    workspace.view.activeCellId,
    workspace.view.activeWorkspaceId,
    workspace.view.activeWorkspaceName,
    workspace.view.layout,
    workspace.view.document.linkGroups,
    workspace.view.ready,
    workspace.view.workspaces,
  ]);
  const gridClassName = [
    "multi-chart-grid",
    `layout-${workspace.view.layout}`,
    workspace.view.document.maximizedCellId ? "has-maximized-cell" : "",
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
                aria-busy={!workspace.view.ready}
              >
                <WorkspaceLayoutTree
                  tree={workspace.view.document.layoutTree}
                  maximizedCellId={workspace.view.document.maximizedCellId}
                  disabled={!workspace.view.ready}
                  onSplitRatioChange={workspace.actions.setLayoutRatio}
                  renderCell={(cellId, layoutRole) => (
                    <LiveChartCell
                      key={`${workspace.view.runtimeKey}:${cellId}`}
                      workspaceId={workspace.view.activeWorkspaceId}
                      cell={workspace.view.document.cells[cellId]}
                      layoutRole={layoutRole}
                      active={workspace.view.activeCellId === cellId}
                      maximized={workspace.view.document.maximizedCellId === cellId}
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
