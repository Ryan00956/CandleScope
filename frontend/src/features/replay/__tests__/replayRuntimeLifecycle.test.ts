import assert from "node:assert/strict";
import test from "node:test";

import { SeriesWindowStore } from "../../market-data/window/seriesWindowStore.js";
import { ReplayApiError } from "../replayApi.js";
import {
  parseReplayCapabilities,
  parseReplayCatalog,
  parseReplayCommandResult,
  parseReplayEvent,
  parseReplayJournalResponse,
  parseReplayReportResponse,
  parseReplaySessionResponse,
} from "../replayParser.js";
import type { ReplayStreamControllerOptions } from "../replayStreamController.js";
import {
  buildReplayMarketDataRuntime,
  createReplayRuntimeStorePublishScheduler,
  ReplayLifecycleEffectGuard,
  ReplayRuntimeLifecycle,
} from "../useReplayRuntime.js";
import { ReplayStore } from "../replayStore.js";
import {
  BASE_TIME_MS,
  disabledCapabilities,
  enabledCapabilities,
  replayDeltaEvent,
  replayEndedEvent,
  replayFill,
  replayReport,
  replaySessionResponse,
  replayStatusEvent,
} from "./fixtures.js";

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function replayCatalogResponse(character: string) {
  return parseReplayCatalog({
    protocol: "replay.v1",
    catalog_epoch: `sha256:${character.repeat(64)}`,
    warmup_bars: 200,
    horizon_ms: 86_400_000,
    quality_mode: "exact",
    blind_mode: true,
    entries: [],
  });
}

function streamHarness() {
  const options: ReplayStreamControllerOptions[] = [];
  let starts = 0;
  let stops = 0;
  let resyncs = 0;
  return {
    options,
    get starts() { return starts; },
    get stops() { return stops; },
    get resyncs() { return resyncs; },
    factory(value: ReplayStreamControllerOptions) {
      options.push(value);
      return {
        start() { starts += 1; },
        stop() { stops += 1; },
        requestResync() { resyncs += 1; },
      };
    },
  };
}

test("React-facing replay store publishes coalesce to one asynchronous task", () => {
  const callbacks = new Map<number, () => void>();
  const canceled: number[] = [];
  let nextHandle = 1;
  let publishes = 0;
  const scheduler = createReplayRuntimeStorePublishScheduler(
    () => { publishes += 1; },
    (callback) => {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      return handle;
    },
    (handle) => {
      canceled.push(handle);
      callbacks.delete(handle);
    },
  );

  for (let index = 0; index < 100; index += 1) scheduler.schedule();
  assert.equal(callbacks.size, 1);
  assert.equal(publishes, 0);
  const firstFrame = callbacks.get(1);
  callbacks.delete(1);
  firstFrame?.();
  assert.equal(publishes, 1);

  scheduler.schedule();
  assert.equal(callbacks.size, 1);
  scheduler.cancel();
  assert.deepEqual(canceled, [2]);
  assert.equal(callbacks.size, 0);
  assert.equal(publishes, 1);
});

test("replay market-data actions keep stable identities across authoritative publications", () => {
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "error", code: "REPLAY_ENTRY_INVALID", message: "not started" },
  });
  const before = buildReplayMarketDataRuntime(lifecycle.getSnapshot(), lifecycle);

  lifecycle.store.beginGeneration(1, {
    resetAuthoritativeState: true,
    connectionState: "connecting",
  });
  const after = buildReplayMarketDataRuntime(lifecycle.getSnapshot(), lifecycle);

  assert.strictEqual(after.actions, before.actions);
  assert.strictEqual(after.actions.onCrosshairMove, before.actions.onCrosshairMove);
  assert.strictEqual(after.actions.onVisibleRangeChange, before.actions.onVisibleRangeChange);
  lifecycle.dispose();
});

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

test("an explicitly reacquired terminal controller remains heartbeat-eligible", async (context) => {
  const harness = streamHarness();
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    clientInstanceId: "browser-0001",
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() { return parseReplaySessionResponse(replaySessionResponse()); },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();

  lifecycle.store.beginGeneration(1, {
    resetAuthoritativeState: true,
    connectionState: "connected",
  });
  lifecycle.store.applyAtomicSnapshot(1, parseReplaySessionResponse(replaySessionResponse({
    controllerClientId: "browser-0001",
    state: "ENDED",
  })).snapshot);

  assert.equal(harness.options[0]?.shouldHeartbeat?.(), true);
});

