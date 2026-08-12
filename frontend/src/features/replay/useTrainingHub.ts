import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ReplayApiError } from "./replayApi.js";
import type { ReplayCapabilities, ReplayCatalog } from "./replayTypes.js";
import type { ReplaySegmentPreparePlan } from "./replaySegmentTypes.js";
import type {
  ReplayStorageGcPlan,
  ReplayStorageGcProtocol,
  ReplayStorageGcRunResult,
  ReplayStorageInventory,
} from "./replayStorageModel.js";
import { defaultReplayV2Api, ReplayV2ApiError } from "./replayV2Api.js";
import type { TrainingRunListQuery } from "./replayV2Api.js";
import { clearReplayIndicatorPreferences } from "./replayIndicatorPreferences.js";
import { clearReplaySharedIndicatorPreferences } from "./replaySharedIndicatorPreferences.js";
import { clearReplayWorkspacePreferences } from "./replayWorkspacePreferences.js";
import {
  buildTrainingRunCreateRequest,
  createTrainingRunDraft,
  evaluateTrainingRunSetupDraft,
} from "./trainingHubModel.js";
import type { TrainingRunDraft, TrainingRunDraftEvaluation } from "./trainingHubModel.js";
import type {
  ReplayLaunchContext,
  ReplayV2RunState,
  ReplayV2SourceKind,
  TrainingRunCard,
  TrainingRunCompatibility,
  TrainingRunCreatePayload,
  TrainingRunPreparationPayload,
  TrainingRunDeleteResponse,
  TrainingRunListResponse,
  TrainingRunMutationResponse,
} from "./replayV2Types.js";

export type TrainingHubPhase = "IDLE" | "LOADING" | "READY" | "ERROR" | "STOPPED";
export type TrainingHubOperation =
  | "list"
  | "create-context"
  | "plan"
  | "create"
  | "delete"
  | "storage-list"
  | "storage-plan"
  | "storage-run"
  | "storage-rehydrate"
  | null;

export interface TrainingHubFilters {
  readonly state: ReplayV2RunState | null;
  readonly sourceKind: ReplayV2SourceKind | null;
  readonly compatibility: TrainingRunCompatibility | null;
}

export interface TrainingHubError {
  readonly code: string;
  readonly message: string;
}

export interface TrainingHubSnapshot {
  readonly phase: TrainingHubPhase;
  readonly items: readonly TrainingRunCard[];
  readonly nextCursor: string | null;
  readonly filters: TrainingHubFilters;
  readonly operation: TrainingHubOperation;
  readonly error: TrainingHubError | null;
  readonly createOpen: boolean;
  readonly capabilities: ReplayCapabilities | null;
  readonly catalog: ReplayCatalog | null;
  readonly draft: TrainingRunDraft | null;
  readonly evaluation: TrainingRunDraftEvaluation | null;
  readonly segmentPlan: ReplaySegmentPreparePlan | null;
  readonly storageOpen: boolean;
  readonly storageInventory: ReplayStorageInventory | null;
  readonly storagePlan: ReplayStorageGcPlan | null;
  readonly storagePlanConfirmed: boolean;
  readonly storageResult: ReplayStorageGcRunResult | null;
}

