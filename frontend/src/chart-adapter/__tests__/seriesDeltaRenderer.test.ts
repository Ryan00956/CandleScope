import assert from "node:assert/strict";
import test from "node:test";

import {
  renderCandleDataTransition,
  renderSeriesDelta as renderProductionSeriesDelta,
} from "../seriesDeltaRenderer.js";
import { ViewportController } from "../viewportController.js";
import type { ViewportControllerOptions } from "../viewportController.js";
import type { WindowDelta } from "../../features/market-data/klineContracts.js";
import type { KlineBar } from "../../features/market-data/marketDataTypes.js";
import type {
  DeltaViewportController,
  SeriesDataWriter,
  SeriesWindowReader,
} from "../chartAdapterTypes.js";
import { structuralMock } from "../../test/testHelpers.js";

type TestBar = Omit<KlineBar, "time"> & { time: number };
type TestDelta = Omit<Partial<WindowDelta>, "bar"> & {
  type: WindowDelta["type"];
  bar?: TestBar;
};
type ProductionRenderOptions = NonNullable<
  Parameters<typeof renderProductionSeriesDelta<TestBar>>[0]
>;
type TestRenderOptions = Omit<
  ProductionRenderOptions,
  "delta" | "previousRows" | "series" | "snapshot" | "store" | "viewportController"
> & {
  delta?: TestDelta | null;
  previousRows?: TestBar[] | null;
  series?: Partial<SeriesDataWriter<TestBar>> | null;
  snapshot?: TestBar[] | null;
  store?: Partial<SeriesWindowReader<TestBar>> | null;
  viewportController?: Partial<DeltaViewportController<TestBar>> | ViewportController | null;
};

function renderSeriesDelta(options: TestRenderOptions = {}) {
  return renderProductionSeriesDelta<TestBar>(
    structuralMock<ProductionRenderOptions>(options),
  );
}

function createSeries(): { calls: unknown[]; series: SeriesDataWriter<TestBar> } {
  const calls: unknown[] = [];
  return {
    calls,
    series: {
      update: (bar) => { calls.push(["update", bar]); },
      setData: (data) => { calls.push(["setData", data]); },
    },
  };
}

test("renderSeriesDelta updates ticks directly", () => {
  const { series, calls } = createSeries();

  const result = renderSeriesDelta({
    series,
    delta: { type: "tick", bar: { time: 10, close: 1 }, bars: 1 },
  });

  assert.equal(result, "update");
  assert.deepEqual(calls, [["update", { time: 10, close: 1 }]]);
});

test("renderSeriesDelta appends only added right rows", () => {
  const { series, calls } = createSeries();

  renderSeriesDelta({
    series,
    delta: { type: "append", addedRight: 2 },
    snapshot: [{ time: 10 }, { time: 20 }, { time: 30 }],
  });

  assert.deepEqual(calls, [["update", { time: 20 }], ["update", { time: 30 }]]);
});

test("renderSeriesDelta leaves count fallback unused for prepend", () => {
  const { series, calls } = createSeries();
  const compensated: number[] = [];

  renderSeriesDelta({
    series,
    delta: { type: "prepend", addedLeft: 3 },
    snapshot: [{ time: 1 }, { time: 2 }],
    viewportController: {
      compensateInsert: (bars: number) => { compensated.push(bars); return true; },
    },
  });

  assert.deepEqual(calls, [["setData", [{ time: 1 }, { time: 2 }]]]);
  assert.deepEqual(compensated, []);
});

test("renderSeriesDelta uses net shift when prepend hits the trim budget", () => {
  const { series, calls } = createSeries();
  const compensated: number[] = [];

  renderSeriesDelta({
    series,
    delta: { type: "prepend", addedLeft: 500, trimmedLeft: 500 },
    snapshot: [{ time: 1 }, { time: 2 }],
    viewportController: {
      compensateInsert: (bars: number) => { compensated.push(bars); return true; },
    },
  });

  assert.deepEqual(calls, [["setData", [{ time: 1 }, { time: 2 }]]]);
  assert.deepEqual(compensated, []);
});

test("renderSeriesDelta escalates trimming ticks without count fallback", () => {
  const { series, calls } = createSeries();
  const compensated: number[] = [];

  renderSeriesDelta({
    series,
    delta: { type: "tick", bar: { time: 30 }, appended: true, trimmedLeft: 1 },
    snapshot: [{ time: 20 }, { time: 30 }],
    viewportController: {
      compensateInsert: (bars: number) => { compensated.push(bars); return true; },
    },
  });

  assert.deepEqual(calls, [["setData", [{ time: 20 }, { time: 30 }]]]);
  assert.deepEqual(compensated, []);
});

