import type { IntervalString } from "../../utils/intervals.js";
import type { ForegroundPreloadGate } from "./foregroundPreloadGate.js";
import type { ChartWorkScheduler } from "./chartWorkScheduler.js";
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
  changedRanges?: WindowChangedRange[];
}

export interface WindowChangedRange {
  start: EpochSeconds;
  end: EpochSeconds;
  type: "prepend" | "mid-merge" | "append";
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

export type HistoryAvailabilityState = "ready" | "pending" | "exhausted";

export interface HistoryExcludedRange extends Record<string, unknown> {
  start_ms: EpochMilliseconds | number;
  end_ms: EpochMilliseconds | number;
  reason?: string;
  retry_at_ms?: EpochMilliseconds | number | null;
}

export interface HistoryMissingRange extends Record<string, unknown> {
  start_ms: EpochMilliseconds | number;
  end_ms: EpochMilliseconds | number;
  reason?: string;
  missing_bars?: number;
}

export interface KlineFetchResult extends Record<string, unknown> {
  data?: KlineBar[];
  indicatorWindowOwner?: string;
  all_rows_final?: boolean;
  has_more?: boolean;
  has_tail_gap?: boolean;
  source?: string;
  start_ms?: unknown;
  end_ms?: unknown;
  truncated?: boolean;
  next_end_ms?: EpochMilliseconds | number | null;
  history_state?: HistoryAvailabilityState;
  complete?: boolean;
  retryable?: boolean;
  terminal_reason?: string | null;
  earliest_available_ms?: EpochMilliseconds | number | null;
  next_before_ms?: EpochMilliseconds | number | null;
  availability_revision?: string | null;
  retry_at_ms?: EpochMilliseconds | number | null;
  excluded_ranges?: HistoryExcludedRange[];
  missing_ranges?: HistoryMissingRange[];
  verified_contiguous?: boolean;
}

export interface BeforePageAvailability {
  boundaryBefore: EpochSeconds;
  historyState: "exhausted";
  terminalReason: string | null;
  availabilityRevision: string | null;
  retryAtMs: EpochMilliseconds | number | null;
}

export interface KlineRequestOptions {
  signal?: AbortSignal;
  /** Stable chart/pane demand owner used by the backend to supersede stale work. */
  demandScope?: string;
  /** Monotonic generation within demandScope. */
  demandGeneration?: number;
}

export type KlineHistoryIntent = "viewport" | "active_hydration";

export interface KlineHistoryRequestOptions extends KlineRequestOptions {
  countBack?: number | null;
  /** Backend wait budget for the requested history window. */
  maxWaitMs?: number;
  /** Distinguishes the first visible window from active-series hydration. */
  intent?: KlineHistoryIntent;
}

export interface KlineBeforeRequestOptions extends KlineRequestOptions {
  /** Backend long-poll budget. Validation probes use zero to stay non-blocking. */
  maxWaitMs?: number;
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
    options: KlineBeforeRequestOptions,
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

export type FeedCommitMode = "active" | "always" | "patch-active" | "patch-cache" | "cache" | "none";
export type FeedApplyMode = "range" | "tick";
export type FeedRequestPriority = "foreground" | "hydrate" | "preload";

export interface FeedCommitMeta {
  source: string;
  seedIfEmpty?: boolean;
  deferIndicatorWindow?: boolean;
  indicatorWindowOwner?: string;
  historyComplete?: boolean;
  historyRepairPending?: boolean;
  historyValidatedCountBack?: number | null;
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

export type KlineStreamFactory = (
  series: Pick<MarketSeries, "exchange" | "marketType" | "symbol">,
  options?: KlineStreamOptions,
) => KlineStreamController;

export interface SeriesDataFeedConfig {
  api?: KlineApi | null;
  chartWorkScheduler?: ChartWorkScheduler | null;
  chartWorkSchedulerCellId?: string | null;
  foregroundPreloadGate?: ForegroundPreloadGate | null;
  canRequestSeries?: (series: Partial<MarketSeries>) => boolean;
  getActiveSeries?: () => MarketSeries | null;
  isActiveSeries?: (series: MarketSeries, activeSeries: MarketSeries | null) => boolean;
  mergeCacheData?: MergeCacheData;
  commitMergedChartData?: CommitChartData;
  commitPatchedChartData?: CommitChartData;
  patchCacheTick?: PatchCacheTick;
  streamFactory?: KlineStreamFactory | null;
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
  pagination_stop_reason?: "cap" | "missing-cursor" | "stalled-cursor";
}

export interface PendingBeforePage {
  before: EpochSeconds;
  bars?: number;
  range?: TimeRangeMs | null;
  safetyAttempts?: number;
  completionAttempts?: number;
  pollAttempts?: number;
  nextPollAt?: number;
  indicatorWindowOwner?: string;
}

export interface BackfillCompletedDetail extends Record<string, unknown> {
  reason?: unknown;
  range_start_ms?: unknown;
  range_end_ms?: unknown;
  request_start_ms?: unknown;
  request_end_ms?: unknown;
  verified_contiguous?: boolean;
  request_id?: unknown;
  derived_for_intervals?: unknown;
  derived_repair_targets?: unknown;
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
  countBack?: number | null;
  range?: TimeRangeMs | null;
  indicatorWindowOwner?: string;
}

export type LastPriceUpdater = (
  previous: KlineBar | null,
) => KlineBar | null;

export interface BackfillCompletedOptions {
  activeSeries?: MarketSeries | null;
  loading?: boolean;
  pendingInitial?: PendingInitialSeries | null;
  getPendingInitial?: () => PendingInitialSeries | null;
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
  readyState(): number | undefined;
  isOpen(): boolean;
  send(payload: string): boolean;
  sendPing(): boolean;
  updateIntervals(intervals: readonly IntervalString[]): void;
  close(): void;
}

export interface KlineStreamSocket {
  readonly OPEN?: number;
  readonly readyState: number;
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent<string>) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  send(payload: string): void;
  close(): void;
}

export interface KlineStreamStatusMessage extends Record<string, unknown> {
  type: "stream_status";
  interval?: IntervalString;
  status?: string;
}

export interface KlineStreamIntervalFailure extends Record<string, unknown> {
  interval: IntervalString;
  code?: string;
  message?: string;
  error?: string;
}

export interface KlineStreamControlMessage extends Record<string, unknown> {
  type: "subscribed" | "unsubscribed" | "connected" | "warning" | "error";
  request_id?: string;
  requested_intervals?: IntervalString[];
  intervals?: IntervalString[];
  failed?: KlineStreamIntervalFailure[];
  active_intervals?: IntervalString[];
}

export interface KlineStreamBackfillMessage extends BackfillCompletedMessage, Record<string, unknown> {
  type: "backfill_completed";
}

export interface KlineStreamDataMessage extends Record<string, unknown> {
  type: "kline";
  interval: IntervalString;
  data: KlineBar;
}

export interface KlineStreamTickEvent {
  interval: IntervalString;
  tick: KlineBar;
  message: KlineStreamDataMessage;
}

export interface KlineStreamOptions extends Record<string, unknown> {
  intervals?: readonly IntervalString[];
  socketFactory?: (url: string) => KlineStreamSocket;
  onOpen?: (controller: KlineStreamController) => void;
  onStreamStatus?: (
    message: KlineStreamStatusMessage,
    controller: KlineStreamController,
  ) => void;
  onControlMessage?: (
    message: KlineStreamControlMessage,
    controller: KlineStreamController,
  ) => void;
  onBackfillCompleted?: (
    message: KlineStreamBackfillMessage,
    controller: KlineStreamController,
  ) => boolean;
  onKline?: (event: KlineStreamTickEvent, controller: KlineStreamController) => void;
  onError?: (event: Event, controller: KlineStreamController) => void;
  onClose?: (event: CloseEvent, controller: KlineStreamController) => void;
  onParseError?: (
    error: unknown,
    event: MessageEvent<string>,
    controller: KlineStreamController,
  ) => void;
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
  changedRanges?: unknown;
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
  volume?: number | null;
}

export interface MarketSummary {
  displayData: CrosshairData | null;
  priceChange: number;
  isUp: boolean;
  amplitude: string;
}
