import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WindowDelta, WindowDeltaType } from "../market-data/klineContracts.js";
import { WINDOW_DELTA_TYPES } from "../market-data/window/windowDeltas.js";
import { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import { intervalsSemanticallyEquivalent } from "../../utils/intervals.js";
import type {
  ReplayAccountAuditResponse,
  ReplayOrderPreview,
  ReplayOrderCapacity,
  ReplayOrderCapacityContext,
  ReplayOrderRequest,
  ReplayTradePlanDraft,
  ReplayV2Command,
  ReplayV2CommandResult,
  ReplayV2CommandType,
  ReplayV2Json,
  ReplayMarketTracksResponse,
  ReplayV2SubscriptionTier,
  ReplayViewerState,
} from "./replayV2Types.js";
import { defaultReplayV2Api } from "./replayV2Api.js";
import type { ReplayPeriodSummaryStatusResponse } from "./replayPeriodSummary.js";
import {
  applyReplayViewerSeriesDelta,
  replayUsesAuthoritativeSourceBucketProjection,
  ReplayViewerSeriesCache,
  replaceReplayViewerSeriesFromServer,
} from "./replayViewerProjection.js";
import type { ReplayRuntime } from "./useReplayRuntime.js";


export type ReplayPhase3ControlType = Extract<ReplayV2CommandType,
  | "acquire_controller"
  | "takeover_controller"
  | "release_controller"
  | "play"
  | "pause"
  | "set_speed"
  | "step_event"
  | "step_base"
  | "step_display"
  | "advance"
  | "advance_by"
  | "advance_to"
  | "end"
>;

export type ReplayPhase5TradeType = Extract<ReplayV2CommandType,
  | "place_order"
  | "replace_order"
  | "cancel_order"
  | "cancel_orders"
  | "close_position"
  | "execute_position_intent"
  | "set_position_protection"
  | "set_position_leverage"
  | "allocate_isolated_margin"
>;

export function replayAdvanceIsCancelable(
  command: ReplayV2Command | null,
): boolean {
  return command?.type === "advance_by"
    || command?.type === "advance_to"
    || (
      command?.type === "advance"
      && command.payload.basis === "VIRTUAL_TIME"
    );
}

export interface ReplayViewerProjectionScheduler {
  readonly schedule: () => void;
  readonly cancel: () => void;
}

export interface ReplayViewerProjectionRequestGate {
  readonly begin: (key: string) => AbortController | null;
  readonly isCurrent: (key: string, request: AbortController) => boolean;
  readonly commit: (key: string, request: AbortController) => boolean;
  readonly finish: (request: AbortController) => void;
  readonly cancel: () => void;
}

export function createReplayViewerProjectionRequestGate(
  createController: () => AbortController = () => new AbortController(),
): ReplayViewerProjectionRequestGate {
  let active: { readonly key: string; readonly request: AbortController } | null = null;
  let committedKey: string | null = null;
  const isCurrent = (key: string, request: AbortController): boolean => (
    active?.key === key
    && active.request === request
    && !request.signal.aborted
  );
  return {
    begin: (key) => {
      if (active?.key === key || committedKey === key) return null;
      active?.request.abort();
      const request = createController();
      active = { key, request };
      return request;
    },
    isCurrent,
    commit: (key, request) => {
      if (!isCurrent(key, request)) return false;
      committedKey = key;
      active = null;
      return true;
    },
    finish: (request) => {
      if (active?.request === request) active = null;
    },
    cancel: () => {
      active?.request.abort();
      active = null;
    },
  };
}

export function createReplayViewerProjectionScheduler(
  rebuild: () => void,
  requestFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancelFrame: (handle: number) => void = cancelAnimationFrame,
): ReplayViewerProjectionScheduler {
  let pendingFrame: number | null = null;
  return {
    schedule: () => {
      if (pendingFrame !== null) return;
      pendingFrame = requestFrame(() => {
        pendingFrame = null;
        rebuild();
      });
    },
    cancel: () => {
      if (pendingFrame === null) return;
      cancelFrame(pendingFrame);
      pendingFrame = null;
    },
  };
}

export interface ReplayViewerProjectionRequestScheduler {
  schedule(): void;
  cancel(): void;
}

/**
 * Coalesce source-authority notifications without gating HTTP work on paint.
 *
 * The source series publishes synchronously while ReplayStore applies a stream
 * event, before the enclosing event handler commits its envelope cursor.  A
 * microtask therefore provides the required authority barrier.  Unlike
 * requestAnimationFrame, it also remains prompt when Chrome throttles paint in
 * an occluded/background tab, so a coarse display projection does not inherit
 * a roughly one-second frame delay before its request even starts.
 */
export function createReplayViewerProjectionRequestScheduler(
  refresh: () => void,
  enqueueMicrotask: (callback: () => void) => void = queueMicrotask,
): ReplayViewerProjectionRequestScheduler {
  let pending = false;
  let generation = 0;
  return {
    schedule: () => {
      if (pending) return;
      pending = true;
      const scheduledGeneration = generation;
      enqueueMicrotask(() => {
        if (!pending || scheduledGeneration !== generation) return;
        pending = false;
        refresh();
      });
    },
    cancel: () => {
      pending = false;
      generation += 1;
    },
  };
}

interface ReplayRevisionStore {
  readonly getAuthoritySnapshot: () => { readonly revision: number };
  readonly subscribe: (listener: () => void) => () => void;
}

export const REPLAY_STORE_REVISION_ACK_TIMEOUT_MS = 1_000;

export function waitForReplayStoreRevision(
  store: ReplayRevisionStore,
  targetRevision: number,
  timeoutMs = REPLAY_STORE_REVISION_ACK_TIMEOUT_MS,
): Promise<boolean> {
  if (store.getAuthoritySnapshot().revision >= targetRevision) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let unsubscribeWhenReady = false;
    const finish = (converged: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (unsubscribe === null) unsubscribeWhenReady = true;
      else unsubscribe();
      resolve(converged);
    };
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    unsubscribe = store.subscribe(() => {
      if (store.getAuthoritySnapshot().revision >= targetRevision) finish(true);
    });
    if (unsubscribeWhenReady) unsubscribe();
    if (store.getAuthoritySnapshot().revision >= targetRevision) finish(true);
  });
}

