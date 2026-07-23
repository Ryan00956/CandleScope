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

export interface PluginSymbolProviderContribution extends ContributionBase {
  kind: "symbol-provider/1";
  configuration: {
    exchange: string;
    displayName: string;
    marketTypes: Array<{
      id: string;
      productType: string;
      label: string;
      calendarId: string;
      timezone: string;
    }>;
    maxPageSize: number;
    cacheTtlSeconds: number;
  };
}

export interface PluginMarketProviderChannel {
  kind: "kline" | "full_depth";
  marketTypes: string[];
  history: boolean;
  realtime: boolean;
  intervals: string[];
  delivery: "append" | "ordered_delta";
  finality: "explicit" | "inferred";
  corrections: boolean;
  maxPageSize: number;
  maxBatch: number;
  pollIntervalMs: number;
  ratePerMinute: number;
  maxConcurrent: number;
  snapshot?: boolean;
  delta?: boolean;
  sequence?: "range";
  resync?: "snapshot_replay";
  maxDepthLevels?: number;
}

export interface PluginMarketDataProviderContribution extends ContributionBase {
  kind: "market-data-provider/1";
  configuration: {
    exchange: string;
    dataPlane: "candlescope.stream/1";
    channels: PluginMarketProviderChannel[];
    sourceQuality: {
      quality: "authoritative" | "verified" | "best-effort" | "synthetic";
      finality: "explicit" | "inferred";
      timestamp: "exchange" | "provider" | "host";
    };
  };
}

export type PluginProviderContribution =
  | PluginSymbolProviderContribution
  | PluginMarketDataProviderContribution;

export interface PluginPaperAccountContribution extends ContributionBase {
  kind: "account-provider/1";
  configuration: {
    brokerId: string;
    displayName: string;
    environment: "paper";
    accounts: Array<{
      id: string;
      label: string;
      baseCurrency: string;
      initialBalances: Array<{ asset: string; available: string }>;
    }>;
  };
}

export interface PluginPaperExecutorContribution extends ContributionBase {
  kind: "order-executor/1";
  configuration: {
    brokerId: string;
    environment: "paper";
    protocol: "candlescope.paper/1";
    orderTypes: Array<"market" | "limit">;
    symbols: Array<{
      symbol: string;
      marketType: string;
      baseAsset: string;
      quoteAsset: string;
      priceTick: string;
      quantityStep: string;
      minQuantity: string;
      maxQuantity: string;
      minNotional: string;
      maxNotional: string;
    }>;
    limits: {
      maxOrderQuantity: string;
      maxOrderNotional: string;
      maxPositionNotional: string;
      maxOpenOrders: number;
      maxOrdersPerMinute: number;
      allowShort: false;
    };
    maxQuoteAgeMs: number;
  };
}

export type PluginPaperContribution =
  | PluginPaperAccountContribution
  | PluginPaperExecutorContribution;

export type PluginCatalogContribution =
  | PluginUiContribution
  | PluginProviderContribution
  | PluginPaperContribution;

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
  contributions: PluginCatalogContribution[];
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
  paperTrading: PluginPaperStatus & { available: boolean };
  dataRetention: {
    retainedOnDisable: true;
    retainedOnUninstall: true;
    automaticDeletion: false;
    storage: Record<string, JsonValue>;
  };
}

export interface PluginPaperStatus {
  schemaVersion: "candlescope.paper-status/1";
  killSwitchEnabled: boolean;
  mode: "paper-only";
  liveTradingAvailable: false;
  secretsAvailable: false;
  brokers: Array<{
    brokerId: string;
    pluginId: string;
    displayName: string;
    accounts: string[];
    orderTypes: Array<"market" | "limit">;
    symbols: Array<{ symbol: string; marketType: string }>;
    limits: {
      maxOrderQuantity: string;
      maxOrderNotional: string;
      maxPositionNotional: string;
      maxOpenOrders: number;
      maxOrdersPerMinute: number;
      allowShort: boolean;
      maxQuoteAgeMs: number;
    };
  }>;
}

export type PluginLiveControlMode =
  | "disabled"
  | "unavailable"
  | "disarmed"
  | "armed"
  | "killed";

export interface PluginLiveControlStatus {
  schemaVersion: "candlescope.live-control-status/1";
  available: boolean;
  mode: PluginLiveControlMode;
  generation: number;
  policyEpoch: number;
  updatedAt: string | null;
  outstandingConfirmationCount: number;
  confirmationCounts: {
    consumed: number;
    expired: number;
    issued: number;
    revoked: number;
  };
  eventSequence: number;
  eventSha256: string | null;
  liveSubmitAvailable: false;
  liveCancelAvailable: false;
  liveTransferAvailable: false;
}

export interface PluginLiveConfirmationPreview {
  schemaVersion: "candlescope.live-confirmation-preview/1";
  intentSha256: string;
  pluginId: string;
  connectorId: string;
  publisherIdentity: string;
  version: string;
  clientOrderId: string;
  instrumentId: string;
  side: "buy" | "sell";
  orderType: "limit";
  quantity: string;
  limitPrice: string;
  policyEpoch: number;
  controlGeneration: number;
  liveSubmitAvailable: false;
  liveCancelAvailable: false;
}

export interface PluginLiveConfirmationReceipt {
  schemaVersion: "candlescope.live-confirmation/1";
  receiptRef: string;
  receiptId: string;
  intentSha256: string;
  pluginId: string;
  connectorId: string;
  publisherIdentity: string;
  version: string;
  clientOrderId: string;
  instrumentId: string;
  side: "buy" | "sell";
  orderType: "limit";
  quantity: string;
  limitPrice: string;
  policyEpoch: number;
  controlGeneration: number;
  state: "issued";
  issuedAt: string;
  expiresAt: string;
  resolvedAt: null;
  liveSubmitAvailable: false;
  liveCancelAvailable: false;
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
    liveControl: PluginLiveControlStatus;
    liveControlOpen: boolean;
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
    setPaperKillSwitch(enabled: boolean): Promise<void>;
    openLiveControl(): void;
    closeLiveControl(): void;
    setLiveControlMode(
      mode: "armed" | "disarmed",
      reason: string,
      acknowledgeKill: boolean,
    ): Promise<void>;
    killLiveControl(reason: string): Promise<void>;
    revokeLiveAuthority(
      scopeType: "grant" | "plugin" | "publisher" | "credential",
      subject: string,
      reason: string,
    ): Promise<void>;
    previewLiveConfirmation(
      accountRef: string,
      shadowRef: string,
    ): Promise<PluginLiveConfirmationPreview>;
    issueLiveConfirmation(
      accountRef: string,
      shadowRef: string,
      preview: PluginLiveConfirmationPreview,
      ttlSeconds?: number,
    ): Promise<PluginLiveConfirmationReceipt>;
    revokeLiveConfirmation(receiptRef: string, reason: string): Promise<void>;
    downloadLiveAudit(): Promise<void>;
  };
}

export interface PluginMarketIdentity {
  exchange: string;
  marketType: string;
  symbol: string;
  interval: string;
}
