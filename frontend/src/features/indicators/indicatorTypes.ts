import type { KlineBar } from "../market-data/marketDataTypes.js";

export type IndicatorParams = Record<string, unknown>;
export type IndicatorSecurityMode = "safe" | "research" | "unsafe";
export type IndicatorKind = "builtin" | "script" | "custom" | "pyne";
export type IndicatorSeriesType = "line" | "histogram" | string;

export interface IndicatorDefinition {
  id: string;
  name?: string;
  engineName?: string | null;
  script?: string;
  params?: IndicatorParams;
  securityMode?: IndicatorSecurityMode | string;
  visible?: boolean;
  lines?: IndicatorLine[];
  description?: string;
  category?: string;
  paneTarget?: string;
  paramSchema?: IndicatorParameterSchema[];
  isPreset?: boolean;
}

interface IndicatorParameterBase {
  label?: string;
  type?: string;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
}

export type IndicatorParameterSchema =
  | (IndicatorParameterBase & { key: string; name?: string })
  | (IndicatorParameterBase & { name: string; key?: string });

export interface IndicatorOhlcvBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorValuePoint {
  time: number;
  value: number;
  color?: string;
}

export interface IndicatorColorPoint {
  time: number;
  color: string;
  value?: number;
}

export interface IndicatorAnnotationPoint {
  time: number;
  value?: number;
  color?: string;
  text?: string;
  position?: string;
  shape?: string;
  size?: string;
  endTime?: number;
}

export interface IndicatorLine {
  data: IndicatorValuePoint[];
  id?: string;
  indicatorId?: string;
  localId?: string;
  outputName?: string | null;
  name?: string;
  title?: string;
  color?: string;
  lineWidth?: number;
  lineStyle?: number;
  type?: IndicatorSeriesType;
  overlay?: boolean;
  pane?: string;
  scale?: string;
  zIndex?: number;
  colorData?: IndicatorColorPoint[] | null;
}

export interface IndicatorMarker {
  data: IndicatorAnnotationPoint[];
  indicatorId?: string;
  id?: string;
  pane?: string;
  shape?: string;
  color?: string;
  text?: string;
  position?: string;
  size?: string;
}

export interface IndicatorFill {
  indicatorId?: string;
  id?: string;
  pane?: string;
  plot1_id?: string;
  plot2_id?: string;
  color?: string;
  title?: string;
  type?: "betweenSeries" | string;
  seriesIds?: string[];
  localSeriesIds?: Array<string | null>;
  style?: { color?: string; title?: string };
  data?: IndicatorAnnotationPoint[];
}

export interface IndicatorHLine {
  indicatorId?: string;
  id?: string;
  pane?: string;
  price?: number;
  title?: string;
  color?: string;
  linestyle?: number | string;
  linewidth?: number;
  data?: IndicatorAnnotationPoint[];
}

export interface IndicatorBgColor {
  indicatorId?: string;
  id?: string;
  pane?: string;
  title?: string;
  color?: string;
  regions?: IndicatorAnnotationPoint[];
  data?: IndicatorAnnotationPoint[];
}

export interface IndicatorBarColor {
  indicatorId?: string;
  id?: string;
  pane?: string;
  data: IndicatorColorPoint[];
}

export interface IndicatorSignal {
  indicatorId?: string;
  id?: string;
  pane?: string;
  name?: string;
  side?: string;
  message?: string;
  data: IndicatorAnnotationPoint[];
}

export type IndicatorOutput =
  | { kind: "line"; value: IndicatorLine }
  | { kind: "marker"; value: IndicatorMarker }
  | { kind: "fill"; value: IndicatorFill }
  | { kind: "hline"; value: IndicatorHLine }
  | { kind: "bgcolor"; value: IndicatorBgColor }
  | { kind: "barcolor"; value: IndicatorBarColor }
  | { kind: "signal"; value: IndicatorSignal };

