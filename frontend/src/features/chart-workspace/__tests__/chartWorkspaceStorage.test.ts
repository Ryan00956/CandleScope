import assert from "node:assert/strict";
import test from "node:test";

import { activeChartWorkspaceWindow, chartWorkspaceCell } from "../chartWorkspaceDocument.js";
import { cloneChartLinkSettings } from "../chartWorkspaceLinkModel.js";
import {
  CHART_WORKSPACE_V7_STORAGE_KEY,
  CHART_WORKSPACE_V8_STORAGE_KEY,
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

test("workspace defaults to schema v8 with a dynamic root group and no strategy attachment", () => {
  const workspace = createDefaultChartWorkspace();
  assert.equal(workspace.schemaVersion, CHART_WORKSPACE_SCHEMA_VERSION);
  assert.equal(workspace.revision, 0);
  assert.deepEqual(Object.keys(workspace.linkGroups), [DEFAULT_CHART_LINK_GROUP_ID]);
  assert.equal(workspace.linkGroups[DEFAULT_CHART_LINK_GROUP_ID]!.parentId, null);
  assert.ok(Object.values(workspace.cells).every((cell) => (
    cell.linkGroupId === DEFAULT_CHART_LINK_GROUP_ID && cell.strategyAttachment === null
  )));
  assert.equal(activeChartWorkspaceWindow(workspace).activeCellId, "cell-1");
});

test("v8 persistence keeps groups, indicators, cell membership, and strategy attachment", () => {
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
  chartWorkspaceCell(workspace, "cell-2").strategyAttachment = {
    schemaVersion: 1,
    strategyDraftId: "draft-12345678",
    strategyRevisionId: "revision-1",
    displayName: "趋势策略",
    language: "pyne",
    parameters: { slow: 21, fast: 7 },
    rangeMode: "CUSTOM",
    customRange: { startMs: 1, endMs: 2 },
    fidelityPreference: "FAST",
    quickPresetId: "CRYPTO_PERP_STANDARD_V1",
    autoRun: false,
  };
  (chartWorkspaceCell(workspace, "cell-2").strategyAttachment as unknown as Record<string, unknown>)
    .source = "must not enter workspace JSON";

  saveChartWorkspace(workspace, storage);
  assert.deepEqual([...values.keys()], [CHART_WORKSPACE_V8_STORAGE_KEY]);
  const restored = loadChartWorkspace(storage);
  assert.equal(restored.revision, 7);
  assert.equal(restored.linkGroups["group-child"]!.parentId, DEFAULT_CHART_LINK_GROUP_ID);
  assert.equal(restored.linkGroups["group-child"]!.receiveFromParent.indicators.visual, true);
  assert.equal(chartWorkspaceCell(restored, "cell-2").linkGroupId, "group-child");
  assert.equal(chartWorkspaceCell(restored, "cell-2").indicators[0]?.bindingId, "trend");
  assert.deepEqual(chartWorkspaceCell(restored, "cell-2").strategyAttachment?.parameters, {
    fast: 7,
    slow: 21,
  });
  assert.doesNotMatch(values.get(CHART_WORKSPACE_V8_STORAGE_KEY) ?? "", /must not enter/);
});

test("workspace persistence keeps a Twelve Data K-line series identity", () => {
  const { storage } = memoryStorage();
  const workspace = createDefaultChartWorkspace();
  const session = chartWorkspaceCell(workspace, "cell-1").session;
  Object.assign(session, {
    exchange: "twelvedata",
    marketType: "stock",
    symbol: "AAPL:NASDAQ",
    interval: "1d",
    providerId: "twelvedata",
    venue: "XNGS",
    assetClass: "stock",
    seriesVariant: "ohlcv",
    priceAdjustment: "raw",
    sessionVariant: "regular",
    volumeSemantics: "shares",
  });

  saveChartWorkspace(workspace, storage);
  const restored = chartWorkspaceCell(loadChartWorkspace(storage), "cell-1").session;
  assert.deepEqual({
    providerId: restored.providerId,
    venue: restored.venue,
    assetClass: restored.assetClass,
    seriesVariant: restored.seriesVariant,
    priceAdjustment: restored.priceAdjustment,
    sessionVariant: restored.sessionVariant,
    volumeSemantics: restored.volumeSemantics,
  }, {
    providerId: "twelvedata",
    venue: "xngs",
    assetClass: "stock",
    seriesVariant: "ohlcv",
    priceAdjustment: "raw",
    sessionVariant: "regular",
    volumeSemantics: "shares",
  });
});

test("schema v7 migrates to v8 without changing existing chart state", () => {
  const current = createDefaultChartWorkspace();
  chartWorkspaceCell(current, "cell-1").session.interval = "5m";
  chartWorkspaceCell(current, "cell-1").drawingLayerSet = "3";
  chartWorkspaceCell(current, "cell-1").indicators = [{ id: "legacy-sma" }];
  const legacy = structuredClone(current) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 7;
  Object.values((legacy.cells as Record<string, Record<string, unknown>>))
    .forEach((cell) => { delete cell.strategyAttachment; });
  const result = normalizeChartWorkspaceWithDiagnostics(legacy);

  assert.equal(result.usedFallback, false);
  assert.equal(result.migratedFromSchemaVersion, 7);
  assert.equal(result.document.schemaVersion, 8);
  assert.equal(chartWorkspaceCell(result.document, "cell-1").session.interval, "5m");
  assert.equal(chartWorkspaceCell(result.document, "cell-1").drawingLayerSet, "3");
  assert.deepEqual(chartWorkspaceCell(result.document, "cell-1").indicators, [{ id: "legacy-sma" }]);
  assert.ok(Object.values(result.document.cells).every((cell) => cell.strategyAttachment === null));
});

test("schemas older than v7 are rejected instead of guessed", () => {
  const old = { ...createDefaultChartWorkspace(), schemaVersion: 6 };
  const result = normalizeChartWorkspaceWithDiagnostics(old);
  assert.equal(result.usedFallback, true);
  assert.equal(result.migratedFromSchemaVersion, null);
  assert.deepEqual(result.diagnostics, [{ code: "unsupported-schema", path: "schemaVersion" }]);
  assert.equal(result.document.schemaVersion, CHART_WORKSPACE_SCHEMA_VERSION);
});

test("malformed v8 strategy attachments fail closed", () => {
  const malformed = createDefaultChartWorkspace();
  (chartWorkspaceCell(malformed, "cell-1") as unknown as Record<string, unknown>)
    .strategyAttachment = {
      schemaVersion: 1,
      strategyDraftId: "draft-12345678",
      strategyRevisionId: null,
      displayName: "Broken range",
      language: "pyne",
      parameters: {},
      rangeMode: "CUSTOM",
      customRange: null,
      fidelityPreference: "FAST",
      quickPresetId: "CRYPTO_PERP_STANDARD_V1",
      autoRun: false,
    };
  const result = normalizeChartWorkspaceWithDiagnostics(malformed);
  assert.equal(result.usedFallback, true);
  assert.ok(result.diagnostics.some((diagnostic) => (
    diagnostic.code === "invalid-strategy-attachment"
  )));
});

test("load reads legacy v7 key without writing storage and v8 takes precedence", () => {
  const legacy = structuredClone(createDefaultChartWorkspace()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 7;
  (legacy as { revision: number }).revision = 7;
  const current = createDefaultChartWorkspace();
  current.revision = 8;
  const legacyOnly = memoryStorage({
    [CHART_WORKSPACE_V7_STORAGE_KEY]: JSON.stringify(legacy),
  });
  assert.equal(loadChartWorkspace(legacyOnly.storage).revision, 7);
  assert.deepEqual([...legacyOnly.values.keys()], [CHART_WORKSPACE_V7_STORAGE_KEY]);

  const both = memoryStorage({
    [CHART_WORKSPACE_V7_STORAGE_KEY]: JSON.stringify(legacy),
    [CHART_WORKSPACE_V8_STORAGE_KEY]: JSON.stringify(current),
  });
  assert.equal(loadChartWorkspace(both.storage).revision, 8);
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
