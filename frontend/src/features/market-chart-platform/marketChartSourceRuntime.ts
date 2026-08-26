import type { ChartSession } from "../chart-session/chartSessionTypes.js";
import type { MarketDataRuntimeContract } from "../market-data/marketDataRuntimeContract.js";
import type { KlineBar, KlineBarInput } from "../market-data/marketDataTypes.js";
import { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";

export const MARKET_CHART_SOURCE_MODES = [
  "LIVE_REFERENCE",
  "FROZEN_SNAPSHOT",
  "RUN_RESULT",
] as const;

export type MarketChartSourceMode = typeof MARKET_CHART_SOURCE_MODES[number];
export type MarketChartSourceLifecycleState = "ACTIVE" | "PAUSED" | "DISPOSED";

export type MarketChartExecutionIdentity = Readonly<
  | {
      kind: "FROZEN_SNAPSHOT";
      datasetId: string;
      dataEpoch: string;
      snapshotHash: string;
    }
  | {
      kind: "RUN_RESULT";
      runId: string;
      configHash: string;
      reportHash: string;
      chartHash: string;
    }
>;

export interface MarketChartSourceDescription {
  mode: MarketChartSourceMode;
  sourceId: string;
  lifecycle: MarketChartSourceLifecycleState;
  session: ChartSession;
  datasetKey: string;
  bars: number;
  immutable: boolean;
  executionIdentity: MarketChartExecutionIdentity | null;
}

export interface MarketChartSourceRuntime {
  readonly mode: MarketChartSourceMode;
  readonly sourceId: string;
  readonly session: ChartSession;
  readonly datasetKey: string;
  readonly marketData: MarketDataRuntimeContract;
  readonly executionIdentity: MarketChartExecutionIdentity | null;
  readonly lifecycle: MarketChartSourceLifecycleState;
  pause(): void;
  resume(): void;
  dispose(): void;
  describe(): MarketChartSourceDescription;
}

export interface LiveReferenceSourceInput {
  sourceId: string;
  session: ChartSession;
  datasetKey: string;
  marketData: MarketDataRuntimeContract;
  onPause?(): void;
  onResume?(): void;
  onDispose?(): void;
}

export interface LiveReferenceMarketChartSourceRuntime extends MarketChartSourceRuntime {
  readonly mode: "LIVE_REFERENCE";
  readonly executionIdentity: null;
  update(input: Pick<LiveReferenceSourceInput, "session" | "datasetKey" | "marketData">): void;
}

export interface FrozenSnapshotSourceInput {
  sourceId?: string;
  session: ChartSession;
  datasetId: string;
  dataEpoch: string;
  snapshotHash: string;
  bars: readonly KlineBarInput[];
}

export interface RunResultSourceInput {
  sourceId?: string;
  session: ChartSession;
  runId: string;
  configHash: string;
  reportHash: string;
  chartHash: string;
  bars: readonly KlineBarInput[];
}

function requiredText(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 256) {
    throw new Error(`${field} must be a non-empty value no longer than 256 characters`);
  }
  return normalized;
}

function cloneSession(session: ChartSession): ChartSession {
  return { ...session };
}

function lastDisplayBar(rows: readonly KlineBar[]) {
  const row = rows.at(-1);
  if (!row) return null;
  return {
    time: row.time,
    open: Number(row.open ?? 0),
    high: Number(row.high ?? 0),
    low: Number(row.low ?? 0),
    close: Number(row.close ?? 0),
    volume: Number(row.volume ?? 0),
  };
}

