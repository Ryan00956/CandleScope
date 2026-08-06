import assert from "node:assert/strict";
import test from "node:test";

import {
  CHART_WORKSPACE_STORAGE_KEY,
  LEGACY_CHART_WORKSPACE_STORAGE_KEY,
  createDefaultChartWorkspace,
  loadChartWorkspace,
  saveChartWorkspace,
  type ChartWorkspaceStorageLike,
} from "../chartWorkspaceStorage.js";
import {
  createChartWorkspaceLayoutTree,
  closeChartWorkspaceCell,
  detectChartWorkspaceLayout,
  splitChartWorkspaceCell,
  updateChartWorkspaceSplitRatio,
  visibleCellIds,
} from "../chartWorkspaceLayout.js";
import type { ChartWorkspaceLayoutNode } from "../chartWorkspaceTypes.js";

function memoryStorage(initial: Record<string, string> = {}): ChartWorkspaceStorageLike {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

function splitRatios(tree: ChartWorkspaceLayoutNode): Record<string, number> {
  if (tree.kind === "cell") return {};
  return {
    [tree.id]: tree.ratio,
    ...splitRatios(tree.first),
    ...splitRatios(tree.second),
  };
}

test("workspace defaults to four stable cells with one visible tree leaf", () => {
  const workspace = createDefaultChartWorkspace();
  assert.equal(workspace.layoutLocked, false);
  assert.deepEqual(Object.keys(workspace.cells), ["cell-1", "cell-2", "cell-3", "cell-4"]);
  assert.deepEqual(Object.values(workspace.cells).map((cell) => cell.linkGroup), ["A", "A", "A", "A"]);
  assert.deepEqual(Object.values(workspace.cells).map((cell) => cell.linkRole), [
    "bidirectional",
    "bidirectional",
    "bidirectional",
    "bidirectional",
  ]);
  assert.deepEqual(workspace.linkGroups.A, {
    market: true,
    interval: false,
    crosshair: true,
    timeAnchor: false,
    dateRange: true,
    drawings: false,
  });
  assert.deepEqual(visibleCellIds(workspace.layoutTree), ["cell-1"]);
  assert.deepEqual(visibleCellIds(createChartWorkspaceLayoutTree("split-vertical")), ["cell-1", "cell-2"]);
  assert.deepEqual(visibleCellIds(createChartWorkspaceLayoutTree("split-horizontal")), ["cell-1", "cell-2"]);
  assert.deepEqual(visibleCellIds(createChartWorkspaceLayoutTree("main-confirmation")), ["cell-1", "cell-2", "cell-3"]);
  assert.deepEqual(visibleCellIds(createChartWorkspaceLayoutTree("quad")), ["cell-1", "cell-2", "cell-3", "cell-4"]);
});

test("workspace persistence keeps recursive split ratios and cell-scoped state", () => {
  const storage = memoryStorage();
  const workspace = createDefaultChartWorkspace();
  let tree = createChartWorkspaceLayoutTree("quad");
  tree = updateChartWorkspaceSplitRatio(tree, "quad-root", 0.42);
  tree = updateChartWorkspaceSplitRatio(tree, "quad-top", 0.64);
  tree = updateChartWorkspaceSplitRatio(tree, "quad-bottom", 0.58);
  workspace.layoutTree = tree;
  workspace.layoutLocked = true;
  workspace.activeCellId = "cell-2";
  workspace.cells["cell-2"].session = {
    exchange: "binance",
    marketType: "futures",
    symbol: "ETHUSDT",
    interval: "15m",
  };
  workspace.cells["cell-2"].priceScale = { invertScale: true, priceScaleMode: 2 };
  workspace.cells["cell-2"].linkGroup = "B";
  workspace.cells["cell-2"].linkRole = "destination";
  workspace.cells["cell-2"].drawingLayerSet = "3";
  workspace.linkGroups.B.interval = true;
  workspace.linkGroups.B.drawings = true;
  saveChartWorkspace(workspace, storage);

  const restored = loadChartWorkspace(storage);
  assert.equal(restored.schemaVersion, 5);
  assert.equal(restored.layoutLocked, true);
  assert.equal(detectChartWorkspaceLayout(restored.layoutTree), "quad");
  assert.equal(restored.activeCellId, "cell-2");
  assert.deepEqual(restored.cells["cell-2"].session, workspace.cells["cell-2"].session);
  assert.deepEqual(restored.cells["cell-2"].priceScale, { invertScale: true, priceScaleMode: 2 });
  assert.equal(restored.cells["cell-2"].linkGroup, "B");
  assert.equal(restored.cells["cell-2"].linkRole, "destination");
  assert.equal(restored.cells["cell-2"].drawingLayerSet, "3");
  assert.equal(restored.linkGroups.B.interval, true);
  assert.equal(restored.linkGroups.B.drawings, true);
  assert.deepEqual(splitRatios(restored.layoutTree), {
    "quad-root": 0.42,
    "quad-top": 0.64,
    "quad-bottom": 0.58,
  });
});

test("workspace persistence restores arbitrary split and collapsed cell identities", () => {
  const storage = memoryStorage();
  const workspace = createDefaultChartWorkspace();
  let tree = splitChartWorkspaceCell(workspace.layoutTree, "cell-1", "cell-2", "columns");
  tree = splitChartWorkspaceCell(tree, "cell-2", "cell-3", "rows");
  tree = splitChartWorkspaceCell(tree, "cell-3", "cell-4", "columns");
  tree = closeChartWorkspaceCell(tree, "cell-2");
  workspace.layoutTree = tree;
  workspace.activeCellId = "cell-4";
  saveChartWorkspace(workspace, storage);

  const restored = loadChartWorkspace(storage);
  assert.equal(detectChartWorkspaceLayout(restored.layoutTree), "custom");
  assert.deepEqual(visibleCellIds(restored.layoutTree), ["cell-1", "cell-3", "cell-4"]);
  assert.equal(restored.activeCellId, "cell-4");
});

test("v2 migration turns shared legacy ratios into independent recursive split nodes", () => {
  const workspace = createDefaultChartWorkspace();
  const { layoutTree: _layoutTree, ...legacyFields } = workspace;
  const legacyDocument = {
    ...legacyFields,
    schemaVersion: 2,
    layout: "quad",
    layoutRatios: {
      splitVertical: 0.5,
      splitHorizontal: 0.5,
      quadColumns: 0.64,
      quadRows: 0.42,
    },
  };
  const restored = loadChartWorkspace(memoryStorage({
    [CHART_WORKSPACE_STORAGE_KEY]: JSON.stringify(legacyDocument),
  }));
  assert.equal(restored.schemaVersion, 5);
  assert.equal(restored.layoutLocked, false);
  assert.equal(detectChartWorkspaceLayout(restored.layoutTree), "quad");
  assert.deepEqual(splitRatios(restored.layoutTree), {
    "quad-root": 0.42,
    "quad-top": 0.64,
    "quad-bottom": 0.64,
  });
  assert.deepEqual(Object.values(restored.cells).map((cell) => cell.linkGroup), ["A", "A", "A", "A"]);
});

test("v1 workspace migration preserves cells and receives safe tree and link defaults", () => {
  const workspace = createDefaultChartWorkspace();
  const { layoutTree: _layoutTree, ...legacyFields } = workspace;
  const legacyDocument = {
    ...legacyFields,
    schemaVersion: 1,
    layout: "split-horizontal",
  };
  const storage = memoryStorage({
    [LEGACY_CHART_WORKSPACE_STORAGE_KEY]: JSON.stringify(legacyDocument),
  });
  const restored = loadChartWorkspace(storage);
  assert.equal(restored.schemaVersion, 5);
  assert.equal(restored.layoutLocked, false);
  assert.equal(detectChartWorkspaceLayout(restored.layoutTree), "split-horizontal");
  assert.deepEqual(Object.values(restored.cells).map((cell) => cell.linkGroup), [null, null, null, null]);
  assert.deepEqual(splitRatios(restored.layoutTree), { "split-horizontal-root": 0.5 });
});

test("v3 migration preserves legacy date-range behavior and adds safe advanced-link defaults", () => {
  const workspace = createDefaultChartWorkspace();
  const legacyDocument = structuredClone(workspace) as unknown as Record<string, unknown>;
  legacyDocument.schemaVersion = 3;
  let legacyTree = createChartWorkspaceLayoutTree("quad");
  legacyTree = updateChartWorkspaceSplitRatio(legacyTree, "quad-root", 0.37);
  legacyTree = updateChartWorkspaceSplitRatio(legacyTree, "quad-top", 0.61);
  legacyTree = updateChartWorkspaceSplitRatio(legacyTree, "quad-bottom", 0.54);
  legacyDocument.layoutTree = legacyTree;
  const legacyGroups = legacyDocument.linkGroups as Record<string, Record<string, unknown>>;
  legacyGroups.A = {
    market: true,
    interval: false,
    crosshair: true,
    timeRange: true,
  };
  const legacyCells = legacyDocument.cells as Record<string, Record<string, unknown>>;
  delete legacyCells["cell-1"]!.linkRole;
  delete legacyCells["cell-1"]!.drawingLayerSet;

  const restored = loadChartWorkspace(memoryStorage({
    [CHART_WORKSPACE_STORAGE_KEY]: JSON.stringify(legacyDocument),
  }));

  assert.equal(restored.schemaVersion, 5);
  assert.equal(restored.layoutLocked, false);
  assert.deepEqual(restored.linkGroups.A, {
    market: true,
    interval: false,
    crosshair: true,
    timeAnchor: false,
    dateRange: true,
    drawings: false,
  });
  assert.equal(restored.cells["cell-1"].linkRole, "bidirectional");
  assert.equal(restored.cells["cell-1"].drawingLayerSet, "1");
  assert.equal(detectChartWorkspaceLayout(restored.layoutTree), "quad");
  assert.deepEqual(splitRatios(restored.layoutTree), {
    "quad-root": 0.37,
    "quad-top": 0.61,
    "quad-bottom": 0.54,
  });
});

test("v4 migration keeps the recursive layout and starts safely unlocked", () => {
  const legacyDocument = structuredClone(createDefaultChartWorkspace()) as unknown as Record<string, unknown>;
  legacyDocument.schemaVersion = 4;
  delete legacyDocument.layoutLocked;
  legacyDocument.layoutTree = createChartWorkspaceLayoutTree("main-confirmation");

  const restored = loadChartWorkspace(memoryStorage({
    [CHART_WORKSPACE_STORAGE_KEY]: JSON.stringify(legacyDocument),
  }));

  assert.equal(restored.schemaVersion, 5);
  assert.equal(restored.layoutLocked, false);
  assert.equal(detectChartWorkspaceLayout(restored.layoutTree), "main-confirmation");
});

test("malformed workspace storage fails closed to defaults", () => {
  const storage = memoryStorage({ [CHART_WORKSPACE_STORAGE_KEY]: "{not-json" });
  const restored = loadChartWorkspace(storage);
  assert.equal(detectChartWorkspaceLayout(restored.layoutTree), "single");
  assert.equal(restored.activeCellId, "cell-1");
  assert.deepEqual(Object.keys(restored.cells), ["cell-1", "cell-2", "cell-3", "cell-4"]);
});

test("restore keeps the active cell renderable for the saved tree and maximized state", () => {
  const workspace = createDefaultChartWorkspace();
  const single = loadChartWorkspace(memoryStorage({
    [CHART_WORKSPACE_STORAGE_KEY]: JSON.stringify({
      ...workspace,
      activeCellId: "cell-4",
    }),
  }));
  assert.equal(single.activeCellId, "cell-1");

  const maximized = loadChartWorkspace(memoryStorage({
    [CHART_WORKSPACE_STORAGE_KEY]: JSON.stringify({
      ...workspace,
      activeCellId: "cell-1",
      maximizedCellId: "cell-3",
    }),
  }));
  assert.equal(maximized.activeCellId, "cell-3");
  assert.equal(maximized.maximizedCellId, "cell-3");
});
