import {
  CHART_WORKSPACE_STORAGE_KEY,
  LEGACY_CHART_WORKSPACE_STORAGE_KEY,
  loadLegacyChartWorkspace,
} from "./chartWorkspaceStorage.js";
import {
  DEFAULT_CHART_WORKSPACE_ID,
  DEFAULT_CHART_WORKSPACE_NAME,
  createChartWorkspaceRecord,
  createDefaultChartWorkspaceRecord,
  mergeWorkspaceRecoveryRecord,
  normalizeChartWorkspaceId,
  normalizeChartWorkspaceLibrary,
  normalizeChartWorkspaceRecord,
} from "./chartWorkspaceLibrary.js";
import { ChartWorkspaceRevisionConflictError } from "./chartWorkspaceDocument.js";
import type {
  ChartWorkspaceId,
  ChartWorkspaceLibrarySnapshot,
  ChartWorkspaceRecord,
} from "./chartWorkspaceTypes.js";

/** The v5 database is deliberately frozen so an old build can still roll back. */
export const LEGACY_CHART_WORKSPACE_DATABASE_NAME = "candlescope-chart-workspaces";
export const LEGACY_CHART_WORKSPACE_DATABASE_VERSION = 1;
export const LEGACY_CHART_WORKSPACE_OBJECT_STORE = "workspaces";
export const LEGACY_CHART_WORKSPACE_ACTIVE_ID_KEY = "candlescope-active-workspace-id-v1";
export const LEGACY_CHART_WORKSPACE_BOOTSTRAP_KEY = "candlescope-active-workspace-bootstrap-v1";
export const LEGACY_CHART_WORKSPACE_FALLBACK_LIBRARY_KEY = "candlescope-workspace-library-fallback-v1";

/** v6 uses an independent database, rather than a version upgrade of the v5 slot. */
export const CHART_WORKSPACE_DATABASE_NAME = "candlescope-chart-workspaces-v6";
export const CHART_WORKSPACE_DATABASE_VERSION = 1;
export const CHART_WORKSPACE_OBJECT_STORE = "workspaces-v6";
export const CHART_WORKSPACE_ACTIVE_ID_KEY = "candlescope-active-workspace-id-v2";
export const CHART_WORKSPACE_BOOTSTRAP_KEY = "candlescope-active-workspace-bootstrap-v2";
export const CHART_WORKSPACE_FALLBACK_LIBRARY_KEY = "candlescope-workspace-library-fallback-v2";

export type ChartWorkspacePersistenceMode = "indexeddb" | "local-storage" | "memory" | "workspace-bus";
export type ChartWorkspaceRevisionMap = ReadonlyMap<ChartWorkspaceId, number>;

export interface ChartWorkspaceLoadResult extends ChartWorkspaceLibrarySnapshot {
  persistenceMode: ChartWorkspacePersistenceMode;
}

export interface ChartWorkspaceKeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface ChartWorkspaceRepositoryAdapter {
  loadV6Records(): Promise<unknown[]>;
  loadV5Records(): Promise<unknown[]>;
  compareAndSwapV6Library(
    snapshot: ChartWorkspaceLibrarySnapshot,
    expectedRevisions: ChartWorkspaceRevisionMap,
  ): Promise<void>;
}

export interface ChartWorkspaceRepository {
  loadBootstrapLibrary(): ChartWorkspaceLibrarySnapshot;
  loadLibrary(): Promise<ChartWorkspaceLoadResult>;
  saveLibrary(snapshot: ChartWorkspaceLibrarySnapshot): Promise<ChartWorkspacePersistenceMode>;
  writeBootstrap(snapshot: ChartWorkspaceLibrarySnapshot): void;
}

export interface CreateChartWorkspaceRepositoryOptions {
  indexedDB?: IDBFactory | null;
  storage?: ChartWorkspaceKeyValueStorage | null;
  adapter?: ChartWorkspaceRepositoryAdapter | null;
  now?: () => number;
}

function browserStorage(): ChartWorkspaceKeyValueStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function browserIndexedDB(): IDBFactory | null {
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function activeRecord(snapshot: ChartWorkspaceLibrarySnapshot): ChartWorkspaceRecord {
  return snapshot.workspaces.find((workspace) => workspace.id === snapshot.activeWorkspaceId)
    ?? snapshot.workspaces[0]!;
}

function revisionMap(snapshot: ChartWorkspaceLibrarySnapshot): Map<ChartWorkspaceId, number> {
  return new Map(snapshot.workspaces.map((record) => [record.id, record.document.revision]));
}

function normalizedRecords(
  records: readonly unknown[],
  now: number,
): ChartWorkspaceRecord[] {
  return records
    .map((record) => normalizeChartWorkspaceRecord(record, now))
    .filter((record): record is ChartWorkspaceRecord => record !== null);
}

function assertRevisionsMatch(
  expected: ChartWorkspaceRevisionMap,
  actual: ChartWorkspaceRevisionMap,
): void {
  const ids = new Set([...expected.keys(), ...actual.keys()]);
  for (const id of ids) {
    const expectedRevision = expected.get(id) ?? -1;
    const actualRevision = actual.get(id) ?? -1;
    if (expectedRevision !== actualRevision) {
      throw new ChartWorkspaceRevisionConflictError(expectedRevision, actualRevision, id);
    }
  }
}

function openWorkspaceDatabase(
  factory: IDBFactory,
  name: string,
  version: number,
  storeName: string,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`Unable to open ${name}`));
    request.onblocked = () => reject(new Error(`${name} upgrade is blocked`));
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Workspace database request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      transaction.error ?? new Error("Workspace database transaction failed"),
    );
    transaction.onabort = () => reject(
      transaction.error ?? new Error("Workspace database transaction was aborted"),
    );
  });
}

async function loadIndexedDbRecords(
  factory: IDBFactory,
  name: string,
  version: number,
  storeName: string,
): Promise<unknown[]> {
  const database = await openWorkspaceDatabase(factory, name, version, storeName);
  try {
    const transaction = database.transaction(storeName, "readonly");
    const done = transactionDone(transaction);
    const request = transaction.objectStore(storeName).getAll() as IDBRequest<unknown[]>;
    const records = await requestValue(request);
    await done;
    return records;
  } finally {
    database.close();
  }
}

class IndexedDbChartWorkspaceAdapter implements ChartWorkspaceRepositoryAdapter {
  constructor(private readonly factory: IDBFactory) {}

  loadV6Records(): Promise<unknown[]> {
    return loadIndexedDbRecords(
      this.factory,
      CHART_WORKSPACE_DATABASE_NAME,
      CHART_WORKSPACE_DATABASE_VERSION,
      CHART_WORKSPACE_OBJECT_STORE,
    );
  }

  loadV5Records(): Promise<unknown[]> {
    return loadIndexedDbRecords(
      this.factory,
      LEGACY_CHART_WORKSPACE_DATABASE_NAME,
      LEGACY_CHART_WORKSPACE_DATABASE_VERSION,
      LEGACY_CHART_WORKSPACE_OBJECT_STORE,
    );
  }

  async compareAndSwapV6Library(
    snapshot: ChartWorkspaceLibrarySnapshot,
    expectedRevisions: ChartWorkspaceRevisionMap,
  ): Promise<void> {
    const database = await openWorkspaceDatabase(
      this.factory,
      CHART_WORKSPACE_DATABASE_NAME,
      CHART_WORKSPACE_DATABASE_VERSION,
      CHART_WORKSPACE_OBJECT_STORE,
    );
    try {
      const transaction = database.transaction(CHART_WORKSPACE_OBJECT_STORE, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(CHART_WORKSPACE_OBJECT_STORE);
      const rawRecords = await requestValue(store.getAll() as IDBRequest<unknown[]>);
      const current = normalizeChartWorkspaceLibrary(
        { workspaces: rawRecords },
        createDefaultChartWorkspaceRecord(),
      );
      const actual = rawRecords.length === 0 ? new Map() : revisionMap(current);
      try {
        assertRevisionsMatch(expectedRevisions, actual);
      } catch (error) {
        transaction.abort();
        void done.catch(() => undefined);
        throw error;
      }
      store.clear();
      snapshot.workspaces.forEach((workspace) => store.put(workspace));
      await done;
    } finally {
      database.close();
    }
  }
}

class BrowserChartWorkspaceRepository implements ChartWorkspaceRepository {
  private readonly adapter: ChartWorkspaceRepositoryAdapter | null;
  private readonly storage: ChartWorkspaceKeyValueStorage | null;
  private readonly now: () => number;
  private memorySnapshot: ChartWorkspaceLibrarySnapshot | null = null;
  private expectedV6Revisions = new Map<ChartWorkspaceId, number>();
  private expectedFallbackRevisions = new Map<ChartWorkspaceId, number>();

  constructor(options: CreateChartWorkspaceRepositoryOptions) {
    const factory = options.indexedDB === undefined ? browserIndexedDB() : options.indexedDB;
    this.adapter = options.adapter === undefined
      ? factory ? new IndexedDbChartWorkspaceAdapter(factory) : null
      : options.adapter;
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.now = options.now ?? Date.now;
  }

