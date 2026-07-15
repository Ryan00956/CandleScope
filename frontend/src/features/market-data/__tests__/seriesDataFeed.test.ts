import assert from "node:assert/strict";
import test from "node:test";

import { SeriesDataFeed as ProductionSeriesDataFeed } from "../feed/seriesDataFeed.js";
import type {
  BackfillCompletedMessage,
  BackfillCompletedOptions,
  KlineApi,
  KlineHistoryRequestOptions,
  KlineStreamTickEvent,
  KlineStreamSocket,
  SeriesDataFeedConfig,
} from "../klineContracts.js";
import type { KlineBar } from "../marketDataTypes.js";
import type { EpochSeconds } from "../marketDataTypes.js";
import { epochSeconds, mustBeDefined, partialMock } from "../../../test/testHelpers.js";

type TestFeedConfig = Omit<SeriesDataFeedConfig, "api"> & {
  api?: Partial<KlineApi> | null;
};

class SeriesDataFeed extends ProductionSeriesDataFeed {
  constructor(config: TestFeedConfig = {}) {
    super({
      ...config,
      api: config.api ? partialMock<KlineApi>(config.api) : null,
    });
  }
}

const SERIES = {
  exchange: "binance",
  marketType: "spot",
  symbol: "BTCUSDT",
  interval: "1h",
};

function rows(times: number[]): KlineBar[] {
  return times.map((time) => ({ time: epochSeconds(time), close: time }));
}

class FakeSocket implements KlineStreamSocket {
  static OPEN = 1;
  readonly OPEN = FakeSocket.OPEN;
  readonly url: string;
  readyState: number;
  sent: string[];
  closed: boolean;
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent<string>) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;

  constructor(url: string) {
    this.url = url;
    this.readyState = FakeSocket.OPEN;
    this.sent = [];
    this.closed = false;
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closed = true;
  }

  emit(payload: unknown): void {
    this.onmessage?.(partialMock<MessageEvent<string>>({ data: JSON.stringify(payload) }));
  }

  emitRaw(data: string): void {
    this.onmessage?.(partialMock<MessageEvent<string>>({ data }));
  }
}

test("dedupes exact range requests", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async () => {
        calls += 1;
        await pending;
        return { data: rows([10, 20]) };
      },
    },
    getActiveSeries: () => SERIES,
    mergeCacheData: () => {},
    commitMergedChartData: () => {},
  });

  const first = feed.getRange(SERIES, { start: 10, end: 20, source: "test" });
  const second = feed.getRange(SERIES, { end: 20, start: 10, source: "test" });
  mustBeDefined(release)();

  assert.equal((await first).rows.length, 2);
  assert.equal((await second).rows.length, 2);
  assert.equal(calls, 1);
});

test("drops stale responses after epoch advances", async () => {
  let commitCalls = 0;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesHistory: async () => ({ data: rows([10]) }),
    },
    getActiveSeries: () => SERIES,
    mergeCacheData: () => {
      throw new Error("stale rows must not merge");
    },
    commitMergedChartData: () => {
      commitCalls += 1;
    },
  });

  const request = feed.getHistory(SERIES, { days: 1, source: "history" });
  feed.beginEpoch(SERIES);
  const result = await request;

  assert.equal(result.stale, true);
  assert.equal(commitCalls, 0);
});

test("marks inactive responses so callers do not active-commit them", async () => {
  const actions: string[] = [];
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesBefore: async () => ({ data: rows([10]) }),
    },
    getActiveSeries: () => ({ ...SERIES, interval: "15m" }),
    mergeCacheData: () => actions.push("merge-cache"),
    commitMergedChartData: () => actions.push("commit-active"),
  });

  const result = await feed.requestBeforePage(SERIES, {
    before: epochSeconds(20),
    bars: 1,
    source: "history-before-page",
  });

  assert.equal(result.active, false);
  assert.equal(result.committed, false);
  assert.equal(result.stale, false);
  assert.deepEqual(actions, ["merge-cache"]);
});

test("commits active history rows through the active store path", async () => {
  const actions: string[] = [];
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesHistory: async () => ({ data: rows([10, 20]) }),
    },
    getActiveSeries: () => SERIES,
    mergeCacheData: () => actions.push("merge"),
    commitMergedChartData: () => actions.push("commit"),
  });

  const result = await feed.getHistory(SERIES, { days: 1, source: "initial-history" });

  assert.equal(result.committed, true);
  assert.deepEqual(actions, ["commit"]);
});

