import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  computeLocalIndicatorBatch,
  LocalKlineApi,
} from "../../local-data/localDataApi.js";
import type { LocalDatasetManifest } from "../../local-data/localDataTypes.js";
import { toEpochSeconds } from "../../market-data/marketDataTypes.js";


const here = path.dirname(fileURLToPath(import.meta.url));

const FORBIDDEN_ONLINE_URL = /\/api\/v1\/(?:klines|symbols|exchanges)(?:\/|$)/i;
const LOCAL_ALLOWLIST = /^\/api\/v1\/local(?:\/|$)/;

const IMPORTED_SURFACE_FILES = [
  "../StrategyResearchChart.tsx",
  "../StrategyResearchApp.tsx",
  "../../local-data/useLocalChartRuntime.ts",
  "../../local-data/useLocalIndicatorRuntime.ts",
];

function manifest(): LocalDatasetManifest {
  return {
    schema_version: 1,
    dataset_id: "local-0123456789abcdef0123456789abcdef",
    data_epoch: `sha256:${"a".repeat(64)}`,
    name: "BTC sample",
    source: "local_dataset",
    symbol: "BTC-USDT",
    interval: "15m",
    alignment: "fixed_epoch",
    alignment_offset_ms: 0,
    volume_available: true,
    timezone: "UTC",
    timestamp_semantics: "bar_open",
    rows: 2,
    first_open_ms: 1_704_067_200_000,
    last_open_ms: 1_704_067_260_000,
    all_rows_final: true,
    excluded_range_count: 0,
    sqlite_sha256: "b".repeat(64),
    imported_at: "2026-08-25T00:00:00+00:00",
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function localKlinePayload() {
  return {
    source: "local_dataset",
    data: [{
      time: 1_704_067_200,
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 10,
      is_closed: true,
    }],
    has_more: false,
    complete: true,
    retryable: false,
    history_state: "exhausted",
    terminal_reason: "dataset_boundary",
    missing_ranges: [],
    excluded_ranges: [],
  };
}

test("imported chart and indicator sources never import online kline, stream, or indicator fallbacks", () => {
  for (const relative of IMPORTED_SURFACE_FILES) {
    const source = readFileSync(path.resolve(here, relative), "utf8");
    assert.doesNotMatch(source, /from "\.\.\/market-data\/feed\/klineApi/);
    assert.doesNotMatch(source, /from "\.\.\/\.\.\/services\/api(?:\.js)?"/);
    assert.doesNotMatch(source, /getKlines/);
    assert.doesNotMatch(source, FORBIDDEN_ONLINE_URL);
    assert.doesNotMatch(source, /wss?:\/\//);
    assert.doesNotMatch(source, /WebSocket/);
  }
  const chartRuntime = readFileSync(path.resolve(here, "../../local-data/useLocalChartRuntime.ts"), "utf8");
  assert.match(chartRuntime, /new LocalKlineApi/);
  assert.match(chartRuntime, /SeriesDataFeed/);
  assert.match(chartRuntime, /SeriesWindowStore/);
  assert.doesNotMatch(chartRuntime, /subscribeBars/);
  const indicatorRuntime = readFileSync(path.resolve(here, "../../local-data/useLocalIndicatorRuntime.ts"), "utf8");
  assert.match(indicatorRuntime, /computeLocalIndicatorBatch/);
  assert.doesNotMatch(indicatorRuntime, /\bohlcv\b/);
});

test("LocalKlineApi and local indicator compute stay on the /api/v1/local allowlist", async (context) => {
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    seen.push(href);
    assert.match(href, LOCAL_ALLOWLIST);
    assert.doesNotMatch(href, FORBIDDEN_ONLINE_URL);
    assert.doesNotMatch(href, /\/stream/i);
    if (href.includes("/indicators/compute/batch")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(Object.hasOwn(body, "ohlcv"), false);
      assert.equal(body.data_epoch, manifest().data_epoch);
      return jsonResponse({
        schemaVersion: 1,
        type: "local.indicator.compute_batch",
        source: "local_dataset",
        dataset_id: manifest().dataset_id,
        data_epoch: manifest().data_epoch,
        interval: "30m",
        ok: true,
        results: [{
          clientId: "local-ma-one",
          jobKey: "ma-job-one",
          payload: {
            schemaVersion: 1,
            ok: true,
            error: null,
            lines: [],
          },
        }],
      });
    }
    return jsonResponse(localKlinePayload());
  };

  const api = new LocalKlineApi(manifest().dataset_id);
  assert.equal(api.getMultiStreamUrl(), "");
  const start = toEpochSeconds(1_704_067_200);
  const end = toEpochSeconds(1_704_070_000);
  assert.ok(start);
  assert.ok(end);
  await api.fetchKlinesHistory("BTC-USDT", "15m", null, "spot", "binance", { countBack: 200 });
  await api.fetchKlinesBefore("BTC-USDT", "30m", start, 100, "spot", "binance", {});
  await api.fetchKlinesRange("BTC-USDT", "1h", start, end, "spot", "binance", {});
  await computeLocalIndicatorBatch(manifest(), [{
    clientId: "local-ma-one",
    jobKey: "ma-job-one",
    name: "MA",
    params: { period: 3 },
  }], "30m");

  assert.equal(seen.length, 4);
  for (const href of seen) {
    assert.doesNotMatch(href, /\/stream/i);
    assert.doesNotMatch(href, /wss?:\/\//i);
    assert.match(href, /\/api\/v1\/local\/datasets\/local-[a-f0-9]+/);
  }
});
