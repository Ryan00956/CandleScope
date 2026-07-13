import assert from "node:assert/strict";
import test from "node:test";

import {
  ApiError,
  fetchExchangeCapabilities,
  fetchExchanges,
  fetchKlinesHistory,
  fetchSubscriptions,
  request,
  syncWatchlistSymbols,
} from "../api.js";
import { ApiPayloadError } from "../apiPayloadParsers.js";

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
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => (
    String(url).endsWith("/capabilities")
      ? jsonResponse(exchangeCapability())
      : jsonResponse({ count: 1, exchanges: [exchangeCapability()] })
  );

  assert.equal((await fetchExchanges()).exchanges[0].exchange, "binance");
  assert.deepEqual((await fetchExchangeCapabilities()).native_intervals, ["1m", "1h"]);

  globalThis.fetch = async () => jsonResponse({ count: 1, exchanges: [{}] });
  await assert.rejects(() => fetchExchanges(), ApiPayloadError);
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

  assert.equal((await fetchSubscriptions()).subscriptions[0].tier, "full");
  assert.equal((await syncWatchlistSymbols(["BTCUSDT", "ETHUSDT"])).synced, 2);

  globalThis.fetch = async () => jsonResponse({ subscriptions: [{ symbol: "BTCUSDT", tier: "vip" }] });
  await assert.rejects(() => fetchSubscriptions(), ApiPayloadError);
});
