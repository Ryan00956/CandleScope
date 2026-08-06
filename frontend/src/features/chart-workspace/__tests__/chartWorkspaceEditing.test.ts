import assert from "node:assert/strict";
import test from "node:test";

import {
  CHART_WORKSPACE_LAYOUT_HISTORY_LIMIT,
  applyChartWorkspaceLayoutUndo,
  closeChartWorkspaceDocument,
  createEmptyChartWorkspaceLayoutHistory,
  createChartWorkspaceLayoutUndoEntry,
  recordChartWorkspaceLayoutEdit,
  redoChartWorkspaceLayoutEdit,
  resetChartWorkspaceDocumentLayout,
  splitChartWorkspaceDocument,
  swapChartWorkspaceDocumentCells,
  undoChartWorkspaceLayoutEdit,
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

test("bounded layout history supports repeated undo and redo in stack order", () => {
  let document = createDefaultChartWorkspace();
  let history = createEmptyChartWorkspaceLayoutHistory();
  const apply = (result: ReturnType<typeof splitChartWorkspaceDocument>) => {
    history = recordChartWorkspaceLayoutEdit(history, document, result);
    document = result.document;
  };

  apply(splitChartWorkspaceDocument(document, "cell-1", "columns", "copy"));
  apply(splitChartWorkspaceDocument(document, "cell-2", "rows", "blank"));
  apply(swapChartWorkspaceDocumentCells(document, "cell-1", "cell-3"));
  assert.deepEqual(visibleCellIds(document.layoutTree), ["cell-3", "cell-2", "cell-1"]);
  assert.equal(history.past.length, 3);

  const undoSwap = undoChartWorkspaceLayoutEdit(document, history);
  assert.ok(undoSwap);
  ({ document, history } = undoSwap);
  assert.deepEqual(visibleCellIds(document.layoutTree), ["cell-1", "cell-2", "cell-3"]);

  const undoThirdCell = undoChartWorkspaceLayoutEdit(document, history);
  assert.ok(undoThirdCell);
  ({ document, history } = undoThirdCell);
  assert.deepEqual(visibleCellIds(document.layoutTree), ["cell-1", "cell-2"]);
  assert.equal(history.future.length, 2);

  const redoThirdCell = redoChartWorkspaceLayoutEdit(document, history);
  assert.ok(redoThirdCell);
  ({ document, history } = redoThirdCell);
  assert.deepEqual(visibleCellIds(document.layoutTree), ["cell-1", "cell-2", "cell-3"]);
  assert.equal(history.past.length, 2);
  assert.equal(history.future.length, 1);

  const close = closeChartWorkspaceDocument(document, "cell-2");
  history = recordChartWorkspaceLayoutEdit(history, document, close);
  assert.equal(history.future.length, 0);
});

test("layout history retains only the most recent bounded edit steps", () => {
  let document = createDefaultChartWorkspace();
  let history = createEmptyChartWorkspaceLayoutHistory();
  const split = splitChartWorkspaceDocument(document, "cell-1", "columns", "copy");
  history = recordChartWorkspaceLayoutEdit(history, document, split);
  document = split.document;

  for (let index = 0; index < CHART_WORKSPACE_LAYOUT_HISTORY_LIMIT + 7; index += 1) {
    const swap = swapChartWorkspaceDocumentCells(document, "cell-1", "cell-2");
    history = recordChartWorkspaceLayoutEdit(history, document, swap);
    document = swap.document;
  }

  assert.equal(history.past.length, CHART_WORKSPACE_LAYOUT_HISTORY_LIMIT);
  assert.equal(history.future.length, 0);
});

test("redo restores cell edits captured after a copy split was undone", () => {
  const before = createDefaultChartWorkspace();
  const split = splitChartWorkspaceDocument(before, "cell-1", "columns", "copy");
  let history = recordChartWorkspaceLayoutEdit(
    createEmptyChartWorkspaceLayoutHistory(),
    before,
    split,
  );
  let document = {
    ...split.document,
    cells: {
      ...split.document.cells,
      "cell-2": {
        ...split.document.cells["cell-2"],
        session: { ...split.document.cells["cell-2"].session, interval: "5m" },
      },
    },
  };

  const undo = undoChartWorkspaceLayoutEdit(document, history);
  assert.ok(undo);
  ({ document, history } = undo);
  assert.deepEqual(visibleCellIds(document.layoutTree), ["cell-1"]);
  assert.notEqual(document.cells["cell-2"].session.interval, "5m");

  const redo = redoChartWorkspaceLayoutEdit(document, history);
  assert.ok(redo);
  ({ document, history } = redo);
  assert.deepEqual(visibleCellIds(document.layoutTree), ["cell-1", "cell-2"]);
  assert.equal(document.cells["cell-2"].session.interval, "5m");
});

test("locked documents reject every structural edit and history traversal", () => {
  const unlocked = createDefaultChartWorkspace();
  const split = splitChartWorkspaceDocument(unlocked, "cell-1", "columns", "copy");
  const history = recordChartWorkspaceLayoutEdit(
    createEmptyChartWorkspaceLayoutHistory(),
    unlocked,
    split,
  );
  const locked = { ...split.document, layoutLocked: true };

  assert.equal(splitChartWorkspaceDocument(locked, "cell-2", "rows", "copy").document, locked);
  assert.equal(closeChartWorkspaceDocument(locked, "cell-2").document, locked);
  assert.equal(swapChartWorkspaceDocumentCells(locked, "cell-1", "cell-2").document, locked);
  assert.equal(resetChartWorkspaceDocumentLayout(locked).document, locked);
  assert.equal(undoChartWorkspaceLayoutEdit(locked, history), null);
  assert.equal(redoChartWorkspaceLayoutEdit(locked, history), null);
});
