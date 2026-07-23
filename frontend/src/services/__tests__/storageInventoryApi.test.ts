import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchStorageInventory,
  parseStorageInventoryResponse,
} from "../storageInventoryApi.js";
import { ApiPayloadError } from "../apiPayloadParsers.js";

function livePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ok",
    mode: "live",
    read_only: true,
    captured_at_ms: 1_700_000_400_000,
    filters: {
      exchange: "binance",
      market_type: "spot",
      symbol: null,
      interval: null,
    },
    snapshot: {
      captured_at_ms: 1_700_000_400_000,
      exists: true,
      file_set_stable: true,
      db_size_bytes: 123,
      wal_size_bytes: 45,
      shm_size_bytes: 67,
      physical_size_bytes: 168,
      total_size_bytes: 235,
    },
    inventory: {
      total_series: 2,
      total_rows: 28,
      matching_series: 2,
      matching_rows: 28,
      returned_series: 2,
      truncated: false,
    },
    series: [{
      exchange: "binance",
      market_type: "spot",
      symbol: "BTCUSDT",
      interval: "1m",
      earliest_open_ms: 1_700_000_000_000,
      latest_open_ms: 1_700_000_060_000,
      total_count: 20,
    }],
    integrity: {
      available: true,
      open_gap_count: 1,
      open_gap_by_status: { partial: 1 },
      open_gap_age_buckets: { from_1h_to_1d: 1 },
      oldest_open_gap_at_ms: 1_700_000_010_000,
      gap_samples: [{
        exchange: "binance",
        market_type: "spot",
        symbol: "BTCUSDT",
        interval: "1m",
        status: "partial",
        missing_bars: 3,
        first_seen_at_ms: 1_700_000_010_000,
        last_checked_at_ms: 1_700_000_020_000,
      }],
      sample_limit: 50,
    },
    ...overrides,
  };
}

test("storage inventory accepts only a live read-only response and maps its fields", () => {
  const parsed = parseStorageInventoryResponse(livePayload());

  assert.equal(parsed.mode, "live");
  assert.equal(parsed.readOnly, true);
  assert.equal(parsed.snapshot.fileSetStable, true);
  assert.equal(parsed.inventory.totalRows, 28);
  assert.deepEqual(parsed.series[0], {
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    interval: "1m",
    earliestOpenMs: 1_700_000_000_000,
    latestOpenMs: 1_700_000_060_000,
    totalCount: 20,
  });
  assert.equal(parsed.integrity.available, true);
  assert.equal(parsed.integrity.openGapCount, 1);
});

test("storage inventory rejects mock or writable payloads", () => {
  assert.throws(
    () => parseStorageInventoryResponse(livePayload({ mode: "mock" })),
    ApiPayloadError,
  );
  assert.throws(
    () => parseStorageInventoryResponse(livePayload({ read_only: false })),
    ApiPayloadError,
  );
});

test("storage inventory forwards filters and an AbortSignal", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  let capturedUrl = "";
  let capturedOptions: RequestInit | undefined;
  globalThis.fetch = async (url, options) => {
    capturedUrl = String(url);
    capturedOptions = options;
    return new Response(JSON.stringify(livePayload()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await fetchStorageInventory({
    exchange: "binance",
    marketType: "spot",
    symbol: "BTCUSDT",
    interval: "1m",
    limit: 120,
  }, { signal: controller.signal });

  const params = new URL(capturedUrl, "http://localhost").searchParams;
  assert.equal(params.get("exchange"), "binance");
  assert.equal(params.get("market_type"), "spot");
  assert.equal(params.get("symbol"), "BTCUSDT");
  assert.equal(params.get("interval"), "1m");
  assert.equal(params.get("limit"), "120");
  assert.equal(capturedOptions?.signal, controller.signal);
});
