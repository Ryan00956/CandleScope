import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIndicatorHydrationKey,
  createIndicatorHydrationScheduler,
  hydrateIndicatorDefinitionsFromCache,
  type IndicatorHydrationTaskScheduler,
} from "../indicatorHydrationRuntime.js";
import type { IndicatorCacheResult } from "../indicatorTypes.js";
import { structuralMock } from "../../../test/testHelpers.js";

function controlledScheduler() {
  let nextHandle = 1;
  const callbacks = new Map<number, () => void>();
  const cancelled: number[] = [];
  const scheduler: IndicatorHydrationTaskScheduler = {
    request(callback) {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      cancelled.push(handle);
      callbacks.delete(handle);
    },
  };
  return {
    cancelled,
    pendingCount: () => callbacks.size,
    scheduler,
    take(handle: number) {
      const callback = callbacks.get(handle);
      callbacks.delete(handle);
      return callback;
    },
    flush() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
  };
}

function identity(overrides: Partial<{
  contentSignature: string;
  contentVersion: number;
  lifecycleKey: string;
}> = {}) {
  return {
    contentSignature: overrides.contentSignature ?? "cache-a",
    contentVersion: overrides.contentVersion ?? 1,
    lifecycleKey: overrides.lifecycleKey ?? "BTCUSDT|1m|generation-1",
  };
}

test("hydration runs asynchronously and checks external currency immediately before run", () => {
  const tasks = controlledScheduler();
  const events: string[] = [];
  const runtime = createIndicatorHydrationScheduler({ scheduler: tasks.scheduler });
  const hydration = identity();

  const result = runtime.schedule({
    ...hydration,
    isCurrent(candidate) {
      events.push(`check:${candidate.contentVersion}`);
      return true;
    },
    run(candidate) {
      events.push(`run:${candidate.contentVersion}`);
    },
  });

  assert.equal(result.status, "scheduled");
  assert.deepEqual(events, []);
  assert.equal(tasks.pendingCount(), 1);
  tasks.flush();
  assert.deepEqual(events, ["check:1", "run:1"]);
});

test("the same pending identity is deduplicated and keeps the latest closure", () => {
  const tasks = controlledScheduler();
  const runs: string[] = [];
  const runtime = createIndicatorHydrationScheduler({ scheduler: tasks.scheduler });
  const hydration = identity();

  assert.equal(runtime.schedule({
    ...hydration,
    run: () => runs.push("old"),
  }).status, "scheduled");
  assert.equal(runtime.schedule({
    ...hydration,
    run: () => runs.push("latest"),
  }).status, "deduplicated");

  assert.equal(tasks.pendingCount(), 1);
  assert.deepEqual(tasks.cancelled, []);
  tasks.flush();
  assert.deepEqual(runs, ["latest"]);
});

test("new content signatures and versions supersede pending hydration", () => {
  const tasks = controlledScheduler();
  const runs: string[] = [];
  const runtime = createIndicatorHydrationScheduler({ scheduler: tasks.scheduler });

  runtime.schedule({ ...identity(), run: () => runs.push("old-signature") });
  runtime.schedule({
    ...identity({ contentSignature: "cache-b" }),
    run: () => runs.push("old-version"),
  });
  runtime.schedule({
    ...identity({ contentSignature: "cache-b", contentVersion: 2 }),
    run: () => runs.push("current"),
  });

  assert.deepEqual(tasks.cancelled, [1, 2]);
  assert.equal(tasks.pendingCount(), 1);
  tasks.flush();
  assert.deepEqual(runs, ["current"]);
});

test("activating a new lifecycle cancels old work even without a replacement", () => {
  const tasks = controlledScheduler();
  let runs = 0;
  const runtime = createIndicatorHydrationScheduler({ scheduler: tasks.scheduler });
  runtime.schedule({ ...identity(), run: () => { runs += 1; } });

  runtime.activate("ETHUSDT|5m|generation-2");

  assert.equal(tasks.pendingCount(), 0);
  assert.deepEqual(tasks.cancelled, [1]);
  tasks.flush();
  assert.equal(runs, 0);
});

test("a cancelled callback that already escaped the primitive remains fenced", () => {
  const tasks = controlledScheduler();
  const runs: string[] = [];
  const runtime = createIndicatorHydrationScheduler({ scheduler: tasks.scheduler });
  runtime.schedule({ ...identity(), run: () => runs.push("stale") });
  const escaped = tasks.take(1);

  runtime.schedule({
    ...identity({ lifecycleKey: "ETHUSDT|5m|generation-2" }),
    run: () => runs.push("current"),
  });
  escaped?.();
  tasks.flush();

  assert.deepEqual(runs, ["current"]);
});

