import type { IntervalString } from "../../utils/intervals.js";
import type {
  EpochMilliseconds,
  EpochSeconds,
  KlineBar,
  MarketSeries,
  TimeRangeMs,
  TimeRangeSec,
} from "./marketDataTypes.js";

export const WINDOW_DELTA_TYPES = {
  NOOP: "noop",
  TICK: "tick",
  APPEND: "append",
  PREPEND: "prepend",
  MID_MERGE: "mid-merge",
  REPLACE: "replace",
  CLEAR: "clear",
  TRIM_LEFT: "trim-left",
  TRIM_RIGHT: "trim-right",
} as const;

export type WindowDeltaType = (typeof WINDOW_DELTA_TYPES)[keyof typeof WINDOW_DELTA_TYPES];

export interface WindowDeltaDetail extends Record<string, unknown> {
  bar?: KlineBar;
  bars?: number;
  incomingBars?: number;
  addedLeft?: number;
  addedRight?: number;
  appended?: boolean;
  replaced?: boolean;
  originalBars?: number;
  trimmedLeft?: number;
  trimmedRight?: number;
}

interface WindowDeltaBase<TType extends WindowDeltaType, TChanged extends boolean>
  extends WindowDeltaDetail {
  type: TType;
  changed: TChanged;
}

export type WindowDelta =
  | WindowDeltaBase<"noop", false>
  | WindowDeltaBase<Exclude<WindowDeltaType, "noop">, true>;

export type FetchPlan =
  | { type: "range"; range: TimeRangeSec }
  | { type: "before"; before: EpochSeconds; bars: number }
  | { type: "history"; days: number | null; countBack: number | null };

export interface KlineFetchResult extends Record<string, unknown> {
  data?: KlineBar[];
  has_more?: boolean;
  truncated?: boolean;
  next_end_ms?: EpochMilliseconds | number | null;
}

export interface KlineRequestOptions {
  signal?: AbortSignal;
}

export interface KlineHistoryRequestOptions extends KlineRequestOptions {
  countBack?: number | null;
}

export interface KlineRangeRequestOptions extends KlineRequestOptions {
  repair?: string;
  waitMs?: number;
  strict?: boolean;
}

export interface KlineApi {
  fetchKlinesHistory(
    symbol: string,
    interval: IntervalString,
    days: number | null | undefined,
    marketType: string,
    exchange: string,
    options: KlineHistoryRequestOptions,
  ): Promise<KlineFetchResult>;
  fetchKlinesBefore(
    symbol: string,
    interval: IntervalString,
    before: EpochSeconds | undefined,
    bars: number,
    marketType: string,
    exchange: string,
    options: KlineRequestOptions,
  ): Promise<KlineFetchResult>;
  fetchKlinesRange(
    symbol: string,
    interval: IntervalString,
    start: EpochSeconds,
    end: EpochSeconds,
    marketType: string,
    exchange: string,
    options: KlineRangeRequestOptions,
  ): Promise<KlineFetchResult>;
  fetchLatestKlines(
    symbol: string,
    interval: IntervalString,
    limit: number,
    marketType: string,
    exchange: string,
    source: string,
    options: KlineRequestOptions,
  ): Promise<KlineFetchResult>;
  getMultiStreamUrl(symbol: string, marketType: string, exchange: string): string;
}

export type FeedCommitMode = "active" | "always" | "patch-active" | "patch-cache" | "cache";
export type FeedApplyMode = "range" | "tick";

export interface FeedCommitMeta {
  source: string;
  seedIfEmpty?: boolean;
}

export interface FeedCacheMeta {
  marketType: string;
  exchange: string;
}

export type CommitChartData = (
  symbol: string,
  interval: IntervalString,
  rows: KlineBar[],
  meta: FeedCommitMeta,
) => void;

export type MergeCacheData = (
  symbol: string,
  interval: IntervalString,
  rows: KlineBar[],
  meta: FeedCacheMeta,
) => void;

export type PatchCacheTick = (
  symbol: string,
  interval: IntervalString,
  row: KlineBar,
  meta: FeedCacheMeta,
) => void;

