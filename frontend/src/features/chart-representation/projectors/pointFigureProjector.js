const POINT_FIGURE_STATE_VERSION = 1;
const DIRECTIONS = new Set([null, "x", "o"]);

function positiveFiniteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`Point & Figure ${name} must be a positive finite number`);
  }
  return number;
}

function positiveSafeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`Point & Figure ${name} must be a positive safe integer`);
  }
  return number;
}

function decimalPlaces(value) {
  const [coefficient, exponentText] = String(value).toLowerCase().split("e");
  const fractionLength = coefficient.split(".")[1]?.length || 0;
  const exponent = Number(exponentText || 0);
  return Math.max(0, fractionLength - exponent);
}

function cloneCustomValues(customValues) {
  if (!customValues || typeof customValues !== "object") return {};
  return { ...customValues };
}

function cloneState(state) {
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

function frozenState(state) {
  const cloned = cloneState(state);
  cloned.columnCustomValues = Object.freeze(cloned.columnCustomValues);
  return Object.freeze(cloned);
}

function initialState({ boxTicks, minTick, reversalAmount }) {
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

function validColumnState(state) {
  if (state.direction === null) {
    return state.columnLowTicks == null
      && state.columnHighTicks == null
      && state.columnOrder == null;
  }
  return Number.isSafeInteger(state.columnLowTicks)
    && Number.isSafeInteger(state.columnHighTicks)
    && state.columnLowTicks <= state.columnHighTicks
    && Number.isSafeInteger(state.columnOrder)
    && state.columnOrder >= 0
    && state.columnOrder < state.nextOrder
    && state.columnSourceFromTime != null
    && state.columnSourceToTime != null;
}

function normalizeSeedState(seedState, { boxTicks, minTick, reversalAmount }) {
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

function finiteClose(row) {
  if (row?.__whitespace || row?.close == null || row.close === "") return null;
  const close = Number(row.close);
  return Number.isFinite(close) ? close : null;
}

function projectionCustomValues(row, {
  boxSize,
  direction,
  provisional,
  reversalAmount,
  sourceFromTime,
}) {
  return {
    ...(row?.customValues || {}),
    chartProjection: Object.freeze({
      projectorId: "point-and-figure",
      sourceFromTime,
      sourceToTime: row.time,
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
export class PointFigureProjector {
  constructor({
    boxSize = 1,
    minTick = 0.01,
    reversalAmount = 3,
  } = {}) {
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

  project(rows = [], options = {}) {
    return this.projectWithState(rows, options).data;
  }

  projectWithState(rows = [], { provisional = false, seedState = null } = {}) {
    const state = normalizeSeedState(seedState, this);
    const data = [];
    const checkpoints = [];

    // The active column may have started before a trim-left checkpoint. Carry
    // it into the new projection so a no-op retained row cannot make it vanish.
    const hasRetainedSource = (rows || []).some((row) => row?.time != null);
    if (seedState != null && state.direction !== null && hasRetainedSource) {
      this._upsertCurrentColumn(data, state, {
        time: state.columnSourceToTime,
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

  _priceToTicks(price) {
    const ticks = Math.round(price / this.minTick);
    if (!Number.isSafeInteger(ticks)) {
      throw new RangeError("Point & Figure source price exceeds safe integer tick range");
    }
    return ticks;
  }

  _ticksToPrice(ticks) {
    const price = Number((ticks * this.minTick).toFixed(this.pricePrecision));
    return Object.is(price, -0) ? 0 : price;
  }

  _startFirstColumn(data, state, row, closeTicks, provisional) {
    if (closeTicks >= state.anchorTicks + this.boxTicks) {
      const boxes = Math.floor((closeTicks - state.anchorTicks) / this.boxTicks);
      const lowTicks = state.anchorTicks + this.boxTicks;
      const highTicks = state.anchorTicks + boxes * this.boxTicks;
      this._startColumn(data, state, row, "x", lowTicks, highTicks, provisional);
    } else if (closeTicks <= state.anchorTicks - this.boxTicks) {
      const boxes = Math.floor((state.anchorTicks - closeTicks) / this.boxTicks);
      const highTicks = state.anchorTicks - this.boxTicks;
      const lowTicks = state.anchorTicks - boxes * this.boxTicks;
      this._startColumn(data, state, row, "o", lowTicks, highTicks, provisional);
    }
  }

  _processXColumn(data, state, row, closeTicks, provisional) {
    if (closeTicks >= state.columnHighTicks + this.boxTicks) {
      const boxes = Math.floor((closeTicks - state.columnHighTicks) / this.boxTicks);
      state.columnHighTicks += boxes * this.boxTicks;
      state.columnSourceToTime = row.time;
      state.columnCustomValues = cloneCustomValues(row.customValues);
      this._upsertCurrentColumn(data, state, row, provisional);
      return;
    }

    const reversalTicks = this.reversalAmount * this.boxTicks;
    if (!Number.isSafeInteger(reversalTicks)) {
      throw new RangeError("Point & Figure reversal threshold exceeds safe integer tick range");
    }
    if (closeTicks <= state.columnHighTicks - reversalTicks) {
      const boxes = Math.floor((state.columnHighTicks - closeTicks) / this.boxTicks);
      const highTicks = state.columnHighTicks - this.boxTicks;
      const lowTicks = state.columnHighTicks - boxes * this.boxTicks;
      this._startColumn(data, state, row, "o", lowTicks, highTicks, provisional);
    }
  }

  _processOColumn(data, state, row, closeTicks, provisional) {
    if (closeTicks <= state.columnLowTicks - this.boxTicks) {
      const boxes = Math.floor((state.columnLowTicks - closeTicks) / this.boxTicks);
      state.columnLowTicks -= boxes * this.boxTicks;
      state.columnSourceToTime = row.time;
      state.columnCustomValues = cloneCustomValues(row.customValues);
      this._upsertCurrentColumn(data, state, row, provisional);
      return;
    }

    const reversalTicks = this.reversalAmount * this.boxTicks;
    if (!Number.isSafeInteger(reversalTicks)) {
      throw new RangeError("Point & Figure reversal threshold exceeds safe integer tick range");
    }
    if (closeTicks >= state.columnLowTicks + reversalTicks) {
      const boxes = Math.floor((closeTicks - state.columnLowTicks) / this.boxTicks);
      const lowTicks = state.columnLowTicks + this.boxTicks;
      const highTicks = state.columnLowTicks + boxes * this.boxTicks;
      this._startColumn(data, state, row, "x", lowTicks, highTicks, provisional);
    }
  }

  _startColumn(data, state, row, direction, lowTicks, highTicks, provisional) {
    const sourceFromTime = state.direction === null
      ? (state.pendingFromTime ?? row.time)
      : (state.columnSourceToTime ?? row.time);
    state.direction = direction;
    state.columnLowTicks = lowTicks;
    state.columnHighTicks = highTicks;
    state.columnOrder = state.nextOrder;
    state.columnSourceFromTime = sourceFromTime;
    state.columnSourceToTime = row.time;
    state.columnCustomValues = cloneCustomValues(row.customValues);
    state.nextOrder += 1;
    state.pendingFromTime = row.time;
    this._upsertCurrentColumn(data, state, row, provisional);
  }

  _upsertCurrentColumn(data, state, row, provisional) {
    const low = this._ticksToPrice(state.columnLowTicks);
    const high = this._ticksToPrice(state.columnHighTicks);
    const isX = state.direction === "x";
    const point = {
      time: {
        order: state.columnOrder,
        sourceTime: row.time,
        sourceOrdinal: 0,
      },
      open: isX ? low : high,
      high,
      low,
      close: isX ? high : low,
      customValues: projectionCustomValues(row, {
        boxSize: this._ticksToPrice(this.boxTicks),
        direction: state.direction,
        provisional,
        reversalAmount: this.reversalAmount,
        sourceFromTime: state.columnSourceFromTime,
      }),
    };
    const existingIndex = data.length - 1;
    if (existingIndex >= 0 && data[existingIndex].time.order === state.columnOrder) {
      data[existingIndex] = point;
    } else {
      data.push(point);
    }
  }
}
