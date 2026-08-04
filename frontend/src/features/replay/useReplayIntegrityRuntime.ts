import { useCallback, useEffect, useRef, useState } from "react";

import {
  SemanticViewActionSampler,
  type ReplayCurrentDrawingDocumentResponse,
  type ReplayEquityResponse,
  type ReplayIntegrityResponse,
  type ReplayReviewBudget,
  type ReplayReviewControlResponse,
  type ReplayReviewForkResponse,
  type ReplayReviewResponse,
  type ReplayRunRulesResponse,
  type ReplayTrainingReportResponse,
} from "./replayIntegrityModel.js";
import { replayEffectiveTrainingState } from "./replayUiModel.js";
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
  | "drawing"
  | "marker"
  | "review"
  | "review-control"
  | "fork"
  | null;

export interface ReplayIntegrityRuntime {
  readonly runId: string | null;
  readonly integrity: ReplayIntegrityResponse | null;
  readonly rules: ReplayRunRulesResponse | null;
  readonly equity: ReplayEquityResponse | null;
  readonly report: ReplayTrainingReportResponse | null;
  readonly currentDrawing: ReplayCurrentDrawingDocumentResponse | null;
  readonly drawingLoaded: boolean;
  readonly review: ReplayReviewResponse | null;
  readonly forked: ReplayReviewForkResponse | null;
  readonly budget: ReplayReviewBudget | null;
  readonly operation: ReplayIntegrityOperation;
  readonly error: string | null;
  readonly actions: {
    refresh(): Promise<void>;
    deposit(amount: string, reason: string): Promise<ReplayV2CommandResult>;
    withdraw(amount: string, reason: string): Promise<ReplayV2CommandResult>;
    revealTime(reason: string): Promise<ReplayV2CommandResult>;
    changeFeePolicy(
      makerFeeBps: string,
      takerFeeBps: string,
      reason: string,
    ): Promise<ReplayV2CommandResult>;
    changeLeverageCap(maxLeverage: string, reason: string): Promise<ReplayV2CommandResult>;
    changeFundingPolicy(
      fundingMode: "OFF" | "SANDBOX_FIXED",
      fixedFundingRate: string | null,
      fundingIntervalMs: number | null,
      reason: string,
    ): Promise<ReplayV2CommandResult>;
    recordDrawing(
      document: Readonly<Record<string, unknown>>,
      documentHash: `sha256:${string}`,
      entityCount: number,
    ): Promise<void>;
    addMarker(text: string): Promise<void>;
    offerViewAction(
      eventType: string,
      semanticKey: string,
      value: Readonly<Record<string, ReplayV2Json>>,
    ): void;
    startReview(eventId?: string | null): Promise<ReplayReviewResponse>;
    controlReview(
      action: "JUMP" | "PREVIOUS" | "NEXT" | "PLAY" | "PAUSE",
      options?: {
        readonly eventId?: string | null;
        readonly playbackRate?: "0.25" | "0.5" | "1" | "2" | "4" | "8" | null;
      },
    ): Promise<ReplayReviewControlResponse>;
    closeReview(): void;
    forkReview(eventId: string): Promise<ReplayReviewForkResponse>;
  };
}

