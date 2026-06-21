import assert from "node:assert/strict";
import test from "node:test";

import {
  replaceIndicatorItemsRange,
  replaceIndicatorLinesRange,
} from "../indicatorPayloadRuntime.js";

test("replaceIndicatorLinesRange replaces only the target time window", () => {
  const lines = replaceIndicatorLinesRange(
    [{
      outputName: "ma",
      data: [
        { time: 10, value: 1 },
        { time: 20, value: 2 },
        { time: 30, value: 3 },
        { time: 40, value: 4 },
      ],
      colorData: [
        { time: 10, color: "#111" },
        { time: 20, color: "#222" },
        { time: 30, color: "#333" },
        { time: 40, color: "#444" },
      ],
    }],
    [{
      outputName: "ma",
      data: [{ time: 20, value: 200 }],
      colorData: [{ time: 20, color: "#abc" }],
    }],
    { start: 20, end: 30 },
  );

  assert.deepEqual(lines[0].data, [
    { time: 10, value: 1 },
    { time: 20, value: 200 },
    { time: 40, value: 4 },
  ]);
  assert.deepEqual(lines[0].colorData, [
    { time: 10, color: "#111" },
    { time: 20, color: "#abc" },
    { time: 40, color: "#444" },
  ]);
});

test("replaceIndicatorItemsRange deletes stale timed items inside the target window", () => {
  const markers = replaceIndicatorItemsRange(
    [{
      id: "marker",
      indicatorId: "ma-1",
      data: [
        { time: 10, text: "keep-left" },
        { time: 20, text: "drop" },
        { time: 30, text: "drop-too" },
        { time: 40, text: "keep-right" },
      ],
    }],
    [{
      id: "marker",
      indicatorId: "ma-1",
      data: [{ time: 30, text: "new" }],
    }],
    { start: 20, end: 30 },
  );

  assert.deepEqual(markers[0].data, [
    { time: 10, text: "keep-left" },
    { time: 30, text: "new" },
    { time: 40, text: "keep-right" },
  ]);
});
