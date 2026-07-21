import { useCallback, useEffect, useState } from "react";
import type { RefObject } from "react";
import MarketPageFrame from "../../app/MarketPageFrame.js";
import MarketWorkspaceFrame from "../../app/MarketWorkspaceFrame.js";
import type { ChartSurfaceHandle } from "../../chart-adapter/useChartSurfaceRuntime.js";
import SingleChartPanes from "../../components/SingleChartPanes.js";
import ReplayControlBar from "./components/ReplayControlBar.js";
import ReplayReportPanel from "./components/ReplayReportPanel.js";
import ReplayRightRail from "./components/ReplayRightRail.js";
import ReplaySessionDialog from "./components/ReplaySessionDialog.js";
import { defaultReplayV2Api } from "./replayV2Api.js";
import { REPLAY_PRODUCT_V2_ENABLED } from "./replayV2Types.js";
import { handleReplayShortcut } from "./replayShortcuts.js";
import { returnToTrainingHub } from "./trainingHubNavigation.js";
import { formatReplayPublicTime, replayOwnsController } from "./replayUiModel.js";
import type { ReplayIndicatorRuntime } from "./useReplayIndicatorRuntime.js";
import type { ReplayRuntime } from "./useReplayRuntime.js";

export interface ReplayPageShellProps {
  readonly runtime: ReplayRuntime;
  readonly indicators: ReplayIndicatorRuntime;
  readonly chartSurfaceRef: RefObject<ChartSurfaceHandle | null>;
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
            <small>此独立页面 fail closed；不会回退到 live 或 mock K 线。</small>
          </div>
          {runtime.phase === "ERROR" && <button className="retry-btn" type="button" onClick={runtime.actions.retry}>重试回放能力</button>}
          <a href="/" target="_blank" rel="noopener noreferrer">打开实时行情 ↗</a>
        </div>
      </div>
    );
  }
  const labels: Readonly<Record<string, string>> = {
    IDLE: "准备独立回放运行时…",
    LOADING_CAPABILITIES: "正在加载回放能力…",
    VALIDATING_SESSION: "正在校验服务端 session；HTTP snapshot 不会渲染…",
    CONNECTING_SESSION: "等待首个原子 replay snapshot…",
    STOPPED: "回放运行时已释放。",
  };
  return (
    <div className="chart-area" data-replay-state="loading">
      <div className="error-overlay"><div className="replay-loading-spinner" /><div className="error-message"><strong>K 线回放</strong><br />{labels[runtime.phase] ?? "正在恢复回放…"}<small>加载期间不渲染 live/mock bars。</small></div></div>
    </div>
  );
}

