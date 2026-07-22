import assert from "node:assert/strict";
import test from "node:test";

import {
  capContinuationRanges,
  countIntervalBarsInRange,
  projectContinuousRangeToInterval,
  SeriesDataFeed as ProductionSeriesDataFeed,
} from "../feed/seriesDataFeed.js";
import type {
  BackfillCompletedMessage,
  BackfillCompletedOptions,
  FeedResult,
  FeedCommitMeta,
  KlineApi,
  KlineBeforeRequestOptions,
  KlineFetchResult,
  KlineHistoryRequestOptions,
  KlineRequestOptions,
  KlineStreamTickEvent,
  KlineStreamSocket,
  SeriesDataFeedConfig,
} from "../klineContracts.js";
import type { KlineBar } from "../marketDataTypes.js";
import type { EpochSeconds } from "../marketDataTypes.js";
import { toEpochMilliseconds } from "../marketDataTypes.js";
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

test("monthly feed helpers use absolute month anchors and calendar successors", () => {
  const oct2023Ms = Date.UTC(2023, 9, 1);
  const mar2024Ms = Date.UTC(2024, 2, 1);
  assert.deepEqual(projectContinuousRangeToInterval({
    start: Date.UTC(2024, 0, 15) as never,
    end: Date.UTC(2024, 5, 15) as never,
  }, "5M"), {
    start: oct2023Ms,
    end: mar2024Ms,
  });

  const jan2023 = epochSeconds(Date.UTC(2023, 0, 1) / 1_000);
  const feb2023 = epochSeconds(Date.UTC(2023, 1, 1) / 1_000);
  const mar2023 = epochSeconds(Date.UTC(2023, 2, 1) / 1_000);
  assert.equal(countIntervalBarsInRange({ start: jan2023, end: mar2023 }, "1M"), 3);
  assert.deepEqual(capContinuationRanges(
    { start: jan2023, end: mar2023 },
    {
      missing_ranges: [{
        start_ms: feb2023 * 1_000,
        end_ms: mar2023 * 1_000,
      }],
    } as KlineFetchResult,
    jan2023,
    "1M",
  ), [{ start: jan2023, end: mar2023 }]);
});

function rows(times: number[]): KlineBar[] {
  return times.map((time) => ({ time: epochSeconds(time), close: time }));
}

test("data-plane predicate blocks every HTTP and WebSocket transport boundary", async () => {
  let calls = 0;
  const feed = new SeriesDataFeed({
    canRequestSeries: () => false,
    api: {
      fetchKlinesHistory: async () => { calls += 1; return { data: rows([10]) }; },
      fetchKlinesBefore: async () => { calls += 1; return { data: rows([10]) }; },
      fetchKlinesRange: async () => { calls += 1; return { data: rows([10]) }; },
      fetchLatestKlines: async () => { calls += 1; return { data: rows([10]) }; },
      getMultiStreamUrl: () => { calls += 1; return "ws://disabled"; },
    },
  });

  const history = await feed.getHistory(SERIES);
  const before = await feed.getBefore(SERIES, { before: epochSeconds(20) });
  const range = await feed.getRange(SERIES, { start: epochSeconds(1), end: epochSeconds(20) });
  const latest = await feed.getLatest(SERIES);
  const stream = feed.subscribeBars({
    exchange: SERIES.exchange,
    marketType: SERIES.marketType,
    symbol: SERIES.symbol,
  });

  assert.equal(calls, 0);
  for (const result of [history, before, range, latest]) {
    assert.equal(result.reason, "data-plane-disabled");
    assert.equal(result.stale, true);
  }
  assert.equal(stream.isOpen(), false);
  assert.equal(stream.sendPing(), false);
});

test("same-epoch history keeps concurrent realtime rows while repairing untouched timestamps", async () => {
  let resolveFetch!: (result: KlineFetchResult) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const visible = new Map<number, KlineBar>([
    [1_000, { time: epochSeconds(1_000), close: 10, is_closed: true }],
    [1_060, { time: epochSeconds(1_060), close: 20, is_closed: false }],
  ]);
  const commitRows = (_symbol: string, _interval: string, incoming: KlineBar[]) => {
    for (const row of incoming) visible.set(row.time, row);
  };
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesHistory: async () => {
        markStarted();
        return new Promise<KlineFetchResult>((resolve) => { resolveFetch = resolve; });
      },
    },
    commitMergedChartData: commitRows,
  });

  const request = feed.getHistory(SERIES, { commit: "always" });
  await started;
  const realtimeTail = {
    time: epochSeconds(1_060),
    close: 23,
    is_closed: false,
  };
  feed.recordRealtimeRows(SERIES, [realtimeTail]);
  visible.set(realtimeTail.time, realtimeTail);
  resolveFetch({
    all_rows_final: false,
    data: [
      { time: epochSeconds(1_000), close: 11, is_closed: true },
      { time: epochSeconds(1_060), close: 21, is_closed: false },
    ],
  });

  const result = await request;
  assert.equal(visible.get(1_000)?.close, 11);
  assert.equal(visible.get(1_060)?.close, 23);
  assert.equal(result.data.at(-1)?.close, 23);
});

test("background tracked interval cache uses the same realtime row fence", async () => {
  const backgroundSeries = { ...SERIES, interval: "1m" };
  let resolveFetch!: (result: KlineFetchResult) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let cached: KlineBar = { time: epochSeconds(1_000), close: 10, is_closed: false };
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesHistory: async () => {
        markStarted();
        return new Promise<KlineFetchResult>((resolve) => { resolveFetch = resolve; });
      },
    },
    mergeCacheData: (_symbol, _interval, incoming) => {
      cached = mustBeDefined(incoming.at(-1));
    },
  });

  const request = feed.getHistory(backgroundSeries, { commit: "cache" });
  await started;
  const realtime = { time: epochSeconds(1_000), close: 15, is_closed: false };
  feed.recordRealtimeRows(backgroundSeries, [realtime]);
  cached = realtime;
  resolveFetch({
    all_rows_final: false,
    data: [{ time: epochSeconds(1_000), close: 12, is_closed: false }],
  });

  const result = await request;
  assert.equal(cached.close, 15);
  assert.equal(result.data[0]?.close, 15);
});

test("snapshot commit mode reconciles rows without mutating active or cache windows", async () => {
  const writes: string[] = [];
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesHistory: async () => ({ data: rows([10, 20]) }),
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => { writes.push("active"); },
    mergeCacheData: () => { writes.push("cache"); },
  });

  const result = await feed.getHistory(SERIES, { commit: "none" });

  assert.deepEqual(result.data.map((row) => row.time), [10, 20]);
  assert.equal(result.committed, false);
  assert.deepEqual(writes, []);
});

test("pending active commits defer indicator windows until the same range settles", async () => {
  const commits: FeedCommitMeta[] = [];
  let call = 0;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesHistory: async () => {
        call += 1;
        return call === 1
          ? {
              data: rows([100]),
              history_state: "pending",
              complete: false,
              retryable: true,
              verified_contiguous: false,
              missing_ranges: [{ start_ms: 100_000, end_ms: 200_000 }],
            }
          : {
              data: rows([100, 200]),
              history_state: "ready",
              complete: true,
              retryable: false,
              verified_contiguous: true,
              missing_ranges: [],
            };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: (_symbol, _interval, _rows, meta) => commits.push(meta),
  });

  await feed.getHistory(SERIES, { source: "partial-history" });
  await feed.getHistory(SERIES, { source: "settled-history" });

  assert.deepEqual(commits.map((meta) => ({
    source: meta.source,
    deferred: meta.deferIndicatorWindow,
  })), [
    { source: "partial-history", deferred: true },
    { source: "settled-history", deferred: false },
  ]);
  assert.ok(commits[0]?.indicatorWindowOwner);
  assert.equal(commits[0]?.indicatorWindowOwner, commits[1]?.indicatorWindowOwner);
});

test("parent before-page and child range repair retain distinct stable indicator owners", async () => {
  const commits: FeedCommitMeta[] = [];
  let beforeCall = 0;
  let rangeCall = 0;
  const pending = {
    history_state: "pending" as const,
    complete: false,
    retryable: true,
    verified_contiguous: false,
    missing_ranges: [{ start_ms: 100_000, end_ms: 200_000 }],
  };
  const ready = {
    history_state: "ready" as const,
    complete: true,
    retryable: false,
    verified_contiguous: true,
    missing_ranges: [],
  };
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesBefore: async () => (++beforeCall === 1
        ? { ...pending, data: rows([100]) }
        : { ...ready, data: rows([100, 200]) }),
      fetchKlinesRange: async () => (++rangeCall === 1
        ? { ...pending, data: rows([150]) }
        : { ...ready, data: rows([150, 200]) }),
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: (_symbol, _interval, _rows, meta) => commits.push(meta),
  });

  await feed.getBefore(SERIES, { before: epochSeconds(300), bars: 100, source: "parent-partial" });
  await feed.getRange(SERIES, { start: epochSeconds(100), end: epochSeconds(200), source: "child-partial" });
  await feed.getBefore(SERIES, { before: epochSeconds(300), bars: 100, source: "parent-ready" });
  await feed.getRange(SERIES, { start: epochSeconds(100), end: epochSeconds(200), source: "child-ready" });

  const owners = commits.map((meta) => meta.indicatorWindowOwner);
  assert.ok(owners[0]);
  assert.ok(owners[1]);
  assert.notEqual(owners[0], owners[1]);
  assert.equal(owners[0], owners[2]);
  assert.equal(owners[1], owners[3]);
  assert.deepEqual(commits.map((meta) => meta.deferIndicatorWindow), [true, true, false, false]);
});

