import assert from "node:assert/strict";
import test from "node:test";

import {
  ApiError,
  buildCacheLimitsRequestBody,
  fetchExchangeCapabilities,
  fetchExchangeInfo,
  fetchExchanges,
  fetchKlinesBefore,
  fetchKlinesHistory,
  fetchLatestKlines,
  fetchKlinesRange,
  fetchSubscriptions,
  request,
  syncWatchlistSymbols,
} from "../api.js";
import { ApiPayloadError } from "../apiPayloadParsers.js";
import { resetSharedControlReadsForTests } from "../sharedControlRead.js";

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function kline(overrides: Record<string, unknown> = {}) {
  return {
    time: 1_700_000_000,
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 12.5,
    is_closed: true,
    ...overrides,
  };
}

function exchangeCapability(overrides: Record<string, unknown> = {}) {
  return {
    exchange: "binance",
    name: "Binance",
    markets: [{ market_type: "spot", product_type: "spot", label: "Spot" }],
    native_intervals: ["1m", "1h"],
    protocol_features: ["rest", "websocket"],
    limits: { max_bars: 1000 },
    known_limitations: [],
    ...overrides,
  };
}

test("kline endpoints validate payloads and forward AbortSignal", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  let capturedOptions: RequestInit | undefined;
  globalThis.fetch = async (_url, options) => {
    capturedOptions = options;
    return jsonResponse({
      data: [kline()],
      has_more: false,
      truncated: false,
      next_end_ms: null,
    });
  };

  const payload = await fetchKlinesHistory(
    "BTCUSDT",
    "1m",
    1,
    "spot",
    "binance",
    { signal: controller.signal },
  );

  assert.equal(capturedOptions?.signal, controller.signal);
  assert.deepEqual(payload.data, [kline()]);
});

test("count-back history omits the redundant days window", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let capturedUrl = "";
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return jsonResponse({ data: [] });
  };

  await fetchKlinesHistory(
    "BTCUSDT",
    "1M",
    45_000,
    "futures",
    "binance",
    { countBack: 1_500 },
  );

  const params = new URL(capturedUrl, "http://localhost").searchParams;
  assert.equal(params.get("count_back"), "1500");
  assert.equal(params.has("days"), false);
});

test("history forwards bounded wait and caller intent", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let capturedUrl = "";
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return jsonResponse({ data: [] });
  };

  await fetchKlinesHistory(
    "BTCUSDT",
    "1m",
    1,
    "spot",
    "binance",
    { maxWaitMs: 0, intent: "active_hydration" },
  );

  const params = new URL(capturedUrl, "http://localhost").searchParams;
  assert.equal(params.get("max_wait_ms"), "0");
  assert.equal(params.get("intent"), "active_hydration");
});

test("K-line history transports forward chart demand scope and generation", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const capturedUrls: string[] = [];
  globalThis.fetch = async (url) => {
    capturedUrls.push(String(url));
    return jsonResponse({ data: [] });
  };

  const demand = { demandScope: "chart:client:pane-1", demandGeneration: 7 };
  await fetchKlinesHistory("BTCUSDT", "1m", 1, "spot", "binance", demand);
  await fetchKlinesBefore("BTCUSDT", "1m", 1_700_000_000, 500, "spot", "binance", demand);
  await fetchKlinesRange(
    "BTCUSDT",
    "1m",
    1_699_999_000,
    1_700_000_000,
    "spot",
    "binance",
    demand,
  );

  assert.equal(capturedUrls.length, 3);
  for (const capturedUrl of capturedUrls) {
    const params = new URL(capturedUrl, "http://localhost").searchParams;
    assert.equal(params.get("request_scope"), demand.demandScope);
    assert.equal(params.get("request_generation"), String(demand.demandGeneration));
  }
});

