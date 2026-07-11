import assert from "node:assert/strict";
import test from "node:test";

import {
  ChartTypeRegistry,
  DEFAULT_CHART_TYPE_DESCRIPTORS,
  getChartTypeDescriptor,
} from "../chartTypeRegistry.js";

test("default registry describes every currently supported main chart type", () => {
  assert.deepEqual(DEFAULT_CHART_TYPE_DESCRIPTORS.map((item) => item.id), [
    "candlestick",
    "hollow-candlestick",
    "heikin-ashi",
    "bar",
    "high-low",
    "line",
    "line-with-markers",
    "step-line",
    "area",
    "baseline",
    "histogram",
    "renko",
  ]);
  for (const descriptor of DEFAULT_CHART_TYPE_DESCRIPTORS.filter((item) => item.id !== "renko")) {
    assert.equal(descriptor.axisMode, "time");
    assert.ok(descriptor.projectionId);
    assert.ok(descriptor.rendererId);
  }
  assert.equal(getChartTypeDescriptor("heikin-ashi").projectionId, "heikin-ashi");
  assert.equal(getChartTypeDescriptor("high-low").rendererId, "high-low");
  assert.deepEqual(getChartTypeDescriptor("renko"), {
    id: "renko",
    axisMode: "derived-ordinal",
    projectionId: "renko",
    rendererId: "candlestick",
  });
  assert.equal(getChartTypeDescriptor("unknown").id, "candlestick");
});

test("registry validates descriptors and supports explicit replacement", () => {
  const registry = new ChartTypeRegistry();
  registry.register({ id: "renko", axisMode: "derived-ordinal", projectionId: "renko", rendererId: "renko" });

  assert.equal(registry.require("renko").axisMode, "derived-ordinal");
  assert.throws(() => registry.register({ id: "renko", axisMode: "time", projectionId: "identity", rendererId: "line" }));
  registry.register({ id: "renko", axisMode: "derived-ordinal", projectionId: "renko-v2", rendererId: "renko" }, { replace: true });
  assert.equal(registry.require("renko").projectionId, "renko-v2");
});
