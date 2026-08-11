import { canonicalizeIntervalValue } from "../../utils/intervals.js";
import type { ExchangeId, MarketType, SymbolCode } from "../../utils/symbolKey.js";
import { loadInitialChartSession } from "../chart-session/chartSessionModel.js";
import type { ChartSession } from "../chart-session/chartSessionTypes.js";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type ChartSettings,
} from "../settings/chartAppearanceSettings.js";
import type { IndicatorDefinition } from "../indicators/indicatorTypes.js";
import { loadActiveIndicators } from "../indicators/activeIndicatorStore.js";
import {
  CELL_CHART_SETTING_KEYS,
  CHART_CELL_IDS,
  CHART_DRAWING_LAYER_SET_IDS,
  CHART_LINK_GROUP_COLORS,
  CHART_WORKSPACE_SCHEMA_VERSION,
  DEFAULT_CHART_LINK_GROUP_ID,
  DEFAULT_CHART_LINK_GROUP_SETTINGS,
  MAIN_CHART_WINDOW_ID,
  MAX_CHART_LINK_GROUP_DEPTH,
  type ChartCellChartSettings,
  type ChartCellId,
  type ChartCellPriceScale,
  type ChartCellState,
  type ChartDrawingLayerSetId,
  type ChartLinkGroup,
  type ChartLinkGroupId,
  type ChartLinkGroupSettings,
  type ChartWindowBoundsDip,
  type ChartWindowDisplayState,
  type ChartWindowId,
  type ChartWindowState,
  type ChartWorkspaceDocument,
} from "./chartWorkspaceTypes.js";
import {
  MAX_CELLS_PER_APP,
  MAX_CELLS_PER_WINDOW,
  MAX_WINDOWS_PER_WORKSPACE,
} from "./chartWorkspaceCapacity.js";
import {
  isChartCellId,
  isChartWindowId,
} from "./chartWorkspaceIdentity.js";
import {
  createChartWorkspaceLayoutTree,
  parseChartWorkspaceLayoutTree,
  visibleCellIds,
} from "./chartWorkspaceLayout.js";

export const CHART_WORKSPACE_V7_STORAGE_KEY = "candlescope-chart-workspace-v7";

export interface ChartWorkspaceStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ChartWorkspaceNormalizationDiagnostic {
  code:
    | "invalid-document"
    | "unsupported-schema"
    | "invalid-revision"
    | "invalid-cell-record"
    | "invalid-cell-id"
    | "invalid-cell-link-group"
    | "invalid-link-groups"
    | "invalid-link-group"
    | "invalid-link-parent"
    | "link-group-cycle"
    | "max-link-depth"
    | "max-cells-app"
    | "invalid-window-record"
    | "invalid-window-id"
    | "max-windows"
    | "duplicate-cell-reference"
    | "invalid-active-window"
    | `layout-${string}`;
  path: string;
}

export interface NormalizeChartWorkspaceResult {
  document: ChartWorkspaceDocument;
  diagnostics: ChartWorkspaceNormalizationDiagnostic[];
  migratedFromSchemaVersion: number | null;
  usedFallback: boolean;
}

const DEFAULT_CELL_INTERVALS = ["1h", "15m", "4h", "1d"] as const;

function browserStorage(): ChartWorkspaceStorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSession(value: unknown, fallback: ChartSession): ChartSession {
  const source = isRecord(value) ? value : {};
  const symbol = typeof source.symbol === "string" && source.symbol.trim()
    ? source.symbol.trim().toUpperCase() as SymbolCode
    : fallback.symbol;
  const exchange = typeof source.exchange === "string" && source.exchange.trim()
    ? source.exchange.trim().toLowerCase() as ExchangeId
    : fallback.exchange;
  const marketType = typeof source.marketType === "string" && source.marketType.trim()
    ? source.marketType.trim().toLowerCase() as MarketType
    : fallback.marketType;
  const interval = canonicalizeIntervalValue(source.interval) || fallback.interval;
  return { exchange, marketType, symbol, interval };
}

function pickCellChartSettings(settings: ChartSettings): ChartCellChartSettings {
  const entries = CELL_CHART_SETTING_KEYS.map((key) => [key, settings[key]]);
  return Object.fromEntries(entries) as ChartCellChartSettings;
}

