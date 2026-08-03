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
  BASE_TIME_MS,
  replayDeltaEvent,
  replayDigest,
  replayFinalStateEvent,
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

class DeferredCloseSocket extends FakeSocket {
  closeRequested = false;

  override close(): void {
    this.closeRequested = true;
  }

  finishClose(): void {
    super.close();
  }
}

function replaySeekResetEvent({
  sequence = 11,
  revision = 5,
  sourceSequence = 2,
  virtualTimeMs = BASE_TIME_MS + 119_999,
  statusReason = "seek_complete",
  state = "PAUSED",
}: {
  sequence?: number;
  revision?: number;
  sourceSequence?: number;
  virtualTimeMs?: number;
  statusReason?: string;
  state?: string;
} = {}) {
  const event = replaySnapshotEvent({
    sequence,
    revision,
    sourceSequence,
    virtualTimeMs,
    state,
  });
  event.data.snapshot.status_reason = statusReason;
  return event;
}

function replaySummaryJumpResetEvent({
  sequence = 11,
  revision = 5,
  sourceSequence = 84,
  virtualTimeMs = BASE_TIME_MS + 5_039_999,
  statusReason = "fast_forward_summary_jump",
  state = "PAUSED",
}: {
  sequence?: number;
  revision?: number;
  sourceSequence?: number;
  virtualTimeMs?: number;
  statusReason?: string;
  state?: string;
} = {}) {
  const event = replaySnapshotEvent({
    sequence,
    revision,
    sourceSequence,
    virtualTimeMs,
    state,
  });
  event.data.snapshot.status_reason = statusReason;
  return event;
}

function replayCoalescedPrefixResetEvent(
  options: Parameters<typeof replaySummaryJumpResetEvent>[0] = {},
) {
  return replaySummaryJumpResetEvent({
    sourceSequence: 96,
    virtualTimeMs: BASE_TIME_MS + 5_759_999,
    statusReason: "fast_forward_coalesced_prefix",
    ...options,
  });
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
  assert.equal(states.at(-1), "reconnecting");
  assert.equal(controller.diagnostics().state, "reconnecting");
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

test("an explicit resync preempts an already scheduled reconnect backoff", () => {
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
  const reasons: string[] = [];
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
    onGeneration: ({ reason }) => reasons.push(reason),
  });
  controller.start();
  sockets[0]?.open();
  sockets[0]?.message(replaySnapshotEvent());
  sockets[0]?.close();
  assert.equal([...timers.tasks.values()][0]?.delay, 250);

  controller.requestResync("authoritative refresh required");
  assert.equal(timers.tasks.size, 1);
  assert.equal([...timers.tasks.values()][0]?.delay, 0);
  timers.runNext();
  assert.deepEqual(reasons, ["initial", "resync"]);
  assert.equal(sockets.length, 2);
  controller.stop();
});

test("late atomic snapshots cannot roll authoritative counters backward", () => {
  const timers = new FakeTimers();
  const socket = new FakeSocket();
  const snapshots: number[] = [];
  const errors: string[] = [];
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    initialDataEpoch: replayDigest("c"),
    baseUrl: "ws://example.test",
    timers,
    socketFactory: () => socket,
    onSnapshot: (snapshot) => snapshots.push(snapshot.sequence),
    onError: (error) => errors.push(error.code),
  });
  controller.start();
  socket.open();
  socket.message(replaySnapshotEvent());
  socket.message(replayStatusEvent({ sequence: 1 }));
  socket.message(replaySnapshotEvent());

  assert.deepEqual(snapshots, [0]);
  assert.equal(controller.diagnostics().lastSequence, 1);
  assert.equal(controller.diagnostics().state, "resyncing");
  assert.ok(errors.includes("REPLAY_PROTOCOL_ERROR"));
  controller.stop();
});

