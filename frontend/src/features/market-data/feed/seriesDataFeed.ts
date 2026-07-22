import type {
  AppliedKlineResult,
  BackfillCompletedMessage,
  BackfillCompletedOptions,
  BeforePageAvailability,
  CommitChartData,
  FeedApplyMode,
  FeedCommitMode,
  FeedResult,
  HistoryExcludedRange,
  HistoryMissingRange,
  KlineApi,
  KlineFetchResult,
  KlineStreamController,
  KlineStreamOptions,
  MergeCacheData,
  PatchCacheTick,
  PendingBeforePage,
  SeriesDataFeedConfig,
} from "../klineContracts.js";
import type {
  EpochSeconds,
  KlineBar,
  MarketSeries,
  SeriesKey,
  TimeRangeMs,
  TimeRangeSec,
} from "../marketDataTypes.js";
import {
  millisecondsToSeconds,
  secondsToMilliseconds,
  toEpochMilliseconds,
} from "../marketDataTypes.js";
import {
  eventRangeFromDetail,
  isSameSeries,
  rangeCovers,
  rowRangeMs,
} from "../rangeRuntime.js";
import {
  activeCoverageMsFromRows,
  intersectRanges,
  isUserVisibleBackfillReason,
} from "../phase1WindowPolicy.js";
import {
  intervalsSemanticallyEquivalent,
  parseIntervalSeconds,
} from "../../../utils/intervals.js";
import { createIntervalTimeline } from "../../../utils/intervalTimeline.js";
import { InflightRegistry } from "./inflightRegistry.js";
import { KlineStreamSubscription } from "./klineStreamSubscription.js";
import {
  normalizeRangeSec,
  planBarsFetch,
  requestKeyFor,
  rowsFromResult,
  seriesKeyFor,
} from "./fetchPlanner.js";
import {
  planGapRepairs,
  type GapRepairPlan,
  type GapRepairPlanningOptions,
  type VisibleTimeRangeLike,
} from "./gapRepairPlanner.js";

interface RequestBeforePageOptions {
  before?: EpochSeconds;
  bars?: number;
  source?: string;
  signal?: AbortSignal;
  commit?: FeedCommitMode;
  cooldownMs?: number;
  pendingCooldownMs?: number;
  errorCooldownMs?: number;
  indicatorWindowOwner?: string;
}

interface GetBarsOptions {
  from?: unknown;
  to?: unknown;
  countBack?: unknown;
  days?: unknown;
  fallbackDays?: number | null;
  source?: string;
  signal?: AbortSignal;
  commit?: FeedCommitMode;
  repair?: string;
  waitMs?: number;
  maxWaitMs?: number;
  strict?: boolean;
  requestScope?: string;
  indicatorWindowOwner?: string;
}

interface GetHistoryOptions {
  days?: number | null;
  countBack?: number | null;
  source?: string;
  signal?: AbortSignal;
  commit?: FeedCommitMode;
  requestScope?: string;
  indicatorWindowOwner?: string;
}

interface GetBeforeOptions {
  before?: EpochSeconds;
  bars?: number;
  source?: string;
  signal?: AbortSignal;
  commit?: FeedCommitMode;
  requestScope?: string;
  maxWaitMs?: number;
  indicatorWindowOwner?: string;
}

interface GetRangeOptions {
  start?: unknown;
  end?: unknown;
  startSec?: unknown;
  endSec?: unknown;
  repair?: string;
  waitMs?: number;
  strict?: boolean;
  source?: string;
  signal?: AbortSignal;
  commit?: FeedCommitMode;
  maxPages?: number;
  requestScope?: string;
  indicatorWindowOwner?: string;
}

interface GetLatestOptions {
  limit?: number;
  source?: string;
  apiSource?: string;
  signal?: AbortSignal;
  commit?: FeedCommitMode;
}

export interface KlineRequestDemand {
  scope: string;
  generation: number;
}

interface KlineTransportDemandOptions {
  demandScope?: string;
  demandGeneration?: number;
}

interface ApplyResultOptions {
  epoch: number;
  source: string;
  commit: FeedCommitMode;
  mode: FeedApplyMode;
  expectedRealtimeVersion?: number;
  indicatorWindowOwner?: string;
}

interface RealtimeRowMutation {
  version: number;
  row: KlineBar;
  authoritative: boolean;
}

interface RealtimeFenceState {
  version: number;
  activeRequests: Map<symbol, number>;
  rows: Map<EpochSeconds, RealtimeRowMutation>;
}

interface RealtimeRequestFence {
  key: SeriesKey;
  token: symbol;
  version: number;
  state: RealtimeFenceState;
}

interface PendingGapRepair {
  series: MarketSeries;
  range: TimeRangeSec;
  attempts: number;
  nextPollAt: number;
  dormant: boolean;
  terminalReason?: string;
  onResolved?: () => void;
  onTerminal?: (reason: string) => void;
}

interface EpochLease {
  epoch: number;
  repairGeneration: number;
  token: symbol;
}

interface RepairAbortState {
  generation: number;
  controller: AbortController;
}

interface LinkedAbortSignal {
  signal?: AbortSignal;
  dispose(): void;
}

interface ExcludedRangeState {
  revision: string | null;
  ranges: HistoryExcludedRange[];
  updatedAt: number;
}

interface BackfillReloadJob {
  series: MarketSeries;
  epoch: number;
  range: TimeRangeMs | null;
  detail: NonNullable<BackfillCompletedMessage["detail"]>;
  eventKeys: Set<string>;
  userVisibleReason: boolean;
  options: Required<Pick<
    BackfillCompletedOptions,
    "clearPendingInitial"
    | "getPendingInitial"
    | "getCacheRows"
    | "getFallbackDays"
    | "setLastPrice"
    | "setError"
    | "setConnectionStatus"
    | "setLoading"
  >> & {
    activeSeries: MarketSeries | null;
    loading: boolean;
    pendingInitial: BackfillCompletedOptions["pendingInitial"];
    cooldownMs: number;
    completionMaxAttempts: number;
  };
}

export interface GapRepairResult {
  planned: number;
  requested: number;
  pending: number;
}

export interface RepairVisibleGapOptions extends GapRepairPlanningOptions {
  source?: string;
  throttleMs?: number;
}

export interface PollPendingRepairOptions {
  force?: boolean;
  maxRequests?: number;
}

const PENDING_REPAIR_POLL_BASE_MS = 2_000;
const PENDING_REPAIR_MAX_ATTEMPTS = 5;
const PENDING_REPAIR_DORMANT_POLL_MS = 10 * 60_000;
const BACKFILL_EVENT_SEEN_LIMIT = 1_024;
const GAP_PLANNER_THROTTLE_MS = 1_000;
const FRONTEND_CONTINUOUS_EXCHANGES: ReadonlySet<string> = new Set(["binance", "okx"]);
const EXCLUDED_RANGE_SERIES_LIMIT = 64;

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  if (typeof DOMException !== "undefined") return new DOMException("The operation was aborted", "AbortError");
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function isAbortFailure(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return Boolean(
    error
    && typeof error === "object"
    && "name" in error
    && (error as { name?: unknown }).name === "AbortError",
  );
}

function isStaleRequestGenerationFailure(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "status" in error
    && (error as { status?: unknown }).status === 409
    && "code" in error
    && (error as { code?: unknown }).code === "stale_request_generation",
  );
}

function linkAbortSignals(...candidates: Array<AbortSignal | undefined>): LinkedAbortSignal {
  const signals = [...new Set(candidates.filter((signal): signal is AbortSignal => Boolean(signal)))];
  if (signals.length === 0) return { dispose: () => {} };
  const only = signals[0];
  if (signals.length === 1 && only) return { signal: only, dispose: () => {} };

  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  const dispose = () => {
    for (const [signal, listener] of listeners) {
      signal.removeEventListener("abort", listener);
    }
    listeners.clear();
  };
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(abortReason(signal));
      break;
    }
    const listener = () => controller.abort(abortReason(signal));
    listeners.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
  }
  return { signal: controller.signal, dispose };
}

function missingRanges(result: KlineFetchResult | null | undefined): HistoryMissingRange[] {
  return Array.isArray(result?.missing_ranges) ? result.missing_ranges : [];
}

function retryAtMilliseconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function retryAtFromResult(result: KlineFetchResult): number | null {
  const direct = retryAtMilliseconds(result.retry_at_ms);
  if (direct != null) return direct;
  const deadlines = (result.excluded_ranges || [])
    .map((range) => retryAtMilliseconds(range.retry_at_ms))
    .filter((value): value is number => value != null);
  return deadlines.length > 0 ? Math.min(...deadlines) : null;
}

function sameInstrument(
  left: Partial<MarketSeries> | null | undefined,
  right: Partial<MarketSeries> | null | undefined,
): boolean {
  if (!left || !right) return false;
  return (
    String(left.exchange || "").toLowerCase() === String(right.exchange || "").toLowerCase()
    && String(left.marketType || "").toLowerCase() === String(right.marketType || "").toLowerCase()
    && String(left.symbol || "").toUpperCase() === String(right.symbol || "").toUpperCase()
  );
}

