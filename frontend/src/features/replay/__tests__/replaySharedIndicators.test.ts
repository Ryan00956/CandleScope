import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyIndicatorScriptUpdate,
  createActiveIndicatorPersistence,
} from "../../indicators/activeIndicatorStore.js";
import {
  buildIndicatorOhlcv,
  buildIndicatorOhlcvSignature,
} from "../../indicators/indicatorComputeRuntime.js";
import {
  filterIndicatorOutputStateByVisibility,
} from "../../indicators/indicatorOutputReducer.js";
import {
  createKlineOrderFlowProjectionMemo,
  resolveKlineOrderFlow,
} from "../../indicators/klineOrderFlowProjection.js";
import {
  clearProvidedBarsIndicatorRuntimeFields,
  clampProvidedBarsIndicatorOutput,
  prepareProvidedBarsIndicator,
  providedBarsIndicatorSupport,
} from "../../indicators/useProvidedBarsIndicatorRuntime.js";
import type {
  IndicatorOutputState,
} from "../../indicators/indicatorTypes.js";
import type {
  KlineBar,
} from "../../market-data/marketDataTypes.js";
import { MAX_SERIES_BARS } from "../../market-data/phase1WindowPolicy.js";
import {
  clearReplaySharedIndicatorPreferences,
  loadReplayOrderFlowPreferences,
  replayIndicatorStorageKey,
  replayOrderFlowStorageKey,
  saveReplayOrderFlowPreferences,
  selectRevealedIndicatorBars,
} from "../useReplaySharedIndicatorRuntime.js";
import { epochSeconds } from "../../../test/testHelpers.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(testDirectory, "../../../..");

function source(path: string): string {
  return readFileSync(resolve(frontendRoot, path), "utf8");
}