test("an external current check can reject otherwise current work", () => {
  const tasks = controlledScheduler();
  let checked = 0;
  let runs = 0;
  const runtime = createIndicatorHydrationScheduler({ scheduler: tasks.scheduler });
  runtime.schedule({
    ...identity(),
    isCurrent: () => {
      checked += 1;
      return false;
    },
    run: () => { runs += 1; },
  });

  tasks.flush();
  assert.equal(checked, 1);
  assert.equal(runs, 0);
});

test("explicit cancellation invalidates the pending content identity", () => {
  const tasks = controlledScheduler();
  let runs = 0;
  const runtime = createIndicatorHydrationScheduler({ scheduler: tasks.scheduler });
  const hydration = identity();
  runtime.schedule({ ...hydration, run: () => { runs += 1; } });

  runtime.cancel();

  assert.equal(runtime.isCurrent(hydration), false);
  assert.equal(runtime.snapshot().pending, false);
  assert.deepEqual(tasks.cancelled, [1]);
  tasks.flush();
  assert.equal(runs, 0);
});

test("dispose cancels pending work and permanently rejects callbacks and schedules", () => {
  const tasks = controlledScheduler();
  let runs = 0;
  const runtime = createIndicatorHydrationScheduler({ scheduler: tasks.scheduler });
  const hydration = identity();
  runtime.schedule({ ...hydration, run: () => { runs += 1; } });
  const escaped = tasks.take(1);

  runtime.dispose();
  escaped?.();
  const result = runtime.schedule({ ...hydration, run: () => { runs += 1; } });
  tasks.flush();

  assert.equal(result.status, "disposed");
  assert.equal(tasks.pendingCount(), 0);
  assert.equal(runs, 0);
  assert.equal(runtime.snapshot().disposed, true);
});

test("hydration keys distinguish lifecycle, content signature, type, and version", () => {
  const base = identity();
  const key = buildIndicatorHydrationKey(base);
  assert.notEqual(key, buildIndicatorHydrationKey({ ...base, lifecycleKey: "other" }));
  assert.notEqual(key, buildIndicatorHydrationKey({ ...base, contentSignature: "other" }));
  assert.notEqual(key, buildIndicatorHydrationKey({ ...base, contentVersion: 2 }));
  assert.notEqual(key, buildIndicatorHydrationKey({ ...base, contentVersion: "1" }));
});

test("warm cache lines publish synchronously by stable reference", () => {
  const cachedLines = [{
    outputName: "ma",
    data: [{ time: 10, value: 100 }],
  }];
  const schema = [{ key: "period", type: "number" }];
  const entries = [structuralMock<IndicatorCacheResult>({
    indicatorId: "ma",
    contentVersion: 1,
    normalized: {
      lines: cachedLines,
      markers: [],
      fills: [],
      hlines: [],
      bgcolors: [],
      barcolors: [],
      signals: [],
    },
    schema,
  })];
  const hydrated = hydrateIndicatorDefinitionsFromCache([{
    id: "ma",
    lines: [{ data: [{ time: 5, value: 50 }] }],
    error: "old",
  }], entries);

  assert.strictEqual(hydrated[0]?.lines, cachedLines);
  assert.strictEqual(hydrated[0]?.paramSchema, schema);
  assert.equal(hydrated[0]?.error, null);
  assert.strictEqual(hydrateIndicatorDefinitionsFromCache(hydrated, entries), hydrated);
});

test("cache miss clears previous context lines while deferred misses preserve current work", () => {
  const previous = [{
    id: "ma",
    lines: [{
      outputName: "ma",
      data: [{ time: 10, value: 100 }],
      colorData: [{ time: 10, color: "#fff" }],
    }],
    error: "old",
  }];
  const cleared = hydrateIndicatorDefinitionsFromCache(previous, []);

  assert.notStrictEqual(cleared, previous);
  assert.deepEqual(cleared[0]?.lines?.[0]?.data, []);
  assert.deepEqual(cleared[0]?.lines?.[0]?.colorData, []);
  assert.equal(cleared[0]?.error, null);
  assert.strictEqual(hydrateIndicatorDefinitionsFromCache(
    previous,
    [],
    { clearMissing: false },
  ), previous);
});

test("cache miss preserves an explicit-local terminal error while clearing stale lines", () => {
  const previous = [{
    id: "local-ma",
    executionTarget: "local" as const,
    lines: [{
      outputName: "ma",
      data: [{ time: 10, value: 100 }],
    }],
    error: "INDICATOR_COMPUTE_FAILED",
  }];

  const hydrated = hydrateIndicatorDefinitionsFromCache(previous, []);

  assert.notStrictEqual(hydrated, previous);
  assert.deepEqual(hydrated[0]?.lines?.[0]?.data, []);
  assert.equal(hydrated[0]?.error, "INDICATOR_COMPUTE_FAILED");
  assert.strictEqual(hydrateIndicatorDefinitionsFromCache(hydrated, []), hydrated);
});