export interface NormalizedIndicatorPayload {
  lines: IndicatorLine[];
  markers: IndicatorMarker[];
  fills: IndicatorFill[];
  hlines: IndicatorHLine[];
  bgcolors: IndicatorBgColor[];
  barcolors: IndicatorBarColor[];
  signals: IndicatorSignal[];
}

export type IndicatorAuxiliaryKey = Exclude<keyof NormalizedIndicatorPayload, "lines">;

export interface IndicatorErrorDetail {
  message: string;
  line?: number;
  column?: number;
  hint?: string;
}

export interface IndicatorUnifiedSeries {
  id: string;
  localId: string;
  indicatorId?: string | null;
  pane: string;
  type: IndicatorSeriesType;
  data: IndicatorValuePoint[];
  style: {
    title: string;
    color: string;
    lineWidth: number;
    lineStyle: number;
    colorData?: IndicatorColorPoint[];
  };
  scale?: string;
  zIndex?: number;
}

export type IndicatorAnnotationType = "marker" | "hline" | "bgcolor" | "barcolor" | "signal";

export interface IndicatorUnifiedAnnotation {
  id: string;
  indicatorId?: string | null;
  pane: string;
  type: IndicatorAnnotationType;
  data: IndicatorAnnotationPoint[];
  style: Record<string, unknown>;
  scale?: string;
  zIndex?: number;
}

export interface IndicatorPayloadEnvelope {
  ok: boolean | null;
  schemaVersion?: number;
  outputSchemaVersion?: number;
  error?: string | null;
  detail?: unknown;
  code?: string;
  errorDetail?: IndicatorErrorDetail;
  lines: IndicatorLine[];
  series: IndicatorUnifiedSeries[];
  annotations: IndicatorUnifiedAnnotation[];
  fills: IndicatorFill[];
  legacyFills: IndicatorFill[];
  markers: IndicatorMarker[];
  hlines: IndicatorHLine[];
  bgcolors: IndicatorBgColor[];
  barcolors: IndicatorBarColor[];
  signals: IndicatorSignal[];
  param_schema: IndicatorParameterSchema[];
  range?: IndicatorRange;
  dataRevision?: IndicatorRevision;
  __httpStatus?: number;
}

export interface IndicatorRange {
  start: number;
  end: number;
}

export interface IndicatorRevision {
  serverEpoch?: string;
  correctionRevision?: string;
  closedThrough?: number;
  token?: string;
  dirtyRange?: IndicatorRange;
  historyInvalid?: true;
}

export interface IndicatorRangeSegment extends IndicatorRange {
  revision?: IndicatorRevision;
  points?: number;
}

export interface IndicatorCoverage {
  firstTime: number;
  lastTime: number;
  points: number;
}

export interface IndicatorRangeOptions {
  step?: unknown;
  revision?: unknown;
  cascadeRight?: boolean;
}

export interface IndicatorRangeIntent extends IndicatorRange {
  reason: string;
  targetKey: string;
  revision?: IndicatorRevision | null;
}

export interface IndicatorVisibleRange {
  time?: { from?: unknown; to?: unknown } | null;
  logical?: { from?: unknown; to?: unknown } | null;
}

export interface InitialHostedRange extends IndicatorRange {
  startIndex: number;
  endIndex: number;
  visibleStart: number | null;
  visibleEnd: number | null;
  visibleStartIndex: number;
  visibleEndIndex: number;
  warmupBars: number;
  paddingBars: number;
}

export interface DeferredRightCatchupPlan {
  key: string;
  signature: string;
  range: IndicatorRange;
  firstSeenAt: number;
  delayMs: number;
  [key: string]: unknown;
}

export interface IndicatorRangeRequest {
  clientId: string;
  kind?: IndicatorKind | string;
  securityMode?: IndicatorSecurityMode | string;
  name?: string;
  customId?: string;
  script?: string;
  params?: IndicatorParams;
  symbol: string;
  interval: string;
  marketType: string;
  exchange: string;
  start: number;
  end: number;
  reason?: string;
  signal?: AbortSignal;
}

