import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveShortSwitchStepTransition,
  summarizeShortSwitchIndicatorReadiness,
} from "./short-switch-readiness.mjs";

const EXPECTED_IDS = ["ma", "vol", "boll", "rsi"];
const EXPECTED_SERIES = { ma: 1, vol: 1, boll: 3, rsi: 1 };
const OPTIONS = {
  datasetKey: "binance::spot::BTCUSDT::1d",
  expectedIndicatorIds: EXPECTED_IDS,
  expectedSeriesCounts: EXPECTED_SERIES,
  interval: "1d",
  sinceAtMs: 100,
};

function event(name, atMs, detail) {
  return { name, atMs, detail };
}

function open(atMs, wsGeneration = 1) {
  return event("indicator.ws.open", atMs, { interval: "1d", wsGeneration });
}

function ack(indicatorId, atMs, wsGeneration = 1, resumeStatus = "up_to_date") {
  return event("indicator.ws.subscribed", atMs, {
    indicatorId,
    interval: "1d",
    resumeStatus,
    wsGeneration,
  });
}

function data(indicatorId, line, atMs, interval = "1d") {
  return event("chart.indicatorSeries.setData", atMs, {
    datasetKey: `binance::spot::BTCUSDT::${interval}`,
    indicatorId,
    interval,
    line,
    paneId: indicatorId,
    points: 100,
    type: "line",
  });
}

function allData() {
  return [
    data("ma", "ma", 120),
    data("vol", "vol", 121),
    data("boll", "upper", 122),
    data("boll", "middle", 123),
    data("boll", "lower", 124),
    data("rsi", "rsi", 125),
  ];
}

test("short-switch readiness requires current dataset data for every indicator", () => {
  const control = summarizeShortSwitchIndicatorReadiness({
    events: [open(105), ...EXPECTED_IDS.map((id, index) => ack(id, 110 + index)), ...allData()],
  }, OPTIONS);
  assert.equal(control.ready, true);
  assert.equal(control.protocolReady, true);
  assert.deepEqual(control.indicatorSeriesCounts, EXPECTED_SERIES);

  const oldIntervalOnly = summarizeShortSwitchIndicatorReadiness({
    events: [
      open(105),
      ...EXPECTED_IDS.map((id, index) => ack(id, 110 + index)),
      ...allData().map((item) => data(item.detail.indicatorId, item.detail.line, item.atMs, "3m")),
    ],
  }, OPTIONS);
  assert.equal(oldIntervalOnly.ready, false);
  assert.equal(oldIntervalOnly.indicatorDataReady, false);

  const duplicateBollOnly = summarizeShortSwitchIndicatorReadiness({
    events: [
      open(105),
      ...EXPECTED_IDS.map((id, index) => ack(id, 110 + index)),
      ...Array.from({ length: 6 }, (_, index) => data("boll", "upper", 120 + index)),
    ],
  }, OPTIONS);
  assert.equal(duplicateBollOnly.ready, false);
  assert.deepEqual(duplicateBollOnly.indicatorSeriesCounts, { ma: 0, vol: 0, boll: 1, rsi: 0 });
});

test("short-switch readiness uses only ACKs from the latest step-local WS generation", () => {
  const mixed = summarizeShortSwitchIndicatorReadiness({
    events: [
      open(105, 1),
      ack("ma", 110, 1),
      ack("vol", 111, 1),
      open(130, 2),
      ack("boll", 131, 2),
      ack("rsi", 132, 2),
      ...allData(),
    ],
  }, OPTIONS);
  assert.equal(mixed.ready, true);
  assert.equal(mixed.protocolReady, false);
  assert.deepEqual(mixed.subscribedIndicatorIds, ["boll", "rsi"]);

  const current = summarizeShortSwitchIndicatorReadiness({
    events: [
      open(105, 1),
      ack("ma", 110, 1),
      open(130, 2),
      ...EXPECTED_IDS.map((id, index) => ack(id, 131 + index, 2)),
      ...allData(),
    ],
  }, OPTIONS);
  assert.equal(current.ready, true);
  assert.equal(current.protocolReady, true);
  assert.equal(current.wsGeneration, 2);
});

test("short-switch readiness waits for a resume patch after a patch ACK", () => {
  const events = [
    open(105, 1),
    ack("ma", 110, 1, "patch"),
    ack("vol", 111),
    ack("boll", 112),
    ack("rsi", 113),
    ...allData(),
  ];
  const pending = summarizeShortSwitchIndicatorReadiness({ events }, OPTIONS);
  assert.equal(pending.ready, true);
  assert.equal(pending.protocolReady, false);
  assert.deepEqual(pending.pendingPatchIndicatorIds, ["ma"]);

  const applied = summarizeShortSwitchIndicatorReadiness({
    events: [
      ...events,
      event("indicator.ws.patch", 140, { indicatorId: "ma", interval: "1d", wsGeneration: 1 }),
    ],
  }, OPTIONS);
  assert.equal(applied.ready, true);
  assert.equal(applied.protocolReady, true);
});

test("only the first warm step may prime from an already-active interval", () => {
  assert.deepEqual(resolveShortSwitchStepTransition({
    allowInitialPrime: true,
    clickOk: true,
    wasActive: true,
  }), {
    readyEligible: true,
    transitioned: false,
    primedFromInitial: true,
    sinceAtMs: 0,
  });
  assert.equal(resolveShortSwitchStepTransition({
    allowInitialPrime: false,
    clickOk: true,
    wasActive: true,
  }).readyEligible, false);
});
