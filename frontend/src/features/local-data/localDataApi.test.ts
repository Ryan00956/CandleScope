import assert from "node:assert/strict";
import test from "node:test";

import {
  computeLocalIndicatorBatch,
  fetchLocalIndicatorPresets,
  listLocalDatasets,
  LocalKlineApi,
  resolveLocalEventTimes,
} from "./localDataApi.js";
import { toEpochSeconds } from "../market-data/marketDataTypes.js";
import type { LocalDatasetManifest } from "./localDataTypes.js";


function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function manifest(): LocalDatasetManifest {
  return {
    schema_version: 1,
    dataset_id: "local-0123456789abcdef0123456789abcdef",
    data_epoch: `sha256:${"a".repeat(64)}`,
    name: "BTC sample",
    source: "local_dataset",
    symbol: "BTC-USDT",
    interval: "1m",
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
    imported_at: "2026-08-05T00:00:00+00:00",
  };
}

test("local dataset library validates manifests", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let capturedUrl = "";
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return jsonResponse({ datasets: [manifest()], count: 1 });
  };

  const datasets = await listLocalDatasets();

  assert.equal(capturedUrl, "/api/v1/local/datasets");
  assert.equal(datasets[0]?.source, "local_dataset");
  assert.equal(datasets[0]?.rows, 2);
  assert.equal(datasets[0]?.volume_available, true);
});

test("local indicator catalog uses the shared preset wire contract", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let capturedUrl = "";
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return jsonResponse([{
      id: "atr",
      name: "Average True Range",
      engineName: "ATR",
      script: "# __ENGINE__:ATR",
      params: { period: 14 },
      description: "ATR",
      category: "volatility",
      paramSchema: [{ key: "period", label: "Period", type: "int", default: 14 }],
      outputs: ["ATR"],
      is_builtin: true,
      defaultEnabled: false,
      paneTarget: "sub",
    }]);
  };

  const presets = await fetchLocalIndicatorPresets();
  assert.match(capturedUrl, /\/api\/v1\/local\/indicators\/presets$/);
  assert.equal(presets[0]?.engineName, "ATR");
});

test("local kline adapter uses dataset-scoped HTTP and exposes no stream URL", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let capturedUrl = "";
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return jsonResponse({
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
    });
  };
  const api = new LocalKlineApi("local-0123456789abcdef0123456789abcdef");

  const result = await api.fetchKlinesHistory(
    "BTC-USDT",
    "1m",
    null,
    "local",
    "local",
    { countBack: 500 },
  );

  assert.match(capturedUrl, /^\/api\/v1\/local\/datasets\/local-[a-f0-9]+\/klines\/history\?/);
  assert.match(capturedUrl, /count_back=500/);
  assert.equal(result.data?.[0]?.time, toEpochSeconds(1_704_067_200));
  assert.equal(result.retryable, false);
  assert.equal(api.getMultiStreamUrl(), "");
});

test("local kline adapter omits volume when the dataset marks it unavailable", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => jsonResponse({
    source: "local_dataset",
    volume_available: false,
    data: [{
      time: 1_704_067_200,
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: null,
      is_closed: true,
    }],
    has_more: false,
  });
  const api = new LocalKlineApi("local-0123456789abcdef0123456789abcdef");

  const result = await api.fetchLatestKlines(
    "BTC-USDT",
    "1m",
    10,
    "local",
    "local",
    "local",
    {},
  );

  assert.equal(Object.hasOwn(result.data?.[0] ?? {}, "volume"), false);
});

test("event time resolution posts immutable identity and validates ordered results", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let requestBody: unknown;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return jsonResponse({
      dataset_id: manifest().dataset_id,
      data_epoch: manifest().data_epoch,
      mode: "containing",
      matched: 1,
      rejected: 1,
      results: [
        {
          input_index: 0,
          input_time_ms: 1_704_067_230_000,
          matched: true,
          bar_open_ms: 1_704_067_200_000,
          bar_close_ms: 1_704_067_259_999,
          delta_ms: 30_000,
        },
        { input_index: 1, input_time_ms: 1_704_067_500_000, matched: false },
      ],
    });
  };

  const result = await resolveLocalEventTimes(
    manifest(),
    [1_704_067_230_000, 1_704_067_500_000],
    "containing",
  );

  assert.deepEqual(requestBody, {
    data_epoch: manifest().data_epoch,
    times_ms: [1_704_067_230_000, 1_704_067_500_000],
    mode: "containing",
  });
  assert.equal(result.results[0]?.bar_open_ms, 1_704_067_200_000);
  assert.equal(result.results[1]?.matched, false);
});

test("local indicator compute sends identities and params without browser OHLCV", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({
      schemaVersion: 1,
      type: "local.indicator.compute_batch",
      source: "local_dataset",
      dataset_id: manifest().dataset_id,
      data_epoch: manifest().data_epoch,
      interval: "5m",
      ok: true,
      results: [{
        clientId: "local-ma-one",
        jobKey: "ma-job-one",
        payload: {
          schemaVersion: 1,
          ok: true,
          error: null,
          lines: [{
            name: "MA(3)",
            pane: "main",
            data: [{ time: 1_704_067_320, value: 102 }],
          }],
        },
      }],
    });
  };

  const result = await computeLocalIndicatorBatch(manifest(), [{
    clientId: "local-ma-one",
    jobKey: "ma-job-one",
    name: "MA",
    params: { period: 3, source: "close" },
  }], "5m");

  assert.equal(Object.hasOwn(requestBody, "ohlcv"), false);
  assert.equal(requestBody.data_epoch, manifest().data_epoch);
  assert.equal(requestBody.interval, "5m");
  assert.deepEqual(requestBody.requests, [{
    clientId: "local-ma-one",
    jobKey: "ma-job-one",
    name: "MA",
    params: { period: 3, source: "close" },
  }]);
  assert.equal(result.results[0]?.payload.lines[0]?.data[0]?.value, 102);
});
