import assert from "node:assert/strict";
import test from "node:test";

import { ChartWorkspaceRevisionConflictError } from "../chartWorkspaceDocument.js";
import { createDefaultChartWorkspace } from "../chartWorkspaceStorage.js";
import {
  closeChartWorkspaceWindow,
  createChartWorkspaceWindow,
  updateChartWorkspaceWindowPlacementCandidate,
} from "../chartWorkspaceWindows.js";

test("four native windows clone stable independent cells and a fifth fails closed", () => {
  let document = createDefaultChartWorkspace();
  let windowSequence = 2;
  let cellSequence = 100;
  for (let index = 0; index < 3; index += 1) {
    document = createChartWorkspaceWindow(document, document.revision, {
      sourceWindowId: "main-window",
      createWindowId: () => `window-${windowSequence++}`,
      createCellId: () => `cell-${cellSequence++}`,
    });
  }
  assert.equal(document.revision, 3);
  assert.deepEqual(Object.keys(document.windows), ["main-window", "window-2", "window-3", "window-4"]);
  assert.equal(new Set(Object.keys(document.cells)).size, Object.keys(document.cells).length);
  assert.strictEqual(
    createChartWorkspaceWindow(document, document.revision, {
      createWindowId: () => "window-5",
      createCellId: () => "cell-999",
    }),
    document,
  );
});

test("create and close use revision CAS and remove only unreferenced cloned cells", () => {
  const original = createDefaultChartWorkspace();
  const created = createChartWorkspaceWindow(original, 0, {
    createWindowId: () => "window-2",
    createCellId: () => "cell-20",
  });
  assert.throws(
    () => closeChartWorkspaceWindow(created, 0, "window-2"),
    ChartWorkspaceRevisionConflictError,
  );
  const closed = closeChartWorkspaceWindow(created, created.revision, "window-2");
  assert.equal(closed.windows["window-2"], undefined);
  assert.equal(closed.cells["cell-20"], undefined);
  assert.deepEqual(Object.keys(closed.cells).sort(), Object.keys(original.cells).sort());
});

test("placement update preserves layout and records negative DIP coordinates", () => {
  const document = createDefaultChartWorkspace();
  const updated = updateChartWorkspaceWindowPlacementCandidate(document, "main-window", {
    boundsDip: { x: -1440, y: -80, width: 1200, height: 760 },
    monitorFingerprint: "display-external",
    dpiScale: 1.25,
    windowState: "maximized",
  });
  assert.strictEqual(updated.windows["main-window"]!.layoutTree, document.windows["main-window"]!.layoutTree);
  assert.equal(updated.windows["main-window"]!.boundsDip?.x, -1440);
  assert.equal(updated.windows["main-window"]!.dpiScale, 1.25);
});
