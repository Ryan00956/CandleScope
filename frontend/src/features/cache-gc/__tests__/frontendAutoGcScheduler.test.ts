import assert from "node:assert/strict";
import test from "node:test";

import {
  createFrontendAutoGcScheduler,
  resolveFrontendAutoGcSchedule,
  snapshotFrontendAutoGcScheduler,
} from "../frontendAutoGcScheduler.js";

test("frontend auto GC schedule honors policy enabled and cooldown", () => {
  assert.deepEqual(resolveFrontendAutoGcSchedule({ enabled: false, cooldownMs: 1_234 }), {
    enabled: false,
    cooldownMs: 1_234,
  });

  let scheduledMs = 0;
  const scheduler = createFrontendAutoGcScheduler({
    enabled: false,
    cooldownMs: 1_234,
    collectDiagnostics: async () => ({}),
    runGc: () => undefined,
    setIntervalFn: (_callback, cooldownMs) => {
      scheduledMs = cooldownMs;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
  });
  scheduler.start();

  assert.equal(scheduledMs, 0);
  assert.equal(scheduler.snapshot().scheduled, false);

  const enabledScheduler = createFrontendAutoGcScheduler({
    enabled: true,
    cooldownMs: 1_234,
    collectDiagnostics: async () => ({}),
    runGc: () => undefined,
    setIntervalFn: (_callback, cooldownMs) => {
      scheduledMs = cooldownMs;
      return 2 as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalFn: () => undefined,
  });
  enabledScheduler.start();
  assert.equal(scheduledMs, 1_234);
  assert.equal(enabledScheduler.snapshot().scheduled, true);
  enabledScheduler.stop();
});

test("frontend auto GC scheduler exposes errors without terminating", async () => {
  let nowMs = 100;
  let observedError = "";
  let attempts = 0;
  const scheduler = createFrontendAutoGcScheduler({
    enabled: true,
    cooldownMs: 1_000,
    nowMs: () => ++nowMs,
    collectDiagnostics: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("heap probe failed");
      return { ok: true };
    },
    runGc: () => undefined,
    onError: (error) => {
      observedError = error instanceof Error ? error.message : String(error);
    },
  });

  await scheduler.tick();
  assert.equal(observedError, "heap probe failed");
  assert.equal(scheduler.snapshot().consecutiveErrors, 1);
  assert.equal(scheduler.snapshot().lastError, "heap probe failed");

  await scheduler.tick();
  assert.equal(attempts, 2);
  assert.equal(scheduler.snapshot().consecutiveErrors, 0);
  assert.equal(scheduler.snapshot().lastError, null);
  assert.equal(snapshotFrontendAutoGcScheduler().lastSuccessAtMs, scheduler.snapshot().lastSuccessAtMs);
});

test("frontend auto GC scheduler prevents overlap and suppresses stale completion", async () => {
  let releaseDiagnostics!: (value: unknown) => void;
  let runs = 0;
  let stateNotifications = 0;
  const scheduler = createFrontendAutoGcScheduler({
    enabled: true,
    cooldownMs: 1_000,
    collectDiagnostics: () => new Promise((resolve) => {
      releaseDiagnostics = resolve;
    }),
    runGc: () => {
      runs += 1;
    },
    onStateChange: () => {
      stateNotifications += 1;
    },
  });

  const firstTick = scheduler.tick();
  await Promise.resolve();
  await scheduler.tick();
  assert.equal(scheduler.snapshot().skippedTicks, 1);

  scheduler.stop();
  const notificationsAfterStop = stateNotifications;
  assert.equal(typeof releaseDiagnostics, "function");
  releaseDiagnostics({ ok: true });
  await firstTick;

  assert.equal(runs, 0);
  assert.equal(scheduler.snapshot().stopped, true);
  assert.equal(scheduler.snapshot().running, false);
  assert.equal(stateNotifications, notificationsAfterStop);
});
