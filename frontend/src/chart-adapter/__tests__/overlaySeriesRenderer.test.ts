import assert from "node:assert/strict";
import test from "node:test";

import { renderFillSeries as renderFillSeriesProduction } from "../overlaySeriesRenderer.js";
import { structuralMock } from "../../test/testHelpers.js";

type RenderOptions = Parameters<typeof renderFillSeriesProduction>[0];
type AreaSeries = RenderOptions["fillSeriesRef"]["current"][number];

function renderFillSeries(value: object): void {
  renderFillSeriesProduction(structuralMock<RenderOptions>(value));
}

function fillPayload() {
  return {
    entries: [{
      backgroundColor: "#000",
      fillColor: "rgba(1,2,3,.2)",
      lowerData: [{ time: 1, value: 1 }],
      upperData: [{ time: 1, value: 2 }],
    }],
    matchedFillCount: 1,
    pointCount: 1,
    signature: "same-fill",
  };
}

test("fill series rebuild when a surviving pane moves to another index", () => {
  const addedPaneIndexes: number[] = [];
  const removed: AreaSeries[] = [];
  const chart = {
    addSeries: (_type: unknown, _options: unknown, paneIndex: number) => {
      const series = structuralMock<AreaSeries>({ setData() {} });
      addedPaneIndexes.push(paneIndex);
      return series;
    },
    removeSeries: (series: AreaSeries) => { removed.push(series); },
  };
  const fillSeriesRef: { current: AreaSeries[] } = { current: [] };
  const fillSeriesStateRef = {
    current: { chart: null, paneIndex: null, signature: "unknown" },
  };
  const common = {
    chart,
    definitionsCount: 1,
    fillPayload: fillPayload(),
    fillSeriesRef,
    fillSeriesStateRef,
    paneId: "survivor",
    recordPerfEvent() {},
  };

  renderFillSeries({ ...common, paneIndex: 2 });
  const firstPair = [...fillSeriesRef.current];
  renderFillSeries({ ...common, paneIndex: 1 });

  assert.deepEqual(addedPaneIndexes, [2, 2, 1, 1]);
  assert.deepEqual(removed, firstPair);
  assert.equal(fillSeriesStateRef.current.paneIndex, 1);
  assert.equal(fillSeriesRef.current.length, 2);
});