test("resync retains the cross-generation authority floor and rejects a stale atomic snapshot", () => {
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
  const snapshots: number[] = [];
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
    onSnapshot: (snapshot) => snapshots.push(snapshot.sequence),
    onError: (error) => errors.push(error.code),
  });
  controller.start();
  sockets[0]?.open();
  sockets[0]?.message(replaySnapshotEvent({
    sequence: 10,
    revision: 4,
    sourceSequence: 6,
    virtualTimeMs: BASE_TIME_MS + 419_999,
  }));
  assert.deepEqual(snapshots, [10]);

  controller.requestResync("verify retained authority floor");
  timers.runAll();
  sockets[1]?.open();
  sockets[1]?.message(replaySnapshotEvent({
    sequence: 1,
    revision: 1,
    sourceSequence: 1,
    virtualTimeMs: BASE_TIME_MS + 119_999,
  }));

  assert.deepEqual(snapshots, [10]);
  assert.equal(controller.diagnostics().lastSequence, 10);
  assert.equal(controller.diagnostics().lastRevision, 4);
  assert.equal(controller.diagnostics().lastSourceSequence, 6);
  assert.equal(controller.diagnostics().state, "resyncing");
  assert.ok(errors.includes("REPLAY_PROTOCOL_ERROR"));
  controller.stop();
});

test("a cross-generation resync still permits the exact contiguous seek reset", () => {
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
  const snapshots: number[] = [];
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
    onSnapshot: (snapshot) => snapshots.push(snapshot.sequence),
  });
  controller.start();
  sockets[0]?.open();
  sockets[0]?.message(replaySnapshotEvent({
    sequence: 10,
    revision: 4,
    sourceSequence: 6,
    virtualTimeMs: BASE_TIME_MS + 419_999,
  }));
  controller.requestResync("recover a committed seek snapshot");
  timers.runAll();
  sockets[1]?.open();
  sockets[1]?.message(replaySeekResetEvent());

  assert.deepEqual(snapshots, [10, 11]);
  assert.equal(controller.diagnostics().lastSequence, 11);
  assert.equal(controller.diagnostics().lastRevision, 5);
  assert.equal(controller.diagnostics().lastSourceSequence, 2);
  assert.equal(controller.diagnostics().state, "connected");
  controller.stop();
});

test("a contiguous paused seek reset may atomically move replay authority backward", () => {
  const timers = new FakeTimers();
  const socket = new FakeSocket();
  const snapshots: Array<{
    sequence: number;
    revision: number;
    sourceSequence: number;
    virtualTimeMs: number;
    reason: string;
  }> = [];
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    initialDataEpoch: replayDigest("c"),
    baseUrl: "ws://example.test",
    timers,
    socketFactory: () => socket,
    onSnapshot: (snapshot) => snapshots.push({
      sequence: snapshot.sequence,
      revision: snapshot.revision,
      sourceSequence: snapshot.cursor.source_sequence,
      virtualTimeMs: snapshot.cursor.virtual_time_ms,
      reason: snapshot.status_reason,
    }),
  });
  controller.start();
  socket.open();
  socket.message(replaySnapshotEvent({
    sequence: 10,
    revision: 4,
    sourceSequence: 4,
    virtualTimeMs: BASE_TIME_MS + 239_999,
  }));
  socket.message(replaySeekResetEvent());

  assert.deepEqual(snapshots, [
    {
      sequence: 10,
      revision: 4,
      sourceSequence: 4,
      virtualTimeMs: BASE_TIME_MS + 239_999,
      reason: "created",
    },
    {
      sequence: 11,
      revision: 5,
      sourceSequence: 2,
      virtualTimeMs: BASE_TIME_MS + 119_999,
      reason: "seek_complete",
    },
  ]);
  assert.equal(controller.diagnostics().lastSequence, 11);
  assert.equal(controller.diagnostics().lastRevision, 5);
  assert.equal(controller.diagnostics().lastSourceSequence, 2);
  assert.equal(controller.diagnostics().lastVirtualTimeMs, BASE_TIME_MS + 119_999);
  assert.equal(controller.diagnostics().state, "connected");
  controller.stop();
});

