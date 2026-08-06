import { useEffect, useMemo, useState } from "react";
import { useChartSurfaceRuntime } from "../../chart-adapter/useChartSurfaceRuntime.js";
import type { ReplayEntry } from "./replayEntry.js";
import type { ReplayCatalog, ReplayCatalogEntry } from "./replayTypes.js";
import type { TrainingRunCard } from "./replayV2Types.js";
import { defaultReplayV2Api, ReplayV2ApiError } from "./replayV2Api.js";
import { selectReplayInitialMarketWithEpochRetry } from "./replayInitialMarket.js";
import { getReplayControllerClientInstanceId } from "./replayControllerIdentity.js";
import TrainingHubDialog from "./components/TrainingHubDialog.js";
import ReplayTrainingPageShell from "./ReplayTrainingPageShell.js";
import { useReplaySharedIndicatorRuntime } from "./useReplaySharedIndicatorRuntime.js";
import { useReplayRuntime } from "./useReplayRuntime.js";
import { useReplayViewerRuntime } from "./useReplayViewerRuntime.js";
import { useTrainingHub } from "./useTrainingHub.js";

export interface ReplayAppProps {
  entry: ReplayEntry;
}

function ReplayTrainingHubApp() {
  const runtime = useTrainingHub();
  return <TrainingHubDialog runtime={runtime} />;
}

function ReplayStatusSurface({
  title,
  message,
  retry,
}: {
  title: string;
  message: string;
  retry?: () => void;
}) {
  return (
    <main className="training-hub-page">
      <section className="training-hub-shell">
        <header className="training-hub-heading">
          <div>
            <span className="training-hub-kicker">RUN-CENTRIC REPLAY</span>
            <h1>{title}</h1>
            <p>{message}</p>
          </div>
          <div className="training-hub-heading-actions">
            {retry !== undefined && <button type="button" onClick={retry}>重试</button>}
            <a href="/replay.html">返回训练大厅</a>
          </div>
        </header>
      </section>
    </main>
  );
}

function ReplayTrainingWorkspaceSurface({
  indicatorScope,
  replay,
  viewer,
}: {
  indicatorScope: string;
  replay: ReturnType<typeof useReplayRuntime>;
  viewer: ReturnType<typeof useReplayViewerRuntime>;
}) {
  const indicators = useReplaySharedIndicatorRuntime(
    replay,
    viewer,
    indicatorScope,
  );
  const chartSurface = useChartSurfaceRuntime();
  return (
    <ReplayTrainingPageShell
      key={indicatorScope}
      runtime={replay}
      indicators={indicators}
      chartSurfaceRef={chartSurface.ref}
      chartSurfaceActions={chartSurface.actions}
      viewer={viewer}
    />
  );
}

function ReplayInitializedRun({
  runId,
  sessionId,
}: {
  runId: string;
  sessionId: string;
}) {
  const runtimeEntry = useMemo(
    () => ({ kind: "adapter" as const, sessionId }),
    [sessionId],
  );
  const clientInstanceId = useMemo(
    () => getReplayControllerClientInstanceId(runId),
    [runId],
  );
  const replay = useReplayRuntime(runtimeEntry, { clientInstanceId });
  const viewer = useReplayViewerRuntime(replay);
  return (
    <ReplayTrainingWorkspaceSurface
      key={`${runId}:${sessionId}`}
      indicatorScope={runId}
      replay={replay}
      viewer={viewer}
    />
  );
}

function marketLabel(entry: ReplayCatalogEntry): string {
  return `${entry.identity.exchange} · ${entry.identity.market_type}`;
}

