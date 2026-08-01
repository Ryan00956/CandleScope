import type {
  DisplayRow,
  PointFigureDisplayRow,
  ProjectionCustomValues,
  ProjectionProjectOptions,
  ProjectionResult,
  ProjectionState,
  Projector,
  SourceBar,
} from "../chartRepresentationTypes.js";
import { projectionSourceTimeRange } from "./projectorData.js";

const POINT_FIGURE_STATE_VERSION = 1;
type PointFigureDirection = "x" | "o" | null;

interface PointFigureState extends ProjectionState {
  version: 1;
  projectorId: "point-and-figure";
  minTick: number;
  boxTicks: number;
  reversalAmount: number;
  initialized: boolean;
  anchorTicks: number | null;
  direction: PointFigureDirection;
  columnLowTicks: number | null;
  columnHighTicks: number | null;
  columnOrder: number | null;
  columnSourceFromTime: number | null;
  columnSourceToTime: number | null;
  columnCustomValues: ProjectionCustomValues;
  nextOrder: number;
  pendingFromTime: number | null;
}

interface PointFigureProjectorOptions {
  boxSize?: unknown;
  minTick?: unknown;
  reversalAmount?: unknown;
}

const DIRECTIONS = new Set<PointFigureDirection>([null, "x", "o"]);

function positiveFiniteNumber(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`Point & Figure ${name} must be a positive finite number`);
  }
  return number;
}

function positiveSafeInteger(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`Point & Figure ${name} must be a positive safe integer`);
  }
  return number;
}

function decimalPlaces(value: number): number {
  const [coefficient = "", exponentText] = String(value).toLowerCase().split("e");
  const fractionLength = coefficient.split(".")[1]?.length || 0;
  const exponent = Number(exponentText || 0);
  return Math.max(0, fractionLength - exponent);
}

function cloneCustomValues(customValues: unknown): ProjectionCustomValues {
  if (!customValues || typeof customValues !== "object") return {};
  return { ...customValues };
}

function cloneState(state: Readonly<PointFigureState>): PointFigureState {
  return {
    version: POINT_FIGURE_STATE_VERSION,
    projectorId: "point-and-figure",
    minTick: state.minTick,
    boxTicks: state.boxTicks,
    reversalAmount: state.reversalAmount,
    initialized: state.initialized,
    anchorTicks: state.anchorTicks,
    direction: state.direction,
    columnLowTicks: state.columnLowTicks,
    columnHighTicks: state.columnHighTicks,
    columnOrder: state.columnOrder,
    columnSourceFromTime: state.columnSourceFromTime,
    columnSourceToTime: state.columnSourceToTime,
    columnCustomValues: cloneCustomValues(state.columnCustomValues),
    nextOrder: state.nextOrder,
    pendingFromTime: state.pendingFromTime,
  };
}

function frozenState(state: Readonly<PointFigureState>): Readonly<PointFigureState> {
  const cloned = cloneState(state);
  cloned.columnCustomValues = Object.freeze(cloned.columnCustomValues);
  return Object.freeze(cloned);
}

function initialState({
  boxTicks,
  minTick,
  reversalAmount,
}: Pick<PointFigureState, "boxTicks" | "minTick" | "reversalAmount">): PointFigureState {
  return {
    version: POINT_FIGURE_STATE_VERSION,
    projectorId: "point-and-figure",
    minTick,
    boxTicks,
    reversalAmount,
    initialized: false,
    anchorTicks: null,
    direction: null,
    columnLowTicks: null,
    columnHighTicks: null,
    columnOrder: null,
    columnSourceFromTime: null,
    columnSourceToTime: null,
    columnCustomValues: {},
    nextOrder: 0,
    pendingFromTime: null,
  };
}

function validColumnState(state: Readonly<PointFigureState>): boolean {
  if (state.direction === null) {
    return state.columnLowTicks == null
      && state.columnHighTicks == null
      && state.columnOrder == null;
  }
  return typeof state.columnLowTicks === "number"
    && Number.isSafeInteger(state.columnLowTicks)
    && typeof state.columnHighTicks === "number"
    && Number.isSafeInteger(state.columnHighTicks)
    && state.columnLowTicks <= state.columnHighTicks
    && typeof state.columnOrder === "number"
    && Number.isSafeInteger(state.columnOrder)
    && state.columnOrder >= 0
    && state.columnOrder < state.nextOrder
    && typeof state.columnSourceFromTime === "number"
    && Number.isFinite(state.columnSourceFromTime)
    && typeof state.columnSourceToTime === "number"
    && Number.isFinite(state.columnSourceToTime);
}

