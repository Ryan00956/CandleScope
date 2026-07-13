import assert from "node:assert/strict";
import test from "node:test";

import {
  CHART_DRAWING_ANCHOR_MODES,
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
    "point-and-figure",
    "kagi",
    "line-break",
  ]);
  for (const descriptor of DEFAULT_CHART_TYPE_DESCRIPTORS.filter((item) => item.axisMode === "time")) {
    assert.equal(descriptor.axisMode, "time");
    assert.equal(descriptor.drawingAnchorMode, CHART_DRAWING_ANCHOR_MODES.SOURCE_TIME);
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
    drawingAnchorMode: "source-lineage",
  });
  assert.deepEqual(getChartTypeDescriptor("point-and-figure"), {
    id: "point-and-figure",
    axisMode: "derived-ordinal",
    projectionId: "point-and-figure",
    rendererId: "point-and-figure",
    drawingAnchorMode: "source-lineage",
  });
  assert.deepEqual(getChartTypeDescriptor("kagi"), {
    id: "kagi",
    axisMode: "derived-ordinal",
    projectionId: "kagi",
    rendererId: "kagi",
    drawingAnchorMode: "source-lineage",
  });
  assert.deepEqual(getChartTypeDescriptor("line-break"), {
    id: "line-break",
    axisMode: "derived-ordinal",
    projectionId: "line-break",
    rendererId: "candlestick",
    drawingAnchorMode: "source-lineage",
  });
  assert.equal(getChartTypeDescriptor("unknown").id, "candlestick");
});

test("registry validates descriptors and supports explicit replacement", () => {
  const registry = new ChartTypeRegistry();
  registry.register({ id: "renko", axisMode: "derived-ordinal", projectionId: "renko", rendererId: "renko" });

  assert.equal(registry.require("renko").axisMode, "derived-ordinal");
  assert.equal(registry.require("renko").drawingAnchorMode, null);
  assert.throws(() => registry.register({ id: "renko", axisMode: "time", projectionId: "identity", rendererId: "line" }));
  registry.register({ id: "renko", axisMode: "derived-ordinal", projectionId: "renko-v2", rendererId: "renko" }, { replace: true });
  assert.equal(registry.require("renko").projectionId, "renko-v2");
  assert.throws(() => registry.register({
    id: "invalid-drawing-mode",
    axisMode: "time",
    projectionId: "identity",
    rendererId: "line",
    drawingAnchorMode: "projection-order",
  }));
});
