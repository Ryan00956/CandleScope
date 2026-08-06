import assert from "node:assert/strict";
import test from "node:test";

import {
  chartCellStorageScope,
  createChartWorkspaceRecord,
  createDefaultChartWorkspaceRecord,
  createTemplateChartWorkspaceDocument,
  mergeWorkspaceRecoveryRecord,
  normalizeChartWorkspaceLibrary,
  removeChartWorkspace,
  uniqueChartWorkspaceName,
} from "../chartWorkspaceLibrary.js";
import { createDefaultChartWorkspace } from "../chartWorkspaceStorage.js";
import {
  activeChartWorkspaceWindow,
  chartWorkspaceCell,
  replaceChartWorkspaceWindow,
} from "../chartWorkspaceDocument.js";
import {
  detectChartWorkspaceLayout,
  findChartWorkspaceCellRole,
  visibleCellIds,
} from "../chartWorkspaceLayout.js";

test("workspace templates inherit the active market and chart preferences without sharing objects", () => {
  const source = createDefaultChartWorkspace();
  const sourceWindow = activeChartWorkspaceWindow(source);
  Object.assign(source, replaceChartWorkspaceWindow(source, {
    ...sourceWindow,
    layoutLocked: true,
    activeCellId: "cell-2",
  }));
  chartWorkspaceCell(source, "cell-2").session = {
    exchange: "okx",
    marketType: "futures",
    symbol: "ETHUSDT",
    interval: "30m",
  };
  chartWorkspaceCell(source, "cell-2").indicators = [{ id: "rsi", params: { length: 7 } }];

  const document = createTemplateChartWorkspaceDocument("quad", source);

  const window = activeChartWorkspaceWindow(document);
  assert.equal(detectChartWorkspaceLayout(window.layoutTree), "quad");
  assert.equal(window.activeCellId, "cell-1");
  assert.equal(window.maximizedCellId, null);
  assert.equal(window.layoutLocked, false);
  assert.deepEqual(
    Object.values(document.cells).map((cell) => [
      cell.session.exchange,
      cell.session.marketType,
      cell.session.symbol,
    ]),
    Array.from({ length: 4 }, () => ["okx", "futures", "ETHUSDT"]),
  );
  assert.equal(chartWorkspaceCell(document, "cell-1").session.interval, "30m");
  assert.deepEqual(
    ["cell-2", "cell-3", "cell-4"].map((id) => chartWorkspaceCell(document, id).session.interval),
    ["15m", "4h", "1d"],
  );
  assert.deepEqual(chartWorkspaceCell(document, "cell-1").indicators, chartWorkspaceCell(source, "cell-2").indicators);
  assert.notEqual(chartWorkspaceCell(document, "cell-1").indicators, chartWorkspaceCell(source, "cell-2").indicators);
  assert.notEqual(chartWorkspaceCell(document, "cell-1").indicators[0]?.params, chartWorkspaceCell(source, "cell-2").indicators[0]?.params);
});

test("main and confirmation template uses one primary and two higher-timeframe confirmation cells", () => {
  const source = createDefaultChartWorkspace();
  chartWorkspaceCell(source, "cell-1").session.interval = "30m";
  const document = createTemplateChartWorkspaceDocument("main-confirmation", source);
  const window = activeChartWorkspaceWindow(document);

  assert.equal(detectChartWorkspaceLayout(window.layoutTree), "main-confirmation");
  assert.deepEqual(visibleCellIds(window.layoutTree), ["cell-1", "cell-2", "cell-3"]);
  assert.deepEqual([
    chartWorkspaceCell(document, "cell-1").session.interval,
    chartWorkspaceCell(document, "cell-2").session.interval,
    chartWorkspaceCell(document, "cell-3").session.interval,
  ], ["30m", "4h", "1d"]);
  assert.equal(findChartWorkspaceCellRole(window.layoutTree, "cell-1"), "main");
  assert.equal(findChartWorkspaceCellRole(window.layoutTree, "cell-2"), "confirmation");
  assert.equal(findChartWorkspaceCellRole(window.layoutTree, "cell-3"), "confirmation");
  assert.deepEqual([
    chartWorkspaceCell(document, "cell-1").linkRole,
    chartWorkspaceCell(document, "cell-2").linkRole,
    chartWorkspaceCell(document, "cell-3").linkRole,
  ], ["source", "destination", "destination"]);
});

test("library normalization fails a structurally malformed v6 document closed", () => {
  const record = createDefaultChartWorkspaceRecord(100);
  const raw = structuredClone(record) as unknown as Record<string, unknown>;
  const rawDocument = raw.document as Record<string, unknown>;
  const rawCells = rawDocument.cells as Record<string, unknown>;
  rawCells["cell-2"] = { session: { symbol: 42 }, indicators: "bad" };
  rawCells["cell-3"] = {
    ...chartWorkspaceCell(record.document, "cell-3"),
    session: {
      exchange: "binance",
      marketType: "spot",
      symbol: "SOLUSDT",
      interval: "4h",
    },
  };

  const library = normalizeChartWorkspaceLibrary({
    activeWorkspaceId: record.id,
    workspaces: [raw],
  }, record, 200);

  assert.equal(library.workspaces.length, 1);
  const normalized = library.workspaces[0]!.document;
  assert.deepEqual(Object.keys(normalized.cells), ["cell-1", "cell-2", "cell-3", "cell-4"]);
  assert.equal(chartWorkspaceCell(normalized, "cell-2").session.symbol, "BTCUSDT");
  assert.notEqual(chartWorkspaceCell(normalized, "cell-3").session.symbol, "SOLUSDT");
});

test("workspace names remain unique and deleting the active workspace selects a stable neighbor", () => {
  const first = createChartWorkspaceRecord({ id: "one", name: "盘中", createdAt: 1 });
  const second = createChartWorkspaceRecord({ id: "two", name: "盘中 2", createdAt: 2 });
  const third = createChartWorkspaceRecord({ id: "three", name: "波段", createdAt: 3 });
  assert.equal(uniqueChartWorkspaceName("盘中", [first, second, third]), "盘中 3");
  assert.equal(uniqueChartWorkspaceName("盘中", [first, second, third], first.id), "盘中");

  const next = removeChartWorkspace({
    activeWorkspaceId: second.id,
    workspaces: [first, second, third],
  }, second.id);
  assert.equal(next.activeWorkspaceId, third.id);
  assert.deepEqual(next.workspaces.map((workspace) => workspace.id), [first.id, third.id]);
  assert.equal(removeChartWorkspace({ activeWorkspaceId: first.id, workspaces: [first] }, first.id).workspaces.length, 1);
});

test("a newer synchronous recovery record wins over an older async snapshot", () => {
  const stored = createChartWorkspaceRecord({ id: "one", name: "旧名称", createdAt: 1, updatedAt: 2 });
  const recovery = createChartWorkspaceRecord({
    id: "one",
    name: "恢复名称",
    document: stored.document,
    createdAt: 1,
    updatedAt: 3,
  });
  const merged = mergeWorkspaceRecoveryRecord({
    activeWorkspaceId: stored.id,
    workspaces: [stored],
  }, recovery, recovery.id);
  assert.equal(merged.workspaces[0]!.name, "恢复名称");
  assert.equal(merged.activeWorkspaceId, recovery.id);
});

test("cell persistence scopes preserve the migrated default workspace and isolate named workspaces", () => {
  assert.equal(chartCellStorageScope("workspace-default", "cell-2"), "cell-2");
  assert.equal(chartCellStorageScope("workspace-research", "cell-2"), "workspace-research:cell-2");
});