function normalizeCellChartSettings(value: unknown): ChartCellChartSettings {
  return pickCellChartSettings(normalizeSettings(value));
}

function normalizePriceScale(value: unknown): ChartCellPriceScale {
  const source = isRecord(value) ? value : {};
  const parsedMode = Number(source.priceScaleMode);
  return {
    invertScale: source.invertScale === true,
    priceScaleMode: Number.isInteger(parsedMode) && parsedMode >= 0 && parsedMode <= 3
      ? parsedMode
      : 0,
  };
}

function isIndicatorDefinition(value: unknown): value is IndicatorDefinition {
  return isRecord(value) && typeof value.id === "string" && value.id.trim().length > 0;
}

function normalizeIndicators(value: unknown): IndicatorDefinition[] {
  return Array.isArray(value) ? value.filter(isIndicatorDefinition) : [];
}

function normalizeLinkGroupSettings(value: unknown): ChartLinkGroupSettings {
  const source = isRecord(value) ? value : {};
  const dateRange = typeof source.dateRange === "boolean"
    ? source.dateRange
    : DEFAULT_CHART_LINK_GROUP_SETTINGS.dateRange;
  const requestedTimeAnchor = typeof source.timeAnchor === "boolean"
    ? source.timeAnchor
    : DEFAULT_CHART_LINK_GROUP_SETTINGS.timeAnchor;
  const indicatorSource = isRecord(source.indicators) ? source.indicators : {};
  return {
    market: typeof source.market === "boolean" ? source.market : DEFAULT_CHART_LINK_GROUP_SETTINGS.market,
    interval: typeof source.interval === "boolean" ? source.interval : DEFAULT_CHART_LINK_GROUP_SETTINGS.interval,
    crosshair: typeof source.crosshair === "boolean" ? source.crosshair : DEFAULT_CHART_LINK_GROUP_SETTINGS.crosshair,
    timeAnchor: dateRange ? false : requestedTimeAnchor,
    dateRange,
    drawings: typeof source.drawings === "boolean" ? source.drawings : DEFAULT_CHART_LINK_GROUP_SETTINGS.drawings,
    indicators: {
      definitions: typeof indicatorSource.definitions === "boolean"
        ? indicatorSource.definitions
        : DEFAULT_CHART_LINK_GROUP_SETTINGS.indicators.definitions,
      parameters: typeof indicatorSource.parameters === "boolean"
        ? indicatorSource.parameters
        : DEFAULT_CHART_LINK_GROUP_SETTINGS.indicators.parameters,
      visual: typeof indicatorSource.visual === "boolean"
        ? indicatorSource.visual
        : DEFAULT_CHART_LINK_GROUP_SETTINGS.indicators.visual,
      paneLayout: typeof indicatorSource.paneLayout === "boolean"
        ? indicatorSource.paneLayout
        : DEFAULT_CHART_LINK_GROUP_SETTINGS.indicators.paneLayout,
    },
  };
}

function cloneDefaultLinkGroupSettings(): ChartLinkGroupSettings {
  return {
    ...DEFAULT_CHART_LINK_GROUP_SETTINGS,
    indicators: { ...DEFAULT_CHART_LINK_GROUP_SETTINGS.indicators },
  };
}

function normalizeDrawingLayerSet(value: unknown): ChartDrawingLayerSetId {
  return CHART_DRAWING_LAYER_SET_IDS.includes(value as ChartDrawingLayerSetId)
    ? value as ChartDrawingLayerSetId
    : "1";
}

function defaultCell(
  id: ChartCellId,
  baseSession: ChartSession,
  chartSettings: ChartCellChartSettings,
  indicators: IndicatorDefinition[],
  index: number,
): ChartCellState {
  const interval = canonicalizeIntervalValue(DEFAULT_CELL_INTERVALS[index]) || baseSession.interval;
  return {
    id,
    linkGroupId: DEFAULT_CHART_LINK_GROUP_ID,
    drawingLayerSet: "1",
    session: { ...baseSession, interval: index === 0 ? baseSession.interval : interval },
    chartSettings: { ...chartSettings },
    priceScale: { invertScale: false, priceScaleMode: 0 },
    indicators: indicators.map((indicator) => ({ ...indicator })),
  };
}

