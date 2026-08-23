import type { ExternalMarkerSource } from "../../chart-adapter/externalMarkerSource.js";
import type { PluginChartLayerSource } from "./pluginChartLayerSource.js";

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export interface PluginSchemaLocalization {
  title?: string;
  description?: string;
  enumLabels?: string[];
  properties?: Record<string, PluginSchemaLocalization>;
  items?: PluginSchemaLocalization;
}

export interface PluginContributionLocalization {
  title?: string;
  schema?: PluginSchemaLocalization;
  fields?: Record<string, string>;
  emptyState?: string;
  displayName?: string;
  marketTypes?: Record<string, string>;
  accounts?: Record<string, string>;
}

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
  enumLabels?: string[];
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
  localizations?: Record<string, PluginContributionLocalization>;
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

export type PluginRuntimeSupply =
  | {
      source: "host-managed";
      runtimeId: string;
      runtimeKind: "java" | "node" | "wasm";
      version: string;
      executable: string;
      artifactSha256: string;
      artifactSize: number;
      probeSha256: string;
      verificationStatus: "verified";
      reproducible: true;
      licenseSpdx: string;
      registryId: string;
      registryRevision: number;
      registrySha256: string;
      sourceUrl: string;
    }
  | {
      source: "system";
      runtimeId: string;
      runtimeKind: "java" | "node" | "wasm";
      version: string;
      executable: string;
      artifactSha256: string;
      artifactSize: number;
      probeSha256: string;
      verificationStatus: "probed";
      reproducible: false;
      licenseSpdx: "NOASSERTION";
    };

export interface PluginRuntimeRegistryStatus {
  schemaVersion: "candlescope.runtime-registry-status/1";
  enabled: true;
  networkUpdatesEnabled: boolean;
  automaticUpdates: false;
  active: {
    registryId: string;
    revision: number;
    registrySha256: string;
    issuedAt: string;
    rollbackAvailable: boolean;
    revokedArtifactCount: number;
  };
  runtimes: Array<{
    runtimeId: string;
    kind: "java" | "node" | "wasm";
    version: string;
    os: string;
    arch: string;
    sourceUrl: string;
    sha256: string;
    size: number;
    license: string;
    upstreamReleaseUrl: string;
    source: "host-managed";
    registryId: string;
    registryRevision: number;
    registrySha256: string;
    verificationStatus: "verified" | "missing" | "corrupt" | "revoked";
    cached: boolean;
    probeSha256: string | null;
    referenceCount: number;
    reproducible: true;
  }>;
  systemRuntimes: Array<{
    runtimeId: string;
    kind: "java" | "node" | "wasm";
    version: string;
    source: "system";
    executable: string;
    artifactSha256: string;
    artifactSize: number;
    probeSha256: string;
    verificationStatus: "probed";
    reproducible: false;
    license: "NOASSERTION";
  }>;
}

export type PluginCanonicalTrustMode =
  | "first-party-pinned"
  | "marketplace-sandboxed"
  | "trusted-local"
  | "developer-local"
  | "ui-only-untrusted";

export interface PluginRestrictedRuntimeProfile {
  profileId: string;
  runtimeKind: string;
  sandboxMode: "windows-appcontainer" | "unavailable";
  sandboxSupported: boolean;
  trustedLocalOnly: boolean;
  networkDefault: "denied";
  subprocessDeclared: false;
  limits: {
    memoryBytes?: number;
    cpuRatePercent?: number;
    probeCpuTimeSeconds?: number;
    runtimeCpuTimeSeconds?: number;
    diskBytes?: number;
    maxProcesses: number;
    probeWallSeconds?: number;
    runtimeWallSeconds?: number;
  };
}

