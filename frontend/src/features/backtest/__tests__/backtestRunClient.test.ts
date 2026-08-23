import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKTEST_TERMINAL_STATES,
  isBacktestTerminalState,
  pollBacktestRunToTerminal,
  waitForBacktestPoll,
} from "../backtestRunClient.js";
import type { BacktestRunRecord } from "../backtestTypes.js";

function run(state: string): BacktestRunRecord {
  return {
    run_id: "bt_1",
    state,
    fidelity_mode: "BAR_APPROX",
    source_event_kind: "BAR",
    config_hash: "sha256:config",
  };
}

test("Run terminal state contract is shared and fail-closed for active states", () => {
  assert.deepEqual(BACKTEST_TERMINAL_STATES, ["COMPLETED", "FAILED", "CANCELLED"]);
  assert.equal(isBacktestTerminalState("COMPLETED"), true);
  assert.equal(isBacktestTerminalState("FAILED"), true);
  assert.equal(isBacktestTerminalState("CANCELLED"), true);
  assert.equal(isBacktestTerminalState("QUEUED"), false);
  assert.equal(isBacktestTerminalState("RUNNING"), false);
  assert.equal(isBacktestTerminalState("UNKNOWN"), false);
});

test("Run polling emits every state and stops immediately at terminal", async () => {
  const pending = [run("QUEUED"), run("RUNNING"), run("COMPLETED")];
  const observed: string[] = [];
  const waits: number[] = [];
  const result = await pollBacktestRunToTerminal({
    api: { async getRun() { return pending.shift()!; } },
    runId: "bt_1",
    intervalMs: 25,
    wait: async (delay) => { waits.push(delay); },
    onUpdate: (item) => observed.push(item.state),
  });
  assert.equal(result.state, "COMPLETED");
  assert.deepEqual(observed, ["QUEUED", "RUNNING", "COMPLETED"]);
  assert.deepEqual(waits, [25, 25]);
});

test("failed and cancelled Runs are terminal without another wait", async () => {
  for (const state of ["FAILED", "CANCELLED"]) {
    let waits = 0;
    const result = await pollBacktestRunToTerminal({
      api: { async getRun() { return run(state); } },
      runId: "bt_1",
      wait: async () => { waits += 1; },
    });
    assert.equal(result.state, state);
    assert.equal(waits, 0);
  }
});

test("Run polling aborts before a request and cancels an in-flight delay", async () => {
  const before = new AbortController();
  before.abort(new Error("stop-before"));
  let requests = 0;
  await assert.rejects(pollBacktestRunToTerminal({
    api: { async getRun() { requests += 1; return run("RUNNING"); } },
    runId: "bt_1",
    signal: before.signal,
  }), /stop-before/);
  assert.equal(requests, 0);

  const during = new AbortController();
  const waiting = waitForBacktestPoll(60_000, during.signal);
  during.abort(new Error("stop-during"));
  await assert.rejects(waiting, /stop-during/);
});
