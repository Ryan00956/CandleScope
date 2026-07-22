import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginSettingsValue } from "../pluginPlatformApi.js";

test("settings API unwraps the validated value from its revision envelope", () => {
  assert.deepEqual(parsePluginSettingsValue({
    settings: {
      pluginId: "candlescope.market-scanner",
      contributionId: "candlescope.market-scanner.settings",
      value: { interval: "1h", symbolsLimit: 2 },
      schemaSha256: "sha256:abc",
      storeRevision: 4,
    },
  }), { interval: "1h", symbolsLimit: 2 });
});

test("settings API fails closed when the revision envelope has no object value", () => {
  assert.throws(
    () => parsePluginSettingsValue({ settings: { storeRevision: 4 } }),
    /invalid/i,
  );
  assert.throws(
    () => parsePluginSettingsValue({ settings: { value: ["1h"] } }),
    /invalid/i,
  );
});