export interface PluginTrustRuntimeEntrypoint {
  entrypointId: string;
  runtimeKind: string;
  runtimeId: string;
  descriptor: Record<string, JsonValue>;
  pluginArtifactSha256: string | null;
  runtimeArtifactSha256: string | null;
  runtimeArtifactSize: number | null;
  supplySource: "host-python" | "host-managed" | "plugin-bundled" | "system";
  hostManaged: boolean;
  registrySha256: string | null;
  systemRuntimePath: string | null;
  signatureRoot: string | null;
  profile: PluginRestrictedRuntimeProfile;
}

export interface PluginTrustAuthorization {
  runtimeIdentity: string;
  authorizationIdentity: string;
  mode: PluginCanonicalTrustMode;
  entrypoints: PluginTrustRuntimeEntrypoint[];
  signatureRoots: string[];
  sandbox: {
    requested: boolean;
    active: boolean;
    status: "windows-appcontainer" | "trusted-local-user-approved" | "unavailable-trusted-local-only";
    supported: boolean;
    trustedLocalOnly: boolean;
    profiles: PluginRestrictedRuntimeProfile[];
  };
}

export interface PluginTrustRequests {
  permissions: Array<{
    permissionId: string;
    kind: "required" | "optional";
    scope: Record<string, JsonValue>;
  }>;
  network: { requested: boolean; permissionIds: string[] };
  files: { requested: boolean; permissionIds: string[] };
  secrets: { requested: boolean; permissionIds: string[] };
  accounts: { requested: boolean; permissionIds: string[] };
  trading: { requested: boolean; permissionIds: string[] };
  subprocess: {
    requested: false;
    declared: false;
    maxProcesses: 1;
    reason: string;
  };
  liveAuthority: {
    grantedByTrust: false;
    independentlyProtected: true;
  };
}

export interface PluginTrustSource {
  rawTrustLevel: string;
  canonicalDefault: PluginCanonicalTrustMode;
  publisherIdentity: string;
  source: string;
  marketplaceId: string | null;
  signatureRoot: string | null;
}

export interface PluginTrustSummary {
  schemaVersion: "candlescope.plugin-trust-summary/1";
  uxEnabled: boolean;
  mode: PluginCanonicalTrustMode;
  defaultMode: PluginCanonicalTrustMode;
  decisionRecorded: boolean;
  source: PluginTrustSource;
  authorization: PluginTrustAuthorization;
  requests: PluginTrustRequests;
  profiles: PluginRestrictedRuntimeProfile[];
  changeAllowed: boolean;
  highRiskAuthorityIndependent: true;
}

export interface PluginTrustUxStatus {
  schemaVersion: "candlescope.plugin-trust-ux/1";
  enabled: true;
  localInstallFlow: "itemized-double-confirmation";
  actor: "local-desktop-user";
  profiles: PluginRestrictedRuntimeProfile[];
  highRiskAuthorityIndependent: true;
}

export interface PluginCatalogPlugin {
  id: string;
  name: string;
  version: string;
  publisher: string;
  state: "active" | "disabled" | "staged";
  enabled: boolean;
  trustLevel:
    | "first-party-pinned"
    | "verified-publisher"
    | "local-developer"
    | "local-trusted"
    | "untrusted";
  available: boolean;
  unavailableReason?: string;
  trust?: PluginTrustSummary;
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
    entrypoints: Array<{
      entrypointId: string;
      state: string;
      generation: number;
      runtimeKind?: string;
      runtimeId?: string;
      artifactSha256?: string | null;
      runtimeSupply?: PluginRuntimeSupply;
    }>;
  };
}

export type PluginV1CompatibilityImportStatus =
  | "not-imported"
  | "current"
  | "stale"
  | "invalid";

export interface PluginV1CompatibilityContribution {
  id: string;
  kind: "script-runtime/1";
  runtimeId: string;
  title: string;
  version: string;
  package: string;
  available: boolean;
  protocol: "candlescope.script-runtime/1";
  renderProtocol: "candlescope.render/1";
  languages: Array<{
    id: string;
    name: string;
    extensions: string[];
    aliases: string[];
    routeMode: "legacy" | "shadow" | "sidecar";
    available: boolean;
  }>;
  features: string[];
  routeModes: Array<"legacy" | "shadow" | "sidecar">;
  release: {
    managed: boolean;
    bundleSha256?: string;
  };
  imported: boolean;
}

