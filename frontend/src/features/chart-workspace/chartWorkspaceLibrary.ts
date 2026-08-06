import {
  CHART_CELL_IDS,
  CHART_WORKSPACE_RECORD_SCHEMA_VERSION,
  type ChartCellState,
  type ChartCellId,
  type ChartWorkspaceDocument,
  type ChartWorkspaceId,
  type ChartWorkspaceLibrarySnapshot,
  type ChartWorkspaceRecord,
  type ChartWorkspaceSummary,
  type ChartWorkspaceTemplateId,
} from "./chartWorkspaceTypes.js";
import {
  createDefaultChartWorkspace,
  normalizeChartWorkspace,
} from "./chartWorkspaceStorage.js";

export const DEFAULT_CHART_WORKSPACE_ID = "workspace-default";
export const DEFAULT_CHART_WORKSPACE_NAME = "默认工作区";
export const MAX_CHART_WORKSPACE_NAME_LENGTH = 48;

export const CHART_WORKSPACE_TEMPLATE_NAMES: Record<ChartWorkspaceTemplateId, string> = {
  single: "单图工作区",
  "split-vertical": "左右双图",
  "split-horizontal": "上下双图",
  quad: "四图工作区",
};

export function chartCellStorageScope(
  workspaceId: ChartWorkspaceId,
  cellId: ChartCellId,
): string {
  return workspaceId === DEFAULT_CHART_WORKSPACE_ID ? cellId : `${workspaceId}:${cellId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteTimestamp(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function cloneSerializable<T>(value: T): T {
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch {
    // Fall through to the JSON-safe representation used by persistence.
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function normalizeChartWorkspaceId(value: unknown): ChartWorkspaceId | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id.length > 128 || Array.from(id).some((character) => (
    character.charCodeAt(0) < 32
  ))) return null;
  return id;
}

export function normalizeChartWorkspaceName(
  value: unknown,
  fallback = DEFAULT_CHART_WORKSPACE_NAME,
): string {
  const normalized = typeof value === "string"
    ? value.trim().replace(/\s+/g, " ")
    : "";
  const candidate = normalized || fallback.trim() || DEFAULT_CHART_WORKSPACE_NAME;
  return candidate.slice(0, MAX_CHART_WORKSPACE_NAME_LENGTH);
}

export function uniqueChartWorkspaceName(
  requested: string,
  workspaces: readonly Pick<ChartWorkspaceRecord, "id" | "name">[],
  excludeId: ChartWorkspaceId | null = null,
): string {
  const base = normalizeChartWorkspaceName(requested);
  const occupied = new Set(workspaces
    .filter((workspace) => workspace.id !== excludeId)
    .map((workspace) => workspace.name.trim().toLocaleLowerCase()));
  if (!occupied.has(base.toLocaleLowerCase())) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const suffixLabel = ` ${suffix}`;
    const stem = base.slice(0, MAX_CHART_WORKSPACE_NAME_LENGTH - suffixLabel.length).trimEnd();
    const candidate = `${stem}${suffixLabel}`;
    if (!occupied.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return `${base.slice(0, MAX_CHART_WORKSPACE_NAME_LENGTH - 6)} ${Date.now().toString().slice(-4)}`;
}

export function cloneChartWorkspaceDocument(
  document: ChartWorkspaceDocument,
): ChartWorkspaceDocument {
  return normalizeChartWorkspace(cloneSerializable(document));
}

export function createChartWorkspaceId(): ChartWorkspaceId {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return `workspace-${globalThis.crypto.randomUUID()}`;
    }
  } catch {
    // A timestamp plus random suffix is sufficient for a local-only identifier.
  }
  return `workspace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createTemplateChartWorkspaceDocument(
  templateId: ChartWorkspaceTemplateId,
  source: ChartWorkspaceDocument,
): ChartWorkspaceDocument {
  const document = createDefaultChartWorkspace();
  const anchor = source.cells[source.activeCellId];
  const copyCellPreferences = (cell: ChartCellState, index: number): ChartCellState => ({
    ...cell,
    session: {
      ...cell.session,
      exchange: anchor.session.exchange,
      marketType: anchor.session.marketType,
      symbol: anchor.session.symbol,
      interval: index === 0 ? anchor.session.interval : cell.session.interval,
    },
    chartSettings: cloneSerializable(anchor.chartSettings),
    priceScale: cloneSerializable(anchor.priceScale),
    indicators: cloneSerializable(anchor.indicators),
  });
  document.cells = Object.fromEntries(CHART_CELL_IDS.map((cellId, index) => [
    cellId,
    copyCellPreferences(document.cells[cellId], index),
  ])) as ChartWorkspaceDocument["cells"];
  document.layout = templateId;
  document.activeCellId = "cell-1";
  document.maximizedCellId = null;
  return document;
}

export interface CreateChartWorkspaceRecordOptions {
  id?: ChartWorkspaceId;
  name?: string;
  document?: ChartWorkspaceDocument;
  createdAt?: number;
  updatedAt?: number;
}

export function createChartWorkspaceRecord(
  options: CreateChartWorkspaceRecordOptions = {},
): ChartWorkspaceRecord {
  const now = options.createdAt ?? Date.now();
  return {
    schemaVersion: CHART_WORKSPACE_RECORD_SCHEMA_VERSION,
    id: normalizeChartWorkspaceId(options.id) ?? createChartWorkspaceId(),
    name: normalizeChartWorkspaceName(options.name),
    createdAt: now,
    updatedAt: options.updatedAt ?? now,
    document: options.document
      ? cloneChartWorkspaceDocument(options.document)
      : createDefaultChartWorkspace(),
  };
}

export function createDefaultChartWorkspaceRecord(now = Date.now()): ChartWorkspaceRecord {
  return createChartWorkspaceRecord({
    id: DEFAULT_CHART_WORKSPACE_ID,
    name: DEFAULT_CHART_WORKSPACE_NAME,
    createdAt: now,
    updatedAt: now,
  });
}

export function normalizeChartWorkspaceRecord(
  value: unknown,
  now = Date.now(),
): ChartWorkspaceRecord | null {
  if (!isRecord(value)) return null;
  const id = normalizeChartWorkspaceId(value.id);
  if (!id) return null;
  const createdAt = finiteTimestamp(value.createdAt, now);
  const updatedAt = Math.max(createdAt, finiteTimestamp(value.updatedAt, createdAt));
  return {
    schemaVersion: CHART_WORKSPACE_RECORD_SCHEMA_VERSION,
    id,
    name: normalizeChartWorkspaceName(value.name),
    createdAt,
    updatedAt,
    document: normalizeChartWorkspace(value.document),
  };
}

function orderedRecords(records: Iterable<ChartWorkspaceRecord>): ChartWorkspaceRecord[] {
  return Array.from(records).sort((left, right) => (
    left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  ));
}

export function normalizeChartWorkspaceLibrary(
  value: unknown,
  fallback = createDefaultChartWorkspaceRecord(),
  now = Date.now(),
): ChartWorkspaceLibrarySnapshot {
  const source = isRecord(value) ? value : {};
  const sourceRecords = Array.isArray(source.workspaces) ? source.workspaces : [];
  const recordsById = new Map<ChartWorkspaceId, ChartWorkspaceRecord>();
  for (const candidate of sourceRecords) {
    const record = normalizeChartWorkspaceRecord(candidate, now);
    if (!record) continue;
    const previous = recordsById.get(record.id);
    if (!previous || record.updatedAt >= previous.updatedAt) recordsById.set(record.id, record);
  }
  if (recordsById.size === 0) recordsById.set(fallback.id, cloneSerializable(fallback));
  const workspaces = orderedRecords(recordsById.values());
  const requestedActiveId = normalizeChartWorkspaceId(source.activeWorkspaceId);
  const activeWorkspaceId = requestedActiveId && recordsById.has(requestedActiveId)
    ? requestedActiveId
    : recordsById.has(fallback.id)
      ? fallback.id
      : workspaces[0]!.id;
  return { activeWorkspaceId, workspaces };
}

export function mergeWorkspaceRecoveryRecord(
  snapshot: ChartWorkspaceLibrarySnapshot,
  recovery: ChartWorkspaceRecord | null,
  requestedActiveId: ChartWorkspaceId | null = null,
): ChartWorkspaceLibrarySnapshot {
  const recordsById = new Map(snapshot.workspaces.map((record) => [record.id, record]));
  if (recovery) {
    const existing = recordsById.get(recovery.id);
    if (!existing || recovery.updatedAt > existing.updatedAt) recordsById.set(recovery.id, recovery);
  }
  const workspaces = orderedRecords(recordsById.values());
  const activeWorkspaceId = requestedActiveId && recordsById.has(requestedActiveId)
    ? requestedActiveId
    : recordsById.has(snapshot.activeWorkspaceId)
      ? snapshot.activeWorkspaceId
      : workspaces[0]!.id;
  return { activeWorkspaceId, workspaces };
}

export function summarizeChartWorkspaces(
  workspaces: readonly ChartWorkspaceRecord[],
): ChartWorkspaceSummary[] {
  return workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    layout: workspace.document.layout,
  }));
}

export function removeChartWorkspace(
  snapshot: ChartWorkspaceLibrarySnapshot,
  workspaceId: ChartWorkspaceId,
): ChartWorkspaceLibrarySnapshot {
  if (snapshot.workspaces.length <= 1) return snapshot;
  const removedIndex = snapshot.workspaces.findIndex((workspace) => workspace.id === workspaceId);
  if (removedIndex < 0) return snapshot;
  const workspaces = snapshot.workspaces.filter((workspace) => workspace.id !== workspaceId);
  if (snapshot.activeWorkspaceId !== workspaceId) return { ...snapshot, workspaces };
  const nextIndex = Math.min(removedIndex, workspaces.length - 1);
  return {
    activeWorkspaceId: workspaces[nextIndex]!.id,
    workspaces,
  };
}
