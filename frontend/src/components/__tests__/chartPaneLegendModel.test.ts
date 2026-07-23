import assert from "node:assert/strict";
import test from "node:test";

import {
  groupChartPaneLegendValues,
  resolveChartPaneLegendValues,
  shouldUseLatestChartPaneLegend,
} from "../chartPaneLegendModel.js";

test("future-time carrier points use the latest legend values", () => {
  assert.equal(shouldUseLatestChartPaneLegend(1_700_000_000, null, null), true);
  assert.equal(shouldUseLatestChartPaneLegend(1_700_000_000, { time: 1_700_000_000 }, null), false);
  assert.equal(shouldUseLatestChartPaneLegend(1_700_000_000, null, { time: 1_700_000_000 }), false);
  assert.equal(shouldUseLatestChartPaneLegend(null, { time: 1_700_000_000 }, null), true);
});

test("pane legend uses the newest finite value while the crosshair is inactive", () => {
  const values = resolveChartPaneLegendValues([{
    id: "volume",
    pane: "volume",
    data: [{ time: 10, value: 12 }, { time: 20, value: 34 }],
  }], null);

  assert.deepEqual(values, [{
    color: null,
    id: "volume",
    indicatorId: null,
    label: "volume",
    overlay: false,
    pane: "volume",
    type: null,
    value: 34,
    valueFormat: null,
  }]);
});

test("pane legend never falls back to a latest value for a missing historical point", () => {
  const values = resolveChartPaneLegendValues([{
    id: "macd",
    data: [{ time: 10, value: 1 }, { time: 30, value: 3 }],
  }], 20);

  assert.equal(values[0]?.value, null);
});

test("pane legend keeps one indicator's overlay outputs on one main-chart row", () => {
  const values = resolveChartPaneLegendValues([
    { id: "upper", indicatorId: "boll", pane: "main", data: [{ time: 20, value: 110 }] },
    { id: "middle", indicatorId: "boll", pane: "main", data: [{ time: 20, value: 100 }] },
    { id: "ema", indicatorId: "ema", pane: "main", data: [{ time: 20, value: 105 }] },
  ], 20);

  assert.deepEqual(values.map((value) => ({ id: value.id, value: value.value, overlay: value.overlay })), [
    { id: "upper", value: 110, overlay: true },
    { id: "middle", value: 100, overlay: true },
    { id: "ema", value: 105, overlay: true },
  ]);
  assert.deepEqual(groupChartPaneLegendValues(values).map((group) => ({
    id: group.id,
    lineIds: group.entries.map((entry) => entry.id),
  })), [
    { id: "indicator:boll", lineIds: ["upper", "middle"] },
    { id: "indicator:ema", lineIds: ["ema"] },
  ]);
});

test("pane legend preserves indicator display names after adapter alignment", () => {
  const values = resolveChartPaneLegendValues([{
    id: "basis",
    localId: "basis-local",
    outputName: "basis",
    title: "Basis",
    overlay: true,
    data: [{ time: 20, value: 100 }],
  }], 20);

  assert.deepEqual(values.map((value) => ({ id: value.id, label: value.label, overlay: value.overlay })), [
    { id: "basis", label: "Basis", overlay: true },
  ]);
});
