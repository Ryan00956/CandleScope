import assert from "node:assert/strict";
import test from "node:test";

import {
  AdvancedMarketDataStore,
  type AdvancedMarketFrameScheduler,
} from "../advancedMarketDataStore.js";
import { buildAdvancedMarketIdentityKey } from "../advancedMarketDataTypes.js";
import type {
  AdvancedMarketChannel,
  AdvancedMarketIdentity,
  MarketStateRecord,
} from "../advancedMarketDataTypes.js";

const IDENTITY: AdvancedMarketIdentity = {
  exchange: "binance",
  marketType: "futures",
  symbol: "BTCUSDT",
};

function manualFrameScheduler() {
  const callbacks = new Map<number, () => void>();
  let nextHandle = 1;
  const scheduler: AdvancedMarketFrameScheduler = {
    request(callback) {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      callbacks.delete(handle);
    },
  };
  return {
    scheduler,
    get pendingCount() { return callbacks.size; },
    flush() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
  };
}

function record(
  channel: AdvancedMarketChannel,
  data: Record<string, unknown>,
  eventTime: number,
  revision = 1,
): MarketStateRecord {
  return {
    key: {
      exchange: IDENTITY.exchange,
      market_type: IDENTITY.marketType,
      symbol: IDENTITY.symbol,
      channel,
      params: {},
    },
    topic: `${buildAdvancedMarketIdentityKey(IDENTITY)}@${channel}`,
    channel,
    event_time_ms: eventTime,
    received_at_ms: eventTime + 10,
    source: "websocket",
    sequence: null,
    revision,
    data,
  };
}

test("summary lane is latest-only, ignores stale records, and stays separate from metrics", () => {
  const store = new AdvancedMarketDataStore();
  const key = buildAdvancedMarketIdentityKey(IDENTITY);
  let summaryNotifications = 0;
  let metricNotifications = 0;
  store.subscribeSummary(key, () => { summaryNotifications += 1; });
  store.subscribeMetrics(key, () => { metricNotifications += 1; });

  store.applyRecords(IDENTITY, [
    record("basis", {
      mark_price: 101,
      index_price: 100,
      basis: 1,
      basis_rate: 0.01,
      basis_bps: 100,
    }, 2000, 2),
  ]);
  store.applyRecords(IDENTITY, [record("basis", {
    mark_price: 91,
    index_price: 90,
    basis: 1,
  }, 1000, 1)]);

  assert.equal(store.getSummarySnapshot(key).markPrice, 101);
  assert.equal(store.getSummarySnapshot(key).indexPrice, 100);
  assert.equal(summaryNotifications, 1);
  assert.equal(metricNotifications, 0);

  store.applyRecords(IDENTITY, [record("open_interest", {
    open_interest: 50_000,
    is_final: false,
    sample_kind: "provisional",
  }, 3000)]);
  assert.equal(metricNotifications, 1);
  assert.equal(summaryNotifications, 1);
});

test("browser-frame delivery coalesces metric updates and exposes only the latest snapshot", () => {
  const frame = manualFrameScheduler();
  const store = new AdvancedMarketDataStore(frame.scheduler);
  const key = buildAdvancedMarketIdentityKey(IDENTITY);
  let notifications = 0;
  store.subscribeMetrics(key, () => { notifications += 1; });

  store.applyRecords(IDENTITY, [record("open_interest", { open_interest: 1 }, 1000)]);
  store.applyRecords(IDENTITY, [record("open_interest", { open_interest: 2 }, 2000)]);
  store.applyRecords(IDENTITY, [record("open_interest", { open_interest: 3 }, 3000)]);

  assert.equal(frame.pendingCount, 1);
  assert.equal(notifications, 0);
  assert.equal(store.getMetricsSnapshot(key).openInterestHistory.at(-1)?.data.open_interest, 3);
  frame.flush();
  assert.equal(notifications, 1);
});

test("an identical cloned metric record preserves the snapshot and emits no extra frame", () => {
  const frame = manualFrameScheduler();
  const store = new AdvancedMarketDataStore(frame.scheduler);
  const key = buildAdvancedMarketIdentityKey(IDENTITY);
  let notifications = 0;
  store.subscribeMetrics(key, () => { notifications += 1; });
  const first = record("open_interest", {
    open_interest: 50_000,
    is_final: false,
    sample_kind: "provisional",
  }, 1000);

  store.applyRecords(IDENTITY, [first]);
  frame.flush();
  const snapshot = store.getMetricsSnapshot(key);
  store.applyRecords(IDENTITY, [{
    ...first,
    key: { ...first.key, params: { ...first.key.params } },
    data: { ...first.data },
  }]);

  assert.strictEqual(store.getMetricsSnapshot(key), snapshot);
  assert.equal(frame.pendingCount, 0);
  assert.equal(notifications, 1);
});

