import {
  CHART_WORKSPACE_STORAGE_KEY,
  LEGACY_CHART_WORKSPACE_STORAGE_KEY,
  loadChartWorkspace,
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
import type {
  ChartWorkspaceId,
  ChartWorkspaceLibrarySnapshot,
  ChartWorkspaceRecord,
} from "./chartWorkspaceTypes.js";

export const CHART_WORKSPACE_DATABASE_NAME = "candlescope-chart-workspaces";
export const CHART_WORKSPACE_DATABASE_VERSION = 1;
export const CHART_WORKSPACE_OBJECT_STORE = "workspaces";
export const CHART_WORKSPACE_ACTIVE_ID_KEY = "candlescope-active-workspace-id-v1";
export const CHART_WORKSPACE_BOOTSTRAP_KEY = "candlescope-active-workspace-bootstrap-v1";
export const CHART_WORKSPACE_FALLBACK_LIBRARY_KEY = "candlescope-workspace-library-fallback-v1";

export type ChartWorkspacePersistenceMode = "indexeddb" | "local-storage" | "memory";

export interface ChartWorkspaceLoadResult extends ChartWorkspaceLibrarySnapshot {
  persistenceMode: ChartWorkspacePersistenceMode;
}

export interface ChartWorkspaceKeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
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

function openWorkspaceDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(CHART_WORKSPACE_DATABASE_NAME, CHART_WORKSPACE_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CHART_WORKSPACE_OBJECT_STORE)) {
        database.createObjectStore(CHART_WORKSPACE_OBJECT_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open workspace database"));
    request.onblocked = () => reject(new Error("Workspace database upgrade is blocked"));
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

async function loadIndexedDbRecords(factory: IDBFactory): Promise<unknown[]> {
  const database = await openWorkspaceDatabase(factory);
  try {
    const transaction = database.transaction(CHART_WORKSPACE_OBJECT_STORE, "readonly");
    const done = transactionDone(transaction);
    const request = transaction.objectStore(CHART_WORKSPACE_OBJECT_STORE)
      .getAll() as IDBRequest<unknown[]>;
    const records: unknown[] = await requestValue(request);
    await done;
    return records;
  } finally {
    database.close();
  }
}

async function saveIndexedDbLibrary(
  factory: IDBFactory,
  snapshot: ChartWorkspaceLibrarySnapshot,
): Promise<void> {
  const database = await openWorkspaceDatabase(factory);
  try {
    const transaction = database.transaction(CHART_WORKSPACE_OBJECT_STORE, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(CHART_WORKSPACE_OBJECT_STORE);
    store.clear();
    snapshot.workspaces.forEach((workspace) => store.put(workspace));
    await done;
  } finally {
    database.close();
  }
}

class BrowserChartWorkspaceRepository implements ChartWorkspaceRepository {
  private readonly factory: IDBFactory | null;
  private readonly storage: ChartWorkspaceKeyValueStorage | null;
  private readonly now: () => number;
  private memorySnapshot: ChartWorkspaceLibrarySnapshot | null = null;

  constructor(options: CreateChartWorkspaceRepositoryOptions) {
    this.factory = options.indexedDB === undefined ? browserIndexedDB() : options.indexedDB;
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.now = options.now ?? Date.now;
  }

  loadBootstrapLibrary(): ChartWorkspaceLibrarySnapshot {
    const recovery = this.readBootstrapRecord();
    if (recovery) {
      return { activeWorkspaceId: recovery.id, workspaces: [recovery] };
    }
    const fallback = this.readFallbackLibrary();
    if (fallback) return fallback;
    const legacy = this.readLegacyRecord();
    if (legacy) return { activeWorkspaceId: legacy.id, workspaces: [legacy] };
    const workspace = createDefaultChartWorkspaceRecord(this.now());
    return { activeWorkspaceId: workspace.id, workspaces: [workspace] };
  }

  async loadLibrary(): Promise<ChartWorkspaceLoadResult> {
    const recovery = this.readBootstrapRecord();
    const requestedActiveId = this.readActiveWorkspaceId() ?? recovery?.id ?? null;
    if (this.factory) {
      try {
        const rawRecords = await loadIndexedDbRecords(this.factory);
        const seed = rawRecords.length > 0
          ? { activeWorkspaceId: requestedActiveId, workspaces: rawRecords }
          : this.readFallbackLibrary() ?? this.legacyOrDefaultLibrary();
        const normalized = normalizeChartWorkspaceLibrary(
          { ...seed, activeWorkspaceId: requestedActiveId ?? seed.activeWorkspaceId },
          recovery ?? createDefaultChartWorkspaceRecord(this.now()),
          this.now(),
        );
        const snapshot = mergeWorkspaceRecoveryRecord(normalized, recovery, requestedActiveId);
        await saveIndexedDbLibrary(this.factory, snapshot);
        this.memorySnapshot = snapshot;
        this.writeBootstrap(snapshot);
        return { ...snapshot, persistenceMode: "indexeddb" };
      } catch {
        // IndexedDB can be disabled or temporarily unavailable. Keep a local fallback usable.
      }
    }
    const fallback = this.readFallbackLibrary() ?? this.memorySnapshot ?? this.legacyOrDefaultLibrary();
    const snapshot = mergeWorkspaceRecoveryRecord(
      normalizeChartWorkspaceLibrary(fallback, recovery ?? createDefaultChartWorkspaceRecord(this.now())),
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

  async saveLibrary(
    value: ChartWorkspaceLibrarySnapshot,
  ): Promise<ChartWorkspacePersistenceMode> {
    const snapshot = normalizeChartWorkspaceLibrary(value, activeRecord(value), this.now());
    this.memorySnapshot = snapshot;
    this.writeBootstrap(snapshot);
    if (this.factory) {
      try {
        await saveIndexedDbLibrary(this.factory, snapshot);
        return "indexeddb";
      } catch {
        // Fall through to the synchronous local backup.
      }
    }
    if (this.writeFallbackLibrary(snapshot)) return "local-storage";
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

  private readActiveWorkspaceId(): ChartWorkspaceId | null {
    if (!this.storage) return null;
    try {
      return normalizeChartWorkspaceId(this.storage.getItem(CHART_WORKSPACE_ACTIVE_ID_KEY));
    } catch {
      return null;
    }
  }

  private readBootstrapRecord(): ChartWorkspaceRecord | null {
    if (!this.storage) return null;
    try {
      return normalizeChartWorkspaceRecord(
        parseJson(this.storage.getItem(CHART_WORKSPACE_BOOTSTRAP_KEY)),
        this.now(),
      );
    } catch {
      return null;
    }
  }

  private readFallbackLibrary(): ChartWorkspaceLibrarySnapshot | null {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(CHART_WORKSPACE_FALLBACK_LIBRARY_KEY);
      if (!raw) return null;
      return normalizeChartWorkspaceLibrary(parseJson(raw), createDefaultChartWorkspaceRecord(this.now()));
    } catch {
      return null;
    }
  }

  private writeFallbackLibrary(snapshot: ChartWorkspaceLibrarySnapshot): boolean {
    if (!this.storage) return false;
    try {
      this.storage.setItem(CHART_WORKSPACE_FALLBACK_LIBRARY_KEY, JSON.stringify(snapshot));
      return true;
    } catch {
      return false;
    }
  }

  private readLegacyRecord(): ChartWorkspaceRecord | null {
    if (!this.storage) return null;
    try {
      const hasLegacy = this.storage.getItem(CHART_WORKSPACE_STORAGE_KEY) !== null
        || this.storage.getItem(LEGACY_CHART_WORKSPACE_STORAGE_KEY) !== null;
      if (!hasLegacy) return null;
      return createChartWorkspaceRecord({
        id: DEFAULT_CHART_WORKSPACE_ID,
        name: DEFAULT_CHART_WORKSPACE_NAME,
        document: loadChartWorkspace(this.storage),
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
