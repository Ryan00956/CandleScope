import assert from "node:assert/strict";
import test from "node:test";
import {
  createDrawingExportBarrier,
  DrawingExportBarrierError,
} from "../drawingExportBarrier.js";
import type {
  DrawingExportBarrierDependencies,
  DrawingExportRestoreContext,
} from "../drawingExportBarrier.js";

interface HarnessOptions {
  readonly failAt?: string;
  readonly sceneGate?: Promise<never>;
  readonly frameGate?: Promise<never>;
}

interface Harness {
  readonly order: string[];
  readonly restores: Array<DrawingExportRestoreContext<string, string, string, string>>;
  readonly dependencies: DrawingExportBarrierDependencies<string, string, string, string>;
}

function failure(stage: string): Error {
  return new Error(`failed:${stage}`);
}

function createHarness(options: HarnessOptions = {}): Harness {
  const order: string[] = [];
  const restores: Array<DrawingExportRestoreContext<string, string, string, string>> = [];
  const step = <T>(stage: string, value: T): T => {
    order.push(stage);
    if (options.failAt === stage) throw failure(stage);
    return value;
  };
  return {
    order,
    restores,
    dependencies: {
      terminalizeInteraction: () => step("terminalize", {
        scopeKey: "spot:BTCUSDT__main",
        documentRevision: 42,
      }),
      flushTargetDocument: ({ target }) => step("flush", {
        ...target,
        persistence: "idb:42",
      }),
      applyAndClearPresentation: () => step("presentation", "overlay-cleared"),
      awaitExactScene: async ({ target }) => {
        order.push("scene");
        if (options.failAt === "scene") throw failure("scene");
        if (options.sceneGate) await options.sceneGate;
        return { ...target, scene: "scene:42" };
      },
      waitForNextFrame: async () => {
        order.push("frame");
        if (options.failAt === "frame") throw failure("frame");
        if (options.frameGate) await options.frameGate;
        return "paint:next-frame";
      },
      revalidate: () => step("revalidate", options.failAt !== "stale"),
      restorePresentation: (context) => {
        order.push(`restore:${context.reason}`);
        restores.push(context);
        if (options.failAt === "restore") throw failure("restore");
      },
    },
  };
}

function assertBarrierError(error: unknown, code: string): boolean {
  assert.ok(error instanceof DrawingExportBarrierError);
  assert.equal(error.code, code);
  return true;
}

test("export barrier runs the strict sequence and returns a complete idempotent lease", async () => {
  const harness = createHarness();
  const barrier = createDrawingExportBarrier(harness.dependencies);

  const lease = await barrier.prepare();
  assert.deepEqual(harness.order, [
    "terminalize",
    "flush",
    "scene",
    "presentation",
    "frame",
    "revalidate",
  ]);
  assert.deepEqual(lease.receipt, {
    leaseId: 1,
    scopeKey: "spot:BTCUSDT__main",
    documentRevision: 42,
    persistence: "idb:42",
    scene: "scene:42",
    paint: "paint:next-frame",
  });
  assert.deepEqual(barrier.snapshot(), { locked: true, leaseId: 1 });
  assert.equal(await lease.revalidate(), true);

  const firstRestore = lease.restore();
  const secondRestore = lease.restore();
  assert.strictEqual(firstRestore, secondRestore);
  await firstRestore;
  assert.equal(await lease.revalidate(), false);
  assert.deepEqual(harness.order.at(-1), "restore:lease");
  assert.equal(harness.restores.length, 1);
  assert.equal(harness.restores[0]?.presentationApplied, true);
  assert.deepEqual(barrier.snapshot(), { locked: false, leaseId: null });
});

test("the active preparation and returned lease both reject concurrent capture", async () => {
  const pending = new Promise<never>(() => {});
  const preparingHarness = createHarness({ sceneGate: pending });
  const preparingBarrier = createDrawingExportBarrier(preparingHarness.dependencies, {
    defaultTimeoutMs: 1_000,
  });
  const controller = new AbortController();
  const preparing = preparingBarrier.prepare({ signal: controller.signal });
  await assert.rejects(
    preparingBarrier.prepare(),
    (error: unknown) => assertBarrierError(error, "busy"),
  );
  assert.equal(preparingHarness.restores.length, 0, "a rejected contender must not restore the owner");
  controller.abort("test complete");
  await assert.rejects(preparing, (error: unknown) => assertBarrierError(error, "aborted"));
  assert.equal(preparingHarness.restores.length, 1);

  const leasedHarness = createHarness();
  const leasedBarrier = createDrawingExportBarrier(leasedHarness.dependencies);
  const lease = await leasedBarrier.prepare();
  await assert.rejects(
    leasedBarrier.prepare(),
    (error: unknown) => assertBarrierError(error, "busy"),
  );
  assert.equal(leasedHarness.restores.length, 0);
  await lease.restore();
});

