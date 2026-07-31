import assert from "node:assert/strict";
import test from "node:test";

import {
  clearReplayIndicatorPreferences,
  loadReplayIndicatorPreferences,
  saveReplayIndicatorPreferences,
} from "../replayIndicatorPreferences.js";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test("replay indicators inherit supported live studies once and persist per run", () => {
  const storage = new MemoryStorage();
  storage.setItem("candlescope-active-indicators", JSON.stringify([
    {
      id: "vol",
      engineName: "VOL",
      name: "成交量",
      params: {},
      visible: true,
    },
    {
      id: "ma-50",
      engineName: "MA",
      name: "Simple Moving Average",
      params: { period: 50 },
      visible: false,
    },
    {
      id: "custom-wave",
      name: "WaveTrend",
      script: "custom",
      visible: true,
    },
  ]));
  storage.setItem("candlescope-trade-flow-preferences-v1", JSON.stringify({
    indicators: {
      cvd: { added: true, visible: true },
      delta: { added: true, visible: false },
    },
  }));

  const first = loadReplayIndicatorPreferences("run-a", storage);
  assert.equal(first.inheritedFromLiveWorkspace, true);
  assert.deepEqual(first.indicators, [
    { id: "vol", visible: true, period: 1 },
    { id: "sma", visible: false, period: 50 },
    { id: "cvd", visible: true, period: 1 },
    { id: "delta", visible: false, period: 1 },
  ]);
  assert.deepEqual(first.unsupportedLiveIndicators, ["WaveTrend"]);

  storage.setItem("candlescope-active-indicators", "[]");
  assert.deepEqual(loadReplayIndicatorPreferences("run-a", storage), first);
  assert.deepEqual(loadReplayIndicatorPreferences("run-b", storage).indicators, [
    { id: "cvd", visible: true, period: 1 },
    { id: "delta", visible: false, period: 1 },
  ]);
});

test("replay indicator persistence rejects invalid periods and unknown ids", () => {
  const storage = new MemoryStorage();
  saveReplayIndicatorPreferences("run-a", {
    indicators: [
      { id: "rsi", visible: true, period: 14 },
    ],
    inheritedFromLiveWorkspace: false,
    unsupportedLiveIndicators: [],
  }, storage);
  const key = "candlescope-replay-local-indicators-v1:run-a";
  const raw = JSON.parse(storage.getItem(key) ?? "{}") as Record<string, unknown>;
  raw.indicators = [
    { id: "rsi", visible: true, period: 0 },
    { id: "future-indicator", visible: true, period: 20 },
  ];
  storage.setItem(key, JSON.stringify(raw));

  assert.deepEqual(loadReplayIndicatorPreferences("run-a", storage).indicators, [
    { id: "rsi", visible: true, period: 14 },
  ]);
});

test("archive cleanup removes only deleted replay indicator scopes", () => {
  const storage = new MemoryStorage();
  storage.setItem("candlescope-active-indicators", "[]");
  storage.setItem("candlescope-replay-local-indicators-v1:adapter-1", "{}");
  storage.setItem("candlescope-replay-local-indicators-v1:adapter-2", "{}");

  clearReplayIndicatorPreferences(
    ["adapter-1", "adapter-1", ""],
    storage,
  );

  assert.equal(
    storage.getItem("candlescope-replay-local-indicators-v1:adapter-1"),
    null,
  );
  assert.equal(
    storage.getItem("candlescope-replay-local-indicators-v1:adapter-2"),
    "{}",
  );
  assert.equal(storage.getItem("candlescope-active-indicators"), "[]");
});
