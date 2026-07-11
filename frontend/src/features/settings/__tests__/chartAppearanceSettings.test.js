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
  assert.equal(settings.renkoBoxSizeMode, "atr");
  assert.equal(settings.renkoAtrLength, 14);
  assert.equal(settings.renkoBoxSize, 1);
  assert.equal(settings.frontendCacheBudgetBytes, 64 * 1024 * 1024);
  assert.equal(settings.sqliteStorageBudgetBytes, null);
  assert.equal(settings.storageRowLimitsEnabled, false);
});

test("settings normalization preserves supported chart types and rejects stale values", () => {
  assert.equal(normalizeSettings({ chartType: "area" }).chartType, "area");
  assert.equal(normalizeSettings({ chartType: "heikin-ashi" }).chartType, "heikin-ashi");
  assert.equal(normalizeSettings({ chartType: "line-with-markers" }).chartType, "line-with-markers");
  assert.equal(normalizeSettings({ chartType: "renko" }).chartType, "renko");
  assert.equal(normalizeSettings({ chartType: "point-and-figure" }).chartType, "candlestick");
});

test("settings normalization validates Renko runtime options", () => {
  assert.deepEqual(
    {
      mode: normalizeSettings({ renkoBoxSizeMode: "traditional" }).renkoBoxSizeMode,
      atr: normalizeSettings({ renkoAtrLength: 21 }).renkoAtrLength,
      box: normalizeSettings({ renkoBoxSize: 25.5 }).renkoBoxSize,
    },
    { mode: "traditional", atr: 21, box: 25.5 },
  );
  const fallback = normalizeSettings({
    renkoBoxSizeMode: "unknown",
    renkoAtrLength: 1,
    renkoBoxSize: 0,
  });
  assert.equal(fallback.renkoBoxSizeMode, "atr");
  assert.equal(fallback.renkoAtrLength, 14);
  assert.equal(fallback.renkoBoxSize, 1);
});
