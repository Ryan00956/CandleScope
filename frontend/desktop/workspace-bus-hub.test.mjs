import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkspaceBusConflictError,
  WorkspaceBusHub,
} from "./workspace-bus-hub.mjs";

function snapshot(revision = 0, symbol = "BTCUSDT", schemaVersion = 7) {
  return {
    activeWorkspaceId: "workspace-default",
    workspaces: [{
      id: "workspace-default",
      name: "Default",
      createdAt: 1,
      updatedAt: revision + 1,
      document: {
        schemaVersion,
        revision,
        activeWindowId: "main-window",
        windows: { "main-window": { id: "main-window" } },
        cells: { "cell-1": { id: "cell-1", session: { symbol } } },
        linkGroups: {},
      },
    }],
  };
}

test("WorkspaceBus accepts current v7 snapshots and the v6 migration boundary", () => {
  for (const schemaVersion of [6, 7]) {
    const hub = new WorkspaceBusHub();
    hub.register("main-window", () => {});
    assert.equal(hub.connect("main-window", snapshot(0, "BTCUSDT", schemaVersion)).ready, true);
  }
});

test("main window bootstraps one authoritative snapshot and secondary receives it", () => {
  const messages = [];
  const hub = new WorkspaceBusHub();
  hub.register("window-2", (message) => messages.push(["window-2", message]));
  assert.equal(hub.connect("window-2", snapshot()).ready, false);
  hub.register("main-window", (message) => messages.push(["main-window", message]));
  const connected = hub.connect("main-window", snapshot());
  assert.equal(connected.ready, true);
  assert.equal(connected.writerWindowId, "main-window");
  assert.equal(messages.some(([id, message]) => id === "window-2" && message.type === "snapshot"), true);
});

test("revision CAS accepts one writer and rejects a stale peer with authoritative details", () => {
  const hub = new WorkspaceBusHub();
  hub.register("main-window", () => {});
  hub.register("window-2", () => {});
  const base = hub.connect("main-window", snapshot());
  const committed = hub.commit("window-2", {
    expectedSequence: base.sequence,
    expectedRevisions: base.revisions,
    snapshot: snapshot(1, "ETHUSDT"),
  });
  assert.equal(committed.sequence, 1);
  assert.throws(() => hub.commit("main-window", {
    expectedSequence: base.sequence,
    expectedRevisions: base.revisions,
    snapshot: snapshot(1, "SOLUSDT"),
  }), (error) => (
    error instanceof WorkspaceBusConflictError
    && error.details.actualSequence === 1
    && error.details.actualRevisions["workspace-default"] === 1
  ));
  assert.equal(hub.diagnostics().counts.conflicts, 1);
});

test("stale disjoint window patches rebase without losing either update", () => {
  const base = snapshot();
  const document = base.workspaces[0].document;
  document.windows["window-2"] = { id: "window-2", layoutLocked: false };
  document.cells["cell-2"] = { id: "cell-2", session: { symbol: "BTCUSDT" } };
  const mainEdit = structuredClone(base);
  mainEdit.workspaces[0].document.revision = 1;
  mainEdit.workspaces[0].document.windows["main-window"].layoutLocked = true;
  const secondaryEdit = structuredClone(base);
  secondaryEdit.workspaces[0].document.revision = 1;
  secondaryEdit.workspaces[0].document.windows["window-2"].layoutLocked = true;

  const hub = new WorkspaceBusHub({ now: () => 10 });
  hub.register("main-window", () => {});
  hub.register("window-2", () => {});
  const connected = hub.connect("main-window", base);
  hub.commit("main-window", {
    expectedSequence: connected.sequence,
    expectedRevisions: connected.revisions,
    baseSnapshot: base,
    snapshot: mainEdit,
  });
  const rebased = hub.commit("window-2", {
    expectedSequence: connected.sequence,
    expectedRevisions: connected.revisions,
    baseSnapshot: base,
    snapshot: secondaryEdit,
  });
  const merged = rebased.snapshot.workspaces[0].document;
  assert.equal(merged.windows["main-window"].layoutLocked, true);
  assert.equal(merged.windows["window-2"].layoutLocked, true);
  assert.equal(merged.revision, 2);
  assert.equal(hub.diagnostics().counts.rebases, 1);
  assert.equal(hub.diagnostics().counts.conflicts, 0);
});

test("crosshair storms coalesce without changing persistent sequence", () => {
  let now = 100;
  let timer = null;
  const received = [];
  const hub = new WorkspaceBusHub({
    now: () => now,
    setTimer: (callback) => { timer = callback; return 1; },
    clearTimer: () => { timer = null; },
  });
  hub.register("main-window", () => {});
  hub.register("window-2", (message) => received.push(message));
  const base = hub.connect("main-window", snapshot());
  const event = (time) => ({
    workspaceId: "workspace-default",
    sourceWindowId: "main-window",
    sourceCellId: "cell-1",
    kind: "crosshair",
    payload: { time },
  });
  assert.equal(hub.publishLink("main-window", event(1)).coalesced, false);
  now += 1;
  assert.equal(hub.publishLink("main-window", event(2)).coalesced, true);
  assert.equal(hub.publishLink("main-window", event(3)).coalesced, true);
  now += 32;
  timer();
  assert.deepEqual(received.filter((message) => message.type === "link").map((message) => message.event.payload.time), [1, 3]);
  assert.equal(hub.diagnostics().sequence, base.sequence);
  assert.equal(hub.diagnostics().counts.commits, 0);
});

test("window crash removes health, pending events, and elects a recoverable writer", () => {
  const hub = new WorkspaceBusHub();
  hub.register("main-window", () => {});
  hub.register("window-2", () => {});
  hub.connect("main-window", snapshot());
  assert.equal(hub.disconnect("main-window"), true);
  assert.equal(hub.diagnostics().writerWindowId, "window-2");
  assert.equal(hub.register("main-window", () => {}).writerWindowId, "main-window");
  assert.equal(hub.connect("main-window", snapshot()).snapshot.workspaces[0].document.revision, 0);
});
