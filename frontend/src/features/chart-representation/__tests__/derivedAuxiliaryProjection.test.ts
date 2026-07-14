import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDisplaySourceTimeIndex,
  isLastDisplayTargetForSourceTime,
  projectBarcolorGroupsToDisplay,
  projectPaneDescriptorsToDisplay,
  projectSourceTimedEntries,
} from "../derivedAuxiliaryProjection.js";
import type {
  AuxiliaryFanout,
  DisplayRow,
  OrdinalAxisTime,
} from "../chartRepresentationTypes.js";
import { malformedFixture, mustBeDefined } from "../../../test/testHelpers.js";

function ordinal(order: number, sourceTime: number, sourceOrdinal = 0): OrdinalAxisTime {
  return { order, sourceTime, sourceOrdinal };
}

function at<T>(values: readonly T[], index: number): T {
  return mustBeDefined(values[index]);
}

function derivedRows() {
  return [
    { time: ordinal(0, 10, 0) },
    { time: ordinal(1, 10, 1) },
    { time: ordinal(2, 20, 0) },
    { time: ordinal(3, 40, 0) },
  ];
}

test("display source index keeps display order, exact source groups, and time identity", () => {
  const rows = derivedRows();
  const index = buildDisplaySourceTimeIndex(rows);

  assert.deepEqual([...index.bySourceTime.keys()], [10, 20, 40]);
  assert.deepEqual(index.bySourceTime.get(10), [at(rows, 0).time, at(rows, 1).time]);
  assert.strictEqual(at(mustBeDefined(index.bySourceTime.get(20)), 0), at(rows, 2).time);
  assert.deepEqual([...index.displayTimeSet], rows.map((row) => row.time));
  assert.strictEqual(at(index.targets, 0).time, at(rows, 0).time);
});

test("timed entries fan out in display order with exact matches and last-write-wins", () => {
  const rows = derivedRows();
  const index = buildDisplaySourceTimeIndex(rows);
  const entries = [
    { time: 40, value: "forty" },
    { time: 10, value: "stale" },
    { time: 30, value: "no display output" },
    { time: 10, value: "latest" },
  ];
  const before = structuredClone(entries);

  const all = projectSourceTimedEntries(entries, index, { fanout: "all" });
  assert.deepEqual(all.map((entry) => entry.value), ["latest", "latest", "forty"]);
  assert.strictEqual(at(all, 0).time, at(rows, 0).time);
  assert.strictEqual(at(all, 1).time, at(rows, 1).time);
  assert.strictEqual(at(all, 2).time, at(rows, 3).time);

  const last = projectSourceTimedEntries(entries, index, { fanout: "last" });
  assert.deepEqual(last.map((entry) => entry.value), ["latest", "forty"]);
  assert.strictEqual(at(last, 0).time, at(rows, 1).time);
  assert.strictEqual(at(last, 1).time, at(rows, 3).time);
  assert.deepEqual(entries, before);
  assert.throws(
    () => projectSourceTimedEntries(entries, index, {
      fanout: malformedFixture<AuxiliaryFanout>("nearest"),
    }),
    /Unsupported derived auxiliary fanout/,
  );
});

test("pane descriptors apply line, marker, bgcolor, and volume fanout policies", () => {
  const rows = derivedRows();
  const index = buildDisplaySourceTimeIndex(rows);
  const fills = [{ plot1_id: "fast", plot2_id: "slow", color: "#123" }];
  const hlines = [{ price: 50, title: "level" }];
  const panes = [{
    id: "main",
    lines: [{
      id: "fast",
      pane: "main",
      data: [{ time: 20, value: 2 }, { time: 10, value: 1 }],
      colorData: [{ time: 10, color: "red" }],
    }, {
      id: "volume",
      pane: "volume",
      type: "histogram",
      data: [{ time: 10, value: 100 }, { time: 20, value: 200 }],
      colorData: [{ time: 10, color: "green" }, { time: 20, color: "blue" }],
    }],
    markers: [{ id: "marker", data: [{ time: 10, text: "M" }] }],
    bgcolors: [{
      id: "background",
      data: [{ time: 10, color: "rgba(1,2,3,.2)" }],
      regions: [{ time: 20, color: "rgba(4,5,6,.2)" }],
    }],
    fills,
    hlines,
  }];
  const before = structuredClone(panes);

  const projected = at(projectPaneDescriptorsToDisplay(panes, index), 0);
  const fastLine = at(projected.lines, 0);
  const volumeLine = at(projected.lines, 1);
  const marker = at(projected.markers, 0);
  const bgcolor = at(projected.bgcolors, 0);

  assert.deepEqual(fastLine.data.map((point) => point.time), [
    at(rows, 0).time,
    at(rows, 1).time,
    at(rows, 2).time,
  ]);
  assert.deepEqual(fastLine.colorData.map((point) => point.time), [
    at(rows, 0).time,
    at(rows, 1).time,
  ]);
  assert.deepEqual(volumeLine.data.map((point) => point.time), [
    at(rows, 1).time,
    at(rows, 2).time,
  ]);
  assert.deepEqual(volumeLine.colorData.map((point) => point.time), [
    at(rows, 1).time,
    at(rows, 2).time,
  ]);
  assert.deepEqual(marker.data.map((point) => point.time), [at(rows, 1).time]);
  assert.deepEqual(bgcolor.data.map((point) => point.time), [
    at(rows, 0).time,
    at(rows, 1).time,
  ]);
  assert.deepEqual(bgcolor.regions.map((point) => point.time), [at(rows, 2).time]);
  assert.strictEqual(projected.fills, fills);
  assert.strictEqual(projected.hlines, hlines);
  assert.deepEqual(panes, before);
});

