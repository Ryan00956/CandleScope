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
  CHART_LINK_GROUP_IDS,
  CHART_LINK_ROLES,
  CHART_WORKSPACE_SCHEMA_VERSION,
  CHART_WORKSPACE_TEMPLATE_IDS,
  DEFAULT_CHART_LINK_GROUP_SETTINGS,
  DEFAULT_CHART_WORKSPACE_LAYOUT_RATIOS,
  LEGACY_CHART_WORKSPACE_SCHEMA_VERSION,
  MAIN_CHART_WINDOW_ID,
  type ChartCellChartSettings,
  type ChartCellId,
  type ChartCellPriceScale,
  type ChartCellState,
  type ChartDrawingLayerSetId,
  type ChartLinkGroupId,
  type ChartLinkGroupSettings,
  type ChartLinkRole,
  type ChartWindowBoundsDip,
  type ChartWindowDisplayState,
  type ChartWindowId,
  type ChartWindowState,
  type ChartWorkspaceDocument,
  type ChartWorkspaceLayoutRatios,
  type ChartWorkspaceTemplateId,
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
  normalizeChartSplitRatio,
  normalizeChartWorkspaceLayoutTree,
  parseChartWorkspaceLayoutTree,
  visibleCellIds,
} from "./chartWorkspaceLayout.js";

export const CHART_WORKSPACE_V6_STORAGE_KEY = "candlescope-chart-workspace-v6";
export const CHART_WORKSPACE_STORAGE_KEY = "candlescope-chart-workspace-v2";
export const LEGACY_CHART_WORKSPACE_STORAGE_KEY = "candlescope-chart-workspace-v1";
const RECURSIVE_LAYOUT_SCHEMA_VERSION = 3;

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

function normalizeLinkGroup(value: unknown, fallback: ChartLinkGroupId | null): ChartLinkGroupId | null {
  if (value === null || value === "") return null;
  return CHART_LINK_GROUP_IDS.includes(value as ChartLinkGroupId)
    ? value as ChartLinkGroupId
    : fallback;
}

function normalizeLinkGroupSettings(value: unknown): ChartLinkGroupSettings {
  const source = isRecord(value) ? value : {};
  const legacyTimeRange = typeof source.timeRange === "boolean"
    ? source.timeRange
    : DEFAULT_CHART_LINK_GROUP_SETTINGS.dateRange;
  const dateRange = typeof source.dateRange === "boolean"
    ? source.dateRange
    : legacyTimeRange;
  const requestedTimeAnchor = typeof source.timeAnchor === "boolean"
    ? source.timeAnchor
    : DEFAULT_CHART_LINK_GROUP_SETTINGS.timeAnchor;
  return {
    market: typeof source.market === "boolean" ? source.market : DEFAULT_CHART_LINK_GROUP_SETTINGS.market,
    interval: typeof source.interval === "boolean" ? source.interval : DEFAULT_CHART_LINK_GROUP_SETTINGS.interval,
    crosshair: typeof source.crosshair === "boolean" ? source.crosshair : DEFAULT_CHART_LINK_GROUP_SETTINGS.crosshair,
    timeAnchor: dateRange ? false : requestedTimeAnchor,
    dateRange,
    drawings: typeof source.drawings === "boolean" ? source.drawings : DEFAULT_CHART_LINK_GROUP_SETTINGS.drawings,
  };
}

function normalizeLinkRole(value: unknown): ChartLinkRole {
  return CHART_LINK_ROLES.includes(value as ChartLinkRole)
    ? value as ChartLinkRole
    : "bidirectional";
}

function normalizeDrawingLayerSet(value: unknown): ChartDrawingLayerSetId {
  return CHART_DRAWING_LAYER_SET_IDS.includes(value as ChartDrawingLayerSetId)
    ? value as ChartDrawingLayerSetId
    : "1";
}

function normalizeLayoutRatios(value: unknown): ChartWorkspaceLayoutRatios {
  const source = isRecord(value) ? value : {};
  return {
    splitVertical: normalizeChartSplitRatio(source.splitVertical, DEFAULT_CHART_WORKSPACE_LAYOUT_RATIOS.splitVertical),
    splitHorizontal: normalizeChartSplitRatio(source.splitHorizontal, DEFAULT_CHART_WORKSPACE_LAYOUT_RATIOS.splitHorizontal),
    quadColumns: normalizeChartSplitRatio(source.quadColumns, DEFAULT_CHART_WORKSPACE_LAYOUT_RATIOS.quadColumns),
    quadRows: normalizeChartSplitRatio(source.quadRows, DEFAULT_CHART_WORKSPACE_LAYOUT_RATIOS.quadRows),
  };
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
    linkGroup: "A",
    linkRole: "bidirectional",
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
    linkGroups: Object.fromEntries(CHART_LINK_GROUP_IDS.map((group) => [
      group,
      { ...DEFAULT_CHART_LINK_GROUP_SETTINGS },
    ])) as Record<ChartLinkGroupId, ChartLinkGroupSettings>,
    cells,
  };
}

function normalizeLegacyLayout(value: unknown): ChartWorkspaceTemplateId {
  return CHART_WORKSPACE_TEMPLATE_IDS.includes(value as ChartWorkspaceTemplateId)
    ? value as ChartWorkspaceTemplateId
    : "single";
}

function normalizeLegacyCellId(value: unknown, fallback: ChartCellId): ChartCellId {
  return typeof value === "string" && CHART_CELL_IDS.includes(value as typeof CHART_CELL_IDS[number])
    ? value
    : fallback;
}

function normalizedLinkGroups(value: unknown): Record<ChartLinkGroupId, ChartLinkGroupSettings> {
  const source = isRecord(value) ? value : {};
  return Object.fromEntries(CHART_LINK_GROUP_IDS.map((group) => [
    group,
    normalizeLinkGroupSettings(source[group]),
  ])) as Record<ChartLinkGroupId, ChartLinkGroupSettings>;
}

