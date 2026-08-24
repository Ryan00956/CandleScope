export const CHART_STRATEGY_AUTO_RUN_DEBOUNCE_MS = 600;
export const CHART_STRATEGY_AUTO_RUN_WORKSPACE_CONCURRENCY = 2;

export type ChartStrategyAutoRunPauseReason =
  | "FLAG_DISABLED"
  | "USER_DISABLED"
  | "WAITING_DEBOUNCE"
  | "WORKSPACE_QUEUE"
  | "PRECISE_REQUIRES_MANUAL"
  | "NEEDS_DATA_CONFIRMATION"
  | "UNSUPPORTED_CONTEXT"
  | "BACKEND_BUSY"
  | "DRAFT_UNAVAILABLE";

export interface ChartStrategyAutoRunContext {
  sessionKey: string;
  attachmentKey: string | null;
  enabled: boolean;
}

export function shouldScheduleChartStrategyAutoRun(
  previous: ChartStrategyAutoRunContext | null,
  next: ChartStrategyAutoRunContext,
): boolean {
  if (previous === null || next.attachmentKey === null || !next.enabled) return false;
  return previous.sessionKey !== next.sessionKey
    || previous.attachmentKey !== next.attachmentKey
    || (!previous.enabled && next.enabled);
}

export interface ChartStrategyAutoRunJob {
  workspaceId: string;
  cellScope: string;
  generation: number;
  execute(): Promise<void>;
  onQueueState?(state: "QUEUED" | "RUNNING"): void;
}

export interface ChartStrategyAutoRunCoordinatorDiagnostics {
  maxConcurrentPerWorkspace: number;
  workspaces: Array<{
    workspaceId: string;
    active: Array<{ cellScope: string; generation: number }>;
    pending: Array<{ cellScope: string; generation: number }>;
    maxObservedActive: number;
  }>;
}

interface WorkspaceQueue {
  active: Map<string, ChartStrategyAutoRunJob>;
  pending: Map<string, ChartStrategyAutoRunJob>;
  maxObservedActive: number;
}

export class ChartStrategyAutoRunCoordinator {
  private readonly workspaces = new Map<string, WorkspaceQueue>();

  constructor(
    private readonly maxConcurrentPerWorkspace = CHART_STRATEGY_AUTO_RUN_WORKSPACE_CONCURRENCY,
  ) {
    if (!Number.isSafeInteger(maxConcurrentPerWorkspace) || maxConcurrentPerWorkspace < 1) {
      throw new TypeError("auto-run workspace concurrency must be a positive integer");
    }
  }

  enqueue(job: ChartStrategyAutoRunJob): "QUEUED" | "RUNNING" {
    const queue = this.workspace(job.workspaceId);
    queue.pending.set(job.cellScope, job);
    if (queue.active.has(job.cellScope) || queue.active.size >= this.maxConcurrentPerWorkspace) {
      job.onQueueState?.("QUEUED");
      return "QUEUED";
    }
    this.startNext(job.workspaceId, job.cellScope);
    return "RUNNING";
  }

  cancelPending(workspaceId: string, cellScope: string): boolean {
    const queue = this.workspaces.get(workspaceId);
    if (!queue) return false;
    const removed = queue.pending.delete(cellScope);
    this.dropEmptyWorkspace(workspaceId, queue);
    return removed;
  }

  releaseScope(workspaceId: string, cellScope: string): void {
    this.cancelPending(workspaceId, cellScope);
  }

  releaseWorkspace(workspaceId: string): void {
    const queue = this.workspaces.get(workspaceId);
    if (!queue) return;
    queue.pending.clear();
    this.dropEmptyWorkspace(workspaceId, queue);
  }

  diagnostics(): ChartStrategyAutoRunCoordinatorDiagnostics {
    return {
      maxConcurrentPerWorkspace: this.maxConcurrentPerWorkspace,
      workspaces: [...this.workspaces.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([workspaceId, queue]) => ({
          workspaceId,
          active: [...queue.active.values()]
            .map(({ cellScope, generation }) => ({ cellScope, generation }))
            .sort((left, right) => left.cellScope.localeCompare(right.cellScope)),
          pending: [...queue.pending.values()]
            .map(({ cellScope, generation }) => ({ cellScope, generation }))
            .sort((left, right) => left.cellScope.localeCompare(right.cellScope)),
          maxObservedActive: queue.maxObservedActive,
        })),
    };
  }

  private workspace(workspaceId: string): WorkspaceQueue {
    const existing = this.workspaces.get(workspaceId);
    if (existing) return existing;
    const created: WorkspaceQueue = {
      active: new Map(),
      pending: new Map(),
      maxObservedActive: 0,
    };
    this.workspaces.set(workspaceId, created);
    return created;
  }

  private startNext(workspaceId: string, preferredScope?: string): void {
    const queue = this.workspaces.get(workspaceId);
    if (!queue || queue.active.size >= this.maxConcurrentPerWorkspace) return;
    const scope = preferredScope && queue.pending.has(preferredScope)
      ? preferredScope
      : queue.pending.keys().next().value as string | undefined;
    if (!scope || queue.active.has(scope)) return;
    const job = queue.pending.get(scope);
    if (!job) return;
    queue.pending.delete(scope);
    queue.active.set(scope, job);
    queue.maxObservedActive = Math.max(queue.maxObservedActive, queue.active.size);
    job.onQueueState?.("RUNNING");
    void Promise.resolve()
      .then(() => job.execute())
      .catch(() => undefined)
      .finally(() => {
        const current = queue.active.get(scope);
        if (current === job) queue.active.delete(scope);
        while (queue.active.size < this.maxConcurrentPerWorkspace && queue.pending.size > 0) {
          const before = queue.active.size;
          this.startNext(workspaceId);
          if (queue.active.size === before) break;
        }
        this.dropEmptyWorkspace(workspaceId, queue);
      });
    if (queue.active.size < this.maxConcurrentPerWorkspace && queue.pending.size > 0) {
      this.startNext(workspaceId);
    }
  }

  private dropEmptyWorkspace(workspaceId: string, queue: WorkspaceQueue): void {
    if (queue.active.size === 0 && queue.pending.size === 0) this.workspaces.delete(workspaceId);
  }
}

export const chartStrategyAutoRunCoordinator = new ChartStrategyAutoRunCoordinator();
