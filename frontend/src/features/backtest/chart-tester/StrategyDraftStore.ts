export const STRATEGY_DRAFT_SCHEMA_VERSION = 1 as const;
export const STRATEGY_DRAFT_STORE_SCHEMA_VERSION = 1 as const;
export const STRATEGY_DRAFT_STORAGE_KEY = "candlescope-strategy-drafts-v1";

export type StrategyDraftLanguage = "pyne" | "pine";
export type StrategyDraftAutoSaveState = "IDLE" | "SAVING" | "SAVED" | "ERROR";

export interface StrategyDraftCursor {
  line: number;
  column: number;
}

export interface StrategyDraftRecord {
  schemaVersion: typeof STRATEGY_DRAFT_SCHEMA_VERSION;
  id: string;
  revision: number;
  displayName: string;
  language: StrategyDraftLanguage;
  source: string;
  cursor: StrategyDraftCursor | null;
  createdAt: number;
  updatedAt: number;
}

export interface StrategyDraftView {
  record: StrategyDraftRecord | null;
  saveState: StrategyDraftAutoSaveState;
  error: string | null;
}

export interface StrategyDraftStoreAdapter {
  load(id: string): Promise<unknown | null>;
  list(): Promise<unknown[]>;
  save(record: StrategyDraftRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface StrategyDraftStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const MAX_DRAFT_SOURCE_LENGTH = 2 * 1024 * 1024;
const DRAFT_ID_PATTERN = /^draft-[A-Za-z0-9_-]{8,152}$/;

function cloneRecord(record: StrategyDraftRecord): StrategyDraftRecord {
  return { ...record, cursor: record.cursor ? { ...record.cursor } : null };
}

function normalizeRecord(value: unknown): StrategyDraftRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = typeof source.id === "string" ? source.id.trim() : "";
  const revision = Number(source.revision);
  const createdAt = Number(source.createdAt);
  const updatedAt = Number(source.updatedAt);
  const displayName = typeof source.displayName === "string"
    ? source.displayName.trim().slice(0, 120)
    : "";
  const language = source.language === "pyne" || source.language === "pine"
    ? source.language
    : null;
  const code = typeof source.source === "string" ? source.source : null;
  const cursorSource = source.cursor && typeof source.cursor === "object"
    && !Array.isArray(source.cursor)
    ? source.cursor as Record<string, unknown>
    : null;
  const cursor = source.cursor === null
    ? null
    : cursorSource
      && Number.isSafeInteger(Number(cursorSource.line))
      && Number(cursorSource.line) >= 1
      && Number.isSafeInteger(Number(cursorSource.column))
      && Number(cursorSource.column) >= 1
      ? { line: Number(cursorSource.line), column: Number(cursorSource.column) }
      : undefined;
  if (
    source.schemaVersion !== STRATEGY_DRAFT_SCHEMA_VERSION
    || !DRAFT_ID_PATTERN.test(id)
    || !Number.isSafeInteger(revision)
    || revision < 0
    || !Number.isSafeInteger(createdAt)
    || !Number.isSafeInteger(updatedAt)
    || createdAt < 0
    || updatedAt < createdAt
    || !displayName
    || language === null
    || code === null
    || code.length > MAX_DRAFT_SOURCE_LENGTH
    || cursor === undefined
  ) return null;
  return {
    schemaVersion: STRATEGY_DRAFT_SCHEMA_VERSION,
    id,
    revision,
    displayName,
    language,
    source: code,
    cursor,
    createdAt,
    updatedAt,
  };
}

interface StoredDraftEnvelope {
  schemaVersion: typeof STRATEGY_DRAFT_STORE_SCHEMA_VERSION;
  drafts: Record<string, StrategyDraftRecord>;
}

function readEnvelope(storage: StrategyDraftStorageLike): StoredDraftEnvelope {
  try {
    const raw = storage.getItem(STRATEGY_DRAFT_STORAGE_KEY);
    if (!raw) return { schemaVersion: STRATEGY_DRAFT_STORE_SCHEMA_VERSION, drafts: {} };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const source = parsed as Record<string, unknown>;
    if (source.schemaVersion !== STRATEGY_DRAFT_STORE_SCHEMA_VERSION
      || !source.drafts || typeof source.drafts !== "object" || Array.isArray(source.drafts)) {
      throw new Error();
    }
    const drafts = Object.fromEntries(Object.entries(source.drafts as Record<string, unknown>)
      .map(([id, value]) => [id, normalizeRecord(value)] as const)
      .filter((entry): entry is [string, StrategyDraftRecord] => (
        entry[1] !== null && entry[0] === entry[1].id
      )));
    return { schemaVersion: STRATEGY_DRAFT_STORE_SCHEMA_VERSION, drafts };
  } catch {
    return { schemaVersion: STRATEGY_DRAFT_STORE_SCHEMA_VERSION, drafts: {} };
  }
}

export function createLocalStorageStrategyDraftAdapter(
  storage: StrategyDraftStorageLike,
): StrategyDraftStoreAdapter {
  return {
    async load(id) {
      const record = readEnvelope(storage).drafts[id];
      return record ? cloneRecord(record) : null;
    },
    async list() {
      return Object.values(readEnvelope(storage).drafts).map(cloneRecord);
    },
    async save(record) {
      const normalized = normalizeRecord(record);
      if (!normalized) throw new TypeError("invalid strategy draft record");
      const envelope = readEnvelope(storage);
      envelope.drafts[normalized.id] = normalized;
      storage.setItem(STRATEGY_DRAFT_STORAGE_KEY, JSON.stringify(envelope));
    },
    async remove(id) {
      const envelope = readEnvelope(storage);
      delete envelope.drafts[id];
      storage.setItem(STRATEGY_DRAFT_STORAGE_KEY, JSON.stringify(envelope));
    },
  };
}

export function createMemoryStrategyDraftAdapter(): StrategyDraftStoreAdapter {
  const drafts = new Map<string, StrategyDraftRecord>();
  return {
    async load(id) {
      const record = drafts.get(id);
      return record ? cloneRecord(record) : null;
    },
    async list() {
      return [...drafts.values()].map(cloneRecord);
    },
    async save(record) {
      const normalized = normalizeRecord(record);
      if (!normalized) throw new TypeError("invalid strategy draft record");
      drafts.set(record.id, cloneRecord(normalized));
    },
    async remove(id) {
      drafts.delete(id);
    },
  };
}

export interface SaveStrategyDraftInput {
  id: string;
  displayName: string;
  language: StrategyDraftLanguage;
  source: string;
  cursor: StrategyDraftCursor | null;
}

export function sameStrategyDraftCursor(
  left: StrategyDraftCursor | null,
  right: StrategyDraftCursor | null,
): boolean {
  return left?.line === right?.line && left?.column === right?.column;
}

export function pendingStrategyDraftSave(pending: {
  draft: StrategyDraftRecord | null;
  source: string;
  cursor: StrategyDraftCursor | null;
}): SaveStrategyDraftInput | null {
  if (!pending.draft) return null;
  if (
    pending.draft.source === pending.source
    && sameStrategyDraftCursor(pending.draft.cursor, pending.cursor)
  ) {
    return null;
  }
  return {
    id: pending.draft.id,
    displayName: pending.draft.displayName,
    language: pending.draft.language,
    source: pending.source,
    cursor: pending.cursor,
  };
}

export class StrategyDraftStore {
  private readonly views = new Map<string, StrategyDraftView>();
  private readonly listeners = new Set<(id: string, view: StrategyDraftView) => void>();
  private readonly pending = new Map<string, Promise<StrategyDraftRecord>>();

