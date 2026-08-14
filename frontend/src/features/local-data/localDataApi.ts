import type {
  KlineApi,
  KlineBeforeRequestOptions,
  KlineFetchResult,
  KlineHistoryRequestOptions,
  KlineRangeRequestOptions,
  KlineRequestOptions,
} from "../market-data/klineContracts.js";
import {
  toEpochSeconds,
  type EpochSeconds,
  type KlineBar,
} from "../market-data/marketDataTypes.js";
import type { IntervalString } from "../../utils/intervals.js";
import { API_BASE } from "../../services/apiConfig.js";
import {
  isJsonRecord,
  parseKlineResponse,
  type TransportKlineResponse,
} from "../../services/apiPayloadParsers.js";
import {
  parseIndicatorComputeBatchResponse,
  parseIndicatorPresetList,
} from "../indicators/indicatorContracts.js";
import type {
  IndicatorComputeBatchResponse,
  IndicatorParams,
  IndicatorPreset,
} from "../indicators/indicatorTypes.js";
import type {
  LocalDatasetListResponse,
  LocalDatasetManifest,
  LocalDatasetRevision,
  LocalEventTimeResolution,
  LocalEventTimeResolutionMode,
  LocalEventTimeResolutionResponse,
  LocalImportInput,
  LocalImportJob,
  LocalIndicatorName,
  LocalRevisionComparison,
  LocalRevisionDetails,
  LocalTrashEntry,
} from "./localDataTypes.js";


export class LocalDataApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "LocalDataApiError";
  }
}

function localUrl(path: string, params: Record<string, unknown> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  return `${API_BASE}/local${path}${query ? `?${query}` : ""}`;
}

async function responseJson(response: Response): Promise<unknown> {
  const payload: unknown = await response.json().catch(() => null);
  if (response.ok) return payload;
  const detail = isJsonRecord(payload) ? payload.detail : null;
  const message = typeof detail === "string"
    ? detail
    : isJsonRecord(detail) && typeof detail.message === "string"
      ? detail.message
      : `HTTP ${response.status}`;
  const code = isJsonRecord(detail) && typeof detail.code === "string" ? detail.code : null;
  throw new LocalDataApiError(message, response.status, code);
}

function expectManifest(value: unknown): LocalDatasetManifest {
  if (!isJsonRecord(value)) throw new TypeError("Local dataset manifest must be an object");
  const requiredStrings = [
    "dataset_id",
    "data_epoch",
    "name",
    "source",
    "symbol",
    "interval",
    "timezone",
    "timestamp_semantics",
    "sqlite_sha256",
    "imported_at",
  ] as const;
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new TypeError(`Local dataset manifest field ${key} is invalid`);
    }
  }
  for (const key of [
    "schema_version",
    "rows",
    "first_open_ms",
    "last_open_ms",
    "excluded_range_count",
  ] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      throw new TypeError(`Local dataset manifest field ${key} is invalid`);
    }
  }
  if (typeof value.all_rows_final !== "boolean") {
    throw new TypeError("Local dataset manifest field all_rows_final is invalid");
  }
  if (value.volume_available !== undefined && typeof value.volume_available !== "boolean") {
    throw new TypeError("Local dataset manifest field volume_available is invalid");
  }
  if (value.source !== "local_dataset" || value.timestamp_semantics !== "bar_open") {
    throw new TypeError("Local dataset manifest has unsupported source semantics");
  }
  return {
    ...value,
    volume_available: value.volume_available ?? true,
    archived: value.archived ?? false,
    revision_count: value.revision_count ?? 1,
  } as unknown as LocalDatasetManifest;
}

export async function listLocalDatasets(
  signal?: AbortSignal,
  includeArchived = false,
): Promise<LocalDatasetManifest[]> {
  const payload = await responseJson(await fetch(
    localUrl("/datasets", { include_archived: includeArchived || undefined }),
    signal === undefined ? {} : { signal },
  ));
  if (!isJsonRecord(payload) || !Array.isArray(payload.datasets)) {
    throw new TypeError("Local dataset list response is invalid");
  }
  const parsed: LocalDatasetListResponse = {
    datasets: payload.datasets.map(expectManifest),
    count: typeof payload.count === "number" ? payload.count : payload.datasets.length,
  };
  return parsed.datasets;
}

export async function fetchLocalIndicatorPresets(
  signal?: AbortSignal,
): Promise<IndicatorPreset[]> {
  return parseIndicatorPresetList(await responseJson(await fetch(
    localUrl("/indicators/presets"),
    signal === undefined ? {} : { signal },
  )));
}

