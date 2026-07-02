import assert from "node:assert/strict";
import test from "node:test";

import { SeriesDataFeed } from "../feed/seriesDataFeed.js";

const SERIES = {
  exchange: "binance",
  marketType: "spot",
  symbol: "BTCUSDT",
  interval: "1h",
};

function rows(times) {
  return times.map((time) => ({ time, close: time }));
}

class FakeSocket {
  static OPEN = 1;

  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.OPEN;
    this.OPEN = FakeSocket.OPEN;
    this.sent = [];
    this.closed = false;
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.closed = true;
  }

  emit(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

test("dedupes exact range requests", async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => {
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
  release();

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
  const actions = [];
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesBefore: async () => ({ data: rows([10]) }),
    },
    getActiveSeries: () => ({ ...SERIES, interval: "15m" }),
    mergeCacheData: () => actions.push("merge-cache"),
    commitMergedChartData: () => actions.push("commit-active"),
  });

  const result = await feed.requestBeforePage(SERIES, {
    before: 20,
    bars: 1,
    source: "history-before-page",
  });

  assert.equal(result.active, false);
  assert.equal(result.committed, false);
  assert.equal(result.stale, false);
  assert.deepEqual(actions, ["merge-cache"]);
});

test("commits active history rows through the active store path", async () => {
  const actions = [];
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
  let requestedOptions = null;
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
  assert.equal(requestedOptions.countBack, 24);
  assert.equal(result.plan.type, "history");
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
  assert.equal(result.plan.type, "before");
});

test("getRange follows backend truncation cursors until the requested range is covered", async () => {
  const requests = [];
  const committed = [];
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
    before: 200,
    bars: 500,
    pendingCooldownMs: 10_000,
  });
  const second = await feed.requestBeforePage(SERIES, {
    before: 200,
    bars: 500,
  });

  assert.equal(first.pending, true);
  assert.deepEqual(feed.getPendingBeforePage(SERIES), {
    before: 200,
    safetyAttempts: 0,
    completionAttempts: 0,
  });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "cooldown");
  assert.equal(calls, 1);
});

test("before-page safety and completion attempts are tracked in the feed", () => {
  const feed = new SeriesDataFeed();
  feed.setPendingBeforePage(SERIES, {
    before: 200,
    safetyAttempts: 0,
    completionAttempts: 0,
  });
  feed.setBeforePageCooldown(SERIES, 10_000);

  assert.equal(feed.markBeforePageSafetyRetry(SERIES, 200, 1), true);
  assert.equal(feed.isBeforePageCoolingDown(SERIES), false);
  assert.equal(feed.markBeforePageSafetyRetry(SERIES, 200, 1), false);

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
  const requested = [];
  const committed = [];
  let lastPrice = null;
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
  assert.equal(committed[0].source, "backfill-completed");
  assert.equal(lastPrice.time, 180);
  assert.equal(loading, false);
});

test("patches active latest rows", async () => {
  const actions = [];
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
  const ticks = [];
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

  socket.onopen();
  assert.equal(socket.url, "ws://binance/spot/BTCUSDT");
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    action: "subscribe",
    intervals: ["1h", "1m"],
  });

  subscription.updateIntervals(["1m", "5m"]);
  assert.deepEqual(JSON.parse(socket.sent[1]), {
    action: "subscribe",
    intervals: ["5m"],
  });
  assert.deepEqual(JSON.parse(socket.sent[2]), {
    action: "unsubscribe",
    intervals: ["1h"],
  });

  socket.emit({ type: "kline", interval: "1m", data: { time: 10, close: 100 } });
  assert.deepEqual(ticks, [{ interval: "1m", tick: { time: 10, close: 100 } }]);
  subscription.close();
  assert.equal(socket.closed, true);
});