test("an empty terminal probe releases the indicator window owned by a partial page", async () => {
  const commits: Array<{ rows: number; meta: FeedCommitMeta }> = [];
  let call = 0;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesHistory: async () => {
        call += 1;
        return call === 1
          ? {
              data: rows([100]),
              history_state: "pending",
              complete: false,
              retryable: true,
              verified_contiguous: false,
              missing_ranges: [{ start_ms: 100_000, end_ms: 200_000 }],
            }
          : {
              data: [],
              history_state: "exhausted",
              complete: true,
              retryable: false,
              verified_contiguous: true,
              missing_ranges: [],
            };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: (_symbol, _interval, incoming, meta) => {
      commits.push({ rows: incoming.length, meta });
    },
  });

  await feed.getHistory(SERIES, { source: "partial-history" });
  await feed.getHistory(SERIES, { source: "terminal-history" });

  assert.deepEqual(commits.map(({ rows: count, meta }) => ({
    rows: count,
    source: meta.source,
    deferred: meta.deferIndicatorWindow,
  })), [
    { rows: 1, source: "partial-history", deferred: true },
    { rows: 0, source: "terminal-history", deferred: false },
  ]);
});

test("trusted final latest may close a concurrent forming realtime row", async () => {
  let resolveFetch!: (result: KlineFetchResult) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let visible: KlineBar = { time: epochSeconds(1_000), close: 10, is_closed: false };
  const feed = new SeriesDataFeed({
    api: {
      fetchLatestKlines: async () => {
        markStarted();
        return new Promise<KlineFetchResult>((resolve) => { resolveFetch = resolve; });
      },
    },
    getActiveSeries: () => SERIES,
    commitPatchedChartData: (_symbol, _interval, incoming) => {
      visible = mustBeDefined(incoming.at(-1));
    },
  });

  const request = feed.getLatest(SERIES);
  await started;
  const realtimeForming = { time: epochSeconds(1_000), close: 11, is_closed: false };
  feed.recordRealtimeRows(SERIES, [realtimeForming]);
  visible = realtimeForming;
  resolveFetch({
    all_rows_final: true,
    data: [{ time: epochSeconds(1_000), close: 12, is_closed: true }],
  });

  const result = await request;
  assert.equal(visible.close, 12);
  assert.equal(visible.is_closed, true);
  assert.equal(result.data[0]?.close, 12);
});

test("trusted final promotion fences a second older same-epoch history response", async () => {
  let resolveLatest!: (result: KlineFetchResult) => void;
  let resolveHistory!: (result: KlineFetchResult) => void;
  let markLatestStarted!: () => void;
  let markHistoryStarted!: () => void;
  const latestStarted = new Promise<void>((resolve) => { markLatestStarted = resolve; });
  const historyStarted = new Promise<void>((resolve) => { markHistoryStarted = resolve; });
  let visible: KlineBar = { time: epochSeconds(1_000), close: 10, is_closed: false };
  const commitRows = (_symbol: string, _interval: string, incoming: KlineBar[]) => {
    visible = mustBeDefined(incoming.at(-1));
  };
  const feed = new SeriesDataFeed({
    api: {
      fetchLatestKlines: async () => {
        markLatestStarted();
        return new Promise<KlineFetchResult>((resolve) => { resolveLatest = resolve; });
      },
      fetchKlinesHistory: async () => {
        markHistoryStarted();
        return new Promise<KlineFetchResult>((resolve) => { resolveHistory = resolve; });
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: commitRows,
    commitPatchedChartData: commitRows,
  });

  const historyRequest = feed.getHistory(SERIES);
  await historyStarted;
  const realtimeForming = { time: epochSeconds(1_000), close: 11, is_closed: false };
  feed.recordRealtimeRows(SERIES, [realtimeForming]);
  visible = realtimeForming;
  const latestRequest = feed.getLatest(SERIES);
  await latestStarted;

  resolveLatest({
    all_rows_final: true,
    data: [{ time: epochSeconds(1_000), close: 12, is_closed: true }],
  });
  await latestRequest;
  assert.equal(visible.close, 12);
  assert.equal(visible.is_closed, true);

  resolveHistory({
    all_rows_final: false,
    data: [{ time: epochSeconds(1_000), close: 10, is_closed: false }],
  });
  const historyResult = await historyRequest;
  assert.equal(visible.close, 12);
  assert.equal(visible.is_closed, true);
  assert.equal(historyResult.data[0]?.close, 12);
});

test("an old epoch response cannot promote a row into the new epoch realtime fence", async () => {
  const resolvers: Array<(result: KlineFetchResult) => void> = [];
  const started: Array<() => void> = [];
  let visible: KlineBar = { time: epochSeconds(1_000), close: 10, is_closed: false };
  const feed = new SeriesDataFeed({
    api: {
      fetchLatestKlines: async () => {
        started.shift()?.();
        return new Promise<KlineFetchResult>((resolve) => { resolvers.push(resolve); });
      },
    },
    getActiveSeries: () => SERIES,
    commitPatchedChartData: (_symbol, _interval, incoming) => {
      visible = mustBeDefined(incoming.at(-1));
    },
  });
  const oldStarted = new Promise<void>((resolve) => { started.push(resolve); });
  const oldRequest = feed.getLatest(SERIES);
  await oldStarted;

  feed.beginEpoch(SERIES);
  const newStarted = new Promise<void>((resolve) => { started.push(resolve); });
  const newRequest = feed.getLatest(SERIES);
  await newStarted;
  const realtime = { time: epochSeconds(1_000), close: 11, is_closed: false };
  feed.recordRealtimeRows(SERIES, [realtime]);
  visible = realtime;

  mustBeDefined(resolvers.shift())({
    all_rows_final: true,
    data: [{ time: epochSeconds(1_000), close: 99, is_closed: true }],
  });
  const oldResult = await oldRequest;
  assert.equal(oldResult.stale, true);
  assert.equal(visible.close, 11);

  mustBeDefined(resolvers.shift())({
    all_rows_final: false,
    data: [{ time: epochSeconds(1_000), close: 10, is_closed: false }],
  });
  const newResult = await newRequest;
  assert.equal(newResult.stale, false);
  assert.equal(newResult.data[0]?.close, 11);
  assert.equal(visible.close, 11);
});

test("concurrent realtime close or amendment dominates an older trusted HTTP row", async () => {
  let resolveFetch!: (result: KlineFetchResult) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let visible: KlineBar = { time: epochSeconds(1_000), close: 10, is_closed: true };
  const feed = new SeriesDataFeed({
    api: {
      fetchLatestKlines: async () => {
        markStarted();
        return new Promise<KlineFetchResult>((resolve) => { resolveFetch = resolve; });
      },
    },
    getActiveSeries: () => SERIES,
    commitPatchedChartData: (_symbol, _interval, incoming) => {
      visible = mustBeDefined(incoming.at(-1));
    },
  });

  const request = feed.getLatest(SERIES);
  await started;
  const amended = { time: epochSeconds(1_000), close: 30, is_closed: true };
  feed.recordRealtimeRows(SERIES, [amended]);
  visible = amended;
  resolveFetch({
    all_rows_final: true,
    data: [{ time: epochSeconds(1_000), close: 20, is_closed: true }],
  });

  const result = await request;
  assert.equal(visible.close, 30);
  assert.equal(result.data[0]?.close, 30);
});

test("retained realtime amendment also fences HTTP begun after the amendment", async () => {
  const resolvers: Array<(result: KlineFetchResult) => void> = [];
  const starters: Array<() => void> = [];
  let visible: KlineBar = { time: epochSeconds(1_000), close: 10, is_closed: true };
  const feed = new SeriesDataFeed({
    api: {
      fetchLatestKlines: async () => {
        starters.shift()?.();
        return new Promise<KlineFetchResult>((resolve) => { resolvers.push(resolve); });
      },
    },
    getActiveSeries: () => SERIES,
    commitPatchedChartData: (_symbol, _interval, incoming) => {
      visible = mustBeDefined(incoming.at(-1));
    },
  });

  const oldStarted = new Promise<void>((resolve) => { starters.push(resolve); });
  const oldRequest = feed.getLatest(SERIES, { source: "old-latest" });
  await oldStarted;
  const amended = { time: epochSeconds(1_000), close: 30, is_closed: true };
  feed.recordRealtimeRows(SERIES, [amended]);
  visible = amended;

  const newerStarted = new Promise<void>((resolve) => { starters.push(resolve); });
  const newerRequest = feed.getLatest(SERIES, { source: "newer-latest" });
  await newerStarted;
  mustBeDefined(resolvers[1])({
    all_rows_final: true,
    data: [{ time: epochSeconds(1_000), close: 20, is_closed: true }],
  });
  const newerResult = await newerRequest;
  assert.equal(newerResult.data[0]?.close, 30);
  assert.equal(visible.close, 30);

  mustBeDefined(resolvers[0])({
    all_rows_final: true,
    data: [{ time: epochSeconds(1_000), close: 10, is_closed: true }],
  });
  const oldResult = await oldRequest;
  assert.equal(oldResult.data[0]?.close, 30);
  assert.equal(visible.close, 30);
});

test("range pagination re-checks the data-plane predicate before every page", async () => {
  let allowed = true;
  let calls = 0;
  const feed = new SeriesDataFeed({
    canRequestSeries: () => allowed,
    api: {
      fetchKlinesRange: async (_symbol, _interval, _start, end) => {
        calls += 1;
        allowed = false;
        return {
          data: rows([Number(end)]),
          truncated: true,
          next_end_ms: (Number(end) - 1) * 1_000,
        };
      },
    },
  });

  const result = await feed.getRange(SERIES, {
    start: epochSeconds(1),
    end: epochSeconds(20),
    maxPages: 3,
  });

  assert.equal(calls, 1);
  assert.equal(result.reason, "data-plane-disabled");
  assert.equal(result.stale, true);
});

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

interface SentSubscriptionRequest {
  action: string;
  request_id: string;
  intervals: string[];
}

function parseSentSubscriptionRequest(payload: string): SentSubscriptionRequest {
  const value: unknown = JSON.parse(payload);
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const record = value as Record<string, unknown>;
  assert.equal(typeof record.action, "string");
  assert.equal(typeof record.request_id, "string");
  assert.ok(Array.isArray(record.intervals));
  assert.ok(record.intervals.every((interval) => typeof interval === "string"));
  return {
    action: record.action,
    request_id: record.request_id,
    intervals: record.intervals,
  } as SentSubscriptionRequest;
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

test("same-series epoch starts a fresh history request instead of joining the old promise", async () => {
  let calls = 0;
  let releaseFirst: (() => void) | undefined;
  let releaseSecond: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesHistory: async () => {
        calls += 1;
        await (calls === 1 ? firstGate : secondGate);
        return { data: rows([calls * 10]) };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  const first = feed.getHistory(SERIES, { days: 1, source: "same-source" });
  while (calls < 1) await new Promise((resolve) => setImmediate(resolve));
  feed.beginEpoch(SERIES);
  const second = feed.getHistory(SERIES, { days: 1, source: "same-source" });
  while (calls < 2) await new Promise((resolve) => setImmediate(resolve));

  mustBeDefined(releaseSecond)();
  assert.equal((await second).stale, false);
  mustBeDefined(releaseFirst)();
  assert.equal((await first).stale, true);
  assert.equal(calls, 2);
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
  const pendingPage = mustBeDefined(feed.getPendingBeforePage(SERIES));
  assert.equal(pendingPage.before, 200);
  assert.equal(pendingPage.bars, 500);
  assert.equal(pendingPage.safetyAttempts, 0);
  assert.equal(pendingPage.completionAttempts, 0);
  assert.equal(pendingPage.pollAttempts, 0);
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

test("an earlier backfill completion invalidates cached left-edge exhaustion", async () => {
  let beforeCalls = 0;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesBefore: async () => {
        beforeCalls += 1;
        if (beforeCalls === 1) {
          return {
            data: [],
            history_state: "exhausted",
            complete: true,
            retryable: false,
            terminal_reason: "provider_exhausted",
            earliest_available_ms: 100_000,
            availability_revision: "history-v1",
          };
        }
        return { data: rows([50]), complete: true, retryable: false, has_more: true };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  await feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    bars: 500,
    cooldownMs: 30_000,
  });
  assert.ok(feed.getBeforePageAvailability(SERIES));

  assert.equal(feed.handleBackfillCompleted({
    type: "backfill_completed",
    exchange: SERIES.exchange,
    market_type: SERIES.marketType,
    symbol: SERIES.symbol,
    interval: SERIES.interval,
    detail: {
      reason: "background_gap_audit",
      range_start_ms: 50_000,
      range_end_ms: 50_000,
    },
  }, {
    activeSeries: SERIES,
    getCacheRows: () => rows([100, 200]),
  }), true);
  assert.equal(feed.getBeforePageAvailability(SERIES), null);

  const refreshed = await feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    bars: 500,
  });
  assert.equal(refreshed.skipped, undefined);
  assert.equal(beforeCalls, 2);
});

test("an observed revision or earlier row invalidates cached left-edge exhaustion", async () => {
  let beforeCalls = 0;
  let historyResult = {
    data: rows([250]),
    availability_revision: "history-v2",
  };
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesBefore: async () => {
        beforeCalls += 1;
        return {
          data: [],
          history_state: "exhausted",
          complete: true,
          retryable: false,
          terminal_reason: "provider_exhausted",
          availability_revision: "history-v1",
        };
      },
      fetchKlinesHistory: async () => historyResult,
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  await feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    bars: 500,
    cooldownMs: 0,
  });
  assert.ok(feed.getBeforePageAvailability(SERIES));
  await feed.getHistory(SERIES, { source: "availability-revision-refresh" });
  assert.equal(feed.getBeforePageAvailability(SERIES), null);

  await feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    bars: 500,
    cooldownMs: 0,
  });
  assert.ok(feed.getBeforePageAvailability(SERIES));
  historyResult = { data: rows([50]), availability_revision: "history-v1" };
  await feed.getHistory(SERIES, { source: "earlier-row-refresh" });
  assert.equal(feed.getBeforePageAvailability(SERIES), null);
  assert.equal(beforeCalls, 2);
});