test("backward seek snapshots require the exact reason, sequence, revision, and paused state", () => {
  const variants = [
    { name: "reason", event: replaySeekResetEvent({ statusReason: "created" }) },
    { name: "sequence", event: replaySeekResetEvent({ sequence: 12 }) },
    { name: "revision", event: replaySeekResetEvent({ revision: 6 }) },
    { name: "state", event: replaySeekResetEvent({ state: "PLAYING" }) },
  ];

  for (const variant of variants) {
    const timers = new FakeTimers();
    const socket = new FakeSocket();
    const snapshots: number[] = [];
    const errors: string[] = [];
    const controller = new ReplayStreamController({
      sessionId: "session-0001",
      initialDataEpoch: replayDigest("c"),
      baseUrl: "ws://example.test",
      timers,
      socketFactory: () => socket,
      onSnapshot: (snapshot) => snapshots.push(snapshot.sequence),
      onError: (error) => errors.push(error.code),
    });
    controller.start();
    socket.open();
    socket.message(replaySnapshotEvent({
      sequence: 10,
      revision: 4,
      sourceSequence: 4,
      virtualTimeMs: BASE_TIME_MS + 239_999,
    }));
    socket.message(variant.event);

    assert.deepEqual(snapshots, [10], variant.name);
    assert.equal(controller.diagnostics().lastSequence, 10, variant.name);
    assert.equal(controller.diagnostics().lastRevision, 4, variant.name);
    assert.equal(controller.diagnostics().lastSourceSequence, 4, variant.name);
    assert.equal(controller.diagnostics().state, "resyncing", variant.name);
    assert.ok(errors.includes("REPLAY_PROTOCOL_ERROR"), variant.name);
    controller.stop();
  }
});

test("a contiguous paused period-summary reset may atomically advance the source cursor", () => {
  const timers = new FakeTimers();
  const socket = new FakeSocket();
  const snapshots: Array<{
    sequence: number;
    revision: number;
    sourceSequence: number;
    virtualTimeMs: number;
    reason: string;
  }> = [];
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    initialDataEpoch: replayDigest("c"),
    baseUrl: "ws://example.test",
    timers,
    socketFactory: () => socket,
    onSnapshot: (snapshot) => snapshots.push({
      sequence: snapshot.sequence,
      revision: snapshot.revision,
      sourceSequence: snapshot.cursor.source_sequence,
      virtualTimeMs: snapshot.cursor.virtual_time_ms,
      reason: snapshot.status_reason,
    }),
  });
  controller.start();
  socket.open();
  socket.message(replaySnapshotEvent({
    sequence: 10,
    revision: 4,
    sourceSequence: 4,
    virtualTimeMs: BASE_TIME_MS + 239_999,
  }));
  socket.message(replaySummaryJumpResetEvent());

  assert.deepEqual(snapshots, [
    {
      sequence: 10,
      revision: 4,
      sourceSequence: 4,
      virtualTimeMs: BASE_TIME_MS + 239_999,
      reason: "created",
    },
    {
      sequence: 11,
      revision: 5,
      sourceSequence: 84,
      virtualTimeMs: BASE_TIME_MS + 5_039_999,
      reason: "fast_forward_summary_jump",
    },
  ]);
  assert.equal(controller.diagnostics().lastSequence, 11);
  assert.equal(controller.diagnostics().lastRevision, 5);
  assert.equal(controller.diagnostics().lastSourceSequence, 84);
  assert.equal(controller.diagnostics().lastVirtualTimeMs, BASE_TIME_MS + 5_039_999);
  assert.equal(controller.diagnostics().state, "connected");
  controller.stop();
});

