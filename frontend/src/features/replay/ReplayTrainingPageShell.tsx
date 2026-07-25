import { useCallback, useEffect, useMemo, useState } from "react";
import MarketChartWorkspace from "../../app/MarketChartWorkspace.js";
import MarketPageFrame from "../../app/MarketPageFrame.js";
import MarketStatusBar from "../../app/MarketStatusBar.js";
import MarketTopBarFrame from "../../app/MarketTopBarFrame.js";
import type { ChartSurfaceActions, ChartSurfaceHandle, ChartSurfaceVisibleRange } from "../../chart-adapter/useChartSurfaceRuntime.js";
import type { RefObject } from "react";
import DrawingToolbar from "../../components/DrawingToolbar.js";
import IntervalSelector from "../../components/IntervalSelector.js";
import SingleChartPanes from "../../components/SingleChartPanes.js";
import { loadUserPrefs } from "../chart-session/chartSessionModel.js";
import { useDrawingRuntime } from "../drawings/useDrawingRuntime.js";
import { useChartSettingsRuntime } from "../settings/chartAppearanceSettings.js";
import { groupIntervalsByDuration, parseIntervalSeconds } from "../../utils/intervals.js";
import type { IntervalString } from "../../utils/intervals.js";
import ReplayBottomControlDock from "./components/ReplayBottomControlDock.js";
import ReplayIntegrityReviewPanel from "./components/ReplayIntegrityReviewPanel.js";
import ReplayRightMarketRail from "./components/ReplayRightMarketRail.js";
import ReplaySessionDialog from "./components/ReplaySessionDialog.js";
import { buildReplayCapabilityModel } from "./replayCapabilityModel.js";
import { defaultReplayV2Api } from "./replayV2Api.js";
import { handleReplayShortcut } from "./replayShortcuts.js";
import { returnToTrainingHub } from "./trainingHubNavigation.js";
import { replayEffectiveTrainingState, replayOwnsController } from "./replayUiModel.js";
import { useReplayHistoryRuntime } from "./useReplayHistoryRuntime.js";
import { useReplayIntegrityRuntime } from "./useReplayIntegrityRuntime.js";
import { useReplayPublicTimeRuntime } from "./useReplayPublicTimeRuntime.js";
import type { ReplayIndicatorRuntime } from "./useReplayIndicatorRuntime.js";
import type { ReplayRuntime } from "./useReplayRuntime.js";
import type { ReplayViewerRuntime } from "./useReplayViewerRuntime.js";
import { useReplayWorkspacePreferences } from "./replayWorkspacePreferences.js";


export interface ReplayTrainingPageShellProps {
  readonly runtime: ReplayRuntime;
  readonly indicators: ReplayIndicatorRuntime;
  readonly chartSurfaceRef: RefObject<ChartSurfaceHandle | null>;
  readonly chartSurfaceActions: ChartSurfaceActions;
  readonly viewer: ReplayViewerRuntime;
}

function ReplayStatePanel({ runtime }: { readonly runtime: ReplayRuntime }) {
  if (runtime.phase === "CONFIGURING") return <ReplaySessionDialog runtime={runtime} />;
  if (runtime.phase === "ERROR" || runtime.phase === "ENTRY_ERROR") {
    return (
      <div className="chart-area" data-replay-state="error" data-replay-error={runtime.error?.code ?? "REPLAY_RUNTIME_ERROR"}>
        <div className="error-overlay">
          <div className="error-icon">!</div>
          <div className="error-message">
            <strong>K 线回放不可用</strong><br />
            {runtime.error?.code ?? "REPLAY_RUNTIME_ERROR"}: {runtime.error?.message ?? "Unknown replay error"}
            <small>训练工作区 fail closed；不会回退到 live、mock 或缓存中的其他市场。</small>
          </div>
          {runtime.phase === "ERROR" && <button className="retry-btn" type="button" onClick={runtime.actions.retry}>重试回放能力</button>}
        </div>
      </div>
    );
  }
  const labels: Readonly<Record<string, string>> = {
    IDLE: "准备独立回放运行时…",
    LOADING_CAPABILITIES: "正在加载回放能力…",
    VALIDATING_SESSION: "正在校验服务端 session；HTTP snapshot 不会直接渲染…",
    CONNECTING_SESSION: "等待首个原子 replay snapshot…",
    STOPPED: "回放运行时已释放。",
  };
  return (
    <div className="chart-area" data-replay-state="loading">
      <div className="error-overlay">
        <div className="replay-loading-spinner" />
        <div className="error-message"><strong>K 线回放</strong><br />{labels[runtime.phase] ?? "正在恢复回放…"}<small>加载期间不渲染 live/mock bars。</small></div>
      </div>
    </div>
  );
}

