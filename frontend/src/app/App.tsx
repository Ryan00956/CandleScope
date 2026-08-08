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
import { flushSync } from "react-dom";
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
import { chartWorkspaceCell } from "../features/chart-workspace/chartWorkspaceDocument.js";
import WorkspaceLayoutTree from "../features/chart-workspace/WorkspaceLayoutTree.js";
import { chartWorkspaceTemplateCellCount } from "../features/chart-workspace/chartWorkspaceLayout.js";
import WorkspaceSwitcher from "../features/chart-workspace/WorkspaceSwitcher.js";
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
import { loadReplayLauncherDialog } from "./lazySurfaceLoaders.js";
import {
  desktopWindowManager,
  type DesktopBootstrap,
} from "../desktop/desktopWindowManager.js";
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
  { id: "grid-6", label: "六图（2×3）", glyph: "6" },
  { id: "grid-8", label: "八图（2×4）", glyph: "8" },
  { id: "grid-9", label: "九图（3×3）", glyph: "9" },
  { id: "grid-12", label: "十二图（3×4）", glyph: "12" },
  { id: "grid-16", label: "十六图（4×4）", glyph: "16" },
];

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

function WorkspaceLayoutControls({
  layout,
  disabled,
  locked,
  canUndo,
  canRedo,
  maxCellsPerWindow,
  onChange,
  onUndo,
  onRedo,
  onReset,
  onLockChange,
}: {
  layout: ChartWorkspaceLayout;
  disabled?: boolean;
  locked: boolean;
  canUndo: boolean;
  canRedo: boolean;
  maxCellsPerWindow: number;
  onChange(layout: ChartWorkspaceTemplateId): void;
  onUndo(): void;
  onRedo(): void;
  onReset(): void;
  onLockChange(locked: boolean): void;
}) {
  return (
    <div
      className="workspace-layout-controls"
      role="group"
      aria-label="图表布局"
      data-layout-locked={locked ? "true" : "false"}
    >
      {LAYOUT_OPTIONS.filter((option) => (
        chartWorkspaceTemplateCellCount(option.id) <= maxCellsPerWindow
      )).map((option) => (
        <button
          key={option.id}
          type="button"
          className={`workspace-layout-button${layout === option.id ? " active" : ""}`}
          onClick={() => onChange(option.id)}
          disabled={disabled || locked}
          aria-pressed={layout === option.id}
          aria-label={option.label}
          title={option.label}
        >
          <span aria-hidden="true">{option.glyph}</span>
        </button>
      ))}
      <span className="workspace-layout-action-separator" aria-hidden="true" />
      <button
        type="button"
        className="workspace-layout-button workspace-layout-history-button"
        onClick={onUndo}
        disabled={disabled || locked || !canUndo}
        aria-label="撤销上一次布局修改"
        title="撤销上一次布局修改（Ctrl+Z）"
      >
        ↶
      </button>
      <button
        type="button"
        className="workspace-layout-button workspace-layout-history-button"
        onClick={onRedo}
        disabled={disabled || locked || !canRedo}
        aria-label="重做上一次布局修改"
        title="重做上一次布局修改（Ctrl+Shift+Z / Ctrl+Y）"
      >
        ↷
      </button>
      <button
        type="button"
        className="workspace-layout-button workspace-layout-reset-button"
        onClick={onReset}
        disabled={disabled || locked}
        aria-label="只保留当前图表"
        title="重置布局，只保留当前图表"
      >
        ⟲
      </button>
      <button
        type="button"
        className={`workspace-layout-button workspace-layout-lock-button${locked ? " active" : ""}`}
        onClick={() => onLockChange(!locked)}
        disabled={disabled}
        aria-label={locked ? "解锁布局" : "锁定布局"}
        aria-pressed={locked}
        title={locked ? "布局已锁定；点击解锁" : "锁定布局，防止误拖、误关或误调整"}
      >
        {locked ? "🔒" : "🔓"}
      </button>
    </div>
  );
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable
    || target.tagName === "INPUT"
    || target.tagName === "TEXTAREA"
    || target.tagName === "SELECT";
}