test("latest forwards bounded foreground repair and chart demand", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let capturedUrl = "";
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return jsonResponse({ data: [], has_tail_gap: true });
  };

  await fetchLatestKlines("ETHUSDT", "1m", 5, "spot", "binance", "initial-latest", {
    repair: "wait",
    waitMs: 1_500,
    demandScope: "chart:client:pane-1",
    demandGeneration: 8,
  });

  const params = new URL(capturedUrl, "http://localhost").searchParams;
  assert.equal(params.get("repair"), "wait");
  assert.equal(params.get("max_wait_ms"), "1500");
  assert.equal(params.get("request_scope"), "chart:client:pane-1");
  assert.equal(params.get("request_generation"), "8");
});

test("before-page validation forwards a zero long-poll budget", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let capturedUrl = "";
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return jsonResponse({ data: [] });
  };

  await fetchKlinesBefore(
    "BTCUSDT",
    "89m",
    1_700_000_000,
    109,
    "spot",
    "binance",
    { maxWaitMs: 0 },
  );

  const params = new URL(capturedUrl, "http://localhost").searchParams;
  assert.equal(params.get("max_wait_ms"), "0");
});

test("kline parser rejects malformed bars, metadata, and millisecond timestamps", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const invalidPayloads = [
    { data: "not-an-array" },
    { data: [kline({ close: "105" })] },
    { data: [kline({ time: 1_700_000_000_000 })] },
    { data: [kline()], truncated: "false" },
  ];

  for (const payload of invalidPayloads) {
    globalThis.fetch = async () => jsonResponse(payload);
    await assert.rejects(
      () => fetchKlinesHistory(),
      (error) => error instanceof ApiPayloadError,
    );
  }
});

test("request preserves ApiError fields and does not wrap AbortError", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => jsonResponse({ detail: "backend rejected request" }, { status: 422 });

  await assert.rejects(
    () => request("/api/v1/example"),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 422);
      assert.equal(error.detail, "backend rejected request");
      assert.equal(error.url, "/api/v1/example");
      return true;
    },
  );

  const abortError = new DOMException("cancelled", "AbortError");
  globalThis.fetch = async () => Promise.reject(abortError);
  await assert.rejects(
    () => request("/api/v1/example"),
    (error) => error === abortError,
  );
});

test("request preserves structured backend error codes", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => jsonResponse({
    detail: {
      code: "stale_request_generation",
      request_scope: "chart:test",
      request_generation: 3,
    },
  }, { status: 409 });

  await assert.rejects(
    () => request("/api/v1/klines/range"),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "stale_request_generation");
      assert.match(error.detail, /"request_scope":"chart:test"/);
      assert.match(error.detail, /"request_generation":3/);
      return true;
    },
  );
});

test("request rejects invalid JSON on a successful response", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("{invalid", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  await assert.rejects(() => request("/api/v1/example"), SyntaxError);
});