export default function ReplayTrainingPageShell({
  runtime,
  indicators,
  chartSurfaceRef,
  chartSurfaceActions,
  viewer,
}: ReplayTrainingPageShellProps) {
  const [returningToHub, setReturningToHub] = useState(false);
  const [returnToHubError, setReturnToHubError] = useState<string | null>(null);
  const [priceScale] = useState(() => {
    const preferences = loadUserPrefs();
    return {
      invert: Boolean(preferences.invertScale),
      mode: typeof preferences.priceScaleMode === "number" ? preferences.priceScaleMode : 0,
    };
  });
  const { settings, setSettings, resolvedTheme } = useChartSettingsRuntime();
  const drawings = useDrawingRuntime({ chartSurfaceActions, session: null });
  const history = useReplayHistoryRuntime(runtime);
  const integrityRuntime = useReplayIntegrityRuntime(runtime, viewer);
  const workspace = useReplayWorkspacePreferences(runtime.store.sessionId ?? "pending");
  const config = runtime.store.sessionConfig;
  const active = runtime.phase === "ACTIVE" && config !== null && runtime.store.hasAuthoritativeSnapshot;
  const ownsController = replayOwnsController(runtime.store, runtime.clientInstanceId);
  const effectiveState = replayEffectiveTrainingState(
    viewer.marketTracks?.global_clock.state,
    runtime.store.state,
    runtime.store.controllerClientId,
  );
  const capabilities = useMemo(() => buildReplayCapabilityModel(config?.source_kind ?? "BAR"), [config?.source_kind]);
  const publicTimeline = (() => {
    const values = viewer.seriesStore.snapshot().map((bar) => Number(bar.time) * 1_000);
    if (runtime.store.virtualTimeMs !== null) values.push(runtime.store.virtualTimeMs);
    for (const order of runtime.store.orders) values.push(order.created_time_ms);
    for (const fill of runtime.store.fills) values.push(fill.event_time_ms);
    for (const entry of runtime.store.journal) values.push(entry.virtual_time_ms);
    for (const track of viewer.marketTracks?.tracks ?? []) {
      if (track.historical_book?.as_of_virtual_time_ms !== null
        && track.historical_book?.as_of_virtual_time_ms !== undefined) {
        values.push(track.historical_book.as_of_virtual_time_ms);
      }
    }
    return values;
  })();
  const publicTimePolicy = integrityRuntime.integrity?.effective_time_disclosure_policy
    ?? (config?.blind_mode === false ? "NONE" : "HIDE_ALL");
  const publicTimeRuntime = useReplayPublicTimeRuntime({
    runId: integrityRuntime.runId,
    policy: publicTimePolicy,
    originMs: integrityRuntime.integrity?.start_selection.public_start.timeline_ms
      ?? runtime.store.replayStartMs,
    timelineOriginMs: runtime.store.replayStartMs,
    timelineMs: publicTimeline,
  });
  const publicTime = integrityRuntime.integrity?.public_time.label
    ?? (runtime.store.virtualTimeMs === null
      ? "--"
      : publicTimeRuntime.formatTime(runtime.store.virtualTimeMs));
  const formatPublicTime = publicTimeRuntime.formatTime;
  const formatChartTime = useCallback(
    (timeSeconds: number) => formatPublicTime(timeSeconds * 1_000),
    [formatPublicTime],
  );
  const returnToHub = useCallback(async () => {
    const sessionId = runtime.store.sessionId;
    if (sessionId === null || returningToHub) return;
    setReturningToHub(true);
    setReturnToHubError(null);
    try {
      await returnToTrainingHub(sessionId, defaultReplayV2Api);
    } catch (cause) {
      setReturnToHubError(cause instanceof Error ? cause.message : "返回存档大厅失败");
      setReturningToHub(false);
    }
  }, [returningToHub, runtime.store.sessionId]);
  const handleVisibleRangeChange = useCallback((range: ChartSurfaceVisibleRange) => {
    runtime.marketData.actions.onVisibleRangeChange(range);
    const value: Record<string, number> = {};
    if (range.logical !== undefined) {
      value.from_logical_ppm = Math.round(range.logical.from * 1_000_000);
      value.to_logical_ppm = Math.round(range.logical.to * 1_000_000);
    }
    if (range.barSpacing !== undefined) value.bar_spacing_ppm = Math.round(range.barSpacing * 1_000_000);
    if (range.rightOffset !== undefined) value.right_offset_ppm = Math.round(range.rightOffset * 1_000_000);
    integrityRuntime.actions.offerViewAction("VISIBLE_RANGE", "main-chart-range", value);
  }, [integrityRuntime.actions, runtime.marketData.actions]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      handleReplayShortcut(event, (action) => {
        if (!ownsController || runtime.store.connectionState !== "connected"
          || runtime.pendingCommand !== null || viewer.controlPending !== null
          || viewer.viewerPending || runtime.forkPending) return false;
        if (action === "toggle-play" && effectiveState === "PLAYING") {
          void viewer.actions.submitControl("pause", {}).catch(() => undefined);
          return true;
        }
        if (action === "toggle-play" && effectiveState === "PAUSED") {
          void viewer.actions.submitControl("play", {}).catch(() => undefined);
          return true;
        }
        if (action === "step" && effectiveState === "PAUSED") {
          void viewer.actions.submitControl("step_display", { count: 1 }).catch(() => undefined);
          return true;
        }
        if (action === "advance-window" && effectiveState === "PAUSED") {
          const baseMs = (parseIntervalSeconds(config?.base_interval ?? "1m") ?? 60) * 1_000;
          void viewer.actions.submitControl("advance_by", { ms: baseMs * 5 }).catch(() => undefined);
          return true;
        }
        return false;
      });
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [config?.base_interval, effectiveState, ownsController, runtime.forkPending, runtime.pendingCommand, runtime.store.connectionState, viewer.actions, viewer.controlPending, viewer.viewerPending]);

  const interval = (viewer.viewerState?.display_interval ?? config?.base_interval ?? "1m") as IntervalString;
  const displayIntervals = useMemo(() => {
    const base = (config?.base_interval ?? "1m") as IntervalString;
    const baseSeconds = parseIntervalSeconds(base);
    const candidates = new Set<IntervalString>([base, "1m", "5m", "15m", "1h"] as IntervalString[]);
    return [...candidates]
      .map((value) => ({ value, seconds: parseIntervalSeconds(value) }))
      .filter((item): item is { value: IntervalString; seconds: number } => (
        baseSeconds !== null
        && item.seconds !== null
        && item.seconds >= baseSeconds
        && item.seconds % baseSeconds === 0
      ))
      .sort((left, right) => left.seconds - right.seconds);
  }, [config?.base_interval]);
  const nativeIntervals = useMemo(() => displayIntervals.map(({ value, seconds }) => ({
    value,
    seconds,
    label: value,
  })), [displayIntervals]);
  const intervalGroups = useMemo(() => groupIntervalsByDuration(displayIntervals.map(({ value, seconds }) => ({
    value,
    seconds,
    label: value,
    isCustom: false,
  }))), [displayIntervals]);
  const viewerLast = viewer.seriesStore.last();
  const viewerFirst = viewer.seriesStore.first();
  const viewerBarCount = viewer.seriesStore.barCount;
  const viewerDataMeta = {
    ...runtime.marketData.view.meta,
    version: Number(viewer.seriesStore.version),
    status: viewer.loading ? "loading" : "ready",
    source: "replay-viewer-rebuild",
    seriesKey: viewer.seriesStore.seriesKey,
    interval,
    bars: viewerBarCount,
    firstTime: viewerFirst?.time ?? null,
    lastTime: viewerLast?.time ?? null,
  };
  const last = viewerLast ?? runtime.store.lastPrice;
  const isUp = Number(last?.close ?? 0) >= Number(last?.open ?? 0);
  const chart = active && viewerBarCount > 0 && config !== null ? (
    <SingleChartPanes
      ref={chartSurfaceRef}
      seriesStore={viewer.seriesStore}
      symbol={config.symbol}
      drawingKeyBase={`replay:${runtime.store.sessionId ?? "unknown"}`}
      interval={interval}
      loading={runtime.marketData.view.loading || viewer.loading || history.loading}
      onCrosshairMove={runtime.marketData.actions.onCrosshairMove}
      onNeedMoreLeft={history.loadMoreLeft}
      canLoadMoreLeft={history.hasMore}
      datasetKey={String(viewer.seriesStore.seriesKey ?? "replay-viewer-uninitialized")}
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
      timezone={settings.timezone ?? "UTC"}
      timeFormatter={formatChartTime}
      tickMarkFormatter={formatChartTime}
      dataMeta={viewerDataMeta}
      onVisibleRangeChange={handleVisibleRangeChange}
      drawingTool={drawings.view.drawingTool}
      onDrawingToolChange={drawings.actions.setDrawingTool}
      penColor={drawings.view.penColor}
      penSize={drawings.view.penSize}
      textFontSize={drawings.view.textFontSize}
      textBold={drawings.view.textBold}
      textItalic={drawings.view.textItalic}
      fibLevels={drawings.view.fibLevels}
      fibInverted={drawings.view.fibInverted}
      positionSize={drawings.view.positionSize}
      drawingSnapEnabled={drawings.view.drawingSnapEnabled}
      onSelectedDrawingChange={drawings.actions.handleSelectedDrawingChange}
      mainOverlayLines={[...indicators.mainOverlayLines]}
      invertScale={priceScale.invert}
      priceScaleMode={priceScale.mode}
    />
  ) : active ? (
    <div className="chart-area" data-replay-state="empty"><div className="error-overlay"><div className="error-message"><strong>尚无已揭示 BAR</strong><br />服务端 snapshot 为空；不会使用 live/mock 数据填充。</div></div></div>
  ) : <ReplayStatePanel runtime={runtime} />;

  const drawingToolbar = (
    <DrawingToolbar
      activeTool={drawings.view.drawingTool}
      onToolChange={drawings.actions.setDrawingTool}
      penColor={drawings.view.penColor}
      onPenColorChange={drawings.actions.setPenColor}
      penSize={drawings.view.penSize}
      onPenSizeChange={drawings.actions.setPenSize}
      onClearAll={drawings.actions.handleClearDrawing}
      drawingsHidden={drawings.view.drawingsHidden}
      onToggleDrawingsHidden={drawings.actions.handleToggleDrawingsHidden}
      drawingSnapEnabled={drawings.view.drawingSnapEnabled}
      onDrawingSnapEnabledChange={drawings.actions.handleDrawingSnapEnabledChange}
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
      chartType={settings.chartType}
      onChartTypeChange={(chartType) => setSettings((current) => ({ ...current, chartType }))}
    />
  );

  return (
    <MarketPageFrame
      topBar={(
        <MarketTopBarFrame
          source="replay"
          className="replay-top-bar"
          brandIcon="◀"
          brandText="CandleScope"
          navigation={<span className="replay-mode-badge">REPLAY TRAINING</span>}
          identity={config && (
            <button className="replay-identity-readonly" type="button" title="活动 run 的来源身份不可变；请新建或 Fork。">
              {config.exchange} · {config.market_type} · {config.symbol} · base {config.base_interval}
            </button>
          )}
          controls={<>
            <button className="indicator-toggle-btn active" type="button" title="本地指标仅使用已揭示前缀">📊<span className="indicator-badge">{indicators.status.sourceBarCount}</span></button>
            <button className="indicator-toggle-btn alert-toggle-btn" type="button" disabled title={capabilities.ALERTS.state}>🔔</button>
          </>}
          quote={last && (
            <div className="price-info"><span className={`current-price ${isUp ? "price-up" : "price-down"}`}>{last.close}</span><span className="price-change">{isUp ? "▲" : "▼"} REPLAY</span></div>
          )}
          marketMetrics={(
            <div className="advanced-market-summary advanced-market-summary-unsupported" aria-label="Replay derivatives capability summary">
              {(["MARK_PRICE", "INDEX_PRICE", "BASIS"] as const).map((id) => (
                <div className="advanced-market-chip" key={id} data-market-metric={id.toLowerCase()} data-capability-state={capabilities[id].state}>
                  <span className="advanced-market-chip-label">{capabilities[id].label}</span>
                  <span className="advanced-market-chip-value">--</span>
                  <span className="advanced-market-chip-suffix">{capabilities[id].state}</span>
                </div>
              ))}
            </div>
          )}
          ohlcv={last && (
            <div className="ohlcv-bar">
              <div className="ohlcv-item"><span className="ohlcv-label">O</span><span className="ohlcv-value">{last.open}</span></div>
              <div className="ohlcv-item"><span className="ohlcv-label">H</span><span className="ohlcv-value">{last.high}</span></div>
              <div className="ohlcv-item"><span className="ohlcv-label">L</span><span className="ohlcv-value">{last.low}</span></div>
              <div className="ohlcv-item"><span className="ohlcv-label">C</span><span className="ohlcv-value">{last.close}</span></div>
              <div className="ohlcv-item"><span className="ohlcv-label">Vol</span><span className="ohlcv-value">{last.volume}</span></div>
            </div>
          )}
          trailing={<>
            {active && runtime.store.sessionId !== null && <button className="replay-return-hub" type="button" disabled={returningToHub} title={returnToHubError ?? "服务端暂停并写入 checkpoint 后返回存档大厅"} onClick={() => void returnToHub()}>{returningToHub ? "正在保存…" : "存档大厅"}</button>}
            <a className="replay-live-link" href="/" target="_blank" rel="noopener noreferrer">实时行情 ↗</a>
          </>}
        />
      )}
      intervalSelector={(
        <IntervalSelector
          interval={interval}
          capabilityReady={config !== null && viewer.viewerState !== null && !viewer.viewerPending}
          capabilityLoading={config === null || viewer.loading || viewer.viewerPending}
          nativeIntervals={nativeIntervals}
          intervalGroups={intervalGroups}
          customIntervalRecords={[]}
          savedCustomIntervals={[]}
          onSelectInterval={(next) => { void viewer.actions.setDisplayInterval(next).catch(() => undefined); }}
          onCreateCustomInterval={() => ({ ok: false, message: "Phase 3 仅开放可证明的固定周期倍数" })}
          onRemoveCustomInterval={() => undefined}
          onRestoreCustomInterval={() => undefined}
          onTogglePinCustomInterval={() => null}
          onClearCustomIntervals={() => undefined}
          intervalNotice={{
            type: viewer.error ? "error" : "info",
            text: viewer.error ?? `ViewerState r${viewer.viewerState?.semantic_view_revision ?? "--"} · ${publicTime}`,
          }}
        />
      )}
      workspace={(
        <MarketChartWorkspace
          toolbar={drawingToolbar}
          exportOverlay={null}
          chart={chart}
          rightRail={active ? (
            <ReplayRightMarketRail
              runtime={runtime}
              viewer={viewer}
              indicators={indicators}
              preferences={workspace.preferences}
              actions={workspace.actions}
              upColor={settings.upColor}
              downColor={settings.downColor}
              formatTime={publicTimeRuntime.formatTime}
            />
          ) : null}
        />
      )}
      featureSurfaces={active ? <><ReplayIntegrityReviewPanel runtime={runtime} integrityRuntime={integrityRuntime} /><ReplayBottomControlDock runtime={runtime} viewer={viewer} publicTimeLabel={publicTime} /></> : null}
      statusBar={(
        <MarketStatusBar
          source="replay"
          className="replay-status-bar"
          connectionStatus={runtime.store.connectionState}
          dataAttributes={{
            "data-replay-generation": runtime.store.generation,
            "data-replay-session-state": effectiveState ?? "",
            "data-replay-adapter-state": runtime.store.state ?? "",
            "data-replay-source-sequence": runtime.store.sourceSequence,
            "data-replay-revision": runtime.store.revision,
            "data-replay-state-hash": runtime.store.stateHash ?? "",
            "data-replay-cursor-ms": runtime.store.virtualTimeMs ?? "",
            "data-replay-max-bar-ms": viewerLast?.time === undefined ? "" : Number(viewerLast.time) * 1_000,
            "data-replay-last-bar-closed": String(viewerLast?.replayClosed ?? ""),
            "data-replay-order-count": runtime.store.orders.length,
            "data-replay-fill-count": runtime.store.fills.length,
            "data-replay-revealed": String(runtime.store.revealed),
            "data-replay-history-epoch": history.historyEpoch ?? "",
            "data-replay-view-interval": interval,
            "data-replay-view-revision": viewer.viewerState?.semantic_view_revision ?? "",
            "data-replay-time-disclosure-policy": integrityRuntime.integrity?.effective_time_disclosure_policy ?? "",
            "data-replay-result-label": integrityRuntime.integrity?.result_label ?? "",
            "data-replay-public-time-projections": publicTimeRuntime.projectedCount,
            "data-replay-public-time-state": publicTimeRuntime.error === null
              ? (publicTimeRuntime.loading ? "loading" : "ready")
              : "relative-fallback",
            "data-replay-review-read-only": integrityRuntime.review?.read_only === true ? "true" : "false",
          }}
          left={<>
            <span><span className={`status-dot ${runtime.store.connectionState === "connected" ? "connected" : "loading"}`} />K 线回放 · REPLAY</span>
            <span>{effectiveState ?? runtime.phase}</span>
            <span>{viewerBarCount} display bars</span>
            {history.loading && <span>Loading older replay data…</span>}
            {!history.hasMore && !history.loading && <span>No more frozen history</span>}
            {history.error && <span className="replay-history-error">{history.error}</span>}
          </>}
          right={<>
            <span>Controller: {ownsController ? "本页" : runtime.store.controllerClientId ? "其他页面" : "无"}</span>
            <span>{config?.source_kind.toUpperCase() ?? "BAR"} · {config?.quality_mode.toUpperCase() ?? "EXACT"}</span>
            <span>无 live feeds · replay.v2 shell / replay.v1 adapter</span>
          </>}
        />
      )}
    />
  );
}
