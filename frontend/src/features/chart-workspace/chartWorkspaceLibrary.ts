import { getLocale, t, type LocaleId, type MessageKey } from "../../i18n/index.js";
import {
  CHART_CELL_IDS,
  CHART_LINK_GROUP_COLORS,
  CHART_WORKSPACE_RECORD_SCHEMA_VERSION,
  DEFAULT_CHART_LINK_GROUP_ID,
  type ChartCellState,
  type ChartCellId,
  type ChartWorkspaceBuiltinName,
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
import {
  chartWorkspaceTemplateCellCount,
  createChartWorkspaceLayoutTree,
  detectChartWorkspaceLayout,
} from "./chartWorkspaceLayout.js";
import { createChartCellId } from "./chartWorkspaceIdentity.js";
import {
  activeChartWorkspaceWindow,
  chartWorkspaceCell,
  replaceChartWorkspaceWindow,
} from "./chartWorkspaceDocument.js";

export const DEFAULT_CHART_WORKSPACE_ID = "workspace-default";
export const MAX_CHART_WORKSPACE_NAME_LENGTH = 48;

const CHART_WORKSPACE_TEMPLATE_NAME_KEYS: Record<ChartWorkspaceTemplateId, MessageKey> = {
  single: "workspace.name.template.single",
  "split-vertical": "workspace.name.template.splitVertical",
  "split-horizontal": "workspace.name.template.splitHorizontal",
  "main-confirmation": "workspace.name.template.mainConfirm",
  quad: "workspace.name.template.quad",
  "grid-6": "workspace.name.template.grid6",
  "grid-8": "workspace.name.template.grid8",
  "grid-9": "workspace.name.template.grid9",
  "grid-12": "workspace.name.template.grid12",
  "grid-16": "workspace.name.template.grid16",
};

export function defaultChartWorkspaceName(locale: LocaleId = getLocale()): string {
  return t("workspace.name.default", {}, locale);
}

export function chartWorkspaceTemplateName(
  templateId: ChartWorkspaceTemplateId,
  locale: LocaleId = getLocale(),
): string {
  return t(CHART_WORKSPACE_TEMPLATE_NAME_KEYS[templateId], {}, locale);
}

function builtinWorkspaceName(
  source: ChartWorkspaceBuiltinName,
  locale: LocaleId,
): string {
  if (source.kind === "default") return defaultChartWorkspaceName(locale);
  const base = chartWorkspaceTemplateName(source.templateId, locale);
  return source.ordinal > 1 ? `${base} ${source.ordinal}` : base;
}

export function chartWorkspaceDisplayName(
  workspace: Pick<ChartWorkspaceRecord, "name" | "builtinName">,
  locale: LocaleId = getLocale(),
): string {
  return workspace.builtinName
    ? builtinWorkspaceName(workspace.builtinName, locale)
    : workspace.name;
}

function isChartWorkspaceTemplateId(value: unknown): value is ChartWorkspaceTemplateId {
  return typeof value === "string"
    && Object.prototype.hasOwnProperty.call(CHART_WORKSPACE_TEMPLATE_NAME_KEYS, value);
}

function normalizeBuiltinWorkspaceName(
  value: unknown,
  id: ChartWorkspaceId,
  name: string,
): ChartWorkspaceBuiltinName | null {
  if (isRecord(value)) {
    if (value.kind === "default" && id === DEFAULT_CHART_WORKSPACE_ID) {
      return { kind: "default" };
    }
    const ordinal = Number(value.ordinal);
    if (
      value.kind === "template"
      && isChartWorkspaceTemplateId(value.templateId)
      && Number.isSafeInteger(ordinal)
      && ordinal >= 1
    ) {
      return { kind: "template", templateId: value.templateId, ordinal };
    }
  }
  if (
    id === DEFAULT_CHART_WORKSPACE_ID
    && (["zh-CN", "en"] as const).some((locale) => name === defaultChartWorkspaceName(locale))
  ) return { kind: "default" };
  const legacyChineseNames: Partial<Record<ChartWorkspaceTemplateId, string>> = {
    "split-vertical": "左右双图",
    "split-horizontal": "上下双图",
    "main-confirmation": "主图与确认图",
  };
  const ordinalForBase = (base: string): number | null => {
    if (name === base) return 1;
    if (!name.startsWith(`${base} `)) return null;
    const ordinal = Number(name.slice(base.length + 1));
    return Number.isSafeInteger(ordinal) && ordinal >= 2
      ? ordinal
      : null;
  };
  for (const templateId of Object.keys(CHART_WORKSPACE_TEMPLATE_NAME_KEYS) as ChartWorkspaceTemplateId[]) {
    const bases = (["zh-CN", "en"] as const).map((locale) => (
      chartWorkspaceTemplateName(templateId, locale)
    ));
    const legacyName = legacyChineseNames[templateId];
    if (legacyName) bases.push(legacyName);
    for (const base of bases) {
      const ordinal = ordinalForBase(base);
      if (ordinal !== null) return { kind: "template", templateId, ordinal };
    }
  }
  return null;
}

export function nextChartWorkspaceTemplateBuiltinName(
  templateId: ChartWorkspaceTemplateId,
  workspaces: readonly Pick<ChartWorkspaceRecord, "name" | "builtinName">[],
  locale: LocaleId = getLocale(),
): { name: string; builtinName: ChartWorkspaceBuiltinName } {
  const occupied = new Set(workspaces.map((workspace) => (
    chartWorkspaceDisplayName(workspace, locale).trim().toLocaleLowerCase()
  )));
  // With N existing workspaces, at least one of the first N + 1 localized
  // template names must be free, even when user-defined names occupy slots.
  for (let ordinal = 1; ordinal <= workspaces.length + 1; ordinal += 1) {
    const builtinName = { kind: "template", templateId, ordinal } as const;
    const name = builtinWorkspaceName(builtinName, locale);
    if (!occupied.has(name.toLocaleLowerCase())) return { name, builtinName };
  }
  throw new Error("Unable to allocate a unique built-in workspace name.");
}

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
  fallback = defaultChartWorkspaceName(),
): string {
  const normalized = typeof value === "string"
    ? value.trim().replace(/\s+/g, " ")
    : "";
  const candidate = normalized || fallback.trim() || defaultChartWorkspaceName();
  return candidate.slice(0, MAX_CHART_WORKSPACE_NAME_LENGTH);
}