test("source-empty suppression expires both the before boundary and held-window exclusion", async () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  const retryAtMs = 1_010_000;
  let beforeCalls = 0;
  let rangeCalls = 0;
  Date.now = () => now;
  try {
    const feed = new SeriesDataFeed({
      api: {
        fetchKlinesBefore: async () => {
          beforeCalls += 1;
          if (beforeCalls === 1) {
            return {
              data: [],
              has_more: false,
              history_state: "exhausted",
              complete: true,
              retryable: false,
              terminal_reason: "source_empty",
              retry_at_ms: retryAtMs,
              verified_contiguous: true,
              missing_ranges: [],
              excluded_ranges: [{
                start_ms: 7_200_000,
                end_ms: 7_200_000,
                reason: "source_empty",
                retry_at_ms: retryAtMs,
              }],
            };
          }
          return {
            data: rows([100]),
            has_more: true,
            history_state: "ready",
            complete: true,
            retryable: false,
          };
        },
        fetchKlinesRange: async () => {
          rangeCalls += 1;
          return {
            data: rows([7_200]),
            history_state: "ready",
            complete: true,
            retryable: false,
            verified_contiguous: true,
            missing_ranges: [],
          };
        },
      },
      getActiveSeries: () => SERIES,
      commitMergedChartData: () => {},
    });

    const suppressed = await feed.requestBeforePage(SERIES, {
      before: epochSeconds(200),
      cooldownMs: 60_000,
    });
    assert.equal(suppressed.pending, false);
    assert.equal(feed.getBeforePageAvailability(SERIES)?.retryAtMs, retryAtMs);
    assert.equal((await feed.requestBeforePage(SERIES, {
      before: epochSeconds(200),
    })).reason, "history-exhausted");
    assert.equal(await feed.pollPendingRepairs(SERIES, { force: true }), 0);
    assert.equal((await feed.repairVisibleGaps(
      SERIES,
      rows([0, 3_600, 10_800]),
      null,
      { throttleMs: 0 },
    )).planned, 0);
    assert.equal(beforeCalls, 1);
    assert.equal(rangeCalls, 0);

    now = retryAtMs;
    assert.equal(feed.getBeforePageAvailability(SERIES), null);
    const refreshed = await feed.requestBeforePage(SERIES, {
      before: epochSeconds(200),
    });
    assert.equal(refreshed.skipped, undefined);
    assert.equal(beforeCalls, 2, "expiry must also clear the longer before-page cooldown");
    assert.equal((await feed.repairVisibleGaps(
      SERIES,
      rows([0, 3_600, 10_800]),
      null,
      { throttleMs: 0 },
    )).requested, 1);
    assert.equal(rangeCalls, 1);
  } finally {
    Date.now = originalNow;
  }
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
  assert.equal(feed.getPendingBeforePage(SERIES)?.completionAttempts, 2);
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

test("base repair completion immediately wakes a dormant derived-interval gap", async () => {
  const customSeries = { ...SERIES, interval: "45m" };
  const requested: Array<{ interval: string; start: EpochSeconds; end: EpochSeconds }> = [];
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, interval, start, end) => {
        requested.push({ interval, start, end });
        return {
          data: rows([start, end]),
          verified_contiguous: true,
          history_state: "ready",
          complete: true,
          retryable: false,
          missing_ranges: [],
        };
      },
    },
    getActiveSeries: () => customSeries,
    commitMergedChartData: () => {},
  });
  feed.pendingGapRepairs.set("binance:spot:BTCUSDT:45m|0|0", {
    series: customSeries,
    range: { start: epochSeconds(0), end: epochSeconds(0) },
    attempts: 5,
    nextPollAt: Date.now() + 10 * 60_000,
    dormant: true,
  });

  assert.equal(feed.handleBackfillCompleted({
    type: "backfill_completed",
    exchange: customSeries.exchange,
    market_type: customSeries.marketType,
    symbol: customSeries.symbol,
    interval: "15m",
    detail: {
      request_id: "base-component-repair",
      reason: "visible_range_gap",
      range_start_ms: 900_000,
      range_end_ms: 900_000,
      derived_for_intervals: ["45m"],
      derived_repair_targets: [{
        interval: "45m",
        start_ms: 0,
        end_ms: 0,
      }],
    },
  }, {
    activeSeries: customSeries,
    getCacheRows: () => rows([0, 2_700]),
    cooldownMs: 0,
  }), true);

  while (feed.backfillReloadInFlight.size > 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(requested, [{
    interval: "45m",
    start: epochSeconds(0),
    end: epochSeconds(0),
  }]);
  assert.equal(feed.pendingGapRepairs.size, 0);
});

test("one base completion verifies every same-interval derived target without clearing outside children", async () => {
  const customSeries = { ...SERIES, interval: "45m" };
  const requested: Array<{ interval: string; start: EpochSeconds; end: EpochSeconds }> = [];
  const resolved: number[] = [];
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, interval, start, end) => {
        requested.push({ interval, start, end });
        return {
          data: rows([start, end]),
          verified_contiguous: true,
          history_state: "ready",
          complete: true,
          retryable: false,
          missing_ranges: [],
        };
      },
    },
    getActiveSeries: () => customSeries,
    commitMergedChartData: () => {},
  });
  for (const start of [0, 5_400, 10_800]) {
    feed.pendingGapRepairs.set(`binance:spot:BTCUSDT:45m|${start}|${start}`, {
      series: customSeries,
      range: { start: epochSeconds(start), end: epochSeconds(start) },
      attempts: 5,
      nextPollAt: Date.now() + 10 * 60_000,
      dormant: true,
      onResolved: () => resolved.push(start),
    });
  }

  assert.equal(feed.handleBackfillCompleted({
    type: "backfill_completed",
    exchange: customSeries.exchange,
    market_type: customSeries.marketType,
    symbol: customSeries.symbol,
    interval: "15m",
    detail: {
      request_id: "merged-base-component-repair",
      reason: "visible_range_gap",
      range_start_ms: 900_000,
      range_end_ms: 5_400_000,
      derived_repair_targets: [
        { interval: "45m", start_ms: 0, end_ms: 0 },
        { interval: "45m", start_ms: 5_400_000, end_ms: 5_400_000 },
      ],
    },
  }, {
    activeSeries: customSeries,
    getCacheRows: () => rows([0, 10_800]),
    cooldownMs: 0,
  }), true);

  while (feed.backfillReloadInFlight.size > 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(requested, [{
    interval: "45m",
    start: epochSeconds(0),
    end: epochSeconds(5_400),
  }]);
  assert.deepEqual(resolved, [0, 5_400]);
  assert.deepEqual([...feed.pendingGapRepairs.values()].map((pending) => pending.range), [{
    start: epochSeconds(10_800),
    end: epochSeconds(10_800),
  }]);
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

test("distinct backfill completion ranges drain after the current series fetch", async () => {
  let releaseFirst: (() => void) | undefined;
  const firstPending = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const requests: Array<{ start: EpochSeconds; end: EpochSeconds }> = [];
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, _interval, start, end) => {
        requests.push({ start, end });
        if (requests.length === 1) await firstPending;
        return { data: rows([start, end]), verified_contiguous: true };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });
  const options: BackfillCompletedOptions = {
    activeSeries: SERIES,
    getCacheRows: () => rows([100, 300]),
    cooldownMs: 0,
  };

  feed.handleBackfillCompleted({
    type: "backfill_completed",
    ...SERIES,
    market_type: SERIES.marketType,
    detail: {
      request_id: "repair-a",
      reason: "visible_range_gap",
      range_start_ms: 120_000,
      range_end_ms: 180_000,
    },
  }, options);
  feed.handleBackfillCompleted({
    type: "backfill_completed",
    ...SERIES,
    market_type: SERIES.marketType,
    detail: {
      request_id: "repair-b",
      reason: "visible_range_gap",
      range_start_ms: 220_000,
      range_end_ms: 280_000,
    },
  }, options);
  while (requests.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(requests, [{ start: 120, end: 180 }]);

  mustBeDefined(releaseFirst)();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(requests, [
    { start: 120, end: 180 },
    { start: 220, end: 280 },
  ]);
});

