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
  setChartWorkspaceDocumentLayout,
  splitChartWorkspaceDocument,
  swapChartWorkspaceDocumentCells,
  undoChartWorkspaceLayoutEdit,
  type ChartWorkspaceEditOptions,
} from "../chartWorkspaceEditing.js";
import { activeChartWorkspaceWindow, chartWorkspaceCell, replaceChartWorkspaceWindow } from "../chartWorkspaceDocument.js";
import { visibleCellIds } from "../chartWorkspaceLayout.js";
import { createDefaultChartWorkspace } from "../chartWorkspaceStorage.js";
import {
  DEFAULT_CHART_LINK_GROUP_ID,
  type ChartCellId,
  type ChartWorkspaceDocument,
} from "../chartWorkspaceTypes.js";

const windowOf = (document: ChartWorkspaceDocument) => activeChartWorkspaceWindow(document);
const cellOf = (document: ChartWorkspaceDocument, id: ChartCellId) => chartWorkspaceCell(document, id);
const visible = (document: ChartWorkspaceDocument) => visibleCellIds(windowOf(document).layoutTree);

test("copy split duplicates cell configuration into the first unused stable cell", () => {
  const document = createDefaultChartWorkspace();
  cellOf(document, "cell-1").linkGroupId = DEFAULT_CHART_LINK_GROUP_ID;
  cellOf(document, "cell-1").indicators = [{ id: "copy-me", params: { length: 21 } }];
  cellOf(document, "cell-1").strategyAttachment = {
    schemaVersion: 1,
    strategyDraftId: "draft-12345678",
    strategyRevisionId: "revision-1",
    displayName: "Copy me",
    language: "pyne",
    parameters: { length: 21 },
    rangeMode: "ALL_AVAILABLE",
    customRange: null,
    fidelityPreference: "FAST",
    quickPresetId: "CRYPTO_PERP_STANDARD_V1",
    autoRun: false,
  };
  const result = splitChartWorkspaceDocument(document, "cell-1", "columns", "copy");

  assert.deepEqual(visible(result.document), ["cell-1", "cell-2"]);
  assert.equal(windowOf(result.document).activeCellId, "cell-2");
  assert.deepEqual(result.restoreCellIds, ["cell-2"]);
  assert.equal(cellOf(result.document, "cell-2").linkGroupId, DEFAULT_CHART_LINK_GROUP_ID);
  assert.deepEqual(cellOf(result.document, "cell-2").session, cellOf(document, "cell-1").session);
  assert.deepEqual(cellOf(result.document, "cell-2").indicators, cellOf(document, "cell-1").indicators);
  assert.notEqual(cellOf(result.document, "cell-2").indicators, cellOf(document, "cell-1").indicators);
  assert.deepEqual(
    cellOf(result.document, "cell-2").strategyAttachment,
    cellOf(document, "cell-1").strategyAttachment,
  );
  assert.notEqual(
    cellOf(result.document, "cell-2").strategyAttachment,
    cellOf(document, "cell-1").strategyAttachment,
  );
});

test("blank split keeps market context while clearing links, indicators, and price transforms", () => {
  const document = createDefaultChartWorkspace();
  cellOf(document, "cell-1").linkGroupId = DEFAULT_CHART_LINK_GROUP_ID;
  cellOf(document, "cell-1").priceScale = { invertScale: true, priceScaleMode: 2 };
  cellOf(document, "cell-1").indicators = [{ id: "do-not-copy" }];
  cellOf(document, "cell-1").strategyAttachment = {
    schemaVersion: 1,
    strategyDraftId: "draft-12345678",
    strategyRevisionId: null,
    displayName: "Do not copy",
    language: "pine",
    parameters: {},
    rangeMode: "VISIBLE",
    customRange: null,
    fidelityPreference: "FAST",
    quickPresetId: "CRYPTO_PERP_STANDARD_V1",
    autoRun: false,
  };
  const result = splitChartWorkspaceDocument(document, "cell-1", "rows", "blank");
  const blank = cellOf(result.document, "cell-2");

  assert.deepEqual(blank.session, cellOf(document, "cell-1").session);
  assert.equal(blank.linkGroupId, null);
  assert.deepEqual(blank.indicators, []);
  assert.deepEqual(blank.priceScale, { invertScale: false, priceScaleMode: 0 });
  assert.equal(blank.strategyAttachment, null);
});

