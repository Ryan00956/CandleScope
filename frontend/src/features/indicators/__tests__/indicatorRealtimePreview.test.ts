import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRealtimeIndicatorValuesToLines,
  shouldRetainProvisionalIndicatorPreview,
} from "../indicatorRealtimePreview.js";
import { epochSeconds } from "../../../test/testHelpers.js";

const indicator = {
  id: "vol",
  engineName: "VOL",
  params: {},
};

const volumeLine = {
  id: "volume",
  outputName: "volume",
  pane: "volume",
  type: "histogram" as const,
  color: "#up",
  data: [
    { time: epochSeconds(100), value: 10 },
    { time: epochSeconds(200), value: 20 },
  ],
};

test("realtime VOL preview keeps its exact timestamp when the main K-line has a gap", () => {
  const lines = applyRealtimeIndicatorValuesToLines({
    bar: {
      time: epochSeconds(300),
      open: 10,
      high: 12,
      low: 9,
      close: 11,
      volume: 30,
    },
    barTime: 300,
    candleDownColor: "#down",
    candleUpColor: "#up",
    indicator,
    lines: [volumeLine],
    values: { volume: 30 },
  });

  assert.deepEqual(lines[0]?.data.map((point) => point.time), [100, 200, 300]);
  assert.equal(lines[0]?.data[2]?.value, 30);
  assert.equal(lines[0]?.data[2]?.color, "#up");
});

test("acknowledged first VOL preview can render before closed history supplies line metadata", () => {
  const lines = applyRealtimeIndicatorValuesToLines({
    bar: {
      time: epochSeconds(300),
      open: 12,
      high: 13,
      low: 11,
      close: 11,
      volume: 42,
    },
    barTime: 300,
    candleDownColor: "#down",
    candleUpColor: "#up",
    indicator,
    lines: [],
    values: { vol: 42 },
  });

  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.pane, "volume");
  assert.equal(lines[0]?.type, "histogram");
  assert.deepEqual(lines[0]?.data, [{
    time: epochSeconds(300),
    value: 42,
    color: "#down",
  }]);
});

test("delayed historical range keeps an uncovered forming preview but yields to final data", () => {
  const preview = {
    barTime: 300,
    values: { volume: 30 },
  };

  assert.equal(shouldRetainProvisionalIndicatorPreview(preview, [volumeLine], {
    dataRevision: { closedThrough: 200 },
  }), true);

  assert.equal(shouldRetainProvisionalIndicatorPreview(preview, [{
    ...volumeLine,
    data: [...volumeLine.data, { time: epochSeconds(300), value: 31 }],
  }], {
    dataRevision: { closedThrough: 300 },
  }), false);

  assert.equal(shouldRetainProvisionalIndicatorPreview(preview, [volumeLine], {
    dataRevision: { closedThrough: 300 },
  }), false);
});
