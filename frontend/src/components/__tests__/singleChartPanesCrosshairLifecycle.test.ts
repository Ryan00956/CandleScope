import test from "node:test";
import assert from "node:assert/strict";
import {
  createPaneCrosshairStore,
  createPaneCrosshairStoreLifecycle,
  type PaneCrosshairFrameScheduler,
  type PaneCrosshairStore,
} from "../paneCrosshairStore.js";

function controlledScheduler() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  const scheduler: PaneCrosshairFrameScheduler = {
    request(callback) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    cancel(id) {
      callbacks.delete(id);
    },
  };
  return {
    scheduler,
    flush() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
    pendingCount: () => callbacks.size,
  };
}

interface StoreGeneration {
  store: PaneCrosshairStore;
  disposeCalls: number;
  activeSubscriptions: number;
}

test("SingleChartPanes crosshair lifecycle replaces the StrictMode rehearsal generation", () => {
  const frames = controlledScheduler();
  const generations: StoreGeneration[] = [];
  const lifecycle = createPaneCrosshairStoreLifecycle(() => {
    const store = createPaneCrosshairStore(frames.scheduler);
    const generation: StoreGeneration = {
      store,
      disposeCalls: 0,
      activeSubscriptions: 0,
    };
    generations.push(generation);
    return {
      getSnapshot: store.getSnapshot,
      publish: store.publish,
      clear: store.clear,
      subscribe: (listener) => {
        generation.activeSubscriptions += 1;
        const unsubscribe = store.subscribe(listener);
        return () => {
          generation.activeSubscriptions -= 1;
          unsubscribe();
        };
      },
      dispose: () => {
        generation.disposeCalls += 1;
        store.dispose();
      },
    };
  });
  const snapshots: Array<number | null> = [];
  const unsubscribe = lifecycle.store.subscribe(() => {
    snapshots.push(lifecycle.store.getSnapshot());
  });

  // First setup/cleanup is React StrictMode's development rehearsal.
  const cleanupRehearsal = lifecycle.activate();
  lifecycle.store.publish(101);
  assert.equal(frames.pendingCount(), 1);
  assert.equal(generations[0]?.activeSubscriptions, 1);

  cleanupRehearsal();
  assert.equal(generations[0]?.disposeCalls, 1);
  assert.equal(generations[0]?.activeSubscriptions, 0);
  assert.equal(frames.pendingCount(), 0);

  // The replay must own a fresh, live store instead of the disposed first one.
  const cleanupMounted = lifecycle.activate();
  assert.equal(generations.length, 2);
  assert.notEqual(generations[1]?.store, generations[0]?.store);
  assert.equal(generations[1]?.activeSubscriptions, 1);

  lifecycle.store.publish(202);
  frames.flush();
  assert.deepEqual(snapshots, [202]);
  assert.equal(lifecycle.store.getSnapshot(), 202);

  // A real production unmount cancels pending rAF work and detaches listeners.
  lifecycle.store.publish(303);
  assert.equal(frames.pendingCount(), 1);
  cleanupMounted();
  assert.equal(generations[1]?.disposeCalls, 1);
  assert.equal(generations[1]?.activeSubscriptions, 0);
  assert.equal(frames.pendingCount(), 0);
  frames.flush();
  assert.deepEqual(snapshots, [202]);

  // Effect cleanups are generation-bound and idempotent.
  cleanupRehearsal();
  assert.equal(generations[0]?.disposeCalls, 1);
  unsubscribe();
});