export interface TrainingHubApiBoundary {
  listRuns(query?: TrainingRunListQuery, signal?: AbortSignal): Promise<TrainingRunListResponse>;
  capabilities(signal?: AbortSignal): Promise<ReplayCapabilities>;
  catalog(
    query?: {
      warmupBars?: number;
      horizonMs?: number;
      qualityMode?: "exact" | "best_effort";
      blindMode?: boolean;
      sourceKind?: ReplayV2SourceKind;
    },
    signal?: AbortSignal,
  ): Promise<ReplayCatalog>;
  createRun(payload: TrainingRunCreatePayload, signal?: AbortSignal): Promise<TrainingRunMutationResponse>;
  deleteRun?(
    runId: string,
    signal?: AbortSignal,
  ): Promise<TrainingRunDeleteResponse>;
  segmentPlan?(
    payload: TrainingRunPreparationPayload,
    signal?: AbortSignal,
  ): Promise<ReplaySegmentPreparePlan>;
  storageInventory?(signal?: AbortSignal): Promise<ReplayStorageInventory>;
  storageGcPlan?(
    protocol: ReplayStorageGcProtocol,
    request: {
      readonly targetReclaimBytes: number;
      readonly maxObjects: number;
    },
    signal?: AbortSignal,
  ): Promise<ReplayStorageGcPlan>;
  storageGcRun?(
    plan: ReplayStorageGcPlan,
    signal?: AbortSignal,
  ): Promise<ReplayStorageGcRunResult>;
  storageRehydrate?(
    protocol: ReplayStorageGcProtocol,
    objectId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly object_id: string; readonly health: "READY" }>;
}

export interface TrainingHubLifecycleOptions {
  readonly api?: TrainingHubApiBoundary;
  readonly navigateToRun?: (runId: string) => void;
  readonly launchContext?: ReplayLaunchContext;
  readonly clearDeletedRunState?: (
    runId: string,
    sessionIds: readonly string[],
  ) => void;
}

type Listener = () => void;

function hubError(error: unknown): TrainingHubError {
  if (error instanceof ReplayV2ApiError || error instanceof ReplayApiError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) return { code: "TRAINING_HUB_ERROR", message: error.message };
  return { code: "TRAINING_HUB_ERROR", message: "Unknown Training Hub failure" };
}

