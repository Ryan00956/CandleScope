import assert from "node:assert/strict";
import test from "node:test";

import { resetChartWorkspaceDocumentLayout, splitChartWorkspaceDocument } from "../chartWorkspaceEditing.js";
import { commitChartWorkspaceDocument } from "../chartWorkspaceDocument.js";
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

test("scoped layout commits restore the document active window", () => {
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
    (current) => splitChartWorkspaceDocument(current, "cell-window-2-primary", "columns", "blank"),
  );
  assert.ok(scopedEdit);
  assert.equal(scopedEdit.result.document.activeWindowId, "window-2");
  const committed = commitChartWorkspaceDocument(activeMain, scopedEdit.result.document);
  assert.equal(committed.activeWindowId, "main-window");
  assert.equal(committed.revision, activeMain.revision + 1);
});