test("a right-edge gesture restores the latest replay window after deep left history", async (context) => {
  const harness = streamHarness();
  const store = new ReplayStore({
    seriesStore: new SeriesWindowStore({ maxBars: 1 }),
  });
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    store,
    api: {
      async capabilities() {
        return parseReplayCapabilities(enabledCapabilities());
      },
      async getSession() {
        return parseReplaySessionResponse(replaySessionResponse());
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();

  const callbacks = harness.options[0]!;
  const authoritative = parseReplaySessionResponse(replaySessionResponse()).snapshot;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(authoritative, 1);
  const latest = store.seriesStore.first();
  assert.ok(latest);
  store.seriesStore.applyRange([{
    ...latest,
    time: latest.time - 60,
  }], { source: "replay-history-before-page" });
  assert.equal(store.seriesStore.rightTruncated, true);

  const runtime = buildReplayMarketDataRuntime(lifecycle.getSnapshot(), lifecycle);
  assert.equal(runtime.status.canRestoreLatestWindow, true);
  const restore = runtime.actions.restoreLatestWindow?.();
  assert.ok(restore);
  assert.equal(harness.resyncs, 1);

  callbacks.onGeneration?.({ generation: 2, reason: "resync", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(authoritative, 2);
  assert.equal(await restore, true);
  assert.equal(store.seriesStore.rightTruncated, false);
  assert.equal(store.seriesStore.first()?.time, latest.time);
});

for (const recovery of [
  {
    label: "reacquires the controller previously owned by this browser",
    controllerClientId: "browser-0001",
    recoveredControllerClientId: null,
    expectedCommands: 1,
  },
  {
    label: "keeps a browser that did not own the controller read-only",
    controllerClientId: "browser-other",
    recoveredControllerClientId: null,
    expectedCommands: 0,
  },
  {
    label: "never takes over a controller acquired by another browser during recovery",
    controllerClientId: "browser-0001",
    recoveredControllerClientId: "browser-other",
    expectedCommands: 0,
  },
] as const) {
  test(`a reset generation ${recovery.label}`, async (context) => {
    const harness = streamHarness();
    const commands: unknown[] = [];
    const lifecycle = new ReplayRuntimeLifecycle({
      entry: { kind: "session", sessionId: "session-0001" },
      clientInstanceId: "browser-0001",
      commandIdFactory: () => "command-reacquire-0001",
      api: {
        async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
        async getSession() {
          return parseReplaySessionResponse(replaySessionResponse({ controllerClientId: recovery.controllerClientId }));
        },
        async command(_sessionId, command) {
          commands.push(command);
          return parseReplayCommandResult({
            protocol: "replay.v1",
            session_id: "session-0001",
            command_id: command.command_id,
            revision: 1,
            sequence: 1,
            state: "PAUSED",
            state_hash: `sha256:${"4".repeat(64)}`,
            cursor: {
              virtual_time_ms: BASE_TIME_MS + 59_999,
              source_sequence: 0,
              last_base_bar_open_ms: 1_700_000_000_000,
              last_trade_time_ms: null,
              last_agg_trade_id: null,
              at_end: false,
            },
            data: { controller: "browser-0001" },
          });
        },
      },
      streamFactory: (options) => harness.factory(options),
    });
    context.after(() => lifecycle.dispose());
    lifecycle.start();
    await settle();
    const callbacks = harness.options[0]!;
    callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
    callbacks.onSnapshot?.(parseReplaySessionResponse(replaySessionResponse({
      controllerClientId: recovery.controllerClientId,
    })).snapshot, 1);
    callbacks.onGeneration?.({ generation: 2, reason: "resync", resetAuthoritativeState: true });
    callbacks.onSnapshot?.(parseReplaySessionResponse(replaySessionResponse({
      controllerClientId: recovery.recoveredControllerClientId,
    })).snapshot, 2);
    await settle();

    assert.equal(commands.length, recovery.expectedCommands);
    if (recovery.expectedCommands === 1) {
      assert.deepEqual(commands[0], {
        protocol: "replay.v1",
        command_id: "command-reacquire-0001",
        client_instance_id: "browser-0001",
        expected_revision: 0,
        type: "acquire_controller",
        payload: {},
      });
    }
  });
}

test("the first WS snapshot cannot predate the HTTP validation authority floor", async (context) => {
  const harness = streamHarness();
  const validation = parseReplaySessionResponse(replaySessionResponse({
    sequence: 10,
    revision: 4,
    sourceSequence: 6,
    virtualTimeMs: BASE_TIME_MS + 419_999,
  }));
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() { return validation; },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });

  assert.throws(
    () => callbacks.onSnapshot?.(parseReplaySessionResponse(replaySessionResponse()).snapshot, 1),
    /predates HTTP validation authority/,
  );
  assert.equal(lifecycle.getSnapshot().phase, "CONNECTING_SESSION");
  assert.equal(lifecycle.getSnapshot().store.hasAuthoritativeSnapshot, false);
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

test("create establishes the authoritative session identity used by retry", async (context) => {
  const harness = streamHarness();
  const validated: string[] = [];
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "configure" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession(sessionId) {
        validated.push(sessionId);
        return parseReplaySessionResponse(replaySessionResponse({ sessionId }));
      },
      async createSession() {
        return parseReplaySessionResponse(replaySessionResponse({ sessionId: "session-created" }));
      },
    },
    streamFactory: (options) => harness.factory(options),
    replaceSessionUrl() {},
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  assert.equal(lifecycle.getSnapshot().phase, "CONFIGURING");

  await lifecycle.createSession(parseReplaySessionResponse(replaySessionResponse()).snapshot.config);
  assert.equal(harness.options[0]?.sessionId, "session-created");
  lifecycle.restart();
  await settle();

  assert.deepEqual(validated, ["session-created"]);
  assert.equal(harness.options[1]?.sessionId, "session-created");
  assert.equal(lifecycle.getSnapshot().sessionId, "session-created");
});

test("create requests are single-flight and cannot leave duplicate sessions", async (context) => {
  const harness = streamHarness();
  let createCalls = 0;
  let resolveCreate: ((value: ReturnType<typeof parseReplaySessionResponse>) => void) | null = null;
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "configure" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() { return parseReplaySessionResponse(replaySessionResponse()); },
      async createSession() {
        createCalls += 1;
        return new Promise<ReturnType<typeof parseReplaySessionResponse>>((resolve) => { resolveCreate = resolve; });
      },
    },
    streamFactory: (options) => harness.factory(options),
    replaceSessionUrl() {},
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();

  const config = parseReplaySessionResponse(replaySessionResponse()).snapshot.config;
  const first = lifecycle.createSession(config);
  const second = lifecycle.createSession(config);
  assert.strictEqual(second, first);
  assert.equal(createCalls, 1);
  const completeCreate = resolveCreate as unknown as (
    value: ReturnType<typeof parseReplaySessionResponse>,
  ) => void;
  completeCreate(parseReplaySessionResponse(replaySessionResponse({ sessionId: "session-created" })));
  assert.deepEqual(await Promise.all([first, second]), ["session-created", "session-created"]);
  assert.equal(createCalls, 1);
});

test("fork replaces parent identity for retry and subsequent commands", async (context) => {
  const harness = streamHarness();
  const validated: string[] = [];
  const forked: string[] = [];
  const commanded: string[] = [];
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-parent" },
    clientInstanceId: "browser-0001",
    commandIdFactory: () => "command-child-0001",
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession(sessionId) {
        validated.push(sessionId);
        return parseReplaySessionResponse(replaySessionResponse({ sessionId, controllerClientId: "browser-0001" }));
      },
      async forkSession(sessionId) {
        forked.push(sessionId);
        return parseReplaySessionResponse({
          ...replaySessionResponse({ sessionId: "session-child", controllerClientId: "browser-0001" }),
          forked: true,
          forked_from_session_id: "session-parent",
        });
      },
      async command(sessionId, command) {
        commanded.push(sessionId);
        return parseReplayCommandResult({
          protocol: "replay.v1",
          session_id: sessionId,
          command_id: command.command_id,
          revision: command.expected_revision + 1,
          sequence: 1,
          state: "PAUSED",
          state_hash: `sha256:${"8".repeat(64)}`,
          cursor: {
            virtual_time_ms: BASE_TIME_MS + 59_999,
            source_sequence: 0,
            last_base_bar_open_ms: BASE_TIME_MS,
            last_trade_time_ms: null,
            last_agg_trade_id: null,
            at_end: false,
          },
          data: {},
        });
      },
    },
    streamFactory: (options) => harness.factory(options),
    replaceSessionUrl() {},
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const parentCallbacks = harness.options[0]!;
  parentCallbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  parentCallbacks.onSnapshot?.(
    parseReplaySessionResponse(replaySessionResponse({ sessionId: "session-parent", controllerClientId: "browser-0001" })).snapshot,
    1,
  );

  await lifecycle.forkSession();
  assert.doesNotThrow(() => {
    parentCallbacks.onSnapshot?.(
      parseReplaySessionResponse(replaySessionResponse({ sessionId: "session-parent", controllerClientId: "browser-0001" })).snapshot,
      1,
    );
  });
  assert.equal(lifecycle.getSnapshot().phase, "CONNECTING_SESSION");
  assert.equal(lifecycle.getSnapshot().sessionId, "session-child");
  const childCallbacks = harness.options[1]!;
  childCallbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  childCallbacks.onSnapshot?.(
    parseReplaySessionResponse(replaySessionResponse({ sessionId: "session-child", controllerClientId: "browser-0001" })).snapshot,
    1,
  );
  await lifecycle.submitCommand("step", { count: 1 });
  lifecycle.restart();
  await settle();

  assert.deepEqual(forked, ["session-parent"]);
  assert.deepEqual(commanded, ["session-child"]);
  assert.deepEqual(validated, ["session-parent", "session-child"]);
  assert.equal(harness.options[2]?.sessionId, "session-child");
  assert.equal(lifecycle.getSnapshot().sessionId, "session-child");
});

test("fork requests are single-flight and cannot create duplicate child sessions", async (context) => {
  const harness = streamHarness();
  let forkCalls = 0;
  let resolveFork: ((value: ReturnType<typeof parseReplaySessionResponse>) => void) | null = null;
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-parent" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() {
        return parseReplaySessionResponse(replaySessionResponse({
          sessionId: "session-parent",
          controllerClientId: "browser-0001",
        }));
      },
      async forkSession() {
        forkCalls += 1;
        return new Promise<ReturnType<typeof parseReplaySessionResponse>>((resolve) => { resolveFork = resolve; });
      },
    },
    streamFactory: (options) => harness.factory(options),
    replaceSessionUrl() {},
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(
    parseReplaySessionResponse(replaySessionResponse({
      sessionId: "session-parent",
      controllerClientId: "browser-0001",
    })).snapshot,
    1,
  );

  const first = lifecycle.forkSession();
  const second = lifecycle.forkSession();
  assert.strictEqual(second, first);
  assert.equal(forkCalls, 1);
  assert.equal(lifecycle.getSnapshot().forkPending, true);
  const completeFork = resolveFork as unknown as (
    value: ReturnType<typeof parseReplaySessionResponse>,
  ) => void;
  completeFork(parseReplaySessionResponse({
    ...replaySessionResponse({ sessionId: "session-child" }),
    forked: true,
    forked_from_session_id: "session-parent",
  }));
  assert.deepEqual(await Promise.all([first, second]), ["session-child", "session-child"]);
  assert.equal(forkCalls, 1);
  assert.equal(lifecycle.getSnapshot().forkPending, false);
});

