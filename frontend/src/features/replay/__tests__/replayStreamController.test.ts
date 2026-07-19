import assert from "node:assert/strict";
import test from "node:test";

import {
  ReplayStreamController,
  buildReplayStreamUrl,
} from "../replayStreamController.js";
import type {
  ReplayStreamSocket,
  ReplayStreamTimers,
} from "../replayStreamController.js";
import {
  replayDeltaEvent,
  replayDigest,
  replaySnapshotEvent,
  replayStatusEvent,
} from "./fixtures.js";

class FakeTimers implements ReplayStreamTimers {
  private nextId = 1;
  readonly tasks = new Map<number, { callback: () => void; delay: number }>();

  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { callback, delay });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.tasks.delete(handle as unknown as number);
  }

  runAll(): void {
    while (this.tasks.size) {
      const next = [...this.tasks.entries()].sort(([left], [right]) => left - right)[0];
      if (!next) return;
      this.tasks.delete(next[0]);
      next[1].callback();
    }
  }


  runNext(): void {
    const next = [...this.tasks.entries()].sort(([left], [right]) => left - right)[0];
    if (!next) return;
    this.tasks.delete(next[0]);
    next[1].callback();
  }
}

class FakeSocket implements ReplayStreamSocket {
  readonly OPEN = 1;
  readyState = 0;
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent<string>) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  readonly sent: string[] = [];

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  message(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "closed" } as CloseEvent);
  }
}

test("stream URL is replay-only and includes bounded resume identity", () => {
  assert.equal(
    buildReplayStreamUrl({
      sessionId: "session-0001",
      baseUrl: "wss://example.test/",
      afterSequence: 12,
      dataEpoch: replayDigest("c"),
    }),
    `wss://example.test/api/v1/stream/replay/session-0001?after_sequence=12&data_epoch=${encodeURIComponent(replayDigest("c"))}`,
  );
});

test("controller publishes atomic snapshot then reconnects with after_sequence and epoch", () => {
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const snapshots: number[] = [];
  const events: number[] = [];
  const generations: number[] = [];
  const states: string[] = [];
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    initialDataEpoch: replayDigest("c"),
    baseUrl: "ws://example.test",
    timers,
    socketFactory: (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onGeneration: ({ generation }) => generations.push(generation),
    onState: (state) => states.push(state),
    onSnapshot: (snapshot) => snapshots.push(snapshot.sequence),
    onEvent: (event) => events.push(event.sequence),
  });

  controller.start();
  sockets[0]?.open();
  assert.deepEqual(states, ["connecting"]);
  sockets[0]?.message(replaySnapshotEvent());
  assert.equal(states.at(-1), "connected");
  assert.deepEqual(snapshots, [0]);
  const staleHandler = sockets[0]?.onmessage;
  sockets[0]?.close();
  assert.equal([...timers.tasks.values()][0]?.delay, 250);
  timers.runAll();
  assert.match(urls[1] ?? "", /after_sequence=0/);
  assert.match(urls[1] ?? "", /data_epoch=sha256%3A/);
  sockets[1]?.open();
  assert.equal(states.at(-1), "reconnecting");
  sockets[1]?.message(replayStatusEvent({ sequence: 1 }));
  assert.equal(states.at(-1), "connected");
  assert.deepEqual(events, [1]);
  staleHandler?.({ data: JSON.stringify(replayStatusEvent({ sequence: 2 })) } as MessageEvent<string>);
  assert.deepEqual(events, [1]);
  assert.deepEqual(generations, [1, 2]);
  controller.stop();
});

