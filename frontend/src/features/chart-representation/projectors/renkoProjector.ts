import type {
  ProjectionCustomValues,
  ProjectionProjectOptions,
  ProjectionResult,
  ProjectionState,
  Projector,
  RenkoDisplayRow,
  SourceBar,
} from "../chartRepresentationTypes.js";

const RENKO_STATE_VERSION = 1;
type RenkoDirection = "up" | "down" | null;

interface RenkoState extends ProjectionState {
  version: 1;
  projectorId: "renko";
  minTick: number;
  boxTicks: number;
  initialized: boolean;
  lastCloseTicks: number | null;
  direction: RenkoDirection;
  nextOrder: number;
  pendingFromTime: number | null;
}

interface RenkoProjectorOptions {
  boxSize?: unknown;
  maxBricksPerSource?: unknown;
  minTick?: unknown;
}

interface Counter {
  value: number;
}

const DIRECTIONS = new Set<RenkoDirection>([null, "up", "down"]);

function positiveFiniteNumber(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`Renko ${name} must be a positive finite number`);
  }
  return number;
}

function decimalPlaces(value: number): number {
  const [coefficient = "", exponentText] = String(value).toLowerCase().split("e");
  const fractionLength = coefficient.split(".")[1]?.length || 0;
  const exponent = Number(exponentText || 0);
  return Math.max(0, fractionLength - exponent);
}

function cloneState(state: Readonly<RenkoState>): RenkoState {
  return {
    version: RENKO_STATE_VERSION,
    projectorId: "renko",
    minTick: state.minTick,
    boxTicks: state.boxTicks,
    initialized: state.initialized,
    lastCloseTicks: state.lastCloseTicks,
    direction: state.direction,
    nextOrder: state.nextOrder,
    pendingFromTime: state.pendingFromTime,
  };
}

function frozenState(state: Readonly<RenkoState>): Readonly<RenkoState> {
  return Object.freeze(cloneState(state));
}

function initialState({ boxTicks, minTick }: Pick<RenkoState, "boxTicks" | "minTick">): RenkoState {
  return {
    version: RENKO_STATE_VERSION,
    projectorId: "renko",
    minTick,
    boxTicks,
    initialized: false,
    lastCloseTicks: null,
    direction: null,
    nextOrder: 0,
    pendingFromTime: null,
  };
}

function normalizeSeedState(
  seedState: Readonly<RenkoState> | null,
  { boxTicks, minTick }: Pick<RenkoState, "boxTicks" | "minTick">,
): RenkoState {
  if (seedState == null) return initialState({ boxTicks, minTick });
  if (seedState.version !== RENKO_STATE_VERSION
    || seedState.projectorId !== "renko"
    || seedState.boxTicks !== boxTicks
    || seedState.minTick !== minTick) {
    throw new TypeError("Renko seed state is incompatible with projector options");
  }
  if (typeof seedState.initialized !== "boolean"
    || !DIRECTIONS.has(seedState.direction)
    || !Number.isSafeInteger(seedState.nextOrder)
    || seedState.nextOrder < 0
    || (seedState.initialized && !Number.isSafeInteger(seedState.lastCloseTicks))) {
    throw new TypeError("Renko seed state is invalid");
  }
  return cloneState(seedState);
}

function finiteClose(row: SourceBar): number | null {
  const value: unknown = row?.close;
  if (row?.__whitespace || value == null || value === "") return null;
  const close = Number(value);
  return Number.isFinite(close) ? close : null;
}

function activeCloseTicks(state: RenkoState): number {
  if (!Number.isSafeInteger(state.lastCloseTicks)) {
    throw new TypeError("Renko active state requires lastCloseTicks");
  }
  return Number(state.lastCloseTicks);
}

function projectionCustomValues(row: SourceBar, {
  boxSize,
  direction,
  sourceFromTime,
  sourceOrdinal,
  provisional,
}: {
  boxSize: number;
  direction: Exclude<RenkoDirection, null>;
  sourceFromTime: number;
  sourceOrdinal: number;
  provisional: boolean;
}): RenkoDisplayRow["customValues"] {
  return {
    ...(row?.customValues || {}),
    chartProjection: Object.freeze({
      projectorId: "renko",
      sourceFromTime,
      sourceToTime: row.time,
      sourceOrdinal,
      synthetic: true,
      provisional: Boolean(provisional),
    }),
    renko: Object.freeze({
      direction,
      boxSize,
      source: "close",
      wickPolicy: "none",
    }),
  };
}

