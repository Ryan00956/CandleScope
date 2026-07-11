const KAGI_STATE_VERSION = 1;
const DIRECTIONS = new Set([null, "up", "down"]);
const STYLES = new Set(["yang", "yin"]);
const REVERSAL_KINDS = new Set([null, "shoulder", "waist"]);

function positiveFiniteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`Kagi ${name} must be a positive finite number`);
  }
  return number;
}

function positiveSafeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`Kagi ${name} must be a positive safe integer`);
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
    version: KAGI_STATE_VERSION,
    projectorId: "kagi",
    minTick: state.minTick,
    reversalTicks: state.reversalTicks,
    initialized: state.initialized,
    anchorTicks: state.anchorTicks,
    direction: state.direction,
    currentStyle: state.currentStyle,
    previousShoulderTicks: state.previousShoulderTicks,
    previousWaistTicks: state.previousWaistTicks,
    legStartTicks: state.legStartTicks,
    legEndTicks: state.legEndTicks,
    legStartStyle: state.legStartStyle,
    legOrder: state.legOrder,
    legReversalKind: state.legReversalKind,
    legTurnTicks: state.legTurnTicks,
    legSourceFromTime: state.legSourceFromTime,
    legSourceToTime: state.legSourceToTime,
    legCustomValues: cloneCustomValues(state.legCustomValues),
    nextOrder: state.nextOrder,
    pendingFromTime: state.pendingFromTime,
  };
}

function frozenState(state) {
  const cloned = cloneState(state);
  cloned.legCustomValues = Object.freeze(cloned.legCustomValues);
  return Object.freeze(cloned);
}

function initialState({ minTick, reversalTicks }) {
  return {
    version: KAGI_STATE_VERSION,
    projectorId: "kagi",
    minTick,
    reversalTicks,
    initialized: false,
    anchorTicks: null,
    direction: null,
    currentStyle: "yin",
    previousShoulderTicks: null,
    previousWaistTicks: null,
    legStartTicks: null,
    legEndTicks: null,
    legStartStyle: null,
    legOrder: null,
    legReversalKind: null,
    legTurnTicks: null,
    legSourceFromTime: null,
    legSourceToTime: null,
    legCustomValues: {},
    nextOrder: 0,
    pendingFromTime: null,
  };
}

function safeIntegerOrNull(value) {
  return value == null || Number.isSafeInteger(value);
}

function validActiveLeg(state) {
  if (state.direction === null) {
    return state.legStartTicks == null
      && state.legEndTicks == null
      && state.legStartStyle == null
      && state.legOrder == null
      && state.legReversalKind == null
      && state.legTurnTicks == null;
  }
  return Number.isSafeInteger(state.legStartTicks)
    && Number.isSafeInteger(state.legEndTicks)
    && state.legStartTicks !== state.legEndTicks
    && STYLES.has(state.legStartStyle)
    && Number.isSafeInteger(state.legOrder)
    && state.legOrder >= 0
    && state.legOrder < state.nextOrder
    && REVERSAL_KINDS.has(state.legReversalKind)
    && safeIntegerOrNull(state.legTurnTicks)
    && state.legSourceFromTime != null
    && state.legSourceToTime != null
    && (state.direction === "up"
      ? state.legEndTicks > state.legStartTicks
      : state.legEndTicks < state.legStartTicks);
}

function normalizeSeedState(seedState, { minTick, reversalTicks }) {
  if (seedState == null) return initialState({ minTick, reversalTicks });
  if (seedState.version !== KAGI_STATE_VERSION
    || seedState.projectorId !== "kagi"
    || seedState.minTick !== minTick
    || seedState.reversalTicks !== reversalTicks) {
    throw new TypeError("Kagi seed state is incompatible with projector options");
  }
  if (typeof seedState.initialized !== "boolean"
    || !DIRECTIONS.has(seedState.direction)
    || !STYLES.has(seedState.currentStyle)
    || !safeIntegerOrNull(seedState.previousShoulderTicks)
    || !safeIntegerOrNull(seedState.previousWaistTicks)
    || !Number.isSafeInteger(seedState.nextOrder)
    || seedState.nextOrder < 0
    || (seedState.initialized && !Number.isSafeInteger(seedState.anchorTicks))
    || !validActiveLeg(seedState)) {
    throw new TypeError("Kagi seed state is invalid");
  }
  return cloneState(seedState);
}