export function coalesceReplayViewerSourceDeltas(
  deltas: readonly WindowDelta[],
): WindowDelta | null {
  const changed = deltas.filter((delta) => delta.changed);
  if (changed.length === 0) return null;
  if (changed.length === 1) return changed[0] ?? null;
  const types = changed.map((delta) => delta.type);
  let type: WindowDeltaType;
  if (types.includes(WINDOW_DELTA_TYPES.REPLACE)) {
    type = WINDOW_DELTA_TYPES.REPLACE;
  } else if (types.includes(WINDOW_DELTA_TYPES.CLEAR)) {
    // A clear mixed with another write describes a new authoritative shape.
    type = WINDOW_DELTA_TYPES.REPLACE;
  } else if (types.every((item) => item === WINDOW_DELTA_TYPES.TICK)) {
    type = WINDOW_DELTA_TYPES.TICK;
  } else if (types.every((item) => (
    item === WINDOW_DELTA_TYPES.TICK || item === WINDOW_DELTA_TYPES.APPEND
  ))) {
    type = WINDOW_DELTA_TYPES.APPEND;
  } else if (types.every((item) => item === WINDOW_DELTA_TYPES.PREPEND)) {
    type = WINDOW_DELTA_TYPES.PREPEND;
  } else {
    type = WINDOW_DELTA_TYPES.MID_MERGE;
  }
  const latest = changed[changed.length - 1] as WindowDelta;
  const replacements = changed.filter((delta) => delta.type === WINDOW_DELTA_TYPES.REPLACE);
  return {
    ...latest,
    type,
    changed: true,
    addedLeft: changed.reduce((total, delta) => (
      total + (Number(delta.addedLeft) || 0)
    ), 0),
    addedRight: changed.reduce((total, delta) => (
      total + (Number(delta.addedRight) || 0)
    ), 0),
    trimmedLeft: changed.reduce((total, delta) => (
      total + (Number(delta.trimmedLeft) || 0)
    ), 0),
    trimmedRight: changed.reduce((total, delta) => (
      total + (Number(delta.trimmedRight) || 0)
    ), 0),
    ...(replacements.length > 0
      ? {
          preserveRevealedPrefix: replacements.every((delta) => (
            delta.preserveRevealedPrefix === true
          )),
        }
      : {}),
    source: "replay-viewer-source-burst",
  };
}

function publicTimeMsFromDelta(
  delta: WindowDelta | null,
  fallback: number | null,
): number | null {
  const value = Number(delta?.publicTimeMs);
  if (Number.isSafeInteger(value) && value >= 0) return value;
  return Number.isSafeInteger(fallback) && Number(fallback) >= 0
    ? Number(fallback)
    : null;
}