test("commands cannot race a pending fork on the parent session", async (context) => {
  const harness = streamHarness();
  let commandCalls = 0;
  let resolveFork: ((value: ReturnType<typeof parseReplaySessionResponse>) => void) | null = null;
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-parent" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() {
        return parseReplaySessionResponse(replaySessionResponse({
          sessionId: "session-parent",
          controllerClientId: "browser-0001",
        }));
      },
      async forkSession() {
        return new Promise<ReturnType<typeof parseReplaySessionResponse>>((resolve) => { resolveFork = resolve; });
      },
      async command() {
        commandCalls += 1;
        throw new Error("command API must remain unreachable while fork is pending");
      },
    },
    streamFactory: (options) => harness.factory(options),
    replaceSessionUrl() {},
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(
    parseReplaySessionResponse(replaySessionResponse({
      sessionId: "session-parent",
      controllerClientId: "browser-0001",
    })).snapshot,
    1,
  );

  const fork = lifecycle.forkSession();
  await assert.rejects(() => lifecycle.submitCommand("step", { count: 1 }), /pending replay fork/);
  assert.equal(commandCalls, 0);
  const completeFork = resolveFork as unknown as (
    value: ReturnType<typeof parseReplaySessionResponse>,
  ) => void;
  completeFork(parseReplaySessionResponse({
    ...replaySessionResponse({ sessionId: "session-child" }),
    forked: true,
    forked_from_session_id: "session-parent",
  }));
  assert.equal(await fork, "session-child");
});

test("an older report request cannot clear the explicit pending-fork gate", async (context) => {
  const harness = streamHarness();
  let resolveReport: ((value: ReturnType<typeof parseReplayReportResponse>) => void) | null = null;
  let resolveFork: ((value: ReturnType<typeof parseReplaySessionResponse>) => void) | null = null;
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-parent" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() {
        return parseReplaySessionResponse(replaySessionResponse({ sessionId: "session-parent" }));
      },
      async report() {
        return new Promise<ReturnType<typeof parseReplayReportResponse>>((resolve) => { resolveReport = resolve; });
      },
      async forkSession() {
        return new Promise<ReturnType<typeof parseReplaySessionResponse>>((resolve) => { resolveFork = resolve; });
      },
    },
    streamFactory: (options) => harness.factory(options),
    replaceSessionUrl() {},
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(
    parseReplaySessionResponse(replaySessionResponse({ sessionId: "session-parent" })).snapshot,
    1,
  );

  const report = lifecycle.loadReport();
  const fork = lifecycle.forkSession();
  assert.equal(lifecycle.getSnapshot().operation, "fork");
  assert.equal(lifecycle.getSnapshot().forkPending, true);
  const completeReport = resolveReport as unknown as (
    value: ReturnType<typeof parseReplayReportResponse>,
  ) => void;
  completeReport(parseReplayReportResponse({
    protocol: "replay.v1",
    session_id: "session-parent",
    data_fidelity: "EXACT_BAR_COVERAGE",
    execution_fidelity: "BAR_CONSERVATIVE",
    revealed: false,
    report: { ...replayReport(), ended: false },
  }));
  await report;
  assert.equal(lifecycle.getSnapshot().operation, "fork");
  assert.equal(lifecycle.getSnapshot().forkPending, true);
  await assert.rejects(() => lifecycle.loadReport(), /pending replay fork/);

  const completeFork = resolveFork as unknown as (
    value: ReturnType<typeof parseReplaySessionResponse>,
  ) => void;
  completeFork(parseReplaySessionResponse({
    ...replaySessionResponse({ sessionId: "session-child" }),
    forked: true,
    forked_from_session_id: "session-parent",
  }));
  assert.equal(await fork, "session-child");
  assert.equal(lifecycle.getSnapshot().forkPending, false);
  assert.equal(lifecycle.getSnapshot().operation, null);
});

test("the newest catalog request is the only one allowed to publish", async (context) => {
  const pending: Array<(value: ReturnType<typeof replayCatalogResponse>) => void> = [];
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "configure" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() { throw new Error("session validation must remain unreachable"); },
      async catalog() {
        return new Promise<ReturnType<typeof replayCatalogResponse>>((resolve) => pending.push(resolve));
      },
    },
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  assert.equal(pending.length, 1);

  const newest = lifecycle.loadCatalog({
    warmupBars: 300,
    horizonMs: 172_800_000,
    qualityMode: "exact",
    blindMode: true,
  });
  assert.equal(pending.length, 2);
  pending[1]?.(replayCatalogResponse("b"));
  await newest;
  pending[0]?.(replayCatalogResponse("a"));
  await settle();

  assert.equal(lifecycle.getSnapshot().catalog?.catalog_epoch, `sha256:${"b".repeat(64)}`);
  assert.equal(lifecycle.getSnapshot().phase, "CONFIGURING");
});