test("merging the same history page preserves metric array and snapshot references", () => {
  const store = new AdvancedMarketDataStore();
  const key = buildAdvancedMarketIdentityKey(IDENTITY);
  const history = record("open_interest", {
    open_interest: 42_000,
    is_final: true,
    sample_kind: "final",
  }, 1000);
  store.mergeMetricHistory(IDENTITY, "open_interest", [history], "5m");
  const first = store.getMetricsSnapshot(key);

  store.mergeMetricHistory(IDENTITY, "open_interest", [{
    ...history,
    key: { ...history.key, params: { ...history.key.params } },
    data: { ...history.data },
  }], "5m");

  const second = store.getMetricsSnapshot(key);
  assert.strictEqual(second, first);
  assert.strictEqual(second.openInterestHistory, first.openInterestHistory);
});

test("funding history keeps settlements and overwrites preview separately", () => {
  const store = new AdvancedMarketDataStore();
  const key = buildAdvancedMarketIdentityKey(IDENTITY);
  const settlement = record("funding_rate", {
    funding_rate: 0.0001,
    funding_time_ms: 1000,
    is_final: true,
    sample_kind: "settlement",
  }, 1000);
  const firstPreview = record("funding_rate", {
    funding_rate: 0.0002,
    next_funding_time_ms: 9000,
    is_final: false,
    sample_kind: "preview",
  }, 2000);
  const latestPreview = record("funding_rate", {
    funding_rate: 0.0003,
    next_funding_time_ms: 9000,
    is_final: false,
    sample_kind: "preview",
  }, 3000);

  store.mergeMetricHistory(IDENTITY, "funding_rate", [settlement, firstPreview, latestPreview]);
  const snapshot = store.getMetricsSnapshot(key);
  assert.deepEqual(snapshot.fundingHistory, [settlement]);
  assert.deepEqual(snapshot.fundingRealtimeHistory, [firstPreview, latestPreview]);
  assert.strictEqual(snapshot.fundingPreview, latestPreview);
});

test("funding derived history is isolated by chart period", () => {
  const store = new AdvancedMarketDataStore();
  const key = buildAdvancedMarketIdentityKey(IDENTITY);
  const hourly = record("funding_rate", {
    funding_rate: 0.0001,
    sample_time_ms: 3_600_000,
    sample_kind: "estimate",
    provenance: "derived_history",
    quality: "estimated",
    is_final: false,
  }, 0);
  const fiveMinute = record("funding_rate", {
    funding_rate: 0.0002,
    sample_time_ms: 300_000,
    sample_kind: "estimate",
    provenance: "derived_history",
    quality: "estimated",
    is_final: false,
  }, 300_000);

  store.setFundingPeriod(IDENTITY, "1h");
  store.mergeMetricHistory(IDENTITY, "funding_rate", [hourly], "1h");
  assert.deepEqual(store.getMetricsSnapshot(key).fundingHistory, [hourly]);

  store.setFundingPeriod(IDENTITY, "5m");
  store.mergeMetricHistory(IDENTITY, "funding_rate", [fiveMinute], "5m");
  assert.deepEqual(store.getMetricsSnapshot(key).fundingHistory, [fiveMinute]);

  store.setFundingPeriod(IDENTITY, "1h");
  assert.deepEqual(store.getMetricsSnapshot(key).fundingHistory, [hourly]);
});

test("funding period partition preserves month M distinct from minute m", () => {
  const store = new AdvancedMarketDataStore();
  const key = buildAdvancedMarketIdentityKey(IDENTITY);
  const minute = record("funding_rate", {
    funding_rate: 0.0001,
    sample_kind: "estimate",
    provenance: "derived_history",
    quality: "estimated",
    is_final: false,
  }, 60_000);
  const month = record("funding_rate", {
    ...minute.data,
    funding_rate: 0.0002,
  }, 2_592_000_000);

  store.setFundingPeriod(IDENTITY, "1m");
  store.mergeMetricHistory(IDENTITY, "funding_rate", [minute], "1m");
  store.setFundingPeriod(IDENTITY, "1M");
  store.mergeMetricHistory(IDENTITY, "funding_rate", [month], "1M");
  assert.deepEqual(store.getMetricsSnapshot(key).fundingHistory, [month]);

  store.setFundingPeriod(IDENTITY, "1m");
  assert.deepEqual(store.getMetricsSnapshot(key).fundingHistory, [minute]);
});

