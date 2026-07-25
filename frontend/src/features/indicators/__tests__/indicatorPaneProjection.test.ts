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
