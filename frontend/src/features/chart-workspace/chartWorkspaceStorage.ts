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
  CHART_LINK_GROUP_IDS,
  CHART_WORKSPACE_SCHEMA_VERSION,
  CHART_WORKSPACE_TEMPLATE_IDS,
  DEFAULT_CHART_LINK_GROUP_SETTINGS,
  DEFAULT_CHART_WORKSPACE_LAYOUT_RATIOS,
  type ChartCellChartSettings,
  type ChartCellId,
  type ChartCellPriceScale,
  type ChartCellState,
  type ChartLinkGroupId,
  type ChartLinkGroupSettings,
  type ChartWorkspaceDocument,
  type ChartWorkspaceLayoutRatios,
  type ChartWorkspaceTemplateId,
} from "./chartWorkspaceTypes.js";
import {
  createChartWorkspaceLayoutTree,
  normalizeChartSplitRatio,
  normalizeChartWorkspaceLayoutTree,
  visibleCellIds,
} from "./chartWorkspaceLayout.js";

export const CHART_WORKSPACE_STORAGE_KEY = "candlescope-chart-workspace-v2";
export const LEGACY_CHART_WORKSPACE_STORAGE_KEY = "candlescope-chart-workspace-v1";

export interface ChartWorkspaceStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
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
  return {
    market: typeof source.market === "boolean"
      ? source.market
      : DEFAULT_CHART_LINK_GROUP_SETTINGS.market,
    interval: typeof source.interval === "boolean"
      ? source.interval
      : DEFAULT_CHART_LINK_GROUP_SETTINGS.interval,
    crosshair: typeof source.crosshair === "boolean"
      ? source.crosshair
      : DEFAULT_CHART_LINK_GROUP_SETTINGS.crosshair,
    timeRange: typeof source.timeRange === "boolean"
      ? source.timeRange
      : DEFAULT_CHART_LINK_GROUP_SETTINGS.timeRange,
  };
}

function normalizeLayoutRatios(value: unknown): ChartWorkspaceLayoutRatios {
  const source = isRecord(value) ? value : {};
  return {
    splitVertical: normalizeChartSplitRatio(
      source.splitVertical,
      DEFAULT_CHART_WORKSPACE_LAYOUT_RATIOS.splitVertical,
    ),
    splitHorizontal: normalizeChartSplitRatio(
      source.splitHorizontal,
      DEFAULT_CHART_WORKSPACE_LAYOUT_RATIOS.splitHorizontal,
    ),
    quadColumns: normalizeChartSplitRatio(
      source.quadColumns,
      DEFAULT_CHART_WORKSPACE_LAYOUT_RATIOS.quadColumns,
    ),
    quadRows: normalizeChartSplitRatio(
      source.quadRows,
      DEFAULT_CHART_WORKSPACE_LAYOUT_RATIOS.quadRows,
    ),
  };
}

function defaultCell(
  id: ChartCellId,
  baseSession: ChartSession,
  chartSettings: ChartCellChartSettings,
  indicators: IndicatorDefinition[],
): ChartCellState {
  const index = CHART_CELL_IDS.indexOf(id);
  const interval = canonicalizeIntervalValue(DEFAULT_CELL_INTERVALS[index]) || baseSession.interval;
  return {
    id,
    linkGroup: "A",
    session: {
      ...baseSession,
      interval: index === 0 ? baseSession.interval : interval,
    },
    chartSettings: { ...chartSettings },
    priceScale: { invertScale: false, priceScaleMode: 0 },
    indicators: indicators.map((indicator) => ({ ...indicator })),
  };
}

