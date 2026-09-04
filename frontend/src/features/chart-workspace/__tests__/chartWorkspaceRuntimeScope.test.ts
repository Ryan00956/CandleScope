import assert from "node:assert/strict";
import test from "node:test";

import { resetChartWorkspaceDocumentLayout } from "../chartWorkspaceEditing.js";
import { createDefaultChartWorkspace } from "../chartWorkspaceStorage.js";
import { runScopedChartWorkspaceLayoutEdit } from "../useChartWorkspaceRuntime.js";
import { createChartWorkspaceWindowCandidate } from "../chartWorkspaceWindows.js";

test("a secondary-window no-op does not produce a runtime layout edit", () => {
  const withSecondaryWindow = createChartWorkspaceWindowCandidate(
    createDefaultChartWorkspace(),
    {
      createWindowId: () => "window-2",
      createCellId: () => "cell-window-2-primary",
    },
  );
  const activeMain = { ...withSecondaryWindow, activeWindowId: "main-window" };

  const scopedEdit = runScopedChartWorkspaceLayoutEdit(
    activeMain,
    "window-2",
    (current) => resetChartWorkspaceDocumentLayout(current),
  );

  assert.equal(scopedEdit, null);
  assert.equal(activeMain.revision, withSecondaryWindow.revision);
});
