import { sourceTimeFromAxisTime } from "./axisTime.js";
import type {
  AuxiliaryFanout,
  AxisTime,
  DisplayRow,
  DisplaySourceTimeIndex,
} from "./chartRepresentationTypes.js";

type JsonRecord = Record<string, unknown>;

interface TimedEntry extends JsonRecord {
  time?: unknown;
}

const SUPPORTED_FANOUTS = new Set<AuxiliaryFanout>(["all", "last"]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displaySourceTime(row: DisplayRow | null | undefined): number | null {
  return sourceTimeFromAxisTime(row?.time);
}

function projectTimedField(
  owner: JsonRecord,
  field: string,
  index: DisplaySourceTimeIndex,
  fanout: AuxiliaryFanout,
): unknown {
  if (!Array.isArray(owner?.[field])) return owner?.[field];
  return projectSourceTimedEntries(owner[field], index, { fanout });
}

function projectGroups(
  groups: unknown,
  index: DisplaySourceTimeIndex,
  fanout: AuxiliaryFanout,
  timedFields: readonly string[],
): unknown[] {
  if (!Array.isArray(groups)) return [];
  const groupList: unknown[] = groups;
  return groupList.map((group) => {
    if (!isRecord(group)) return group;
    const projected = { ...group };
    for (const field of timedFields) {
      if (Array.isArray(group[field])) {
        projected[field] = projectTimedField(group, field, index, fanout);
      }
    }
    return projected;
  });
}

/**
 * Builds an opaque, display-ordered lookup for projecting source-timed
 * auxiliary data onto a derived axis. A source timestamp is matched only to
 * rows whose public axis time carries that exact sourceTime; lineage ranges
 * are deliberately ignored.
 */
export function buildDisplaySourceTimeIndex(
  displayRows: readonly DisplayRow[] = [],
): DisplaySourceTimeIndex {
  const targets: DisplaySourceTimeIndex["targets"] = [];
  const bySourceTime = new Map<number, AxisTime[]>();
  const lastTargetIndexBySourceTime = new Map<number, number>();
  const displayTimeSet = new Set<AxisTime>();

  for (const row of displayRows) {
    const time = row?.time;
    if (time != null) displayTimeSet.add(time);

    const sourceTime = displaySourceTime(row);
    if (sourceTime === null || !Number.isFinite(sourceTime) || time == null) continue;

    const targetIndex = targets.length;
    targets.push({ sourceTime, time });
    const displayTimes = bySourceTime.get(sourceTime);
    if (displayTimes) displayTimes.push(time);
    else bySourceTime.set(sourceTime, [time]);
    lastTargetIndexBySourceTime.set(sourceTime, targetIndex);
  }

  return {
    bySourceTime,
    displayTimeSet,
    lastTargetIndexBySourceTime,
    targets,
  };
}

/**
 * Projects timed source entries in display order. Duplicate input timestamps
 * use the last source entry, matching the indicator runtime's overwrite
 * semantics.
 */
export function projectSourceTimedEntries(
  entries: readonly TimedEntry[] = [],
  index: DisplaySourceTimeIndex,
  { fanout = "all" }: { fanout?: AuxiliaryFanout } = {},
): TimedEntry[] {
  if (!SUPPORTED_FANOUTS.has(fanout)) {
    throw new RangeError(`Unsupported derived auxiliary fanout: ${fanout}`);
  }

  const sourceEntryByTime = new Map<number, TimedEntry>();
  for (const entry of entries) {
    const sourceTime = sourceTimeFromAxisTime(entry?.time);
    if (sourceTime === null || !Number.isFinite(sourceTime)) continue;
    sourceEntryByTime.set(sourceTime, entry);
  }

  const targets = index.targets;
  const lastTargetIndexBySourceTime = index.lastTargetIndexBySourceTime;
  const projected: TimedEntry[] = [];

  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const target = targets[targetIndex];
    if (!target) continue;
    const entry = sourceEntryByTime.get(target.sourceTime);
    if (!entry) continue;
    if (
      fanout === "last"
      && lastTargetIndexBySourceTime?.get(target.sourceTime) !== targetIndex
    ) {
      continue;
    }
    projected.push({ ...entry, time: target.time });
  }

  return projected;
}

/**
 * Projects indicator pane descriptors without changing their structural
 * definitions. Lines and background colors fan out to every exact display
 * target; markers and volume samples attach only to the final target emitted
 * by a source bar. Fill and horizontal-line definitions are preserved.
 */
export function projectPaneDescriptorsToDisplay<TPane>(
  panes: readonly TPane[],
  index: DisplaySourceTimeIndex,
): TPane[];
export function projectPaneDescriptorsToDisplay(
  panes: readonly unknown[] = [],
  index: DisplaySourceTimeIndex,
): unknown[] {
  return panes.map((pane) => {
    if (!isRecord(pane)) return pane;
    const projected = { ...pane };

    if (Array.isArray(pane.lines)) {
      const lines: unknown[] = pane.lines;
      projected.lines = lines.map((line) => {
        if (!isRecord(line)) return line;
        const fanout = line.pane === "volume" ? "last" : "all";
        return {
          ...line,
          ...(Array.isArray(line.data)
            ? { data: projectTimedField(line, "data", index, fanout) }
            : {}),
          ...(Array.isArray(line.colorData)
            ? { colorData: projectTimedField(line, "colorData", index, fanout) }
            : {}),
        };
      });
    }

    if (Array.isArray(pane.markers)) {
      projected.markers = projectGroups(pane.markers, index, "last", ["data"]);
    }
    if (Array.isArray(pane.bgcolors)) {
      projected.bgcolors = projectGroups(pane.bgcolors, index, "all", ["data", "regions"]);
    }

    return projected;
  });
}

export function projectBarcolorGroupsToDisplay<TGroup>(
  groups: readonly TGroup[],
  index: DisplaySourceTimeIndex,
): TGroup[];
export function projectBarcolorGroupsToDisplay(
  groups: readonly unknown[] = [],
  index: DisplaySourceTimeIndex,
): unknown[] {
  return projectGroups(groups, index, "all", ["data"]);
}

/**
 * Returns whether displayRows[index] is the final contiguous output carrying
 * its exact sourceTime. This intentionally performs only current/next lookup
 * so high-frequency crosshair resolution remains O(1).
 */
export function isLastDisplayTargetForSourceTime(
  displayRows: readonly DisplayRow[] | null | undefined,
  index: unknown,
): boolean {
  if (
    !displayRows
    || !Number.isInteger(index)
    || Number(index) < 0
    || Number(index) >= displayRows.length
  ) {
    return false;
  }

  const resolvedIndex = Number(index);
  const currentRow = displayRows[resolvedIndex];
  if (!currentRow) return false;
  const sourceTime = displaySourceTime(currentRow);
  if (!Number.isFinite(sourceTime)) return false;
  if (resolvedIndex === displayRows.length - 1) return true;
  return displaySourceTime(displayRows[resolvedIndex + 1]) !== sourceTime;
}