export interface ReplayViewerRuntime {
  readonly viewerState: ReplayViewerState | null;
  readonly marketTracks: ReplayMarketTracksResponse | null;
  readonly seriesStore: SeriesWindowStore;
  readonly loading: boolean;
  readonly error: string | null;
  readonly controlPending: ReplayV2Command | null;
  readonly viewerPending: boolean;
  readonly progress: Readonly<Record<string, ReplayV2Json>> | null;
  readonly periodSummary: ReplayPeriodSummaryStatusResponse | null;
  readonly summaryPreparing: boolean;
  readonly summaryError: string | null;
  readonly actions: {
    setDisplayInterval(interval: string): Promise<ReplayV2CommandResult | null>;
    submitControl(
      type: ReplayPhase3ControlType,
      payload: Readonly<Record<string, ReplayV2Json>>,
    ): Promise<ReplayV2CommandResult>;
    cancelAdvance(): Promise<ReplayV2CommandResult>;
    selectTrack(trackId: string): Promise<ReplayV2CommandResult>;
    setSubscriptionTier(
      trackId: string,
      tier: ReplayV2SubscriptionTier,
    ): Promise<ReplayV2CommandResult>;
    addAndSelectTrack(identity: {
      readonly exchange: string;
      readonly marketType: string;
      readonly symbol: string;
      readonly settlementAsset: string;
    }): Promise<ReplayV2CommandResult>;
    submitTrade(
      type: ReplayPhase5TradeType,
      payload: Readonly<Record<string, ReplayV2Json>>,
    ): Promise<ReplayV2CommandResult>;
    previewOrder(
      order: ReplayOrderRequest,
      positionIntent: "NET" | "OPEN",
      tradePlan?: ReplayTradePlanDraft | null,
      signal?: AbortSignal,
    ): Promise<ReplayOrderPreview>;
    orderCapacity(
      context: ReplayOrderCapacityContext,
      positionIntent: "NET" | "OPEN",
      signal?: AbortSignal,
    ): Promise<ReplayOrderCapacity>;
    auditAccount(): Promise<ReplayAccountAuditResponse>;
    resyncHistoricalBook(): Promise<void>;
    preparePeriodSummaries(): Promise<void>;
    reload(): void;
  };
}

