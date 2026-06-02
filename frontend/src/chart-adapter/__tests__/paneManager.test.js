import test from "node:test";
import assert from "node:assert/strict";
import { ensurePane, readPaneHeights, removePaneSeries, setPaneHeights } from "../paneManager.js";

function createFakePane(height = 100) {
  return {
    height,
    preserve: null,
    getHeight() {
      return this.height;
    },
    setHeight(nextHeight) {
      this.height = nextHeight;
    },
    setPreserveEmptyPane(nextPreserve) {
      this.preserve = nextPreserve;
    },
  };
}

test("ensurePane creates missing panes and preserves empty panes", () => {
  const panes = [createFakePane()];
  const chart = {
    panes: () => panes,
    addPane: (preserveEmptyPane) => {
      const pane = createFakePane();
      pane.preserve = preserveEmptyPane;
      panes.push(pane);
      return pane;
    },
  };

  const pane = ensurePane(chart, 2);

  assert.equal(panes.length, 3);
  assert.equal(pane, panes[2]);
  assert.equal(pane.preserve, true);
});

test("setPaneHeights and readPaneHeights round trip finite heights", () => {
  const panes = [createFakePane(50), createFakePane(60)];
  const chart = { panes: () => panes };

  setPaneHeights(chart, [120, Number.NaN, 180]);

  assert.deepEqual(readPaneHeights(chart), [120, 60]);
});

test("removePaneSeries removes direct series and entry-wrapped series", () => {
  const removed = [];
  const seriesA = { id: "a" };
  const seriesB = { id: "b" };
  const chart = {
    removeSeries: (series) => {
      removed.push(series.id);
    },
  };

  assert.equal(removePaneSeries(chart, [seriesA, { series: seriesB }, null]), 2);
  assert.deepEqual(removed, ["a", "b"]);
});
