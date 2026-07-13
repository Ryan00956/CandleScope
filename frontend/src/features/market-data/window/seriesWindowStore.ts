import type {
  WindowDelta,
  WindowDeltaDetail,
  WindowDeltaType,
} from "../klineContracts.js";
import type {
  DataRevision,
  EpochSeconds,
  KlineBar,
  KlineBarInput,
  SeriesCoverage,
  SeriesDescription,
  SeriesKey,
  SeriesWindowIndexRef,
  SeriesWindowSegment,
} from "../marketDataTypes.js";
import {
  asDataRevision,
  asSeriesKey,
  toEpochSeconds,
} from "../marketDataTypes.js";
import { MAX_SERIES_BARS } from "../phase1WindowPolicy.js";
import { createWindowDelta, WINDOW_DELTA_TYPES } from "./windowDeltas.js";

interface SeriesWindowStoreOptions {
  maxBars?: number;
  intervalSeconds?: number | null;
  seriesKey?: SeriesKey | string | null;
}
interface SnapshotOptions {
  force?: boolean;
}

interface TrimResult {
  trimmedLeft: number;
  trimmedRight: number;
}

export type SeriesWindowListener = (
  delta: WindowDelta,
  store: SeriesWindowStore,
) => void;

function finiteTime(row: KlineBarInput | null | undefined): EpochSeconds | null {
  return toEpochSeconds(row?.time);
}