test("getBars plans countBack history using interval duration", async () => {
  let requestedDays = null;
  let requestedOptions: KlineHistoryRequestOptions | null = null;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesHistory: async (_symbol, _interval, days, _marketType, _exchange, options) => {
        requestedDays = days;
        requestedOptions = options;
        return { data: rows([10]) };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  const result = await feed.getBars(SERIES, {
    countBack: 24,
    source: "countback-history",
  });

  assert.equal(requestedDays, 1);
  assert.equal(mustBeDefined<KlineHistoryRequestOptions>(requestedOptions).countBack, 24);
  assert.equal(mustBeDefined(result.plan).type, "history");
});

test("getBars plans left paging through before endpoint", async () => {
  let request = null;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesBefore: async (_symbol, _interval, before, bars) => {
        request = { before, bars };
        return { data: rows([10]) };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  const result = await feed.getBars(SERIES, {
    to: 200,
    countBack: 500,
    source: "before",
  });

  assert.deepEqual(request, { before: 200, bars: 500 });
  assert.equal(mustBeDefined(result.plan).type, "before");
});

test("getRange follows backend truncation cursors until the requested range is covered", async () => {
  const requests: Array<{ start: EpochSeconds; end: EpochSeconds }> = [];
  const committed: EpochSeconds[][] = [];
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, _interval, start, end) => {
        requests.push({ start, end });
        if (end === 1_000) {
          return {
            data: rows([900, 1_000]),
            truncated: true,
            next_end_ms: 800_000,
          };
        }
        return {
          data: rows([100, 800]),
          truncated: false,
          next_end_ms: null,
        };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: (_symbol, _interval, nextRows) => committed.push(nextRows.map((row) => row.time)),
  });

  const result = await feed.getRange(SERIES, {
    start: 100,
    end: 1_000,
    source: "visible-range-gap",
  });

  assert.deepEqual(requests, [
    { start: 100, end: 1_000 },
    { start: 100, end: 800 },
  ]);
  assert.deepEqual(result.data.map((row) => row.time), [100, 800, 900, 1_000]);
  assert.equal(result.pageCount, 2);
  assert.deepEqual(committed, [[900, 1_000], [100, 800]]);
});

test("requestBeforePage owns pending and cooldown state", async () => {
  let calls = 0;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesBefore: async () => {
        calls += 1;
        return { data: [], has_more: true };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  const first = await feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    bars: 500,
    pendingCooldownMs: 10_000,
  });
  const second = await feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    bars: 500,
  });

  assert.equal(first.pending, true);
  assert.deepEqual(feed.getPendingBeforePage(SERIES), {
    before: epochSeconds(200),
    safetyAttempts: 0,
    completionAttempts: 0,
  });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "cooldown");
  assert.equal(calls, 1);
});

test("terminal before-page availability prevents repeated left-edge HTTP requests", async () => {
  let calls = 0;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesBefore: async () => {
        calls += 1;
        return {
          data: [],
          history_state: "exhausted",
          complete: true,
          retryable: false,
          terminal_reason: "provider_exhausted",
          earliest_available_ms: 100_000,
          availability_revision: "history-v1",
        };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  const first = await feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    bars: 500,
    cooldownMs: 0,
  });
  const second = await feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    bars: 500,
  });

  assert.equal(first.history_state, "exhausted");
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "history-exhausted");
  assert.equal(second.has_more, false);
  assert.equal(calls, 1);

  feed.invalidateBeforePageAvailability(SERIES);
  feed.resetBeforePageCooldown(SERIES);
  await feed.requestBeforePage(SERIES, {
    before: epochSeconds(100),
    bars: 500,
  });
  assert.equal(calls, 2);
});

test("new pending availability remains retryable without legacy has_more", async () => {
  let calls = 0;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesBefore: async () => {
        calls += 1;
        return {
          data: [],
          history_state: "pending",
          complete: false,
          retryable: true,
        };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  const first = await feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    bars: 500,
    pendingCooldownMs: 0,
  });
  const second = await feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    bars: 500,
    pendingCooldownMs: 0,
  });

  assert.equal(first.pending, true);
  assert.equal(second.pending, true);
  assert.equal(calls, 2);
});