function createDefaultChartWindow(): ChartWindowState {
  return {
    id: MAIN_CHART_WINDOW_ID,
    layoutTree: createChartWorkspaceLayoutTree("single"),
    layoutLocked: false,
    activeCellId: "cell-1",
    maximizedCellId: null,
    boundsDip: null,
    monitorFingerprint: null,
    dpiScale: null,
    windowState: "normal",
  };
}

export function createDefaultChartWorkspace(): ChartWorkspaceDocument {
  const session = loadInitialChartSession();
  const chartSettings = pickCellChartSettings(DEFAULT_SETTINGS);
  const indicators = loadActiveIndicators();
  const cells = Object.fromEntries(CHART_CELL_IDS.map((id, index) => [
    id,
    defaultCell(id, session, chartSettings, indicators, index),
  ])) as Record<ChartCellId, ChartCellState>;
  const mainWindow = createDefaultChartWindow();
  return {
    schemaVersion: CHART_WORKSPACE_SCHEMA_VERSION,
    revision: 0,
    activeWindowId: MAIN_CHART_WINDOW_ID,
    windows: { [MAIN_CHART_WINDOW_ID]: mainWindow },
    linkGroups: {
      [DEFAULT_CHART_LINK_GROUP_ID]: {
        id: DEFAULT_CHART_LINK_GROUP_ID,
        name: "主控组",
        color: CHART_LINK_GROUP_COLORS[0],
        parentId: null,
        peerPolicy: cloneDefaultLinkGroupSettings(),
        receiveFromParent: cloneDefaultLinkGroupSettings(),
      },
    },
    cells,
  };
}

function normalizeLinkGroups(
  value: unknown,
  diagnostics: ChartWorkspaceNormalizationDiagnostic[],
): Record<ChartLinkGroupId, ChartLinkGroup> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    diagnostics.push({ code: "invalid-link-groups", path: "linkGroups" });
    return {};
  }
  const groups: Record<ChartLinkGroupId, ChartLinkGroup> = {};
  for (const [id, candidate] of Object.entries(value)) {
    if (!id.trim() || id.length > 128 || !isRecord(candidate) || candidate.id !== id) {
      diagnostics.push({ code: "invalid-link-group", path: `linkGroups.${id}` });
      continue;
    }
    groups[id] = {
      id,
      name: typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name.trim().slice(0, 64)
        : id,
      color: typeof candidate.color === "string" && candidate.color.trim()
        ? candidate.color.trim().slice(0, 32)
        : CHART_LINK_GROUP_COLORS[Object.keys(groups).length % CHART_LINK_GROUP_COLORS.length]!,
      parentId: typeof candidate.parentId === "string" && candidate.parentId.trim()
        ? candidate.parentId
        : null,
      peerPolicy: normalizeLinkGroupSettings(candidate.peerPolicy),
      receiveFromParent: normalizeLinkGroupSettings(candidate.receiveFromParent),
    };
  }
  for (const group of Object.values(groups)) {
    if (group.parentId && !groups[group.parentId]) {
      diagnostics.push({ code: "invalid-link-parent", path: `linkGroups.${group.id}.parentId` });
      continue;
    }
    const visited = new Set<ChartLinkGroupId>();
    let current: ChartLinkGroup | null = group;
    let depth = 1;
    while (current?.parentId) {
      if (visited.has(current.id)) {
        diagnostics.push({ code: "link-group-cycle", path: `linkGroups.${group.id}.parentId` });
        break;
      }
      visited.add(current.id);
      current = groups[current.parentId] ?? null;
      depth += 1;
      if (depth > MAX_CHART_LINK_GROUP_DEPTH) {
        diagnostics.push({ code: "max-link-depth", path: `linkGroups.${group.id}.parentId` });
        break;
      }
    }
  }
  return groups;
}

