import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveShortSwitchStepTransition,
  summarizeShortSwitchIndicatorReadiness,
  summarizeShortSwitchLongTasks,
} from "./short-switch-readiness.mjs";

const EXPECTED_IDS = ["ma", "vol", "boll", "rsi"];
const EXPECTED_SERIES = { ma: 1, vol: 1, boll: 3, rsi: 1 };
const OPTIONS = {
  datasetKey: "binance::spot::BTCUSDT::1d",
  expectedIndicatorIds: EXPECTED_IDS,
  expectedSeriesCounts: EXPECTED_SERIES,
  interval: "1d",
  maxSetDataPerSeries: 1,
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

function data(indicatorId, line, atMs, interval = "1d", points = 100) {
  return event("chart.indicatorSeries.setData", atMs, {
    datasetKey: `binance::spot::BTCUSDT::${interval}`,
    indicatorId,
    interval,
    line,
    paneId: indicatorId,
    points,
    type: "line",
  });
}

function mainData(atMs, points = 100) {
  return event("chart.candleSeries.setData", atMs, {
    paneId: "main",
    points,
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
  assert.equal(control.submissionReady, true);
  assert.equal(control.lastSubmissionAtMs, 125);

  const oldIntervalOnly = summarizeShortSwitchIndicatorReadiness({
    events: [
      open(105),
      ...EXPECTED_IDS.map((id, index) => ack(id, 110 + index)),
      ...allData().map((item) => data(item.detail.indicatorId, item.detail.line, item.atMs, "3m")),
    ],
  }, OPTIONS);
  assert.equal(oldIntervalOnly.ready, false);

  const progressiveWithoutProtocol = summarizeShortSwitchIndicatorReadiness({
    events: allData(),
  }, OPTIONS);
  assert.equal(progressiveWithoutProtocol.indicatorDataReady, true);
  assert.equal(progressiveWithoutProtocol.protocolReady, false);
  assert.equal(progressiveWithoutProtocol.ready, false);
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

  const duplicateAfterCoverage = summarizeShortSwitchIndicatorReadiness({
    events: [
      open(105),
      ...EXPECTED_IDS.map((id, index) => ack(id, 110 + index)),
      ...allData(),
      data("boll", "upper", 130),
    ],
  }, OPTIONS);
  assert.equal(duplicateAfterCoverage.ready, true);
  assert.equal(duplicateAfterCoverage.indicatorDataReady, true);
  assert.equal(duplicateAfterCoverage.indicatorFullSubmissionsReady, false);
  assert.equal(duplicateAfterCoverage.submissionReady, false);
  assert.equal(duplicateAfterCoverage.indicatorSetDataCounts["boll|boll|upper|line"], 2);
});

test("short-switch readiness enforces expected main setData counts of zero, one, and two", () => {
  const baseEvents = [
    open(105),
    ...EXPECTED_IDS.map((id, index) => ack(id, 110 + index)),
    ...allData(),
  ];

  const zeroExpected = summarizeShortSwitchIndicatorReadiness({
    events: baseEvents,
  }, { ...OPTIONS, expectedMainSetDataCount: 0 });
  assert.equal(zeroExpected.mainSetDataCount, 0);
  assert.equal(zeroExpected.mainSubmissionReady, true);
  assert.equal(zeroExpected.submissionReady, true);

  const zeroSubmissions = summarizeShortSwitchIndicatorReadiness({
    events: baseEvents,
  }, { ...OPTIONS, expectedMainSetDataCount: 1 });
  assert.equal(zeroSubmissions.mainSetDataCount, 0);
  assert.equal(zeroSubmissions.mainSubmissionReady, false);
  assert.equal(zeroSubmissions.submissionReady, false);

  const oneSubmission = summarizeShortSwitchIndicatorReadiness({
    events: [...baseEvents, mainData(130)],
  }, { ...OPTIONS, expectedMainSetDataCount: 1 });
  assert.equal(oneSubmission.mainSetDataCount, 1);
  assert.equal(oneSubmission.mainSubmissionReady, true);
  assert.equal(oneSubmission.submissionReady, true);

  const emptyThenFull = summarizeShortSwitchIndicatorReadiness({
    events: [...baseEvents, mainData(129, 0), mainData(130)],
  }, { ...OPTIONS, expectedMainSetDataCount: 1 });
  assert.equal(emptyThenFull.mainSetDataCount, 2);
  assert.equal(emptyThenFull.mainSubmissionReady, false);
  assert.equal(emptyThenFull.submissionReady, false);

  const twoExpected = summarizeShortSwitchIndicatorReadiness({
    events: [...baseEvents, mainData(129, 0), mainData(130)],
  }, { ...OPTIONS, expectedMainSetDataCount: 2 });
  assert.equal(twoExpected.mainSetDataCount, 2);
  assert.equal(twoExpected.mainSubmissionReady, true);
  assert.equal(twoExpected.submissionReady, true);
});

test("short-switch readiness counts empty indicator setData before full coverage", () => {
  const report = summarizeShortSwitchIndicatorReadiness({
    events: [
      open(105),
      ...EXPECTED_IDS.map((id, index) => ack(id, 110 + index)),
      data("ma", "ma", 119, "1d", 0),
      ...allData(),
    ],
  }, OPTIONS);

  assert.equal(report.ready, true);
  assert.equal(report.indicatorDataReady, true);
  assert.equal(report.indicatorSeriesCounts.ma, 1);
  assert.equal(report.indicatorSeriesDataEventCount, 6);
  assert.equal(report.indicatorSetDataEventCount, 7);
  assert.equal(report.indicatorSetDataCounts["ma|ma|ma|line"], 2);
  assert.equal(report.indicatorFullSubmissionsReady, false);
  assert.equal(report.submissionReady, false);
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
  assert.equal(mixed.ready, false);
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
  assert.equal(pending.ready, false);
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

test("short-switch long-task attribution includes only measured tasks over 50ms", () => {
  const summary = summarizeShortSwitchLongTasks([
    { startTime: 90, duration: 80 },
    { startTime: 120, duration: 50 },
    { startTime: 140, duration: 51 },
    { startTime: 250, duration: 75 },
    { startTime: 420, duration: 60 },
  ], [
    { phase: "short-switch-warm:1m", sincePerfMs: 0, elapsedMs: 100 },
    { phase: "short-switch-measured:1m", sincePerfMs: 100, elapsedMs: 100 },
    { phase: "short-switch-measured:3m", sincePerfMs: 300, elapsedMs: 100 },
  ]);

  assert.equal(summary.count, 1);
  assert.equal(summary.maxDurationMs, 51);
  assert.deepEqual(summary.byPhase.map((phase) => ({
    phase: phase.phase,
    count: phase.count,
  })), [
    { phase: "short-switch-measured:1m", count: 1 },
    { phase: "short-switch-measured:3m", count: 0 },
  ]);
});

test("short-switch long-task attribution stops after the last target submission", () => {
  const summary = summarizeShortSwitchLongTasks([
    { startTime: 140, duration: 51 },
    { startTime: 170, duration: 80 },
  ], [{
    phase: "short-switch-measured:1m",
    sincePerfMs: 100,
    attributionEndPerfMs: 160,
    elapsedMs: 1_000,
  }]);

  assert.equal(summary.count, 1);
  assert.equal(summary.byPhase[0].endMs, 160);
  assert.deepEqual(summary.byPhase[0].tasks, [{ startTime: 140, duration: 51 }]);
});