export default function ReplayPageShell({ runtime, indicators, chartSurfaceRef }: ReplayPageShellProps) {
  const [returningToHub, setReturningToHub] = useState(false);
  const [returnToHubError, setReturnToHubError] = useState<string | null>(null);
  const { marketData } = runtime;
  const config = runtime.store.sessionConfig;
  const active = runtime.phase === "ACTIVE" && config !== null && runtime.store.hasAuthoritativeSnapshot;
  const ownsController = replayOwnsController(runtime.store, runtime.clientInstanceId);
  const publicTime = formatReplayPublicTime(runtime.store.virtualTimeMs, {
    blindMode: config?.blind_mode ?? true,
    originMs: runtime.store.replayStartMs,
  });
  const formatChartTime = useCallback((timeSeconds: number) => formatReplayPublicTime(timeSeconds * 1_000, {
    blindMode: config?.blind_mode ?? true,
    originMs: runtime.store.replayStartMs,
  }), [config?.blind_mode, runtime.store.replayStartMs]);
  const returnToHub = useCallback(async () => {
    const sessionId = runtime.store.sessionId;
    if (sessionId === null || returningToHub) return;
    setReturningToHub(true);
    setReturnToHubError(null);
    try {
      await returnToTrainingHub(sessionId, defaultReplayV2Api);
    } catch (error) {
      setReturnToHubError(error instanceof Error ? error.message : "返回存档大厅失败");
      setReturningToHub(false);
    }
  }, [returningToHub, runtime.store.sessionId]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      handleReplayShortcut(event, (action) => {
        if (!ownsController
          || runtime.store.connectionState !== "connected"
          || runtime.pendingCommand !== null
          || runtime.forkPending) return false;
        if (action === "toggle-play" && runtime.store.state === "PLAYING") {
          void runtime.actions.submitCommand("pause", {}).catch(() => undefined);
          return true;
        } else if (action === "toggle-play" && runtime.store.state === "PAUSED") {
          void runtime.actions.submitCommand("play", {}).catch(() => undefined);
          return true;
        } else if (action === "step" && runtime.store.state === "PAUSED") {
          void runtime.actions.submitCommand("step", { count: 1 }).catch(() => undefined);
          return true;
        } else if (action === "advance-window" && runtime.store.state === "PAUSED") {
          void runtime.actions.submitCommand("advance_by", { ms: 300_000 }).catch(() => undefined);
          return true;
        }
        return false;
      });
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [ownsController, runtime.actions, runtime.forkPending, runtime.pendingCommand, runtime.store.connectionState, runtime.store.state]);

  const chart = active && marketData.status.barCount > 0 ? (
    <SingleChartPanes
      ref={chartSurfaceRef}
      seriesStore={marketData.view.seriesStore}
      symbol={config.symbol}
      drawingKeyBase={`replay:${runtime.store.sessionId ?? "unknown"}`}
      interval={config.display_interval}
      loading={marketData.view.loading}
      onCrosshairMove={marketData.actions.onCrosshairMove}
      onNeedMoreLeft={null}
      canLoadMoreLeft={false}
      datasetKey={String(marketData.view.meta.seriesKey ?? "replay-uninitialized")}
      upColor="#22c55e"
      downColor="#ef4444"
      theme="dark"
      customBg="#0b1220"
      timezone="UTC"
      timeFormatter={formatChartTime}
      tickMarkFormatter={formatChartTime}
      dataMeta={marketData.view.meta}
      onVisibleRangeChange={marketData.actions.onVisibleRangeChange}
      mainOverlayLines={[...indicators.mainOverlayLines]}
    />
  ) : active ? (
    <div className="chart-area" data-replay-state="empty"><div className="error-overlay"><div className="error-message"><strong>尚无已揭示 BAR</strong><br />服务端 snapshot 为空；不会使用 live/mock 数据填充。</div></div></div>
  ) : <ReplayStatePanel runtime={runtime} />;

  const lastPrice = runtime.store.lastPrice;
  return (
    <MarketPageFrame
      topBar={(
        <header className="top-bar replay-top-bar" id="replay-top-bar" data-runtime-source="replay">
          <div className="logo"><div className="logo-icon">◀</div><span className="logo-text">CandleScope K 线回放</span></div>
          <span className="replay-mode-badge">REPLAY</span>
          {config && (
            <button className="replay-identity-readonly" type="button" title="Session ACTIVE 后身份不可变；请新建回放或 Fork。">
              {config.exchange} · {config.market_type} · {config.symbol} · {config.display_interval}
            </button>
          )}
          {lastPrice && <div className="replay-ohlcv"><strong>{lastPrice.close}</strong><span>O {lastPrice.open}</span><span>H {lastPrice.high}</span><span>L {lastPrice.low}</span><span>V {lastPrice.volume}</span></div>}
          {REPLAY_PRODUCT_V2_ENABLED && active && runtime.store.sessionId !== null && (
            <button
              className="replay-return-hub"
              type="button"
              disabled={returningToHub}
              title={returnToHubError ?? "先由服务端暂停并写入 checkpoint，再返回训练存档大厅"}
              onClick={() => void returnToHub()}
            >
              {returningToHub ? "正在保存…" : "存档大厅"}
            </button>
          )}
          <a className="replay-live-link" href="/" target="_blank" rel="noopener noreferrer">实时行情 ↗</a>
        </header>
      )}
      intervalSelector={(
        <div className="replay-toolbar-slot">
          <div className="interval-toolbar-wrap" data-replay-readonly="true">
            <span className="interval-btn active">{config?.display_interval ?? "--"}</span>
            <span>服务端权威历史时间轴 · {publicTime}</span>
            {config?.blind_mode && !runtime.store.revealed && <span className="replay-blind-chip">BLIND · synthetic D+N</span>}
          </div>
          {active && <ReplayControlBar runtime={runtime} />}
        </div>
      )}
      workspace={(
        <MarketWorkspaceFrame
          toolbar={<div className="drawing-toolbar replay-chart-toolbar" aria-label="回放图表工具"><span>REPLAY</span><span>SMA 20 · revealed-only</span><span title="Hosted / range / security indicators are disabled">本地指标边界</span></div>}
          exportOverlay={null}
          chart={chart}
          rightRail={active ? <ReplayRightRail runtime={runtime} indicatorStatus={indicators.status} /> : null}
        />
      )}
      featureSurfaces={active ? <ReplayReportPanel runtime={runtime} /> : null}
      statusBar={(
        <footer
          className="status-bar replay-status-bar"
          id="replay-status-bar"
          data-replay-connection={runtime.store.connectionState}
          data-replay-session-state={runtime.store.state ?? ""}
          data-replay-source-sequence={runtime.store.sourceSequence}
          data-replay-revision={runtime.store.revision}
          data-replay-state-hash={runtime.store.stateHash ?? ""}
          data-replay-cursor-ms={runtime.store.virtualTimeMs ?? ""}
          data-replay-max-bar-ms={runtime.replayStore.seriesStore.last()?.time === undefined ? "" : Number(runtime.replayStore.seriesStore.last()?.time) * 1_000}
          data-replay-last-bar-closed={String(runtime.store.lastPrice?.replayClosed ?? "")}
          data-replay-order-count={runtime.store.orders.length}
          data-replay-fill-count={runtime.store.fills.length}
          data-replay-revealed={String(runtime.store.revealed)}
        >
          <div className="status-left">
            <span><span className={`status-dot ${runtime.store.connectionState === "connected" ? "connected" : "loading"}`} />K 线回放 · REPLAY</span>
            <span>{runtime.store.state ?? runtime.phase}</span><span>{marketData.status.barCount} bars</span>
            <span>
              {config?.source_kind.toUpperCase() ?? "BAR"} · {config?.quality_mode.toUpperCase() ?? "EXACT"} · {config?.source_kind === "agg_trade" ? "AGG_TRADE_TAPE" : "BAR_CONSERVATIVE"}
            </span>
          </div>
          <div className="status-right"><span>Controller: {ownsController ? "本页" : runtime.store.controllerClientId ? "其他页面" : "无"}</span><span>{runtime.store.connectionState}</span><span>无 live feeds · replay.v1</span></div>
        </footer>
      )}
    />
  );
}
