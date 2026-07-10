import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

let server;
let computeIndicatorRange;
let computeIndicatorRangeBatch;

test.before(async () => {
  server = await createServer({ appType: "custom", server: { middlewareMode: true } });
  ({ computeIndicatorRange, computeIndicatorRangeBatch } = await server.ssrLoadModule(
    "/src/services/indicatorApi.js",
  ));
});

test.after(async () => {
  await server?.close();
});

test("range preserves a typed HTTP 202 payload and forwards AbortSignal", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  let capturedOptions;
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
  assert.equal(capturedOptions.signal, controller.signal);
});

test("batch serializes requests while keeping signal in fetch options", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  let capturedOptions;
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
    requests: [{ clientId: "vol", start: 100, end: 200 }],
    signal: controller.signal,
  });
  assert.equal(capturedOptions.signal, controller.signal);
  assert.deepEqual(JSON.parse(capturedOptions.body), {
    requests: [{ clientId: "vol", start: 100, end: 200 }],
  });
});
