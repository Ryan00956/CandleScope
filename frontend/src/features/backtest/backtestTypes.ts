export interface BacktestRunRecord {
  run_id: string;
  state: string;
  fidelity_mode: string;
  source_event_kind: string;
  config_hash: string;
  result?: {
    report_hash?: string;
    fill_hash?: string;
    ambiguity_count?: number;
    fills?: Array<Record<string, string>>;
  };
}

export interface BacktestReport {
  schemaVersion: string;
  runId: string;
  fidelity_mode: string;
  source_event_kind: string;
  report_label: string;
  hashes: Record<string, string | null>;
  metrics: { fill_count: number; ambiguity_count: number };
  unmodeled: string[];
  suitable_for: string[];
  not_suitable_for: string[];
  fills: Array<Record<string, string>>;
}

export const STREAM_EVENTS = [
  "RUN_STATE",
  "PROGRESS",
  "WARNING",
  "CHECKPOINT",
  "ACCOUNT_DELTA",
  "ORDER_DELTA",
  "REPORT_READY",
  "TERMINAL",
  "RESYNC_REQUIRED",
] as const;
