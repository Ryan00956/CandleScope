import type { BacktestReport, BacktestRunRecord } from "./backtestTypes.js";

export interface BacktestApiClient {
  capabilities(signal?: AbortSignal): Promise<{ flags: Record<string, boolean> }>;
  listRuns(signal?: AbortSignal): Promise<BacktestRunRecord[]>;
  validate(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean }>;
  createRun(
    body: Record<string, unknown>,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<BacktestRunRecord>;
  getRun(runId: string, signal?: AbortSignal): Promise<BacktestRunRecord>;
  getReport(runId: string, signal?: AbortSignal): Promise<BacktestReport>;
  exportRun(runId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`backtest API ${response.status}`);
  }
  return (await response.json()) as T;
}

export function createBacktestApi(base = "/api/v1/backtests"): BacktestApiClient {
  return {
    async capabilities(signal) {
      return readJson(await fetch(`${base}/capabilities`, { signal }));
    },
    async listRuns(signal) {
      const payload = await readJson<{ runs: BacktestRunRecord[] }>(
        await fetch(`${base}/runs`, { signal }),
      );
      return payload.runs;
    },
    async validate(body, signal) {
      return readJson(
        await fetch(`${base}/runs/validate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        }),
      );
    },
    async createRun(body, idempotencyKey, signal) {
      return readJson(
        await fetch(`${base}/runs`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(body),
          signal,
        }),
      );
    },
    async getRun(runId, signal) {
      return readJson(await fetch(`${base}/runs/${encodeURIComponent(runId)}`, { signal }));
    },
    async getReport(runId, signal) {
      return readJson(
        await fetch(`${base}/runs/${encodeURIComponent(runId)}/report`, { signal }),
      );
    },
    async exportRun(runId, signal) {
      return readJson(
        await fetch(`${base}/runs/${encodeURIComponent(runId)}/export`, { signal }),
      );
    },
  };
}

export const defaultBacktestApi = createBacktestApi();
