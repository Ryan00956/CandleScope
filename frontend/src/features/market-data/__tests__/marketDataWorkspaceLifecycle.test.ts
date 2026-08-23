import assert from "node:assert/strict";
import test from "node:test";

import {
  MarketDataWorkspaceEffectGuard,
  finalizeMarketDataWorkspaceResources,
  type MarketDataWorkspaceFinalizableResources,
} from "../marketDataWorkspaceLifecycle.js";

interface ResourceCounters {
  indicator: number;
  requests: number;
  scheduler: number;
  stream: number;
}

function resourceHarness(): {
  counters: ResourceCounters;
  resources: MarketDataWorkspaceFinalizableResources;
} {
  const counters = {
    indicator: 0,
    requests: 0,
    scheduler: 0,
    stream: 0,
  };
  return {
    counters,
    resources: {
      indicatorStreamCoordinator: {
        closeAll: () => { counters.indicator += 1; },
      },
      requestCoordinator: {
        closeAll: () => { counters.requests += 1; },
      },
      streamCoordinator: {
        closeAll: () => { counters.stream += 1; },
      },
      workScheduler: {
        dispose: () => { counters.scheduler += 1; },
      },
    },
  };
}

function deferredMicrotasks(): {
  enqueue(callback: () => void): void;
  flush(): void;
} {
  const callbacks: Array<() => void> = [];
  return {
    enqueue: (callback) => { callbacks.push(callback); },
    flush: () => {
      callbacks.splice(0).forEach((callback) => callback());
    },
  };
}

test("StrictMode effect replay preserves the reused workspace resources", () => {
  const microtasks = deferredMicrotasks();
  const { counters, resources } = resourceHarness();
  const guard = new MarketDataWorkspaceEffectGuard(microtasks.enqueue);

  const rehearsalCleanup = guard.mount(resources);
  rehearsalCleanup();
  const finalCleanup = guard.mount(resources);
  microtasks.flush();

  assert.deepEqual(counters, {
    indicator: 0,
    requests: 0,
    scheduler: 0,
    stream: 0,
  });

  finalCleanup();
  microtasks.flush();
  assert.deepEqual(counters, {
    indicator: 1,
    requests: 1,
    scheduler: 1,
    stream: 1,
  });
});

test("resource replacement still finalizes the obsolete workspace generation", () => {
  const microtasks = deferredMicrotasks();
  const first = resourceHarness();
  const second = resourceHarness();
  const guard = new MarketDataWorkspaceEffectGuard(microtasks.enqueue);

  guard.mount(first.resources)();
  const secondCleanup = guard.mount(second.resources);
  microtasks.flush();

  assert.deepEqual(first.counters, {
    indicator: 1,
    requests: 1,
    scheduler: 1,
    stream: 1,
  });
  assert.deepEqual(second.counters, {
    indicator: 0,
    requests: 0,
    scheduler: 0,
    stream: 0,
  });

  secondCleanup();
  microtasks.flush();
  assert.deepEqual(second.counters, {
    indicator: 1,
    requests: 1,
    scheduler: 1,
    stream: 1,
  });
});

test("duplicate cleanup and stale microtasks cannot finalize resources twice", () => {
  const microtasks = deferredMicrotasks();
  const { counters, resources } = resourceHarness();
  const guard = new MarketDataWorkspaceEffectGuard(microtasks.enqueue);

  const firstCleanup = guard.mount(resources);
  firstCleanup();
  firstCleanup();
  const secondCleanup = guard.mount(resources);
  secondCleanup();
  microtasks.flush();

  assert.deepEqual(counters, {
    indicator: 1,
    requests: 1,
    scheduler: 1,
    stream: 1,
  });
});

test("finalization tolerates disabled optional brokers", () => {
  let streamClosures = 0;
  finalizeMarketDataWorkspaceResources({
    indicatorStreamCoordinator: null,
    requestCoordinator: null,
    streamCoordinator: { closeAll: () => { streamClosures += 1; } },
    workScheduler: null,
  });
  assert.equal(streamClosures, 1);
});

test("the default scheduler finalizes on the next microtask", async () => {
  const { counters, resources } = resourceHarness();
  const guard = new MarketDataWorkspaceEffectGuard();

  guard.mount(resources)();
  assert.equal(counters.scheduler, 0);

  await new Promise<void>((resolve) => { globalThis.queueMicrotask(resolve); });
  assert.deepEqual(counters, {
    indicator: 1,
    requests: 1,
    scheduler: 1,
    stream: 1,
  });
});
