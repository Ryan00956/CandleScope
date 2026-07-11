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
    this._display = this.projector.project(this._source);
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
    if (trimmedRight === 0 && this._canApplyTailDelta(detail, currentRows, trimmedLeft)) {
      return this._applyTailDelta(detail, currentRows, trimmedLeft);
    }
    return this._reprojectStructural(currentRows, { trimmedLeft });
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

  _reprojectStructural(currentRows, { trimmedLeft = 0 } = {}) {
    const previousLength = this._display.length;
    const nextSource = Array.from(currentRows || []);
    if (this.projector.oneToOne !== true) {
      this._source = nextSource;
      this._display = this.projector.project(nextSource);
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
