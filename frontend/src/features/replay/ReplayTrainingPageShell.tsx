import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TickMarkType } from "../../chart-adapter/chartAdapterTypes.js";
import MarketChartWorkspace from "../../app/MarketChartWorkspace.js";
import MarketPageFrame from "../../app/MarketPageFrame.js";
import MarketStatusBar from "../../app/MarketStatusBar.js";
import MarketTopBarFrame from "../../app/MarketTopBarFrame.js";
import type { ChartSurfaceActions, ChartSurfaceHandle, ChartSurfaceVisibleRange } from "../../chart-adapter/useChartSurfaceRuntime.js";
import type { RefObject } from "react";
import type { SurfaceViewportSnapshot } from "../chart-representation/chartRepresentationTypes.js";
import DrawingToolbar from "../../components/DrawingToolbar.js";
import IntervalSelector from "../../components/IntervalSelector.js";
import SingleChartPanes from "../../components/SingleChartPanes.js";
import IndicatorPanel from "../indicators/IndicatorPanel.js";
import type { IndicatorHLine, IndicatorMarker } from "../indicators/indicatorTypes.js";
import {
  providedBarsIndicatorSupport,
} from "../indicators/useProvidedBarsIndicatorRuntime.js";
import { useCustomIntervals } from "../chart-session/customIntervalStore.js";
import { useIntervalNoticeRuntime } from "../chart-session/intervalNoticeRuntime.js";
import { loadUserPrefs } from "../chart-session/chartSessionModel.js";
import type { CustomIntervalRecord } from "../chart-session/chartSessionTypes.js";
import { useDrawingRuntime } from "../drawings/useDrawingRuntime.js";
import { createEmptyDrawingDocument } from "../drawings/core/drawingDocument.js";
import { drawingDocumentSessionRegistry } from "../drawings/core/drawingDocumentStore.js";
import { useChartSettingsRuntime } from "../settings/chartAppearanceSettings.js";
import { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import {
  intervalsSemanticallyEquivalent,
  parseIntervalSeconds,
} from "../../utils/intervals.js";
import type { IntervalString } from "../../utils/intervals.js";
import ReplayBottomControlDock from "./components/ReplayBottomControlDock.js";
import ReplayIntegrityReviewPanel from "./components/ReplayIntegrityReviewPanel.js";
import ReplayTrainingResultsPanel from "./components/ReplayTrainingResultsPanel.js";
import ReplayRightMarketRail from "./components/ReplayRightMarketRail.js";
import { buildReplayCapabilityModel } from "./replayCapabilityModel.js";
import {
  buildReplayIntervalCatalog,
  canProjectReplayDisplayInterval,
  replayIntervalUnavailableMessage,
} from "./replayIntervalPolicy.js";
import { defaultReplayApi } from "./replayApi.js";
import { defaultReplayV2Api } from "./replayV2Api.js";
import {
  applyReplayHistoryPage,
  ReplayHistoryProvider,
} from "./replayHistoryProvider.js";
import {
  isReplayContextHistoryBar,
  rebuildReplayViewerSeries,
} from "./replayViewerProjection.js";
import { handleReplayShortcut } from "./replayShortcuts.js";
import {
  formatReplayTimeAxisLabel,
  replayTimeAxisMaxCharacterLength,
} from "./replayPublicTimeModel.js";
import { returnToTrainingHub } from "./trainingHubNavigation.js";
import { replayEffectiveTrainingState, replayOwnsController } from "./replayUiModel.js";
import { useReplayHistoryRuntime } from "./useReplayHistoryRuntime.js";
import { useReplayIntegrityRuntime } from "./useReplayIntegrityRuntime.js";
import { useReplayPublicTimeRuntime } from "./useReplayPublicTimeRuntime.js";
import type {
  ReplaySharedIndicatorRuntime,
} from "./useReplaySharedIndicatorRuntime.js";
import type { ReplayRuntime } from "./useReplayRuntime.js";
import type { ReplayViewerRuntime } from "./useReplayViewerRuntime.js";
import { useReplayWorkspacePreferences } from "./replayWorkspacePreferences.js";
import {
  replayReviewDocumentHash,
  replayReviewDrawingDocument,
  replayReviewDrawingRecord,
} from "./replayReviewDrawing.js";
import type { ReplayReviewResponse } from "./replayIntegrityModel.js";


export interface ReplayTrainingPageShellProps {
  readonly runtime: ReplayRuntime;
  readonly indicators: ReplaySharedIndicatorRuntime;
  readonly chartSurfaceRef: RefObject<ChartSurfaceHandle | null>;
  readonly chartSurfaceActions: ChartSurfaceActions;
  readonly viewer: ReplayViewerRuntime;
}

interface ReplayIntervalViewportTransfer {
  readonly snapshot: SurfaceViewportSnapshot;
  readonly targetInterval: IntervalString;
}

function ReplayReviewRightRail({ review }: { readonly review: ReplayReviewResponse }) {
  const selectedTrackId = String(review.projection.viewer_state.selected_track_id ?? "");
  const selected = review.projection.tracks.find((track) => track.track_id === selectedTrackId)
    ?? review.projection.tracks[0]
    ?? null;
  const position = selected?.position;
  const positionRecord = position !== null && typeof position === "object"
    && !Array.isArray(position)
    ? position as Readonly<Record<string, unknown>>
    : null;
  const account = selected?.account;
  const accountRecord = account !== null && typeof account === "object"
    && !Array.isArray(account)
    ? account as Readonly<Record<string, unknown>>
    : null;
  return (
    <aside
      className="replay-review-right-rail"
      aria-label="ReviewMode 只读组合"
      data-review-track-id={selectedTrackId}
    >
      <span className="training-hub-kicker">REVIEW · READ ONLY</span>
      <h3>{String(selected?.symbol ?? "--")}</h3>
      <dl>
        <div><dt>公开时间</dt><dd>{review.events.find((event) => event.event_id === review.selected_event_id)?.public_time.label ?? "--"}</dd></div>
        <div><dt>权益</dt><dd>{String(review.projection.domain.equity ?? "--")}</dd></div>
        <div><dt>仓位</dt><dd>{String(positionRecord?.quantity ?? "--")}</dd></div>
        <div><dt>未实现盈亏</dt><dd>{String(positionRecord?.unrealized_pnl ?? "--")}</dd></div>
        <div><dt>可用权益</dt><dd>{String(accountRecord?.available_equity ?? "--")}</dd></div>
        <div><dt>订单 / 成交</dt><dd>{review.projection.orders.length} / {review.projection.fills.length}</dd></div>
        <div><dt>账本</dt><dd>{review.projection.ledger.length}</dd></div>
        <div><dt>绘图版本</dt><dd>r{review.projection.drawing_revision}</dd></div>
      </dl>
      <p>该侧栏来自选中事件投影，不读取活动 Run 的当前组合。</p>
    </aside>
  );
}

function ReplayStatePanel({ runtime }: { readonly runtime: ReplayRuntime }) {
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
  const [integrityOpen, setIntegrityOpen] = useState(false);
  const [trainingResultsOpen, setTrainingResultsOpen] = useState(false);
  const [indicatorPanelOpen, setIndicatorPanelOpen] = useState(false);
  const [intervalViewportTransfer, setIntervalViewportTransfer] = useState<ReplayIntervalViewportTransfer | null>(null);
  const intervalCommandOwnerRef = useRef<object | null>(null);
  const {
    customIntervalRecords,
    savedCustomIntervals,
    addCustomInterval,
    markIntervalUsed,
    removeCustomInterval,
    restoreCustomInterval,
    togglePinCustomInterval,
    clearCustomIntervals,
  } = useCustomIntervals();
  const { intervalNotice, showIntervalNotice } = useIntervalNoticeRuntime();
  const lastRemovedIntervalRef = useRef<CustomIntervalRecord | null>(null);
  const integrityToggleRef = useRef<HTMLButtonElement | null>(null);
  const integrityDrawerRef = useRef<HTMLElement | null>(null);
  const [priceScale] = useState(() => {
    const preferences = loadUserPrefs();
    return {
      invert: Boolean(preferences.invertScale),
      mode: typeof preferences.priceScaleMode === "number" ? preferences.priceScaleMode : 0,
    };
  });
  const { settings, setSettings, resolvedTheme } = useChartSettingsRuntime();
  const drawings = useDrawingRuntime({ chartSurfaceActions, session: null });
  const activeIntervalViewportTransfer = intervalViewportTransfer !== null
    && intervalsSemanticallyEquivalent(
      viewer.viewerState?.display_interval
        ?? runtime.store.sessionConfig?.base_interval
        ?? "1m",
      intervalViewportTransfer.targetInterval,
    )
    ? intervalViewportTransfer.snapshot
    : null;
  const history = useReplayHistoryRuntime(runtime, viewer, activeIntervalViewportTransfer);
  useEffect(() => {
    if (!history.viewportTransferUnavailable
      || activeIntervalViewportTransfer === null) return;
    setIntervalViewportTransfer((current) => (
      current?.snapshot === activeIntervalViewportTransfer ? null : current
    ));
  }, [activeIntervalViewportTransfer, history.viewportTransferUnavailable]);
  const integrityRuntime = useReplayIntegrityRuntime(runtime, viewer);
  const review = integrityRuntime.review;
  useEffect(() => {
    if (review !== null && !trainingResultsOpen) setIntegrityOpen(true);
  }, [review, trainingResultsOpen]);
  useEffect(() => {
    if (review !== null) setIndicatorPanelOpen(false);
  }, [review]);
  useEffect(() => {
    if (!integrityOpen) return undefined;
    const drawer = integrityDrawerRef.current;
    const toggle = integrityToggleRef.current;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setIntegrityOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    requestAnimationFrame(() => drawer?.focus());
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      requestAnimationFrame(() => toggle?.focus());
    };
  }, [integrityOpen]);
  const liveDrawingScopeBase = integrityRuntime.runId === null
    ? `replay-run:pending`
    : `replay-run:${integrityRuntime.runId}`;
  const reviewDrawingScopeBase = review === null
    ? null
    : `replay-review:${review.review_id}`;
  const reviewDrawingDocument = review?.drawing_document ?? null;
  const reviewDrawingCursorRevision = review?.cursor_revision ?? null;
  const reviewSelectedTrackId = review === null
    ? null
    : String(review.projection.viewer_state.selected_track_id ?? "");
  const reviewProjectedTrack = reviewSelectedTrackId === null
    ? undefined
    : review?.projection.tracks.find((item) => (
      item.track_id === reviewSelectedTrackId
    ));
  const reviewProjectedExchange = reviewProjectedTrack?.exchange;
  const reviewProjectedMarketType = reviewProjectedTrack?.market_type;
  const reviewProjectedSourceKind = reviewProjectedTrack?.source_kind;
  const reviewProjectedSymbol = reviewProjectedTrack?.symbol;
  const reviewProjectedInterval = review?.projection.viewer_state.display_interval;
  const reviewCursorVirtualTimeMs = review?.projection.cursor.virtual_time_ms ?? null;
  const drawingScopeBase = reviewDrawingScopeBase ?? liveDrawingScopeBase;
  const reviewSeriesStore = useMemo(() => new SeriesWindowStore(), []);
  const [reviewChartLoading, setReviewChartLoading] = useState(false);
  const [reviewChartError, setReviewChartError] = useState<string | null>(null);
  const [reviewChartBounded, setReviewChartBounded] = useState(false);
  const [liveDrawingError, setLiveDrawingError] = useState<string | null>(null);
  const [reviewDrawingError, setReviewDrawingError] = useState<string | null>(null);
  const workspace = useReplayWorkspacePreferences(runtime.store.sessionId ?? "pending");
  const config = runtime.store.sessionConfig;
  const active = runtime.phase === "ACTIVE" && config !== null && runtime.store.hasAuthoritativeSnapshot;
  const ownsController = replayOwnsController(runtime.store, runtime.clientInstanceId);
  const globalClock = viewer.marketTracks?.global_clock ?? null;
  const effectiveState = replayEffectiveTrainingState(
    globalClock?.state,
    runtime.store.state,
    runtime.store.controllerClientId,
  );
  const capabilities = useMemo(() => buildReplayCapabilityModel(config?.source_kind ?? "BAR"), [config?.source_kind]);
  const publicTimeline = (() => {
    const values = viewer.seriesStore.snapshot()
      .filter((bar) => !isReplayContextHistoryBar(bar))
      .map((bar) => Number(bar.time) * 1_000);
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
  const formatChartTick = useCallback(
    (timeSeconds: number, tickMarkType: TickMarkType) => formatReplayTimeAxisLabel(
      publicTimePolicy,
      formatPublicTime(timeSeconds * 1_000),
      tickMarkType,
    ),
    [formatPublicTime, publicTimePolicy],
  );
  const returnToHub = useCallback(async () => {
    const runId = viewer.viewerState?.run_id ?? null;
    if (runId === null || returningToHub) return;
    setReturningToHub(true);
    setReturnToHubError(null);
    try {
      await returnToTrainingHub(runId, defaultReplayV2Api);
    } catch (cause) {
      setReturnToHubError(cause instanceof Error ? cause.message : "返回存档大厅失败");
      setReturningToHub(false);
    }
  }, [returningToHub, viewer.viewerState?.run_id]);

  useEffect(() => {
    setLiveDrawingError(null);
    const runId = integrityRuntime.runId;
    if (runId === null || !integrityRuntime.drawingLoaded) return;
    const current = integrityRuntime.currentDrawing;
    if (current === null) {
      setLiveDrawingError("服务端绘图证据已标记完成但缺少当前文档响应");
      return;
    }
    const scopeKey = `replay-run:${runId}__main`;
    const store = drawingDocumentSessionRegistry.getStore(scopeKey);
    try {
      if (current.document !== null && !store.dirty) {
        const document = replayReviewDrawingDocument(current.document, scopeKey);
        const loaded = store.loadDocument(document);
        if (!loaded.ok) throw new Error(loaded.error);
      }
      drawingDocumentSessionRegistry.markLoaded(scopeKey, store);
    } catch (cause) {
      setLiveDrawingError(
        cause instanceof Error ? cause.message : "Run 绘图文档恢复失败",
      );
    }
  }, [
    integrityRuntime.currentDrawing,
    integrityRuntime.drawingLoaded,
    integrityRuntime.runId,
  ]);

  useEffect(() => {
    const runId = integrityRuntime.runId;
    const currentDrawing = integrityRuntime.currentDrawing;
    if (runId === null
      || !integrityRuntime.drawingLoaded
      || currentDrawing === null
      || liveDrawingError !== null) return;
    const scopeKey = `replay-run:${runId}__main`;
    const store = drawingDocumentSessionRegistry.getStore(scopeKey);
    const recordDrawing = integrityRuntime.actions.recordDrawing;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const snapshot = store.getSnapshot();
        const revision = snapshot.documentRevision;
        void (async () => {
          const document = replayReviewDrawingRecord(snapshot, runId);
          const hash = await replayReviewDocumentHash(document);
          if (disposed) return;
          if (store.getSnapshot().documentRevision !== revision) {
            schedule();
            return;
          }
          await recordDrawing(document, hash, snapshot.entities.size);
          if (!disposed) store.acknowledgePersisted(scopeKey, revision);
        })().catch((cause) => {
          if (disposed) return;
          setLiveDrawingError(
            cause instanceof Error
              ? `Run 绘图证据提交失败：${cause.message}`
              : "Run 绘图证据提交失败",
          );
        });
      }, 500);
    };
    const unsubscribe = store.subscribe(() => schedule());
    if ((store.dirty || currentDrawing.document === null)
      && store.getSnapshot().documentRevision > 0) schedule();
    return () => {
      disposed = true;
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [
    integrityRuntime.actions.recordDrawing,
    integrityRuntime.currentDrawing,
    integrityRuntime.drawingLoaded,
    integrityRuntime.runId,
    liveDrawingError,
  ]);

  useEffect(() => {
    setReviewDrawingError(null);
    if (reviewDrawingCursorRevision === null || reviewDrawingScopeBase === null) return;
    try {
      const scopeKey = `${reviewDrawingScopeBase}__main`;
      const store = drawingDocumentSessionRegistry.getStore(scopeKey);
      const document = reviewDrawingDocument === null
        ? createEmptyDrawingDocument(scopeKey)
        : replayReviewDrawingDocument(reviewDrawingDocument, scopeKey);
      const loaded = store.loadDocument(document);
      if (!loaded.ok) throw new Error(loaded.error);
      drawingDocumentSessionRegistry.markLoaded(scopeKey, store);
    } catch (cause) {
      setReviewDrawingError(
        cause instanceof Error ? cause.message : "Review 绘图文档恢复失败",
      );
    }
  }, [
    reviewDrawingCursorRevision,
    reviewDrawingDocument,
    reviewDrawingScopeBase,
  ]);

  useEffect(() => {
    if (reviewSelectedTrackId === null || reviewCursorVirtualTimeMs === null) {
      setReviewChartLoading(false);
      setReviewChartError(null);
      setReviewChartBounded(false);
      return;
    }
    const track = viewer.marketTracks?.tracks.find((item) => (
      item.track_id === reviewSelectedTrackId
    ));
    if (typeof reviewProjectedExchange !== "string"
      || typeof reviewProjectedMarketType !== "string"
      || typeof reviewProjectedSymbol !== "string"
      || typeof reviewProjectedSourceKind !== "string"
      || typeof reviewProjectedInterval !== "string"
      || parseIntervalSeconds(reviewProjectedInterval) === null
      || track?.adapter_session_id === null
      || track?.adapter_session_id === undefined) {
      setReviewChartLoading(false);
      setReviewChartBounded(false);
      setReviewChartError("选中 Review 轨道缺少严格身份、周期或冻结 adapter session，图表按 fail-closed 隐藏。");
      reviewSeriesStore.replace([], { source: "replay-review-unavailable" });
      return;
    }
    const adapterSessionId = track.adapter_session_id;
    const abort = new AbortController();
    const source = new SeriesWindowStore();
    let provider: ReplayHistoryProvider | null = null;
    setReviewChartLoading(true);
    setReviewChartError(null);
    setReviewChartBounded(false);
    void (async () => {
      const session = await defaultReplayApi.getSession(
        adapterSessionId,
        abort.signal,
      );
      const config = session.snapshot.config;
      if (config.exchange !== reviewProjectedExchange
        || config.market_type !== reviewProjectedMarketType
        || config.symbol !== reviewProjectedSymbol
        || config.source_kind.toUpperCase() !== reviewProjectedSourceKind) {
        throw new Error("Review 轨道身份与冻结 adapter session 不一致");
      }
      provider = new ReplayHistoryProvider({
        sessionId: adapterSessionId,
        trackId: reviewSelectedTrackId,
        identity: {
          exchange: config.exchange,
          market_type: config.market_type,
          symbol: config.symbol,
          source_kind: config.source_kind === "agg_trade" ? "AGG_TRADE" : "BAR",
          base_interval: config.base_interval,
          display_interval: config.display_interval,
        },
      });
      const revealedBoundaryMs = reviewCursorVirtualTimeMs;
      let beforeMs = Math.min(Number.MAX_SAFE_INTEGER, revealedBoundaryMs + 1);
      let bounded = false;
      for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
        const page = await provider.loadBefore({
          beforeMs,
          revealedBoundaryMs,
          dataEpoch: session.snapshot.data_epoch,
          limit: 1_000,
        });
        applyReplayHistoryPage(source, page);
        if (!page.has_more || page.bars.length === 0) break;
        if (pageIndex === 19) bounded = true;
        beforeMs = page.next_before_ms;
      }
      if (abort.signal.aborted) return;
      rebuildReplayViewerSeries(
        reviewSeriesStore,
        source,
        config.base_interval,
        reviewProjectedInterval,
      );
      setReviewChartBounded(bounded);
    })().catch((cause: unknown) => {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      reviewSeriesStore.replace([], { source: "replay-review-fail-closed" });
      setReviewChartError(
        cause instanceof Error ? cause.message : "Review 图表前缀加载失败",
      );
    }).finally(() => {
      if (!abort.signal.aborted) setReviewChartLoading(false);
    });
    return () => {
      abort.abort();
      provider?.cancel();
    };
  }, [
    reviewCursorVirtualTimeMs,
    reviewProjectedInterval,
    reviewProjectedExchange,
    reviewProjectedMarketType,
    reviewProjectedSourceKind,
    reviewProjectedSymbol,
    reviewSelectedTrackId,
    reviewSeriesStore,
    viewer.marketTracks,
  ]);

  const displayedSeriesStore = review === null ? viewer.seriesStore : reviewSeriesStore;
  const handleVisibleRangeChange = useCallback((range: ChartSurfaceVisibleRange) => {
    if (integrityRuntime.review !== null) return;
    runtime.marketData.actions.onVisibleRangeChange(range);
    const value: Record<string, number> = {};
    if (range.logical !== undefined) {
      value.from_logical_ppm = Math.round(range.logical.from * 1_000_000);
      value.to_logical_ppm = Math.round(range.logical.to * 1_000_000);
    }
    if (range.barSpacing !== undefined) value.bar_spacing_ppm = Math.round(range.barSpacing * 1_000_000);
    if (range.rightOffset !== undefined) value.right_offset_ppm = Math.round(range.rightOffset * 1_000_000);
    integrityRuntime.actions.offerViewAction("VISIBLE_RANGE", "main-chart-range", value);
  }, [integrityRuntime.actions, integrityRuntime.review, runtime.marketData.actions]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      handleReplayShortcut(event, (action) => {
        if (integrityRuntime.review !== null
          || !ownsController || runtime.store.connectionState !== "connected"
          || runtime.pendingCommand !== null || viewer.controlPending !== null
          || viewer.viewerPending) return false;
        if (action === "toggle-play" && effectiveState === "PLAYING") {
          void viewer.actions.submitControl("pause", {}).catch(() => undefined);
          return true;
        }
        if (action === "toggle-play" && effectiveState === "PAUSED") {
          if (globalClock === null || !globalClock.playback_bases.includes(globalClock.basis)) {
            return false;
          }
          void viewer.actions.submitControl("play", {
            basis: globalClock.basis,
            rate: globalClock.rate,
          }).catch(() => undefined);
          return true;
        }
        if (action === "step" && effectiveState === "PAUSED") {
          if (globalClock === null || !globalClock.supported_bases.includes("DISPLAY_BAR")) {
            return false;
          }
          void viewer.actions.submitControl("advance", {
            basis: "DISPLAY_BAR",
            count: 1,
          }).catch(() => undefined);
          return true;
        }
        if (action === "advance-window" && effectiveState === "PAUSED") {
          if (globalClock === null || !globalClock.supported_bases.includes("BASE_BAR")) {
            return false;
          }
          void viewer.actions.submitControl("advance", {
            basis: "BASE_BAR",
            count: 5,
          }).catch(() => undefined);
          return true;
        }
        return false;
      });
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [effectiveState, globalClock, integrityRuntime.review, ownsController, runtime.pendingCommand, runtime.store.connectionState, viewer.actions, viewer.controlPending, viewer.viewerPending]);

  const interval = (viewer.viewerState?.display_interval ?? config?.base_interval ?? "1m") as IntervalString;
  const reviewSelectedTrack = review?.projection.tracks.find((track) => (
    track.track_id === review.projection.viewer_state.selected_track_id
  ));
  const projectedInterval = review?.projection.viewer_state.display_interval;
  const displayedInterval = (
    review !== null
      && typeof projectedInterval === "string"
      && parseIntervalSeconds(projectedInterval) !== null
      ? projectedInterval
      : interval
  ) as IntervalString;
  const displayedSymbol = review !== null && typeof reviewSelectedTrack?.symbol === "string"
    ? reviewSelectedTrack.symbol
    : config?.symbol ?? "--";
  const baseInterval = (config?.base_interval ?? "1m") as IntervalString;
  const replayIntervalCatalog = useMemo(() => buildReplayIntervalCatalog({
    exchange: config?.exchange ?? "binance",
    marketType: config?.market_type ?? "spot",
    savedCustomIntervals,
  }), [
    config?.exchange,
    config?.market_type,
    savedCustomIntervals,
  ]);
  const intervalAvailability = useCallback((next: IntervalString): boolean => (
    canProjectReplayDisplayInterval(baseInterval, next)
  ), [baseInterval]);
  const unavailableIntervalMessage = useCallback((next: IntervalString): string => (
    replayIntervalUnavailableMessage(baseInterval, next)
  ), [baseInterval]);
  const setReplayDisplayInterval = useCallback((next: IntervalString): void => {
    if (intervalCommandOwnerRef.current !== null
      || intervalsSemanticallyEquivalent(interval, next)) return;
    const owner = {};
    intervalCommandOwnerRef.current = owner;
    const snapshot = chartSurfaceActions.captureViewportTransfer();
    const transfer = snapshot === null
      ? null
      : { snapshot, targetInterval: next } satisfies ReplayIntervalViewportTransfer;
    setIntervalViewportTransfer(transfer);
    void viewer.actions.setDisplayInterval(next)
      .catch(() => {
        setIntervalViewportTransfer((current) => current === transfer ? null : current);
      })
      .finally(() => {
        if (intervalCommandOwnerRef.current === owner) {
          intervalCommandOwnerRef.current = null;
        }
      });
  }, [chartSurfaceActions, interval, viewer.actions]);
  const settleReplayIntervalViewportTransfer = useCallback((
    transfer: SurfaceViewportSnapshot,
  ): void => {
    setIntervalViewportTransfer((current) => current?.snapshot === transfer ? null : current);
  }, []);
  const selectReplayInterval = useCallback((next: IntervalString): void => {
    if (review !== null || !intervalAvailability(next)) return;
    markIntervalUsed(next);
    setReplayDisplayInterval(next);
  }, [intervalAvailability, markIntervalUsed, review, setReplayDisplayInterval]);
  const createReplayCustomInterval = useCallback((next: IntervalString) => {
    if (review !== null) return { ok: false as const, message: "ReviewMode 中周期只读" };
    if (!intervalAvailability(next)) {
      return { ok: false as const, message: unavailableIntervalMessage(next) };
    }
    const result = addCustomInterval(next, { markUsed: true });
    if (!result.ok) return { ok: false as const, message: "周期格式无效" };
    setReplayDisplayInterval(result.value);
    showIntervalNotice({
      type: "success",
      text: `${result.value} 已保存并切换；实时主图与回放共用这份自定义周期`,
    });
    return { ok: true as const, added: result.added };
  }, [
    addCustomInterval,
    intervalAvailability,
    review,
    showIntervalNotice,
    unavailableIntervalMessage,
    setReplayDisplayInterval,
  ]);
  const removeReplayCustomInterval = useCallback((removedInterval: IntervalString): void => {
    if (review !== null) return;
    const removed = removeCustomInterval(removedInterval);
    if (removed === null) return;
    lastRemovedIntervalRef.current = removed;
    if (intervalsSemanticallyEquivalent(interval, removed.value)) {
      setReplayDisplayInterval(baseInterval);
    }
    showIntervalNotice({
      type: "warning",
      text: `${removed.value} 已从实时主图与回放的自定义周期中删除`,
      actionLabel: "撤销",
      duration: 6500,
    });
  }, [
    baseInterval,
    interval,
    removeCustomInterval,
    review,
    showIntervalNotice,
    setReplayDisplayInterval,
  ]);
  const restoreReplayCustomInterval = useCallback((): void => {
    const restored = restoreCustomInterval(lastRemovedIntervalRef.current);
    if (restored === null) return;
    lastRemovedIntervalRef.current = null;
    showIntervalNotice({ type: "success", text: `${restored.value} 已恢复` });
  }, [restoreCustomInterval, showIntervalNotice]);
  const clearReplayCustomIntervals = useCallback((): void => {
    if (review !== null) return;
    const removed = clearCustomIntervals();
    if (removed.length === 0) return;
    lastRemovedIntervalRef.current = removed.at(-1) ?? null;
    if (removed.some((record) => (
      intervalsSemanticallyEquivalent(interval, record.value)
    ))) {
      setReplayDisplayInterval(baseInterval);
    }
    showIntervalNotice({
      type: "warning",
      text: `已清空 ${removed.length} 个共享自定义周期，最近一项可撤销`,
      actionLabel: "撤销最近一项",
      duration: 6500,
    });
  }, [
    baseInterval,
    clearCustomIntervals,
    interval,
    review,
    showIntervalNotice,
    setReplayDisplayInterval,
  ]);
  const viewerLast = displayedSeriesStore.last();
  const viewerFirst = displayedSeriesStore.first();
  const viewerBarCount = displayedSeriesStore.barCount;
  const viewerDataMeta = {
    ...runtime.marketData.view.meta,
    version: Number(displayedSeriesStore.version),
    status: review === null
      ? (viewer.loading ? "loading" : "ready")
      : (reviewChartLoading ? "loading" : "ready"),
    source: review === null ? "replay-viewer-rebuild" : "replay-review-closed-prefix",
    seriesKey: displayedSeriesStore.seriesKey,
    interval: displayedInterval,
    bars: viewerBarCount,
    firstTime: viewerFirst?.time ?? null,
    lastTime: viewerLast?.time ?? null,
  };
  const replayTradeMarkers = useMemo<IndicatorMarker[]>(() => [{
    id: "replay-trade-fills",
    pane: "main",
    data: runtime.store.fills.map((fill) => ({
      time: fill.event_time_ms / 1_000,
      position: fill.side === "BUY" ? "below" : "above",
      shape: fill.side === "BUY" ? "arrow_up" : "arrow_down",
      color: fill.side === "BUY" ? "#16a34a" : "#e11d48",
      text: `${fill.side === "BUY" ? "买" : "卖"} ${fill.quantity} @ ${fill.price}`,
    })),
  }], [runtime.store.fills]);
  const replayTradeHlines = useMemo<IndicatorHLine[]>(() => {
    const selectedTrackId = viewer.viewerState?.selected_track_id;
    const portfolio = viewer.marketTracks?.portfolio;
    const selectedPositions = selectedTrackId === undefined
      ? []
      : (portfolio?.positions.filter((item) => item.track_id === selectedTrackId) ?? []);
    const lines: IndicatorHLine[] = [];
    for (const selectedPosition of selectedPositions) {
      const position = selectedPosition.position;
      const entryPrice = Number(position.entry_price ?? Number.NaN);
      const quantity = Number(position.quantity ?? 0);
      const positionSide = selectedPosition.position_side;
      const sideLabel = positionSide === "LONG" ? "多仓" : positionSide === "SHORT" ? "空仓" : "持仓";
      const lineSuffix = positionSide?.toLowerCase() ?? "net";
      if (quantity !== 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
        lines.push({
          id: "replay-position-average" + (positionSide === undefined ? "" : `-${lineSuffix}`),
          pane: "main",
          price: entryPrice,
          title: `${sideLabel}均价 ${entryPrice}`,
          color: positionSide === "SHORT" ? "#7c3aed" : "#2563eb",
          linestyle: "solid",
          linewidth: 1,
        });
      }
      if (quantity === 0 || portfolio?.position_mode === "HEDGE") continue;
      const mark = Number(position?.mark_price ?? Number.NaN);
      const marginEquity = Number(selectedPosition.margin_equity ?? Number.NaN);
      const maintenance = Number(selectedPosition.maintenance_margin ?? Number.NaN);
      let contractSize = 1;
      if (portfolio?.schema_version === "replay.training.portfolio.v2") {
        const rule = portfolio.instrument_rules.find((item) => item.track_id === selectedTrackId);
        const rawRule = rule?.rule;
        if (typeof rawRule === "object" && rawRule !== null && !Array.isArray(rawRule)) {
          const parsed = Number((rawRule as Readonly<Record<string, unknown>>).contract_size ?? 1);
          if (Number.isFinite(parsed) && parsed > 0) contractSize = parsed;
        }
      }
      const sensitivity = Math.abs(quantity) * contractSize;
      const buffer = marginEquity - maintenance;
      const riskPrice = quantity > 0
        ? mark - buffer / sensitivity
        : mark + buffer / sensitivity;
      if (
        Number.isFinite(mark)
        && Number.isFinite(marginEquity)
        && Number.isFinite(maintenance)
        && sensitivity > 0
        && buffer >= 0
        && Number.isFinite(riskPrice)
        && riskPrice > 0
      ) {
        lines.push({
          id: "replay-position-risk-reference" + (positionSide === undefined ? "" : `-${lineSuffix}`),
          pane: "main",
          price: riskPrice,
          title: `风险参考≈ ${riskPrice.toFixed(6)}`,
          color: "#f59e0b",
          linestyle: "dotted",
          linewidth: 1,
        });
      }
    }
    for (const order of runtime.store.orders) {
      if (order.status !== "OPEN" && order.status !== "PARTIALLY_FILLED") continue;
      const rawPrice = order.limit_price ?? order.stop_price;
      const orderPrice = Number(rawPrice ?? Number.NaN);
      if (!Number.isFinite(orderPrice) || orderPrice <= 0) continue;
      const protection = order.order_type === "STOP_MARKET"
        ? "止损"
        : order.order_type === "TAKE_PROFIT_MARKET"
          ? "止盈"
          : "委托";
      lines.push({
        id: `replay-order-${order.order_id}`,
        pane: "main",
        price: orderPrice,
        title: `${protection} ${order.side === "BUY" ? "买" : "卖"} ${order.remaining_quantity}`,
        color: order.order_type === "STOP_MARKET"
          ? "#e11d48"
          : order.order_type === "TAKE_PROFIT_MARKET"
            ? "#16a34a"
            : "#7c3aed",
        linestyle: "dashed",
        linewidth: 1,
      });
    }
    return lines;
  }, [runtime.store.orders, viewer.marketTracks?.portfolio, viewer.viewerState?.selected_track_id]);
  const chartMarkers = useMemo(() => [
    ...indicators.view.markers,
    ...replayTradeMarkers,
  ], [indicators.view.markers, replayTradeMarkers]);
  const chartHlines = useMemo(() => [
    ...indicators.view.hlines,
    ...replayTradeHlines,
  ], [indicators.view.hlines, replayTradeHlines]);
  const last = viewerLast ?? runtime.store.lastPrice;
  const isUp = Number(last?.close ?? 0) >= Number(last?.open ?? 0);
  const chart = active && review === null && liveDrawingError !== null ? (
    <div className="chart-area" data-replay-state="drawing-error">
      <div className="error-overlay">
        <div className="error-icon">!</div>
        <div className="error-message">
          <strong>Run 绘图证据已 fail closed</strong><br />
          {liveDrawingError}
          <small>不会用 IndexedDB、其他 Run 或 live 绘图替代服务端文档。</small>
        </div>
      </div>
    </div>
  ) : active && review !== null && (reviewChartError !== null || reviewDrawingError !== null) ? (
    <div className="chart-area" data-replay-state="review-error">
      <div className="error-overlay">
        <div className="error-icon">!</div>
        <div className="error-message">
          <strong>ReviewMode 已 fail closed</strong><br />
          {reviewChartError ?? reviewDrawingError}
          <small>不会用当前 Run、live 数据或其他绘图作用域填补缺口。</small>
        </div>
      </div>
    </div>
  ) : active && review !== null && reviewChartLoading ? (
    <div className="chart-area" data-replay-state="review-loading">
      <div className="error-overlay">
        <div className="replay-loading-spinner" />
        <div className="error-message">
          <strong>正在重建只读图表前缀</strong><br />
          仅请求选中事件之前的冻结历史。
        </div>
      </div>
    </div>
  ) : active && viewerBarCount > 0 && config !== null ? (
    <SingleChartPanes
      ref={chartSurfaceRef}
      seriesStore={displayedSeriesStore}
      symbol={displayedSymbol}
      drawingKeyBase={drawingScopeBase}
      interval={displayedInterval}
      loading={review === null
        && (runtime.marketData.view.loading || viewer.loading)}
      onCrosshairMove={runtime.marketData.actions.onCrosshairMove}
      onNeedMoreLeft={review === null ? history.loadMoreLeft : null}
      onNeedMoreRight={review === null ? history.restoreLatestWindow : null}
      canLoadMoreLeft={review === null && history.hasMore}
      canRestoreLatestWindow={review === null && history.canRestoreLatestWindow}
      rightWindowTruncated={review === null
        ? viewer.seriesStore.rightTruncated
        : false}
      datasetKey={review === null
        ? String(displayedSeriesStore.seriesKey ?? "replay-viewer-uninitialized")
        : `review:${review.review_id}:${review.selected_timeline_sequence}`}
      datasetViewportTransfer={review === null ? activeIntervalViewportTransfer : null}
      onDatasetViewportTransferSettled={settleReplayIntervalViewportTransfer}
      followLatest={review === null}
      latestBarPosition={0.5}
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
      tickMarkFormatter={formatChartTick}
      tickMarkMaxCharacterLength={replayTimeAxisMaxCharacterLength(publicTimePolicy)}
      dataMeta={viewerDataMeta}
      onVisibleRangeChange={handleVisibleRangeChange}
      drawingTool={review === null ? drawings.view.drawingTool : null}
      onDrawingToolChange={review === null ? drawings.actions.setDrawingTool : null}
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
      mainOverlayLines={review === null ? indicators.view.mainOverlayLines : []}
      subPanes={review === null ? indicators.view.subPanes : []}
      indicatorMarkers={review === null ? chartMarkers : []}
      indicatorFills={review === null ? indicators.view.fills : []}
      indicatorHlines={review === null ? chartHlines : []}
      indicatorBgcolors={review === null ? indicators.view.bgcolors : []}
      indicatorBarcolors={review === null ? indicators.view.barcolors : []}
      onRemoveSubPane={review === null
        ? (pane) => {
            const owner = pane.owner;
            if (owner?.kind === "indicator") {
              indicators.actions.removeIndicator(owner.id);
            } else if (owner?.kind === "trade-flow") {
              indicators.marketStudyActions.remove(owner.id);
            }
          }
        : null}
      invertScale={priceScale.invert}
      priceScaleMode={priceScale.mode}
    />
  ) : active ? (
    <div className="chart-area" data-replay-state="empty"><div className="error-overlay"><div className="error-message"><strong>尚无已揭示 BAR</strong><br />服务端 snapshot 为空；不会使用 live/mock 数据填充。</div></div></div>
  ) : <ReplayStatePanel runtime={runtime} />;

  const drawingToolbar = review !== null ? (
    <div className="drawing-toolbar replay-chart-toolbar" aria-label="ReviewMode 只读图表工具">
      <span>REVIEW · READ ONLY</span>
      <span>CLOSED PREFIX · NO FUTURE BAR</span>
      <span>绘图 r{review.projection.drawing_revision}</span>
      {reviewChartBounded && <span role="status">左侧历史已按 20,000 bars 上限截断</span>}
    </div>
  ) : (
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
              {review === null
                ? `${config.exchange} · ${config.market_type} · ${config.symbol} · base ${config.base_interval}`
                : `REVIEW · ${String(
                  review.projection.tracks.find((track) => (
                    track.track_id === review.projection.viewer_state.selected_track_id
                  ))?.symbol ?? config.symbol,
                )} · ${String(review.projection.viewer_state.display_interval ?? interval)}`}
            </button>
          )}
          controls={<>
            <button
              className={`indicator-toggle-btn ${indicatorPanelOpen ? "active" : ""}`}
              type="button"
              disabled={review !== null}
              aria-expanded={indicatorPanelOpen}
              aria-controls="replay-indicator-panel"
              onClick={() => setIndicatorPanelOpen((open) => !open)}
              title={review === null ? "管理仅使用已揭示 K 线的回放指标" : "ReviewMode 禁用活动 Run 指标，防止未来值进入只读投影"}
            >
              📊
              <span className="indicator-badge">
                {review === null ? indicators.status.activeIndicatorCount : "R/O"}
              </span>
            </button>
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
          trailing={<>
            {active && (
              <button
                ref={integrityToggleRef}
                className="replay-integrity-toggle"
                type="button"
                data-replay-action="toggle-integrity"
                data-review-active={review === null ? "false" : "true"}
                aria-controls="replay-integrity-drawer"
                aria-expanded={integrityOpen}
                onClick={() => {
                  setTrainingResultsOpen(false);
                  setIntegrityOpen((open) => !open);
                }}
              >
                {review === null ? "复盘与完整性" : "复盘中"}
              </button>
            )}
            {active && integrityRuntime.runId !== null && (
              <button
                className="replay-integrity-toggle"
                type="button"
                data-replay-action="toggle-training-results"
                aria-controls="replay-training-results-drawer"
                aria-expanded={trainingResultsOpen}
                onClick={() => {
                  setIntegrityOpen(false);
                  setTrainingResultsOpen((open) => !open);
                }}
              >训练成绩</button>
            )}
            {active && viewer.viewerState?.run_id !== undefined && <button className="replay-return-hub" type="button" disabled={returningToHub || review !== null} title={review !== null ? "先退出只读 ReviewMode" : returnToHubError ?? "服务端暂停并写入 checkpoint 后返回存档大厅"} onClick={() => void returnToHub()}>{returningToHub ? "正在保存…" : "存档大厅"}</button>}
            <a className="replay-live-link" href="/" target="_blank" rel="noopener noreferrer">实时行情 ↗</a>
          </>}
        />
      )}
      intervalSelector={(
        <IntervalSelector
          interval={displayedInterval}
          capabilityReady={review === null
            && config !== null
            && viewer.viewerState !== null
            && !viewer.viewerPending
            && intervalViewportTransfer === null
            && replayIntervalCatalog.nativeIntervals.length > 0}
          capabilityLoading={config === null
            || viewer.loading
            || viewer.viewerPending
            || intervalViewportTransfer !== null}
          nativeIntervals={replayIntervalCatalog.nativeIntervals}
          intervalGroups={replayIntervalCatalog.intervalGroups}
          customIntervalRecords={customIntervalRecords}
          savedCustomIntervals={savedCustomIntervals}
          onSelectInterval={selectReplayInterval}
          onCreateCustomInterval={createReplayCustomInterval}
          onRemoveCustomInterval={removeReplayCustomInterval}
          onRestoreCustomInterval={restoreReplayCustomInterval}
          onTogglePinCustomInterval={togglePinCustomInterval}
          onClearCustomIntervals={clearReplayCustomIntervals}
          intervalAvailability={intervalAvailability}
          unavailableIntervalMessage={unavailableIntervalMessage}
          readOnlyReason={review === null ? null : "ReviewMode 中周期只读"}
          intervalNotice={intervalNotice ?? {
            type: viewer.error ? "error" : "info",
            text: review === null
              ? viewer.error ?? `ViewerState r${viewer.viewerState?.semantic_view_revision ?? "--"} · ${publicTime}`
              : `Review ViewerState r${String(review.projection.viewer_state.semantic_view_revision ?? "--")} · ${review.events.find((event) => event.event_id === review.selected_event_id)?.public_time.label ?? "--"}`,
          }}
        />
      )}
      workspace={(
        <MarketChartWorkspace
          toolbar={drawingToolbar}
          exportOverlay={null}
          chart={chart}
          rightRail={active ? (
            review !== null ? <ReplayReviewRightRail review={review} /> : <ReplayRightMarketRail
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
      featureSurfaces={active ? <>
        {review === null && history.notice !== null && (
          <div className="replay-history-boundary-notice" role="status">
            <span>{history.notice}</span>
            <button type="button" onClick={history.dismissNotice} aria-label="关闭历史边界提示">×</button>
          </div>
        )}
        {review === null && <ReplayBottomControlDock runtime={runtime} viewer={viewer} publicTimeLabel={publicTime} />}
        {review === null && indicatorPanelOpen && (
          <div id="replay-indicator-panel" className="replay-shared-indicator-panel">
            <IndicatorPanel
              allowedScriptLanguages={["pyne", "pine"]}
              allowedSecurityModes={["safe"]}
              isOpen
              onClose={() => setIndicatorPanelOpen(false)}
              activeIndicators={indicators.view.activeIndicators}
              paramSchemas={indicators.view.paramSchemas}
              onAddIndicator={indicators.actions.addIndicator}
              onRemoveIndicator={indicators.actions.removeIndicator}
              onToggleVisibility={indicators.actions.toggleVisibility}
              onUpdateParams={indicators.actions.updateIndicatorParams}
              onUpdateScript={indicators.actions.updateIndicatorScript}
              computing={indicators.status.computing}
              realtimeMode={indicators.status.realtimeMode}
              onRecompute={indicators.actions.recompute}
              marketStudies={indicators.marketStudies}
              onAddMarketStudy={indicators.marketStudyActions.add}
              onRemoveMarketStudy={indicators.marketStudyActions.remove}
              onToggleMarketStudyVisibility={
                indicators.marketStudyActions.toggleVisibility
              }
              modeNotice={{
                label: "回放闭合前缀",
                description: "只计算服务端已揭示且已闭合的 K 线；禁用 hosted range、指标 WebSocket 与 unsafe 脚本。",
              }}
              resolveIndicatorSupport={providedBarsIndicatorSupport}
            />
          </div>
        )}
        {integrityOpen && (
          <aside
            ref={integrityDrawerRef}
            id="replay-integrity-drawer"
            className="replay-integrity-drawer"
            aria-label="复盘与完整性"
            tabIndex={-1}
          >
            <ReplayIntegrityReviewPanel
              runtime={runtime}
              integrityRuntime={integrityRuntime}
              trainingState={effectiveState}
              onClose={() => setIntegrityOpen(false)}
            />
          </aside>
        )}
        {trainingResultsOpen && integrityRuntime.runId !== null && (
          <aside
            id="replay-training-results-drawer"
            className="replay-integrity-drawer replay-training-results-drawer"
            aria-label="训练成绩"
            tabIndex={-1}
          >
            <ReplayTrainingResultsPanel
              runId={integrityRuntime.runId}
              integrityRuntime={integrityRuntime}
              trainingState={effectiveState}
              onClose={() => setTrainingResultsOpen(false)}
            />
          </aside>
        )}
      </> : null}
      statusBar={(
        <MarketStatusBar
          source="replay"
          className="replay-status-bar"
          connectionStatus={runtime.store.connectionState}
          dataAttributes={{
            "data-replay-generation": runtime.store.generation,
            "data-replay-session-state": review === null ? effectiveState ?? "" : "REVIEW",
            "data-replay-adapter-state": review === null ? runtime.store.state ?? "" : review.playback_state,
            "data-replay-source-sequence": review?.projection.cursor.source_sequence ?? runtime.store.sourceSequence,
            "data-replay-revision": runtime.store.revision,
            "data-replay-state-hash": review?.selected_state_hash ?? runtime.store.stateHash ?? "",
            "data-replay-cursor-ms": review?.projection.cursor.virtual_time_ms ?? runtime.store.virtualTimeMs ?? "",
            "data-replay-max-bar-ms": viewerLast?.time === undefined ? "" : Number(viewerLast.time) * 1_000,
            "data-replay-last-bar-closed": String(viewerLast?.replayClosed ?? ""),
            "data-replay-order-count": review?.projection.orders.length ?? runtime.store.orders.length,
            "data-replay-fill-count": review?.projection.fills.length ?? runtime.store.fills.length,
            "data-replay-revealed": String(runtime.store.revealed),
            "data-replay-history-epoch": history.historyEpoch ?? "",
            "data-replay-history-right-truncated": String(
              review === null
                ? viewer.seriesStore.rightTruncated
                : displayedSeriesStore.rightTruncated,
            ),
            "data-replay-history-can-restore-latest": String(history.canRestoreLatestWindow),
            "data-replay-view-interval": displayedInterval,
            "data-replay-view-revision": review === null
              ? viewer.viewerState?.semantic_view_revision ?? ""
              : String(review.projection.viewer_state.semantic_view_revision ?? ""),
            "data-replay-clock-basis": review === null ? globalClock?.basis ?? "" : "",
            "data-replay-clock-rate": review === null ? globalClock?.rate ?? "" : "",
            "data-replay-control-pending": review === null
              ? viewer.controlPending?.type ?? ""
              : "",
            "data-replay-time-disclosure-policy": integrityRuntime.integrity?.effective_time_disclosure_policy ?? "",
            "data-replay-result-label": integrityRuntime.integrity?.result_label ?? "",
            "data-replay-public-time-projections": publicTimeRuntime.projectedCount,
            "data-replay-public-time-state": publicTimeRuntime.error === null
              ? (publicTimeRuntime.loading ? "loading" : "ready")
              : "relative-fallback",
            "data-replay-review-read-only": integrityRuntime.review?.read_only === true ? "true" : "false",
            "data-replay-review-timeline-sequence": review?.selected_timeline_sequence ?? "",
            "data-replay-review-chart-fidelity": review === null ? "" : "CLOSED_PREFIX_ONLY",
            "data-replay-review-original-verified": review?.immutability_proof.verified === true ? "true" : "",
          }}
          left={<>
            <span><span className={`status-dot ${runtime.store.connectionState === "connected" ? "connected" : "loading"}`} />K 线回放 · REPLAY</span>
            <span>{review === null ? effectiveState ?? runtime.phase : `REVIEW ${review.playback_state}`}</span>
            <span>{viewerBarCount} display bars</span>
            {review === null && history.loading && <span>Loading older replay data…</span>}
            {review === null && history.historyEpoch !== null && !history.hasMore && !history.loading && <span>已到归档历史起点</span>}
            {review === null && history.error && <span className="replay-history-error">{history.error}</span>}
            {review !== null && <span>immutable event #{review.selected_timeline_sequence}</span>}
            {review !== null && reviewChartBounded && <span>20,000-bar review prefix bound</span>}
          </>}
          right={<>
            <span>{review === null ? `Controller: ${ownsController ? "本页" : runtime.store.controllerClientId ? "其他页面" : "无"}` : "Original controller isolated"}</span>
            <span>{config?.source_kind.toUpperCase() ?? "BAR"} · {config?.quality_mode.toUpperCase() ?? "EXACT"}</span>
            <span>服务端回放 · 与实时行情隔离</span>
          </>}
        />
      )}
    />
  );
}
