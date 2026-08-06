export type ChartWorkTier = "focused" | "hidden" | "minimized" | "visible-secondary";

export type ChartWorkLane =
  | "active-hydration"
  | "authoritative-final"
  | "indicator-preview"
  | "indicator-range"
  | "initial-history"
  | "kline-forming"
  | "load-more"
  | "prefetch";

export interface ChartWorkSchedulerOptions {
  appBudget?: {
    acquire(cellId: string, lane: ChartWorkLane): Promise<unknown>;
    release(lease: unknown): void;
  } | null;
  cancelFrame?: (handle: number) => void;
  maxConcurrent?: number;
  maxConcurrentHydration?: number;
  maxFrameTasksPerFrame?: number;
  now?: () => number;
  requestFrame?: (callback: () => void) => number;
  yieldFrameBetweenTasks?: boolean;
}

export interface ChartWorkCellDiagnostics {
  cellId: string;
  committed: Partial<Record<ChartWorkLane, number>>;
  dropped: number;
  lastCommitAt: number | null;
  lastLane: ChartWorkLane | null;
  lastQueueWaitMs: number | null;
  maxQueueWaitMs: number;
  pending: Partial<Record<ChartWorkLane, number>>;
  replaced: number;
  tier: ChartWorkTier;
}

export interface ChartWorkSchedulerDiagnostics {
  activeAsync: number;
  activeHydration: number;
  cells: ChartWorkCellDiagnostics[];
  disposed: boolean;
  pendingAsync: number;
  pendingFrames: number;
  windowVisible: boolean;
}

interface CellState {
  diagnostics: ChartWorkCellDiagnostics;
  configuredTier: Exclude<ChartWorkTier, "minimized">;
}

interface AsyncTask<TResult = unknown> {
  cellId: string;
  createdAt: number;
  lane: Extract<ChartWorkLane, "active-hydration" | "indicator-range" | "initial-history" | "load-more" | "prefetch">;
  reject(error: unknown): void;
  resolve(result: TResult): void;
  run(): TResult | PromiseLike<TResult>;
  sequence: number;
}

interface FrameTask {
  callback: () => void;
  cellId: string;
  createdAt: number;
  key: string;
  lane: Extract<ChartWorkLane, "indicator-preview" | "kline-forming">;
  sequence: number;
}

const TIER_ORDER: Record<ChartWorkTier, number> = {
  focused: 0,
  "visible-secondary": 1,
  hidden: 2,
  minimized: 3,
};

const LANE_ORDER: Record<AsyncTask["lane"], number> = {
  "initial-history": 0,
  "load-more": 1,
  "indicator-range": 2,
  "active-hydration": 3,
  prefetch: 4,
};

function defaultRequestFrame(callback: () => void): number {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(callback, 16) as unknown as number;
}

function defaultCancelFrame(handle: number): void {
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(handle);
    return;
  }
  globalThis.clearTimeout(handle);
}

export class ChartWorkDroppedError extends Error {
  readonly code = "CHART_WORK_DROPPED";

  constructor(message: string) {
    super(message);
    this.name = "ChartWorkDroppedError";
  }
}

/**
 * Per-window work arbiter. Forming/preview work is replaceable and frame
 * bounded; closed/amended commits bypass throttling. Async lanes use bounded
 * concurrency and round-robin selection between equal tier/lane Cells.
 */
