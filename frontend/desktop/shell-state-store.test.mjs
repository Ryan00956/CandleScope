import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DesktopShellStateStore,
  DesktopTopologyRevisionConflictError,
  compareAndSwapShellState,
  emptyShellState,
} from "./shell-state-store.mjs";

function stateAt(revision, windowIds = ["main-window"]) {
  return {
    schemaVersion: "candlescope.desktop-shell-state/1",
    workspaceId: "workspace-default",
    workspaceRevision: revision,
    activeWindowId: windowIds[0],
    windows: Object.fromEntries(windowIds.map((id) => [id, {
      id,
      boundsDip: { x: 0, y: 0, width: 1280, height: 800 },
    }])),
  };
}

test("topology CAS rejects a stale renderer revision", () => {
  const current = stateAt(7);
  assert.throws(
    () => compareAndSwapShellState(current, 6, stateAt(8)),
    (error) => error instanceof DesktopTopologyRevisionConflictError
      && error.expectedRevision === 6
      && error.actualRevision === 7,
  );
});

test("shell store writes an atomic restorable projection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "candlescope-shell-state-"));
  const filePath = path.join(root, "desktop-windows.json");
  const store = new DesktopShellStateStore(filePath);
  assert.deepEqual(await store.load(), emptyShellState());
  await store.compareAndSwap(-1, stateAt(3, ["main-window", "window-2"]));
  const reloaded = new DesktopShellStateStore(filePath);
  assert.deepEqual(await reloaded.load(), stateAt(3, ["main-window", "window-2"]));
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).workspaceRevision, 3);
});

test("normalization caps untrusted persisted topology at four windows", () => {
  const oversized = stateAt(1, ["w1", "w2", "w3", "w4", "w5"]);
  const committed = compareAndSwapShellState(emptyShellState(), -1, oversized);
  assert.deepEqual(Object.keys(committed.windows), ["w1", "w2", "w3", "w4"]);
});