export interface PluginV1CompatibilityCatalog {
  schemaVersion: "candlescope.v1-script-runtime-compatibility/1";
  status: "ready" | "unavailable" | "invalid";
  kind: "script-runtime/1";
  protocol: "candlescope.script-runtime/1";
  renderProtocol: "candlescope.render/1";
  import: {
    status: PluginV1CompatibilityImportStatus;
    stateRevision: number;
    activeSnapshotRevision: number | null;
    sourceSha256: string | null;
    importedSourceSha256: string | null;
    historyDepth: number;
    rollbackAvailable: boolean;
  };
  contributions: PluginV1CompatibilityContribution[];
}

export interface PluginV1CompatibilityPreview {
  schemaVersion: "candlescope.v1-compatibility-preview/1";
  action: "import" | "rollback";
  available: boolean;
  stateRevision: number;
  sourceSha256: string;
  targetSnapshotRevision: number | null;
  changes: Array<{
    id: string;
    action: "add" | "update" | "remove";
  }>;
  previewSha256: string | null;
}

export interface PluginCatalog {
  schemaVersion: "candlescope.plugin-catalog/2";
  platform: {
    enabled: boolean;
    started: boolean;
    status: "disabled" | "ok" | "degraded";
    registryRevision: number;
  };
  plugins: PluginCatalogPlugin[];
  compatibility: PluginV1CompatibilityCatalog;
  runtimeRegistry?: PluginRuntimeRegistryStatus;
  trustUx?: PluginTrustUxStatus;
}

export interface PluginMarketplaceArtifact {
  fileName: string;
  url: string;
  sha256: string;
  size: number;
  manifestSha256: string;
  sbomSha256: string;
}

export interface PluginMarketplaceRuntimeBinding {
  entrypointId: string;
  runtimeKind: "python-module" | "native-executable" | "java-jar" | "node-module" | "wasm-component";
  runtimeId: string;
  pluginArtifactPath: string;
  pluginArtifactSha256: string;
  supplySource: "host-python" | "plugin-bundled" | "host-managed";
  hostRuntime: null | {
    registryId: string;
    registryRevision: number;
    registrySha256: string;
    runtimeArtifactSha256: string;
    licenseExpression: string;
  };
}

export interface PluginMarketplaceSignedArtifact extends PluginMarketplaceArtifact {
  artifactId: string;
  os: "windows" | "linux" | "macos";
  arch: "x86_64" | "arm64";
  licenseInventorySha256: string;
  runtimeBindings: PluginMarketplaceRuntimeBinding[];
  provenance: {
    sourceRepository: string;
    sourceCommit: string;
    buildReceiptUrl: string;
    buildReceiptSha256: string;
    rebuildInstructionsUrl: string;
    rebuildInstructionsSha256: string;
    reproducibleBuilds: true;
  };
  reviewPolicy: {
    distribution: "prebuilt-only";
    sourceBuild: false;
    systemRuntimeFallback: false;
    undeclaredDownloads: false;
  };
  signature: {
    algorithm: "ed25519";
    keyId: string;
    value: string;
  };
}

export interface PluginMarketplacePermissionScope {
  id: string;
  scope: Record<string, JsonValue>;
}

