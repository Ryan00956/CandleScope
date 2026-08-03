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
  replayFinalStateEvent,
  replaySessionResponse,
  replayTradeDeltaEvent,
  replayTradeSessionResponse,
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

test("atomic snapshots label only same-dataset monotonic resets for revealed-prefix retention", () => {
  const store = new ReplayStore();
  store.beginGeneration(1, { resetAuthoritativeState: true, connectionState: "connecting" });
  store.applyAtomicSnapshot(1, parseReplaySessionResponse(replaySessionResponse({
    sourceSequence: 1,
    virtualTimeMs: BASE_TIME_MS + 60_000,
  })).snapshot);
  const flags: unknown[] = [];
  const unsubscribe = store.seriesStore.subscribe((delta) => {
    flags.push(delta.preserveRevealedPrefix);
  });

  store.applyAtomicSnapshot(1, parseReplaySessionResponse(replaySessionResponse({
    sourceSequence: 2,
    virtualTimeMs: BASE_TIME_MS + 120_000,
  })).snapshot);
  store.applyAtomicSnapshot(1, parseReplaySessionResponse(replaySessionResponse({
    sourceSequence: 1,
    virtualTimeMs: BASE_TIME_MS + 60_000,
  })).snapshot);
  unsubscribe();

  assert.deepEqual(flags, [true, false]);
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

test("aggregate-trade tape updates every chart tick while ordinary UI remains frame-bounded", () => {
  const scheduler = new FakeScheduler();
  const store = new ReplayStore({ scheduler });
  store.beginGeneration(1, { resetAuthoritativeState: true, connectionState: "connecting" });
  store.applyAtomicSnapshot(1, parseReplaySessionResponse(replayTradeSessionResponse()).snapshot);
  const flushesBefore = store.getSnapshot().uiFlushCount;
  for (let index = 1; index <= 100; index += 1) {
    const event = parseReplayEvent(replayTradeDeltaEvent({
      sequence: index,
      sourceSequence: index + 1,
    }));
    assert.equal(store.applyEvent(1, event), true);
  }
  assert.equal(store.seriesStore.barCount, 2);
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

test("compact final-state atomically replaces the retained series and account authority", () => {
  const store = new ReplayStore();
  store.beginGeneration(1, { resetAuthoritativeState: true, connectionState: "connecting" });
  store.applyAtomicSnapshot(1, parseReplaySessionResponse(replaySessionResponse()).snapshot);
  const event = parseReplayEvent(replayFinalStateEvent({ state: "ENDED" }));
  assert.equal(store.applyEvent(1, event), true);
  const snapshot = store.getSnapshot();
  assert.equal(store.seriesStore.barCount, 3);
  assert.equal(snapshot.lastPrice?.close, 102);
  assert.equal(snapshot.sourceSequence, 2);
  assert.equal(snapshot.sequence, 1);
  assert.equal(snapshot.state, "ENDED");
  assert.equal(snapshot.cursorAtEnd, true);
  assert.equal(snapshot.controllerClientId, null);
});

test("a non-convergent compact suffix changes neither store authority nor chart", () => {
  const store = new ReplayStore();
  store.beginGeneration(1, { resetAuthoritativeState: true, connectionState: "connecting" });
  store.applyAtomicSnapshot(1, parseReplaySessionResponse(replaySessionResponse()).snapshot);
  const malformed = structuredClone(replayFinalStateEvent());
  malformed.data.projection.series.retained_count = 4;
  const event = parseReplayEvent(malformed);
  assert.throws(() => store.applyEvent(1, event), /does not converge/);
  assert.equal(store.getSnapshot().sourceSequence, 0);
  assert.equal(store.getSnapshot().sequence, 0);
  assert.equal(store.seriesStore.barCount, 1);
});

test("an HTTP journal refresh merges without dropping newer WebSocket entries", () => {
  const store = new ReplayStore();
  store.beginGeneration(1, { resetAuthoritativeState: true, connectionState: "connecting" });
  store.applyAtomicSnapshot(1, parseReplaySessionResponse(replaySessionResponse()).snapshot);
  store.applyEvent(1, parseReplayEvent({
    type: "replay.journal",
    protocol: "replay.v1",
    session_id: "session-0001",
    sequence: 1,
    revision: 1,
    virtual_time_ms: BASE_TIME_MS,
    state_hash: `sha256:${"5".repeat(64)}`,
    data_epoch: `sha256:${"c".repeat(64)}`,
    data: { entry_id: "ws-note", virtual_time_ms: BASE_TIME_MS, text: "stream truth" },
  }));

  assert.equal(store.replaceJournal(1, [
    { entry_id: "http-note", virtual_time_ms: BASE_TIME_MS, text: "HTTP history" },
    { entry_id: "ws-note", virtual_time_ms: BASE_TIME_MS, text: "stale copy" },
  ]), true);
  assert.deepEqual(store.getSnapshot().journal, [
    { entry_id: "http-note", virtual_time_ms: BASE_TIME_MS, text: "HTTP history" },
    { entry_id: "ws-note", virtual_time_ms: BASE_TIME_MS, text: "stream truth" },
  ]);
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