test("non-empty partial before pages remain pending", async () => {
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesBefore: async () => ({
        data: rows([100]),
        history_state: "pending",
        complete: false,
        retryable: true,
        verified_contiguous: false,
        missing_ranges: [{ start_ms: 120_000, end_ms: 180_000 }],
      }),
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  const result = await feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    bars: 500,
    pendingCooldownMs: 0,
  });

  assert.equal(result.data.length, 1);
  assert.equal(result.pending, true);
  assert.deepEqual(feed.getPendingBeforePage(SERIES)?.range, {
    start: 120_000,
    end: 180_000,
  });
});

test("pending load-more completion chunks only wake one non-blocking page poll", async () => {
  let beforeCalls = 0;
  let rangeCalls = 0;
  const beforeOptions: KlineBeforeRequestOptions[] = [];
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesBefore: async (
        _symbol,
        _interval,
        _before,
        _bars,
        _marketType,
        _exchange,
        options,
      ) => {
        beforeCalls += 1;
        beforeOptions.push(options);
        if (beforeCalls === 1) {
          return {
            data: rows([100]),
            history_state: "pending",
            complete: false,
            retryable: true,
            verified_contiguous: false,
            missing_ranges: [{ start_ms: 120_000, end_ms: 180_000 }],
          };
        }
        return {
          data: rows([50, 100]),
          has_more: true,
          history_state: "ready",
          complete: true,
          retryable: false,
          verified_contiguous: true,
          missing_ranges: [],
        };
      },
      fetchKlinesRange: async () => {
        rangeCalls += 1;
        return { data: rows([120, 180]), verified_contiguous: true };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  await feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    bars: 500,
    pendingCooldownMs: 0,
  });
  const pending = mustBeDefined(feed.getPendingBeforePage(SERIES));
  pending.nextPollAt = Date.now() + 60_000;

  for (const [requestId, start] of [["chunk-a", 120], ["chunk-b", 150]] as const) {
    assert.equal(feed.handleBackfillCompleted({
      type: "backfill_completed",
      ...SERIES,
      market_type: SERIES.marketType,
      detail: {
        request_id: requestId,
        reason: "visible_load_more",
        range_start_ms: start * 1_000,
        range_end_ms: 180_000,
      },
    }, {
      activeSeries: SERIES,
      getCacheRows: () => rows([100, 200]),
      cooldownMs: 0,
    }), true);
  }

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rangeCalls, 0, "completion chunks must not fan out into exact range reloads");
  assert.equal(beforeCalls, 1, "completion chunks must not directly retry the full page");
  assert.ok((pending.nextPollAt ?? Infinity) <= Date.now(), "completion must wake the central poll");

  assert.equal(await feed.pollPendingRepairs(SERIES, { maxRequests: 1 }), 1);
  assert.equal(beforeCalls, 2);
  assert.equal(beforeOptions[1]?.maxWaitMs, 0, "validation must not spend another long-poll budget");
  assert.equal(feed.getPendingBeforePage(SERIES), null);
});

test("pending initial completion chunks only wake the owned exact-range poll", async () => {
  let rangeCalls = 0;
  let resolved = 0;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, _interval, start, end) => {
        rangeCalls += 1;
        assert.deepEqual({ start, end }, { start: 100, end: 300 });
        return {
          data: rows([100, 200, 300]),
          verified_contiguous: true,
          history_state: "ready",
          complete: true,
          retryable: false,
          missing_ranges: [],
        };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });
  const pendingInitial = {
    ...SERIES,
    range: {
      start: mustBeDefined(toEpochMilliseconds(100_000)),
      end: mustBeDefined(toEpochMilliseconds(300_000)),
    },
  };
  const tracked = feed.trackPendingResultRepair(SERIES, {
    data: rows([300]),
    start_ms: 100_000,
    end_ms: 300_000,
    history_state: "pending",
    complete: false,
    retryable: true,
    verified_contiguous: false,
    missing_ranges: [{ start_ms: 100_000, end_ms: 300_000 }],
  }, () => { resolved += 1; });
  assert.deepEqual(tracked, { start: 100, end: 300 });

  for (const [requestId, start, end] of [
    ["chunk-a", 120, 180],
    ["chunk-b", 220, 280],
  ] as const) {
    assert.equal(feed.handleBackfillCompleted({
      type: "backfill_completed",
      ...SERIES,
      market_type: SERIES.marketType,
      detail: {
        request_id: requestId,
        reason: "initial_history",
        range_start_ms: start * 1_000,
        range_end_ms: end * 1_000,
      },
    }, {
      activeSeries: SERIES,
      pendingInitial,
      getPendingInitial: () => pendingInitial,
      getCacheRows: () => rows([300]),
      cooldownMs: 0,
    }), true);
  }

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rangeCalls, 0, "physical completion chunks must not launch their own range reads");
  assert.equal(await feed.pollPendingRepairs(SERIES, { maxRequests: 1 }), 1);
  assert.equal(rangeCalls, 1, "the central poll validates the complete initial range once");
  assert.equal(resolved, 1);
  assert.equal(feed.pendingRepairCount(SERIES), 0);
});

test("pending exact gap repairs are re-read without a websocket completion", async () => {
  let calls = 0;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            data: [],
            history_state: "pending",
            complete: false,
            retryable: true,
            verified_contiguous: false,
            missing_ranges: [{ start_ms: 7_200_000, end_ms: 7_200_000 }],
          };
        }
        return {
          data: rows([7_200]),
          history_state: "ready",
          complete: true,
          retryable: false,
          verified_contiguous: true,
          missing_ranges: [],
        };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  const planned = await feed.repairVisibleGaps(SERIES, rows([0, 3_600, 10_800]));
  assert.equal(planned.requested, 1);
  assert.equal(feed.pendingRepairCount(SERIES), 1);

  const duplicatePlanner = await feed.repairVisibleGaps(
    SERIES,
    rows([0, 3_600, 10_800]),
    null,
    { throttleMs: 0 },
  );
  assert.equal(duplicatePlanner.requested, 0);
  assert.equal(calls, 1, "a not-yet-due pending range must not consume another attempt");

  assert.equal(await feed.pollPendingRepairs(SERIES, { force: true }), 1);
  assert.equal(calls, 2);
  assert.equal(feed.pendingRepairCount(SERIES), 0);
});

test("an initial pending range still resolves after the normal retry window without switching interval", async () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  let backendReady = false;
  let calls = 0;
  let resolved = 0;
  Date.now = () => now;
  try {
    const feed = new SeriesDataFeed({
      api: {
        fetchKlinesRange: async () => {
          calls += 1;
          return backendReady
            ? {
              data: rows([7_200]),
              history_state: "ready",
              complete: true,
              retryable: false,
              verified_contiguous: true,
              missing_ranges: [],
            }
            : {
              data: [],
              history_state: "pending",
              complete: false,
              retryable: true,
              verified_contiguous: false,
              missing_ranges: [{ start_ms: 7_200_000, end_ms: 7_200_000 }],
            };
        },
      },
      getActiveSeries: () => SERIES,
      commitMergedChartData: () => {},
    });

    assert.deepEqual(feed.trackPendingResultRepair(SERIES, {
      data: [],
      start_ms: 7_200_000,
      end_ms: 7_200_000,
      history_state: "pending",
      complete: false,
      retryable: true,
      verified_contiguous: false,
      missing_ranges: [{ start_ms: 7_200_000, end_ms: 7_200_000 }],
    }, () => { resolved += 1; }), {
      start: 7_200,
      end: 7_200,
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal(await feed.pollPendingRepairs(SERIES, { force: true, maxRequests: 1 }), 1);
    }

    backendReady = true;
    now += 61_000;
    assert.equal(await feed.pollPendingRepairs(SERIES, { maxRequests: 1 }), 0);
    assert.equal(feed.pendingRepairCount(SERIES), 1);

    now += 10 * 60_000;
    assert.equal(await feed.pollPendingRepairs(SERIES, { maxRequests: 1 }), 1);
    assert.equal(calls, 6);
    assert.equal(resolved, 1);
    assert.equal(feed.pendingRepairCount(SERIES), 0);
  } finally {
    Date.now = originalNow;
  }
});