  constructor(
    private readonly adapter: StrategyDraftStoreAdapter,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe(listener: (id: string, view: StrategyDraftView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(id: string): StrategyDraftView {
    const current = this.views.get(id) ?? { record: null, saveState: "IDLE", error: null };
    return {
      ...current,
      record: current.record ? cloneRecord(current.record) : null,
    };
  }

  async load(id: string): Promise<StrategyDraftView> {
    if (!DRAFT_ID_PATTERN.test(id)) return this.snapshot(id);
    const loaded = normalizeRecord(await this.adapter.load(id));
    const current = this.views.get(id);
    const keepCurrent = current?.record !== null
      && current?.record !== undefined
      && (loaded === null || current.record.revision > loaded.revision);
    const view: StrategyDraftView = keepCurrent
      ? {
        record: cloneRecord(current.record!),
        saveState: current.saveState,
        error: current.error,
      }
      : {
        record: loaded,
        saveState: loaded ? "SAVED" : "IDLE",
        error: null,
      };
    this.views.set(id, view);
    this.emit(id);
    return this.snapshot(id);
  }

  async recent(limit = 8): Promise<StrategyDraftRecord[]> {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.min(50, Math.max(1, limit)) : 8;
    await Promise.all([...this.pending.values()].map((pending) => pending.catch(() => undefined)));
    const merged = new Map<string, StrategyDraftRecord>();
    (await this.adapter.list())
      .map(normalizeRecord)
      .filter((record): record is StrategyDraftRecord => record !== null)
      .forEach((record) => merged.set(record.id, record));
    this.views.forEach((view) => {
      const record = view.record;
      if (!record) return;
      const existing = merged.get(record.id);
      if (!existing || record.revision > existing.revision) merged.set(record.id, record);
    });
    return [...merged.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .slice(0, boundedLimit)
      .map(cloneRecord);
  }

  save(input: SaveStrategyDraftInput): Promise<StrategyDraftRecord> {
    const previous = this.pending.get(input.id);
    const ready = previous
      ? previous.then(() => undefined, () => undefined)
      : Promise.resolve();
    const operation = ready.then(async () => {
      const current = this.views.get(input.id)?.record ?? normalizeRecord(await this.adapter.load(input.id));
      const now = this.now();
      const candidate = normalizeRecord({
        schemaVersion: STRATEGY_DRAFT_SCHEMA_VERSION,
        id: input.id,
        revision: (current?.revision ?? -1) + 1,
        displayName: input.displayName,
        language: input.language,
        source: input.source,
        cursor: input.cursor,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      });
      if (!candidate) throw new TypeError("invalid strategy draft input");
      this.views.set(input.id, { record: candidate, saveState: "SAVING", error: null });
      this.emit(input.id);
      try {
        await this.adapter.save(candidate);
      } catch (error) {
        this.views.set(input.id, {
          record: candidate,
          saveState: "ERROR",
          error: error instanceof Error ? error.message : "strategy draft save failed",
        });
        this.emit(input.id);
        throw error;
      }
      this.views.set(input.id, { record: candidate, saveState: "SAVED", error: null });
      this.emit(input.id);
      return cloneRecord(candidate);
    });
    this.pending.set(input.id, operation);
    void operation.finally(() => {
      if (this.pending.get(input.id) === operation) this.pending.delete(input.id);
    }).catch(() => undefined);
    return operation;
  }

  async remove(id: string): Promise<void> {
    await this.pending.get(id)?.catch(() => undefined);
    await this.adapter.remove(id);
    this.views.delete(id);
    this.emit(id);
  }

  private emit(id: string): void {
    const view = this.snapshot(id);
    this.listeners.forEach((listener) => listener(id, view));
  }
}
