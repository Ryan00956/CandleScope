import assert from "node:assert/strict";
import test from "node:test";

import { buildOrdinalChartOptions } from "../lightweightChartSurface.js";

test("ordinal chart options format labels with source time", () => {
  const seen = [];
  const options = buildOrdinalChartOptions({
    localization: {
      timeFormatter: (time) => {
        seen.push(["time", time]);
        return `time:${time}`;
      },
    },
    timeScale: {
      tickMarkFormatter: (time, weight) => {
        seen.push(["tick", time, weight]);
        return `tick:${time}`;
      },
    },
  });

  const ordinal = { order: 3, sourceTime: 123, sourceOrdinal: 1 };
  assert.equal(options.localization.timeFormatter(ordinal), "time:123");
  assert.equal(options.timeScale.tickMarkFormatter(ordinal, 4), "tick:123");
  assert.deepEqual(seen, [["time", 123], ["tick", 123, 4]]);
});
