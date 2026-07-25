import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ReplayApiError } from "./replayApi.js";
import type { ReplayCapabilities, ReplayCatalog } from "./replayTypes.js";
import type { ReplaySegmentPreparePlan } from "./replaySegmentTypes.js";
import { defaultReplayV2Api, ReplayV2ApiError } from "./replayV2Api.js";
import type { TrainingRunListQuery } from "./replayV2Api.js";
import {
  buildTrainingRunCreateRequest,
  createTrainingRunDraft,
  evaluateTrainingRunDraft,
  replayStartWindow,
  requiresBlindTrainingCatalog,
} from "./trainingHubModel.js";
import type { TrainingRunDraft, TrainingRunDraftEvaluation } from "./trainingHubModel.js";
import type {
  ReplayLaunchContext,
  ReplayV2RunState,
  ReplayV2SourceKind,
  TrainingRunCard,
  TrainingRunCompatibility,
  TrainingRunCreatePayload,
  TrainingRunListResponse,
  TrainingRunMutationResponse,
} from "./replayV2Types.js";

export type TrainingHubPhase = "IDLE" | "LOADING" | "READY" | "ERROR" | "STOPPED";
export type TrainingHubOperation = "list" | "create-context" | "plan" | "create" | "migrate" | null;

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
    },
    signal?: AbortSignal,
  ): Promise<ReplayCatalog>;
  createRun(payload: TrainingRunCreatePayload, signal?: AbortSignal): Promise<TrainingRunMutationResponse>;
  segmentPlan?(
    payload: TrainingRunCreatePayload,
    signal?: AbortSignal,
  ): Promise<ReplaySegmentPreparePlan>;
  migrateLegacy(
    sessionId: string,
    name?: string | null,
    signal?: AbortSignal,
  ): Promise<TrainingRunMutationResponse>;
}

export interface TrainingHubLifecycleOptions {
  readonly api?: TrainingHubApiBoundary;
  readonly navigateToSession?: (sessionId: string) => void;
  readonly launchContext?: ReplayLaunchContext;
}

type Listener = () => void;

