import type { WindowDelta } from "../market-data/klineContracts.js";
import type { SeriesWindowStore } from "../market-data/window/seriesWindowStore.js";
import { createIntervalTimeline } from "../../utils/intervalTimeline.js";
import { replayDisplayBarToKline } from "./replaySeriesProjection.js";
import type { ReplayDigest, ReplayDisplayBar } from "./replayTypes.js";


const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const HISTORY_PAGE_LIMIT = 1_000;

export interface ReplayHistoryIdentity {
  readonly exchange: string;
  readonly market_type: string;
  readonly symbol: string;
  readonly source_kind: "BAR" | "AGG_TRADE";
  readonly base_interval: string;
  readonly display_interval: string;
}

export interface ReplayHistoryPolicy {
  readonly schema_version: "replay.data-policy.v1";
  readonly indicator_warmup_bars: number;
  readonly visible_history_lookback: {
    readonly mode: "DURATION" | "ALL_AVAILABLE";
    readonly duration_ms: number | null;
  };
  readonly visible_history_rows: number;
  readonly effective_warmup_bars: number;
  readonly forward_cache_ms: number;
  readonly interval_ms: number;
  readonly policy_hash: ReplayDigest;
}

export interface ReplayHistoryExcludedRange {
  readonly start_ms: number;
  readonly end_ms: number;
  readonly reason: "source_gap" | "source_gap_affected_display_bucket";
  readonly source_reason: string;
}

export interface ReplayHistoryPage {
  readonly protocol: "replay.v2";
  readonly schema_version: "replay.history.v3";
  readonly run_id: string;
  readonly session_id: string;
  readonly track_id: string;
  readonly identity: ReplayHistoryIdentity;
  readonly data_epoch: ReplayDigest;
  readonly history_epoch: ReplayDigest;
  readonly history_boundary_ms: number;
  readonly history_policy: ReplayHistoryPolicy;
  readonly revealed_boundary_ms: number;
  readonly bars: readonly ReplayDisplayBar[];
  readonly excluded_ranges: readonly ReplayHistoryExcludedRange[];
  readonly next_before_ms: number;
  readonly has_more: boolean;
}

export interface ReplayHistoryRequest {
  readonly beforeMs: number;
  readonly revealedBoundaryMs: number;
  readonly dataEpoch: ReplayDigest;
  readonly limit?: number;
}

export interface ReplayHistoryProviderOptions {
  readonly sessionId: string;
  readonly trackId: string;
  readonly identity: ReplayHistoryIdentity;
  readonly fetcher?: typeof fetch;
  readonly apiBase?: string;
}

export class ReplayHistoryProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayHistoryProtocolError";
  }
}

export function replayHistoryStoreBeforeMs(
  store: SeriesWindowStore,
): number | null {
  const firstTime = Number(store.first()?.time);
  const beforeMs = firstTime * 1_000;
  return Number.isSafeInteger(beforeMs) && beforeMs >= 0 ? beforeMs : null;
}

export function replayHistoryInitialBeforeMs(
  replayStartMs: number | null,
  displayInterval: string | null,
): number | null {
  if (
    replayStartMs === null
    || !Number.isSafeInteger(replayStartMs)
    || replayStartMs < 0
    || displayInterval === null
  ) return null;
  const timeline = createIntervalTimeline(displayInterval);
  const replayStartSeconds = Math.floor(replayStartMs / 1_000);
  const seamSeconds = timeline?.floor(replayStartSeconds);
  const seamMs = seamSeconds === null || seamSeconds === undefined
    ? Number.NaN
    : seamSeconds * 1_000;
  return Number.isSafeInteger(seamMs) && seamMs >= 0 ? seamMs : null;
}

/**
 * Finds the exclusive display boundary that can repair a bounded replay
 * projection.  A forming right-edge bucket is never requested early; only an
 * elapsed partial left bucket or a real discontinuity after the replay seam is
 * eligible.
 */
