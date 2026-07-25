import type {
  BusinessDay,
  Coordinate,
  CustomData,
  CustomSeriesOptions,
  AreaData,
  IChartApi,
  IChartApiBase,
  IPaneApi,
  ISeriesApi,
  Logical,
  LogicalRange,
  SeriesType,
} from "lightweight-charts";
import type {
  OrdinalAxisTime,
  ProjectionCustomValues,
} from "../features/chart-representation/chartRepresentationTypes.js";
import type { MainChartType } from "../shared/mainChartTypes.js";

export type ChartTime = number | string | BusinessDay | OrdinalAxisTime;

export type LightweightChartApi = IChartApi | IChartApiBase<OrdinalAxisTime>;

export type MainSeriesHandle<TSeriesType extends SeriesType = SeriesType> = ISeriesApi<
  TSeriesType,
  ChartTime
>;

export type IndicatorSeriesHandle<TSeriesType extends SeriesType = SeriesType> = ISeriesApi<
  TSeriesType,
  ChartTime
>;

export type PaneHandle = IPaneApi<ChartTime>;

export interface RefLike<T> {
  current: T | null;
}

export interface MutableRef<T> {
  current: T;
}

export type RefOrValue<T> = RefLike<T> | T | null | undefined;

export interface ChartSeriesInputRow {
  time?: ChartTime;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  value?: number;
  volume?: unknown;
  color?: string;
  borderColor?: string;
  wickColor?: string;
  __whitespace?: boolean;
  customValues?: ProjectionCustomValues;
}

export interface ChartSeriesRow extends Omit<ChartSeriesInputRow, "time"> {
  time: ChartTime;
}

export interface ChartSeriesPoint extends ChartSeriesRow {
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  value?: number;
  color?: string;
  borderColor?: string;
  wickColor?: string;
  customValues?: ProjectionCustomValues;
}

export interface IndicatorDataEntry {
  time?: ChartTime;
  value?: number;
  color?: string;
}

export interface NormalizedIndicatorDataEntry extends IndicatorDataEntry {
  time: ChartTime;
  value: number;
}

export interface IndicatorLine {
  id?: string;
  indicatorId?: string;
  name?: string;
  pane?: string;
  type?: string;
  color?: string;
  lineWidth?: number;
  lineStyle?: number;
  scale?: string;
  valueFormat?: string;
  visible?: boolean;
  base?: number;
  trackPrice?: boolean;
  data?: IndicatorDataEntry[];
  colorData?: IndicatorDataEntry[] | null;
  renderUpdate?: "tail" | "full" | null;
}

export interface IndicatorSeriesDefinition extends IndicatorLine {
  type?: "histogram" | "line" | string;
}

export interface IndicatorMarkerEntry {
  time?: ChartTime;
  value?: number;
  position?: string;
  shape?: string;
  text?: string;
  color?: string;
}

export interface IndicatorMarkerGroup {
  id?: string;
  indicatorId?: string;
  pane?: string;
  data?: IndicatorMarkerEntry[];
}

export interface IndicatorBgcolorGroup {
  id?: string;
  indicatorId?: string;
  pane?: string;
  color?: string;
  data?: IndicatorMarkerEntry[];
  regions?: IndicatorMarkerEntry[];
}

export interface BgcolorRegion {
  time: ChartTime;
  color: string;
}

export interface IndicatorFillDefinition {
  indicatorId?: string;
  plot1_id?: string;
  plot2_id?: string;
  color?: string;
}

export interface FillRenderEntry {
  upperData: AreaData<ChartTime>[];
  lowerData: AreaData<ChartTime>[];
  fillColor: string;
  backgroundColor: string;
}

export interface IndicatorHline {
  price?: number;
  color?: string;
  linestyle?: number | string;
  title?: string;
}

export interface FillRenderResult {
  entries: FillRenderEntry[];
  signature: string;
  structureSignature: string;
  matchedFillCount: number;
  pointCount: number;
}

export interface SeriesDataWriter<TData> {
  setData(data: TData[]): void;
  update(data: TData): void;
}

export interface ProjectionSeriesWriter<TData> extends SeriesDataWriter<TData> {
  pop(count: number): TData[];
}

export interface ProjectionRenderPatch {
  kind: "replace-tail";
  fromOutputIndex: number;
  deleteCount: number;
  insert: ChartSeriesInputRow[];
  previousData: ChartSeriesInputRow[];
  previousLength: number;
  nextLength: number;
  nextData?: ChartSeriesInputRow[];
}

export interface ProjectionPatchCandidate {
  kind?: string;
  fromOutputIndex?: unknown;
  deleteCount?: unknown;
  insert?: ChartSeriesInputRow[];
  previousData?: ChartSeriesInputRow[];
  previousLength?: unknown;
  nextLength?: unknown;
  nextData?: ChartSeriesInputRow[];
}

