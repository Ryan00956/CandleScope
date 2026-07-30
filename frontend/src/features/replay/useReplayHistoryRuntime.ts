import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LoadMoreLeft } from "../market-data/useChartLoadMoreLeft.js";
import type { ReplayDigest } from "./replayTypes.js";
import {
  ReplayHistoryProvider,
  applyReplayHistoryPage,
} from "./replayHistoryProvider.js";
import type {
  ReplayHistoryIdentity,
  ReplayHistoryPolicy,
} from "./replayHistoryProvider.js";
import type { ReplayRuntime } from "./useReplayRuntime.js";


export interface ReplayHistoryRuntime {
  readonly loading: boolean;
  readonly hasMore: boolean;
  readonly canRestoreLatestWindow: boolean;
  readonly error: string | null;
  readonly historyEpoch: ReplayDigest | null;
  readonly boundaryMs: number | null;
  readonly policy: ReplayHistoryPolicy | null;
  readonly notice: string | null;
  readonly loadMoreLeft: LoadMoreLeft;
  readonly restoreLatestWindow: () => Promise<boolean>;
  readonly dismissNotice: () => void;
}

export function useReplayHistoryRuntime(runtime: ReplayRuntime): ReplayHistoryRuntime {
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyEpoch, setHistoryEpoch] = useState<ReplayDigest | null>(null);
  const [boundaryMs, setBoundaryMs] = useState<number | null>(null);
  const [policy, setPolicy] = useState<ReplayHistoryPolicy | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const storeRef = useRef(runtime.store);
  storeRef.current = runtime.store;
  const config = runtime.store.sessionConfig;
  const sessionId = runtime.store.sessionId;
  const dataEpoch = runtime.store.dataEpoch;
  const runtimeGeneration = runtime.store.generation;
  const identity = useMemo<ReplayHistoryIdentity | null>(() => config === null ? null : ({
    exchange: config.exchange,
    market_type: config.market_type,
    symbol: config.symbol,
    source_kind: config.source_kind === "agg_trade" ? "AGG_TRADE" : "BAR",
    base_interval: config.base_interval,
    display_interval: config.display_interval,
  }), [config]);
  const provider = useMemo(() => (
    sessionId === null || identity === null || dataEpoch === null
      ? null
      : new ReplayHistoryProvider({ sessionId, trackId: "track-1", identity })
  ), [dataEpoch, identity, sessionId]);

  useEffect(() => {
    setHasMore(true);
    setError(null);
    setHistoryEpoch(null);
    setBoundaryMs(null);
    setPolicy(null);
    setNotice(null);
    loadingRef.current = false;
    setLoading(false);
    return () => provider?.cancel();
  }, [provider, runtimeGeneration]);

  const loadMoreLeft = useCallback<LoadMoreLeft>(async (oldestLoadedTime) => {
    const store = storeRef.current;
    if (provider === null || loadingRef.current || !hasMore
      || store.dataEpoch === null || store.virtualTimeMs === null
      || oldestLoadedTime === null || oldestLoadedTime === undefined) return;
    const beforeMs = Math.floor(Number(oldestLoadedTime) * 1_000);
    if (!Number.isSafeInteger(beforeMs) || beforeMs < 0) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const page = await provider.loadBefore({
        beforeMs,
        revealedBoundaryMs: store.virtualTimeMs,
        dataEpoch: store.dataEpoch,
        limit: 500,
      });
      const latest = storeRef.current;
      if (latest.sessionId !== sessionId
        || latest.dataEpoch !== page.data_epoch
        || latest.virtualTimeMs === null
        || page.revealed_boundary_ms > latest.virtualTimeMs) return;
      applyReplayHistoryPage(runtime.replayStore.seriesStore, page);
      setHistoryEpoch(page.history_epoch);
      setBoundaryMs(page.history_boundary_ms);
      setPolicy(page.history_policy);
      setHasMore(page.has_more && page.bars.length > 0);
      if (!page.has_more) {
        setNotice(page.history_policy.visible_history_lookback.mode === "DURATION"
          ? `已到旧 Run 的固定历史边界：开始前 ${page.history_policy.visible_history_rows} 根 ${config?.base_interval ?? "基础周期"} K 线。新建 Run 默认可按需翻到数据起点。`
          : "已到该数据源连续历史的最早一根 K 线。");
      } else {
        setNotice(null);
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "回放历史回补失败");
      setHasMore(false);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [config?.base_interval, hasMore, provider, runtime.replayStore.seriesStore, sessionId]);

  const restoreLatestWindow = useCallback(async (): Promise<boolean> => {
    const restore = runtime.marketData.actions.restoreLatestWindow;
    if (restore === undefined || loadingRef.current) return false;
    return restore();
  }, [runtime.marketData.actions.restoreLatestWindow]);

  return {
    loading,
    hasMore,
    canRestoreLatestWindow: !loading
      && runtime.store.hasAuthoritativeSnapshot
      && runtime.store.connectionState === "connected"
      && runtime.replayStore.seriesStore.rightTruncated
      && runtime.marketData.actions.restoreLatestWindow !== undefined,
    error,
    historyEpoch,
    boundaryMs,
    policy,
    notice,
    loadMoreLeft,
    restoreLatestWindow,
    dismissNotice: () => setNotice(null),
  };
}