/**
 * Traditional fixed-box Renko projection.
 *
 * V1 intentionally uses source closes and body-only bricks. Prices are
 * converted to integer minimum-tick units before any threshold comparison.
 */
export class RenkoProjector implements Projector<RenkoState, Record<string, unknown>, RenkoDisplayRow> {
  readonly id: "renko";
  readonly oneToOne: false;
  readonly supportsStatefulTailProjection: true;
  readonly boxSize: number;
  readonly minTick: number;
  readonly boxTicks: number;
  readonly maxBricksPerSource: number;
  readonly pricePrecision: number;

  constructor({
    boxSize = 1,
    maxBricksPerSource = 10_000,
    minTick = 0.01,
  }: RenkoProjectorOptions = {}) {
    this.id = "renko";
    this.oneToOne = false;
    this.supportsStatefulTailProjection = true;
    this.boxSize = positiveFiniteNumber(boxSize, "boxSize");
    this.minTick = positiveFiniteNumber(minTick, "minTick");
    const boxRatio = this.boxSize / this.minTick;
    const roundedBoxTicks = Math.round(boxRatio);
    const tolerance = Number.EPSILON * Math.max(16, Math.abs(boxRatio) * 16);
    if (!Number.isSafeInteger(roundedBoxTicks)
      || roundedBoxTicks <= 0
      || Math.abs(boxRatio - roundedBoxTicks) > tolerance) {
      throw new TypeError("Renko boxSize must be an integer multiple of minTick");
    }
    const brickLimit = Number(maxBricksPerSource);
    if (!Number.isSafeInteger(brickLimit) || brickLimit <= 0) {
      throw new TypeError("Renko maxBricksPerSource must be a positive safe integer");
    }
    this.boxTicks = roundedBoxTicks;
    this.maxBricksPerSource = brickLimit;
    this.pricePrecision = Math.min(12, decimalPlaces(this.minTick));
  }

  project(
    rows: readonly SourceBar[] = [],
    options: ProjectionProjectOptions<RenkoState> = {},
  ): RenkoDisplayRow[] {
    return this.projectWithState(rows, options).data;
  }

