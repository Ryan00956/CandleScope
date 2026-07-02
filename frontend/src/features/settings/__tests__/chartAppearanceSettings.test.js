import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSettings } from "../chartAppearanceSettings.js";

test("settings normalization backfills cache budget defaults for old saved settings", () => {
  const settings = normalizeSettings({
    theme: "light",
    cacheLimits: { minutes: 100, hours: 20, daily: 0 },
  });

  assert.equal(settings.theme, "light");
  assert.equal(settings.frontendCacheBudgetBytes, 64 * 1024 * 1024);
  assert.equal(settings.sqliteStorageBudgetBytes, null);
  assert.equal(settings.storageRowLimitsEnabled, false);
});