export interface PluginMarketplaceRelease {
  pluginId: string;
  version: string;
  publisherId: string;
  /** Host-selected compatibility projection; v2 also retains all signed artifacts. */
  artifact: PluginMarketplaceArtifact;
  artifacts?: PluginMarketplaceSignedArtifact[];
  runtimeKinds?: PluginMarketplaceRuntimeBinding["runtimeKind"][];
  publishedAt: string;
  licenseExpression: string;
  dependencies: Array<{
    name: string;
    version: string;
    licenseExpression: string;
  }>;
  sha256Sums: string;
  sha256SumsSha256: string;
  minimumHostVersion?: string;
  rolloutStage?: "internal" | "opted-in-local" | "preview" | "stable";
  officialMaintained?: boolean;
  permissions?: {
    required: PluginMarketplacePermissionScope[];
    optional: PluginMarketplacePermissionScope[];
  };
  publisherKeyId: string;
  transparency: {
    logIndex: number;
    leafSha256: string;
    recordSha256: string;
  };
  revoked: boolean;
}

export interface PluginMarketplacePermissionDiff {
  pluginId: string;
  publisherIdentityChanged: boolean;
  majorVersionChanged: boolean;
  bundleChanged: boolean;
  authorizationIdentityChanged?: boolean;
  requiresConfirmation: boolean;
  permissions: Array<{
    permissionId: string;
    kind: "required" | "optional" | null;
    previousKind: "required" | "optional" | null;
    change:
      | "added"
      | "removed"
      | "identity-changed"
      | "kind-changed"
      | "unchanged"
      | "narrowed"
      | "expanded"
      | "changed";
    previousDecision: "pending" | "granted" | "denied" | "revoked" | null;
    requestedScope: Record<string, JsonValue> | null;
    previousScope: Record<string, JsonValue> | null;
    requiresConfirmation: boolean;
  }>;
}

export interface PluginMarketplaceCandidate {
  pluginId: string;
  version: string;
  marketplaceId: string;
  publisherId: string;
  bundleSha256: string;
  artifactFile: string;
  phase:
    | "verified-staged"
    | "activation-staged"
    | "observing"
    | "active"
    | "rolled-back"
    | "failed"
    | "quarantined";
  preparedAt: string;
  fromVersion: string | null;
  permissionDiff: PluginMarketplacePermissionDiff;
  compatibility: {
    hostVersion: string;
    verified: true;
    marketplaceSchema?: "candlescope.marketplace-index/1" | "candlescope.marketplace-index/2";
    platform?: { os: string; arch: string; artifactId: string };
    runtimeKinds?: PluginMarketplaceRuntimeBinding["runtimeKind"][];
    runtimeRegistry?: Array<Record<string, JsonValue>>;
    sandboxAvailable?: boolean;
    cacheReuse?: boolean;
    rolloutStage?: "internal" | "opted-in-local" | "preview" | "stable";
  };
  migration: {
    required: false;
    supported: true;
    policy: "same-major-only";
  };
  observation: {
    status: "not-started" | "observing" | "passed" | "failed" | "rolled-back";
    observedAt: string | null;
    detail: string | null;
  };
}

export interface PluginMarketplaceUpdate {
  policy: "signed-marketplace-or-local-artifact";
  automatic: false;
  available: boolean;
  ownership: "signed-marketplace" | "local-or-first-party";
  reason: string | null;
  candidate: PluginMarketplaceCandidate | null;
  latest: PluginMarketplaceRelease | null;
}

export interface PluginMarketplaceAssurances {
  publisherVerified: boolean;
  officialMaintained: boolean;
  sandbox: {
    available: boolean;
    runtimeKinds: PluginMarketplaceRuntimeBinding["runtimeKind"][];
    profiles: PluginRestrictedRuntimeProfile[];
  };
  permissions: {
    required: PluginMarketplacePermissionScope[];
    optional: PluginMarketplacePermissionScope[];
  };
  rolloutStage: "internal" | "opted-in-local" | "preview" | "stable";
  minimumHostVersion: string | null;
  platform: {
    os: string;
    arch: string;
    available: boolean;
    artifactId: string | null;
  };
}

