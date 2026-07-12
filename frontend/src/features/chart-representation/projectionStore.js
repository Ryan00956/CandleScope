import { IdentityProjector } from "./projectors/identityProjector.js";

function sameSourceRow(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function sameProjectedValue(left, right, memo = null) {
  if (Object.is(left, right)) return true;
  if (left == null || right == null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftIsArray = Array.isArray(left);
  const rightIsArray = Array.isArray(right);
  if (leftIsArray !== rightIsArray) return false;
  const leftPrototype = Object.getPrototypeOf(left);
  const rightPrototype = Object.getPrototypeOf(right);
  if (leftPrototype !== rightPrototype
    || (!leftIsArray && leftPrototype !== Object.prototype && leftPrototype !== null)) {
    return false;
  }
  const pairs = memo || {
    leftToRight: new WeakMap(),
    rightToLeft: new WeakMap(),
  };
  const hasLeft = pairs.leftToRight.has(left);
  const hasRight = pairs.rightToLeft.has(right);
  if (hasLeft || hasRight) {
    return hasLeft
      && hasRight
      && pairs.leftToRight.get(left) === right
      && pairs.rightToLeft.get(right) === left;
  }
  pairs.leftToRight.set(left, right);
  pairs.rightToLeft.set(right, left);
  if (leftIsArray) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameProjectedValue(left[index], right[index], pairs)) return false;
    }
    return true;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)
      || !sameProjectedValue(left[key], right[key], pairs)) {
      return false;
    }
  }
  return true;
}

function outputOrder(row) {
  const order = row?.time?.order;
  return Number.isSafeInteger(order) ? order : null;
}

function lowerBoundOutputOrder(rows, targetOrder) {
  if (!Number.isSafeInteger(targetOrder)) return null;
  let left = 0;
  let right = rows.length;
  while (left < right) {
    const middle = left + Math.floor((right - left) / 2);
    const order = outputOrder(rows[middle]);
    if (order == null) return null;
    if (order < targetOrder) left = middle + 1;
    else right = middle;
  }
  return left;
}

function hasStrictlyIncreasingOutputOrders(rows) {
  let previousOrder = null;
  for (const row of rows) {
    const order = outputOrder(row);
    if (order == null || (previousOrder != null && order <= previousOrder)) return false;
    previousOrder = order;
  }
  return true;
}

function trimSharedProjectedPrefix(previousRows, startIndex, projectedRows) {
  let shared = 0;
  while (startIndex + shared < previousRows.length
    && shared < projectedRows.length
    && sameProjectedValue(previousRows[startIndex + shared], projectedRows[shared])) {
    shared += 1;
  }
  return {
    fromOutputIndex: startIndex + shared,
    insert: projectedRows.slice(shared),
  };
}

function displayAxisKey(time) {
  if (time && typeof time === "object" && Number.isSafeInteger(time.order)) {
    return `order:${time.order}`;
  }
  const numeric = Number(time);
  return Number.isFinite(numeric) ? `time:${numeric}` : null;
}

function patchResult(fromOutputIndex, previousLength, insert, nextData) {
  return {
    kind: "replace-tail",
    fromOutputIndex,
    deleteCount: Math.max(0, previousLength - fromOutputIndex),
    insert,
    nextData,
    previousLength,
    nextLength: nextData.length,
  };
}

function firstDifference(previousRows, nextRows) {
  const shared = Math.min(previousRows.length, nextRows.length);
  for (let index = 0; index < shared; index += 1) {
    if (!sameSourceRow(previousRows[index], nextRows[index])) return index;
  }
  return previousRows.length === nextRows.length ? -1 : shared;
}

export class ProjectionStore {
  constructor({ projector = new IdentityProjector() } = {}) {
    if (!projector || typeof projector.project !== "function") {
      throw new TypeError("ProjectionStore requires a projector with project(rows, options)");
    }
    this.projector = projector;
    this._source = [];
    this._display = [];
    this._displayTimeIndex = new Map();
    this._displayTimeSet = new Set();
    this._projectionSeedState = null;
    this._projectionFinalState = null;
    this._sourceCheckpoints = [];
  }