function createStaticMarketData(
  source: string,
  session: ChartSession,
  rows: readonly KlineBarInput[],
): MarketDataRuntimeContract {
  const copiedRows = rows.map((row) => ({ ...row }));
  const store = new SeriesWindowStore({
    maxBars: Math.max(1, copiedRows.length),
    seriesKey: `${source}:${session.exchange}:${session.marketType}:${session.symbol}:${session.interval}`,
  });
  store.replace(copiedRows, { source });
  const bars = store.snapshot({ force: true });
  const firstTime = bars.at(0)?.time ?? null;
  const lastTime = bars.at(-1)?.time ?? null;
  const displayData = lastDisplayBar(bars);
  const view: MarketDataRuntimeContract["view"] = {
    bars,
    seriesStore: store,
    meta: {
      version: Number(store.version),
      status: "ready",
      source,
      seriesKey: store.seriesKey,
      symbol: session.symbol,
      interval: session.interval,
      bars: bars.length,
      firstTime,
      lastTime,
      coverage: { from: firstTime, to: lastTime, bars: bars.length },
      committedAt: Date.now(),
      historyComplete: true,
      historyRepairPending: false,
    },
    loading: false,
    error: null,
    crosshairData: null,
    lastPrice: bars.at(-1) ?? null,
    connectionStatus: "idle",
    dataSource: source,
    wsStatus: "idle",
    display: {
      displayData,
      priceChange: 0,
      isUp: true,
      amplitude: "0.00%",
      wsStatusLabel: source,
      exchangeLabel: session.exchange,
      marketLabel: session.marketType,
    },
  };
  return {
    view,
    actions: {
      retry() {},
      async loadMoreLeft() {},
      async loadMoreRight() { return false; },
      async restoreLatestWindow() { return false; },
      onCrosshairMove() {},
      onVisibleRangeChange() {},
      consumeIndicatorRangeRequest() {},
    },
    status: {
      hasMoreLeft: false,
      loadingMoreLeft: false,
      loadingMoreRight: false,
      initialHistoryPending: false,
      activeChartReady: bars.length > 0,
      canLoadMoreLeft: false,
      canLoadMoreRight: false,
      canRestoreLatestWindow: false,
      barCount: bars.length,
      cacheDiagnostics: () => ({ source, bars: view.bars.length }),
      trimCacheEntries: () => ({ source, removed: 0 }),
      indicatorRangeRequests: [],
      requestDemand: null,
    },
  };
}

class LiveReferenceSource implements LiveReferenceMarketChartSourceRuntime {
  readonly mode = "LIVE_REFERENCE" as const;
  readonly sourceId: string;
  readonly executionIdentity = null;
  private currentSession: ChartSession;
  private currentDatasetKey: string;
  private currentMarketData: MarketDataRuntimeContract;
  private state: MarketChartSourceLifecycleState = "ACTIVE";
  private readonly onPause: (() => void) | undefined;
  private readonly onResume: (() => void) | undefined;
  private readonly onDispose: (() => void) | undefined;

  constructor(input: LiveReferenceSourceInput) {
    this.sourceId = requiredText(input.sourceId, "sourceId");
    this.currentSession = cloneSession(input.session);
    this.currentDatasetKey = requiredText(input.datasetKey, "datasetKey");
    this.currentMarketData = input.marketData;
    this.onPause = input.onPause;
    this.onResume = input.onResume;
    this.onDispose = input.onDispose;
  }

  get session() { return this.currentSession; }
  get datasetKey() { return this.currentDatasetKey; }
  get marketData() { return this.currentMarketData; }
  get lifecycle() { return this.state; }

  update(input: Pick<LiveReferenceSourceInput, "session" | "datasetKey" | "marketData">) {
    if (this.state === "DISPOSED") throw new Error("cannot update a disposed market chart source");
    this.currentSession = cloneSession(input.session);
    this.currentDatasetKey = requiredText(input.datasetKey, "datasetKey");
    this.currentMarketData = input.marketData;
  }

  pause() {
    if (this.state !== "ACTIVE") return;
    this.state = "PAUSED";
    this.onPause?.();
  }

  resume() {
    if (this.state !== "PAUSED") return;
    this.state = "ACTIVE";
    this.onResume?.();
  }

  dispose() {
    if (this.state === "DISPOSED") return;
    this.state = "DISPOSED";
    this.onDispose?.();
  }

  describe(): MarketChartSourceDescription {
    return {
      mode: this.mode,
      sourceId: this.sourceId,
      lifecycle: this.state,
      session: cloneSession(this.currentSession),
      datasetKey: this.currentDatasetKey,
      bars: this.currentMarketData.status.barCount,
      immutable: false,
      executionIdentity: null,
    };
  }
}

