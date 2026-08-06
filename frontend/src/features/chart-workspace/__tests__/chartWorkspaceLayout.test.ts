import assert from "node:assert/strict";
import test from "node:test";

import {
  createChartWorkspaceLayoutTree,
  detectChartWorkspaceLayout,
  findChartWorkspaceCellRole,
  normalizeChartSplitRatio,
  normalizeChartWorkspaceLayoutTree,
  ratioFromPointerPosition,
  updateChartWorkspaceSplitRatio,
  visibleCellIds,
} from "../chartWorkspaceLayout.js";

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