test("a stale bootstrap catalog failure cannot replace a newer catalog with ERROR", async (context) => {
  const pending: Array<{
    resolve(value: ReturnType<typeof replayCatalogResponse>): void;
    reject(error: Error): void;
  }> = [];
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "configure" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() { throw new Error("session validation must remain unreachable"); },
      async catalog() {
        return new Promise<ReturnType<typeof replayCatalogResponse>>((resolve, reject) => {
          pending.push({ resolve, reject });
        });
      },
    },
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  assert.equal(pending.length, 1);

  const newest = lifecycle.loadCatalog();
  assert.equal(pending.length, 2);
  pending[1]?.resolve(replayCatalogResponse("b"));
  await newest;
  pending[0]?.reject(new Error("stale catalog failed"));
  await settle();

  assert.equal(lifecycle.getSnapshot().phase, "CONFIGURING");
  assert.equal(lifecycle.getSnapshot().error, null);
  assert.equal(lifecycle.getSnapshot().catalog?.catalog_epoch, `sha256:${"b".repeat(64)}`);
});

test("a parent journal response arriving after fork cannot replace the child journal", async (context) => {
  const harness = streamHarness();
  let resolveJournal: ((value: ReturnType<typeof parseReplayJournalResponse>) => void) | null = null;
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-parent" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession(sessionId) {
        return parseReplaySessionResponse(replaySessionResponse({ sessionId }));
      },
      async forkSession() {
        return parseReplaySessionResponse({
          ...replaySessionResponse({ sessionId: "session-child" }),
          forked: true,
          forked_from_session_id: "session-parent",
        });
      },
      async journal() {
        return new Promise<ReturnType<typeof parseReplayJournalResponse>>((resolve) => { resolveJournal = resolve; });
      },
    },
    streamFactory: (options) => harness.factory(options),
    replaceSessionUrl() {},
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const parentCallbacks = harness.options[0]!;
  parentCallbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  parentCallbacks.onSnapshot?.(
    parseReplaySessionResponse(replaySessionResponse({ sessionId: "session-parent" })).snapshot,
    1,
  );

  const pendingJournal = lifecycle.refreshJournal();
  await lifecycle.forkSession();
  const childCallbacks = harness.options[1]!;
  childCallbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  childCallbacks.onSnapshot?.(
    parseReplaySessionResponse(replaySessionResponse({ sessionId: "session-child" })).snapshot,
    1,
  );
  const completeJournal = resolveJournal as unknown as (
    value: ReturnType<typeof parseReplayJournalResponse>,
  ) => void;
  completeJournal(parseReplayJournalResponse({
    protocol: "replay.v1",
    session_id: "session-parent",
    entries: [{ entry_id: "parent-note", virtual_time_ms: BASE_TIME_MS, text: "parent only" }],
  }));

  await assert.rejects(pendingJournal, /runtime changed while loading the journal/);
  assert.equal(lifecycle.getSnapshot().sessionId, "session-child");
  assert.deepEqual(lifecycle.getSnapshot().store.journal, []);
});

test("session validation response must match the requested session identity", async (context) => {
  const harness = streamHarness();
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-requested" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() {
        return parseReplaySessionResponse(replaySessionResponse({ sessionId: "session-other" }));
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();

  assert.equal(lifecycle.getSnapshot().phase, "ERROR");
  assert.equal(lifecycle.getSnapshot().error?.code, "REPLAY_PROTOCOL_ERROR");
  assert.equal(harness.options.length, 0);
});

test("fork response must prove its parent before runtime identity can change", async (context) => {
  const harness = streamHarness();
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-parent" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() {
        return parseReplaySessionResponse(replaySessionResponse({ sessionId: "session-parent" }));
      },
      async forkSession() {
        return parseReplaySessionResponse({
          ...replaySessionResponse({ sessionId: "session-child" }),
          forked: true,
          forked_from_session_id: "session-wrong-parent",
        });
      },
    },
    streamFactory: (options) => harness.factory(options),
    replaceSessionUrl() {},
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(
    parseReplaySessionResponse(replaySessionResponse({ sessionId: "session-parent" })).snapshot,
    1,
  );

  await assert.rejects(() => lifecycle.forkSession(), /not bound to its parent session/);
  assert.equal(lifecycle.getSnapshot().sessionId, "session-parent");
  assert.equal(harness.options.length, 1);
});

