import assert from "node:assert/strict";
import test from "node:test";

import {
  createIndicatorOutputState,
  indicatorOutputReducer,
} from "../indicatorOutputReducer.js";
import type { IndicatorOutputState } from "../indicatorTypes.js";
import { structuralMock } from "../../../test/testHelpers.js";

test("remove-indicator clears global outputs and param schema for one indicator", () => {
  const state = {
    ...createIndicatorOutputState(),
    markers: [
      { id: "a", indicatorId: "ma" },
      { id: "b", indicatorId: "rsi" },
    ],
    hlines: [
      { id: "h", indicatorId: "ma" },
    ],
    paramSchemas: {
      ma: [{ name: "period" }],
      rsi: [{ name: "period" }],
    },
  };

  const next = indicatorOutputReducer(structuralMock<IndicatorOutputState>(state), {
    type: "remove-indicator",
    indicatorId: "ma",
  });

  assert.deepEqual(next.markers, [{ id: "b", indicatorId: "rsi" }]);
  assert.deepEqual(next.hlines, []);
  assert.deepEqual(next.paramSchemas, { rsi: [{ name: "period" }] });
});