function hubError(error: unknown): TrainingHubError {
  if (error instanceof ReplayV2ApiError || error instanceof ReplayApiError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) return { code: "TRAINING_HUB_ERROR", message: error.message };
  return { code: "TRAINING_HUB_ERROR", message: "Unknown Training Hub failure" };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function defaultNavigateToSession(sessionId: string): void {
  if (typeof window === "undefined") return;
  window.location.assign(`/replay.html?session=${encodeURIComponent(sessionId)}`);
}

function samePlanInputs(left: TrainingRunDraft, right: TrainingRunDraft): boolean {
  return left.sourceKind === right.sourceKind
    && left.startMode === right.startMode
    && left.exchange === right.exchange
    && left.marketType === right.marketType
    && left.symbol === right.symbol
    && left.baseInterval === right.baseInterval
    && left.displayInterval === right.displayInterval
    && left.requestedStartMs === right.requestedStartMs
    && left.warmupBars === right.warmupBars
    && left.forwardCacheMs === right.forwardCacheMs;
}

export class TrainingHubLifecycle {
  private readonly api: TrainingHubApiBoundary;
  private readonly navigateToSession: (sessionId: string) => void;
  private readonly launchContext: ReplayLaunchContext | undefined;
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
  private abortController = new AbortController();
  private requestToken = 0;
  private started = false;
  private disposed = false;
  private snapshot: TrainingHubSnapshot;

  constructor({
    api = defaultReplayV2Api,
    navigateToSession = defaultNavigateToSession,
    launchContext,
  }: TrainingHubLifecycleOptions = {}) {
    this.api = api;
    this.navigateToSession = navigateToSession;
    this.launchContext = launchContext;
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
    const forceReload = this.error?.code === "CATALOG_EPOCH_MISMATCH";
    const preservedDraft = forceReload ? this.draft : null;
    this.createOpen = true;
    this.error = null;
    if (!forceReload && this.capabilities !== null && this.catalog !== null) {
      this.draft ??= createTrainingRunDraft(this.catalog, this.launchContext);
      this.evaluation = evaluateTrainingRunDraft(
        this.draft,
        this.capabilities,
        this.catalog,
        this.segmentPlan,
      );
      this.publish();
      return;
    }
    if (forceReload) {
      this.capabilities = null;
      this.catalog = null;
      this.evaluation = null;
      this.segmentPlan = null;
    }
    this.operation = "create-context";
    this.publish();
    const token = ++this.requestToken;
    try {
      const [capabilities, catalog] = await Promise.all([
        this.api.capabilities(this.abortController.signal),
        this.api.catalog({
          warmupBars: preservedDraft?.warmupBars ?? 200,
          horizonMs: preservedDraft?.forwardCacheMs ?? 86_400_000,
          qualityMode: "exact",
          blindMode: preservedDraft === null
            ? true
            : requiresBlindTrainingCatalog(preservedDraft),
        }, this.abortController.signal),
      ]);
      if (!this.accept(token)) return;
      this.capabilities = capabilities;
      this.catalog = catalog;
      this.draft = preservedDraft ?? createTrainingRunDraft(
        catalog,
        this.launchContext,
      );
      this.evaluation = evaluateTrainingRunDraft(this.draft, capabilities, catalog);
      this.segmentPlan = await this.loadSegmentPlan(
        this.draft,
        catalog,
      );
      if (!this.accept(token)) return;
      this.evaluation = evaluateTrainingRunDraft(
        this.draft,
        capabilities,
        catalog,
        this.segmentPlan,
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

  setDraft(draft: TrainingRunDraft): void {
    if (this.disposed) return;
    const keepPlan = this.draft !== null && samePlanInputs(this.draft, draft);
    this.draft = draft;
    if (!keepPlan) this.segmentPlan = null;
    this.evaluation = this.capabilities !== null && this.catalog !== null
      ? evaluateTrainingRunDraft(
        draft,
        this.capabilities,
        this.catalog,
        this.segmentPlan,
      )
      : null;
    this.publish();
    if (this.catalog !== null
      && this.catalog.blind_mode !== requiresBlindTrainingCatalog(draft)) {
      void this.rebindCreateCatalog(draft);
    }
  }

  async refreshCreatePlan(): Promise<void> {
    if (this.disposed || this.capabilities === null || this.catalog === null || this.draft === null) {
      return;
    }
    this.operation = "plan";
    this.error = null;
    this.publish();
    const token = ++this.requestToken;
    try {
      const plan = await this.loadSegmentPlan(this.draft, this.catalog);
      if (!this.accept(token)) return;
      this.segmentPlan = plan;
      this.evaluation = evaluateTrainingRunDraft(
        this.draft,
        this.capabilities,
        this.catalog,
        plan,
      );
      this.operation = null;
      this.publish();
    } catch (error) {
      this.fail(token, error);
    }
  }

  async createRun(draft: TrainingRunDraft): Promise<void> {
    if (this.disposed || this.capabilities === null || this.catalog === null) return;
    let evaluation = evaluateTrainingRunDraft(
      draft,
      this.capabilities,
      this.catalog,
      this.segmentPlan,
    );
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
      const catalog = await this.api.catalog({
        warmupBars: draft.warmupBars,
        horizonMs: draft.forwardCacheMs,
        qualityMode: "exact",
        blindMode: requiresBlindTrainingCatalog(draft),
      }, this.abortController.signal);
      if (!this.accept(token)) return;
      evaluation = evaluateTrainingRunDraft(
        draft,
        this.capabilities,
        catalog,
        this.segmentPlan,
      );
      this.catalog = catalog;
      this.evaluation = evaluation;
      if (!evaluation.canSubmit) {
        this.operation = null;
        this.error = { code: "TRAINING_RUN_INVALID", message: evaluation.errors.join("；") };
        this.publish();
        return;
      }
      this.segmentPlan = await this.loadSegmentPlan(draft, catalog);
      if (!this.accept(token)) return;
      evaluation = evaluateTrainingRunDraft(
        draft,
        this.capabilities,
        catalog,
        this.segmentPlan,
      );
      this.evaluation = evaluation;
      if (!evaluation.canSubmit) {
        this.operation = null;
        this.error = { code: "TRAINING_RUN_INVALID", message: evaluation.errors.join("；") };
        this.publish();
        return;
      }
      const result = await this.api.createRun(
        buildTrainingRunCreateRequest(
          draft,
          evaluation,
          catalog,
          this.launchContext,
        ),
        this.abortController.signal,
      );
      if (!this.accept(token)) return;
      this.operation = null;
      this.publish();
      this.navigateToSession(result.run.adapter_session_id);
    } catch (error) {
      this.fail(token, error);
    }
  }

  async migrateLegacy(sessionId: string, name: string | null = null): Promise<void> {
    if (this.disposed) return;
    this.operation = "migrate";
    this.error = null;
    this.publish();
    const token = ++this.requestToken;
    try {
      const result = await this.api.migrateLegacy(
        sessionId,
        name,
        this.abortController.signal,
      );
      if (!this.accept(token)) return;
      this.operation = null;
      this.publish();
      this.navigateToSession(result.run.adapter_session_id);
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
    this.navigateToSession(card.adapter_session_id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort();
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

  private async loadSegmentPlan(
    draft: TrainingRunDraft,
    catalog: ReplayCatalog,
  ): Promise<ReplaySegmentPreparePlan | null> {
    if (this.api.segmentPlan === undefined || this.capabilities === null) return null;
    const planningDraft: TrainingRunDraft = { ...draft, bookMode: "OFF" };
    const planningEvaluation = evaluateTrainingRunDraft(
      planningDraft,
      this.capabilities,
      catalog,
    );
    if (!planningEvaluation.canSubmit) return null;
    const payload = buildTrainingRunCreateRequest(
      planningDraft,
      planningEvaluation,
      catalog,
      this.launchContext,
    );
    return this.api.segmentPlan(
      { ...payload, book_mode: draft.bookMode },
      this.abortController.signal,
    );
  }

  private async rebindCreateCatalog(requestedDraft: TrainingRunDraft): Promise<void> {
    if (this.disposed || this.capabilities === null) return;
    const expectedBlind = requiresBlindTrainingCatalog(requestedDraft);
    this.operation = "create-context";
    this.error = null;
    this.segmentPlan = null;
    this.publish();
    const token = ++this.requestToken;
    try {
      const catalog = await this.api.catalog({
        warmupBars: requestedDraft.warmupBars,
        horizonMs: requestedDraft.forwardCacheMs,
        qualityMode: "exact",
        blindMode: expectedBlind,
      }, this.abortController.signal);
      if (!this.accept(token)) return;
      const current = this.draft;
      if (current === null || requiresBlindTrainingCatalog(current) !== expectedBlind) return;
      let reboundDraft = current;
      if (current.startMode === "MANUAL" && current.requestedStartMs === null) {
        const entry = catalog.entries.find((candidate) => (
          candidate.identity.exchange === current.exchange
          && candidate.identity.market_type === current.marketType
          && candidate.identity.symbol === current.symbol
        ));
        const earliest = entry === undefined
          ? null
          : replayStartWindow(entry).earliestEligibleMs;
        if (earliest !== null) reboundDraft = { ...current, requestedStartMs: earliest };
      }
      this.catalog = catalog;
      this.draft = reboundDraft;
      this.evaluation = evaluateTrainingRunDraft(
        reboundDraft,
        this.capabilities,
        catalog,
      );
      this.segmentPlan = await this.loadSegmentPlan(reboundDraft, catalog);
      if (!this.accept(token)) return;
      this.evaluation = evaluateTrainingRunDraft(
        reboundDraft,
        this.capabilities,
        catalog,
        this.segmentPlan,
      );
      this.operation = null;
      this.publish();
    } catch (error) {
      this.fail(token, error);
    }
  }

  private accept(token: number): boolean {
    return !this.disposed && token === this.requestToken;
  }

  private fail(token: number, error: unknown): void {
    if (!this.accept(token) || isAbort(error)) return;
    this.phase = this.items.length > 0 ? "READY" : "ERROR";
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
    setDraft(draft: TrainingRunDraft): void;
    refreshCreatePlan(): void | Promise<void>;
    createRun(draft: TrainingRunDraft): void | Promise<void>;
    migrateLegacy(sessionId: string, name?: string | null): void | Promise<void>;
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
  const { api, navigateToSession, launchContext } = options;
  const lifecycle = useMemo(() => new TrainingHubLifecycle({
    ...(api === undefined ? {} : { api }),
    ...(navigateToSession === undefined ? {} : { navigateToSession }),
    ...(launchContext === undefined ? {} : { launchContext }),
  }), [api, launchContext, navigateToSession]);
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
      setDraft: (draft: TrainingRunDraft) => lifecycle.setDraft(draft),
      refreshCreatePlan: () => lifecycle.refreshCreatePlan(),
      createRun: (draft: TrainingRunDraft) => lifecycle.createRun(draft),
      migrateLegacy: (sessionId: string, name: string | null = null) => (
        lifecycle.migrateLegacy(sessionId, name)
      ),
      continueRun: (card: TrainingRunCard) => lifecycle.continueRun(card),
    },
  }), [lifecycle, snapshot]);
}
