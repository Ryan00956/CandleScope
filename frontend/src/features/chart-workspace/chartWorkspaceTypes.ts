import type { ChartSession } from "../chart-session/chartSessionTypes.js";
import type { ChartSettings } from "../settings/chartAppearanceSettings.js";
import type { IndicatorDefinition } from "../indicators/indicatorTypes.js";

export const CHART_WORKSPACE_SCHEMA_VERSION = 6 as const;
export const CHART_WORKSPACE_RECORD_SCHEMA_VERSION = 1 as const;
export const LEGACY_CHART_WORKSPACE_SCHEMA_VERSION = 5 as const;
export type ChartCellId = string;
export type ChartWindowId = string;
export const CHART_CELL_IDS = ["cell-1", "cell-2", "cell-3", "cell-4"] as const satisfies readonly ChartCellId[];
export const MAIN_CHART_WINDOW_ID = "main-window" as const satisfies ChartWindowId;
export const CHART_LINK_GROUP_IDS = ["A", "B", "C", "D"] as const;
export const CHART_LINK_ROLES = ["bidirectional", "source", "destination"] as const;
export const CHART_DRAWING_LAYER_SET_IDS = ["1", "2", "3", "4"] as const;

export type ChartLinkGroupId = (typeof CHART_LINK_GROUP_IDS)[number];
export type ChartLinkRole = (typeof CHART_LINK_ROLES)[number];
export type ChartDrawingLayerSetId = (typeof CHART_DRAWING_LAYER_SET_IDS)[number];

export type ChartWorkspaceTemplateId =
  | "single"
  | "split-vertical"
  | "split-horizontal"
  | "main-confirmation"
  | "quad"
  | "grid-6"
  | "grid-8"
  | "grid-9"
  | "grid-12"
  | "grid-16";

export type ChartWorkspaceId = string;
export type ChartWorkspaceLayout = ChartWorkspaceTemplateId | "custom";
export type ChartWorkspaceSplitDirection = "columns" | "rows";
export type ChartWorkspaceCellRole = "main" | "confirmation";
export type ChartCellCreationMode = "copy" | "blank";

export interface ChartWorkspaceCellLayoutNode {
  kind: "cell";
  cellId: ChartCellId;
  role?: ChartWorkspaceCellRole;
}

export interface ChartWorkspaceSplitLayoutNode {
  kind: "split";
  id: string;
  direction: ChartWorkspaceSplitDirection;
  ratio: number;
  first: ChartWorkspaceLayoutNode;
  second: ChartWorkspaceLayoutNode;
}

export type ChartWorkspaceLayoutNode =
  | ChartWorkspaceCellLayoutNode
  | ChartWorkspaceSplitLayoutNode;

export const CELL_CHART_SETTING_KEYS = [
  "chartType",
  "renkoBoxSizeMode",
  "renkoAtrLength",
  "renkoBoxSize",
  "pointFigureBoxSizeMode",
  "pointFigureAtrLength",
  "pointFigureBoxSize",
  "pointFigureReversalAmount",
  "kagiReversalMode",
  "kagiAtrLength",
  "kagiReversalAmount",
  "lineBreakNumberOfLines",
] as const satisfies readonly (keyof ChartSettings)[];

export type CellChartSettingKey = (typeof CELL_CHART_SETTING_KEYS)[number];
export type ChartCellChartSettings = Pick<ChartSettings, CellChartSettingKey>;

export interface ChartCellPriceScale {
  invertScale: boolean;
  priceScaleMode: number;
}

export interface ChartLinkGroupSettings {
  market: boolean;
  interval: boolean;
  crosshair: boolean;
  timeAnchor: boolean;
  dateRange: boolean;
  drawings: boolean;
}

export interface ChartWorkspaceLayoutRatios {
  splitVertical: number;
  splitHorizontal: number;
  quadColumns: number;
  quadRows: number;
}

export interface ChartCellState {
  id: ChartCellId;
  linkGroup: ChartLinkGroupId | null;
  linkRole: ChartLinkRole;
  drawingLayerSet: ChartDrawingLayerSetId;
  session: ChartSession;
  chartSettings: ChartCellChartSettings;
  priceScale: ChartCellPriceScale;
  indicators: IndicatorDefinition[];
}

export interface ChartWindowBoundsDip {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ChartWindowDisplayState = "normal" | "maximized" | "minimized";

export interface ChartWindowState {
  id: ChartWindowId;
  layoutTree: ChartWorkspaceLayoutNode;
  layoutLocked: boolean;
  activeCellId: ChartCellId;
  maximizedCellId: ChartCellId | null;
  boundsDip: ChartWindowBoundsDip | null;
  monitorFingerprint: string | null;
  dpiScale: number | null;
  windowState: ChartWindowDisplayState;
}

export interface ChartWorkspaceDocument {
  schemaVersion: typeof CHART_WORKSPACE_SCHEMA_VERSION;
  revision: number;
  activeWindowId: ChartWindowId;
  windows: Record<ChartWindowId, ChartWindowState>;
  linkGroups: Record<ChartLinkGroupId, ChartLinkGroupSettings>;
  cells: Record<ChartCellId, ChartCellState>;
}

export interface ChartWorkspaceRecord {
  schemaVersion: typeof CHART_WORKSPACE_RECORD_SCHEMA_VERSION;
  id: ChartWorkspaceId;
  name: string;
  createdAt: number;
  updatedAt: number;
  document: ChartWorkspaceDocument;
}

export interface ChartWorkspaceSummary {
  id: ChartWorkspaceId;
  name: string;
  createdAt: number;
  updatedAt: number;
  layout: ChartWorkspaceLayout;
}

export interface ChartWorkspaceLibrarySnapshot {
  activeWorkspaceId: ChartWorkspaceId;
  workspaces: ChartWorkspaceRecord[];
}

export const DEFAULT_CHART_LINK_GROUP_SETTINGS: ChartLinkGroupSettings = Object.freeze({
  market: true,
  interval: false,
  crosshair: true,
  timeAnchor: false,
  dateRange: true,
  drawings: false,
});

export const DEFAULT_CHART_WORKSPACE_LAYOUT_RATIOS: ChartWorkspaceLayoutRatios = Object.freeze({
  splitVertical: 0.5,
  splitHorizontal: 0.5,
  quadColumns: 0.5,
  quadRows: 0.5,
});

export const CHART_WORKSPACE_LAYOUTS: readonly ChartWorkspaceLayout[] = [
  "single",
  "split-vertical",
  "split-horizontal",
  "main-confirmation",
  "quad",
  "grid-6",
  "grid-8",
  "grid-9",
  "grid-12",
  "grid-16",
  "custom",
];

export const CHART_WORKSPACE_TEMPLATE_IDS: readonly ChartWorkspaceTemplateId[] = [
  "single",
  "split-vertical",
  "split-horizontal",
  "main-confirmation",
  "quad",
  "grid-6",
  "grid-8",
  "grid-9",
  "grid-12",
  "grid-16",
];