export function uniqueChartWorkspaceName(
  requested: string,
  workspaces: readonly Pick<ChartWorkspaceRecord, "id" | "name" | "builtinName">[],
  excludeId: ChartWorkspaceId | null = null,
): string {
  const base = normalizeChartWorkspaceName(requested);
  const occupied = new Set(workspaces
    .filter((workspace) => workspace.id !== excludeId)
    .map((workspace) => chartWorkspaceDisplayName(workspace).trim().toLocaleLowerCase()));
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
  const sourceWindow = activeChartWorkspaceWindow(source);
  const anchor = chartWorkspaceCell(source, sourceWindow.activeCellId);
  const mainConfirmationIntervals = [anchor.session.interval, "4h", "1d", "15m"];
  const copyCellPreferences = (cell: ChartCellState, index: number): ChartCellState => ({
    ...cell,
    session: {
      ...cell.session,
      exchange: anchor.session.exchange,
      marketType: anchor.session.marketType,
      symbol: anchor.session.symbol,
      interval: templateId === "main-confirmation"
        ? mainConfirmationIntervals[index] ?? cell.session.interval
        : index === 0 ? anchor.session.interval : cell.session.interval,
    },
    chartSettings: cloneSerializable(anchor.chartSettings),
    priceScale: cloneSerializable(anchor.priceScale),
    indicators: cloneSerializable(anchor.indicators),
  });
  const targetCount = chartWorkspaceTemplateCellCount(templateId);
  const targetCellIds: ChartCellId[] = [...CHART_CELL_IDS];
  const occupied = new Set<ChartCellId>(targetCellIds);
  while (targetCellIds.length < targetCount) {
    const cellId = createChartCellId(occupied);
    if (!cellId) throw new Error(`Unable to allocate Cell ID for ${templateId}`);
    occupied.add(cellId);
    targetCellIds.push(cellId);
  }
  const confirmationGroupId = "group-confirmation";
  if (templateId === "main-confirmation") {
    const primaryGroup = document.linkGroups[DEFAULT_CHART_LINK_GROUP_ID]!;
    document.linkGroups = {
      ...document.linkGroups,
      [confirmationGroupId]: {
        id: confirmationGroupId,
        name: t("workspace.linkGroup.confirmation"),
        color: CHART_LINK_GROUP_COLORS[1],
        parentId: DEFAULT_CHART_LINK_GROUP_ID,
        peerPolicy: cloneSerializable(primaryGroup.peerPolicy),
        receiveFromParent: cloneSerializable(primaryGroup.receiveFromParent),
      },
    };
  }
  document.cells = Object.fromEntries(targetCellIds.map((cellId, index) => [
    cellId,
    {
      ...copyCellPreferences(document.cells[cellId] ?? { ...anchor, id: cellId }, index),
      linkGroupId: templateId === "main-confirmation" && index > 0 && index < 3
        ? confirmationGroupId
        : DEFAULT_CHART_LINK_GROUP_ID,
    },
  ])) as ChartWorkspaceDocument["cells"];
  const window = activeChartWorkspaceWindow(document);
  return replaceChartWorkspaceWindow(document, {
    ...window,
    layoutTree: createChartWorkspaceLayoutTree(
      templateId,
      undefined,
      targetCellIds.slice(0, targetCount),
    ),
    activeCellId: "cell-1",
    maximizedCellId: null,
  });
}