  projectWithState(
    rows: readonly SourceBar[] = [],
    { provisional = false, seedState = null }: ProjectionProjectOptions<RenkoState> = {},
  ): ProjectionResult<RenkoState, RenkoDisplayRow> {
    const state = normalizeSeedState(seedState, this);
    const data: RenkoDisplayRow[] = [];
    const checkpoints: Readonly<RenkoState>[] = [];

    for (const row of rows || []) {
      checkpoints.push(frozenState(state));
      if (row?.time == null) continue;
      const close = finiteClose(row);
      if (close == null) continue;
      const closeTicks = this._priceToTicks(close);

      if (!state.initialized) {
        const anchorTicks = Math.floor(closeTicks / this.boxTicks) * this.boxTicks;
        if (!Number.isSafeInteger(anchorTicks)) {
          throw new RangeError("Renko anchor exceeds safe integer tick range");
        }
        state.initialized = true;
        state.lastCloseTicks = anchorTicks;
        state.pendingFromTime = row.time;
      }

      if (state.pendingFromTime == null) state.pendingFromTime = row.time;
      const sourceOrdinal = { value: 0 };
      const emitted = { value: 0 };
      const lastCloseTicks = activeCloseTicks(state);

      if (state.direction === null) {
        if (closeTicks >= lastCloseTicks + this.boxTicks) {
          this._emitContinuation(data, state, row, "up", closeTicks, sourceOrdinal, emitted, provisional);
        } else if (closeTicks <= lastCloseTicks - this.boxTicks) {
          this._emitContinuation(data, state, row, "down", closeTicks, sourceOrdinal, emitted, provisional);
        }
      } else if (state.direction === "up") {
        if (closeTicks >= lastCloseTicks + this.boxTicks) {
          this._emitContinuation(data, state, row, "up", closeTicks, sourceOrdinal, emitted, provisional);
        } else if (closeTicks <= lastCloseTicks - 2 * this.boxTicks) {
          this._emitReversal(data, state, row, "down", sourceOrdinal, emitted, provisional);
          this._emitContinuation(data, state, row, "down", closeTicks, sourceOrdinal, emitted, provisional);
        }
      } else if (closeTicks <= lastCloseTicks - this.boxTicks) {
        this._emitContinuation(data, state, row, "down", closeTicks, sourceOrdinal, emitted, provisional);
      } else if (closeTicks >= lastCloseTicks + 2 * this.boxTicks) {
        this._emitReversal(data, state, row, "up", sourceOrdinal, emitted, provisional);
        this._emitContinuation(data, state, row, "up", closeTicks, sourceOrdinal, emitted, provisional);
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
      throw new RangeError("Renko source price exceeds safe integer tick range");
    }
    return ticks;
  }

  _ticksToPrice(ticks: number): number {
    const price = Number((ticks * this.minTick).toFixed(this.pricePrecision));
    return Object.is(price, -0) ? 0 : price;
  }

  _assertBrickLimit(emitted: Counter): void {
    emitted.value += 1;
    if (emitted.value > this.maxBricksPerSource) {
      throw new RangeError("Renko source row exceeds maxBricksPerSource");
    }
  }

  _emitBrick(
    data: RenkoDisplayRow[],
    state: RenkoState,
    row: SourceBar,
    direction: Exclude<RenkoDirection, null>,
    openTicks: number,
    closeTicks: number,
    sourceOrdinal: Counter,
    emitted: Counter,
    provisional: boolean,
  ): void {
    this._assertBrickLimit(emitted);
    const open = this._ticksToPrice(openTicks);
    const close = this._ticksToPrice(closeTicks);
    const ordinal = sourceOrdinal.value;
    const point = {
      time: {
        order: state.nextOrder,
        sourceTime: row.time,
        sourceOrdinal: ordinal,
      },
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      customValues: projectionCustomValues(row, {
        boxSize: this._ticksToPrice(this.boxTicks),
        direction,
        provisional,
        sourceFromTime: state.pendingFromTime ?? row.time,
        sourceOrdinal: ordinal,
      }),
    };
    data.push(point);
    state.lastCloseTicks = closeTicks;
    state.direction = direction;
    state.nextOrder += 1;
    state.pendingFromTime = row.time;
    sourceOrdinal.value += 1;
  }

  _emitContinuation(
    data: RenkoDisplayRow[],
    state: RenkoState,
    row: SourceBar,
    direction: Exclude<RenkoDirection, null>,
    sourceTicks: number,
    sourceOrdinal: Counter,
    emitted: Counter,
    provisional: boolean,
  ): void {
    const step = direction === "up" ? this.boxTicks : -this.boxTicks;
    const reachedNextBrick = () => direction === "up"
      ? sourceTicks >= activeCloseTicks(state) + this.boxTicks
      : sourceTicks <= activeCloseTicks(state) - this.boxTicks;
    while (reachedNextBrick()) {
      const openTicks = activeCloseTicks(state);
      this._emitBrick(
        data,
        state,
        row,
        direction,
        openTicks,
        openTicks + step,
        sourceOrdinal,
        emitted,
        provisional,
      );
    }
  }

  _emitReversal(
    data: RenkoDisplayRow[],
    state: RenkoState,
    row: SourceBar,
    direction: Exclude<RenkoDirection, null>,
    sourceOrdinal: Counter,
    emitted: Counter,
    provisional: boolean,
  ): void {
    const step = direction === "up" ? this.boxTicks : -this.boxTicks;
    const previousCloseTicks = activeCloseTicks(state);
    this._emitBrick(
      data,
      state,
      row,
      direction,
      previousCloseTicks + step,
      previousCloseTicks + 2 * step,
      sourceOrdinal,
      emitted,
      provisional,
    );
  }
}
