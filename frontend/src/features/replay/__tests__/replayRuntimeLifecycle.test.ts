import assert from "node:assert/strict";
import test from "node:test";

import { ReplayApiError } from "../replayApi.js";
import {
  parseReplayCapabilities,
  parseReplayCommandResult,
  parseReplayEvent,
  parseReplayReportResponse,
  parseReplaySessionResponse,
} from "../replayParser.js";
import type { ReplayStreamControllerOptions } from "../replayStreamController.js";
import { ReplayLifecycleEffectGuard, ReplayRuntimeLifecycle } from "../useReplayRuntime.js";
import {
  BASE_TIME_MS,
  disabledCapabilities,
  enabledCapabilities,
  replayDeltaEvent,
  replayFill,
  replayReport,
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

test("commands are pending without optimistic bars and use server revision acknowledgements", async (context) => {
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
    state_hash: `sha256:${"8".repeat(64)}`,
    cursor: {
      virtual_time_ms: 1_700_000_059_999,
      source_sequence: 1,
      last_base_bar_open_ms: 1_700_000_000_000,
      last_trade_time_ms: null,
      last_agg_trade_id: null,
      at_end: false,
    },
    data: { consumed: 1 },
  }));
  await submitted;
  assert.equal(lifecycle.getSnapshot().pendingCommand, null);
  assert.equal(lifecycle.getSnapshot().commandTimeline.at(-1)?.status, "acknowledged");
  assert.equal(lifecycle.store.seriesStore.barCount, barsBefore, "HTTP ack cannot advance chart truth");
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