for (const failedStage of [
  "terminalize",
  "flush",
  "presentation",
  "scene",
  "frame",
  "stale",
]) {
  test(`failure at ${failedStage} restores and releases the owned barrier`, async () => {
    const harness = createHarness({ failAt: failedStage });
    const barrier = createDrawingExportBarrier(harness.dependencies);
    await assert.rejects(barrier.prepare());
    assert.equal(harness.restores.length, 1);
    assert.equal(harness.restores[0]?.reason, "failure");
    assert.equal(
      harness.restores[0]?.presentationApplied,
      ["frame", "stale"].includes(failedStage),
    );
    assert.deepEqual(barrier.snapshot(), { locked: false, leaseId: null });

    const recovery = createHarness();
    const recoveredBarrier = createDrawingExportBarrier(recovery.dependencies);
    const lease = await recoveredBarrier.prepare();
    await lease.restore();
  });
}

test("mismatched persistence and exact-scene identities fail closed", async () => {
  const persistenceHarness = createHarness();
  persistenceHarness.dependencies.flushTargetDocument = ({ target }) => ({
    ...target,
    documentRevision: target.documentRevision + 1,
    persistence: "wrong",
  });
  const persistenceBarrier = createDrawingExportBarrier(persistenceHarness.dependencies);
  await assert.rejects(
    persistenceBarrier.prepare(),
    (error: unknown) => assertBarrierError(error, "invalid-receipt"),
  );
  assert.equal(persistenceHarness.restores.length, 1);

  const sceneHarness = createHarness();
  sceneHarness.dependencies.awaitExactScene = ({ target }) => ({
    ...target,
    scopeKey: "stale-scope",
    scene: "wrong",
  });
  const sceneBarrier = createDrawingExportBarrier(sceneHarness.dependencies);
  await assert.rejects(
    sceneBarrier.prepare(),
    (error: unknown) => assertBarrierError(error, "invalid-receipt"),
  );
  assert.equal(sceneHarness.restores.length, 1);
});

test("timeout aborts the active callback, restores presentation, and unlocks", async () => {
  const pending = new Promise<never>(() => {});
  const harness = createHarness({ sceneGate: pending });
  let observedSignal: AbortSignal | null = null;
  const originalAwaitScene = harness.dependencies.awaitExactScene;
  harness.dependencies.awaitExactScene = (context) => {
    observedSignal = context.signal;
    return originalAwaitScene(context);
  };
  const barrier = createDrawingExportBarrier(harness.dependencies, { defaultTimeoutMs: 20 });

  await assert.rejects(
    barrier.prepare(),
    (error: unknown) => assertBarrierError(error, "timeout"),
  );
  assert.equal((observedSignal as AbortSignal | null)?.aborted, true);
  assert.equal(harness.restores.length, 1);
  assert.equal(harness.restores[0]?.presentationApplied, false);
  assert.deepEqual(barrier.snapshot(), { locked: false, leaseId: null });
});

test("AbortSignal cancels a frame wait and preserves the original target in cleanup", async () => {
  const pending = new Promise<never>(() => {});
  const harness = createHarness({ frameGate: pending });
  const barrier = createDrawingExportBarrier(harness.dependencies, { defaultTimeoutMs: 1_000 });
  const controller = new AbortController();
  const preparation = barrier.prepare({ signal: controller.signal });

  while (!harness.order.includes("frame")) await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error("cancel capture"));
  await assert.rejects(
    preparation,
    (error: unknown) => assertBarrierError(error, "aborted"),
  );
  assert.deepEqual(harness.restores[0]?.target, {
    scopeKey: "spot:BTCUSDT__main",
    documentRevision: 42,
  });
  assert.deepEqual(barrier.snapshot(), { locked: false, leaseId: null });
});

test("a stale restore call cannot restore or unlock a newer lease", async () => {
  const harness = createHarness();
  const barrier = createDrawingExportBarrier(harness.dependencies);
  const first = await barrier.prepare();
  await first.restore();
  const restoreCountAfterFirst = harness.restores.length;

  const second = await barrier.prepare();
  assert.deepEqual(barrier.snapshot(), { locked: true, leaseId: 2 });
  await first.restore();
  assert.equal(harness.restores.length, restoreCountAfterFirst);
  assert.deepEqual(barrier.snapshot(), { locked: true, leaseId: 2 });

  await second.restore();
  assert.equal(harness.restores.length, restoreCountAfterFirst + 1);
  assert.deepEqual(barrier.snapshot(), { locked: false, leaseId: null });
});

test("restore failure is idempotent and releases the lock", async () => {
  const harness = createHarness({ failAt: "restore" });
  const barrier = createDrawingExportBarrier(harness.dependencies);
  const lease = await barrier.prepare();
  const first = lease.restore();
  const second = lease.restore();
  assert.strictEqual(first, second);
  await assert.rejects(first, /failed:restore/);
  assert.equal(harness.restores.length, 1);
  assert.deepEqual(barrier.snapshot(), { locked: false, leaseId: null });
});

test("cleanup failure preserves both the primary and restore errors", async () => {
  const harness = createHarness({ failAt: "restore" });
  harness.dependencies.revalidate = () => {
    throw failure("revalidate");
  };
  const barrier = createDrawingExportBarrier(harness.dependencies);

  await assert.rejects(barrier.prepare(), (error: unknown) => {
    assertBarrierError(error, "restore-failed");
    assert.ok(error instanceof DrawingExportBarrierError);
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors.length, 2);
    return true;
  });
  assert.deepEqual(barrier.snapshot(), { locked: false, leaseId: null });
});
