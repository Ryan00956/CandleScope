import { request } from "./api.js";
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

export async function fetchManualHistoryCapabilities(signal?: AbortSignal): Promise<Record<string, unknown>> {
  return request(`${API_BASE}/settings/storage/manual-downloads/capabilities`, { signal });
}

export async function planManualHistoryDownload(
  body: ManualHistoryPlanRequest,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return request(`${API_BASE}/settings/storage/manual-downloads/plan`, {
    method: "POST",
    body: JSON.stringify(toPayload(body)),
    signal,
  });
}

export async function createManualHistoryDownload(
  body: ManualHistoryCreateRequest,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return request(`${API_BASE}/settings/storage/manual-downloads`, {
    method: "POST",
    body: JSON.stringify({
      ...toPayload(body),
      plan_hash: body.planHash,
      idempotency_key: body.idempotencyKey,
    }),
    signal,
  });
}

export async function getManualHistoryJob(jobId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return request(`${API_BASE}/settings/storage/manual-downloads/${encodeURIComponent(jobId)}`, { signal });
}

export async function cancelManualHistoryJob(jobId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return request(`${API_BASE}/settings/storage/manual-downloads/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    signal,
  });
}
