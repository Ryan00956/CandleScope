import assert from "node:assert/strict";
import test from "node:test";

import {
  createChartWorkspaceLayoutTree,
  closeChartWorkspaceCell,
  detectChartWorkspaceLayout,
  firstAvailableChartCellId,
  findChartWorkspaceCellRole,
  normalizeChartSplitRatio,
  normalizeChartWorkspaceLayoutTree,
  parseChartWorkspaceLayoutTree,
  projectChartWorkspaceLayoutTree,
  ratioFromPointerPosition,
  resetChartWorkspaceLayout,
  splitChartWorkspaceCell,
  swapChartWorkspaceCells,
  updateChartWorkspaceSplitRatio,
  visibleCellIds,
} from "../chartWorkspaceLayout.js";

test("high-density presets expose exact leaf counts and survive opaque Cell IDs", () => {
  for (const [template, count] of [["grid-6", 6], ["grid-8", 8], ["grid-9", 9], ["grid-12", 12], ["grid-16", 16]] as const) {
    const cellIds = Array.from({ length: count }, (_, index) => `cell-opaque-${index + 1}`);
    const tree = createChartWorkspaceLayoutTree(template, undefined, cellIds);
    assert.equal(visibleCellIds(tree).length, count);
    assert.equal(detectChartWorkspaceLayout(tree), template);
  }
});

test("Cell ID allocation delegates to the factory and fails closed at capacity", () => {
  const tree = createChartWorkspaceLayoutTree("split-vertical");
  const occupied = new Set(["cell-1", "cell-2", "cell-retired"]);
  let factorySawRetired = false;
  assert.equal(firstAvailableChartCellId(tree, {
    occupiedCellIds: occupied,
    maxCells: 3,
    createCellId: (ids) => {
      factorySawRetired = ids.has("cell-retired");
      return "cell-dynamic-next";
    },
  }), "cell-dynamic-next");
  assert.equal(factorySawRetired, true);
  assert.equal(firstAvailableChartCellId(tree, { maxCells: 2 }), null);
});

test("flag-off projection exposes only the first four cells without mutating the v7 tree", () => {
  const tree = createChartWorkspaceLayoutTree("grid-16");
  const serialized = JSON.stringify(tree);
  const projected = projectChartWorkspaceLayoutTree(tree, 4);
  assert.deepEqual(visibleCellIds(projected), ["cell-1", "cell-2", "cell-3", "cell-4"]);
  assert.equal(detectChartWorkspaceLayout(projected), "quad");
  assert.equal(JSON.stringify(tree), serialized);
  assert.equal(visibleCellIds(tree).length, 16);
});

test("split ratios clamp to a usable 20 to 80 percent range", () => {
  assert.equal(normalizeChartSplitRatio(-1), 0.2);
  assert.equal(normalizeChartSplitRatio(0.37), 0.37);
  assert.equal(normalizeChartSplitRatio(5), 0.8);
  assert.equal(normalizeChartSplitRatio("invalid", 0.6), 0.6);
});

test("pointer positions resolve relative to each recursive split boundary", () => {
  assert.equal(ratioFromPointerPosition(350, 100, 500), 0.5);
  assert.equal(ratioFromPointerPosition(50, 100, 500), 0.2);
  assert.equal(ratioFromPointerPosition(700, 100, 500), 0.8);
  assert.equal(ratioFromPointerPosition(100, 100, 0), null);
});

test("main and confirmation preset is a recursive three-cell tree with semantic roles", () => {
  const tree = createChartWorkspaceLayoutTree("main-confirmation");
  assert.equal(detectChartWorkspaceLayout(tree), "main-confirmation");
  assert.deepEqual(visibleCellIds(tree), ["cell-1", "cell-2", "cell-3"]);
  assert.deepEqual(visibleCellIds(tree, "cell-3"), ["cell-3"]);
  assert.equal(findChartWorkspaceCellRole(tree, "cell-1"), "main");
  assert.equal(findChartWorkspaceCellRole(tree, "cell-2"), "confirmation");
  assert.equal(findChartWorkspaceCellRole(tree, "cell-4"), null);
  assert.equal(tree.kind, "split");
  if (tree.kind !== "split") return;
  assert.equal(tree.direction, "columns");
  assert.equal(tree.ratio, 0.68);
  assert.equal(tree.second.kind, "split");
  if (tree.second.kind === "split") assert.equal(tree.second.direction, "rows");
});

test("nested split updates are immutable and touch only the addressed node", () => {
  const tree = createChartWorkspaceLayoutTree("quad", {
    quadColumns: 0.6,
    quadRows: 0.4,
  });
  assert.equal(tree.kind, "split");
  if (tree.kind !== "split" || tree.first.kind !== "split" || tree.second.kind !== "split") return;
  const secondBefore = tree.second;
  const updated = updateChartWorkspaceSplitRatio(tree, "quad-top", 0.72);
  assert.notEqual(updated, tree);
  assert.equal(updated.kind, "split");
  if (updated.kind !== "split" || updated.first.kind !== "split") return;
  assert.equal(updated.ratio, 0.4);
  assert.equal(updated.first.ratio, 0.72);
  assert.equal(updated.second, secondBefore);
  assert.equal(updateChartWorkspaceSplitRatio(updated, "missing", 0.3), updated);
});

