import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import type { LoadMoreLeft } from "../market-data/useChartLoadMoreLeft.js";
import type { SurfaceViewportSnapshot } from "../chart-representation/chartRepresentationTypes.js";
import type { ReplayDigest } from "./replayTypes.js";
import {
  ReplayHistoryProvider,
  applyReplayHistoryPage,
  replayHistoryFirstPageBeforeMs,
  replayHistoryRevealRepairBeforeMs,
  replayHistoryStoreBeforeMs,
  replayHistoryViewportTransferNeedsLatestWindow,
  replayHistoryViewportTransferUnavailable,
  replayHistoryViewportBeforeMs,
} from "./replayHistoryProvider.js";
import type {
  ReplayHistoryIdentity,
  ReplayHistoryPolicy,
} from "./replayHistoryProvider.js";
import type { ReplayRuntime } from "./useReplayRuntime.js";
import { defaultReplayV2Api } from "./replayV2Api.js";
import {
  rebuildReplayViewerSeries,
  replayUsesAuthoritativeSourceBucketProjection,
  replaceReplayViewerSeriesFromServer,
} from "./replayViewerProjection.js";
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
  readonly viewportTransferUnavailable: boolean;
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
  readonly viewportTransferUnavailable: boolean;
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
    viewportTransferUnavailable: false,
  };
}