test("legacy terminal pages keep old per-request semantics without persistent inference", async () => {
  let calls = 0;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesBefore: async () => {
        calls += 1;
        return { data: [], has_more: false };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  const first = await feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    bars: 500,
    cooldownMs: 0,
  });
  const second = await feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    bars: 500,
    cooldownMs: 0,
  });

  assert.equal(first.pending, false);
  assert.equal(second.skipped, undefined);
  assert.equal(calls, 2);
});

test("before-page safety and completion attempts are tracked in the feed", () => {
  const feed = new SeriesDataFeed();
  feed.setPendingBeforePage(SERIES, {
    before: epochSeconds(200),
    safetyAttempts: 0,
    completionAttempts: 0,
  });
  feed.setBeforePageCooldown(SERIES, 10_000);

  assert.equal(feed.markBeforePageSafetyRetry(SERIES, epochSeconds(200), 1), true);
  assert.equal(feed.isBeforePageCoolingDown(SERIES), false);
  assert.equal(feed.markBeforePageSafetyRetry(SERIES, epochSeconds(200), 1), false);

  assert.deepEqual(feed.beginBeforePageCompletionAttempt(SERIES, 2), {
    before: 200,
    safetyAttempts: 1,
    completionAttempts: 1,
  });
  assert.deepEqual(feed.beginBeforePageCompletionAttempt(SERIES, 2), {
    before: 200,
    safetyAttempts: 1,
    completionAttempts: 2,
  });
  assert.equal(feed.beginBeforePageCompletionAttempt(SERIES, 2), null);
  assert.equal(feed.getPendingBeforePage(SERIES), null);
});

test("backfill completion ignores non-visible events without pending work", () => {
  const feed = new SeriesDataFeed();
  assert.equal(feed.handleBackfillCompleted({
    type: "backfill_completed",
    ...SERIES,
    market_type: SERIES.marketType,
    detail: { reason: "background_gap_audit" },
  }, {
    activeSeries: SERIES,
    getCacheRows: () => [],
    cooldownMs: 0,
  }), true);
});

test("backfill completion reloads only the active overlapping range", async () => {
  const requested: Array<{ start: EpochSeconds; end: EpochSeconds }> = [];
  const committed: Array<{ rows: KlineBar[]; source: string }> = [];
  let lastPrice: KlineBar | null = null;
  let loading = true;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, _interval, start, end) => {
        requested.push({ start, end });
        return { data: rows([start, end]) };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: (_symbol, _interval, nextRows, { source }) => {
      committed.push({ rows: nextRows, source });
    },
  });

  assert.equal(feed.handleBackfillCompleted({
    type: "backfill_completed",
    symbol: SERIES.symbol,
    interval: SERIES.interval,
    exchange: SERIES.exchange,
    market_type: SERIES.marketType,
    detail: {
      reason: "visible_range_gap",
      range_start_ms: 120_000,
      range_end_ms: 180_000,
    },
  }, {
    activeSeries: SERIES,
    loading: true,
    getCacheRows: () => rows([100, 200]),
    setLastPrice: (updater) => {
      lastPrice = updater(lastPrice);
    },
    setError: () => {},
    setConnectionStatus: () => {},
    setLoading: (next) => {
      loading = next;
    },
    cooldownMs: 0,
  }), true);

  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.deepEqual(requested, [{ start: 120, end: 180 }]);
  assert.equal(mustBeDefined(committed[0]).source, "backfill-completed");
  assert.equal(mustBeDefined<KlineBar>(lastPrice).time, 180);
  assert.equal(loading, false);
});

test("duplicate backfill completion releases active loading only once", async () => {
  let releaseFetch: (() => void) | undefined;
  let fetchCalls = 0;
  let loadingReleaseCalls = 0;
  const pendingFetch = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, _interval, start, end) => {
        fetchCalls += 1;
        await pendingFetch;
        return { data: rows([start, end]) };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });
  const message: BackfillCompletedMessage = {
    type: "backfill_completed",
    symbol: SERIES.symbol,
    interval: SERIES.interval,
    exchange: SERIES.exchange,
    market_type: SERIES.marketType,
    detail: {
      reason: "visible_range_gap",
      range_start_ms: 120_000,
      range_end_ms: 180_000,
    },
  };
  const options: BackfillCompletedOptions = {
    activeSeries: SERIES,
    loading: true,
    getCacheRows: () => rows([100, 200]),
    setLastPrice: () => {},
    setError: () => {},
    setConnectionStatus: () => {},
    setLoading: (next) => {
      if (next === false) loadingReleaseCalls += 1;
    },
    cooldownMs: 0,
  };

  assert.equal(feed.handleBackfillCompleted(message, options), true);
  assert.equal(feed.handleBackfillCompleted(message, options), true);
  mustBeDefined(releaseFetch)();

  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.equal(fetchCalls, 1);
  assert.equal(loadingReleaseCalls, 1);
});

