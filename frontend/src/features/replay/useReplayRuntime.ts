import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { MarketDataRuntimeContract } from "../market-data/marketDataRuntimeContract.js";
import type { ReplayEntry } from "./replayEntry.js";
import { defaultReplayApi, ReplayApiError } from "./replayApi.js";
import type { ReplayApiClient } from "./replayApi.js";
import { ReplayStore } from "./replayStore.js";
import type { ReplayConnectionState, ReplayStoreError, ReplayStoreSnapshot } from "./replayStore.js";
import { ReplayStreamController, ReplayStreamError } from "./replayStreamController.js";
import type { ReplayStreamControllerOptions, ReplayStreamState } from "./replayStreamController.js";
import type { ReplayCapabilities, ReplaySessionSnapshot } from "./replayTypes.js";

export type ReplayRuntimePhase =
  | "IDLE"
  | "ENTRY_ERROR"
  | "LOADING_CAPABILITIES"
  | "CONFIGURING"
  | "VALIDATING_SESSION"
  | "CONNECTING_SESSION"
  | "ACTIVE"
  | "ERROR"
  | "STOPPED";

export interface ReplayRuntimeError {
  readonly code: string;
  readonly message: string;
}

export interface ReplayRuntimeSnapshot {
  readonly phase: ReplayRuntimePhase;
  readonly capabilities: ReplayCapabilities | null;
  readonly error: ReplayRuntimeError | null;
  readonly sessionId: string | null;
  readonly store: ReplayStoreSnapshot;
}

interface ReplayApiBoundary {
  capabilities(signal?: AbortSignal): ReturnType<ReplayApiClient["capabilities"]>;
  getSession(sessionId: string, signal?: AbortSignal): ReturnType<ReplayApiClient["getSession"]>;
}

interface ReplayStreamBoundary {
  start(): void;
  stop(): void;
  requestResync(reason?: string): void;
}

export interface ReplayRuntimeLifecycleOptions {
  entry: ReplayEntry;
  api?: ReplayApiBoundary;
  store?: ReplayStore;
  streamFactory?: (options: ReplayStreamControllerOptions) => ReplayStreamBoundary;
}

type Listener = () => void;

function runtimeError(error: unknown): ReplayRuntimeError {
  if (error instanceof ReplayApiError || error instanceof ReplayStreamError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) return { code: "REPLAY_RUNTIME_ERROR", message: error.message };
  return { code: "REPLAY_RUNTIME_ERROR", message: "Unknown replay runtime failure" };
}

function connectionState(state: ReplayStreamState): ReplayConnectionState {
  return state;
}

export class ReplayRuntimeLifecycle {
  readonly store: ReplayStore;
  private readonly entry: ReplayEntry;
  private readonly api: ReplayApiBoundary;
  private readonly streamFactory: (options: ReplayStreamControllerOptions) => ReplayStreamBoundary;
  private readonly listeners = new Set<Listener>();
  private readonly unsubscribeStore: () => void;
  private phase: ReplayRuntimePhase = "IDLE";
  private capabilities: ReplayCapabilities | null = null;
  private error: ReplayRuntimeError | null = null;
  private sessionId: string | null = null;
  private stream: ReplayStreamBoundary | null = null;
  private abortController: AbortController | null = null;
  private runToken = 0;
  private started = false;
  private disposed = false;
  private snapshot: ReplayRuntimeSnapshot;

  constructor({
    entry,
    api = defaultReplayApi,
    store = new ReplayStore(),
    streamFactory = (options) => new ReplayStreamController(options),
  }: ReplayRuntimeLifecycleOptions) {
    this.entry = entry;
    this.api = api;
    this.store = store;
    this.streamFactory = streamFactory;
    this.snapshot = this.buildSnapshot();
    this.unsubscribeStore = this.store.subscribe(() => this.publish());
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ReplayRuntimeSnapshot => this.snapshot;

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    void this.run();
  }

  restart(): void {
    if (this.disposed) return;
    this.stopCurrentRun();
    this.started = true;
    this.error = null;
    void this.run();
  }

