import {
  fetchKlinesBefore as fetchTransportKlinesBefore,
  fetchKlinesHistory as fetchTransportKlinesHistory,
  fetchKlinesHistoryBatch as fetchTransportKlinesHistoryBatch,
  fetchKlinesRange as fetchTransportKlinesRange,
  fetchLatestKlines as fetchTransportLatestKlines,
  getMultiStreamUrl,
} from "../../../services/api.js";
import type { TransportKlineResponse } from "../../../services/apiPayloadParsers.js";
import type {
  HistoryAvailabilityState,
  HistoryExcludedRange,
  HistoryMissingRange,
  KlineApi,
  KlineBeforeRequestOptions,
  KlineFetchResult,
  KlineHistoryRequestOptions,
  KlineHistoryBatchOutcome,
  KlineHistoryBatchRequest,
  KlineRangeRequestOptions,
  KlineRequestOptions,
} from "../klineContracts.js";
import {
  toEpochSeconds,
  type EpochSeconds,
  type KlineBar,
} from "../marketDataTypes.js";
import type { IntervalString } from "../../../utils/intervals.js";

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean`);
  return value;
}

function optionalNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${field} must be a string or null`);
  return value;
}

function optionalNullableNonNegativeNumber(
  value: unknown,
  field: string,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative finite number or null`);
  }
  return value;
}

function optionalHistoryState(value: unknown): HistoryAvailabilityState | undefined {
  if (value === undefined) return undefined;
  if (value === "ready" || value === "pending" || value === "exhausted") return value;
  throw new TypeError("history_state must be ready, pending, or exhausted");
}

function optionalExcludedRanges(value: unknown): HistoryExcludedRange[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("excluded_ranges must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`excluded_ranges[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const startMs = optionalNullableNonNegativeNumber(
      record.start_ms,
      `excluded_ranges[${index}].start_ms`,
    );
    const endMs = optionalNullableNonNegativeNumber(
      record.end_ms,
      `excluded_ranges[${index}].end_ms`,
    );
    if (startMs == null || endMs == null || endMs < startMs) {
      throw new TypeError(`excluded_ranges[${index}] must contain a valid start_ms/end_ms range`);
    }
    const reason = optionalNullableString(record.reason, `excluded_ranges[${index}].reason`);
    const retryAtMs = optionalNullableNonNegativeNumber(
      record.retry_at_ms,
      `excluded_ranges[${index}].retry_at_ms`,
    );
    return {
      ...record,
      start_ms: startMs,
      end_ms: endMs,
      ...(reason == null ? {} : { reason }),
      ...(retryAtMs === undefined ? {} : { retry_at_ms: retryAtMs }),
    };
  });
}

function optionalMissingRanges(value: unknown): HistoryMissingRange[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("missing_ranges must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`missing_ranges[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const startMs = optionalNullableNonNegativeNumber(
      record.start_ms,
      `missing_ranges[${index}].start_ms`,
    );
    const endMs = optionalNullableNonNegativeNumber(
      record.end_ms,
      `missing_ranges[${index}].end_ms`,
    );
    if (startMs == null || endMs == null || endMs < startMs) {
      throw new TypeError(`missing_ranges[${index}] must contain a valid start_ms/end_ms range`);
    }
    const reason = optionalNullableString(record.reason, `missing_ranges[${index}].reason`);
    return {
      ...record,
      start_ms: startMs,
      end_ms: endMs,
      ...(reason == null ? {} : { reason }),
    };
  });
}