function finiteClose(row) {
  if (row?.__whitespace || row?.close == null || row.close === "") return null;
  const close = Number(row.close);
  return Number.isFinite(close) ? close : null;
}

function freezeSections(sections) {
  return Object.freeze(sections.map((section) => Object.freeze(section)));
}

function projectionCustomValues(row, {
  direction,
  provisional,
  reversalAmount,
  reversalKind,
  reversalTicks,
  sections,
  sourceFromTime,
  state,
  turnPrice,
}) {
  return {
    ...(row?.customValues || {}),
    chartProjection: Object.freeze({
      projectorId: "kagi",
      sourceFromTime,
      sourceToTime: row.time,
      sourceOrdinal: 0,
      synthetic: true,
      provisional: Boolean(provisional),
    }),
    kagi: Object.freeze({
      direction,
      state,
      reversalKind,
      turnPrice,
      reversalAmount,
      reversalTicks,
      source: "close",
      sections: freezeSections(sections),
    }),
  };
}

/**
 * Close-only Kagi projection using an already-resolved reversal size in ticks.
 *
 * One semantic OHLC item represents one directional leg. Direction and
 * Yang/Yin style are independent: an up leg becomes Yang only after strictly
 * breaking the previous shoulder, while a down leg becomes Yin only after
 * strictly breaking the previous waist. Mid-leg style changes are retained in
 * customValues.kagi.sections without allocating another ordinal-axis item.
 */
export class KagiProjector {
  constructor({ minTick = 0.01, reversalTicks = 1 } = {}) {
    this.id = "kagi";
    this.oneToOne = false;
    this.minTick = positiveFiniteNumber(minTick, "minTick");
    this.reversalTicks = positiveSafeInteger(reversalTicks, "reversalTicks");
    this.pricePrecision = Math.min(12, decimalPlaces(this.minTick));
    this.reversalAmount = this._ticksToPrice(this.reversalTicks);
    if (!Number.isFinite(this.reversalAmount) || this.reversalAmount <= 0) {
      throw new RangeError("Kagi reversal amount exceeds the supported price range");
    }
  }

  project(rows = [], options = {}) {
    return this.projectWithState(rows, options).data;
  }

