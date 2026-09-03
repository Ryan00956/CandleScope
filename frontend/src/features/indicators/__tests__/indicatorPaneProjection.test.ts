import assert from "node:assert/strict";
import test from "node:test";
import { buildIndicatorPaneData } from "../indicatorPaneProjection.js";

const hiddenIndicator = {
  id: "pine-1",
  name: "Hidden Pine output",
  visible: true,
  lines: [{
    id: "pine-plot-0",
    pane: "separate",
    type: "line",
    visible: false,
    data: [{ time: 10, value: 42 }],
  }],
};

test("restored indicators without a visible flag use the visible default", () => {
  const indicator = { id: "restored", name: "MA", lines: [{ id: "ma", pane: "separate", type: "line", data: [{ time: 10, value: 42 }] }] };
  assert.equal(buildIndicatorPaneData([indicator]).subPanes.length, 1);
  assert.equal(buildIndicatorPaneData([{ ...indicator, visible: false }]).subPanes.length, 0);
});

test("hidden-only separate output does not materialize an empty pane", () => {
  const projected = buildIndicatorPaneData([hiddenIndicator]);

  assert.deepEqual(projected.subPanes, []);
  assert.deepEqual(projected.mainOverlayLines, []);
});

test("visible pane annotations retain hidden series as renderer inputs", () => {
  const projected = buildIndicatorPaneData([hiddenIndicator], {
    hlines: [{
      indicatorId: "pine-1",
      pane: "separate",
      price: 50,
    }],
  });

  assert.equal(projected.subPanes.length, 1);
  assert.equal(projected.subPanes[0]?.id, "separate-pine-1");
  assert.equal(projected.subPanes[0]?.lines[0]?.visible, false);
});

test("marker-only separate output materializes a placeholder-backed pane", () => {
  const projected = buildIndicatorPaneData([{
    id: "pine-marker-only",
    name: "Marker only",
    visible: true,
    lines: [],
  }], {
    markers: [{
      indicatorId: "pine-marker-only",
      pane: "separate",
      data: [{ time: 10, value: 42 }],
    }],
  });

  assert.equal(projected.subPanes.length, 1);
  assert.equal(projected.subPanes[0]?.id, "separate-pine-marker-only");
  assert.deepEqual(projected.subPanes[0]?.lines, []);
});

test("hline-only separate output materializes a placeholder-backed pane", () => {
  const projected = buildIndicatorPaneData([{
    id: "pine-hline-only",
    name: "Hline only",
    visible: true,
  }], {
    hlines: [{
      indicatorId: "pine-hline-only",
      pane: "separate",
      price: 50,
    }],
  });

  assert.equal(projected.subPanes.length, 1);
  assert.equal(projected.subPanes[0]?.id, "separate-pine-hline-only");
  assert.deepEqual(projected.subPanes[0]?.lines, []);
});
