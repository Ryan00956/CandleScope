import assert from "node:assert/strict";
import test from "node:test";

import {
  CHART_WORKSPACE_BOOTSTRAP_KEY,
  CHART_WORKSPACE_FALLBACK_LIBRARY_KEY,
  createChartWorkspaceRepository,
  type ChartWorkspaceKeyValueStorage,
} from "../chartWorkspaceRepository.js";
import {
  CHART_WORKSPACE_STORAGE_KEY,
  createDefaultChartWorkspace,
} from "../chartWorkspaceStorage.js";
import { createChartWorkspaceRecord } from "../chartWorkspaceLibrary.js";
import {
  createChartWorkspaceLayoutTree,
  detectChartWorkspaceLayout,
} from "../chartWorkspaceLayout.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: ChartWorkspaceKeyValueStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  return { storage, values };
}

test("repository migrates the legacy single workspace into the named local library", async () => {
  const legacy = createDefaultChartWorkspace();
  legacy.layoutTree = createChartWorkspaceLayoutTree("quad");
  legacy.activeCellId = "cell-3";
  const { storage, values } = memoryStorage({
    [CHART_WORKSPACE_STORAGE_KEY]: JSON.stringify(legacy),
  });
  const repository = createChartWorkspaceRepository({
    indexedDB: null,
    storage,
    now: () => 100,
  });

  const loaded = await repository.loadLibrary();

  assert.equal(loaded.persistenceMode, "local-storage");
  assert.equal(loaded.workspaces.length, 1);
  assert.equal(loaded.workspaces[0]!.name, "默认工作区");
  assert.equal(detectChartWorkspaceLayout(loaded.workspaces[0]!.document.layoutTree), "quad");
  assert.equal(loaded.workspaces[0]!.document.activeCellId, "cell-3");
  assert.ok(values.has(CHART_WORKSPACE_BOOTSTRAP_KEY));
});

test("local fallback restores multiple workspaces and their active selection", async () => {
  const { storage, values } = memoryStorage();
  const repository = createChartWorkspaceRepository({ indexedDB: null, storage, now: () => 100 });
  const first = createChartWorkspaceRecord({ id: "one", name: "盘中", createdAt: 1, updatedAt: 1 });
  const second = createChartWorkspaceRecord({ id: "two", name: "波段", createdAt: 2, updatedAt: 2 });
  second.document.layoutTree = createChartWorkspaceLayoutTree("split-horizontal");

  await repository.saveLibrary({ activeWorkspaceId: second.id, workspaces: [first, second] });
  assert.ok(values.has(CHART_WORKSPACE_FALLBACK_LIBRARY_KEY));

  const reloaded = await createChartWorkspaceRepository({
    indexedDB: null,
    storage,
    now: () => 200,
  }).loadLibrary();
  assert.equal(reloaded.activeWorkspaceId, second.id);
  assert.deepEqual(reloaded.workspaces.map((workspace) => workspace.name), ["盘中", "波段"]);
  assert.equal(
    detectChartWorkspaceLayout(reloaded.workspaces[1]!.document.layoutTree),
    "split-horizontal",
  );
});

test("bootstrap journal recovers a change newer than the debounced library save", async () => {
  const { storage } = memoryStorage();
  const repository = createChartWorkspaceRepository({ indexedDB: null, storage, now: () => 100 });
  const stored = createChartWorkspaceRecord({ id: "one", name: "旧名称", createdAt: 1, updatedAt: 2 });
  await repository.saveLibrary({ activeWorkspaceId: stored.id, workspaces: [stored] });

  const recovered = createChartWorkspaceRecord({
    id: stored.id,
    name: "未完成异步保存的名称",
    document: stored.document,
    createdAt: 1,
    updatedAt: 3,
  });
  repository.writeBootstrap({ activeWorkspaceId: recovered.id, workspaces: [recovered] });

  const reloaded = await createChartWorkspaceRepository({
    indexedDB: null,
    storage,
    now: () => 200,
  }).loadLibrary();
  assert.equal(reloaded.workspaces[0]!.name, "未完成异步保存的名称");
  assert.equal(reloaded.workspaces[0]!.updatedAt, 3);
});