function toMarketDataResult(result: TransportKlineResponse): KlineFetchResult {
  const data: KlineBar[] = result.data.map((row) => {
    const time = toEpochSeconds(row.time);
    if (time === null) throw new TypeError("Validated kline time could not be converted to EpochSeconds");
    return { ...row, time };
  });
  const historyState = optionalHistoryState(result.history_state);
  const complete = optionalBoolean(result.complete, "complete");
  const retryable = optionalBoolean(result.retryable, "retryable");
  const terminalReason = optionalNullableString(result.terminal_reason, "terminal_reason");
  const earliestAvailableMs = optionalNullableNonNegativeNumber(
    result.earliest_available_ms,
    "earliest_available_ms",
  );
  const nextBeforeMs = optionalNullableNonNegativeNumber(result.next_before_ms, "next_before_ms");
  const availabilityRevision = optionalNullableString(
    result.availability_revision,
    "availability_revision",
  );
  const retryAtMs = optionalNullableNonNegativeNumber(result.retry_at_ms, "retry_at_ms");
  const excludedRanges = optionalExcludedRanges(result.excluded_ranges);
  const missingRanges = optionalMissingRanges(result.missing_ranges);
  const verifiedContiguous = optionalBoolean(result.verified_contiguous, "verified_contiguous");
  return {
    ...result,
    data,
    ...(historyState === undefined ? {} : { history_state: historyState }),
    ...(complete === undefined ? {} : { complete }),
    ...(retryable === undefined ? {} : { retryable }),
    ...(terminalReason === undefined ? {} : { terminal_reason: terminalReason }),
    ...(earliestAvailableMs === undefined ? {} : { earliest_available_ms: earliestAvailableMs }),
    ...(nextBeforeMs === undefined ? {} : { next_before_ms: nextBeforeMs }),
    ...(availabilityRevision === undefined ? {} : { availability_revision: availabilityRevision }),
    ...(retryAtMs === undefined ? {} : { retry_at_ms: retryAtMs }),
    ...(excludedRanges === undefined ? {} : { excluded_ranges: excludedRanges }),
    ...(missingRanges === undefined ? {} : { missing_ranges: missingRanges }),
    ...(verifiedContiguous === undefined ? {} : { verified_contiguous: verifiedContiguous }),
  };
}

async function fetchKlinesHistory(
  symbol: string,
  interval: IntervalString,
  days: number | null | undefined,
  marketType: string,
  exchange: string,
  options: KlineHistoryRequestOptions,
): Promise<KlineFetchResult> {
  return toMarketDataResult(await fetchTransportKlinesHistory(
    symbol,
    interval,
    days,
    marketType,
    exchange,
    options,
  ));
}

async function fetchKlinesHistoryBatch(
  requests: readonly KlineHistoryBatchRequest[],
  options: { signal?: AbortSignal },
): Promise<KlineHistoryBatchOutcome[]> {
  const outcomes = await fetchTransportKlinesHistoryBatch(requests, options);
  return outcomes.map((outcome) => outcome.ok
    ? { ok: true, result: toMarketDataResult(outcome.result) }
    : outcome);
}

async function fetchKlinesBefore(
  symbol: string,
  interval: IntervalString,
  before: EpochSeconds | undefined,
  bars: number,
  marketType: string,
  exchange: string,
  options: KlineBeforeRequestOptions,
): Promise<KlineFetchResult> {
  return toMarketDataResult(await fetchTransportKlinesBefore(
    symbol,
    interval,
    before ?? 0,
    bars,
    marketType,
    exchange,
    options,
  ));
}

async function fetchKlinesRange(
  symbol: string,
  interval: IntervalString,
  start: EpochSeconds,
  end: EpochSeconds,
  marketType: string,
  exchange: string,
  options: KlineRangeRequestOptions,
): Promise<KlineFetchResult> {
  return toMarketDataResult(await fetchTransportKlinesRange(
    symbol,
    interval,
    start,
    end,
    marketType,
    exchange,
    options,
  ));
}

async function fetchLatestKlines(
  symbol: string,
  interval: IntervalString,
  limit: number,
  marketType: string,
  exchange: string,
  source: string,
  options: KlineRequestOptions,
): Promise<KlineFetchResult> {
  return toMarketDataResult(await fetchTransportLatestKlines(
    symbol,
    interval,
    limit,
    marketType,
    exchange,
    source,
    options,
  ));
}

export const defaultKlineApi = {
  fetchKlinesHistory,
  fetchKlinesHistoryBatch,
  fetchKlinesBefore,
  fetchKlinesRange,
  fetchLatestKlines,
  getMultiStreamUrl,
} satisfies KlineApi;
