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

test("active-chart hydration bypasses dwell and preempts an ordinary speculative owner", () => {
  const clock = createClock();
  const gate = new ForegroundPreloadGate({
    quietDwellMs: 1_000,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  const watchlist = gate.tryAcquirePreload("watchlist");
  assert.ok(watchlist);
  let reentrantPreload: ReturnType<typeof gate.tryAcquirePreload> = null;
  let reentrantHydration: ReturnType<typeof gate.tryAcquireHydration> = null;
  watchlist.controller.signal.addEventListener("abort", () => {
    reentrantPreload = gate.tryAcquirePreload("reentrant-watchlist");
    reentrantHydration = gate.tryAcquireHydration("reentrant-hydration");
  }, { once: true });

  gate.requireQuietDwell();
  const hydration = gate.tryAcquireHydration("active-chart-history");
  assert.ok(hydration);
  assert.equal(watchlist.controller.signal.aborted, true);
  assert.equal(reentrantPreload, null, "abort listeners cannot steal the reserved hydration slot");
  assert.equal(reentrantHydration, null, "abort listeners cannot replace the reserved hydration slot");
  assert.equal(gate.isCurrent(watchlist), false);
  assert.equal(gate.isCurrent(hydration), true);
  assert.equal(gate.tryAcquirePreload("chart-background-prefetch"), null);
  assert.equal(gate.tryAcquireHydration("duplicate-hydration"), null);
  assert.deepEqual(gate.snapshot().queuedHydrationOwners, ["duplicate-hydration"]);
  gate.cancelQueued("duplicate-hydration");
  gate.cancelQueued("chart-background-prefetch");

  clock.advance(100);
  const hydrationGeneration = hydration.generation;
  gate.requireQuietDwell();
  assert.equal(hydration.controller.signal.aborted, false);
  assert.equal(gate.isCurrent(hydration), true);
  assert.equal(hydration.generation, hydrationGeneration);

  gate.release(watchlist);
  assert.equal(gate.isCurrent(hydration), true, "stale ordinary release cannot steal hydration");
  gate.release(hydration);
  assert.equal(gate.tryAcquirePreload("watchlist-resume"), null);
  clock.advance(999);
  assert.equal(gate.tryAcquirePreload("watchlist-resume"), null);
  clock.advance(1);
  assert.ok(gate.tryAcquirePreload("watchlist-resume"));
  gate.dispose();
});

test("same-lane speculative owners advance in FIFO order and cancelled owners cannot starve followers", () => {
  const gate = new ForegroundPreloadGate({ quietDwellMs: 0 });
  const first = gate.tryAcquireHydration("cell-1");
  assert.ok(first);
  assert.equal(gate.tryAcquireHydration("cell-2"), null);
  assert.equal(gate.tryAcquireHydration("cell-3"), null);
  assert.deepEqual(gate.snapshot().queuedHydrationOwners, ["cell-2", "cell-3"]);

  gate.release(first);
  assert.equal(gate.tryAcquireHydration("cell-3"), null, "a later poller cannot jump the queue");
  const second = gate.tryAcquireHydration("cell-2");
  assert.ok(second);
  gate.release(second);
  gate.cancelQueued("cell-3");

  const preload = gate.tryAcquirePreload("watchlist");
  assert.ok(preload);
  gate.release(preload);
  gate.dispose();
});

test("foreground aborts hydration and hydration cannot reacquire until foreground releases", () => {
  const clock = createClock();
  const gate = new ForegroundPreloadGate({
    quietDwellMs: 1_000,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  const hydration = gate.tryAcquireHydration("active-chart-history");
  assert.ok(hydration);

  const foreground = gate.enterForeground("interval-switch");
  assert.equal(hydration.controller.signal.aborted, true);
  assert.equal(gate.tryAcquireHydration("stale-chart-history"), null);
  assert.equal(gate.tryAcquirePreload("watchlist"), null);

  foreground.release();
  const nextHydration = gate.tryAcquireHydration("current-chart-history");
  assert.ok(nextHydration, "hydration bypasses the post-foreground quiet dwell");
  assert.equal(gate.tryAcquirePreload("watchlist"), null);
  gate.release(nextHydration);
  gate.dispose();
});