export function replayHistoryRevealRepairBeforeMs(
  store: SeriesWindowStore,
  replayStartMs: number | null,
  revealedBoundaryMs: number | null,
  displayInterval: string | null,
): number | null {
  if (
    replayStartMs === null
    || revealedBoundaryMs === null
    || !Number.isSafeInteger(replayStartMs)
    || !Number.isSafeInteger(revealedBoundaryMs)
    || replayStartMs < 0
    || revealedBoundaryMs < 0
    || displayInterval === null
  ) return null;
  const timeline = createIntervalTimeline(displayInterval);
  const seamSeconds = timeline?.floor(Math.floor(replayStartMs / 1_000));
  if (seamSeconds === null || seamSeconds === undefined) return null;
  const seamMs = seamSeconds * 1_000;
  if (!Number.isSafeInteger(seamMs) || seamMs < 0) return null;

  const rows = store.snapshot();
  const projectionIndex = rows.findIndex((row) => row.replayContextHistory !== true);
  if (projectionIndex < 0) return null;
  const firstProjection = rows[projectionIndex];
  if (!firstProjection) return null;
  const projectionOpenMs = Number(firstProjection.time) * 1_000;
  const projectionCloseMs = Number(firstProjection.replayCloseTimeMs);
  if (!Number.isSafeInteger(projectionOpenMs) || projectionOpenMs < 0) return null;

  if (
    firstProjection.replayClosed !== true
    && Number.isSafeInteger(projectionCloseMs)
    && projectionCloseMs >= projectionOpenMs
    && projectionCloseMs <= revealedBoundaryMs
    && Number.isSafeInteger(projectionCloseMs + 1)
  ) {
    return projectionCloseMs + 1;
  }
  if (projectionOpenMs <= seamMs) return null;

  const previous = rows[projectionIndex - 1];
  const previousCloseMs = Number(previous?.replayCloseTimeMs);
  if (
    previous?.replayContextHistory === true
    && Number.isSafeInteger(previousCloseMs)
    && previousCloseMs + 1 === projectionOpenMs
  ) return null;
  return projectionOpenMs <= revealedBoundaryMs ? projectionOpenMs : null;
}

