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

function catalog(plugins = [plugin()]) {
  return {
    schemaVersion: "candlescope.plugin-catalog/1",
    platform: { enabled: true, started: true, status: "ok", registryRevision: 1 },
    plugins,
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