test("a later held-window scan discovers a websocket-era interior jump", async () => {
  let calls = 0;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async () => {
        calls += 1;
        return {
          data: rows([7_200]),
          verified_contiguous: true,
          history_state: "ready",
          complete: true,
          retryable: false,
          missing_ranges: [],
        };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  assert.equal((await feed.repairVisibleGaps(
    SERIES,
    rows([0, 3_600, 7_200]),
    null,
    { throttleMs: 0 },
  )).planned, 0);
  assert.equal((await feed.repairVisibleGaps(
    SERIES,
    rows([0, 3_600, 10_800]),
    null,
    { throttleMs: 0 },
  )).requested, 1);
  assert.equal(calls, 1);
});

test("ending a series session releases pending repairs and planner throttle state", async () => {
  let calls = 0;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async () => {
        calls += 1;
        return {
          data: [],
          history_state: "pending",
          complete: false,
          retryable: true,
          verified_contiguous: false,
          missing_ranges: [{ start_ms: 7_200_000, end_ms: 7_200_000 }],
        };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  await feed.repairVisibleGaps(SERIES, rows([0, 3_600, 10_800]));
  assert.equal(feed.pendingRepairCount(SERIES), 1);
  feed.cancelSeriesRepairs(SERIES);
  assert.equal(feed.pendingRepairCount(SERIES), 0);

  assert.equal((await feed.repairVisibleGaps(
    SERIES,
    rows([0, 3_600, 10_800]),
  )).requested, 1);
  assert.equal(calls, 2, "a new session must not inherit the old planner throttle");
  feed.cancelSeriesRepairs(SERIES);
});

test("gap repair pagination resumes from the cap cursor", async () => {
  const requestedEnds: number[] = [];
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, _interval, _start, end) => {
        requestedEnds.push(end);
        return {
          data: [],
          truncated: true,
          next_end_ms: (end - 3_600) * 1_000,
          verified_contiguous: true,
          missing_ranges: [],
        };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  await feed.repairVisibleGaps(SERIES, rows([0, 36_000]), null, { throttleMs: 0 });
  assert.deepEqual(requestedEnds.slice(0, 4), [32_400, 28_800, 25_200, 21_600]);

  await feed.pollPendingRepairs(SERIES, { force: true, maxRequests: 1 });
  assert.equal(requestedEnds[4], 18_000, "polling must continue below the consumed cap");
});

test("a pagination cap preserves missing ranges from consumed newer pages", async () => {
  const requests: Array<{ start: EpochSeconds; end: EpochSeconds }> = [];
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, _interval, start, end) => {
        requests.push({ start, end });
        if ((start === 3_600 && end === 18_000) || (start === 28_800 && end === 28_800)) {
          return {
            data: rows([start, end]),
            truncated: false,
            verified_contiguous: true,
            history_state: "ready",
            complete: true,
            retryable: false,
            missing_ranges: [],
          };
        }
        return {
          data: [],
          truncated: true,
          next_end_ms: (end - 3_600) * 1_000,
          verified_contiguous: false,
          missing_ranges: end === 32_400
            ? [{ start_ms: 28_800_000, end_ms: 28_800_000 }]
            : [],
        };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  await feed.repairVisibleGaps(SERIES, rows([0, 36_000]), null, { throttleMs: 0 });

  assert.equal(feed.pendingRepairCount(SERIES), 2);
  assert.equal(await feed.pollPendingRepairs(SERIES, { force: true, maxRequests: 2 }), 2);
  assert.deepEqual(requests.slice(-2), [
    { start: 3_600, end: 18_000 },
    { start: 28_800, end: 28_800 },
  ]);
  assert.equal(feed.pendingRepairCount(SERIES), 0);
});

test("a capped initial verification finalizes only after every child range resolves", () => {
  const feed = new SeriesDataFeed({ getActiveSeries: () => SERIES });
  const range = { start: epochSeconds(3_600), end: epochSeconds(32_400) };
  let resolved = 0;
  const updatePending = (feed as unknown as {
    updatePendingGapRepairFromResult(
      series: typeof SERIES,
      pendingRange: typeof range,
      result: FeedResult,
      attempts: number,
      dormant: boolean,
      onResolved?: () => void,
    ): void;
  }).updatePendingGapRepairFromResult.bind(feed);

  updatePending(SERIES, range, {
    data: [],
    rows: [],
    truncated: true,
    pagination_stop_reason: "cap",
    next_end_ms: 18_000_000,
    complete: false,
    retryable: true,
    verified_contiguous: false,
    missing_ranges: [{ start_ms: 28_800_000, end_ms: 28_800_000 }],
  }, 1, false, () => { resolved += 1; });

  updatePending(SERIES, {
    start: epochSeconds(3_600),
    end: epochSeconds(18_000),
  }, {
    data: rows([3_600, 18_000]),
    rows: rows([3_600, 18_000]),
    complete: true,
    retryable: false,
    verified_contiguous: true,
    missing_ranges: [],
  }, 2, false);
  assert.equal(resolved, 0);

  updatePending(SERIES, {
    start: epochSeconds(28_800),
    end: epochSeconds(28_800),
  }, {
    data: rows([28_800]),
    rows: rows([28_800]),
    complete: true,
    retryable: false,
    verified_contiguous: true,
    missing_ranges: [],
  }, 2, false);
  assert.equal(resolved, 1);
});

test("clearing a capped parent removes child repairs and rejects a late in-flight response", async () => {
  let releaseChild: (() => void) | undefined;
  const childPending = new Promise<void>((resolve) => { releaseChild = resolve; });
  let childStarted = false;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, _interval, start, end) => {
        childStarted = true;
        await childPending;
        return {
          data: [],
          start_ms: start * 1_000,
          end_ms: end * 1_000,
          history_state: "pending",
          complete: false,
          retryable: true,
          verified_contiguous: false,
          missing_ranges: [{ start_ms: start * 1_000, end_ms: end * 1_000 }],
        };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });
  const parent = mustBeDefined(feed.trackPendingResultRepair(SERIES, {
    data: [],
    rows: [],
    start_ms: 3_600_000,
    end_ms: 32_400_000,
    truncated: true,
    pagination_stop_reason: "cap",
    next_end_ms: 18_000_000,
    complete: false,
    retryable: true,
    verified_contiguous: false,
    missing_ranges: [{ start_ms: 28_800_000, end_ms: 28_800_000 }],
  } as FeedResult));
  assert.equal(feed.pendingRepairCount(SERIES), 2);

  const poll = feed.pollPendingRepairs(SERIES, { force: true, maxRequests: 1 });
  while (!childStarted) await new Promise((resolve) => setImmediate(resolve));
  feed.clearPendingResultRepair(SERIES, parent);
  assert.equal(feed.pendingRepairCount(SERIES), 0);

  mustBeDefined(releaseChild)();
  await poll;
  assert.equal(feed.pendingRepairCount(SERIES), 0);
  assert.equal(feed.terminalRepairCount(SERIES), 0);
});

test("a stale repair lease cannot block or release the next epoch lease", async () => {
  let calls = 0;
  let releaseFirst: (() => void) | undefined;
  let releaseSecond: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, _interval, start, end) => {
        calls += 1;
        const callNumber = calls;
        if (callNumber === 1) await firstGate;
        if (callNumber === 2) await secondGate;
        return callNumber < 3
          ? {
            data: [],
            start_ms: start * 1_000,
            end_ms: end * 1_000,
            history_state: "pending",
            complete: false,
            retryable: true,
            verified_contiguous: false,
            missing_ranges: [{ start_ms: start * 1_000, end_ms: end * 1_000 }],
          }
          : {
            data: rows([start, end]),
            start_ms: start * 1_000,
            end_ms: end * 1_000,
            history_state: "ready",
            complete: true,
            retryable: false,
            verified_contiguous: true,
            missing_ranges: [],
          };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  const first = feed.repairVisibleGaps(SERIES, rows([0, 7_200]), null, { throttleMs: 0 });
  while (calls < 1) await new Promise((resolve) => setImmediate(resolve));
  feed.beginEpoch(SERIES);
  const second = feed.repairVisibleGaps(SERIES, rows([0, 7_200]), null, { throttleMs: 0 });
  while (calls < 2) await new Promise((resolve) => setImmediate(resolve));

  mustBeDefined(releaseFirst)();
  await first;
  assert.equal(await feed.pollPendingRepairs(SERIES, { force: true }), 0);
  assert.equal(calls, 2);

  mustBeDefined(releaseSecond)();
  await second;
  assert.equal(await feed.pollPendingRepairs(SERIES, { force: true }), 1);
  assert.equal(calls, 3);
  assert.equal(feed.pendingRepairCount(SERIES), 0);
});

test("cancelling a repair generation aborts the exact request without blocking its successor", async () => {
  let calls = 0;
  let releaseSecond: (() => void) | undefined;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const observedSignals: AbortSignal[] = [];
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, _interval, start, end, _marketType, _exchange, options) => {
        calls += 1;
        const signal = mustBeDefined(options.signal);
        observedSignals.push(signal);
        if (calls === 1) {
          await new Promise<never>((_resolve, reject) => {
            const rejectAborted = () => {
              const error = new Error("cancelled exact repair");
              error.name = "AbortError";
              reject(error);
            };
            if (signal.aborted) rejectAborted();
            else signal.addEventListener("abort", rejectAborted, { once: true });
          });
        }
        await secondGate;
        return {
          data: rows([start, end]),
          history_state: "ready",
          complete: true,
          retryable: false,
          verified_contiguous: true,
          missing_ranges: [],
        };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  const first = feed.repairVisibleGaps(
    SERIES,
    rows([0, 7_200]),
    null,
    { throttleMs: 0 },
  );
  while (calls < 1) await new Promise((resolve) => setImmediate(resolve));

  feed.cancelSeriesRepairs(SERIES);
  assert.equal(observedSignals[0]?.aborted, true);

  const second = feed.repairVisibleGaps(
    SERIES,
    rows([0, 7_200]),
    null,
    { throttleMs: 0 },
  );
  while (calls < 2) await new Promise((resolve) => setImmediate(resolve));
  await first;
  assert.equal(
    feed.gapRepairInFlight.size,
    1,
    "the old finally must not release the successor generation lease",
  );

  mustBeDefined(releaseSecond)();
  await second;
  assert.equal(calls, 2, "the new generation must not join the old aborted inflight promise");
  assert.equal(feed.gapRepairInFlight.size, 0);
  assert.equal(feed.pendingRepairCount(SERIES), 0);
});

