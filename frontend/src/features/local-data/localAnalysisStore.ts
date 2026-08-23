import { t } from "../../i18n/index.js";
import {
  LOCAL_ANALYSIS_EVENT_KINDS,
  type LocalAnalysisEvent,
  type LocalAnalysisEventDraft,
  type LocalAnalysisEventImportDraft,
  type LocalAnalysisEventKind,
  type LocalAnalysisIdentity,
  type LocalAnalysisImportResult,
  type LocalAnalysisSnapshot,
} from "./localAnalysisTypes.js";

const STORAGE_SCHEMA_VERSION = 1;
const MAX_EVENTS = 5_000;
const MAX_LABEL_LENGTH = 160;
const MAX_NOTE_LENGTH = 8_000;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredAnalysisDocument {
  schema_version: 1;
  dataset_id: string;
  data_epoch: string;
  events: LocalAnalysisEvent[];
}

export class LocalAnalysisStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalAnalysisStorageError";
  }
}

export const EMPTY_LOCAL_ANALYSIS_SNAPSHOT: LocalAnalysisSnapshot = Object.freeze({
  events: Object.freeze([]),
  revision: 0,
  storage_error: null,
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || value.length > maximum) return null;
  return value.trim();
}

function isEventKind(value: unknown): value is LocalAnalysisEventKind {
  return typeof value === "string"
    && (LOCAL_ANALYSIS_EVENT_KINDS as readonly string[]).includes(value);
}

function parseEvent(
  value: unknown,
  identity: LocalAnalysisIdentity,
): LocalAnalysisEvent | null {
  const record = asRecord(value);
  if (record === null
    || typeof record.id !== "string"
    || record.id.length < 1
    || record.id.length > 200
    || record.dataset_id !== identity.datasetId
    || record.data_epoch !== identity.dataEpoch
    || !Number.isFinite(record.time)
    || Number(record.time) <= 0
    || (record.price !== null && !Number.isFinite(record.price))
    || !isEventKind(record.kind)
    || typeof record.color !== "string"
    || !COLOR_PATTERN.test(record.color)
    || (record.source !== "manual" && record.source !== "csv")
    || typeof record.created_at !== "string"
    || !Number.isFinite(Date.parse(record.created_at))
    || typeof record.updated_at !== "string"
    || !Number.isFinite(Date.parse(record.updated_at))) {
    return null;
  }
  const label = normalizedText(record.label, MAX_LABEL_LENGTH);
  const note = normalizedText(record.note, MAX_NOTE_LENGTH);
  const extra = asRecord(record.extra);
  if (label === null || note === null || extra === null) return null;
  return Object.freeze({
    id: record.id,
    dataset_id: identity.datasetId,
    data_epoch: identity.dataEpoch,
    time: Number(record.time),
    price: record.price === null ? null : Number(record.price),
    kind: record.kind,
    label,
    note,
    color: record.color.toLowerCase(),
    source: record.source,
    extra: Object.freeze({ ...extra }),
    created_at: record.created_at,
    updated_at: record.updated_at,
  });
}

function parseDocument(
  raw: string,
  identity: LocalAnalysisIdentity,
): readonly LocalAnalysisEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LocalAnalysisStorageError(t("local.err.invalidJson"));
  }
  const record = asRecord(parsed);
  if (record === null
    || record.schema_version !== STORAGE_SCHEMA_VERSION
    || record.dataset_id !== identity.datasetId
    || record.data_epoch !== identity.dataEpoch
    || !Array.isArray(record.events)
    || record.events.length > MAX_EVENTS) {
    throw new LocalAnalysisStorageError(t("local.err.invalidIdentity"));
  }
  const events = record.events.map((event) => parseEvent(event, identity));
  if (events.some((event) => event === null)) {
    throw new LocalAnalysisStorageError(t("local.err.invalidEvents"));
  }
  const ids = new Set<string>();
  for (const event of events) {
    if (event === null || ids.has(event.id)) {
      throw new LocalAnalysisStorageError(t("local.err.dupEventId"));
    }
    ids.add(event.id);
  }
  return Object.freeze((events as LocalAnalysisEvent[]).sort((left, right) => (
    left.time - right.time || left.created_at.localeCompare(right.created_at)
  )));
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function defaultId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the process-local fallback.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function buildLocalAnalysisStorageKey(identity: LocalAnalysisIdentity): string {
  return `candlescope:local-analysis:v1:${encodeURIComponent(identity.datasetId)}:${encodeURIComponent(identity.dataEpoch)}`;
}

