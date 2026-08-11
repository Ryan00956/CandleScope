import assert from "node:assert/strict";
import test from "node:test";

import { chartCellDrawingScopeBase } from "../chartWorkspaceDrawingLink.js";
import { activeChartWorkspaceWindow, chartWorkspaceCell, replaceChartWorkspaceWindow } from "../chartWorkspaceDocument.js";
import { chartCellStorageScope } from "../chartWorkspaceLibrary.js";
import {
  CHART_WORKSPACE_STORAGE_KEY,
  CHART_WORKSPACE_V6_STORAGE_KEY,
  LEGACY_CHART_WORKSPACE_STORAGE_KEY,
  createDefaultChartWorkspace,
  loadChartWorkspace,
  normalizeChartWorkspaceWithDiagnostics,
  saveChartWorkspace,
  type ChartWorkspaceStorageLike,
} from "../chartWorkspaceStorage.js";
import {
  createChartWorkspaceLayoutTree,
  detectChartWorkspaceLayout,
  updateChartWorkspaceSplitRatio,
  visibleCellIds,
} from "../chartWorkspaceLayout.js";
import type {
  ChartCellId,
  ChartWindowId,
  ChartWorkspaceDocument,
  ChartWorkspaceLayoutNode,
} from "../chartWorkspaceTypes.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: ChartWorkspaceStorageLike = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
  return { storage, values };
}

function windowOf(document: ChartWorkspaceDocument) {
  return activeChartWorkspaceWindow(document);
}

function splitRatios(tree: ChartWorkspaceLayoutNode): Record<string, number> {
  if (tree.kind === "cell") return {};
  return {
    [tree.id]: tree.ratio,
    ...splitRatios(tree.first),
    ...splitRatios(tree.second),
  };
}

function legacyDocument(schemaVersion: number, layout: "single" | "split-horizontal" | "quad" = "single") {
  const current = createDefaultChartWorkspace();
  return {
    schemaVersion,
    layout,
    layoutTree: createChartWorkspaceLayoutTree(layout),
    layoutLocked: true,
    activeCellId: layout === "quad" ? "cell-3" : "cell-1",
    maximizedCellId: null,
    layoutRatios: {
      splitVertical: 0.5,
      splitHorizontal: 0.5,
      quadColumns: 0.64,
      quadRows: 0.42,
    },
    linkGroups: structuredClone(current.linkGroups),
    cells: structuredClone(current.cells),
  };
}

function skewedTree(ids: readonly ChartCellId[]): ChartWorkspaceLayoutNode {
  let tree: ChartWorkspaceLayoutNode = { kind: "cell", cellId: ids[0]! };
  for (let index = 1; index < ids.length; index += 1) {
    tree = {
      kind: "split",
      id: `split-${index}`,
      direction: index % 2 === 0 ? "rows" : "columns",
      ratio: 0.5,
      first: tree,
      second: { kind: "cell", cellId: ids[index]! },
    };
  }
  return tree;
}

test("workspace defaults to schema v6 main-window with four stable cells and one visible leaf", () => {
  const workspace = createDefaultChartWorkspace();
  assert.equal(workspace.schemaVersion, 6);
  assert.equal(workspace.revision, 0);
  assert.equal(workspace.activeWindowId, "main-window");
  assert.deepEqual(Object.keys(workspace.windows), ["main-window"]);
  assert.equal(windowOf(workspace).layoutLocked, false);
  assert.deepEqual(Object.keys(workspace.cells), ["cell-1", "cell-2", "cell-3", "cell-4"]);
  assert.deepEqual(Object.values(workspace.cells).map((cell) => cell.linkGroup), ["A", "A", "A", "A"]);
  assert.deepEqual(visibleCellIds(windowOf(workspace).layoutTree), ["cell-1"]);
});