test("patches active latest rows", async () => {
  const actions: string[] = [];
  const feed = new SeriesDataFeed({
    api: {
      fetchLatestKlines: async () => ({ data: rows([30]) }),
    },
    getActiveSeries: () => SERIES,
    mergeCacheData: () => actions.push("merge"),
    commitPatchedChartData: () => actions.push("patch"),
  });

  const result = await feed.getLatest(SERIES, { source: "polling-latest" });

  assert.equal(result.committed, true);
  assert.deepEqual(actions, ["patch"]);
});

test("subscribeBars syncs socket subscriptions and dispatches kline messages", () => {
  let socket = null;
  const ticks: Array<Pick<KlineStreamTickEvent, "interval" | "tick">> = [];
  const feed = new SeriesDataFeed({
    api: {
      getMultiStreamUrl: (symbol, marketType, exchange) => `ws://${exchange}/${marketType}/${symbol}`,
    },
  });

  const subscription = feed.subscribeBars(
    { exchange: "binance", marketType: "spot", symbol: "BTCUSDT" },
    {
      intervals: ["1h", "1m"],
      socketFactory: (url) => {
        socket = new FakeSocket(url);
        return socket;
      },
      onKline: ({ interval, tick }) => ticks.push({ interval, tick }),
    },
  );

  const activeSocket = mustBeDefined<FakeSocket>(socket);
  mustBeDefined(activeSocket.onopen)(partialMock<Event>({}));
  assert.equal(activeSocket.url, "ws://binance/spot/BTCUSDT");
  assert.deepEqual(JSON.parse(mustBeDefined(activeSocket.sent[0])), {
    action: "subscribe",
    intervals: ["1h", "1m"],
  });

  subscription.updateIntervals(["1m", "5m"]);
  assert.deepEqual(JSON.parse(mustBeDefined(activeSocket.sent[1])), {
    action: "subscribe",
    intervals: ["5m"],
  });
  assert.deepEqual(JSON.parse(mustBeDefined(activeSocket.sent[2])), {
    action: "unsubscribe",
    intervals: ["1h"],
  });

  const tick = {
    time: 10,
    open: 95,
    high: 105,
    low: 90,
    close: 100,
    volume: 12,
    is_closed: false,
  };
  activeSocket.emit({ type: "kline", interval: "1m", data: tick });
  assert.deepEqual(ticks, [{ interval: "1m", tick }]);
  subscription.close();
  assert.equal(activeSocket.closed, true);
});

test("subscribeBars diagnoses invalid WebSocket payloads without updating chart data", () => {
  let socket = null;
  const ticks: KlineStreamTickEvent[] = [];
  const diagnostics: unknown[] = [];
  const feed = new SeriesDataFeed({
    api: {
      getMultiStreamUrl: () => "ws://example.test/klines",
    },
  });

  feed.subscribeBars(
    { exchange: "binance", marketType: "spot", symbol: "BTCUSDT" },
    {
      socketFactory: (url) => {
        socket = new FakeSocket(url);
        return socket;
      },
      onKline: (event) => ticks.push(event),
      onParseError: (error) => diagnostics.push(error),
    },
  );

  const activeSocket = mustBeDefined<FakeSocket>(socket);
  activeSocket.emitRaw("{invalid");
  activeSocket.emit({ type: "mystery", data: {} });
  activeSocket.emit({ type: "kline", interval: "1m" });
  activeSocket.emit({
    type: "kline",
    interval: "1m",
    data: { time: 1_700_000_000_000, open: 1, high: 2, low: 0, close: 1, volume: 1 },
  });
  activeSocket.emit({ type: "unsubscribed", intervals: ["1m"] });
  activeSocket.emit({
    type: "kline",
    interval: "1m",
    data: { time: 10, open: 1, high: 2, low: 0, close: 1, volume: 1 },
  });

  assert.equal(diagnostics.length, 4);
  assert.equal(ticks.length, 1);
  assert.equal(mustBeDefined(ticks[0]).tick.time, 10);
});
