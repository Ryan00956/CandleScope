import { sourceTimeFromAxisTime } from "./axisTime.js";

const SUPPORTED_FANOUTS = new Set(["all", "last"]);

function displaySourceTime(row) {
  return sourceTimeFromAxisTime(row?.time);
}

function projectTimedField(owner, field, index, fanout) {
  if (!Array.isArray(owner?.[field])) return owner?.[field];
  return projectSourceTimedEntries(owner[field], index, { fanout });
}

function projectGroups(groups, index, fanout, timedFields) {
  if (!Array.isArray(groups)) return [];
  return groups.map((group) => {
    if (!group || typeof group !== "object") return group;
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
export function buildDisplaySourceTimeIndex(displayRows = []) {
  const targets = [];
  const bySourceTime = new Map();
  const lastTargetIndexBySourceTime = new Map();
  const displayTimeSet = new Set();

  for (const row of Array.isArray(displayRows) ? displayRows : []) {
    const time = row?.time;
    if (time != null) displayTimeSet.add(time);

    const sourceTime = displaySourceTime(row);
    if (!Number.isFinite(sourceTime) || time == null) continue;

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
export function projectSourceTimedEntries(entries = [], index, { fanout = "all" } = {}) {
  if (!SUPPORTED_FANOUTS.has(fanout)) {
    throw new RangeError(`Unsupported derived auxiliary fanout: ${fanout}`);
  }

  const sourceEntryByTime = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const sourceTime = sourceTimeFromAxisTime(entry?.time);
    if (!Number.isFinite(sourceTime)) continue;
    sourceEntryByTime.set(sourceTime, entry);
  }

  const targets = Array.isArray(index?.targets) ? index.targets : [];
  const lastTargetIndexBySourceTime = index?.lastTargetIndexBySourceTime;
  const projected = [];

  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const target = targets[targetIndex];
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
export function projectPaneDescriptorsToDisplay(panes = [], index) {
  if (!Array.isArray(panes)) return [];

  return panes.map((pane) => {
    if (!pane || typeof pane !== "object") return pane;
    const projected = { ...pane };

    if (Array.isArray(pane.lines)) {
      projected.lines = pane.lines.map((line) => {
        if (!line || typeof line !== "object") return line;
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

export function projectBarcolorGroupsToDisplay(groups = [], index) {
  return projectGroups(groups, index, "all", ["data"]);
}

/**
 * Returns whether displayRows[index] is the final contiguous output carrying
 * its exact sourceTime. This intentionally performs only current/next lookup
 * so high-frequency crosshair resolution remains O(1).
 */
export function isLastDisplayTargetForSourceTime(displayRows, index) {
  if (
    !Array.isArray(displayRows)
    || !Number.isInteger(index)
    || index < 0
    || index >= displayRows.length
  ) {
    return false;
  }

  const sourceTime = displaySourceTime(displayRows[index]);
  if (!Number.isFinite(sourceTime)) return false;
  if (index === displayRows.length - 1) return true;
  return displaySourceTime(displayRows[index + 1]) !== sourceTime;
}