  sourceSnapshot() {
    return this._source;
  }

  displaySnapshot() {
    return this._display;
  }

  getDisplayByTime(time) {
    const index = this.indexOfDisplayTime(time);
    return index >= 0 ? this._display[index] : null;
  }

  indexOfDisplayTime(time) {
    const key = displayAxisKey(time);
    if (key == null) return -1;
    const index = this._displayTimeIndex.get(key);
    return Number.isInteger(index) ? index : -1;
  }

  displayTimeSet() {
    return this._displayTimeSet;
  }

  reset(rows = []) {
    const previousLength = this._display.length;
    this._source = Array.from(rows || []);
    this._projectionSeedState = null;
    this._display = this._projectRows(this._source, { seedState: null });
    this._rebuildDisplayTimeIndex();
    return patchResult(0, previousLength, this._display.slice(), this._display);
  }

  applySourceDelta(delta, currentRows = []) {
    const detail = delta || {};
    if (detail.type === "noop") {
      return patchResult(this._display.length, this._display.length, [], this._display);
    }
    if (detail.type === "clear") return this.reset([]);

    const trimmedLeft = Math.max(0, Number(detail.trimmedLeft) || 0);
    const trimmedRight = Math.max(0, Number(detail.trimmedRight) || 0);
    if (trimmedRight === 0
      && this._canApplyStatefulTailDelta(detail, currentRows, trimmedLeft)) {
      const patch = this._applyStatefulTailDelta(detail, currentRows);
      if (patch) return patch;
    }
    if (trimmedRight === 0 && this._canApplyTailDelta(detail, currentRows, trimmedLeft)) {
      return this._applyTailDelta(detail, currentRows, trimmedLeft);
    }
    return this._reprojectStructural(currentRows, {
      deltaType: detail.type,
      trimmedLeft,
    });
  }

  _canApplyStatefulTailDelta(delta, currentRows, trimmedLeft) {
    // Opt-in projector contract: every source row has a checkpoint, state
    // exposes the next synthetic order, and emitted rows use strictly
    // increasing time.order values. Prefix comparison includes metadata so a
    // reused custom-series point is semantically identical, not merely the
    // same ordinal.
    if (this.projector.oneToOne === true
      || this.projector.supportsStatefulTailProjection !== true
      || typeof this.projector.projectWithState !== "function"
      || trimmedLeft !== 0
      || this._sourceCheckpoints.length !== this._source.length
      || this._projectionFinalState == null) {
      return false;
    }
    const previousLength = this._source.length;
    const nextLength = currentRows?.length || 0;
    const appendSeamMatches = previousLength === 0 || sameSourceRow(
      currentRows[previousLength - 1],
      this._source[previousLength - 1],
    );
    if (delta.type === "tick") {
      if (delta.appended) return nextLength === previousLength + 1 && appendSeamMatches;
      if (delta.replaced) {
        return nextLength === previousLength
          && previousLength > 0
          && currentRows[nextLength - 1]?.time === this._source[previousLength - 1]?.time
          && (previousLength === 1 || sameSourceRow(
            currentRows[previousLength - 2],
            this._source[previousLength - 2],
          ))
          && this._sourceCheckpoints[previousLength - 1] != null;
      }
      return false;
    }
    if (delta.type === "append") {
      const addedRight = Math.max(0, Number(delta.addedRight) || 0);
      return addedRight > 0
        && nextLength === previousLength + addedRight
        && appendSeamMatches;
    }
    return false;
  }

