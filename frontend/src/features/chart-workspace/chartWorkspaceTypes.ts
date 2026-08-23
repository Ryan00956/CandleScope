import type { ChartSession } from "../chart-session/chartSessionTypes.js";
import type { ChartSettings } from "../settings/chartAppearanceSettings.js";
import type { IndicatorDefinition } from "../indicators/indicatorTypes.js";

export const CHART_WORKSPACE_SCHEMA_VERSION = 8 as const;
export const CHART_WORKSPACE_RECORD_SCHEMA_VERSION = 1 as const;
export type ChartCellId = string;
export type ChartWindowId = string;
export const CHART_CELL_IDS = ["cell-1", "cell-2", "cell-3", "cell-4"] as const satisfies readonly ChartCellId[];
export const MAIN_CHART_WINDOW_ID = "main-window" as const satisfies ChartWindowId;
export const DEFAULT_CHART_LINK_GROUP_ID = "group-primary" as const;
export const CHART_LINK_GROUP_COLORS = [
  "#4f7cff",
  "#8b5cf6",
  "#0f9f8f",
  "#d97706",
  "#dc5a6b",
  "#64748b",
] as const;
export const MAX_CHART_LINK_GROUP_DEPTH = 4 as const;
export const CHART_DRAWING_LAYER_SET_IDS = ["1", "2", "3", "4"] as const;

export type ChartLinkGroupId = string;
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

export type ChartWorkspaceBuiltinName =
  | { kind: "default" }
  | { kind: "template"; templateId: ChartWorkspaceTemplateId; ordinal: number };

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

export interface ChartStrategyAttachmentRecord {
  schemaVersion: 1;
  strategyDraftId: string | null;
  strategyRevisionId: string | null;
  displayName: string;
  language: "pyne" | "pine";
  parameters: Record<string, unknown>;
  rangeMode: "ALL_AVAILABLE" | "VISIBLE" | "CUSTOM";
  customRange: { startMs: number; endMs: number } | null;
  fidelityPreference: "FAST" | "PRECISE";
  quickPresetId: string;
  autoRun: boolean;
}

export interface ChartLinkIndicatorSettings {
  definitions: boolean;
  parameters: boolean;
  visual: boolean;
  paneLayout: boolean;
}

export interface ChartLinkGroupSettings {
  market: boolean;
  interval: boolean;
  crosshair: boolean;
  timeAnchor: boolean;
  dateRange: boolean;
  drawings: boolean;
  indicators: ChartLinkIndicatorSettings;
}

export interface ChartLinkGroup {
  id: ChartLinkGroupId;
  name: string;
  color: string;
  parentId: ChartLinkGroupId | null;
  peerPolicy: ChartLinkGroupSettings;
  receiveFromParent: ChartLinkGroupSettings;
}

export interface ChartWorkspaceLayoutRatios {
  splitVertical: number;
  splitHorizontal: number;
  quadColumns: number;
  quadRows: number;
}

export interface ChartCellState {
  id: ChartCellId;
  linkGroupId: ChartLinkGroupId | null;
  drawingLayerSet: ChartDrawingLayerSetId;
  session: ChartSession;
  chartSettings: ChartCellChartSettings;
  priceScale: ChartCellPriceScale;
  indicators: IndicatorDefinition[];
  strategyAttachment: ChartStrategyAttachmentRecord | null;
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
  linkGroups: Record<ChartLinkGroupId, ChartLinkGroup>;
  cells: Record<ChartCellId, ChartCellState>;
}

export interface ChartWorkspaceRecord {
  schemaVersion: typeof CHART_WORKSPACE_RECORD_SCHEMA_VERSION;
  id: ChartWorkspaceId;
  name: string;
  builtinName?: ChartWorkspaceBuiltinName;
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
  indicators: Object.freeze({
    definitions: true,
    parameters: true,
    visual: false,
    paneLayout: false,
  }),
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
