import assert from "node:assert/strict";
import test from "node:test";

import { ForegroundPreloadGate } from "../foregroundPreloadGate.js";

function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    schedule(callback: () => void, delayMs: number): number {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + Math.max(0, delayMs), callback });
      return id;
    },
    cancel(handle: unknown): void {
      timers.delete(Number(handle));
    },
    advance(delayMs: number): void {
      const target = now + delayMs;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = target;
    },
  };
}

test("nested foreground and busy owners synchronously preempt preload and require a quiet dwell", () => {
  const clock = createClock();
  const gate = new ForegroundPreloadGate({
    quietDwellMs: 1_000,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  const preload = gate.tryAcquirePreload("chart-prefetch");
  assert.ok(preload);

  const request = gate.enterForeground("initial-history");
  const busy = gate.acquireBusy("chart-runtime:session-a");
  assert.equal(preload.controller.signal.aborted, true);
  assert.equal(gate.snapshot().activeForeground, 2);
  assert.equal(gate.tryAcquirePreload("watchlist"), null);

  request.release();
  clock.advance(5_000);
  assert.equal(gate.snapshot().activeForeground, 1);
  assert.equal(gate.tryAcquirePreload("watchlist"), null);

  busy.release();
  assert.equal(gate.snapshot().waitMs, 1_000);
  clock.advance(999);
  assert.equal(gate.tryAcquirePreload("watchlist"), null);
  clock.advance(1);
  const resumed = gate.tryAcquirePreload("watchlist");
  assert.ok(resumed);

  request.release();
  gate.release(preload);
  assert.equal(gate.isCurrent(resumed), true, "stale releases cannot steal the resumed lease");
  gate.release(resumed);
  gate.dispose();
});

test("quiet-dwell notification resumes one globally serialized speculative owner", () => {
  const clock = createClock();
  const gate = new ForegroundPreloadGate({
    quietDwellMs: 100,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  let notifications = 0;
  gate.yieldToForeground();
  const unsubscribe = gate.subscribe(() => { notifications += 1; });

  assert.equal(gate.tryAcquirePreload("first"), null);
  clock.advance(100);
  assert.equal(notifications, 1);

  const first = gate.tryAcquirePreload("first");
  assert.ok(first);
  assert.equal(gate.tryAcquirePreload("second"), null);
  gate.release(first);
  assert.equal(notifications, 2);
  const second = gate.tryAcquirePreload("second");
  assert.ok(second);

  unsubscribe();
  gate.release(second);
  gate.dispose();
});