export interface PluginMarketplaceCatalog {
  schemaVersion: "candlescope.marketplace-catalog/1" | "candlescope.marketplace-catalog/2";
  enabled: boolean;
  rollout?: {
    channel: "internal" | "opted-in-local" | "preview" | "stable";
    stages: readonly ["internal", "opted-in-local", "preview", "stable"];
  };
  marketplaces: Array<{
    marketplaceId: string;
    indexUrl: string;
    keyId: string;
    enabled: boolean;
    cache:
      | {
        status: "valid";
        sequence: number;
        expiresAt: string;
      }
      | {
        status: "invalid-or-empty";
        reason: string | null;
      };
  }>;
  plugins: Array<{
    pluginId: string;
    publisher: {
      publisherId: string;
      displayName: string;
      keyId: string;
      status: "active";
      verificationTier?: "verified" | "official";
    };
    latest: PluginMarketplaceRelease;
    assurances?: PluginMarketplaceAssurances;
    releaseCount: number;
    installedVersion: string | null;
    installable: boolean;
  }>;
}

export interface PluginMarketplaceStatus {
  schemaVersion: "candlescope.marketplace-status/1" | "candlescope.marketplace-status/2";
  enabled: boolean;
  automaticUpdates: false;
  rootCount: number;
  validCacheCount: number;
  cacheErrors: Record<string, string>;
  candidates: PluginMarketplaceCandidate[];
  updates: Array<PluginMarketplaceUpdate & { pluginId: string }>;
  rollout?: PluginMarketplaceCatalog["rollout"];
  telemetry?: {
    enabled: boolean;
    uploadEnabled: false;
    storage: "local-aggregate-only";
    privacy: {
      identifiers: false;
      strategyInputs: false;
      accounts: false;
      pluginPrivateData: false;
    };
    counters: Array<{
      runtimeKind: PluginMarketplaceRuntimeBinding["runtimeKind"] | "mixed" | "none";
      operation: "refresh" | "cache-reuse" | "prepare" | "apply" | "activate" | "observation" | "rollback" | "revocation-quarantine";
      outcome: "success" | "failure" | "quarantined";
      count: number;
    }>;
  };
  quarantine?: Array<{
    schemaVersion: "candlescope.marketplace-quarantine/1";
    pluginId: string;
    version: string;
    bundleSha256: string;
    reason: string;
    quarantinedAt: string;
    artifactFile: string | null;
    payloadMoved: boolean;
  }>;
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

interface PluginChartLayerBase {
  id: string;
  pluginId: string;
  generation: number;
  revision: number;
  context: { mode: "live"; exchange: string; marketType: string };
  series: { symbol: string; interval: string };
}

export interface PluginRuntimeDiff {
  changed: boolean;
  requiresConfirmation: boolean;
  kindOrIdChanged: boolean;
  signatureRootChanged: boolean;
  systemRuntimePathChanged: boolean;
  supplyChanged: boolean;
  previous: PluginTrustRuntimeEntrypoint[];
  current: PluginTrustRuntimeEntrypoint[];
}

export interface PluginLocalInstallPreview {
  schemaVersion: "candlescope.plugin-trust-preview/1";
  plugin: {
    id: string;
    name: string;
    version: string;
    publisher: string;
    bundleSha256: string;
    manifestSha256: string;
  };
  source: PluginTrustSource;
  authorization: PluginTrustAuthorization;
  permissionDiff: PluginMarketplacePermissionDiff;
  runtimeDiff: PluginRuntimeDiff;
  requests: PluginTrustRequests;
  requiredAcknowledgements: string[];
  warning: string;
}

export interface PluginLocalInstallCandidate {
  candidateId: string;
  previewSha256: string;
  expiresAt: string;
  preview: PluginLocalInstallPreview;
}

export interface PluginTrustReview {
  candidateId: string;
  previewSha256: string;
  confirmationToken: string;
  expiresAt: string;
  confirmationStep: 1;
}

export interface PluginTrustChangeReview {
  changeId: string;
  previewSha256: string;
  confirmationToken: string;
  expiresAt: string;
  preview: {
    schemaVersion: "candlescope.plugin-trust-preview/1";
    action: "trust-change";
    pluginId: string;
    bundleSha256: string;
    source: PluginTrustSource;
    from: PluginTrustAuthorization;
    to: PluginTrustAuthorization;
    permissionDiff: PluginMarketplacePermissionDiff;
    runtimeDiff: PluginRuntimeDiff;
    requests: PluginTrustRequests;
    requiredAcknowledgements: string[];
  };
}

export interface PluginChartLayerV1 extends PluginChartLayerBase {
  render: {
    schemaVersion: "candlescope.render/1";
    items: PluginChartMarker[];
  };
}

export interface PluginChartMarker {
  id: string;
  type: "marker";
  time: number;
  position: "aboveBar" | "belowBar" | "inBar";
  shape: "circle" | "square" | "arrowUp" | "arrowDown";
  color: string;
  text: string;
  price?: number;
}

export interface PluginChartPolyline {
  id: string;
  type: "polyline";
  points: Array<{ time: number; price: number }>;
  color: string;
  width: number;
  style: "solid" | "dashed" | "dotted";
}

export interface PluginChartPriceLine {
  id: string;
  type: "price-line";
  price: number;
  color: string;
  width: number;
  style: "solid" | "dashed" | "dotted";
  text?: string;
}

export interface PluginChartBand {
  id: string;
  type: "band";
  startTime: number;
  endTime: number;
  lowerPrice: number;
  upperPrice: number;
  fillColor: string;
  borderColor?: string;
}

export interface PluginChartLabel {
  id: string;
  type: "label";
  time: number;
  price: number;
  text: string;
  color: string;
  position: "above" | "below" | "center";
  backgroundColor?: string;
}

export type PluginChartRenderItem =
  | PluginChartMarker
  | PluginChartPolyline
  | PluginChartPriceLine
  | PluginChartBand
  | PluginChartLabel;

export interface PluginChartLayerV2 extends PluginChartLayerBase {
  chartId: "main-chart";
  chartRevision: number;
  zOrder: "above-series" | "below-series";
  render: {
    schemaVersion: "candlescope.render/2";
    items: PluginChartRenderItem[];
  };
}

export type PluginChartLayer = PluginChartLayerV1 | PluginChartLayerV2;

export interface PluginChartContextSnapshot {
  schemaVersion: "candlescope.chart-context/1";
  chartId: "main-chart";
  revision: number;
  active: boolean;
  context: { mode: "live"; exchange: string; marketType: string } | null;
  series: { symbol: string; interval: string } | null;
  updatedAtMs: number | null;
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
  trust?: PluginTrustSummary;
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
    entrypoints: Array<{
      entrypointId: string;
      state: string;
      generation: number;
      runtimeSupply?: PluginRuntimeSupply;
    }>;
  };
  update: PluginMarketplaceUpdate;
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
  liveSubmitAvailable: boolean;
  liveCancelAvailable: boolean;
  liveTransferAvailable: false;
}