function normalizeCellState(
  id: ChartCellId,
  value: unknown,
  fallback: ChartCellState,
  linkGroups: Record<ChartLinkGroupId, ChartLinkGroup>,
  diagnostics: ChartWorkspaceNormalizationDiagnostic[],
): ChartCellState {
  const source = isRecord(value) ? value : {};
  const requestedLinkGroupId = source.linkGroupId === null
    ? null
    : typeof source.linkGroupId === "string" && linkGroups[source.linkGroupId]
      ? source.linkGroupId
      : fallback.linkGroupId;
  if (source.linkGroupId !== null
    && (typeof source.linkGroupId !== "string" || !linkGroups[source.linkGroupId])) {
    diagnostics.push({ code: "invalid-cell-link-group", path: `cells.${id}.linkGroupId` });
  }
  return {
    id,
    linkGroupId: requestedLinkGroupId,
    drawingLayerSet: normalizeDrawingLayerSet(source.drawingLayerSet),
    session: normalizeSession(source.session, fallback.session),
    chartSettings: normalizeCellChartSettings(source.chartSettings),
    priceScale: normalizePriceScale(source.priceScale),
    indicators: normalizeIndicators(source.indicators),
  };
}

function normalizeBounds(value: unknown): ChartWindowBoundsDip | null {
  if (!isRecord(value)) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  const height = Number(value.height);
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
    ? { x, y, width, height }
    : null;
}

function normalizeWindowState(value: unknown): ChartWindowDisplayState {
  return value === "maximized" || value === "minimized" ? value : "normal";
}

function failResult(
  fallback: ChartWorkspaceDocument,
  diagnostics: ChartWorkspaceNormalizationDiagnostic[],
): NormalizeChartWorkspaceResult {
  return {
    document: fallback,
    diagnostics,
    migratedFromSchemaVersion: null,
    usedFallback: true,
  };
}

function normalizeV7ChartWorkspace(
  value: Record<string, unknown>,
): NormalizeChartWorkspaceResult {
  const fallback = createDefaultChartWorkspace();
  const diagnostics: ChartWorkspaceNormalizationDiagnostic[] = [];
  const revision = Number(value.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    diagnostics.push({ code: "invalid-revision", path: "revision" });
  }
  const linkGroups = normalizeLinkGroups(value.linkGroups, diagnostics);
  const sourceCells = isRecord(value.cells) ? value.cells : null;
  if (!sourceCells) diagnostics.push({ code: "invalid-cell-record", path: "cells" });
  const sourceCellEntries = sourceCells ? Object.entries(sourceCells) : [];
  if (sourceCellEntries.length === 0 || sourceCellEntries.length > MAX_CELLS_PER_APP) {
    diagnostics.push({ code: "max-cells-app", path: "cells" });
  }
  const cells: Record<ChartCellId, ChartCellState> = {};
  const dynamicFallback = fallback.cells["cell-1"]!;
  for (const [key, candidate] of sourceCellEntries) {
    if (!isChartCellId(key) || !isRecord(candidate) || candidate.id !== key) {
      diagnostics.push({ code: "invalid-cell-id", path: `cells.${key}` });
      continue;
    }
    cells[key] = normalizeCellState(
      key,
      candidate,
      fallback.cells[key] ?? { ...dynamicFallback, id: key },
      linkGroups,
      diagnostics,
    );
  }
  const sourceWindows = isRecord(value.windows) ? value.windows : null;
  if (!sourceWindows) diagnostics.push({ code: "invalid-window-record", path: "windows" });
  const sourceWindowEntries = sourceWindows ? Object.entries(sourceWindows) : [];
  if (sourceWindowEntries.length === 0 || sourceWindowEntries.length > MAX_WINDOWS_PER_WORKSPACE) {
    diagnostics.push({ code: "max-windows", path: "windows" });
  }
  const windows: Record<ChartWindowId, ChartWindowState> = {};
  const globallyReferencedCells = new Set<ChartCellId>();
  for (const [key, candidate] of sourceWindowEntries) {
    if (!isChartWindowId(key) || !isRecord(candidate) || candidate.id !== key) {
      diagnostics.push({ code: "invalid-window-id", path: `windows.${key}` });
      continue;
    }
    const layout = parseChartWorkspaceLayoutTree(candidate.layoutTree, {
      knownCellIds: new Set(Object.keys(cells)),
      maxCells: MAX_CELLS_PER_WINDOW,
      path: `windows.${key}.layoutTree`,
    });
    diagnostics.push(...layout.diagnostics.map((diagnostic) => ({
      code: `layout-${diagnostic.code}` as const,
      path: diagnostic.path,
    })));
    if (!layout.tree) continue;
    const referenced = visibleCellIds(layout.tree);
    for (const cellId of referenced) {
      if (globallyReferencedCells.has(cellId)) {
        diagnostics.push({
          code: "duplicate-cell-reference",
          path: `windows.${key}.layoutTree`,
        });
      }
      globallyReferencedCells.add(cellId);
    }
    const requestedActiveCellId = isChartCellId(candidate.activeCellId)
      ? candidate.activeCellId
      : referenced[0]!;
    const maximizedCellId = candidate.maximizedCellId == null
      ? null
      : isChartCellId(candidate.maximizedCellId) && cells[candidate.maximizedCellId]
        ? candidate.maximizedCellId
        : null;
    const activeCellId = maximizedCellId
      ?? (referenced.includes(requestedActiveCellId) ? requestedActiveCellId : referenced[0]!);
    windows[key] = {
      id: key,
      layoutTree: layout.tree,
      layoutLocked: candidate.layoutLocked === true,
      activeCellId,
      maximizedCellId,
      boundsDip: normalizeBounds(candidate.boundsDip),
      monitorFingerprint: typeof candidate.monitorFingerprint === "string"
        ? candidate.monitorFingerprint.slice(0, 256)
        : null,
      dpiScale: Number.isFinite(Number(candidate.dpiScale)) && Number(candidate.dpiScale) > 0
        ? Number(candidate.dpiScale)
        : null,
      windowState: normalizeWindowState(candidate.windowState),
    };
  }
  const activeWindowId = isChartWindowId(value.activeWindowId)
    && windows[value.activeWindowId]
    ? value.activeWindowId
    : null;
  if (!activeWindowId) diagnostics.push({ code: "invalid-active-window", path: "activeWindowId" });
  if (diagnostics.length > 0 || !activeWindowId) return failResult(fallback, diagnostics);
  return {
    document: {
      schemaVersion: CHART_WORKSPACE_SCHEMA_VERSION,
      revision,
      activeWindowId,
      windows,
      linkGroups,
      cells,
    },
    diagnostics: [],
    migratedFromSchemaVersion: null,
    usedFallback: false,
  };
}

