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
  const scheduler = createReplayOrderAdvisoryScheduler({ delayMs: 500, timers });
  const started: number[] = [];

  for (let revision = 1; revision <= 1_000; revision += 1) {
    scheduler.schedule(`revision-${revision}`, () => started.push(revision));
  }

  assert.equal(callbacks.size, 1);
  assert.equal(scheduler.pending(), true);
  [...callbacks.values()][0]?.();
  assert.deepEqual(started, [1_000]);
  assert.equal(scheduler.pending(), false);
});

test("cancel prevents a stale advisory request from starting", () => {
  const callbacks = new Map<number, () => void>();
  const scheduler = createReplayOrderAdvisoryScheduler({
    timers: {
      setTimeout(next) {
        callbacks.set(1, next);
        return 1;
      },
      clearTimeout() {
        callbacks.delete(1);
      },
    },
  });
  let started = false;
  scheduler.schedule("revision-1", () => {
    started = true;
  });
  const staleCallback = callbacks.get(1);
  scheduler.cancel();
  staleCallback?.();

  assert.equal(started, false);
  assert.equal(scheduler.pending(), false);
});

test("a settled advisory key is deduplicated until an aborted request is forgotten", () => {
  const callbacks = new Map<number, () => void>();
  let nextHandle = 0;
  const scheduler = createReplayOrderAdvisoryScheduler({
    timers: {
      setTimeout(callback) {
        nextHandle += 1;
        callbacks.set(nextHandle, callback);
        return nextHandle;
      },
      clearTimeout(handle) {
        callbacks.delete(Number(handle));
      },
    },
  });
  let starts = 0;
  assert.equal(scheduler.schedule("same-cursor", () => { starts += 1; }), true);
  callbacks.get(1)?.();
  assert.equal(starts, 1);
  assert.equal(scheduler.schedule("same-cursor", () => { starts += 1; }), false);
  assert.equal(callbacks.size, 1);

  scheduler.forget("same-cursor");
  assert.equal(scheduler.schedule("same-cursor", () => { starts += 1; }), true);
  callbacks.get(2)?.();
  assert.equal(starts, 2);
});
