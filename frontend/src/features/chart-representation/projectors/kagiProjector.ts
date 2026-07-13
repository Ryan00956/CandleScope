import type {
  DisplayRow,
  KagiDisplayRow,
  ProjectionCustomValues,
  ProjectionProjectOptions,
  ProjectionResult,
  ProjectionState,
  Projector,
  SourceBar,
} from "../chartRepresentationTypes.js";

const KAGI_STATE_VERSION = 1;
type KagiDirection = "up" | "down" | null;
type KagiStyle = "yang" | "yin";
type KagiReversalKind = "shoulder" | "waist" | null;

interface KagiState extends ProjectionState {
  version: 1;
  projectorId: "kagi";
  minTick: number;
  reversalTicks: number;
  initialized: boolean;
  anchorTicks: number | null;
  direction: KagiDirection;
  currentStyle: KagiStyle;
  previousShoulderTicks: number | null;
  previousWaistTicks: number | null;
  legStartTicks: number | null;
  legEndTicks: number | null;
  legStartStyle: KagiStyle | null;
  legOrder: number | null;
  legReversalKind: KagiReversalKind;
  legTurnTicks: number | null;
  legSourceFromTime: number | null;
  legSourceToTime: number | null;
  legCustomValues: ProjectionCustomValues;
  nextOrder: number;
  pendingFromTime: number | null;
}

interface KagiProjectorOptions {
  minTick?: unknown;
  reversalTicks?: unknown;
}

interface KagiSection {
  from: number;
  to: number;
  style: KagiStyle;
}

interface KagiSectionsResult {
  sections: KagiSection[];
  tailStyle: KagiStyle;
}

const DIRECTIONS = new Set<KagiDirection>([null, "up", "down"]);
const STYLES = new Set<KagiStyle>(["yang", "yin"]);
const REVERSAL_KINDS = new Set<KagiReversalKind>([null, "shoulder", "waist"]);

function positiveFiniteNumber(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`Kagi ${name} must be a positive finite number`);
  }
  return number;
}

function positiveSafeInteger(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`Kagi ${name} must be a positive safe integer`);
  }
  return number;
}

function decimalPlaces(value: number): number {
  const [coefficient, exponentText] = String(value).toLowerCase().split("e");
  const fractionLength = coefficient.split(".")[1]?.length || 0;
  const exponent = Number(exponentText || 0);
  return Math.max(0, fractionLength - exponent);
}

function cloneCustomValues(customValues: unknown): ProjectionCustomValues {
  if (!customValues || typeof customValues !== "object") return {};
  return { ...customValues };
}

function cloneState(state: Readonly<KagiState>): KagiState {
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

function frozenState(state: Readonly<KagiState>): Readonly<KagiState> {
  const cloned = cloneState(state);
  cloned.legCustomValues = Object.freeze(cloned.legCustomValues);
  return Object.freeze(cloned);
}

function initialState({
  minTick,
  reversalTicks,
}: Pick<KagiState, "minTick" | "reversalTicks">): KagiState {
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

function safeIntegerOrNull(value: unknown): boolean {
  return value == null || Number.isSafeInteger(value);
}

function validActiveLeg(state: Readonly<KagiState>): boolean {
  if (state.direction === null) {
    return state.legStartTicks == null
      && state.legEndTicks == null
      && state.legStartStyle == null
      && state.legOrder == null
      && state.legReversalKind == null
      && state.legTurnTicks == null;
  }
  return typeof state.legStartTicks === "number"
    && Number.isSafeInteger(state.legStartTicks)
    && typeof state.legEndTicks === "number"
    && Number.isSafeInteger(state.legEndTicks)
    && state.legStartTicks !== state.legEndTicks
    && state.legStartStyle !== null
    && STYLES.has(state.legStartStyle)
    && typeof state.legOrder === "number"
    && Number.isSafeInteger(state.legOrder)
    && state.legOrder >= 0
    && state.legOrder < state.nextOrder
    && REVERSAL_KINDS.has(state.legReversalKind)
    && safeIntegerOrNull(state.legTurnTicks)
    && typeof state.legSourceFromTime === "number"
    && Number.isFinite(state.legSourceFromTime)
    && typeof state.legSourceToTime === "number"
    && Number.isFinite(state.legSourceToTime)
    && (state.direction === "up"
      ? state.legEndTicks > state.legStartTicks
      : state.legEndTicks < state.legStartTicks);
}

function requiredInteger(value: number | null, name: string): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`Kagi active state requires ${name}`);
  return Number(value);
}

