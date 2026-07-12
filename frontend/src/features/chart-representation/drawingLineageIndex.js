import { isOrdinalAxisTime, sourceTimeRangeFromDisplayRow } from "./axisTime.js";
import { PROJECTION_METADATA_KEY } from "./projectors/projectorData.js";

const DRAWING_LINEAGE_INDEX_KIND = "candlescope-drawing-lineage-index";

function projectionMetadataFromRow(row) {
  const metadata = row?.customValues?.[PROJECTION_METADATA_KEY];
  return metadata && typeof metadata === "object" ? metadata : null;
}

function projectorIdFromRow(row) {
  const projectorId = projectionMetadataFromRow(row)?.projectorId;
  return typeof projectorId === "string" && projectorId.length > 0
    ? projectorId
    : null;
}

function usesOrdinalSeriesData(seriesData) {
  if (!Array.isArray(seriesData)) return false;
  for (let index = 0; index < seriesData.length; index += 1) {
    const row = seriesData[index];
    if (row?.time != null) return isOrdinalAxisTime(row.time);
  }
  return false;
}

function firstRangeIndexWithToAtLeast(rowRanges, target) {
  let left = 0;
  let right = rowRanges.length;
  while (left < right) {
    const middle = (left + right) >> 1;
    if (rowRanges[middle].range.to < target) left = middle + 1;
    else right = middle;
  }
  return left;
}

function firstRangeIndexWithFromGreaterThan(rowRanges, target, fromIndex = 0) {
  let left = fromIndex;
  let right = rowRanges.length;
  while (left < right) {
    const middle = (left + right) >> 1;
    if (rowRanges[middle].range.from <= target) left = middle + 1;
    else right = middle;
  }
  return left;
}

/**
 * Mutable, projection-owned lookup for resolving stable drawing anchors.
 *
 * ProjectionStore replaces only the forming synthetic tail during realtime
 * updates. Keeping the lookup independent from the display-array identity lets
 * that tail be removed and appended in O(changed tail) instead of rescanning
 * the complete projected history for the first primitive rendered each tick.
 */
export class DrawingLineageIndex {
  constructor(seriesData = []) {
    this.kind = DRAWING_LINEAGE_INDEX_KIND;
    this.revision = 0;
    this.seriesData = [];
    this.isOrdinal = false;
    this.exactRowsBySourceTime = new Map();
    this.ordinalRows = [];
    this.rowRanges = [];
    this.currentProjection = null;
    this.latestLineage = Number.NEGATIVE_INFINITY;
    this.rowRangesMonotonic = true;
    this._records = [];
    this._coverageGroup = 0;
    this._previousRangeFrom = Number.NEGATIVE_INFINITY;
    this._previousRangeTo = Number.NEGATIVE_INFINITY;
    this.reset(seriesData);
  }

  reset(seriesData = []) {
    const rows = Array.isArray(seriesData) ? seriesData : [];
    const previousState = {
      currentProjection: this.currentProjection,
      exactRowsBySourceTime: this.exactRowsBySourceTime,
      isOrdinal: this.isOrdinal,
      latestLineage: this.latestLineage,
      ordinalRows: this.ordinalRows,
      previousRangeFrom: this._previousRangeFrom,
      previousRangeTo: this._previousRangeTo,
      records: this._records,
      coverageGroup: this._coverageGroup,
      rowRanges: this.rowRanges,
      rowRangesMonotonic: this.rowRangesMonotonic,
      seriesData: this.seriesData,
    };
    this.seriesData = rows;
    this.isOrdinal = usesOrdinalSeriesData(rows);
    this.exactRowsBySourceTime = new Map();
    this.ordinalRows = [];
    this.rowRanges = [];
    this.currentProjection = null;
    this.latestLineage = Number.NEGATIVE_INFINITY;
    this.rowRangesMonotonic = true;
    this._records = [];
    this._coverageGroup = 0;
    this._previousRangeFrom = Number.NEGATIVE_INFINITY;
    this._previousRangeTo = Number.NEGATIVE_INFINITY;

    try {
      if (this.isOrdinal) {
        for (const row of rows) this._appendRow(row);
      }
    } catch (error) {
      this.currentProjection = previousState.currentProjection;
      this.exactRowsBySourceTime = previousState.exactRowsBySourceTime;
      this.isOrdinal = previousState.isOrdinal;
      this.latestLineage = previousState.latestLineage;
      this.ordinalRows = previousState.ordinalRows;
      this._previousRangeFrom = previousState.previousRangeFrom;
      this._previousRangeTo = previousState.previousRangeTo;
      this._records = previousState.records;
      this._coverageGroup = previousState.coverageGroup;
      this.rowRanges = previousState.rowRanges;
      this.rowRangesMonotonic = previousState.rowRangesMonotonic;
      this.seriesData = previousState.seriesData;
      throw error;
    }
    this.revision += 1;
    return this;
  }

  replaceTail({
    previousSeriesData,
    fromOutputIndex,
    insert,
    nextSeriesData,
  } = {}) {
    const insertedRows = Array.isArray(insert) ? insert : null;
    if (!Array.isArray(previousSeriesData)
      || !Array.isArray(nextSeriesData)
      || insertedRows == null
      || this.seriesData !== previousSeriesData
      || !this.isOrdinal
      || !Number.isInteger(fromOutputIndex)
      || fromOutputIndex < 0
      || fromOutputIndex > previousSeriesData.length
      || this._records.length !== previousSeriesData.length
      || nextSeriesData.length !== fromOutputIndex + insertedRows.length
      || (fromOutputIndex > 0
        && nextSeriesData[fromOutputIndex - 1] !== previousSeriesData[fromOutputIndex - 1])) {
      return false;
    }

    let insertedEntries;
    try {
      insertedEntries = insertedRows.map((row) => this._describeRow(row));
    } catch {
      return false;
    }
    this._removeTail(fromOutputIndex);
    for (let index = 0; index < insertedRows.length; index += 1) {
      this._appendRow(insertedRows[index], insertedEntries[index]);
    }
    this.seriesData = nextSeriesData;
    this.revision += 1;
    return true;
  }

