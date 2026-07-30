import assert from "node:assert/strict";
import test from "node:test";
import { PluginChartLayerPrimitive } from "../pluginChartLayerRenderer.js";
import type { PluginChartRenderEntry } from "../../features/plugins/pluginChartLayerSource.js";

const entries: PluginChartRenderEntry[] = [
  {
    id: "path",
    zOrder: "above-series",
    item: {
      id: "path",
      type: "polyline",
      points: [{ time: 100, price: 10 }, { time: 200, price: 14 }],
      color: "#3B82F6",
      width: 2,
      style: "solid",
    },
  },
  {
    id: "target",
    zOrder: "below-series",
    item: {
      id: "target",
      type: "band",
      startTime: 200,
      endTime: 400,
      lowerPrice: 15,
      upperPrice: 18,
      fillColor: "#22C55E22",
    },
  },
];

test("plugin chart primitives isolate z-order and contribute bounded autoscale ranges", () => {
  const above = new PluginChartLayerPrimitive("above-series");
  const below = new PluginChartLayerPrimitive("below-series");
  above.setEntries(entries);
  below.setEntries(entries);

  assert.deepEqual(above.autoscaleInfo(), {
    priceRange: { minValue: 10, maxValue: 14 },
  });
  assert.deepEqual(below.autoscaleInfo(), {
    priceRange: { minValue: 15, maxValue: 18 },
  });
  assert.equal(above.paneViews()[0]?.zOrder?.(), "top");
  assert.equal(below.paneViews()[0]?.zOrder?.(), "bottom");
});

test("autoscale handles the aggregate chart-layer/2 point budget without argument spreading", () => {
  const primitive = new PluginChartLayerPrimitive("above-series");
  primitive.setEntries(Array.from({ length: 10 }, (_, seriesIndex) => ({
    id: `large-path-${seriesIndex}`,
    zOrder: "above-series",
    item: {
      id: `large-path-${seriesIndex}`,
      type: "polyline",
      points: Array.from({ length: 10_000 }, (_, index) => ({
        time: index + 1,
        price: seriesIndex * 10_000 + index - 50_000,
      })),
      color: "#3B82F6",
      width: 2,
      style: "solid",
    },
  })));

  assert.deepEqual(primitive.autoscaleInfo(), {
    priceRange: { minValue: -50_000, maxValue: 49_999 },
  });
});