test("period-summary resets require exact reason, contiguous counters, paused state, and forward cursor", () => {
  const variants = [
    {
      name: "reason",
      event: replaySummaryJumpResetEvent({ statusReason: "fast_forward_unknown" }),
    },
    { name: "sequence", event: replaySummaryJumpResetEvent({ sequence: 12 }) },
    { name: "revision", event: replaySummaryJumpResetEvent({ revision: 6 }) },
    { name: "state", event: replaySummaryJumpResetEvent({ state: "PLAYING" }) },
    {
      name: "virtual-time",
      event: replaySummaryJumpResetEvent({ virtualTimeMs: BASE_TIME_MS + 119_999 }),
    },
    { name: "source-sequence", event: replaySummaryJumpResetEvent({ sourceSequence: 4 }) },
  ];

  for (const variant of variants) {
    const timers = new FakeTimers();
    const socket = new FakeSocket();
    const snapshots: number[] = [];
    const errors: string[] = [];
    const controller = new ReplayStreamController({
      sessionId: "session-0001",
      initialDataEpoch: replayDigest("c"),
      baseUrl: "ws://example.test",
      timers,
      socketFactory: () => socket,
      onSnapshot: (snapshot) => snapshots.push(snapshot.sequence),
      onError: (error) => errors.push(error.code),
    });
    controller.start();
    socket.open();
    socket.message(replaySnapshotEvent({
      sequence: 10,
      revision: 4,
      sourceSequence: 4,
      virtualTimeMs: BASE_TIME_MS + 239_999,
    }));
    socket.message(variant.event);

    assert.deepEqual(snapshots, [10], variant.name);
    assert.equal(controller.diagnostics().lastSequence, 10, variant.name);
    assert.equal(controller.diagnostics().lastRevision, 4, variant.name);
    assert.equal(controller.diagnostics().lastSourceSequence, 4, variant.name);
    assert.equal(controller.diagnostics().state, "resyncing", variant.name);
    assert.ok(errors.includes("REPLAY_PROTOCOL_ERROR"), variant.name);
    controller.stop();
  }
});

test("a coalesced fast-forward prefix reset establishes a causal floor for its visible tail", () => {
  const timers = new FakeTimers();
  const socket = new FakeSocket();
  const snapshots: number[] = [];
  const events: number[] = [];
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    initialDataEpoch: replayDigest("c"),
    baseUrl: "ws://example.test",
    timers,
    socketFactory: () => socket,
    onSnapshot: (snapshot) => snapshots.push(snapshot.cursor.source_sequence),
    onEvent: (event) => events.push(
      (event.data as { source_sequence: number }).source_sequence,
    ),
  });
  controller.start();
  socket.open();
  socket.message(replaySnapshotEvent({
    sequence: 10,
    revision: 4,
    sourceSequence: 84,
    virtualTimeMs: BASE_TIME_MS + 5_039_999,
  }));
  socket.message(replayCoalescedPrefixResetEvent());
  const tail = replayDeltaEvent({
    sequence: 12,
    sourceSequence: 97,
    openTimeMs: BASE_TIME_MS + 5_760_000,
  });
  tail.revision = 5;
  socket.message(tail);

  assert.deepEqual(snapshots, [84, 96]);
  assert.deepEqual(events, [97]);
  assert.equal(controller.diagnostics().lastSequence, 12);
  assert.equal(controller.diagnostics().lastSourceSequence, 97);
  assert.equal(controller.diagnostics().state, "connected");
  controller.stop();
});

test("a final fast-forward reset converges within the visible tail command revision", () => {
  const timers = new FakeTimers();
  const socket = new FakeSocket();
  const snapshots: Array<{ sequence: number; revision: number; sourceSequence: number }> = [];
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    initialDataEpoch: replayDigest("c"),
    baseUrl: "ws://example.test",
    timers,
    socketFactory: () => socket,
    onSnapshot: (snapshot) => snapshots.push({
      sequence: snapshot.sequence,
      revision: snapshot.revision,
      sourceSequence: snapshot.cursor.source_sequence,
    }),
  });
  controller.start();
  socket.open();
  socket.message(replaySnapshotEvent({
    sequence: 10,
    revision: 4,
    sourceSequence: 84,
    virtualTimeMs: BASE_TIME_MS + 5_039_999,
  }));
  socket.message(replayCoalescedPrefixResetEvent());
  const tail = replayDeltaEvent({
    sequence: 12,
    sourceSequence: 97,
    openTimeMs: BASE_TIME_MS + 5_760_000,
  });
  tail.revision = 5;
  socket.message(tail);
  socket.message(replaySummaryJumpResetEvent({
    sequence: 13,
    revision: 5,
    sourceSequence: 97,
    virtualTimeMs: BASE_TIME_MS + 5_819_999,
    statusReason: "fast_forward_complete",
  }));

  assert.deepEqual(snapshots, [
    { sequence: 10, revision: 4, sourceSequence: 84 },
    { sequence: 11, revision: 5, sourceSequence: 96 },
    { sequence: 13, revision: 5, sourceSequence: 97 },
  ]);
  assert.equal(controller.diagnostics().lastSequence, 13);
  assert.equal(controller.diagnostics().lastRevision, 5);
  assert.equal(controller.diagnostics().lastSourceSequence, 97);
  assert.equal(controller.diagnostics().state, "connected");
  controller.stop();
});