export class LocalAnalysisEventStore {
  private readonly identity: LocalAnalysisIdentity;
  private readonly storage: StorageLike | null;
  private readonly storageKey: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly listeners = new Set<() => void>();
  private snapshot: LocalAnalysisSnapshot;

  constructor(
    identity: LocalAnalysisIdentity,
    {
      storage = defaultStorage(),
      now = () => new Date(),
      idFactory = defaultId,
    }: {
      storage?: StorageLike | null;
      now?: () => Date;
      idFactory?: () => string;
    } = {},
  ) {
    this.identity = { ...identity };
    this.storage = storage;
    this.storageKey = buildLocalAnalysisStorageKey(identity);
    this.now = now;
    this.idFactory = idFactory;
    this.snapshot = this.load();
  }

  getSnapshot = (): LocalAnalysisSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  create(draft: LocalAnalysisEventDraft): LocalAnalysisEvent {
    this.ensureWritable();
    if (this.snapshot.events.length >= MAX_EVENTS) {
      throw new LocalAnalysisStorageError(t("local.err.maxEvents", { count: MAX_EVENTS }));
    }
    const normalized = this.normalizeDraft(draft);
    const timestamp = this.now().toISOString();
    const event = Object.freeze({
      id: this.idFactory(),
      dataset_id: this.identity.datasetId,
      data_epoch: this.identity.dataEpoch,
      ...normalized,
      source: "manual" as const,
      extra: Object.freeze({}),
      created_at: timestamp,
      updated_at: timestamp,
    });
    this.commit([...this.snapshot.events, event]);
    return event;
  }

  importBatch(drafts: readonly LocalAnalysisEventImportDraft[]): LocalAnalysisImportResult {
    this.ensureWritable();
    const currentIds = new Set(this.snapshot.events.map((event) => event.id));
    const batchIds = new Set<string>();
    const pending = drafts.filter((draft) => {
      if (draft.id.length < 1 || draft.id.length > 200 || batchIds.has(draft.id)) {
        throw new LocalAnalysisStorageError(t("local.err.dupImportId"));
      }
      batchIds.add(draft.id);
      return !currentIds.has(draft.id);
    });
    if (this.snapshot.events.length + pending.length > MAX_EVENTS) {
      throw new LocalAnalysisStorageError(t("local.err.maxEvents", { count: MAX_EVENTS }));
    }
    if (pending.length === 0) return { imported: 0, skipped: drafts.length };
    const timestamp = this.now().toISOString();
    const imported = pending.map((draft) => Object.freeze({
      id: draft.id,
      dataset_id: this.identity.datasetId,
      data_epoch: this.identity.dataEpoch,
      ...this.normalizeDraft(draft),
      source: "csv" as const,
      extra: Object.freeze({ ...draft.extra }),
      created_at: timestamp,
      updated_at: timestamp,
    }));
    this.commit([...this.snapshot.events, ...imported]);
    return { imported: imported.length, skipped: drafts.length - imported.length };
  }

  update(eventId: string, draft: LocalAnalysisEventDraft): LocalAnalysisEvent {
    this.ensureWritable();
    const index = this.snapshot.events.findIndex((event) => event.id === eventId);
    const current = this.snapshot.events[index];
    if (index < 0 || current === undefined) {
      throw new LocalAnalysisStorageError(t("local.err.missingEvent"));
    }
    const updated = Object.freeze({
      ...current,
      ...this.normalizeDraft(draft),
      updated_at: this.now().toISOString(),
    });
    const events = [...this.snapshot.events];
    events[index] = updated;
    this.commit(events);
    return updated;
  }