function requiredInteger(value: number | null, name: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`Point & Figure active state requires ${name}`);
  }
  return Number(value);
}

function requiredSourceTime(value: number | null, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Point & Figure active state requires ${name}`);
  }
  return value;
}

function requiredDirection(direction: PointFigureDirection): Exclude<PointFigureDirection, null> {
  if (direction === null) throw new TypeError("Point & Figure active state requires direction");
  return direction;
}

function displayOrder(row: DisplayRow): number | null {
  return typeof row.time === "object" ? row.time.order : null;
}

function normalizeSeedState(
  seedState: Readonly<PointFigureState> | null,
  { boxTicks, minTick, reversalAmount }:
    Pick<PointFigureState, "boxTicks" | "minTick" | "reversalAmount">,
): PointFigureState {
  if (seedState == null) {
    return initialState({ boxTicks, minTick, reversalAmount });
  }
  if (seedState.version !== POINT_FIGURE_STATE_VERSION
    || seedState.projectorId !== "point-and-figure"
    || seedState.boxTicks !== boxTicks
    || seedState.minTick !== minTick
    || seedState.reversalAmount !== reversalAmount) {
    throw new TypeError("Point & Figure seed state is incompatible with projector options");
  }
  if (typeof seedState.initialized !== "boolean"
    || !DIRECTIONS.has(seedState.direction)
    || !Number.isSafeInteger(seedState.nextOrder)
    || seedState.nextOrder < 0
    || (seedState.initialized && !Number.isSafeInteger(seedState.anchorTicks))
    || !validColumnState(seedState)) {
    throw new TypeError("Point & Figure seed state is invalid");
  }
  return cloneState(seedState);
}

function finiteClose(row: SourceBar): number | null {
  const value: unknown = row?.close;
  if (row?.__whitespace || value == null || value === "") return null;
  const close = Number(value);
  return Number.isFinite(close) ? close : null;
}

function projectionCustomValues(row: SourceBar, {
  boxSize,
  direction,
  provisional,
  reversalAmount,
  sourceFromTime,
}: {
  boxSize: number;
  direction: Exclude<PointFigureDirection, null>;
  provisional: boolean;
  reversalAmount: number;
  sourceFromTime: number;
}): PointFigureDisplayRow["customValues"] {
  return {
    ...(row?.customValues || {}),
    chartProjection: Object.freeze({
      projectorId: "point-and-figure",
      sourceFromTime,
      sourceToTime: projectionSourceTimeRange(row).to,
      sourceOrdinal: 0,
      synthetic: true,
      provisional: Boolean(provisional),
    }),
    pointAndFigure: Object.freeze({
      direction,
      boxSize,
      reversalAmount,
      source: "close",
    }),
  };
}

/**
 * Close-only, fixed-box Point & Figure projection.
 *
 * Each X/O column is represented by one semantic OHLC item. X columns use
 * open=low and close=high; O columns use open=high and close=low. A renderer
 * can reconstruct every glyph from high/low and pointAndFigure.boxSize.
 * Prices are converted to integer minimum-tick units before comparisons.
 */
export class PointFigureProjector implements Projector<
  PointFigureState,
  Record<string, unknown>,
  PointFigureDisplayRow
> {
  readonly id: "point-and-figure";
  readonly oneToOne: false;
  readonly supportsStatefulTailProjection: true;
  readonly boxSize: number;
  readonly minTick: number;
  readonly reversalAmount: number;
  readonly boxTicks: number;
  readonly pricePrecision: number;

  constructor({
    boxSize = 1,
    minTick = 0.01,
    reversalAmount = 3,
  }: PointFigureProjectorOptions = {}) {
    this.id = "point-and-figure";
    this.oneToOne = false;
    this.supportsStatefulTailProjection = true;
    this.boxSize = positiveFiniteNumber(boxSize, "boxSize");
    this.minTick = positiveFiniteNumber(minTick, "minTick");
    this.reversalAmount = positiveSafeInteger(reversalAmount, "reversalAmount");

    const boxRatio = this.boxSize / this.minTick;
    const roundedBoxTicks = Math.round(boxRatio);
    const tolerance = Number.EPSILON * Math.max(16, Math.abs(boxRatio) * 16);
    if (!Number.isSafeInteger(roundedBoxTicks)
      || roundedBoxTicks <= 0
      || Math.abs(boxRatio - roundedBoxTicks) > tolerance) {
      throw new TypeError("Point & Figure boxSize must be an integer multiple of minTick");
    }
    this.boxTicks = roundedBoxTicks;
    this.pricePrecision = Math.min(12, decimalPlaces(this.minTick));
  }

  project(
    rows: readonly SourceBar[] = [],
    options: ProjectionProjectOptions<PointFigureState> = {},
  ): PointFigureDisplayRow[] {
    return this.projectWithState(rows, options).data;
  }

  projectWithState(
    rows: readonly SourceBar[] = [],
    { provisional = false, seedState = null }: ProjectionProjectOptions<PointFigureState> = {},
  ): ProjectionResult<PointFigureState, PointFigureDisplayRow> {
    const state = normalizeSeedState(seedState, this);
    const data: PointFigureDisplayRow[] = [];
    const checkpoints: Readonly<PointFigureState>[] = [];

    // The active column may have started before a trim-left checkpoint. Carry
    // it into the new projection so a no-op retained row cannot make it vanish.
    const hasRetainedSource = (rows || []).some((row) => row?.time != null);
    if (seedState != null && state.direction !== null && hasRetainedSource) {
      this._upsertCurrentColumn(data, state, {
        time: requiredSourceTime(state.columnSourceToTime, "columnSourceToTime"),
        customValues: state.columnCustomValues,
      }, false);
    }

    for (const row of rows || []) {
      checkpoints.push(frozenState(state));
      if (row?.time == null) continue;
      const close = finiteClose(row);
      if (close == null) continue;
      const closeTicks = this._priceToTicks(close);

      if (!state.initialized) {
        const anchorTicks = Math.floor(closeTicks / this.boxTicks) * this.boxTicks;
        if (!Number.isSafeInteger(anchorTicks)) {
          throw new RangeError("Point & Figure anchor exceeds safe integer tick range");
        }
        state.initialized = true;
        state.anchorTicks = anchorTicks;
        state.pendingFromTime = row.time;
        continue;
      }

      if (state.direction === null) {
        this._startFirstColumn(data, state, row, closeTicks, provisional);
      } else if (state.direction === "x") {
        this._processXColumn(data, state, row, closeTicks, provisional);
      } else {
        this._processOColumn(data, state, row, closeTicks, provisional);
      }
    }

    return {
      checkpoints,
      data,
      state: frozenState(state),
    };
  }

  _priceToTicks(price: number): number {
    const ticks = Math.round(price / this.minTick);
    if (!Number.isSafeInteger(ticks)) {
      throw new RangeError("Point & Figure source price exceeds safe integer tick range");
    }
    return ticks;
  }

  _ticksToPrice(ticks: number): number {
    const price = Number((ticks * this.minTick).toFixed(this.pricePrecision));
    return Object.is(price, -0) ? 0 : price;
  }

  _startFirstColumn(
    data: PointFigureDisplayRow[],
    state: PointFigureState,
    row: SourceBar,
    closeTicks: number,
    provisional: boolean,
  ): void {
    const anchorTicks = requiredInteger(state.anchorTicks, "anchorTicks");
    if (closeTicks >= anchorTicks + this.boxTicks) {
      const boxes = Math.floor((closeTicks - anchorTicks) / this.boxTicks);
      const lowTicks = anchorTicks + this.boxTicks;
      const highTicks = anchorTicks + boxes * this.boxTicks;
      this._startColumn(data, state, row, "x", lowTicks, highTicks, provisional);
    } else if (closeTicks <= anchorTicks - this.boxTicks) {
      const boxes = Math.floor((anchorTicks - closeTicks) / this.boxTicks);
      const highTicks = anchorTicks - this.boxTicks;
      const lowTicks = anchorTicks - boxes * this.boxTicks;
      this._startColumn(data, state, row, "o", lowTicks, highTicks, provisional);
    }
  }

  _processXColumn(
    data: PointFigureDisplayRow[],
    state: PointFigureState,
    row: SourceBar,
    closeTicks: number,
    provisional: boolean,
  ): void {
    const columnHighTicks = requiredInteger(state.columnHighTicks, "columnHighTicks");
    if (closeTicks >= columnHighTicks + this.boxTicks) {
      const boxes = Math.floor((closeTicks - columnHighTicks) / this.boxTicks);
      state.columnHighTicks = columnHighTicks + boxes * this.boxTicks;
      state.columnSourceToTime = projectionSourceTimeRange(row).to;
      state.columnCustomValues = cloneCustomValues(row.customValues);
      this._upsertCurrentColumn(data, state, row, provisional);
      return;
    }

    const reversalTicks = this.reversalAmount * this.boxTicks;
    if (!Number.isSafeInteger(reversalTicks)) {
      throw new RangeError("Point & Figure reversal threshold exceeds safe integer tick range");
    }
    if (closeTicks <= columnHighTicks - reversalTicks) {
      const boxes = Math.floor((columnHighTicks - closeTicks) / this.boxTicks);
      const highTicks = columnHighTicks - this.boxTicks;
      const lowTicks = columnHighTicks - boxes * this.boxTicks;
      this._startColumn(data, state, row, "o", lowTicks, highTicks, provisional);
    }
  }

  _processOColumn(
    data: PointFigureDisplayRow[],
    state: PointFigureState,
    row: SourceBar,
    closeTicks: number,
    provisional: boolean,
  ): void {
    const columnLowTicks = requiredInteger(state.columnLowTicks, "columnLowTicks");
    if (closeTicks <= columnLowTicks - this.boxTicks) {
      const boxes = Math.floor((columnLowTicks - closeTicks) / this.boxTicks);
      state.columnLowTicks = columnLowTicks - boxes * this.boxTicks;
      state.columnSourceToTime = projectionSourceTimeRange(row).to;
      state.columnCustomValues = cloneCustomValues(row.customValues);
      this._upsertCurrentColumn(data, state, row, provisional);
      return;
    }

    const reversalTicks = this.reversalAmount * this.boxTicks;
    if (!Number.isSafeInteger(reversalTicks)) {
      throw new RangeError("Point & Figure reversal threshold exceeds safe integer tick range");
    }
    if (closeTicks >= columnLowTicks + reversalTicks) {
      const boxes = Math.floor((closeTicks - columnLowTicks) / this.boxTicks);
      const lowTicks = columnLowTicks + this.boxTicks;
      const highTicks = columnLowTicks + boxes * this.boxTicks;
      this._startColumn(data, state, row, "x", lowTicks, highTicks, provisional);
    }
  }

  _startColumn(
    data: PointFigureDisplayRow[],
    state: PointFigureState,
    row: SourceBar,
    direction: Exclude<PointFigureDirection, null>,
    lowTicks: number,
    highTicks: number,
    provisional: boolean,
  ): void {
    const sourceFromTime = state.direction === null
      ? (state.pendingFromTime ?? row.time)
      : (state.columnSourceToTime ?? row.time);
    state.direction = direction;
    state.columnLowTicks = lowTicks;
    state.columnHighTicks = highTicks;
    state.columnOrder = state.nextOrder;
    state.columnSourceFromTime = sourceFromTime;
    state.columnSourceToTime = projectionSourceTimeRange(row).to;
    state.columnCustomValues = cloneCustomValues(row.customValues);
    state.nextOrder += 1;
    state.pendingFromTime = row.time;
    this._upsertCurrentColumn(data, state, row, provisional);
  }

  _upsertCurrentColumn(
    data: PointFigureDisplayRow[],
    state: PointFigureState,
    row: SourceBar,
    provisional: boolean,
  ): void {
    const low = this._ticksToPrice(requiredInteger(state.columnLowTicks, "columnLowTicks"));
    const high = this._ticksToPrice(requiredInteger(state.columnHighTicks, "columnHighTicks"));
    const direction = requiredDirection(state.direction);
    const columnOrder = requiredInteger(state.columnOrder, "columnOrder");
    const isX = direction === "x";
    const point: PointFigureDisplayRow = {
      time: {
        order: columnOrder,
        sourceTime: row.time,
        sourceOrdinal: 0,
      },
      open: isX ? low : high,
      high,
      low,
      close: isX ? high : low,
      customValues: projectionCustomValues(row, {
        boxSize: this._ticksToPrice(this.boxTicks),
        direction,
        provisional,
        reversalAmount: this.reversalAmount,
        sourceFromTime: requiredSourceTime(state.columnSourceFromTime, "columnSourceFromTime"),
      }),
    };
    const existingIndex = data.length - 1;
    const existing = existingIndex >= 0 ? data[existingIndex] : undefined;
    if (existing && displayOrder(existing) === columnOrder) {
      data[existingIndex] = point;
    } else {
      data.push(point);
    }
  }
}