function normalizeCellState(
  id: ChartCellId,
  value: unknown,
  fallback: ChartCellState,
  hasLinkGroups = true,
  hasAdvancedLinks = true,
): ChartCellState {
  const source = isRecord(value) ? value : {};
  return {
    id,
    linkGroup: hasLinkGroups ? normalizeLinkGroup(source.linkGroup, fallback.linkGroup) : null,
    linkRole: hasAdvancedLinks ? normalizeLinkRole(source.linkRole) : "bidirectional",
    drawingLayerSet: hasAdvancedLinks ? normalizeDrawingLayerSet(source.drawingLayerSet) : "1",
    session: normalizeSession(source.session, fallback.session),
    chartSettings: normalizeCellChartSettings(source.chartSettings),
    priceScale: normalizePriceScale(source.priceScale),
    indicators: normalizeIndicators(source.indicators),
  };
}

function migrateLegacyChartWorkspace(
  value: Record<string, unknown>,
  sourceSchemaVersion: number,
): ChartWorkspaceDocument {
  const fallback = createDefaultChartWorkspace();
  const fallbackWindow = fallback.windows[MAIN_CHART_WINDOW_ID]!;
  const sourceCells = isRecord(value.cells) ? value.cells : {};
  const cells = Object.fromEntries(CHART_CELL_IDS.map((id) => [
    id,
    normalizeCellState(
      id,
      sourceCells[id],
      fallback.cells[id]!,
      sourceSchemaVersion >= 2,
      sourceSchemaVersion >= 4,
    ),
  ])) as Record<ChartCellId, ChartCellState>;
  const legacyTree = createChartWorkspaceLayoutTree(
    normalizeLegacyLayout(value.layout),
    normalizeLayoutRatios(value.layoutRatios),
  );
  const layoutTree = sourceSchemaVersion >= RECURSIVE_LAYOUT_SCHEMA_VERSION
    ? normalizeChartWorkspaceLayoutTree(value.layoutTree, legacyTree, {
      knownCellIds: new Set(CHART_CELL_IDS),
      maxCells: CHART_CELL_IDS.length,
    })
    : legacyTree;
  const requestedActiveCellId = normalizeLegacyCellId(value.activeCellId, "cell-1");
  const maximizedCellId = value.maximizedCellId == null
    ? null
    : normalizeLegacyCellId(value.maximizedCellId, requestedActiveCellId);
  const layoutCellIds = visibleCellIds(layoutTree);
  const activeCellId = maximizedCellId
    ?? (layoutCellIds.includes(requestedActiveCellId)
      ? requestedActiveCellId
      : layoutCellIds[0] ?? "cell-1");
  const mainWindow: ChartWindowState = {
    ...fallbackWindow,
    layoutTree,
    layoutLocked: sourceSchemaVersion >= LEGACY_CHART_WORKSPACE_SCHEMA_VERSION
      && value.layoutLocked === true,
    activeCellId,
    maximizedCellId,
  };
  return {
    schemaVersion: CHART_WORKSPACE_SCHEMA_VERSION,
    revision: 0,
    activeWindowId: MAIN_CHART_WINDOW_ID,
    windows: { [MAIN_CHART_WINDOW_ID]: mainWindow },
    linkGroups: normalizedLinkGroups(value.linkGroups),
    cells,
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

function normalizeV6ChartWorkspace(
  value: Record<string, unknown>,
): NormalizeChartWorkspaceResult {
  const fallback = createDefaultChartWorkspace();
  const diagnostics: ChartWorkspaceNormalizationDiagnostic[] = [];
  const revision = Number(value.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    diagnostics.push({ code: "invalid-revision", path: "revision" });
  }
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
    cells[key] = normalizeCellState(key, candidate, fallback.cells[key] ?? {
      ...dynamicFallback,
      id: key,
    });
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
      linkGroups: normalizedLinkGroups(value.linkGroups),
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
    return normalizeV6ChartWorkspace(value);
  }
  if (Number.isInteger(rawSchemaVersion)
    && rawSchemaVersion >= 1
    && rawSchemaVersion <= LEGACY_CHART_WORKSPACE_SCHEMA_VERSION) {
    return {
      document: migrateLegacyChartWorkspace(value, rawSchemaVersion),
      diagnostics: [],
      migratedFromSchemaVersion: rawSchemaVersion,
      usedFallback: false,
    };
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

export function loadLegacyChartWorkspace(
  storage: ChartWorkspaceStorageLike | null = browserStorage(),
): ChartWorkspaceDocument | null {
  if (!storage) return null;
  try {
    const raw = loadRawWorkspace(storage, [
      CHART_WORKSPACE_STORAGE_KEY,
      LEGACY_CHART_WORKSPACE_STORAGE_KEY,
    ]);
    return raw ? normalizeChartWorkspace(raw) : null;
  } catch {
    return null;
  }
}

export function loadChartWorkspace(
  storage: ChartWorkspaceStorageLike | null = browserStorage(),
): ChartWorkspaceDocument {
  if (!storage) return createDefaultChartWorkspace();
  try {
    const v6 = loadRawWorkspace(storage, [CHART_WORKSPACE_V6_STORAGE_KEY]);
    if (v6) return normalizeChartWorkspace(v6);
    return loadLegacyChartWorkspace(storage) ?? createDefaultChartWorkspace();
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
      CHART_WORKSPACE_V6_STORAGE_KEY,
      JSON.stringify(normalizeChartWorkspace(workspace)),
    );
  } catch {
    // Workspace persistence is best effort and must not break live charts.
  }
}
