import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSettings } from "../chartAppearanceSettings.js";

test("settings normalization backfills cache budget defaults for old saved settings", () => {
  const settings = normalizeSettings({
    theme: "light",
    cacheLimits: { minutes: 100, hours: 20, daily: 0 },
  });

  assert.equal(settings.theme, "light");
  assert.equal(settings.chartType, "candlestick");
  assert.equal(settings.frontendCacheBudgetBytes, 64 * 1024 * 1024);
  assert.equal(settings.sqliteStorageBudgetBytes, null);
  assert.equal(settings.storageRowLimitsEnabled, false);
});

test("settings normalization preserves supported chart types and rejects stale values", () => {
  assert.equal(normalizeSettings({ chartType: "area" }).chartType, "area");
  assert.equal(normalizeSettings({ chartType: "heikin-ashi" }).chartType, "heikin-ashi");
  assert.equal(normalizeSettings({ chartType: "line-with-markers" }).chartType, "line-with-markers");
  assert.equal(normalizeSettings({ chartType: "renko" }).chartType, "candlestick");
});
