import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ViteDevServer } from "vite";
import type * as IndicatorApiModule from "../indicatorApi.js";

let server: ViteDevServer;
let computeIndicator: typeof IndicatorApiModule.computeIndicator;
let computeIndicatorBatch: typeof IndicatorApiModule.computeIndicatorBatch;
let computeIndicatorRange: typeof IndicatorApiModule.computeIndicatorRange;
let computeIndicatorRangeBatch: typeof IndicatorApiModule.computeIndicatorRangeBatch;
let fetchScriptRuntimes: typeof IndicatorApiModule.fetchScriptRuntimes;

test.before(async () => {
  server = await createServer({
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { hmr: false, middlewareMode: true },
  });
  const module = await server.ssrLoadModule(
    "/src/services/indicatorApi.js",
  ) as typeof IndicatorApiModule;
  ({
    computeIndicator,
    computeIndicatorBatch,
    computeIndicatorRange,
    computeIndicatorRangeBatch,
    fetchScriptRuntimes,
  } = module);
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
    language: "community-lang",
    name: "VOL",
    start: 100,
    end: 200,
    requestScope: "chart:test:pane-1",
    requestGeneration: 7,
    signal: controller.signal,
  });
  assert.equal(payload.code, "INDICATOR_RANGE_NOT_READY");
  assert.equal(payload.__httpStatus, 202);
  assert.equal(capturedOptions?.signal, controller.signal);
  const body = capturedOptions?.body;
  if (typeof body !== "string") throw new Error("Expected serialized request body");
  const serialized = JSON.parse(body) as Record<string, unknown>;
  assert.equal(serialized.language, "community-lang");
  assert.equal(serialized.requestScope, "chart:test:pane-1");
  assert.equal(serialized.requestGeneration, 7);
});

test("runtime discovery parses descriptor-declared community languages", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    schemaVersion: 1,
    defaultLanguage: "community-lang",
    languages: [{
      id: "community-lang",
      name: "Community Lang",
      extensions: [".community"],
      aliases: ["community"],
      runtimeId: "community.runtime",
      routeMode: "sidecar",
      available: true,
      features: ["batch-execution/1"],
    }],
    runtimes: [{
      id: "community.runtime",
      name: "Community Runtime",
      version: "1.0.0",
      package: "community-runtime",
      languages: [{
        id: "community-lang",
        name: "Community Lang",
        extensions: [".community"],
        aliases: ["community"],
      }],
      features: ["batch-execution/1"],
      requiredHostFeatures: ["batch-execution/1"],
      meta: {},
    }],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  const catalog = await fetchScriptRuntimes();

  assert.equal(catalog.defaultLanguage, "community-lang");
  assert.equal(catalog.languages[0]?.id, "community-lang");
  assert.equal(catalog.runtimes[0]?.package, "community-runtime");
});

test("compute forwards an arbitrary descriptor language id", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let capturedBody: unknown;
  globalThis.fetch = async (_url, options) => {
    capturedBody = typeof options?.body === "string" ? JSON.parse(options.body) : null;
    return new Response(JSON.stringify({ ok: true, lines: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await computeIndicator({
    mode: "script",
    language: "community-lang",
    script: "plot(close)",
    ohlcv: [],
  });

  assert.equal((capturedBody as Record<string, unknown>).language, "community-lang");
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
      requestScope: "chart:test:pane-1",
      requestGeneration: 7,
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
      requestScope: "chart:test:pane-1",
      requestGeneration: 7,
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

test("local compute batch serializes shared OHLCV once, forwards language, and validates job identities", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let capturedOptions: RequestInit | undefined;
  const ohlcv = [{ time: 100, open: 1, high: 2, low: 0, close: 1, volume: 3 }];
  globalThis.fetch = async (_url, options) => {
    capturedOptions = options;
    return new Response(JSON.stringify({
      ok: true,
      results: [
        { clientId: "ma", jobKey: "job-ma", payload: { ok: true } },
        { clientId: "rsi", jobKey: "job-rsi", payload: { ok: true } },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  await computeIndicatorBatch({
    jobs: [
      {
        clientId: "ma",
        jobKey: "job-ma",
        request: {
          mode: "script",
          language: "community-lang",
          script: "plot(close)",
          params: { period: 20 },
          ohlcv,
          exchange: "binance",
          marketType: "spot",
          symbol: "BTCUSDT",
          interval: "1m",
        },
      },
      {
        clientId: "rsi",
        jobKey: "job-rsi",
        request: {
          mode: "builtin",
          name: "RSI",
          params: { period: 14 },
          ohlcv,
          exchange: "binance",
          marketType: "spot",
          symbol: "BTCUSDT",
          interval: "1m",
        },
      },
    ],
  });
  const body = capturedOptions?.body;
  if (typeof body !== "string") throw new Error("Expected serialized request body");
  const parsed = JSON.parse(body) as Record<string, unknown>;
  assert.deepEqual(parsed.ohlcv, ohlcv);
  assert.equal(JSON.stringify(parsed).match(/"ohlcv"/g)?.length, 1);
  assert.deepEqual(parsed.context, {
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    interval: "1m",
  });
  const requests = parsed.requests as Array<Record<string, unknown>>;
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.language, "community-lang");
});

test("local compute batch fails closed on an unexpected response identity", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const ohlcv = [{ time: 100, open: 1, high: 2, low: 0, close: 1, volume: 3 }];
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    results: [{ clientId: "other", jobKey: "job-ma", payload: { ok: true } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  await assert.rejects(computeIndicatorBatch({
    jobs: [{
      clientId: "ma",
      jobKey: "job-ma",
      request: {
        mode: "builtin",
        name: "MA",
        ohlcv,
        exchange: "binance",
        marketType: "spot",
        symbol: "BTCUSDT",
        interval: "1m",
      },
    }],
  }), /unexpected job identity/);
});

test("local compute batch rejects identities outside the bounded backend contract", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("fetch must not run");
  };
  const ohlcv = [{ time: 100, open: 1, high: 2, low: 0, close: 1, volume: 3 }];

  await assert.rejects(computeIndicatorBatch({
    jobs: [{
      clientId: "ma",
      jobKey: "x".repeat(257),
      request: {
        mode: "builtin",
        name: "MA",
        ohlcv,
        exchange: "binance",
        marketType: "spot",
        symbol: "BTCUSDT",
        interval: "1m",
      },
    }],
  }), /at most 256 characters/);
  assert.equal(fetched, false);
});
