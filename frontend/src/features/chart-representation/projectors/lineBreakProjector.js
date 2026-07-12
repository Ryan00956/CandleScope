const LINE_BREAK_STATE_VERSION = 1;
const DIRECTIONS = new Set(["up", "down"]);

function positiveFiniteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`Line Break ${name} must be a positive finite number`);
  }
  return number;
}

function positiveSafeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`Line Break ${name} must be a positive safe integer`);
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

function cloneLine(line) {
  return {
    direction: line.direction,
    openTicks: line.openTicks,
    highTicks: line.highTicks,
    lowTicks: line.lowTicks,
    closeTicks: line.closeTicks,
    order: line.order,
    sourceFromTime: line.sourceFromTime,
    sourceToTime: line.sourceToTime,
    referenceHighTicks: line.referenceHighTicks,
    referenceLowTicks: line.referenceLowTicks,
    customValues: cloneCustomValues(line.customValues),
  };
}

function frozenLine(line) {
  const cloned = cloneLine(line);
  cloned.customValues = Object.freeze(cloned.customValues);
  return Object.freeze(cloned);
}

function frozenLineWindow(lines) {
  return Object.freeze(lines.map(frozenLine));
}

const EMPTY_LINE_WINDOW = Object.freeze([]);

function cloneState(state, { copyWindow = false } = {}) {
  return {
    version: LINE_BREAK_STATE_VERSION,
    projectorId: "line-break",
    minTick: state.minTick,
    numberOfLines: state.numberOfLines,
    initialized: state.initialized,
    anchorTicks: state.anchorTicks,
    pendingFromTime: state.pendingFromTime,
    lineWindow: copyWindow ? frozenLineWindow(state.lineWindow) : state.lineWindow,
    nextOrder: state.nextOrder,
  };
}

function frozenState(state) {
  const cloned = cloneState(state);
  return Object.freeze(cloned);
}

function initialState({ minTick, numberOfLines }) {
  return {
    version: LINE_BREAK_STATE_VERSION,
    projectorId: "line-break",
    minTick,
    numberOfLines,
    initialized: false,
    anchorTicks: null,
    pendingFromTime: null,
    lineWindow: EMPTY_LINE_WINDOW,
    nextOrder: 0,
  };
}

function validLine(line, nextOrder) {
  return line != null
    && DIRECTIONS.has(line.direction)
    && Number.isSafeInteger(line.openTicks)
    && Number.isSafeInteger(line.highTicks)
    && Number.isSafeInteger(line.lowTicks)
    && Number.isSafeInteger(line.closeTicks)
    && line.highTicks >= Math.max(line.openTicks, line.closeTicks)
    && line.lowTicks <= Math.min(line.openTicks, line.closeTicks)
    && Number.isSafeInteger(line.order)
    && line.order >= 0
    && line.order < nextOrder
    && line.sourceFromTime != null
    && line.sourceToTime != null
    && Number.isSafeInteger(line.referenceHighTicks)
    && Number.isSafeInteger(line.referenceLowTicks);
}

function normalizeSeedState(seedState, { minTick, numberOfLines }) {
  if (seedState == null) return initialState({ minTick, numberOfLines });
  if (seedState.version !== LINE_BREAK_STATE_VERSION
    || seedState.projectorId !== "line-break"
    || seedState.minTick !== minTick
    || seedState.numberOfLines !== numberOfLines) {
    throw new TypeError("Line Break seed state is incompatible with projector options");
  }
  if (typeof seedState.initialized !== "boolean"
    || !Array.isArray(seedState.lineWindow)
    || seedState.lineWindow.length > numberOfLines
    || !Number.isSafeInteger(seedState.nextOrder)
    || seedState.nextOrder < 0
    || (seedState.initialized && !Number.isSafeInteger(seedState.anchorTicks))
    || seedState.lineWindow.some((line) => !validLine(line, seedState.nextOrder))) {
    throw new TypeError("Line Break seed state is invalid");
  }
  for (let index = 1; index < seedState.lineWindow.length; index += 1) {
    if (seedState.lineWindow[index - 1].order >= seedState.lineWindow[index].order) {
      throw new TypeError("Line Break seed state is invalid");
    }
  }
  // Even when the seed originated from this projector, take one defensive
  // copy at the public boundary. Internal checkpoints can then safely share
  // the resulting persistent immutable window.
  return cloneState(seedState, { copyWindow: true });
}

function finiteClose(row) {
  if (row?.__whitespace || row?.close == null || row.close === "") return null;
  const close = Number(row.close);
  return Number.isFinite(close) ? close : null;
}

function projectionCustomValues(line, {
  numberOfLines,
  provisional,
  referenceHigh,
  referenceLow,
}) {
  return {
    ...line.customValues,
    chartProjection: Object.freeze({
      projectorId: "line-break",
      sourceFromTime: line.sourceFromTime,
      sourceToTime: line.sourceToTime,
      sourceOrdinal: 0,
      synthetic: true,
      provisional: Boolean(provisional),
    }),
    lineBreak: Object.freeze({
      direction: line.direction,
      numberOfLines,
      source: "close",
      referenceHigh,
      referenceLow,
    }),
  };
}

