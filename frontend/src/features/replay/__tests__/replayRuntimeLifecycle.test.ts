import assert from "node:assert/strict";
import test from "node:test";

import { ReplayApiError } from "../replayApi.js";
import { parseReplayCapabilities, parseReplaySessionResponse } from "../replayParser.js";
import type { ReplayStreamControllerOptions } from "../replayStreamController.js";
import { ReplayLifecycleEffectGuard, ReplayRuntimeLifecycle } from "../useReplayRuntime.js";
import {
  disabledCapabilities,
  enabledCapabilities,
  replaySessionResponse,
} from "./fixtures.js";

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function streamHarness() {
  const options: ReplayStreamControllerOptions[] = [];
  let starts = 0;
  let stops = 0;
  return {
    options,
    get starts() { return starts; },
    get stops() { return stops; },
    factory(value: ReplayStreamControllerOptions) {
      options.push(value);
      return {
        start() { starts += 1; },
        stop() { stops += 1; },
        requestResync() {},
      };
    },
  };
}

test("HTTP session snapshot validates only; first published chart truth is the WS atomic snapshot", async (context) => {
  const harness = streamHarness();
  let capabilityCalls = 0;
  let sessionCalls = 0;
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    api: {
      async capabilities() {
        capabilityCalls += 1;
        return parseReplayCapabilities(enabledCapabilities());
      },
      async getSession() {
        sessionCalls += 1;
        return parseReplaySessionResponse(replaySessionResponse());
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  assert.equal(capabilityCalls, 1);
  assert.equal(sessionCalls, 1);
  assert.equal(harness.starts, 1);
  assert.equal(lifecycle.getSnapshot().phase, "CONNECTING_SESSION");
  assert.equal(lifecycle.store.seriesStore.barCount, 0);
  assert.equal(lifecycle.getSnapshot().store.hasAuthoritativeSnapshot, false);

  const callback = harness.options[0];
  callback?.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callback?.onSnapshot?.(parseReplaySessionResponse(replaySessionResponse()).snapshot, 1);
  assert.equal(lifecycle.getSnapshot().phase, "ACTIVE");
  assert.equal(lifecycle.store.seriesStore.barCount, 1);
});

test("disabled capability fails closed before session validation or socket construction", async (context) => {
  const harness = streamHarness();
  let sessionCalls = 0;
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    api: {
      async capabilities() { return parseReplayCapabilities(disabledCapabilities()); },
      async getSession() {
        sessionCalls += 1;
        return parseReplaySessionResponse(replaySessionResponse());
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  assert.equal(lifecycle.getSnapshot().phase, "ERROR");
  assert.equal(lifecycle.getSnapshot().error?.code, "REPLAY_DISABLED");
  assert.equal(sessionCalls, 0);
  assert.equal(harness.options.length, 0);
});

test("missing session stays on replay error state", async (context) => {
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "missing-session" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() { throw new ReplayApiError("SESSION_NOT_FOUND", "missing"); },
    },
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  assert.equal(lifecycle.getSnapshot().phase, "ERROR");
  assert.deepEqual(lifecycle.getSnapshot().error, { code: "SESSION_NOT_FOUND", message: "missing" });
  assert.equal(lifecycle.store.seriesStore.barCount, 0);
});

test("callbacks from a pre-retry runtime generation cannot publish", async (context) => {
  const harness = streamHarness();
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() { return parseReplaySessionResponse(replaySessionResponse()); },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const stale = harness.options[0];
  lifecycle.restart();
  await settle();
  stale?.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  stale?.onSnapshot?.(parseReplaySessionResponse(replaySessionResponse()).snapshot, 1);
  assert.equal(lifecycle.store.seriesStore.barCount, 0);
  assert.equal(lifecycle.getSnapshot().phase, "CONNECTING_SESSION");
  const current = harness.options[1];
  current?.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  current?.onSnapshot?.(parseReplaySessionResponse(replaySessionResponse()).snapshot, 1);
  assert.equal(lifecycle.getSnapshot().phase, "ACTIVE");
  assert.equal(lifecycle.store.seriesStore.barCount, 1);
});

test("entry route errors perform zero network and zero socket work", async (context) => {
  let calls = 0;
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "error", code: "REPLAY_ROUTE_MISMATCH", message: "bad route" },
    api: {
      async capabilities() { calls += 1; return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() { calls += 1; return parseReplaySessionResponse(replaySessionResponse()); },
    },
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  assert.equal(calls, 0);
  assert.equal(lifecycle.getSnapshot().phase, "ENTRY_ERROR");
});

test("StrictMode effect replay does not terminally dispose the reused lifecycle", async () => {
  let starts = 0;
  let disposals = 0;
  const lifecycle = {
    start() { starts += 1; },
    dispose() { disposals += 1; },
  };
  const guard = new ReplayLifecycleEffectGuard();

  const firstCleanup = guard.mount(lifecycle);
  firstCleanup();
  const finalCleanup = guard.mount(lifecycle);
  await Promise.resolve();
  assert.equal(starts, 2);
  assert.equal(disposals, 0);

  finalCleanup();
  await Promise.resolve();
  assert.equal(disposals, 1);
});

test("lifecycle replacement still disposes the obsolete instance", async () => {
  const disposed: string[] = [];
  const first = { start() {}, dispose() { disposed.push("first"); } };
  const second = { start() {}, dispose() { disposed.push("second"); } };
  const guard = new ReplayLifecycleEffectGuard();

  guard.mount(first)();
  const secondCleanup = guard.mount(second);
  await Promise.resolve();
  assert.deepEqual(disposed, ["first"]);

  secondCleanup();
  await Promise.resolve();
  assert.deepEqual(disposed, ["first", "second"]);
});