function derivedIntervalsFromDetail(
  detail: NonNullable<BackfillCompletedMessage["detail"]>,
): string[] {
  const values: readonly unknown[] = Array.isArray(detail.derived_for_intervals)
    ? detail.derived_for_intervals
    : [];
  const targets: readonly unknown[] = Array.isArray(detail.derived_repair_targets)
    ? detail.derived_repair_targets
    : [];
  return [...values, ...targets.map((target) => (
    target && typeof target === "object" ? (target as Record<string, unknown>).interval : null
  ))]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function derivedTargetRangeFromDetail(
  detail: NonNullable<BackfillCompletedMessage["detail"]>,
  interval: string,
): TimeRangeMs | null {
  if (!Array.isArray(detail.derived_repair_targets)) return null;
  let combinedRange: TimeRangeMs | null = null;
  for (const rawTarget of detail.derived_repair_targets) {
    if (!rawTarget || typeof rawTarget !== "object") continue;
    const target = rawTarget as Record<string, unknown>;
    if (!intervalsSemanticallyEquivalent(target.interval, interval)) continue;
    const range = eventRangeFromDetail({
      request_start_ms: target.request_start_ms ?? target.start_ms ?? target.range_start_ms,
      request_end_ms: target.request_end_ms ?? target.end_ms ?? target.range_end_ms,
    });
    combinedRange = unionRange(combinedRange, range);
  }
  return combinedRange;
}

export function projectContinuousRangeToInterval(
  range: TimeRangeMs | null,
  interval: string,
): TimeRangeMs | null {
  if (!range) return null;
  const timeline = createIntervalTimeline(interval);
  if (!timeline) return null;
  const start = timeline.floor(range.start / 1_000);
  const end = timeline.floor(range.end / 1_000);
  if (start === null || end === null) return null;
  return {
    start: (start * 1_000) as TimeRangeMs["start"],
    end: (end * 1_000) as TimeRangeMs["end"],
  };
}

export function countIntervalBarsInRange(range: TimeRangeSec, interval: string): number | null {
  const timeline = createIntervalTimeline(interval);
  if (!timeline) return null;
  const startFloor = timeline.floor(range.start);
  const end = timeline.floor(range.end);
  if (startFloor === null || end === null) return null;
  const start = startFloor === range.start ? startFloor : timeline.next(startFloor);
  if (start === null || end < start) return null;
  if (timeline.spec.alignment === "calendar-month") {
    const startDate = new Date(start * 1_000);
    const endDate = new Date(end * 1_000);
    const startMonth = startDate.getUTCFullYear() * 12 + startDate.getUTCMonth();
    const endMonth = endDate.getUTCFullYear() * 12 + endDate.getUTCMonth();
    return Math.floor((endMonth - startMonth) / timeline.spec.monthCount!) + 1;
  }
  const width = timeline.spec.alignment === "weekly-monday"
    ? timeline.spec.weekCount! * 604_800
    : timeline.spec.widthSeconds!;
  return Math.floor((end - start) / width) + 1;
}

/** A result can contain renderable rows while its requested range is still incomplete. */
export function isKlineResultRepairPending(
  result: KlineFetchResult | null | undefined,
): boolean {
  if (!result) return true;
  if (result.history_state === "exhausted" && result.retryable === false) return false;
  return Boolean(
    result.history_state === "pending"
    || result.complete === false
    || result.retryable === true
    || result.verified_contiguous === false
    || result.has_tail_gap === true
    || result.truncated === true
    || missingRanges(result).length > 0
    || (rowsFromResult(result).length === 0 && result.has_more === true)
  );
}

function unionRange(
  left: TimeRangeMs | null | undefined,
  right: TimeRangeMs | null | undefined,
): TimeRangeMs | null {
  if (!left) return right || null;
  if (!right) return left;
  return {
    start: Math.min(left.start, right.start) as TimeRangeMs["start"],
    end: Math.max(left.end, right.end) as TimeRangeMs["end"],
  };
}

function rangesTouch(left: TimeRangeMs | null, right: TimeRangeMs | null): boolean {
  if (!left || !right) return !left && !right;
  return left.start <= right.end + 1 && right.start <= left.end + 1;
}

function rangeFromMissing(result: KlineFetchResult | null | undefined): TimeRangeMs | null {
  let range: TimeRangeMs | null = null;
  for (const missing of missingRanges(result)) {
    const candidate = eventRangeFromDetail({
      range_start_ms: missing.start_ms,
      range_end_ms: missing.end_ms,
    });
    range = unionRange(range, candidate);
  }
  return range || numericResultRange(result);
}

function numericResultRange(result: KlineFetchResult | null | undefined): TimeRangeMs | null {
  const start = toEpochMilliseconds(result?.start_ms);
  const end = toEpochMilliseconds(result?.end_ms);
  return start == null || end == null || end < start ? null : { start, end };
}

function mergeStructuredRanges<T extends HistoryExcludedRange | HistoryMissingRange>(
  ranges: readonly T[],
): T[] {
  const byKey = new Map<string, T>();
  for (const range of ranges) {
    const start = toEpochMilliseconds(range.start_ms);
    const end = toEpochMilliseconds(range.end_ms);
    if (start == null || end == null || end < start) continue;
    byKey.set(`${start}:${end}:${String(range.reason || "")}`, range);
  }
  return [...byKey.values()].sort((left, right) => Number(left.start_ms) - Number(right.start_ms));
}

function combineResolvedCallbacks(
  current: (() => void) | undefined,
  next: (() => void) | undefined,
): (() => void) | undefined {
  if (!current) return next;
  if (!next || next === current) return current;
  let called = false;
  return () => {
    if (called) return;
    called = true;
    current();
    next();
  };
}

function combineTerminalCallbacks(
  current: ((reason: string) => void) | undefined,
  next: ((reason: string) => void) | undefined,
): ((reason: string) => void) | undefined {
  if (!current) return next;
  if (!next || next === current) return current;
  let called = false;
  return (reason) => {
    if (called) return;
    called = true;
    current(reason);
    next(reason);
  };
}

export function capContinuationRanges(
  range: TimeRangeSec,
  result: KlineFetchResult,
  continuation: EpochSeconds,
  interval: string,
): TimeRangeSec[] {
  const timeline = createIntervalTimeline(interval);
  const candidates: TimeRangeSec[] = [{ start: range.start, end: continuation }];
  for (const missing of missingRanges(result)) {
    const startMs = toEpochMilliseconds(missing.start_ms);
    const endMs = toEpochMilliseconds(missing.end_ms);
    if (startMs == null || endMs == null || endMs < startMs) continue;
    const start = millisecondsToSeconds(startMs);
    const end = millisecondsToSeconds(endMs);
    const clamped = {
      start: Math.max(Number(range.start), Number(start)),
      end: Math.min(Number(range.end), Number(end)),
    };
    if (clamped.end < clamped.start) continue;
    candidates.push({
      start: clamped.start as EpochSeconds,
      end: clamped.end as EpochSeconds,
    });
  }
  candidates.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TimeRangeSec[] = [];
  for (const candidate of candidates) {
    const previous = merged.at(-1);
    const successor = previous ? timeline?.next(previous.end) : null;
    if (previous && successor != null && candidate.start <= successor) {
      previous.end = Math.max(previous.end, candidate.end) as EpochSeconds;
    } else {
      merged.push({ ...candidate });
    }
  }
  return merged;
}

function childResolutionCallbacks(
  count: number,
  onResolved: (() => void) | undefined,
): Array<(() => void) | undefined> {
  if (!onResolved) return Array.from({ length: count }, () => undefined);
  let remaining = count;
  return Array.from({ length: count }, () => {
    let childResolved = false;
    return () => {
      if (childResolved) return;
      childResolved = true;
      remaining -= 1;
      if (remaining === 0) onResolved();
    };
  });
}

function defaultIsActiveSeries(
  series: MarketSeries,
  activeSeries: MarketSeries | null,
): boolean {
  return isSameSeries(series, activeSeries);
}

const noopMergeCacheData: MergeCacheData = () => undefined;
const noopCommitChartData: CommitChartData = () => undefined;
const noopPatchCacheTick: PatchCacheTick = () => undefined;
const disabledStreamController: KlineStreamController = {
  readyState: () => undefined,
  isOpen: () => false,
  send: () => false,
  sendPing: () => false,
  updateIntervals: () => undefined,
  close: () => undefined,
};

function dataPlaneDisabledResult(): AppliedKlineResult {
  return {
    data: [],
    rows: [],
    committed: false,
    stale: true,
    active: false,
    skipped: true,
    reason: "data-plane-disabled",
    retryable: false,
    terminal_reason: "data_plane_disabled",
  };
}

export class SeriesDataFeed {
  inflight: InflightRegistry;
  epochBySeries: Map<SeriesKey, number>;
  beforePageCooldownUntil: Map<SeriesKey, number>;
  pendingBeforePages: Map<SeriesKey, PendingBeforePage>;
  beforePageFetchInFlight: Map<SeriesKey, EpochLease>;
  beforePageAvailability: Map<SeriesKey, BeforePageAvailability>;
  backfillReloadInFlight: Set<SeriesKey>;
  backfillReloadQueues: Map<SeriesKey, BackfillReloadJob[]>;
  backfillEventInFlight: Set<string>;
  backfillEventSeenUntil: Map<string, number>;
  pendingGapRepairs: Map<string, PendingGapRepair>;
  gapRepairInFlight: Map<string, EpochLease>;
  gapRepairGenerationBySeries: Map<SeriesKey, number>;
  repairAbortStateBySeries: Map<SeriesKey, RepairAbortState>;
  gapPlannerNextAllowedAt: Map<SeriesKey, number>;
  excludedRangesBySeries: Map<SeriesKey, ExcludedRangeState>;
  api: KlineApi | null;
  canRequestSeries: (series: Partial<MarketSeries>) => boolean;
  getActiveSeries: () => MarketSeries | null;
  isActiveSeries: (series: MarketSeries, activeSeries: MarketSeries | null) => boolean;
  mergeCacheData: MergeCacheData;
  commitMergedChartData: CommitChartData;
  commitPatchedChartData: CommitChartData;
  patchCacheTick: PatchCacheTick;
  private realtimeFenceBySeries: Map<SeriesKey, RealtimeFenceState>;
  private requestDemandBySeries: Map<SeriesKey, KlineRequestDemand>;

  constructor(config: SeriesDataFeedConfig = {}) {
    this.inflight = new InflightRegistry();
    this.epochBySeries = new Map();
    this.beforePageCooldownUntil = new Map();
    this.pendingBeforePages = new Map();
    this.beforePageFetchInFlight = new Map();
    this.beforePageAvailability = new Map();
    this.backfillReloadInFlight = new Set();
    this.backfillReloadQueues = new Map();
    this.backfillEventInFlight = new Set();
    this.backfillEventSeenUntil = new Map();
    this.pendingGapRepairs = new Map();
    this.gapRepairInFlight = new Map();
    this.gapRepairGenerationBySeries = new Map();
    this.repairAbortStateBySeries = new Map();
    this.gapPlannerNextAllowedAt = new Map();
    this.excludedRangesBySeries = new Map();
    this.api = null;
    this.canRequestSeries = () => true;
    this.getActiveSeries = () => null;
    this.isActiveSeries = defaultIsActiveSeries;
    this.mergeCacheData = noopMergeCacheData;
    this.commitMergedChartData = noopCommitChartData;
    this.commitPatchedChartData = noopCommitChartData;
    this.patchCacheTick = noopPatchCacheTick;
    this.realtimeFenceBySeries = new Map();
    this.requestDemandBySeries = new Map();
    this.configure(config);
  }

  configure(config: SeriesDataFeedConfig = {}): void {
    this.api = config.api || this.api || null;
    this.canRequestSeries = config.canRequestSeries || this.canRequestSeries || (() => true);
    this.getActiveSeries = config.getActiveSeries || this.getActiveSeries || (() => null);
    this.isActiveSeries = config.isActiveSeries || this.isActiveSeries || defaultIsActiveSeries;
    this.mergeCacheData = config.mergeCacheData || this.mergeCacheData || noopMergeCacheData;
    this.commitMergedChartData = config.commitMergedChartData
      || this.commitMergedChartData
      || noopCommitChartData;
    this.commitPatchedChartData = config.commitPatchedChartData
      || this.commitPatchedChartData
      || noopCommitChartData;
    this.patchCacheTick = config.patchCacheTick || this.patchCacheTick || noopPatchCacheTick;
  }

  async resolveApi(): Promise<KlineApi> {
    if (this.api) return this.api;
    throw new Error("SeriesDataFeed requires an API adapter before fetching");
  }

  resolveSyncApi(): KlineApi {
    if (this.api) return this.api;
    throw new Error("SeriesDataFeed requires an API adapter before subscribing");
  }

  seriesKey(series: Partial<MarketSeries>): SeriesKey {
    return seriesKeyFor(series);
  }

  beforePageKey(series: Partial<MarketSeries>): SeriesKey {
    return this.seriesKey(series);
  }

  private indicatorWindowOwner(
    kind: "history" | "before" | "range",
    series: MarketSeries,
    epoch: number,
    identity: readonly unknown[],
  ): string {
    return [
      this.seriesKey(series),
      "indicator-window",
      kind,
      epoch,
      ...identity.map((value) => String(value ?? "")),
    ].join("|");
  }

  setRequestDemand(series: MarketSeries, demand: KlineRequestDemand): void {
    const scope = demand.scope.trim();
    const generation = Math.floor(demand.generation);
    if (!scope) throw new TypeError("K-line request demand scope must not be empty");
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new TypeError("K-line request demand generation must be a non-negative safe integer");
    }
    this.requestDemandBySeries.set(this.seriesKey(series), { scope, generation });
  }

  private transportDemandOptions(series: MarketSeries): KlineTransportDemandOptions {
    const demand = this.requestDemandBySeries.get(this.seriesKey(series));
    if (!demand) return {};
    return {
      demandScope: demand.scope,
      demandGeneration: demand.generation,
    };
  }

  beginEpoch(series: MarketSeries): number {
    const key = this.seriesKey(series);
    const next = (this.epochBySeries.get(key) || 0) + 1;
    this.epochBySeries.set(key, next);
    this.clearBeforePageAvailability(series);
    this.clearPendingBeforePage(series);
    this.bumpGapRepairGeneration(series);
    this.excludedRangesBySeries.delete(key);
    for (const [repairKey, pending] of this.pendingGapRepairs) {
      if (this.seriesKey(pending.series) === key) this.pendingGapRepairs.delete(repairKey);
    }
    this.gapPlannerNextAllowedAt.delete(key);
    // The epoch gate makes every request from the previous session stale, so
    // its request-scoped realtime mutations can be released as well.
    this.realtimeFenceBySeries.delete(key);
    return next;
  }

  cancelSeriesRequests(series: MarketSeries): void {
    const key = this.seriesKey(series);
    this.beginEpoch(series);
    this.requestDemandBySeries.delete(key);
    const queue = this.backfillReloadQueues.get(key);
    if (queue) {
      for (const job of queue) {
        for (const eventKey of job.eventKeys) this.backfillEventInFlight.delete(eventKey);
      }
      queue.splice(0, queue.length);
      this.backfillReloadQueues.delete(key);
    }
  }

  private bumpGapRepairGeneration(series: MarketSeries): number {
    const key = this.seriesKey(series);
    const currentAbortState = this.repairAbortStateBySeries.get(key);
    if (currentAbortState) {
      currentAbortState.controller.abort();
      this.repairAbortStateBySeries.delete(key);
    }
    const next = (this.gapRepairGenerationBySeries.get(key) || 0) + 1;
    this.gapRepairGenerationBySeries.set(key, next);
    return next;
  }

  private currentGapRepairGeneration(series: MarketSeries): number {
    return this.gapRepairGenerationBySeries.get(this.seriesKey(series)) || 0;
  }

  private repairGenerationContext(series: MarketSeries): {
    generation: number;
    signal: AbortSignal;
    requestScope: string;
  } {
    const key = this.seriesKey(series);
    const generation = this.currentGapRepairGeneration(series);
    let state = this.repairAbortStateBySeries.get(key);
    if (!state || state.generation !== generation || state.controller.signal.aborted) {
      state?.controller.abort();
      state = { generation, controller: new AbortController() };
      this.repairAbortStateBySeries.set(key, state);
    }
    return {
      generation,
      signal: state.controller.signal,
      requestScope: `repair-generation:${generation}`,
    };
  }

  currentEpoch(series: MarketSeries): number {
    return this.epochBySeries.get(this.seriesKey(series)) || 0;
  }

  isCurrent(series: MarketSeries, epoch: number): boolean {
    return this.currentEpoch(series) === epoch;
  }

  recordRealtimeRows(series: MarketSeries, rows: readonly KlineBar[]): void {
    if (!rows.length) return;
    const key = this.seriesKey(series);
    let state = this.realtimeFenceBySeries.get(key);
    if (!state) {
      state = { version: 0, activeRequests: new Map(), rows: new Map() };
      this.realtimeFenceBySeries.set(key, state);
    }

    for (const row of rows) {
      if (row?.time == null) continue;
      state.version += 1;
      if (state.activeRequests.size === 0) continue;
      const previous = state.rows.get(row.time);
      state.rows.set(row.time, {
        version: state.version,
        row: { ...row },
        // Once a realtime close/amendment has been observed for this request
        // window, never let an older HTTP snapshot regain authority.
        authoritative: previous?.authoritative === true || row.is_closed === true,
      });
    }
  }

  private beginRealtimeRequest(series: MarketSeries): RealtimeRequestFence {
    const key = this.seriesKey(series);
    let state = this.realtimeFenceBySeries.get(key);
    if (!state) {
      state = { version: 0, activeRequests: new Map(), rows: new Map() };
      this.realtimeFenceBySeries.set(key, state);
    }
    const token = Symbol(key);
    state.activeRequests.set(token, state.version);
    return { key, token, version: state.version, state };
  }

  private endRealtimeRequest(fence: RealtimeRequestFence): void {
    const state = this.realtimeFenceBySeries.get(fence.key);
    if (!state || state !== fence.state) return;
    state.activeRequests.delete(fence.token);
    if (state.activeRequests.size === 0) {
      state.rows.clear();
      return;
    }
    let oldestVersion = Number.POSITIVE_INFINITY;
    for (const version of state.activeRequests.values()) {
      oldestVersion = Math.min(oldestVersion, version);
    }
    for (const [time, mutation] of state.rows) {
      if (mutation.version <= oldestVersion) state.rows.delete(time);
    }
  }

  private reconcileRealtimeRows(
    series: MarketSeries,
    result: KlineFetchResult,
    rows: KlineBar[],
    expectedRealtimeVersion: number | undefined,
  ): KlineBar[] {
    if (expectedRealtimeVersion == null || rows.length === 0) return rows;
    const state = this.realtimeFenceBySeries.get(this.seriesKey(series));
    if (!state || state.rows.size === 0) return rows;
    const trustedFinalResponse = result.all_rows_final === true;
    let changed = false;
    const reconciled = rows.map((row) => {
      const mutation = state.rows.get(row.time);
      if (!mutation) return row;
      if (mutation.authoritative) {
        changed = true;
        return mutation.row;
      }
      if (
        trustedFinalResponse
        && row.is_closed === true
      ) {
        // Match the watchlist preload contract: a provenance-verified final
        // HTTP row may close a concurrently forming realtime row. Promote the
        // fence too, so another older same-epoch request cannot subsequently
        // restore that forming snapshot.
        state.version += 1;
        state.rows.set(row.time, {
          version: state.version,
          row: { ...row },
          authoritative: true,
        });
        return row;
      }
      if (mutation.version <= expectedRealtimeVersion) return row;
      changed = true;
      return mutation.row;
    });
    return changed ? reconciled : rows;
  }

  private acquireEpochLease(
    leases: Map<string, EpochLease>,
    key: string,
    epoch: number,
    repairGeneration = 0,
  ): EpochLease | null {
    const existing = leases.get(key);
    if (existing?.epoch === epoch && existing.repairGeneration === repairGeneration) return null;
    const lease = { epoch, repairGeneration, token: Symbol(key) };
    leases.set(key, lease);
    return lease;
  }

  private releaseEpochLease(
    leases: Map<string, EpochLease>,
    key: string,
    lease: EpochLease,
  ): void {
    if (leases.get(key)?.token === lease.token) leases.delete(key);
  }

  private isBeforePageFetchInFlight(series: MarketSeries): boolean {
    const lease = this.beforePageFetchInFlight.get(this.beforePageKey(series));
    return lease?.epoch === this.currentEpoch(series)
      && lease.repairGeneration === this.currentGapRepairGeneration(series);
  }

  shouldCommitActive(series: MarketSeries): boolean {
    return this.isActiveSeries(series, this.getActiveSeries());
  }

  subscribeBars(
    series: Pick<MarketSeries, "exchange" | "marketType" | "symbol">,
    options: KlineStreamOptions = {},
  ): KlineStreamController {
    if (!this.isSeriesRequestAllowed(series)) return disabledStreamController;
    const api = this.resolveSyncApi();
    if (typeof api.getMultiStreamUrl !== "function") {
      throw new Error("SeriesDataFeed API adapter must provide getMultiStreamUrl for subscribeBars");
    }
    return new KlineStreamSubscription({
      api,
      series,
      ...options,
    });
  }

  private isSeriesRequestAllowed(series: Partial<MarketSeries>): boolean {
    try {
      return this.canRequestSeries(series);
    } catch (error) {
      console.warn("Series data-plane predicate failed closed:", error);
      return false;
    }
  }

  isBeforePageCoolingDown(series: MarketSeries, now = Date.now()): boolean {
    const cooldownUntil = this.beforePageCooldownUntil.get(this.beforePageKey(series)) || 0;
    return now < cooldownUntil;
  }

  setBeforePageCooldown(
    series: MarketSeries,
    durationMs: number | null | undefined,
    now = Date.now(),
  ): void {
    this.beforePageCooldownUntil.set(
      this.beforePageKey(series),
      now + Math.max(0, durationMs || 0),
    );
  }

  resetBeforePageCooldown(series: MarketSeries): void {
    this.beforePageCooldownUntil.delete(this.beforePageKey(series));
  }

  getPendingBeforePage(series: MarketSeries): PendingBeforePage | null {
    return this.pendingBeforePages.get(this.beforePageKey(series)) || null;
  }

  setPendingBeforePage(series: MarketSeries, pending: PendingBeforePage): void {
    this.pendingBeforePages.set(this.beforePageKey(series), pending);
  }

  clearPendingBeforePage(series: MarketSeries): void {
    this.pendingBeforePages.delete(this.beforePageKey(series));
  }

  getBeforePageAvailability(series: MarketSeries): BeforePageAvailability | null {
    const key = this.beforePageKey(series);
    const availability = this.beforePageAvailability.get(key) || null;
    if (
      availability?.retryAtMs != null
      && Date.now() >= Number(availability.retryAtMs)
    ) {
      this.beforePageAvailability.delete(key);
      this.beforePageCooldownUntil.delete(key);
      return null;
    }
    return availability;
  }

  clearBeforePageAvailability(series?: MarketSeries): void {
    if (series) {
      this.beforePageAvailability.delete(this.beforePageKey(series));
      return;
    }
    this.beforePageAvailability.clear();
  }

  invalidateBeforePageAvailability(series?: MarketSeries): void {
    this.clearBeforePageAvailability(series);
  }

  private invalidateBeforePageAvailabilityFromObservation(
    series: MarketSeries,
    {
      rows = [],
      range = null,
      revision,
      revisionPresent = false,
    }: {
      rows?: readonly KlineBar[];
      range?: TimeRangeMs | null;
      revision?: unknown;
      revisionPresent?: boolean;
    },
  ): boolean {
    const key = this.beforePageKey(series);
    const current = this.getBeforePageAvailability(series);
    if (!current) return false;

    const normalizedRevision = typeof revision === "string"
      ? revision
      : (revision === null ? null : undefined);
    const revisionChanged = Boolean(
      revisionPresent
      && normalizedRevision !== undefined
      && normalizedRevision !== current.availabilityRevision,
    );
    const observedEarlierRow = rows.some((row) => row.time < current.boundaryBefore);
    const boundaryMs = secondsToMilliseconds(current.boundaryBefore);
    const completedAcrossBoundary = Boolean(range && range.start <= boundaryMs);
    if (!revisionChanged && !observedEarlierRow && !completedAcrossBoundary) return false;

    this.beforePageAvailability.delete(key);
    this.resetBeforePageCooldown(series);
    return true;
  }

  isBeforePageExhausted(series: MarketSeries, before?: EpochSeconds): boolean {
    const availability = this.getBeforePageAvailability(series);
    return Boolean(
      availability
      && before !== undefined
      && before <= availability.boundaryBefore,
    );
  }

  updateBeforePageAvailability(
    series: MarketSeries,
    before: EpochSeconds | undefined,
    result: KlineFetchResult,
  ): void {
    const key = this.beforePageKey(series);
    const current = this.getBeforePageAvailability(series);
    const revision = result.availability_revision ?? null;
    if (
      current?.availabilityRevision
      && revision
      && current.availabilityRevision !== revision
    ) {
      this.beforePageAvailability.delete(key);
    }

    const explicitTerminal = result.history_state === "exhausted"
      && result.retryable === false;
    if (!explicitTerminal) return;

    const retryAtMs = retryAtFromResult(result);
    if (retryAtMs != null && retryAtMs <= Date.now()) return;

    const earliestAvailableMs = toEpochMilliseconds(result.earliest_available_ms);
    const earliestAvailable = earliestAvailableMs == null
      ? null
      : millisecondsToSeconds(earliestAvailableMs);
    const rowTimes = rowsFromResult(result).map((row) => row.time);
    const earliestRow = rowTimes.length > 0 ? Math.min(...rowTimes) as EpochSeconds : null;
    const boundaryBefore = rowTimes.length === 0
      ? (before ?? earliestAvailable)
      : (earliestAvailable ?? earliestRow);
    if (boundaryBefore === undefined || boundaryBefore === null) return;
    this.beforePageAvailability.set(key, {
      boundaryBefore,
      historyState: "exhausted",
      terminalReason: result.terminal_reason ?? null,
      availabilityRevision: revision,
      retryAtMs,
    });
  }

  markBeforePageSafetyRetry(
    series: MarketSeries,
    before: EpochSeconds,
    maxAttempts = 1,
  ): boolean {
    const pending = this.getPendingBeforePage(series);
    if (!pending || pending.before !== before) return false;
    const attempts = pending.safetyAttempts ?? 0;
    if (attempts >= maxAttempts) return false;
    pending.safetyAttempts = attempts + 1;
    this.resetBeforePageCooldown(series);
    return true;
  }

  beginBeforePageCompletionAttempt(
    series: MarketSeries,
    maxAttempts = 3,
  ): PendingBeforePage | null {
    if (this.isBeforePageFetchInFlight(series)) return null;
    const pending = this.getPendingBeforePage(series);
    if (!pending) return null;
    const attempts = pending.completionAttempts ?? 0;
    if (attempts >= maxAttempts) return null;
    pending.completionAttempts = attempts + 1;
    return pending;
  }

  private async refreshPendingBeforePage(
    series: MarketSeries,
    pending: PendingBeforePage,
    source: string,
  ): Promise<boolean> {
    const leaseKey = this.beforePageKey(series);
    const epoch = this.currentEpoch(series);
    const repairContext = this.repairGenerationContext(series);
    const lease = this.acquireEpochLease(
      this.beforePageFetchInFlight,
      leaseKey,
      epoch,
      repairContext.generation,
    );
    if (!lease) return false;
    try {
      const result = await this.getBars(series, {
        to: pending.before,
        countBack: pending.bars ?? 500,
        maxWaitMs: 0,
        source,
        signal: repairContext.signal,
        requestScope: repairContext.requestScope,
        ...(pending.indicatorWindowOwner
          ? { indicatorWindowOwner: pending.indicatorWindowOwner }
          : {}),
      });
      if (
        result.stale
        || !this.isCurrent(series, epoch)
        || this.currentGapRepairGeneration(series) !== repairContext.generation
      ) return false;
      this.updatePendingBeforePageFromResult(
        series,
        pending.before,
        pending.bars ?? 500,
        result,
      );
      return true;
    } catch (error) {
      if (
        isAbortFailure(error, repairContext.signal)
        || this.currentGapRepairGeneration(series) !== repairContext.generation
      ) return false;
      throw error;
    } finally {
      this.releaseEpochLease(this.beforePageFetchInFlight, leaseKey, lease);
    }
  }

  private updatePendingBeforePageFromResult(
    series: MarketSeries,
    before: EpochSeconds,
    bars: number,
    result: KlineFetchResult,
    { resetAttempts = false }: { resetAttempts?: boolean } = {},
  ): boolean {
    if (!isKlineResultRepairPending(result)) {
      this.clearPendingBeforePage(series);
      return false;
    }
    const existing = this.getPendingBeforePage(series);
    const pollAttempts = resetAttempts ? 0 : (existing?.pollAttempts ?? 0);
    this.setPendingBeforePage(series, {
      before,
      bars,
      range: rangeFromMissing(result),
      safetyAttempts: resetAttempts ? 0 : (existing?.safetyAttempts ?? 0),
      completionAttempts: resetAttempts ? 0 : (existing?.completionAttempts ?? 0),
      pollAttempts,
      nextPollAt: Date.now() + (pollAttempts >= PENDING_REPAIR_MAX_ATTEMPTS
        ? PENDING_REPAIR_DORMANT_POLL_MS
        : PENDING_REPAIR_POLL_BASE_MS * (2 ** Math.min(4, pollAttempts))),
      ...(result.indicatorWindowOwner
        ? { indicatorWindowOwner: result.indicatorWindowOwner }
        : (existing?.indicatorWindowOwner
          ? { indicatorWindowOwner: existing.indicatorWindowOwner }
          : {})),
    });
    return true;
  }

  private backfillEventKey(
    series: MarketSeries,
    detail: NonNullable<BackfillCompletedMessage["detail"]>,
    range: TimeRangeMs | null,
  ): string {
    const requestId = detail.request_id ?? detail.repair_id ?? detail.job_id ?? "";
    return [
      this.seriesKey(series),
      String(requestId),
      String(range?.start ?? ""),
      String(range?.end ?? ""),
      String(detail.reason || ""),
    ].join("|");
  }

  private wasBackfillEventSeen(eventKey: string, now = Date.now()): boolean {
    if (this.backfillEventInFlight.has(eventKey)) return true;
    const seenUntil = this.backfillEventSeenUntil.get(eventKey) || 0;
    if (seenUntil > now) return true;
    if (seenUntil > 0) this.backfillEventSeenUntil.delete(eventKey);
    return false;
  }

  private rememberBackfillEvents(job: BackfillReloadJob): void {
    const seenUntil = Date.now() + Math.max(1_000, job.options.cooldownMs);
    for (const eventKey of job.eventKeys) {
      this.backfillEventInFlight.delete(eventKey);
      this.backfillEventSeenUntil.set(eventKey, seenUntil);
    }
    if (this.backfillEventSeenUntil.size <= BACKFILL_EVENT_SEEN_LIMIT) return;
    const now = Date.now();
    for (const [eventKey, expiresAt] of this.backfillEventSeenUntil) {
      if (expiresAt <= now || this.backfillEventSeenUntil.size > BACKFILL_EVENT_SEEN_LIMIT) {
        this.backfillEventSeenUntil.delete(eventKey);
      }
      if (this.backfillEventSeenUntil.size <= BACKFILL_EVENT_SEEN_LIMIT) break;
    }
  }

  private enqueueBackfillReload(job: BackfillReloadJob): void {
    const reloadKey = this.seriesKey(job.series);
    const queue = this.backfillReloadQueues.get(reloadKey) || [];
    const mergeTarget = queue.find((queued) => (
      queued.epoch === job.epoch && rangesTouch(queued.range, job.range)
    ));
    if (mergeTarget) {
      mergeTarget.range = unionRange(mergeTarget.range, job.range);
      mergeTarget.userVisibleReason ||= job.userVisibleReason;
      mergeTarget.detail = { ...mergeTarget.detail, ...job.detail };
      for (const eventKey of job.eventKeys) mergeTarget.eventKeys.add(eventKey);
      if (!mergeTarget.options.pendingInitial && job.options.pendingInitial) {
        mergeTarget.options.pendingInitial = job.options.pendingInitial;
      }
      mergeTarget.options.loading ||= job.options.loading;
    } else {
      queue.push(job);
    }
    for (const eventKey of job.eventKeys) this.backfillEventInFlight.add(eventKey);
    this.backfillReloadQueues.set(reloadKey, queue);
    if (this.backfillReloadInFlight.has(reloadKey)) return;
    this.backfillReloadInFlight.add(reloadKey);
    void this.drainBackfillReloads(reloadKey);
  }

  private async drainBackfillReloads(reloadKey: SeriesKey): Promise<void> {
    try {
      const queue = this.backfillReloadQueues.get(reloadKey);
      if (!queue) return;
      do {
        let pendingInitialVerification: BackfillReloadJob | null = null;
        while (queue.length) {
          const job = queue.shift();
          if (!job) continue;
          try {
            const initialResolved = await this.readBackfilledData(job);
            if (!this.isCurrent(job.series, job.epoch)) continue;
            if (!this.shouldCommitActive(job.series)) {
              this.clearInactivePendingState(job.series);
              continue;
            }
            if (job.options.pendingInitial && !initialResolved) {
              pendingInitialVerification = job;
            }
          } catch (error) {
            console.warn(`Failed to reload after backfill for ${job.series.interval}:`, error);
          } finally {
            this.rememberBackfillEvents(job);
          }
        }
        if (pendingInitialVerification) {
          await this.verifyPendingInitialRange(pendingInitialVerification);
        }
      } while (queue.length);
    } finally {
      this.backfillReloadQueues.delete(reloadKey);
      this.backfillReloadInFlight.delete(reloadKey);
    }
  }

  private async readBackfilledData(job: BackfillReloadJob): Promise<boolean> {
    if (!this.isCurrent(job.series, job.epoch)) return false;
    if (!this.shouldCommitActive(job.series) && !this.getPendingBeforePage(job.series)) return false;
    const {
      activeSeries,
      loading,
      pendingInitial,
      clearPendingInitial,
      getCacheRows,
      setLastPrice,
      setError,
      setConnectionStatus,
      setLoading,
    } = job.options;
    const pendingBeforePage = this.getPendingBeforePage(job.series);
    const isPendingInitial = Boolean(
      pendingInitial && isSameSeries(job.series, pendingInitial),
    );
    const isPendingLoadMore = Boolean(pendingBeforePage);
    const activeRows = getCacheRows(job.series) || [];
    const activeCoverage = activeCoverageMsFromRows(activeRows);
    const activeOverlap = intersectRanges(job.range, activeCoverage);
    const fetchRange = (
      (isPendingInitial || isPendingLoadMore)
        ? job.range
        : (activeOverlap || intersectRanges(job.range, activeCoverage))
    );
    let loadedAny = false;
    let initialResolved = false;
    let lastError: unknown = null;

    const canReleaseInitialLoading = (result: FeedResult, rows: KlineBar[]): boolean => {
      if (!isSameSeries(job.series, activeSeries)) return false;
      if (isKlineResultRepairPending(result)) return false;
      const rowsRange = rowRangeMs(rows);
      if (pendingInitial && isSameSeries(job.series, pendingInitial)) {
        if (!pendingInitial.range) return true;
        const resultRange = numericResultRange(result) || rowsRange;
        return rangeCovers(resultRange, pendingInitial.range)
          || (
            job.detail.verified_contiguous === true
            && rangeCovers(job.range, pendingInitial.range)
          );
      }
      return loading && job.userVisibleReason;
    };

    const afterBackfillRows = (result: FeedResult): boolean => {
      const rows = result.data || [];
      if (!rows.length) return false;
      if (
        !result.stale
        && this.isCurrent(job.series, job.epoch)
        && this.shouldCommitActive(job.series)
        && isSameSeries(job.series, activeSeries)
      ) {
        setLastPrice((previous) => previous || rows.at(-1) || previous);
        setError(null);
        if (canReleaseInitialLoading(result, rows)) {
          clearPendingInitial();
          setConnectionStatus("connected");
          setLoading(false);
          initialResolved = true;
        }
      }
      return true;
    };

    if (fetchRange) {
      try {
        const result = await this.getBars(job.series, {
          from: millisecondsToSeconds(fetchRange.start),
          to: millisecondsToSeconds(fetchRange.end),
          repair: "none",
          strict: false,
          source: "backfill-completed",
        });
        if (result.stale || !this.isCurrent(job.series, job.epoch)) return false;
        if (result.active === false || !this.shouldCommitActive(job.series)) {
          this.clearInactivePendingState(job.series);
          return false;
        }
        loadedAny = afterBackfillRows(result) || loadedAny;
        if (isKlineResultRepairPending(result)) {
          const range = {
            start: millisecondsToSeconds(fetchRange.start),
            end: millisecondsToSeconds(fetchRange.end),
          };
          this.updatePendingGapRepairFromResult(job.series, range, result, 0, false);
        } else {
          this.resolveVerifiedPendingGapRepairs(job.series, {
            start: millisecondsToSeconds(fetchRange.start),
            end: millisecondsToSeconds(fetchRange.end),
          }, result);
        }
      } catch (error) {
        if (!isStaleRequestGenerationFailure(error)) {
          lastError = error;
          console.warn(`[Backfill] Exact range reload failed for ${this.seriesKey(job.series)}:`, error);
        }
      }
    }

    if (!loadedAny && lastError) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    return initialResolved;
  }

  private async verifyPendingInitialRange(job: BackfillReloadJob): Promise<void> {
    const pendingInitial = job.options.pendingInitial;
    if (!pendingInitial || !isSameSeries(job.series, pendingInitial)) return;
    const isStillAuthoritative = () => (
      this.isCurrent(job.series, job.epoch)
      && this.shouldCommitActive(job.series)
      && job.options.getPendingInitial() === pendingInitial
    );
    if (!isStillAuthoritative()) return;
    const finalize = () => {
      if (!isStillAuthoritative()) return;
      job.options.clearPendingInitial();
      job.options.setConnectionStatus("connected");
      job.options.setLoading(false);
    };
    try {
      const result = pendingInitial.range
        ? await this.getBars(job.series, {
          from: millisecondsToSeconds(pendingInitial.range.start),
          to: millisecondsToSeconds(pendingInitial.range.end),
          repair: "none",
          strict: false,
          source: "backfill-initial-range-verification",
          ...(pendingInitial.indicatorWindowOwner
            ? { indicatorWindowOwner: pendingInitial.indicatorWindowOwner }
            : {}),
        })
        : await this.getBars(job.series, {
          fallbackDays: job.options.getFallbackDays(job.series),
          countBack: pendingInitial.countBack ?? 1_500,
          source: "backfill-initial-range-verification",
          ...(pendingInitial.indicatorWindowOwner
            ? { indicatorWindowOwner: pendingInitial.indicatorWindowOwner }
            : {}),
        });
      const rows = result.data || [];
      if (result.stale || result.active === false || !isStillAuthoritative()) return;
      if (rows.length > 0) {
        job.options.setLastPrice((previous) => previous || rows.at(-1) || previous);
        job.options.setError(null);
      }
      if (!pendingInitial.range) {
        if (!isKlineResultRepairPending(result) && rows.length > 0) finalize();
        return;
      }
      const range = {
        start: millisecondsToSeconds(pendingInitial.range.start),
        end: millisecondsToSeconds(pendingInitial.range.end),
      };
      this.updatePendingGapRepairFromResult(
        job.series,
        range,
        result,
        0,
        false,
        finalize,
      );
    } catch (error) {
      console.warn(`[Backfill] Initial range verification failed for ${this.seriesKey(job.series)}:`, error);
    }
  }

  private gapRepairKey(series: MarketSeries, range: TimeRangeSec): string {
    return `${this.seriesKey(series)}|${range.start}|${range.end}`;
  }

  private trackPendingGapRepair(
    series: MarketSeries,
    range: TimeRangeSec,
    attempts?: number,
    dormant?: boolean,
    onResolved?: () => void,
    terminalReason?: string | null,
    onTerminal?: (reason: string) => void,
  ): PendingGapRepair {
    const key = this.gapRepairKey(series, range);
    const current = this.pendingGapRepairs.get(key);
    const nextAttempts = attempts ?? current?.attempts ?? 0;
    const nextDormant = dormant ?? current?.dormant ?? false;
    const nextTerminalReason = terminalReason === null
      ? undefined
      : (terminalReason || current?.terminalReason);
    const nextResolved = combineResolvedCallbacks(current?.onResolved, onResolved);
    const nextTerminal = combineTerminalCallbacks(current?.onTerminal, onTerminal);
    const pending = {
      series,
      range,
      attempts: nextAttempts,
      nextPollAt: nextTerminalReason
        ? Number.POSITIVE_INFINITY
        : Date.now() + (nextDormant
          ? PENDING_REPAIR_DORMANT_POLL_MS
          : PENDING_REPAIR_POLL_BASE_MS * (2 ** Math.min(4, nextAttempts))),
      dormant: nextDormant || Boolean(nextTerminalReason),
      ...(nextTerminalReason ? { terminalReason: nextTerminalReason } : {}),
      ...(nextResolved ? { onResolved: nextResolved } : {}),
      ...(nextTerminal ? { onTerminal: nextTerminal } : {}),
    };
    this.pendingGapRepairs.set(key, pending);
    return pending;
  }

  private clearPendingGapRepair(series: MarketSeries, range: TimeRangeSec): void {
    this.pendingGapRepairs.delete(this.gapRepairKey(series, range));
  }

  private wakePendingGapRepairs(
    series: MarketSeries,
    range: TimeRangeSec | null = null,
  ): number {
    const seriesKey = this.seriesKey(series);
    const now = Date.now();
    let woken = 0;
    for (const pending of this.pendingGapRepairs.values()) {
      if (
        pending.terminalReason
        || this.seriesKey(pending.series) !== seriesKey
        || (range && (
          pending.range.end < range.start
          || pending.range.start > range.end
        ))
      ) continue;
      pending.nextPollAt = Math.min(pending.nextPollAt, now);
      woken += 1;
    }
    return woken;
  }

  private resolveVerifiedPendingGapRepairs(
    series: MarketSeries,
    fetchedRange: TimeRangeSec,
    result: KlineFetchResult,
  ): void {
    if (
      !createIntervalTimeline(series.interval)
      || result.verified_contiguous !== true
      || isKlineResultRepairPending(result)
    ) {
      return;
    }
    const seriesKey = this.seriesKey(series);
    for (const [repairKey, pending] of this.pendingGapRepairs) {
      if (this.seriesKey(pending.series) !== seriesKey) continue;
      if (
        pending.range.start < fetchedRange.start
        || pending.range.end > fetchedRange.end
      ) {
        continue;
      }
      if (!this.isGapRangeSatisfied(result, pending.range, series.interval)) continue;
      this.pendingGapRepairs.delete(repairKey);
      pending.onResolved?.();
    }
  }

  pendingRepairCount(series?: MarketSeries): number {
    if (!series) {
      const actionableGaps = [...this.pendingGapRepairs.values()]
        .filter((pending) => !pending.terminalReason)
        .length;
      return actionableGaps + this.pendingBeforePages.size;
    }
    const seriesKey = this.seriesKey(series);
    const gapCount = [...this.pendingGapRepairs.values()]
      .filter((pending) => (
        !pending.terminalReason
        && this.seriesKey(pending.series) === seriesKey
      ))
      .length;
    return gapCount + Number(this.pendingBeforePages.has(seriesKey));
  }

  terminalRepairCount(series?: MarketSeries): number {
    const terminalGapRepairs = [...this.pendingGapRepairs.values()]
      .filter((pending) => (
        Boolean(pending.terminalReason)
        && (!series || this.seriesKey(pending.series) === this.seriesKey(series))
      )).length;
    return terminalGapRepairs;
  }

  private clearInactivePendingState(series: MarketSeries): void {
    const seriesKey = this.seriesKey(series);
    this.bumpGapRepairGeneration(series);
    this.clearPendingBeforePage(series);
    for (const [repairKey, pending] of this.pendingGapRepairs) {
      if (this.seriesKey(pending.series) === seriesKey) {
        this.pendingGapRepairs.delete(repairKey);
      }
    }
  }

  private canPlanFrontendGaps(series: MarketSeries): boolean {
    // The currently supported exchanges are crypto 24x7. Unknown future
    // calendars fail closed until the frontend receives an explicit calendar
    // capability instead of guessing closed sessions from missing timestamps.
    return FRONTEND_CONTINUOUS_EXCHANGES.has(String(series.exchange).toLowerCase());
  }

  private recordExcludedRanges(series: MarketSeries, result: KlineFetchResult): void {
    const key = this.seriesKey(series);
    const revision = result.availability_revision ?? null;
    const current = this.excludedRangesBySeries.get(key);
    const revisionChanged = revision != null && current?.revision !== revision;
    if (!Array.isArray(result.excluded_ranges) && !revisionChanged) return;
    const now = Date.now();
    const resultRetryAtMs = retryAtMilliseconds(result.retry_at_ms);
    const incomingRanges = Array.isArray(result.excluded_ranges)
      ? result.excluded_ranges.map((range) => (
        !Object.prototype.hasOwnProperty.call(range, "retry_at_ms") && resultRetryAtMs != null
          ? { ...range, retry_at_ms: resultRetryAtMs }
          : range
      ))
      : [];
    const activeCurrentRanges = (current?.ranges || []).filter((range) => {
      const retryAtMs = retryAtMilliseconds(range.retry_at_ms);
      return retryAtMs == null || retryAtMs > now;
    });
    const ranges = revisionChanged
      ? mergeStructuredRanges(incomingRanges).slice(-256)
      : mergeStructuredRanges([
        ...activeCurrentRanges,
        ...incomingRanges,
      ]).slice(-256);
    this.excludedRangesBySeries.delete(key);
    this.excludedRangesBySeries.set(key, {
      revision,
      ranges,
      updatedAt: Date.now(),
    });
    while (this.excludedRangesBySeries.size > EXCLUDED_RANGE_SERIES_LIMIT) {
      const oldestKey = this.excludedRangesBySeries.keys().next().value as SeriesKey | undefined;
      if (!oldestKey) break;
      this.excludedRangesBySeries.delete(oldestKey);
    }
  }

  private isGapRangeSatisfied(
    result: KlineFetchResult,
    range: TimeRangeSec,
    interval: string,
  ): boolean {
    if (result.truncated || result.verified_contiguous === false || missingRanges(result).length > 0) {
      return false;
    }
    if (isKlineResultRepairPending(result)) return false;
    if (result.verified_contiguous === true) return true;
    if (result.history_state === "exhausted" && result.retryable === false) return true;
    const expectedBars = countIntervalBarsInRange(range, interval);
    if (expectedBars === null) return false;
    return rowsFromResult(result).length >= expectedBars;
  }

  private updatePendingGapRepairFromResult(
    series: MarketSeries,
    range: TimeRangeSec,
    result: KlineFetchResult,
    attempts: number,
    dormant: boolean,
    onResolved?: () => void,
    onTerminal?: (reason: string) => void,
  ): void {
    const current = this.pendingGapRepairs.get(this.gapRepairKey(series, range));
    const resolvedCallback = onResolved || current?.onResolved;
    const terminalCallback = onTerminal || current?.onTerminal;
    const intervalTimeline = createIntervalTimeline(series.interval);
    if (intervalTimeline && this.isGapRangeSatisfied(result, range, series.interval)) {
      this.clearPendingGapRepair(series, range);
      resolvedCallback?.();
      return;
    }
    const terminalReason = result.retryable === false
      && (result.pagination_stop_reason === "missing-cursor"
        || result.pagination_stop_reason === "stalled-cursor")
      ? `pagination_${result.pagination_stop_reason}`
      : null;
    if (terminalReason) {
      const newlyTerminal = current?.terminalReason !== terminalReason;
      if (newlyTerminal) {
        console.warn(
          `[GapRepair] ${this.gapRepairKey(series, range)} stopped: ${terminalReason}`,
        );
      }
      this.trackPendingGapRepair(
        series,
        range,
        attempts,
        true,
        resolvedCallback,
        terminalReason,
        terminalCallback,
      );
      if (newlyTerminal) terminalCallback?.(terminalReason);
      return;
    }
    const continuationMs = result.pagination_stop_reason === "cap"
      ? toEpochMilliseconds(result.next_end_ms)
      : null;
    const continuation = continuationMs == null
      ? null
      : millisecondsToSeconds(continuationMs);
    if (
      intervalTimeline
      && continuation != null
      && continuation >= range.start
      && continuation < range.end
    ) {
      const children = capContinuationRanges(range, result, continuation, series.interval);
      const madeProgress = children.length > 1
        || children[0]?.start !== range.start
        || children[0]?.end !== range.end;
      if (children.length > 0 && madeProgress) {
        const callbacks = childResolutionCallbacks(children.length, resolvedCallback);
        this.clearPendingGapRepair(series, range);
        children.forEach((child, index) => {
          this.trackPendingGapRepair(
            series,
            child,
            attempts,
            dormant,
            callbacks[index],
            null,
            terminalCallback,
          );
        });
        return;
      }
    }
    this.trackPendingGapRepair(
      series,
      range,
      attempts,
      dormant,
      resolvedCallback,
      null,
      terminalCallback,
    );
  }

  /**
   * Keeps a pending history/range request discoverable by the exact-range poller.
   * This is the no-completion-event fallback for empty and edge/tail gaps, which
   * cannot be rediscovered by scanning interior timestamps already held in memory.
   */
  trackPendingResultRepair(
    series: MarketSeries,
    result: KlineFetchResult,
    onResolved?: () => void,
    onTerminal?: (reason: string) => void,
  ): TimeRangeSec | null {
    const rangeMs = numericResultRange(result) || rangeFromMissing(result);
    if (!rangeMs) return null;
    const range = {
      start: millisecondsToSeconds(rangeMs.start),
      end: millisecondsToSeconds(rangeMs.end),
    };
    const current = this.pendingGapRepairs.get(this.gapRepairKey(series, range));
    this.updatePendingGapRepairFromResult(
      series,
      range,
      result,
      current?.attempts ?? 0,
      current?.dormant ?? false,
      onResolved,
      onTerminal,
    );
    return range;
  }

  clearPendingResultRepair(series: MarketSeries, range: TimeRangeSec | null | undefined): void {
    if (!range) return;
    const seriesKey = this.seriesKey(series);
    this.bumpGapRepairGeneration(series);
    for (const [repairKey, pending] of this.pendingGapRepairs) {
      if (
        this.seriesKey(pending.series) === seriesKey
        && pending.range.start >= range.start
        && pending.range.end <= range.end
      ) {
        this.pendingGapRepairs.delete(repairKey);
      }
    }
  }

  cancelSeriesRepairs(series: MarketSeries): void {
    const seriesKey = this.seriesKey(series);
    this.bumpGapRepairGeneration(series);
    this.clearPendingBeforePage(series);
    this.gapPlannerNextAllowedAt.delete(seriesKey);
    for (const [repairKey, pending] of this.pendingGapRepairs) {
      if (this.seriesKey(pending.series) === seriesKey) {
        this.pendingGapRepairs.delete(repairKey);
      }
    }
  }

  private async requestGapRepair(
    series: MarketSeries,
    plan: GapRepairPlan | TimeRangeSec,
    source: string,
    repair: "wait" | "async" = "wait",
    force = false,
  ): Promise<boolean> {
    const range = { start: plan.start, end: plan.end };
    const key = this.gapRepairKey(series, range);
    const repairContext = this.repairGenerationContext(series);
    const repairGeneration = repairContext.generation;
    const lease = this.acquireEpochLease(
      this.gapRepairInFlight,
      key,
      repairGeneration,
    );
    if (!lease) return false;
    const current = this.pendingGapRepairs.get(key);
    if (current && !force && Date.now() < current.nextPollAt) {
      this.releaseEpochLease(this.gapRepairInFlight, key, lease);
      return false;
    }
    const attempts = Math.min(PENDING_REPAIR_MAX_ATTEMPTS, (current?.attempts ?? 0) + 1);
    const dormant = Boolean(current?.dormant || attempts >= PENDING_REPAIR_MAX_ATTEMPTS);
    this.trackPendingGapRepair(series, range, attempts, dormant);
    try {
      const result = await this.getRange(series, {
        start: range.start,
        end: range.end,
        repair,
        waitMs: repair === "wait" ? 1_500 : 0,
        strict: false,
        source,
        maxPages: 4,
        signal: repairContext.signal,
        requestScope: repairContext.requestScope,
      });
      if (this.currentGapRepairGeneration(series) !== repairGeneration) return true;
      if (result.stale || result.active === false) {
        this.pendingGapRepairs.delete(key);
        return true;
      }
      this.updatePendingGapRepairFromResult(series, range, result, attempts, dormant);
      return true;
    } catch (error) {
      if (
        isAbortFailure(error, repairContext.signal)
        || this.currentGapRepairGeneration(series) !== repairGeneration
      ) return false;
      this.trackPendingGapRepair(series, range, attempts, dormant);
      console.warn(`[GapRepair] Exact range request failed for ${key}:`, error);
      return false;
    } finally {
      this.releaseEpochLease(this.gapRepairInFlight, key, lease);
    }
  }

  async repairVisibleGaps(
    series: MarketSeries,
    rows: readonly KlineBar[] | null | undefined,
    visibleRange: VisibleTimeRangeLike | null = null,
    options: RepairVisibleGapOptions = {},
  ): Promise<GapRepairResult> {
    if (!this.shouldCommitActive(series) || !this.canPlanFrontendGaps(series)) {
      return { planned: 0, requested: 0, pending: this.pendingRepairCount(series) };
    }
    const epoch = this.currentEpoch(series);
    const repairGeneration = this.currentGapRepairGeneration(series);
    const key = this.seriesKey(series);
    const now = Date.now();
    const throttleMs = Math.max(0, Number(options.throttleMs ?? GAP_PLANNER_THROTTLE_MS) || 0);
    if (now < (this.gapPlannerNextAllowedAt.get(key) || 0)) {
      return { planned: 0, requested: 0, pending: this.pendingRepairCount(series) };
    }
    this.gapPlannerNextAllowedAt.set(key, now + throttleMs);
    const intervalSeconds = parseIntervalSeconds(series.interval);
    const { source = "visible-gap-planner", throttleMs: _throttleMs, ...planningOptions } = options;
    void _throttleMs;
    const plans = planGapRepairs(rows, intervalSeconds, {
      ...planningOptions,
      interval: series.interval,
      nowMs: now,
      visibleRange,
      excludedRanges: this.excludedRangesBySeries.get(key)?.ranges || [],
    });
    let requested = 0;
    for (const plan of plans) {
      if (
        !this.shouldCommitActive(series)
        || !this.isCurrent(series, epoch)
        || this.currentGapRepairGeneration(series) !== repairGeneration
      ) break;
      if (await this.requestGapRepair(
        series,
        plan,
        source,
      )) requested += 1;
      if (
        !this.shouldCommitActive(series)
        || !this.isCurrent(series, epoch)
        || this.currentGapRepairGeneration(series) !== repairGeneration
      ) break;
    }
    return { planned: plans.length, requested, pending: this.pendingRepairCount(series) };
  }

  async pollPendingRepairs(
    series: MarketSeries,
    { force = false, maxRequests = 2 }: PollPendingRepairOptions = {},
  ): Promise<number> {
    if (!this.shouldCommitActive(series)) return 0;
    const repairGeneration = this.currentGapRepairGeneration(series);
    const now = Date.now();
    let requested = 0;
    const pendingBefore = this.getPendingBeforePage(series);
    if (
      pendingBefore
      && requested < maxRequests
      && (force || now >= (pendingBefore.nextPollAt ?? 0))
      && !this.isBeforePageFetchInFlight(series)
    ) {
      const attempts = Math.min(
        PENDING_REPAIR_MAX_ATTEMPTS,
        (pendingBefore.pollAttempts ?? 0) + 1,
      );
      const dormant = attempts >= PENDING_REPAIR_MAX_ATTEMPTS;
      pendingBefore.pollAttempts = attempts;
      pendingBefore.nextPollAt = now + (dormant
        ? PENDING_REPAIR_DORMANT_POLL_MS
        : PENDING_REPAIR_POLL_BASE_MS * (2 ** Math.min(4, attempts)));
      try {
        if (await this.refreshPendingBeforePage(
          series,
          pendingBefore,
          "pending-before-page-poll",
        )) requested += 1;
      } catch (error) {
        console.warn(`[GapRepair] Pending before-page poll failed for ${this.seriesKey(series)}:`, error);
      }
    }
    if (this.currentGapRepairGeneration(series) !== repairGeneration) return requested;

    const key = this.seriesKey(series);
    const due = [...this.pendingGapRepairs.values()]
      .filter((pending) => (
        this.seriesKey(pending.series) === key
        && !pending.terminalReason
        && (force || now >= pending.nextPollAt)
      ))
      .sort((left, right) => left.nextPollAt - right.nextPollAt);
    for (const pending of due) {
      if (requested >= maxRequests) break;
      if (this.currentGapRepairGeneration(series) !== repairGeneration) break;
      if (this.pendingGapRepairs.get(this.gapRepairKey(series, pending.range)) !== pending) continue;
      if (await this.requestGapRepair(
        series,
        pending.range,
        "pending-gap-poll",
        "async",
        force,
      )) {
        requested += 1;
      }
      if (this.currentGapRepairGeneration(series) !== repairGeneration) break;
    }
    return requested;
  }

  private pendingDerivedRange(
    series: MarketSeries,
    baseEventRange: TimeRangeMs | null,
  ): TimeRangeMs | null {
    const candidates = [...this.pendingGapRepairs.values()]
      .filter((pending) => isSameSeries(pending.series, series));
    const timeline = createIntervalTimeline(series.interval);
    for (const pending of candidates) {
      const range = {
        start: secondsToMilliseconds(pending.range.start),
        end: secondsToMilliseconds(pending.range.end),
      };
      if (!baseEventRange || !timeline) return range;
      const end = timeline.end(pending.range.end);
      if (end === null) return range;
      const componentCoverage = {
        start: range.start,
        end: (end * 1_000 - 1) as TimeRangeMs["end"],
      };
      if (intersectRanges(baseEventRange, componentCoverage)) return range;
    }
    if (candidates.length === 1) {
      const only = candidates[0];
      if (only) {
        return {
          start: secondsToMilliseconds(only.range.start),
          end: secondsToMilliseconds(only.range.end),
        };
      }
    }
    return null;
  }

  handleBackfillCompleted(
    msg: BackfillCompletedMessage | null | undefined,
    {
      activeSeries = this.getActiveSeries(),
      loading = false,
      pendingInitial = null,
      getPendingInitial = () => pendingInitial,
      clearPendingInitial = () => {},
      getCacheRows = () => [],
      getFallbackDays = () => null,
      setLastPrice = () => {},
      setError = () => {},
      setConnectionStatus = () => {},
      setLoading = () => {},
      cooldownMs = 3_000,
      completionMaxAttempts = 3,
    }: BackfillCompletedOptions = {},
  ): boolean {
    if (msg?.type !== "backfill_completed") return false;

    const detail = msg.detail || {};
    const baseEventSeries = {
      exchange: msg.exchange || activeSeries?.exchange,
      marketType: msg.market_type || activeSeries?.marketType,
      symbol: msg.symbol || activeSeries?.symbol,
      interval: msg.interval || activeSeries?.interval,
    } as MarketSeries;
    if (
      !baseEventSeries.exchange
      || !baseEventSeries.marketType
      || !baseEventSeries.symbol
      || !baseEventSeries.interval
    ) {
      return false;
    }
    let eventSeries = baseEventSeries;
    let eventRange = eventRangeFromDetail(detail);
    const derivedIntervals = derivedIntervalsFromDetail(detail);
    if (
      activeSeries
      && !intervalsSemanticallyEquivalent(activeSeries.interval, baseEventSeries.interval)
      && sameInstrument(activeSeries, baseEventSeries)
      && derivedIntervals.some((interval) => (
        intervalsSemanticallyEquivalent(interval, activeSeries.interval)
      ))
    ) {
      eventSeries = activeSeries;
      eventRange = derivedTargetRangeFromDetail(detail, activeSeries.interval)
        || this.pendingDerivedRange(activeSeries, eventRange)
        || projectContinuousRangeToInterval(eventRange, activeSeries.interval);
    }
    this.invalidateBeforePageAvailabilityFromObservation(eventSeries, {
      range: eventRange,
      revision: detail.availability_revision,
      revisionPresent: Object.prototype.hasOwnProperty.call(
        detail,
        "availability_revision",
      ),
    });
    const userVisibleReason = isUserVisibleBackfillReason(detail.reason);
    const pendingBeforePage = this.getPendingBeforePage(eventSeries);
    const isPendingInitial = Boolean(
      pendingInitial && isSameSeries(eventSeries, pendingInitial),
    );
    const isPendingLoadMore = Boolean(pendingBeforePage);

    if (isPendingLoadMore && !isPendingInitial) {
      // A completion chunk is only a hint that the owned page may now be
      // readable. Do not fan each chunk out into an exact-range reload plus a
      // second full-page request; the runtime poll is the single validation
      // owner and will perform one non-blocking page probe.
      if (pendingBeforePage) pendingBeforePage.nextPollAt = Date.now();
      return true;
    }

    if (isPendingInitial && pendingInitial?.range) {
      const initialRange = {
        start: millisecondsToSeconds(pendingInitial.range.start),
        end: millisecondsToSeconds(pendingInitial.range.end),
      };
      // Initial custom-interval backfills emit one completion per physical
      // base chunk. The exact-range poller already owns verification of the
      // whole requested window, so each completion only makes that poll due.
      // Reloading both the chunk and the full range here turned one 89m cold
      // start into dozens of K-line commits and downstream indicator refreshes.
      if (this.wakePendingGapRepairs(eventSeries, initialRange) > 0) return true;
    }

    if (!userVisibleReason && !isPendingInitial && !isPendingLoadMore) {
      return true;
    }

    const activeRows = getCacheRows(eventSeries) || [];
    const activeCoverage = activeCoverageMsFromRows(activeRows);
    const activeOverlap = intersectRanges(eventRange, activeCoverage);
    if (
      userVisibleReason
      && eventRange
      && activeCoverage
      && !activeOverlap
      && !isPendingInitial
      && !isPendingLoadMore
    ) {
      return true;
    }

    const fetchRange = (isPendingInitial || isPendingLoadMore)
      ? eventRange
      : (activeOverlap || intersectRanges(eventRange, activeCoverage));
    const eventKey = this.backfillEventKey(eventSeries, detail, fetchRange);
    if (this.wasBackfillEventSeen(eventKey)) return true;
    this.enqueueBackfillReload({
      series: eventSeries,
      epoch: this.currentEpoch(eventSeries),
      range: fetchRange,
      detail,
      eventKeys: new Set([eventKey]),
      userVisibleReason,
      options: {
        activeSeries,
        loading,
        pendingInitial,
        getPendingInitial,
        clearPendingInitial,
        getCacheRows,
        getFallbackDays,
        setLastPrice,
        setError,
        setConnectionStatus,
        setLoading,
        cooldownMs,
        completionMaxAttempts,
      },
    });

    return true;
  }

  async requestBeforePage(
    series: MarketSeries,
    {
      before,
      bars = 500,
      source = "history-before-page",
      signal,
      commit = "active",
      cooldownMs = 3_000,
      pendingCooldownMs = 2_000,
      errorCooldownMs = 3_000,
      indicatorWindowOwner,
    }: RequestBeforePageOptions = {},
  ): Promise<FeedResult> {
    if (this.isBeforePageExhausted(series, before)) {
      const availability = this.getBeforePageAvailability(series);
      this.clearPendingBeforePage(series);
      return {
        data: [],
        rows: [],
        skipped: true,
        reason: "history-exhausted",
        pending: false,
        has_more: false,
        history_state: "exhausted",
        complete: true,
        retryable: false,
        terminal_reason: availability?.terminalReason ?? null,
        availability_revision: availability?.availabilityRevision ?? null,
        retry_at_ms: availability?.retryAtMs ?? null,
      };
    }
    if (this.isBeforePageCoolingDown(series)) {
      return { skipped: true, reason: "cooldown", data: [], rows: [] };
    }
    const leaseKey = this.beforePageKey(series);
    const epoch = this.currentEpoch(series);
    const repairContext = this.repairGenerationContext(series);
    const linkedSignal = linkAbortSignals(signal, repairContext.signal);
    const lease = this.acquireEpochLease(
      this.beforePageFetchInFlight,
      leaseKey,
      epoch,
      repairContext.generation,
    );
    if (!lease) {
      linkedSignal.dispose();
      return { skipped: true, reason: "before-page-inflight", data: [], rows: [] };
    }

    try {
      const result = await this.getBars(series, {
        ...(before === undefined ? {} : { to: before }),
        countBack: bars,
        source,
        ...(linkedSignal.signal === undefined ? {} : { signal: linkedSignal.signal }),
        commit,
        requestScope: repairContext.requestScope,
        ...(indicatorWindowOwner === undefined ? {} : { indicatorWindowOwner }),
      });
      if (this.currentGapRepairGeneration(series) !== repairContext.generation) {
        return {
          ...result,
          data: [],
          rows: [],
          skipped: true,
          reason: "repair-cancelled",
          pending: false,
          stale: true,
        };
      }
      if (result.stale) return { ...result, pending: false };
      if (result.active === false || !this.shouldCommitActive(series)) {
        this.clearInactivePendingState(series);
        return { ...result, pending: false };
      }
      const rows = result?.data || [];
      const repairPending = isKlineResultRepairPending(result);

      if (repairPending) {
        this.updatePendingBeforePageFromResult(
          series,
          before as EpochSeconds,
          bars,
          result,
          { resetAttempts: this.getPendingBeforePage(series)?.before !== before },
        );
        this.setBeforePageCooldown(series, pendingCooldownMs);
        return { ...result, pending: true };
      }

      this.clearPendingBeforePage(series);
      this.setBeforePageCooldown(series, cooldownMs);
      return { ...result, pending: false, data: rows, rows };
    } catch (error) {
      if (
        isAbortFailure(error, linkedSignal.signal)
        || this.currentGapRepairGeneration(series) !== repairContext.generation
      ) {
        return {
          data: [],
          rows: [],
          skipped: true,
          reason: "repair-cancelled",
          pending: false,
          stale: true,
        };
      }
      this.setBeforePageCooldown(series, errorCooldownMs);
      throw error;
    } finally {
      linkedSignal.dispose();
      this.releaseEpochLease(this.beforePageFetchInFlight, leaseKey, lease);
    }
  }

  async getBars(
    series: MarketSeries,
    {
      from,
      to,
      countBack,
      days,
      fallbackDays,
      source = "bars",
      signal,
      commit = "active",
      repair = "async",
      waitMs = 0,
      maxWaitMs,
      strict = false,
      requestScope,
      indicatorWindowOwner,
    }: GetBarsOptions = {},
  ): Promise<FeedResult> {
    const plan = planBarsFetch({
      from,
      to,
      countBack,
      days,
      ...(fallbackDays === undefined ? {} : { fallbackDays }),
      intervalSeconds: parseIntervalSeconds(series.interval),
    });

    if (plan.type === "range") {
      const result = await this.getRange(series, {
        start: plan.range.start,
        end: plan.range.end,
        repair,
        waitMs,
        strict,
        source,
        ...(signal === undefined ? {} : { signal }),
        commit,
        ...(requestScope === undefined ? {} : { requestScope }),
        ...(indicatorWindowOwner === undefined ? {} : { indicatorWindowOwner }),
      });
      return { ...result, plan };
    }

    if (plan.type === "before") {
      const result = await this.getBefore(series, {
        before: plan.before,
        bars: plan.bars,
        source,
        ...(signal === undefined ? {} : { signal }),
        commit,
        ...(requestScope === undefined ? {} : { requestScope }),
        ...(maxWaitMs === undefined ? {} : { maxWaitMs }),
        ...(indicatorWindowOwner === undefined ? {} : { indicatorWindowOwner }),
      });
      return { ...result, plan };
    }

    const result = await this.getHistory(series, {
      days: plan.days,
      countBack: plan.countBack,
      source,
      ...(signal === undefined ? {} : { signal }),
      commit,
      ...(requestScope === undefined ? {} : { requestScope }),
      ...(indicatorWindowOwner === undefined ? {} : { indicatorWindowOwner }),
    });
    return { ...result, plan };
  }

  async getHistory(
    series: MarketSeries,
    {
      days,
      countBack,
      source = "history",
      signal,
      commit = "active",
      requestScope,
      indicatorWindowOwner: requestedIndicatorWindowOwner,
    }: GetHistoryOptions = {},
  ): Promise<AppliedKlineResult> {
    if (!this.isSeriesRequestAllowed(series)) return dataPlaneDisabledResult();
    const epoch = this.currentEpoch(series);
    const indicatorWindowOwner = requestedIndicatorWindowOwner || this.indicatorWindowOwner(
      "history",
      series,
      epoch,
      [days, countBack, requestScope],
    );
    const transportDemand = this.transportDemandOptions(series);
    const key = requestKeyFor("history", series, {
      countBack,
      days,
      epoch,
      source,
      requestScope,
      ...transportDemand,
    });
    const realtimeFence = this.beginRealtimeRequest(series);
    return this.inflight.run(key, async () => {
      if (!this.isSeriesRequestAllowed(series)) return dataPlaneDisabledResult();
      const api = await this.resolveApi();
      if (!this.isSeriesRequestAllowed(series)) return dataPlaneDisabledResult();
      const result = await api.fetchKlinesHistory(
        series.symbol,
        series.interval,
        days,
        series.marketType,
        series.exchange,
        {
          ...(countBack === undefined ? {} : { countBack }),
          ...(signal === undefined ? {} : { signal }),
          ...transportDemand,
        },
      );
      return this.applyResult(series, result, {
        epoch,
        source,
        commit,
        mode: "range",
        expectedRealtimeVersion: realtimeFence.version,
        indicatorWindowOwner,
      });
    }).finally(() => {
      this.endRealtimeRequest(realtimeFence);
    });
  }

  async getBefore(
    series: MarketSeries,
    {
      before,
      bars = 500,
      source = "before",
      signal,
      commit = "active",
      requestScope,
      maxWaitMs,
      indicatorWindowOwner: requestedIndicatorWindowOwner,
    }: GetBeforeOptions = {},
  ): Promise<AppliedKlineResult> {
    if (!this.isSeriesRequestAllowed(series)) return dataPlaneDisabledResult();
    const epoch = this.currentEpoch(series);
    const indicatorWindowOwner = requestedIndicatorWindowOwner || this.indicatorWindowOwner(
      "before",
      series,
      epoch,
      [before, bars, requestScope],
    );
    const transportDemand = this.transportDemandOptions(series);
    const key = requestKeyFor("before", series, {
      before,
      bars,
      epoch,
      source,
      requestScope,
      maxWaitMs,
      ...transportDemand,
    });
    const realtimeFence = this.beginRealtimeRequest(series);
    return this.inflight.run(key, async () => {
      if (!this.isSeriesRequestAllowed(series)) return dataPlaneDisabledResult();
      const api = await this.resolveApi();
      if (!this.isSeriesRequestAllowed(series)) return dataPlaneDisabledResult();
      const result = await api.fetchKlinesBefore(
        series.symbol,
        series.interval,
        before,
        bars,
        series.marketType,
        series.exchange,
        {
          ...(signal === undefined ? {} : { signal }),
          ...(maxWaitMs === undefined ? {} : { maxWaitMs }),
          ...transportDemand,
        },
      );
      throwIfAborted(signal);
      const applied = this.applyResult(series, result, {
        epoch,
        source,
        commit,
        mode: "range",
        expectedRealtimeVersion: realtimeFence.version,
        indicatorWindowOwner,
      });
      if (!applied.stale) this.updateBeforePageAvailability(series, before, applied);
      return applied;
    }).finally(() => {
      this.endRealtimeRequest(realtimeFence);
    });
  }

  async getRange(
    series: MarketSeries,
    {
      start,
      end,
      startSec,
      endSec,
      repair = "async",
      waitMs = 0,
      strict = false,
      source = "range",
      signal,
      commit = "active",
      maxPages = 20,
      requestScope,
      indicatorWindowOwner: requestedIndicatorWindowOwner,
    }: GetRangeOptions = {},
  ): Promise<FeedResult> {
    const range = normalizeRangeSec({ start, end, startSec, endSec });
    if (!range) {
      return { data: [], rows: [], skipped: true, reason: "invalid-range" };
    }
    if (!this.isSeriesRequestAllowed(series)) return dataPlaneDisabledResult();

    const epoch = this.currentEpoch(series);
    const indicatorWindowOwner = requestedIndicatorWindowOwner || this.indicatorWindowOwner(
      "range",
      series,
      epoch,
      [range.start, range.end, requestScope],
    );
    const transportDemand = this.transportDemandOptions(series);
    const key = requestKeyFor("range", series, {
      start: range.start,
      end: range.end,
      epoch,
      repair,
      waitMs,
      strict,
      source,
      maxPages,
      requestScope,
      ...transportDemand,
    });
    const realtimeFence = this.beginRealtimeRequest(series);
    return this.inflight.run(key, async () => {
      if (!this.isSeriesRequestAllowed(series)) return dataPlaneDisabledResult();
      const api = await this.resolveApi();
      const pages: AppliedKlineResult[] = [];
      const combinedByTime = new Map<EpochSeconds, KlineBar>();
      const pageLimit = Math.max(1, Math.floor(Number(maxPages) || 1));
      let pageEnd = range.end;
      let finalResult: AppliedKlineResult | null = null;
      let paginationStopReason: FeedResult["pagination_stop_reason"];

      for (let page = 0; page < pageLimit && pageEnd >= range.start; page += 1) {
        if (!this.isSeriesRequestAllowed(series)) return dataPlaneDisabledResult();
        throwIfAborted(signal);
        const result = await api.fetchKlinesRange(
          series.symbol,
          series.interval,
          range.start,
          pageEnd,
          series.marketType,
          series.exchange,
          {
            repair,
            waitMs,
            strict,
            ...(signal === undefined ? {} : { signal }),
            ...transportDemand,
          },
        );
        throwIfAborted(signal);
        const applied = this.applyResult(series, result, {
          epoch,
          source,
          commit,
          mode: "range",
          expectedRealtimeVersion: realtimeFence.version,
          indicatorWindowOwner,
        });
        finalResult = applied;
        pages.push(applied);
        for (const row of rowsFromResult(applied)) {
          if (row?.time != null) combinedByTime.set(row.time, row);
        }
        if (applied.stale || !result.truncated) break;
        if (page + 1 >= pageLimit) {
          paginationStopReason = "cap";
          break;
        }
        if (result.next_end_ms == null) {
          paginationStopReason = "missing-cursor";
          break;
        }
        const nextEndMs = toEpochMilliseconds(result.next_end_ms);
        const nextEnd = nextEndMs == null ? null : millisecondsToSeconds(nextEndMs);
        if (nextEnd == null || nextEnd >= pageEnd) {
          paginationStopReason = "stalled-cursor";
          break;
        }
        if (nextEnd < range.start) break;
        pageEnd = nextEnd;
      }

      const combinedRows = Array.from(combinedByTime.values())
        .sort((left, right) => left.time - right.time);
      const combinedMissing = mergeStructuredRanges(
        pages.flatMap((page) => missingRanges(page)),
      );
      const combinedExcluded = mergeStructuredRanges(
        pages.flatMap((page) => page.excluded_ranges || []),
      );
      const incompletePagination = paginationStopReason !== undefined;
      const pageHasRealPendingWork = (page: AppliedKlineResult): boolean => {
        if (missingRanges(page).length > 0) return true;
        // A capped page may advertise complete=false / pending solely because
        // its original request extended beyond this cursor. Once all cursors
        // are consumed, that is pagination metadata rather than repair work.
        if (page.truncated) return false;
        return isKlineResultRepairPending({ ...page, truncated: false });
      };
      const semanticPending = pages.some(pageHasRealPendingWork);
      const anyVerifiedFalse = pages.some((page) => (
        page.verified_contiguous === false
        && (!page.truncated || missingRanges(page).length > 0)
      ));
      const allExplicitlyVerified = pages.length > 0
        && pages.every((page) => (
          page.verified_contiguous === true
          || (page.truncated && missingRanges(page).length === 0)
        ));
      const verifiedContiguous = incompletePagination || combinedMissing.length > 0 || anyVerifiedFalse
        ? false
        : (allExplicitlyVerified ? true : finalResult?.verified_contiguous);
      const pending = incompletePagination || semanticPending || verifiedContiguous === false;
      const combinedResult: FeedResult = {
        ...(finalResult || {}),
        data: combinedRows,
        rows: combinedRows,
        pages,
        pageCount: pages.length,
        start_ms: secondsToMilliseconds(range.start),
        end_ms: secondsToMilliseconds(range.end),
        truncated: incompletePagination,
        ...(paginationStopReason === undefined ? {} : { pagination_stop_reason: paginationStopReason }),
        ...(combinedMissing.length === 0 ? {} : { missing_ranges: combinedMissing }),
        ...(combinedExcluded.length === 0 ? {} : { excluded_ranges: combinedExcluded }),
        ...(verifiedContiguous === undefined ? {} : { verified_contiguous: verifiedContiguous }),
        ...(pending ? {
          complete: false,
          retryable: paginationStopReason === "missing-cursor"
            || paginationStopReason === "stalled-cursor"
            ? false
            : true,
          history_state: "pending" as const,
          ...(paginationStopReason === "missing-cursor"
            || paginationStopReason === "stalled-cursor"
            ? { terminal_reason: `pagination_${paginationStopReason}` }
            : {}),
        } : {}),
        ...(finalResult?.plan === undefined ? {} : { plan: finalResult.plan }),
        indicatorWindowOwner,
      };
      const terminalPagination = paginationStopReason === "missing-cursor"
        || paginationStopReason === "stalled-cursor";
      if (
        terminalPagination
        && this.isCurrent(series, epoch)
        && (commit === "always" || (commit === "active" && this.shouldCommitActive(series)))
      ) {
        this.commitMergedChartData(series.symbol, series.interval, [], {
          source,
          deferIndicatorWindow: false,
          indicatorWindowOwner,
        });
      }
      return combinedResult;
    }).finally(() => {
      this.endRealtimeRequest(realtimeFence);
    });
  }

  async getLatest(
    series: MarketSeries,
    {
      limit = 2,
      source = "latest",
      apiSource = "",
      signal,
      commit = "patch-active",
    }: GetLatestOptions = {},
  ): Promise<AppliedKlineResult> {
    if (!this.isSeriesRequestAllowed(series)) return dataPlaneDisabledResult();
    const epoch = this.currentEpoch(series);
    const key = requestKeyFor("latest", series, { apiSource, epoch, limit, source });
    const realtimeFence = this.beginRealtimeRequest(series);
    return this.inflight.run(key, async () => {
      if (!this.isSeriesRequestAllowed(series)) return dataPlaneDisabledResult();
      const api = await this.resolveApi();
      if (!this.isSeriesRequestAllowed(series)) return dataPlaneDisabledResult();
      const result = await api.fetchLatestKlines(
        series.symbol,
        series.interval,
        limit,
        series.marketType,
        series.exchange,
        apiSource,
        signal === undefined ? {} : { signal },
      );
      return this.applyResult(series, result, {
        epoch,
        source,
        commit,
        mode: "tick",
        expectedRealtimeVersion: realtimeFence.version,
      });
    }).finally(() => {
      this.endRealtimeRequest(realtimeFence);
    });
  }

  applyResult(
    series: MarketSeries,
    result: KlineFetchResult,
    {
      epoch,
      source,
      commit,
      mode,
      expectedRealtimeVersion,
      indicatorWindowOwner,
    }: ApplyResultOptions,
  ): AppliedKlineResult {
    const rawRows = rowsFromResult(result);
    const active = this.shouldCommitActive(series);
    if (!this.isCurrent(series, epoch)) {
      return {
        ...result,
        data: rawRows,
        rows: rawRows,
        committed: false,
        stale: true,
        active,
        ...(indicatorWindowOwner ? { indicatorWindowOwner } : {}),
      };
    }
    const rows = this.reconcileRealtimeRows(
      series,
      result,
      rawRows,
      expectedRealtimeVersion,
    );

    this.invalidateBeforePageAvailabilityFromObservation(series, {
      rows,
      revision: result.availability_revision,
      revisionPresent: Object.prototype.hasOwnProperty.call(
        result,
        "availability_revision",
      ),
    });
    this.recordExcludedRanges(series, result);

    if (rows.length > 0) {
      if (commit === "always" || (commit === "active" && active)) {
        this.commitMergedChartData(series.symbol, series.interval, rows, {
          source,
          deferIndicatorWindow: isKlineResultRepairPending(result),
          ...(indicatorWindowOwner ? { indicatorWindowOwner } : {}),
        });
        return {
          ...result,
          data: rows,
          rows,
          committed: true,
          stale: false,
          active,
          ...(indicatorWindowOwner ? { indicatorWindowOwner } : {}),
        };
      }
      if (commit === "patch-active" && active) {
        this.commitPatchedChartData(series.symbol, series.interval, rows, {
          seedIfEmpty: true,
          source,
        });
        return { ...result, data: rows, rows, committed: true, stale: false, active };
      }
      if (commit === "none") {
        // Snapshot callers own an atomic replacement and must not mutate the
        // active/cache window before they have revalidated session ownership.
      } else if (commit === "patch-cache") {
        for (const row of rows) {
          this.patchCacheTick(series.symbol, series.interval, row, {
            marketType: series.marketType,
            exchange: series.exchange,
          });
        }
      } else {
        this.mergeCacheData(series.symbol, series.interval, rows, {
          marketType: series.marketType,
          exchange: series.exchange,
        });
      }
    }

    if (
      rows.length === 0
      && (commit === "always" || (commit === "active" && active))
      && !isKlineResultRepairPending(result)
      && (
        result.complete === true
        || result.retryable === false
        || result.history_state === "ready"
        || result.history_state === "exhausted"
      )
    ) {
      // A terminal/settled probe may legitimately contain no new rows. Give
      // the chart owner a chance to publish (or discard) indicator deltas that
      // were staged by earlier partial commits for this exact series.
      this.commitMergedChartData(series.symbol, series.interval, [], {
        source,
        deferIndicatorWindow: false,
        ...(indicatorWindowOwner ? { indicatorWindowOwner } : {}),
      });
    }

    return {
      ...result,
      data: rows,
      rows,
      committed: false,
      stale: false,
      active,
      mode,
      ...(indicatorWindowOwner ? { indicatorWindowOwner } : {}),
    };
  }
}