test("an empty derived index preserves pane structure while clearing timed data", () => {
  const panes = [{
    id: "main",
    paneIndex: 0,
    lines: [{ id: "overlay", data: [{ time: 10, value: 1 }] }],
  }, {
    id: "macd",
    paneIndex: 1,
    lines: [{ id: "signal", data: [{ time: 10, value: 2 }] }],
  }, {
    id: "atr",
    paneIndex: 2,
    lines: [{ id: "atr", data: [{ time: 10, value: 3 }] }],
  }, {
    id: "volume",
    paneIndex: 3,
    lines: [{ id: "volume", data: [{ time: 10, value: 4 }] }],
  }];

  const projected = projectPaneDescriptorsToDisplay(
    panes,
    buildDisplaySourceTimeIndex([]),
  );

  assert.deepEqual(projected.map((pane) => [pane.id, pane.paneIndex]), [
    ["main", 0],
    ["macd", 1],
    ["atr", 2],
    ["volume", 3],
  ]);
  assert.deepEqual(
    projected.flatMap((pane) => pane.lines.map((line) => line.data)),
    [[], [], [], []],
  );
});

test("barcolor groups fan out to every exact display target and drop missing targets", () => {
  const rows = derivedRows();
  const groups = [{
    id: "trend",
    data: [
      { time: 10, color: "red" },
      { time: 30, color: "gray" },
      { time: 40, color: "green" },
    ],
  }];

  const projected = projectBarcolorGroupsToDisplay(
    groups,
    buildDisplaySourceTimeIndex(rows),
  );

  const projectedGroup = at(projected, 0);
  assert.deepEqual(projectedGroup.data.map((point) => point.color), ["red", "red", "green"]);
  assert.deepEqual(projectedGroup.data.map((point) => point.time), [
    at(rows, 0).time,
    at(rows, 1).time,
    at(rows, 3).time,
  ]);
  assert.deepEqual(at(groups, 0).data.map((point) => point.time), [10, 30, 40]);
});

test("structural reprojection replaces reused orders with the new lineage objects", () => {
  const oldRows = [
    { time: ordinal(0, 10, 0) },
    { time: ordinal(1, 20, 0) },
  ];
  const newRows = [
    { time: ordinal(0, 5, 0) },
    { time: ordinal(1, 10, 0) },
    { time: ordinal(2, 20, 0) },
  ];
  const source = [{ time: 10, value: 7 }];

  const oldPoint = at(projectSourceTimedEntries(
    source,
    buildDisplaySourceTimeIndex(oldRows),
  ), 0);
  const newPoint = at(projectSourceTimedEntries(
    source,
    buildDisplaySourceTimeIndex(newRows),
  ), 0);

  assert.strictEqual(oldPoint.time, at(oldRows, 0).time);
  assert.strictEqual(newPoint.time, at(newRows, 1).time);
  assert.notStrictEqual(newPoint.time, oldPoint.time);
});

test("last display target lookup compares only the current and next exact source time", () => {
  const rows = derivedRows();

  assert.equal(isLastDisplayTargetForSourceTime(rows, 0), false);
  assert.equal(isLastDisplayTargetForSourceTime(rows, 1), true);
  assert.equal(isLastDisplayTargetForSourceTime(rows, 2), true);
  assert.equal(isLastDisplayTargetForSourceTime(rows, 3), true);
  assert.equal(isLastDisplayTargetForSourceTime([
    malformedFixture<DisplayRow>({ time: "10" }),
  ], 0), false);
  assert.equal(isLastDisplayTargetForSourceTime(rows, -1), false);
  assert.equal(isLastDisplayTargetForSourceTime(rows, rows.length), false);
  assert.equal(isLastDisplayTargetForSourceTime(rows, 1.5), false);
  assert.equal(isLastDisplayTargetForSourceTime(null, 0), false);
});