test("journal response identity mismatch fails closed and requests resync", async (context) => {
  const harness = streamHarness();
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() { return parseReplaySessionResponse(replaySessionResponse()); },
      async journal() {
        return parseReplayJournalResponse({
          protocol: "replay.v1",
          session_id: "session-wrong",
          entries: [],
        });
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(parseReplaySessionResponse(replaySessionResponse()).snapshot, 1);

  await assert.rejects(() => lifecycle.refreshJournal(), /journal response session identity changed/);
  assert.equal(harness.resyncs, 1);
  assert.deepEqual(lifecycle.getSnapshot().store.journal, []);
});

test("journal entries beyond authoritative virtual time fail closed", async (context) => {
  const harness = streamHarness();
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() { return parseReplaySessionResponse(replaySessionResponse()); },
      async journal() {
        return parseReplayJournalResponse({
          protocol: "replay.v1",
          session_id: "session-0001",
          entries: [{
            entry_id: "future-note",
            virtual_time_ms: BASE_TIME_MS + 60_000,
            text: "must remain hidden",
          }],
        });
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(parseReplaySessionResponse(replaySessionResponse()).snapshot, 1);

  await assert.rejects(() => lifecycle.refreshJournal(), /journal crossed the authoritative replay time/);
  assert.equal(harness.resyncs, 1);
  assert.deepEqual(lifecycle.getSnapshot().store.journal, []);
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

test("commands remain gated until the stream reaches the HTTP acknowledgement", async (context) => {
  const harness = streamHarness();
  const commands: unknown[] = [];
  let resolveCommand: ((value: ReturnType<typeof parseReplayCommandResult>) => void) | null = null;
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    clientInstanceId: "browser-0001",
    commandIdFactory: () => "command-ui-0001",
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() {
        return parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" }));
      },
      async command(_sessionId, command) {
        commands.push(command);
        return new Promise((resolve) => { resolveCommand = resolve; });
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" })).snapshot, 1);
  const barsBefore = lifecycle.store.seriesStore.barCount;
  const submitted = lifecycle.submitCommand("step", { count: 1 });
  assert.equal(lifecycle.getSnapshot().pendingCommand?.type, "step");
  assert.equal(lifecycle.store.seriesStore.barCount, barsBefore);
  assert.deepEqual(commands, [{
    protocol: "replay.v1",
    command_id: "command-ui-0001",
    client_instance_id: "browser-0001",
    expected_revision: 0,
    type: "step",
    payload: { count: 1 },
  }]);
  const completeCommand = resolveCommand as unknown as (value: ReturnType<typeof parseReplayCommandResult>) => void;
  completeCommand(parseReplayCommandResult({
    protocol: "replay.v1",
    session_id: "session-0001",
    command_id: "command-ui-0001",
    revision: 1,
    sequence: 1,
    state: "PAUSED",
    state_hash: `sha256:${"4".repeat(64)}`,
    cursor: {
      virtual_time_ms: BASE_TIME_MS + 119_999,
      source_sequence: 1,
      last_base_bar_open_ms: 1_700_000_000_000,
      last_trade_time_ms: null,
      last_agg_trade_id: null,
      at_end: false,
    },
    data: { consumed: 1 },
  }));
  await submitted;
  assert.equal(lifecycle.getSnapshot().pendingCommand?.command_id, "command-ui-0001");
  assert.equal(lifecycle.getSnapshot().commandTimeline.at(-1)?.status, "acknowledged");
  assert.equal(lifecycle.store.seriesStore.barCount, barsBefore, "HTTP ack cannot advance chart truth");
  await assert.rejects(
    () => lifecycle.submitCommand("step", { count: 1 }),
    /another replay command is pending/,
  );

  const acknowledgedEvent = replayDeltaEvent();
  acknowledgedEvent.revision = 1;
  callbacks.onEvent?.(parseReplayEvent(acknowledgedEvent), 1);
  assert.equal(lifecycle.getSnapshot().pendingCommand, null);
  assert.equal(lifecycle.getSnapshot().operation, null);
});

test("a protocol-ambiguous command is retried with the same canonical command id", async (context) => {
  const harness = streamHarness();
  let commandCalls = 0;
  const submittedCommands: unknown[] = [];
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    clientInstanceId: "browser-0001",
    commandIdFactory: () => `command-ui-${commandCalls + 1}`,
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() {
        return parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" }));
      },
      async command(_sessionId, command) {
        commandCalls += 1;
        submittedCommands.push(command);
        return parseReplayCommandResult({
          protocol: "replay.v1",
          session_id: "session-0001",
          command_id: commandCalls === 1 ? "command-from-another-request" : command.command_id,
          revision: command.expected_revision + 1,
          sequence: 1,
          state: "PAUSED",
          state_hash: `sha256:${"4".repeat(64)}`,
          cursor: {
            virtual_time_ms: BASE_TIME_MS + 119_999,
            source_sequence: 1,
            last_base_bar_open_ms: BASE_TIME_MS,
            last_trade_time_ms: null,
            last_agg_trade_id: null,
            at_end: false,
          },
          data: {},
        });
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(
    parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" })).snapshot,
    1,
  );

  await assert.rejects(
    () => lifecycle.submitCommand("step", { count: 1 }),
    /command response command identity changed/,
  );
  assert.equal(lifecycle.getSnapshot().pendingCommand?.command_id, "command-ui-1");
  assert.equal(lifecycle.getSnapshot().commandTimeline.at(-1)?.status, "unknown");
  callbacks.onGeneration?.({ generation: 2, reason: "resync", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(
    parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" })).snapshot,
    2,
  );
  await settle();
  assert.equal(commandCalls, 2);
  assert.deepEqual(submittedCommands[1], submittedCommands[0], "reconciliation must reuse the canonical envelope");
  assert.equal(lifecycle.getSnapshot().pendingCommand?.command_id, "command-ui-1");
  assert.equal(lifecycle.getSnapshot().commandTimeline.at(-1)?.status, "acknowledged");
  const reconciledEvent = replayDeltaEvent();
  reconciledEvent.revision = 1;
  callbacks.onEvent?.(parseReplayEvent(reconciledEvent), 2);
  assert.equal(lifecycle.getSnapshot().pendingCommand, null);
  assert.equal(harness.resyncs, 1);
});

for (const failure of [
  {
    label: "transport loss",
    create: () => new ReplayApiError("REPLAY_TRANSPORT_ERROR", "response lost"),
  },
  {
    label: "abort",
    create: () => new DOMException("request aborted", "AbortError"),
  },
] as const) {
  test(`a command ${failure.label} remains fail-closed until same-id reconciliation`, async (context) => {
    const harness = streamHarness();
    let commandCalls = 0;
    const submittedCommands: unknown[] = [];
    const lifecycle = new ReplayRuntimeLifecycle({
      entry: { kind: "session", sessionId: "session-0001" },
      clientInstanceId: "browser-0001",
      commandIdFactory: () => "command-uncertain-0001",
      api: {
        async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
        async getSession() {
          return parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" }));
        },
        async command(_sessionId, command) {
          commandCalls += 1;
          submittedCommands.push(command);
          if (commandCalls === 1) throw failure.create();
          return parseReplayCommandResult({
            protocol: "replay.v1",
            session_id: "session-0001",
            command_id: command.command_id,
            revision: command.expected_revision + 1,
            sequence: 1,
            state: "PAUSED",
            state_hash: `sha256:${"4".repeat(64)}`,
            cursor: {
              virtual_time_ms: BASE_TIME_MS + 119_999,
              source_sequence: 1,
              last_base_bar_open_ms: BASE_TIME_MS + 60_000,
              last_trade_time_ms: null,
              last_agg_trade_id: null,
              at_end: false,
            },
            data: { consumed: 1 },
          });
        },
      },
      streamFactory: (options) => harness.factory(options),
    });
    context.after(() => lifecycle.dispose());
    lifecycle.start();
    await settle();
    const callbacks = harness.options[0]!;
    callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
    callbacks.onSnapshot?.(
      parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" })).snapshot,
      1,
    );

    await assert.rejects(() => lifecycle.submitCommand("step", { count: 1 }));
    assert.equal(commandCalls, 1);
    assert.equal(harness.resyncs, 1);
    assert.equal(lifecycle.getSnapshot().commandTimeline.at(-1)?.status, "unknown");
    assert.equal(lifecycle.getSnapshot().commandError?.details?.needs_resync, true);
    assert.equal(lifecycle.getSnapshot().pendingCommand?.command_id, "command-uncertain-0001");
    await assert.rejects(
      () => lifecycle.submitCommand("step", { count: 1 }),
      /another replay command is pending/,
    );
    assert.equal(commandCalls, 1);

    callbacks.onGeneration?.({ generation: 2, reason: "resync", resetAuthoritativeState: true });
    assert.equal(lifecycle.getSnapshot().pendingCommand?.command_id, "command-uncertain-0001");
    callbacks.onSnapshot?.(
      parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" })).snapshot,
      2,
    );
    await settle();
    assert.equal(commandCalls, 2);
    assert.deepEqual(submittedCommands[1], submittedCommands[0]);
    assert.equal(lifecycle.getSnapshot().pendingCommand?.command_id, "command-uncertain-0001");
    assert.equal(lifecycle.getSnapshot().commandError, null);
    assert.equal(lifecycle.getSnapshot().commandTimeline.at(-1)?.status, "acknowledged");
    await assert.rejects(
      () => lifecycle.submitCommand("step", { count: 1 }),
      /another replay command is pending/,
    );
    const reconciledEvent = replayDeltaEvent();
    reconciledEvent.revision = 1;
    callbacks.onEvent?.(parseReplayEvent(reconciledEvent), 2);
    assert.equal(lifecycle.getSnapshot().pendingCommand, null);
    assert.equal(lifecycle.getSnapshot().operation, null);
  });
}

test("HTTP 5xx command failures remain unknown and never reopen mutations without same-id reconciliation", async (context) => {
  const harness = streamHarness();
  const submittedCommands: unknown[] = [];
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    clientInstanceId: "browser-0001",
    commandIdFactory: () => "command-persistence-0001",
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() {
        return parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" }));
      },
      async command(_sessionId, command) {
        submittedCommands.push(command);
        throw new ReplayApiError("PERSISTENCE_DEGRADED", "report persistence failed", { status: 503 });
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(
    parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" })).snapshot,
    1,
  );

  await assert.rejects(() => lifecycle.submitCommand("end_session", {}), /report persistence failed/);
  assert.equal(lifecycle.getSnapshot().commandTimeline.at(-1)?.status, "unknown");
  assert.equal(lifecycle.getSnapshot().pendingCommand?.command_id, "command-persistence-0001");
  callbacks.onGeneration?.({ generation: 2, reason: "resync", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(
    parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" })).snapshot,
    2,
  );
  await settle();
  assert.equal(submittedCommands.length, 2, "one automatic same-id reconciliation follows the resync");
  assert.deepEqual(submittedCommands[1], submittedCommands[0]);
  assert.equal(lifecycle.getSnapshot().pendingCommand?.command_id, "command-persistence-0001");
  assert.equal(lifecycle.getSnapshot().commandTimeline.at(-1)?.status, "unknown");
  assert.equal(lifecycle.getSnapshot().commandRecoveryReady, false);

  callbacks.onGeneration?.({ generation: 3, reason: "resync", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(
    parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" })).snapshot,
    3,
  );
  await settle();
  assert.equal(submittedCommands.length, 2, "repeated ambiguous failures do not create an automatic retry loop");
  assert.equal(lifecycle.getSnapshot().commandRecoveryReady, true);
  await assert.rejects(
    () => lifecycle.submitCommand("step", { count: 1 }),
    /another replay command is pending/,
  );
  await assert.rejects(() => lifecycle.retryPendingCommandRecovery(), /report persistence failed/);
  assert.equal(submittedCommands.length, 3);
  assert.deepEqual(submittedCommands[2], submittedCommands[0]);
  assert.equal(lifecycle.getSnapshot().pendingCommand?.command_id, "command-persistence-0001");
  assert.equal(lifecycle.getSnapshot().commandTimeline.at(-1)?.status, "unknown");
});

test("runtime restart preserves an unknown command and reconciles the same id after the new handshake", async (context) => {
  const harness = streamHarness();
  const submittedCommands: unknown[] = [];
  let commandCalls = 0;
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    clientInstanceId: "browser-0001",
    commandIdFactory: () => "command-restart-0001",
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() {
        return parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" }));
      },
      async command(_sessionId, command) {
        commandCalls += 1;
        submittedCommands.push(command);
        if (commandCalls === 1) throw new ReplayApiError("REPLAY_TRANSPORT_ERROR", "response lost");
        return parseReplayCommandResult({
          protocol: "replay.v1",
          session_id: "session-0001",
          command_id: command.command_id,
          revision: command.expected_revision + 1,
          sequence: 1,
          state: "PAUSED",
          state_hash: `sha256:${"4".repeat(64)}`,
          cursor: {
            virtual_time_ms: BASE_TIME_MS + 119_999,
            source_sequence: 1,
            last_base_bar_open_ms: BASE_TIME_MS + 60_000,
            last_trade_time_ms: null,
            last_agg_trade_id: null,
            at_end: false,
          },
          data: { consumed: 1 },
        });
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const firstStream = harness.options[0]!;
  firstStream.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  firstStream.onSnapshot?.(
    parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" })).snapshot,
    1,
  );

  await assert.rejects(() => lifecycle.submitCommand("step", { count: 1 }), /response lost/);
  assert.equal(lifecycle.getSnapshot().pendingCommand?.command_id, "command-restart-0001");
  lifecycle.restart();
  await settle();
  assert.equal(harness.options.length, 2);
  assert.equal(lifecycle.getSnapshot().pendingCommand?.command_id, "command-restart-0001");
  assert.equal(lifecycle.getSnapshot().commandTimeline.at(-1)?.status, "unknown");
  assert.equal(commandCalls, 1, "restart cannot issue a new mutation before the new atomic handshake");

  const restartedStream = harness.options[1]!;
  restartedStream.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  restartedStream.onSnapshot?.(
    parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" })).snapshot,
    1,
  );
  await settle();
  assert.equal(commandCalls, 2);
  assert.deepEqual(submittedCommands[1], submittedCommands[0]);
  assert.equal(lifecycle.getSnapshot().pendingCommand?.command_id, "command-restart-0001");
  const reconciledEvent = replayDeltaEvent();
  reconciledEvent.revision = 1;
  restartedStream.onEvent?.(parseReplayEvent(reconciledEvent), 1);
  assert.equal(lifecycle.getSnapshot().pendingCommand, null);
});

test("a structured domain rejection is recorded as rejected without an unknown-outcome gate", async (context) => {
  const harness = streamHarness();
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    clientInstanceId: "browser-0001",
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() {
        return parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" }));
      },
      async command() {
        throw new ReplayApiError("ORDER_REJECTED", "order rejected", { status: 422 });
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(
    parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" })).snapshot,
    1,
  );

  await assert.rejects(() => lifecycle.submitCommand("place_order", {}), /order rejected/);
  assert.equal(lifecycle.getSnapshot().commandTimeline.at(-1)?.status, "rejected");
  assert.equal(lifecycle.getSnapshot().pendingCommand, null);
  assert.equal(lifecycle.getSnapshot().operation, null);
  assert.equal(harness.resyncs, 0);
});

test("reconnect backoff state disables HTTP commands before a new atomic handshake", async (context) => {
  const harness = streamHarness();
  let commandCalls = 0;
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    clientInstanceId: "browser-0001",
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() {
        return parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" }));
      },
      async command() {
        commandCalls += 1;
        throw new Error("command must remain unreachable");
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(
    parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" })).snapshot,
    1,
  );
  callbacks.onState?.("reconnecting", 1);

  await assert.rejects(() => lifecycle.submitCommand("step", { count: 1 }), /must reconnect/);
  assert.equal(lifecycle.getSnapshot().store.connectionState, "reconnecting");
  assert.equal(commandCalls, 0);
});

test("authoritative fills refresh the report-backed closed-trades rail during an active session", async (context) => {
  const harness = streamHarness();
  const fill = replayFill(BASE_TIME_MS + 119_999);
  const closedTrade = {
    trade_id: "trade-0001",
    order_id: fill.order_id,
    fill_id: fill.fill_id,
    side: "BUY",
    quantity: "1",
    entry_price: "100",
    exit_price: "101",
    realized_pnl: "1",
    source_sequence: 1,
  };
  let reportCalls = 0;
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    clientInstanceId: "browser-0001",
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() {
        return parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" }));
      },
      async report() {
        reportCalls += 1;
        return parseReplayReportResponse({
          protocol: "replay.v1",
          session_id: "session-0001",
          data_fidelity: "EXACT_BAR_COVERAGE",
          execution_fidelity: "BAR_CONSERVATIVE",
          revealed: false,
          report: {
            ...replayReport(),
            ended: false,
            final_equity: "10001",
            realized_pnl: "1",
            trade_count: 1,
            winning_trades: 1,
            win_rate: "1",
            average_win: "1",
            fill_count: 1,
            fills: [fill],
            closed_trades: [closedTrade],
          },
        });
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(
    parseReplaySessionResponse(replaySessionResponse({ controllerClientId: "browser-0001" })).snapshot,
    1,
  );

  callbacks.onEvent?.(parseReplayEvent(replayDeltaEvent({ fills: [fill] })), 1);
  await settle();

  assert.equal(reportCalls, 1);
  assert.deepEqual(lifecycle.getSnapshot().report?.report.closed_trades, [closedTrade]);
});

test("report artifacts cannot cross the current stream source cursor", async (context) => {
  const harness = streamHarness();
  const futureTrade = {
    trade_id: "trade-future",
    order_id: "order-0001",
    fill_id: "fill-0001",
    side: "BUY",
    quantity: "1",
    entry_price: "100",
    exit_price: "101",
    realized_pnl: "1",
    source_sequence: 1,
  };
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() { return parseReplaySessionResponse(replaySessionResponse()); },
      async report() {
        return parseReplayReportResponse({
          protocol: "replay.v1",
          session_id: "session-0001",
          data_fidelity: "EXACT_BAR_COVERAGE",
          execution_fidelity: "BAR_CONSERVATIVE",
          revealed: false,
          report: {
            ...replayReport(),
            ended: false,
            trade_count: 1,
            closed_trades: [futureTrade],
          },
        });
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(parseReplaySessionResponse(replaySessionResponse()).snapshot, 1);

  await assert.rejects(() => lifecycle.loadReport(), /causal source sequence 1 exceeds revealed cursor 0/);
  assert.equal(lifecycle.getSnapshot().report, null);
  assert.equal(harness.resyncs, 1);
});

test("a report from an old stream generation cannot cover a newer atomic snapshot", async (context) => {
  const harness = streamHarness();
  let resolveReport: ((value: ReturnType<typeof parseReplayReportResponse>) => void) | null = null;
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() { return parseReplaySessionResponse(replaySessionResponse()); },
      async report() {
        return new Promise<ReturnType<typeof parseReplayReportResponse>>((resolve) => { resolveReport = resolve; });
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(parseReplaySessionResponse(replaySessionResponse()).snapshot, 1);

  const staleReport = lifecycle.loadReport();
  callbacks.onGeneration?.({ generation: 2, reason: "resync", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(parseReplaySessionResponse(replaySessionResponse()).snapshot, 2);
  const completeReport = resolveReport as unknown as (
    value: ReturnType<typeof parseReplayReportResponse>,
  ) => void;
  completeReport(parseReplayReportResponse({
    protocol: "replay.v1",
    session_id: "session-0001",
    data_fidelity: "EXACT_BAR_COVERAGE",
    execution_fidelity: "BAR_CONSERVATIVE",
    revealed: false,
    report: replayReport(),
  }));

  await assert.rejects(staleReport, /stream generation changed/);
  assert.equal(lifecycle.getSnapshot().report, null);
  assert.equal(lifecycle.getSnapshot().reportError, null);
});

test("report history reveal must match the current authoritative store state", async (context) => {
  const harness = streamHarness();
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() { return parseReplaySessionResponse(replaySessionResponse()); },
      async report() {
        return parseReplayReportResponse({
          protocol: "replay.v1",
          session_id: "session-0001",
          data_fidelity: "EXACT_BAR_COVERAGE",
          execution_fidelity: "BAR_CONSERVATIVE",
          revealed: true,
          report: { ...replayReport(), ended: false },
          actual_history: {
            replay_start_ms: BASE_TIME_MS,
            replay_end_open_ms: BASE_TIME_MS + 60_000,
          },
        });
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(parseReplaySessionResponse(replaySessionResponse({ revealed: false })).snapshot, 1);

  await assert.rejects(
    () => lifecycle.loadReport(),
    /report reveal state disagrees with the authoritative replay state/,
  );
  assert.equal(lifecycle.getSnapshot().report, null);
  assert.equal(harness.resyncs, 1);
});

test("history reveal queues a fresh report behind an older in-flight artifact", async (context) => {
  const harness = streamHarness();
  const pending: Array<(value: ReturnType<typeof parseReplayReportResponse>) => void> = [];
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() { return parseReplaySessionResponse(replaySessionResponse()); },
      async report() {
        return new Promise<ReturnType<typeof parseReplayReportResponse>>((resolve) => pending.push(resolve));
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(parseReplaySessionResponse(replaySessionResponse({ revealed: false })).snapshot, 1);

  const oldReport = lifecycle.loadReport();
  const revealedStatus = replayStatusEvent({ sequence: 1 });
  revealedStatus.data.reason = "history_revealed";
  callbacks.onEvent?.(parseReplayEvent(revealedStatus), 1);
  pending[0]?.(parseReplayReportResponse({
    protocol: "replay.v1",
    session_id: "session-0001",
    data_fidelity: "EXACT_BAR_COVERAGE",
    execution_fidelity: "BAR_CONSERVATIVE",
    revealed: false,
    report: { ...replayReport(), ended: false },
  }));
  await assert.rejects(oldReport, /report reveal state disagrees/);
  await settle();
  assert.equal(pending.length, 2);

  pending[1]?.(parseReplayReportResponse({
    protocol: "replay.v1",
    session_id: "session-0001",
    data_fidelity: "EXACT_BAR_COVERAGE",
    execution_fidelity: "BAR_CONSERVATIVE",
    revealed: true,
    report: { ...replayReport(), ended: false },
    actual_history: {
      replay_start_ms: BASE_TIME_MS,
      replay_end_open_ms: BASE_TIME_MS + 60_000,
    },
  }));
  await settle();
  assert.equal(lifecycle.getSnapshot().report?.revealed, true);
  assert.ok(lifecycle.getSnapshot().report?.actual_history);
});

test("session end queues a final report behind an older active-session artifact", async (context) => {
  const harness = streamHarness();
  const pending: Array<(value: ReturnType<typeof parseReplayReportResponse>) => void> = [];
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() { return parseReplaySessionResponse(replaySessionResponse()); },
      async report() {
        return new Promise<ReturnType<typeof parseReplayReportResponse>>((resolve) => pending.push(resolve));
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(parseReplaySessionResponse(replaySessionResponse()).snapshot, 1);

  const activeReport = lifecycle.loadReport();
  callbacks.onEvent?.(parseReplayEvent(replayEndedEvent()), 1);
  assert.equal(lifecycle.getSnapshot().store.state, "ENDED");
  pending[0]?.(parseReplayReportResponse({
    protocol: "replay.v1",
    session_id: "session-0001",
    data_fidelity: "EXACT_BAR_COVERAGE",
    execution_fidelity: "BAR_CONSERVATIVE",
    revealed: false,
    report: { ...replayReport(), ended: false },
  }));
  await assert.rejects(activeReport, /report ended state disagrees/);
  await settle();
  assert.equal(pending.length, 2);
  assert.equal(harness.resyncs, 0, "a known end-event race needs a trailing report, not a stream resync");

  pending[1]?.(parseReplayReportResponse({
    protocol: "replay.v1",
    session_id: "session-0001",
    data_fidelity: "EXACT_BAR_COVERAGE",
    execution_fidelity: "BAR_CONSERVATIVE",
    revealed: false,
    report: replayReport(),
  }));
  await settle();
  assert.equal(lifecycle.getSnapshot().report?.report.ended, true);
  assert.equal(lifecycle.getSnapshot().reportError, null);
});

test("a failed fork resumes an ended-session report refresh queued behind an older request", async (context) => {
  const harness = streamHarness();
  const pendingReports: Array<(value: ReturnType<typeof parseReplayReportResponse>) => void> = [];
  let rejectFork: ((reason?: unknown) => void) | null = null;
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() { return parseReplaySessionResponse(replaySessionResponse()); },
      async report() {
        return new Promise<ReturnType<typeof parseReplayReportResponse>>((resolve) => pendingReports.push(resolve));
      },
      async forkSession() {
        return new Promise<ReturnType<typeof parseReplaySessionResponse>>((_resolve, reject) => { rejectFork = reject; });
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(parseReplaySessionResponse(replaySessionResponse()).snapshot, 1);

  const activeReport = lifecycle.loadReport();
  callbacks.onEvent?.(parseReplayEvent(replayEndedEvent()), 1);
  const fork = lifecycle.forkSession();
  pendingReports[0]?.(parseReplayReportResponse({
    protocol: "replay.v1",
    session_id: "session-0001",
    data_fidelity: "EXACT_BAR_COVERAGE",
    execution_fidelity: "BAR_CONSERVATIVE",
    revealed: false,
    report: { ...replayReport(), ended: false },
  }));
  await assert.rejects(activeReport, /report ended state disagrees/);
  await settle();
  assert.equal(pendingReports.length, 1, "the trailing report remains queued while fork is pending");

  const failFork = rejectFork as unknown as (reason?: unknown) => void;
  failFork(new ReplayApiError("CONTROLLER_CONFLICT", "fork denied", { status: 409 }));
  await assert.rejects(fork, /fork denied/);
  await settle();
  assert.equal(lifecycle.getSnapshot().forkPending, false);
  assert.equal(pendingReports.length, 2, "fork failure resumes the queued parent-session report");
  pendingReports[1]?.(parseReplayReportResponse({
    protocol: "replay.v1",
    session_id: "session-0001",
    data_fidelity: "EXACT_BAR_COVERAGE",
    execution_fidelity: "BAR_CONSERVATIVE",
    revealed: false,
    report: replayReport(),
  }));
  await settle();
  assert.equal(lifecycle.getSnapshot().report?.report.ended, true);
});

test("a fork failure does not consume a trailing refresh while the older report is still in flight", async (context) => {
  const harness = streamHarness();
  const pendingReports: Array<(value: ReturnType<typeof parseReplayReportResponse>) => void> = [];
  let rejectFork: ((reason?: unknown) => void) | null = null;
  const lifecycle = new ReplayRuntimeLifecycle({
    entry: { kind: "session", sessionId: "session-0001" },
    api: {
      async capabilities() { return parseReplayCapabilities(enabledCapabilities()); },
      async getSession() { return parseReplaySessionResponse(replaySessionResponse()); },
      async report() {
        return new Promise<ReturnType<typeof parseReplayReportResponse>>((resolve) => pendingReports.push(resolve));
      },
      async forkSession() {
        return new Promise<ReturnType<typeof parseReplaySessionResponse>>((_resolve, reject) => { rejectFork = reject; });
      },
    },
    streamFactory: (options) => harness.factory(options),
  });
  context.after(() => lifecycle.dispose());
  lifecycle.start();
  await settle();
  const callbacks = harness.options[0]!;
  callbacks.onGeneration?.({ generation: 1, reason: "initial", resetAuthoritativeState: true });
  callbacks.onSnapshot?.(parseReplaySessionResponse(replaySessionResponse()).snapshot, 1);

  const oldReport = lifecycle.loadReport();
  callbacks.onEvent?.(parseReplayEvent(replayDeltaEvent({ fills: [replayFill(BASE_TIME_MS + 119_999)] })), 1);
  const fork = lifecycle.forkSession();
  const failFork = rejectFork as unknown as (reason?: unknown) => void;
  failFork(new ReplayApiError("CONTROLLER_CONFLICT", "fork denied", { status: 409 }));
  await assert.rejects(fork, /fork denied/);
  await settle();
  assert.equal(pendingReports.length, 1, "fork failure preserves the queued edge behind the active request");

  pendingReports[0]?.(parseReplayReportResponse({
    protocol: "replay.v1",
    session_id: "session-0001",
    data_fidelity: "EXACT_BAR_COVERAGE",
    execution_fidelity: "BAR_CONSERVATIVE",
    revealed: false,
    report: { ...replayReport(), ended: false },
  }));
  await oldReport;
  await settle();
  assert.equal(pendingReports.length, 2, "the queued refresh starts only after the older report settles");
  pendingReports[1]?.(parseReplayReportResponse({
    protocol: "replay.v1",
    session_id: "session-0001",
    data_fidelity: "EXACT_BAR_COVERAGE",
    execution_fidelity: "BAR_CONSERVATIVE",
    revealed: false,
    report: { ...replayReport(), ended: false },
  }));
  await settle();
  assert.equal(lifecycle.getSnapshot().report?.report.ended, false);
});
