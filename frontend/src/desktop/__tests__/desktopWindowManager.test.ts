import assert from "node:assert/strict";
import test from "node:test";

import {
  desktopTopologyFromDocument,
  requestedDesktopWindowId,
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
