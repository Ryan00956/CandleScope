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

test("snapshot preserves untouched output lane references", () => {
  const state = createIndicatorOutputState();
  const next = indicatorOutputReducer(state, structuralMock({
    type: "snapshot",
    indicatorId: "vol",
    normalized: {
      markers: [],
      fills: [],
      hlines: [{ id: "baseline", indicatorId: "vol" }],
      bgcolors: [],
      barcolors: [],
      signals: [],
    },
  }));

  assert.notStrictEqual(next, state);
  assert.notStrictEqual(next.hlines, state.hlines);
  assert.strictEqual(next.markers, state.markers);
  assert.strictEqual(next.fills, state.fills);
  assert.strictEqual(next.bgcolors, state.bgcolors);
  assert.strictEqual(next.barcolors, state.barcolors);
  assert.strictEqual(next.signals, state.signals);
});

test("semantically empty snapshot is a reducer no-op", () => {
  const state = createIndicatorOutputState();
  const next = indicatorOutputReducer(state, structuralMock({
    type: "snapshot",
    indicatorId: "vol",
    normalized: {
      markers: [],
      fills: [],
      hlines: [],
      bgcolors: [],
      barcolors: [],
      signals: [],
    },
  }));

  assert.strictEqual(next, state);
});

test("marker patches dedupe only within the same indicator", () => {
  const rsiMarker = {
    id: "signal",
    indicatorId: "rsi",
    text: "rsi",
  };
  const maMarker = {
    id: "signal",
    indicatorId: "ma",
    text: "ma-before",
    previousOnly: true,
  };
  const state = structuralMock<IndicatorOutputState>({
    ...createIndicatorOutputState(),
    markers: [rsiMarker, maMarker],
  });

  const next = indicatorOutputReducer(state, structuralMock({
    type: "patch",
    indicatorId: "ma",
    normalized: {
      lines: [],
      markers: [{
        id: "signal",
        indicatorId: "ma",
        text: "ma-after",
        patchOnly: true,
      }],
      fills: [],
      hlines: [],
      bgcolors: [],
      barcolors: [],
      signals: [],
    },
  }));

  assert.equal(next.markers.length, 2);
  assert.strictEqual(next.markers[0], rsiMarker);
  assert.deepEqual(next.markers[1], {
    id: "signal",
    indicatorId: "ma",
    text: "ma-after",
    previousOnly: true,
    patchOnly: true,
  });
  assert.deepEqual(state.markers, [rsiMarker, maMarker]);
});

test("removing an absent indicator preserves the entire state reference", () => {
  const state = structuralMock<IndicatorOutputState>({
    ...createIndicatorOutputState(),
    markers: [{ id: "signal", indicatorId: "rsi" }],
    paramSchemas: { rsi: [{ name: "period" }] },
  });

  const next = indicatorOutputReducer(state, {
    type: "remove-indicator",
    indicatorId: "missing",
  });

  assert.strictEqual(next, state);
  assert.strictEqual(next.markers, state.markers);
  assert.strictEqual(next.paramSchemas, state.paramSchemas);
});
