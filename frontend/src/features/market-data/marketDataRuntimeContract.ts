import type { CacheDiagnosticsEntry } from "../cache-gc/cacheGcTypes.js";
import type { IndicatorRangeEvent, CrosshairData } from "./klineContracts.js";
import type { KlineBar } from "./marketDataTypes.js";
import type { ChartDataCommitMeta } from "./useChartDataRuntime.js";
import type { SeriesWindowStore } from "./window/seriesWindowStore.js";

/**
 * Source-neutral market-data boundary consumed by page shells and chart views.
 *
 * This module intentionally contains types only. Live and replay composition
 * roots implement the contract independently; importing it cannot construct a
 * feed, open a socket, touch storage, or select a source.
 */
export type MarketDataConnectionStatus =
  | "idle"
  | "connecting"
  | "live"
  | "fallback"
  | "reconnecting"
  | "disconnected"
  | string;

export interface MarketDataDisplayState {
  displayData: {
    time?: unknown;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
  } | null;
  priceChange: number;
  isUp: boolean;
  amplitude: string;
  wsStatusLabel: string;
  exchangeLabel: string;
  marketLabel: string;
}

export interface MarketDataRuntimeContract {
  view: {
    bars: KlineBar[];
    seriesStore: SeriesWindowStore | null;
    meta: ChartDataCommitMeta;
    loading: boolean;
    error: unknown | null;
    crosshairData: null;
    lastPrice: KlineBar | null;
    connectionStatus: MarketDataConnectionStatus;
    dataSource: string | null;
    wsStatus: MarketDataConnectionStatus;
    display: MarketDataDisplayState;
  };
  actions: {
    retry(): void;
    loadMoreLeft(oldestLoadedTime?: number | null): Promise<void>;
    loadMoreRight?(): Promise<boolean>;
    restoreLatestWindow?(): Promise<boolean>;
    onCrosshairMove(data: CrosshairData | null | undefined): void;
    onVisibleRangeChange(range: unknown): void;
    consumeIndicatorRangeRequest(requestId: number): void;
  };
  status: {
    hasMoreLeft: boolean;
    loadingMoreLeft: boolean;
    loadingMoreRight?: boolean;
    initialHistoryPending: boolean;
    activeChartReady: boolean;
    canLoadMoreLeft: boolean;
    canLoadMoreRight?: boolean;
    canRestoreLatestWindow: boolean;
    barCount: number;
    cacheDiagnostics(): Record<string, unknown>;
    trimCacheEntries(victims?: CacheDiagnosticsEntry[]): Record<string, unknown>;
    indicatorRangeRequests: IndicatorRangeEvent[];
    requestDemand: Readonly<{ scope: string; generation: number }> | null;
  };
}
