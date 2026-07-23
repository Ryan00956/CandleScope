import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePluginCatalog,
  parsePluginLiveConfirmationPreview,
  parsePluginLiveConfirmationReceipt,
  parsePluginLiveControlStatus,
  parsePluginLiveExecutionRecord,
  parsePluginManagementDetail,
  parsePluginMarketplaceCatalog,
  parsePluginMarketplaceStatus,
  parsePluginUiSnapshot,
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
    schemaVersion: "candlescope.plugin-catalog/1",
    platform: { enabled: true, started: true, status: "ok", registryRevision: 1 },
    plugins,
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