test("close collapses parent splits without deleting the hidden cell state", () => {
  const first = splitChartWorkspaceDocument(createDefaultChartWorkspace(), "cell-1", "columns", "copy").document;
  const second = splitChartWorkspaceDocument(first, "cell-2", "rows", "copy").document;
  const closedCell = cellOf(second, "cell-2");
  const result = closeChartWorkspaceDocument(second, "cell-2");

  assert.deepEqual(visible(result.document), ["cell-1", "cell-3"]);
  assert.equal(windowOf(result.document).activeCellId, "cell-3");
  assert.equal(cellOf(result.document, "cell-2"), closedCell);
});

test("swap moves stable cell identities in the tree without exchanging their state", () => {
  const document = splitChartWorkspaceDocument(createDefaultChartWorkspace(), "cell-1", "columns", "copy").document;
  const firstState = cellOf(document, "cell-1");
  const secondState = cellOf(document, "cell-2");
  const result = swapChartWorkspaceDocumentCells(document, "cell-1", "cell-2");

  assert.deepEqual(visible(result.document), ["cell-2", "cell-1"]);
  assert.equal(cellOf(result.document, "cell-1"), firstState);
  assert.equal(cellOf(result.document, "cell-2"), secondState);
});

test("one-step undo restores overwritten legacy cell state but preserves later source edits", () => {
  const before = createDefaultChartWorkspace();
  const previousCellTwo = structuredClone(cellOf(before, "cell-2"));
  const split = splitChartWorkspaceDocument(before, "cell-1", "columns", "copy");
  const undo = createChartWorkspaceLayoutUndoEntry(before, split.restoreCellIds);
  const source = cellOf(split.document, "cell-1");
  const afterUserEdit: ChartWorkspaceDocument = {
    ...split.document,
    cells: {
      ...split.document.cells,
      "cell-1": { ...source, session: { ...source.session, interval: "5m" } },
    },
  };
  const restored = applyChartWorkspaceLayoutUndo(afterUserEdit, undo);

  assert.deepEqual(visible(restored), ["cell-1"]);
  assert.equal(cellOf(restored, "cell-1").session.interval, "5m");
  assert.deepEqual(cellOf(restored, "cell-2"), previousCellTwo);
});

