import assert from "node:assert/strict";
import test from "node:test";

import {
  createCacheLimitSyncCoordinator,
} from "../cacheLimitSettingsRuntime.js";
import type { CacheLimitsInput } from "../../../services/api.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface FakeTimer {
  id: number;
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeTimers() {
  const timers: FakeTimer[] = [];
  let nextId = 1;
  return {
    timers,
    schedule(callback: () => void, delayMs: number): number {
      const id = nextId;
      nextId += 1;
      timers.push({ id, callback, delayMs, cancelled: false });
      return id;
    },
    cancel(handle: unknown): void {
      const timer = timers.find((candidate) => candidate.id === handle);
      if (timer) timer.cancelled = true;
    },
    pending(): FakeTimer[] {
      return timers.filter((timer) => !timer.cancelled);
    },
    runNext(): FakeTimer {
      const timer = timers.find((candidate) => !candidate.cancelled);
      assert.ok(timer);
      timer.cancelled = true;
      timer.callback();
      return timer;
    },
  };
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function payload(ephemeralBars: number): CacheLimitsInput {
  return {
    dbLimits: { minutes: ephemeralBars, hours: 50_000, daily: 0 },
    ephemeralBars,
    sqliteBudgetBytes: null,
    storageRowLimitsEnabled: false,
  };
}

test("cache-limit sync serializes writes and sends only the newest queued settings", async () => {
  const gates: Array<Deferred<unknown>> = [];
  const sent: CacheLimitsInput[] = [];
  let active = 0;
  let maxActive = 0;
  const timers = fakeTimers();
  const coordinator = createCacheLimitSyncCoordinator({
    send: async (value) => {
      sent.push(value);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const gate = deferred<unknown>();
      gates.push(gate);
      try {
        return await gate.promise;
      } finally {
        active -= 1;
      }
    },
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  coordinator.update(payload(1_000));
  coordinator.update(payload(2_000));
  coordinator.update(payload(3_000));
  assert.deepEqual(sent.map((value) => value.ephemeralBars), [1_000]);

  gates[0]?.resolve({ status: "ok" });
  await drainMicrotasks();
  assert.deepEqual(sent.map((value) => value.ephemeralBars), [1_000, 3_000]);
  assert.equal(maxActive, 1);

  gates[1]?.resolve({ status: "ok" });
  await drainMicrotasks();
  assert.equal(timers.pending().length, 1);
  assert.equal(timers.pending()[0]?.delayMs, 5 * 60_000);
  coordinator.dispose();
});

test("cache-limit sync never retries a stale failed generation", async () => {
  const gates: Array<Deferred<unknown>> = [];
  const sent: CacheLimitsInput[] = [];
  const timers = fakeTimers();
  const coordinator = createCacheLimitSyncCoordinator({
    send: (value) => {
      sent.push(value);
      const gate = deferred<unknown>();
      gates.push(gate);
      return gate.promise;
    },
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  coordinator.update(payload(1_000));
  coordinator.update(payload(9_000));
  gates[0]?.reject(new Error("old request failed"));
  await drainMicrotasks();

  assert.deepEqual(sent.map((value) => value.ephemeralBars), [1_000, 9_000]);
  assert.equal(timers.pending().length, 0);

  gates[1]?.resolve({ status: "ok" });
  await drainMicrotasks();
  assert.equal(timers.pending()[0]?.delayMs, 5 * 60_000);
  coordinator.dispose();
});

test("cache-limit sync retains exponential retry and success heartbeat", async () => {
  const timers = fakeTimers();
  let attempts = 0;
  const coordinator = createCacheLimitSyncCoordinator({
    send: async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error("temporary failure");
      return { status: "ok" };
    },
    schedule: timers.schedule,
    cancel: timers.cancel,
    retryBaseMs: 100,
    heartbeatMs: 5_000,
  });

  coordinator.update(payload(5_000));
  await drainMicrotasks();
  assert.equal(attempts, 1);
  assert.equal(timers.pending()[0]?.delayMs, 100);

  timers.runNext();
  await drainMicrotasks();
  assert.equal(attempts, 2);
  assert.equal(timers.pending()[0]?.delayMs, 200);

  timers.runNext();
  await drainMicrotasks();
  assert.equal(attempts, 3);
  assert.equal(timers.pending()[0]?.delayMs, 5_000);

  timers.runNext();
  await drainMicrotasks();
  assert.equal(attempts, 4);
  assert.equal(timers.pending()[0]?.delayMs, 5_000);
  coordinator.dispose();
});

test("cache-limit sync disposal prevents an in-flight failure from scheduling retries", async () => {
  const timers = fakeTimers();
  const gate = deferred<unknown>();
  const coordinator = createCacheLimitSyncCoordinator({
    send: () => gate.promise,
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  coordinator.update(payload(7_000));
  coordinator.dispose();
  gate.reject(new Error("late failure after unmount"));
  await drainMicrotasks();

  assert.equal(timers.pending().length, 0);
});
