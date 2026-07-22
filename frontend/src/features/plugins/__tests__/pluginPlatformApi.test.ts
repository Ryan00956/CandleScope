import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginSettingsValue, sandboxPluginAssetUrl } from "../pluginPlatformApi.js";

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

test("sandbox asset URLs are digest-addressed and reject path confusion", () => {
  const digest = `sha256:${"b".repeat(64)}`;
  assert.equal(
    sandboxPluginAssetUrl("acme.sandbox", digest, "nested/index.html"),
    `/api/v2/plugins/assets/acme.sandbox/${"b".repeat(64)}/nested/index.html`,
  );
  assert.throws(() => sandboxPluginAssetUrl("acme.sandbox", digest, "../index.html"), /invalid/);
  assert.throws(() => sandboxPluginAssetUrl("acme.sandbox", "sha256:abc", "index.html"), /invalid/);
  assert.throws(() => sandboxPluginAssetUrl("sandbox", digest, "index.html"), /invalid/);
});
