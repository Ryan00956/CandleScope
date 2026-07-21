import { useCallback, useEffect, useRef, useState } from "react";

import {
  SemanticViewActionSampler,
  type ReplayEquityResponse,
  type ReplayIntegrityResponse,
  type ReplayReviewForkResponse,
  type ReplayReviewResponse,
  type ReplayTrainingReportResponse,
} from "./replayIntegrityModel.js";
import { defaultReplayV2Api } from "./replayV2Api.js";
import type {
  ReplayV2Command,
  ReplayV2CommandResult,
  ReplayV2CommandType,
  ReplayV2Json,
} from "./replayV2Types.js";
import type { ReplayRuntime } from "./useReplayRuntime.js";
import type { ReplayViewerRuntime } from "./useReplayViewerRuntime.js";

export type ReplayIntegrityOperation =
  | "refresh"
  | "policy"
  | "review"
  | "fork"
  | null;

export interface ReplayIntegrityRuntime {
  readonly runId: string | null;
  readonly integrity: ReplayIntegrityResponse | null;
  readonly equity: ReplayEquityResponse | null;
  readonly report: ReplayTrainingReportResponse | null;
  readonly review: ReplayReviewResponse | null;
  readonly forked: ReplayReviewForkResponse | null;
  readonly operation: ReplayIntegrityOperation;
  readonly error: string | null;
  readonly actions: {
    refresh(): Promise<void>;
    deposit(amount: string, reason: string): Promise<ReplayV2CommandResult>;
    withdraw(amount: string, reason: string): Promise<ReplayV2CommandResult>;
    revealTime(reason: string): Promise<ReplayV2CommandResult>;
    offerViewAction(
      eventType: string,
      semanticKey: string,
      value: Readonly<Record<string, ReplayV2Json>>,
    ): void;
    startReview(eventId?: string | null): Promise<ReplayReviewResponse>;
    forkReview(eventId: string): Promise<ReplayReviewForkResponse>;
  };
}