export interface PluginLiveConfirmationPreview {
  schemaVersion:
    | "candlescope.live-confirmation-preview/1"
    | "candlescope.live-confirmation-preview/2";
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
  liveSubmitAvailable: boolean;
  liveCancelAvailable: boolean;
  orderIntentSha256?: string;
  action?: "submit" | "cancel";
  executionState?: "not-started" | "live" | "partially_filled";
  notional?: string;
  riskDecisionSha256?: string;
  hardLimits?: {
    instrumentId: "BTC-USDT";
    maxOrderNotional: "100";
    maxUnresolvedOrders: 2;
    maxUnresolvedNotional: "200";
  };
}

export interface PluginLiveConfirmationReceipt {
  schemaVersion:
    | "candlescope.live-confirmation/1"
    | "candlescope.live-confirmation/2";
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
  liveSubmitAvailable: boolean;
  liveCancelAvailable: boolean;
  orderIntentSha256?: string;
  action?: "submit" | "cancel";
  executionState?: "not-started" | "live" | "partially_filled";
  notional?: string;
  riskDecisionSha256?: string;
}

export type PluginLiveExecutionState =
  | "submitting"
  | "unknown"
  | "rejected"
  | "live"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "mmp_canceled"
  | "canceling"
  | "cancel_unknown";

