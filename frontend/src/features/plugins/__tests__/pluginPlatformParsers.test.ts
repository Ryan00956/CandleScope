import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginCatalog, parsePluginManagementDetail, parsePluginUiSnapshot } from "../pluginPlatformParsers.js";
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
    update: { policy: "local-artifact-only", automatic: false, available: false },
    rollback: { available: true, target: { state: "disabled", version: "1.0.0" } },
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
