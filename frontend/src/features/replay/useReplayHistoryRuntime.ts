import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LoadMoreLeft } from "../market-data/useChartLoadMoreLeft.js";
import type { ReplayDigest } from "./replayTypes.js";
import {
  ReplayHistoryProvider,
  applyReplayHistoryPage,
  replayHistoryInitialBeforeMs,
  replayHistoryRevealRepairBeforeMs,
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

interface ReplayHistoryState {
  readonly key: string | null;
  readonly loading: boolean;
  readonly hasMore: boolean;
  readonly error: string | null;
  readonly historyEpoch: ReplayDigest | null;
  readonly boundaryMs: number | null;
  readonly policy: ReplayHistoryPolicy | null;
  readonly notice: string | null;
}

function initialReplayHistoryState(key: string | null): ReplayHistoryState {
  return {
    key,
    loading: false,
    hasMore: true,
    error: null,
    historyEpoch: null,
    boundaryMs: null,
    policy: null,
    notice: null,
  };
}

export function useReplayHistoryRuntime(
  runtime: ReplayRuntime,
  viewer: ReplayViewerRuntime,
): ReplayHistoryRuntime {
  const storeRef = useRef(runtime.store);
  storeRef.current = runtime.store;
  const config = runtime.store.sessionConfig;
  const sessionId = runtime.store.sessionId;
  const dataEpoch = runtime.store.dataEpoch;
  const runtimeGeneration = runtime.store.generation;
  const displayInterval = viewer.viewerState?.display_interval ?? null;
  const exchange = config?.exchange ?? null;
  const marketType = config?.market_type ?? null;
  const symbol = config?.symbol ?? null;
  const sourceKind = config?.source_kind ?? null;
  const baseInterval = config?.base_interval ?? null;
  const identity = useMemo<ReplayHistoryIdentity | null>(() => (
    exchange === null || marketType === null || symbol === null
      || sourceKind === null || baseInterval === null || displayInterval === null
      ? null
      : ({
    exchange,
    market_type: marketType,
    symbol,
    source_kind: sourceKind === "agg_trade" ? "AGG_TRADE" : "BAR",
    base_interval: baseInterval,
    display_interval: displayInterval,
  })), [baseInterval, displayInterval, exchange, marketType, sourceKind, symbol]);
  const provider = useMemo(() => (
    sessionId === null || identity === null || dataEpoch === null
      ? null
      : new ReplayHistoryProvider({ sessionId, trackId: "track-1", identity })
  ), [dataEpoch, identity, sessionId]);
  const historyKey = useMemo(() => (
    sessionId === null || identity === null || dataEpoch === null
      ? null
      : JSON.stringify([
        runtimeGeneration,
        sessionId,
        dataEpoch,
        identity.exchange,
        identity.market_type,
        identity.symbol,
        identity.source_kind,
        identity.base_interval,
        identity.display_interval,
      ])
  ), [dataEpoch, identity, runtimeGeneration, sessionId]);
  const [historyState, setHistoryState] = useState<ReplayHistoryState>(() => (
    initialReplayHistoryState(historyKey)
  ));
  const [, setViewerSeriesRevision] = useState(0);
  const currentState = historyState.key === historyKey
    ? historyState
    : initialReplayHistoryState(historyKey);
  const loadingRef = useRef<{ key: string | null; loading: boolean }>({
    key: historyKey,
    loading: false,
  });
  const repairAttemptsRef = useRef(new Set<number>());
  const {
    loading,
    hasMore,
    error,
    historyEpoch,
    boundaryMs,
    policy,
    notice,
  } = currentState;

  useEffect(() => {
    loadingRef.current = { key: historyKey, loading: false };
    repairAttemptsRef.current.clear();
    setHistoryState(initialReplayHistoryState(historyKey));
    return () => provider?.cancel();
  }, [historyKey, provider]);

  useEffect(() => {
    const unsubscribe = viewer.seriesStore.subscribe((delta) => {
      if (delta.type === "replace" || delta.type === "clear") {
        setViewerSeriesRevision((current) => current + 1);
      }
    });
    return () => { unsubscribe(); };
  }, [viewer.seriesStore]);

  const revealRepairBeforeMs = replayHistoryRevealRepairBeforeMs(
    viewer.seriesStore,
    runtime.store.replayStartMs,
    runtime.store.virtualTimeMs,
    displayInterval,
  );
  const revealRepairPending = revealRepairBeforeMs !== null
    && !repairAttemptsRef.current.has(revealRepairBeforeMs);

  const loadMoreLeft = useCallback<LoadMoreLeft>(async () => {
    const store = storeRef.current;
    const repairBeforeMs = replayHistoryRevealRepairBeforeMs(
      viewer.seriesStore,
      store.replayStartMs,
      store.virtualTimeMs,
      displayInterval,
    );
    const pendingRepairBeforeMs = repairBeforeMs !== null
      && !repairAttemptsRef.current.has(repairBeforeMs)
      ? repairBeforeMs
      : null;
    if (provider === null
      || (loadingRef.current.key === historyKey && loadingRef.current.loading)
      || (!hasMore && pendingRepairBeforeMs === null)
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
    const beforeMs = pendingRepairBeforeMs
      ?? (provider.historyEpoch === null && initialBeforeMs !== null
        ? initialBeforeMs
        : storeBeforeMs);
    if (beforeMs === null) return;
    loadingRef.current = { key: historyKey, loading: true };
    setHistoryState((current) => ({
      ...(current.key === historyKey ? current : initialReplayHistoryState(historyKey)),
      loading: true,
      error: null,
    }));
    try {
      const page = await provider.loadBefore({
        beforeMs,
        revealedBoundaryMs: store.virtualTimeMs,
        dataEpoch: store.dataEpoch,
        limit: 500,
      });
      const latest = storeRef.current;
      if (latest.sessionId !== sessionId
        || latest.generation !== runtimeGeneration
        || latest.dataEpoch !== page.data_epoch
        || latest.virtualTimeMs === null
        || page.revealed_boundary_ms > latest.virtualTimeMs) return;
      applyReplayHistoryPage(viewer.seriesStore, page, {
        expectedBeforeMs: beforeMs,
        contextHistory: true,
      });
      if (pendingRepairBeforeMs !== null) {
        repairAttemptsRef.current.add(pendingRepairBeforeMs);
      }
      const nextHasMore = page.has_more && page.bars.length > 0;
      const gapNotice = page.excluded_ranges.length > 0
        ? `已跨过 ${page.excluded_ranges.length} 段交易所无 K 线区间；图表保留空白，没有补造 K 线。`
        : null;
      const nextNotice = !page.has_more
        ? (page.history_policy.visible_history_lookback.mode === "DURATION"
          ? `已到旧 Run 的固定历史边界：开始前 ${page.history_policy.visible_history_rows} 根 ${config?.base_interval ?? "基础周期"} K 线。新建 Run 默认可按需翻到数据起点。`
          : "已到该归档校验过的数据起点；中间的停牌或维护缺口均保持为空白。")
        : gapNotice;
      setHistoryState((current) => current.key === historyKey ? {
        ...current,
        hasMore: nextHasMore,
        historyEpoch: page.history_epoch,
        boundaryMs: page.history_boundary_ms,
        policy: page.history_policy,
        notice: nextNotice,
      } : current);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setHistoryState((current) => current.key === historyKey ? {
        ...current,
        error: cause instanceof Error ? cause.message : "回放历史回补失败",
        hasMore: false,
      } : current);
    } finally {
      if (loadingRef.current.key === historyKey) {
        loadingRef.current = { key: historyKey, loading: false };
      }
      setHistoryState((current) => current.key === historyKey
        ? { ...current, loading: false }
        : current);
    }
  }, [
    config?.base_interval,
    displayInterval,
    hasMore,
    historyKey,
    provider,
    runtimeGeneration,
    sessionId,
    viewer.seriesStore,
  ]);

  useEffect(() => {
    if (
      provider === null
      || revealRepairBeforeMs === null
      || !revealRepairPending
      || runtime.store.dataEpoch === null
      || runtime.store.virtualTimeMs === null
    ) return;
    void loadMoreLeft();
  }, [
    loadMoreLeft,
    provider,
    revealRepairBeforeMs,
    revealRepairPending,
    runtime.store.dataEpoch,
    runtime.store.virtualTimeMs,
  ]);

  const restoreLatestWindow = useCallback(async (): Promise<boolean> => {
    if (
      (loadingRef.current.key === historyKey && loadingRef.current.loading)
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
    loadingRef.current = { key: historyKey, loading: false };
    setHistoryState(initialReplayHistoryState(historyKey));
    return true;
  }, [
    config,
    displayInterval,
    historyKey,
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
    dismissNotice: () => setHistoryState((current) => current.key === historyKey
      ? { ...current, notice: null }
      : current),
  };
}
