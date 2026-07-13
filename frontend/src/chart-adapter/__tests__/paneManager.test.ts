import test from "node:test";
import assert from "node:assert/strict";
import {
  ensurePane,
  materializePaneLayout,
  readPaneHeights,
  removePaneSeries,
  setPaneHeights,
  trimPanes,
} from "../paneManager.js";
import { structuralMock } from "../../test/testHelpers.js";

type AdapterChart = NonNullable<Parameters<typeof ensurePane>[0]>;

function chartFixture(value: object): AdapterChart {
  return structuralMock<AdapterChart>(value);
}

function containerFixture(): HTMLElement {
  return structuralMock<HTMLElement>({ clientHeight: 720, clientWidth: 1280 });
}

interface FakePane {
  height: number;
  preserve: boolean | null;
  getHeight(): number;
  setHeight(nextHeight: number): void;
  setPreserveEmptyPane(nextPreserve: boolean): void;
}

function createFakePane(height = 100): FakePane {
  const preserve: boolean | null = null;
  return {
    height,
    preserve,
    getHeight() {
      return this.height;
    },
    setHeight(nextHeight: number) {
      this.height = nextHeight;
    },
    setPreserveEmptyPane(nextPreserve: boolean) {
      this.preserve = nextPreserve;
    },
  };
}

test("ensurePane creates missing panes and preserves empty panes", () => {
  const panes = [createFakePane()];
  const chart = chartFixture({
    panes: () => panes,
    addPane: (preserveEmptyPane: boolean) => {
      const pane = createFakePane();
      pane.preserve = preserveEmptyPane;
      panes.push(pane);
      return pane;
    },
  });

  const pane = ensurePane(chart, 2);

  assert.equal(panes.length, 3);
  assert.equal(pane, panes[2]);
  assert.equal(panes[2].preserve, true);
});

test("setPaneHeights and readPaneHeights round trip finite heights", () => {
  const panes = [createFakePane(50), createFakePane(60)];
  const chart = chartFixture({ panes: () => panes });

  setPaneHeights(chart, [120, Number.NaN, 180]);

  assert.deepEqual(readPaneHeights(chart), [120, 60]);
});

test("setPaneHeights restores multi-pane ratios without sequential height redistribution", () => {
  const panes = [0, 1, 2, 3].map((index) => ({
    factor: 1,
    heightCalls: 0,
    setHeight() {
      this.heightCalls += 1;
    },
    setStretchFactor(value: number) {
      this.factor = value;
    },
    getStretchFactor() {
      return this.factor;
    },
    index,
  }));
  const chart = chartFixture({ panes: () => panes });
  const saved = [480, 120, 100, 100];

  setPaneHeights(chart, saved);
  setPaneHeights(chart, saved);

  assert.deepEqual(panes.map((pane) => pane.factor), saved);
  assert.deepEqual(panes.map((pane) => pane.heightCalls), [0, 0, 0, 0]);
});

test("readPaneHeights rejects an incomplete vector instead of shifting pane indexes", () => {
  const chart = chartFixture({
    panes: () => [
      createFakePane(300),
      { getHeight: () => undefined },
      createFakePane(100),
    ],
  });

  assert.deepEqual(readPaneHeights(chart), []);
});

test("materializePaneLayout temporarily disables autoSize for one forced resize", () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const chart = chartFixture({
    applyOptions: (options: unknown) => { calls.push(["applyOptions", options]); },
    options: () => ({ autoSize: true }),
    resize: (...args: unknown[]) => { calls.push(["resize", ...args]); },
  });

  assert.equal(materializePaneLayout(chart, containerFixture()), true);
  assert.deepEqual(calls, [
    ["applyOptions", { autoSize: false, height: 720, width: 1280 }],
    ["resize", 1278, 720, true],
    ["resize", 1280, 720, true],
    ["applyOptions", { autoSize: true }],
  ]);
});

test("materializePaneLayout restores autoSize when the forced resize fails", () => {
  const options: unknown[] = [];
  const chart = chartFixture({
    applyOptions: (nextOptions: unknown) => { options.push(nextOptions); },
    options: () => ({ autoSize: true }),
    resize: () => { throw new Error("resize failed"); },
  });

  assert.equal(materializePaneLayout(chart, containerFixture()), false);
  assert.deepEqual(options, [
    { autoSize: false, height: 720, width: 1280 },
    { autoSize: true },
  ]);
});

test("materializePaneLayout can nudge height when flushing a viewport restore", () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const chart = chartFixture({
    applyOptions: (options: unknown) => { calls.push(["applyOptions", options]); },
    options: () => ({ autoSize: true }),
    resize: (...args: unknown[]) => { calls.push(["resize", ...args]); },
  });

  assert.equal(materializePaneLayout(
    chart,
    containerFixture(),
    { nudgeAxis: "height" },
  ), true);
  assert.deepEqual(calls, [
    ["applyOptions", { autoSize: false, height: 720, width: 1280 }],
    ["resize", 1280, 718, true],
    ["resize", 1280, 720, true],
    ["applyOptions", { autoSize: true }],
  ]);
});

test("removePaneSeries removes direct series and entry-wrapped series", () => {
  const removed: string[] = [];
  const seriesA = { id: "a" };
  const seriesB = { id: "b" };
  const chart = chartFixture({
    removeSeries: (series: { id: string }) => {
      removed.push(series.id);
    },
  });

  assert.equal(removePaneSeries(chart, [seriesA, { series: seriesB }, null]), 2);
  assert.deepEqual(removed, ["a", "b"]);
});

test("trimPanes removes auxiliary panes from right to left", () => {
  const removed: number[] = [];
  const chart = chartFixture({
    panes: () => [{}, {}, {}, {}],
    removePane: (index: number) => { removed.push(index); },
  });

  assert.equal(trimPanes(chart, 2), 2);
  assert.deepEqual(removed, [3, 2]);
});
