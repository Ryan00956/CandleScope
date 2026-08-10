import assert from "node:assert/strict";
import test from "node:test";

import {
  createReplayOrderAdvisoryScheduler,
  type ReplayOrderAdvisoryTimers,
} from "../replayOrderAdvisoryScheduler.js";

test("order advisory scheduling collapses high-rate cursor churn to the latest request", () => {
  let nextHandle = 0;
  const callbacks = new Map<number, () => void>();
  const timers: ReplayOrderAdvisoryTimers = {
    setTimeout(callback) {
      nextHandle += 1;
      callbacks.set(nextHandle, callback);
      return nextHandle;
    },
    clearTimeout(handle) {
      callbacks.delete(Number(handle));
    },
  };
  const scheduler = createReplayOrderAdvisoryScheduler({ delayMs: 180, timers });
  const started: number[] = [];

  for (let revision = 1; revision <= 1_000; revision += 1) {
    scheduler.schedule(() => started.push(revision));
  }

  assert.equal(callbacks.size, 1);
  assert.equal(scheduler.pending(), true);
  [...callbacks.values()][0]?.();
  assert.deepEqual(started, [1_000]);
  assert.equal(scheduler.pending(), false);
});

test("cancel prevents a stale advisory request from starting", () => {
  let callback: (() => void) | null = null;
  const scheduler = createReplayOrderAdvisoryScheduler({
    timers: {
      setTimeout(next) {
        callback = next;
        return 1;
      },
      clearTimeout() {
        callback = null;
      },
    },
  });
  let started = false;
  scheduler.schedule(() => {
    started = true;
  });
  scheduler.cancel();
  callback?.();

  assert.equal(started, false);
  assert.equal(scheduler.pending(), false);
});