test("malformed or duplicate recursive nodes fail closed to the supplied preset", () => {
  const fallback = createChartWorkspaceLayoutTree("split-vertical");
  const duplicateCells = {
    kind: "split",
    id: "duplicate-root",
    direction: "columns",
    ratio: 0.5,
    first: { kind: "cell", cellId: "cell-1" },
    second: { kind: "cell", cellId: "cell-1" },
  };
  assert.equal(normalizeChartWorkspaceLayoutTree(duplicateCells, fallback), fallback);
  assert.equal(normalizeChartWorkspaceLayoutTree({ kind: "split" }, fallback), fallback);
});

test("arbitrary split and close operations grow and collapse the recursive tree", () => {
  let tree = createChartWorkspaceLayoutTree("single");
  assert.equal(firstAvailableChartCellId(tree), "cell-2");
  tree = splitChartWorkspaceCell(tree, "cell-1", "cell-2", "columns");
  assert.deepEqual(visibleCellIds(tree), ["cell-1", "cell-2"]);
  assert.equal(detectChartWorkspaceLayout(tree), "split-vertical");
  tree = splitChartWorkspaceCell(tree, "cell-2", "cell-3", "rows");
  assert.equal(detectChartWorkspaceLayout(tree), "custom");
  tree = splitChartWorkspaceCell(tree, "cell-3", "cell-4", "columns");
  assert.deepEqual(visibleCellIds(tree), ["cell-1", "cell-2", "cell-3", "cell-4"]);
  assert.equal(firstAvailableChartCellId(tree), null);
  assert.equal(splitChartWorkspaceCell(tree, "cell-1", "cell-4", "rows"), tree);

  tree = closeChartWorkspaceCell(tree, "cell-3");
  assert.deepEqual(visibleCellIds(tree), ["cell-1", "cell-2", "cell-4"]);
  tree = closeChartWorkspaceCell(tree, "cell-2");
  assert.deepEqual(visibleCellIds(tree), ["cell-1", "cell-4"]);
  tree = closeChartWorkspaceCell(tree, "cell-4");
  assert.deepEqual(visibleCellIds(tree), ["cell-1"]);
  assert.equal(closeChartWorkspaceCell(tree, "cell-1"), tree);
});

test("structural edits clear preset roles while swaps preserve positional roles", () => {
  const preset = createChartWorkspaceLayoutTree("main-confirmation");
  const swapped = swapChartWorkspaceCells(preset, "cell-1", "cell-3");
  assert.deepEqual(visibleCellIds(swapped), ["cell-3", "cell-2", "cell-1"]);
  assert.equal(findChartWorkspaceCellRole(swapped, "cell-3"), "main");
  assert.equal(findChartWorkspaceCellRole(swapped, "cell-1"), "confirmation");

  const closed = closeChartWorkspaceCell(preset, "cell-2");
  assert.equal(findChartWorkspaceCellRole(closed, "cell-1"), null);
  assert.equal(findChartWorkspaceCellRole(closed, "cell-3"), null);
});

test("reset keeps the active cell identity and still reports a single layout", () => {
  const tree = resetChartWorkspaceLayout("cell-3");
  assert.deepEqual(visibleCellIds(tree), ["cell-3"]);
  assert.equal(detectChartWorkspaceLayout(tree), "single");
});

test("dynamic layout parsing accepts opaque IDs and reports dangling and duplicate identities", () => {
  const valid = {
    kind: "split",
    id: "dynamic-root",
    direction: "columns",
    ratio: 0.5,
    first: { kind: "cell", cellId: "cell-opaque-a" },
    second: { kind: "cell", cellId: "cell-opaque-b" },
  };
  const parsed = parseChartWorkspaceLayoutTree(valid, {
    knownCellIds: new Set(["cell-opaque-a", "cell-opaque-b"]),
    maxCells: 16,
  });
  assert.deepEqual(visibleCellIds(parsed.tree!), ["cell-opaque-a", "cell-opaque-b"]);
  assert.deepEqual(parsed.diagnostics, []);

  const dangling = parseChartWorkspaceLayoutTree(valid, {
    knownCellIds: new Set(["cell-opaque-a"]),
    maxCells: 16,
  });
  assert.equal(dangling.tree, null);
  assert.ok(dangling.diagnostics.some((diagnostic) => diagnostic.code === "dangling-cell-id"));

  const duplicate = parseChartWorkspaceLayoutTree({
    ...valid,
    second: { kind: "cell", cellId: "cell-opaque-a" },
  }, {
    knownCellIds: new Set(["cell-opaque-a"]),
    maxCells: 16,
  });
  assert.equal(duplicate.tree, null);
  assert.ok(duplicate.diagnostics.some((diagnostic) => diagnostic.code === "duplicate-cell-id"));
});
