import { request } from "./api.js";
import { API_BASE } from "./apiConfig.js";
import { ApiPayloadError, isJsonRecord } from "./apiPayloadParsers.js";

export interface StorageInventoryFilters {
  exchange?: string;
  marketType?: string;
  symbol?: string;
  interval?: string;
  limit?: number;
}

export interface StorageInventoryRequestOptions {
  signal?: AbortSignal;
}

export interface StorageInventoryFileSnapshot {
  capturedAtMs: number;
  exists: boolean;
  fileSetStable: boolean;
  dbSizeBytes: number;
  walSizeBytes: number;
  shmSizeBytes: number;
  physicalSizeBytes: number;
  totalSizeBytes: number;
}

export interface StorageInventorySummary {
  totalSeries: number;
  totalRows: number;
  matchingSeries: number;
  matchingRows: number;
  returnedSeries: number;
  truncated: boolean;
}

export interface StorageInventorySeries {
  exchange: string;
  marketType: string;
  symbol: string;
  interval: string;
  earliestOpenMs: number | null;
  latestOpenMs: number | null;
  totalCount: number;
}

export interface StorageGapSample {
  exchange: string;
  marketType: string;
  symbol: string;
  interval: string;
  status: string;
  missingBars: number;
  firstSeenAtMs: number | null;
  lastCheckedAtMs: number | null;
}

export interface StorageIntegrityAvailable {
  available: true;
  reason: null;
  openGapCount: number;
  openGapByStatus: Record<string, number>;
  openGapAgeBuckets: Record<string, number>;
  oldestOpenGapAtMs: number | null;
  gapSamples: StorageGapSample[];
  sampleLimit: number;
}

export interface StorageIntegrityUnavailable {
  available: false;
  reason: string;
  openGapCount: null;
  openGapByStatus: Record<string, number>;
  openGapAgeBuckets: Record<string, number>;
  oldestOpenGapAtMs: null;
  gapSamples: StorageGapSample[];
  sampleLimit: number;
}

export type StorageIntegrity = StorageIntegrityAvailable | StorageIntegrityUnavailable;

export interface StorageInventoryResponse {
  mode: "live";
  readOnly: true;
  capturedAtMs: number;
  filters: {
    exchange: string | null;
    marketType: string | null;
    symbol: string | null;
    interval: string | null;
  };
  snapshot: StorageInventoryFileSnapshot;
  inventory: StorageInventorySummary;
  series: StorageInventorySeries[];
  integrity: StorageIntegrity;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isJsonRecord(value)) throw new ApiPayloadError(path, "expected an object");
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ApiPayloadError(path, "expected a string");
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ApiPayloadError(path, "expected a boolean");
  return value;
}

function expectNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ApiPayloadError(path, "expected a non-negative integer");
  }
  return value;
}

function expectNullableNonNegativeInteger(value: unknown, path: string): number | null {
  if (value === null) return null;
  return expectNonNegativeInteger(value, path);
}

function parseCountMap(value: unknown, path: string): Record<string, number> {
  const record = expectRecord(value, path);
  return Object.fromEntries(
    Object.entries(record).map(([key, count]) => [
      key,
      expectNonNegativeInteger(count, `${path}.${key}`),
    ]),
  );
}

function parseSeries(value: unknown, path: string): StorageInventorySeries {
  const item = expectRecord(value, path);
  return {
    exchange: expectString(item.exchange, `${path}.exchange`),
    marketType: expectString(item.market_type, `${path}.market_type`),
    symbol: expectString(item.symbol, `${path}.symbol`),
    interval: expectString(item.interval, `${path}.interval`),
    earliestOpenMs: expectNullableNonNegativeInteger(item.earliest_open_ms, `${path}.earliest_open_ms`),
    latestOpenMs: expectNullableNonNegativeInteger(item.latest_open_ms, `${path}.latest_open_ms`),
    totalCount: expectNonNegativeInteger(item.total_count, `${path}.total_count`),
  };
}

function parseGapSample(value: unknown, path: string): StorageGapSample {
  const item = expectRecord(value, path);
  return {
    exchange: expectString(item.exchange, `${path}.exchange`),
    marketType: expectString(item.market_type, `${path}.market_type`),
    symbol: expectString(item.symbol, `${path}.symbol`),
    interval: expectString(item.interval, `${path}.interval`),
    status: expectString(item.status, `${path}.status`),
    missingBars: expectNonNegativeInteger(item.missing_bars, `${path}.missing_bars`),
    firstSeenAtMs: expectNullableNonNegativeInteger(item.first_seen_at_ms, `${path}.first_seen_at_ms`),
    lastCheckedAtMs: expectNullableNonNegativeInteger(item.last_checked_at_ms, `${path}.last_checked_at_ms`),
  };
}

