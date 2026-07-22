import assert from "node:assert/strict";
import test from "node:test";

import { createServer } from "vite";
import { structuralMock } from "../../../test/testHelpers.js";

type RuntimeModule = typeof import("../useIndicatorRuntime.js");

let server: Awaited<ReturnType<typeof createServer>> | null = null;
let hostedIndicatorRangeRequestsReady = structuralMock<
  RuntimeModule["hostedIndicatorRangeRequestsReady"]
>(() => {
  throw new Error("indicator runtime not loaded");
});
let shouldWaitForIndicatorRangeSubscription = structuralMock<
  RuntimeModule["shouldWaitForIndicatorRangeSubscription"]
>(() => {
  throw new Error("indicator runtime not loaded");
});
let isTypedIndicatorRangeWait = structuralMock<RuntimeModule["isTypedIndicatorRangeWait"]>(() => {
  throw new Error("indicator runtime not loaded");
});
let isResolvedIndicatorRangeEmpty = structuralMock<
  RuntimeModule["isResolvedIndicatorRangeEmpty"]
>(() => {
  throw new Error("indicator runtime not loaded");
});
let resolveIndicatorRealtimeMode = structuralMock<
  RuntimeModule["resolveIndicatorRealtimeMode"]
>(() => {
  throw new Error("indicator runtime not loaded");
});

test.before(async () => {
  server = await createServer({
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
  });
  ({
    hostedIndicatorRangeRequestsReady,
    shouldWaitForIndicatorRangeSubscription,
    isTypedIndicatorRangeWait,
    isResolvedIndicatorRangeEmpty,
    resolveIndicatorRealtimeMode,
} = structuralMock<RuntimeModule>(await server.ssrLoadModule(
    "/src/features/indicators/useIndicatorRuntime.js",
  )));
});

test("indicator realtime follows the main K-line fallback boundary", () => {
  assert.equal(resolveIndicatorRealtimeMode(true, "live"), "enabled");
  assert.equal(resolveIndicatorRealtimeMode(true, "reconnecting"), "enabled");
  assert.equal(resolveIndicatorRealtimeMode(true, "fallback"), "historical-only");
  assert.equal(resolveIndicatorRealtimeMode(false, "idle"), "historical-only");
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

test("HTTP indicator history is not blocked by an unrelated realtime acknowledgement", () => {
  assert.equal(shouldWaitForIndicatorRangeSubscription(true), false);
  assert.equal(shouldWaitForIndicatorRangeSubscription(true, false), false);
  assert.equal(shouldWaitForIndicatorRangeSubscription(true, true), true);
  assert.equal(shouldWaitForIndicatorRangeSubscription(false, true), false);
});

test.after(async () => {
  await server?.close();
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

test("terminal indicator empty ranges resolve coverage while pending empties stay retryable", () => {
  assert.equal(isResolvedIndicatorRangeEmpty({
    ok: false,
    code: "INDICATOR_RANGE_EMPTY",
    lines: [],
    series: [],
    annotations: [],
    fills: [],
    legacyFills: [],
    markers: [],
    hlines: [],
    bgcolors: [],
    barcolors: [],
    signals: [],
    param_schema: [],
    history_state: "exhausted",
    complete: true,
    retryable: false,
  }), true);
  assert.equal(isResolvedIndicatorRangeEmpty({
    ok: false,
    code: "INDICATOR_RANGE_EMPTY",
    lines: [],
    series: [],
    annotations: [],
    fills: [],
    legacyFills: [],
    markers: [],
    hlines: [],
    bgcolors: [],
    barcolors: [],
    signals: [],
    param_schema: [],
    detail: {
      availability: {
        history_state: "exhausted",
        complete: true,
        retryable: false,
      },
    },
  }), true);
  assert.equal(isResolvedIndicatorRangeEmpty({
    ok: false,
    code: "INDICATOR_RANGE_EMPTY",
    lines: [],
    series: [],
    annotations: [],
    fills: [],
    legacyFills: [],
    markers: [],
    hlines: [],
    bgcolors: [],
    barcolors: [],
    signals: [],
    param_schema: [],
    history_state: "pending",
    complete: false,
    retryable: true,
  }), false);
});