  _applyStatefulTailDelta(delta, currentRows) {
    const previousLength = this._display.length;
    const replacingLast = delta.type === "tick" && delta.replaced;
    const sourceStart = replacingLast ? this._source.length - 1 : this._source.length;
    const seedState = replacingLast
      ? this._sourceCheckpoints[sourceStart]
      : this._projectionFinalState;
    const affectedRows = Array.from(currentRows || []).slice(sourceStart);
    const projection = this.projector.projectWithState(affectedRows, { seedState });
    if (!projection
      || !Array.isArray(projection.data)
      || !Array.isArray(projection.checkpoints)
      || projection.checkpoints.length !== affectedRows.length
      || projection.state == null
      || !hasStrictlyIncreasingOutputOrders(projection.data)) {
      return null;
    }

    const candidateOrder = outputOrder(projection.data[0]) ?? seedState?.nextOrder;
    const initialOutputIndex = lowerBoundOutputOrder(this._display, candidateOrder);
    if (initialOutputIndex == null) return null;
    const tail = trimSharedProjectedPrefix(
      this._display,
      initialOutputIndex,
      projection.data,
    );
    const nextDisplay = [
      ...this._display.slice(0, tail.fromOutputIndex),
      ...tail.insert,
    ];

    this._source = Array.from(currentRows || []);
    this._sourceCheckpoints = replacingLast
      ? this._sourceCheckpoints.slice(0, sourceStart).concat(projection.checkpoints)
      : this._sourceCheckpoints.concat(projection.checkpoints);
    this._projectionFinalState = projection.state;
    this._display = nextDisplay;
    this._rebuildDisplayTimeIndex();
    return patchResult(
      tail.fromOutputIndex,
      previousLength,
      tail.insert,
      this._display,
    );
  }

  _canApplyTailDelta(delta, currentRows, trimmedLeft) {
    if (this.projector.oneToOne !== true) return false;
    const previousLength = this._source.length;
    const nextLength = currentRows?.length || 0;
    const retainedLength = Math.max(0, previousLength - trimmedLeft);
    if (delta.type === "tick") {
      if (delta.appended) return nextLength === retainedLength + 1;
      if (delta.replaced && trimmedLeft === 0) {
        return nextLength === previousLength
          && previousLength > 0
          && currentRows[nextLength - 1]?.time === this._source[previousLength - 1]?.time;
      }
      return false;
    }
    if (delta.type === "append") {
      const addedRight = Math.max(0, Number(delta.addedRight) || 0);
      return addedRight > 0 && nextLength === retainedLength + addedRight;
    }
    if (delta.type === "trim-left") return nextLength === retainedLength;
    return false;
  }

  _applyTailDelta(delta, currentRows, trimmedLeft) {
    const previousLength = this._display.length;
    const retainedSource = trimmedLeft > 0 ? this._source.slice(trimmedLeft) : this._source.slice();
    const retainedDisplay = trimmedLeft > 0 ? this._display.slice(trimmedLeft) : this._display.slice();
    const appendedCount = delta.type === "append"
      ? Math.max(0, Number(delta.addedRight) || 0)
      : (delta.type === "tick" && delta.appended ? 1 : 0);

    if (delta.type === "tick" && delta.replaced) {
      const sourceIndex = currentRows.length - 1;
      const previousDisplayRow = this._resolvePreviousDisplayRow(retainedDisplay.slice(0, -1));
      const insert = this.projector.project([currentRows[sourceIndex]], { previousDisplayRow });
      retainedSource[retainedSource.length - 1] = currentRows[sourceIndex];
      retainedDisplay.splice(Math.max(0, retainedDisplay.length - 1), 1, ...insert);
      this._source = retainedSource;
      this._display = retainedDisplay;
      this._rebuildDisplayTimeIndex();
      return patchResult(previousLength - 1, previousLength, insert, this._display);
    }

    const appendedRows = appendedCount > 0
      ? Array.from(currentRows).slice(currentRows.length - appendedCount)
      : [];
    const previousDisplayRow = this._resolvePreviousDisplayRow(retainedDisplay);
    const projectedTail = this.projector.project(appendedRows, { previousDisplayRow });
    this._source = retainedSource.concat(appendedRows);
    this._display = retainedDisplay.concat(projectedTail);
    this._rebuildDisplayTimeIndex();

    if (trimmedLeft > 0) {
      return patchResult(0, previousLength, this._display.slice(), this._display);
    }
    return patchResult(previousLength, previousLength, projectedTail, this._display);
  }

