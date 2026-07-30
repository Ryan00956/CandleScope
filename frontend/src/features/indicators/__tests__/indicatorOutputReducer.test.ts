import assert from "node:assert/strict";
import test from "node:test";

import {
  createIndicatorOutputState,
  indicatorOutputReducer,
} from "../indicatorOutputReducer.js";
import type {
  IndicatorOutputAction,
  IndicatorOutputState,
} from "../indicatorTypes.js";
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

test("replay context reset can clear compute-derived schemas fail closed", () => {
  const state = structuralMock<IndicatorOutputState>({
    ...createIndicatorOutputState(),
    markers: [{ id: "future", indicatorId: "script" }],
    paramSchemas: { script: [{ name: "future-sensitive" }] },
  });
  const next = indicatorOutputReducer(state, {
    type: "reset-context",
    preserveParamSchemas: false,
  });
  assert.deepEqual(next.markers, []);
  assert.deepEqual(next.paramSchemas, {});
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

test("repeating the same cache hydration preserves state and lane references", () => {
  const marker = { id: "signal", indicatorId: "ma" };
  const hline = { id: "baseline", indicatorId: "rsi" };
  const maSchema = [{ name: "period" }];
  const entries = structuralMock<IndicatorOutputAction>({
    type: "hydrate-cache",
    entries: [
      {
        indicatorId: "ma",
        normalized: {
          lines: [],
          markers: [marker],
          fills: [],
          hlines: [],
          bgcolors: [],
          barcolors: [],
          signals: [],
        },
        schema: maSchema,
      },
      {
        indicatorId: "rsi",
        normalized: {
          lines: [],
          markers: [],
          fills: [],
          hlines: [hline],
          bgcolors: [],
          barcolors: [],
          signals: [],
        },
        schema: [],
      },
    ],
  });
  const initial = structuralMock<IndicatorOutputState>({
    ...createIndicatorOutputState(),
    paramSchemas: { existing: [{ name: "source" }] },
  });

  const hydrated = indicatorOutputReducer(initial, entries);
  const repeated = indicatorOutputReducer(hydrated, entries);

  assert.deepEqual(hydrated.markers, [marker]);
  assert.deepEqual(hydrated.hlines, [hline]);
  assert.deepEqual(hydrated.paramSchemas, {
    existing: [{ name: "source" }],
    ma: maSchema,
  });
  assert.strictEqual(repeated, hydrated);
  assert.strictEqual(repeated.markers, hydrated.markers);
  assert.strictEqual(repeated.fills, hydrated.fills);
  assert.strictEqual(repeated.hlines, hydrated.hlines);
  assert.strictEqual(repeated.bgcolors, hydrated.bgcolors);
  assert.strictEqual(repeated.barcolors, hydrated.barcolors);
  assert.strictEqual(repeated.signals, hydrated.signals);
  assert.strictEqual(repeated.paramSchemas, hydrated.paramSchemas);
});

test("cache hydration clears empty lanes and reuses lanes whose items did not change", () => {
  const marker = { id: "signal", indicatorId: "ma" };
  const initial = structuralMock<IndicatorOutputState>({
    ...createIndicatorOutputState(),
    markers: [marker],
    fills: [{ id: "old-fill", indicatorId: "ma" }],
    paramSchemas: { ma: [{ name: "period" }] },
  });
  const action = structuralMock<IndicatorOutputAction>({
    type: "hydrate-cache",
    entries: [{
      indicatorId: "ma",
      normalized: {
        lines: [],
        markers: [marker],
        fills: [],
        hlines: [],
        bgcolors: [],
        barcolors: [],
        signals: [],
      },
      schema: [],
    }],
  });

  const next = indicatorOutputReducer(initial, action);

  assert.strictEqual(next.markers, initial.markers);
  assert.deepEqual(next.fills, []);
  assert.notStrictEqual(next.fills, initial.fills);
  assert.strictEqual(next.hlines, initial.hlines);
  assert.strictEqual(next.paramSchemas, initial.paramSchemas);

  const cleared = indicatorOutputReducer(next, {
    type: "hydrate-cache",
    entries: [],
  });
  assert.deepEqual(cleared.markers, []);
  assert.strictEqual(cleared.fills, next.fills);
  assert.strictEqual(cleared.hlines, next.hlines);
  assert.strictEqual(cleared.paramSchemas, next.paramSchemas);
});

test("cache hydration keeps replacement ordering and last non-empty schema semantics", () => {
  const firstMaMarker = { id: "ma-first", indicatorId: "ma" };
  const rsiMarker = { id: "rsi", indicatorId: "rsi" };
  const lastMaMarker = { id: "ma-last", indicatorId: "ma" };
  const firstMaSchema = [{ name: "first-period" }];

  const next = indicatorOutputReducer(createIndicatorOutputState(), structuralMock({
    type: "hydrate-cache",
    entries: [
      {
        indicatorId: "ma",
        normalized: {
          lines: [], markers: [firstMaMarker], fills: [], hlines: [],
          bgcolors: [], barcolors: [], signals: [],
        },
        schema: firstMaSchema,
      },
      {
        indicatorId: "rsi",
        normalized: {
          lines: [], markers: [rsiMarker], fills: [], hlines: [],
          bgcolors: [], barcolors: [], signals: [],
        },
        schema: [],
      },
      {
        indicatorId: "ma",
        normalized: {
          lines: [], markers: [lastMaMarker], fills: [], hlines: [],
          bgcolors: [], barcolors: [], signals: [],
        },
        schema: [],
      },
    ],
  }));

  assert.deepEqual(next.markers, [rsiMarker, lastMaMarker]);
  assert.strictEqual(next.paramSchemas.ma, firstMaSchema);
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

test("failed compute ownership clears stale auxiliary trading outputs", () => {
  const unrelatedMarker = { id: "keep", indicatorId: "rsi" };
  const state = structuralMock<IndicatorOutputState>({
    ...createIndicatorOutputState(),
    markers: [unrelatedMarker, { id: "drop-marker", indicatorId: "ma" }],
    fills: [{ id: "drop-fill", indicatorId: "ma" }],
    signals: [{ id: "drop-signal", indicatorId: "ma", data: [] }],
  });

  const next = indicatorOutputReducer(state, {
    type: "compute-results",
    processedIds: ["ma"],
    markers: [],
    fills: [],
    hlines: [],
    bgcolors: [],
    barcolors: [],
    signals: [],
    paramSchemas: {},
  });

  assert.deepEqual(next.markers, [unrelatedMarker]);
  assert.deepEqual(next.fills, []);
  assert.deepEqual(next.signals, []);
});
