import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import type {
  ReplayV2Command,
  ReplayV2CommandResult,
  ReplayV2CommandType,
  ReplayV2Json,
  ReplayViewerState,
} from "./replayV2Types.js";
import { defaultReplayV2Api } from "./replayV2Api.js";
import { rebuildReplayViewerSeries } from "./replayViewerProjection.js";
import type { ReplayRuntime } from "./useReplayRuntime.js";


export type ReplayPhase3ControlType = Extract<ReplayV2CommandType,
  | "step_event"
  | "step_base"
  | "step_display"
  | "advance_by"
  | "advance_to"
>;

export interface ReplayViewerRuntime {
  readonly viewerState: ReplayViewerState | null;
  readonly seriesStore: SeriesWindowStore;
  readonly loading: boolean;
  readonly error: string | null;
  readonly controlPending: ReplayV2Command | null;
  readonly viewerPending: boolean;
  readonly progress: Readonly<Record<string, ReplayV2Json>> | null;
  readonly actions: {
    setDisplayInterval(interval: string): Promise<ReplayV2CommandResult>;
    submitControl(
      type: ReplayPhase3ControlType,
      payload: Readonly<Record<string, ReplayV2Json>>,
    ): Promise<ReplayV2CommandResult>;
    cancelAdvance(): Promise<ReplayV2CommandResult>;
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [controlPending, setControlPending] = useState<ReplayV2Command | null>(null);
  const [viewerPending, setViewerPending] = useState(false);
  const [progress, setProgress] = useState<Readonly<Record<string, ReplayV2Json>> | null>(null);
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
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    void defaultReplayV2Api.viewerBySession(sessionId, abort.signal).then((response) => {
      setViewerState(response.viewer_state);
    }).catch((cause: unknown) => {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "ViewerState 加载失败");
    }).finally(() => {
      if (!abort.signal.aborted) setLoading(false);
    });
    return () => abort.abort();
  }, [reloadRevision, sessionId]);

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
    if (active === null || (active.type !== "advance_by" && active.type !== "advance_to")) return;
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
    const boundPayload = type === "step_display"
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
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "回放控制失败");
      throw cause;
    } finally {
      setControlPending((current) => current?.command_id === command.command_id ? null : current);
    }
  }, [buildCommand]);

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
      setError(cause instanceof Error ? cause.message : "展示周期切换失败");
      throw cause;
    } finally {
      setViewerPending(false);
    }
  }, [buildCommand]);

  const cancelAdvance = useCallback(async (): Promise<ReplayV2CommandResult> => {
    const active = controlRef.current;
    if (active === null || (active.type !== "advance_by" && active.type !== "advance_to")) {
      throw new Error("no cancelable advance is active");
    }
    const command = buildCommand(
      "cancel_advance",
      { advance_command_id: active.command_id },
      "cancel",
    );
    const result = await defaultReplayV2Api.commandRun(command.run_id, command);
    setProgress(progressFromResult(result));
    return result;
  }, [buildCommand]);

  return {
    viewerState,
    seriesStore,
    loading,
    error,
    controlPending,
    viewerPending,
    progress,
    actions: {
      setDisplayInterval,
      submitControl,
      cancelAdvance,
      reload: () => setReloadRevision((value) => value + 1),
    },
  };
}