export function normalizeChartWorkspaceWithDiagnostics(
  value: unknown,
): NormalizeChartWorkspaceResult {
  const fallback = createDefaultChartWorkspace();
  if (!isRecord(value)) {
    return failResult(fallback, [{ code: "invalid-document", path: "$" }]);
  }
  const rawSchemaVersion = value.schemaVersion == null ? 1 : Number(value.schemaVersion);
  if (rawSchemaVersion === CHART_WORKSPACE_SCHEMA_VERSION) {
    return normalizeV7ChartWorkspace(value);
  }
  return failResult(fallback, [{ code: "unsupported-schema", path: "schemaVersion" }]);
}

export function normalizeChartWorkspace(value: unknown): ChartWorkspaceDocument {
  return normalizeChartWorkspaceWithDiagnostics(value).document;
}

function loadRawWorkspace(
  storage: ChartWorkspaceStorageLike,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    const raw = storage.getItem(key);
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

export function loadChartWorkspace(
  storage: ChartWorkspaceStorageLike | null = browserStorage(),
): ChartWorkspaceDocument {
  if (!storage) return createDefaultChartWorkspace();
  try {
    const v7 = loadRawWorkspace(storage, [CHART_WORKSPACE_V7_STORAGE_KEY]);
    return v7 ? normalizeChartWorkspace(v7) : createDefaultChartWorkspace();
  } catch {
    return createDefaultChartWorkspace();
  }
}

export function saveChartWorkspace(
  workspace: ChartWorkspaceDocument,
  storage: ChartWorkspaceStorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      CHART_WORKSPACE_V7_STORAGE_KEY,
      JSON.stringify(normalizeChartWorkspace(workspace)),
    );
  } catch {
    // Workspace persistence is best effort and must not break live charts.
  }
}