function commandId(prefix: string): string {
  const random = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`.slice(0, 128);
}

export function useReplayIntegrityRuntime(
  runtime: ReplayRuntime,
  viewer: ReplayViewerRuntime,
): ReplayIntegrityRuntime {
  const [integrity, setIntegrity] = useState<ReplayIntegrityResponse | null>(null);
  const [equity, setEquity] = useState<ReplayEquityResponse | null>(null);
  const [report, setReport] = useState<ReplayTrainingReportResponse | null>(null);
  const [review, setReview] = useState<ReplayReviewResponse | null>(null);
  const [forked, setForked] = useState<ReplayReviewForkResponse | null>(null);
  const [operation, setOperation] = useState<ReplayIntegrityOperation>(null);
  const [error, setError] = useState<string | null>(null);
  const sampler = useRef(new SemanticViewActionSampler());
  const viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const pendingPolicy = useRef(false);
  const runtimeRef = useRef(runtime);
  const viewerRef = useRef(viewer);
  runtimeRef.current = runtime;
  viewerRef.current = viewer;
  const runId = viewer.viewerState?.run_id ?? null;

  const refresh = useCallback(async (): Promise<void> => {
    const currentRunId = viewerRef.current.viewerState?.run_id ?? null;
    if (currentRunId === null) return;
    const requestGeneration = ++generation.current;
    setOperation((current) => current ?? "refresh");
    try {
      const currentState = runtimeRef.current.store.state;
      const [nextIntegrity, nextEquity, nextReport] = await Promise.all([
        defaultReplayV2Api.integrityRun(currentRunId),
        defaultReplayV2Api.equityRun(currentRunId, "AUTO", 1_000),
        currentState === "ENDED"
          ? defaultReplayV2Api.reportRun(currentRunId)
          : Promise.resolve(null),
      ]);
      if (requestGeneration !== generation.current
        || viewerRef.current.viewerState?.run_id !== currentRunId) return;
      setIntegrity(nextIntegrity);
      setEquity(nextEquity);
      setReport(nextReport);
      setError(null);
    } catch (cause) {
      if (requestGeneration !== generation.current) return;
      setError(cause instanceof Error ? cause.message : "训练完整性数据加载失败");
    } finally {
      if (requestGeneration === generation.current) {
        setOperation((current) => current === "refresh" ? null : current);
      }
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    setIntegrity(null);
    setEquity(null);
    setReport(null);
    setReview(null);
    setForked(null);
    setError(null);
    if (runId !== null) void refresh();
  }, [refresh, runId]);

  useEffect(() => {
    if (runId === null || runtime.store.state !== "PLAYING") return;
    const timer = setInterval(() => { void refresh(); }, 750);
    return () => clearInterval(timer);
  }, [refresh, runId, runtime.store.state]);

  useEffect(() => {
    if (runId === null || runtime.store.state === "PLAYING") return;
    const timer = setTimeout(() => { void refresh(); }, 50);
    return () => clearTimeout(timer);
  }, [refresh, runId, runtime.store.revision, runtime.store.state]);

  const buildCommand = useCallback((
    type: ReplayV2CommandType,
    payload: Readonly<Record<string, ReplayV2Json>>,
    prefix: string,
  ): ReplayV2Command => {
    const currentRuntime = runtimeRef.current;
    const currentViewer = viewerRef.current.viewerState;
    const virtualTimeMs = currentRuntime.store.virtualTimeMs;
    if (currentViewer === null || virtualTimeMs === null) {
      throw new Error("replay.v2 integrity runtime is not command-ready");
    }
    return {
      protocol: "replay.v2",
      run_id: currentViewer.run_id,
      command_id: commandId(prefix),
      client_instance_id: currentRuntime.clientInstanceId,
      expected_revision: currentRuntime.store.revision,
      expected_cursor: {
        virtual_time_ms: virtualTimeMs,
        source_sequence: currentRuntime.store.sourceSequence,
        revision: currentRuntime.store.revision,
      },
      type,
      payload,
    };
  }, []);

  const submitPolicy = useCallback(async (
    type: Extract<ReplayV2CommandType, "deposit" | "withdraw" | "reveal_time">,
    payload: Readonly<Record<string, ReplayV2Json>>,
  ): Promise<ReplayV2CommandResult> => {
    if (pendingPolicy.current) throw new Error("another integrity policy command is pending");
    const command = buildCommand(type, payload, "integrity");
    pendingPolicy.current = true;
    setOperation("policy");
    setError(null);
    try {
      const result = await defaultReplayV2Api.commandRun(command.run_id, command);
      await refresh();
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "完整性策略命令失败");
      throw cause;
    } finally {
      pendingPolicy.current = false;
      setOperation((current) => current === "policy" ? null : current);
    }
  }, [buildCommand, refresh]);

  const flushViewActions = useCallback(async () => {
    viewTimer.current = null;
    const actions = sampler.current.flush();
    for (const action of actions) {
      try {
        const command = buildCommand("record_view_action", {
          event_type: action.event_type,
          semantic_key: action.semantic_key,
          value: action.value,
        }, "view");
        await defaultReplayV2Api.commandRun(command.run_id, command);
      } catch {
        // View telemetry is outside the domain hash. A cursor race drops this
        // sample instead of interfering with replay controls.
      }
    }
  }, [buildCommand]);

  useEffect(() => () => {
    generation.current += 1;
    if (viewTimer.current !== null) clearTimeout(viewTimer.current);
  }, []);

  const offerViewAction = useCallback((
    eventType: string,
    semanticKey: string,
    value: Readonly<Record<string, ReplayV2Json>>,
  ) => {
    sampler.current.offer(eventType, semanticKey, value);
    if (viewTimer.current !== null) return;
    viewTimer.current = setTimeout(() => { void flushViewActions(); }, 500);
  }, [flushViewActions]);

  const startReview = useCallback(async (eventId: string | null = null): Promise<ReplayReviewResponse> => {
    const currentRunId = viewerRef.current.viewerState?.run_id ?? null;
    if (currentRunId === null) throw new Error("replay.v2 run is unavailable");
    setOperation("review");
    setError(null);
    try {
      const response = await defaultReplayV2Api.reviewRun(currentRunId, eventId);
      setReview(response);
      return response;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "只读 Review 加载失败");
      throw cause;
    } finally {
      setOperation((current) => current === "review" ? null : current);
    }
  }, []);

  const forkReview = useCallback(async (eventId: string): Promise<ReplayReviewForkResponse> => {
    const currentRunId = viewerRef.current.viewerState?.run_id ?? null;
    if (currentRunId === null) throw new Error("replay.v2 run is unavailable");
    setOperation("fork");
    setError(null);
    try {
      const response = await defaultReplayV2Api.forkRun(currentRunId, eventId);
      setForked(response);
      return response;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Review checkpoint Fork 失败");
      throw cause;
    } finally {
      setOperation((current) => current === "fork" ? null : current);
    }
  }, []);

  return {
    runId,
    integrity,
    equity,
    report,
    review,
    forked,
    operation,
    error,
    actions: {
      refresh,
      deposit: (amount, reason) => submitPolicy("deposit", { amount, reason }),
      withdraw: (amount, reason) => submitPolicy("withdraw", { amount, reason }),
      revealTime: (reason) => submitPolicy("reveal_time", { reason }),
      offerViewAction,
      startReview,
      forkReview,
    },
  };
}