test("v6 persistence keeps revision, recursive ratios, window state, and cell-scoped state", () => {
  const { storage } = memoryStorage();
  let workspace = createDefaultChartWorkspace();
  let tree = createChartWorkspaceLayoutTree("quad");
  tree = updateChartWorkspaceSplitRatio(tree, "quad-root", 0.42);
  tree = updateChartWorkspaceSplitRatio(tree, "quad-top", 0.64);
  tree = updateChartWorkspaceSplitRatio(tree, "quad-bottom", 0.58);
  workspace = replaceChartWorkspaceWindow({ ...workspace, revision: 7 }, {
    ...windowOf(workspace),
    layoutTree: tree,
    layoutLocked: true,
    activeCellId: "cell-2",
    boundsDip: { x: 10, y: 20, width: 1280, height: 720 },
    monitorFingerprint: "display-primary",
    dpiScale: 1.5,
  });
  const cellTwo = chartWorkspaceCell(workspace, "cell-2");
  workspace.cells["cell-2"] = {
    ...cellTwo,
    session: { exchange: "binance", marketType: "futures", symbol: "ETHUSDT", interval: "15m" },
    priceScale: { invertScale: true, priceScaleMode: 2 },
    linkGroup: "B",
    linkRole: "destination",
    drawingLayerSet: "3",
    indicators: [{ id: "persist-me", params: { length: 21 } }],
  };
  workspace.linkGroups.B.interval = true;
  workspace.linkGroups.B.drawings = true;
  saveChartWorkspace(workspace, storage);

  const restored = loadChartWorkspace(storage);
  assert.equal(restored.schemaVersion, 6);
  assert.equal(restored.revision, 7);
  assert.equal(windowOf(restored).layoutLocked, true);
  assert.equal(detectChartWorkspaceLayout(windowOf(restored).layoutTree), "quad");
  assert.equal(windowOf(restored).activeCellId, "cell-2");
  assert.deepEqual(windowOf(restored).boundsDip, { x: 10, y: 20, width: 1280, height: 720 });
  assert.deepEqual(chartWorkspaceCell(restored, "cell-2"), workspace.cells["cell-2"]);
  assert.deepEqual(splitRatios(windowOf(restored).layoutTree), {
    "quad-root": 0.42,
    "quad-top": 0.64,
    "quad-bottom": 0.58,
  });
});

for (const version of [1, 2, 3, 4, 5]) {
  test(`v${version} migrates into v6 main-window while preserving legacy cell identity`, () => {
    const legacy = legacyDocument(version, version === 1 ? "split-horizontal" : "quad");
    if (version === 1) {
      delete (legacy as Record<string, unknown>).linkGroups;
    }
    if (version === 3) {
      (legacy.linkGroups.A as unknown as Record<string, unknown>).timeRange = true;
      delete (legacy.linkGroups.A as unknown as Record<string, unknown>).dateRange;
    }
    const result = normalizeChartWorkspaceWithDiagnostics(legacy);
    assert.equal(result.usedFallback, false);
    assert.equal(result.migratedFromSchemaVersion, version);
    assert.equal(result.document.schemaVersion, 6);
    assert.equal(result.document.revision, 0);
    assert.equal(result.document.activeWindowId, "main-window");
    assert.deepEqual(Object.keys(result.document.cells), ["cell-1", "cell-2", "cell-3", "cell-4"]);
    assert.equal(
      detectChartWorkspaceLayout(windowOf(result.document).layoutTree),
      version === 1 ? "split-horizontal" : "quad",
    );
    assert.equal(windowOf(result.document).layoutLocked, version === 5);
  });
}

test("v5 migration preserves drawing, visible-range, and indicator scope identities", () => {
  const legacy = legacyDocument(5, "quad");
  legacy.cells["cell-2"]!.linkGroup = "B";
  legacy.cells["cell-2"]!.drawingLayerSet = "3";
  legacy.cells["cell-2"]!.indicators = [{ id: "scope-indicator", params: { length: 55 } }];
  legacy.linkGroups.B.drawings = true;
  const workspaceId = "workspace-scope";
  const expectedStorageScope = chartCellStorageScope(workspaceId, "cell-2");
  const migrated = normalizeChartWorkspaceWithDiagnostics(legacy).document;

  assert.equal(chartCellStorageScope(workspaceId, "cell-2"), expectedStorageScope);
  assert.equal(
    chartCellDrawingScopeBase(workspaceId, migrated, "cell-2"),
    ["workspace-link", workspaceId, "B", "layer-3", "binance", "spot", "BTCUSDT"].join(":"),
  );
  assert.deepEqual(chartWorkspaceCell(migrated, "cell-2").indicators, [
    { id: "scope-indicator", params: { length: 55 } },
  ]);
});

