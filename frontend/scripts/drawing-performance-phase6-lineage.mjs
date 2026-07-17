export const PHASE6_LINEAGE_DATASET_KEY = "binance-spot-BTCUSDT-1h";

export const PHASE6_LINEAGE_REPRESENTATION = Object.freeze({
  chartType: "renko",
  axisMode: "derived-ordinal",
  projectorId: "renko",
  mode: "traditional",
  atrLength: 14,
  boxSize: 10,
  minTick: 0.01,
  configKey: "renko:traditional:14:10:0.01",
  projectionConfig: "binance-spot-BTCUSDT-1h:renko:traditional:14:10:0.01",
});

function positiveFinite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive finite number`);
  }
  return number;
}

/**
 * Project only the canonical lineage identity emitted by traditional Renko.
 * A tsx regression test compares this compact script implementation against
 * the production RenkoProjector so fixture ordinals cannot silently drift.
 */
export function projectTraditionalRenkoLineage(rows, {
  boxSize = PHASE6_LINEAGE_REPRESENTATION.boxSize,
  minTick = PHASE6_LINEAGE_REPRESENTATION.minTick,
} = {}) {
  const box = positiveFinite(boxSize, "Renko boxSize");
  const tick = positiveFinite(minTick, "Renko minTick");
  const boxTicks = Math.round(box / tick);
  if (!Number.isSafeInteger(boxTicks) || boxTicks <= 0) {
    throw new TypeError("Renko boxSize must resolve to positive safe tick units");
  }
  let initialized = false;
  let lastCloseTicks = 0;
  let direction = null;
  let order = 0;
  const anchors = [];

  for (const row of rows || []) {
    const time = Number(row?.time);
    const close = Number(row?.close);
    if (!Number.isFinite(time) || !Number.isFinite(close)) continue;
    const closeTicks = Math.round(close / tick);
    if (!Number.isSafeInteger(closeTicks)) {
      throw new RangeError("Renko source close exceeds safe tick range");
    }
    if (!initialized) {
      lastCloseTicks = Math.floor(closeTicks / boxTicks) * boxTicks;
      initialized = true;
    }
    let sourceOrdinal = 0;
    const emit = (nextDirection, nextCloseTicks) => {
      anchors.push(Object.freeze({ order, sourceTime: time, sourceOrdinal }));
      order += 1;
      sourceOrdinal += 1;
      direction = nextDirection;
      lastCloseTicks = nextCloseTicks;
    };
    const emitContinuation = (nextDirection) => {
      const step = nextDirection === "up" ? boxTicks : -boxTicks;
      const canEmit = () => nextDirection === "up"
        ? closeTicks >= lastCloseTicks + boxTicks
        : closeTicks <= lastCloseTicks - boxTicks;
      while (canEmit()) emit(nextDirection, lastCloseTicks + step);
    };
    const emitReversal = (nextDirection) => {
      const step = nextDirection === "up" ? boxTicks : -boxTicks;
      emit(nextDirection, lastCloseTicks + 2 * step);
    };

    if (direction === null) {
      if (closeTicks >= lastCloseTicks + boxTicks) emitContinuation("up");
      else if (closeTicks <= lastCloseTicks - boxTicks) emitContinuation("down");
    } else if (direction === "up") {
      if (closeTicks >= lastCloseTicks + boxTicks) emitContinuation("up");
      else if (closeTicks <= lastCloseTicks - 2 * boxTicks) {
        emitReversal("down");
        emitContinuation("down");
      }
    } else if (closeTicks <= lastCloseTicks - boxTicks) {
      emitContinuation("down");
    } else if (closeTicks >= lastCloseTicks + 2 * boxTicks) {
      emitReversal("up");
      emitContinuation("up");
    }
  }
  return Object.freeze(anchors);
}

export function buildPhase6LineageFixtureContract(rows, {
  datasetKey = PHASE6_LINEAGE_DATASET_KEY,
} = {}) {
  if (datasetKey !== PHASE6_LINEAGE_DATASET_KEY) {
    throw new RangeError("Phase 6 lineage fixture requires the managed BTCUSDT 1h dataset");
  }
  const anchors = projectTraditionalRenkoLineage(rows);
  const ordinalAnchors = anchors.filter((anchor) => anchor.sourceOrdinal > 0);
  if (ordinalAnchors.length < 2) {
    throw new RangeError("Phase 6 Renko source rows did not emit two multi-brick ordinals");
  }
  const left = ordinalAnchors[Math.floor(ordinalAnchors.length * 0.2)];
  const right = ordinalAnchors.findLast(
    (candidate) => candidate.sourceTime > left.sourceTime,
  );
  if (!left || !right || left.order >= right.order) {
    throw new RangeError("Phase 6 Renko lineage endpoints are not strictly ordered");
  }
  return Object.freeze({
    sourceProjection: PHASE6_LINEAGE_REPRESENTATION.projectorId,
    sourceProjectionConfig: `${datasetKey}:${PHASE6_LINEAGE_REPRESENTATION.configKey}`,
    exact: Object.freeze({
      left: Object.freeze({ time: left.sourceTime, sourceOrdinal: left.sourceOrdinal }),
      right: Object.freeze({ time: right.sourceTime, sourceOrdinal: right.sourceOrdinal }),
    }),
    fallback: Object.freeze({
      fromTime: left.sourceTime,
      toTime: right.sourceTime,
      leftRatio: 0,
      rightRatio: 1,
    }),
    derivedRowCount: anchors.length,
  });
}

export function phase6LineageSettings() {
  return Object.freeze({
    chartType: PHASE6_LINEAGE_REPRESENTATION.chartType,
    renkoBoxSizeMode: PHASE6_LINEAGE_REPRESENTATION.mode,
    renkoAtrLength: PHASE6_LINEAGE_REPRESENTATION.atrLength,
    renkoBoxSize: PHASE6_LINEAGE_REPRESENTATION.boxSize,
  });
}