export interface PluginLiveExecutionRecord {
  schemaVersion: "candlescope.live-execution-record/1";
  pluginId: string;
  connectorId: "candlescope.okx-demo-spot-execution";
  publisherIdentity: string;
  version: string;
  clientOrderId: string;
  orderIntentSha256: string;
  instrumentId: "BTC-USDT";
  side: "buy" | "sell";
  orderType: "limit";
  quantity: string;
  limitPrice: string;
  notional: string;
  state: PluginLiveExecutionState;
  priorState: "live" | "partially_filled" | null;
  submitAttemptCount: 1;
  cancelAttemptCount: number;
  venueOrderIdSha256: string | null;
  lastReceiptId: string;
  lastConfirmationSha256: string;
  lastRiskDecisionSha256: string;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  policyEpoch: number;
  controlGeneration: number;
  terminal: boolean;
  reconciliationRequired: boolean;
  accepted?: boolean;
  action?: "submit" | "cancel";
}

export interface PluginPlatformRuntime {
  view: {
    catalog: PluginCatalog | null;
    marketplaceCatalog: PluginMarketplaceCatalog | null;
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
    chartLayerSource: PluginChartLayerSource;
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
    loadMarketplaceStatus(): Promise<PluginMarketplaceStatus>;
    refreshMarketplace(marketplaceId: string): Promise<void>;
    prepareMarketplaceRelease(pluginId: string, version: string): Promise<void>;
    applyMarketplaceRelease(pluginId: string): Promise<void>;
    activateMarketplaceRelease(pluginId: string): Promise<void>;
    previewV1CompatibilityImport(): Promise<PluginV1CompatibilityPreview>;
    applyV1CompatibilityImport(previewSha256: string): Promise<void>;
    previewV1CompatibilityRollback(): Promise<PluginV1CompatibilityPreview>;
    applyV1CompatibilityRollback(previewSha256: string): Promise<void>;
    installBundle(file: File): Promise<void>;
    prepareLocalInstall(file: File): Promise<PluginLocalInstallCandidate>;
    reviewLocalInstall(
      candidateId: string,
      previewSha256: string,
      reason: string,
      acknowledgements: string[],
    ): Promise<PluginTrustReview>;
    confirmLocalInstall(
      candidateId: string,
      previewSha256: string,
      confirmationToken: string,
    ): Promise<void>;
    reviewTrustChange(
      pluginId: string,
      targetMode: "marketplace-sandboxed" | "trusted-local",
      reason: string,
      acknowledgements: string[],
    ): Promise<PluginTrustChangeReview>;
    confirmTrustChange(
      pluginId: string,
      changeId: string,
      previewSha256: string,
      confirmationToken: string,
    ): Promise<void>;
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
    submitLiveExecution(
      accountRef: string,
      shadowRef: string,
      receipt: PluginLiveConfirmationReceipt,
    ): Promise<PluginLiveExecutionRecord>;
    cancelLiveExecution(
      accountRef: string,
      shadowRef: string,
      receipt: PluginLiveConfirmationReceipt,
    ): Promise<PluginLiveExecutionRecord>;
    reconcileLiveExecution(
      accountRef: string,
      shadowRef: string,
    ): Promise<PluginLiveExecutionRecord>;
    downloadLiveAudit(): Promise<void>;
  };
}

export interface PluginMarketIdentity {
  exchange: string;
  marketType: string;
  symbol: string;
  interval: string;
}
