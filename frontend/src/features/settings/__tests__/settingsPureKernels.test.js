import assert from "node:assert/strict";
import test from "node:test";

import { SETTINGS_ACTION_TYPES } from "../settingsActionTypes.js";
import { buildSettingsPanelViewModel } from "../settingsPanelViewModel.js";
import { SETTINGS_CATEGORIES, resolveSettingsTab } from "../settingsTabRegistry.js";

test("settings registry owns the complete ordered category contract", () => {
  assert.deepEqual(
    SETTINGS_CATEGORIES.map((category) => category.key),
    ["appearance", "network", "exchanges", "data", "database", "about"],
  );
  assert.equal(resolveSettingsTab("missing"), SETTINGS_CATEGORIES[0]);
});

test("settings action descriptors distinguish local, backend, and mock behavior", () => {
  assert.equal(SETTINGS_ACTION_TYPES.chartAppearance.type, "local_only");
  assert.equal(SETTINGS_ACTION_TYPES.proxySettings.type, "backend_endpoint");
  assert.equal(SETTINGS_ACTION_TYPES.databaseTools.type, "mock");
});

test("settings panel view model merges only the matching view and action groups", () => {
  const panel = buildSettingsPanelViewModel({
    view: {
      appearance: { theme: "dark" },
      proxy: { mode: "direct" },
      exchanges: { current: "binance" },
      cacheLimits: { limit: 1 },
      cacheDiagnostics: { status: "ready" },
      maintenance: { scanning: false },
      database: { rows: 3 },
    },
    actions: {
      proxy: { save: "proxy-save" },
      exchanges: { refresh: "exchange-refresh" },
      cacheLimits: { toggle: "cache-toggle" },
      cacheDiagnostics: { run: "cache-run" },
      maintenance: { scan: "maintenance-scan" },
    },
  });

  assert.deepEqual(panel.network, { mode: "direct", save: "proxy-save" });
  assert.deepEqual(panel.data.cacheDiagnostics, { status: "ready", run: "cache-run" });
  assert.deepEqual(panel.about, {});
});
