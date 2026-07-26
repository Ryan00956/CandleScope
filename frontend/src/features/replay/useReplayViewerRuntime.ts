import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import type {
  ReplayAccountAuditResponse,
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
import { rebuildReplayViewerSeries } from "./replayViewerProjection.js";
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
  | "cancel_order"
  | "close_position"
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
    setDisplayInterval(interval: string): Promise<ReplayV2CommandResult>;
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
  const sourceStore = runtime.replayStore.seriesStore;
  const seriesStore = useMemo(() => new SeriesWindowStore(), []);
  const sessionId = runtime.store.sessionId;
  const config = runtime.store.sessionConfig;

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
      setViewerState(authoritative);
      setMarketTracks(tracksResponse);
    }).catch((cause: unknown) => {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "ViewerState 加载失败");
    }).finally(() => {
      if (!abort.signal.aborted) setLoading(false);
    });
    return () => abort.abort();
  }, [reloadRevision, sessionId]);

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
    const response = await defaultReplayV2Api.tracksRun(runId);
    setMarketTracks(response);
    setViewerState((current) => current === null
      || response.viewer_state.semantic_view_revision >= current.semantic_view_revision
      ? response.viewer_state
      : current);
    return response;
  }, []);

  const failClosedAndRefreshMarketTracks = useCallback(async (
    runId: string,
  ): Promise<void> => {
    // A rejected command may already have paused the Run and cleared a
    // continuity-gated projection server-side. Remove every local track
    // projection before attempting the authoritative refresh so a second
    // network failure cannot leave stale L2 or fills visible.
    setMarketTracks(null);
    try {
      await refreshMarketTracks(runId);
    } catch {
      // The original command error remains the user-facing failure. Keeping
      // marketTracks null is the deliberate fail-closed state.
    }
  }, [refreshMarketTracks]);

  useEffect(() => {
    if (marketTracks?.global_clock.state !== "PLAYING") return;
    const timer = setInterval(() => {
      void refreshMarketTracks(marketTracks.run_id).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "全局时钟状态刷新失败");
      });
    }, 250);
    return () => clearInterval(timer);
  }, [marketTracks?.global_clock.state, marketTracks?.run_id, refreshMarketTracks]);

  useEffect(() => {
    const rebuild = () => {
      if (config === null || viewerState === null) {
        seriesStore.clear({ source: "replay-viewer-unavailable" });
        return;
      }
      try {
        rebuildReplayViewerSeries(
          seriesStore,
          sourceStore,
          config.base_interval,
          viewerState.display_interval,
        );
        setError(null);
      } catch (cause) {
        seriesStore.clear({ source: "replay-viewer-error" });
        setError(cause instanceof Error ? cause.message : "展示周期重建失败");
      }
    };
    rebuild();
    const unsubscribe = sourceStore.subscribe(rebuild);
    return () => { unsubscribe(); };
  }, [config, seriesStore, sourceStore, viewerState]);

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
      throw new Error("replay.v2 viewer is not command-ready");
    }
    return {
      protocol: "replay.v2",
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
    if (controlRef.current !== null) throw new Error("another replay.v2 control is pending");
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
      setViewerState((current) => current === null
        || result.viewer_state.semantic_view_revision >= current.semantic_view_revision
        ? result.viewer_state
        : current);
      setProgress(progressFromResult(result));
      await refreshMarketTracks(command.run_id);
      return result;
    } catch (cause) {
      await failClosedAndRefreshMarketTracks(command.run_id);
      setError(cause instanceof Error ? cause.message : "回放控制失败");
      throw cause;
    } finally {
      setControlPending((current) => current?.command_id === command.command_id ? null : current);
    }
  }, [buildCommand, failClosedAndRefreshMarketTracks, refreshMarketTracks]);

  const setDisplayInterval = useCallback(async (interval: string): Promise<ReplayV2CommandResult> => {
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
    setViewerPending(true);
    setError(null);
    try {
      const result = await defaultReplayV2Api.commandRun(command.run_id, command);
      setViewerState((current) => current === null
        || result.viewer_state.semantic_view_revision >= current.semantic_view_revision
        ? result.viewer_state
        : current);
      return result;
    } catch (cause) {
      await failClosedAndRefreshMarketTracks(command.run_id);
      setError(cause instanceof Error ? cause.message : "展示周期切换失败");
      throw cause;
    } finally {
      setViewerPending(false);
    }
  }, [buildCommand, failClosedAndRefreshMarketTracks]);

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
    if (controlRef.current !== null) throw new Error("another replay.v2 control is pending");
    const command = buildCommand(type, payload, prefix);
    setViewerPending(true);
    setError(null);
    try {
      const result = await defaultReplayV2Api.commandRun(command.run_id, command);
      setViewerState((current) => current === null
        || result.viewer_state.semantic_view_revision >= current.semantic_view_revision
        ? result.viewer_state
        : current);
      await refreshMarketTracks(command.run_id);
      return result;
    } catch (cause) {
      await failClosedAndRefreshMarketTracks(command.run_id);
      setError(cause instanceof Error ? cause.message : "MarketTrack 操作失败");
      throw cause;
    } finally {
      setViewerPending(false);
    }
  }, [buildCommand, failClosedAndRefreshMarketTracks, refreshMarketTracks]);

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
      globalThis.location.assign(`/replay.html?session=${encodeURIComponent(result.session_id)}`);
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
    if (track === undefined) throw new Error("created MarketTrack is missing from replay.v2");
    return selectTrack(track.track_id);
  }, [refreshMarketTracks, selectTrack, submitTrackCommand]);

  const submitTrade = useCallback(async (
    type: ReplayPhase5TradeType,
    payload: Readonly<Record<string, ReplayV2Json>>,
  ): Promise<ReplayV2CommandResult> => {
    if (controlRef.current !== null) throw new Error("another replay.v2 control is pending");
    const command = buildCommand(type, payload, "trade");
    setViewerPending(true);
    setError(null);
    try {
      const result = await defaultReplayV2Api.commandRun(command.run_id, command);
      setViewerState((current) => current === null
        || result.viewer_state.semantic_view_revision >= current.semantic_view_revision
        ? result.viewer_state
        : current);
      await refreshMarketTracks(command.run_id);
      return result;
    } catch (cause) {
      await failClosedAndRefreshMarketTracks(command.run_id);
      setError(cause instanceof Error ? cause.message : "组合纸面交易失败");
      throw cause;
    } finally {
      setViewerPending(false);
    }
  }, [buildCommand, failClosedAndRefreshMarketTracks, refreshMarketTracks]);

  const resyncHistoricalBook = useCallback(async (): Promise<void> => {
    const runId = viewerRef.current?.run_id;
    if (runId === undefined) throw new Error("ViewerState is unavailable");
    if (controlRef.current !== null) throw new Error("another replay.v2 control is pending");
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
    if (controlRef.current !== null) throw new Error("another replay.v2 control is pending");
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
      auditAccount,
      resyncHistoricalBook,
      preparePeriodSummaries,
      reload: () => setReloadRevision((value) => value + 1),
    },
  };
}