  loadBootstrapLibrary(): ChartWorkspaceLibrarySnapshot {
    const recovery = this.readBootstrapRecord();
    if (recovery) return { activeWorkspaceId: recovery.id, workspaces: [recovery] };
    const fallback = this.readFallbackLibrary() ?? this.readLegacyFallbackLibrary();
    if (fallback) return fallback;
    const legacy = this.readLegacyRecord();
    if (legacy) return { activeWorkspaceId: legacy.id, workspaces: [legacy] };
    const workspace = createDefaultChartWorkspaceRecord(this.now());
    return { activeWorkspaceId: workspace.id, workspaces: [workspace] };
  }

  async loadLibrary(): Promise<ChartWorkspaceLoadResult> {
    const recovery = this.readBootstrapRecord();
    const requestedActiveId = this.readActiveWorkspaceId() ?? recovery?.id ?? null;
    const fallback = this.readFallbackLibrary();
    if (this.adapter) {
      try {
        const rawV6 = await this.adapter.loadV6Records();
        const v6Records = normalizedRecords(rawV6, this.now());
        const seed = v6Records.length > 0
          ? { activeWorkspaceId: requestedActiveId, workspaces: v6Records }
          : await this.legacySeed(requestedActiveId, fallback);
        const normalized = normalizeChartWorkspaceLibrary(
          { ...seed, activeWorkspaceId: requestedActiveId ?? seed.activeWorkspaceId },
          recovery ?? createDefaultChartWorkspaceRecord(this.now()),
          this.now(),
        );
        const snapshot = mergeWorkspaceRecoveryRecord(normalized, recovery, requestedActiveId);
        this.expectedV6Revisions = v6Records.length > 0
          ? revisionMap(normalizeChartWorkspaceLibrary({ workspaces: v6Records }))
          : new Map<ChartWorkspaceId, number>();
        if (v6Records.length === 0) {
          await this.adapter.compareAndSwapV6Library(snapshot, this.expectedV6Revisions);
          this.expectedV6Revisions = revisionMap(snapshot);
        }
        this.memorySnapshot = snapshot;
        this.writeBootstrap(snapshot);
        return { ...snapshot, persistenceMode: "indexeddb" };
      } catch (error) {
        if (error instanceof ChartWorkspaceRevisionConflictError) throw error;
        // IndexedDB can be disabled or temporarily unavailable. Keep the v6 fallback usable.
      }
    }
    const localSeed = fallback
      ?? this.memorySnapshot
      ?? this.readLegacyFallbackLibrary()
      ?? this.legacyOrDefaultLibrary();
    const snapshot = mergeWorkspaceRecoveryRecord(
      normalizeChartWorkspaceLibrary(
        localSeed,
        recovery ?? createDefaultChartWorkspaceRecord(this.now()),
      ),
      recovery,
      requestedActiveId,
    );
    this.memorySnapshot = snapshot;
    this.writeBootstrap(snapshot);
    return {
      ...snapshot,
      persistenceMode: this.storage ? "local-storage" : "memory",
    };
  }

  async saveLibrary(value: ChartWorkspaceLibrarySnapshot): Promise<ChartWorkspacePersistenceMode> {
    const snapshot = normalizeChartWorkspaceLibrary(value, activeRecord(value), this.now());
    if (this.adapter) {
      try {
        await this.adapter.compareAndSwapV6Library(snapshot, this.expectedV6Revisions);
        this.expectedV6Revisions = revisionMap(snapshot);
        this.memorySnapshot = snapshot;
        this.writeBootstrap(snapshot);
        return "indexeddb";
      } catch (error) {
        if (error instanceof ChartWorkspaceRevisionConflictError) throw error;
        // Fall through to the synchronous v6 local backup.
      }
    }
    if (this.writeFallbackLibraryCas(snapshot)) {
      this.memorySnapshot = snapshot;
      this.writeBootstrap(snapshot);
      return "local-storage";
    }
    this.memorySnapshot = snapshot;
    this.writeBootstrap(snapshot);
    return "memory";
  }

  writeBootstrap(snapshot: ChartWorkspaceLibrarySnapshot): void {
    if (!this.storage || snapshot.workspaces.length === 0) return;
    try {
      const current = activeRecord(snapshot);
      this.storage.setItem(CHART_WORKSPACE_ACTIVE_ID_KEY, current.id);
      this.storage.setItem(CHART_WORKSPACE_BOOTSTRAP_KEY, JSON.stringify(current));
    } catch {
      // The async repository remains authoritative if the small recovery journal is unavailable.
    }
  }

