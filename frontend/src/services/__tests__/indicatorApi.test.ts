import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ViteDevServer } from "vite";
import type * as IndicatorApiModule from "../indicatorApi.js";

let server: ViteDevServer;
let computeIndicatorRange: typeof IndicatorApiModule.computeIndicatorRange;
let computeIndicatorRangeBatch: typeof IndicatorApiModule.computeIndicatorRangeBatch;

test.before(async () => {
  server = await createServer({
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
  });
  const module = await server.ssrLoadModule(
    "/src/services/indicatorApi.js",
  ) as typeof IndicatorApiModule;
  ({ computeIndicatorRange, computeIndicatorRangeBatch } = module);
});

test.after(async () => {
  await server?.close();
});

test("range preserves a typed HTTP 202 payload and forwards AbortSignal", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  let capturedOptions: RequestInit | undefined;
  globalThis.fetch = async (_url, options) => {
    capturedOptions = options;
    return new Response(JSON.stringify({
      ok: false,
      code: "INDICATOR_RANGE_NOT_READY",
      detail: { backfillRequestIds: ["request-1"], waitedMs: 2500 },
    }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  };

  const payload = await computeIndicatorRange({
    clientId: "vol",
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    interval: "1m",
    name: "VOL",
    start: 100,
    end: 200,
    signal: controller.signal,
  });
  assert.equal(payload.code, "INDICATOR_RANGE_NOT_READY");
  assert.equal(payload.__httpStatus, 202);
  assert.equal(capturedOptions?.signal, controller.signal);
});

test("batch serializes requests while keeping signal in fetch options", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  let capturedOptions: RequestInit | undefined;
  globalThis.fetch = async (_url, options) => {
    capturedOptions = options;
    return new Response(JSON.stringify({
      ok: true,
      results: [{ clientId: "vol", payload: { ok: true } }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await computeIndicatorRangeBatch({
    requests: [{
      clientId: "vol",
      exchange: "binance",
      marketType: "spot",
      symbol: "BTCUSDT",
      interval: "1m",
      start: 100,
      end: 200,
    }],
    signal: controller.signal,
  });
  assert.equal(capturedOptions?.signal, controller.signal);
  const body = capturedOptions?.body;
  if (typeof body !== "string") throw new Error("Expected serialized request body");
  assert.deepEqual(JSON.parse(body), {
    requests: [{
      clientId: "vol",
      exchange: "binance",
      marketType: "spot",
      symbol: "BTCUSDT",
      interval: "1m",
      start: 100,
      end: 200,
    }],
  });
});

test("range rejects malformed indicator output points", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    lines: [{ outputName: "ma", data: [{ time: 100, value: "bad" }] }],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  await assert.rejects(
    computeIndicatorRange({
      clientId: "ma-1",
      exchange: "binance",
      marketType: "spot",
      symbol: "BTCUSDT",
      interval: "1m",
      name: "MA",
      start: 100,
      end: 200,
    }),
    /indicator\.range\.lines\[0\]\.data\[0\]\.value/,
  );
});

test("batch rejects malformed nested payload envelopes", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    results: [{ clientId: "ma-1", payload: "not-an-object" }],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  await assert.rejects(
    computeIndicatorRangeBatch({ requests: [] }),
    /indicator\.rangeBatch\.results\[0\]\.payload/,
  );
});
