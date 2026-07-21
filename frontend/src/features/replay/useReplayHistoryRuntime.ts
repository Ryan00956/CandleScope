import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LoadMoreLeft } from "../market-data/useChartLoadMoreLeft.js";
import type { ReplayDigest } from "./replayTypes.js";
import {
  ReplayHistoryProvider,
  applyReplayHistoryPage,
} from "./replayHistoryProvider.js";
import type { ReplayHistoryIdentity } from "./replayHistoryProvider.js";
import type { ReplayRuntime } from "./useReplayRuntime.js";


export interface ReplayHistoryRuntime {
  readonly loading: boolean;
  readonly hasMore: boolean;
  readonly error: string | null;
  readonly historyEpoch: ReplayDigest | null;
  readonly loadMoreLeft: LoadMoreLeft;
}

export function useReplayHistoryRuntime(runtime: ReplayRuntime): ReplayHistoryRuntime {
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyEpoch, setHistoryEpoch] = useState<ReplayDigest | null>(null);
  const loadingRef = useRef(false);
  const storeRef = useRef(runtime.store);
  storeRef.current = runtime.store;
  const config = runtime.store.sessionConfig;
  const sessionId = runtime.store.sessionId;
  const dataEpoch = runtime.store.dataEpoch;
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
    loadingRef.current = false;
    setLoading(false);
    return () => provider?.cancel();
  }, [provider]);

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
      setHasMore(page.has_more && page.bars.length > 0);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "回放历史回补失败");
      setHasMore(false);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [hasMore, provider, runtime.replayStore.seriesStore, sessionId]);

  return { loading, hasMore, error, historyEpoch, loadMoreLeft };
}
