import type { ChartSession } from "../../chart-session/chartSessionTypes.js";
import type { ChartStrategyAttachmentRecord } from "../../chart-workspace/chartWorkspaceTypes.js";
import {
  createChartStrategyTesterState,
  currentChartStrategyTesterToken,
  reduceChartStrategyTesterState,
  type ChartStrategyTesterEvent,
  type ChartStrategyTesterGenerationToken,
  type ChartStrategyTesterInputs,
  type ChartStrategyTesterState,
} from "./chartStrategyTesterState.js";

export interface ChartStrategyTesterMarkerSource {
  clear?(): void;
  dispose?(): void;
}

export interface ChartStrategyTesterRuntimeDiagnostics {
  disposed: boolean;
  timers: number;
  abortControllers: number;
  cleanups: number;
  hasMarkerSource: boolean;
  hasResultReference: boolean;
}

type Listener = (state: ChartStrategyTesterState) => void;

export class ChartStrategyTesterRuntime {
  private state: ChartStrategyTesterState;
  private readonly listeners = new Set<Listener>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly abortControllers = new Set<AbortController>();
  private readonly cleanups = new Set<() => void>();
  private markerSource: ChartStrategyTesterMarkerSource | null = null;
  private resultReference: unknown = null;
  private disposed = false;

  constructor(
    readonly cellScope: string,
    inputs: ChartStrategyTesterInputs | null,
  ) {
    this.state = createChartStrategyTesterState(inputs, cellScope);
  }

  snapshot(): ChartStrategyTesterState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispatch(event: ChartStrategyTesterEvent): ChartStrategyTesterState {
    if (this.disposed) return this.state;
    const next = reduceChartStrategyTesterState(this.state, event);
    if (next === this.state) return this.state;
    this.state = next;
    this.listeners.forEach((listener) => listener(next));
    return next;
  }

  syncInputs(inputs: ChartStrategyTesterInputs | null): ChartStrategyTesterState {
    return this.dispatch({ type: "SYNC_INPUTS", inputs });
  }

  beginRequest(
    status: "RESOLVING" | "QUEUED" | "RUNNING" = "RESOLVING",
  ): ChartStrategyTesterGenerationToken {
    this.dispatch({ type: "BEGIN_REQUEST", status });
    return currentChartStrategyTesterToken(this.state);
  }

  trackTimer(timer: ReturnType<typeof setTimeout>): () => void {
    if (this.disposed) {
      clearTimeout(timer);
      return () => undefined;
    }
    this.timers.add(timer);
    return () => {
      clearTimeout(timer);
      this.timers.delete(timer);
    };
  }

  trackAbortController(controller: AbortController): () => void {
    if (this.disposed) {
      controller.abort();
      return () => undefined;
    }
    this.abortControllers.add(controller);
    return () => this.abortControllers.delete(controller);
  }

  trackCleanup(cleanup: () => void): () => void {
    if (this.disposed) {
      cleanup();
      return () => undefined;
    }
    this.cleanups.add(cleanup);
    return () => this.cleanups.delete(cleanup);
  }

  setMarkerSource(source: ChartStrategyTesterMarkerSource | null): void {
    if (this.markerSource === source) return;
    this.markerSource?.clear?.();
    this.markerSource?.dispose?.();
    this.markerSource = source;
  }

  setResultReference(reference: unknown): void {
    this.resultReference = reference;
  }

  diagnostics(): ChartStrategyTesterRuntimeDiagnostics {
    return {
      disposed: this.disposed,
      timers: this.timers.size,
      abortControllers: this.abortControllers.size,
      cleanups: this.cleanups.size,
      hasMarkerSource: this.markerSource !== null,
      hasResultReference: this.resultReference !== null,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.timers.forEach((timer) => clearTimeout(timer));
    this.abortControllers.forEach((controller) => controller.abort());
    this.cleanups.forEach((cleanup) => cleanup());
    this.markerSource?.clear?.();
    this.markerSource?.dispose?.();
    this.timers.clear();
    this.abortControllers.clear();
    this.cleanups.clear();
    this.markerSource = null;
    this.resultReference = null;
    this.listeners.clear();
    this.state = reduceChartStrategyTesterState(this.state, { type: "DETACH" });
  }
}

export interface ActivateChartStrategyTesterRuntime {
  workspaceId: string;
  cellId: string;
  attachment: ChartStrategyAttachmentRecord | null;
  session: ChartSession;
  draftContentRevision: number | null;
  editorOpen?: boolean;
}

export interface ChartStrategyTesterFactoryDiagnostics {
  enabled: boolean;
  activeInstances: number;
  createdInstances: number;
  disposedInstances: number;
  scopes: string[];
}

export function chartStrategyTesterCellScope(workspaceId: string, cellId: string): string {
  return `${workspaceId}\u0000${cellId}`;
}

export class ChartStrategyTesterRuntimeFactory {
  private readonly runtimes = new Map<string, ChartStrategyTesterRuntime>();
  private createdInstances = 0;
  private disposedInstances = 0;

  constructor(private enabled = false) {}

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.dispose();
  }

  activate(input: ActivateChartStrategyTesterRuntime): ChartStrategyTesterRuntime | null {
    const scope = chartStrategyTesterCellScope(input.workspaceId, input.cellId);
    if (!this.enabled) return null;
    if (!input.attachment && input.editorOpen !== true) {
      this.releaseScope(scope);
      return null;
    }
    const inputs = input.attachment ? {
      session: input.session,
      attachment: input.attachment,
      draftContentRevision: input.draftContentRevision,
    } : null;
    const existing = this.runtimes.get(scope);
    if (existing) {
      existing.syncInputs(inputs);
      return existing;
    }
    const runtime = new ChartStrategyTesterRuntime(scope, inputs);
    this.runtimes.set(scope, runtime);
    this.createdInstances += 1;
    return runtime;
  }

  get(workspaceId: string, cellId: string): ChartStrategyTesterRuntime | null {
    return this.runtimes.get(chartStrategyTesterCellScope(workspaceId, cellId)) ?? null;
  }

  release(workspaceId: string, cellId: string): void {
    this.releaseScope(chartStrategyTesterCellScope(workspaceId, cellId));
  }

  reconcileActiveScopes(activeScopes: ReadonlySet<string>): void {
    for (const scope of this.runtimes.keys()) {
      if (!activeScopes.has(scope)) this.releaseScope(scope);
    }
  }

  releaseWorkspace(workspaceId: string): void {
    const prefix = `${workspaceId}\u0000`;
    for (const scope of this.runtimes.keys()) {
      if (scope.startsWith(prefix)) this.releaseScope(scope);
    }
  }

  diagnostics(): ChartStrategyTesterFactoryDiagnostics {
    return {
      enabled: this.enabled,
      activeInstances: this.runtimes.size,
      createdInstances: this.createdInstances,
      disposedInstances: this.disposedInstances,
      scopes: [...this.runtimes.keys()].sort(),
    };
  }

  dispose(): void {
    for (const scope of [...this.runtimes.keys()]) this.releaseScope(scope);
  }

  private releaseScope(scope: string): void {
    const runtime = this.runtimes.get(scope);
    if (!runtime) return;
    this.runtimes.delete(scope);
    runtime.dispose();
    this.disposedInstances += 1;
  }
}