export async function importLocalCsv(input: LocalImportInput): Promise<LocalDatasetManifest> {
  const url = localUrl("/imports/csv", {
    name: input.name,
    symbol: input.symbol,
    interval: input.interval,
    timezone: input.timezone,
    timestamp_unit: input.timestampUnit,
    volume_required: input.volumeRequired,
    dataset_id: input.datasetId,
  });
  const payload = await responseJson(await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/csv" },
    body: input.file,
  }));
  return expectManifest(payload);
}

function expectImportJob(value: unknown): LocalImportJob {
  if (!isJsonRecord(value)
    || typeof value.job_id !== "string"
    || value.kind !== "csv_import"
    || !["queued", "running", "completed", "failed", "cancelled"].includes(String(value.status))
    || typeof value.stage !== "string"
    || typeof value.processed_rows !== "number") {
    throw new TypeError("Local import job response is invalid");
  }
  return {
    ...value,
    dataset: value.dataset === null ? null : expectManifest(value.dataset),
  } as unknown as LocalImportJob;
}

export function createLocalImportJob(
  input: LocalImportInput,
  options: { signal?: AbortSignal; onUploadProgress?: (fraction: number) => void } = {},
): Promise<LocalImportJob> {
  const url = localUrl("/imports/csv/jobs", {
    name: input.name,
    symbol: input.symbol,
    interval: input.interval,
    timezone: input.timezone,
    timestamp_unit: input.timestampUnit,
    volume_required: input.volumeRequired,
    dataset_id: input.datasetId,
  });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", "text/csv");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onUploadProgress?.(event.loaded / event.total);
    };
    xhr.onerror = () => reject(new LocalDataApiError("CSV 上传失败", 0, "upload_failed"));
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    xhr.onload = () => {
      options.signal?.removeEventListener("abort", abort);
      let payload: unknown = null;
      try { payload = JSON.parse(xhr.responseText); } catch { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(expectImportJob(payload));
        } catch (reason) {
          reject(reason instanceof Error ? reason : new TypeError("Local import job response is invalid"));
        }
        return;
      }
      const detail = isJsonRecord(payload) ? payload.detail : null;
      reject(new LocalDataApiError(
        isJsonRecord(detail) && typeof detail.message === "string" ? detail.message : `HTTP ${xhr.status}`,
        xhr.status,
        isJsonRecord(detail) && typeof detail.code === "string" ? detail.code : null,
      ));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    xhr.send(input.file);
  });
}

export async function getLocalImportJob(jobId: string): Promise<LocalImportJob> {
  return expectImportJob(await responseJson(await fetch(
    localUrl(`/imports/jobs/${encodeURIComponent(jobId)}`),
  )));
}

export async function cancelLocalImportJob(jobId: string): Promise<LocalImportJob> {
  return expectImportJob(await responseJson(await fetch(
    localUrl(`/imports/jobs/${encodeURIComponent(jobId)}`),
    { method: "DELETE" },
  )));
}

export async function updateLocalDataset(
  datasetId: string,
  patch: { name?: string; archived?: boolean },
): Promise<LocalDatasetManifest> {
  return expectManifest(await responseJson(await fetch(
    localUrl(`/datasets/${encodeURIComponent(datasetId)}`),
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) },
  )));
}

export async function trashLocalDataset(datasetId: string): Promise<LocalTrashEntry> {
  return await responseJson(await fetch(
    localUrl(`/datasets/${encodeURIComponent(datasetId)}`),
    { method: "DELETE" },
  )) as LocalTrashEntry;
}

export async function listLocalTrash(): Promise<LocalTrashEntry[]> {
  const payload = await responseJson(await fetch(localUrl("/trash")));
  if (!isJsonRecord(payload) || !Array.isArray(payload.entries)) throw new TypeError("Trash response is invalid");
  return payload.entries as unknown as LocalTrashEntry[];
}

export async function restoreLocalTrash(trashId: string): Promise<LocalDatasetManifest> {
  return expectManifest(await responseJson(await fetch(
    localUrl(`/trash/${encodeURIComponent(trashId)}/restore`),
    { method: "POST" },
  )));
}

export async function listLocalRevisions(datasetId: string): Promise<LocalDatasetRevision[]> {
  const payload = await responseJson(await fetch(
    localUrl(`/datasets/${encodeURIComponent(datasetId)}/revisions`),
  ));
  if (!isJsonRecord(payload) || !Array.isArray(payload.revisions)) throw new TypeError("Revision response is invalid");
  return payload.revisions.map((value) => ({
    ...expectManifest(value),
    current: isJsonRecord(value) && value.current === true,
    quality_status: isJsonRecord(value) && typeof value.quality_status === "string" ? value.quality_status : "unknown",
  }));
}

