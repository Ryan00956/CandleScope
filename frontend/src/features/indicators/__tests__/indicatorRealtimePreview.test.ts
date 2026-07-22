import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRealtimeIndicatorValuesToLines,
  currentContextualProvisionalIndicatorPreview,
  stageContextualProvisionalIndicatorPreview,
  shouldRetainProvisionalIndicatorPreview,
  type ContextualProvisionalIndicatorPreview,
} from "../indicatorRealtimePreview.js";
import { buildIndicatorRealtimeConfigSignature } from "../indicatorRealtimeBatcher.js";
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

test("a provisional preview cannot cross an indicator config signature boundary", () => {
  const candidate = {
    contextKey: "binance|futures|BTCUSDT|1m",
    indicatorConfigSignature: "config-a",
    preview: { barTime: 300, values: { volume: 30 } },
  };
  assert.strictEqual(currentContextualProvisionalIndicatorPreview(
    candidate,
    candidate.contextKey,
    "config-a",
  ), candidate);
  assert.equal(currentContextualProvisionalIndicatorPreview(
    candidate,
    candidate.contextKey,
    "config-b",
  ), null);
});

test("an old wire value is rejected without polluting the current config preview", () => {
  const currentPreview: ContextualProvisionalIndicatorPreview = {
    contextKey: "binance|futures|BTCUSDT|1m",
    indicatorConfigSignature: "config-b",
    preview: { barTime: 300, values: { volume: 30 } },
  };
  const previews = new Map([["vol", currentPreview]]);

  assert.equal(stageContextualProvisionalIndicatorPreview({
    currentContextKey: currentPreview.contextKey,
    currentIndicatorConfigSignature: "config-b",
    incomingIndicatorConfigSignature: "config-a",
    indicatorId: "vol",
    isFinal: false,
    preview: { barTime: 400, values: { volume: 999 } },
    previews,
  }), false);
  assert.strictEqual(previews.get("vol"), currentPreview);

  assert.equal(stageContextualProvisionalIndicatorPreview({
    currentContextKey: currentPreview.contextKey,
    currentIndicatorConfigSignature: "config-b",
    incomingIndicatorConfigSignature: "config-a",
    indicatorId: "vol",
    isFinal: true,
    preview: { barTime: 400, values: { volume: 999 } },
    previews,
  }), false);
  assert.strictEqual(previews.get("vol"), currentPreview);

  assert.equal(stageContextualProvisionalIndicatorPreview({
    currentContextKey: currentPreview.contextKey,
    currentIndicatorConfigSignature: "config-b",
    incomingIndicatorConfigSignature: "config-b",
    indicatorId: "vol",
    isFinal: false,
    preview: { barTime: 400, values: { volume: 40 } },
    previews,
  }), true);
  assert.deepEqual(previews.get("vol"), {
    contextKey: currentPreview.contextKey,
    indicatorConfigSignature: "config-b",
    preview: { barTime: 400, values: { volume: 40 } },
  });
});

test("line hydration does not invalidate a same-config provisional preview", () => {
  const context = {
    exchange: "binance",
    marketType: "futures",
    symbol: "BTCUSDT",
    interval: "1m",
  };
  const unhydratedSignature = buildIndicatorRealtimeConfigSignature(indicator, context);
  const hydratedSignature = buildIndicatorRealtimeConfigSignature({
    ...indicator,
    lines: [volumeLine],
  }, context);
  const candidate = {
    contextKey: "binance|futures|BTCUSDT|1m",
    indicatorConfigSignature: unhydratedSignature,
    preview: { barTime: 300, values: { volume: 30 } },
  };

  assert.equal(hydratedSignature, unhydratedSignature);
  assert.strictEqual(currentContextualProvisionalIndicatorPreview(
    candidate,
    candidate.contextKey,
    hydratedSignature,
  ), candidate);
});

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
  assert.equal(lines[0]?.renderUpdate, "tail");
});

test("an older realtime correction forces a full indicator render", () => {
  const lines = applyRealtimeIndicatorValuesToLines({
    barTime: 100,
    candleDownColor: "#down",
    candleUpColor: "#up",
    indicator,
    lines: [volumeLine],
    values: { volume: 15 },
  });

  assert.equal(lines[0]?.data[0]?.value, 15);
  assert.equal(lines[0]?.renderUpdate, "full");
});

test("a not-yet-warm BOLL preview removes its forming points instead of plotting zero", () => {
  const boll = {
    id: "boll",
    engineName: "BOLL",
    params: { period: 20 },
  };
  const lines = applyRealtimeIndicatorValuesToLines({
    barTime: 300,
    candleDownColor: "#down",
    candleUpColor: "#up",
    indicator: boll,
    lines: [
      {
        id: "middle",
        outputName: "middle",
        pane: "main",
        type: "line" as const,
        data: [{ time: 200, value: 100 }, { time: 300, value: 101 }],
      },
      {
        id: "upper",
        outputName: "upper",
        pane: "main",
        type: "line" as const,
        data: [{ time: 200, value: 110 }, { time: 300, value: 111 }],
      },
      {
        id: "lower",
        outputName: "lower",
        pane: "main",
        type: "line" as const,
        data: [{ time: 200, value: 90 }, { time: 300, value: 91 }],
      },
    ],
    values: { middle: null, upper: null, lower: null },
  });

  assert.deepEqual(lines.map((line) => line.data), [
    [{ time: 200, value: 100 }],
    [{ time: 200, value: 110 }],
    [{ time: 200, value: 90 }],
  ]);
  assert.deepEqual(lines.map((line) => line.renderUpdate), ["full", "full", "full"]);
  assert.equal(lines.some((line) => line.data.some((point) => point.value === 0)), false);
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

test("an identical realtime value preserves line and data references", () => {
  const current = [volumeLine];
  const lines = applyRealtimeIndicatorValuesToLines({
    barTime: 200,
    candleDownColor: "#down",
    candleUpColor: "#up",
    indicator,
    lines: current,
    values: { volume: 20 },
  });

  assert.strictEqual(lines, current);
  assert.strictEqual(lines[0], volumeLine);
  assert.strictEqual(lines[0]?.data, volumeLine.data);
});
