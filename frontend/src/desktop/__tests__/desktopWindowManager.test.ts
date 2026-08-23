import assert from "node:assert/strict";
import test from "node:test";

import {
  DesktopWindowManager,
  desktopTopologyFromDocument,
  requestedDesktopWindowId,
  type DesktopBootstrap,
  type DesktopTopologyPayload,
} from "../desktopWindowManager.js";
import { createDefaultChartWorkspace } from "../../features/chart-workspace/chartWorkspaceStorage.js";

test("web URLs always fail closed to main-window when no valid projection exists", () => {
  assert.equal(requestedDesktopWindowId(""), "main-window");
  assert.equal(requestedDesktopWindowId("?windowId=window-2"), "window-2");
  assert.equal(requestedDesktopWindowId(`?windowId=${"x".repeat(129)}`), "main-window");
});

test("topology projection excludes cell, indicator, and drawing state from shell IPC", () => {
  const document = createDefaultChartWorkspace();
  const topology = desktopTopologyFromDocument("workspace-default", document, -1);
  assert.equal(topology.workspaceRevision, document.revision);
  assert.deepEqual(Object.keys(topology.windows), ["main-window"]);
  assert.deepEqual(Object.keys(topology.windows["main-window"]!).sort(), [
    "boundsDip",
    "dpiScale",
    "id",
    "monitorFingerprint",
    "windowState",
  ]);
  assert.equal("cells" in topology, false);
});

test("reconcile uses the latest acknowledged shell revision after bootstrap", async () => {
  const globalRef = globalThis as typeof globalThis & { window?: Window };
  const originalWindow = globalRef.window;
  const expectedRevisions: number[] = [];
  const bootstrap: DesktopBootstrap = {
    mode: "native",
    multiWindowAvailable: true,
    multiWindowEnabled: true,
    windowId: "main-window",
    workspaceId: "workspace-default",
    shellRevision: -1,
    displayCount: 1,
    logsPath: null,
    sidecar: null,
  };
  const bridge = {
    getBootstrap: async () => bootstrap,
    reconcileWorkspace: async (payload: DesktopTopologyPayload) => {
      expectedRevisions.push(payload.expectedShellRevision);
      return { ok: true, shellRevision: payload.workspaceRevision };
    },
  } as NonNullable<Window["candlescopeDesktop"]>;
  Object.defineProperty(globalRef, "window", {
    configurable: true,
    value: { candlescopeDesktop: bridge },
  });

  try {
    const manager = new DesktopWindowManager();
    const first = createDefaultChartWorkspace();
    const second = { ...first, revision: first.revision + 1 };
    await manager.reconcileWorkspace("workspace-default", first);
    await manager.reconcileWorkspace("workspace-default", second);
    assert.deepEqual(expectedRevisions, [-1, first.revision]);
  } finally {
    if (originalWindow === undefined) delete globalRef.window;
    else Object.defineProperty(globalRef, "window", { configurable: true, value: originalWindow });
  }
});
