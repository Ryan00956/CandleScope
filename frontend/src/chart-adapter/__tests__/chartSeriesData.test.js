import test from "node:test";
import assert from "node:assert/strict";
import {
  alignIndicatorBgcolorsToTimes,
  alignIndicatorLinesToTimes,
  alignIndicatorMarkersToTimes,
  buildFillRenderEntries,
} from "../chartSeriesData.js";

test("alignIndicatorLinesToTimes clips line and color data to the main bar time set", () => {
  const allowed = new Set([10, 20]);
  const [line] = alignIndicatorLinesToTimes([{
    id: "plot",
    type: "histogram",
    data: [
      { time: 10, value: 1 },
      { time: 15, value: 99 },
      { time: 20, value: 2 },
    ],
    colorData: [
      { time: 10, color: "red" },
      { time: 15, color: "blue" },
      { time: 20, color: "green" },
    ],
  }], allowed);

  assert.deepEqual(line.data, [
    { time: 10, value: 1, color: "red" },
    { time: 20, value: 2, color: "green" },
  ]);
  assert.deepEqual(line.colorData, [
    { time: 10, color: "red" },
    { time: 20, color: "green" },
  ]);
});

test("alignIndicatorMarkersToTimes and bgcolors clip payloads to the main bar time set", () => {
  const allowed = new Set([10]);

  assert.deepEqual(alignIndicatorMarkersToTimes([{ data: [{ time: 10 }, { time: 11 }] }], allowed), [
    { data: [{ time: 10 }] },
  ]);
  assert.deepEqual(alignIndicatorBgcolorsToTimes([{ data: [{ time: 10 }, { time: 11 }], regions: [{ time: 10 }, { time: 11 }] }], allowed), [
    { data: [{ time: 10 }], regions: [{ time: 10 }] },
  ]);
});

test("buildFillRenderEntries only uses shared clipped line times", () => {
  const payload = buildFillRenderEntries(
    [{ plot1_id: "upper", plot2_id: "lower", color: "rgba(1,2,3,0.5)" }],
    [
      { id: "upper", data: [{ time: 10, value: 3 }, { time: 20, value: 5 }] },
      { id: "lower", data: [{ time: 10, value: 1 }, { time: 30, value: 2 }] },
    ],
    "#000",
  );

  assert.equal(payload.matchedFillCount, 1);
  assert.deepEqual(payload.entries[0].upperData, [{ time: 10, value: 3 }]);
  assert.deepEqual(payload.entries[0].lowerData, [{ time: 10, value: 1 }]);
});