function commandId(prefix: string): string {
  const random = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`.slice(0, 128);
}

function progressFromResult(result: ReplayV2CommandResult): Readonly<Record<string, ReplayV2Json>> | null {
  const progress = result.data.progress;
  return progress !== null && typeof progress === "object" && !Array.isArray(progress)
    ? progress as Readonly<Record<string, ReplayV2Json>>
    : null;
}

export function useReplayViewerRuntime(runtime: ReplayRuntime): ReplayViewerRuntime {
  const [viewerState, setViewerState] = useState<ReplayViewerState | null>(null);
  const [marketTracks, setMarketTracks] = useState<ReplayMarketTracksResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [controlPending, setControlPending] = useState<ReplayV2Command | null>(null);
  const [viewerPending, setViewerPending] = useState(false);
  const [progress, setProgress] = useState<Readonly<Record<string, ReplayV2Json>> | null>(null);
  const [periodSummary, setPeriodSummary] = useState<ReplayPeriodSummaryStatusResponse | null>(null);
  const [summaryPreparing, setSummaryPreparing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [reloadRevision, setReloadRevision] = useState(0);
  const viewerRef = useRef(viewerState);
  viewerRef.current = viewerState;
  const controlRef = useRef(controlPending);
  controlRef.current = controlPending;
  const viewerCommandRef = useRef<string | null>(null);
  const marketTracksRequestRef = useRef(0);
  const sourceStore = runtime.replayStore.seriesStore;
  const sessionId = runtime.store.sessionId;
  const config = runtime.store.sessionConfig;
  const baseInterval = config?.base_interval ?? null;
  const adapterDisplayInterval = config?.display_interval ?? null;
  const displayInterval = viewerState?.display_interval ?? null;
  const sourceExchange = config?.exchange ?? null;
  const sourceMarketType = config?.market_type ?? null;
  const sourceSymbol = config?.symbol ?? null;
  const dataEpoch = runtime.store.dataEpoch;
  const requiresSourceBucketProjection = replayUsesAuthoritativeSourceBucketProjection(
    config?.source_kind,
    baseInterval,
    displayInterval,
  );
  const sourceSeriesKey = sourceStore.seriesKey;
  const sourcePublicTimeMsRef = useRef(runtime.store.virtualTimeMs);
  sourcePublicTimeMsRef.current = runtime.store.virtualTimeMs;
  const viewerStores = useMemo(() => ({
    ownerSessionId: sessionId,
    viewerSeriesCache: new ReplayViewerSeriesCache(),
    unavailableSeriesStore: new SeriesWindowStore(),
  }), [sessionId]);
  const { viewerSeriesCache, unavailableSeriesStore } = viewerStores;
  const prepareViewerSeries = useCallback((next: ReplayViewerState): void => {
    if (baseInterval === null) throw new Error("replay base interval is unavailable");
    if (adapterDisplayInterval !== null && !intervalsSemanticallyEquivalent(
      baseInterval,
      adapterDisplayInterval,
    )) {
      throw new Error("authoritative replay adapter is not projected at the base interval");
    }
    if (replayUsesAuthoritativeSourceBucketProjection(
      config?.source_kind,
      baseInterval,
      next.display_interval,
    )) {
      viewerSeriesCache.storeFor(sourceStore, next.display_interval).clear({
        source: "replay-viewer-awaiting-source-bucket-projection",
      });
      return;
    }
    viewerSeriesCache.prepare(
      sourceStore,
      baseInterval,
      next.display_interval,
      sourcePublicTimeMsRef.current,
    );
  }, [
    adapterDisplayInterval,
    baseInterval,
    config?.source_kind,
    sourceStore,
    viewerSeriesCache,
  ]);
  const publishViewerState = useCallback((next: ReplayViewerState): boolean => {
    const current = viewerRef.current;
    if (current !== null
      && next.semantic_view_revision < current.semantic_view_revision) return true;
    const targetChanged = current === null
      || current.run_id !== next.run_id
      || !intervalsSemanticallyEquivalent(
        current.display_interval,
        next.display_interval,
      );
    try {
      if (targetChanged) prepareViewerSeries(next);
    } catch (cause) {
      setViewerState(null);
      setError(cause instanceof Error ? cause.message : "展示周期重建失败");
      return false;
    }
    viewerRef.current = next;
    setViewerState(next);
    return true;
  }, [prepareViewerSeries]);
  const viewerSeriesBinding = useMemo(() => ({
    sourceSeriesKey,
    store: displayInterval === null
      ? unavailableSeriesStore
      : viewerSeriesCache.storeFor(sourceStore, displayInterval),
  }), [
    displayInterval,
    sourceSeriesKey,
    sourceStore,
    unavailableSeriesStore,
    viewerSeriesCache,
  ]);
  const seriesStore = viewerSeriesBinding.store;

  useEffect(() => {
    if (sessionId === null) {
      setViewerState(null);
      setMarketTracks(null);
      setPeriodSummary(null);
      setSummaryError(null);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    void Promise.all([
      defaultReplayV2Api.viewerBySession(sessionId, abort.signal),
      defaultReplayV2Api.tracksBySession(sessionId, abort.signal),
    ]).then(([viewerResponse, tracksResponse]) => {
      const authoritative = tracksResponse.viewer_state.semantic_view_revision
        >= viewerResponse.viewer_state.semantic_view_revision
        ? tracksResponse.viewer_state
        : viewerResponse.viewer_state;
      publishViewerState(authoritative);
      setMarketTracks(tracksResponse);
    }).catch((cause: unknown) => {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "ViewerState 加载失败");
    }).finally(() => {
      if (!abort.signal.aborted) setLoading(false);
    });
    return () => abort.abort();
  }, [publishViewerState, reloadRevision, sessionId]);

  useEffect(() => {
    const runId = viewerState?.run_id;
    if (runId === undefined) {
      setPeriodSummary(null);
      return;
    }
    const abort = new AbortController();
    void defaultReplayV2Api.periodSummaryStatusRun(runId, abort.signal)
      .then((response) => {
        setPeriodSummary(response);
        setSummaryError(null);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setPeriodSummary(null);
        setSummaryError(cause instanceof Error ? cause.message : "摘要状态加载失败");
      });
    return () => abort.abort();
  }, [reloadRevision, viewerState?.run_id]);

  const refreshMarketTracks = useCallback(async (
    runId: string,
  ): Promise<ReplayMarketTracksResponse> => {
    const requestSequence = marketTracksRequestRef.current + 1;
    marketTracksRequestRef.current = requestSequence;
    const response = await defaultReplayV2Api.tracksRun(runId);
    if (requestSequence !== marketTracksRequestRef.current) return response;
    if (!publishViewerState(response.viewer_state)) {
      throw new Error("authoritative replay viewer projection could not be prepared");
    }
    setMarketTracks(response);
    return response;
  }, [publishViewerState]);

  const failClosedAndRefreshMarketTracks = useCallback(async (
    runId: string,
  ): Promise<ReplayMarketTracksResponse | null> => {
    // A rejected command may already have paused the Run and cleared a
    // continuity-gated projection server-side. Remove every local track
    // projection before attempting the authoritative refresh so a second
    // network failure cannot leave stale L2 or fills visible.
    setMarketTracks(null);
    try {
      return await refreshMarketTracks(runId);
    } catch {
      // The original command error remains the user-facing failure. Keeping
      // marketTracks null is the deliberate fail-closed state.
      return null;
    }
  }, [refreshMarketTracks]);

  useEffect(() => {
    if (marketTracks?.global_clock?.state !== "PLAYING") return;
    const timer = setInterval(() => {
      void refreshMarketTracks(marketTracks.run_id).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "全局时钟状态刷新失败");
      });
    }, 250);
    return () => clearInterval(timer);
  }, [marketTracks?.global_clock?.state, marketTracks?.run_id, refreshMarketTracks]);

  useEffect(() => {
    if (requiresSourceBucketProjection) {
      let disposed = false;
      const requestGate = createReplayViewerProjectionRequestGate();
      const refresh = () => {
        const boundaryMs = runtime.replayStore.getAuthoritySnapshot().virtualTimeMs;
        const activeDataEpoch = dataEpoch;
        const trackId = viewerRef.current?.selected_track_id ?? null;
        if (sessionId === null
          || displayInterval === null
          || boundaryMs === null
          || activeDataEpoch === null
          || trackId === null) {
          seriesStore.clear({ source: "replay-viewer-source-bucket-unavailable" });
          return;
        }
        const requestKey = JSON.stringify([
          sessionId,
          trackId,
          displayInterval,
          activeDataEpoch,
          boundaryMs,
        ]);
        const request = requestGate.begin(requestKey);
        if (request === null) return;
        void defaultReplayV2Api.displayProjectionBySession(
          sessionId,
          {
            trackId,
            displayInterval,
            revealedBoundaryMs: boundaryMs,
            dataEpoch: activeDataEpoch,
          },
          request.signal,
        ).then((response) => {
          if (disposed || !requestGate.isCurrent(requestKey, request)) return;
          const latestBoundaryMs = runtime.replayStore.getAuthoritySnapshot().virtualTimeMs;
          if (response.session_id !== sessionId
            || response.track_id !== trackId
            || response.display_interval !== displayInterval
            || response.data_epoch !== activeDataEpoch
            || response.revealed_boundary_ms !== boundaryMs
            || response.identity.exchange !== sourceExchange
            || response.identity.market_type !== sourceMarketType
            || response.identity.symbol !== sourceSymbol
            || response.identity.source_kind !== "BAR"
            || baseInterval === null
            || !intervalsSemanticallyEquivalent(
              response.identity.base_interval,
              baseInterval,
            )) {
            throw new Error("source-bucket projection identity changed");
          }
          if (latestBoundaryMs !== boundaryMs
            || dataEpoch !== activeDataEpoch) {
            projectionRequestScheduler.schedule();
            return;
          }
          replaceReplayViewerSeriesFromServer(
            seriesStore,
            sourceStore,
            displayInterval,
            response.bars,
            response.revealed_boundary_ms,
          );
          viewerSeriesCache.markSynchronized(
            seriesStore,
            sourceStore,
            response.revealed_boundary_ms,
          );
          requestGate.commit(requestKey, request);
          setError(null);
        }).catch((cause: unknown) => {
          if (disposed
            || request.signal.aborted
            || (cause instanceof DOMException && cause.name === "AbortError")) return;
          seriesStore.clear({ source: "replay-viewer-source-bucket-error" });
          setError(cause instanceof Error ? cause.message : "交易所周期 K 线重建失败");
        }).finally(() => {
          requestGate.finish(request);
        });
      };
      const projectionRequestScheduler = createReplayViewerProjectionRequestScheduler(refresh);
      refresh();
      const unsubscribe = sourceStore.subscribe(() => {
        projectionRequestScheduler.schedule();
      });
      return () => {
        disposed = true;
        unsubscribe();
        projectionRequestScheduler.cancel();
        requestGate.cancel();
      };
    }
    let initialized = false;
    let pendingSourceDeltas: WindowDelta[] = [];
    const rebuild = () => {
      if (baseInterval === null || displayInterval === null) {
        seriesStore.clear({ source: "replay-viewer-unavailable" });
        initialized = false;
        pendingSourceDeltas = [];
        return;
      }
      try {
        const sourceDelta = coalesceReplayViewerSourceDeltas(pendingSourceDeltas);
        pendingSourceDeltas = [];
        if (!initialized || sourceDelta === null) {
          viewerSeriesCache.synchronize(
            seriesStore,
            sourceStore,
            baseInterval,
            displayInterval,
            sourcePublicTimeMsRef.current,
          );
          initialized = true;
        } else {
          applyReplayViewerSeriesDelta(
            seriesStore,
            sourceStore,
            baseInterval,
            displayInterval,
            sourceDelta,
          );
          viewerSeriesCache.markSynchronized(
            seriesStore,
            sourceStore,
            publicTimeMsFromDelta(sourceDelta, sourcePublicTimeMsRef.current),
          );
        }
        setError(null);
      } catch (cause) {
        seriesStore.clear({ source: "replay-viewer-error" });
        setError(cause instanceof Error ? cause.message : "展示周期重建失败");
      }
    };
    rebuild();
    const projectionScheduler = createReplayViewerProjectionScheduler(rebuild);
    const unsubscribe = sourceStore.subscribe((delta) => {
      pendingSourceDeltas.push(delta);
      projectionScheduler.schedule();
    });
    return () => {
      unsubscribe();
      projectionScheduler.cancel();
      pendingSourceDeltas = [];
    };
  }, [
    baseInterval,
    dataEpoch,
    displayInterval,
    requiresSourceBucketProjection,
    runtime.replayStore,
    seriesStore,
    sessionId,
    sourceExchange,
    sourceMarketType,
    sourceSymbol,
    sourceStore,
    viewerSeriesCache,
  ]);

  useEffect(() => {
    const active = controlPending;
    if (!replayAdvanceIsCancelable(active)) return;
    if (active === null) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const response = await defaultReplayV2Api.advanceProgress(
          active.run_id,
          active.command_id,
          abort.signal,
        );
        setProgress(response.progress);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        // The command request and progress endpoint race during startup and
        // teardown. The authoritative command result remains the final state.
      }
      if (!abort.signal.aborted) timer = setTimeout(() => { void poll(); }, 100);
    };
    timer = setTimeout(() => { void poll(); }, 100);
    return () => {
      abort.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [controlPending]);

  const buildCommand = useCallback((
    type: ReplayV2CommandType,
    payload: Readonly<Record<string, ReplayV2Json>>,
    prefix: string,
  ): ReplayV2Command => {
    const viewer = viewerRef.current;
    const store = runtime.store;
    if (viewer === null || store.virtualTimeMs === null || store.sessionId === null) {
      throw new Error("replay.v3 viewer is not command-ready");
    }
    return {
      protocol: "replay.v3",
      run_id: viewer.run_id,
      command_id: commandId(prefix),
      client_instance_id: runtime.clientInstanceId,
      expected_revision: store.revision,
      expected_cursor: {
        virtual_time_ms: store.virtualTimeMs,
        source_sequence: store.sourceSequence,
        revision: store.revision,
      },
      type,
      payload,
    };
  }, [runtime.clientInstanceId, runtime.store]);

  const submitControl = useCallback(async (
    type: ReplayPhase3ControlType,
    payload: Readonly<Record<string, ReplayV2Json>>,
  ): Promise<ReplayV2CommandResult> => {
    if (controlRef.current !== null) throw new Error("another replay.v3 control is pending");
    const viewer = viewerRef.current;
    if (viewer === null) throw new Error("ViewerState is unavailable");
    const canonicalDisplayBinding = (
      type === "advance"
      || type === "play"
      || type === "set_speed"
    ) && payload.basis === "DISPLAY_BAR";
    const boundPayload = type === "step_display" || canonicalDisplayBinding
      ? {
          ...payload,
          display_interval: viewer.display_interval,
          viewer_revision: viewer.semantic_view_revision,
        }
      : payload;
    const command = buildCommand(type, boundPayload, "control");
    setControlPending(command);
    setProgress(null);
    setError(null);
    try {
      const result = await defaultReplayV2Api.commandRun(command.run_id, command);
      publishViewerState(result.viewer_state);
      setProgress(progressFromResult(result));
      const displayAdvance = type === "advance"
        && boundPayload.basis === "DISPLAY_BAR";
      if (displayAdvance) {
        const converged = await waitForReplayStoreRevision(
          runtime.replayStore,
          result.revision,
        );
        if (!converged) runtime.actions.requestResync("v2-display-advance-ack-timeout");
        void refreshMarketTracks(command.run_id).catch((cause: unknown) => {
          setMarketTracks(null);
          setError(cause instanceof Error ? cause.message : "市场轨道状态刷新失败");
        });
      } else {
        await refreshMarketTracks(command.run_id);
      }
      return result;
    } catch (cause) {
      await failClosedAndRefreshMarketTracks(command.run_id);
      setError(cause instanceof Error ? cause.message : "回放控制失败");
      throw cause;
    } finally {
      setControlPending((current) => current?.command_id === command.command_id ? null : current);
    }
  }, [
    buildCommand,
    failClosedAndRefreshMarketTracks,
    publishViewerState,
    refreshMarketTracks,
    runtime.actions,
    runtime.replayStore,
  ]);

  const setDisplayInterval = useCallback(async (
    interval: string,
  ): Promise<ReplayV2CommandResult | null> => {
    if (viewerCommandRef.current !== null) {
      throw new Error("another replay.v3 viewer command is pending");
    }
    const viewer = viewerRef.current;
    if (viewer === null) throw new Error("ViewerState is unavailable");
    const command = buildCommand(
      "set_display_interval",
      {
        display_interval: interval,
        expected_viewer_revision: viewer.semantic_view_revision,
      },
      "viewer",
    );
    viewerCommandRef.current = command.command_id;
    setViewerPending(true);
    setError(null);
    try {
      const result = await defaultReplayV2Api.commandRun(command.run_id, command);
      publishViewerState(result.viewer_state);
      return result;
    } catch (cause) {
      const authoritative = await failClosedAndRefreshMarketTracks(command.run_id);
      if (authoritative !== null && intervalsSemanticallyEquivalent(
        authoritative.viewer_state.display_interval,
        interval,
      )) {
        // The command committed but its response was lost. The authoritative
        // refresh already published the requested target, so preserve the
        // pending viewport hand-off and report a recovered success.
        setError(null);
        return null;
      }
      setError(cause instanceof Error ? cause.message : "展示周期切换失败");
      throw cause;
    } finally {
      if (viewerCommandRef.current === command.command_id) {
        viewerCommandRef.current = null;
        setViewerPending(false);
      }
    }
  }, [buildCommand, failClosedAndRefreshMarketTracks, publishViewerState]);

  const cancelAdvance = useCallback(async (): Promise<ReplayV2CommandResult> => {
    const active = controlRef.current;
    if (!replayAdvanceIsCancelable(active)) {
      throw new Error("no cancelable advance is active");
    }
    if (active === null) throw new Error("no cancelable advance is active");
    const command = buildCommand(
      "cancel_advance",
      { advance_command_id: active.command_id },
      "cancel",
    );
    const result = await defaultReplayV2Api.commandRun(command.run_id, command);
    setProgress(progressFromResult(result));
    return result;
  }, [buildCommand]);

  const submitTrackCommand = useCallback(async (
    type: Extract<ReplayV2CommandType,
      "add_track" | "select_track" | "set_subscription_tier"
    >,
    payload: Readonly<Record<string, ReplayV2Json>>,
    prefix: string,
  ): Promise<ReplayV2CommandResult> => {
    if (controlRef.current !== null) throw new Error("another replay.v3 control is pending");
    if (viewerCommandRef.current !== null) {
      throw new Error("another replay.v3 viewer command is pending");
    }
    const command = buildCommand(type, payload, prefix);
    viewerCommandRef.current = command.command_id;
    setViewerPending(true);
    setError(null);
    try {
      const result = await defaultReplayV2Api.commandRun(command.run_id, command);
      publishViewerState(result.viewer_state);
      await refreshMarketTracks(command.run_id);
      return result;
    } catch (cause) {
      await failClosedAndRefreshMarketTracks(command.run_id);
      setError(cause instanceof Error ? cause.message : "MarketTrack 操作失败");
      throw cause;
    } finally {
      if (viewerCommandRef.current === command.command_id) {
        viewerCommandRef.current = null;
        setViewerPending(false);
      }
    }
  }, [buildCommand, failClosedAndRefreshMarketTracks, publishViewerState, refreshMarketTracks]);

  const selectTrack = useCallback(async (trackId: string): Promise<ReplayV2CommandResult> => {
    const viewer = viewerRef.current;
    if (viewer === null) throw new Error("ViewerState is unavailable");
    const result = await submitTrackCommand(
      "select_track",
      {
        track_id: trackId,
        expected_viewer_revision: viewer.semantic_view_revision,
      },
      "select-track",
    );
    if (runtime.store.sessionId !== result.session_id && typeof globalThis.location !== "undefined") {
      globalThis.location.assign(`/replay.html?run=${encodeURIComponent(result.run_id)}`);
    }
    return result;
  }, [runtime.store, submitTrackCommand]);

  const setSubscriptionTier = useCallback(async (
    trackId: string,
    tier: ReplayV2SubscriptionTier,
  ): Promise<ReplayV2CommandResult> => submitTrackCommand(
    "set_subscription_tier",
    { track_id: trackId, subscription_tier: tier },
    "track-tier",
  ), [submitTrackCommand]);

  const addAndSelectTrack = useCallback(async (identity: {
    readonly exchange: string;
    readonly marketType: string;
    readonly symbol: string;
    readonly settlementAsset: string;
  }): Promise<ReplayV2CommandResult> => {
    const viewer = viewerRef.current;
    if (viewer === null) throw new Error("ViewerState is unavailable");
    await submitTrackCommand(
      "add_track",
      {
        exchange: identity.exchange,
        market_type: identity.marketType,
        symbol: identity.symbol,
        settlement_asset: identity.settlementAsset,
        subscription_tier: "NONE",
      },
      "add-track",
    );
    const refreshed = await refreshMarketTracks(viewer.run_id);
    const track = refreshed?.tracks.find((candidate) => (
      candidate.exchange === identity.exchange
      && candidate.market_type === identity.marketType
      && candidate.symbol === identity.symbol
    ));
    if (track === undefined) throw new Error("created MarketTrack is missing from replay.v3");
    return selectTrack(track.track_id);
  }, [refreshMarketTracks, selectTrack, submitTrackCommand]);

  const submitTrade = useCallback(async (
    type: ReplayPhase5TradeType,
    payload: Readonly<Record<string, ReplayV2Json>>,
  ): Promise<ReplayV2CommandResult> => {
    if (controlRef.current !== null) throw new Error("another replay.v3 control is pending");
    if (viewerCommandRef.current !== null) {
      throw new Error("another replay.v3 viewer command is pending");
    }
    const command = buildCommand(type, payload, "trade");
    viewerCommandRef.current = command.command_id;
    setViewerPending(true);
    setError(null);
    try {
      const result = await defaultReplayV2Api.commandRun(command.run_id, command);
      publishViewerState(result.viewer_state);
      await refreshMarketTracks(command.run_id);
      return result;
    } catch (cause) {
      await failClosedAndRefreshMarketTracks(command.run_id);
      setError(cause instanceof Error ? cause.message : "组合纸面交易失败");
      throw cause;
    } finally {
      if (viewerCommandRef.current === command.command_id) {
        viewerCommandRef.current = null;
        setViewerPending(false);
      }
    }
  }, [buildCommand, failClosedAndRefreshMarketTracks, publishViewerState, refreshMarketTracks]);

  const previewOrder = useCallback(async (
    order: ReplayOrderRequest,
    positionIntent: "NET" | "OPEN",
    tradePlan: ReplayTradePlanDraft | null = null,
    signal?: AbortSignal,
  ): Promise<ReplayOrderPreview> => {
    const viewer = viewerRef.current;
    const store = runtime.store;
    if (viewer === null || store.virtualTimeMs === null || store.sessionId === null) {
      throw new Error("replay.v3 viewer is not preview-ready");
    }
    return defaultReplayV2Api.previewOrder(
      viewer.run_id,
      {
        protocol: "replay.v3",
        expected_revision: store.revision,
        expected_cursor: {
          virtual_time_ms: store.virtualTimeMs,
          source_sequence: store.sourceSequence,
          revision: store.revision,
        },
        position_intent: positionIntent,
        order,
        trade_plan: tradePlan,
      },
      signal,
    );
  }, [runtime.store]);

  const orderCapacity = useCallback(async (
    context: ReplayOrderCapacityContext,
    positionIntent: "NET" | "OPEN",
    signal?: AbortSignal,
  ): Promise<ReplayOrderCapacity> => {
    const viewer = viewerRef.current;
    const store = runtime.store;
    if (viewer === null || store.virtualTimeMs === null || store.sessionId === null) {
      throw new Error("replay.v3 viewer is not capacity-ready");
    }
    return defaultReplayV2Api.orderCapacity(
      viewer.run_id,
      {
        protocol: "replay.v3",
        expected_revision: store.revision,
        expected_cursor: {
          virtual_time_ms: store.virtualTimeMs,
          source_sequence: store.sourceSequence,
          revision: store.revision,
        },
        position_intent: positionIntent,
        context,
      },
      signal,
    );
  }, [runtime.store]);

  const resyncHistoricalBook = useCallback(async (): Promise<void> => {
    const runId = viewerRef.current?.run_id;
    if (runId === undefined) throw new Error("ViewerState is unavailable");
    if (controlRef.current !== null) throw new Error("another replay.v3 control is pending");
    setViewerPending(true);
    setError(null);
    try {
      await defaultReplayV2Api.resyncHistoricalBook(runId);
      await refreshMarketTracks(runId);
    } catch (cause) {
      await failClosedAndRefreshMarketTracks(runId);
      setError(cause instanceof Error ? cause.message : "历史盘口 resync 失败");
      throw cause;
    } finally {
      setViewerPending(false);
    }
  }, [failClosedAndRefreshMarketTracks, refreshMarketTracks]);

  const auditAccount = useCallback(async (): Promise<ReplayAccountAuditResponse> => {
    const runId = viewerRef.current?.run_id;
    if (runId === undefined) throw new Error("ViewerState is unavailable");
    if (controlRef.current !== null) throw new Error("another replay.v3 control is pending");
    setViewerPending(true);
    setError(null);
    try {
      const audit = await defaultReplayV2Api.auditAccount(runId);
      await refreshMarketTracks(runId);
      return audit;
    } catch (cause) {
      await failClosedAndRefreshMarketTracks(runId);
      setError(cause instanceof Error ? cause.message : "独立账户审计失败");
      throw cause;
    } finally {
      setViewerPending(false);
    }
  }, [failClosedAndRefreshMarketTracks, refreshMarketTracks]);

  const preparePeriodSummaries = useCallback(async (): Promise<void> => {
    const runId = viewerRef.current?.run_id;
    if (runId === undefined) throw new Error("ViewerState is unavailable");
    if (controlRef.current !== null || summaryPreparing) {
      throw new Error("another replay operation is pending");
    }
    setSummaryPreparing(true);
    setSummaryError(null);
    try {
      const prepared = await defaultReplayV2Api.preparePeriodSummariesRun(runId);
      setPeriodSummary({
        protocol: prepared.protocol,
        run_id: prepared.run_id,
        enabled: prepared.enabled,
        status: prepared.status,
      });
    } catch (cause) {
      setSummaryError(cause instanceof Error ? cause.message : "摘要准备失败");
      throw cause;
    } finally {
      setSummaryPreparing(false);
    }
  }, [summaryPreparing]);

  return {
    viewerState,
    marketTracks,
    seriesStore,
    loading,
    error,
    controlPending,
    viewerPending,
    progress,
    periodSummary,
    summaryPreparing,
    summaryError,
    actions: {
      setDisplayInterval,
      submitControl,
      cancelAdvance,
      selectTrack,
      setSubscriptionTier,
      addAndSelectTrack,
      submitTrade,
      previewOrder,
      orderCapacity,
      auditAccount,
      resyncHistoricalBook,
      preparePeriodSummaries,
      reload: () => setReloadRevision((value) => value + 1),
    },
  };
}