test("an exact terminal fast-forward reset may atomically publish the exhausted cursor", () => {
  const timers = new FakeTimers();
  const socket = new FakeSocket();
  const snapshots: Array<{ state: string; sourceSequence: number }> = [];
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    initialDataEpoch: replayDigest("c"),
    baseUrl: "ws://example.test",
    timers,
    socketFactory: () => socket,
    onSnapshot: (snapshot) => snapshots.push({
      state: snapshot.state,
      sourceSequence: snapshot.cursor.source_sequence,
    }),
  });
  controller.start();
  socket.open();
  socket.message(replaySnapshotEvent({
    sequence: 10,
    revision: 4,
    sourceSequence: 84,
    virtualTimeMs: BASE_TIME_MS + 5_039_999,
  }));
  const terminal = replaySummaryJumpResetEvent({
    sourceSequence: 128,
    virtualTimeMs: BASE_TIME_MS + 7_679_999,
    statusReason: "fast_forward_complete",
    state: "ENDED",
  });
  terminal.data.snapshot.cursor.at_end = true;
  terminal.data.snapshot.components.ended = true;
  socket.message(terminal);

  assert.deepEqual(snapshots, [
    { state: "PAUSED", sourceSequence: 84 },
    { state: "ENDED", sourceSequence: 128 },
  ]);
  assert.equal(controller.diagnostics().lastSequence, 11);
  assert.equal(controller.diagnostics().lastSourceSequence, 128);
  assert.equal(controller.diagnostics().state, "connected");
  controller.stop();
});

test("compact final-state advances transport, source, revision, time, and hash together", () => {
  const timers = new FakeTimers();
  const socket = new FakeSocket();
  const events: string[] = [];
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    initialDataEpoch: replayDigest("c"),
    baseUrl: "ws://example.test",
    timers,
    socketFactory: () => socket,
    onEvent: (event) => events.push(event.type),
  });
  controller.start();
  socket.open();
  socket.message(replaySnapshotEvent());
  socket.message(replayFinalStateEvent({ state: "ENDED" }));
  const diagnostics = controller.diagnostics();
  assert.deepEqual(events, ["replay.final_state"]);
  assert.equal(diagnostics.lastSequence, 1);
  assert.equal(diagnostics.lastRevision, 1);
  assert.equal(diagnostics.lastSourceSequence, 2);
  assert.equal(diagnostics.lastStateHash, replayDigest("9"));
  assert.equal(diagnostics.state, "connected");
  controller.stop();
});

test("compact final-state source gaps fail closed into full resync", () => {
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
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
    onError: (error) => errors.push(error.code),
  });
  controller.start();
  sockets[0]!.open();
  sockets[0]!.message(replaySnapshotEvent());
  sockets[0]!.message(replayFinalStateEvent({ sourceFrom: 2, sourceTo: 3 }));
  assert.deepEqual(errors, ["REPLAY_PROTOCOL_ERROR"]);
  assert.equal(controller.diagnostics().state, "resyncing");
  timers.runAll();
  assert.equal(sockets.length, 2);
  controller.stop();
});

