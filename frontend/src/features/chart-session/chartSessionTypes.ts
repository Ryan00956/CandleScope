import type {
  IntervalDurationGroup,
  IntervalString,
} from "../../utils/intervals.js";
import type {
  ExchangeCapabilityPayload,
  ExchangeMarketPayload,
} from "../../services/apiPayloadParsers.js";
import type { ChartSurfaceActions } from "../../chart-adapter/useChartSurfaceRuntime.js";
import type {
  ExchangeId,
  MarketType,
  SymbolCode,
  SymbolIdentity,
} from "../../utils/symbolKey.js";

export type DatasetKey = string;
export type ChartSessionKey = string;

export interface ChartSession extends SymbolIdentity {
  interval: IntervalString;
}

export type ChartSessionTransitionType =
  | "symbol-change"
  | "interval-change"
  | "market-type-change"
  | "capability-correction";

export interface ChartSessionTransition {
  id: number;
  type: ChartSessionTransitionType;
  from: ChartSession;
  to: ChartSession;
  fromSessionKey: ChartSessionKey;
  sessionKey: ChartSessionKey;
  createdAt: number;
}

export interface UserPrefs extends Record<string, unknown> {
  lastSymbol?: unknown;
  lastExchange?: unknown;
  lastMarketType?: unknown;
  lastInterval?: unknown;
}

export interface NativeInterval {
  value: IntervalString;
  seconds: number;
  label?: string;
}

export type NativeIntervalPurpose = "history" | "realtime";

export interface AvailableInterval extends NativeInterval {
  isCustom: boolean;
}

export type IntervalDayMap = Record<string, number>;

export interface ExchangeCatalogEntry {
  id: ExchangeId;
  label: string;
  markets: ExchangeMarketPayload[];
  nativeIntervals: NativeInterval[];
  intervalDays: IntervalDayMap;
  intervalDaysSource: "capability" | "fallback";
  protocolFeatures: Set<string>;
  limits: Record<string, unknown>;
  knownLimitations: string[];
  wsConnectionModel: string;
  raw: ExchangeCapabilityPayload | null;
}

export type ExchangeCatalog = Record<string, ExchangeCatalogEntry>;
export type ExchangeCatalogStatus = "loading" | "ready" | "fallback";

export interface ExchangeCatalogRuntime {
  exchangeCatalog: ExchangeCatalog;
  exchangeCatalogStatus: ExchangeCatalogStatus;
}

export type GroupedAvailableIntervals = IntervalDurationGroup<AvailableInterval>[];

export interface CustomIntervalRecord {
  value: IntervalString;
  createdAt: number;
  lastUsedAt: number;
  usageCount: number;
  pinned: boolean;
  order: number;
}

export interface AddCustomIntervalOptions {
  pinned?: boolean;
  markUsed?: boolean;
}

export type AddCustomIntervalResult =
  | { ok: false; reason: "invalid" }
  | {
      ok: true;
      added: boolean;
      value: IntervalString;
      record: CustomIntervalRecord | undefined;
    };

export interface CustomIntervalsRuntime {
  customIntervalRecords: CustomIntervalRecord[];
  savedCustomIntervals: IntervalString[];
  addCustomInterval(
    interval: unknown,
    options?: AddCustomIntervalOptions,
  ): AddCustomIntervalResult;
  markIntervalUsed(interval: unknown): void;
  removeCustomInterval(interval: unknown): CustomIntervalRecord | null;
  restoreCustomInterval(record: unknown): CustomIntervalRecord | null;
  togglePinCustomInterval(interval: unknown): CustomIntervalRecord | undefined | null;
  clearCustomIntervals(): CustomIntervalRecord[];
}

export interface IntervalNotice {
  type: "success" | "warning" | "error" | "info";
  text: string;
  actionLabel?: string;
  duration?: number;
}

export interface IntervalNoticeRuntime {
  intervalNotice: IntervalNotice | null;
  showIntervalNotice(notice: IntervalNotice): void;
}

export interface ExchangeMarketConfig {
  market_type?: string | null;
}

export interface ExchangeConfig {
  markets: readonly ExchangeMarketConfig[];
}

export type NativeIntervalSupport = (
  exchange: ExchangeId,
  interval: IntervalString,
  exchangeCatalog?: ExchangeCatalog | null,
  marketType?: MarketType,
  purpose?: NativeIntervalPurpose,
) => boolean;

export interface SelectSymbolInput {
  symbol: SymbolCode;
  marketType?: MarketType;
  exchange?: ExchangeId;
}

export type CreateCustomIntervalResult =
  | { ok: true; added: boolean }
  | { ok: false; message: string };

export interface UseChartSessionOptions {
  chartSurfaceActions?: Pick<ChartSurfaceActions, "getVisibleRange"> | null;
}

export interface ChartSessionView {
  symbol: SymbolCode;
  exchange: ExchangeId;
  marketType: MarketType;
  interval: IntervalString;
  sessionKey: ChartSessionKey;
  datasetKey: DatasetKey;
  datasetVersion: number;
  exchangeCatalog: ExchangeCatalog;
  exchangeConfig: ExchangeCatalogEntry;
  exchangeMarketTypes: string[];
  nativeIntervals: NativeInterval[];
  intervalGroups: GroupedAvailableIntervals;
  baseWsIntervals: IntervalString[];
  trackedIntervals: IntervalString[];
  prefetchIntervals: IntervalString[];
  customIntervalRecords: CustomIntervalRecord[];
  savedCustomIntervals: IntervalString[];
  intervalNotice: IntervalNotice | null;
  savedVisibleRange: VisibleRangeSnapshot | null;
}

export interface ChartSessionActions {
  selectSymbol(input: SymbolCode | SelectSymbolInput): void;
  selectInterval(interval: IntervalString): void;
  selectMarketType(marketType: MarketType): void;
  refreshDataset(): void;
  setDatasetVersion(): void;
  saveCurrentVisibleRange(dataMeta?: unknown): void;
  handleVisibleRangeChange(range: unknown, dataMeta?: unknown): void;
  updateVisibleRangeDataMeta(dataMeta: unknown): void;
  createCustomInterval(interval: IntervalString): CreateCustomIntervalResult;
  removeCustomInterval(interval: IntervalString): void;
  restoreCustomInterval(): void;
  clearCustomIntervals(): void;
  togglePinCustomInterval(interval: unknown): CustomIntervalRecord | undefined | null;
}

export interface ChartSessionRuntime {
  view: ChartSessionView;
  actions: ChartSessionActions;
  status: {
    exchangeCatalogStatus: ExchangeCatalogStatus;
    exchangeLimitations: string[];
  };
  events: {
    transitionToken: number;
    lastTransition: ChartSessionTransition | null;
  };
  refs: {
    intervalRef: { current: IntervalString };
    trackedIntervalsRef: { current: IntervalString[] };
  };
}

export interface VisibleRangeSnapshot {
  barSpacing?: number;
  rightOffset?: number;
  rightmostTime?: number;
  savedAt?: number;
}

export interface AnchorVisibleRangeRestore {
  mode: "anchor";
  barSpacing: number | null;
  rightOffset: number | null;
  rightmostTime: number | null;
}

export interface FitVisibleRangeRestore {
  mode: "fit";
  timeRange: null;
  logicalRange: null;
  barSpacing: null;
  rightOffset: null;
  rightmostTime: null;
}

export type VisibleRangeRestorePlan = AnchorVisibleRangeRestore | FitVisibleRangeRestore;
export type PaneHeights = Record<string, number[]>;

export type { ExchangeId, IntervalString, MarketType, SymbolCode };
