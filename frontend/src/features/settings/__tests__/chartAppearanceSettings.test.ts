import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSettings,
  parseStoredSettings,
  settingsFromStorageChange,
} from "../chartAppearanceSettings.js";

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
  assert.equal(settings.pointFigureBoxSizeMode, "atr");
  assert.equal(settings.pointFigureAtrLength, 14);
  assert.equal(settings.pointFigureBoxSize, 1);
  assert.equal(settings.pointFigureReversalAmount, 3);
  assert.equal(settings.kagiReversalMode, "atr");
  assert.equal(settings.kagiAtrLength, 14);
  assert.equal(settings.kagiReversalAmount, 1);
  assert.equal(settings.lineBreakNumberOfLines, 3);
  assert.equal(settings.frontendCacheBudgetBytes, 64 * 1024 * 1024);
  assert.equal(settings.sqliteStorageBudgetBytes, null);
  assert.equal(settings.storageRowLimitsEnabled, false);
  assert.equal(settings.locale, "zh-CN");
});

test("settings normalization defaults locale to zh-CN and accepts English aliases", () => {
  assert.equal(normalizeSettings({}).locale, "zh-CN");
  assert.equal(normalizeSettings({ locale: "en" }).locale, "en");
  assert.equal(normalizeSettings({ locale: "en-US" }).locale, "en");
  assert.equal(normalizeSettings({ locale: "zh-Hans" }).locale, "zh-CN");
  assert.equal(normalizeSettings({ locale: "fr-FR" }).locale, "zh-CN");
});

test("settings persist and restore zh-TW across storage events and old settings", () => {
  assert.equal(normalizeSettings({ locale: "zh-TW" }).locale, "zh-TW");
  assert.equal(normalizeSettings({ locale: "zh-tw" }).locale, "zh-TW");
  assert.equal(normalizeSettings({ locale: "zh-Hant-TW" }).locale, "zh-TW");
  assert.equal(parseStoredSettings(JSON.stringify({ locale: "zh-TW" })).locale, "zh-TW");
  const incoming = settingsFromStorageChange("candlescope-settings", JSON.stringify({
    locale: "zh-Hant-TW",
  }));
  assert.equal(incoming?.locale, "zh-TW");
  assert.equal(normalizeSettings({ theme: "light" }).locale, "zh-CN");
  assert.equal(normalizeSettings({ locale: "zh-HK" }).locale, "zh-CN");
});

test("settings storage changes synchronize the complete settings snapshot across windows", () => {
  const incoming = settingsFromStorageChange("candlescope-settings", JSON.stringify({
    theme: "light",
    locale: "en-US",
  }));
  assert.equal(incoming?.theme, "light");
  assert.equal(incoming?.locale, "en");
  assert.equal(settingsFromStorageChange("unrelated-key", "{}"), null);
  assert.equal(settingsFromStorageChange(null, null)?.locale, "zh-CN");
});