test("a final-state reset may converge across hidden command revisions", () => {
  for (const statusReason of [
    "fast_forward_final_state_complete",
    "fast_forward_final_state_cancelled",
    "fast_forward_final_state_interaction",
  ]) {
    const timers = new FakeTimers();
    const socket = new FakeSocket();
    const snapshots: Array<{
      revision: number;
      sourceSequence: number;
      reason: string;
    }> = [];
    const controller = new ReplayStreamController({
      sessionId: "session-0001",
      initialDataEpoch: replayDigest("c"),
      baseUrl: "ws://example.test",
      timers,
      socketFactory: () => socket,
      onSnapshot: (snapshot) => snapshots.push({
        revision: snapshot.revision,
        sourceSequence: snapshot.cursor.source_sequence,
        reason: snapshot.status_reason,
      }),
    });
    controller.start();
    socket.open();
    socket.message(replaySnapshotEvent({
      sequence: 10,
      revision: 4,
      sourceSequence: 4,
      virtualTimeMs: BASE_TIME_MS + 239_999,
    }));
    socket.message(replaySummaryJumpResetEvent({
      sequence: 11,
      revision: 9,
      sourceSequence: 84,
      virtualTimeMs: BASE_TIME_MS + 5_039_999,
      statusReason,
    }));

    assert.deepEqual(snapshots, [
      { revision: 4, sourceSequence: 4, reason: "created" },
      { revision: 9, sourceSequence: 84, reason: statusReason },
    ]);
    assert.equal(controller.diagnostics().state, "connected");
    controller.stop();
  }
});

test("a final-state reset cannot cross source within the same revision", () => {
  const timers = new FakeTimers();
  const socket = new FakeSocket();
  const snapshots: number[] = [];
  const errors: string[] = [];
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    initialDataEpoch: replayDigest("c"),
    baseUrl: "ws://example.test",
    timers,
    socketFactory: () => socket,
    onSnapshot: (snapshot) => snapshots.push(snapshot.cursor.source_sequence),
    onError: (error) => errors.push(error.code),
  });
  controller.start();
  socket.open();
  socket.message(replaySnapshotEvent({
    sequence: 10,
    revision: 4,
    sourceSequence: 4,
    virtualTimeMs: BASE_TIME_MS + 239_999,
  }));
  socket.message(replaySummaryJumpResetEvent({
    sequence: 11,
    revision: 4,
    sourceSequence: 84,
    virtualTimeMs: BASE_TIME_MS + 5_039_999,
    statusReason: "fast_forward_final_state_complete",
  }));

  assert.deepEqual(snapshots, [4]);
  assert.equal(controller.diagnostics().state, "resyncing");
  assert.ok(errors.includes("REPLAY_PROTOCOL_ERROR"));
  controller.stop();
});

test("coalesced-prefix resets reject non-contiguous or non-forward authority", () => {
  const variants = [
    { name: "sequence", event: replayCoalescedPrefixResetEvent({ sequence: 12 }) },
    { name: "revision", event: replayCoalescedPrefixResetEvent({ revision: 6 }) },
    { name: "state", event: replayCoalescedPrefixResetEvent({ state: "PLAYING" }) },
    {
      name: "virtual-time",
      event: replayCoalescedPrefixResetEvent({ virtualTimeMs: BASE_TIME_MS + 119_999 }),
    },
    { name: "source-sequence", event: replayCoalescedPrefixResetEvent({ sourceSequence: 4 }) },
  ];

  for (const variant of variants) {
    const timers = new FakeTimers();
    const socket = new FakeSocket();
    const errors: string[] = [];
    const controller = new ReplayStreamController({
      sessionId: "session-0001",
      initialDataEpoch: replayDigest("c"),
      baseUrl: "ws://example.test",
      timers,
      socketFactory: () => socket,
      onError: (error) => errors.push(error.code),
    });
    controller.start();
    socket.open();
    socket.message(replaySnapshotEvent({
      sequence: 10,
      revision: 4,
      sourceSequence: 4,
      virtualTimeMs: BASE_TIME_MS + 239_999,
    }));
    socket.message(variant.event);

    assert.equal(controller.diagnostics().lastSequence, 10, variant.name);
    assert.equal(controller.diagnostics().lastSourceSequence, 4, variant.name);
    assert.equal(controller.diagnostics().state, "resyncing", variant.name);
    assert.ok(errors.includes("REPLAY_PROTOCOL_ERROR"), variant.name);
    controller.stop();
  }
});

