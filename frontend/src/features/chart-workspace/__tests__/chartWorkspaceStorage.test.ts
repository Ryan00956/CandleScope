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
import { visibleCellIds } from "../chartWorkspaceTypes.js";

function memoryStorage(initial: Record<string, string> = {}): ChartWorkspaceStorageLike {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

test("workspace defaults to four stable cells with one visible chart", () => {
  const workspace = createDefaultChartWorkspace();
  assert.deepEqual(Object.keys(workspace.cells), ["cell-1", "cell-2", "cell-3", "cell-4"]);
  assert.deepEqual(Object.values(workspace.cells).map((cell) => cell.linkGroup), ["A", "A", "A", "A"]);
  assert.deepEqual(workspace.linkGroups.A, {
    market: true,
    interval: false,
    crosshair: true,
    timeRange: true,
  });
  assert.deepEqual(visibleCellIds(workspace.layout), ["cell-1"]);
  assert.deepEqual(visibleCellIds("split-vertical"), ["cell-1", "cell-2"]);
  assert.deepEqual(visibleCellIds("split-horizontal"), ["cell-1", "cell-2"]);
  assert.deepEqual(visibleCellIds("quad"), ["cell-1", "cell-2", "cell-3", "cell-4"]);
  assert.deepEqual(visibleCellIds("quad", "cell-3"), ["cell-3"]);
});

test("workspace persistence keeps cell-scoped session, layout, and price scale", () => {
  const storage = memoryStorage();
  const workspace = createDefaultChartWorkspace();
  workspace.layout = "quad";
  workspace.activeCellId = "cell-2";
  workspace.cells["cell-2"].session = {
    exchange: "binance",
    marketType: "futures",
    symbol: "ETHUSDT",
    interval: "15m",
  };
  workspace.cells["cell-2"].priceScale = { invertScale: true, priceScaleMode: 2 };
  workspace.cells["cell-2"].linkGroup = "B";
  workspace.linkGroups.B.interval = true;
  workspace.layoutRatios.quadColumns = 0.64;
  workspace.layoutRatios.quadRows = 0.42;
  saveChartWorkspace(workspace, storage);

  const restored = loadChartWorkspace(storage);
  assert.equal(restored.layout, "quad");
  assert.equal(restored.activeCellId, "cell-2");
  assert.deepEqual(restored.cells["cell-2"].session, workspace.cells["cell-2"].session);
  assert.deepEqual(restored.cells["cell-2"].priceScale, { invertScale: true, priceScaleMode: 2 });
  assert.equal(restored.cells["cell-2"].linkGroup, "B");
  assert.equal(restored.linkGroups.B.interval, true);
  assert.deepEqual(restored.layoutRatios, {
    splitVertical: 0.5,
    splitHorizontal: 0.5,
    quadColumns: 0.64,
    quadRows: 0.42,
  });
});

test("v1 workspace migration preserves independent cells and receives safe layout defaults", () => {
  const workspace = createDefaultChartWorkspace();
  const legacyDocument = {
    ...workspace,
    schemaVersion: 1,
  };
  const storage = memoryStorage({
    [LEGACY_CHART_WORKSPACE_STORAGE_KEY]: JSON.stringify(legacyDocument),
  });
  const restored = loadChartWorkspace(storage);
  assert.equal(restored.schemaVersion, 2);
  assert.deepEqual(Object.values(restored.cells).map((cell) => cell.linkGroup), [null, null, null, null]);
  assert.deepEqual(restored.layoutRatios, {
    splitVertical: 0.5,
    splitHorizontal: 0.5,
    quadColumns: 0.5,
    quadRows: 0.5,
  });
});

test("malformed workspace storage fails closed to defaults", () => {
  const storage = memoryStorage({ [CHART_WORKSPACE_STORAGE_KEY]: "{not-json" });
  const restored = loadChartWorkspace(storage);
  assert.equal(restored.layout, "single");
  assert.equal(restored.activeCellId, "cell-1");
  assert.deepEqual(Object.keys(restored.cells), ["cell-1", "cell-2", "cell-3", "cell-4"]);
});

test("restore keeps the active cell renderable for the saved layout and maximized state", () => {
  const workspace = createDefaultChartWorkspace();
  const single = loadChartWorkspace(memoryStorage({
    [CHART_WORKSPACE_STORAGE_KEY]: JSON.stringify({
      ...workspace,
      layout: "single",
      activeCellId: "cell-4",
    }),
  }));
  assert.equal(single.activeCellId, "cell-1");

  const maximized = loadChartWorkspace(memoryStorage({
    [CHART_WORKSPACE_STORAGE_KEY]: JSON.stringify({
      ...workspace,
      layout: "single",
      activeCellId: "cell-1",
      maximizedCellId: "cell-3",
    }),
  }));
  assert.equal(maximized.activeCellId, "cell-3");
  assert.equal(maximized.maximizedCellId, "cell-3");
});