test("reset keeps the current active chart as the sole mounted cell", () => {
  const split = splitChartWorkspaceDocument(createDefaultChartWorkspace(), "cell-1", "columns", "copy").document;
  assert.equal(windowOf(split).activeCellId, "cell-2");
  const reset = resetChartWorkspaceDocumentLayout(split);
  assert.deepEqual(visible(reset.document), ["cell-2"]);
  assert.equal(windowOf(reset.document).activeCellId, "cell-2");
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
  assert.deepEqual(visible(document), ["cell-3", "cell-2", "cell-1"]);
  assert.equal(history.past.length, 3);

  const undoSwap = undoChartWorkspaceLayoutEdit(document, history);
  assert.ok(undoSwap);
  ({ document, history } = undoSwap);
  assert.deepEqual(visible(document), ["cell-1", "cell-2", "cell-3"]);

  const undoThirdCell = undoChartWorkspaceLayoutEdit(document, history);
  assert.ok(undoThirdCell);
  ({ document, history } = undoThirdCell);
  assert.deepEqual(visible(document), ["cell-1", "cell-2"]);
  assert.equal(history.future.length, 2);

  const redoThirdCell = redoChartWorkspaceLayoutEdit(document, history);
  assert.ok(redoThirdCell);
  ({ document, history } = redoThirdCell);
  assert.deepEqual(visible(document), ["cell-1", "cell-2", "cell-3"]);
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

test("dynamic editing creates 16 unique IDs and never reuses a closed ID", () => {
  let sequence = 0;
  const options: ChartWorkspaceEditOptions = {
    allowDynamicCellIds: true,
    maxCellsPerWindow: 16,
    maxCellsPerApp: 64,
    createCellId: (occupied) => {
      let id: ChartCellId;
      do id = `cell-dynamic-${++sequence}`; while (occupied.has(id));
      return id;
    },
  };
  let document = createDefaultChartWorkspace();
  while (visible(document).length < 16) {
    const target = windowOf(document).activeCellId;
    document = splitChartWorkspaceDocument(document, target, "columns", "copy", options).document;
  }
  const uniqueIds = visible(document);
  assert.equal(uniqueIds.length, 16);
  assert.equal(new Set(uniqueIds).size, 16);
  const closedId = windowOf(document).activeCellId;
  document = closeChartWorkspaceDocument(document, closedId, options).document;
  const target = windowOf(document).activeCellId;
  document = splitChartWorkspaceDocument(document, target, "rows", "blank", options).document;
  assert.equal(visible(document).length, 16);
  assert.ok(!visible(document).includes(closedId));
  assert.ok(document.cells[closedId]);
});

test("16-cell preset, split rejection, undo, and redo preserve the complete layout", () => {
  let sequence = 0;
  const options: ChartWorkspaceEditOptions = {
    allowDynamicCellIds: true,
    maxCellsPerWindow: 16,
    maxCellsPerApp: 64,
    createCellId: (occupied) => {
      let id: ChartCellId;
      do id = `cell-preset-${++sequence}`; while (occupied.has(id));
      return id;
    },
  };
  const before = createDefaultChartWorkspace();
  const preset = setChartWorkspaceDocumentLayout(before, "grid-16", options);
  assert.equal(visible(preset.document).length, 16);
  assert.equal(new Set(visible(preset.document)).size, 16);
  const rejected = splitChartWorkspaceDocument(
    preset.document,
    visible(preset.document)[0]!,
    "columns",
    "copy",
    options,
  );
  assert.equal(rejected.document, preset.document);

  let history = recordChartWorkspaceLayoutEdit(createEmptyChartWorkspaceLayoutHistory(), before, preset);
  const undo = undoChartWorkspaceLayoutEdit(preset.document, history);
  assert.ok(undo);
  assert.deepEqual(visible(undo.document), ["cell-1"]);
  history = undo.history;
  const redo = redoChartWorkspaceLayoutEdit(undo.document, history);
  assert.ok(redo);
  assert.equal(visible(redo.document).length, 16);

  const disabled = setChartWorkspaceDocumentLayout(before, "grid-6", {
    ...options,
    maxCellsPerWindow: 4,
  });
  assert.equal(disabled.document, before);
});

test("dynamic undo and redo restore the same ID and its complete edited snapshot", () => {
  const options: ChartWorkspaceEditOptions = {
    allowDynamicCellIds: true,
    maxCellsPerWindow: 16,
    createCellId: () => "cell-dynamic-history",
  };
  const before = createDefaultChartWorkspace();
  const split = splitChartWorkspaceDocument(before, "cell-1", "columns", "copy", options);
  let history = recordChartWorkspaceLayoutEdit(createEmptyChartWorkspaceLayoutHistory(), before, split);
  const dynamic = cellOf(split.document, "cell-dynamic-history");
  let document: ChartWorkspaceDocument = {
    ...split.document,
    cells: {
      ...split.document.cells,
      [dynamic.id]: {
        ...dynamic,
        indicators: [{ id: "history-indicator", params: { length: 34 } }],
        session: { ...dynamic.session, interval: "5m" },
      },
    },
  };

  const undo = undoChartWorkspaceLayoutEdit(document, history);
  assert.ok(undo);
  ({ document, history } = undo);
  assert.deepEqual(visible(document), ["cell-1"]);

  const redo = redoChartWorkspaceLayoutEdit(document, history);
  assert.ok(redo);
  ({ document } = redo);
  assert.deepEqual(visible(document), ["cell-1", "cell-dynamic-history"]);
  assert.equal(cellOf(document, "cell-dynamic-history").session.interval, "5m");
  assert.deepEqual(cellOf(document, "cell-dynamic-history").indicators, [
    { id: "history-indicator", params: { length: 34 } },
  ]);
});

test("locked windows reject every structural edit and history traversal", () => {
  const unlocked = createDefaultChartWorkspace();
  const split = splitChartWorkspaceDocument(unlocked, "cell-1", "columns", "copy");
  const history = recordChartWorkspaceLayoutEdit(createEmptyChartWorkspaceLayoutHistory(), unlocked, split);
  const locked = replaceChartWorkspaceWindow(split.document, {
    ...windowOf(split.document),
    layoutLocked: true,
  });

  assert.equal(splitChartWorkspaceDocument(locked, "cell-2", "rows", "copy").document, locked);
  assert.equal(closeChartWorkspaceDocument(locked, "cell-2").document, locked);
  assert.equal(swapChartWorkspaceDocumentCells(locked, "cell-1", "cell-2").document, locked);
  assert.equal(resetChartWorkspaceDocumentLayout(locked).document, locked);
  assert.equal(undoChartWorkspaceLayoutEdit(locked, history), null);
  assert.equal(redoChartWorkspaceLayoutEdit(locked, history), null);
});