test("hybrid funding settlements follow their chart period without leaking bucket opens", () => {
  const store = new AdvancedMarketDataStore();
  const key = buildAdvancedMarketIdentityKey(IDENTITY);
  const cycleTimeMs = 28_800_000;
  const sparse = record("funding_rate", {
    funding_rate: 0.0001,
    funding_time_ms: cycleTimeMs,
    raw_funding_time_ms: cycleTimeMs,
    funding_cycle_ms: cycleTimeMs,
    sample_kind: "settlement",
    provenance: "exchange_settlement",
    quality: "final",
    is_final: true,
  }, cycleTimeMs);
  const hybrid = (period: string, bucketOpenMs: number): MarketStateRecord => ({
    ...sparse,
    key: { ...sparse.key, params: { period, view: "hybrid" } },
    event_time_ms: bucketOpenMs,
    data: { ...sparse.data, funding_rate: period === "1d" ? 0.0002 : 0.0003 },
  });
  const daily = hybrid("1d", 0);
  const hourly = hybrid("1h", cycleTimeMs);

  store.mergeMetricHistory(IDENTITY, "funding_rate", [sparse]);
  store.setFundingPeriod(IDENTITY, "1d");
  store.mergeMetricHistory(IDENTITY, "funding_rate", [daily], "1d");
  assert.deepEqual(store.getMetricsSnapshot(key).fundingHistory, [daily]);

  store.setFundingPeriod(IDENTITY, "1h");
  store.mergeMetricHistory(IDENTITY, "funding_rate", [hourly], "1h");
  assert.deepEqual(store.getMetricsSnapshot(key).fundingHistory, [hourly]);

  store.setFundingPeriod(IDENTITY, "1d");
  assert.deepEqual(store.getMetricsSnapshot(key).fundingHistory, [daily]);
});

test("funding realtime keeps bounded observations and resets at cycle boundary", () => {
  const store = new AdvancedMarketDataStore();
  const key = buildAdvancedMarketIdentityKey(IDENTITY);
  store.setFundingPeriod(IDENTITY, "5m");
  const first = record("funding_rate", {
    funding_rate: 0.0001,
    observed_at_ms: 10_000,
    next_funding_time_ms: 9_000_000,
    sample_kind: "preview",
    provenance: "exchange_realtime",
    quality: "live",
    is_final: false,
  }, 10_000);
  const sameKLatest = record("funding_rate", {
    ...first.data,
    funding_rate: 0.0002,
    observed_at_ms: 20_000,
  }, 20_000);
  const nextK = record("funding_rate", {
    ...first.data,
    funding_rate: 0.0003,
    observed_at_ms: 310_000,
  }, 310_000);
  const nextCycle = record("funding_rate", {
    ...first.data,
    funding_rate: 0.0004,
    observed_at_ms: 610_000,
    next_funding_time_ms: 18_000_000,
  }, 610_000);

  store.applyRecords(IDENTITY, [first, sameKLatest, nextK]);
  assert.deepEqual(store.getMetricsSnapshot(key).fundingRealtimeHistory, [first, sameKLatest, nextK]);

  store.applyRecords(IDENTITY, [nextCycle]);
  const snapshot = store.getMetricsSnapshot(key);
  assert.deepEqual(snapshot.fundingRealtimeHistory, [nextCycle]);
  assert.strictEqual(snapshot.fundingPreview, nextCycle);
});

test("a published funding snapshot is not mutated by later realtime observations", () => {
  const store = new AdvancedMarketDataStore();
  const key = buildAdvancedMarketIdentityKey(IDENTITY);
  const first = record("funding_rate", {
    funding_rate: 0.0001,
    observed_at_ms: 10_000,
    next_funding_time_ms: 9_000_000,
    sample_kind: "preview",
    provenance: "exchange_realtime",
    quality: "live",
    is_final: false,
  }, 10_000);
  const second = record("funding_rate", {
    ...first.data,
    funding_rate: 0.0002,
    observed_at_ms: 20_000,
  }, 20_000);

  store.applyRecords(IDENTITY, [first]);
  const previous = store.getMetricsSnapshot(key);
  store.applyRecords(IDENTITY, [second]);

  assert.deepEqual(previous.fundingRealtimeHistory, [first]);
  assert.deepEqual(store.getMetricsSnapshot(key).fundingRealtimeHistory, [first, second]);
});

test("funding realtime observations do not use epoch buckets for week or calendar month", () => {
  const cases = [
    {
      period: "1w",
      observations: [Date.UTC(2026, 6, 12, 23, 59), Date.UTC(2026, 6, 13, 0, 1)],
    },
    {
      period: "1M",
      observations: [Date.UTC(2026, 6, 31, 23, 59), Date.UTC(2026, 7, 1, 0, 1)],
    },
  ];
  for (const { period, observations } of cases) {
    const store = new AdvancedMarketDataStore();
    const key = buildAdvancedMarketIdentityKey(IDENTITY);
    store.setFundingPeriod(IDENTITY, period);
    const records = observations.map((observedAtMs, index) => record("funding_rate", {
      funding_rate: 0.0001 + index * 0.00001,
      observed_at_ms: observedAtMs,
      next_funding_time_ms: Date.UTC(2026, 11, 1),
      sample_kind: "preview",
      provenance: "exchange_realtime",
      quality: "live",
      is_final: false,
    }, observedAtMs));
    store.applyRecords(IDENTITY, records);
    assert.deepEqual(store.getMetricsSnapshot(key).fundingRealtimeHistory, records);
  }
});