function parseIntegrity(value: unknown): StorageIntegrity {
  const record = expectRecord(value, "storageInventory.integrity");
  const available = expectBoolean(record.available, "storageInventory.integrity.available");
  if (!available) {
    return {
      available: false,
      reason: expectString(record.reason, "storageInventory.integrity.reason"),
      openGapCount: null,
      openGapByStatus: {},
      openGapAgeBuckets: {},
      oldestOpenGapAtMs: null,
      gapSamples: [],
      sampleLimit: 0,
    };
  }
  if (!Array.isArray(record.gap_samples)) {
    throw new ApiPayloadError("storageInventory.integrity.gap_samples", "expected an array");
  }
  return {
    available: true,
    reason: null,
    openGapCount: expectNonNegativeInteger(record.open_gap_count, "storageInventory.integrity.open_gap_count"),
    openGapByStatus: parseCountMap(record.open_gap_by_status, "storageInventory.integrity.open_gap_by_status"),
    openGapAgeBuckets: parseCountMap(record.open_gap_age_buckets, "storageInventory.integrity.open_gap_age_buckets"),
    oldestOpenGapAtMs: expectNullableNonNegativeInteger(
      record.oldest_open_gap_at_ms,
      "storageInventory.integrity.oldest_open_gap_at_ms",
    ),
    gapSamples: record.gap_samples.map((entry, index) =>
      parseGapSample(entry, `storageInventory.integrity.gap_samples[${index}]`)
    ),
    sampleLimit: expectNonNegativeInteger(record.sample_limit, "storageInventory.integrity.sample_limit"),
  };
}

export function parseStorageInventoryResponse(value: unknown): StorageInventoryResponse {
  const record = expectRecord(value, "storageInventory");
  if (record.mode !== "live") {
    throw new ApiPayloadError("storageInventory.mode", "expected a live backend response");
  }
  if (record.read_only !== true) {
    throw new ApiPayloadError("storageInventory.read_only", "expected true");
  }
  const filters = expectRecord(record.filters, "storageInventory.filters");
  const snapshot = expectRecord(record.snapshot, "storageInventory.snapshot");
  const inventory = expectRecord(record.inventory, "storageInventory.inventory");
  if (!Array.isArray(record.series)) {
    throw new ApiPayloadError("storageInventory.series", "expected an array");
  }
  return {
    mode: "live",
    readOnly: true,
    capturedAtMs: expectNonNegativeInteger(record.captured_at_ms, "storageInventory.captured_at_ms"),
    filters: {
      exchange: expectNullableString(filters.exchange, "storageInventory.filters.exchange"),
      marketType: expectNullableString(filters.market_type, "storageInventory.filters.market_type"),
      symbol: expectNullableString(filters.symbol, "storageInventory.filters.symbol"),
      interval: expectNullableString(filters.interval, "storageInventory.filters.interval"),
    },
    snapshot: {
      capturedAtMs: expectNonNegativeInteger(snapshot.captured_at_ms, "storageInventory.snapshot.captured_at_ms"),
      exists: expectBoolean(snapshot.exists, "storageInventory.snapshot.exists"),
      fileSetStable: expectBoolean(snapshot.file_set_stable, "storageInventory.snapshot.file_set_stable"),
      dbSizeBytes: expectNonNegativeInteger(snapshot.db_size_bytes, "storageInventory.snapshot.db_size_bytes"),
      walSizeBytes: expectNonNegativeInteger(snapshot.wal_size_bytes, "storageInventory.snapshot.wal_size_bytes"),
      shmSizeBytes: expectNonNegativeInteger(snapshot.shm_size_bytes, "storageInventory.snapshot.shm_size_bytes"),
      physicalSizeBytes: expectNonNegativeInteger(snapshot.physical_size_bytes, "storageInventory.snapshot.physical_size_bytes"),
      totalSizeBytes: expectNonNegativeInteger(snapshot.total_size_bytes, "storageInventory.snapshot.total_size_bytes"),
    },
    inventory: {
      totalSeries: expectNonNegativeInteger(inventory.total_series, "storageInventory.inventory.total_series"),
      totalRows: expectNonNegativeInteger(inventory.total_rows, "storageInventory.inventory.total_rows"),
      matchingSeries: expectNonNegativeInteger(inventory.matching_series, "storageInventory.inventory.matching_series"),
      matchingRows: expectNonNegativeInteger(inventory.matching_rows, "storageInventory.inventory.matching_rows"),
      returnedSeries: expectNonNegativeInteger(inventory.returned_series, "storageInventory.inventory.returned_series"),
      truncated: expectBoolean(inventory.truncated, "storageInventory.inventory.truncated"),
    },
    series: record.series.map((entry, index) => parseSeries(entry, `storageInventory.series[${index}]`)),
    integrity: parseIntegrity(record.integrity),
  };
}

function expectNullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return expectString(value, path);
}

function buildUrl(filters: StorageInventoryFilters): string {
  const query = new URLSearchParams();
  if (filters.exchange) query.set("exchange", filters.exchange);
  if (filters.marketType) query.set("market_type", filters.marketType);
  if (filters.symbol) query.set("symbol", filters.symbol);
  if (filters.interval) query.set("interval", filters.interval);
  if (filters.limit !== undefined) query.set("limit", String(filters.limit));
  const params = query.toString();
  return `${API_BASE}/settings/storage/inventory${params ? `?${params}` : ""}`;
}

export async function fetchStorageInventory(
  filters: StorageInventoryFilters = {},
  { signal }: StorageInventoryRequestOptions = {},
): Promise<StorageInventoryResponse> {
  const raw = await request(buildUrl(filters), signal === undefined ? {} : { signal });
  return parseStorageInventoryResponse(raw);
}
