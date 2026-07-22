import type { ExternalMarkerSource } from "../../chart-adapter/externalMarkerSource.js";

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export type PluginPlacement = "commandPalette" | "topToolbar" | "chartContextMenu";
export type PluginViewSlot = "sidePanel" | "bottomPanel" | "statusArea";
export type PluginDeclarativeViewRenderer = "table" | "list" | "detail" | "status";
export type PluginViewRenderer = PluginDeclarativeViewRenderer | "sandbox";
export type PluginSandboxViewSlot = "sidePanel" | "bottomPanel";
export type PluginFieldFormat = "text" | "number" | "percent" | "price" | "boolean" | "timestamp";

export interface PluginJsonSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  title?: string;
  description?: string;
  default?: JsonValue;
  enum?: JsonValue[];
  properties?: Record<string, PluginJsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: PluginJsonSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

interface ContributionBase {
  pluginId: string;
  id: string;
  localId: string;
  title: string;
  entrypointId: string;
  available: boolean;
  unavailableReason?: string;
}

export interface PluginCommandContribution extends ContributionBase {
  kind: "command/1";
  configuration: {
    requiresUserAction?: boolean;
    inputSchema?: PluginJsonSchema;
    fileInputs?: PluginCommandFileInput[];
    placements: PluginPlacement[];
  };
}

export interface PluginCommandFileInput {
  field: string;
  mode: "open" | "save";
  accept: string[];
  maxBytes: number;
  suggestedName?: string;
}

export interface PluginFileSelection {
  handle: string;
  name: string;
  mediaType: string;
  maxBytes: number;
  expiresInSeconds: number;
}

export interface PluginSettingsContribution extends ContributionBase {
  kind: "settings/1";
  configuration: {
    schema: PluginJsonSchema;
    defaults: Record<string, JsonValue>;
  };
}

export interface PluginViewField {
  field: string;
  label: string;
  format: PluginFieldFormat;
}

export interface PluginDeclarativeViewContribution extends ContributionBase {
  kind: "view/1";
  configuration: {
    slot: PluginViewSlot;
    renderer: PluginDeclarativeViewRenderer;
    source: { kind: "storage.document"; name: string; path: string[] };
    fields: PluginViewField[];
    maxItems: number;
    emptyState: string;
    primaryCommand?: string;
  };
}

export interface PluginSandboxViewContribution extends ContributionBase {
  kind: "view/1";
  configuration: {
    slot: PluginSandboxViewSlot;
    renderer: "sandbox";
    surface: string;
    asset: {
      bundleDigest: string;
      entry: string;
      protocol: "candlescope.ui-bridge/1";
      sandbox: "allow-scripts";
      cspProfile: "opaque-origin-v1";
    };
  };
}

export type PluginViewContribution =
  | PluginDeclarativeViewContribution
  | PluginSandboxViewContribution;

export type PluginUiContribution =
  | PluginCommandContribution
  | PluginSettingsContribution
  | PluginViewContribution;

export interface PluginCatalogPlugin {
  id: string;
  name: string;
  version: string;
  publisher: string;
  state: "active" | "disabled" | "staged";
  enabled: boolean;
  trustLevel: "first-party-pinned" | "local-trusted" | "untrusted";
  available: boolean;
  unavailableReason?: string;
  permissions: {
    activationReady: boolean;
    requiredSatisfied: boolean;
    requiredPermissionIds: string[];
    permissions: Array<{
      permissionId: string;
      kind: "required" | "optional";
      decision: "pending" | "granted" | "denied" | "revoked";
      hasGrantedScope: boolean;
    }>;
  };
  contributions: PluginUiContribution[];
  runtime: {
    entrypoints: Array<{ entrypointId: string; state: string; generation: number }>;
  };
}

export interface PluginCatalog {
  schemaVersion: "candlescope.plugin-catalog/1";
  platform: {
    enabled: boolean;
    started: boolean;
    status: "disabled" | "ok" | "degraded";
    registryRevision: number;
  };
  plugins: PluginCatalogPlugin[];
}

export interface PluginViewProjection {
  id: string;
  pluginId: string;
  title: string;
  slot: PluginViewSlot;
  renderer: PluginDeclarativeViewRenderer;
  state: "empty" | "ready" | "error";
  sourceRevision?: number;
  errorCode?: "PLUGIN_VIEW_DATA_INVALID";
  data: { rows: Record<string, JsonScalar>[] } | { values: Record<string, JsonScalar> };
}

