import type {
  AppliedKlineResult,
  BackfillCompletedMessage,
  BackfillCompletedOptions,
  CommitChartData,
  FeedApplyMode,
  FeedCommitMode,
  FeedResult,
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
} from "../marketDataTypes.js";
import {
  millisecondsToSeconds,
  toEpochMilliseconds,
} from "../marketDataTypes.js";
import {
  eventRangeFromDetail,
  isSameSeries,
  rangeCovers,
  rangesOverlap,
  rowRangeMs,
} from "../rangeRuntime.js";
import {
  activeCoverageMsFromRows,
  intersectRanges,
  isUserVisibleBackfillReason,
} from "../phase1WindowPolicy.js";
import { parseIntervalSeconds } from "../../../utils/intervals.js";
import { InflightRegistry } from "./inflightRegistry.js";
import { KlineStreamSubscription } from "./klineStreamSubscription.js";
import {
  normalizeRangeSec,
  planBarsFetch,
  requestKeyFor,
  rowsFromResult,
  seriesKeyFor,
} from "./fetchPlanner.js";

interface RequestBeforePageOptions {
  before?: EpochSeconds;
  bars?: number;
  source?: string;
  signal?: AbortSignal;
  commit?: FeedCommitMode;
  cooldownMs?: number;
  pendingCooldownMs?: number;
  errorCooldownMs?: number;
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
  strict?: boolean;
}

interface GetHistoryOptions {
  days?: number | null;
  countBack?: number | null;
  source?: string;
  signal?: AbortSignal;
  commit?: FeedCommitMode;
}

interface GetBeforeOptions {
  before?: EpochSeconds;
  bars?: number;
  source?: string;
  signal?: AbortSignal;
  commit?: FeedCommitMode;
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
}

interface GetLatestOptions {
  limit?: number;
  source?: string;
  apiSource?: string;
  signal?: AbortSignal;
  commit?: FeedCommitMode;
}

interface ApplyResultOptions {
  epoch: number;
  source: string;
  commit: FeedCommitMode;
  mode: FeedApplyMode;
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
export class SeriesDataFeed {
  inflight: InflightRegistry;
  epochBySeries: Map<SeriesKey, number>;
  beforePageCooldownUntil: Map<SeriesKey, number>;
  pendingBeforePages: Map<SeriesKey, PendingBeforePage>;
  backfillReloadInFlight: Set<SeriesKey>;
  api: KlineApi | null;
  getActiveSeries: () => MarketSeries | null;
  isActiveSeries: (series: MarketSeries, activeSeries: MarketSeries | null) => boolean;
  mergeCacheData: MergeCacheData;
  commitMergedChartData: CommitChartData;
  commitPatchedChartData: CommitChartData;
  patchCacheTick: PatchCacheTick;

  constructor(config: SeriesDataFeedConfig = {}) {
    this.inflight = new InflightRegistry();
    this.epochBySeries = new Map();
    this.beforePageCooldownUntil = new Map();
    this.pendingBeforePages = new Map();
    this.backfillReloadInFlight = new Set();
    this.api = null;
    this.getActiveSeries = () => null;
    this.isActiveSeries = defaultIsActiveSeries;
    this.mergeCacheData = noopMergeCacheData;
    this.commitMergedChartData = noopCommitChartData;
    this.commitPatchedChartData = noopCommitChartData;
    this.patchCacheTick = noopPatchCacheTick;
    this.configure(config);
  }