function sameRow(
  left: Record<string, unknown> | null | undefined,
  right: Record<string, unknown> | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function normalizeRows(rows: readonly KlineBarInput[] | null | undefined): KlineBar[] {
  const byTime = new Map<EpochSeconds, KlineBar>();
  for (const row of rows || []) {
    const time = finiteTime(row);
    if (time == null) continue;
    byTime.set(time, { ...row, time });
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

function inferIntervalSeconds(rows: readonly KlineBar[]): number | null {
  let best: number | null = null;
  for (let index = 1; index < rows.length; index += 1) {
    const diff = rows[index].time - rows[index - 1].time;
    if (diff <= 0) continue;
    best = best == null ? diff : Math.min(best, diff);
  }
  return best;
}

function buildSegments(
  rows: readonly KlineBar[],
  intervalSeconds: number | null = null,
): SeriesWindowSegment[] {
  if (!rows.length) return [];
  const step = intervalSeconds || inferIntervalSeconds(rows);
  const threshold = step ? step * 1.5 : null;
  const segments: SeriesWindowSegment[] = [];
  let current = [rows[0]];
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const row = rows[index];
    if (threshold != null && row.time - previous.time > threshold) {
      segments.push({ bars: current });
      current = [row];
    } else {
      current.push(row);
    }
  }
  segments.push({ bars: current });
  return segments;
}

export class SeriesWindowStore {
  seriesKey: SeriesKey | null;
  maxBars: number;
  intervalSeconds: number | null;
  private _segments: SeriesWindowSegment[];
  private _timeIndex: Map<EpochSeconds, SeriesWindowIndexRef>;
  private _snapshot: KlineBar[];
  private _snapshotDirty: boolean;
  private _timeSet: Set<EpochSeconds>;
  private _version: number;
  private _listeners: Set<SeriesWindowListener>;

  constructor({
    maxBars = MAX_SERIES_BARS,
    intervalSeconds = null,
    seriesKey = null,
  }: SeriesWindowStoreOptions = {}) {
    this.seriesKey = typeof seriesKey === "string" ? asSeriesKey(seriesKey) : seriesKey;
    this.maxBars = maxBars;
    this.intervalSeconds = intervalSeconds;
    this._segments = [];
    this._timeIndex = new Map();
    this._snapshot = [];
    this._snapshotDirty = false;
    this._timeSet = new Set();
    this._version = 0;
    this._listeners = new Set();
  }

  get version(): DataRevision {
    return asDataRevision(this._version);
  }

  get segments(): SeriesWindowSegment[] {
    return this._segments.map((segment) => ({ bars: segment.bars.slice() }));
  }

  get barCount(): number {
    let count = 0;
    for (const segment of this._segments) count += segment.bars.length;
    return count;
  }

  isEmpty(): boolean {
    return this.barCount === 0;
  }

  snapshot({ force = false }: SnapshotOptions = {}): KlineBar[] {
    if (force || this._snapshotDirty) {
      this._snapshot = this._segments.flatMap((segment) => segment.bars);
      this._snapshotDirty = false;
    }
    return this._snapshot;
  }

  timeSet(): ReadonlySet<EpochSeconds> {
    return this._timeSet;
  }

  hasTime(time: unknown): boolean {
    const normalized = toEpochSeconds(time);
    return normalized != null && this._timeIndex.has(normalized);
  }

  getByTime(time: unknown): KlineBar | null {
    const normalized = toEpochSeconds(time);
    if (normalized == null) return null;
    const ref = this._timeIndex.get(normalized);
    if (!ref) return null;
    return this._segments[ref.segmentIndex]?.bars?.[ref.rowIndex] || null;
  }

  indexOfTime(time: unknown): number {
    const normalized = toEpochSeconds(time);
    if (normalized == null) return -1;
    const ref = this._timeIndex.get(normalized);
    if (!ref) return -1;
    let offset = 0;
    for (let segmentIndex = 0; segmentIndex < ref.segmentIndex; segmentIndex += 1) {
      offset += this._segments[segmentIndex].bars.length;
    }
    return offset + ref.rowIndex;
  }

  first(): KlineBar | null {
    return this.snapshot()[0] || null;
  }

  last(): KlineBar | null {
    const rows = this.snapshot();
    return rows[rows.length - 1] || null;
  }

  coverage(): SeriesCoverage {
    const rows = this.snapshot();
    if (!rows.length) {
      return {
        firstTime: null,
        lastTime: null,
        bars: 0,
        gaps: [],
      };
    }
    const gaps: SeriesCoverage["gaps"] = [];
    for (let index = 1; index < this._segments.length; index += 1) {
      const previous = this._segments[index - 1].bars;
      const next = this._segments[index].bars;
      const from = previous[previous.length - 1]?.time;
      const to = next[0]?.time;
      if (from == null || to == null) continue;
      const missingBars = this.intervalSeconds
        ? Math.max(0, Math.round((to - from) / this.intervalSeconds) - 1)
        : null;
      gaps.push({ from, to, missingBars });
    }
    return {
      firstTime: rows[0].time,
      lastTime: rows[rows.length - 1].time,
      bars: rows.length,
      gaps,
    };
  }

  describe(): SeriesDescription {
    const coverage = this.coverage();
    return {
      seriesKey: this.seriesKey,
      bars: coverage.bars,
      firstTime: coverage.firstTime,
      lastTime: coverage.lastTime,
      coverage,
      version: this.version,
    };
  }

  subscribe(listener: SeriesWindowListener): () => boolean {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  clear(meta: WindowDeltaDetail = {}): WindowDelta {
    if (this.barCount === 0) return createWindowDelta(WINDOW_DELTA_TYPES.NOOP);
    const originalBars = this.barCount;
    this._segments = [];
    this._timeIndex.clear();
    this._timeSet = new Set();
    this._snapshot = [];
    this._snapshotDirty = false;
    this._version += 1;
    const delta = createWindowDelta(WINDOW_DELTA_TYPES.CLEAR, {
      originalBars,
      bars: 0,
      ...meta,
    });
    this._emit(delta);
    return delta;
  }

  replace(
    rows: readonly KlineBarInput[] | null | undefined,
    meta: WindowDeltaDetail = {},
  ): WindowDelta {
    const normalized = normalizeRows(rows);
    const originalBars = normalized.length;
    this._replaceRows(normalized);
    const trim = this.trimToBudget();
    this._version += 1;
    const delta = createWindowDelta(WINDOW_DELTA_TYPES.REPLACE, {
      bars: this.barCount,
      originalBars,
      trimmedLeft: trim.trimmedLeft,
      trimmedRight: trim.trimmedRight,
      ...meta,
    });
    this._emit(delta);
    return delta;
  }

  applyRange(
    rows: readonly KlineBarInput[] | null | undefined,
    meta: WindowDeltaDetail = {},
  ): WindowDelta {
    const incoming = normalizeRows(rows);
    if (!incoming.length) return createWindowDelta(WINDOW_DELTA_TYPES.NOOP);

    if (this.barCount === 0) {
      return this.replace(incoming, meta);
    }

    const previousRows = this.snapshot();
    const previousFirst = previousRows[0].time;
    const previousLast = previousRows[previousRows.length - 1].time;
    const previousByTime = new Map(previousRows.map((row) => [row.time, row]));
    const byTime = new Map(previousByTime);
    let addedLeft = 0;
    let addedRight = 0;
    let changed = false;

    for (const row of incoming) {
      const existing = byTime.get(row.time);
      if (!existing) {
        if (row.time < previousFirst) addedLeft += 1;
        if (row.time > previousLast) addedRight += 1;
        changed = true;
      } else if (!sameRow(existing, row)) {
        changed = true;
      }
      byTime.set(row.time, row);
    }

    if (!changed) return createWindowDelta(WINDOW_DELTA_TYPES.NOOP);

    const nextRows = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    this._replaceRows(nextRows);
    const trim = this.trimToBudget();
    this._version += 1;

    const incomingFirst = incoming[0].time;
    const incomingLast = incoming[incoming.length - 1].time;
    let type: WindowDeltaType = WINDOW_DELTA_TYPES.MID_MERGE;
    if (incomingLast < previousFirst) type = WINDOW_DELTA_TYPES.PREPEND;
    else if (incomingFirst > previousLast) type = WINDOW_DELTA_TYPES.APPEND;

    const delta = createWindowDelta(type, {
      bars: this.barCount,
      incomingBars: incoming.length,
      addedLeft,
      addedRight,
      originalBars: nextRows.length,
      trimmedLeft: trim.trimmedLeft,
      trimmedRight: trim.trimmedRight,
      ...meta,
    });
    this._emit(delta);
    return delta;
  }

  applyTick(
    row: KlineBarInput | null | undefined,
    meta: WindowDeltaDetail = {},
  ): WindowDelta {
    const time = finiteTime(row);
    if (time == null || this.barCount === 0 || !row) {
      return createWindowDelta(WINDOW_DELTA_TYPES.NOOP);
    }

    const tick: KlineBar = { ...row, time };
    const firstTime = this._firstTime();
    const lastTime = this._lastTime();
    if (firstTime == null || lastTime == null || time < firstTime) {
      return createWindowDelta(WINDOW_DELTA_TYPES.NOOP);
    }

    const existingRef = this._timeIndex.get(time);
    let replaced = false;
    let appended = false;

    if (existingRef) {
      const segment = this._segments[existingRef.segmentIndex];
      if (sameRow(segment.bars[existingRef.rowIndex], tick)) {
        return createWindowDelta(WINDOW_DELTA_TYPES.NOOP);
      }
      segment.bars[existingRef.rowIndex] = tick;
      if (time !== lastTime) {
        // Mid-window correction: positions are unchanged, so the time index
        // stays valid; only the flattened snapshot must be rebuilt lazily.
        this._snapshotDirty = true;
        this._version += 1;
        const delta = createWindowDelta(WINDOW_DELTA_TYPES.MID_MERGE, {
          bars: this.barCount,
          incomingBars: 1,
          addedLeft: 0,
          addedRight: 0,
          originalBars: this.barCount,
          trimmedLeft: 0,
          trimmedRight: 0,
          ...meta,
        });
        this._emit(delta);
        return delta;
      }
      // Replace-last fast path: patch the cached snapshot in place so the
      // realtime tick stays O(1) and keeps the snapshot identity stable.
      if (!this._snapshotDirty && this._snapshot.length > 0) {
        this._snapshot[this._snapshot.length - 1] = tick;
      } else {
        this._snapshotDirty = true;
      }
      replaced = true;
    } else if (time > lastTime) {
      const lastSegmentIndex = this._segments.length - 1;
      const lastSegment = this._segments[lastSegmentIndex];
      const lastBar = lastSegment.bars[lastSegment.bars.length - 1];
      const shouldExtend = !this.intervalSeconds
        || time - lastBar.time <= this.intervalSeconds * 1.5;
      if (shouldExtend) {
        lastSegment.bars.push(tick);
        this._timeIndex.set(time, {
          segmentIndex: lastSegmentIndex,
          rowIndex: lastSegment.bars.length - 1,
        });
      } else {
        this._segments.push({ bars: [tick] });
        this._timeIndex.set(time, {
          segmentIndex: this._segments.length - 1,
          rowIndex: 0,
        });
      }
      this._timeSet.add(time);
      if (!this._snapshotDirty) {
        this._snapshot.push(tick);
      }
      appended = true;
    } else {
      return createWindowDelta(WINDOW_DELTA_TYPES.NOOP);
    }

    const trim = this.barCount > this.maxBars
      ? this.trimToBudget()
      : { trimmedLeft: 0, trimmedRight: 0 };
    this._version += 1;
    const delta = createWindowDelta(WINDOW_DELTA_TYPES.TICK, {
      bar: tick,
      bars: this.barCount,
      appended,
      replaced,
      originalBars: this.barCount + trim.trimmedLeft + trim.trimmedRight,
      trimmedLeft: trim.trimmedLeft,
      trimmedRight: trim.trimmedRight,
      ...meta,
    });
    this._emit(delta);
    return delta;
  }

  trimToBudget(): TrimResult {
    const count = this.barCount;
    if (count <= this.maxBars) return { trimmedLeft: 0, trimmedRight: 0 };

    const trimmedLeft = count - this.maxBars;
    const rows = this.snapshot().slice(trimmedLeft);
    this._replaceRows(rows);
    return { trimmedLeft, trimmedRight: 0 };
  }

  private _replaceRows(rows: KlineBar[]): void {
    if (!this.intervalSeconds) {
      this.intervalSeconds = inferIntervalSeconds(rows);
    }
    this._segments = buildSegments(rows, this.intervalSeconds);
    this._snapshot = rows;
    this._snapshotDirty = false;
    this._rebuildTimeIndex();
  }

  private _firstTime(): EpochSeconds | null {
    return this._segments[0]?.bars[0]?.time ?? null;
  }

  private _lastTime(): EpochSeconds | null {
    const lastSegment = this._segments[this._segments.length - 1];
    return lastSegment?.bars[lastSegment.bars.length - 1]?.time ?? null;
  }

  private _rebuildTimeIndex(): void {
    this._timeIndex.clear();
    this._segments.forEach((segment, segmentIndex) => {
      segment.bars.forEach((row, rowIndex) => {
        this._timeIndex.set(row.time, { segmentIndex, rowIndex });
      });
    });
    this._timeSet = new Set(this._timeIndex.keys());
  }

  private _emit(delta: WindowDelta): void {
    for (const listener of this._listeners) {
      listener(delta, this);
    }
  }
}
