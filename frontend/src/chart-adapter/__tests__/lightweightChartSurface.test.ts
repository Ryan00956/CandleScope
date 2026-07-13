import assert from "node:assert/strict";
import test from "node:test";

import { buildOrdinalChartOptions } from "../lightweightChartSurface.js";
import type { OrdinalAxisTime } from "../../features/chart-representation/chartRepresentationTypes.js";
import { structuralMock } from "../../test/testHelpers.js";

test("ordinal chart options format labels with source time", () => {
  const seen: Array<[string, unknown, unknown?]> = [];
  const options = buildOrdinalChartOptions({
    localization: {
      timeFormatter: (time: number) => {
        seen.push(["time", time]);
        return `time:${time}`;
      },
    },
    timeScale: {
      tickMarkFormatter: (time: number, weight: number) => {
        seen.push(["tick", time, weight]);
        return `tick:${time}`;
      },
    },
  });
  const formatted = structuralMock<{
    localization: { timeFormatter: (time: OrdinalAxisTime) => string };
    timeScale: { tickMarkFormatter: (time: OrdinalAxisTime, weight: number) => string };
  }>(options);

  const ordinal = { order: 3, sourceTime: 123, sourceOrdinal: 1 };
  assert.equal(formatted.localization.timeFormatter(ordinal), "time:123");
  assert.equal(formatted.timeScale.tickMarkFormatter(ordinal, 4), "tick:123");
  assert.deepEqual(seen, [["time", 123], ["tick", 123, 4]]);
});
