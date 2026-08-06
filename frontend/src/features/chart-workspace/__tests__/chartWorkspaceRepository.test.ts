import assert from "node:assert/strict";
import test from "node:test";

import {
  CHART_WORKSPACE_BOOTSTRAP_KEY,
  CHART_WORKSPACE_FALLBACK_LIBRARY_KEY,
  LEGACY_CHART_WORKSPACE_FALLBACK_LIBRARY_KEY,
  createChartWorkspaceRepository,
  type ChartWorkspaceKeyValueStorage,
  type ChartWorkspaceRepositoryAdapter,
  type ChartWorkspaceRevisionMap,
} from "../chartWorkspaceRepository.js";
import {
  ChartWorkspaceRevisionConflictError,
  activeChartWorkspaceWindow,
  advanceChartWorkspaceRevision,
  replaceChartWorkspaceWindow,
} from "../chartWorkspaceDocument.js";
import { createChartWorkspaceRecord } from "../chartWorkspaceLibrary.js";
import { createChartWorkspaceLayoutTree, detectChartWorkspaceLayout } from "../chartWorkspaceLayout.js";
import { createDefaultChartWorkspace } from "../chartWorkspaceStorage.js";
import type { ChartWorkspaceLibrarySnapshot, ChartWorkspaceRecord } from "../chartWorkspaceTypes.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: ChartWorkspaceKeyValueStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  return { storage, values };
}

function rawV5Record(): Record<string, unknown> {
  const current = createDefaultChartWorkspace();
  return {
    schemaVersion: 1,
    id: "legacy-workspace",
    name: "旧工作区",
    createdAt: 10,
    updatedAt: 20,
    document: {
      schemaVersion: 5,
      layout: "quad",
      layoutTree: createChartWorkspaceLayoutTree("quad"),
      layoutLocked: true,
      activeCellId: "cell-3",
      maximizedCellId: null,
      cells: structuredClone(current.cells),
      linkGroups: structuredClone(current.linkGroups),
    },
  };
}

function revisionMap(records: readonly unknown[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of records) {
    const record = value as Partial<ChartWorkspaceRecord>;
    if (typeof record.id === "string" && record.document) {
      result.set(record.id, record.document.revision);
    }
  }
  return result;
}

class MemoryDualSlotAdapter implements ChartWorkspaceRepositoryAdapter {
  v5Records: unknown[];
  v6Records: unknown[];
  v6WriteCount = 0;

  constructor(options: { v5?: unknown[]; v6?: unknown[] } = {}) {
    this.v5Records = structuredClone(options.v5 ?? []);
    this.v6Records = structuredClone(options.v6 ?? []);
  }

  async loadV6Records(): Promise<unknown[]> {
    return structuredClone(this.v6Records);
  }

  async loadV5Records(): Promise<unknown[]> {
    return structuredClone(this.v5Records);
  }

  async compareAndSwapV6Library(
    snapshot: ChartWorkspaceLibrarySnapshot,
    expectedRevisions: ChartWorkspaceRevisionMap,
  ): Promise<void> {
    const actual = revisionMap(this.v6Records);
    const ids = new Set([...expectedRevisions.keys(), ...actual.keys()]);
    for (const id of ids) {
      const expected = expectedRevisions.get(id) ?? -1;
      const current = actual.get(id) ?? -1;
      if (expected !== current) throw new ChartWorkspaceRevisionConflictError(expected, current, id);
    }
    this.v6Records = structuredClone(snapshot.workspaces);
    this.v6WriteCount += 1;
  }
}

function changedSnapshot(
  snapshot: ChartWorkspaceLibrarySnapshot,
  layoutLocked: boolean,
): ChartWorkspaceLibrarySnapshot {
  const workspace = snapshot.workspaces[0]!;
  const currentWindow = activeChartWorkspaceWindow(workspace.document);
  const candidate = replaceChartWorkspaceWindow(workspace.document, {
    ...currentWindow,
    layoutLocked,
  });
  return {
    ...snapshot,
    workspaces: [{
      ...workspace,
      updatedAt: workspace.updatedAt + 1,
      document: advanceChartWorkspaceRevision(workspace.document, candidate),
    }],
  };
}

test("first v6 load copies the v5 IndexedDB record without mutating the legacy slot", async () => {
  const legacy = rawV5Record();
  const legacyBytes = JSON.stringify(legacy);
  const adapter = new MemoryDualSlotAdapter({ v5: [legacy] });
  const repository = createChartWorkspaceRepository({ adapter, storage: null, now: () => 100 });

  const loaded = await repository.loadLibrary();

  assert.equal(loaded.persistenceMode, "indexeddb");
  assert.equal(loaded.workspaces.length, 1);
  assert.equal(loaded.workspaces[0]!.name, "旧工作区");
  assert.equal(loaded.workspaces[0]!.document.schemaVersion, 6);
  assert.equal(loaded.workspaces[0]!.document.revision, 0);
  assert.equal(detectChartWorkspaceLayout(
    activeChartWorkspaceWindow(loaded.workspaces[0]!.document).layoutTree,
  ), "quad");
  assert.equal(activeChartWorkspaceWindow(loaded.workspaces[0]!.document).activeCellId, "cell-3");
  assert.equal(adapter.v6WriteCount, 1);
  assert.equal(JSON.stringify(adapter.v5Records[0]), legacyBytes);

  await repository.saveLibrary(changedSnapshot(loaded, false));
  assert.equal(adapter.v6WriteCount, 2);
  assert.equal(JSON.stringify(adapter.v5Records[0]), legacyBytes);
});