class StaticMarketChartSource implements MarketChartSourceRuntime {
  readonly mode: "FROZEN_SNAPSHOT" | "RUN_RESULT";
  readonly sourceId: string;
  readonly session: ChartSession;
  readonly datasetKey: string;
  readonly executionIdentity: MarketChartExecutionIdentity;
  readonly marketData: MarketDataRuntimeContract;
  private state: MarketChartSourceLifecycleState = "ACTIVE";

  constructor(input: {
    mode: "FROZEN_SNAPSHOT" | "RUN_RESULT";
    sourceId: string;
    session: ChartSession;
    datasetKey: string;
    executionIdentity: MarketChartExecutionIdentity;
    bars: readonly KlineBarInput[];
  }) {
    this.mode = input.mode;
    this.sourceId = requiredText(input.sourceId, "sourceId");
    this.session = Object.freeze(cloneSession(input.session));
    this.datasetKey = requiredText(input.datasetKey, "datasetKey");
    this.executionIdentity = Object.freeze({ ...input.executionIdentity });
    this.marketData = createStaticMarketData(this.mode, this.session, input.bars);
  }

  get lifecycle() { return this.state; }

  pause() {
    if (this.state === "ACTIVE") this.state = "PAUSED";
  }

  resume() {
    if (this.state === "PAUSED") this.state = "ACTIVE";
  }

  dispose() {
    if (this.state === "DISPOSED") return;
    this.state = "DISPOSED";
    this.marketData.view.seriesStore?.clear({ source: `${this.mode}:dispose` });
    this.marketData.view.seriesStore = null;
    this.marketData.view.bars = [];
    this.marketData.view.lastPrice = null;
    this.marketData.status.barCount = 0;
    this.marketData.status.activeChartReady = false;
  }

  describe(): MarketChartSourceDescription {
    return {
      mode: this.mode,
      sourceId: this.sourceId,
      lifecycle: this.state,
      session: cloneSession(this.session),
      datasetKey: this.datasetKey,
      bars: this.marketData.status.barCount,
      immutable: true,
      executionIdentity: this.executionIdentity,
    };
  }
}

export function createLiveReferenceSource(
  input: LiveReferenceSourceInput,
): LiveReferenceMarketChartSourceRuntime {
  return new LiveReferenceSource(input);
}

export function createFrozenSnapshotSource(
  input: FrozenSnapshotSourceInput,
): MarketChartSourceRuntime {
  const datasetId = requiredText(input.datasetId, "datasetId");
  const dataEpoch = requiredText(input.dataEpoch, "dataEpoch");
  const snapshotHash = requiredText(input.snapshotHash, "snapshotHash");
  return new StaticMarketChartSource({
    mode: "FROZEN_SNAPSHOT",
    sourceId: input.sourceId ?? `snapshot:${snapshotHash}`,
    session: input.session,
    datasetKey: `${datasetId}:${dataEpoch}`,
    executionIdentity: { kind: "FROZEN_SNAPSHOT", datasetId, dataEpoch, snapshotHash },
    bars: input.bars,
  });
}

export function createRunResultSource(input: RunResultSourceInput): MarketChartSourceRuntime {
  const runId = requiredText(input.runId, "runId");
  const configHash = requiredText(input.configHash, "configHash");
  const reportHash = requiredText(input.reportHash, "reportHash");
  const chartHash = requiredText(input.chartHash, "chartHash");
  return new StaticMarketChartSource({
    mode: "RUN_RESULT",
    sourceId: input.sourceId ?? `run:${runId}`,
    session: input.session,
    datasetKey: `run:${runId}:${chartHash}`,
    executionIdentity: { kind: "RUN_RESULT", runId, configHash, reportHash, chartHash },
    bars: input.bars,
  });
}

export function assertExecutableMarketChartSource(
  source: MarketChartSourceRuntime,
): MarketChartExecutionIdentity {
  if (source.lifecycle === "DISPOSED") throw new Error("MARKET_CHART_SOURCE_DISPOSED");
  if (!source.executionIdentity) throw new Error("LIVE_REFERENCE_IS_NOT_IMMUTABLE_EXECUTION_INPUT");
  return source.executionIdentity;
}
