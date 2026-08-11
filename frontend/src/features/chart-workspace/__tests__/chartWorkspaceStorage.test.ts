import assert from "node:assert/strict";
import test from "node:test";

import { activeChartWorkspaceWindow, chartWorkspaceCell } from "../chartWorkspaceDocument.js";
import { cloneChartLinkSettings } from "../chartWorkspaceLinkModel.js";
import {
  CHART_WORKSPACE_V7_STORAGE_KEY,
  createDefaultChartWorkspace,
  loadChartWorkspace,
  normalizeChartWorkspaceWithDiagnostics,
  saveChartWorkspace,
  type ChartWorkspaceStorageLike,
} from "../chartWorkspaceStorage.js";
import {
  CHART_WORKSPACE_SCHEMA_VERSION,
  DEFAULT_CHART_LINK_GROUP_ID,
  DEFAULT_CHART_LINK_GROUP_SETTINGS,
} from "../chartWorkspaceTypes.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: ChartWorkspaceStorageLike = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
  return { storage, values };
}

test("workspace defaults to schema v7 with a dynamic root group", () => {
  const workspace = createDefaultChartWorkspace();
  assert.equal(workspace.schemaVersion, CHART_WORKSPACE_SCHEMA_VERSION);
  assert.equal(workspace.revision, 0);
  assert.deepEqual(Object.keys(workspace.linkGroups), [DEFAULT_CHART_LINK_GROUP_ID]);
  assert.equal(workspace.linkGroups[DEFAULT_CHART_LINK_GROUP_ID]!.parentId, null);
  assert.ok(Object.values(workspace.cells).every((cell) => (
    cell.linkGroupId === DEFAULT_CHART_LINK_GROUP_ID
  )));
  assert.equal(activeChartWorkspaceWindow(workspace).activeCellId, "cell-1");
});

test("v7 persistence keeps the group tree, indicator policies, and cell membership", () => {
  const { storage, values } = memoryStorage();
  const workspace = createDefaultChartWorkspace();
  workspace.revision = 7;
  workspace.linkGroups["group-child"] = {
    id: "group-child",
    name: "确认组",
    color: "#8b5cf6",
    parentId: DEFAULT_CHART_LINK_GROUP_ID,
    peerPolicy: cloneChartLinkSettings(DEFAULT_CHART_LINK_GROUP_SETTINGS),
    receiveFromParent: cloneChartLinkSettings(DEFAULT_CHART_LINK_GROUP_SETTINGS),
  };
  workspace.linkGroups["group-child"]!.receiveFromParent.indicators.visual = true;
  chartWorkspaceCell(workspace, "cell-2").linkGroupId = "group-child";
  chartWorkspaceCell(workspace, "cell-2").indicators = [{
    id: "sma",
    bindingId: "trend",
    params: { length: 21 },
  }];

  saveChartWorkspace(workspace, storage);
  assert.deepEqual([...values.keys()], [CHART_WORKSPACE_V7_STORAGE_KEY]);
  const restored = loadChartWorkspace(storage);
  assert.equal(restored.revision, 7);
  assert.equal(restored.linkGroups["group-child"]!.parentId, DEFAULT_CHART_LINK_GROUP_ID);
  assert.equal(restored.linkGroups["group-child"]!.receiveFromParent.indicators.visual, true);
  assert.equal(chartWorkspaceCell(restored, "cell-2").linkGroupId, "group-child");
  assert.equal(chartWorkspaceCell(restored, "cell-2").indicators[0]?.bindingId, "trend");
});

test("old schemas are rejected instead of migrated", () => {
  const old = { ...createDefaultChartWorkspace(), schemaVersion: 6 };
  const result = normalizeChartWorkspaceWithDiagnostics(old);
  assert.equal(result.usedFallback, true);
  assert.equal(result.migratedFromSchemaVersion, null);
  assert.deepEqual(result.diagnostics, [{ code: "unsupported-schema", path: "schemaVersion" }]);
  assert.equal(result.document.schemaVersion, CHART_WORKSPACE_SCHEMA_VERSION);
});

test("cycles and dangling group references fail closed", () => {
  const cyclic = createDefaultChartWorkspace();
  cyclic.linkGroups["group-child"] = {
    id: "group-child",
    name: "确认组",
    color: "#8b5cf6",
    parentId: DEFAULT_CHART_LINK_GROUP_ID,
    peerPolicy: cloneChartLinkSettings(DEFAULT_CHART_LINK_GROUP_SETTINGS),
    receiveFromParent: cloneChartLinkSettings(DEFAULT_CHART_LINK_GROUP_SETTINGS),
  };
  cyclic.linkGroups[DEFAULT_CHART_LINK_GROUP_ID]!.parentId = "group-child";
  assert.equal(normalizeChartWorkspaceWithDiagnostics(cyclic).usedFallback, true);

  const dangling = createDefaultChartWorkspace();
  chartWorkspaceCell(dangling, "cell-2").linkGroupId = "missing";
  const result = normalizeChartWorkspaceWithDiagnostics(dangling);
  assert.equal(result.usedFallback, true);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "invalid-cell-link-group"));
});

test("load ignores old keys and malformed v7 JSON", () => {
  const { storage } = memoryStorage({
    "candlescope-chart-workspace-v6": JSON.stringify(createDefaultChartWorkspace()),
    [CHART_WORKSPACE_V7_STORAGE_KEY]: "{broken",
  });
  const loaded = loadChartWorkspace(storage);
  assert.equal(loaded.schemaVersion, CHART_WORKSPACE_SCHEMA_VERSION);
  assert.equal(loaded.revision, 0);
});