export class ChartWorkScheduler {
  private readonly maxConcurrent: number;
  private readonly maxConcurrentHydration: number;
  private readonly maxFrameTasksPerFrame: number;
  private readonly now: () => number;
  private readonly requestFrame: (callback: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly yieldFrameBetweenTasks: boolean;
  private readonly appBudget: ChartWorkSchedulerOptions["appBudget"];
  private readonly cells = new Map<string, CellState>();
  private readonly asyncQueue: AsyncTask[] = [];
  private readonly frameQueue = new Map<string, FrameTask>();
  private readonly lastServedCell = new Map<string, string>();
  private activeAsync = 0;
  private activeHydration = 0;
  private frameHandle: number | null = null;
  private yieldNextFrame = false;
  private nextSequence = 0;
  private nextFrameHandle = 0;
  private windowVisible = true;
  private disposed = false;

  constructor(options: ChartWorkSchedulerOptions = {}) {
    // One logical slot per maximum visible Cell lets equal requests reach the
    // exact-request broker concurrently, where they collapse to one physical
    // transport. CPU-heavy forming/preview work uses the separate frame lane.
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 16));
    // Deep cache hydration is intentionally background work. One request at a
    // time prevents several distinct 1,500-row SQLite projections from
    // contending for the Python GIL while foreground 16-Cell reads stay fully
    // concurrent.
    this.maxConcurrentHydration = Math.max(
      1,
      Math.floor(options.maxConcurrentHydration ?? 1),
    );
    // Canvas paint cost scales with visible Cell count. Stagger replaceable
    // forming/preview commits across frames so a 16-Cell fan-out cannot turn a
    // one-second market tick into one 250+ ms main-thread block. Authoritative
    // final/amended commits bypass this queue and remain immediate.
    this.maxFrameTasksPerFrame = Math.max(
      1,
      Math.floor(options.maxFrameTasksPerFrame ?? 1),
    );
    this.now = options.now || Date.now;
    this.requestFrame = options.requestFrame || defaultRequestFrame;
    this.cancelFrame = options.cancelFrame || defaultCancelFrame;
    this.yieldFrameBetweenTasks = options.yieldFrameBetweenTasks ?? true;
    this.appBudget = options.appBudget ?? null;
  }

  registerCell(
    cellId: string,
    tier: Exclude<ChartWorkTier, "minimized"> = "visible-secondary",
  ): () => void {
    this.setCellTier(cellId, tier);
    return () => this.unregisterCell(cellId);
  }

  setCellTier(cellId: string, tier: Exclude<ChartWorkTier, "minimized">): void {
    if (this.disposed || !cellId) return;
    const state = this.ensureCell(cellId, tier);
    state.configuredTier = tier;
    state.diagnostics.tier = this.effectiveTier(state);
    if (state.diagnostics.tier === "hidden" || state.diagnostics.tier === "minimized") {
      this.dropReplaceableFrames(cellId);
    }
    this.scheduleDrain();
  }

  setWindowVisible(visible: boolean): void {
    if (this.disposed || this.windowVisible === visible) return;
    this.windowVisible = visible;
    for (const state of this.cells.values()) {
      state.diagnostics.tier = this.effectiveTier(state);
    }
    if (!visible) {
      for (const cellId of this.cells.keys()) this.dropReplaceableFrames(cellId);
    }
    this.scheduleDrain();
  }

  tier(cellId: string): ChartWorkTier {
    return this.ensureCell(cellId).diagnostics.tier;
  }

  commitAuthoritative(
    cellId: string,
    callback: () => void,
    supersede?: { key: string; lane: FrameTask["lane"] },
  ): void {
    if (this.disposed) return;
    const state = this.ensureCell(cellId);
    if (supersede) {
      const taskKey = `${cellId}\u0000${supersede.lane}\u0000${supersede.key}`;
      const pending = this.frameQueue.get(taskKey);
      if (pending) {
        this.frameQueue.delete(taskKey);
        this.incrementPending(state, supersede.lane, -1);
        state.diagnostics.replaced += 1;
      }
    }
    callback();
    this.recordCommit(state, "authoritative-final", 0);
  }

  enqueueFrame(
    cellId: string,
    lane: FrameTask["lane"],
    key: string,
    callback: () => void,
  ): boolean {
    if (this.disposed) return false;
    const state = this.ensureCell(cellId);
    if (state.diagnostics.tier === "hidden" || state.diagnostics.tier === "minimized") {
      state.diagnostics.dropped += 1;
      return false;
    }
    const taskKey = `${cellId}\u0000${lane}\u0000${key}`;
    const previous = this.frameQueue.get(taskKey);
    const task: FrameTask = {
      callback,
      cellId,
      createdAt: previous?.createdAt ?? this.now(),
      key,
      lane,
      sequence: previous?.sequence ?? this.nextSequence++,
    };
    this.frameQueue.set(taskKey, task);
    if (previous) state.diagnostics.replaced += 1;
    else this.incrementPending(state, lane, 1);
    this.scheduleFrame();
    return true;
  }

  frameScheduler(
    cellId: string,
    lane: Extract<FrameTask["lane"], "indicator-preview"> = "indicator-preview",
  ): { cancel(handle: number): void; request(callback: () => void): number } {
    return {
      request: (callback) => {
        this.nextFrameHandle += 1;
        const handle = this.nextFrameHandle;
        this.enqueueFrame(cellId, lane, `frame-${handle}`, callback);
        return handle;
      },
      cancel: (handle) => {
        const taskKey = `${cellId}\u0000${lane}\u0000frame-${handle}`;
        const task = this.frameQueue.get(taskKey);
        if (!task) return;
        this.frameQueue.delete(taskKey);
        this.incrementPending(this.ensureCell(cellId), lane, -1);
      },
    };
  }

  run<TResult>(
    cellId: string,
    lane: AsyncTask["lane"],
    work: () => TResult | PromiseLike<TResult>,
  ): Promise<TResult> {
    if (this.disposed) return Promise.reject(new ChartWorkDroppedError("Chart work scheduler is disposed"));
    const state = this.ensureCell(cellId);
    if (
      (state.diagnostics.tier === "hidden" || state.diagnostics.tier === "minimized")
      && (lane === "indicator-range" || lane === "prefetch")
    ) {
      state.diagnostics.dropped += 1;
      return Promise.reject(new ChartWorkDroppedError(`${lane} is disabled for ${state.diagnostics.tier} Cell`));
    }
    return new Promise<TResult>((resolve, reject) => {
      const task: AsyncTask<TResult> = {
        cellId,
        createdAt: this.now(),
        lane,
        reject,
        resolve,
        run: work,
        sequence: this.nextSequence++,
      };
      this.asyncQueue.push(task as AsyncTask);
      this.incrementPending(state, lane, 1);
      this.scheduleDrain();
    });
  }

  diagnostics(): ChartWorkSchedulerDiagnostics {
    return {
      activeAsync: this.activeAsync,
      activeHydration: this.activeHydration,
      cells: [...this.cells.values()].map((state) => ({
        ...state.diagnostics,
        committed: { ...state.diagnostics.committed },
        pending: { ...state.diagnostics.pending },
      })),
      disposed: this.disposed,
      pendingAsync: this.asyncQueue.length,
      pendingFrames: this.frameQueue.size,
      windowVisible: this.windowVisible,
    };
  }

  unregisterCell(cellId: string): void {
    const state = this.cells.get(cellId);
    if (!state) return;
    this.dropReplaceableFrames(cellId);
    for (let index = this.asyncQueue.length - 1; index >= 0; index -= 1) {
      const task = this.asyncQueue[index];
      if (task?.cellId !== cellId) continue;
      this.asyncQueue.splice(index, 1);
      task.reject(new ChartWorkDroppedError(`Cell ${cellId} was unregistered`));
    }
    this.cells.delete(cellId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameHandle !== null) this.cancelFrame(this.frameHandle);
    this.frameHandle = null;
    this.yieldNextFrame = false;
    this.frameQueue.clear();
    const error = new ChartWorkDroppedError("Chart work scheduler was disposed");
    this.asyncQueue.splice(0).forEach((task) => task.reject(error));
    this.cells.clear();
  }

  private ensureCell(
    cellId: string,
    tier: Exclude<ChartWorkTier, "minimized"> = "visible-secondary",
  ): CellState {
    let state = this.cells.get(cellId);
    if (state) return state;
    state = {
      configuredTier: tier,
      diagnostics: {
        cellId,
        committed: {},
        dropped: 0,
        lastCommitAt: null,
        lastLane: null,
        lastQueueWaitMs: null,
        maxQueueWaitMs: 0,
        pending: {},
        replaced: 0,
        tier: this.windowVisible ? tier : "minimized",
      },
    };
    this.cells.set(cellId, state);
    return state;
  }

  private effectiveTier(state: CellState): ChartWorkTier {
    return this.windowVisible ? state.configuredTier : "minimized";
  }

  private incrementPending(state: CellState, lane: ChartWorkLane, delta: number): void {
    const next = Math.max(0, (state.diagnostics.pending[lane] || 0) + delta);
    if (next === 0) delete state.diagnostics.pending[lane];
    else state.diagnostics.pending[lane] = next;
  }

  private recordCommit(state: CellState, lane: ChartWorkLane, queueWaitMs: number): void {
    state.diagnostics.committed[lane] = (state.diagnostics.committed[lane] || 0) + 1;
    state.diagnostics.lastCommitAt = this.now();
    state.diagnostics.lastLane = lane;
    state.diagnostics.lastQueueWaitMs = queueWaitMs;
    state.diagnostics.maxQueueWaitMs = Math.max(state.diagnostics.maxQueueWaitMs, queueWaitMs);
  }

  private dropReplaceableFrames(cellId: string): void {
    const state = this.cells.get(cellId);
    if (!state) return;
    for (const [key, task] of this.frameQueue) {
      if (task.cellId !== cellId) continue;
      this.frameQueue.delete(key);
      state.diagnostics.dropped += 1;
      this.incrementPending(state, task.lane, -1);
    }
    if (this.frameQueue.size === 0 && this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
      this.yieldNextFrame = false;
    }
  }

  private scheduleFrame(): void {
    if (this.frameHandle !== null || this.frameQueue.size === 0 || this.disposed) return;
    this.frameHandle = this.requestFrame(() => {
      this.frameHandle = null;
      this.flushFrames();
    });
  }

  private flushFrames(): void {
    if (this.yieldNextFrame) {
      this.yieldNextFrame = false;
      this.scheduleFrame();
      return;
    }
    const tasks = [...this.frameQueue.values()].sort((left, right) => {
      const tierDelta = TIER_ORDER[this.tier(left.cellId)] - TIER_ORDER[this.tier(right.cellId)];
      return tierDelta || left.sequence - right.sequence;
    });
    let committed = 0;
    for (const task of tasks) {
      if (committed >= this.maxFrameTasksPerFrame) break;
      const taskKey = `${task.cellId}\u0000${task.lane}\u0000${task.key}`;
      if (!this.frameQueue.delete(taskKey)) continue;
      const state = this.ensureCell(task.cellId);
      this.incrementPending(state, task.lane, -1);
      if (state.diagnostics.tier === "hidden" || state.diagnostics.tier === "minimized") {
        state.diagnostics.dropped += 1;
        continue;
      }
      const waitMs = Math.max(0, this.now() - task.createdAt);
      task.callback();
      this.recordCommit(state, task.lane, waitMs);
      committed += 1;
    }
    if (committed > 0 && this.frameQueue.size > 0 && this.yieldFrameBetweenTasks) {
      this.yieldNextFrame = true;
    }
    this.scheduleFrame();
  }

  private scheduleDrain(): void {
    if (this.disposed) return;
    queueMicrotask(() => this.drain());
  }

  private drain(): void {
    while (!this.disposed && this.activeAsync < this.maxConcurrent && this.asyncQueue.length > 0) {
      const index = this.selectNextAsyncTask();
      if (index < 0) return;
      const task = this.asyncQueue.splice(index, 1)[0];
      if (!task) return;
      const state = this.ensureCell(task.cellId);
      this.incrementPending(state, task.lane, -1);
      if (
        (state.diagnostics.tier === "hidden" || state.diagnostics.tier === "minimized")
        && (task.lane === "indicator-range" || task.lane === "prefetch")
      ) {
        state.diagnostics.dropped += 1;
        task.reject(new ChartWorkDroppedError(`${task.lane} is disabled for ${state.diagnostics.tier} Cell`));
        continue;
      }
      const waitMs = Math.max(0, this.now() - task.createdAt);
      this.activeAsync += 1;
      if (task.lane === "active-hydration") this.activeHydration += 1;
      this.lastServedCell.set(this.priorityKey(task), task.cellId);
      let appLease: unknown = null;
      void Promise.resolve()
        .then(async () => {
          appLease = await this.appBudget?.acquire(task.cellId, task.lane) ?? null;
          return task.run();
        })
        .then(task.resolve, task.reject)
        .finally(() => {
          this.appBudget?.release(appLease);
          this.activeAsync -= 1;
          if (task.lane === "active-hydration") this.activeHydration -= 1;
          if (!this.disposed) this.recordCommit(state, task.lane, waitMs);
          this.drain();
        });
    }
  }

  private priorityKey(task: AsyncTask): string {
    return `${TIER_ORDER[this.tier(task.cellId)]}:${LANE_ORDER[task.lane]}`;
  }

  private selectNextAsyncTask(): number {
    const eligible = this.asyncQueue
      .map((task, index) => ({ index, task }))
      .filter(({ task }) => (
        task.lane !== "active-hydration"
        || this.activeHydration < this.maxConcurrentHydration
      ));
    if (eligible.length === 0) return -1;
    let bestTier = Number.POSITIVE_INFINITY;
    let bestLane = Number.POSITIVE_INFINITY;
    for (const { task } of eligible) {
      const tier = TIER_ORDER[this.tier(task.cellId)];
      const lane = LANE_ORDER[task.lane];
      if (tier < bestTier || (tier === bestTier && lane < bestLane)) {
        bestTier = tier;
        bestLane = lane;
      }
    }
    const candidates = eligible
      .filter(({ task }) => (
        TIER_ORDER[this.tier(task.cellId)] === bestTier
        && LANE_ORDER[task.lane] === bestLane
      ));
    const key = `${bestTier}:${bestLane}`;
    const lastCell = this.lastServedCell.get(key);
    if (!lastCell) return candidates[0]?.index ?? 0;
    const cells = [...this.cells.keys()];
    const lastIndex = cells.indexOf(lastCell);
    for (let offset = 1; offset <= cells.length; offset += 1) {
      const nextCell = cells[(Math.max(-1, lastIndex) + offset) % cells.length];
      const candidate = candidates.find(({ task }) => task.cellId === nextCell);
      if (candidate) return candidate.index;
    }
    return candidates[0]?.index ?? 0;
  }
}