export interface PluginChartLayer {
  id: string;
  pluginId: string;
  generation: number;
  revision: number;
  context: { mode: "live"; exchange: string; marketType: string };
  series: { symbol: string; interval: string };
  render: {
    schemaVersion: "candlescope.render/1";
    items: Array<{
      id: string;
      type: "marker";
      time: number;
      position: "aboveBar" | "belowBar" | "inBar";
      shape: "circle" | "square" | "arrowUp" | "arrowDown";
      color: string;
      text: string;
      price?: number;
    }>;
  };
}

export interface PluginUiSnapshot {
  schemaVersion: "candlescope.plugin-ui/1";
  registryRevision: number;
  views: PluginViewProjection[];
  chartLayers: PluginChartLayer[];
}

export interface PluginRegistries {
  commandPalette: PluginCommandContribution[];
  topToolbar: PluginCommandContribution[];
  chartContextMenu: PluginCommandContribution[];
  settings: PluginSettingsContribution[];
  sidePanel: PluginViewContribution[];
  bottomPanel: PluginViewContribution[];
  statusArea: PluginViewContribution[];
}

export interface PluginManagementDetail {
  schemaVersion: "candlescope.plugin-management-detail/1";
  plugin: PluginCatalogPlugin;
  permissions: Array<{
    pluginId: string;
    activationReady: boolean;
    requiredSatisfied: boolean;
    permissions: Array<{
      permissionId: string;
      kind: "required" | "optional";
      decision: "pending" | "granted" | "denied" | "revoked";
      requestedScope: Record<string, JsonValue>;
      grantedScope: Record<string, JsonValue> | null;
    }>;
  }>;
  health: {
    available: boolean;
    unavailableReason?: string | null;
    entrypoints: Array<{ entrypointId: string; state: string; generation: number }>;
  };
  update: { policy: "local-artifact-only"; automatic: false; available: false };
  rollback: {
    available: boolean;
    reason?: string;
    target?: { state: string; version: string | null };
  };
  dataRetention: {
    retainedOnDisable: true;
    retainedOnUninstall: true;
    automaticDeletion: false;
    storage: Record<string, JsonValue>;
  };
}

export interface PluginPlatformRuntime {
  view: {
    catalog: PluginCatalog | null;
    snapshot: PluginUiSnapshot | null;
    registries: PluginRegistries;
    loading: boolean;
    error: string | null;
    managementAvailable: boolean;
    managerOpen: boolean;
    paletteOpen: boolean;
    openViewId: string | null;
    openSettingsId: string | null;
    notice: string | null;
    markerSource: ExternalMarkerSource;
    marketIdentity: PluginMarketIdentity;
  };
  actions: {
    refresh(): Promise<void>;
    openManager(): void;
    closeManager(): void;
    openPalette(): void;
    closePalette(): void;
    openView(id: string): void;
    closeView(): void;
    openSettings(id: string): void;
    closeSettings(): void;
    clearNotice(): void;
    invokeCommand(id: string, input?: Record<string, JsonValue>): Promise<JsonValue>;
    readSettings(id: string): Promise<Record<string, JsonValue>>;
    writeSettings(id: string, value: Record<string, JsonValue>): Promise<Record<string, JsonValue>>;
    loadDetail(pluginId: string): Promise<PluginManagementDetail>;
    installBundle(file: File): Promise<void>;
    stageUserFile(id: string, field: string, file: File): Promise<PluginFileSelection>;
    prepareUserFileSave(id: string, field: string): Promise<PluginFileSelection>;
    downloadUserFile(pluginId: string, downloadId: string): Promise<Blob>;
    changeState(pluginId: string, action: "enable" | "disable" | "rollback" | "uninstall"): Promise<void>;
    decidePermission(
      pluginId: string,
      permissionId: string,
      decision: "grant" | "deny" | "revoke",
      scope?: Record<string, JsonValue>,
    ): Promise<void>;
  };
}

export interface PluginMarketIdentity {
  exchange: string;
  marketType: string;
  symbol: string;
  interval: string;
}
