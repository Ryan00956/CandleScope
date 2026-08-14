import type {
  BacktestReport,
  BacktestChartData,
  BacktestRunRecord,
  BacktestStudyComparison,
  BacktestStudyRecord,
} from "./backtestTypes.js";

export interface BacktestStrategyDescriptor {
  revision_id: string;
  provider_kind: string;
  label: string;
  description: string;
  input_modes: string[];
  output_modes: string[];
  signal_clock: string;
  required_features: string[];
  warmup_requirement: Record<string, unknown>;
  parameter_schema: Array<Record<string, unknown>>;
  accepts_source: boolean;
}

export interface BacktestCapabilities {
  flags: Record<string, boolean>;
  fidelity_modes: string[];
  strategies: BacktestStrategyDescriptor[];
}

export interface BacktestApiClient {
  capabilities(signal?: AbortSignal): Promise<BacktestCapabilities>;
  listDatasets(signal?: AbortSignal): Promise<BacktestDataset[]>;
  previewSnapshot(
    body: SnapshotPreviewRequest,
    signal?: AbortSignal,
  ): Promise<BacktestSnapshot>;
  listRuns(signal?: AbortSignal): Promise<BacktestRunRecord[]>;
  validate(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean }>;
  createRun(
    body: Record<string, unknown>,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<BacktestRunRecord>;
  getRun(runId: string, signal?: AbortSignal): Promise<BacktestRunRecord>;
  getReport(runId: string, signal?: AbortSignal): Promise<BacktestReport>;
  getChart(runId: string, signal?: AbortSignal): Promise<BacktestChartData>;
  exportRun(runId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  cancelRun(runId: string, signal?: AbortSignal): Promise<BacktestRunRecord>;
  listStudies(signal?: AbortSignal): Promise<BacktestStudyRecord[]>;
  createStudy(body: Record<string, unknown>, signal?: AbortSignal): Promise<BacktestStudyRecord>;
  startStudy(studyId: string, signal?: AbortSignal): Promise<BacktestStudyRecord>;
  cancelStudy(studyId: string, signal?: AbortSignal): Promise<BacktestStudyRecord>;
  compareStudy(studyId: string, signal?: AbortSignal): Promise<BacktestStudyComparison>;
}

export interface BacktestDataset {
  dataset_id: string;
  data_epoch: string;
  name: string;
  symbol: string;
  interval: string;
  rows: number;
  first_open_ms: number | null;
  last_close_ms: number | null;
  strategy_revisions: string[];
  contract_history?: {
    bundle_hash: string;
    roles: string[];
  };
}

export interface SnapshotPreviewRequest {
  dataset_id: string;
  data_epoch: string;
  start_time_ms: number;
  end_time_ms: number;
  interval?: string;
  fidelity_mode?: string;
  exchange?: string;
  market_type?: string;
  contract_data_mode?: string;
}

export interface BacktestSnapshot {
  data_epoch: string;
  snapshot_hash: string;
  coverage_start_ms: number;
  coverage_end_ms: number;
  row_count: number;
  market_row_count?: number;
  quality: Record<string, unknown>;
  role_hashes?: Record<string, string>;
  fidelity_capabilities: string[];
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    const detail = payload?.error;
    throw new Error(
      detail?.code && detail.message
        ? `${detail.code}: ${detail.message}`
        : `backtest API ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

function requestOptions(options: RequestInit, signal?: AbortSignal): RequestInit {
  return signal === undefined ? options : { ...options, signal };
}

export function createBacktestApi(base = "/api/v1/backtests"): BacktestApiClient {
  return {
    async capabilities(signal) {
      return readJson(await fetch(`${base}/capabilities`, requestOptions({}, signal)));
    },
    async listDatasets(signal) {
      const payload = await readJson<{ datasets: BacktestDataset[] }>(
        await fetch(`${base}/datasets`, requestOptions({}, signal)),
      );
      return payload.datasets;
    },
    async previewSnapshot(body, signal) {
      return readJson(
        await fetch(`${base}/datasets/snapshot`, requestOptions({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }, signal)),
      );
    },
    async listRuns(signal) {
      const payload = await readJson<{ runs: BacktestRunRecord[] }>(
        await fetch(`${base}/runs`, requestOptions({}, signal)),
      );
      return payload.runs;
    },
    async validate(body, signal) {
      return readJson(
        await fetch(`${base}/runs/validate`, requestOptions({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }, signal)),
      );
    },
    async createRun(body, idempotencyKey, signal) {
      return readJson(
        await fetch(`${base}/runs`, requestOptions({
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(body),
        }, signal)),
      );
    },
    async getRun(runId, signal) {
      return readJson(await fetch(
        `${base}/runs/${encodeURIComponent(runId)}`,
        requestOptions({}, signal),
      ));
    },
    async getReport(runId, signal) {
      return readJson(
        await fetch(
          `${base}/runs/${encodeURIComponent(runId)}/report`,
          requestOptions({}, signal),
        ),
      );
    },
    async getChart(runId, signal) {
      return readJson(
        await fetch(
          `${base}/runs/${encodeURIComponent(runId)}/chart`,
          requestOptions({}, signal),
        ),
      );
    },
    async exportRun(runId, signal) {
      return readJson(
        await fetch(
          `${base}/runs/${encodeURIComponent(runId)}/export`,
          requestOptions({}, signal),
        ),
      );
    },
    async cancelRun(runId, signal) {
      return readJson(
        await fetch(
          `${base}/runs/${encodeURIComponent(runId)}/cancel`,
          requestOptions({ method: "POST" }, signal),
        ),
      );
    },
    async listStudies(signal) {
      const payload = await readJson<{ studies: BacktestStudyRecord[] }>(
        await fetch(`${base}/studies`, requestOptions({}, signal)),
      );
      return payload.studies;
    },
    async createStudy(body, signal) {
      return readJson(
        await fetch(`${base}/studies`, requestOptions({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }, signal)),
      );
    },
    async startStudy(studyId, signal) {
      return readJson(
        await fetch(
          `${base}/studies/${encodeURIComponent(studyId)}/start`,
          requestOptions({ method: "POST" }, signal),
        ),
      );
    },
    async cancelStudy(studyId, signal) {
      return readJson(
        await fetch(
          `${base}/studies/${encodeURIComponent(studyId)}/cancel`,
          requestOptions({ method: "POST" }, signal),
        ),
      );
    },
    async compareStudy(studyId, signal) {
      return readJson(
        await fetch(
          `${base}/studies/${encodeURIComponent(studyId)}/compare`,
          requestOptions({}, signal),
        ),
      );
    },
  };
}

const configuredBacktestApiBase = String(
  import.meta.env.VITE_BACKTEST_API_BASE ?? "",
).trim().replace(/\/$/, "");

export const defaultBacktestApi = createBacktestApi(
  configuredBacktestApiBase || "/api/v1/backtests",
);