  requestResync(reason?: string): void {
    this.stream?.requestResync(reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopCurrentRun();
    this.phase = "STOPPED";
    this.unsubscribeStore();
    this.store.dispose();
    this.publish();
    this.listeners.clear();
  }

  private async run(): Promise<void> {
    const token = this.runToken + 1;
    this.runToken = token;
    if (this.entry.kind === "error") {
      this.phase = "ENTRY_ERROR";
      this.error = { code: this.entry.code, message: this.entry.message };
      this.publish();
      return;
    }
    const abortController = new AbortController();
    this.abortController = abortController;
    this.phase = "LOADING_CAPABILITIES";
    this.error = null;
    this.publish();
    try {
      const capabilities = await this.api.capabilities(abortController.signal);
      if (!this.isCurrent(token)) return;
      this.capabilities = capabilities;
      if (!capabilities.enabled || !capabilities.available) {
        this.fail({
          code: capabilities.reason ?? (capabilities.persistence.degraded ? "PERSISTENCE_DEGRADED" : "REPLAY_DISABLED"),
          message: capabilities.persistence.degraded_reason ?? "K-line replay is unavailable",
        });
        return;
      }
      if (this.entry.kind === "configure") {
        this.phase = "CONFIGURING";
        this.publish();
        return;
      }

      this.sessionId = this.entry.sessionId;
      this.phase = "VALIDATING_SESSION";
      this.publish();
      // This HTTP snapshot is validation only. It is deliberately never
      // published; the WebSocket atomic snapshot is the first chart truth.
      const response = await this.api.getSession(this.entry.sessionId, abortController.signal);
      if (!this.isCurrent(token)) return;
      this.phase = "CONNECTING_SESSION";
      this.publish();
      this.stream = this.createStream(response.snapshot, token);
      this.stream.start();
    } catch (error) {
      if (!this.isCurrent(token) || (error instanceof DOMException && error.name === "AbortError")) return;
      this.fail(runtimeError(error));
    }
  }

  private createStream(validationSnapshot: ReplaySessionSnapshot, token: number): ReplayStreamBoundary {
    const generationMap = new Map<number, number>();
    const mappedGeneration = (localGeneration: number): number | null => (
      generationMap.get(localGeneration) ?? null
    );
    return this.streamFactory({
      sessionId: validationSnapshot.session_id,
      initialDataEpoch: validationSnapshot.data_epoch,
      onGeneration: ({ generation, reason, resetAuthoritativeState }) => {
        if (!this.isCurrent(token)) return;
        const globalGeneration = this.store.getSnapshot().generation + 1;
        generationMap.set(generation, globalGeneration);
        this.store.beginGeneration(globalGeneration, {
          resetAuthoritativeState,
          connectionState: reason === "resync" ? "resyncing" : reason === "reconnect" ? "reconnecting" : "connecting",
        });
      },
      onState: (state, generation) => {
        if (!this.isCurrent(token)) return;
        const globalGeneration = mappedGeneration(generation);
        if (globalGeneration !== null) this.store.setConnectionState(globalGeneration, connectionState(state));
      },
      onSnapshot: (snapshot, generation) => {
        const globalGeneration = mappedGeneration(generation);
        if (!this.isCurrent(token)
          || globalGeneration === null
          || !this.store.applyAtomicSnapshot(globalGeneration, snapshot)) return;
        this.phase = "ACTIVE";
        this.error = null;
        this.publish();
      },
      onEvent: (event, generation) => {
        if (!this.isCurrent(token)) return;
        const globalGeneration = mappedGeneration(generation);
        if (globalGeneration === null) return;
        this.store.clearError(globalGeneration);
        this.store.applyEvent(globalGeneration, event);
      },
      onError: (error, generation) => {
        if (!this.isCurrent(token)) return;
        const globalGeneration = mappedGeneration(generation);
        if (globalGeneration === null) return;
        const view = runtimeError(error);
        this.store.setError(globalGeneration, view as ReplayStoreError);
        if (error.fatal) this.fail(view);
      },
    });
  }

  private fail(error: ReplayRuntimeError): void {
    this.error = error;
    this.phase = "ERROR";
    this.publish();
  }

  private stopCurrentRun(): void {
    this.runToken += 1;
    this.started = false;
    this.abortController?.abort();
    this.abortController = null;
    this.stream?.stop();
    this.stream = null;
  }

  private isCurrent(token: number): boolean {
    return !this.disposed && token === this.runToken;
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): ReplayRuntimeSnapshot {
    return {
      phase: this.phase,
      capabilities: this.capabilities,
      error: this.error,
      sessionId: this.sessionId,
      store: this.store.getSnapshot(),
    };
  }
}

function buildReplayMarketDataRuntime(
  snapshot: ReplayRuntimeSnapshot,
  lifecycle: ReplayRuntimeLifecycle,
): MarketDataRuntimeContract {
  const store = lifecycle.store;
  const lastPrice = snapshot.store.lastPrice;
  const displayData = lastPrice?.open !== undefined
    && lastPrice.high !== undefined
    && lastPrice.low !== undefined
    && lastPrice.close !== undefined
    ? {
        time: lastPrice.time,
        open: lastPrice.open,
        high: lastPrice.high,
        low: lastPrice.low,
        close: lastPrice.close,
        ...(lastPrice.volume === undefined ? {} : { volume: lastPrice.volume }),
      }
    : null;
  const priceChange = displayData?.open
    ? ((displayData.close - displayData.open) / displayData.open) * 100
    : 0;
  const wsStatus = snapshot.store.connectionState === "connected"
    ? "live"
    : snapshot.store.connectionState === "reconnecting" || snapshot.store.connectionState === "resyncing"
      ? "reconnecting"
      : snapshot.store.connectionState === "connecting"
        ? "connecting"
        : "disconnected";
  return {
    view: {
      bars: store.seriesStore.snapshot(),
      seriesStore: store.seriesStore,
      meta: {
        version: snapshot.store.renderRevision,
        status: snapshot.store.hasAuthoritativeSnapshot ? "ready" : "loading",
        source: "replay",
        seriesKey: store.seriesStore.seriesKey,
        ...(snapshot.store.sessionConfig
          ? {
              symbol: snapshot.store.sessionConfig.symbol,
              interval: snapshot.store.sessionConfig.display_interval,
            }
          : {}),
        bars: store.seriesStore.barCount,
        firstTime: store.seriesStore.first()?.time ?? null,
        lastTime: store.seriesStore.last()?.time ?? null,
        committedAt: snapshot.store.virtualTimeMs,
        dataRevision: store.seriesStore.version,
      },
      loading: !["ACTIVE", "CONFIGURING", "ERROR", "ENTRY_ERROR"].includes(snapshot.phase),
      error: snapshot.error,
      crosshairData: null,
      lastPrice,
      connectionStatus: snapshot.store.connectionState,
      dataSource: "replay",
      wsStatus,
      display: {
        displayData,
        priceChange,
        isUp: priceChange >= 0,
        amplitude: displayData?.open
          ? (((displayData.high - displayData.low) / displayData.open) * 100).toFixed(2)
          : "0.00",
        wsStatusLabel: snapshot.store.connectionState === "connected" ? "Replay stream" : "Replay disconnected",
        exchangeLabel: snapshot.store.sessionConfig?.exchange ?? "Replay",
        marketLabel: snapshot.store.sessionConfig?.market_type ?? "Historical",
      },
    },
    actions: {
      retry: () => lifecycle.restart(),
      loadMoreLeft: async () => undefined,
      onCrosshairMove: (value) => store.setCrosshairData(value),
      onVisibleRangeChange: () => store.markVisibleRangePending(),
      consumeIndicatorRangeRequest: (requestId) => store.consumeIndicatorRequest(requestId),
    },
    status: {
      hasMoreLeft: false,
      loadingMoreLeft: false,
      activeChartReady: snapshot.store.hasAuthoritativeSnapshot && store.seriesStore.barCount > 0,
      canLoadMoreLeft: false,
      barCount: store.seriesStore.barCount,
      cacheDiagnostics: () => ({
        owner: "replay",
        sessionId: snapshot.store.sessionId,
        dataEpoch: snapshot.store.dataEpoch,
        seriesKey: store.seriesStore.seriesKey,
        bars: store.seriesStore.barCount,
      }),
      trimCacheEntries: () => ({ owner: "replay", removedCount: 0 }),
      indicatorRangeRequests: [],
    },
  };
}

export interface ReplayRuntime extends ReplayRuntimeSnapshot {
  readonly lifecycle: ReplayRuntimeLifecycle;
  readonly replayStore: ReplayStore;
  readonly marketData: MarketDataRuntimeContract;
  readonly actions: {
    retry(): void;
    requestResync(reason?: string): void;
  };
}

export interface ReplayLifecycleLease {
  start(): void;
  dispose(): void;
}

/**
 * React development StrictMode deliberately runs an effect as
 * setup -> cleanup -> setup. ReplayRuntimeLifecycle disposal is terminal, so
 * defer the terminal cleanup by one microtask and cancel it only when the same
 * lifecycle instance is immediately leased again. Different instances retain
 * independent pending disposals and cannot keep an obsolete runtime alive.
 */
export class ReplayLifecycleEffectGuard {
  private readonly pendingDisposals = new Map<ReplayLifecycleLease, symbol>();