class SpyStorage {
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    this.reads.push(key);
    if (key === "candlescope-active-indicators") {
      throw new Error("replay attempted to read live indicator state");
    }
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes.push(key);
    if (key === "candlescope-active-indicators") {
      throw new Error("replay attempted to write live indicator state");
    }
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function bar(
  time: number,
  replayClosed: boolean | undefined,
): KlineBar {
  return {
    time: epochSeconds(time),
    open: time,
    high: time + 2,
    low: time - 2,
    close: time + 1,
    volume: 10,
    replayCloseTimeMs: time * 1_000 + 59_999,
    replayLastBaseOpenMs: time * 1_000,
    ...(replayClosed === undefined ? {} : { replayClosed }),
  };
}

test("replay indicator input rejects a forming bar before the revealed tail", () => {
  const rows = [
    bar(1_000, true),
    bar(1_060, false),
    bar(1_120, true),
    bar(940, undefined),
  ];
  const selected = selectRevealedIndicatorBars(rows, 1_120_000);
  assert.deepEqual(selected.map((item) => item.time), [1_000]);

  const ohlcv = buildIndicatorOhlcv(selected);
  assert.equal(ohlcv.length, 1);
  assert.equal(ohlcv[0]?.is_closed, true);
  assert.ok(ohlcv.every((item) => item.time * 1_000 <= 1_120_000));

  assert.deepEqual(selectRevealedIndicatorBars([{
    ...bar(1_000, true),
    is_closed: false,
  }], 1_120_000), []);
  assert.deepEqual(
    selectRevealedIndicatorBars([bar(1_000, undefined)], 1_120_000),
    [],
  );
});

test("replay indicator input includes one authoritative forming bar at the revealed tail", () => {
  const forming = {
    ...bar(1_060, false),
    replayCloseTimeMs: 1_179_999,
    replayLastBaseOpenMs: 1_120_000,
    is_closed: false,
  };
  const selected = selectRevealedIndicatorBars([
    { ...bar(1_000, true), is_closed: true },
    forming,
  ], 1_120_000);

  assert.deepEqual(selected.map((item) => item.time), [1_000, 1_060]);
  const ohlcv = buildIndicatorOhlcv(selected);
  assert.equal(ohlcv.at(-1)?.is_closed, false);

  assert.deepEqual(selectRevealedIndicatorBars([
    { ...forming, replayCloseTimeMs: 1_119_999 },
  ], 1_120_000), []);
  assert.deepEqual(selectRevealedIndicatorBars([
    { ...forming, replayLastBaseOpenMs: 1_120_001 },
  ], 1_120_000), []);
  assert.deepEqual(selectRevealedIndicatorBars([
    { ...forming, is_closed: true },
  ], 1_120_000), []);
});

test("replay indicator input resets at a chart history gap", () => {
  const selected = selectRevealedIndicatorBars([
    bar(1_000, true),
    bar(1_060, true),
    bar(1_180, true),
    bar(1_240, true),
  ], 1_300_000);

  assert.deepEqual(selected.map((item) => item.time), [1_180, 1_240]);
});

test("provided-bars policy forces local safe execution and rejects unknown runtimes", () => {
  const builtin = prepareProvidedBarsIndicator({
    id: "ma",
    name: "MA",
    engineName: "MA",
    kind: "builtin",
    lines: [{ data: [{ time: 99, value: 1 }] }],
    error: "stale",
  });
  assert.equal(builtin?.executionTarget, "local");
  assert.equal(builtin?.lines, undefined);
  assert.equal(builtin?.error, undefined);

  const pyne = prepareProvidedBarsIndicator({
    id: "custom-pyne",
    name: "Custom",
    kind: "script",
    language: "pyne",
    script: "plot(close)",
    securityMode: "unsafe",
  });
  assert.equal(pyne?.executionTarget, "local");
  assert.equal(pyne?.securityMode, "safe");

  const pine = prepareProvidedBarsIndicator({
    id: "custom-pine",
    name: "Pine",
    kind: "script",
    language: "pine",
    script: "indicator('x')\nplot(close)",
  });
  assert.equal(pine?.executionTarget, "local");
  assert.equal(pine?.language, "pine");
  assert.equal(pine?.securityMode, undefined);

  const unknown = {
    id: "community",
    name: "Community",
    kind: "script",
    language: "community-python",
    script: "plot(close)",
  };
  assert.equal(prepareProvidedBarsIndicator(unknown), null);
  assert.equal(providedBarsIndicatorSupport(unknown).supported, false);

  const switchedToPyne = applyIndicatorScriptUpdate(
    pine!,
    "plot(close)",
    "pyne",
    "unsafe",
    prepareProvidedBarsIndicator,
  );
  assert.equal(switchedToPyne.language, "pyne");
  assert.equal(switchedToPyne.securityMode, "safe");
  const rejectedUpdate = applyIndicatorScriptUpdate(
    switchedToPyne,
    "external_runtime(close)",
    "community-python",
    undefined,
    prepareProvidedBarsIndicator,
  );
  assert.equal(rejectedUpdate, switchedToPyne);

  const cleared = clearProvidedBarsIndicatorRuntimeFields({
    ...switchedToPyne,
    lines: [{ data: [{ time: epochSeconds(1_000), value: 99 }] }],
    error: "future-sensitive error",
    paramSchema: [{ key: "future", type: "int" }],
  });
  assert.deepEqual(cleared.lines, []);
  assert.equal(cleared.error, undefined);
  assert.equal(cleared.paramSchema, undefined);
});

test("replay indicator and order-flow preferences are run-scoped and never touch live storage", () => {
  const storage = new SpyStorage();
  const runAKey = replayIndicatorStorageKey("run-a");
  const runBKey = replayIndicatorStorageKey("run-b");
  storage.values.set(runAKey, JSON.stringify([{
    id: "ma",
    name: "MA",
    engineName: "MA",
    kind: "builtin",
    executionTarget: "local",
  }]));
  const runA = createActiveIndicatorPersistence(runAKey, storage);
  const runB = createActiveIndicatorPersistence(runBKey, storage);
  assert.deepEqual(runA.load().map((item) => item.id), ["ma"]);
  assert.deepEqual(runB.load(), []);
  runB.save([{ id: "rsi", name: "RSI" }]);

  saveReplayOrderFlowPreferences("run-a", {
    cvd: { added: true, visible: true },
    delta: { added: false, visible: true },
  }, storage);
  assert.equal(loadReplayOrderFlowPreferences("run-a", storage).cvd.added, true);
  assert.equal(loadReplayOrderFlowPreferences("run-b", storage).cvd.added, false);

  assert.ok(storage.reads.every((key) => key !== "candlescope-active-indicators"));
  assert.ok(storage.writes.every((key) => key !== "candlescope-active-indicators"));
  assert.notEqual(runAKey, runBKey);
  assert.notEqual(
    replayOrderFlowStorageKey("run-a"),
    replayOrderFlowStorageKey("run-b"),
  );
});

test("archive cleanup removes shared indicator scopes without touching live preferences", () => {
  const storage = new SpyStorage();
  storage.values.set("candlescope-active-indicators", "live");
  for (const scope of ["run-a", "session:adapter-a", "run-b"]) {
    storage.values.set(replayIndicatorStorageKey(scope), "indicators");
    storage.values.set(replayOrderFlowStorageKey(scope), "order-flow");
  }

  clearReplaySharedIndicatorPreferences(
    ["run-a", "session:adapter-a", "run-a"],
    storage,
  );

  for (const scope of ["run-a", "session:adapter-a"]) {
    assert.equal(storage.values.has(replayIndicatorStorageKey(scope)), false);
    assert.equal(storage.values.has(replayOrderFlowStorageKey(scope)), false);
  }
  assert.equal(storage.values.get(replayIndicatorStorageKey("run-b")), "indicators");
  assert.equal(storage.values.get(replayOrderFlowStorageKey("run-b")), "order-flow");
  assert.equal(storage.values.get("candlescope-active-indicators"), "live");
});

test("shared order-flow projection derives replay CVD and Delta from volume plus taker buy", () => {
  const replayBar: KlineBar = {
    ...bar(1_000, true),
    volume: 10,
    taker_buy_base: 6,
  };
  assert.deepEqual(resolveKlineOrderFlow(replayBar), {
    buy: 6,
    sell: 4,
    delta: 2,
    contribution: 2,
  });
  const panes = createKlineOrderFlowProjectionMemo().project({
    bars: [replayBar],
    enabled: true,
    forceFull: true,
    interval: "1m",
    intervalSeconds: 60,
  });
  assert.deepEqual(
    panes.find((pane) => pane.id === "trade-flow-cvd")
      ?.lines[0]?.data.map((point) => point.value),
    [2],
  );
  assert.deepEqual(
    panes.find((pane) => pane.id === "trade-flow-delta")
      ?.lines[0]?.data.map((point) => point.value),
    [2],
  );
});

test("provided-bars output clamps every render collection to the replay cursor", () => {
  const points = [
    { time: 10, value: 1 },
    { time: 30, value: 2 },
  ];
  const outputState: IndicatorOutputState = {
    markers: [{ id: "m", data: [{ time: 10 }, { time: 30 }] }],
    fills: [{ id: "f", data: [{ time: 10, endTime: 30 }, { time: 30 }] }],
    hlines: [
      { id: "constant", price: 50 },
      { id: "timed", data: [{ time: 30, value: 50 }] },
    ],
    bgcolors: [{
      id: "bg",
      regions: [{ time: 10, endTime: 30 }, { time: 30 }],
      data: [{ time: 30 }],
    }],
    barcolors: [{
      id: "bar",
      data: [{ time: 10, color: "#0f0" }, { time: 30, color: "#f00" }],
    }],
    signals: [{ id: "signal", data: [{ time: 10 }, { time: 30 }] }],
    paramSchemas: {},
  };
  const clamped = clampProvidedBarsIndicatorOutput({
    activeIndicators: [{
      id: "ma",
      visible: true,
      lines: [{
        id: "line",
        data: points,
        colorData: [
          { time: 10, color: "#0f0" },
          { time: 30, color: "#f00" },
        ],
      }],
    }],
    outputState,
    visibleThroughSeconds: 20,
  });

  assert.deepEqual(clamped.activeIndicators[0]?.lines?.[0]?.data, [points[0]]);
  assert.deepEqual(clamped.activeIndicators[0]?.lines?.[0]?.colorData, [{
    time: 10,
    color: "#0f0",
  }]);
  assert.deepEqual(clamped.outputState.markers[0]?.data, [{ time: 10 }]);
  assert.deepEqual(clamped.outputState.fills[0]?.data, [{
    time: 10,
    endTime: 20,
  }]);
  assert.equal(clamped.outputState.hlines[0]?.price, 50);
  assert.deepEqual(clamped.outputState.hlines[1]?.data, []);
  assert.deepEqual(clamped.outputState.bgcolors[0]?.regions, [{
    time: 10,
    endTime: 20,
  }]);
  assert.deepEqual(clamped.outputState.bgcolors[0]?.data, []);
  assert.deepEqual(clamped.outputState.barcolors[0]?.data, [{
    time: 10,
    color: "#0f0",
  }]);
  assert.deepEqual(clamped.outputState.signals[0]?.data, [{ time: 10 }]);

  const unavailable = clampProvidedBarsIndicatorOutput({
    activeIndicators: clamped.activeIndicators,
    outputState,
    visibleThroughSeconds: null,
  });
  assert.deepEqual(unavailable.activeIndicators[0]?.lines, []);
  assert.deepEqual(unavailable.outputState.hlines, []);
  assert.deepEqual(unavailable.outputState.markers, []);
});

test("auxiliary outputs follow indicator visibility without requiring recompute", () => {
  const state: IndicatorOutputState = {
    markers: [{ id: "m", indicatorId: "script", data: [{ time: 10 }] }],
    fills: [{ id: "f", indicatorId: "script" }],
    hlines: [{ id: "h", indicatorId: "script", price: 5 }],
    bgcolors: [{ id: "bg", indicatorId: "script" }],
    barcolors: [{ id: "bar", indicatorId: "script", data: [] }],
    signals: [{ id: "signal", indicatorId: "script", data: [] }],
    paramSchemas: {},
  };
  const hidden = filterIndicatorOutputStateByVisibility(state, [{
    id: "script",
    visible: false,
  }]);
  assert.equal(hidden.markers.length, 0);
  assert.equal(hidden.fills.length, 0);
  assert.equal(hidden.hlines.length, 0);
  assert.equal(hidden.bgcolors.length, 0);
  assert.equal(hidden.barcolors.length, 0);
  assert.equal(hidden.signals.length, 0);

  const visible = filterIndicatorOutputStateByVisibility(state, [{
    id: "script",
    visible: true,
  }]);
  assert.equal(visible.markers.length, 1);
  assert.equal(visible.hlines.length, 1);
});

test("provided-bars compute can cover the full bounded replay series window", () => {
  const rows = Array.from({ length: 2_501 }, (_, index) => ({
    ...bar(1_000 + index * 60, true),
  }));
  assert.equal(
    buildIndicatorOhlcv(rows, { limit: MAX_SERIES_BARS }).length,
    rows.length,
  );
  assert.notEqual(
    buildIndicatorOhlcvSignature(rows, { limit: MAX_SERIES_BARS }),
    buildIndicatorOhlcvSignature(rows.slice(1), { limit: MAX_SERIES_BARS }),
  );
});

test("v2 composition reuses the shared indicator product without hosted/cache reachability", () => {
  const composition = source("src/features/replay/ReplayApp.tsx");
  const workspace = source("src/features/replay/ReplayTrainingPageShell.tsx");
  const adapter = source("src/features/replay/useReplaySharedIndicatorRuntime.ts");
  const providedBars = source(
    "src/features/indicators/useProvidedBarsIndicatorRuntime.ts",
  );

  assert.match(composition, /useReplaySharedIndicatorRuntime/);
  assert.match(composition, /key=\{indicatorScope\}/);
  assert.match(workspace, /<IndicatorPanel/);
  assert.match(workspace, /allowedScriptLanguages=\{\["pyne", "pine"\]\}/);
  assert.doesNotMatch(workspace, /ReplayIndicatorPanel/);
  for (const prop of [
    "indicatorMarkers",
    "indicatorFills",
    "indicatorHlines",
    "indicatorBgcolors",
    "indicatorBarcolors",
  ]) {
    assert.match(workspace, new RegExp(`${prop}=\\{`));
  }
  assert.match(providedBars, /resultCacheMode:\s*"disabled"/);
  assert.match(providedBars, /historyLimit:\s*MAX_SERIES_BARS/);
  assert.match(providedBars, /pendingForceComputeRef\.current = true/);
  assert.match(
    source("src/features/indicators/indicatorComputeController.ts"),
    /resultCacheMode === "disabled"[\s\S]*flushSync\(publishAcceptedResults\)/,
  );
  assert.match(providedBars, /useIndicatorComputeController/);
  assert.match(providedBars, /indicatorOutputReducer/);
  assert.match(providedBars, /buildIndicatorPaneData/);
  assert.doesNotMatch(
    `${adapter}\n${providedBars}`,
    /computeIndicatorRangeBatch|useIndicatorStreamController|indicatorStreamController/,
  );
  assert.doesNotMatch(adapter, /candlescope-active-indicators/);
});