test("an ordinary reconnect snapshot still cannot move cursor authority backward", () => {
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
  const snapshots: number[] = [];
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
    onSnapshot: (snapshot) => snapshots.push(snapshot.sequence),
  });
  controller.start();
  sockets[0]?.open();
  sockets[0]?.message(replaySnapshotEvent({
    sequence: 10,
    revision: 4,
    sourceSequence: 4,
    virtualTimeMs: BASE_TIME_MS + 239_999,
  }));
  sockets[0]?.close();
  timers.runAll();
  sockets[1]?.open();
  sockets[1]?.message(replaySnapshotEvent({
    sequence: 11,
    revision: 5,
    sourceSequence: 2,
    virtualTimeMs: BASE_TIME_MS + 119_999,
  }));

  assert.deepEqual(snapshots, [10]);
  assert.equal(controller.diagnostics().lastSequence, 10);
  assert.equal(controller.diagnostics().lastSourceSequence, 4);
  assert.equal(controller.diagnostics().state, "resyncing");
  controller.stop();
});

test("projection callback failures do not advance controller authority and fail closed into resync", () => {
  const timers = new FakeTimers();
  const socket = new FakeSocket();
  const errors: string[] = [];
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    initialDataEpoch: replayDigest("c"),
    baseUrl: "ws://example.test",
    timers,
    socketFactory: () => socket,
    onEvent: () => { throw new Error("projection rejected"); },
    onError: (error) => errors.push(error.code),
  });
  controller.start();
  socket.open();
  socket.message(replaySnapshotEvent());
  socket.message(replayStatusEvent({ sequence: 1 }));

  assert.equal(controller.diagnostics().lastSequence, 0);
  assert.equal(controller.diagnostics().lastRevision, 0);
  assert.equal(controller.diagnostics().state, "resyncing");
  assert.ok(errors.includes("REPLAY_PROTOCOL_ERROR"));
  controller.stop();
});

test("atomic snapshot callback failures leave controller authority empty", () => {
  const timers = new FakeTimers();
  const socket = new FakeSocket();
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    initialDataEpoch: replayDigest("c"),
    baseUrl: "ws://example.test",
    timers,
    socketFactory: () => socket,
    onSnapshot: () => { throw new Error("chart cannot represent snapshot"); },
  });
  controller.start();
  socket.open();
  socket.message(replaySnapshotEvent());

  assert.equal(controller.diagnostics().hasAuthoritativeState, false);
  assert.equal(controller.diagnostics().lastSequence, null);
  assert.equal(controller.diagnostics().state, "resyncing");
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

test("queued old-socket messages cannot publish after an asynchronous resync close", () => {
  const timers = new FakeTimers();
  const socket = new DeferredCloseSocket();
  const events: number[] = [];
  const states: string[] = [];
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    initialDataEpoch: replayDigest("c"),
    baseUrl: "ws://example.test",
    timers,
    socketFactory: () => socket,
    onEvent: (event) => events.push(event.sequence),
    onState: (state) => states.push(state),
  });
  controller.start();
  socket.open();
  socket.message(replaySnapshotEvent());
  const queuedOldHandler = socket.onmessage;

  socket.message(replayStatusEvent({ sequence: 2 }));
  assert.equal(socket.closeRequested, true);
  assert.equal(controller.diagnostics().state, "resyncing");
  queuedOldHandler?.({ data: JSON.stringify(replayStatusEvent({ sequence: 1 })) } as MessageEvent<string>);

  assert.deepEqual(events, []);
  assert.equal(states.at(-1), "resyncing");
  assert.equal(controller.diagnostics().lastSequence, 0);
  socket.finishClose();
  controller.stop();
});

