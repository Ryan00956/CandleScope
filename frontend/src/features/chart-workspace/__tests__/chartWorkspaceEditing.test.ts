import assert from "node:assert/strict";
import test from "node:test";

import {
  applyChartWorkspaceLayoutUndo,
  closeChartWorkspaceDocument,
  createChartWorkspaceLayoutUndoEntry,
  resetChartWorkspaceDocumentLayout,
  splitChartWorkspaceDocument,
  swapChartWorkspaceDocumentCells,
} from "../chartWorkspaceEditing.js";
import { visibleCellIds } from "../chartWorkspaceLayout.js";
import { createDefaultChartWorkspace } from "../chartWorkspaceStorage.js";

test("copy split duplicates cell configuration into the first unused stable cell", () => {
  const document = createDefaultChartWorkspace();
  document.cells["cell-1"].linkGroup = "B";
  document.cells["cell-1"].indicators = [{ id: "copy-me", params: { length: 21 } }];
  const result = splitChartWorkspaceDocument(document, "cell-1", "columns", "copy");

  assert.deepEqual(visibleCellIds(result.document.layoutTree), ["cell-1", "cell-2"]);
  assert.equal(result.document.activeCellId, "cell-2");
  assert.deepEqual(result.restoreCellIds, ["cell-2"]);
  assert.equal(result.document.cells["cell-2"].linkGroup, "B");
  assert.deepEqual(result.document.cells["cell-2"].session, document.cells["cell-1"].session);
  assert.deepEqual(result.document.cells["cell-2"].indicators, document.cells["cell-1"].indicators);
  assert.notEqual(result.document.cells["cell-2"].indicators, document.cells["cell-1"].indicators);
});

test("blank split keeps market context while clearing links, indicators, and price transforms", () => {
  const document = createDefaultChartWorkspace();
  document.cells["cell-1"].linkGroup = "C";
  document.cells["cell-1"].priceScale = { invertScale: true, priceScaleMode: 2 };
  document.cells["cell-1"].indicators = [{ id: "do-not-copy" }];
  const result = splitChartWorkspaceDocument(document, "cell-1", "rows", "blank");
  const blank = result.document.cells["cell-2"];

  assert.deepEqual(blank.session, document.cells["cell-1"].session);
  assert.equal(blank.linkGroup, null);
  assert.equal(blank.linkRole, "bidirectional");
  assert.deepEqual(blank.indicators, []);
  assert.deepEqual(blank.priceScale, { invertScale: false, priceScaleMode: 0 });
});

test("close collapses parent splits without deleting the hidden cell state", () => {
  const document = createDefaultChartWorkspace();
  const first = splitChartWorkspaceDocument(document, "cell-1", "columns", "copy").document;
  const second = splitChartWorkspaceDocument(first, "cell-2", "rows", "copy").document;
  const closedCell = second.cells["cell-2"];
  const result = closeChartWorkspaceDocument(second, "cell-2");

  assert.deepEqual(visibleCellIds(result.document.layoutTree), ["cell-1", "cell-3"]);
  assert.equal(result.document.activeCellId, "cell-3");
  assert.equal(result.document.cells["cell-2"], closedCell);
});

test("swap moves stable cell identities in the tree without exchanging their state", () => {
  const document = splitChartWorkspaceDocument(
    createDefaultChartWorkspace(),
    "cell-1",
    "columns",
    "copy",
  ).document;
  const firstState = document.cells["cell-1"];
  const secondState = document.cells["cell-2"];
  const result = swapChartWorkspaceDocumentCells(document, "cell-1", "cell-2");

  assert.deepEqual(visibleCellIds(result.document.layoutTree), ["cell-2", "cell-1"]);
  assert.equal(result.document.cells["cell-1"], firstState);
  assert.equal(result.document.cells["cell-2"], secondState);
});

test("one-step undo restores overwritten new-cell state but preserves later source edits", () => {
  const before = createDefaultChartWorkspace();
  const previousCellTwo = structuredClone(before.cells["cell-2"]);
  const split = splitChartWorkspaceDocument(before, "cell-1", "columns", "copy");
  const undo = createChartWorkspaceLayoutUndoEntry(before, split.restoreCellIds);
  const afterUserEdit = {
    ...split.document,
    cells: {
      ...split.document.cells,
      "cell-1": {
        ...split.document.cells["cell-1"],
        session: { ...split.document.cells["cell-1"].session, interval: "5m" },
      },
    },
  };
  const restored = applyChartWorkspaceLayoutUndo(afterUserEdit, undo);

  assert.deepEqual(visibleCellIds(restored.layoutTree), ["cell-1"]);
  assert.equal(restored.cells["cell-1"].session.interval, "5m");
  assert.deepEqual(restored.cells["cell-2"], previousCellTwo);
});

test("reset keeps the current active chart as the sole mounted cell", () => {
  const split = splitChartWorkspaceDocument(
    createDefaultChartWorkspace(),
    "cell-1",
    "columns",
    "copy",
  ).document;
  assert.equal(split.activeCellId, "cell-2");
  const reset = resetChartWorkspaceDocumentLayout(split);
  assert.deepEqual(visibleCellIds(reset.document.layoutTree), ["cell-2"]);
  assert.equal(reset.document.activeCellId, "cell-2");
});
