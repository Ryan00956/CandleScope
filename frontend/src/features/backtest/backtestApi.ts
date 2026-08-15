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
  language?: string;
  label: string;
  description: string;
  input_modes: string[];
  output_modes: string[];
  signal_clock: string;
  required_features: string[];
  warmup_requirement: Record<string, unknown>;
  parameter_schema: Array<Record<string, unknown>>;
  accepts_source: boolean;
  unsupported?: string[];
  source_hash?: string;
  compiled_hash?: string;
  runtime_revision?: string;
}

export interface StrategyRevisionRecord extends BacktestStrategyDescriptor {
  schema_version?: string;
  base_revision_id?: string;
  diagnostics?: Array<Record<string, unknown>>;
}

export interface SignalTracePage {
  schema: "SIGNAL_TRACE_V1";
  runId: string;
  items: Array<{ ordinal: number; event_time_ms: number | null; payload: Record<string, unknown>; row_hash: string }>;
  nextAfter: number | null;
  limit: number;
}

export interface BacktestCapabilities {
  flags: Record<string, boolean>;
  fidelity_modes: string[];
  strategies: BacktestStrategyDescriptor[];
  account_models?: string[];
  funding_modes_v2?: string[];
  host_policy_revision?: string;
  sizing_policies?: string[];
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
  resumeRun(runId: string, signal?: AbortSignal): Promise<BacktestRunRecord>;
  listStudies(signal?: AbortSignal): Promise<BacktestStudyRecord[]>;
  createStudy(body: Record<string, unknown>, signal?: AbortSignal): Promise<BacktestStudyRecord>;
  startStudy(studyId: string, signal?: AbortSignal): Promise<BacktestStudyRecord>;
  cancelStudy(studyId: string, signal?: AbortSignal): Promise<BacktestStudyRecord>;
  revealStudyHoldout(studyId: string, signal?: AbortSignal): Promise<BacktestStudyRecord>;
  compareStudy(studyId: string, signal?: AbortSignal): Promise<BacktestStudyComparison>;
  createStrategyRevision(body: Record<string, unknown>, signal?: AbortSignal): Promise<StrategyRevisionRecord>;
  smokeStrategyRevision(revisionId: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
  getSignalTrace(runId: string, after?: number, limit?: number, signal?: AbortSignal): Promise<SignalTracePage>;
  compareRuns(leftRunId: string, rightRunId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  cloneRun(runId: string, parameter: string, value: unknown, idempotencyKey: string, signal?: AbortSignal): Promise<BacktestRunRecord>;
  copyStrategyRevision(revisionId: string, name: string, signal?: AbortSignal): Promise<StrategyRevisionRecord>;
  archiveStrategyRevision(revisionId: string, signal?: AbortSignal): Promise<StrategyRevisionRecord>;
  createReviewBridge(runId: string, startTimeMs: number, endTimeMs: number, signal?: AbortSignal): Promise<Record<string, unknown>>;
  getReviewBridge(bridgeId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  revealReviewBridge(bridgeId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  inspectPythonBundle(zipBase64: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  createPythonBundle(zipBase64: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  getPythonBundle(bundleId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  createPythonRevision(bundleId: string, signal?: AbortSignal): Promise<StrategyRevisionRecord>;
  getPythonRuntimeReceipt(revisionId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
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
  account_model?: string;
  funding_mode?: string;
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
    async resumeRun(runId, signal) {
      return readJson(
        await fetch(
          `${base}/runs/${encodeURIComponent(runId)}/resume`,
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
    async revealStudyHoldout(studyId, signal) {
      return readJson(
        await fetch(
          `${base}/studies/${encodeURIComponent(studyId)}/reveal-holdout`,
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
    async createStrategyRevision(body, signal) {
      return readJson(await fetch(`${base}/strategy-revisions`, requestOptions({
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }, signal)));
    },
    async smokeStrategyRevision(revisionId, body, signal) {
      return readJson(await fetch(`${base}/strategy-revisions/${encodeURIComponent(revisionId)}/smoke`, requestOptions({
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }, signal)));
    },
    async getSignalTrace(runId, after = 0, limit = 200, signal) {
      return readJson(await fetch(`${base}/runs/${encodeURIComponent(runId)}/signal-trace?after=${after}&limit=${limit}`, requestOptions({}, signal)));
    },
    async compareRuns(leftRunId, rightRunId, signal) {
      const query = new URLSearchParams({ left_run_id: leftRunId, right_run_id: rightRunId });
      return readJson(await fetch(`${base}/runs/compare/pair?${query}`, requestOptions({}, signal)));
    },
    async cloneRun(runId, parameter, value, idempotencyKey, signal) {
      return readJson(await fetch(`${base}/runs/${encodeURIComponent(runId)}/clone`, requestOptions({
        method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ parameter, value }),
      }, signal)));
    },
    async copyStrategyRevision(revisionId, name, signal) {
      return readJson(await fetch(`${base}/strategy-revisions/${encodeURIComponent(revisionId)}/copy`, requestOptions({
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
      }, signal)));
    },
    async archiveStrategyRevision(revisionId, signal) {
      return readJson(await fetch(`${base}/strategy-revisions/${encodeURIComponent(revisionId)}/archive`, requestOptions({ method: "POST" }, signal)));
    },
    async createReviewBridge(runId, startTimeMs, endTimeMs, signal) {
      return readJson(await fetch(`${base}/runs/${encodeURIComponent(runId)}/review-bridge`, requestOptions({
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ start_time_ms: startTimeMs, end_time_ms: endTimeMs }),
      }, signal)));
    },
    async getReviewBridge(bridgeId, signal) {
      return readJson(await fetch(`${base}/review-bridges/${encodeURIComponent(bridgeId)}`, requestOptions({}, signal)));
    },
    async revealReviewBridge(bridgeId, signal) {
      return readJson(await fetch(`${base}/review-bridges/${encodeURIComponent(bridgeId)}/reveal`, requestOptions({ method: "POST" }, signal)));
    },
    async inspectPythonBundle(zipBase64, signal) {
      return readJson(await fetch(`${base}/strategy-bundles/inspect`, requestOptions({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ zip_base64: zipBase64 }),
      }, signal)));
    },
    async createPythonBundle(zipBase64, signal) {
      return readJson(await fetch(`${base}/strategy-bundles`, requestOptions({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ zip_base64: zipBase64 }),
      }, signal)));
    },
    async getPythonBundle(bundleId, signal) {
      return readJson(await fetch(`${base}/strategy-bundles/${encodeURIComponent(bundleId)}`, requestOptions({}, signal)));
    },
    async createPythonRevision(bundleId, signal) {
      return readJson(await fetch(`${base}/strategy-revisions/python`, requestOptions({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundle_id: bundleId }),
      }, signal)));
    },
    async getPythonRuntimeReceipt(revisionId, signal) {
      return readJson(await fetch(
        `${base}/strategy-revisions/${encodeURIComponent(revisionId)}/runtime-receipt`,
        requestOptions({}, signal),
      ));
    },
  };
}

const configuredBacktestApiBase = String(
  import.meta.env?.VITE_BACKTEST_API_BASE ?? "",
).trim().replace(/\/$/, "");

export const defaultBacktestApi = createBacktestApi(
  configuredBacktestApiBase || "/api/v1/backtests",
);
