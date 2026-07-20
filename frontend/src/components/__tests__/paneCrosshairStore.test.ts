import test from "node:test";
import assert from "node:assert/strict";
import {
  createPaneCrosshairStore,
  type PaneCrosshairFrameScheduler,
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

test("pane crosshair store publishes only the latest value once per frame", () => {
  const frames = controlledScheduler();
  const store = createPaneCrosshairStore(frames.scheduler);
  const snapshots: Array<number | null> = [];
  store.subscribe(() => snapshots.push(store.getSnapshot()));

  store.publish(10);
  store.publish(20);
  store.publish(30);

  assert.equal(frames.pendingCount(), 1);
  assert.equal(store.getSnapshot(), null);
  frames.flush();
  assert.deepEqual(snapshots, [30]);
  assert.equal(store.getSnapshot(), 30);
});

test("pane crosshair store skips duplicate values and clears synchronously", () => {
  const frames = controlledScheduler();
  const store = createPaneCrosshairStore(frames.scheduler);
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });

  store.publish(10);
  frames.flush();
  store.publish(10);
  assert.equal(frames.pendingCount(), 0);
  store.publish(20);
  store.clear();

  assert.equal(frames.pendingCount(), 0);
  assert.equal(store.getSnapshot(), null);
  assert.equal(notifications, 2);
});