function ReplayInitialMarketPicker({
  run,
  onInitialized,
}: {
  run: TrainingRunCard;
  onInitialized: (run: TrainingRunCard) => void;
}) {
  const [catalog, setCatalog] = useState<ReplayCatalog | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);

  const loadCatalog = () => {
    setError(null);
    setCatalog(null);
    void defaultReplayV2Api.marketCatalog(run.run_id).then(setCatalog).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "商品目录读取失败");
    });
  };

  useEffect(() => {
    const abort = new AbortController();
    void defaultReplayV2Api.marketCatalog(run.run_id, abort.signal)
      .then(setCatalog)
      .catch((reason: unknown) => {
        if (abort.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "商品目录读取失败");
      });
    return () => abort.abort();
  }, [run.run_id]);

  const entries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (catalog?.entries ?? []).filter((entry) => (
      needle.length === 0
      || entry.identity.symbol.toLowerCase().includes(needle)
      || entry.identity.exchange.toLowerCase().includes(needle)
      || entry.identity.market_type.toLowerCase().includes(needle)
    ));
  }, [catalog, query]);
  const timeCommitment = catalog?.time_commitment;
  const committedTimeLabel = timeCommitment?.committed_start_ms === null
    ? "已冻结（按披露策略隐藏）"
    : timeCommitment?.committed_start_ms === undefined
      ? "正在读取"
      : new Date(timeCommitment.committed_start_ms).toISOString();

  const selectMarket = async (entry: ReplayCatalogEntry) => {
    if (catalog === null || entry.selected_base_interval === null || selecting !== null) return;
    setSelecting(entry.identity.symbol);
    setError(null);
    try {
      const result = await selectReplayInitialMarketWithEpochRetry({
        api: defaultReplayV2Api,
        runId: run.run_id,
        catalog,
        entry,
      });
      setCatalog(result.catalog);
      onInitialized(result.response.run);
    } catch (reason) {
      const message = reason instanceof ReplayV2ApiError
        ? `${reason.code}: ${reason.message}`
        : reason instanceof Error ? reason.message : "商品初始化失败";
      setError(message);
      setSelecting(null);
      if (reason instanceof ReplayV2ApiError && reason.code === "CATALOG_EPOCH_MISMATCH") {
        loadCatalog();
      }
    }
  };

  return (
    <main className="training-hub-page" data-replay-run-state="AWAITING_MARKET">
      <section className="training-hub-shell">
        <header className="training-hub-heading">
          <div>
            <span className="training-hub-kicker">T0 COMMITTED · NO MARKET LOADED</span>
            <h1>{run.name}</h1>
            <p>这局模拟账户的开始时间已经永久冻结。选择商品只会检查兼容性，不会改时间、顺延或重新随机。</p>
          </div>
          <div className="training-hub-heading-actions">
            <button type="button" onClick={loadCatalog} disabled={selecting !== null}>刷新商品</button>
            <a href="/replay.html">返回训练大厅</a>
          </div>
        </header>

        <div className="training-hub-filters replay-market-picker-search">
          <label>
            搜索商品
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="BTC、ETH、交易所或市场类型"
              autoFocus
            />
          </label>
          <span>开局时间：{committedTimeLabel} · 账户结算：{run.settlement_asset} · 历史源：{run.source_kind}</span>
        </div>

        {error !== null && <div className="replay-error-summary" role="alert">{error}</div>}
        {catalog === null ? (
          <div className="training-hub-empty"><div className="replay-loading-spinner" />正在读取可用商品…</div>
        ) : entries.length === 0 ? (
          <div className="training-hub-empty"><strong>没有匹配商品</strong><span>清空搜索词或刷新能力目录。</span></div>
        ) : (
          <div className="training-hub-card-grid replay-market-picker-grid">
            {entries.map((entry) => {
              const interval = entry.selected_base_interval;
              const compatibility = entry.start_compatibility;
              const available = interval !== null
                && compatibility?.state === "READY";
              return (
                <article className="training-hub-card" key={`${entry.identity.exchange}:${entry.identity.market_type}:${entry.identity.symbol}`}>
                  <header>
                    <div><span>MARKET</span><h2>{entry.identity.symbol}</h2></div>
                    <strong data-run-state={available ? "PAUSED" : "ERROR"}>{available ? "时间兼容" : "不支持本局"}</strong>
                  </header>
                  <dl>
                    <div><dt>市场</dt><dd>{marketLabel(entry)}</dd></div>
                    <div><dt>基础周期</dt><dd>{interval ?? "—"}</dd></div>
                    <div><dt>合格窗口</dt><dd>{entry.eligible_window_count}</dd></div>
                    <div><dt>来源</dt><dd>{run.source_kind}</dd></div>
                  </dl>
                  <p>{compatibility?.message ?? "服务端尚未返回本局时间兼容性。"}</p>
                  <footer>
                    <button
                      type="button"
                      disabled={!available || selecting !== null}
                      onClick={() => void selectMarket(entry)}
                    >
                      {selecting === entry.identity.symbol ? "正在初始化…" : `选择 ${entry.identity.symbol}`}
                    </button>
                    {!available && <a href="/replay.html">另开一局</a>}
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}

function ReplayTrainingRunApp({ runId }: { runId: string }) {
  const [run, setRun] = useState<TrainingRunCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void defaultReplayV2Api.getRun(runId, controller.signal).then(({ run: loaded }) => {
      setRun(loaded);
    }).catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : "回放 Run 读取失败");
    });
    return () => controller.abort();
  }, [attempt, runId]);

  if (error !== null) {
    return <ReplayStatusSurface title="无法打开回放" message={error} retry={() => {
      setRun(null);
      setError(null);
      setAttempt((value) => value + 1);
    }} />;
  }
  if (run === null) {
    return <ReplayStatusSurface title="正在打开回放" message={`正在解析 Run ${runId} 的当前商品与内部数据轨道…`} />;
  }
  if (run.state === "AWAITING_MARKET" || run.resume_action === "SELECT_MARKET") {
    return <ReplayInitialMarketPicker run={run} onInitialized={setRun} />;
  }
  if (run.adapter_session_id === null) {
    return <ReplayStatusSurface title="回放状态不完整" message="Run 已有时钟，但当前 Viewer 没有可用的 MarketTrack。" />;
  }
  return <ReplayInitializedRun runId={run.run_id} sessionId={run.adapter_session_id} />;
}

/** Dedicated run-centric replay composition root. */
export default function ReplayApp({ entry }: ReplayAppProps) {
  if (entry.kind === "configure") return <ReplayTrainingHubApp />;
  if (entry.kind === "run") return <ReplayTrainingRunApp key={entry.runId} runId={entry.runId} />;
  return <ReplayStatusSurface title="回放地址无效" message={entry.message} />;
}