/**
 * Close-only N-Line Break projection.
 *
 * The first close anchors the projection and the next different close creates
 * the first line. Later closes create at most one line and must be strictly
 * outside the high/low envelope of the latest min(N, lineCount) lines.
 * Checkpoints retain only that bounded decision window. TradingView does not
 * publish a synthetic OHLC encoding, so CandleScope V1 uses the classic bar
 * convention: a new up line opens at the previous confirmed line's high and a
 * new down line opens at its low.
 */
export class LineBreakProjector {
  constructor({ minTick = 0.01, numberOfLines = 3 } = {}) {
    this.id = "line-break";
    this.oneToOne = false;
    this.supportsStatefulTailProjection = true;
    this.minTick = positiveFiniteNumber(minTick, "minTick");
    this.numberOfLines = positiveSafeInteger(numberOfLines, "numberOfLines");
    this.pricePrecision = Math.min(12, decimalPlaces(this.minTick));
  }

  project(rows = [], options = {}) {
    return this.projectWithState(rows, options).data;
  }

  projectWithState(rows = [], { provisional = false, seedState = null } = {}) {
    const state = normalizeSeedState(seedState, this);
    const data = [];
    const checkpoints = [];

    const hasRetainedSource = (rows || []).some((row) => row?.time != null);
    if (seedState != null && state.lineWindow.length > 0 && hasRetainedSource) {
      this._emitLine(data, state.lineWindow[state.lineWindow.length - 1], false);
    }

    for (const row of rows || []) {
      checkpoints.push(frozenState(state));
      if (row?.time == null) continue;
      const close = finiteClose(row);
      if (close == null) continue;
      const closeTicks = this._priceToTicks(close);

      if (!state.initialized) {
        state.initialized = true;
        state.anchorTicks = closeTicks;
        state.pendingFromTime = row.time;
        continue;
      }

      if (state.lineWindow.length === 0) {
        if (closeTicks !== state.anchorTicks) {
          this._appendLine(data, state, row, {
            closeTicks,
            direction: closeTicks > state.anchorTicks ? "up" : "down",
            openTicks: state.anchorTicks,
            provisional,
            referenceHighTicks: state.anchorTicks,
            referenceLowTicks: state.anchorTicks,
            sourceFromTime: state.pendingFromTime ?? row.time,
          });
        }
        continue;
      }

      const { referenceHighTicks, referenceLowTicks } = this._referenceRange(state.lineWindow);
      const activeLine = state.lineWindow[state.lineWindow.length - 1];
      if (closeTicks > referenceHighTicks) {
        this._appendLine(data, state, row, {
          closeTicks,
          direction: "up",
          openTicks: activeLine.highTicks,
          provisional,
          referenceHighTicks,
          referenceLowTicks,
          sourceFromTime: activeLine.sourceToTime,
        });
      } else if (closeTicks < referenceLowTicks) {
        this._appendLine(data, state, row, {
          closeTicks,
          direction: "down",
          openTicks: activeLine.lowTicks,
          provisional,
          referenceHighTicks,
          referenceLowTicks,
          sourceFromTime: activeLine.sourceToTime,
        });
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
      throw new RangeError("Line Break source price exceeds safe integer tick range");
    }
    return ticks;
  }

  _ticksToPrice(ticks) {
    const price = Number((ticks * this.minTick).toFixed(this.pricePrecision));
    return Object.is(price, -0) ? 0 : price;
  }

  _referenceRange(lineWindow) {
    let referenceHighTicks = -Infinity;
    let referenceLowTicks = Infinity;
    for (const line of lineWindow) {
      referenceHighTicks = Math.max(referenceHighTicks, line.highTicks);
      referenceLowTicks = Math.min(referenceLowTicks, line.lowTicks);
    }
    return { referenceHighTicks, referenceLowTicks };
  }

  _appendLine(data, state, row, {
    closeTicks,
    direction,
    openTicks,
    provisional,
    referenceHighTicks,
    referenceLowTicks,
    sourceFromTime,
  }) {
    const line = frozenLine({
      direction,
      openTicks,
      highTicks: Math.max(openTicks, closeTicks),
      lowTicks: Math.min(openTicks, closeTicks),
      closeTicks,
      order: state.nextOrder,
      sourceFromTime,
      sourceToTime: row.time,
      referenceHighTicks,
      referenceLowTicks,
      customValues: cloneCustomValues(row.customValues),
    });
    state.nextOrder += 1;
    state.pendingFromTime = row.time;
    state.lineWindow = Object.freeze(
      [...state.lineWindow, line].slice(-this.numberOfLines),
    );
    this._emitLine(data, line, provisional);
  }

  _emitLine(data, line, provisional) {
    const open = this._ticksToPrice(line.openTicks);
    const close = this._ticksToPrice(line.closeTicks);
    const referenceHigh = this._ticksToPrice(line.referenceHighTicks);
    const referenceLow = this._ticksToPrice(line.referenceLowTicks);
    data.push({
      time: {
        order: line.order,
        sourceTime: line.sourceToTime,
        sourceOrdinal: 0,
      },
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      customValues: projectionCustomValues(line, {
        numberOfLines: this.numberOfLines,
        provisional,
        referenceHigh,
        referenceLow,
      }),
    });
  }
}
