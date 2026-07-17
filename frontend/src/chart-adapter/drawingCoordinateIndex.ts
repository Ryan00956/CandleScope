import { isOrdinalAxisTime } from "../features/chart-representation/axisTime.js";
import {
  isDrawingLineageIndexForSeries,
  type DrawingLineageIndex,
} from "../features/chart-representation/drawingLineageIndex.js";
import type { DisplayRow } from "../features/chart-representation/chartRepresentationTypes.js";

export type DrawingCoordinateIndexMode = "empty" | "invalid" | "numeric" | "ordinal";

export type DrawingCoordinateIndexIssue =
  | "duplicate-time"
  | "invalid-numeric-row"
  | "mixed-axis-time"
  | "ordinal-lineage-mismatch"
  | "ordinal-lineage-missing"
  | "unordered-time";

export type NumericTimePosition = "after" | "before" | "between" | "exact";

/**
 * Pure data-space resolution for one source timestamp.
 *
 * `ratio` is intentionally allowed outside [0, 1] for absolute future/past
 * timestamps. Viewport code can then project the two logical endpoints without
 * repeating the source-data search.
 */
export interface NumericTimeSearchResult {
  exactIndex: number | null;
  leftIndex: number;
  leftTime: number;
  position: NumericTimePosition;
  ratio: number;
  rightIndex: number;
  rightTime: number;
  targetTime: number;
}

export interface DrawingCoordinateIndexStats {
  numericBatchFallbackCount: number;
  numericBatchMergeWalkCount: number;
  numericBinarySearchCount: number;
  numericValidationCount: number;
  ordinalSameTimeCacheBuildCount: number;
}