test("cancelling a visible-gap batch does not dispatch its remaining stale plans", async () => {
  let calls = 0;
  let firstStarted = false;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, _interval, start, end, _marketType, _exchange, options) => {
        calls += 1;
        firstStarted = true;
        const signal = mustBeDefined(options.signal);
        await new Promise<never>((_resolve, reject) => {
          const rejectAborted = () => {
            const error = new Error("cancelled visible gap batch");
            error.name = "AbortError";
            reject(error);
          };
          if (signal.aborted) rejectAborted();
          else signal.addEventListener("abort", rejectAborted, { once: true });
        });
        return {
          data: rows([start, end]),
          history_state: "ready",
          complete: true,
          retryable: false,
          verified_contiguous: true,
          missing_ranges: [],
        };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  const repairing = feed.repairVisibleGaps(
    SERIES,
    rows([0, 7_200, 14_400]),
    null,
    { throttleMs: 0 },
  );
  while (!firstStarted) await new Promise((resolve) => setImmediate(resolve));

  feed.cancelSeriesRepairs(SERIES);
  const result = await repairing;

  assert.equal(result.planned, 2);
  assert.equal(result.requested, 0);
  assert.equal(calls, 1, "the cancelled batch must not use a new generation for stale plans");
  assert.equal(feed.pendingRepairCount(SERIES), 0);
});

test("a stalled pagination cursor becomes terminal instead of auto-polling forever", async () => {
  let calls = 0;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, _interval, _start, end) => {
        calls += 1;
        return {
          data: [],
          truncated: true,
          next_end_ms: end * 1_000,
          verified_contiguous: false,
          missing_ranges: [],
        };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  await feed.repairVisibleGaps(SERIES, rows([0, 3_600, 10_800]), null, { throttleMs: 0 });

  assert.equal(feed.pendingRepairCount(SERIES), 0);
  assert.equal(feed.terminalRepairCount(SERIES), 1);
  assert.equal(await feed.pollPendingRepairs(SERIES, { force: true }), 0);
  assert.equal(calls, 1);
});

test("a terminal initial exact repair reports failure instead of leaving loading unresolved", async () => {
  let terminalReason: string | null = null;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, _interval, _start, end) => ({
        data: [],
        truncated: true,
        next_end_ms: end * 1_000,
        verified_contiguous: false,
        missing_ranges: [],
      }),
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });
  feed.trackPendingResultRepair(SERIES, {
    data: [],
    start_ms: 7_200_000,
    end_ms: 7_200_000,
    history_state: "pending",
    complete: false,
    retryable: true,
    verified_contiguous: false,
  }, undefined, (reason) => { terminalReason = reason; });

  assert.equal(await feed.pollPendingRepairs(SERIES, { force: true }), 1);
  assert.equal(terminalReason, "pagination_stalled-cursor");
  assert.equal(feed.pendingRepairCount(SERIES), 0);
  assert.equal(feed.terminalRepairCount(SERIES), 1);
});

test("a terminal capped child clears its initial-repair siblings", async () => {
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, _interval, _start, end) => ({
        data: [],
        truncated: true,
        next_end_ms: end * 1_000,
        verified_contiguous: false,
        missing_ranges: [],
      }),
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });
  let parent: { start: EpochSeconds; end: EpochSeconds } | null = null;
  parent = feed.trackPendingResultRepair(SERIES, {
    data: [],
    rows: [],
    start_ms: 3_600_000,
    end_ms: 32_400_000,
    truncated: true,
    pagination_stop_reason: "cap",
    next_end_ms: 18_000_000,
    complete: false,
    retryable: true,
    verified_contiguous: false,
    missing_ranges: [{ start_ms: 28_800_000, end_ms: 28_800_000 }],
  } as FeedResult, undefined, () => {
    feed.clearPendingResultRepair(SERIES, parent);
  });
  assert.equal(feed.pendingRepairCount(SERIES), 2);

  assert.equal(await feed.pollPendingRepairs(SERIES, { force: true, maxRequests: 1 }), 1);
  assert.equal(feed.pendingRepairCount(SERIES), 0);
  assert.equal(feed.terminalRepairCount(SERIES), 0);
});

test("before-page fetches share one per-series lease across request owners", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesBefore: async () => {
        calls += 1;
        await pending;
        return { data: [], history_state: "pending", complete: false, retryable: true };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  const first = feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    source: "manual-before",
    pendingCooldownMs: 0,
  });
  while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = await feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    source: "safety-before",
  });

  assert.equal(second.skipped, true);
  assert.equal(second.reason, "before-page-inflight");
  assert.equal(calls, 1);
  mustBeDefined(release)();
  await first;
});

test("a stale before-page lease cannot block or release the next epoch lease", async () => {
  let calls = 0;
  let releaseFirst: (() => void) | undefined;
  let releaseSecond: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesBefore: async () => {
        calls += 1;
        await (calls === 1 ? firstGate : secondGate);
        return { data: [], history_state: "pending", complete: false, retryable: true };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  const first = feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    source: "same-before-source",
    pendingCooldownMs: 0,
  });
  while (calls < 1) await new Promise((resolve) => setImmediate(resolve));
  feed.beginEpoch(SERIES);
  const second = feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    source: "same-before-source",
    pendingCooldownMs: 0,
  });
  while (calls < 2) await new Promise((resolve) => setImmediate(resolve));

  mustBeDefined(releaseFirst)();
  await first;
  const third = await feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    source: "third-owner",
  });
  assert.equal(third.skipped, true);
  assert.equal(third.reason, "before-page-inflight");
  assert.equal(calls, 2);

  mustBeDefined(releaseSecond)();
  await second;
});

test("a fresh-window epoch prevents an older left page from merging after replacement", async () => {
  let beforeCalls = 0;
  let releaseBefore: (() => void) | undefined;
  const beforeGate = new Promise<void>((resolve) => { releaseBefore = resolve; });
  const committed: string[] = [];
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesBefore: async () => {
        beforeCalls += 1;
        await beforeGate;
        return { data: rows([100]) };
      },
      fetchKlinesHistory: async () => ({ data: rows([900, 1_000]) }),
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: (_symbol, _interval, _rows, meta) => {
      committed.push(String(meta?.source || "unknown"));
    },
  });

  const oldLeft = feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    source: "history-before-page",
    cooldownMs: 0,
  });
  while (beforeCalls < 1) await new Promise((resolve) => setImmediate(resolve));

  feed.beginEpoch(SERIES);
  const freshWindow = await feed.getHistory(SERIES, {
    countBack: 2,
    source: "right-window-restore",
    commit: "none",
  });
  mustBeDefined(releaseBefore)();
  const staleLeft = await oldLeft;

  assert.equal(freshWindow.stale, false);
  assert.deepEqual(freshWindow.data.map((row) => row.time), [900, 1_000]);
  assert.equal(staleLeft.stale, true);
  assert.deepEqual(committed, [], "the old left request cannot merge after the fresh snapshot epoch");
});

test("cancelling a repair generation aborts before-page work and permits an immediate retry", async () => {
  let calls = 0;
  let releaseSecond: (() => void) | undefined;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const observedSignals: AbortSignal[] = [];
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesBefore: async (_symbol, _interval, _before, _bars, _marketType, _exchange, options) => {
        calls += 1;
        const signal = mustBeDefined(options.signal);
        observedSignals.push(signal);
        if (calls === 1) {
          await new Promise<never>((_resolve, reject) => {
            const rejectAborted = () => {
              const error = new Error("cancelled before-page repair");
              error.name = "AbortError";
              reject(error);
            };
            if (signal.aborted) rejectAborted();
            else signal.addEventListener("abort", rejectAborted, { once: true });
          });
        }
        await secondGate;
        return {
          data: rows([100]),
          has_more: true,
          history_state: "ready",
          complete: true,
          retryable: false,
          verified_contiguous: true,
          missing_ranges: [],
        };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  const first = feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    cooldownMs: 0,
  });
  while (calls < 1) await new Promise((resolve) => setImmediate(resolve));

  feed.cancelSeriesRepairs(SERIES);
  assert.equal(observedSignals[0]?.aborted, true);

  const second = feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    cooldownMs: 0,
  });
  while (calls < 2) await new Promise((resolve) => setImmediate(resolve));
  const firstResult = await first;
  assert.equal(firstResult.reason, "repair-cancelled");
  assert.equal(
    feed.beforePageFetchInFlight.size,
    1,
    "the old before-page finally must retain the successor lease",
  );

  mustBeDefined(releaseSecond)();
  const secondResult = await second;
  assert.equal(calls, 2, "the retry must have a generation-scoped inflight key");
  assert.equal(secondResult.skipped, undefined);
  assert.equal(secondResult.data?.length, 1);
  assert.equal(feed.beforePageFetchInFlight.size, 0);
});

