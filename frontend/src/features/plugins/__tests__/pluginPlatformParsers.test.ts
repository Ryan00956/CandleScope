import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePluginCatalog,
  parsePluginLiveConfirmationPreview,
  parsePluginLiveConfirmationReceipt,
  parsePluginLiveControlStatus,
  parsePluginLiveExecutionRecord,
  parsePluginLocalInstallCandidate,
  parsePluginManagementDetail,
  parsePluginMarketplaceCatalog,
  parsePluginMarketplaceStatus,
  parsePluginUiSnapshot,
  parsePluginTrustChangeReview,
  parsePluginTrustReview,
  parsePluginV1CompatibilityPreview,
} from "../pluginPlatformParsers.js";
import { buildPluginRegistries } from "../pluginRegistries.js";

function plugin(id = "acme.scanner", available = true) {
  return {
    id,
    name: "Scanner",
    version: "1.0.0",
    publisher: "acme",
    state: available ? "active" : "disabled",
    enabled: available,
    trustLevel: "local-trusted",
    available,
    ...(available ? {} : { unavailableReason: "PLUGIN_NOT_ACTIVE" }),
    permissions: {
      activationReady: true,
      requiredSatisfied: true,
      requiredPermissionIds: [],
      permissions: [],
    },
    contributions: [
      {
        id: `${id}.scan`,
        localId: "scan",
        kind: "command/1",
        title: "Scan",
        entrypointId: "main",
        configuration: {
          requiresUserAction: true,
          placements: ["commandPalette", "topToolbar"],
          inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
        available,
        ...(available ? {} : { unavailableReason: "PLUGIN_NOT_ACTIVE" }),
      },
      {
        id: `${id}.results`,
        localId: "results",
        kind: "view/1",
        title: "Results",
        entrypointId: "main",
        configuration: {
          slot: "sidePanel",
          renderer: "table",
          source: { kind: "storage.document", name: "latest", path: ["rows"] },
          fields: [{ field: "symbol", label: "Symbol", format: "text" }],
          maxItems: 50,
          emptyState: "No results",
          primaryCommand: "scan",
        },
        available,
        ...(available ? {} : { unavailableReason: "PLUGIN_NOT_ACTIVE" }),
      },
    ],
    runtime: { entrypoints: available ? [{ entrypointId: "main", state: "stopped", generation: 0 }] : [] },
  };
}

function catalog<T = ReturnType<typeof plugin>>(plugins: T[] = [plugin()] as T[]) {
  return {
    schemaVersion: "candlescope.plugin-catalog/2",
    platform: { enabled: true, started: true, status: "ok", registryRevision: 1 },
    plugins,
    compatibility: {
      schemaVersion: "candlescope.v1-script-runtime-compatibility/1",
      status: "ready",
      kind: "script-runtime/1",
      protocol: "candlescope.script-runtime/1",
      renderProtocol: "candlescope.render/1",
      import: {
        status: "current",
        stateRevision: 1,
        activeSnapshotRevision: 1,
        sourceSha256: `sha256:${"9".repeat(64)}`,
        importedSourceSha256: `sha256:${"9".repeat(64)}`,
        historyDepth: 1,
        rollbackAvailable: true,
      },
      contributions: [{
        id: "compat.v1.pyne.runtime",
        kind: "script-runtime/1",
        runtimeId: "pyne.runtime",
        title: "Pyne Runtime",
        version: "1.0.0",
        package: "candlescope-plugin-pyne",
        available: true,
        protocol: "candlescope.script-runtime/1",
        renderProtocol: "candlescope.render/1",
        languages: [{
          id: "pyne",
          name: "Pyne",
          extensions: [".pyne"],
          aliases: [],
          routeMode: "sidecar",
          available: true,
        }],
        features: ["batch-execution/1", "render.line-series/1"],
        routeModes: ["sidecar"],
        release: {
          managed: true,
          bundleSha256: `sha256:${"8".repeat(64)}`,
        },
        imported: true,
      }],
    },
  };
}

function phase6Profile() {
  return {
    profileId: "restricted-python-v1",
    runtimeKind: "python-module",
    sandboxMode: "windows-appcontainer",
    sandboxSupported: true,
    trustedLocalOnly: false,
    networkDefault: "denied",
    subprocessDeclared: false,
    limits: {
      memoryBytes: 268_435_456,
      cpuRatePercent: 25,
      probeCpuTimeSeconds: 60,
      runtimeCpuTimeSeconds: 300,
      diskBytes: 67_108_864,
      maxProcesses: 1,
      probeWallSeconds: 90,
      runtimeWallSeconds: 86_400,
    },
  };
}

function phase6Entrypoint() {
  return {
    entrypointId: "main",
    runtimeKind: "python-module",
    runtimeId: "python-host",
    descriptor: {
      kind: "python-module",
      runtimeId: "python-host",
      pythonModule: "candlescope_plugin.entrypoint",
    },
    pluginArtifactSha256: null,
    runtimeArtifactSha256: `sha256:${"1".repeat(64)}`,
    runtimeArtifactSize: 102_400,
    supplySource: "host-python",
    hostManaged: true,
    registrySha256: null,
    systemRuntimePath: "C:\\Python\\python.exe",
    signatureRoot: "host-python:3.12",
    profile: phase6Profile(),
  };
}

function phase6Authorization(mode: "marketplace-sandboxed" | "trusted-local") {
  const profile = phase6Profile();
  return {
    runtimeIdentity: `sha256:${"2".repeat(64)}`,
    authorizationIdentity: `sha256:${(mode === "trusted-local" ? "3" : "4").repeat(64)}`,
    mode,
    entrypoints: [phase6Entrypoint()],
    signatureRoots: ["host-python:3.12"],
    sandbox: {
      requested: mode === "marketplace-sandboxed",
      active: mode === "marketplace-sandboxed",
      status: mode === "marketplace-sandboxed" ? "windows-appcontainer" : "trusted-local-user-approved",
      supported: true,
      trustedLocalOnly: false,
      profiles: [profile],
    },
  };
}

function phase6Requests() {
  return {
    permissions: [{
      permissionId: "network.connect",
      kind: "optional",
      scope: { origins: ["https://example.invalid"] },
    }],
    network: { requested: true, permissionIds: ["network.connect"] },
    files: { requested: false, permissionIds: [] },
    secrets: { requested: false, permissionIds: [] },
    accounts: { requested: false, permissionIds: [] },
    trading: { requested: false, permissionIds: [] },
    subprocess: {
      requested: false,
      declared: false,
      maxProcesses: 1,
      reason: "No process model is declared.",
    },
    liveAuthority: { grantedByTrust: false, independentlyProtected: true },
  };
}

function phase6Acknowledgements() {
  return [
    "execute-local-code",
    "live-authority-separate",
    "permission:network.connect",
    "runtime:main:python-module:python-host",
    "sandbox-status",
  ];
}

function phase6LocalCandidate() {
  const authorization = phase6Authorization("trusted-local");
  return {
    candidateId: `candidate-${"a".repeat(32)}`,
    previewSha256: `sha256:${"5".repeat(64)}`,
    expiresAt: "2026-08-03T12:15:00Z",
    preview: {
      schemaVersion: "candlescope.plugin-trust-preview/1",
      plugin: {
        id: "candlescope.phase6-example",
        name: "Phase 6 Example",
        version: "0.1.0",
        publisher: "candlescope",
        bundleSha256: `sha256:${"6".repeat(64)}`,
        manifestSha256: `sha256:${"7".repeat(64)}`,
      },
      source: {
        rawTrustLevel: "local-developer",
        canonicalDefault: "developer-local",
        publisherIdentity: "manifest:candlescope",
        source: "local-file",
        marketplaceId: null,
        signatureRoot: null,
      },
      authorization,
      permissionDiff: {
        pluginId: "candlescope.phase6-example",
        publisherIdentityChanged: false,
        majorVersionChanged: false,
        bundleChanged: true,
        authorizationIdentityChanged: false,
        requiresConfirmation: true,
        permissions: [{
          permissionId: "network.connect",
          kind: "optional",
          previousKind: null,
          change: "added",
          previousDecision: null,
          requestedScope: { origins: ["https://example.invalid"] },
          previousScope: null,
          requiresConfirmation: true,
        }],
      },
      runtimeDiff: {
        changed: true,
        requiresConfirmation: true,
        kindOrIdChanged: true,
        signatureRootChanged: true,
        systemRuntimePathChanged: true,
        supplyChanged: true,
        previous: [],
        current: authorization.entrypoints,
      },
      requests: phase6Requests(),
      requiredAcknowledgements: phase6Acknowledgements(),
      warning: "Local application code runs as the current user; Live authority remains separate.",
    },
  };
}

function marketplaceRelease() {
  const artifactSha256 = `sha256:${"a".repeat(64)}`;
  const fileName = "acme.scanner-1.1.0.cspkg";
  return {
    pluginId: "acme.scanner",
    version: "1.1.0",
    publisherId: "acme",
    artifact: {
      fileName,
      url: `https://plugins.example.invalid/artifacts/${fileName}`,
      sha256: artifactSha256,
      size: 1024,
      manifestSha256: `sha256:${"b".repeat(64)}`,
      sbomSha256: `sha256:${"c".repeat(64)}`,
    },
    publishedAt: "2026-07-23T02:00:00Z",
    licenseExpression: "MIT",
    dependencies: [{ name: "demo-wheel", version: "1.0.0", licenseExpression: "MIT" }],
    sha256Sums: `${"a".repeat(64)}  ${fileName}\n`,
    sha256SumsSha256: `sha256:${"d".repeat(64)}`,
    publisherKeyId: `ed25519:${"e".repeat(64)}`,
    transparency: {
      logIndex: 1,
      leafSha256: `sha256:${"f".repeat(64)}`,
      recordSha256: `sha256:${"1".repeat(64)}`,
    },
    revoked: false,
  };
}

function marketplaceReleaseV2() {
  const fileName = "candlescope.aho-corasick-0.1.0-windows-x86_64.cspkg";
  const artifactSha256 = `sha256:${"9".repeat(64)}`;
  const artifact = {
    artifactId: "windows-x86_64",
    os: "windows",
    arch: "x86_64",
    fileName,
    url: `https://plugins.example.invalid/artifacts/${fileName}`,
    sha256: artifactSha256,
    size: 4096,
    manifestSha256: `sha256:${"8".repeat(64)}`,
    sbomSha256: `sha256:${"7".repeat(64)}`,
    licenseInventorySha256: `sha256:${"6".repeat(64)}`,
    runtimeBindings: [{
      entrypointId: "main",
      runtimeKind: "native-executable",
      runtimeId: "native-host",
      pluginArtifactPath: "runtime/adapter.exe",
      pluginArtifactSha256: `sha256:${"5".repeat(64)}`,
      supplySource: "plugin-bundled",
      hostRuntime: null,
    }],
    provenance: {
      sourceRepository: "https://github.com/BurntSushi/aho-corasick",
      sourceCommit: "4".repeat(40),
      buildReceiptUrl: "https://plugins.example.invalid/provenance/receipt.json",
      buildReceiptSha256: `sha256:${"3".repeat(64)}`,
      rebuildInstructionsUrl: "https://plugins.example.invalid/provenance/rebuild.md",
      rebuildInstructionsSha256: `sha256:${"2".repeat(64)}`,
      reproducibleBuilds: true,
    },
    reviewPolicy: {
      distribution: "prebuilt-only",
      sourceBuild: false,
      systemRuntimeFallback: false,
      undeclaredDownloads: false,
    },
    signature: {
      algorithm: "ed25519",
      keyId: `ed25519:${"e".repeat(64)}`,
      value: "signed-artifact",
    },
  };
  return {
    pluginId: "candlescope.aho-corasick",
    version: "0.1.0",
    publisherId: "candlescope",
    artifacts: [artifact],
    publishedAt: "2026-08-03T00:00:00Z",
    licenseExpression: "GPL-3.0-only",
    dependencies: [{ name: "aho-corasick", version: "1.1.4", licenseExpression: "Unlicense OR MIT" }],
    minimumHostVersion: "0.4.0",
    rolloutStage: "preview",
    officialMaintained: true,
    permissions: { required: [], optional: [] },
    sha256Sums: `${"9".repeat(64)}  ${fileName}\n`,
    sha256SumsSha256: `sha256:${"1".repeat(64)}`,
    publisherKeyId: `ed25519:${"e".repeat(64)}`,
    runtimeKinds: ["native-executable"],
    transparency: {
      logIndex: 1,
      leafSha256: `sha256:${"f".repeat(64)}`,
      recordSha256: `sha256:${"0".repeat(64)}`,
    },
    revoked: false,
  };
}

function marketplaceCandidate() {
  return {
    pluginId: "acme.scanner",
    version: "1.1.0",
    marketplaceId: "candlescope.community",
    publisherId: "acme",
    bundleSha256: `sha256:${"a".repeat(64)}`,
    artifactFile: `${"a".repeat(64)}.cspkg`,
    phase: "verified-staged",
    preparedAt: "2026-07-23T02:01:00Z",
    fromVersion: "1.0.0",
    permissionDiff: {
      pluginId: "acme.scanner",
      publisherIdentityChanged: false,
      majorVersionChanged: false,
      bundleChanged: true,
      requiresConfirmation: true,
      permissions: [{
        permissionId: "market.bars.read",
        kind: "required",
        previousKind: null,
        change: "added",
        previousDecision: null,
        requestedScope: { maxHistoryBars: 50 },
        previousScope: null,
        requiresConfirmation: true,
      }],
    },
    compatibility: { hostVersion: "0.1.0", verified: true },
    migration: { required: false, supported: true, policy: "same-major-only" },
    observation: { status: "not-started", observedAt: null, detail: null },
  };
}

function sandboxPlugin() {
  const id = "acme.sandbox";
  return {
    id,
    name: "Sandbox",
    version: "1.0.0",
    publisher: "acme",
    state: "active",
    enabled: true,
    trustLevel: "untrusted",
    available: true,
    permissions: {
      activationReady: true,
      requiredSatisfied: true,
      requiredPermissionIds: [],
      permissions: [],
    },
    contributions: [{
      id: `${id}.main-view`,
      localId: "main-view",
      kind: "view/1",
      title: "Sandbox",
      entrypointId: "main",
      configuration: {
        slot: "sidePanel",
        renderer: "sandbox",
        surface: "main-view",
        asset: {
          bundleDigest: `sha256:${"a".repeat(64)}`,
          entry: "index.html",
          protocol: "candlescope.ui-bridge/1",
          sandbox: "allow-scripts",
          cspProfile: "opaque-origin-v1",
        },
      },
      available: true,
    }],
    runtime: { entrypoints: [{ entrypointId: "main", state: "stopped", generation: 0 }] },
  };
}

function providerPlugin() {
  const id = "candlescope.mock-provider";
  return {
    ...plugin(id),
    name: "Mock Exchange Provider",
    contributions: [
      {
        id: `${id}.symbols`,
        localId: "symbols",
        kind: "symbol-provider/1",
        title: "Mock Symbols",
        entrypointId: "main",
        configuration: {
          exchange: "mock",
          displayName: "Mock Exchange",
          marketTypes: [{
            id: "spot",
            productType: "spot",
            label: "Mock Spot",
            calendarId: "crypto.24x7.utc",
            timezone: "UTC",
          }],
          maxPageSize: 100,
          cacheTtlSeconds: 30,
        },
        available: true,
      },
      {
        id: `${id}.market-data`,
        localId: "market-data",
        kind: "market-data-provider/1",
        title: "Mock Market Data",
        entrypointId: "main",
        configuration: {
          exchange: "mock",
          dataPlane: "candlescope.stream/1",
          channels: [{
            kind: "kline",
            marketTypes: ["spot"],
            history: true,
            realtime: true,
            intervals: ["1m", "5m"],
            delivery: "append",
            finality: "explicit",
            corrections: true,
            maxPageSize: 500,
            maxBatch: 32,
            pollIntervalMs: 50,
            ratePerMinute: 600,
            maxConcurrent: 2,
          }],
          sourceQuality: { quality: "synthetic", finality: "explicit", timestamp: "provider" },
        },
        available: true,
      },
    ],
  };
}

function paperPlugin() {
  const id = "candlescope.paper-broker";
  return {
    ...plugin(id),
    name: "CandleScope Paper Broker",
    trustLevel: "first-party-pinned",
    contributions: [
      {
        id: `${id}.accounts`,
        localId: "accounts",
        kind: "account-provider/1",
        title: "Paper Accounts",
        entrypointId: "main",
        configuration: {
          brokerId: "fixture-paper",
          displayName: "Fixture Paper Broker",
          environment: "paper",
          accounts: [{
            id: "paper-main",
            label: "Paper Main",
            baseCurrency: "USDT",
            initialBalances: [{ asset: "USDT", available: "100000" }],
          }],
        },
        available: true,
      },
      {
        id: `${id}.executor`,
        localId: "executor",
        kind: "order-executor/1",
        title: "Paper Executor",
        entrypointId: "main",
        configuration: {
          brokerId: "fixture-paper",
          environment: "paper",
          protocol: "candlescope.paper/1",
          orderTypes: ["market", "limit"],
          symbols: [{
            symbol: "BTCUSDT",
            marketType: "spot",
            baseAsset: "BTC",
            quoteAsset: "USDT",
            priceTick: "0.01",
            quantityStep: "0.001",
            minQuantity: "0.001",
            maxQuantity: "2",
            minNotional: "10",
            maxNotional: "100000",
          }],
          limits: {
            maxOrderQuantity: "2",
            maxOrderNotional: "100000",
            maxPositionNotional: "200000",
            maxOpenOrders: 16,
            maxOrdersPerMinute: 60,
            allowShort: false,
          },
          maxQuoteAgeMs: 10000,
        },
        available: true,
      },
    ],
  };
}

function liveControl(mode: "disabled" | "unavailable" | "disarmed" | "armed" | "killed" = "armed") {
  const available = ["disarmed", "armed", "killed"].includes(mode);
  return {
    schemaVersion: "candlescope.live-control-status/1",
    available,
    mode,
    generation: available ? 4 : 0,
    policyEpoch: available ? 2 : 0,
    updatedAt: available ? "2026-07-23T01:02:03Z" : null,
    outstandingConfirmationCount: available ? 1 : 0,
    confirmationCounts: {
      consumed: 2,
      expired: 1,
      issued: available ? 1 : 0,
      revoked: 3,
    },
    eventSequence: available ? 8 : 0,
    eventSha256: available ? `sha256:${"a".repeat(64)}` : null,
    liveSubmitAvailable: false,
    liveCancelAvailable: false,
    liveTransferAvailable: false,
  };
}

function confirmationPreview() {
  return {
    schemaVersion: "candlescope.live-confirmation-preview/1",
    intentSha256: `sha256:${"b".repeat(64)}`,
    pluginId: "candlescope.okx-demo",
    connectorId: "candlescope.okx-demo-readonly",
    publisherIdentity: "publisher:test",
    version: "1.0.0",
    clientOrderId: "C".repeat(32),
    instrumentId: "BTC-USDT",
    side: "buy",
    orderType: "limit",
    quantity: "1",
    limitPrice: "42000",
    policyEpoch: 2,
    controlGeneration: 4,
    liveSubmitAvailable: false,
    liveCancelAvailable: false,
  };
}

test("Live control parsers keep unavailable, armed, and exact intent states fail closed", () => {
  assert.equal(parsePluginLiveControlStatus(liveControl()).mode, "armed");
  assert.equal(parsePluginLiveControlStatus(liveControl("unavailable")).available, false);
  assert.throws(
    () => parsePluginLiveControlStatus({ ...liveControl(), liveSubmitAvailable: true }),
    /invalid/i,
  );
  assert.equal(
    parsePluginLiveControlStatus({
      ...liveControl(),
      liveSubmitAvailable: true,
      liveCancelAvailable: true,
    }).liveSubmitAvailable,
    true,
  );
  assert.throws(
    () => parsePluginLiveControlStatus({ ...liveControl("disabled"), available: true }),
    /invalid/i,
  );
  const preview = parsePluginLiveConfirmationPreview(confirmationPreview());
  assert.equal(preview.intentSha256, `sha256:${"b".repeat(64)}`);
  const receipt = parsePluginLiveConfirmationReceipt({
    ...confirmationPreview(),
    schemaVersion: "candlescope.live-confirmation/1",
    receiptRef: `livecfm_${"R".repeat(43)}`,
    receiptId: "d".repeat(32),
    state: "issued",
    issuedAt: "2026-07-23T01:02:03Z",
    expiresAt: "2026-07-23T01:03:03Z",
    resolvedAt: null,
  });
  assert.equal(receipt.state, "issued");
  assert.throws(
    () => parsePluginLiveConfirmationReceipt({
      ...receipt,
      state: "consumed",
      resolvedAt: "2026-07-23T01:02:04Z",
    }),
    /invalid/i,
  );
});

test("WP-F parsers accept only action-bound Demo receipts and redacted execution records", () => {
  const preview = parsePluginLiveConfirmationPreview({
    ...confirmationPreview(),
    schemaVersion: "candlescope.live-confirmation-preview/2",
    connectorId: "candlescope.okx-demo-spot-execution",
    quantity: "0.001",
    orderIntentSha256: `sha256:${"c".repeat(64)}`,
    action: "submit",
    executionState: "not-started",
    notional: "42",
    riskDecisionSha256: `sha256:${"d".repeat(64)}`,
    hardLimits: {
      instrumentId: "BTC-USDT",
      maxOrderNotional: "100",
      maxUnresolvedOrders: 2,
      maxUnresolvedNotional: "200",
    },
    liveSubmitAvailable: true,
    liveCancelAvailable: false,
  });
  assert.equal(preview.action, "submit");
  const { hardLimits: _hardLimits, ...receiptPreview } = preview;
  const receipt = parsePluginLiveConfirmationReceipt({
    ...receiptPreview,
    schemaVersion: "candlescope.live-confirmation/2",
    receiptRef: `livecfm_${"R".repeat(43)}`,
    receiptId: "e".repeat(32),
    state: "issued",
    issuedAt: "2026-07-23T01:02:03Z",
    expiresAt: "2026-07-23T01:03:03Z",
    resolvedAt: null,
  });
  assert.equal(receipt.action, "submit");
  const execution = parsePluginLiveExecutionRecord({
    schemaVersion: "candlescope.live-execution-record/1",
    pluginId: "candlescope.okx-demo",
    connectorId: "candlescope.okx-demo-spot-execution",
    publisherIdentity: "publisher:test",
    version: "1.0.0",
    clientOrderId: "C".repeat(32),
    orderIntentSha256: `sha256:${"c".repeat(64)}`,
    instrumentId: "BTC-USDT",
    side: "buy",
    orderType: "limit",
    quantity: "0.001",
    limitPrice: "42000",
    notional: "42",
    state: "unknown",
    priorState: null,
    submitAttemptCount: 1,
    cancelAttemptCount: 0,
    venueOrderIdSha256: `sha256:${"f".repeat(64)}`,
    lastReceiptId: "e".repeat(32),
    lastConfirmationSha256: `sha256:${"b".repeat(64)}`,
    lastRiskDecisionSha256: `sha256:${"d".repeat(64)}`,
    lastErrorCode: null,
    createdAt: "2026-07-23T01:02:03Z",
    updatedAt: "2026-07-23T01:02:04Z",
    policyEpoch: 2,
    controlGeneration: 4,
    terminal: false,
    reconciliationRequired: true,
    accepted: true,
    action: "submit",
  });
  assert.equal(execution.state, "unknown");
  assert.equal(execution.action, "submit");
  assert.throws(
    () => parsePluginLiveExecutionRecord({
      ...execution,
      venueOrderId: "123456789",
    }),
    /invalid/i,
  );
  assert.throws(
    () => parsePluginLiveConfirmationPreview({
      ...preview,
      hardLimits: {
        ...preview.hardLimits,
        maxOrderNotional: "1000",
      },
    }),
    /invalid/i,
  );
});

test("catalog validator builds only active native registries", () => {
  const parsed = parsePluginCatalog(catalog());
  const registries = buildPluginRegistries(parsed);
  assert.deepEqual(registries.commandPalette.map((item) => item.id), ["acme.scanner.scan"]);
  assert.equal(registries.commandPalette[0]?.pluginId, "acme.scanner");
  assert.deepEqual(registries.topToolbar.map((item) => item.id), ["acme.scanner.scan"]);
  assert.deepEqual(registries.sidePanel.map((item) => item.id), ["acme.scanner.results"]);
});

test("plugin-owned localizations are validated and resolved by the Host locale", () => {
  const value = catalog();
  const commandInputSchema = value.plugins[0]!.contributions[0]!.configuration.inputSchema!;
  commandInputSchema.properties = {
    interval: { type: "string", enum: ["1m", "5m"] },
  };
  Object.assign(value.plugins[0]!.contributions[0]!, {
    localizations: {
      "zh-CN": {
        title: "扫描",
        schema: {
          title: "扫描参数",
          properties: {
            interval: { title: "周期", enumLabels: ["1 分钟", "5 分钟"] },
          },
        },
      },
      ja: {
        title: "スキャン",
        schema: {
          title: "スキャンパラメータ",
          properties: {
            interval: { title: "時間足", enumLabels: ["1分", "5分"] },
          },
        },
      },
    },
  });
  Object.assign(value.plugins[0]!.contributions[1]!, {
    localizations: {
      zh: {
        title: "结果",
        fields: { symbol: "标的" },
        emptyState: "暂无结果",
      },
      ja: {
        title: "結果",
        fields: { symbol: "銘柄" },
        emptyState: "結果はまだありません",
      },
    },
  });

  const parsed = parsePluginCatalog(value);
  const zh = buildPluginRegistries(parsed, "zh-CN");
  const en = buildPluginRegistries(parsed, "en");
  const ja = buildPluginRegistries(parsed, "ja");
  assert.equal(zh.commandPalette[0]?.title, "扫描");
  assert.equal(zh.commandPalette[0]?.configuration.inputSchema?.title, "扫描参数");
  assert.deepEqual(
    zh.commandPalette[0]?.configuration.inputSchema?.properties?.interval?.enumLabels,
    ["1 分钟", "5 分钟"],
  );
  assert.equal(zh.sidePanel[0]?.title, "结果");
  const zhView = zh.sidePanel[0];
  if (!zhView || zhView.configuration.renderer === "sandbox") assert.fail("localized view missing");
  assert.equal(zhView.configuration.fields[0]?.label, "标的");
  assert.equal(zhView.configuration.emptyState, "暂无结果");
  assert.equal(en.commandPalette[0]?.title, "Scan");
  assert.equal(en.sidePanel[0]?.title, "Results");
  assert.equal(ja.commandPalette[0]?.title, "スキャン");
  assert.deepEqual(
    ja.commandPalette[0]?.configuration.inputSchema?.properties?.interval?.enumLabels,
    ["1分", "5分"],
  );
  const jaView = ja.sidePanel[0];
  if (!jaView || jaView.configuration.renderer === "sandbox") assert.fail("japanese localized view missing");
  assert.equal(jaView.configuration.fields[0]?.label, "銘柄");
  assert.equal(jaView.configuration.emptyState, "結果はまだありません");

  const unknownField = structuredClone(value);
  const viewLocalization = (unknownField.plugins[0]!.contributions[1] as unknown as {
    localizations: Record<string, { fields: Record<string, string> }>;
  }).localizations.zh!;
  viewLocalization.fields = { executable: "不得进入目录" };
  assert.throws(() => parsePluginCatalog(unknownField), /invalid/i);

  const commandOnlyPayload = structuredClone(value);
  const commandLocalization = (commandOnlyPayload.plugins[0]!.contributions[0] as unknown as {
    localizations: Record<string, Record<string, unknown>>;
  }).localizations["zh-CN"]!;
  commandLocalization.fields = { source: "源码" };
  assert.throws(() => parsePluginCatalog(commandOnlyPayload), /invalid/i);

  const mismatchedEnumLabels = structuredClone(value);
  const intervalLocalization = (mismatchedEnumLabels.plugins[0]!.contributions[0] as unknown as {
    localizations: Record<string, {
      schema: { properties: { interval: { enumLabels: string[] } } };
    }>;
  }).localizations["zh-CN"]!.schema.properties.interval;
  intervalLocalization.enumLabels = ["1 分钟"];
  assert.throws(() => parsePluginCatalog(mismatchedEnumLabels), /enumLabels/i);
});

test("Phase 13 compatibility catalog is strict and never enters executable registries", () => {
  const parsed = parsePluginCatalog(catalog());
  assert.equal(parsed.schemaVersion, "candlescope.plugin-catalog/2");
  assert.equal(parsed.compatibility.import.status, "current");
  assert.equal(parsed.compatibility.contributions[0]?.kind, "script-runtime/1");
  assert.equal(parsed.compatibility.contributions[0]?.release.managed, true);
  assert.equal(buildPluginRegistries(parsed).commandPalette.length, 1);

  const fullV1IdentifierRange = structuredClone(catalog());
  fullV1IdentifierRange.compatibility.contributions[0]!.id = "compat.v1.1_py.runtime";
  fullV1IdentifierRange.compatibility.contributions[0]!.runtimeId = "1_py.runtime";
  fullV1IdentifierRange.compatibility.contributions[0]!.languages[0]!.id = "1_pyne";
  assert.equal(
    parsePluginCatalog(fullV1IdentifierRange).compatibility.contributions[0]?.runtimeId,
    "1_py.runtime",
  );

  const mismatchedCompatibilityId = structuredClone(fullV1IdentifierRange);
  mismatchedCompatibilityId.compatibility.contributions[0]!.id = "compat.v1.other";
  assert.throws(() => parsePluginCatalog(mismatchedCompatibilityId), /invalid/i);

  const invalidSource = structuredClone(catalog());
  Object.assign(invalidSource.compatibility, {
    status: "invalid",
    contributions: [],
  });
  Object.assign(invalidSource.compatibility.import, {
    status: "invalid",
    stateRevision: 0,
    activeSnapshotRevision: null,
    sourceSha256: null,
    importedSourceSha256: null,
    historyDepth: 0,
    rollbackAvailable: false,
  });
  assert.equal(parsePluginCatalog(invalidSource).compatibility.status, "invalid");

  const inconsistentRollback = structuredClone(catalog());
  inconsistentRollback.compatibility.import.historyDepth = 0;
  assert.throws(() => parsePluginCatalog(inconsistentRollback), /invalid/i);

  const executable = structuredClone(catalog());
  (executable.compatibility.contributions[0] as Record<string, unknown>).executable = "python.exe";
  assert.throws(() => parsePluginCatalog(executable), /invalid/i);

  const falseImport = structuredClone(catalog());
  falseImport.compatibility.contributions[0]!.imported = false;
  assert.throws(() => parsePluginCatalog(falseImport), /invalid/i);

  const preview = parsePluginV1CompatibilityPreview({
    schemaVersion: "candlescope.v1-compatibility-preview/1",
    action: "import",
    available: true,
    stateRevision: 1,
    sourceSha256: `sha256:${"9".repeat(64)}`,
    targetSnapshotRevision: null,
    changes: [{ id: "compat.v1.pyne.runtime", action: "update" }],
    previewSha256: `sha256:${"7".repeat(64)}`,
  });
  assert.equal(preview.changes[0]?.action, "update");
  assert.throws(
    () => parsePluginV1CompatibilityPreview({ ...preview, executable: "python.exe" }),
    /invalid/i,
  );
  assert.throws(
    () => parsePluginV1CompatibilityPreview({ ...preview, previewSha256: null }),
    /invalid/i,
  );
});

test("catalog validates public providers while keeping them out of UI extension registries", () => {
  const parsed = parsePluginCatalog(catalog([providerPlugin()]));
  assert.deepEqual(parsed.plugins[0]?.contributions.map((item) => item.kind), [
    "symbol-provider/1",
    "market-data-provider/1",
  ]);
  const market = parsed.plugins[0]?.contributions[1];
  assert.equal(market?.kind, "market-data-provider/1");
  if (market?.kind !== "market-data-provider/1") assert.fail("provider missing");
  assert.equal(market.configuration.dataPlane, "candlescope.stream/1");
  assert.deepEqual(buildPluginRegistries(parsed), {
    commandPalette: [],
    topToolbar: [],
    chartContextMenu: [],
    settings: [],
    sidePanel: [],
    bottomPanel: [],
    statusArea: [],
  });

  const invalid = providerPlugin();
  invalid.contributions[1]!.configuration.dataPlane = "direct-socket";
  assert.throws(() => parsePluginCatalog(catalog([invalid])), /configuration/);

  const invalidQuality = providerPlugin();
  const invalidQualitySource = invalidQuality.contributions[1]!.configuration.sourceQuality!;
  invalidQualitySource.quality = "trusted";
  assert.throws(() => parsePluginCatalog(catalog([invalidQuality])), /sourceQuality\.quality/);

  const invalidTimestamp = providerPlugin();
  const invalidTimestampSource = invalidTimestamp.contributions[1]!.configuration.sourceQuality!;
  invalidTimestampSource.timestamp = "sidecar";
  assert.throws(() => parsePluginCatalog(catalog([invalidTimestamp])), /sourceQuality\.timestamp/);
});

test("catalog validates Paper-only contributions and never registers them as UI code", () => {
  const parsed = parsePluginCatalog(catalog([paperPlugin()]));
  assert.deepEqual(parsed.plugins[0]?.contributions.map((item) => item.kind), [
    "account-provider/1",
    "order-executor/1",
  ]);
  assert.deepEqual(buildPluginRegistries(parsed).commandPalette, []);

  const live = paperPlugin();
  live.contributions[1]!.configuration.environment = "live";
  assert.throws(() => parsePluginCatalog(catalog([live])), /configuration/);

  const floatDecimal = paperPlugin();
  const floatLimits = (floatDecimal.contributions[1]!.configuration as { limits: Record<string, unknown> }).limits;
  floatLimits.maxOrderNotional = 100000;
  assert.throws(() => parsePluginCatalog(catalog([floatDecimal])), /maxOrderNotional/);

  const shorting = paperPlugin();
  const shortLimits = (shorting.contributions[1]!.configuration as { limits: Record<string, unknown> }).limits;
  shortLimits.allowShort = true;
  assert.throws(() => parsePluginCatalog(catalog([shorting])), /allowShort/);
});

test("command file inputs require native user-action fields within declared bounds", () => {
  const value = catalog();
  const configuration = value.plugins[0]!.contributions[0]!.configuration as Record<string, unknown>;
  configuration.inputSchema = {
    type: "object",
    properties: {
      fileHandle: { type: "string", minLength: 1, maxLength: 256 },
    },
    required: ["fileHandle"],
    additionalProperties: false,
  };
  configuration.fileInputs = [{
    field: "fileHandle",
    mode: "open",
    accept: ["application/json", "text/plain"],
    maxBytes: 131_072,
  }];
  const command = parsePluginCatalog(value).plugins[0]!.contributions[0]!;
  assert.equal(command.kind, "command/1");
  if (command.kind !== "command/1") assert.fail("command missing");
  assert.deepEqual(command.configuration.fileInputs, [{
    field: "fileHandle",
    mode: "open",
    accept: ["application/json", "text/plain"],
    maxBytes: 131_072,
  }]);

  const invalidCases: Array<(wire: typeof value) => void> = [
    (wire) => {
      (wire.plugins[0]!.contributions[0]!.configuration as Record<string, unknown>).requiresUserAction = false;
    },
    (wire) => {
      const files = (wire.plugins[0]!.contributions[0]!.configuration as Record<string, unknown>).fileInputs as Array<Record<string, unknown>>;
      files[0]!.suggestedName = "not-allowed.json";
    },
    (wire) => {
      const files = (wire.plugins[0]!.contributions[0]!.configuration as Record<string, unknown>).fileInputs as Array<Record<string, unknown>>;
      files[0]!.maxBytes = 131_073;
    },
    (wire) => {
      const schema = (wire.plugins[0]!.contributions[0]!.configuration as Record<string, unknown>).inputSchema as { required: string[] };
      schema.required = [];
    },
    (wire) => {
      const config = wire.plugins[0]!.contributions[0]!.configuration as Record<string, unknown>;
      const schema = config.inputSchema as {
        properties: Record<string, unknown>;
        required: string[];
      };
      schema.properties.secondHandle = { type: "string", minLength: 1, maxLength: 256 };
      schema.required.push("secondHandle");
      config.fileInputs = [
        {
          field: "fileHandle",
          mode: "save",
          accept: ["application/json"],
          maxBytes: 131_072,
          suggestedName: "first.json",
        },
        {
          field: "secondHandle",
          mode: "save",
          accept: ["application/json"],
          maxBytes: 131_072,
          suggestedName: "second.json",
        },
      ];
    },
  ];
  for (const mutate of invalidCases) {
    const wire = structuredClone(value);
    mutate(wire);
    assert.throws(() => parsePluginCatalog(wire), /invalid/);
  }
});

test("unknown slots and duplicate contribution IDs fail closed", () => {
  const unknownSlot = catalog();
  unknownSlot.plugins[0]!.contributions[1]!.configuration.slot = "floatingWindow";
  assert.throws(() => parsePluginCatalog(unknownSlot), /invalid/);

  const mismatchedRenderer = catalog();
  mismatchedRenderer.plugins[0]!.contributions[1]!.configuration.renderer = "status";
  assert.throws(() => parsePluginCatalog(mismatchedRenderer), /invalid/);

  const duplicate = catalog([plugin("acme.scanner"), plugin("acme.scanner-2")]);
  duplicate.plugins[1]!.contributions[0]!.id = duplicate.plugins[0]!.contributions[0]!.id;
  assert.throws(() => parsePluginCatalog(duplicate), /invalid/);
});

test("fifty disabled plugins produce no commands, views, or settings", () => {
  const parsed = parsePluginCatalog(catalog(Array.from({ length: 50 }, (_, index) => plugin(`acme.disabled-${index}`, false))));
  const registries = buildPluginRegistries(parsed);
  assert.equal(Object.values(registries).flat().length, 0);
});

test("sandbox view catalog accepts only digest-addressed opaque-origin assets", () => {
  const parsed = parsePluginCatalog(catalog([sandboxPlugin()]));
  const registries = buildPluginRegistries(parsed);
  const view = registries.sidePanel[0];
  assert.equal(view?.configuration.renderer, "sandbox");
  if (!view || view.configuration.renderer !== "sandbox") assert.fail("sandbox view missing");
  assert.equal(view.configuration.asset.protocol, "candlescope.ui-bridge/1");
  assert.equal(view.configuration.asset.bundleDigest, `sha256:${"a".repeat(64)}`);

  const badDigest = catalog([sandboxPlugin()]);
  badDigest.plugins[0]!.contributions[0]!.configuration.asset.bundleDigest = "sha256:abc";
  assert.throws(() => parsePluginCatalog(badDigest), /invalid/);

  const unsafeSlot = catalog([sandboxPlugin()]);
  unsafeSlot.plugins[0]!.contributions[0]!.configuration.slot = "statusArea";
  assert.throws(() => parsePluginCatalog(unsafeSlot), /invalid/);

  const executableExtra = catalog([sandboxPlugin()]);
  Object.assign(executableExtra.plugins[0]!.contributions[0]!.configuration, {
    componentUrl: "https://untrusted.invalid/plugin.js",
  });
  assert.throws(() => parsePluginCatalog(executableExtra), /invalid/);
});

test("UI snapshot accepts scalar projections and rejects executable-shaped extras", () => {
  const parsed = parsePluginUiSnapshot({
    schemaVersion: "candlescope.plugin-ui/1",
    registryRevision: 1,
    views: [{
      id: "acme.scanner.results",
      pluginId: "acme.scanner",
      title: "Results",
      slot: "sidePanel",
      renderer: "table",
      state: "ready",
      sourceRevision: 1,
      data: { rows: [{ symbol: "BTCUSDT" }] },
    }],
    chartLayers: [],
  });
  assert.equal("rows" in parsed.views[0]!.data && parsed.views[0]!.data.rows[0]?.symbol, "BTCUSDT");

  const invalid = {
    schemaVersion: "candlescope.plugin-ui/1",
    registryRevision: 1,
    views: [{
      id: "acme.scanner.results",
      pluginId: "acme.scanner",
      title: "Results",
      slot: "sidePanel",
      renderer: "table",
      state: "ready",
      data: { rows: [] },
      componentUrl: "https://untrusted.invalid/plugin.js",
    }],
    chartLayers: [],
  };
  assert.throws(() => parsePluginUiSnapshot(invalid), /invalid/);
});

test("Phase 6 local trust preview cannot understate risk, runtime, or acknowledgements", () => {
  const candidate = phase6LocalCandidate();
  const parsed = parsePluginLocalInstallCandidate(candidate);
  assert.equal(parsed.preview.authorization.mode, "trusted-local");
  assert.equal(parsed.preview.authorization.entrypoints[0]?.systemRuntimePath, "C:\\Python\\python.exe");
  assert.deepEqual(parsed.preview.requests.network.permissionIds, ["network.connect"]);
  assert.deepEqual(parsed.preview.requiredAcknowledgements, phase6Acknowledgements());

  const understatedRisk = structuredClone(candidate);
  understatedRisk.preview.requests.network = { requested: false, permissionIds: [] };
  assert.throws(() => parsePluginLocalInstallCandidate(understatedRisk), /network/);

  const missingAcknowledgement = structuredClone(candidate);
  missingAcknowledgement.preview.requiredAcknowledgements = phase6Acknowledgements().slice(1);
  assert.throws(() => parsePluginLocalInstallCandidate(missingAcknowledgement), /preview/);

  const falseSandbox = structuredClone(candidate);
  falseSandbox.preview.authorization.sandbox.active = true;
  assert.throws(() => parsePluginLocalInstallCandidate(falseSandbox), /authorization/);

  const falseProfile = structuredClone(candidate);
  falseProfile.preview.authorization.entrypoints[0]!.profile.sandboxMode = "unavailable";
  falseProfile.preview.authorization.sandbox.profiles[0]!.sandboxMode = "unavailable";
  assert.throws(() => parsePluginLocalInstallCandidate(falseProfile), /profile/);

  const extraExecutionField = structuredClone(candidate) as typeof candidate & { executable?: string };
  extraExecutionField.executable = "powershell.exe";
  assert.throws(() => parsePluginLocalInstallCandidate(extraExecutionField), /invalid/i);
});

test("Phase 6 review tokens and signed trust changes are exact and fail closed", () => {
  const candidate = phase6LocalCandidate();
  const review = parsePluginTrustReview({
    candidateId: candidate.candidateId,
    previewSha256: candidate.previewSha256,
    confirmationToken: `trust-review-${"A".repeat(43)}`,
    expiresAt: "2026-08-03T12:10:00Z",
    confirmationStep: 1,
  });
  assert.equal(review.confirmationStep, 1);
  assert.throws(() => parsePluginTrustReview({ ...review, confirmationToken: "reusable" }), /confirmationToken/);

  const from = phase6Authorization("marketplace-sandboxed");
  from.signatureRoots = [`publisher-key:ed25519:${"a".repeat(64)}`, "host-python:3.12"].sort();
  const to = phase6Authorization("trusted-local");
  to.signatureRoots = [...from.signatureRoots];
  const change = {
    changeId: `trust-change-${"b".repeat(32)}`,
    previewSha256: `sha256:${"c".repeat(64)}`,
    confirmationToken: `trust-change-${"D".repeat(43)}`,
    expiresAt: "2026-08-03T12:10:00Z",
    preview: {
      schemaVersion: "candlescope.plugin-trust-preview/1",
      action: "trust-change",
      pluginId: "candlescope.phase6-example",
      bundleSha256: `sha256:${"6".repeat(64)}`,
      source: {
        rawTrustLevel: "verified-publisher",
        canonicalDefault: "marketplace-sandboxed",
        publisherIdentity: `publisher-key:ed25519:${"a".repeat(64)}`,
        source: "signed-marketplace",
        marketplaceId: "candlescope.community",
        signatureRoot: `publisher-key:ed25519:${"a".repeat(64)}`,
      },
      from,
      to,
      permissionDiff: {
        pluginId: "candlescope.phase6-example",
        publisherIdentityChanged: false,
        majorVersionChanged: false,
        bundleChanged: false,
        authorizationIdentityChanged: true,
        requiresConfirmation: true,
        permissions: [{
          permissionId: "network.connect",
          kind: "optional",
          previousKind: "optional",
          change: "identity-changed",
          previousDecision: "granted",
          requestedScope: { origins: ["https://example.invalid"] },
          previousScope: { origins: ["https://example.invalid"] },
          requiresConfirmation: true,
        }],
      },
      runtimeDiff: {
        changed: false,
        requiresConfirmation: false,
        kindOrIdChanged: false,
        signatureRootChanged: false,
        systemRuntimePathChanged: false,
        supplyChanged: false,
        previous: from.entrypoints,
        current: to.entrypoints,
      },
      requests: phase6Requests(),
      requiredAcknowledgements: phase6Acknowledgements(),
    },
  };
  const parsed = parsePluginTrustChangeReview(change);
  assert.equal(parsed.preview.from.mode, "marketplace-sandboxed");
  assert.equal(parsed.preview.to.mode, "trusted-local");

  const unsigned = structuredClone(change);
  (unsigned.preview as { source: unknown }).source = candidate.preview.source;
  assert.throws(() => parsePluginTrustChangeReview(unsigned), /preview/);

  const noModeChange = structuredClone(change);
  noModeChange.preview.to = structuredClone(noModeChange.preview.from);
  assert.throws(() => parsePluginTrustChangeReview(noModeChange), /preview/);

  const hiddenPermission = structuredClone(change);
  hiddenPermission.preview.requiredAcknowledgements = hiddenPermission.preview.requiredAcknowledgements.filter(
    (item) => item !== "permission:network.connect",
  );
  assert.throws(() => parsePluginTrustChangeReview(hiddenPermission), /preview/);
});

test("Phase 4 catalog strictly preserves managed Registry and runtime supply provenance", () => {
  const runtimeSupply = {
    source: "host-managed" as const,
    runtimeId: "temurin-21.0.12.8",
    runtimeKind: "java" as const,
    version: "21.0.12+8-LTS",
    executable: "C:\\CandleScope\\managed-runtimes\\bin\\java.exe",
    artifactSha256: `sha256:${"a".repeat(64)}`,
    artifactSize: 48_993_215,
    probeSha256: `sha256:${"b".repeat(64)}`,
    verificationStatus: "verified" as const,
    reproducible: true as const,
    licenseSpdx: "GPL-2.0 WITH Classpath-exception-2.0",
    registryId: "candlescope.reference-runtime",
    registryRevision: 1,
    registrySha256: `sha256:${"c".repeat(64)}`,
    sourceUrl: "https://github.com/adoptium/temurin21-binaries/releases/download/runtime.zip",
  };
  const value = {
    ...catalog([{
      ...plugin(),
      runtime: {
        entrypoints: [{
          entrypointId: "main",
          state: "stopped",
          generation: 0,
          runtimeSupply,
        }],
      },
    }]),
    runtimeRegistry: {
      schemaVersion: "candlescope.runtime-registry-status/1",
      enabled: true,
      networkUpdatesEnabled: false,
      automaticUpdates: false,
      active: {
        registryId: "candlescope.reference-runtime",
        revision: 1,
        registrySha256: `sha256:${"c".repeat(64)}`,
        issuedAt: "2026-08-03T00:00:00Z",
        rollbackAvailable: false,
        revokedArtifactCount: 0,
      },
      runtimes: [{
        runtimeId: "temurin-21.0.12.8",
        kind: "java",
        version: "21.0.12+8-LTS",
        os: "windows",
        arch: "x86_64",
        sourceUrl: runtimeSupply.sourceUrl,
        sha256: runtimeSupply.artifactSha256,
        size: runtimeSupply.artifactSize,
        license: runtimeSupply.licenseSpdx,
        upstreamReleaseUrl: "https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.12%2B8",
        source: "host-managed",
        registryId: runtimeSupply.registryId,
        registryRevision: runtimeSupply.registryRevision,
        registrySha256: runtimeSupply.registrySha256,
        verificationStatus: "verified",
        cached: true,
        probeSha256: runtimeSupply.probeSha256,
        referenceCount: 2,
        reproducible: true,
      }],
      systemRuntimes: [],
    },
  };

  const parsed = parsePluginCatalog(value);
  assert.equal(parsed.runtimeRegistry?.runtimes[0]?.runtimeId, "temurin-21.0.12.8");
  assert.equal(parsed.runtimeRegistry?.automaticUpdates, false);
  assert.deepEqual(parsed.plugins[0]?.runtime.entrypoints[0]?.runtimeSupply, runtimeSupply);

  const automatic = structuredClone(value);
  automatic.runtimeRegistry.automaticUpdates = true;
  assert.throws(() => parsePluginCatalog(automatic), /invalid/i);

  const nonreproducible = structuredClone(value);
  Object.assign(
    nonreproducible.plugins[0]!.runtime.entrypoints[0]!.runtimeSupply,
    { reproducible: false },
  );
  assert.throws(() => parsePluginCatalog(nonreproducible), /invalid/i);

  const extra = structuredClone(value);
  Object.assign(extra.runtimeRegistry, { updateUrl: "https://example.invalid/latest" });
  assert.throws(() => parsePluginCatalog(extra), /invalid/i);

  const insecureSource = structuredClone(value);
  insecureSource.runtimeRegistry.runtimes[0]!.sourceUrl = "http://example.invalid/runtime.zip";
  assert.throws(() => parsePluginCatalog(insecureSource), /invalid/i);
});

test("UI snapshot accepts bounded Render IR v2 analysis layers and rejects unknown items", () => {
  const wire = {
    schemaVersion: "candlescope.plugin-ui/1",
    registryRevision: 1,
    views: [],
    chartLayers: [{
      id: "acme.wave.waves",
      pluginId: "acme.wave",
      generation: 1,
      revision: 2,
      chartId: "main-chart",
      chartRevision: 3,
      zOrder: "above-series",
      context: { mode: "live", exchange: "binance", marketType: "spot" },
      series: { symbol: "BTCUSDT", interval: "1m" },
      itemCount: 4,
      schemaVersion: "candlescope.render/2",
      render: {
        schemaVersion: "candlescope.render/2",
        items: [
          {
            id: "path",
            type: "polyline",
            points: [{ time: 100, price: 10 }, { time: 200, price: 12 }],
            color: "#3B82F6",
            width: 2,
            style: "solid",
          },
          {
            id: "label",
            type: "label",
            time: 200,
            price: 12,
            text: "(3)",
            color: "#FFFFFF",
            backgroundColor: "#1D4ED8CC",
            position: "above",
          },
          {
            id: "invalid",
            type: "price-line",
            price: 9,
            color: "#EF4444",
            width: 1,
            style: "dashed",
            text: "invalid",
          },
          {
            id: "target",
            type: "band",
            startTime: 200,
            endTime: 400,
            lowerPrice: 13,
            upperPrice: 14,
            fillColor: "#22C55E22",
          },
        ],
      },
    }],
  };
  const parsed = parsePluginUiSnapshot(wire);
  const layer = parsed.chartLayers[0];
  assert.equal(layer?.render.schemaVersion, "candlescope.render/2");
  assert.equal(layer && "chartRevision" in layer ? layer.chartRevision : null, 3);

  const invalid = structuredClone(wire);
  invalid.chartLayers[0]!.render.items[0] = {
    ...invalid.chartLayers[0]!.render.items[0]!,
    type: "host-component",
  };
  assert.throws(() => parsePluginUiSnapshot(invalid), /type/);
});

test("marketplace catalog and status preserve only verified distribution metadata", () => {
  const release = marketplaceRelease();
  const candidate = marketplaceCandidate();
  const marketplaceCatalog = {
    schemaVersion: "candlescope.marketplace-catalog/1",
    enabled: true,
    marketplaces: [{
      marketplaceId: "candlescope.community",
      indexUrl: "https://plugins.example.invalid/index.json",
      keyId: `ed25519:${"2".repeat(64)}`,
      enabled: true,
      cache: {
        status: "valid",
        sequence: 1,
        expiresAt: "2026-07-30T02:00:00Z",
      },
    }],
    plugins: [{
      pluginId: "acme.scanner",
      publisher: {
        publisherId: "acme",
        displayName: "Acme",
        keyId: `ed25519:${"e".repeat(64)}`,
        status: "active",
      },
      latest: release,
      releaseCount: 1,
      installedVersion: "1.0.0",
      installable: true,
    }],
  };
  assert.equal(parsePluginMarketplaceCatalog(marketplaceCatalog).plugins[0]?.latest.version, "1.1.0");

  const validSemver = structuredClone(marketplaceCatalog);
  validSemver.plugins[0]!.latest.version = "1.1.0-1alpha+build.01";
  assert.equal(
    parsePluginMarketplaceCatalog(validSemver).plugins[0]?.latest.version,
    "1.1.0-1alpha+build.01",
  );

  const longArtifact = structuredClone(marketplaceCatalog);
  const longFileName = `a${"b".repeat(199)}.cspkg`;
  longArtifact.plugins[0]!.latest.artifact.fileName = longFileName;
  longArtifact.plugins[0]!.latest.artifact.url = `https://plugins.example.invalid/artifacts/${longFileName}`;
  longArtifact.plugins[0]!.latest.sha256Sums = `${"a".repeat(64)}  ${longFileName}\n`;
  assert.equal(
    parsePluginMarketplaceCatalog(longArtifact).plugins[0]?.latest.artifact.fileName,
    longFileName,
  );

  const oversized = structuredClone(marketplaceCatalog);
  oversized.plugins[0]!.latest.artifact.size = 128 * 1024 * 1024 + 1;
  oversized.plugins[0]!.installable = false;
  assert.equal(parsePluginMarketplaceCatalog(oversized).plugins[0]?.installable, false);
  oversized.plugins[0]!.installable = true;
  assert.throws(() => parsePluginMarketplaceCatalog(oversized), /invalid/);

  const invalidVersion = structuredClone(marketplaceCatalog);
  invalidVersion.plugins[0]!.latest.version = "1.01.0";
  assert.throws(() => parsePluginMarketplaceCatalog(invalidVersion), /invalid/);

  const inactivePublisher = structuredClone(marketplaceCatalog);
  inactivePublisher.plugins[0]!.publisher.status = "disabled";
  assert.throws(() => parsePluginMarketplaceCatalog(inactivePublisher), /invalid/);

  const update = {
    policy: "signed-marketplace-or-local-artifact",
    automatic: false,
    available: true,
    ownership: "signed-marketplace",
    reason: null,
    candidate,
    latest: release,
  };
  const status = {
    schemaVersion: "candlescope.marketplace-status/1",
    enabled: true,
    automaticUpdates: false,
    rootCount: 1,
    validCacheCount: 1,
    cacheErrors: {},
    candidates: [candidate],
    updates: [{ pluginId: "acme.scanner", ...update }],
  };
  assert.equal(parsePluginMarketplaceStatus(status).candidates[0]?.permissionDiff.requiresConfirmation, true);

  const injected = structuredClone(marketplaceCatalog);
  Object.assign(injected.plugins[0]!.latest, { installScript: "powershell -enc ..." });
  assert.throws(() => parsePluginMarketplaceCatalog(injected), /invalid/);
});

test("marketplace v2 preserves separate supply-chain assurances and local-only telemetry", () => {
  const release = marketplaceReleaseV2();
  const catalog = {
    schemaVersion: "candlescope.marketplace-catalog/2",
    enabled: true,
    rollout: {
      channel: "preview",
      stages: ["internal", "opted-in-local", "preview", "stable"],
    },
    marketplaces: [{
      marketplaceId: "candlescope.community",
      indexUrl: "https://plugins.example.invalid/index.json",
      keyId: `ed25519:${"2".repeat(64)}`,
      enabled: true,
      cache: {
        status: "valid",
        sequence: 2,
        expiresAt: "2026-09-02T00:00:00Z",
      },
    }],
    plugins: [{
      pluginId: "candlescope.aho-corasick",
      publisher: {
        publisherId: "candlescope",
        displayName: "CandleScope Official",
        keyId: `ed25519:${"e".repeat(64)}`,
        status: "active",
        verificationTier: "official",
      },
      latest: release,
      assurances: {
        publisherVerified: true,
        officialMaintained: true,
        sandbox: {
          available: true,
          runtimeKinds: ["native-executable"],
          profiles: [{
            profileId: "restricted-native-v1",
            runtimeKind: "native-executable",
            sandboxMode: "windows-appcontainer",
            sandboxSupported: true,
            trustedLocalOnly: false,
            networkDefault: "denied",
            subprocessDeclared: false,
            limits: { maxProcesses: 1 },
          }],
        },
        permissions: { required: [], optional: [] },
        rolloutStage: "preview",
        minimumHostVersion: "0.4.0",
        platform: {
          os: "windows",
          arch: "x86_64",
          available: true,
          artifactId: "windows-x86_64",
        },
      },
      releaseCount: 1,
      installedVersion: null,
      installable: true,
    }],
  };
  const parsed = parsePluginMarketplaceCatalog(catalog);
  assert.equal(parsed.schemaVersion, "candlescope.marketplace-catalog/2");
  assert.equal(parsed.plugins[0]?.publisher.verificationTier, "official");
  assert.equal(parsed.plugins[0]?.assurances?.sandbox.available, true);
  assert.equal(parsed.plugins[0]?.latest.artifacts?.[0]?.reviewPolicy.sourceBuild, false);

  const status = {
    schemaVersion: "candlescope.marketplace-status/2",
    enabled: true,
    automaticUpdates: false,
    rootCount: 1,
    validCacheCount: 1,
    cacheErrors: {},
    candidates: [],
    updates: [],
    rollout: catalog.rollout,
    telemetry: {
      enabled: true,
      uploadEnabled: false,
      storage: "local-aggregate-only",
      privacy: {
        identifiers: false,
        strategyInputs: false,
        accounts: false,
        pluginPrivateData: false,
      },
      counters: [{ runtimeKind: "native-executable", operation: "prepare", outcome: "success", count: 1 }],
    },
    quarantine: [{
      schemaVersion: "candlescope.marketplace-quarantine/1",
      pluginId: "candlescope.aho-corasick",
      version: "0.1.0",
      bundleSha256: `sha256:${"9".repeat(64)}`,
      reason: "MALICIOUS_RELEASE",
      quarantinedAt: "2026-08-03T01:00:00Z",
      artifactFile: `${"9".repeat(64)}.cspkg`,
      payloadMoved: true,
    }],
  };
  const parsedStatus = parsePluginMarketplaceStatus(status);
  assert.equal(parsedStatus.telemetry?.uploadEnabled, false);
  assert.equal(parsedStatus.quarantine?.[0]?.reason, "MALICIOUS_RELEASE");

  const unsafe = structuredClone(catalog);
  unsafe.plugins[0]!.latest.artifacts[0]!.reviewPolicy.sourceBuild = true;
  assert.throws(() => parsePluginMarketplaceCatalog(unsafe), /reviewPolicy/);
});

test("management detail accepts only the Host-projected lifecycle shape", () => {
  const value = {
    schemaVersion: "candlescope.plugin-management-detail/1",
    plugin: plugin(),
    permissions: [{
      pluginId: "acme.scanner",
      activationReady: true,
      requiredSatisfied: true,
      permissions: [{
        permissionId: "market.bars.read",
        kind: "required",
        decision: "pending",
        requestedScope: { maxHistoryBars: 50 },
        grantedScope: null,
      }],
    }],
    health: { available: true, entrypoints: [{ entrypointId: "main", state: "stopped", generation: 0 }] },
    update: {
      policy: "signed-marketplace-or-local-artifact",
      automatic: false,
      available: false,
      ownership: "local-or-first-party",
      reason: "NO_SIGNED_UPDATE",
      candidate: null,
      latest: null,
    },
    rollback: { available: true, target: { state: "disabled", version: "1.0.0" } },
    paperTrading: {
      schemaVersion: "candlescope.paper-status/1",
      killSwitchEnabled: false,
      mode: "paper-only",
      liveTradingAvailable: false,
      secretsAvailable: false,
      brokers: [],
      available: false,
    },
    dataRetention: {
      retainedOnDisable: true,
      retainedOnUninstall: true,
      automaticDeletion: false,
      storage: { available: true, exists: false, usageBytes: 0 },
    },
  };
  assert.equal(parsePluginManagementDetail(value).permissions[0]?.permissions[0]?.permissionId, "market.bars.read");

  const executableExtra = structuredClone(value);
  Object.assign(executableExtra.health, { componentUrl: "https://untrusted.invalid/plugin.js" });
  assert.throws(() => parsePluginManagementDetail(executableExtra), /invalid/);
});
