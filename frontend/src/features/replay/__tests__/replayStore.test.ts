import assert from "node:assert/strict";
import test from "node:test";

import { parseReplayEvent, parseReplaySessionResponse } from "../replayParser.js";
import { ReplayStore } from "../replayStore.js";
import type { ReplayStoreScheduler } from "../replayStore.js";
import {
  BASE_TIME_MS,
  replayDeltaEvent,
  replayEndedEvent,
  replayFill,
  replaySessionResponse,
} from "./fixtures.js";

class FakeScheduler implements ReplayStoreScheduler {
  private nextId = 1;
  readonly tasks = new Map<number, () => void>();

  setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, callback);
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.tasks.delete(handle as unknown as number);
  }

  flushAll(): void {
    const callbacks = [...this.tasks.values()];
    this.tasks.clear();
    for (const callback of callbacks) callback();
  }
}

test("ReplayStore owns read models while SeriesWindowStore remains bar truth", () => {
  const scheduler = new FakeScheduler();
  const store = new ReplayStore({ scheduler });
  store.beginGeneration(1, { resetAuthoritativeState: true, connectionState: "connecting" });
  const snapshot = parseReplaySessionResponse(replaySessionResponse()).snapshot;
  assert.equal(store.applyAtomicSnapshot(1, snapshot), true);
  assert.equal(store.seriesStore.barCount, 1);
  assert.equal(store.getSnapshot().sessionConfig?.symbol, "BTCUSDT");
  assert.equal(store.getSnapshot().account?.equity, "10000");
});

test("100x-style deltas update chart immediately but ordinary UI at most once per frame", () => {
  const scheduler = new FakeScheduler();
  const store = new ReplayStore({ scheduler });
  store.beginGeneration(1, { resetAuthoritativeState: true, connectionState: "connecting" });
  store.applyAtomicSnapshot(1, parseReplaySessionResponse(replaySessionResponse()).snapshot);
  const flushesBefore = store.getSnapshot().uiFlushCount;
  for (let index = 1; index <= 100; index += 1) {
    const event = parseReplayEvent(replayDeltaEvent({
      sequence: index,
      sourceSequence: index,
      openTimeMs: BASE_TIME_MS + index * 60_000,
    }));
    assert.equal(store.applyEvent(1, event), true);
  }
  assert.equal(store.seriesStore.barCount, 101);
  assert.equal(store.getSnapshot().uiFlushCount, flushesBefore);
  assert.equal(scheduler.tasks.size, 1);
  scheduler.flushAll();
  assert.equal(store.getSnapshot().uiFlushCount, flushesBefore + 1);
});

test("fills and paused state flush immediately", () => {
  const scheduler = new FakeScheduler();
  const store = new ReplayStore({ scheduler });
  store.beginGeneration(1, { resetAuthoritativeState: true, connectionState: "connecting" });
  store.applyAtomicSnapshot(1, parseReplaySessionResponse(replaySessionResponse()).snapshot);
  const before = store.getSnapshot().uiFlushCount;
  const event = parseReplayEvent(replayDeltaEvent({
    fills: [replayFill(BASE_TIME_MS + 119_999)],
  }));
  store.applyEvent(1, event);
  assert.equal(store.getSnapshot().fills.length, 1);
  assert.equal(store.getSnapshot().uiFlushCount, before + 1);
  assert.equal(scheduler.tasks.size, 0);
});

test("ended event releases stale local controller ownership immediately", () => {
  const store = new ReplayStore();
  store.beginGeneration(1, { resetAuthoritativeState: true, connectionState: "connecting" });
  store.applyAtomicSnapshot(1, parseReplaySessionResponse(replaySessionResponse({
    controllerClientId: "browser-0001",
  })).snapshot);
  assert.equal(store.getSnapshot().controllerClientId, "browser-0001");
  store.applyEvent(1, parseReplayEvent(replayEndedEvent()));
  assert.equal(store.getSnapshot().state, "ENDED");
  assert.equal(store.getSnapshot().controllerClientId, null);
});

test("generation reset clears transient state and rejects late callbacks", () => {
  const store = new ReplayStore();
  store.beginGeneration(1, { resetAuthoritativeState: true, connectionState: "connecting" });
  store.applyAtomicSnapshot(1, parseReplaySessionResponse(replaySessionResponse()).snapshot);
  store.setCrosshairData({ close: 100 });
  store.markVisibleRangePending();
  store.addIndicatorRequest(7);
  store.beginGeneration(2, { resetAuthoritativeState: false, connectionState: "reconnecting" });
  assert.deepEqual(store.transientDiagnostics(), {
    crosshairPresent: false,
    visibleRangePending: false,
    indicatorRequestCount: 0,
    transientRevision: 2,
  });
  assert.equal(store.applyEvent(1, parseReplayEvent(replayDeltaEvent())), false);
  assert.equal(store.seriesStore.barCount, 1);
});