  configure(config: SeriesDataFeedConfig = {}): void {
    this.api = config.api || this.api || null;
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

  beginEpoch(series: MarketSeries): number {
    const key = this.seriesKey(series);
    const next = (this.epochBySeries.get(key) || 0) + 1;
    this.epochBySeries.set(key, next);
    return next;
  }

  currentEpoch(series: MarketSeries): number {
    return this.epochBySeries.get(this.seriesKey(series)) || 0;
  }

  isCurrent(series: MarketSeries, epoch: number): boolean {
    return this.currentEpoch(series) === epoch;
  }

  shouldCommitActive(series: MarketSeries): boolean {
    return this.isActiveSeries(series, this.getActiveSeries());
  }

  subscribeBars(
    series: Pick<MarketSeries, "exchange" | "marketType" | "symbol">,
    options: KlineStreamOptions = {},
  ): KlineStreamController {
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
    const pending = this.getPendingBeforePage(series);
    if (!pending) return null;
    const attempts = pending.completionAttempts ?? 0;
    if (attempts >= maxAttempts) {
      this.clearPendingBeforePage(series);
      return null;
    }
    pending.completionAttempts = attempts + 1;
    return pending;
  }

  handleBackfillCompleted(
    msg: BackfillCompletedMessage | null | undefined,
    {
      activeSeries = this.getActiveSeries(),
      loading = false,
      pendingInitial = null,
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
    const eventSeries = {
      exchange: msg.exchange || activeSeries?.exchange,
      marketType: msg.market_type || activeSeries?.marketType,
      symbol: msg.symbol || activeSeries?.symbol,
      interval: msg.interval || activeSeries?.interval,
    } as MarketSeries;
    const eventRange = eventRangeFromDetail(detail);
    const userVisibleReason = isUserVisibleBackfillReason(detail.reason);
    const pendingBeforePage = this.getPendingBeforePage(eventSeries);
    const isPendingInitial = Boolean(
      pendingInitial && isSameSeries(eventSeries, pendingInitial),
    );
    const isPendingLoadMore = Boolean(pendingBeforePage);

    if (!userVisibleReason && !isPendingInitial && !isPendingLoadMore) {
      this.clearPendingBeforePage(eventSeries);
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

    const reloadKey = this.seriesKey(eventSeries);
    if (this.backfillReloadInFlight.has(reloadKey)) {
      console.log(`[Backfill] Skipping duplicate reload for ${reloadKey} (already in-flight/cooldown)`);
      return true;
    }
    this.backfillReloadInFlight.add(reloadKey);

    const canReleaseInitialLoading = (rows: KlineBar[]): boolean => {
      if (!isSameSeries(eventSeries, activeSeries)) return false;
      if (!loading) return true;

      const rowsRange = rowRangeMs(rows);
      if (pendingInitial && isSameSeries(eventSeries, pendingInitial)) {
        if (!pendingInitial.range) return true;
        if (rowsRange && rangesOverlap(rowsRange, pendingInitial.range)) return true;
        if (eventRange && rangesOverlap(eventRange, pendingInitial.range)) return true;
        if (
          detail.verified_contiguous === true
          && rangeCovers(eventRange, pendingInitial.range)
        ) return true;
        return false;
      }

      return userVisibleReason;
    };

    const afterBackfillRows = (rows: KlineBar[]): boolean => {
      if (!rows?.length) return false;
      if (isSameSeries(eventSeries, activeSeries)) {
        setLastPrice((prev) => prev || rows[rows.length - 1] || prev);
        setError(null);
        if (canReleaseInitialLoading(rows)) {
          clearPendingInitial();
          setConnectionStatus("connected");
          setLoading(false);
        }
      }
      return true;
    };

    const readBackfilledData = async (): Promise<void> => {
      const startMs = toEpochMilliseconds(detail.range_start_ms ?? detail.request_start_ms);
      const endMs = toEpochMilliseconds(detail.range_end_ms ?? detail.request_end_ms);
      const requestedRange: TimeRangeMs | null = (
        startMs != null && endMs != null && endMs > startMs
      ) ? { start: startMs, end: endMs } : null;
      const fetchRange = (
        (isPendingInitial || isPendingLoadMore)
          ? requestedRange
          : (activeOverlap || intersectRanges(requestedRange, activeCoverage))
      );
      let loadedAny = false;
      let lastError: unknown = null;

      if (fetchRange) {
        try {
          const result = await this.getBars(eventSeries, {
            from: millisecondsToSeconds(fetchRange.start),
            to: millisecondsToSeconds(fetchRange.end),
            repair: "none",
            strict: false,
            source: "backfill-completed",
          });
          loadedAny = afterBackfillRows(result?.data || []) || loadedAny;
        } catch (error) {
          lastError = error;
          console.warn(`[Backfill] Exact range reload failed for ${reloadKey}:`, error);
        }
      }

      if (!loadedAny && isPendingInitial) {
        try {
          const result = await this.getBars(eventSeries, {
            fallbackDays: getFallbackDays(eventSeries),
            countBack: 1_500,
            source: "backfill-completed",
          });
          loadedAny = afterBackfillRows(result?.data || []) || loadedAny;
        } catch (error) {
          lastError = error;
          console.warn(`[Backfill] History reload failed for ${reloadKey}:`, error);
        }
      }

      if (!loadedAny && lastError) {
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      }
    };

    void readBackfilledData()
      .then(() => {
        const pending = this.beginBeforePageCompletionAttempt(
          eventSeries,
          completionMaxAttempts,
        );
        if (!pending) return undefined;
        return this.getBars(eventSeries, {
          to: pending.before,
          countBack: 500,
          source: "backfill-before-page",
        })
          .then((result) => {
            const older = result?.data || [];
            if (older.length > 0 || result?.has_more === false) {
              this.clearPendingBeforePage(eventSeries);
            }
          })
          .catch((error: unknown) => {
            console.warn(`[Backfill] Pending before-page fetch failed for ${reloadKey}:`, error);
          });
      })
      .catch((error: unknown) => {
        console.warn(`Failed to reload after backfill for ${eventSeries.interval}:`, error);
      })
      .finally(() => {
        setTimeout(() => {
          this.backfillReloadInFlight.delete(reloadKey);
        }, cooldownMs);
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
    }: RequestBeforePageOptions = {},
  ): Promise<FeedResult> {
    if (this.isBeforePageCoolingDown(series)) {
      return { skipped: true, reason: "cooldown", data: [], rows: [] };
    }

    try {
      const result = await this.getBars(series, {
        ...(before === undefined ? {} : { to: before }),
        countBack: bars,
        source,
        ...(signal === undefined ? {} : { signal }),
        commit,
      });
      const rows = result?.data || [];

      if (rows.length > 0) {
        this.clearPendingBeforePage(series);
        this.setBeforePageCooldown(series, cooldownMs);
        return { ...result, pending: false };
      }

      if (result?.has_more) {
        const existing = this.getPendingBeforePage(series);
        if (!existing || existing.before !== before) {
          this.setPendingBeforePage(series, {
            before: before as EpochSeconds,
            safetyAttempts: 0,
            completionAttempts: 0,
          });
        }
        this.setBeforePageCooldown(series, pendingCooldownMs);
        return { ...result, pending: true };
      }

      this.clearPendingBeforePage(series);
      this.setBeforePageCooldown(series, cooldownMs);
      return { ...result, pending: false };
    } catch (error) {
      this.setBeforePageCooldown(series, errorCooldownMs);
      throw error;
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
      strict = false,
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
      });
      return { ...result, plan };
    }

    const result = await this.getHistory(series, {
      days: plan.days,
      countBack: plan.countBack,
      source,
      ...(signal === undefined ? {} : { signal }),
      commit,
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
    }: GetHistoryOptions = {},
  ): Promise<AppliedKlineResult> {
    const epoch = this.currentEpoch(series);
    const key = requestKeyFor("history", series, { countBack, days, source });
    return this.inflight.run(key, async () => {
      const api = await this.resolveApi();
      const result = await api.fetchKlinesHistory(
        series.symbol,
        series.interval,
        days,
        series.marketType,
        series.exchange,
        {
          ...(countBack === undefined ? {} : { countBack }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return this.applyResult(series, result, {
        epoch,
        source,
        commit,
        mode: "range",
      });
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
    }: GetBeforeOptions = {},
  ): Promise<AppliedKlineResult> {
    const epoch = this.currentEpoch(series);
    const key = requestKeyFor("before", series, { before, bars, source });
    return this.inflight.run(key, async () => {
      const api = await this.resolveApi();
      const result = await api.fetchKlinesBefore(
        series.symbol,
        series.interval,
        before,
        bars,
        series.marketType,
        series.exchange,
        signal === undefined ? {} : { signal },
      );
      return this.applyResult(series, result, {
        epoch,
        source,
        commit,
        mode: "range",
      });
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
    }: GetRangeOptions = {},
  ): Promise<FeedResult> {
    const range = normalizeRangeSec({ start, end, startSec, endSec });
    if (!range) {
      return { data: [], rows: [], skipped: true, reason: "invalid-range" };
    }

    const epoch = this.currentEpoch(series);
    const key = requestKeyFor("range", series, {
      start: range.start,
      end: range.end,
      repair,
      waitMs,
      strict,
      source,
    });
    return this.inflight.run(key, async () => {
      const api = await this.resolveApi();
      const pages: AppliedKlineResult[] = [];
      const combinedByTime = new Map<EpochSeconds, KlineBar>();
      let pageEnd = range.end;
      let finalResult: AppliedKlineResult | null = null;

      for (let page = 0; page < maxPages && pageEnd >= range.start; page += 1) {
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
          },
        );
        const applied = this.applyResult(series, result, {
          epoch,
          source,
          commit,
          mode: "range",
        });
        finalResult = applied;
        pages.push(applied);
        for (const row of rowsFromResult(applied)) {
          if (row?.time != null) combinedByTime.set(row.time, row);
        }
        if (applied?.stale || !result?.truncated || result?.next_end_ms == null) break;
        const nextEndMs = toEpochMilliseconds(result.next_end_ms);
        const nextEnd = nextEndMs == null ? null : millisecondsToSeconds(nextEndMs);
        if (nextEnd == null || nextEnd >= pageEnd) break;
        pageEnd = nextEnd;
      }

      const combinedRows = Array.from(combinedByTime.values())
        .sort((left, right) => left.time - right.time);
      return {
        ...(finalResult || {}),
        data: combinedRows,
        rows: combinedRows,
        pages,
        pageCount: pages.length,
        truncated: Boolean(finalResult?.truncated && pages.length >= maxPages),
        ...(finalResult?.plan === undefined ? {} : { plan: finalResult.plan }),
      };
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
    const epoch = this.currentEpoch(series);
    const key = requestKeyFor("latest", series, { limit, source, apiSource });
    return this.inflight.run(key, async () => {
      const api = await this.resolveApi();
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
      });
    });
  }

  applyResult(
    series: MarketSeries,
    result: KlineFetchResult,
    { epoch, source, commit, mode }: ApplyResultOptions,
  ): AppliedKlineResult {
    const rows = rowsFromResult(result);
    const active = this.shouldCommitActive(series);
    if (!this.isCurrent(series, epoch)) {
      return { ...result, data: rows, rows, committed: false, stale: true, active };
    }

    if (rows.length > 0) {
      if (commit === "always" || (commit === "active" && active)) {
        this.commitMergedChartData(series.symbol, series.interval, rows, { source });
        return { ...result, data: rows, rows, committed: true, stale: false, active };
      }
      if (commit === "patch-active" && active) {
        this.commitPatchedChartData(series.symbol, series.interval, rows, {
          seedIfEmpty: true,
          source,
        });
        return { ...result, data: rows, rows, committed: true, stale: false, active };
      }
      if (commit === "patch-cache") {
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

    return {
      ...result,
      data: rows,
      rows,
      committed: false,
      stale: false,
      active,
      mode,
    };
  }
}
