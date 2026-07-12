import { IdentityProjector } from "./projectors/identityProjector.js";
import { findDisplayIndexForAxisAnchor } from "./axisTime.js";
import { createDrawingLineageIndex } from "./drawingLineageIndex.js";

const PROVISIONAL_SOURCE_STATES = new Set([
  "false",
  "0",
  "no",
  "n",
  "open",
  "forming",
]);

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

function isExplicitlyProvisionalSourceRow(row) {
  const value = row?.is_closed ?? row?.isClosed;
  if (value === false || value === 0) return true;
  if (typeof value !== "string") return false;
  return PROVISIONAL_SOURCE_STATES.has(value.trim().toLowerCase());
}

function validStatefulProjection(projection, sourceLength) {
  return projection
    && Array.isArray(projection.data)
    && Array.isArray(projection.checkpoints)
    && projection.checkpoints.length === sourceLength
    && projection.state != null;
}

function overlayProjectedRows(confirmedRows, provisionalRows) {
  if (provisionalRows.length === 0) return confirmedRows;
  const provisionalOrder = outputOrder(provisionalRows[0]);
  const overlayIndex = lowerBoundOutputOrder(confirmedRows, provisionalOrder);
  if (overlayIndex == null) return null;
  // Projectors return an owned data array. Reuse it here so a forming tail on
  // reset does not create another full-size synthetic display copy.
  confirmedRows.length = overlayIndex;
  for (const row of provisionalRows) confirmedRows.push(row);
  const combined = confirmedRows;
  return hasStrictlyIncreasingOutputOrders(combined) ? combined : null;
}