function commandId(prefix: string): string {
  const random = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`.slice(0, 128);
}

function replayRunId(viewer: ReplayViewerRuntime): string | null {
  return viewer.viewerState?.run_id ?? viewer.marketTracks?.run_id ?? null;
}

export function useReplayIntegrityRuntime(
  runtime: ReplayRuntime,
  viewer: ReplayViewerRuntime,
): ReplayIntegrityRuntime {
  const [integrity, setIntegrity] = useState<ReplayIntegrityResponse | null>(null);
  const [rules, setRules] = useState<ReplayRunRulesResponse | null>(null);
  const [equity, setEquity] = useState<ReplayEquityResponse | null>(null);
  const [report, setReport] = useState<ReplayTrainingReportResponse | null>(null);
  const [currentDrawing, setCurrentDrawing] = useState<ReplayCurrentDrawingDocumentResponse | null>(null);
  const [drawingLoaded, setDrawingLoaded] = useState(false);
  const [review, setReview] = useState<ReplayReviewResponse | null>(null);
  const [forked, setForked] = useState<ReplayReviewForkResponse | null>(null);
  const [budget, setBudget] = useState<ReplayReviewBudget | null>(null);
  const [operation, setOperation] = useState<ReplayIntegrityOperation>(null);
  const [error, setError] = useState<string | null>(null);
  const sampler = useRef(new SemanticViewActionSampler());
  const viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const pendingPolicy = useRef(false);
  const pendingReviewControl = useRef(false);
  const runtimeRef = useRef(runtime);
  const viewerRef = useRef(viewer);
  runtimeRef.current = runtime;
  viewerRef.current = viewer;
  const runId = replayRunId(viewer);
  const globalClock = viewer.marketTracks?.global_clock ?? null;
  const effectiveState = replayEffectiveTrainingState(
    globalClock?.state,
    runtime.store.state,
    runtime.store.controllerClientId,
  );
  const clockIsAdvancing = effectiveState === "PLAYING"
    || effectiveState === "ADVANCING";

  const refresh = useCallback(async (): Promise<void> => {
    const currentRunId = replayRunId(viewerRef.current);
    if (currentRunId === null) return;
    const requestGeneration = ++generation.current;
    setOperation((current) => current ?? "refresh");
    try {
      const currentRuntime = runtimeRef.current;
      const currentViewer = viewerRef.current;
      const currentState = replayEffectiveTrainingState(
        currentViewer.marketTracks?.global_clock.state,
        currentRuntime.store.state,
        currentRuntime.store.controllerClientId,
      );
      const [
        nextIntegrity,
        nextRules,
        nextEquity,
        nextDrawing,
        nextReport,
      ] = await Promise.all([
        defaultReplayV2Api.integrityRun(currentRunId),
        defaultReplayV2Api.rulesRun(currentRunId),
        defaultReplayV2Api.equityRun(currentRunId, "AUTO", 1_000),
        defaultReplayV2Api.currentDrawingRun(currentRunId),
        currentState === "ENDED"
          ? defaultReplayV2Api.reportRun(currentRunId)
          : Promise.resolve(null),
      ]);
      if (requestGeneration !== generation.current
        || replayRunId(viewerRef.current) !== currentRunId) return;
      setIntegrity(nextIntegrity);
      setRules(nextRules);
      setEquity(nextEquity);
      setCurrentDrawing((current) => (
        current?.run_id === nextDrawing.run_id
        && current.document_hash === nextDrawing.document_hash
        && current.revision === nextDrawing.revision
          ? current
          : nextDrawing
      ));
      setDrawingLoaded(true);
      setBudget(nextDrawing.budget);
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
    setRules(null);
    setEquity(null);
    setReport(null);
    setCurrentDrawing(null);
    setDrawingLoaded(false);
    setReview(null);
    setForked(null);
    setBudget(null);
    setError(null);
    if (runId !== null) void refresh();
  }, [refresh, runId]);

  useEffect(() => {
    if (runId === null || !clockIsAdvancing) return;
    const timer = setInterval(() => { void refresh(); }, 750);
    return () => clearInterval(timer);
  }, [clockIsAdvancing, refresh, runId]);

  useEffect(() => {
    if (runId === null || clockIsAdvancing) return;
    const timer = setTimeout(() => { void refresh(); }, 50);
    return () => clearTimeout(timer);
  }, [
    clockIsAdvancing,
    effectiveState,
    globalClock?.generation,
    globalClock?.tick,
    refresh,
    runId,
    runtime.store.revision,
  ]);

  useEffect(() => {
    if (runId === null || effectiveState !== "ENDED" || report !== null) return;
    // The terminal adapter snapshot and immutable v2 report commit are
    // separate projections of one command. Retry while the report is absent;
    // a transient read cannot strand an already-ended training page forever.
    const timer = setInterval(() => { void refresh(); }, 1_000);
    return () => clearInterval(timer);
  }, [effectiveState, refresh, report, runId]);

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
    type: Extract<ReplayV2CommandType,
      | "deposit"
      | "withdraw"
      | "reveal_time"
      | "change_fee_policy"
      | "change_leverage_cap"
      | "change_funding_policy"
    >,
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

  const recordDrawing = useCallback(async (
    document: Readonly<Record<string, unknown>>,
    documentHash: `sha256:${string}`,
    entityCount: number,
  ): Promise<void> => {
    const currentRunId = replayRunId(viewerRef.current);
    if (currentRunId === null) throw new Error("replay.v2 run is unavailable");
    setOperation("drawing");
    setError(null);
    try {
      const response = await defaultReplayV2Api.recordDrawingRun(currentRunId, {
        command_id: commandId("drawing"),
        document_hash: documentHash,
        document,
        entity_count: entityCount,
      });
      const hydrated = await defaultReplayV2Api.currentDrawingRun(currentRunId);
      if (hydrated.document_hash !== response.document_hash
        || hydrated.revision !== response.revision) {
        throw new Error("drawing evidence hydration drifted after commit");
      }
      setCurrentDrawing((current) => (
        current?.run_id === hydrated.run_id
        && current.document_hash === hydrated.document_hash
        && current.revision === hydrated.revision
          ? current
          : hydrated
      ));
      setDrawingLoaded(true);
      setBudget(hydrated.budget);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "绘图复盘证据提交失败");
      throw cause;
    } finally {
      setOperation((current) => current === "drawing" ? null : current);
    }
  }, []);

  const addMarker = useCallback(async (text: string): Promise<void> => {
    const currentRunId = replayRunId(viewerRef.current);
    if (currentRunId === null) throw new Error("replay.v2 run is unavailable");
    setOperation("marker");
    setError(null);
    try {
      const response = await defaultReplayV2Api.recordMarkerRun(
        currentRunId,
        text,
        commandId("marker"),
      );
      setBudget(response.budget);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "复盘标记提交失败");
      throw cause;
    } finally {
      setOperation((current) => current === "marker" ? null : current);
    }
  }, []);

  const startReview = useCallback(async (eventId: string | null = null): Promise<ReplayReviewResponse> => {
    const currentRunId = replayRunId(viewerRef.current);
    if (currentRunId === null) throw new Error("replay.v2 run is unavailable");
    setOperation("review");
    setError(null);
    try {
      const response = await defaultReplayV2Api.reviewRun(currentRunId, eventId);
      setReview(response);
      setRules(response.projection.rules);
      setBudget(response.budget);
      return response;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "只读 Review 加载失败");
      throw cause;
    } finally {
      setOperation((current) => current === "review" ? null : current);
    }
  }, []);

  const controlReview = useCallback(async (
    action: "JUMP" | "PREVIOUS" | "NEXT" | "PLAY" | "PAUSE",
    options: {
      readonly eventId?: string | null;
      readonly playbackRate?: "0.25" | "0.5" | "1" | "2" | "4" | "8" | null;
    } = {},
  ): Promise<ReplayReviewControlResponse> => {
    const current = review;
    const currentRunId = replayRunId(viewerRef.current);
    if (currentRunId === null || current === null) {
      throw new Error("ReviewMode is not active");
    }
    if (pendingReviewControl.current) throw new Error("another Review control is pending");
    pendingReviewControl.current = true;
    setOperation("review-control");
    setError(null);
    try {
      const response = await defaultReplayV2Api.controlReviewRun(
        currentRunId,
        current.review_id,
        {
          action,
          event_id: options.eventId ?? null,
          expected_cursor_revision: current.cursor_revision,
          playback_rate: options.playbackRate ?? null,
        },
      );
      if (response.review_id !== current.review_id
        || response.original_state_hash !== current.original_state_hash) {
        throw new Error("Review cursor response drifted from its immutable session");
      }
      setReview({
        ...current,
        selected_event_id: response.selected_event_id,
        selected_timeline_sequence: response.selected_timeline_sequence,
        selected_state_hash: response.selected_state_hash,
        cursor_revision: response.cursor_revision,
        playback_state: response.playback_state,
        playback_rate: response.playback_rate,
        projection: response.projection,
        drawing_document: response.drawing_document,
        immutability_proof: response.immutability_proof,
        budget: response.budget,
      });
      setRules(response.projection.rules);
      setBudget(response.budget);
      return response;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Review 游标控制失败");
      throw cause;
    } finally {
      pendingReviewControl.current = false;
      setOperation((currentOperation) => (
        currentOperation === "review-control" ? null : currentOperation
      ));
    }
  }, [review]);

  useEffect(() => {
    if (review?.playback_state !== "PLAYING") return;
    const rate = Number(review.playback_rate);
    const timer = setTimeout(() => {
      void controlReview("NEXT").catch(() => undefined);
    }, Math.max(60, Math.round(1_000 / rate)));
    return () => clearTimeout(timer);
  }, [
    controlReview,
    review?.cursor_revision,
    review?.playback_rate,
    review?.playback_state,
    review?.selected_timeline_sequence,
  ]);

  const closeReview = useCallback(() => {
    setReview(null);
    setForked(null);
    void refresh();
  }, [refresh]);

  const forkReview = useCallback(async (eventId: string): Promise<ReplayReviewForkResponse> => {
    const currentRunId = replayRunId(viewerRef.current);
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
    rules,
    equity,
    report,
    currentDrawing,
    drawingLoaded,
    review,
    forked,
    budget,
    operation,
    error,
    actions: {
      refresh,
      deposit: (amount, reason) => submitPolicy("deposit", { amount, reason }),
      withdraw: (amount, reason) => submitPolicy("withdraw", { amount, reason }),
      revealTime: (reason) => submitPolicy("reveal_time", { reason }),
      changeFeePolicy: (makerFeeBps, takerFeeBps, reason) => (
        submitPolicy("change_fee_policy", {
          maker_fee_bps: makerFeeBps,
          taker_fee_bps: takerFeeBps,
          reason,
        })
      ),
      changeLeverageCap: (maxLeverage, reason) => (
        submitPolicy("change_leverage_cap", { max_leverage: maxLeverage, reason })
      ),
      changeFundingPolicy: (
        fundingMode,
        fixedFundingRate,
        fundingIntervalMs,
        reason,
      ) => submitPolicy("change_funding_policy", {
        funding_mode: fundingMode,
        fixed_funding_rate: fixedFundingRate,
        funding_interval_ms: fundingIntervalMs,
        reason,
      }),
      recordDrawing,
      addMarker,
      offerViewAction,
      startReview,
      controlReview,
      closeReview,
      forkReview,
    },
  };
}
