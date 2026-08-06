import assert from "node:assert/strict";
import test from "node:test";

import {
  assessWorkspaceLayoutSpace,
  computeWorkspaceLayoutGeometry,
  nextWorkspaceCellInDirection,
  workspaceCellDensityForSize,
} from "../chartWorkspaceGeometry.js";
import {
  chartWorkspaceTemplateCellCount,
  createChartWorkspaceLayoutTree,
} from "../chartWorkspaceLayout.js";
import type { ChartWorkspaceTemplateId } from "../chartWorkspaceTypes.js";

const matrixTemplates: readonly ChartWorkspaceTemplateId[] = [
  "grid-6", "grid-8", "grid-9", "grid-12", "grid-16",
];

function overlaps(
  first: ReturnType<typeof computeWorkspaceLayoutGeometry>["leaves"][number]["rect"],
  second: ReturnType<typeof computeWorkspaceLayoutGeometry>["leaves"][number]["rect"],
): boolean {
  return Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x) > 1e-9
    && Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y) > 1e-9;
}

test("matrix presets produce exact unique leaves with full non-overlapping geometry", () => {
  for (const template of matrixTemplates) {
    const count = chartWorkspaceTemplateCellCount(template);
    const geometry = computeWorkspaceLayoutGeometry(createChartWorkspaceLayoutTree(template));
    assert.equal(geometry.leaves.length, count, template);
    assert.equal(new Set(geometry.leaves.map((leaf) => leaf.cellId)).size, count, template);
    assert.equal(geometry.splits.length, count - 1, template);
    for (let first = 0; first < geometry.leaves.length; first += 1) {
      const rect = geometry.leaves[first]!.rect;
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 1 + 1e-9);
      assert.ok(rect.y + rect.height <= 1 + 1e-9);
      for (let second = first + 1; second < geometry.leaves.length; second += 1) {
        assert.equal(overlaps(rect, geometry.leaves[second]!.rect), false, `${template}:${first}:${second}`);
      }
    }
  }
});

test("density and 16-cell space assessment distinguish 1600, 2560, and 3840 structures", () => {
  assert.equal(workspaceCellDensityForSize(600, 320), "full");
  assert.equal(workspaceCellDensityForSize(400, 220), "compact");
  assert.equal(workspaceCellDensityForSize(220, 150), "minimal");
  const geometry = computeWorkspaceLayoutGeometry(createChartWorkspaceLayoutTree("grid-16"));
  assert.equal(assessWorkspaceLayoutSpace(geometry, 1600, 900).sufficient, false);
  assert.equal(assessWorkspaceLayoutSpace(geometry, 2560, 1440).sufficient, true);
  assert.equal(assessWorkspaceLayoutSpace(geometry, 3840, 2160).sufficient, true);
});

test("directional keyboard navigation follows visual matrix order", () => {
  const geometry = computeWorkspaceLayoutGeometry(createChartWorkspaceLayoutTree("grid-16"));
  assert.equal(nextWorkspaceCellInDirection(geometry, "cell-6", "left"), "cell-5");
  assert.equal(nextWorkspaceCellInDirection(geometry, "cell-6", "right"), "cell-7");
  assert.equal(nextWorkspaceCellInDirection(geometry, "cell-6", "up"), "cell-2");
  assert.equal(nextWorkspaceCellInDirection(geometry, "cell-6", "down"), "cell-10");
});
