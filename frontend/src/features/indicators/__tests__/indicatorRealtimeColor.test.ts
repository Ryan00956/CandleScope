import assert from "node:assert/strict";
import test from "node:test";

import { resolveRealtimeHistogramColor } from "../indicatorRealtimeColor.js";
import type { KlineBar } from "../../market-data/marketDataTypes.js";

const redBar = {
  time: 100,
  open: 12,
  high: 13,
  low: 8,
  close: 9,
  volume: 50,
} as KlineBar;

test("realtime volume color follows the exact bar carried by the indicator update", () => {
  const color = resolveRealtimeHistogramColor({
    bar: redBar,
    downColor: "#down",
    indicator: { id: "vol", engineName: "VOL", params: {} },
    line: { type: "histogram", pane: "volume", color: "#up", data: [] },
    upColor: "#up",
    value: 50,
  });

  assert.equal(color, "#down");
});

test("realtime MACD histogram color follows the histogram sign, not candle direction", () => {
  const indicator = {
    id: "macd",
    engineName: "MACD",
    params: { hist_up_color: "#positive", hist_down_color: "#negative" },
  };
  const line = {
    type: "histogram",
    pane: "separate",
    color: "#positive",
    data: [],
  };

  assert.equal(resolveRealtimeHistogramColor({
    bar: { ...redBar, close: 13 } as KlineBar,
    downColor: "#down",
    indicator,
    line,
    upColor: "#up",
    value: -0.25,
  }), "#negative");
  assert.equal(resolveRealtimeHistogramColor({
    bar: redBar,
    downColor: "#down",
    indicator,
    line,
    upColor: "#up",
    value: 0.25,
  }), "#positive");
});
