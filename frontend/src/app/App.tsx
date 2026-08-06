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
  ChartDrawingLayerSetId,
  ChartLinkGroupId,
  ChartLinkGroupSettings,
  ChartLinkRole,
  ChartWorkspaceLayout,
  ChartWorkspaceTemplateId,
} from "../features/chart-workspace/chartWorkspaceTypes.js";
import {
  CHART_DRAWING_LAYER_SET_IDS,
  CHART_LINK_GROUP_IDS,
} from "../features/chart-workspace/chartWorkspaceTypes.js";
import {
  ChartLinkCoordinator,
  type ChartLinkViewportIssue,
} from "../features/chart-workspace/chartLinkCoordinator.js";
import {
  chartCellDrawingScopeBase,
  summarizeChartDrawingLink,
  type ChartDrawingLinkSummary,
} from "../features/chart-workspace/chartWorkspaceDrawingLink.js";
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
  { key: "timeAnchor", label: "右端", title: "对齐可视窗口右端时间，并保留各图自己的缩放" },
  { key: "dateRange", label: "范围", title: "同步完整可视日期范围与缩放" },
  { key: "drawings", label: "绘图", title: "同市场、同图层集的图表共享绘图文档" },
];

const LINK_ROLE_OPTIONS: ReadonlyArray<{
  id: ChartLinkRole;
  label: string;
  description: string;
}> = [
  { id: "bidirectional", label: "↔ 双向", description: "品种、周期与视图双向联动；启用绘图共享时可共同编辑" },
  { id: "source", label: "→ 源图", description: "品种、周期与视图只发送；启用绘图共享时可共同编辑" },
  { id: "destination", label: "← 目标图", description: "品种、周期与视图只接收；启用绘图共享时可共同编辑" },
];

function drawingLinkStatusText(summary: ChartDrawingLinkSummary): string {
  if (summary.state === "linked") return `绘图已与 ${summary.linkedPeerCount} 个图表共享`;
  if (summary.state === "waiting") return "绘图联动等待同组图表";
  if (summary.state === "market-mismatch") return "绘图未共享：同组图表的市场身份不同";
  if (summary.state === "layer-mismatch") return "绘图未共享：请选择相同图层集";
  return summary.state === "disabled" ? "绘图联动未开启" : "独立绘图文档";
}

function WorkspaceLinkControls({
  activeCellId,
  group,
  settings,
  role,
  drawingLayerSet,
  drawingSummary,
  viewportIssue,
  disabled,
  onGroupChange,
  onRoleChange,
  onDrawingLayerSetChange,
  onSettingsChange,
}: {
  activeCellId: ChartCellId;
  group: ChartLinkGroupId | null;
  settings: ChartLinkGroupSettings | null;
  role: ChartLinkRole;
  drawingLayerSet: ChartDrawingLayerSetId;
  drawingSummary: ChartDrawingLinkSummary;
  viewportIssue: ChartLinkViewportIssue | null;
  disabled?: boolean;
  onGroupChange(cellId: ChartCellId, group: ChartLinkGroupId | null): void;
  onRoleChange(cellId: ChartCellId, role: ChartLinkRole): void;
  onDrawingLayerSetChange(cellId: ChartCellId, layerSet: ChartDrawingLayerSetId): void;
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
        <details className="workspace-link-advanced">
          <summary title="高级联动设置">
            {role === "source" ? "源" : role === "destination" ? "目" : "↔"}
            <span>高级</span>
          </summary>
          <div className="workspace-link-popover">
            <strong>组 {group} 高级联动</strong>
            <label className="workspace-link-field">
              <span>本图角色</span>
              <select
                aria-label="活动图联动角色"
                value={role}
                disabled={disabled}
                onChange={(event) => onRoleChange(
                  activeCellId,
                  event.currentTarget.value as ChartLinkRole,
                )}
              >
                {LINK_ROLE_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
            <p className="workspace-link-help">
              {LINK_ROLE_OPTIONS.find((option) => option.id === role)?.description}
            </p>
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
            {settings.drawings && (
              <label className="workspace-link-field">
                <span>绘图图层集</span>
                <select
                  aria-label="活动图绘图图层集"
                  value={drawingLayerSet}
                  disabled={disabled}
                  onChange={(event) => onDrawingLayerSetChange(
                    activeCellId,
                    event.currentTarget.value as ChartDrawingLayerSetId,
                  )}
                >
                  {CHART_DRAWING_LAYER_SET_IDS.map((layerSet) => (
                    <option key={layerSet} value={layerSet}>图层 {layerSet}</option>
                  ))}
                </select>
              </label>
            )}
            <p className="workspace-link-status" data-state={drawingSummary.state}>
              {drawingLinkStatusText(drawingSummary)}
            </p>
            {viewportIssue?.group === group && (
              <p className="workspace-link-status warning" role="status">
                {viewportIssue.kind === "timeAnchor" ? "右端时间" : "日期范围"}
                {`无法映射到 ${viewportIssue.failedCellIds.length} 个目标图，目标已保持原位`}
              </p>
            )}
          </div>
        </details>
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
    () => new ChartLinkCoordinator(
      workspace.view.document,
      workspace.view.activeWorkspaceId,
    ),
  );
  const [viewportLinkIssue, setViewportLinkIssue] = useState<ChartLinkViewportIssue | null>(
    () => linkCoordinator.getViewportIssue(),
  );
  useLayoutEffect(() => {
    linkCoordinator.updateDocument(
      workspace.view.document,
      workspace.view.activeWorkspaceId,
    );
  }, [linkCoordinator, workspace.view.activeWorkspaceId, workspace.view.document]);
  useEffect(
    () => linkCoordinator.subscribeViewportIssue(setViewportLinkIssue),
    [linkCoordinator],
  );
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
        role={workspace.view.activeCell.linkRole}
        drawingLayerSet={workspace.view.activeCell.drawingLayerSet}
        drawingSummary={summarizeChartDrawingLink(
          workspace.view.document,
          workspace.view.activeCellId,
          workspace.view.visibleCellIds,
        )}
        viewportIssue={viewportLinkIssue}
        disabled={!workspace.view.ready}
        onGroupChange={workspace.actions.setCellLinkGroup}
        onRoleChange={workspace.actions.setCellLinkRole}
        onDrawingLayerSetChange={workspace.actions.setCellDrawingLayerSet}
        onSettingsChange={workspace.actions.updateLinkGroupSettings}
      />
    </div>
  ), [
    workspace.actions.createWorkspace,
    workspace.actions.deleteWorkspace,
    workspace.actions.duplicateWorkspace,
    workspace.actions.renameWorkspace,
    workspace.actions.setCellLinkGroup,
    workspace.actions.setCellDrawingLayerSet,
    workspace.actions.setCellLinkRole,
    workspace.actions.setLayout,
    workspace.actions.switchWorkspace,
    workspace.actions.updateLinkGroupSettings,
    workspace.status.error,
    workspace.status.persistenceMode,
    workspace.status.saveState,
    workspace.view.activeCell.linkGroup,
    workspace.view.activeCell.drawingLayerSet,
    workspace.view.activeCell.linkRole,
    workspace.view.activeCellId,
    workspace.view.activeWorkspaceId,
    workspace.view.activeWorkspaceName,
    workspace.view.layout,
    workspace.view.document,
    workspace.view.ready,
    workspace.view.visibleCellIds,
    workspace.view.workspaces,
    viewportLinkIssue,
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
                      linkedDrawingScopeBase={chartCellDrawingScopeBase(
                        workspace.view.activeWorkspaceId,
                        workspace.view.document,
                        cellId,
                      )}
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