export function clearDeletedTrainingRunClientState(
  runId: string,
  sessionIds: readonly string[],
): void {
  clearReplayWorkspacePreferences(sessionIds);
  clearReplayIndicatorPreferences(sessionIds);
  clearReplaySharedIndicatorPreferences([
    runId,
    ...sessionIds.map((sessionId) => `session:${sessionId}`),
  ]);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function defaultNavigateToRun(runId: string): void {
  if (typeof window === "undefined") return;
  window.location.assign(`/replay.html?run=${encodeURIComponent(runId)}`);
}

export class TrainingHubLifecycle {
  private readonly api: TrainingHubApiBoundary;
  private readonly navigateToRun: (runId: string) => void;
  private readonly launchContext: ReplayLaunchContext | undefined;
  private readonly clearDeletedRunState: (
    runId: string,
    sessionIds: readonly string[],
  ) => void;
  private readonly listeners = new Set<Listener>();
  private phase: TrainingHubPhase = "IDLE";
  private items: readonly TrainingRunCard[] = [];
  private nextCursor: string | null = null;
  private filters: TrainingHubFilters = { state: null, sourceKind: null, compatibility: null };
  private operation: TrainingHubOperation = null;
  private error: TrainingHubError | null = null;
  private createOpen = false;
  private capabilities: ReplayCapabilities | null = null;
  private catalog: ReplayCatalog | null = null;
  private draft: TrainingRunDraft | null = null;
  private evaluation: TrainingRunDraftEvaluation | null = null;
  private segmentPlan: ReplaySegmentPreparePlan | null = null;
  private storageOpen = false;
  private storageInventory: ReplayStorageInventory | null = null;
  private storagePlan: ReplayStorageGcPlan | null = null;
  private storagePlanConfirmed = false;
  private storageResult: ReplayStorageGcRunResult | null = null;
  private abortController = new AbortController();
  private storageAbortController = new AbortController();
  private requestToken = 0;
  private started = false;
  private disposed = false;
  private snapshot: TrainingHubSnapshot;

  constructor({
    api = defaultReplayV2Api,
    navigateToRun = defaultNavigateToRun,
    launchContext,
    clearDeletedRunState = clearDeletedTrainingRunClientState,
  }: TrainingHubLifecycleOptions = {}) {
    this.api = api;
    this.navigateToRun = navigateToRun;
    this.launchContext = launchContext;
    this.clearDeletedRunState = clearDeletedRunState;
    this.snapshot = this.buildSnapshot();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TrainingHubSnapshot => this.snapshot;

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    void this.loadRuns(false, null);
  }

  refresh(): void {
    if (this.disposed) return;
    void this.loadRuns(false, null);
  }

  loadNext(): void {
    if (this.disposed || this.nextCursor === null || this.operation !== null) return;
    void this.loadRuns(true, this.nextCursor);
  }

  setFilters(filters: TrainingHubFilters): void {
    if (this.disposed) return;
    this.filters = filters;
    this.nextCursor = null;
    this.publish();
    void this.loadRuns(false, null);
  }

  async openCreate(): Promise<void> {
    if (this.disposed) return;
    const preservedDraft = this.draft;
    this.createOpen = true;
    this.error = null;
    this.operation = "create-context";
    this.publish();
    const token = ++this.requestToken;
    try {
      const capabilities = this.capabilities
        ?? await this.api.capabilities(this.abortController.signal);
      if (!this.accept(token)) return;
      this.capabilities = capabilities;
      const seedDraft = preservedDraft ?? createTrainingRunDraft();
      const catalog = await this.api.catalog({
        warmupBars: seedDraft.indicatorWarmupBars,
        horizonMs: seedDraft.forwardCacheMs,
        qualityMode: "exact",
        blindMode: false,
        sourceKind: seedDraft.sourceKind,
      }, this.abortController.signal);
      if (!this.accept(token)) return;
      this.catalog = catalog;
      this.draft = preservedDraft ?? createTrainingRunDraft(catalog, this.launchContext);
      if (preservedDraft === null) {
        this.draft = this.sourceAwareDraft(this.draft, catalog);
      }
      this.evaluation = this.evaluateSourceCoverage(
        this.draft,
        catalog,
      );
      this.operation = null;
      this.publish();
    } catch (error) {
      this.fail(token, error);
    }
  }

  closeCreate(): void {
    if (this.disposed || this.operation === "create") return;
    this.createOpen = false;
    this.publish();
  }

  async openStorage(): Promise<void> {
    if (this.disposed || this.operation !== null) return;
    this.storageOpen = true;
    this.storagePlan = null;
    this.storagePlanConfirmed = false;
    this.storageResult = null;
    this.error = null;
    this.publish();
    await this.refreshStorage();
  }

  closeStorage(): void {
    if (this.disposed) return;
    this.storageAbortController.abort();
    this.storageAbortController = new AbortController();
    this.requestToken += 1;
    if (this.operation?.startsWith("storage-")) this.operation = null;
    this.storageOpen = false;
    this.storagePlan = null;
    this.storagePlanConfirmed = false;
    this.storageResult = null;
    this.publish();
  }

  async refreshStorage(): Promise<void> {
    if (this.disposed || !this.storageOpen) return;
    if (this.api.storageInventory === undefined) {
      this.error = {
        code: "REPLAY_STORAGE_UNAVAILABLE",
        message: "Replay storage inventory API is unavailable",
      };
      this.publish();
      return;
    }
    this.storageAbortController.abort();
    this.storageAbortController = new AbortController();
    this.operation = "storage-list";
    this.error = null;
    this.publish();
    const token = ++this.requestToken;
    try {
      const inventory = await this.api.storageInventory(
        this.storageAbortController.signal,
      );
      if (!this.accept(token) || !this.storageOpen) return;
      this.storageInventory = inventory;
      this.storagePlan = null;
      this.storagePlanConfirmed = false;
      this.operation = null;
      this.publish();
    } catch (error) {
      this.failStorage(token, error);
    }
  }

  async planStorageGc(
    protocol: ReplayStorageGcProtocol,
    targetReclaimBytes: number,
    maxObjects: number,
  ): Promise<void> {
    if (this.disposed || !this.storageOpen || this.api.storageGcPlan === undefined) return;
    this.operation = "storage-plan";
    this.error = null;
    this.storagePlan = null;
    this.storagePlanConfirmed = false;
    this.storageResult = null;
    this.publish();
    const token = ++this.requestToken;
    try {
      const plan = await this.api.storageGcPlan(
        protocol,
        { targetReclaimBytes, maxObjects },
        this.storageAbortController.signal,
      );
      if (!this.accept(token) || !this.storageOpen) return;
      this.storagePlan = plan;
      this.operation = null;
      this.publish();
    } catch (error) {
      this.failStorage(token, error);
    }
  }

  confirmStoragePlan(confirmed: boolean): void {
    if (this.disposed || this.storagePlan === null) return;
    this.storagePlanConfirmed = confirmed;
    this.publish();
  }

  async runStorageGc(): Promise<void> {
    if (this.disposed
      || !this.storageOpen
      || !this.storagePlanConfirmed
      || this.storagePlan === null
      || this.api.storageGcRun === undefined
      || this.api.storageInventory === undefined) return;
    const submitted = this.storagePlan;
    this.operation = "storage-run";
    this.error = null;
    this.publish();
    const token = ++this.requestToken;
    try {
      const result = await this.api.storageGcRun(
        submitted,
        this.storageAbortController.signal,
      );
      const inventory = await this.api.storageInventory(
        this.storageAbortController.signal,
      );
      if (!this.accept(token) || !this.storageOpen) return;
      this.storageResult = result;
      this.storageInventory = inventory;
      this.storagePlan = null;
      this.storagePlanConfirmed = false;
      this.operation = null;
      this.publish();
    } catch (error) {
      if (error instanceof ReplayV2ApiError
        && error.code.endsWith("_GC_PLAN_CHANGED")) {
        this.storagePlan = null;
        this.storagePlanConfirmed = false;
      }
      this.failStorage(token, error);
    }
  }

  async rehydrateStorageObject(
    protocol: ReplayStorageGcProtocol,
    objectId: string,
  ): Promise<void> {
    if (this.disposed
      || !this.storageOpen
      || this.api.storageRehydrate === undefined
      || this.api.storageInventory === undefined) return;
    this.operation = "storage-rehydrate";
    this.error = null;
    this.publish();
    const token = ++this.requestToken;
    try {
      await this.api.storageRehydrate(
        protocol,
        objectId,
        this.storageAbortController.signal,
      );
      const inventory = await this.api.storageInventory(
        this.storageAbortController.signal,
      );
      if (!this.accept(token) || !this.storageOpen) return;
      this.storageInventory = inventory;
      this.storagePlan = null;
      this.storagePlanConfirmed = false;
      this.operation = null;
      this.publish();
    } catch (error) {
      this.failStorage(token, error);
    }
  }

  setDraft(draft: TrainingRunDraft): void {
    if (this.disposed) return;
    const sourceChanged = this.draft !== null
      && this.draft.sourceKind !== draft.sourceKind;
    this.draft = draft;
    this.segmentPlan = null;
    if (sourceChanged) {
      this.catalog = null;
      this.evaluation = null;
      this.operation = "create-context";
      this.publish();
      void this.loadCreateCatalog(draft, true);
      return;
    }
    this.evaluation = this.capabilities !== null && this.catalog !== null
      ? this.evaluateSourceCoverage(draft, this.catalog)
      : this.capabilities !== null
        ? evaluateTrainingRunSetupDraft(draft, this.capabilities)
      : null;
    this.publish();
  }

  async refreshCreatePlan(): Promise<void> {
    if (this.disposed || this.capabilities === null || this.draft === null) {
      return;
    }
    await this.loadCreateCatalog(this.draft);
  }

  async createRun(draft: TrainingRunDraft): Promise<void> {
    if (this.disposed || this.capabilities === null) return;
    const ready = await this.loadCreateCatalog(draft);
    if (!ready) return;
    if (this.catalog === null || this.draft === null) return;
    draft = this.draft;
    const evaluation = this.evaluateSourceCoverage(draft, this.catalog);
    this.draft = draft;
    this.evaluation = evaluation;
    if (!evaluation.canSubmit) {
      this.error = { code: "TRAINING_RUN_INVALID", message: evaluation.errors.join("；") };
      this.publish();
      return;
    }
    this.operation = "create";
    this.error = null;
    this.publish();
    const token = ++this.requestToken;
    try {
      const result = await this.api.createRun(
        buildTrainingRunCreateRequest(draft, evaluation, this.launchContext),
        this.abortController.signal,
      );
      if (!this.accept(token)) return;
      this.operation = null;
      this.publish();
      this.navigateToRun(result.run.run_id);
    } catch (error) {
      this.fail(token, error);
    }
  }

  async deleteRun(runId: string): Promise<void> {
    if (this.disposed || this.operation !== null) return;
    if (this.api.deleteRun === undefined) {
      this.error = {
        code: "TRAINING_RUN_DELETE_UNAVAILABLE",
        message: "当前客户端不支持删除训练存档",
      };
      this.publish();
      return;
    }
    this.operation = "delete";
    this.error = null;
    this.publish();
    const token = ++this.requestToken;
    try {
      const result = await this.api.deleteRun(
        runId,
        this.abortController.signal,
      );
      if (!this.accept(token)) return;
      if (result.run_id !== runId) {
        throw new TypeError("run deletion response identity changed");
      }
      this.clearDeletedRunState(result.run_id, result.session_ids);
      this.items = this.items.filter((item) => item.run_id !== result.run_id);
      this.operation = null;
      this.publish();
    } catch (error) {
      this.fail(token, error);
    }
  }

  continueRun(card: TrainingRunCard): void {
    if (card.resume_action === "UNAVAILABLE") {
      this.error = { code: "TRAINING_RUN_UNAVAILABLE", message: card.status.message };
      this.publish();
      return;
    }
    this.navigateToRun(card.run_id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort();
    this.storageAbortController.abort();
    this.phase = "STOPPED";
    this.operation = null;
    this.publish();
    this.listeners.clear();
  }

  private async loadRuns(append: boolean, cursor: string | null): Promise<void> {
    const token = ++this.requestToken;
    this.phase = this.items.length === 0 ? "LOADING" : this.phase;
    this.operation = "list";
    this.error = null;
    this.publish();
    const query: TrainingRunListQuery = {
      limit: 50,
      ...(cursor === null ? {} : { cursor }),
      ...(this.filters.state === null ? {} : { state: this.filters.state }),
      ...(this.filters.sourceKind === null ? {} : { sourceKind: this.filters.sourceKind }),
      ...(this.filters.compatibility === null
        ? {}
        : { compatibility: this.filters.compatibility }),
    };
    try {
      const result = await this.api.listRuns(query, this.abortController.signal);
      if (!this.accept(token)) return;
      this.items = append ? [...this.items, ...result.items] : result.items;
      this.nextCursor = result.next_cursor;
      this.phase = "READY";
      this.operation = null;
      this.publish();
    } catch (error) {
      this.fail(token, error);
    }
  }

  private accept(token: number): boolean {
    return !this.disposed && token === this.requestToken;
  }

  private sourceAwareDraft(
    draft: TrainingRunDraft,
    catalog: ReplayCatalog,
  ): TrainingRunDraft {
    const ranges = catalog.entries.flatMap((entry) => entry.eligible_ranges);
    if (ranges.length === 0) return draft;
    const earliest = Math.min(...ranges.map((range) => range.first_start_ms));
    const latest = Math.max(...ranges.map((range) => range.last_start_ms));
    if (draft.startMode === "MANUAL") {
      return { ...draft, requestedStartMs: latest };
    }
    return {
      ...draft,
      randomRangeStartMs: earliest,
      randomRangeEndMs: latest,
    };
  }

  private evaluateSourceCoverage(
    draft: TrainingRunDraft,
    catalog: ReplayCatalog,
  ): TrainingRunDraftEvaluation {
    if (this.capabilities === null) {
      throw new TypeError("replay capabilities are required for source validation");
    }
    const evaluation = evaluateTrainingRunSetupDraft(draft, this.capabilities);
    const errors = [...evaluation.errors];
    const ranges = catalog.entries.flatMap((entry) => entry.eligible_ranges);
    if (catalog.entries.length === 0 || ranges.length === 0) {
      errors.push("当前历史源没有可用覆盖商品");
    } else if (draft.startMode === "MANUAL" && (
      draft.requestedStartMs === null
      || !ranges.some((range) => (
        draft.requestedStartMs! >= range.first_start_ms
        && draft.requestedStartMs! <= range.last_start_ms
        && (draft.requestedStartMs! - range.first_start_ms) % range.interval_ms === 0
      ))
    )) {
      errors.push("开始时间不在当前历史源的可用覆盖范围");
    } else if (draft.startMode === "RANDOM"
      && draft.randomRangeStartMs !== null
      && draft.randomRangeEndMs !== null
      && !ranges.some((range) => {
        const first = Math.max(range.first_start_ms, draft.randomRangeStartMs!);
        const last = Math.min(range.last_start_ms, draft.randomRangeEndMs!);
        const alignedFirst = first
          + ((range.interval_ms - ((first - range.first_start_ms) % range.interval_ms))
            % range.interval_ms);
        return alignedFirst <= last;
      })) {
      errors.push("随机区间与当前历史源的可用覆盖范围不相交");
    }
    return {
      ...evaluation,
      canSubmit: errors.length === 0,
      errors,
    };
  }

  private async loadCreateCatalog(
    draft: TrainingRunDraft,
    normalizeStart = false,
  ): Promise<boolean> {
    if (this.disposed || this.capabilities === null) return false;
    const token = ++this.requestToken;
    this.operation = "create-context";
    this.error = null;
    this.publish();
    try {
      const catalog = await this.api.catalog({
        warmupBars: draft.indicatorWarmupBars,
        horizonMs: draft.forwardCacheMs,
        qualityMode: "exact",
        blindMode: false,
        sourceKind: draft.sourceKind,
      }, this.abortController.signal);
      if (!this.accept(token)) return false;
      this.catalog = catalog;
      this.draft = normalizeStart ? this.sourceAwareDraft(draft, catalog) : draft;
      this.evaluation = this.evaluateSourceCoverage(
        this.draft,
        catalog,
      );
      this.operation = null;
      this.publish();
      return true;
    } catch (error) {
      this.fail(token, error);
      return false;
    }
  }

  private fail(token: number, error: unknown): void {
    if (!this.accept(token) || isAbort(error)) return;
    this.phase = this.items.length > 0 ? "READY" : "ERROR";
    this.operation = null;
    this.error = hubError(error);
    this.publish();
  }

  private failStorage(token: number, error: unknown): void {
    if (!this.accept(token) || isAbort(error)) return;
    this.operation = null;
    this.error = hubError(error);
    this.publish();
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): TrainingHubSnapshot {
    return {
      phase: this.phase,
      items: this.items,
      nextCursor: this.nextCursor,
      filters: this.filters,
      operation: this.operation,
      error: this.error,
      createOpen: this.createOpen,
      capabilities: this.capabilities,
      catalog: this.catalog,
      draft: this.draft,
      evaluation: this.evaluation,
      segmentPlan: this.segmentPlan,
      storageOpen: this.storageOpen,
      storageInventory: this.storageInventory,
      storagePlan: this.storagePlan,
      storagePlanConfirmed: this.storagePlanConfirmed,
      storageResult: this.storageResult,
    };
  }
}

export interface TrainingHubRuntime extends TrainingHubSnapshot {
  readonly actions: {
    refresh(): void;
    loadNext(): void;
    setFilters(filters: TrainingHubFilters): void;
    openCreate(): void | Promise<void>;
    closeCreate(): void;
    openStorage(): void | Promise<void>;
    closeStorage(): void;
    refreshStorage(): void | Promise<void>;
    planStorageGc(
      protocol: ReplayStorageGcProtocol,
      targetReclaimBytes: number,
      maxObjects: number,
    ): void | Promise<void>;
    confirmStoragePlan(confirmed: boolean): void;
    runStorageGc(): void | Promise<void>;
    rehydrateStorageObject(
      protocol: ReplayStorageGcProtocol,
      objectId: string,
    ): void | Promise<void>;
    setDraft(draft: TrainingRunDraft): void;
    refreshCreatePlan(): void | Promise<void>;
    createRun(draft: TrainingRunDraft): void | Promise<void>;
    deleteRun(runId: string): void | Promise<void>;
    continueRun(card: TrainingRunCard): void;
  };
}

class TrainingHubEffectGuard {
  private readonly pending = new Map<TrainingHubLifecycle, symbol>();

  mount(lifecycle: TrainingHubLifecycle): () => void {
    this.pending.delete(lifecycle);
    lifecycle.start();
    return () => {
      const token = Symbol("training-hub-dispose");
      this.pending.set(lifecycle, token);
      queueMicrotask(() => {
        if (this.pending.get(lifecycle) !== token) return;
        this.pending.delete(lifecycle);
        lifecycle.dispose();
      });
    };
  }
}

export function useTrainingHub(
  options: TrainingHubLifecycleOptions = {},
): TrainingHubRuntime {
  const { api, navigateToRun, launchContext } = options;
  const lifecycle = useMemo(() => new TrainingHubLifecycle({
    ...(api === undefined ? {} : { api }),
    ...(navigateToRun === undefined ? {} : { navigateToRun }),
    ...(launchContext === undefined ? {} : { launchContext }),
  }), [api, launchContext, navigateToRun]);
  const guard = useMemo(() => new TrainingHubEffectGuard(), []);
  useEffect(() => guard.mount(lifecycle), [guard, lifecycle]);
  const snapshot = useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.getSnapshot,
    lifecycle.getSnapshot,
  );
  return useMemo(() => ({
    ...snapshot,
    actions: {
      refresh: () => lifecycle.refresh(),
      loadNext: () => lifecycle.loadNext(),
      setFilters: (filters: TrainingHubFilters) => lifecycle.setFilters(filters),
      openCreate: () => lifecycle.openCreate(),
      closeCreate: () => lifecycle.closeCreate(),
      openStorage: () => lifecycle.openStorage(),
      closeStorage: () => lifecycle.closeStorage(),
      refreshStorage: () => lifecycle.refreshStorage(),
      planStorageGc: (protocol, targetReclaimBytes, maxObjects) => (
        lifecycle.planStorageGc(protocol, targetReclaimBytes, maxObjects)
      ),
      confirmStoragePlan: (confirmed) => (
        lifecycle.confirmStoragePlan(confirmed)
      ),
      runStorageGc: () => lifecycle.runStorageGc(),
      rehydrateStorageObject: (protocol, objectId) => (
        lifecycle.rehydrateStorageObject(protocol, objectId)
      ),
      setDraft: (draft: TrainingRunDraft) => lifecycle.setDraft(draft),
      refreshCreatePlan: () => lifecycle.refreshCreatePlan(),
      createRun: (draft: TrainingRunDraft) => lifecycle.createRun(draft),
      deleteRun: (runId: string) => lifecycle.deleteRun(runId),
      continueRun: (card: TrainingRunCard) => lifecycle.continueRun(card),
    },
  }), [lifecycle, snapshot]);
}