test("before-page polling enters dormant backoff after five failed probes", async () => {
  let calls = 0;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesBefore: async () => {
        calls += 1;
        return { data: [], history_state: "pending", complete: false, retryable: true };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  await feed.requestBeforePage(SERIES, {
    before: epochSeconds(200),
    pendingCooldownMs: 0,
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(await feed.pollPendingRepairs(SERIES, { force: true, maxRequests: 1 }), 1);
  }
  assert.equal(calls, 6);
  assert.equal(await feed.pollPendingRepairs(SERIES, { maxRequests: 1 }), 0);
  assert.equal(calls, 6);
});

test("availability revision replacement clears stale excluded ranges", async () => {
  let rangeCalls = 0;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async () => {
        rangeCalls += 1;
        return {
          data: [],
          verified_contiguous: true,
          availability_revision: "calendar-v1",
          excluded_ranges: [{ start_ms: 7_200_000, end_ms: 7_200_000 }],
          missing_ranges: [],
        };
      },
      fetchKlinesHistory: async () => ({
        data: rows([0, 3_600, 10_800]),
        availability_revision: "calendar-v2",
      }),
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  await feed.repairVisibleGaps(SERIES, rows([0, 3_600, 10_800]), null, { throttleMs: 0 });
  assert.equal(rangeCalls, 1);
  assert.equal((await feed.repairVisibleGaps(
    SERIES,
    rows([0, 3_600, 10_800]),
    null,
    { throttleMs: 0 },
  )).planned, 0);

  await feed.getHistory(SERIES, { countBack: 3, source: "revision-refresh" });
  assert.equal((await feed.repairVisibleGaps(
    SERIES,
    rows([0, 3_600, 10_800]),
    null,
    { throttleMs: 0 },
  )).requested, 1);
  assert.equal(rangeCalls, 2);
});

test("multiple initial completion chunks coalesce into one full-range verification", async () => {
  const requests: Array<{ start: EpochSeconds; end: EpochSeconds }> = [];
  let releaseFirst: (() => void) | undefined;
  const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let clearCalls = 0;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, _interval, start, end) => {
        requests.push({ start, end });
        if (requests.length === 1) await firstPending;
        if (start === 100 && end === 300) {
          return {
            data: rows([100, 200, 300]),
            verified_contiguous: true,
            history_state: "ready",
            complete: true,
            retryable: false,
            missing_ranges: [],
          };
        }
        return {
          data: rows([start, end]),
          verified_contiguous: true,
          history_state: "ready",
          complete: true,
          retryable: false,
          missing_ranges: [],
        };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });
  const options: BackfillCompletedOptions = {
    activeSeries: SERIES,
    pendingInitial: {
      ...SERIES,
      range: {
        start: mustBeDefined(toEpochMilliseconds(100_000)),
        end: mustBeDefined(toEpochMilliseconds(300_000)),
      },
    },
    clearPendingInitial: () => { clearCalls += 1; },
    getCacheRows: () => rows([100, 300]),
    cooldownMs: 0,
  };

  feed.handleBackfillCompleted({
    type: "backfill_completed",
    ...SERIES,
    market_type: SERIES.marketType,
    detail: {
      request_id: "chunk-a",
      reason: "initial_history",
      range_start_ms: 120_000,
      range_end_ms: 180_000,
    },
  }, options);
  feed.handleBackfillCompleted({
    type: "backfill_completed",
    ...SERIES,
    market_type: SERIES.marketType,
    detail: {
      request_id: "chunk-b",
      reason: "initial_history",
      range_start_ms: 220_000,
      range_end_ms: 280_000,
    },
  }, options);
  while (requests.length === 0) await new Promise((resolve) => setImmediate(resolve));
  mustBeDefined(releaseFirst)();
  while (feed.backfillReloadInFlight.size > 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(requests, [
    { start: 120, end: 180 },
    { start: 220, end: 280 },
    { start: 100, end: 300 },
  ]);
  assert.equal(clearCalls, 1);
});

test("chart demand generation reaches every history transport and is cleared on cancel", async () => {
  const seen: KlineRequestOptions[] = [];
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesHistory: async (_symbol, _interval, _days, _marketType, _exchange, options) => {
        seen.push(options);
        return { data: [] };
      },
      fetchKlinesBefore: async (_symbol, _interval, _before, _bars, _marketType, _exchange, options) => {
        seen.push(options);
        return { data: [] };
      },
      fetchKlinesRange: async (_symbol, _interval, _start, _end, _marketType, _exchange, options) => {
        seen.push(options);
        return { data: [] };
      },
    },
  });
  feed.setRequestDemand(SERIES, { scope: "chart:test:1", generation: 9 });

  await feed.getHistory(SERIES);
  await feed.getBefore(SERIES, { before: epochSeconds(20) });
  await feed.getRange(SERIES, { start: epochSeconds(1), end: epochSeconds(20) });

  assert.equal(seen.length, 3);
  for (const options of seen) {
    assert.equal(options.demandScope, "chart:test:1");
    assert.equal(options.demandGeneration, 9);
  }

  feed.cancelSeriesRequests(SERIES);
  await feed.getHistory(SERIES);
  assert.equal(seen.at(-1)?.demandScope, undefined);
  assert.equal(seen.at(-1)?.demandGeneration, undefined);
});

test("initial completion without an exact range reuses the planned derived countBack", async () => {
  const historyCountBacks: Array<number | null | undefined> = [];
  let clearCalls = 0;
  const pendingInitial = {
    ...SERIES,
    countBack: 216,
    range: null,
  };
  let currentPending: NonNullable<BackfillCompletedOptions["pendingInitial"]> | null = pendingInitial;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async () => ({
        data: [],
        verified_contiguous: true,
        history_state: "ready",
        complete: true,
        retryable: false,
        missing_ranges: [],
      }),
      fetchKlinesHistory: async (
        _symbol,
        _interval,
        _days,
        _marketType,
        _exchange,
        options,
      ) => {
        historyCountBacks.push(options.countBack);
        return {
          data: rows([100, 200]),
          verified_contiguous: true,
          history_state: "ready",
          complete: true,
          retryable: false,
          missing_ranges: [],
        };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  feed.handleBackfillCompleted({
    type: "backfill_completed",
    ...SERIES,
    market_type: SERIES.marketType,
    detail: {
      request_id: "derived-initial-count-back",
      reason: "initial_history",
      range_start_ms: 100_000,
      range_end_ms: 200_000,
    },
  }, {
    activeSeries: SERIES,
    pendingInitial,
    getPendingInitial: () => currentPending,
    clearPendingInitial: () => {
      clearCalls += 1;
      currentPending = null;
    },
    getCacheRows: () => rows([100, 200]),
    cooldownMs: 0,
  });
  while (feed.backfillReloadInFlight.size > 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(historyCountBacks, [216]);
  assert.equal(clearCalls, 1);
});

test("same-series epoch rollover cannot finalize an older initial verification", async () => {
  let releaseVerification: (() => void) | undefined;
  const verificationPending = new Promise<void>((resolve) => { releaseVerification = resolve; });
  const requests: Array<{ start: EpochSeconds; end: EpochSeconds }> = [];
  let clearCalls = 0;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, _interval, start, end) => {
        requests.push({ start, end });
        if (start === 100 && end === 300) await verificationPending;
        return {
          data: rows([start, end]),
          verified_contiguous: true,
          history_state: "ready",
          complete: true,
          retryable: false,
          missing_ranges: [],
        };
      },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });
  feed.beginEpoch(SERIES);
  feed.handleBackfillCompleted({
    type: "backfill_completed",
    ...SERIES,
    market_type: SERIES.marketType,
    detail: {
      request_id: "old-epoch-chunk",
      reason: "initial_history",
      range_start_ms: 120_000,
      range_end_ms: 180_000,
    },
  }, {
    activeSeries: SERIES,
    pendingInitial: {
      ...SERIES,
      range: {
        start: mustBeDefined(toEpochMilliseconds(100_000)),
        end: mustBeDefined(toEpochMilliseconds(300_000)),
      },
    },
    clearPendingInitial: () => { clearCalls += 1; },
    getCacheRows: () => rows([100, 300]),
    cooldownMs: 0,
  });
  while (!requests.some((request) => request.start === 100 && request.end === 300)) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  feed.beginEpoch(SERIES);
  mustBeDefined(releaseVerification)();
  while (feed.backfillReloadInFlight.size > 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(clearCalls, 0);
});

test("switching symbols during initial verification cannot mutate the new active session", async () => {
  let activeSymbol = SERIES.symbol;
  let releaseVerification: (() => void) | undefined;
  const verificationPending = new Promise<void>((resolve) => { releaseVerification = resolve; });
  const requests: Array<{ start: EpochSeconds; end: EpochSeconds }> = [];
  let clearCalls = 0;
  let lastPriceCalls = 0;
  let errorCalls = 0;
  let statusCalls = 0;
  let loadingCalls = 0;
  const pendingInitial = {
    ...SERIES,
    range: {
      start: mustBeDefined(toEpochMilliseconds(100_000)),
      end: mustBeDefined(toEpochMilliseconds(300_000)),
    },
  };
  let currentPending: NonNullable<BackfillCompletedOptions["pendingInitial"]> | null = pendingInitial;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, _interval, start, end) => {
        requests.push({ start, end });
        if (start === 100 && end === 300) await verificationPending;
        return {
          data: rows([start, end]),
          verified_contiguous: true,
          history_state: "ready",
          complete: true,
          retryable: false,
          missing_ranges: [],
        };
      },
    },
    getActiveSeries: () => ({ ...SERIES, symbol: activeSymbol }),
    commitMergedChartData: () => {},
  });

  feed.handleBackfillCompleted({
    type: "backfill_completed",
    ...SERIES,
    market_type: SERIES.marketType,
    detail: {
      request_id: "switch-symbol-chunk",
      reason: "initial_history",
      range_start_ms: 120_000,
      range_end_ms: 180_000,
    },
  }, {
    activeSeries: SERIES,
    pendingInitial,
    getPendingInitial: () => currentPending,
    clearPendingInitial: () => { clearCalls += 1; },
    getCacheRows: () => rows([100, 300]),
    setLastPrice: () => { lastPriceCalls += 1; },
    setError: () => { errorCalls += 1; },
    setConnectionStatus: () => { statusCalls += 1; },
    setLoading: () => { loadingCalls += 1; },
    cooldownMs: 0,
  });
  while (!requests.some((request) => request.start === 100 && request.end === 300)) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  activeSymbol = "ETHUSDT";
  currentPending = null;
  mustBeDefined(releaseVerification)();
  while (feed.backfillReloadInFlight.size > 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(clearCalls, 0);
  assert.equal(lastPriceCalls, 1, "only the earlier exact chunk may update the old active session");
  assert.equal(errorCalls, 1, "only the earlier exact chunk may clear its error state");
  assert.equal(statusCalls, 0);
  assert.equal(loadingCalls, 0);
});