test("subsequent loads prefer v6 and never consult stale v5 content", async () => {
  const v6 = createChartWorkspaceRecord({ id: "v6", name: "新版本", createdAt: 1, updatedAt: 1 });
  const adapter = new MemoryDualSlotAdapter({ v5: [rawV5Record()], v6: [v6] });
  const loaded = await createChartWorkspaceRepository({ adapter, storage: null }).loadLibrary();
  assert.equal(loaded.workspaces[0]!.id, "v6");
  assert.equal(adapter.v6WriteCount, 0);
});

test("local v6 fallback restores multiple workspaces and leaves the v1 fallback untouched", async () => {
  const legacyFallback = JSON.stringify({ sentinel: "legacy-read-only" });
  const { storage, values } = memoryStorage({
    [LEGACY_CHART_WORKSPACE_FALLBACK_LIBRARY_KEY]: legacyFallback,
  });
  const repository = createChartWorkspaceRepository({ indexedDB: null, storage, now: () => 100 });
  await repository.loadLibrary();
  const first = createChartWorkspaceRecord({ id: "one", name: "盘中", createdAt: 1, updatedAt: 1 });
  const second = createChartWorkspaceRecord({ id: "two", name: "波段", createdAt: 2, updatedAt: 2 });
  second.document = replaceChartWorkspaceWindow(second.document, {
    ...activeChartWorkspaceWindow(second.document),
    layoutTree: createChartWorkspaceLayoutTree("split-horizontal"),
  });

  await repository.saveLibrary({ activeWorkspaceId: second.id, workspaces: [first, second] });
  assert.ok(values.has(CHART_WORKSPACE_FALLBACK_LIBRARY_KEY));
  assert.equal(values.get(LEGACY_CHART_WORKSPACE_FALLBACK_LIBRARY_KEY), legacyFallback);

  const reloaded = await createChartWorkspaceRepository({
    indexedDB: null,
    storage,
    now: () => 200,
  }).loadLibrary();
  assert.equal(reloaded.activeWorkspaceId, second.id);
  assert.deepEqual(reloaded.workspaces.map((workspace) => workspace.name), ["盘中", "波段"]);
  assert.equal(detectChartWorkspaceLayout(
    activeChartWorkspaceWindow(reloaded.workspaces[1]!.document).layoutTree,
  ), "split-horizontal");
});

test("bootstrap journal recovers a revision newer than the debounced library save", async () => {
  const { storage, values } = memoryStorage();
  const repository = createChartWorkspaceRepository({ indexedDB: null, storage, now: () => 100 });
  await repository.loadLibrary();
  const stored = createChartWorkspaceRecord({ id: "one", name: "旧名称", createdAt: 1, updatedAt: 2 });
  await repository.saveLibrary({ activeWorkspaceId: stored.id, workspaces: [stored] });

  const recovered = createChartWorkspaceRecord({
    id: stored.id,
    name: "未完成异步保存的名称",
    document: { ...stored.document, revision: 1 },
    createdAt: 1,
    updatedAt: 3,
  });
  repository.writeBootstrap({ activeWorkspaceId: recovered.id, workspaces: [recovered] });
  assert.ok(values.has(CHART_WORKSPACE_BOOTSTRAP_KEY));

  const reloaded = await createChartWorkspaceRepository({
    indexedDB: null,
    storage,
    now: () => 200,
  }).loadLibrary();
  assert.equal(reloaded.workspaces[0]!.name, "未完成异步保存的名称");
  assert.equal(reloaded.workspaces[0]!.document.revision, 1);
});

test("two repository writers reject a stale document revision instead of last-write-wins", async () => {
  const initial = createChartWorkspaceRecord({ id: "shared", name: "共享", createdAt: 1, updatedAt: 1 });
  const adapter = new MemoryDualSlotAdapter({ v6: [initial] });
  const { storage } = memoryStorage();
  const firstRepository = createChartWorkspaceRepository({ adapter, storage });
  const secondRepository = createChartWorkspaceRepository({ adapter, storage });
  const first = await firstRepository.loadLibrary();
  const second = await secondRepository.loadLibrary();

  const firstChange = changedSnapshot(first, true);
  const staleChange = changedSnapshot(second, false);
  await firstRepository.saveLibrary(firstChange);
  secondRepository.writeBootstrap({
    ...staleChange,
    workspaces: staleChange.workspaces.map((workspace) => ({ ...workspace, updatedAt: 999 })),
  });
  await assert.rejects(
    secondRepository.saveLibrary(staleChange),
    (error: unknown) => error instanceof ChartWorkspaceRevisionConflictError
      && error.workspaceId === "shared"
      && error.expectedRevision === 0
      && error.actualRevision === 1,
  );
  const stored = adapter.v6Records[0] as ChartWorkspaceRecord;
  assert.equal(stored.document.revision, 1);
  assert.equal(activeChartWorkspaceWindow(stored.document).layoutLocked, true);

  const reloaded = await createChartWorkspaceRepository({ adapter, storage }).loadLibrary();
  assert.equal(activeChartWorkspaceWindow(reloaded.workspaces[0]!.document).layoutLocked, true);
});

test("local fallback also rejects a stale revision", async () => {
  const { storage } = memoryStorage();
  const seed = createChartWorkspaceRepository({ indexedDB: null, storage });
  const initial = await seed.loadLibrary();
  await seed.saveLibrary(initial);
  const firstRepository = createChartWorkspaceRepository({ indexedDB: null, storage });
  const secondRepository = createChartWorkspaceRepository({ indexedDB: null, storage });
  const first = await firstRepository.loadLibrary();
  const second = await secondRepository.loadLibrary();
  await firstRepository.saveLibrary(changedSnapshot(first, true));
  await assert.rejects(
    secondRepository.saveLibrary(changedSnapshot(second, false)),
    ChartWorkspaceRevisionConflictError,
  );
});