test("a newer metric cycle advances past an older final sample", () => {
  const store = new AdvancedMarketDataStore();
  const key = buildAdvancedMarketIdentityKey(IDENTITY);
  const oldOpenInterestFinal = record("open_interest", {
    open_interest: 50_000,
    is_final: true,
    sample_kind: "final",
  }, 1000, 10);
  const newerOpenInterestProvisional = record("open_interest", {
    open_interest: 51_000,
    is_final: false,
    sample_kind: "provisional",
  }, 2000, 1);
  const oldFundingFinal = record("funding_rate", {
    funding_rate: 0.0001,
    funding_time_ms: 1000,
    is_final: true,
    sample_kind: "settlement",
  }, 1000, 10);
  const newerFundingPreview = record("funding_rate", {
    funding_rate: 0.0002,
    next_funding_time_ms: 9000,
    is_final: false,
    sample_kind: "preview",
  }, 2000, 1);

  store.applyRecords(IDENTITY, [oldOpenInterestFinal, oldFundingFinal]);
  store.applyRecords(IDENTITY, [newerOpenInterestProvisional, newerFundingPreview]);

  assert.deepEqual(store.getMetricsSnapshot(key).openInterestHistory, [
    newerOpenInterestProvisional,
  ]);
  assert.strictEqual(store.getMetricsSnapshot(key).fundingPreview, newerFundingPreview);
});

test("a provisional update cannot overwrite a final record for the same sample", () => {
  const store = new AdvancedMarketDataStore();
  const key = buildAdvancedMarketIdentityKey(IDENTITY);
  const finalRecord = record("open_interest", {
    open_interest: 50_000,
    is_final: true,
    sample_kind: "final",
  }, 1000, 1);
  const laterReceivedProvisional = record("open_interest", {
    open_interest: 51_000,
    is_final: false,
    sample_kind: "provisional",
  }, 1000, 99);

  store.applyRecords(IDENTITY, [finalRecord]);
  store.applyRecords(IDENTITY, [laterReceivedProvisional]);

  assert.deepEqual(store.getMetricsSnapshot(key).openInterestHistory, [finalRecord]);
});

test("identity reset drops inactive cached histories", () => {
  const store = new AdvancedMarketDataStore();
  const key = buildAdvancedMarketIdentityKey(IDENTITY);
  store.applyRecords(IDENTITY, [record("open_interest", { open_interest: 1 }, 1000)]);
  assert.equal(store.getMetricsSnapshot(key).openInterestHistory.length, 1);
  store.resetIdentity(IDENTITY);
  assert.equal(store.getMetricsSnapshot(key).openInterestHistory.length, 0);
});

test("OI history is isolated by requested period while live OI stays a shared tail", () => {
  const store = new AdvancedMarketDataStore();
  const key = buildAdvancedMarketIdentityKey(IDENTITY);
  const fiveMinute = record("open_interest", {
    open_interest: 50_000,
    is_final: true,
    sample_kind: "final",
  }, 1000);
  const oneHour = record("open_interest", {
    open_interest: 60_000,
    is_final: true,
    sample_kind: "final",
  }, 2000);
  const websocketLive = record("open_interest", { open_interest: 70_000 }, 3000);

  // The request descriptor is authoritative even when mock/history records
  // have an empty key.params object.
  store.mergeMetricHistory(IDENTITY, "open_interest", [fiveMinute], "5m");
  store.mergeMetricHistory(IDENTITY, "open_interest", [oneHour], "1h");
  store.applyRecords(IDENTITY, [websocketLive]);

  let snapshot = store.getMetricsSnapshot(key);
  assert.equal(snapshot.openInterestPeriod, "5m");
  assert.deepEqual(snapshot.openInterestHistory.map((item) => item.data.open_interest), [
    50_000,
    70_000,
  ]);
  assert.equal(snapshot.openInterestHistory.at(-1)?.data.sample_kind, "provisional");

  store.setOpenInterestPeriod(IDENTITY, "1h");
  snapshot = store.getMetricsSnapshot(key);
  assert.equal(snapshot.openInterestPeriod, "1h");
  assert.deepEqual(snapshot.openInterestHistory.map((item) => item.data.open_interest), [
    60_000,
    70_000,
  ]);

  store.setOpenInterestPeriod(IDENTITY, "5m");
  assert.deepEqual(
    store.getMetricsSnapshot(key).openInterestHistory.map((item) => item.data.open_interest),
    [50_000, 70_000],
  );
});
