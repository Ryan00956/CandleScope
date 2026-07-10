import assert from "node:assert/strict";
import test from "node:test";

import { createServer } from "vite";

let server;
let planIndicatorRangeRetry;

test.before(async () => {
  server = await createServer({
    appType: "custom",
    server: { middlewareMode: true },
  });
  ({ planIndicatorRangeRetry } = await server.ssrLoadModule(
    "/src/features/indicators/useIndicatorRuntime.js",
  ));
});

test.after(async () => {
  await server?.close();
});

test("indicator NOT_READY gets one bounded fallback instead of a polling chain", () => {
  assert.deepEqual(planIndicatorRangeRetry({
    attempts: 0,
    retryAfterMs: 750,
  }), {
    delayMs: 3000,
    nextAttempts: 1,
    shouldRetry: true,
  });

  assert.deepEqual(planIndicatorRangeRetry({
    attempts: 1,
    retryAfterMs: 750,
  }), {
    delayMs: null,
    nextAttempts: 1,
    shouldRetry: false,
  });
});

test("indicator retry honors a longer server delay and normalizes invalid input", () => {
  assert.deepEqual(planIndicatorRangeRetry({
    attempts: Number.NaN,
    retryAfterMs: 5000,
  }), {
    delayMs: 5000,
    nextAttempts: 1,
    shouldRetry: true,
  });

  assert.deepEqual(planIndicatorRangeRetry({
    attempts: 0,
    retryAfterMs: Number.NaN,
  }), {
    delayMs: 3000,
    nextAttempts: 1,
    shouldRetry: true,
  });
});