  /**
   * Resolve the axis-ordered run whose source lineage overlaps an inclusive
   * source-time envelope. Monotonic projector lineage uses two binary searches;
   * unusual/non-monotonic or internally discontinuous metadata fails closed.
   */
  rowsOverlappingSourceEnvelope({ fromTime, toTime } = {}) {
    if (!Number.isFinite(fromTime)
      || !Number.isFinite(toTime)
      || fromTime > toTime
      || this.rowRanges.length === 0) {
      return null;
    }

    // A first/last axis run is only meaningful when lineage itself follows
    // axis order. Fail closed rather than spanning unrelated non-monotonic rows.
    if (!this.rowRangesMonotonic) return null;

    const firstIndex = firstRangeIndexWithToAtLeast(this.rowRanges, fromTime);
    const endIndex = firstRangeIndexWithFromGreaterThan(
      this.rowRanges,
      toTime,
      firstIndex,
    );
    if (firstIndex >= endIndex) return null;
    const firstEntry = this.rowRanges[firstIndex];
    const lastEntry = this.rowRanges[endIndex - 1];
    if (firstEntry.range.from > fromTime
      || firstEntry.range.to < fromTime
      || lastEntry.range.from > toTime
      || lastEntry.range.to < toTime
      || firstEntry.coverageGroup !== lastEntry.coverageGroup) {
      return null;
    }
    return { first: firstEntry.row, last: lastEntry.row };
  }

  _removeTail(fromOutputIndex) {
    for (let index = this._records.length - 1; index >= fromOutputIndex; index -= 1) {
      const record = this._records[index];
      if (!record?.ordinalIncluded) continue;
      const exactRows = this.exactRowsBySourceTime.get(record.sourceTime);
      if (!exactRows) continue;
      if (exactRows[exactRows.length - 1] === record.row) {
        exactRows.pop();
      } else {
        const rowIndex = exactRows.lastIndexOf(record.row);
        if (rowIndex >= 0) exactRows.splice(rowIndex, 1);
      }
      if (exactRows.length === 0) this.exactRowsBySourceTime.delete(record.sourceTime);
    }

    this._records.length = fromOutputIndex;
    const retained = this._records[fromOutputIndex - 1] || null;
    this.ordinalRows.length = retained?.ordinalCount || 0;
    this.rowRanges.length = retained?.rangeCount || 0;
    this.currentProjection = retained?.currentProjection || null;
    this.latestLineage = retained?.latestLineage ?? Number.NEGATIVE_INFINITY;
    this.rowRangesMonotonic = retained?.rowRangesMonotonic ?? true;
    this._coverageGroup = retained?.coverageGroup ?? 0;
    this._previousRangeFrom = retained?.previousRangeFrom ?? Number.NEGATIVE_INFINITY;
    this._previousRangeTo = retained?.previousRangeTo ?? Number.NEGATIVE_INFINITY;
  }

  _describeRow(row) {
    const ordinalIncluded = isOrdinalAxisTime(row?.time);
    return {
      ordinalIncluded,
      projectorId: ordinalIncluded ? projectorIdFromRow(row) : null,
      range: ordinalIncluded ? sourceTimeRangeFromDisplayRow(row) : null,
      sourceTime: ordinalIncluded ? row.time.sourceTime : null,
    };
  }

  _appendRow(row, description = this._describeRow(row)) {
    const {
      ordinalIncluded,
      projectorId,
      range,
      sourceTime,
    } = description;
    if (ordinalIncluded) {
      this.ordinalRows.push(row);
      let exactRows = this.exactRowsBySourceTime.get(sourceTime);
      if (!exactRows) {
        exactRows = [];
        this.exactRowsBySourceTime.set(sourceTime, exactRows);
      }
      exactRows.push(row);

      if (range) {
        if (range.from < this._previousRangeFrom || range.to < this._previousRangeTo) {
          this.rowRangesMonotonic = false;
        }
        // Projector lineage ranges normally overlap at their boundary. Allow
        // adjacent inclusive integer ranges as well, while assigning a new
        // group to a genuine hole so envelope queries remain O(log n).
        if (this.rowRanges.length > 0 && range.from > this._previousRangeTo + 1) {
          this._coverageGroup += 1;
        }
        this._previousRangeFrom = range.from;
        this._previousRangeTo = range.to;
        this.rowRanges.push({ coverageGroup: this._coverageGroup, row, range });
        if (range.to > this.latestLineage) this.latestLineage = range.to;
      }
      this.currentProjection ||= projectorId;
    }

    this._records.push({
      currentProjection: this.currentProjection,
      coverageGroup: this._coverageGroup,
      latestLineage: this.latestLineage,
      ordinalCount: this.ordinalRows.length,
      ordinalIncluded,
      previousRangeFrom: this._previousRangeFrom,
      previousRangeTo: this._previousRangeTo,
      rangeCount: this.rowRanges.length,
      row,
      rowRangesMonotonic: this.rowRangesMonotonic,
      sourceTime,
    });
  }
}

export function createDrawingLineageIndex(seriesData = []) {
  return new DrawingLineageIndex(seriesData);
}

export function isDrawingLineageIndexForSeries(value, seriesData) {
  return value?.kind === DRAWING_LINEAGE_INDEX_KIND
    && value.isOrdinal === true
    && value.seriesData === seriesData
    && value.exactRowsBySourceTime instanceof Map
    && Array.isArray(value.rowRanges);
}