test("save writes only the v6 local slot and leaves both legacy keys byte-for-byte unchanged", () => {
  const v5Raw = JSON.stringify(legacyDocument(5, "quad"));
  const v1Raw = JSON.stringify(legacyDocument(1, "single"));
  const { storage, values } = memoryStorage({
    [CHART_WORKSPACE_STORAGE_KEY]: v5Raw,
    [LEGACY_CHART_WORKSPACE_STORAGE_KEY]: v1Raw,
  });
  saveChartWorkspace(loadChartWorkspace(storage), storage);
  assert.ok(values.has(CHART_WORKSPACE_V6_STORAGE_KEY));
  assert.equal(values.get(CHART_WORKSPACE_STORAGE_KEY), v5Raw);
  assert.equal(values.get(LEGACY_CHART_WORKSPACE_STORAGE_KEY), v1Raw);
});

test("v6 can express four windows with sixteen disjoint cells each", () => {
  const document = createDefaultChartWorkspace();
  const cells: ChartWorkspaceDocument["cells"] = {};
  const windows: ChartWorkspaceDocument["windows"] = {};
  for (let windowIndex = 1; windowIndex <= 4; windowIndex += 1) {
    const ids = Array.from({ length: 16 }, (_, index) => `cell-w${windowIndex}-${index + 1}`);
    for (const id of ids) cells[id] = { ...chartWorkspaceCell(document, "cell-1"), id };
    const id: ChartWindowId = windowIndex === 1 ? "main-window" : `window-${windowIndex}`;
    windows[id] = {
      ...windowOf(document),
      id,
      layoutTree: skewedTree(ids),
      activeCellId: ids[0]!,
    };
  }
  const result = normalizeChartWorkspaceWithDiagnostics({
    ...document,
    cells,
    windows,
    activeWindowId: "main-window",
  });
  assert.equal(result.usedFallback, false);
  assert.equal(Object.keys(result.document.windows).length, 4);
  assert.equal(Object.keys(result.document.cells).length, 64);
  assert.deepEqual(Object.values(result.document.windows).map((entry) => (
    visibleCellIds(entry.layoutTree).length
  )), [16, 16, 16, 16]);
});

test("malformed v6 duplicate, dangling, over-limit, and over-depth documents fail closed with diagnostics", () => {
  const base = createDefaultChartWorkspace();
  const main = windowOf(base);
  const cases: Array<{ value: unknown; code: string }> = [
    {
      value: {
        ...base,
        windows: {
          "main-window": {
            ...main,
            layoutTree: {
              kind: "split",
              id: "duplicate",
              direction: "columns",
              ratio: 0.5,
              first: { kind: "cell", cellId: "cell-1" },
              second: { kind: "cell", cellId: "cell-1" },
            },
          },
        },
      },
      code: "layout-duplicate-cell-id",
    },
    {
      value: {
        ...base,
        windows: {
          "main-window": { ...main, layoutTree: { kind: "cell", cellId: "cell-dangling" } },
        },
      },
      code: "layout-dangling-cell-id",
    },
    {
      value: {
        ...base,
        cells: Object.fromEntries(Array.from({ length: 65 }, (_, index) => {
          const id = `cell-over-${index + 1}`;
          return [id, { ...chartWorkspaceCell(base, "cell-1"), id }];
        })),
      },
      code: "max-cells-app",
    },
    {
      value: {
        ...base,
        windows: Object.fromEntries(Array.from({ length: 5 }, (_, index) => {
          const id = index === 0 ? "main-window" : `window-${index + 1}`;
          return [id, { ...main, id }];
        })),
      },
      code: "max-windows",
    },
    {
      value: (() => {
        const ids = Array.from({ length: 18 }, (_, index) => `cell-depth-${index + 1}`);
        const cells = Object.fromEntries(ids.map((id) => [id, { ...chartWorkspaceCell(base, "cell-1"), id }]));
        return {
          ...base,
          cells,
          windows: {
            "main-window": { ...main, layoutTree: skewedTree(ids), activeCellId: ids[0] },
          },
        };
      })(),
      code: "layout-max-depth",
    },
  ];

  for (const candidate of cases) {
    const result = normalizeChartWorkspaceWithDiagnostics(candidate.value);
    assert.equal(result.usedFallback, true);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === candidate.code), candidate.code);
    assert.deepEqual(visibleCellIds(windowOf(result.document).layoutTree), ["cell-1"]);
  }
});

test("malformed JSON fails closed to the v6 default", () => {
  const { storage } = memoryStorage({ [CHART_WORKSPACE_V6_STORAGE_KEY]: "{not-json" });
  const restored = loadChartWorkspace(storage);
  assert.equal(restored.schemaVersion, 6);
  assert.deepEqual(visibleCellIds(windowOf(restored).layoutTree), ["cell-1"]);
});