export interface SeriesDataFeedConfig {
  api?: KlineApi | null;
  getActiveSeries?: () => MarketSeries | null;
  isActiveSeries?: (series: MarketSeries, activeSeries: MarketSeries | null) => boolean;
  mergeCacheData?: MergeCacheData;
  commitMergedChartData?: CommitChartData;
  commitPatchedChartData?: CommitChartData;
  patchCacheTick?: PatchCacheTick;
}

export interface AppliedKlineResult extends KlineFetchResult {
  data: KlineBar[];
  rows: KlineBar[];
  committed: boolean;
  stale: boolean;
  active: boolean;
  mode?: FeedApplyMode;
  plan?: FetchPlan;
}

export interface FeedResult extends KlineFetchResult {
  data: KlineBar[];
  rows: KlineBar[];
  committed?: boolean;
  stale?: boolean;
  active?: boolean;
  mode?: FeedApplyMode;
  plan?: FetchPlan;
  skipped?: boolean;
  reason?: string;
  pending?: boolean;
  pages?: AppliedKlineResult[];
  pageCount?: number;
}

export interface PendingBeforePage {
  before: EpochSeconds;
  safetyAttempts?: number;
  completionAttempts?: number;
}

export interface BackfillCompletedDetail extends Record<string, unknown> {
  reason?: unknown;
  range_start_ms?: unknown;
  range_end_ms?: unknown;
  request_start_ms?: unknown;
  request_end_ms?: unknown;
  verified_contiguous?: boolean;
}

export interface BackfillCompletedMessage {
  type: "backfill_completed";
  exchange?: string;
  market_type?: string;
  symbol?: string;
  interval?: IntervalString;
  detail?: BackfillCompletedDetail;
}

export interface PendingInitialSeries extends MarketSeries {
  range?: TimeRangeMs | null;
}

export type LastPriceUpdater = (
  previous: KlineBar | null,
) => KlineBar | null;

export interface BackfillCompletedOptions {
  activeSeries?: MarketSeries | null;
  loading?: boolean;
  pendingInitial?: PendingInitialSeries | null;
  clearPendingInitial?: () => void;
  getCacheRows?: (series: MarketSeries) => KlineBar[];
  getFallbackDays?: (series: MarketSeries) => number | null;
  setLastPrice?: (updater: LastPriceUpdater) => void;
  setError?: (error: unknown) => void;
  setConnectionStatus?: (status: string) => void;
  setLoading?: (loading: boolean) => void;
  cooldownMs?: number;
  completionMaxAttempts?: number;
}

export interface KlineStreamController {
  updateIntervals(intervals: readonly IntervalString[]): void;
  close(): void;
}

export interface KlineStreamOptions extends Record<string, unknown> {
  intervals?: IntervalString[];
  socketFactory?: (url: string) => WebSocket;
  onOpen?: (...args: unknown[]) => void;
  onStreamStatus?: (...args: unknown[]) => void;
  onControlMessage?: (...args: unknown[]) => void;
  onBackfillCompleted?: (...args: unknown[]) => boolean;
  onKline?: (...args: unknown[]) => void;
  onError?: (...args: unknown[]) => void;
  onClose?: (...args: unknown[]) => void;
  onParseError?: (...args: unknown[]) => void;
}

export interface RangeEventDetail {
  request_start_ms?: unknown;
  request_end_ms?: unknown;
  range_start_ms?: unknown;
  range_end_ms?: unknown;
}

export interface IndicatorWindowMeta {
  windowDeltaType?: unknown;
  incomingFirstTime?: unknown;
  incomingLastTime?: unknown;
}

export interface IndicatorRangeRequest {
  start: EpochSeconds;
  end: EpochSeconds;
  reason: `window-${"prepend" | "mid-merge"}`;
}

export interface IndicatorRangeEvent {
  id: number;
  sessionKey: string;
  start: EpochSeconds;
  end: EpochSeconds;
  interval: IntervalString;
  reason: string;
  createdAt: number;
}

export interface CrosshairData {
  time?: unknown;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}

export interface MarketSummary {
  displayData: CrosshairData | null;
  priceChange: number;
  isUp: boolean;
  amplitude: string;
}