export interface CreateChartWorkspaceRecordOptions {
  id?: ChartWorkspaceId;
  name?: string;
  builtinName?: ChartWorkspaceBuiltinName;
  document?: ChartWorkspaceDocument;
  createdAt?: number;
  updatedAt?: number;
}

export function createChartWorkspaceRecord(
  options: CreateChartWorkspaceRecordOptions = {},
): ChartWorkspaceRecord {
  const now = options.createdAt ?? Date.now();
  const id = normalizeChartWorkspaceId(options.id) ?? createChartWorkspaceId();
  const name = normalizeChartWorkspaceName(options.name);
  const builtinName = normalizeBuiltinWorkspaceName(options.builtinName, id, name);
  return {
    schemaVersion: CHART_WORKSPACE_RECORD_SCHEMA_VERSION,
    id,
    name,
    ...(builtinName ? { builtinName } : {}),
    createdAt: now,
    updatedAt: options.updatedAt ?? now,
    document: options.document
      ? cloneChartWorkspaceDocument(options.document)
      : createDefaultChartWorkspace(),
  };
}

export function createDefaultChartWorkspaceRecord(
  now = Date.now(),
  locale: LocaleId = getLocale(),
): ChartWorkspaceRecord {
  return createChartWorkspaceRecord({
    id: DEFAULT_CHART_WORKSPACE_ID,
    name: defaultChartWorkspaceName(locale),
    builtinName: { kind: "default" },
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
  const name = normalizeChartWorkspaceName(value.name);
  const builtinName = normalizeBuiltinWorkspaceName(value.builtinName, id, name);
  return {
    schemaVersion: CHART_WORKSPACE_RECORD_SCHEMA_VERSION,
    id,
    name,
    ...(builtinName ? { builtinName } : {}),
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
    const sameDocument = existing
      ? JSON.stringify(normalizeChartWorkspace(recovery.document))
        === JSON.stringify(normalizeChartWorkspace(existing.document))
      : false;
    if (!existing
      || recovery.document.revision > existing.document.revision
      || (recovery.document.revision === existing.document.revision
        && sameDocument
        && recovery.updatedAt > existing.updatedAt)) {
      recordsById.set(recovery.id, recovery);
    }
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
  locale: LocaleId = getLocale(),
): ChartWorkspaceSummary[] {
  return workspaces.map((workspace) => ({
    id: workspace.id,
    name: chartWorkspaceDisplayName(workspace, locale),
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    layout: detectChartWorkspaceLayout(
      activeChartWorkspaceWindow(workspace.document).layoutTree,
    ),
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
