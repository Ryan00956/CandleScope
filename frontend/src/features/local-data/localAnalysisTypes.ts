export const LOCAL_ANALYSIS_EVENT_KINDS = [
  "note",
  "signal",
  "entry",
  "exit",
  "custom",
] as const;

export type LocalAnalysisEventKind = typeof LOCAL_ANALYSIS_EVENT_KINDS[number];

export interface LocalAnalysisIdentity {
  datasetId: string;
  dataEpoch: string;
}

export interface LocalAnalysisEvent {
  id: string;
  dataset_id: string;
  data_epoch: string;
  time: number;
  price: number | null;
  kind: LocalAnalysisEventKind;
  label: string;
  note: string;
  color: string;
  source: "manual" | "csv";
  extra: Readonly<Record<string, unknown>>;
  created_at: string;
  updated_at: string;
}

export interface LocalAnalysisEventImportDraft extends LocalAnalysisEventDraft {
  id: string;
  source: "csv";
  extra: Readonly<Record<string, unknown>>;
}

export interface LocalAnalysisImportResult {
  imported: number;
  skipped: number;
}

export interface LocalAnalysisEventDraft {
  time: number;
  price: number | null;
  kind: LocalAnalysisEventKind;
  label: string;
  note: string;
  color: string;
}

export interface LocalAnalysisSnapshot {
  events: readonly LocalAnalysisEvent[];
  revision: number;
  storage_error: string | null;
}

export interface LocalAnalysisFocusRequest {
  requestId: number;
  time: number;
}

export const LOCAL_ANALYSIS_KIND_LABELS: Readonly<Record<LocalAnalysisEventKind, string>> = {
  note: "备注",
  signal: "信号",
  entry: "开仓",
  exit: "平仓",
  custom: "自定义",
};

export const LOCAL_ANALYSIS_KIND_COLORS: Readonly<Record<LocalAnalysisEventKind, string>> = {
  note: "#f59e0b",
  signal: "#8b5cf6",
  entry: "#22c55e",
  exit: "#ef4444",
  custom: "#38bdf8",
};
