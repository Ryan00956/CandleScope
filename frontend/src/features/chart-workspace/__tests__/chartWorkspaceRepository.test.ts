import assert from "node:assert/strict";
import test from "node:test";

import {
  CHART_WORKSPACE_BOOTSTRAP_KEY,
  CHART_WORKSPACE_FALLBACK_LIBRARY_KEY,
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

function revisions(records: readonly unknown[]) {
  return new Map(records.map((value) => {
    const record = value as ChartWorkspaceRecord;
    return [record.id, record.document.revision] as const;
  }));
}

class MemoryV7Adapter implements ChartWorkspaceRepositoryAdapter {
  records: unknown[];
  writeCount = 0;

  constructor(records: unknown[] = []) {
    this.records = structuredClone(records);
  }

  async loadV7Records(): Promise<unknown[]> {
    return structuredClone(this.records);
  }

  async compareAndSwapV7Library(
    snapshot: ChartWorkspaceLibrarySnapshot,
    expected: ChartWorkspaceRevisionMap,
  ): Promise<void> {
    const actual = revisions(this.records);
    for (const id of new Set([...expected.keys(), ...actual.keys()])) {
      const expectedRevision = expected.get(id) ?? -1;
      const actualRevision = actual.get(id) ?? -1;
      if (expectedRevision !== actualRevision) {
        throw new ChartWorkspaceRevisionConflictError(expectedRevision, actualRevision, id);
      }
    }
    this.records = structuredClone(snapshot.workspaces);
    this.writeCount += 1;
  }
}

function changedSnapshot(
  snapshot: ChartWorkspaceLibrarySnapshot,
  layoutLocked: boolean,
): ChartWorkspaceLibrarySnapshot {
  const workspace = snapshot.workspaces[0]!;
  const window = activeChartWorkspaceWindow(workspace.document);
  const candidate = replaceChartWorkspaceWindow(workspace.document, { ...window, layoutLocked });
  return {
    ...snapshot,
    workspaces: [{
      ...workspace,
      updatedAt: workspace.updatedAt + 1,
      document: advanceChartWorkspaceRevision(workspace.document, candidate),
    }],
  };
}

test("an empty v7 database is seeded without consulting an old store", async () => {
  const adapter = new MemoryV7Adapter();
  const repository = createChartWorkspaceRepository({ adapter, storage: null, now: () => 100 });
  const loaded = await repository.loadLibrary();
  assert.equal(loaded.persistenceMode, "indexeddb");
  assert.equal(loaded.workspaces[0]!.document.schemaVersion, 8);
  assert.equal(adapter.writeCount, 1);
});

test("existing v7 records load without a seed write", async () => {
  const record = createChartWorkspaceRecord({ id: "v7", name: "层级联动", createdAt: 1 });
  const legacy = structuredClone(record) as unknown as Record<string, unknown>;
  const document = legacy.document as Record<string, unknown>;
  document.schemaVersion = 7;
  Object.values(document.cells as Record<string, Record<string, unknown>>)
    .forEach((cell) => { delete cell.strategyAttachment; });
  const adapter = new MemoryV7Adapter([legacy]);
  const loaded = await createChartWorkspaceRepository({ adapter, storage: null }).loadLibrary();
  assert.equal(loaded.workspaces[0]!.id, "v7");
  assert.equal(loaded.workspaces[0]!.document.schemaVersion, 8);
  assert.ok(Object.values(loaded.workspaces[0]!.document.cells)
    .every((cell) => cell.strategyAttachment === null));
  assert.equal(adapter.writeCount, 0);
});

test("local fallback persists multiple workspaces in the v7-only slot", async () => {
  const { storage, values } = memoryStorage();
  const repository = createChartWorkspaceRepository({ indexedDB: null, storage, now: () => 100 });
  await repository.loadLibrary();
  const first = createChartWorkspaceRecord({ id: "one", name: "盘中", createdAt: 1 });
  const second = createChartWorkspaceRecord({ id: "two", name: "波段", createdAt: 2 });
  await repository.saveLibrary({ activeWorkspaceId: second.id, workspaces: [first, second] });
  assert.ok(values.has(CHART_WORKSPACE_FALLBACK_LIBRARY_KEY));

  const reloaded = await createChartWorkspaceRepository({
    indexedDB: null,
    storage,
    now: () => 200,
  }).loadLibrary();
  assert.equal(reloaded.activeWorkspaceId, "two");
  assert.deepEqual(reloaded.workspaces.map((workspace) => workspace.name), ["盘中", "波段"]);
});

test("a newer bootstrap record recovers before the async save completes", async () => {
  const stored = createChartWorkspaceRecord({ id: "one", name: "旧名称", createdAt: 1 });
  const recovered = createChartWorkspaceRecord({
    id: stored.id,
    name: "退出前状态",
    document: { ...stored.document, revision: 1 },
    createdAt: 1,
    updatedAt: 3,
  });
  const { storage } = memoryStorage({
    [CHART_WORKSPACE_BOOTSTRAP_KEY]: JSON.stringify(recovered),
  });
  const adapter = new MemoryV7Adapter([stored]);
  const loaded = await createChartWorkspaceRepository({ adapter, storage }).loadLibrary();
  assert.equal(loaded.workspaces[0]!.name, "退出前状态");
  assert.equal(loaded.workspaces[0]!.document.revision, 1);
});

test("two writers reject a stale revision instead of last-write-wins", async () => {
  const initial = createChartWorkspaceRecord({ id: "shared", name: "共享", createdAt: 1 });
  const adapter = new MemoryV7Adapter([initial]);
  const firstRepository = createChartWorkspaceRepository({ adapter, storage: null });
  const secondRepository = createChartWorkspaceRepository({ adapter, storage: null });
  const first = await firstRepository.loadLibrary();
  const second = await secondRepository.loadLibrary();
  await firstRepository.saveLibrary(changedSnapshot(first, true));
  await assert.rejects(
    secondRepository.saveLibrary(changedSnapshot(second, false)),
    ChartWorkspaceRevisionConflictError,
  );
  const stored = adapter.records[0] as ChartWorkspaceRecord;
  assert.equal(stored.document.revision, 1);
  assert.equal(activeChartWorkspaceWindow(stored.document).layoutLocked, true);
});
