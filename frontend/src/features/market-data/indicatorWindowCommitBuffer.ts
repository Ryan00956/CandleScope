import type { WindowChangedRange } from "./klineContracts.js";
import { mergeIndicatorWindowChangedRanges } from "./indicatorRangeRuntime.js";

const MAX_EXACT_CHANGED_RANGES = 512;

function boundRangesWithoutDroppingCoverage(
  ranges: WindowChangedRange[],
): WindowChangedRange[] {
  if (ranges.length <= MAX_EXACT_CHANGED_RANGES) return ranges;
  const boundaries: Array<{ index: number; gap: number }> = [];
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (!previous || !current || previous.type !== current.type) continue;
    boundaries.push({
      index,
      gap: Math.max(0, Number(current.start) - Number(previous.end) - 1),
    });
  }
  boundaries.sort((left, right) => left.gap - right.gap || left.index - right.index);
  const joinedBoundaries = new Set(
    boundaries
      .slice(0, ranges.length - MAX_EXACT_CHANGED_RANGES)
      .map(({ index }) => index),
  );
  const bounded: WindowChangedRange[] = [];
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    if (!range) continue;
    const previous = bounded.at(-1);
    if (previous && joinedBoundaries.has(index) && previous.type === range.type) {
      previous.end = range.end;
    } else {
      bounded.push({ ...range });
    }
  }
  return bounded;
}

export interface IndicatorWindowCommitResult {
  deferred: boolean;
  lifecycleChanged: boolean;
  publish: boolean;
  ranges: WindowChangedRange[];
}

export interface IndicatorWindowCommitOptions {
  ownerToken?: string | null | undefined;
  pending?: boolean;
}

interface IndicatorWindowSeriesState {
  owners: Set<string>;
  ranges: WindowChangedRange[];
}

export class IndicatorWindowCommitBuffer {
  private readonly pending = new Map<string, IndicatorWindowSeriesState>();

  record(
    seriesKey: string,
    changedRanges: readonly WindowChangedRange[] = [],
    {
      ownerToken = null,
      pending = false,
    }: IndicatorWindowCommitOptions = {},
  ): IndicatorWindowCommitResult {
    const current = this.pending.get(seriesKey);
    const owners = new Set(current?.owners || []);
    const normalizedOwner = String(ownerToken || "").trim();
    let lifecycleChanged = false;
    if (normalizedOwner) {
      if (pending) {
        lifecycleChanged = !owners.has(normalizedOwner);
        owners.add(normalizedOwner);
      } else {
        lifecycleChanged = owners.delete(normalizedOwner);
      }
    }
    const ranges = boundRangesWithoutDroppingCoverage(mergeIndicatorWindowChangedRanges(
      current?.ranges,
      changedRanges,
    ));
    if (owners.size > 0) {
      this.pending.set(seriesKey, { owners, ranges });
      return { deferred: true, lifecycleChanged, publish: false, ranges };
    }
    this.pending.delete(seriesKey);
    return {
      deferred: false,
      lifecycleChanged,
      publish: ranges.length > 0,
      ranges,
    };
  }

  hasPending(seriesKey: string): boolean {
    return (this.pending.get(seriesKey)?.owners.size || 0) > 0;
  }

  hasOwner(seriesKey: string, ownerToken: string): boolean {
    return this.pending.get(seriesKey)?.owners.has(ownerToken) || false;
  }

  discard(seriesKey: string): void {
    this.pending.delete(seriesKey);
  }

  clear(): void {
    this.pending.clear();
  }

  snapshot(seriesKey: string): WindowChangedRange[] {
    return (this.pending.get(seriesKey)?.ranges || []).map((range) => ({ ...range }));
  }
}