test("coalesced delta ranges advance transport and source authority by the exact covered count", () => {
  const timers = new FakeTimers();
  const socket = new FakeSocket();
  const events: number[] = [];
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    initialDataEpoch: replayDigest("c"),
    baseUrl: "ws://example.test",
    timers,
    socketFactory: () => socket,
    onEvent: (event) => events.push(event.sequence),
  });
  controller.start();
  socket.open();
  socket.message(replaySnapshotEvent());
  const ranged = replayDeltaEvent({ sequence: 3, sourceSequence: 3 });
  Object.assign(ranged, { sequence_from: 1, sequence_to: 3 });
  socket.message(ranged);

  assert.deepEqual(events, [3]);
  assert.equal(controller.diagnostics().lastSequence, 3);
  assert.equal(controller.diagnostics().lastSourceSequence, 3);
  assert.equal(controller.diagnostics().state, "connected");
  controller.stop();
});

test("coalesced ranges reject forged source cursor jumps", () => {
  const timers = new FakeTimers();
  const socket = new FakeSocket();
  const events: number[] = [];
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    initialDataEpoch: replayDigest("c"),
    baseUrl: "ws://example.test",
    timers,
    socketFactory: () => socket,
    onEvent: (event) => events.push(event.sequence),
  });
  controller.start();
  socket.open();
  socket.message(replaySnapshotEvent());
  const forged = replayDeltaEvent({ sequence: 3, sourceSequence: 999 });
  Object.assign(forged, { sequence_from: 1, sequence_to: 3 });
  socket.message(forged);

  assert.deepEqual(events, []);
  assert.equal(controller.diagnostics().lastSequence, 0);
  assert.equal(controller.diagnostics().state, "resyncing");
  controller.stop();
});

test("coalesced ranges reject projections that do not advance beyond the previous source cursor", () => {
  const timers = new FakeTimers();
  const socket = new FakeSocket();
  const controller = new ReplayStreamController({
    sessionId: "session-0001",
    initialDataEpoch: replayDigest("c"),
    baseUrl: "ws://example.test",
    timers,
    socketFactory: () => socket,
  });
  controller.start();
  socket.open();
  socket.message(replaySnapshotEvent());
  const staleProjection = replayDeltaEvent({ sequence: 3, sourceSequence: 3 });
  Object.assign(staleProjection, { sequence_from: 1, sequence_to: 3 });
  const projection = staleProjection.data.projection as {
    bar_update: { action: string; source_sequence: number } | null;
  };
  if (projection.bar_update && projection.bar_update.action !== "batch") {
    projection.bar_update.source_sequence = 0;
  }
  socket.message(staleProjection);

  assert.equal(controller.diagnostics().lastSequence, 0);
  assert.equal(controller.diagnostics().state, "resyncing");
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

test("controller conflict resyncs so a terminal snapshot can cross a heartbeat race", () => {
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
  const states: string[] = [];
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
    onSnapshot: (snapshot) => states.push(snapshot.state),
    onError: (error) => errors.push({ code: error.code, fatal: error.fatal }),
  });
  controller.start();
  sockets[0]?.open();
  sockets[0]?.message(replaySnapshotEvent());
  sockets[0]?.message({
    protocol: "replay.v1",
    error: {
      code: "CONTROLLER_CONFLICT",
      message: "client does not own the replay controller lease",
      details: { controller_client_id: null },
    },
  });

  assert.equal(controller.diagnostics().state, "resyncing");
  assert.deepEqual(errors, [{ code: "CONTROLLER_CONFLICT", fatal: false }]);
  timers.runAll();
  assert.equal(sockets.length, 2);

  const terminal = replaySnapshotEvent({
    sequence: 1,
    revision: 1,
    state: "ENDED",
  });
  terminal.data.snapshot.cursor.at_end = true;
  terminal.data.snapshot.components.ended = true;
  sockets[1]?.open();
  sockets[1]?.message(terminal);

  assert.deepEqual(states, ["PAUSED", "ENDED"]);
  assert.equal(controller.diagnostics().state, "connected");
  controller.stop();
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