export interface CreateDrawingCoordinateIndexOptions {
  lineageIndex?: DrawingLineageIndex | null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finiteSourceOrdinal(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function interpolationResult(
  targetTime: number,
  leftIndex: number,
  rightIndex: number,
  leftTime: number,
  rightTime: number,
  position: NumericTimePosition,
): NumericTimeSearchResult {
  const exactIndex = position === "exact" ? leftIndex : null;
  const duration = rightTime - leftTime;
  const ratio = exactIndex !== null || duration === 0
    ? 0
    : (targetTime - leftTime) / duration;
  return {
    exactIndex,
    leftIndex,
    leftTime,
    position,
    ratio,
    rightIndex,
    rightTime,
    targetTime,
  };
}

/**
 * Revision-local source-coordinate index used by DrawingFrameSnapshot.
 *
 * Numeric rows are validated and copied to a Float64 index in one pass.
 * Ordinal rows never build a second lineage index: callers must provide the
 * projection-owned DrawingLineageIndex for the exact same display array.
 */
export class DrawingCoordinateIndex {
  readonly issue: DrawingCoordinateIndexIssue | null;
  readonly lineageRevision: number | null;
  readonly mode: DrawingCoordinateIndexMode;
  readonly numericTimes: Float64Array | null;
  readonly seriesData: DisplayRow[];
  readonly stats: DrawingCoordinateIndexStats;

  private readonly exactNumericIndices: Map<number, number>;
  private readonly lineageIndex: DrawingLineageIndex | null;
  private readonly ordinalRowsBySourceTime: Map<number, Map<number, DisplayRow | null>>;

  constructor(
    seriesData: DisplayRow[],
    { lineageIndex = null }: CreateDrawingCoordinateIndexOptions = {},
  ) {
    this.seriesData = Array.isArray(seriesData) ? seriesData : [];
    this.exactNumericIndices = new Map();
    this.ordinalRowsBySourceTime = new Map();
    this.stats = {
      numericBatchFallbackCount: 0,
      numericBatchMergeWalkCount: 0,
      numericBinarySearchCount: 0,
      numericValidationCount: 0,
      ordinalSameTimeCacheBuildCount: 0,
    };

    if (this.seriesData.length === 0) {
      this.mode = "empty";
      this.issue = null;
      this.numericTimes = new Float64Array(0);
      this.lineageIndex = null;
      this.lineageRevision = null;
      return;
    }

    const firstTime = this.seriesData[0]?.time;
    if (isOrdinalAxisTime(firstTime)) {
      this.numericTimes = null;
      if (!lineageIndex) {
        this.mode = "invalid";
        this.issue = "ordinal-lineage-missing";
        this.lineageIndex = null;
        this.lineageRevision = null;
        return;
      }
      if (!isDrawingLineageIndexForSeries(lineageIndex, this.seriesData)) {
        this.mode = "invalid";
        this.issue = "ordinal-lineage-mismatch";
        this.lineageIndex = null;
        this.lineageRevision = null;
        return;
      }
      this.mode = "ordinal";
      this.issue = null;
      this.lineageIndex = lineageIndex;
      this.lineageRevision = lineageIndex.revision;
      return;
    }

    this.lineageIndex = null;
    this.lineageRevision = null;
    this.stats.numericValidationCount = 1;
    const numericTimes = new Float64Array(this.seriesData.length);
    let previousTime = Number.NEGATIVE_INFINITY;
    let issue: DrawingCoordinateIndexIssue | null = null;

    // Numeric validation and exact/Float64 index construction intentionally
    // share this single pass. No per-anchor validation is necessary afterward.
    for (let index = 0; index < this.seriesData.length; index += 1) {
      const time = this.seriesData[index]?.time;
      if (isOrdinalAxisTime(time)) {
        issue = "mixed-axis-time";
        break;
      }
      if (!finiteNumber(time)) {
        issue = "invalid-numeric-row";
        break;
      }
      if (index > 0 && time === previousTime) {
        issue = "duplicate-time";
        break;
      }
      if (index > 0 && time < previousTime) {
        issue = "unordered-time";
        break;
      }
      numericTimes[index] = time;
      this.exactNumericIndices.set(time, index);
      previousTime = time;
    }

    if (issue) {
      this.mode = "invalid";
      this.issue = issue;
      this.numericTimes = null;
      this.exactNumericIndices.clear();
      return;
    }

    this.mode = "numeric";
    this.issue = null;
    this.numericTimes = numericTimes;
  }

  get valid(): boolean {
    return this.mode !== "invalid";
  }

  get validationCount(): number {
    return this.stats.numericValidationCount;
  }

  findExactNumericIndex(time: unknown): number | null {
    if (this.mode !== "numeric" || !finiteNumber(time)) return null;
    return this.exactNumericIndices.get(time) ?? null;
  }

  findExactNumericRow(time: unknown): DisplayRow | null {
    const index = this.findExactNumericIndex(time);
    return index === null ? null : this.seriesData[index] ?? null;
  }

  /** Resolve a timestamp through one O(log B) lower-bound search. */
  searchNumericTime(time: unknown): NumericTimeSearchResult | null {
    if (this.mode !== "numeric" || !finiteNumber(time)) return null;
    this.stats.numericBinarySearchCount += 1;
    return this.searchNumericTimeUnchecked(time);
  }

  /**
   * Resolve a point batch without changing caller order.
   *
   * Finite nondecreasing input uses one merge-walk over the Float64 index.
   * Unsorted or partly invalid input safely falls back to independent binary
   * searches; invalid entries resolve to null without rejecting valid peers.
   */
  resolveNumericBatch(times: readonly unknown[]): Array<NumericTimeSearchResult | null> {
    if (this.mode !== "numeric" || !Array.isArray(times)) {
      return Array.from({ length: Array.isArray(times) ? times.length : 0 }, () => null);
    }
    if (times.length === 0) return [];

    let ordered = true;
    let previousTime = Number.NEGATIVE_INFINITY;
    for (const value of times) {
      if (!finiteNumber(value) || value < previousTime) {
        ordered = false;
        break;
      }
      previousTime = value;
    }

    if (!ordered) {
      this.stats.numericBatchFallbackCount += 1;
      return times.map((value) => this.searchNumericTime(value));
    }

    this.stats.numericBatchMergeWalkCount += 1;
    const numericTimes = this.numericTimes;
    if (!numericTimes || numericTimes.length === 0) return times.map(() => null);
    if (numericTimes.length === 1) {
      const onlyTime = numericTimes[0];
      if (onlyTime === undefined) return times.map(() => null);
      return times.map((value) => {
        if (!finiteNumber(value)) return null;
        const position = value === onlyTime
          ? "exact"
          : value < onlyTime ? "before" : "after";
        return interpolationResult(value, 0, 0, onlyTime, onlyTime, position);
      });
    }

    const lastIndex = numericTimes.length - 1;
    let cursor = 0;
    return times.map((value) => {
      if (!finiteNumber(value)) return null;
      while (cursor < lastIndex && Number(numericTimes[cursor + 1]) <= value) {
        cursor += 1;
      }
      const cursorTime = numericTimes[cursor];
      if (cursorTime === undefined) return null;
      if (cursorTime === value) {
        return interpolationResult(
          value,
          cursor,
          cursor,
          cursorTime,
          cursorTime,
          "exact",
        );
      }
      if (cursor === 0 && value < cursorTime) {
        const rightTime = numericTimes[1];
        if (rightTime === undefined) return null;
        return interpolationResult(value, 0, 1, cursorTime, rightTime, "before");
      }
      if (cursor === lastIndex) {
        const leftTime = numericTimes[lastIndex - 1];
        if (leftTime === undefined) return null;
        return interpolationResult(
          value,
          lastIndex - 1,
          lastIndex,
          leftTime,
          cursorTime,
          "after",
        );
      }
      const rightTime = numericTimes[cursor + 1];
      if (rightTime === undefined) return null;
      return interpolationResult(value, cursor, cursor + 1, cursorTime, rightTime, "between");
    });
  }

  /**
   * Resolve one canonical same-time ordinal without scanning that run again.
   * Ambiguous duplicate ordinals fail closed and stay cached as null.
   */
  findExactOrdinalRow(sourceTime: unknown, sourceOrdinal: unknown): DisplayRow | null {
    if (this.mode !== "ordinal"
      || !finiteNumber(sourceTime)
      || !finiteSourceOrdinal(sourceOrdinal)
      || !this.lineageIsCurrent()) {
      return null;
    }

    let ordinalRows = this.ordinalRowsBySourceTime.get(sourceTime);
    if (!ordinalRows) {
      ordinalRows = new Map();
      const sameTimeRows = this.lineageIndex?.exactRowsBySourceTime.get(sourceTime) ?? [];
      for (const row of sameTimeRows) {
        const axisTime = row?.time;
        if (!isOrdinalAxisTime(axisTime) || axisTime.sourceTime !== sourceTime) continue;
        if (ordinalRows.has(axisTime.sourceOrdinal)) {
          ordinalRows.set(axisTime.sourceOrdinal, null);
        } else {
          ordinalRows.set(axisTime.sourceOrdinal, row);
        }
      }
      this.ordinalRowsBySourceTime.set(sourceTime, ordinalRows);
      this.stats.ordinalSameTimeCacheBuildCount += 1;
    }
    return ordinalRows.get(sourceOrdinal) ?? null;
  }

  private lineageIsCurrent(): boolean {
    return this.lineageIndex !== null
      && this.lineageRevision !== null
      && this.lineageIndex.revision === this.lineageRevision
      && this.lineageIndex.seriesData === this.seriesData;
  }

  private searchNumericTimeUnchecked(time: number): NumericTimeSearchResult | null {
    const numericTimes = this.numericTimes;
    if (!numericTimes || numericTimes.length === 0) return null;
    if (numericTimes.length === 1) {
      const onlyTime = numericTimes[0];
      if (onlyTime === undefined) return null;
      const position = time === onlyTime ? "exact" : time < onlyTime ? "before" : "after";
      return interpolationResult(time, 0, 0, onlyTime, onlyTime, position);
    }

    let left = 0;
    let right = numericTimes.length;
    while (left < right) {
      const middle = (left + right) >> 1;
      const middleTime = numericTimes[middle];
      if (middleTime === undefined) return null;
      if (middleTime < time) left = middle + 1;
      else right = middle;
    }

    if (left < numericTimes.length && numericTimes[left] === time) {
      return interpolationResult(time, left, left, time, time, "exact");
    }
    if (left === 0) {
      const firstTime = numericTimes[0];
      const secondTime = numericTimes[1];
      if (firstTime === undefined || secondTime === undefined) return null;
      return interpolationResult(time, 0, 1, firstTime, secondTime, "before");
    }
    if (left === numericTimes.length) {
      const lastIndex = numericTimes.length - 1;
      const previousTime = numericTimes[lastIndex - 1];
      const lastTime = numericTimes[lastIndex];
      if (previousTime === undefined || lastTime === undefined) return null;
      return interpolationResult(
        time,
        lastIndex - 1,
        lastIndex,
        previousTime,
        lastTime,
        "after",
      );
    }

    const leftTime = numericTimes[left - 1];
    const rightTime = numericTimes[left];
    if (leftTime === undefined || rightTime === undefined) return null;
    return interpolationResult(time, left - 1, left, leftTime, rightTime, "between");
  }
}

export function createDrawingCoordinateIndex(
  seriesData: DisplayRow[],
  options: CreateDrawingCoordinateIndexOptions = {},
): DrawingCoordinateIndex {
  return new DrawingCoordinateIndex(seriesData, options);
}
