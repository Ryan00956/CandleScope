import type { WindowDeltaType } from "../market-data/klineContracts.js";

export interface OrdinalAxisTime {
  order: number;
  sourceTime: number;
  sourceOrdinal: number;
}

export type AxisTime = number | OrdinalAxisTime;

export interface SourceTimeRange {
  from: number;
  to: number;
}

export interface ProjectionMetadata extends Record<string, unknown> {
  projectorId: string;
  sourceFromTime: number | null;
  sourceToTime: number | null;
  sourceOrdinal: number;
  synthetic: boolean;
  provisional?: boolean;
}

export interface ProjectionCustomValues extends Record<string, unknown> {
  chartProjection?: Readonly<ProjectionMetadata>;
}

export interface RenkoProjectionValues {
  direction: "up" | "down";
  boxSize: number;
  source: "close";
  wickPolicy: "none";
}

export interface PointFigureProjectionValues {
  direction: "x" | "o";
  boxSize: number;
  reversalAmount: number;
  source: "close";
}

export interface KagiProjectionSection {
  from: number;
  to: number;
  style: "yang" | "yin";
}

export interface KagiProjectionValues {
  direction: "up" | "down";
  state: "yang" | "yin";
  reversalKind: "shoulder" | "waist" | null;
  turnPrice: number | null;
  reversalAmount: number;
  reversalTicks: number;
  source: "close";
  sections: readonly Readonly<KagiProjectionSection>[];
}

export interface LineBreakProjectionValues {
  direction: "up" | "down";
  numberOfLines: number;
  source: "close";
  referenceHigh: number;
  referenceLow: number;
}

export interface SourceBar extends Record<string, unknown> {
  time: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: unknown;
  is_closed?: unknown;
  isClosed?: unknown;
  __whitespace?: boolean;
  customValues?: ProjectionCustomValues;
}

export interface OhlcValues {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DisplayRow extends Record<string, unknown> {
  time: AxisTime;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: unknown;
  sourceTime?: unknown;
  customValues?: ProjectionCustomValues;
}

export type ProjectedDisplayRow<
  TProjectionValues extends object,
  TProjectionKey extends string,
> = Omit<DisplayRow, "time" | "customValues"> & {
  time: OrdinalAxisTime;
  customValues: ProjectionCustomValues & {
    chartProjection: Readonly<ProjectionMetadata>;
  } & Record<TProjectionKey, Readonly<TProjectionValues>>;
};

export type RenkoDisplayRow = ProjectedDisplayRow<RenkoProjectionValues, "renko">;
export type PointFigureDisplayRow = ProjectedDisplayRow<
  PointFigureProjectionValues,
  "pointAndFigure"
>;
export type KagiDisplayRow = ProjectedDisplayRow<KagiProjectionValues, "kagi">;
export type LineBreakDisplayRow = ProjectedDisplayRow<
  LineBreakProjectionValues,
  "lineBreak"
>;

export interface ProjectionState extends Record<string, unknown> {
  nextOrder?: number;
}

export interface ProjectionProjectOptions<TState extends ProjectionState = ProjectionState> {
  previousDisplayRow?: DisplayRow | null;
  provisional?: boolean;
  seedState?: Readonly<TState> | null;
}

export interface ProjectionResult<
  TState extends ProjectionState = ProjectionState,
  TRow extends DisplayRow = DisplayRow,
> {
  checkpoints: Readonly<TState>[];
  data: TRow[];
  state: Readonly<TState>;
}

export interface Projector<
  TState extends ProjectionState = ProjectionState,
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TRow extends DisplayRow = DisplayRow,
> {
  readonly id: string;
  readonly oneToOne: boolean;
  readonly supportsStatefulTailProjection?: boolean;
  readonly config?: TConfig;
  project(
    rows?: readonly SourceBar[],
    options?: ProjectionProjectOptions<TState>,
  ): TRow[];
  projectWithState?(
    rows?: readonly SourceBar[],
    options?: ProjectionProjectOptions<TState>,
  ): ProjectionResult<TState, TRow>;
  resolvePreviousDisplayRow?(rows?: readonly DisplayRow[]): DisplayRow | null;
}

export interface ProjectionTailState<TState extends ProjectionState = ProjectionState> {
  seedState: Readonly<TState> | null;
  finalState: Readonly<TState> | null;
  checkpoints: Readonly<TState>[];
  confirmedSourceLength: number;
}

export interface ProjectionPatch {
  kind: "replace-tail";
  fromOutputIndex: number;
  deleteCount: number;
  insert: DisplayRow[];
  nextData: DisplayRow[];
  previousLength: number;
  nextLength: number;
}

export interface ProjectionSourceDelta extends Record<string, unknown> {
  type?: WindowDeltaType | string;
  appended?: boolean;
  replaced?: boolean;
  addedRight?: number;
  trimmedLeft?: number;
  trimmedRight?: number;
}

export type ProjectionId =
  | "identity"
  | "heikin-ashi"
  | "renko"
  | "point-and-figure"
  | "kagi"
  | "line-break";

export type ChartAxisMode = "time" | "derived-ordinal";
export type ChartDrawingAnchorMode = "source-time" | "source-lineage";

export interface ChartTypeDescriptor extends Record<string, unknown> {
  id: string;
  axisMode: ChartAxisMode | string;
  projectionId: ProjectionId | string;
  rendererId: string;
  drawingAnchorMode: ChartDrawingAnchorMode | null;
}

export type RenkoMode = "atr" | "traditional";

export interface RenkoProjectionOptions {
  atrLength?: unknown;
  boxSize?: unknown;
  mode?: unknown;
}

export interface ResolvedRenkoProjectionOptions extends Record<string, unknown> {
  atrLength: number;
  boxSize: number;
  minTick: number;
  mode: RenkoMode;
  configKey: string;
}

export interface PointFigureProjectionOptions extends RenkoProjectionOptions {
  reversalAmount?: unknown;
}

export interface ResolvedPointFigureProjectionOptions extends ResolvedRenkoProjectionOptions {
  reversalAmount: number;
}

export interface KagiProjectionOptions {
  atrLength?: unknown;
  mode?: unknown;
  reversalAmount?: unknown;
}

export interface ResolvedKagiProjectionOptions extends Record<string, unknown> {
  atrLength: number;
  minTick: number;
  mode: RenkoMode;
  reversalAmount: number;
  reversalTicks: number;
  configKey: string;
}

export interface LineBreakProjectionOptions {
  numberOfLines?: unknown;
}

export interface ResolvedLineBreakProjectionOptions extends Record<string, unknown> {
  numberOfLines: number;
  minTick: number;
  configKey: string;
}

export type AuxiliaryFanout = "all" | "last";

export interface DisplaySourceTarget {
  sourceTime: number;
  time: AxisTime;
}

export interface DisplaySourceTimeIndex {
  bySourceTime: Map<number, AxisTime[]>;
  displayTimeSet: Set<AxisTime>;
  lastTargetIndexBySourceTime: Map<number, number>;
  targets: DisplaySourceTarget[];
}

export interface LogicalRange {
  from: number;
  to: number;
}

export interface SurfaceViewportSnapshot extends Record<string, unknown> {
  anchorSourceTime: number;
  anchorTime: AxisTime;
  axisMode?: unknown;
  barSpacing: number | null;
  datasetKey?: unknown;
  logicalSpan: number;
  screenOffset: number;
  sourceRange: LogicalRange | null;
  surfaceConfigKey?: unknown;
}