export interface IndicatorRangeBatchItem {
  clientId: string;
  payload: IndicatorPayloadEnvelope;
}

export interface IndicatorRangeBatchResponse {
  ok: boolean;
  results: IndicatorRangeBatchItem[];
}

export interface IndicatorComputeRequest {
  mode?: string;
  securityMode?: string;
  name?: string;
  script?: string;
  ohlcv: IndicatorOhlcvBar[];
  params?: IndicatorParams;
  symbol?: string;
  interval?: string;
  marketType?: string;
  exchange?: string;
}

export interface IndicatorPreset extends IndicatorDefinition {
  name: string;
  engineName: string;
  script: string;
  params: IndicatorParams;
  description: string;
  category: string;
  paramSchema: IndicatorParameterSchema[];
  outputs: string[];
  is_builtin: boolean;
  defaultEnabled: boolean;
  paneTarget: string;
}

export interface IndicatorRegistrySpec {
  name: string;
  display_name: string;
  description: string;
  category: string;
  inputs: string[];
  outputs: string[];
  params: IndicatorParams;
  paramSchema: IndicatorParameterSchema[];
  is_builtin: boolean;
}

export interface CustomIndicatorRecord {
  schemaVersion: number;
  id: string;
  kind: string;
  name: string;
  description: string;
  script: string;
  params: IndicatorParams;
  paramSchema: IndicatorParameterSchema[];
  renderHints: Record<string, unknown>;
  securityMode?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface CustomIndicatorSaveInput extends Omit<CustomIndicatorRecord, "id" | "schemaVersion"> {
  id?: string;
  schemaVersion?: number;
}

export interface PyneSecurityPolicy {
  defaultMode: string;
  allowedModes: string[];
  [key: string]: unknown;
}

export interface IndicatorCacheContext {
  exchange: string;
  marketType: string;
  symbol: string;
  interval: string;
  candleUpColor: string;
  candleDownColor: string;
}

export interface IndicatorCacheMetadata {
  range?: IndicatorRange | null;
  revision?: IndicatorRevision | null;
  dataRevision?: IndicatorRevision | null;
  cascadeRight?: boolean;
}

export interface IndicatorCacheEntry {
  key: string;
  dependencyKey: string;
  indicatorId: string;
  context: IndicatorCacheContext;
  normalized: NormalizedIndicatorPayload;
  schema: IndicatorParameterSchema[];
  outputCoverage: IndicatorCoverage | null;
  coverage: IndicatorCoverage | null;
  computedSegments: IndicatorRangeSegment[];
  staleSegments: IndicatorRangeSegment[];
  revision: IndicatorRevision | null;
  lastUpdatedMs: number;
  lastAccessMs: number;
}

export interface IndicatorCacheResult {
  indicatorId: string;
  normalized: NormalizedIndicatorPayload;
  schema: IndicatorParameterSchema[];
  outputCoverage: IndicatorCoverage | null;
  coverage: IndicatorCoverage | null;
  computedSegments: IndicatorRangeSegment[];
  staleSegments: IndicatorRangeSegment[];
  revision: IndicatorRevision | null;
  lastUpdatedMs: number;
}

export interface IndicatorSubscriptionContext {
  candleDownColor?: string;
  candleUpColor?: string;
  chartData?: KlineBar[];
  chartDataLength?: number;
  exchange: string;
  interval: string;
  marketType: string;
  symbol: string;
  resumeFrom?: unknown;
  serverEpoch?: unknown;
  correctionRevision?: unknown;
}

export interface IndicatorSubscribeMessage {
  action: "subscribe";
  clientId: string;
  kind: "builtin" | "script";
  exchange: string;
  marketType: string;
  symbol: string;
  interval: string;
  displayName: string;
  params: IndicatorParams;
  historyLimit: number;
  name?: string;
  customId?: string;
  script?: string;
  securityMode?: string;
  resumeFrom?: number;
  serverEpoch?: string;
  correctionRevision?: string;
}

interface IndicatorWsBase {
  type: string;
  seq?: number;
  clientId?: string;
}

export interface IndicatorSnapshotMessage extends IndicatorWsBase, IndicatorPayloadEnvelope {
  type: "indicator.snapshot";
  clientId: string;
  indicatorId?: string;
  barTime?: number;
}

export interface IndicatorPatchMessage extends IndicatorWsBase, IndicatorPayloadEnvelope {
  type: "indicator.patch";
  clientId: string;
  range: IndicatorRange;
  reason?: string;
}

export interface IndicatorReplaceRangeMessage extends IndicatorWsBase, IndicatorPayloadEnvelope {
  type: "indicator.replace_range";
  clientId: string;
  range: IndicatorRange;
  reason?: string;
}

export interface IndicatorRecomputedMessage extends IndicatorWsBase {
  type: "indicator.recomputed";
  clientId: string;
  range: IndicatorRange;
  dirtyRange?: IndicatorRange;
  dataRevision?: IndicatorRevision;
  timestampMs?: number;
}

export interface IndicatorSubscribedMessage extends IndicatorWsBase {
  type: "indicator.subscribed";
  clientId: string;
  indicatorId?: string;
  resumeStatus?: string;
  resumeReason?: string | null;
  dataRevision?: IndicatorRevision;
  interval?: string;
}

export interface IndicatorValuesMessage extends IndicatorWsBase {
  type: "indicator.preview" | "indicator.update";
  clientId: string;
  values: Record<string, unknown>;
  barTime: number;
}

export interface IndicatorErrorMessage extends IndicatorWsBase {
  type: "indicator.error" | "error";
  clientId: string;
  error?: string;
  detail?: unknown;
  code?: string;
  errorDetail?: IndicatorErrorDetail;
}

export interface IndicatorControlMessage extends IndicatorWsBase {
  type: "heartbeat" | "connected";
}

export type IndicatorWsMessage =
  | IndicatorSnapshotMessage
  | IndicatorPatchMessage
  | IndicatorReplaceRangeMessage
  | IndicatorRecomputedMessage
  | IndicatorSubscribedMessage
  | IndicatorValuesMessage
  | IndicatorErrorMessage
  | IndicatorControlMessage;

export interface IndicatorWsSequenceState {
  hasGap: boolean;
  nextSeq: number;
  expectedSeq: number | null;
  actualSeq: number | null;
}

export interface IndicatorOutputState {
  markers: IndicatorMarker[];
  fills: IndicatorFill[];
  hlines: IndicatorHLine[];
  bgcolors: IndicatorBgColor[];
  barcolors: IndicatorBarColor[];
  signals: IndicatorSignal[];
  paramSchemas: Record<string, IndicatorParameterSchema[]>;
}

export type IndicatorOutputAction =
  | { type: "reset-context" }
  | { type: "hydrate-cache"; entries: IndicatorCacheResult[] }
  | { type: "snapshot"; indicatorId: string; normalized: NormalizedIndicatorPayload; schema?: IndicatorParameterSchema[] }
  | { type: "patch"; indicatorId: string; normalized: NormalizedIndicatorPayload }
  | { type: "replace-range"; indicatorId: string; normalized: NormalizedIndicatorPayload; range: IndicatorRange }
  | { type: "remove-indicator"; indicatorId: string }
  | {
    type: "compute-results";
    processedIds?: string[];
    markers?: IndicatorMarker[];
    fills?: IndicatorFill[];
    hlines?: IndicatorHLine[];
    bgcolors?: IndicatorBgColor[];
    barcolors?: IndicatorBarColor[];
    signals?: IndicatorSignal[];
    paramSchemas?: Record<string, IndicatorParameterSchema[]>;
  };
