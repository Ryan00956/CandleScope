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

test("catalog validator builds only active native registries", () => {
  const parsed = parsePluginCatalog(catalog());
  const registries = buildPluginRegistries(parsed);
  assert.deepEqual(registries.commandPalette.map((item) => item.id), ["acme.scanner.scan"]);
  assert.equal(registries.commandPalette[0]?.pluginId, "acme.scanner");
  assert.deepEqual(registries.topToolbar.map((item) => item.id), ["acme.scanner.scan"]);
  assert.deepEqual(registries.sidePanel.map((item) => item.id), ["acme.scanner.results"]);
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