function WorkspaceWindowControls({
  bootstrap,
  currentWindowId,
  windowCount,
  disabled,
  error,
  onCreate,
  onClose,
}: {
  bootstrap: DesktopBootstrap;
  currentWindowId: string;
  windowCount: number;
  disabled: boolean;
  error: string | null;
  onCreate(): void;
  onClose(): void;
}) {
  const nativeEnabled = bootstrap.mode === "native" && bootstrap.multiWindowEnabled;
  const status = bootstrap.mode === "web"
    ? "Web 单窗口（原生多窗口不可用）"
    : nativeEnabled
      ? windowCount >= 4
        ? "4/4 窗口 · 64/64 图 · 已达应用上限"
        : `${windowCount}/4 窗口 · ${bootstrap.displayCount} 显示器`
      : "原生多窗口未启用";
  return (
    <div
      className="workspace-window-controls"
      data-desktop-mode={bootstrap.mode}
      data-multi-window-enabled={nativeEnabled ? "true" : "false"}
      title={error || status}
    >
      <span className="workspace-window-status" role="status">{error || status}</span>
      {nativeEnabled && (
        <>
          <button
            type="button"
            className="workspace-layout-button"
            onClick={onCreate}
            disabled={disabled || windowCount >= 4}
            aria-label="新建原生图表窗口"
            title={windowCount >= 4
              ? "已达 4 窗口 / 64 图硬上限；请先关闭一个窗口"
              : "复制当前布局到新的原生窗口"}
          >
            +屏
          </button>
          {currentWindowId !== "main-window" && (
            <button
              type="button"
              className="workspace-layout-button"
              onClick={onClose}
              disabled={disabled}
              aria-label="关闭当前原生图表窗口"
              title="关闭当前窗口并保留其他窗口"
            >
              −屏
            </button>
          )}
        </>
      )}
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
    <div className="workspace-top-controls">
      <WorkspaceSwitcher
        activeWorkspaceId={workspace.view.activeWorkspaceId}
        activeWorkspaceName={workspace.view.activeWorkspaceName}
        workspaces={workspace.view.workspaces}
        ready={workspace.view.ready}
        saveState={workspace.status.saveState}
        persistenceMode={workspace.status.persistenceMode}
        error={workspace.status.error}
        maxCellsPerWindow={workspace.view.maxCellsPerWindow}
        onSwitch={workspace.actions.switchWorkspace}
        onCreate={workspace.actions.createWorkspace}
        onDuplicate={workspace.actions.duplicateWorkspace}
        onRename={workspace.actions.renameWorkspace}
        onDelete={workspace.actions.deleteWorkspace}
      />
      <WorkspaceLayoutControls
        layout={workspace.view.layout}
        disabled={!workspace.view.ready}
        locked={workspace.view.layoutLocked}
        canUndo={workspace.view.canUndoLayout}
        canRedo={workspace.view.canRedoLayout}
        maxCellsPerWindow={workspace.view.maxCellsPerWindow}
        onChange={workspace.actions.setLayout}
        onUndo={workspace.actions.undoLayout}
        onRedo={workspace.actions.redoLayout}
        onReset={workspace.actions.resetLayout}
        onLockChange={workspace.actions.setLayoutLocked}
      />
      <WorkspaceWindowControls
        bootstrap={desktopBootstrap}
        currentWindowId={workspace.view.window.id}
        windowCount={Object.keys(workspace.view.document.windows).length}
        disabled={!workspace.view.ready}
        error={desktopError}
        onCreate={workspace.actions.createWindow}
        onClose={() => workspace.actions.closeWindow(workspace.view.window.id)}
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
    workspace.actions,
    workspace.status.error,
    workspace.status.persistenceMode,
    workspace.status.saveState,
    desktopBootstrap,
    desktopError,
    workspace.view.activeCell.linkGroup,
    workspace.view.activeCell.drawingLayerSet,
    workspace.view.activeCell.linkRole,
    workspace.view.activeCellId,
    workspace.view.activeWorkspaceId,
    workspace.view.activeWorkspaceName,
    workspace.view.layout,
    workspace.view.canRedoLayout,
    workspace.view.canUndoLayout,
    workspace.view.layoutLocked,
    workspace.view.maxCellsPerWindow,
    workspace.view.document,
    workspace.view.ready,
    workspace.view.visibleCellIds,
    workspace.view.workspaces,
    workspace.view.window.id,
    viewportLinkIssue,
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