export async function fetchLocalRevisionDetails(
  manifest: LocalDatasetManifest,
): Promise<LocalRevisionDetails> {
  return await responseJson(await fetch(localUrl(
    `/datasets/${encodeURIComponent(manifest.dataset_id)}/quality`,
    { data_epoch: manifest.data_epoch },
  ))) as LocalRevisionDetails;
}

export async function compareLocalRevisions(
  datasetId: string,
  leftEpoch: string,
  rightEpoch: string,
): Promise<LocalRevisionComparison> {
  return await responseJson(await fetch(localUrl(
    `/datasets/${encodeURIComponent(datasetId)}/revisions/compare`,
    { left_epoch: leftEpoch, right_epoch: rightEpoch },
  ))) as LocalRevisionComparison;
}

export async function activateLocalRevision(
  manifest: LocalDatasetManifest,
  dataEpoch: string,
): Promise<LocalDatasetManifest> {
  return expectManifest(await responseJson(await fetch(
    localUrl(`/datasets/${encodeURIComponent(manifest.dataset_id)}/revisions/activate`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data_epoch: dataEpoch, expected_current_epoch: manifest.data_epoch }),
    },
  )));
}

export async function exportLocalProject(
  manifest: LocalDatasetManifest,
  clientState: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(
    localUrl(`/projects/${encodeURIComponent(manifest.dataset_id)}/export`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data_epoch: manifest.data_epoch, client_state: clientState }),
    },
  );
  if (!response.ok) { await responseJson(response); return; }
  const href = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `${manifest.name.replace(/[^\w.-]+/g, "-") || manifest.dataset_id}.csproject`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
}

export interface LocalProjectImportResult {
  dataset: LocalDatasetManifest;
  source_dataset_id: string;
  dataset_id: string;
  identity_changed: boolean;
  revision_count: number;
  client_state: Record<string, unknown>;
}

export async function importLocalProject(file: File): Promise<LocalProjectImportResult> {
  const payload = await responseJson(await fetch(localUrl("/projects/import"), {
    method: "POST",
    headers: { "Content-Type": "application/vnd.candlescope.local-project+zip" },
    body: file,
  }));
  if (!isJsonRecord(payload)) throw new TypeError("Project import response is invalid");
  return { ...payload, dataset: expectManifest(payload.dataset) } as unknown as LocalProjectImportResult;
}

export async function resolveLocalEventTimes(
  manifest: LocalDatasetManifest,
  timesMs: readonly number[],
  mode: LocalEventTimeResolutionMode,
  signal?: AbortSignal,
): Promise<LocalEventTimeResolutionResponse> {
  const payload = await responseJson(await fetch(
    localUrl(`/datasets/${encodeURIComponent(manifest.dataset_id)}/events/resolve-times`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data_epoch: manifest.data_epoch, times_ms: timesMs, mode }),
      ...(signal === undefined ? {} : { signal }),
    },
  ));
  if (!isJsonRecord(payload)
    || payload.dataset_id !== manifest.dataset_id
    || payload.data_epoch !== manifest.data_epoch
    || payload.mode !== mode
    || !Array.isArray(payload.results)) {
    throw new TypeError("Event time resolution response is invalid");
  }
  const results: LocalEventTimeResolution[] = payload.results.map((value, index) => {
    if (!isJsonRecord(value)
      || value.input_index !== index
      || typeof value.input_time_ms !== "number"
      || !Number.isFinite(value.input_time_ms)
      || typeof value.matched !== "boolean") {
      throw new TypeError("Event time resolution row is invalid");
    }
    if (!value.matched) {
      return {
        input_index: index,
        input_time_ms: value.input_time_ms,
        matched: false,
      };
    }
    for (const key of ["bar_open_ms", "bar_close_ms", "delta_ms"] as const) {
      if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
        throw new TypeError(`Event time resolution field ${key} is invalid`);
      }
    }
    return {
      input_index: index,
      input_time_ms: value.input_time_ms,
      matched: true,
      bar_open_ms: value.bar_open_ms as number,
      bar_close_ms: value.bar_close_ms as number,
      delta_ms: value.delta_ms as number,
    };
  });
  const matched = results.filter((result) => result.matched).length;
  if (payload.matched !== matched || payload.rejected !== results.length - matched) {
    throw new TypeError("Event time resolution counts are invalid");
  }
  return {
    dataset_id: manifest.dataset_id,
    data_epoch: manifest.data_epoch,
    mode,
    matched,
    rejected: results.length - matched,
    results,
  };
}