function fail(path: string, message: string): never {
  throw new ReplayHistoryProtocolError(`${path}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(path, "fields do not match the replay history schema");
  }
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string");
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(path, "must be a non-negative safe integer");
  return Number(value);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function digest(value: unknown, path: string): ReplayDigest {
  const parsed = string(value, path);
  if (!DIGEST_PATTERN.test(parsed)) fail(path, "must be a canonical SHA-256 digest");
  return parsed as ReplayDigest;
}

function decimal(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!Number.isFinite(Number(parsed))) fail(path, "must be a finite decimal string");
  return parsed;
}

function optionalDecimal(value: unknown, path: string): string | null {
  return value === null ? null : decimal(value, path);
}

function optionalInteger(value: unknown, path: string): number | null {
  return value === null ? null : integer(value, path);
}

function parseIdentity(value: unknown, path: string): ReplayHistoryIdentity {
  const source = record(value, path);
  exact(source, [
    "exchange", "market_type", "symbol", "source_kind", "base_interval", "display_interval",
  ], path);
  const sourceKind = string(source.source_kind, `${path}.source_kind`);
  if (sourceKind !== "BAR" && sourceKind !== "AGG_TRADE") fail(`${path}.source_kind`, "is unsupported");
  return {
    exchange: string(source.exchange, `${path}.exchange`),
    market_type: string(source.market_type, `${path}.market_type`),
    symbol: string(source.symbol, `${path}.symbol`),
    source_kind: sourceKind,
    base_interval: string(source.base_interval, `${path}.base_interval`),
    display_interval: string(source.display_interval, `${path}.display_interval`),
  };
}

function parseHistoryPolicy(value: unknown, path: string): ReplayHistoryPolicy {
  const source = record(value, path);
  exact(source, [
    "schema_version",
    "indicator_warmup_bars",
    "visible_history_lookback",
    "visible_history_rows",
    "effective_warmup_bars",
    "forward_cache_ms",
    "interval_ms",
    "policy_hash",
  ], path);
  if (source.schema_version !== "replay.data-policy.v1") {
    fail(`${path}.schema_version`, "is unsupported");
  }
  const visible = record(source.visible_history_lookback, `${path}.visible_history_lookback`);
  exact(visible, ["mode", "duration_ms"], `${path}.visible_history_lookback`);
  const mode = string(visible.mode, `${path}.visible_history_lookback.mode`);
  if (mode !== "DURATION" && mode !== "ALL_AVAILABLE") {
    fail(`${path}.visible_history_lookback.mode`, "is unsupported");
  }
  const durationMs = optionalInteger(
    visible.duration_ms,
    `${path}.visible_history_lookback.duration_ms`,
  );
  const indicatorWarmup = integer(source.indicator_warmup_bars, `${path}.indicator_warmup_bars`);
  const visibleRows = integer(source.visible_history_rows, `${path}.visible_history_rows`);
  const effectiveWarmup = integer(source.effective_warmup_bars, `${path}.effective_warmup_bars`);
  const forwardCacheMs = integer(source.forward_cache_ms, `${path}.forward_cache_ms`);
  const intervalMs = integer(source.interval_ms, `${path}.interval_ms`);
  if (indicatorWarmup < 1 || intervalMs < 1 || forwardCacheMs < 1
    || effectiveWarmup < indicatorWarmup
    || (mode === "DURATION"
      && (durationMs === null
        || durationMs < 1
        || durationMs !== visibleRows * intervalMs
        || effectiveWarmup < visibleRows))
    || (mode === "ALL_AVAILABLE" && durationMs !== null)) {
    fail(path, "contains inconsistent history bounds");
  }
  return {
    schema_version: "replay.data-policy.v1",
    indicator_warmup_bars: indicatorWarmup,
    visible_history_lookback: { mode, duration_ms: durationMs },
    visible_history_rows: visibleRows,
    effective_warmup_bars: effectiveWarmup,
    forward_cache_ms: forwardCacheMs,
    interval_ms: intervalMs,
    policy_hash: digest(source.policy_hash, `${path}.policy_hash`),
  };
}

function parseBar(value: unknown, path: string): ReplayDisplayBar {
  const source = record(value, path);
  exact(source, [
    "open_time_ms", "close_time_ms", "open", "high", "low", "close", "volume",
    "quote_volume", "trades", "taker_buy_base", "taker_buy_quote", "first_base_open_ms",
    "last_base_open_ms", "component_count", "expected_components", "is_closed", "synthetic",
  ], path);
  const openTime = integer(source.open_time_ms, `${path}.open_time_ms`);
  const closeTime = integer(source.close_time_ms, `${path}.close_time_ms`);
  const firstBase = integer(source.first_base_open_ms, `${path}.first_base_open_ms`);
  const lastBase = integer(source.last_base_open_ms, `${path}.last_base_open_ms`);
  const componentCount = integer(source.component_count, `${path}.component_count`);
  const expectedComponents = integer(source.expected_components, `${path}.expected_components`);
  if (closeTime < openTime || firstBase < openTime || lastBase < firstBase || lastBase > closeTime) {
    fail(path, "bar time bounds are inconsistent");
  }
  if (componentCount < 1 || expectedComponents < 1 || componentCount > expectedComponents) {
    fail(path, "bar component counts are inconsistent");
  }
  if (!boolean(source.is_closed, `${path}.is_closed`)) fail(path, "history bars must be closed");
  return {
    open_time_ms: openTime as ReplayDisplayBar["open_time_ms"],
    close_time_ms: closeTime as ReplayDisplayBar["close_time_ms"],
    open: decimal(source.open, `${path}.open`) as ReplayDisplayBar["open"],
    high: decimal(source.high, `${path}.high`) as ReplayDisplayBar["high"],
    low: decimal(source.low, `${path}.low`) as ReplayDisplayBar["low"],
    close: decimal(source.close, `${path}.close`) as ReplayDisplayBar["close"],
    volume: decimal(source.volume, `${path}.volume`) as ReplayDisplayBar["volume"],
    quote_volume: optionalDecimal(source.quote_volume, `${path}.quote_volume`) as ReplayDisplayBar["quote_volume"],
    trades: optionalInteger(source.trades, `${path}.trades`),
    taker_buy_base: optionalDecimal(source.taker_buy_base, `${path}.taker_buy_base`) as ReplayDisplayBar["taker_buy_base"],
    taker_buy_quote: optionalDecimal(source.taker_buy_quote, `${path}.taker_buy_quote`) as ReplayDisplayBar["taker_buy_quote"],
    first_base_open_ms: firstBase as ReplayDisplayBar["first_base_open_ms"],
    last_base_open_ms: lastBase as ReplayDisplayBar["last_base_open_ms"],
    component_count: componentCount,
    expected_components: expectedComponents,
    is_closed: true,
    synthetic: boolean(source.synthetic, `${path}.synthetic`),
  };
}

function parseExcludedRange(
  value: unknown,
  path: string,
): ReplayHistoryExcludedRange {
  const source = record(value, path);
  exact(source, ["start_ms", "end_ms", "reason", "source_reason"], path);
  const startMs = integer(source.start_ms, `${path}.start_ms`);
  const endMs = integer(source.end_ms, `${path}.end_ms`);
  if (endMs < startMs) fail(path, "must contain an ordered inclusive range");
  const reason = string(source.reason, `${path}.reason`);
  if (reason !== "source_gap" && reason !== "source_gap_affected_display_bucket") {
    fail(`${path}.reason`, "is unsupported");
  }
  return {
    start_ms: startMs,
    end_ms: endMs,
    reason,
    source_reason: string(source.source_reason, `${path}.source_reason`),
  };
}

function exclusionsCover(
  ranges: readonly ReplayHistoryExcludedRange[],
  startMs: number,
  endMs: number,
): boolean {
  if (startMs > endMs) return true;
  let cursorMs = startMs;
  for (const range of ranges) {
    if (range.end_ms < cursorMs) continue;
    if (range.start_ms > cursorMs) return false;
    cursorMs = Math.max(cursorMs, range.end_ms + 1);
    if (cursorMs > endMs) return true;
  }
  return false;
}

function sameIdentity(left: ReplayHistoryIdentity, right: ReplayHistoryIdentity): boolean {
  return left.exchange === right.exchange
    && left.market_type === right.market_type
    && left.symbol === right.symbol
    && left.source_kind === right.source_kind
    && left.base_interval === right.base_interval
    && left.display_interval === right.display_interval;
}

function parsePage(
  value: unknown,
  {
    sessionId,
    trackId,
    identity,
    request,
    expectedHistoryEpoch,
  }: {
    sessionId: string;
    trackId: string;
    identity: ReplayHistoryIdentity;
    request: Required<ReplayHistoryRequest>;
    expectedHistoryEpoch: ReplayDigest | null;
  },
): ReplayHistoryPage {
  const source = record(value, "history");
  exact(source, [
    "protocol", "schema_version", "run_id", "session_id", "track_id", "identity", "data_epoch",
    "history_epoch", "history_boundary_ms", "history_policy", "revealed_boundary_ms",
    "bars", "excluded_ranges", "next_before_ms", "has_more",
  ], "history");
  if (source.protocol !== "replay.v2") fail("history.protocol", "must be replay.v2");
  if (source.schema_version !== "replay.history.v3") fail("history.schema_version", "is unsupported");
  const parsedSession = string(source.session_id, "history.session_id");
  const parsedTrack = string(source.track_id, "history.track_id");
  if (parsedSession !== sessionId || parsedTrack !== trackId) fail("history", "session or track identity drifted");
  const parsedIdentity = parseIdentity(source.identity, "history.identity");
  if (!sameIdentity(parsedIdentity, identity)) fail("history.identity", "source identity drifted");
  const dataEpoch = digest(source.data_epoch, "history.data_epoch");
  if (dataEpoch !== request.dataEpoch) fail("history.data_epoch", "does not match the active replay snapshot");
  const historyEpoch = digest(source.history_epoch, "history.history_epoch");
  if (expectedHistoryEpoch !== null && historyEpoch !== expectedHistoryEpoch) {
    fail("history.history_epoch", "changed during the replay session");
  }
  const boundary = integer(source.revealed_boundary_ms, "history.revealed_boundary_ms");
  if (boundary !== request.revealedBoundaryMs) fail("history.revealed_boundary_ms", "does not match the request");
  const historyBoundary = integer(source.history_boundary_ms, "history.history_boundary_ms");
  if (historyBoundary > boundary) fail("history.history_boundary_ms", "exceeds the revealed boundary");
  const historyPolicy = parseHistoryPolicy(source.history_policy, "history.history_policy");
  if (!Array.isArray(source.excluded_ranges)) fail("history.excluded_ranges", "must be an array");
  const excludedRanges = source.excluded_ranges.map(
    (item, index) => parseExcludedRange(item, `history.excluded_ranges[${index}]`),
  );
  for (const [index, range] of excludedRanges.entries()) {
    if (range.start_ms < historyBoundary || range.end_ms >= request.beforeMs) {
      fail(`history.excluded_ranges[${index}]`, "is outside the requested history page");
    }
    const previous = excludedRanges[index - 1];
    if (previous !== undefined && range.start_ms <= previous.end_ms) {
      fail(`history.excluded_ranges[${index}]`, "overlaps a previous excluded range");
    }
  }
  if (!Array.isArray(source.bars)) fail("history.bars", "must be an array");
  const bars = source.bars.map((item, index) => parseBar(item, `history.bars[${index}]`));
  let previousOpen = -1;
  let previousClose = -1;
  for (const [index, item] of bars.entries()) {
    if (item.open_time_ms <= previousOpen) fail(`history.bars[${index}]`, "must be strictly increasing");
    if (previousClose >= 0 && item.open_time_ms !== previousClose + 1
      && !exclusionsCover(excludedRanges, previousClose + 1, item.open_time_ms - 1)) {
      fail(`history.bars[${index}]`, "contains an undeclared gap after the previous history bar");
    }
    if (item.open_time_ms >= request.beforeMs) fail(`history.bars[${index}]`, "is outside the before-page");
    if (item.open_time_ms < historyBoundary) {
      fail(`history.bars[${index}]`, "precedes the visible history boundary");
    }
    if (item.close_time_ms > boundary || item.last_base_open_ms > boundary) {
      fail(`history.bars[${index}]`, "exceeds the revealed boundary");
    }
    if (excludedRanges.some((range) => (
      range.start_ms <= item.close_time_ms && range.end_ms >= item.open_time_ms
    ))) {
      fail(`history.bars[${index}]`, "overlaps an excluded source range");
    }
    previousOpen = item.open_time_ms;
    previousClose = item.close_time_ms;
  }
  const nextBefore = integer(source.next_before_ms, "history.next_before_ms");
  if (bars.length > 0 && nextBefore !== bars[0]?.open_time_ms) {
    fail("history.next_before_ms", "must point at the oldest returned bar");
  }
  return {
    protocol: "replay.v2",
    schema_version: "replay.history.v3",
    run_id: string(source.run_id, "history.run_id"),
    session_id: parsedSession,
    track_id: parsedTrack,
    identity: parsedIdentity,
    data_epoch: dataEpoch,
    history_epoch: historyEpoch,
    history_boundary_ms: historyBoundary,
    history_policy: historyPolicy,
    revealed_boundary_ms: boundary,
    bars,
    excluded_ranges: excludedRanges,
    next_before_ms: nextBefore,
    has_more: boolean(source.has_more, "history.has_more"),
  };
}

export class ReplayHistoryProvider {
  readonly sessionId: string;
  readonly trackId: string;
  readonly identity: ReplayHistoryIdentity;
  private readonly fetcher: typeof fetch;
  private readonly apiBase: string;
  private readonly inflight = new Map<string, { controller: AbortController; promise: Promise<ReplayHistoryPage> }>();
  private epoch: ReplayDigest | null = null;
  private generation = 0;

  constructor({ sessionId, trackId, identity, fetcher = fetch, apiBase = "" }: ReplayHistoryProviderOptions) {
    this.sessionId = sessionId;
    this.trackId = trackId;
    this.identity = identity;
    this.fetcher = fetcher;
    this.apiBase = apiBase.replace(/\/$/, "");
  }

  get historyEpoch(): ReplayDigest | null {
    return this.epoch;
  }

  loadBefore(input: ReplayHistoryRequest): Promise<ReplayHistoryPage> {
    const request: Required<ReplayHistoryRequest> = {
      ...input,
      limit: input.limit ?? 500,
    };
    if (!Number.isSafeInteger(request.beforeMs) || request.beforeMs < 0
      || !Number.isSafeInteger(request.revealedBoundaryMs) || request.revealedBoundaryMs < 0
      || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > HISTORY_PAGE_LIMIT
      || !DIGEST_PATTERN.test(request.dataEpoch)) {
      return Promise.reject(new ReplayHistoryProtocolError("history request is invalid"));
    }
    const key = `${request.dataEpoch}:${request.revealedBoundaryMs}:${request.beforeMs}:${request.limit}:${this.epoch ?? "initial"}`;
    const existing = this.inflight.get(key);
    if (existing) return existing.promise;

    const controller = new AbortController();
    const params = new URLSearchParams({
      track_id: this.trackId,
      display_interval: this.identity.display_interval,
      before_ms: String(request.beforeMs),
      revealed_boundary_ms: String(request.revealedBoundaryMs),
      limit: String(request.limit),
      data_epoch: request.dataEpoch,
    });
    if (this.epoch !== null) params.set("history_epoch", this.epoch);
    const url = `${this.apiBase}/api/v1/replay/runs/session/${encodeURIComponent(this.sessionId)}/history?${params}`;
    const expectedEpoch = this.epoch;
    const generation = this.generation;
    const fetcher = this.fetcher;
    const promise = fetcher(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) {
        throw new ReplayHistoryProtocolError(`history request failed with HTTP ${response.status}`);
      }
      const page = parsePage(await response.json(), {
        sessionId: this.sessionId,
        trackId: this.trackId,
        identity: this.identity,
        request,
        expectedHistoryEpoch: expectedEpoch,
      });
      if (generation !== this.generation) throw new DOMException("history request canceled", "AbortError");
      if (this.epoch !== null && page.history_epoch !== this.epoch) {
        throw new ReplayHistoryProtocolError("history epoch changed during the replay session");
      }
      this.epoch = page.history_epoch;
      return page;
    }).finally(() => {
      if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key);
    });
    this.inflight.set(key, { controller, promise });
    return promise;
  }

  cancel(): void {
    this.generation += 1;
    for (const request of this.inflight.values()) request.controller.abort();
    this.inflight.clear();
    this.epoch = null;
  }
}

export function applyReplayHistoryPage(
  store: SeriesWindowStore,
  page: ReplayHistoryPage,
  {
    expectedBeforeMs,
    contextHistory = false,
  }: {
    readonly expectedBeforeMs?: number;
    readonly contextHistory?: boolean;
  } = {},
): WindowDelta {
  if (expectedBeforeMs !== undefined) {
    if (!Number.isSafeInteger(expectedBeforeMs) || expectedBeforeMs < 0) {
      throw new ReplayHistoryProtocolError("history cursor must be a non-negative safe integer");
    }
    const newestHistoryBar = page.bars.at(-1);
    const connectionStartMs = newestHistoryBar === undefined
      ? expectedBeforeMs
      : newestHistoryBar.close_time_ms + 1;
    if (newestHistoryBar !== undefined
      && connectionStartMs !== expectedBeforeMs
      && (connectionStartMs > expectedBeforeMs || !exclusionsCover(
        page.excluded_ranges,
        connectionStartMs,
        expectedBeforeMs - 1,
      ))) {
      throw new ReplayHistoryProtocolError(
        "history page does not connect to the authoritative replay source window",
      );
    }
  }
  return store.applyRange(page.bars.map((bar) => ({
    ...replayDisplayBarToKline(bar),
    ...(contextHistory ? { replayContextHistory: true } : {}),
  })), {
    source: "replay-history-before-page",
    sessionId: page.session_id,
    trackId: page.track_id,
    dataEpoch: page.data_epoch,
    historyEpoch: page.history_epoch,
    revealedBoundaryMs: page.revealed_boundary_ms,
    excludedRangeCount: page.excluded_ranges.length,
  });
}