  delete(eventId: string): boolean {
    this.ensureWritable();
    const events = this.snapshot.events.filter((event) => event.id !== eventId);
    if (events.length === this.snapshot.events.length) return false;
    this.commit(events);
    return true;
  }

  resetCorruptDocument(): void {
    try {
      this.storage?.removeItem(this.storageKey);
    } catch (reason) {
      throw new LocalAnalysisStorageError(
        reason instanceof Error ? reason.message : t("local.err.resetCorrupt"),
      );
    }
    this.snapshot = Object.freeze({
      events: Object.freeze([]),
      revision: this.snapshot.revision + 1,
      storage_error: null,
    });
    this.emit();
  }

  private load(): LocalAnalysisSnapshot {
    if (this.storage === null) {
      return Object.freeze({
        events: Object.freeze([]),
        revision: 0,
        storage_error: t("local.err.storageUnavailableSave"),
      });
    }
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.storageKey);
    } catch (reason) {
      return Object.freeze({
        events: Object.freeze([]),
        revision: 0,
        storage_error: reason instanceof Error ? reason.message : t("local.err.readMarkers"),
      });
    }
    if (raw === null) return EMPTY_LOCAL_ANALYSIS_SNAPSHOT;
    try {
      return Object.freeze({ events: parseDocument(raw, this.identity), revision: 0, storage_error: null });
    } catch (reason) {
      return Object.freeze({
        events: Object.freeze([]),
        revision: 0,
        storage_error: reason instanceof Error ? reason.message : t("local.err.readMarkers"),
      });
    }
  }

  private normalizeDraft(draft: LocalAnalysisEventDraft): Omit<
    LocalAnalysisEventDraft,
    "kind"
  > & { kind: LocalAnalysisEventKind } {
    const label = normalizedText(draft.label, MAX_LABEL_LENGTH);
    const note = normalizedText(draft.note, MAX_NOTE_LENGTH);
    if (!Number.isFinite(draft.time) || draft.time <= 0) {
      throw new LocalAnalysisStorageError(t("local.err.badTime"));
    }
    if (draft.price !== null && !Number.isFinite(draft.price)) {
      throw new LocalAnalysisStorageError(t("local.err.badPrice"));
    }
    if (!isEventKind(draft.kind) || label === null || note === null) {
      throw new LocalAnalysisStorageError(t("local.err.badFields"));
    }
    if (!COLOR_PATTERN.test(draft.color)) {
      throw new LocalAnalysisStorageError(t("local.err.badColor"));
    }
    return {
      time: draft.time,
      price: draft.price,
      kind: draft.kind,
      label,
      note,
      color: draft.color.toLowerCase(),
    };
  }

  private ensureWritable(): void {
    if (this.snapshot.storage_error !== null) {
      throw new LocalAnalysisStorageError(this.snapshot.storage_error);
    }
    if (this.storage === null) {
      throw new LocalAnalysisStorageError(t("local.err.storageUnavailable"));
    }
  }

  private commit(values: readonly LocalAnalysisEvent[]): void {
    const events = Object.freeze([...values].sort((left, right) => (
      left.time - right.time || left.created_at.localeCompare(right.created_at)
    )));
    const document: StoredAnalysisDocument = {
      schema_version: STORAGE_SCHEMA_VERSION,
      dataset_id: this.identity.datasetId,
      data_epoch: this.identity.dataEpoch,
      events: [...events],
    };
    try {
      this.storage?.setItem(this.storageKey, JSON.stringify(document));
    } catch (reason) {
      throw new LocalAnalysisStorageError(
        reason instanceof Error ? reason.message : t("local.err.saveFailed"),
      );
    }
    this.snapshot = Object.freeze({
      events,
      revision: this.snapshot.revision + 1,
      storage_error: null,
    });
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