  _reprojectStructural(currentRows, { deltaType = "", trimmedLeft = 0 } = {}) {
    const previousLength = this._display.length;
    const nextSource = Array.from(currentRows || []);
    if (this.projector.oneToOne !== true) {
      const seedState = this._seedStateForStructuralProjection({
        deltaType,
        trimmedLeft,
      });
      this._source = nextSource;
      this._projectionSeedState = seedState;
      this._display = this._projectRows(nextSource, { seedState });
      this._rebuildDisplayTimeIndex();
      return patchResult(0, previousLength, this._display.slice(), this._display);
    }
    let fromOutputIndex = firstDifference(this._source, nextSource);
    if (fromOutputIndex < 0) {
      this._source = nextSource;
      return patchResult(previousLength, previousLength, [], this._display);
    }

    let previousDisplayRow = this._resolvePreviousDisplayRow(
      this._display.slice(0, fromOutputIndex),
    );
    if (trimmedLeft > 0 && fromOutputIndex === 0) {
      const retainedStart = this._source.findIndex((row) => row?.time === nextSource[0]?.time);
      if (retainedStart > 0) {
        previousDisplayRow = this._resolvePreviousDisplayRow(
          this._display.slice(0, retainedStart),
        );
      }
    }
    const projectedTail = this.projector.project(nextSource.slice(fromOutputIndex), { previousDisplayRow });
    this._source = nextSource;
    this._display = this._display.slice(0, fromOutputIndex).concat(projectedTail);
    this._rebuildDisplayTimeIndex();
    return patchResult(fromOutputIndex, previousLength, projectedTail, this._display);
  }

  _seedStateForStructuralProjection({ deltaType, trimmedLeft }) {
    if (typeof this.projector.projectWithState !== "function") return null;
    if (deltaType === "prepend") return null;
    if (trimmedLeft <= 0) return this._projectionSeedState;
    if (trimmedLeft < this._sourceCheckpoints.length) {
      return this._sourceCheckpoints[trimmedLeft];
    }
    if (trimmedLeft === this._source.length) return this._projectionFinalState;
    return null;
  }

  _projectRows(rows, { seedState = null } = {}) {
    if (typeof this.projector.projectWithState !== "function") {
      this._sourceCheckpoints = [];
      this._projectionFinalState = null;
      return this.projector.project(rows);
    }
    const projection = this.projector.projectWithState(rows, { seedState });
    if (!projection || !Array.isArray(projection.data)) {
      throw new TypeError("stateful projector must return { data, state, checkpoints }");
    }
    this._sourceCheckpoints = Array.isArray(projection.checkpoints)
      ? projection.checkpoints
      : [];
    this._projectionFinalState = projection.state ?? null;
    return projection.data;
  }

  _resolvePreviousDisplayRow(rows) {
    if (typeof this.projector.resolvePreviousDisplayRow === "function") {
      return this.projector.resolvePreviousDisplayRow(rows);
    }
    return rows[rows.length - 1] || null;
  }

  _rebuildDisplayTimeIndex() {
    this._displayTimeIndex.clear();
    const displayTimes = [];
    for (let index = 0; index < this._display.length; index += 1) {
      const time = this._display[index]?.time;
      const key = displayAxisKey(time);
      if (key != null) {
        this._displayTimeIndex.set(key, index);
        displayTimes.push(time);
      }
    }
    this._displayTimeSet = new Set(displayTimes);
  }
}