test("exchange endpoints validate the list and capabilities shapes", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
    resetSharedControlReadsForTests();
  });
  const capability = exchangeCapability({
    capability_schema_version: 3,
    support: {
      provider: "ccxt_primary",
      routable: true,
      verification_level: "shadow",
      qualification: {
        ccxt_version: "4.5.60",
        level: "shadow",
        verified_at: "2026-08-07T01:19:43Z",
        market_types: ["spot"],
        channels: ["kline"],
        evidence_id: "ccxt-shadow-binance-spot-1910-zero-mismatch",
        event_count: 1910,
      },
      qualifications: [{
        ccxt_version: "4.5.60",
        level: "shadow",
        verified_at: "2026-08-07T01:19:43Z",
        market_types: ["spot"],
        channels: ["kline"],
        evidence_id: "ccxt-shadow-binance-spot-1910-zero-mismatch",
        event_count: 1910,
      }],
      products: {
        markets: {
          spot: {
            chart: true,
            order_book: {
              supported: true,
              channel: "depth",
              mode: "snapshot",
              snapshot_mode: "live_snapshot",
              strict_full_depth: true,
            },
            trade_flow: {
              supported: true,
              channel: "agg_trade",
              mode: "strict_repairable",
              sequence_continuity: true,
              history: true,
              delivery_mode: "live_stream",
            },
            advanced_market_data: {
              supported: true,
              channels: {
                funding_rate: {
                  supported: true,
                  realtime: false,
                  history: true,
                  delivery_mode: "history_only",
                },
              },
            },
          },
        },
      },
    },
    channels: [{
      channel: "kline",
      market_types: ["spot"],
      history: true,
      realtime: true,
      params: { interval: ["1m", "1h"] },
    }],
  });
  globalThis.fetch = async (url) => (
    String(url).endsWith("/capabilities")
      ? jsonResponse(capability)
      : jsonResponse({
          count: 1,
          ccxt: {
            version: "4.5.60",
            rest_exchange_ids: 105,
            pro_exchange_ids: 77,
            watch_ohlcv: 59,
            watch_trades: 75,
            watch_order_book: 76,
            watch_ticker: 67,
          },
          exchanges: [capability],
        })
  );

  const exchangeList = await fetchExchanges();
  const firstExchange = exchangeList.exchanges[0];
  assert.ok(firstExchange);
  assert.equal(firstExchange.exchange, "binance");
  assert.equal(firstExchange.support?.provider, "ccxt_primary");
  assert.equal(firstExchange.support?.verification_level, "shadow");
  assert.equal(firstExchange.support?.qualifications[0]?.event_count, 1910);
  assert.equal(
    firstExchange.support?.products.markets.spot?.trade_flow.mode,
    "strict_repairable",
  );
  assert.equal(
    firstExchange.support?.products.markets.spot
      ?.advanced_market_data.channels.funding_rate?.delivery_mode,
    "history_only",
  );
  assert.equal(exchangeList.ccxt?.pro_exchange_ids, 77);
  const parsedCapability = await fetchExchangeCapabilities();
  assert.deepEqual(parsedCapability.native_intervals, ["1m", "1h"]);
  assert.equal(parsedCapability.capability_schema_version, 3);
  assert.deepEqual(parsedCapability.channels?.[0]?.params.interval, ["1m", "1h"]);

  resetSharedControlReadsForTests();
  globalThis.fetch = async () => jsonResponse({ count: 1, exchanges: [{}] });
  await assert.rejects(() => fetchExchanges(), ApiPayloadError);

  globalThis.fetch = async () => jsonResponse({
    count: 1,
    exchanges: [exchangeCapability({ channels: [{ channel: "kline" }] })],
  });
  await assert.rejects(() => fetchExchanges(), ApiPayloadError);
});

test("symbol catalog reads encode exact CCXT markets and forward cancellation", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  let capturedUrl = "";
  let capturedSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (url, options) => {
    capturedUrl = String(url);
    capturedSignal = options?.signal;
    return jsonResponse({ symbols: [] });
  };

  await fetchExchangeInfo("swap.linear", "bybit", { signal: controller.signal });

  assert.match(capturedUrl, /market_type=swap\.linear/);
  assert.match(capturedUrl, /exchange=bybit/);
  assert.equal(capturedSignal, controller.signal);
});

test("subscription endpoints validate list and sync payloads", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => (
    String(url).endsWith("/sync")
      ? jsonResponse({ synced: 2, auto_registered: 1 })
      : jsonResponse({
        subscriptions: [{ symbol: "BTCUSDT", tier: "full", intervals: ["1m"] }],
      })
  );

  const firstSubscription = (await fetchSubscriptions()).subscriptions[0];
  assert.ok(firstSubscription);
  assert.equal(firstSubscription.tier, "full");
  assert.equal((await syncWatchlistSymbols(["BTCUSDT", "ETHUSDT"])).synced, 2);

  globalThis.fetch = async () => jsonResponse({ subscriptions: [{ symbol: "BTCUSDT", tier: "vip" }] });
  await assert.rejects(() => fetchSubscriptions(), ApiPayloadError);
});

test("cache limit patches preserve omitted, null, and false semantics", () => {
  assert.deepEqual(buildCacheLimitsRequestBody({ ephemeralBars: 5_000 }), {
    ephemeral_bars: 5_000,
  });
  assert.deepEqual(buildCacheLimitsRequestBody({
    sqliteBudgetBytes: null,
    storageRowLimitsEnabled: false,
  }), {
    sqlite_budget_bytes: null,
    storage_row_limits_enabled: false,
  });
});
