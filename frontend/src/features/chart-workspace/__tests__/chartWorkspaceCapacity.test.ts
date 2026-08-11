import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_VISIBLE_CELLS_PER_WINDOW,
  MAX_CELLS_PER_APP,
  MAX_CELLS_PER_WINDOW,
  MAX_WINDOWS_PER_WORKSPACE,
  chartWorkspaceRuntimeLimits,
  resolveChartWorkspaceFeatureFlags,
} from "../chartWorkspaceCapacity.js";
import {
  ChartWorkspaceRevisionConflictError,
  activeChartWorkspaceWindow,
  compareAndSwapChartWorkspaceDocument,
  replaceChartWorkspaceWindow,
} from "../chartWorkspaceDocument.js";
import {
  createChartCellId,
  isChartCellId,
  isChartWindowId,
} from "../chartWorkspaceIdentity.js";
import { createDefaultChartWorkspace } from "../chartWorkspaceStorage.js";

test("hard limits are fixed at 16 cells, 4 windows, and 64 application cells", () => {
  assert.equal(MAX_CELLS_PER_WINDOW, 16);
  assert.equal(MAX_WINDOWS_PER_WORKSPACE, 4);
  assert.equal(MAX_CELLS_PER_APP, 64);
});

test("default-off and partially enabled flags can only tighten hard limits", () => {
  const off = resolveChartWorkspaceFeatureFlags();
  assert.deepEqual(off, {
    multiChart16Enabled: false,
    multiWindowEnabled: false,
    multiChart64Enabled: false,
  });
  assert.deepEqual(chartWorkspaceRuntimeLimits(off), {
    maxCellsPerWindow: LEGACY_VISIBLE_CELLS_PER_WINDOW,
    maxWindowsPerWorkspace: 1,
    maxCellsPerApp: LEGACY_VISIBLE_CELLS_PER_WINDOW,
  });

  const partial = resolveChartWorkspaceFeatureFlags({
    MULTI_CHART_16_ENABLED: "1",
    MULTI_CHART_64_ENABLED: "1",
  });
  assert.equal(partial.multiChart64Enabled, false);
  assert.deepEqual(chartWorkspaceRuntimeLimits(partial), {
    maxCellsPerWindow: 16,
    maxWindowsPerWorkspace: 1,
    maxCellsPerApp: 16,
  });

  const sixteenWithNativeWindows = resolveChartWorkspaceFeatureFlags({
    MULTI_CHART_16_ENABLED: "1",
    MULTI_WINDOW_ENABLED: "1",
  });
  assert.deepEqual(chartWorkspaceRuntimeLimits(sixteenWithNativeWindows), {
    maxCellsPerWindow: 16,
    maxWindowsPerWorkspace: 4,
    maxCellsPerApp: 16,
  });

  const full = resolveChartWorkspaceFeatureFlags({
    MULTI_CHART_16_ENABLED: true,
    MULTI_WINDOW_ENABLED: 1,
    MULTI_CHART_64_ENABLED: "1",
  });
  assert.deepEqual(chartWorkspaceRuntimeLimits(full), {
    maxCellsPerWindow: 16,
    maxWindowsPerWorkspace: 4,
    maxCellsPerApp: 64,
  });
});

test("cell and window IDs are opaque, validated, collision checked, and bounded", () => {
  assert.equal(isChartCellId("cell-6a0c8d5e-opaque"), true);
  assert.equal(isChartCellId("cell-"), false);
  assert.equal(isChartCellId("not-a-cell"), false);
  assert.equal(isChartWindowId("main-window"), true);
  assert.equal(isChartWindowId("Window-1"), false);
  const occupied = new Set(["cell-collision"]);
  const stems = ["collision", "fresh-id"];
  assert.equal(createChartCellId(occupied, () => stems.shift() ?? "unused"), "cell-fresh-id");
  assert.equal(createChartCellId(new Set(), () => "!".repeat(200)), null);
});

test("document compare-and-swap advances once and rejects a stale revision", () => {
  const current = createDefaultChartWorkspace();
  const candidate = replaceChartWorkspaceWindow(current, {
    ...activeChartWorkspaceWindow(current),
    layoutLocked: true,
  });
  const committed = compareAndSwapChartWorkspaceDocument(current, 0, candidate);
  assert.equal(committed.revision, 1);
  assert.equal(activeChartWorkspaceWindow(committed).layoutLocked, true);
  assert.throws(
    () => compareAndSwapChartWorkspaceDocument(committed, 0, candidate),
    (error: unknown) => error instanceof ChartWorkspaceRevisionConflictError
      && error.expectedRevision === 0
      && error.actualRevision === 1,
  );
});
