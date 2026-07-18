import { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import { applyReplayBarUpdate, latestReplayBar, replaceReplaySeriesFromSnapshot } from "./replaySeriesProjection.js";
import type { KlineBar } from "../market-data/marketDataTypes.js";
import type {
  ReplayAccount,
  ReplayClosedTrade,
  ReplayDigest,
  ReplayFill,
  ReplayJournalEntry,
  ReplayOrder,
  ReplayParsedEvent,
  ReplayPosition,
  ReplayProjection,
  ReplaySessionSnapshot,
  ReplaySessionConfig,
  ReplaySessionState,
  ReplaySpeed,
  ReplayWarning,
} from "./replayTypes.js";

export type ReplayConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "resyncing" | "closed" | "error";

export interface ReplayStoreError {
  readonly code: string;
  readonly message: string;
}

export interface ReplayStoreSnapshot {
  readonly renderRevision: number;
  readonly uiFlushCount: number;
  readonly generation: number;
  readonly connectionState: ReplayConnectionState;
  readonly hasAuthoritativeSnapshot: boolean;
  readonly sessionId: string | null;
  readonly sessionConfig: ReplaySessionConfig | null;
  readonly state: ReplaySessionState | null;
  readonly statusReason: string | null;
  readonly revision: number;
  readonly sequence: number;
  readonly sourceSequence: number;
  readonly virtualTimeMs: number | null;
  readonly stateHash: ReplayDigest | null;
  readonly dataEpoch: ReplayDigest | null;
  readonly speed: ReplaySpeed | null;
  readonly controllerClientId: string | null;
  readonly cursorAtEnd: boolean;
  readonly replayStartMs: number | null;
  readonly revealed: boolean;
  readonly orders: readonly ReplayOrder[];
  readonly fills: readonly ReplayFill[];
  readonly closedTrades: readonly ReplayClosedTrade[];
  readonly warnings: readonly ReplayWarning[];
  readonly position: ReplayPosition | null;
  readonly account: ReplayAccount | null;
  readonly journal: readonly ReplayJournalEntry[];
  readonly lastPrice: KlineBar | null;
  readonly error: ReplayStoreError | null;
  readonly transientRevision: number;
}

export interface ReplayStoreScheduler {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface BeginReplayGenerationOptions {
  resetAuthoritativeState: boolean;
  connectionState: ReplayConnectionState;
}

type StoreListener = () => void;

const defaultScheduler: ReplayStoreScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

function projectionFromEvent(event: ReplayParsedEvent): ReplayProjection | null {
  const data = event.data as { projection?: ReplayProjection };
  return data.projection ?? null;
}

export class ReplayStore {
  readonly seriesStore: SeriesWindowStore;
  private readonly scheduler: ReplayStoreScheduler;
  private readonly listeners = new Set<StoreListener>();
  private pendingFlush: ReturnType<typeof setTimeout> | null = null;
  private renderRevision = 0;
  private uiFlushCount = 0;
  private generation = 0;
  private connectionState: ReplayConnectionState = "idle";
  private hasAuthoritativeSnapshot = false;
  private sessionId: string | null = null;
  private sessionConfig: ReplaySessionConfig | null = null;
  private state: ReplaySessionState | null = null;
  private statusReason: string | null = null;
  private revision = 0;
  private sequence = 0;
  private sourceSequence = 0;
  private virtualTimeMs: number | null = null;
  private stateHash: ReplayDigest | null = null;
  private dataEpoch: ReplayDigest | null = null;
  private speed: ReplaySpeed | null = null;
  private controllerClientId: string | null = null;
  private cursorAtEnd = false;
  private replayStartMs: number | null = null;
  private revealed = false;
  private ordersById = new Map<string, ReplayOrder>();
  private fillsById = new Map<string, ReplayFill>();
  private closedTradesById = new Map<string, ReplayClosedTrade>();
  private warningsById = new Map<string, ReplayWarning>();
  private position: ReplayPosition | null = null;
  private account: ReplayAccount | null = null;
  private journal: ReplayJournalEntry[] = [];
  private error: ReplayStoreError | null = null;
  private transientRevision = 0;
  private crosshairData: unknown | null = null;
  private visibleRangePending = false;
  private indicatorRequestIds = new Set<number>();
  private snapshot: ReplayStoreSnapshot;

  constructor({ scheduler = defaultScheduler, seriesStore = new SeriesWindowStore() }: {
    scheduler?: ReplayStoreScheduler;
    seriesStore?: SeriesWindowStore;
  } = {}) {
    this.scheduler = scheduler;
    this.seriesStore = seriesStore;
    this.snapshot = this.buildSnapshot();
  }

  subscribe = (listener: StoreListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ReplayStoreSnapshot => this.snapshot;

  beginGeneration(generation: number, options: BeginReplayGenerationOptions): void {
    if (!Number.isSafeInteger(generation) || generation <= this.generation) return;
    this.generation = generation;
    this.connectionState = options.connectionState;
    this.clearTransientState();
    this.error = null;
    if (options.resetAuthoritativeState) this.resetAuthoritativeState();
    this.flushNow();
  }

  setConnectionState(generation: number, state: ReplayConnectionState): void {
    if (generation !== this.generation) return;
    this.connectionState = state;
    this.flushNow();
  }

  applyAtomicSnapshot(generation: number, snapshot: ReplaySessionSnapshot): boolean {
    if (generation !== this.generation) return false;
    replaceReplaySeriesFromSnapshot(this.seriesStore, snapshot);
    this.hasAuthoritativeSnapshot = true;
    this.connectionState = "connected";
    this.sessionId = snapshot.session_id;
    this.sessionConfig = snapshot.config;
    this.state = snapshot.state;
    this.statusReason = snapshot.status_reason;
    this.revision = snapshot.revision;
    this.sequence = snapshot.sequence;
    this.sourceSequence = snapshot.cursor.source_sequence;
    this.virtualTimeMs = snapshot.cursor.virtual_time_ms;
    this.stateHash = snapshot.state_hash;
    this.dataEpoch = snapshot.data_epoch;
    this.speed = snapshot.speed;
    this.controllerClientId = snapshot.controller_client_id;
    this.cursorAtEnd = snapshot.cursor.at_end;
    this.replayStartMs = snapshot.components.bar_builder.replay_start_ms;
    this.revealed = snapshot.revealed;
    this.ordersById = new Map(snapshot.components.orders.map((order) => [order.order_id, order]));
    this.fillsById = new Map(snapshot.components.fills.map((fill) => [fill.fill_id, fill]));
    this.closedTradesById = new Map(snapshot.components.closed_trades.map((trade) => [trade.trade_id, trade]));
    this.warningsById = new Map(snapshot.components.warnings.map((warning) => [warning.warning_id, warning]));
    this.position = snapshot.components.position;
    this.account = snapshot.components.account;
    this.journal = [...snapshot.journal];
    this.error = null;
    this.flushNow();
    return true;
  }

  applyEvent(generation: number, event: ReplayParsedEvent): boolean {
    if (generation !== this.generation || !this.hasAuthoritativeSnapshot) return false;
    this.sessionId = event.session_id;
    this.revision = event.revision;
    this.sequence = event.sequence;
    this.virtualTimeMs = event.virtual_time_ms;
    this.stateHash = event.state_hash;
    this.dataEpoch = event.data_epoch;

    let mandatory = false;
    if (event.type === "replay.delta") {
      const data = event.data as { source_sequence: number; projection: ReplayProjection };
      this.sourceSequence = data.source_sequence;
      this.applyProjection(data.projection, event.virtual_time_ms);
      mandatory = data.projection.fills.length > 0;
    } else if (event.type === "replay.order") {
      const projection = projectionFromEvent(event);
      if (projection) this.applyProjection(projection, event.virtual_time_ms);
      mandatory = true;
    } else if (event.type === "replay.status") {
      const data = event.data as {
        state: ReplaySessionState;
        reason: string;
        speed: ReplaySpeed;
        controller_client_id: string | null;
      };
      this.state = data.state;
      this.statusReason = data.reason;
      this.speed = data.speed;
      this.controllerClientId = data.controller_client_id;
      if (data.reason === "history_revealed") this.revealed = true;
      mandatory = data.state === "PAUSED" || data.state === "ENDED" || data.state === "ERROR";
    } else if (event.type === "replay.journal") {
      const entry = event.data as ReplayJournalEntry;
      this.journal = [...this.journal.filter((item) => item.entry_id !== entry.entry_id), entry];
      mandatory = true;
    } else if (event.type === "replay.ended") {
      const projection = projectionFromEvent(event);
      if (projection) this.applyProjection(projection, event.virtual_time_ms);
      this.state = "ENDED";
      this.controllerClientId = null;
      this.cursorAtEnd = true;
      this.statusReason = (event.data as { reason: string }).reason;
      mandatory = true;
    }

    if (mandatory) this.flushNow();
    else this.scheduleUiFlush();
    return true;
  }

  setError(generation: number, error: ReplayStoreError): void {
    if (generation !== this.generation) return;
    this.connectionState = "error";
    this.error = error;
    this.flushNow();
  }

  clearError(generation: number): void {
    if (generation !== this.generation || this.error === null) return;
    this.error = null;
    this.flushNow();
  }

  replaceJournal(generation: number, entries: readonly ReplayJournalEntry[]): boolean {
    if (generation !== this.generation || !this.hasAuthoritativeSnapshot) return false;
    this.journal = [...entries];
    this.flushNow();
    return true;
  }

  setCrosshairData(value: unknown): void {
    this.crosshairData = value;
  }

  markVisibleRangePending(): void {
    this.visibleRangePending = true;
  }

  addIndicatorRequest(requestId: number): void {
    if (Number.isSafeInteger(requestId) && requestId >= 0) this.indicatorRequestIds.add(requestId);
  }

  consumeIndicatorRequest(requestId: number): void {
    this.indicatorRequestIds.delete(requestId);
  }

  transientDiagnostics(): Readonly<Record<string, unknown>> {
    return {
      crosshairPresent: this.crosshairData !== null,
      visibleRangePending: this.visibleRangePending,
      indicatorRequestCount: this.indicatorRequestIds.size,
      transientRevision: this.transientRevision,
    };
  }

  dispose(): void {
    this.cancelPendingFlush();
    this.listeners.clear();
    this.connectionState = "closed";
  }

  private applyProjection(projection: ReplayProjection, virtualTimeMs: number): void {
    if (projection.bar_update) {
      applyReplayBarUpdate(this.seriesStore, projection.bar_update, virtualTimeMs);
    }
    for (const order of projection.orders) this.ordersById.set(order.order_id, order);
    for (const fill of projection.fills) this.fillsById.set(fill.fill_id, fill);
    for (const warning of projection.warnings) this.warningsById.set(warning.warning_id, warning);
    this.position = projection.position;
    this.account = projection.account;
  }

  private clearTransientState(): void {
    this.crosshairData = null;
    this.visibleRangePending = false;
    this.indicatorRequestIds.clear();
    this.transientRevision += 1;
  }

  private resetAuthoritativeState(): void {
    this.cancelPendingFlush();
    this.hasAuthoritativeSnapshot = false;
    this.sessionId = null;
    this.sessionConfig = null;
    this.state = null;
    this.statusReason = null;
    this.revision = 0;
    this.sequence = 0;
    this.sourceSequence = 0;
    this.virtualTimeMs = null;
    this.stateHash = null;
    this.dataEpoch = null;
    this.speed = null;
    this.controllerClientId = null;
    this.cursorAtEnd = false;
    this.replayStartMs = null;
    this.revealed = false;
    this.ordersById.clear();
    this.fillsById.clear();
    this.closedTradesById.clear();
    this.warningsById.clear();
    this.position = null;
    this.account = null;
    this.journal = [];
    this.seriesStore.seriesKey = null;
    this.seriesStore.replace([], { source: "replay-generation-reset" });
  }

  private scheduleUiFlush(): void {
    if (this.pendingFlush !== null) return;
    this.pendingFlush = this.scheduler.setTimeout(() => {
      this.pendingFlush = null;
      this.publishSnapshot();
    }, 34);
  }

  private cancelPendingFlush(): void {
    if (this.pendingFlush === null) return;
    this.scheduler.clearTimeout(this.pendingFlush);
    this.pendingFlush = null;
  }

  private flushNow(): void {
    this.cancelPendingFlush();
    this.publishSnapshot();
  }

  private publishSnapshot(): void {
    this.renderRevision += 1;
    this.uiFlushCount += 1;
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): ReplayStoreSnapshot {
    return {
      renderRevision: this.renderRevision,
      uiFlushCount: this.uiFlushCount,
      generation: this.generation,
      connectionState: this.connectionState,
      hasAuthoritativeSnapshot: this.hasAuthoritativeSnapshot,
      sessionId: this.sessionId,
      sessionConfig: this.sessionConfig,
      state: this.state,
      statusReason: this.statusReason,
      revision: this.revision,
      sequence: this.sequence,
      sourceSequence: this.sourceSequence,
      virtualTimeMs: this.virtualTimeMs,
      stateHash: this.stateHash,
      dataEpoch: this.dataEpoch,
      speed: this.speed,
      controllerClientId: this.controllerClientId,
      cursorAtEnd: this.cursorAtEnd,
      replayStartMs: this.replayStartMs,
      revealed: this.revealed,
      orders: [...this.ordersById.values()].sort((left, right) => left.ordinal - right.ordinal),
      fills: [...this.fillsById.values()],
      closedTrades: [...this.closedTradesById.values()],
      warnings: [...this.warningsById.values()],
      position: this.position,
      account: this.account,
      journal: this.journal,
      lastPrice: latestReplayBar(this.seriesStore),
      error: this.error,
      transientRevision: this.transientRevision,
    };
  }
}
