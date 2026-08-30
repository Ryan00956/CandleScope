import { request, type ApiRequestOptions } from "./api.js";
import { API_BASE } from "./apiConfig.js";

export interface ManualHistoryPlanRequest {
  exchange: string;
  marketType: string;
  symbols: string[];
  intervals: string[];
  startMs: number;
}

export interface ManualHistoryCreateRequest extends ManualHistoryPlanRequest {
  planHash: string;
  idempotencyKey: string;
}

function toPayload(body: ManualHistoryPlanRequest): Record<string, unknown> {
  return {
    exchange: body.exchange,
    market_type: body.marketType,
    symbols: body.symbols,
    intervals: body.intervals,
    start_ms: body.startMs,
  };
}

function optionalSignal(signal: AbortSignal | undefined): ApiRequestOptions {
  return signal === undefined ? {} : { signal };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function fetchManualHistoryCapabilities(signal?: AbortSignal): Promise<Record<string, unknown>> {
  return asRecord(await request(
    `${API_BASE}/settings/storage/manual-downloads/capabilities`,
    optionalSignal(signal),
  ));
}

export async function planManualHistoryDownload(
  body: ManualHistoryPlanRequest,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return asRecord(await request(`${API_BASE}/settings/storage/manual-downloads/plan`, {
    method: "POST",
    body: JSON.stringify(toPayload(body)),
    ...optionalSignal(signal),
  }));
}

export async function createManualHistoryDownload(
  body: ManualHistoryCreateRequest,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return asRecord(await request(`${API_BASE}/settings/storage/manual-downloads`, {
    method: "POST",
    body: JSON.stringify({
      ...toPayload(body),
      plan_hash: body.planHash,
      idempotency_key: body.idempotencyKey,
    }),
    ...optionalSignal(signal),
  }));
}

export async function getManualHistoryJob(jobId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return asRecord(await request(
    `${API_BASE}/settings/storage/manual-downloads/${encodeURIComponent(jobId)}`,
    optionalSignal(signal),
  ));
}

export async function cancelManualHistoryJob(jobId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return asRecord(await request(
    `${API_BASE}/settings/storage/manual-downloads/${encodeURIComponent(jobId)}/cancel`,
    {
      method: "POST",
      ...optionalSignal(signal),
    },
  ));
}

export async function listManualHistoryJobs(signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  const payload = asRecord(await request(
    `${API_BASE}/settings/storage/manual-downloads?limit=50`,
    optionalSignal(signal),
  ));
  return Array.isArray(payload.jobs) ? payload.jobs.map(asRecord) : [];
}

export async function listManualHistoryCollections(signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  const payload = asRecord(await request(
    `${API_BASE}/settings/storage/manual-downloads/collections`,
    optionalSignal(signal),
  ));
  return Array.isArray(payload.collections) ? payload.collections.map(asRecord) : [];
}

export async function releaseManualHistoryCollection(
  collectionId: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return asRecord(await request(
    `${API_BASE}/settings/storage/manual-downloads/collections/${encodeURIComponent(collectionId)}/release`,
    {
      method: "POST",
      ...optionalSignal(signal),
    },
  ));
}
