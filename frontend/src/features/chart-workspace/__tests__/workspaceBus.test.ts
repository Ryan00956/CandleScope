import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultChartWorkspaceRecord } from "../chartWorkspaceLibrary.js";
import { WorkspaceBusClient } from "../workspaceBus.js";

test("native WorkspaceBus forwards exact CAS authority and adopts conflict snapshots", async () => {
  const originalWindow = globalThis.window;
  const record = createDefaultChartWorkspaceRecord(1);
  const snapshot = { activeWorkspaceId: record.id, workspaces: [record] };
  const events = new Set<(value: unknown) => void>();
  const commits: unknown[] = [];
  let sequence = 0;
  const bridge = {
    onWorkspaceBusEvent(listener: (value: unknown) => void) {
      events.add(listener);
      return () => { events.delete(listener); };
    },
    workspaceBusConnect: async () => ({
      ok: true,
      ready: true,
      sequence,
      writerWindowId: "main-window",
      revisions: { [record.id]: 0 },
      snapshot,
    }),
    workspaceBusCommit: async (payload: unknown) => {
      commits.push(payload);
      sequence += 1;
      return {
        ok: true,
        ready: true,
        sequence,
        writerWindowId: "main-window",
        revisions: { [record.id]: 1 },
        snapshot,
      };
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { candlescopeDesktop: bridge },
  });
  try {
    const bus = new WorkspaceBusClient("main-window");
    const connected = await bus.connect(snapshot);
    assert.equal(connected.sequence, 0);
    await bus.commit(snapshot);
    assert.deepEqual(commits, [{
      expectedSequence: 0,
      expectedRevisions: { [record.id]: 0 },
      baseSnapshot: snapshot,
      snapshot,
    }]);
    bus.dispose();
  } finally {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("native WorkspaceBus bootstraps before an early autosave commit", async () => {
  const originalWindow = globalThis.window;
  const record = createDefaultChartWorkspaceRecord(1);
  const snapshot = { activeWorkspaceId: record.id, workspaces: [record] };
  const calls: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      candlescopeDesktop: {
        onWorkspaceBusEvent: () => () => undefined,
        workspaceBusConnect: async () => {
          calls.push("connect");
          return {
            ok: true,
            ready: true,
            sequence: 0,
            writerWindowId: "main-window",
            revisions: { [record.id]: 0 },
            snapshot,
          };
        },
        workspaceBusCommit: async () => {
          calls.push("commit");
          return {
            ok: true,
            ready: true,
            sequence: 1,
            writerWindowId: "main-window",
            revisions: { [record.id]: 0 },
            snapshot,
          };
        },
      },
    },
  });
  try {
    const bus = new WorkspaceBusClient("main-window");
    const committed = await bus.commit(snapshot);
    assert.equal(committed.ready, true);
    assert.deepEqual(calls, ["connect", "commit"]);
  } finally {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("WorkspaceBus delivers remote link events without persisting them", async () => {
  const originalWindow = globalThis.window;
  const listeners = new Set<(value: unknown) => void>();
  const record = createDefaultChartWorkspaceRecord(1);
  const snapshot = { activeWorkspaceId: record.id, workspaces: [record] };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      candlescopeDesktop: {
        onWorkspaceBusEvent(next: (value: unknown) => void) {
          listeners.add(next);
          return () => { listeners.delete(next); };
        },
        workspaceBusConnect: async () => ({
          ok: true,
          ready: true,
          sequence: 7,
          writerWindowId: "main-window",
          revisions: { [record.id]: 0 },
          snapshot,
        }),
      },
    },
  });
  try {
    const bus = new WorkspaceBusClient("window-2");
    await bus.connect(snapshot);
    const links: unknown[] = [];
    bus.subscribeLink((event) => links.push(event));
    for (const listener of listeners) listener({
      type: "link",
      event: {
        eventId: "link-1",
        workspaceId: record.id,
        sourceWindowId: "main-window",
        sourceCellId: "cell-1",
        kind: "crosshair",
        payload: { time: 123 },
      },
    });
    assert.equal(links.length, 1);
    assert.equal(bus.current.sequence, 7);
  } finally {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});