  projectWithState(rows = [], { provisional = false, seedState = null } = {}) {
    const state = normalizeSeedState(seedState, this);
    const data = [];
    const checkpoints = [];

    const hasRetainedSource = (rows || []).some((row) => row?.time != null);
    if (seedState != null && state.direction !== null && hasRetainedSource) {
      this._upsertActiveLeg(data, state, {
        time: state.legSourceToTime,
        customValues: state.legCustomValues,
      }, false);
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

      if (state.direction === null) {
        if (Math.abs(closeTicks - state.anchorTicks) >= this.reversalTicks) {
          this._startLeg(
            data,
            state,
            row,
            closeTicks > state.anchorTicks ? "up" : "down",
            state.anchorTicks,
            closeTicks,
            null,
            null,
            provisional,
          );
        }
      } else if (state.direction === "up") {
        this._processUpLeg(data, state, row, closeTicks, provisional);
      } else {
        this._processDownLeg(data, state, row, closeTicks, provisional);
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
      throw new RangeError("Kagi source price exceeds safe integer tick range");
    }
    return ticks;
  }

  _ticksToPrice(ticks) {
    const price = Number((ticks * this.minTick).toFixed(this.pricePrecision));
    return Object.is(price, -0) ? 0 : price;
  }

  _processUpLeg(data, state, row, closeTicks, provisional) {
    if (closeTicks > state.legEndTicks) {
      this._extendActiveLeg(data, state, row, closeTicks, provisional);
    } else if (state.legEndTicks - closeTicks >= this.reversalTicks) {
      const turnTicks = state.legEndTicks;
      state.previousShoulderTicks = turnTicks;
      this._startLeg(
        data,
        state,
        row,
        "down",
        turnTicks,
        closeTicks,
        "shoulder",
        turnTicks,
        provisional,
      );
    }
  }

  _processDownLeg(data, state, row, closeTicks, provisional) {
    if (closeTicks < state.legEndTicks) {
      this._extendActiveLeg(data, state, row, closeTicks, provisional);
    } else if (closeTicks - state.legEndTicks >= this.reversalTicks) {
      const turnTicks = state.legEndTicks;
      state.previousWaistTicks = turnTicks;
      this._startLeg(
        data,
        state,
        row,
        "up",
        turnTicks,
        closeTicks,
        "waist",
        turnTicks,
        provisional,
      );
    }
  }

  _extendActiveLeg(data, state, row, closeTicks, provisional) {
    state.legEndTicks = closeTicks;
    state.legSourceToTime = row.time;
    state.legCustomValues = cloneCustomValues(row.customValues);
    state.currentStyle = this._sectionsForState(state).tailStyle;
    this._upsertActiveLeg(data, state, row, provisional);
  }

  _startLeg(
    data,
    state,
    row,
    direction,
    startTicks,
    endTicks,
    reversalKind,
    turnTicks,
    provisional,
  ) {
    const sourceFromTime = state.direction === null
      ? (state.pendingFromTime ?? row.time)
      : (state.legSourceToTime ?? row.time);
    const startStyle = state.currentStyle;
    state.direction = direction;
    state.legStartTicks = startTicks;
    state.legEndTicks = endTicks;
    state.legStartStyle = startStyle;
    state.legOrder = state.nextOrder;
    state.legReversalKind = reversalKind;
    state.legTurnTicks = turnTicks;
    state.legSourceFromTime = sourceFromTime;
    state.legSourceToTime = row.time;
    state.legCustomValues = cloneCustomValues(row.customValues);
    state.nextOrder += 1;
    state.pendingFromTime = row.time;
    state.currentStyle = this._sectionsForState(state).tailStyle;
    this._upsertActiveLeg(data, state, row, provisional);
  }

  _sectionsForState(state) {
    const startTicks = state.legStartTicks;
    const endTicks = state.legEndTicks;
    const startStyle = state.legStartStyle;
    let boundaryTicks = null;
    let nextStyle = startStyle;

    if (state.direction === "up"
      && startStyle === "yin"
      && state.previousShoulderTicks != null
      && endTicks > state.previousShoulderTicks) {
      boundaryTicks = state.previousShoulderTicks;
      nextStyle = "yang";
    } else if (state.direction === "down"
      && startStyle === "yang"
      && state.previousWaistTicks != null
      && endTicks < state.previousWaistTicks) {
      boundaryTicks = state.previousWaistTicks;
      nextStyle = "yin";
    }

    if (boundaryTicks == null) {
      return {
        sections: [{
          from: this._ticksToPrice(startTicks),
          to: this._ticksToPrice(endTicks),
          style: startStyle,
        }],
        tailStyle: startStyle,
      };
    }

    const sections = [];
    if (startTicks !== boundaryTicks) {
      sections.push({
        from: this._ticksToPrice(startTicks),
        to: this._ticksToPrice(boundaryTicks),
        style: startStyle,
      });
    }
    sections.push({
      from: this._ticksToPrice(boundaryTicks),
      to: this._ticksToPrice(endTicks),
      style: nextStyle,
    });
    return { sections, tailStyle: nextStyle };
  }

  _upsertActiveLeg(data, state, row, provisional) {
    const open = this._ticksToPrice(state.legStartTicks);
    const close = this._ticksToPrice(state.legEndTicks);
    const { sections, tailStyle } = this._sectionsForState(state);
    const point = {
      time: {
        order: state.legOrder,
        sourceTime: row.time,
        sourceOrdinal: 0,
      },
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      customValues: projectionCustomValues(row, {
        direction: state.direction,
        provisional,
        reversalAmount: this.reversalAmount,
        reversalKind: state.legReversalKind,
        reversalTicks: this.reversalTicks,
        sections,
        sourceFromTime: state.legSourceFromTime,
        state: tailStyle,
        turnPrice: state.legTurnTicks == null
          ? null
          : this._ticksToPrice(state.legTurnTicks),
      }),
    };
    const existingIndex = data.length - 1;
    if (existingIndex >= 0 && data[existingIndex].time.order === state.legOrder) {
      data[existingIndex] = point;
    } else {
      data.push(point);
    }
  }
}
