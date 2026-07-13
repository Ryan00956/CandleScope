import assert from "node:assert/strict";
import test from "node:test";

import { createServer } from "vite";
import { structuralMock } from "../../../test/testHelpers.js";

type RuntimeModule = typeof import("../useIndicatorRuntime.js");

let server: Awaited<ReturnType<typeof createServer>> | null = null;
let planIndicatorRangeRetry = structuralMock<RuntimeModule["planIndicatorRangeRetry"]>(() => {
  throw new Error("indicator runtime not loaded");
});
let hostedIndicatorRangeRequestsReady = structuralMock<
  RuntimeModule["hostedIndicatorRangeRequestsReady"]
>(() => {
  throw new Error("indicator runtime not loaded");
});
let isTypedIndicatorRangeWait = structuralMock<RuntimeModule["isTypedIndicatorRangeWait"]>(() => {
  throw new Error("indicator runtime not loaded");
});

test.before(async () => {
  server = await createServer({
    appType: "custom",
    server: { middlewareMode: true },
  });
  ({
    planIndicatorRangeRetry,
    hostedIndicatorRangeRequestsReady,
    isTypedIndicatorRangeWait,
  } = structuralMock<RuntimeModule>(await server.ssrLoadModule(
    "/src/features/indicators/useIndicatorRuntime.js",
  )));
});

test("hosted range waits for all subscribed acknowledgements then fails open at the deadline", () => {
  const base = {
    indicatorIds: ["vol", "macd"],
    waitStartedAt: 1_000,
    timeoutMs: 2_000,
  };
  assert.equal(hostedIndicatorRangeRequestsReady({
    ...base,
    subscribedIds: new Set(["vol"]),
    now: 2_999,
  }), false);
  assert.equal(hostedIndicatorRangeRequestsReady({
    ...base,
    subscribedIds: new Set(["vol", "macd"]),
    now: 1_001,
  }), true);
  assert.equal(hostedIndicatorRangeRequestsReady({
    ...base,
    subscribedIds: new Set(),
    now: 3_000,
  }), true);
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

test("typed bounded-wait responses defer to events without a blind retry", () => {
  assert.equal(isTypedIndicatorRangeWait({
    ok: false,
    code: "INDICATOR_RANGE_NOT_READY",
    __httpStatus: 202,
    detail: { backfillRequestIds: ["req-1"], waitedMs: 2500 },
  }), true);
  assert.equal(isTypedIndicatorRangeWait({
    ok: false,
    code: "INDICATOR_RANGE_NOT_READY",
    detail: { retryAfterMs: 3000 },
  }), false);
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