export function createDefaultChartWorkspace(): ChartWorkspaceDocument {
  const session = loadInitialChartSession();
  const chartSettings = pickCellChartSettings(DEFAULT_SETTINGS);
  const indicators = loadActiveIndicators();
  const cells = Object.fromEntries(
    CHART_CELL_IDS.map((id) => [id, defaultCell(id, session, chartSettings, indicators)]),
  ) as Record<ChartCellId, ChartCellState>;
  return {
    schemaVersion: CHART_WORKSPACE_SCHEMA_VERSION,
    layoutTree: createChartWorkspaceLayoutTree("single"),
    activeCellId: "cell-1",
    maximizedCellId: null,
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

function normalizeCellId(value: unknown, fallback: ChartCellId): ChartCellId {
  return CHART_CELL_IDS.includes(value as ChartCellId) ? value as ChartCellId : fallback;
}

export function normalizeChartWorkspace(value: unknown): ChartWorkspaceDocument {
  const fallback = createDefaultChartWorkspace();
  if (!isRecord(value)) return fallback;
  const sourceCells = isRecord(value.cells) ? value.cells : {};
  const sourceSchemaVersion = Number(value.schemaVersion);
  const hasLinkGroups = Number.isInteger(sourceSchemaVersion)
    && sourceSchemaVersion >= 2;
  const cells = Object.fromEntries(CHART_CELL_IDS.map((id) => {
    const defaultValue = fallback.cells[id];
    const source = isRecord(sourceCells[id]) ? sourceCells[id] : {};
    return [id, {
      id,
      linkGroup: hasLinkGroups
        ? normalizeLinkGroup(source.linkGroup, defaultValue.linkGroup)
        : null,
      session: normalizeSession(source.session, defaultValue.session),
      chartSettings: normalizeCellChartSettings(source.chartSettings),
      priceScale: normalizePriceScale(source.priceScale),
      indicators: normalizeIndicators(source.indicators),
    } satisfies ChartCellState];
  })) as Record<ChartCellId, ChartCellState>;
  const legacyLayout = normalizeLegacyLayout(value.layout);
  const legacyRatios = normalizeLayoutRatios(value.layoutRatios);
  const legacyTree = createChartWorkspaceLayoutTree(legacyLayout, legacyRatios);
  const layoutTree = sourceSchemaVersion >= CHART_WORKSPACE_SCHEMA_VERSION
    ? normalizeChartWorkspaceLayoutTree(value.layoutTree, legacyTree)
    : legacyTree;
  const requestedActiveCellId = normalizeCellId(value.activeCellId, "cell-1");
  const maximizedCellId = value.maximizedCellId == null
    ? null
    : normalizeCellId(value.maximizedCellId, requestedActiveCellId);
  const layoutCellIds = visibleCellIds(layoutTree);
  const activeCellId = maximizedCellId
    ?? (layoutCellIds.includes(requestedActiveCellId)
      ? requestedActiveCellId
      : layoutCellIds[0] ?? "cell-1");
  const sourceLinkGroups = isRecord(value.linkGroups) ? value.linkGroups : {};
  const linkGroups = Object.fromEntries(CHART_LINK_GROUP_IDS.map((group) => [
    group,
    normalizeLinkGroupSettings(sourceLinkGroups[group]),
  ])) as Record<ChartLinkGroupId, ChartLinkGroupSettings>;
  return {
    schemaVersion: CHART_WORKSPACE_SCHEMA_VERSION,
    layoutTree,
    activeCellId,
    maximizedCellId,
    linkGroups,
    cells,
  };
}

export function loadChartWorkspace(
  storage: ChartWorkspaceStorageLike | null = browserStorage(),
): ChartWorkspaceDocument {
  if (!storage) return createDefaultChartWorkspace();
  try {
    const raw = storage.getItem(CHART_WORKSPACE_STORAGE_KEY)
      ?? storage.getItem(LEGACY_CHART_WORKSPACE_STORAGE_KEY);
    return raw ? normalizeChartWorkspace(JSON.parse(raw)) : createDefaultChartWorkspace();
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
      CHART_WORKSPACE_STORAGE_KEY,
      JSON.stringify(normalizeChartWorkspace(workspace)),
    );
  } catch {
    // Workspace persistence is best effort and must not break live charts.
  }
}