function hasStrictOutputOrderSeam(previousRows, fromOutputIndex, insert) {
  if (insert.length === 0 || fromOutputIndex === 0) return true;
  try {
    const previousOrder = outputOrder(previousRows[fromOutputIndex - 1]);
    const nextOrder = outputOrder(insert[0]);
    return previousOrder != null && nextOrder != null && previousOrder < nextOrder;
  } catch {
    return false;
  }
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

function sourceTail(rows, startIndex) {
  if (Array.isArray(rows)) return rows.slice(startIndex);
  return Array.from(rows || []).slice(startIndex);
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
    this._drawingLineageIndex = createDrawingLineageIndex();
    this._displayTimeIndex = new Map();
    this._displayTimeSet = new Set();
    this._hasStrictlyIncreasingDisplayOrders = true;
    this._projectionSeedState = null;
    this._projectionFinalState = null;
    this._sourceCheckpoints = [];
    this._confirmedSourceLength = 0;
  }

  sourceSnapshot() {
    // The source cache is updated in place on realtime tail deltas. Return an
    // owned array so callers cannot mutate its structure and previously read
    // snapshots do not change underneath them. Row objects remain shared.
    return this._source.slice();
  }

  displaySnapshot() {
    return this._display;
  }

  drawingLineageIndex() {
    return this._drawingLineageIndex.seriesData === this._display
      && this._drawingLineageIndex.isOrdinal
      ? this._drawingLineageIndex
      : null;
  }

  drawingCoordinateSnapshot() {
    const ordinalSeriesIndex = this.drawingLineageIndex();
    return {
      indexRevision: ordinalSeriesIndex?.revision ?? null,
      ordinalSeriesIndex,
      seriesData: this._display,
    };
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

  resolveDisplayAnchorIndex(axisTime) {
    return findDisplayIndexForAxisAnchor(this._display, axisTime);
  }

  displayTimeSet() {
    if (this._displayTimeSet == null) {
      const displayTimes = [];
      for (const row of this._display) {
        if (displayAxisKey(row?.time) != null) displayTimes.push(row.time);
      }
      this._displayTimeSet = new Set(displayTimes);
    }
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
      confirmTrimmedTail: detail.appended === true
        || Math.max(0, Number(detail.addedRight) || 0) > 0,
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
      || this._hasStrictlyIncreasingDisplayOrders !== true
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
    const defaultSourceStart = replacingLast
      ? this._source.length - 1
      : this._source.length;
    // A new timestamp implicitly confirms an older forming tail even when its
    // explicit close event was missed. Reproject from that tail's checkpoint
    // so the old row is committed before the new provisional overlay is tried.
    const sourceStart = Math.min(this._confirmedSourceLength, defaultSourceStart);
    const seedState = sourceStart < this._sourceCheckpoints.length
      ? this._sourceCheckpoints[sourceStart]
      : this._projectionFinalState;
    const affectedRows = sourceTail(currentRows, sourceStart);
    const projection = this._projectStatefulRows(affectedRows, { seedState });
    if (!projection || !hasStrictlyIncreasingOutputOrders(projection.data)) return null;

    const candidateOrder = outputOrder(projection.data[0]) ?? seedState?.nextOrder;
    const initialOutputIndex = lowerBoundOutputOrder(this._display, candidateOrder);
    if (initialOutputIndex == null) return null;
    const tail = trimSharedProjectedPrefix(
      this._display,
      initialOutputIndex,
      projection.data,
    );
    const displayChanged = tail.fromOutputIndex !== previousLength
      || tail.insert.length > 0;
    const previousDisplay = this._display;
    if (displayChanged && !hasStrictOutputOrderSeam(
      previousDisplay,
      tail.fromOutputIndex,
      tail.insert,
    )) {
      return null;
    }
    const displayTimeIndexPlan = displayChanged
      ? this._planDisplayTimeIndexTail(
        previousDisplay,
        tail.fromOutputIndex,
        tail.insert,
      )
      : null;
    if (displayChanged && displayTimeIndexPlan == null) return null;
    const nextDisplay = displayChanged
      ? previousDisplay.slice(0, tail.fromOutputIndex).concat(tail.insert)
      : previousDisplay;

    this._commitStatefulSourceTail({
      affectedRows,
      checkpoints: projection.checkpoints,
      sourceStart,
    });
    this._projectionFinalState = projection.state;
    this._confirmedSourceLength = sourceStart + projection.confirmedSourceLength;
    this._display = nextDisplay;
    if (displayChanged) {
      this._replaceDisplayTimeIndexTail(displayTimeIndexPlan);
      this._replaceDrawingLineageIndexTail({
        fromOutputIndex: tail.fromOutputIndex,
        insert: tail.insert,
        nextDisplay,
        previousDisplay,
      });
    }
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

  _reprojectStructural(currentRows, {
    confirmTrimmedTail = false,
    deltaType = "",
    trimmedLeft = 0,
  } = {}) {
    const previousLength = this._display.length;
    const nextSource = Array.from(currentRows || []);
    if (this.projector.oneToOne !== true) {
      const seedState = this._seedStateForStructuralProjection({
        confirmTrimmedTail,
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

  _seedStateForStructuralProjection({
    confirmTrimmedTail,
    deltaType,
    trimmedLeft,
  }) {
    if (typeof this.projector.projectWithState !== "function") return null;
    if (deltaType === "prepend") return null;
    if (trimmedLeft <= 0) return this._projectionSeedState;
    if (trimmedLeft < this._sourceCheckpoints.length) {
      return this._sourceCheckpoints[trimmedLeft];
    }
    if (trimmedLeft === this._source.length) {
      if (confirmTrimmedTail && this._confirmedSourceLength < this._source.length) {
        const trimmedProvisionalRows = this._source.slice(this._confirmedSourceLength);
        const confirmedProjection = this.projector.projectWithState(
          trimmedProvisionalRows,
          {
            provisional: false,
            seedState: this._projectionFinalState,
          },
        );
        if (!validStatefulProjection(
          confirmedProjection,
          trimmedProvisionalRows.length,
        )) {
          throw new TypeError("stateful projector could not confirm the trimmed tail");
        }
        return confirmedProjection.state;
      }
      return this._projectionFinalState;
    }
    return null;
  }

  _projectRows(rows, { seedState = null } = {}) {
    if (typeof this.projector.projectWithState !== "function") {
      this._sourceCheckpoints = [];
      this._projectionFinalState = null;
      this._confirmedSourceLength = rows.length;
      return this.projector.project(rows);
    }
    const projection = this._projectStatefulRows(rows, { seedState });
    if (!projection) {
      throw new TypeError("stateful projector must return { data, state, checkpoints }");
    }
    this._sourceCheckpoints = projection.checkpoints;
    this._projectionFinalState = projection.state;
    this._confirmedSourceLength = projection.confirmedSourceLength;
    return projection.data;
  }

  _projectStatefulRows(rows, { seedState = null } = {}) {
    // Stateful projectors opt into returning call-owned mutable `data` and
    // `checkpoints` containers. Their state/checkpoint values may stay frozen;
    // only the two fresh containers are extended for the provisional overlay.
    const sourceRows = Array.isArray(rows) ? rows : Array.from(rows || []);
    const hasProvisionalTail = sourceRows.length > 0
      && isExplicitlyProvisionalSourceRow(sourceRows[sourceRows.length - 1]);
    const confirmedSourceLength = sourceRows.length - Number(hasProvisionalTail);
    const confirmedRows = hasProvisionalTail
      ? sourceRows.slice(0, confirmedSourceLength)
      : sourceRows;
    const confirmedProjection = this.projector.projectWithState(confirmedRows, {
      provisional: false,
      seedState,
    });
    if (!validStatefulProjection(confirmedProjection, confirmedRows.length)) return null;
    if (!hasProvisionalTail) {
      return {
        ...confirmedProjection,
        confirmedSourceLength,
      };
    }

    const provisionalProjection = this.projector.projectWithState(
      [sourceRows[sourceRows.length - 1]],
      {
        provisional: true,
        seedState: confirmedProjection.state,
      },
    );
    if (!validStatefulProjection(provisionalProjection, 1)) return null;
    const data = overlayProjectedRows(
      confirmedProjection.data,
      provisionalProjection.data,
    );
    if (data == null) return null;
    for (const checkpoint of provisionalProjection.checkpoints) {
      confirmedProjection.checkpoints.push(checkpoint);
    }
    return {
      checkpoints: confirmedProjection.checkpoints,
      confirmedSourceLength,
      data,
      // The provisional trial state is deliberately discarded. Every forming
      // update starts again from this confirmed state and can fully retract.
      state: confirmedProjection.state,
    };
  }

  _resolvePreviousDisplayRow(rows) {
    if (typeof this.projector.resolvePreviousDisplayRow === "function") {
      return this.projector.resolvePreviousDisplayRow(rows);
    }
    return rows[rows.length - 1] || null;
  }

  _commitStatefulSourceTail({
    affectedRows,
    checkpoints,
    sourceStart,
  }) {
    this._source.length = sourceStart;
    this._sourceCheckpoints.length = sourceStart;
    for (const row of affectedRows) this._source.push(row);
    for (const checkpoint of checkpoints) this._sourceCheckpoints.push(checkpoint);
  }

  _planDisplayTimeIndexTail(previousDisplay, fromOutputIndex, insert) {
    try {
      const remove = [];
      const add = [];
      for (let index = fromOutputIndex; index < previousDisplay.length; index += 1) {
        remove.push({
          index,
          key: displayAxisKey(previousDisplay[index]?.time),
        });
      }
      for (let offset = 0; offset < insert.length; offset += 1) {
        add.push({
          index: fromOutputIndex + offset,
          key: displayAxisKey(insert[offset]?.time),
        });
      }
      return { add, remove };
    } catch {
      return null;
    }
  }

  _replaceDisplayTimeIndexTail({ add, remove }) {
    for (const { index, key } of remove) {
      if (key != null && this._displayTimeIndex.get(key) === index) {
        this._displayTimeIndex.delete(key);
      }
    }
    for (const { index, key } of add) {
      if (key != null) this._displayTimeIndex.set(key, index);
    }
    // displayTimeSet() is public and previously returned a versioned Set.
    // Invalidate instead of mutating it so already returned sets stay stable;
    // rebuilding is deferred until a caller actually asks for the set.
    this._displayTimeSet = null;
  }

  _replaceDrawingLineageIndexTail({
    previousDisplay,
    fromOutputIndex,
    insert,
    nextDisplay,
  }) {
    try {
      const patched = this._drawingLineageIndex.replaceTail({
        previousSeriesData: previousDisplay,
        fromOutputIndex,
        insert,
        nextSeriesData: nextDisplay,
      });
      if (patched) return;
    } catch {
      // Fall through to the correctness-first rebuild below. Projection rows
      // are adapter input, so a malformed metadata getter must not leave a
      // partially patched drawing lookup behind.
    }
    try {
      this._drawingLineageIndex.reset(nextDisplay);
    } catch {
      // Keep the projection commit usable even if third-party projected
      // metadata is hostile. The empty identity deliberately makes the public
      // snapshot reject this lookup and use the bridge's safe fallback.
      this._drawingLineageIndex.reset([]);
    }
  }

  _rebuildDisplayTimeIndex() {
    this._displayTimeIndex.clear();
    const displayTimes = [];
    let previousOrder = null;
    let strictlyIncreasingOrders = true;
    for (let index = 0; index < this._display.length; index += 1) {
      const time = this._display[index]?.time;
      const key = displayAxisKey(time);
      const order = outputOrder(this._display[index]);
      if (order == null || (previousOrder != null && order <= previousOrder)) {
        strictlyIncreasingOrders = false;
      }
      previousOrder = order;
      if (key != null) {
        this._displayTimeIndex.set(key, index);
        displayTimes.push(time);
      }
    }
    this._displayTimeSet = new Set(displayTimes);
    this._hasStrictlyIncreasingDisplayOrders = strictlyIncreasingOrders;
    this._drawingLineageIndex.reset(this._display);
  }
}