export function useReplayHistoryRuntime(
  runtime: ReplayRuntime,
  viewer: ReplayViewerRuntime,
  viewportTransfer: SurfaceViewportSnapshot | null = null,
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
  const usesSourceBucketProjection = replayUsesAuthoritativeSourceBucketProjection(
    sourceKind,
    baseInterval,
    displayInterval,
  );
  // Each authoritative coarse interval owns a different source-bucket
  // mapping. A source-lineage anchor from 1D therefore cannot be compared with
  // the lineage of 1W. Let the authoritative projection restore the latest
  // window, and reserve targeted viewport paging for timelines with a shared
  // identity.
  const historyViewportTransfer = usesSourceBucketProjection
    ? null
    : viewportTransfer;
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
  const viewportAttemptsRef = useRef(new Set<number>());
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
    viewportAttemptsRef.current.clear();
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
  const viewportBeforeMs = historyViewportTransfer !== null
    && historyViewportTransfer.datasetKey !== viewer.seriesStore.seriesKey
    ? replayHistoryViewportBeforeMs(viewer.seriesStore, {
        anchorSourceTime: historyViewportTransfer.anchorSourceTime,
        displayInterval,
        revealedBoundaryMs: runtime.store.virtualTimeMs,
      })
    : null;
  const viewportPagePending = viewportBeforeMs !== null
    && !viewportAttemptsRef.current.has(viewportBeforeMs);
  const initialContextPagePending = usesSourceBucketProjection
    && provider?.historyEpoch === null
    && runtime.store.replayStartMs !== null
    && runtime.store.virtualTimeMs === runtime.store.replayStartMs
    && replayHistoryStoreBeforeMs(viewer.seriesStore) !== null;
  const viewportNeedsLatestRestore = replayHistoryViewportTransferNeedsLatestWindow(
    viewer.seriesStore,
    historyViewportTransfer,
    {
      displayInterval,
      revealedBoundaryMs: runtime.store.virtualTimeMs,
    },
  );

  const loadMoreLeft = useCallback<LoadMoreLeft>(async () => {
    const store = storeRef.current;
    const targetViewportBeforeMs = historyViewportTransfer !== null
      && historyViewportTransfer.datasetKey !== viewer.seriesStore.seriesKey
      ? replayHistoryViewportBeforeMs(viewer.seriesStore, {
          anchorSourceTime: historyViewportTransfer.anchorSourceTime,
          displayInterval,
          revealedBoundaryMs: store.virtualTimeMs,
        })
      : null;
    const pendingViewportBeforeMs = targetViewportBeforeMs !== null
      && !viewportAttemptsRef.current.has(targetViewportBeforeMs)
      ? targetViewportBeforeMs
      : null;
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
      || (!hasMore
        && pendingViewportBeforeMs === null
        && pendingRepairBeforeMs === null)
      || store.dataEpoch === null || store.virtualTimeMs === null
    ) return;
    // Context history belongs only to the display store. The frozen base store
    // remains the execution/broker cursor and is never expanded by scrolling.
    const storeBeforeMs = replayHistoryStoreBeforeMs(
      viewer.seriesStore,
    );
    const firstPageBeforeMs = replayHistoryFirstPageBeforeMs(
      viewer.seriesStore,
      store.replayStartMs,
      displayInterval,
      usesSourceBucketProjection,
    );
    // Source-bucket pages connect to the authoritative projection's exact
    // source phase. Other first pages retain the replay seam so history can
    // replace an overlapping partial warmup bucket. Later pages always
    // continue from the oldest display-owned row.
    const beforeMs = pendingViewportBeforeMs
      ?? pendingRepairBeforeMs
      ?? (provider.historyEpoch === null && firstPageBeforeMs !== null
        ? firstPageBeforeMs
        : storeBeforeMs);
    if (beforeMs === null) return;
    if (pendingViewportBeforeMs !== null) {
      viewportAttemptsRef.current.add(pendingViewportBeforeMs);
    }
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
      // A display-interval switch can start a viewport/repair page while the
      // source-bucket projection is still in flight.  Once that authoritative
      // projection arrives it may already cover the requested anchor.  Do not
      // let the older page reconnect against a cursor that is no longer the
      // active gap; a fresh render will request a different target if one is
      // still needed.
      if (pendingViewportBeforeMs !== null) {
        const latestViewportBeforeMs = historyViewportTransfer !== null
          ? replayHistoryViewportBeforeMs(viewer.seriesStore, {
              anchorSourceTime: historyViewportTransfer.anchorSourceTime,
              displayInterval,
              revealedBoundaryMs: latest.virtualTimeMs,
            })
          : null;
        if (latestViewportBeforeMs !== pendingViewportBeforeMs) return;
      }
      if (pendingRepairBeforeMs !== null) {
        const latestRepairBeforeMs = replayHistoryRevealRepairBeforeMs(
          viewer.seriesStore,
          latest.replayStartMs,
          latest.virtualTimeMs,
          displayInterval,
        );
        if (latestRepairBeforeMs !== pendingRepairBeforeMs) return;
      }
      applyReplayHistoryPage(viewer.seriesStore, page, {
        expectedBeforeMs: beforeMs,
        contextHistory: true,
      });
      if (pendingRepairBeforeMs !== null) {
        repairAttemptsRef.current.add(pendingRepairBeforeMs);
      }
      const nextHasMore = page.has_more && page.bars.length > 0;
      // A gap can invalidate the whole target display bucket even when the
      // original fine-grained anchor itself is outside the excluded range.
      // The targeted page gets one attempt; actual post-apply coverage is the
      // authoritative terminal check, including empty/exhausted pages.
      const viewportTransferUnavailable = replayHistoryViewportTransferUnavailable(
        viewer.seriesStore,
        historyViewportTransfer,
        pendingViewportBeforeMs,
      );
      const gapNotice = page.excluded_ranges.length > 0
        ? t("replay.history.excludedGaps", { count: page.excluded_ranges.length })
        : null;
      const nextNotice = !page.has_more
        ? (page.history_policy.visible_history_lookback.mode === "DURATION"
          ? t("replay.history.oldRunBound", {
            count: page.history_policy.visible_history_rows,
            interval: config?.base_interval ?? t("replay.history.baseInterval"),
          })
          : t("replay.history.archiveStart"))
        : gapNotice;
      setHistoryState((current) => current.key === historyKey ? {
        ...current,
        hasMore: nextHasMore,
        historyEpoch: page.history_epoch,
        boundaryMs: page.history_boundary_ms,
        policy: page.history_policy,
        notice: nextNotice,
        viewportTransferUnavailable,
      } : current);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setHistoryState((current) => current.key === historyKey ? {
        ...current,
        error: cause instanceof Error ? cause.message : t("replay.history.loadFailed"),
        hasMore: false,
        viewportTransferUnavailable: pendingViewportBeforeMs !== null,
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
    usesSourceBucketProjection,
    viewer.seriesStore,
    historyViewportTransfer,
  ]);

  useEffect(() => {
    if (
      provider === null
      || viewportNeedsLatestRestore
      || (!initialContextPagePending && !viewportPagePending && !revealRepairPending)
      || runtime.store.dataEpoch === null
      || runtime.store.virtualTimeMs === null
    ) return;
    void loadMoreLeft();
  }, [
    loadMoreLeft,
    initialContextPagePending,
    provider,
    revealRepairBeforeMs,
    revealRepairPending,
    runtime.store.dataEpoch,
    runtime.store.virtualTimeMs,
    viewportBeforeMs,
    viewportNeedsLatestRestore,
    viewportPagePending,
  ]);

  const restoreLatestWindow = useCallback(async (): Promise<boolean> => {
    if (
      (loadingRef.current.key === historyKey && loadingRef.current.loading)
      || config === null
      || displayInterval === null
      || !viewer.seriesStore.rightTruncated
    ) return false;
    provider?.cancel();
    if (usesSourceBucketProjection
      && runtime.store.sessionId !== null
      && runtime.store.dataEpoch !== null
      && runtime.store.virtualTimeMs !== null
      && viewer.viewerState?.selected_track_id !== null
      && viewer.viewerState?.selected_track_id !== undefined) {
      const response = await defaultReplayV2Api.displayProjectionBySession(
        runtime.store.sessionId,
        {
          trackId: viewer.viewerState.selected_track_id,
          displayInterval,
          revealedBoundaryMs: runtime.store.virtualTimeMs,
          dataEpoch: runtime.store.dataEpoch,
        },
      );
      replaceReplayViewerSeriesFromServer(
        viewer.seriesStore,
        runtime.replayStore.seriesStore,
        displayInterval,
        response.bars,
        response.revealed_boundary_ms,
      );
    } else {
      rebuildReplayViewerSeries(
        viewer.seriesStore,
        runtime.replayStore.seriesStore,
        config.base_interval,
        displayInterval,
      );
    }
    loadingRef.current = { key: historyKey, loading: false };
    setHistoryState(initialReplayHistoryState(historyKey));
    return true;
  }, [
    config,
    displayInterval,
    historyKey,
    provider,
    runtime.replayStore.seriesStore,
    runtime.store.dataEpoch,
    runtime.store.sessionId,
    runtime.store.virtualTimeMs,
    usesSourceBucketProjection,
    viewer.seriesStore,
    viewer.viewerState,
  ]);

  useEffect(() => {
    if (!viewportNeedsLatestRestore) return;
    void restoreLatestWindow();
  }, [restoreLatestWindow, viewportNeedsLatestRestore]);

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
    viewportTransferUnavailable: currentState.viewportTransferUnavailable,
    loadMoreLeft,
    restoreLatestWindow,
    dismissNotice: () => setHistoryState((current) => current.key === historyKey
      ? { ...current, notice: null }
      : current),
  };
}