test("sequence gaps fail closed and reconnect through a reset generation", () => {
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
  const reasons: string[] = [];
  const errors: string[] = [];
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    initialDataEpoch: replayDigest("c"),
    baseUrl: "ws://example.test",
    timers,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onGeneration: ({ reason, resetAuthoritativeState }) => reasons.push(`${reason}:${resetAuthoritativeState}`),
    onError: (error) => errors.push(error.code),
  });
  controller.start();
  sockets[0]?.open();
  sockets[0]?.message(replaySnapshotEvent());
  sockets[0]?.message(replayStatusEvent({ sequence: 2 }));
  timers.runAll();
  assert.ok(errors.includes("REPLAY_PROTOCOL_ERROR"));
  assert.deepEqual(reasons, ["initial:true", "resync:true"]);
  assert.equal(sockets.length, 2);
  controller.stop();
});

test("duplicate incremental messages are never applied twice and force resync", () => {
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
  const events: number[] = [];
  const errors: string[] = [];
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    initialDataEpoch: replayDigest("c"),
    baseUrl: "ws://example.test",
    timers,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onEvent: (event) => events.push(event.sequence),
    onError: (error) => errors.push(error.code),
  });

  controller.start();
  sockets[0]?.open();
  sockets[0]?.message(replaySnapshotEvent());
  const sequenceOne = replayStatusEvent({ sequence: 1 });
  sockets[0]?.message(sequenceOne);
  sockets[0]?.message(sequenceOne);
  timers.runAll();

  assert.deepEqual(events, [1]);
  assert.ok(errors.includes("REPLAY_PROTOCOL_ERROR"));
  assert.equal(sockets.length, 2);
  controller.stop();
});

test("out-of-order messages cannot backfill a detected loss inside one generation", () => {
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
  const events: number[] = [];
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    initialDataEpoch: replayDigest("c"),
    baseUrl: "ws://example.test",
    timers,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onEvent: (event) => events.push(event.sequence),
  });

  controller.start();
  sockets[0]?.open();
  sockets[0]?.message(replaySnapshotEvent());
  const staleHandler = sockets[0]?.onmessage;
  sockets[0]?.message(replayStatusEvent({ sequence: 2 }));
  staleHandler?.({ data: JSON.stringify(replayStatusEvent({ sequence: 1 })) } as MessageEvent<string>);
  timers.runAll();

  assert.deepEqual(events, []);
  assert.equal(sockets.length, 2);
  controller.stop();
});

test("wrong data epoch is fatal and never falls through to best-effort events", () => {
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
  const events: number[] = [];
  const errors: Array<{ code: string; fatal: boolean }> = [];
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    initialDataEpoch: replayDigest("c"),
    baseUrl: "ws://example.test",
    timers,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onEvent: (event) => events.push(event.sequence),
    onError: (error) => errors.push({ code: error.code, fatal: error.fatal }),
  });
  controller.start();
  sockets[0]?.open();
  sockets[0]?.message(replaySnapshotEvent());
  sockets[0]?.message(replayDeltaEvent({ dataEpoch: replayDigest("d") }));
  timers.runAll();
  assert.deepEqual(events, []);
  assert.ok(errors.some((error) => error.code === "DATASET_MISMATCH" && error.fatal));
  assert.equal(sockets.length, 1);
});

test("controller heartbeat is exact, ownership-gated, and canceled on stop", () => {
  const timers = new FakeTimers();
  const socket = new FakeSocket();
  let ownsController = false;
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    clientInstanceId: "browser-0001",
    shouldHeartbeat: () => ownsController,
    heartbeatMs: 500,
    baseUrl: "ws://example.test",
    timers,
    socketFactory: () => socket,
  });
  controller.start();
  socket.open();
  assert.equal(timers.tasks.size, 0);
  socket.message(replaySnapshotEvent());
  assert.equal([...timers.tasks.values()][0]?.delay, 500);
  timers.runNext();
  assert.deepEqual(socket.sent, []);
  ownsController = true;
  timers.runNext();
  assert.deepEqual(socket.sent.map((payload): unknown => JSON.parse(payload) as unknown), [{
    type: "replay.heartbeat",
    protocol: "replay.v1",
    client_instance_id: "browser-0001",
  }]);
  controller.stop();
  assert.equal(timers.tasks.size, 0);
});
