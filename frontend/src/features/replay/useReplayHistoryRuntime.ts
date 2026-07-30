import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LoadMoreLeft } from "../market-data/useChartLoadMoreLeft.js";
import type { ReplayDigest } from "./replayTypes.js";
import {
  ReplayHistoryProvider,
  applyReplayHistoryPage,
  replayHistoryInitialBeforeMs,
  replayHistoryStoreBeforeMs,
} from "./replayHistoryProvider.js";
import type {
  ReplayHistoryIdentity,
  ReplayHistoryPolicy,
} from "./replayHistoryProvider.js";
import type { ReplayRuntime } from "./useReplayRuntime.js";
import { rebuildReplayViewerSeries } from "./replayViewerProjection.js";
import type { ReplayViewerRuntime } from "./useReplayViewerRuntime.js";


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

export function useReplayHistoryRuntime(
  runtime: ReplayRuntime,
  viewer: ReplayViewerRuntime,
): ReplayHistoryRuntime {
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
  const displayInterval = viewer.viewerState?.display_interval ?? null;
  const identity = useMemo<ReplayHistoryIdentity | null>(() => (
    config === null || displayInterval === null
      ? null
      : ({
    exchange: config.exchange,
    market_type: config.market_type,
    symbol: config.symbol,
    source_kind: config.source_kind === "agg_trade" ? "AGG_TRADE" : "BAR",
    base_interval: config.base_interval,
    display_interval: displayInterval,
  })), [config, displayInterval]);
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

  const loadMoreLeft = useCallback<LoadMoreLeft>(async () => {
    const store = storeRef.current;
    if (provider === null || loadingRef.current || !hasMore
      || store.dataEpoch === null || store.virtualTimeMs === null
    ) return;
    // Context history belongs only to the display store. The frozen base store
    // remains the execution/broker cursor and is never expanded by scrolling.
    const storeBeforeMs = replayHistoryStoreBeforeMs(
      viewer.seriesStore,
    );
    const initialBeforeMs = replayHistoryInitialBeforeMs(
      store.replayStartMs,
      displayInterval,
    );
    // The first native-display page owns every complete display bucket before
    // the replay seam, including buckets that overlap the frozen base warmup.
    // Later pages continue from the oldest display-owned row.
    const beforeMs = provider.historyEpoch === null && initialBeforeMs !== null
      ? initialBeforeMs
      : storeBeforeMs;
    if (beforeMs === null) return;
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
      applyReplayHistoryPage(viewer.seriesStore, page, {
        expectedBeforeMs: beforeMs,
        contextHistory: true,
      });
      setHistoryEpoch(page.history_epoch);
      setBoundaryMs(page.history_boundary_ms);
      setPolicy(page.history_policy);
      setHasMore(page.has_more && page.bars.length > 0);
      if (!page.has_more) {
        setNotice(page.history_policy.visible_history_lookback.mode === "DURATION"
          ? `已到旧 Run 的固定历史边界：开始前 ${page.history_policy.visible_history_rows} 根 ${config?.base_interval ?? "基础周期"} K 线。新建 Run 默认可按需翻到数据起点。`
          : "已到当前观看周期可用连续历史的起点。");
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
  }, [
    config?.base_interval,
    displayInterval,
    hasMore,
    provider,
    sessionId,
    viewer.seriesStore,
  ]);

  const restoreLatestWindow = useCallback(async (): Promise<boolean> => {
    if (
      loadingRef.current
      || config === null
      || displayInterval === null
      || !viewer.seriesStore.rightTruncated
    ) return false;
    provider?.cancel();
    rebuildReplayViewerSeries(
      viewer.seriesStore,
      runtime.replayStore.seriesStore,
      config.base_interval,
      displayInterval,
    );
    setHasMore(true);
    setError(null);
    setHistoryEpoch(null);
    setBoundaryMs(null);
    setPolicy(null);
    setNotice(null);
    return true;
  }, [
    config,
    displayInterval,
    provider,
    runtime.replayStore.seriesStore,
    viewer.seriesStore,
  ]);

  return {
    loading,
    hasMore,
    canRestoreLatestWindow: !loading
      && runtime.store.hasAuthoritativeSnapshot
      && runtime.store.connectionState === "connected"
      && viewer.seriesStore.rightTruncated,
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