  mount(lifecycle: ReplayLifecycleLease): () => void {
    this.pendingDisposals.delete(lifecycle);
    lifecycle.start();
    return () => {
      const token = Symbol("replay-lifecycle-dispose");
      this.pendingDisposals.set(lifecycle, token);
      queueMicrotask(() => {
        if (this.pendingDisposals.get(lifecycle) !== token) return;
        this.pendingDisposals.delete(lifecycle);
        lifecycle.dispose();
      });
    };
  }
}

export function useReplayRuntime(
  entry: ReplayEntry,
  {
    api,
    store,
    streamFactory,
  }: Omit<ReplayRuntimeLifecycleOptions, "entry"> = {},
): ReplayRuntime {
  const lifecycle = useMemo(() => new ReplayRuntimeLifecycle({
    entry,
    ...(api === undefined ? {} : { api }),
    ...(store === undefined ? {} : { store }),
    ...(streamFactory === undefined ? {} : { streamFactory }),
  }), [api, entry, store, streamFactory]);
  const lifecycleEffectGuard = useMemo(() => new ReplayLifecycleEffectGuard(), []);
  useEffect(
    () => lifecycleEffectGuard.mount(lifecycle),
    [lifecycle, lifecycleEffectGuard],
  );
  const snapshot = useSyncExternalStore(lifecycle.subscribe, lifecycle.getSnapshot, lifecycle.getSnapshot);
  const marketData = useMemo(
    () => buildReplayMarketDataRuntime(snapshot, lifecycle),
    [lifecycle, snapshot],
  );
  return useMemo(() => ({
    ...snapshot,
    lifecycle,
    replayStore: lifecycle.store,
    marketData,
    actions: {
      retry: () => lifecycle.restart(),
      requestResync: (reason?: string) => lifecycle.requestResync(reason),
    },
  }), [lifecycle, marketData, snapshot]);
}
