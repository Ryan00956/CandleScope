import assert from "node:assert/strict";
import test from "node:test";

import {
  assertExportPixelBudget,
  buildDefaultWatermark,
  buildExportFilename,
  getExportExtension,
  getExportMimeType,
} from "../exportFilename.js";

test("export formats map to the expected extension and MIME type", () => {
  assert.deepEqual([
    [getExportExtension("png"), getExportMimeType("png")],
    [getExportExtension("jpeg"), getExportMimeType("jpeg")],
    [getExportExtension("webp"), getExportMimeType("webp")],
  ], [
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["webp", "image/webp"],
  ]);
});

test("export filenames sanitize metadata and use the selected extension", () => {
  const filename = buildExportFilename({
    prefix: "desk/chart",
    exchange: "binance",
    marketType: "spot",
    symbol: "BTC/USDT",
    interval: "1 h",
    scope: "main-pane",
    format: "jpeg",
    timestamp: new Date(2026, 6, 13, 9, 8, 7),
  });

  assert.equal(filename, "desk-chart-binance-spot-BTC-USDT-1-h-main-pane-20260713-090807.jpg");
});

test("default watermark includes venue, market, symbol, and interval", () => {
  assert.equal(buildDefaultWatermark({
    exchange: "binance",
    marketType: "futures",
    symbol: "BTCUSDT",
    interval: "1h",
  }), "CandleScope · binance Futures · BTCUSDT · 1h");
});

test("export pixel budget rejects oversized captures", () => {
  assert.equal(assertExportPixelBudget(1000, 500, 2), 2_000_000);
  assert.throws(
    () => assertExportPixelBudget(5000, 3000, 2),
    /导出尺寸过大/,
  );
});
