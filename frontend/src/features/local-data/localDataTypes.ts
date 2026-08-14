export interface LocalDatasetManifest {
  schema_version: number;
  dataset_id: string;
  data_epoch: string;
  name: string;
  source: "local_dataset";
  symbol: string;
  interval: string;
  volume_available: boolean;
  timezone: string;
  timestamp_semantics: "bar_open";
  rows: number;
  first_open_ms: number;
  last_open_ms: number;
  all_rows_final: boolean;
  excluded_range_count: number;
  sqlite_sha256: string;
  imported_at: string;
  archived?: boolean;
  revision_count?: number;
}

export interface LocalImportInput {
  file: File;
  name: string;
  symbol: string;
  interval: string;
  timezone: string;
  timestampUnit: "auto" | "s" | "ms" | "iso";
  volumeRequired: boolean;
  datasetId?: string;
}

export type LocalImportJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface LocalImportJob {
  job_id: string;
  kind: "csv_import";
  status: LocalImportJobStatus;
  stage: string;
  processed_rows: number;
  total_rows: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  dataset: LocalDatasetManifest | null;
  error: { code: string; message: string } | null;
  cancel_requested: boolean;
}

export interface LocalDatasetRevision extends LocalDatasetManifest {
  current: boolean;
  quality_status: string;
}

export interface LocalRevisionDetails {
  manifest: LocalDatasetManifest;
  quality: {
    status: string;
    rows: number;
    excluded_ranges: Array<{ start_ms: number; end_ms: number; reason: string; missing_bars: number }>;
    duplicates: number;
    out_of_order: number;
    invalid_rows: number;
    volume_available: boolean;
    missing_volume_rows: number;
  };
  receipt: Record<string, unknown>;
}

export interface LocalRevisionComparison {
  dataset_id: string;
  left_epoch: string;
  right_epoch: string;
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  first_changed_ms: number | null;
  last_changed_ms: number | null;
}

export interface LocalTrashEntry {
  trash_id: string;
  dataset_id: string;
  name: string;
  deleted_at: string;
}

export interface LocalDatasetListResponse {
  datasets: LocalDatasetManifest[];
  count: number;
}

export type LocalEventTimeResolutionMode = "exact" | "containing";

export interface LocalEventTimeResolution {
  input_index: number;
  input_time_ms: number;
  matched: boolean;
  bar_open_ms?: number;
  bar_close_ms?: number;
  delta_ms?: number;
}

export interface LocalEventTimeResolutionResponse {
  dataset_id: string;
  data_epoch: string;
  mode: LocalEventTimeResolutionMode;
  matched: number;
  rejected: number;
  results: LocalEventTimeResolution[];
}

/** Backend shared-registry name; validation remains server-authoritative. */
export type LocalIndicatorName = string;
