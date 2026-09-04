export const RESEARCH_SOURCE_SCHEMA = "candlescope.research-source/1" as const;
export const FROZEN_RESEARCH_CONTEXT_SCHEMA = "candlescope.frozen-research-context/1" as const;

export const RESEARCH_SOURCE_KINDS = ["CURRENT_CHART", "IMPORTED_DATASET", "COMPLETED_RUN"] as const;
export type ResearchSourceKind = (typeof RESEARCH_SOURCE_KINDS)[number];

export const RESEARCH_CAPABILITY_IDS = [
  "viewKlines",
  "importNewData",
  "modifyRevisionPointer",
  "barApprox",
  "tradeTape",
  "onlineBackfill",
  "indicators",
  "drawingsEvents",
] as const;
export type ResearchCapabilityId = (typeof RESEARCH_CAPABILITY_IDS)[number];

export type ResearchQualityStatus = "ok" | "gap" | "failed";
export type ResearchRuntimeMode = "LIVE" | "LOCAL_OFFLINE";

export type CurrentChartSourceRefV1 = {
  schemaVersion: typeof RESEARCH_SOURCE_SCHEMA;
  kind: "CURRENT_CHART";
  workspaceId: string;
  cellId: string;
  exchange: string;
  marketType: string;
  symbol: string;
  interval: string;
};

export type ImportedDatasetSourceRefV1 = {
  schemaVersion: typeof RESEARCH_SOURCE_SCHEMA;
  kind: "IMPORTED_DATASET";
  datasetId: string;
  dataEpoch: string;
  interval: string;
};

export type CompletedRunSourceRefV1 = {
  schemaVersion: typeof RESEARCH_SOURCE_SCHEMA;
  kind: "COMPLETED_RUN";
  runId: string;
  datasetId: string;
  dataEpoch: string;
  snapshotHash: string;
};

export type ResearchSourceRefV1 =
  | CurrentChartSourceRefV1
  | ImportedDatasetSourceRefV1
  | CompletedRunSourceRefV1;

export type ResearchQualitySummaryV1 = {
  status: ResearchQualityStatus;
  rows: number;
  excludedRangeCount: number;
  volumeAvailable: boolean;
};

export type ResearchCapabilityDecisionV1 = {
  available: boolean;
  reasonCode: string | null;
  userReason: string;
  userAction: string;
};

export type ResearchCapabilitySummaryV1 = {
  sourceKind: ResearchSourceKind;
  runtimeMode: ResearchRuntimeMode;
  fidelityCeiling: "BAR_APPROX" | "TRADE_TAPE";
  capabilities: Partial<Record<ResearchCapabilityId, ResearchCapabilityDecisionV1>>;
};

export type FrozenResearchContextV1 = {
  schemaVersion: typeof FROZEN_RESEARCH_CONTEXT_SCHEMA;
  sourceKind: ResearchSourceKind;
  datasetId: string;
  dataEpoch: string;
  snapshotHash: string;
  interval: string;
  startTimeMs: number;
  endTimeMs: number;
  symbol: string;
  qualitySummary: ResearchQualitySummaryV1;
  capabilitySummary: ResearchCapabilitySummaryV1;
  contextHash: string;
};

export type ResearchDataErrorShape = {
  code: string;
  message: string;
  action: string;
  details?: Record<string, unknown>;
};

export const ORDINARY_RESEARCH_TERMS = {
  currentChart: { en: "Current chart", zh: "当前图表", ko: "현재 차트" },
  importedLibrary: { en: "Local library", zh: "本地资料库", ko: "로컬 라이브러리" },
  completedResult: { en: "Completed result", zh: "完成结果", ko: "완료 결과" },
  dataVersion: { en: "Data version", zh: "数据版本", ko: "데이터 버전" },
  frozenReproducible: { en: "Data is frozen and reproducible", zh: "数据已冻结，可复现", ko: "데이터는 동결되어 재현 가능" },
  dataGap: { en: "Data has gaps", zh: "数据有缺口", ko: "데이터에 공백이 있음" },
  barApprox: { en: "Bar estimate", zh: "基于 K 线估算", ko: "캔들 기반 추정" },
} as const;

export const FORBIDDEN_ORDINARY_UI_TERMS = [
  "local profile",
  "data epoch",
  "snapshot hash",
  "dataset id",
  "dataset ID",
  "provider ABI",
  "BacktestRun ID",
] as const;