function requiredSourceTime(value: number | null, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Kagi active state requires ${name}`);
  }
  return value;
}

function requiredDirection(direction: KagiDirection): Exclude<KagiDirection, null> {
  if (direction === null) throw new TypeError("Kagi active state requires direction");
  return direction;
}

function requiredStyle(style: KagiStyle | null): KagiStyle {
  if (style === null) throw new TypeError("Kagi active state requires legStartStyle");
  return style;
}

function displayOrder(row: DisplayRow): number | null {
  return typeof row.time === "object" ? row.time.order : null;
}

function normalizeSeedState(
  seedState: Readonly<KagiState> | null,
  { minTick, reversalTicks }: Pick<KagiState, "minTick" | "reversalTicks">,
): KagiState {
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

function finiteClose(row: SourceBar): number | null {
  const value: unknown = row?.close;
  if (row?.__whitespace || value == null || value === "") return null;
  const close = Number(value);
  return Number.isFinite(close) ? close : null;
}

function freezeSections(sections: KagiSection[]): readonly Readonly<KagiSection>[] {
  return Object.freeze(sections.map((section) => Object.freeze(section)));
}

function projectionCustomValues(row: SourceBar, {
  direction,
  provisional,
  reversalAmount,
  reversalKind,
  reversalTicks,
  sections,
  sourceFromTime,
  state,
  turnPrice,
}: {
  direction: Exclude<KagiDirection, null>;
  provisional: boolean;
  reversalAmount: number;
  reversalKind: KagiReversalKind;
  reversalTicks: number;
  sections: KagiSection[];
  sourceFromTime: number;
  state: KagiStyle;
  turnPrice: number | null;
}): KagiDisplayRow["customValues"] {
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
export class KagiProjector implements Projector<KagiState, Record<string, unknown>, KagiDisplayRow> {
  readonly id: "kagi";
  readonly oneToOne: false;
  readonly supportsStatefulTailProjection: true;
  readonly minTick: number;
  readonly reversalTicks: number;
  readonly pricePrecision: number;
  readonly reversalAmount: number;

  constructor({ minTick = 0.01, reversalTicks = 1 }: KagiProjectorOptions = {}) {
    this.id = "kagi";
    this.oneToOne = false;
    this.supportsStatefulTailProjection = true;
    this.minTick = positiveFiniteNumber(minTick, "minTick");
    this.reversalTicks = positiveSafeInteger(reversalTicks, "reversalTicks");
    this.pricePrecision = Math.min(12, decimalPlaces(this.minTick));
    this.reversalAmount = this._ticksToPrice(this.reversalTicks);
    if (!Number.isFinite(this.reversalAmount) || this.reversalAmount <= 0) {
      throw new RangeError("Kagi reversal amount exceeds the supported price range");
    }
  }

  project(
    rows: readonly SourceBar[] = [],
    options: ProjectionProjectOptions<KagiState> = {},
  ): KagiDisplayRow[] {
    return this.projectWithState(rows, options).data;
  }

  projectWithState(
    rows: readonly SourceBar[] = [],
    { provisional = false, seedState = null }: ProjectionProjectOptions<KagiState> = {},
  ): ProjectionResult<KagiState, KagiDisplayRow> {
    const state = normalizeSeedState(seedState, this);
    const data: KagiDisplayRow[] = [];
    const checkpoints: Readonly<KagiState>[] = [];

    const hasRetainedSource = (rows || []).some((row) => row?.time != null);
    if (seedState != null && state.direction !== null && hasRetainedSource) {
      this._upsertActiveLeg(data, state, {
        time: requiredSourceTime(state.legSourceToTime, "legSourceToTime"),
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
        const anchorTicks = requiredInteger(state.anchorTicks, "anchorTicks");
        if (Math.abs(closeTicks - anchorTicks) >= this.reversalTicks) {
          this._startLeg(
            data,
            state,
            row,
            closeTicks > anchorTicks ? "up" : "down",
            anchorTicks,
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

  _priceToTicks(price: number): number {
    const ticks = Math.round(price / this.minTick);
    if (!Number.isSafeInteger(ticks)) {
      throw new RangeError("Kagi source price exceeds safe integer tick range");
    }
    return ticks;
  }

  _ticksToPrice(ticks: number): number {
    const price = Number((ticks * this.minTick).toFixed(this.pricePrecision));
    return Object.is(price, -0) ? 0 : price;
  }

  _processUpLeg(data: KagiDisplayRow[], state: KagiState, row: SourceBar, closeTicks: number, provisional: boolean): void {
    const legEndTicks = requiredInteger(state.legEndTicks, "legEndTicks");
    if (closeTicks > legEndTicks) {
      this._extendActiveLeg(data, state, row, closeTicks, provisional);
    } else if (legEndTicks - closeTicks >= this.reversalTicks) {
      const turnTicks = legEndTicks;
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

  _processDownLeg(data: KagiDisplayRow[], state: KagiState, row: SourceBar, closeTicks: number, provisional: boolean): void {
    const legEndTicks = requiredInteger(state.legEndTicks, "legEndTicks");
    if (closeTicks < legEndTicks) {
      this._extendActiveLeg(data, state, row, closeTicks, provisional);
    } else if (closeTicks - legEndTicks >= this.reversalTicks) {
      const turnTicks = legEndTicks;
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

  _extendActiveLeg(data: KagiDisplayRow[], state: KagiState, row: SourceBar, closeTicks: number, provisional: boolean): void {
    state.legEndTicks = closeTicks;
    state.legSourceToTime = row.time;
    state.legCustomValues = cloneCustomValues(row.customValues);
    state.currentStyle = this._sectionsForState(state).tailStyle;
    this._upsertActiveLeg(data, state, row, provisional);
  }

  _startLeg(
    data: KagiDisplayRow[],
    state: KagiState,
    row: SourceBar,
    direction: Exclude<KagiDirection, null>,
    startTicks: number,
    endTicks: number,
    reversalKind: KagiReversalKind,
    turnTicks: number | null,
    provisional: boolean,
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

  _sectionsForState(state: KagiState): KagiSectionsResult {
    const startTicks = requiredInteger(state.legStartTicks, "legStartTicks");
    const endTicks = requiredInteger(state.legEndTicks, "legEndTicks");
    const startStyle = requiredStyle(state.legStartStyle);
    let boundaryTicks: number | null = null;
    let nextStyle: KagiStyle = startStyle;

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

    const sections: KagiSection[] = [];
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

  _upsertActiveLeg(
    data: KagiDisplayRow[],
    state: KagiState,
    row: SourceBar,
    provisional: boolean,
  ): void {
    const open = this._ticksToPrice(requiredInteger(state.legStartTicks, "legStartTicks"));
    const close = this._ticksToPrice(requiredInteger(state.legEndTicks, "legEndTicks"));
    const direction = requiredDirection(state.direction);
    const legOrder = requiredInteger(state.legOrder, "legOrder");
    const { sections, tailStyle } = this._sectionsForState(state);
    const point: KagiDisplayRow = {
      time: {
        order: legOrder,
        sourceTime: row.time,
        sourceOrdinal: 0,
      },
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      customValues: projectionCustomValues(row, {
        direction,
        provisional,
        reversalAmount: this.reversalAmount,
        reversalKind: state.legReversalKind,
        reversalTicks: this.reversalTicks,
        sections,
        sourceFromTime: requiredSourceTime(state.legSourceFromTime, "legSourceFromTime"),
        state: tailStyle,
        turnPrice: state.legTurnTicks == null
          ? null
          : this._ticksToPrice(state.legTurnTicks),
      }),
    };
    const existingIndex = data.length - 1;
    if (existingIndex >= 0 && displayOrder(data[existingIndex]) === legOrder) {
      data[existingIndex] = point;
    } else {
      data.push(point);
    }
  }
}
