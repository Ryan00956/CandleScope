import assert from "node:assert/strict";
import test from "node:test";

import { buildDesktopPhase6ReleaseEvidence } from "./desktop-phase6-release.mjs";

function probe(mode, displayCount) {
  return {
    result: "pass",
    probeMode: mode,
    selection: { selected: "Electron" },
    shell: {
      windowCount: 4,
      singleInstanceLock: true,
      displays: Array.from({ length: displayCount }, (_, id) => ({ id })),
    },
    sidecar: { running: true, readyMs: 1234 },
    lifecycle: { result: "pass" },
    closeIsolation: { result: "pass" },
    observations: Array.from({ length: 4 }, (_, index) => ({
      windowId: index === 0 ? "main-window" : `window-${index + 1}`,
      visible: true,
      minimized: false,
      boundsDip: { x: 0, y: 0, width: 800, height: 600 },
      renderer: {
        chartRoots: 1,
        canvasCount: 2,
        hasRightRail: true,
        hasExportControl: true,
      },
    })),
    limitations: [],
  };
}

test("one-display implementation evidence stays honest about the physical release blocker", () => {
  const packaged = probe("create", 1);
  packaged.shell.packaged = true;
  const evidence = buildDesktopPhase6ReleaseEvidence(
    probe("create", 1),
    probe("restore", 1),
    packaged,
  );
  assert.equal(evidence.result, "implementation-pass-hardware-pending");
  assert.equal(evidence.gates.physicalFourDisplays, "pending");
});

test("four-display evidence can pass only when every implementation gate already passes", () => {
  const packaged = probe("create", 4);
  packaged.shell.packaged = true;
  const evidence = buildDesktopPhase6ReleaseEvidence(
    probe("create", 4),
    probe("restore", 4),
    packaged,
  );
  assert.equal(evidence.result, "pass");
  assert.equal(evidence.gates.physicalFourDisplays, "pass");
});