export type ProjectionRenderMode = "noop" | "setData" | "update" | "pop-update";

export interface ProjectionRenderResult {
  mode: ProjectionRenderMode;
  nextData: ChartSeriesInputRow[];
}

export interface ProjectionViewportController {
  captureAnchor(rows: ChartSeriesInputRow[]): unknown;
  applyAnchorShift(
    anchor: unknown,
    resolveDisplayAnchorIndex: (anchor: unknown) => number,
  ): unknown;
}

export interface ViewportLogicalRange {
  from: number;
  to: number;
}

export interface ViewportAnchor {
  time: ChartTime;
  index: number;
  screenOffset: number;
}

export interface ViewportRestorePlan {
  mode?: "anchor" | "time" | "logical" | string;
  barSpacing?: number | null;
  rightOffset?: number | null;
  scrollPosition?: number | null;
  timeRange?: { from: ChartTime; to: ChartTime } | null;
  logicalRange?: ViewportLogicalRange | null;
}

export interface TimedSeriesRow extends Record<string, unknown> {
  time: number;
}

export interface SeriesWindowReader<TRow extends TimedSeriesRow> {
  indexOfTime?(time: number): number;
  snapshot?(options?: { force?: boolean }): TRow[];
}

export interface DeltaViewportController<TRow extends TimedSeriesRow> {
  captureAnchor?(rows: TRow[] | null): ViewportAnchor | null;
  applyAnchorShift?(
    anchor: ViewportAnchor,
    indexOfTime: (time: ChartTime) => number,
  ): boolean;
  compensateInsert(shift: number): boolean;
}

export interface IndicatorBarcolorGroup {
  data?: Array<{ time?: ChartTime; color?: string }>;
}

export interface MainSeriesColorOptions {
  chartType?: MainChartType | string | null;
  downColor?: string;
  indicatorColor?: string | null;
  previousClose?: number | null;
  upColor?: string;
}

export interface MainSeriesDataOptions extends MainSeriesColorOptions {
  indicatorBarColorMap?: ReadonlyMap<ChartTime, string> | null;
  indicatorBarcolors?: IndicatorBarcolorGroup[];
  startIndex?: number;
}

export interface MainSeriesCrosshairValue {
  time: ChartTime;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface OhlcCustomData extends CustomData<ChartTime> {
  open: number;
  high: number;
  low: number;
  close: number;
  color?: string;
  customValues?: ProjectionCustomValues;
}

export interface HighLowSeriesOptions extends CustomSeriesOptions {
  color: string;
}

export interface PointFigureSeriesOptions extends CustomSeriesOptions {
  upColor: string;
  downColor: string;
  lineWidth: number;
}

export interface KagiSeriesOptions extends PointFigureSeriesOptions {
  thickLineWidth: number;
}

export interface PointFigureMetadata {
  direction?: "x" | "o";
  boxSize?: number;
}

export interface PointFigureCustomData extends OhlcCustomData {
  customValues?: ProjectionCustomValues & {
    pointAndFigure?: PointFigureMetadata;
  };
}

export interface KagiSection {
  from?: number;
  to?: number;
  style?: "yang" | "yin";
}

export interface KagiMetadata {
  direction?: "up" | "down";
  state?: "yang" | "yin";
  turnPrice?: number;
  sections?: KagiSection[];
}

export interface KagiCustomData extends OhlcCustomData {
  customValues?: ProjectionCustomValues & {
    kagi?: KagiMetadata;
  };
}

export type KagiStyle = "yang" | "yin";

export interface ResolvedKagiSection {
  from: number;
  to: number;
  style: KagiStyle;
}

export interface CoordinatePoint {
  x: number;
  y: number;
}

export interface CoordinateSnapshot extends Record<string, unknown> {
  seriesData: readonly ChartSeriesRow[];
  sourceTimeHorizon: number | null;
  sourceInterval: string | null;
  sourceIntervalSeconds: number | null;
  ordinalSeriesIndex?: DrawingLineageIndex | null;
  indexRevision?: number | null;
  drawingProjectionConfig?: Readonly<Record<string, unknown>> | null;
}

export interface DrawingLineageIndex extends Record<string, unknown> {
  revision?: number;
}

export interface VisibleRangeSnapshot {
  logical: LogicalRange | null;
  time: { from: ChartTime; to: ChartTime } | null;
  barSpacing: number;
  scrollPosition: number;
}

export interface FutureTimeAxisPlan {
  changed: boolean;
  data: ChartSeriesRow[] | null;
  key: string;
}

export type ChartCoordinate = Coordinate | number;
export type ChartLogical = Logical | number;

export type PerfEventRecorder = (
  name: string,
  detail?: Readonly<Record<string, unknown>>,
) => void;