test("an inactive backfill response clears old-series pending state without recreating it", async () => {
  let activeSymbol = SERIES.symbol;
  let releaseRange: (() => void) | undefined;
  const rangePending = new Promise<void>((resolve) => { releaseRange = resolve; });
  let rangeStarted = false;
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, _interval, start, end) => {
        rangeStarted = true;
        await rangePending;
        return {
          data: rows([start, end]),
          history_state: "pending",
          complete: false,
          retryable: true,
          verified_contiguous: false,
          missing_ranges: [{ start_ms: start * 1_000, end_ms: end * 1_000 }],
        };
      },
    },
    getActiveSeries: () => ({ ...SERIES, symbol: activeSymbol }),
    commitMergedChartData: () => {},
  });
  feed.trackPendingResultRepair(SERIES, {
    data: [],
    start_ms: 7_200_000,
    end_ms: 7_200_000,
    history_state: "pending",
    complete: false,
    retryable: true,
    verified_contiguous: false,
  });
  assert.equal(feed.pendingRepairCount(SERIES), 1);

  feed.handleBackfillCompleted({
    type: "backfill_completed",
    ...SERIES,
    market_type: SERIES.marketType,
    detail: {
      request_id: "inactive-range",
      reason: "visible_range_gap",
      range_start_ms: 120_000,
      range_end_ms: 180_000,
    },
  }, {
    activeSeries: SERIES,
    getCacheRows: () => rows([100, 300]),
    cooldownMs: 0,
  });
  while (!rangeStarted) await new Promise((resolve) => setImmediate(resolve));

  feed.setPendingBeforePage(SERIES, {
    before: epochSeconds(100),
    range: {
      start: mustBeDefined(toEpochMilliseconds(50_000)),
      end: mustBeDefined(toEpochMilliseconds(90_000)),
    },
  });
  assert.equal(feed.pendingRepairCount(SERIES), 2);

  activeSymbol = "ETHUSDT";
  mustBeDefined(releaseRange)();
  while (feed.backfillReloadInFlight.size > 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(feed.getPendingBeforePage(SERIES), null);
  assert.equal(feed.pendingRepairCount(SERIES), 0);
  assert.equal(feed.terminalRepairCount(SERIES), 0);
});

test("getRange treats consumed truncated pages as pagination, not repair pending", async () => {
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async (_symbol, _interval, _start, end) => end === 1_000
        ? {
          data: rows([900, 1_000]),
          truncated: true,
          next_end_ms: 800_000,
          history_state: "pending",
          complete: false,
          retryable: true,
          verified_contiguous: false,
          missing_ranges: [],
        }
        : {
          data: rows([100, 800]),
          truncated: false,
          history_state: "ready",
          complete: true,
          retryable: false,
          verified_contiguous: true,
          missing_ranges: [],
        },
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  const result = await feed.getRange(SERIES, { start: 100, end: 1_000 });

  assert.equal(result.truncated, false);
  assert.equal(result.verified_contiguous, true);
  assert.equal(result.history_state, "ready");
  assert.equal(result.complete, true);
  assert.equal(result.retryable, false);
});

test("getRange reports a resumable pagination cap", async () => {
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async () => ({
        data: rows([900, 1_000]),
        truncated: true,
        next_end_ms: 800_000,
        verified_contiguous: true,
        missing_ranges: [],
      }),
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  const result = await feed.getRange(SERIES, { start: 100, end: 1_000, maxPages: 1 });

  assert.equal(result.truncated, true);
  assert.equal(result.pagination_stop_reason, "cap");
  assert.equal(result.next_end_ms, 800_000);
  assert.equal(result.complete, false);
  assert.equal(result.retryable, true);
});

test("getRange exposes a stalled cursor as bounded non-retryable pagination", async () => {
  const feed = new SeriesDataFeed({
    api: {
      fetchKlinesRange: async () => ({
        data: rows([900, 1_000]),
        truncated: true,
        next_end_ms: 1_000_000,
        verified_contiguous: true,
        missing_ranges: [],
      }),
    },
    getActiveSeries: () => SERIES,
    commitMergedChartData: () => {},
  });

  const result = await feed.getRange(SERIES, { start: 100, end: 1_000 });

  assert.equal(result.pagination_stop_reason, "stalled-cursor");
  assert.equal(result.truncated, true);
  assert.equal(result.retryable, false);
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
  const initialRequest = parseSentSubscriptionRequest(mustBeDefined(activeSocket.sent[0]));
  assert.deepEqual(initialRequest, {
    action: "subscribe",
    request_id: "kline-subscribe-1",
    intervals: ["1h", "1m"],
  });
  activeSocket.emit({
    type: "subscribed",
    request_id: initialRequest.request_id,
    requested_intervals: ["1h", "1m"],
    intervals: ["1h", "1m"],
    failed: [],
    active_intervals: ["1h", "1m"],
  });

  subscription.updateIntervals(["1m", "5m"]);
  assert.deepEqual(JSON.parse(mustBeDefined(activeSocket.sent[1])), {
    action: "subscribe",
    request_id: "kline-subscribe-2",
    intervals: ["5m"],
  });
  assert.deepEqual(JSON.parse(mustBeDefined(activeSocket.sent[2])), {
    action: "unsubscribe",
    request_id: "kline-unsubscribe-3",
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

test("subscribeBars applies mixed ACKs without retrying rejected custom intervals", () => {
  let socket = null;
  const controls: unknown[] = [];
  const feed = new SeriesDataFeed({
    api: {
      getMultiStreamUrl: () => "ws://example.test/klines",
    },
  });

  const subscription = feed.subscribeBars(
    { exchange: "binance", marketType: "spot", symbol: "BTCUSDT" },
    {
      intervals: ["1m", "7s"],
      socketFactory: (url) => {
        socket = new FakeSocket(url);
        return socket;
      },
      onControlMessage: (message) => controls.push(message),
    },
  );

  const activeSocket = mustBeDefined<FakeSocket>(socket);
  mustBeDefined(activeSocket.onopen)(partialMock<Event>({}));
  const request = parseSentSubscriptionRequest(mustBeDefined(activeSocket.sent[0]));
  activeSocket.emit({
    type: "subscribed",
    request_id: request.request_id,
    requested_intervals: ["1m", "7s"],
    intervals: ["1m"],
    failed: [{ interval: "7s", code: "unsupported", message: "not available" }],
    active_intervals: ["1m"],
  });

  assert.equal(controls.length, 1);
  assert.equal(activeSocket.sent.length, 1);
  subscription.updateIntervals(["1m", "7s"]);
  assert.equal(activeSocket.sent.length, 1);

  subscription.updateIntervals(["7s"]);
  assert.deepEqual(JSON.parse(mustBeDefined(activeSocket.sent[1])), {
    action: "unsubscribe",
    request_id: "kline-unsubscribe-2",
    intervals: ["1m"],
  });
  activeSocket.emit({
    type: "unsubscribed",
    request_id: "kline-unsubscribe-2",
    intervals: ["1m"],
    active_intervals: [],
  });
  assert.equal(activeSocket.sent.length, 2);

  mustBeDefined(activeSocket.onclose)(partialMock<CloseEvent>({}));
  mustBeDefined(activeSocket.onopen)(partialMock<Event>({}));
  assert.deepEqual(JSON.parse(mustBeDefined(activeSocket.sent[2])), {
    action: "subscribe",
    request_id: "kline-subscribe-3",
    intervals: ["7s"],
  });
});

test("subscribeBars retries recoverable subscription failures after bounded backoff", async () => {
  let socket = null;
  const feed = new SeriesDataFeed({
    api: { getMultiStreamUrl: () => "ws://example.test/klines" },
  });
  const subscription = feed.subscribeBars(
    { exchange: "binance", marketType: "spot", symbol: "BTCUSDT" },
    {
      intervals: ["45m"],
      subscriptionRetryBaseMs: 30,
      subscriptionRetryMaxMs: 30,
      socketFactory: (url) => {
        socket = new FakeSocket(url);
        return socket;
      },
    },
  );

  const activeSocket = mustBeDefined<FakeSocket>(socket);
  mustBeDefined(activeSocket.onopen)(partialMock<Event>({}));
  const initialRequest = parseSentSubscriptionRequest(mustBeDefined(activeSocket.sent[0]));
  activeSocket.emit({
    type: "subscribed",
    request_id: initialRequest.request_id,
    requested_intervals: ["45m"],
    intervals: [],
    failed: [{
      interval: "45m",
      code: "stream_subscription_failed",
      message: "temporary upstream outage",
    }],
    active_intervals: [],
  });

  // A recoverable NACK must not synchronously recurse into another request.
  assert.equal(activeSocket.sent.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(activeSocket.sent.length, 2);
  const retryRequest = parseSentSubscriptionRequest(mustBeDefined(activeSocket.sent[1]));
  assert.deepEqual(retryRequest.intervals, ["45m"]);

  activeSocket.emit({
    type: "subscribed",
    request_id: retryRequest.request_id,
    requested_intervals: ["45m"],
    intervals: ["45m"],
    failed: [],
    active_intervals: ["45m"],
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(activeSocket.sent.length, 2);
  subscription.close();
});

test("subscribeBars canonicalizes semantic aliases before tracking ACK state", () => {
  let socket = null;
  const feed = new SeriesDataFeed({
    api: { getMultiStreamUrl: () => "ws://example.test/klines" },
  });
  const subscription = feed.subscribeBars(
    { exchange: "binance", marketType: "spot", symbol: "BTCUSDT" },
    {
      intervals: ["60m"],
      socketFactory: (url) => {
        socket = new FakeSocket(url);
        return socket;
      },
    },
  );
  const activeSocket = mustBeDefined<FakeSocket>(socket);
  mustBeDefined(activeSocket.onopen)(partialMock<Event>({}));
  const request = parseSentSubscriptionRequest(mustBeDefined(activeSocket.sent[0]));
  assert.deepEqual(request.intervals, ["1h"]);
  activeSocket.emit({
    type: "subscribed",
    request_id: request.request_id,
    requested_intervals: ["60m"],
    intervals: ["1h"],
    failed: [],
    active_intervals: ["1h"],
  });
  subscription.updateIntervals(["1h"]);
  assert.equal(activeSocket.sent.length, 1);
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