test("settings normalization preserves supported chart types and rejects stale values", () => {
  assert.equal(normalizeSettings({ chartType: "area" }).chartType, "area");
  assert.equal(normalizeSettings({ chartType: "heikin-ashi" }).chartType, "heikin-ashi");
  assert.equal(normalizeSettings({ chartType: "line-with-markers" }).chartType, "line-with-markers");
  assert.equal(normalizeSettings({ chartType: "renko" }).chartType, "renko");
  assert.equal(normalizeSettings({ chartType: "point-and-figure" }).chartType, "point-and-figure");
  assert.equal(normalizeSettings({ chartType: "kagi" }).chartType, "kagi");
  assert.equal(normalizeSettings({ chartType: "line-break" }).chartType, "line-break");
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

test("settings normalization validates Point & Figure runtime options", () => {
  assert.deepEqual(
    {
      mode: normalizeSettings({ pointFigureBoxSizeMode: "traditional" }).pointFigureBoxSizeMode,
      atr: normalizeSettings({ pointFigureAtrLength: 21 }).pointFigureAtrLength,
      box: normalizeSettings({ pointFigureBoxSize: 25.5 }).pointFigureBoxSize,
      reversal: normalizeSettings({ pointFigureReversalAmount: 5 }).pointFigureReversalAmount,
    },
    { mode: "traditional", atr: 21, box: 25.5, reversal: 5 },
  );
  const fallback = normalizeSettings({
    pointFigureBoxSizeMode: "unknown",
    pointFigureAtrLength: 1,
    pointFigureBoxSize: 0,
    pointFigureReversalAmount: 0,
  });
  assert.equal(fallback.pointFigureBoxSizeMode, "atr");
  assert.equal(fallback.pointFigureAtrLength, 14);
  assert.equal(fallback.pointFigureBoxSize, 1);
  assert.equal(fallback.pointFigureReversalAmount, 3);
});

test("settings normalization validates Kagi runtime options", () => {
  assert.deepEqual(
    {
      mode: normalizeSettings({ kagiReversalMode: "traditional" }).kagiReversalMode,
      atr: normalizeSettings({ kagiAtrLength: 21 }).kagiAtrLength,
      reversal: normalizeSettings({ kagiReversalAmount: 25.5 }).kagiReversalAmount,
    },
    { mode: "traditional", atr: 21, reversal: 25.5 },
  );
  const fallback = normalizeSettings({
    kagiReversalMode: "unknown",
    kagiAtrLength: 1,
    kagiReversalAmount: 0,
  });
  assert.equal(fallback.kagiReversalMode, "atr");
  assert.equal(fallback.kagiAtrLength, 14);
  assert.equal(fallback.kagiReversalAmount, 1);
});

test("settings normalization validates Line Break runtime options", () => {
  assert.equal(normalizeSettings({ lineBreakNumberOfLines: 5 }).lineBreakNumberOfLines, 5);
  assert.equal(normalizeSettings({ lineBreakNumberOfLines: 4.9 }).lineBreakNumberOfLines, 4);
  for (const value of [0, -1, 51, "invalid"]) {
    assert.equal(normalizeSettings({ lineBreakNumberOfLines: value }).lineBreakNumberOfLines, 3);
  }
});

test("settings storage and GC limits fail closed on malformed values", () => {
  assert.deepEqual(parseStoredSettings("{broken").cacheLimits, {
    minutes: 200000,
    hours: 50000,
    daily: 0,
  });

  const settings = normalizeSettings({
    cacheLimits: { minutes: -1, hours: "bad", daily: 100 },
    ephemeralCacheBars: -1,
    frontendCacheBudgetBytes: 1,
    sqliteStorageBudgetBytes: -5,
    storageRowLimitsEnabled: "yes",
  });
  assert.equal(settings.cacheLimits.minutes, 200000);
  assert.equal(settings.cacheLimits.hours, 50000);
  assert.equal(settings.cacheLimits.daily, 100);
  assert.equal(settings.ephemeralCacheBars, 86400);
  assert.equal(settings.frontendCacheBudgetBytes, 64 * 1024 * 1024);
  assert.equal(settings.sqliteStorageBudgetBytes, null);
  assert.equal(settings.storageRowLimitsEnabled, false);

  const coercionTraps = normalizeSettings({
    cacheLimits: { minutes: null, hours: false, daily: true },
    ephemeralCacheBars: true,
    frontendCacheBudgetBytes: "",
    sqliteStorageBudgetBytes: true,
  });
  assert.deepEqual(coercionTraps.cacheLimits, {
    minutes: 200000,
    hours: 50000,
    daily: 0,
  });
  assert.equal(coercionTraps.ephemeralCacheBars, 86400);
  assert.equal(coercionTraps.frontendCacheBudgetBytes, 64 * 1024 * 1024);
  assert.equal(coercionTraps.sqliteStorageBudgetBytes, null);
});