export interface LocalIndicatorComputeJob {
  clientId: string;
  jobKey: string;
  name: LocalIndicatorName;
  params: IndicatorParams;
}

export async function computeLocalIndicatorBatch(
  manifest: LocalDatasetManifest,
  jobs: readonly LocalIndicatorComputeJob[],
  interval: string = manifest.interval,
  signal?: AbortSignal,
): Promise<IndicatorComputeBatchResponse> {
  if (jobs.length < 1 || jobs.length > 32) {
    throw new RangeError("Local indicator batch requires between 1 and 32 jobs");
  }
  const payload = await responseJson(await fetch(
    localUrl(`/datasets/${encodeURIComponent(manifest.dataset_id)}/indicators/compute/batch`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        data_epoch: manifest.data_epoch,
        interval,
        requests: jobs,
      }),
      ...(signal === undefined ? {} : { signal }),
    },
  ));
  if (!isJsonRecord(payload)
    || payload.source !== "local_dataset"
    || payload.dataset_id !== manifest.dataset_id
    || payload.data_epoch !== manifest.data_epoch
    || payload.interval !== interval) {
    throw new TypeError("Local indicator response identity is invalid");
  }
  const parsed = parseIndicatorComputeBatchResponse(payload);
  if (parsed.results.length !== jobs.length) {
    throw new TypeError("Local indicator response count is invalid");
  }
  for (let index = 0; index < jobs.length; index += 1) {
    const expected = jobs[index];
    const actual = parsed.results[index];
    if (actual?.clientId !== expected?.clientId || actual?.jobKey !== expected?.jobKey) {
      throw new TypeError("Local indicator response order or identity is invalid");
    }
  }
  return parsed;
}

function toKlineFetchResult(payload: unknown, operation: string): KlineFetchResult {
  const volumeUnavailable = isJsonRecord(payload)
    && payload.source === "local_dataset"
    && payload.volume_available === false;
  const normalizedPayload = volumeUnavailable && Array.isArray(payload.data)
    ? {
        ...payload,
        data: (payload.data as unknown[]).map((row: unknown): unknown => (
          isJsonRecord(row) && row.volume === null ? { ...row, volume: 0 } : row
        )),
      }
    : payload;
  const result: TransportKlineResponse = parseKlineResponse(normalizedPayload, operation);
  const data: KlineBar[] = result.data.map((row) => {
    const time = toEpochSeconds(row.time);
    if (time === null) throw new TypeError(`${operation} returned an invalid bar time`);
    if (volumeUnavailable) {
      const { volume: _volume, ...withoutVolume } = row;
      return { ...withoutVolume, time };
    }
    return { ...row, time };
  });
  return { ...result, data } as KlineFetchResult;
}

export class LocalKlineApi implements KlineApi {
  constructor(readonly datasetId: string) {}

  private async get(
    path: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<KlineFetchResult> {
    const payload = await responseJson(await fetch(
      localUrl(`/datasets/${encodeURIComponent(this.datasetId)}/klines${path}`, params),
      signal === undefined ? {} : { signal },
    ));
    return toKlineFetchResult(payload, `GET local klines${path}`);
  }

  fetchKlinesHistory(
    _symbol: string,
    interval: IntervalString,
    days: number | null | undefined,
    _marketType: string,
    _exchange: string,
    options: KlineHistoryRequestOptions,
  ): Promise<KlineFetchResult> {
    return this.get("/history", {
      interval,
      days,
      count_back: options.countBack ?? 1_000,
    }, options.signal);
  }

  fetchKlinesBefore(
    _symbol: string,
    interval: IntervalString,
    before: EpochSeconds | undefined,
    bars: number,
    _marketType: string,
    _exchange: string,
    options: KlineBeforeRequestOptions,
  ): Promise<KlineFetchResult> {
    return this.get("/history/before", { interval, before: before ?? 0, bars }, options.signal);
  }

  fetchKlinesRange(
    _symbol: string,
    interval: IntervalString,
    start: EpochSeconds,
    end: EpochSeconds,
    _marketType: string,
    _exchange: string,
    options: KlineRangeRequestOptions,
  ): Promise<KlineFetchResult> {
    return this.get("/range", { interval, start, end }, options.signal);
  }

  fetchLatestKlines(
    _symbol: string,
    interval: IntervalString,
    limit: number,
    _marketType: string,
    _exchange: string,
    _source: string,
    options: KlineRequestOptions,
  ): Promise<KlineFetchResult> {
    return this.get("/latest", { interval, limit }, options.signal);
  }

  getMultiStreamUrl(): string {
    return "";
  }
}
