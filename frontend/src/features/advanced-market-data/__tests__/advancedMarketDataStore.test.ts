import assert from "node:assert/strict";
import test from "node:test";

import { AdvancedMarketDataStore } from "../advancedMarketDataStore.js";
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
  assert.strictEqual(snapshot.fundingPreview, latestPreview);
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