test("renderSeriesDelta prefers anchor-based compensation when possible", () => {
  const { series, calls } = createSeries();
  const shifts: number[] = [];
  const viewportController: Partial<DeltaViewportController<TestBar>> = {
    captureAnchor: (previousRows) => previousRows?.[0]
      ? { time: previousRows[0].time, index: 0, screenOffset: 0 }
      : null,
    applyAnchorShift: (anchor, indexOfTime) => {
      shifts.push(indexOfTime(anchor.time) - anchor.index);
      return true;
    },
    compensateInsert: () => {
      throw new Error("fallback compensation must not run when anchor applies");
    },
  };

  renderSeriesDelta({
    series,
    delta: { type: "mid-merge", addedLeft: 0 },
    snapshot: [{ time: 5 }, { time: 10 }, { time: 20 }],
    previousRows: [{ time: 10 }, { time: 20 }],
    viewportController,
  });

  assert.deepEqual(calls, [["setData", [{ time: 5 }, { time: 10 }, { time: 20 }]]]);
  assert.deepEqual(shifts, [1]);
});

interface TestLogicalRange {
  from: number;
  to: number;
}

interface HighFidelityHarnessOptions {
  initialRange: TestLogicalRange;
  onSetData?: (timeScale: TestTimeScale, rows: TestBar[]) => void;
}

interface TestTimeScale {
  range: TestLogicalRange;
  getVisibleLogicalRange(): TestLogicalRange;
  setVisibleLogicalRange(range: TestLogicalRange): void;
}

function createHighFidelityViewportHarness({
  initialRange,
  onSetData,
}: HighFidelityHarnessOptions) {
  const events: unknown[] = [];
  let unlock: (() => void) | null = null;
  const timeScale = {
    range: { ...initialRange },
    getVisibleLogicalRange: () => timeScale.range,
    setVisibleLogicalRange: (range: TestLogicalRange) => {
      timeScale.range = range;
      events.push(["setVisibleLogicalRange", range]);
    },
  };
  const controller = new ViewportController(structuralMock<ViewportControllerOptions>({
    chartProvider: () => ({ timeScale: () => timeScale }),
    setTimer: (fn: () => void) => {
      unlock = fn;
      return 1;
    },
    clearTimer: () => {},
  }));
  const series: SeriesDataWriter<TestBar> = {
    setData: (rows) => {
      events.push(["setData", rows.map((row) => row.time)]);
      onSetData?.(timeScale, rows);
    },
    update: (row) => { events.push(["update", row]); },
  };
  return {
    controller,
    events,
    series,
    timeScale,
    unlock: () => unlock?.(),
  };
}

test("prepend keeps the LWC auto-rebased viewport without double compensation", () => {
  const previousRows = [100, 110, 120, 130, 140, 150, 160, 170]
    .map((time) => ({ time }));
  const nextRows = [70, 80, 90, ...previousRows.map((row) => row.time)]
    .map((time) => ({ time }));
  const harness = createHighFidelityViewportHarness({
    initialRange: { from: 2.25, to: 6.25 },
    onSetData: (timeScale) => {
      // This mirrors Lightweight Charts: prepending three points rebases the
      // logical viewport by +3 before our residual compensation runs.
      timeScale.range = { from: 5.25, to: 9.25 };
    },
  });
  const store = {
    indexOfTime: (time: number) => nextRows.findIndex((row) => row.time === time),
    snapshot: () => nextRows,
  };

  harness.controller.markUserInteracting();
  renderSeriesDelta({
    series: harness.series,
    delta: { type: "prepend", addedLeft: 3 },
    store,
    previousRows,
    viewportController: harness.controller,
  });

  assert.deepEqual(harness.events, [["setData", nextRows.map((row) => row.time)]]);
  assert.deepEqual(harness.timeScale.range, { from: 5.25, to: 9.25 });

  harness.unlock();
  assert.deepEqual(harness.events, [["setData", nextRows.map((row) => row.time)]]);
});

test("mid-merge applies only the residual shift synchronously while locked", () => {
  const previousRows = [100, 200, 400, 500].map((time) => ({ time }));
  const nextRows = [100, 150, 200, 300, 400, 500].map((time) => ({ time }));
  const harness = createHighFidelityViewportHarness({
    initialRange: { from: 1.25, to: 3.25 },
  });
  const store = {
    indexOfTime: (time: number) => nextRows.findIndex((row) => row.time === time),
    snapshot: () => nextRows,
  };

  harness.controller.markUserInteracting();
  renderSeriesDelta({
    series: harness.series,
    delta: { type: "mid-merge", addedLeft: 0 },
    store,
    previousRows,
    viewportController: harness.controller,
  });

  assert.deepEqual(harness.events, [
    ["setData", nextRows.map((row) => row.time)],
    ["setVisibleLogicalRange", { from: 2.25, to: 4.25 }],
  ]);

  harness.unlock();
  assert.equal(harness.events.length, 2);
});

test("renderCandleDataTransition uses trailing updates when possible", () => {
  const { series, calls } = createSeries();

  const result = renderCandleDataTransition({
    series,
    previousData: [{ time: 10, close: 1 }, { time: 20, close: 2 }],
    nextData: [{ time: 10, close: 1 }, { time: 20, close: 3 }, { time: 30, close: 4 }],
  });

  assert.equal(result, "update");
  assert.deepEqual(calls, [["update", { time: 20, close: 3 }], ["update", { time: 30, close: 4 }]]);
});
