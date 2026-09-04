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

type ResearchCopy = { readonly en: string; readonly zh: string; readonly ko: string };

export const RESEARCH_ERROR_ACTIONS = {
  INVALID_RESEARCH_SOURCE: {
    en: "Choose the data source again",
    zh: "重新选择数据来源",
    ko: "데이터 소스를 다시 선택",
  },
  UNKNOWN_SOURCE_KIND: {
    en: "Choose the data source again",
    zh: "重新选择数据来源",
    ko: "데이터 소스를 다시 선택",
  },
  MISSING_DATASET_IDENTITY: {
    en: "Choose a data version in the local library",
    zh: "重新选择本地资料库中的数据版本",
    ko: "로컬 라이브러리에서 데이터 버전을 다시 선택",
  },
  MISSING_SNAPSHOT_HASH: {
    en: "Reopen from a completed result; do not fill identity by hand",
    zh: "从完成结果重新打开，不要手工填写身份",
    ko: "완료 결과에서 다시 열기. 신원을 직접 입력하지 말 것",
  },
  INVALID_FROZEN_CONTEXT: {
    en: "Freeze the data again, then run",
    zh: "重新冻结数据后再运行",
    ko: "데이터를 다시 동결한 뒤 실행",
  },
  CONTEXT_HASH_MISMATCH: {
    en: "Freeze the data again, then run",
    zh: "重新冻结数据后再运行",
    ko: "데이터를 다시 동결한 뒤 실행",
  },
  FRONTEND_MUST_NOT_INVENT_SNAPSHOT: {
    en: "Wait for the backend to return a frozen identity",
    zh: "等待后端返回已冻结身份",
    ko: "백엔드가 동결된 신원을 반환할 때까지 대기",
  },
  fallback: {
    en: "Choose the source again",
    zh: "重新选择来源",
    ko: "소스를 다시 선택",
  },
} as const satisfies Record<string, ResearchCopy>;

export const RESEARCH_CAPABILITY_COPY = {
  viewKlines: { en: "Candles can be viewed", zh: "可以查看 K 线", ko: "캔들을 볼 수 있음" },
  importCsv: { en: "CSV can be imported", zh: "可以导入 CSV", ko: "CSV를 가져올 수 있음" },
  importDenied: { en: "This source cannot import new data", zh: "当前来源不能导入新数据", ko: "현재 소스는 새 데이터를 가져올 수 없음" },
  switchLibrary: { en: "Switch to the local library", zh: "切换到本地资料库", ko: "로컬 라이브러리로 전환" },
  activateVersion: { en: "A data version can be activated", zh: "可以激活数据版本", ko: "데이터 버전을 활성화할 수 있음" },
  versionDenied: { en: "This source cannot change the data version", zh: "当前来源不能修改数据版本", ko: "현재 소스는 데이터 버전을 바꿀 수 없음" },
  manageVersions: { en: "Manage data versions in the local library", zh: "在本地资料库中管理数据版本", ko: "로컬 라이브러리에서 데이터 버전 관리" },
  barApprox: { en: "Bar estimate", zh: "基于 K 线估算", ko: "캔들 기반 추정" },
  gapDenied: { en: "The selected range has gaps", zh: "所选区间存在缺口", ko: "선택한 구간에 공백이 있음" },
  shortenOrImport: { en: "Shorten the range or import complete data", zh: "缩短区间或导入完整数据", ko: "구간을 줄이거나 완전한 데이터를 가져오기" },
  frozenTape: { en: "Frozen fills are available", zh: "已有冻结成交", ko: "동결된 체결이 있음" },
  tapeDenied: {
    en: "This data does not support tape fidelity; only bar estimates",
    zh: "当前数据不支持逐笔精度，只能基于 K 线估算",
    ko: "현재 데이터는 체결 정밀도를 지원하지 않으며 캔들 추정만 가능",
  },
  useBarsOrTape: { en: "Use a bar estimate or import tape data", zh: "使用 K 线估算或导入成交数据", ko: "캔들 추정을 쓰거나 체결 데이터를 가져오기" },
  offlineLive: { en: "Live market data is unavailable in the offline runtime", zh: "离线运行时没有实时行情", ko: "오프라인 런타임에는 실시간 시세가 없음" },
  chooseLibrary: { en: "Choose the local library", zh: "选择本地资料库", ko: "로컬 라이브러리 선택" },
  prepareHistory: { en: "Missing history can be prepared after confirmation", zh: "用户确认后可准备缺失历史", ko: "확인 후 빠진 이력을 준비할 수 있음" },
  noNetworkBackfill: { en: "Imported data never backfills over the network", zh: "导入数据不会联网补历史", ko: "가져온 데이터는 네트워크로 이력을 보충하지 않음" },
  useImportedOrShorten: { en: "Use imported data or shorten the range", zh: "使用已导入的数据或缩短区间", ko: "가져온 데이터를 쓰거나 구간을 줄이기" },
  readOnlyResults: { en: "Read-only result capabilities", zh: "只读结果能力", ko: "읽기 전용 결과 기능" },
  localBars: { en: "Local explicit-bars indicators", zh: "本地显式-bars 指标", ko: "로컬 explicit-bars 지표" },
  liveIndicators: { en: "Live market indicators", zh: "当前行情指标", ko: "실시간 시세 지표" },
  offlineIndicators: { en: "Live indicators are unavailable in the offline runtime", zh: "离线运行时没有实时行情指标", ko: "오프라인 런타임에는 실시간 시세 지표가 없음" },
  independentReview: { en: "Independent review scope", zh: "独立复核范围", ko: "독립 복기 범위" },
  bindVersion: { en: "Bound to the current data version", zh: "绑定当前数据版本", ko: "현재 데이터 버전에 연결" },
  bindChart: { en: "Bound to the current chart", zh: "绑定当前图表", ko: "현재 차트에 연결" },
  offlineChartStrategy: {
    en: "The offline runtime cannot run a current-chart strategy",
    zh: "离线运行时不能运行当前图表策略",
    ko: "오프라인 런타임에서는 현재 차트 전략을 실행할 수 없음",
  },
} as const satisfies Record<string, ResearchCopy>;

export const FORBIDDEN_ORDINARY_UI_TERMS = [
  "local profile",
  "data epoch",
  "snapshot hash",
  "dataset id",
  "dataset ID",
  "provider ABI",
  "BacktestRun ID",
] as const;