  private async legacySeed(
    requestedActiveId: ChartWorkspaceId | null,
    fallback: ChartWorkspaceLibrarySnapshot | null,
  ): Promise<ChartWorkspaceLibrarySnapshot> {
    const rawV5 = await this.adapter!.loadV5Records();
    const v5Records = normalizedRecords(rawV5, this.now());
    if (v5Records.length > 0) {
      return normalizeChartWorkspaceLibrary({
        activeWorkspaceId: requestedActiveId,
        workspaces: v5Records,
      });
    }
    return fallback
      ?? this.readLegacyFallbackLibrary()
      ?? this.legacyOrDefaultLibrary();
  }

  private readActiveWorkspaceId(): ChartWorkspaceId | null {
    if (!this.storage) return null;
    try {
      return normalizeChartWorkspaceId(
        this.storage.getItem(CHART_WORKSPACE_ACTIVE_ID_KEY)
        ?? this.storage.getItem(LEGACY_CHART_WORKSPACE_ACTIVE_ID_KEY),
      );
    } catch {
      return null;
    }
  }

  private readBootstrapRecord(): ChartWorkspaceRecord | null {
    if (!this.storage) return null;
    try {
      return normalizeChartWorkspaceRecord(parseJson(
        this.storage.getItem(CHART_WORKSPACE_BOOTSTRAP_KEY)
        ?? this.storage.getItem(LEGACY_CHART_WORKSPACE_BOOTSTRAP_KEY),
      ), this.now());
    } catch {
      return null;
    }
  }

  private readFallbackLibrary(): ChartWorkspaceLibrarySnapshot | null {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(CHART_WORKSPACE_FALLBACK_LIBRARY_KEY);
      if (!raw) {
        this.expectedFallbackRevisions = new Map();
        return null;
      }
      const snapshot = normalizeChartWorkspaceLibrary(
        parseJson(raw),
        createDefaultChartWorkspaceRecord(this.now()),
      );
      this.expectedFallbackRevisions = revisionMap(snapshot);
      return snapshot;
    } catch {
      return null;
    }
  }

  private readLegacyFallbackLibrary(): ChartWorkspaceLibrarySnapshot | null {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(LEGACY_CHART_WORKSPACE_FALLBACK_LIBRARY_KEY);
      return raw
        ? normalizeChartWorkspaceLibrary(parseJson(raw), createDefaultChartWorkspaceRecord(this.now()))
        : null;
    } catch {
      return null;
    }
  }

  private writeFallbackLibraryCas(snapshot: ChartWorkspaceLibrarySnapshot): boolean {
    if (!this.storage) return false;
    try {
      const raw = this.storage.getItem(CHART_WORKSPACE_FALLBACK_LIBRARY_KEY);
      const current = raw
        ? normalizeChartWorkspaceLibrary(parseJson(raw), createDefaultChartWorkspaceRecord(this.now()))
        : null;
      assertRevisionsMatch(
        this.expectedFallbackRevisions,
        current ? revisionMap(current) : new Map(),
      );
      this.storage.setItem(CHART_WORKSPACE_FALLBACK_LIBRARY_KEY, JSON.stringify(snapshot));
      this.expectedFallbackRevisions = revisionMap(snapshot);
      return true;
    } catch (error) {
      if (error instanceof ChartWorkspaceRevisionConflictError) throw error;
      return false;
    }
  }

  private readLegacyRecord(): ChartWorkspaceRecord | null {
    if (!this.storage) return null;
    try {
      const hasLegacy = this.storage.getItem(CHART_WORKSPACE_STORAGE_KEY) !== null
        || this.storage.getItem(LEGACY_CHART_WORKSPACE_STORAGE_KEY) !== null;
      if (!hasLegacy) return null;
      const document = loadLegacyChartWorkspace(this.storage);
      if (!document) return null;
      return createChartWorkspaceRecord({
        id: DEFAULT_CHART_WORKSPACE_ID,
        name: DEFAULT_CHART_WORKSPACE_NAME,
        document,
        createdAt: this.now(),
        updatedAt: this.now(),
      });
    } catch {
      return null;
    }
  }

  private legacyOrDefaultLibrary(): ChartWorkspaceLibrarySnapshot {
    const legacy = this.readLegacyRecord();
    const workspace = legacy ?? createDefaultChartWorkspaceRecord(this.now());
    return { activeWorkspaceId: workspace.id, workspaces: [workspace] };
  }
}

export function createChartWorkspaceRepository(
  options: CreateChartWorkspaceRepositoryOptions = {},
): ChartWorkspaceRepository {
  return new BrowserChartWorkspaceRepository(options);
}
