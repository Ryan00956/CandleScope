import test from "node:test";
import assert from "node:assert/strict";
import {
  alignIndicatorBgcolorsToTimes,
  alignIndicatorLinesToTimes,
  alignIndicatorMarkersToTimes,
  applyLineSeriesData,
  buildFillRenderEntries,
  canUseTrailingSeriesUpdate,
  filterEntriesByTime,
  normalizeLineSeriesData,
} from "../chartSeriesData.js";
import type { OrdinalAxisTime } from "../../features/chart-representation/chartRepresentationTypes.js";
import { mustBeDefined, structuralMock } from "../../test/testHelpers.js";

function ordinal(order: number, sourceTime = 100, sourceOrdinal = 0): OrdinalAxisTime {
  return { order, sourceTime, sourceOrdinal };
}

test("alignIndicatorLinesToTimes clips line and color data to the main bar time set", () => {
  const allowed = new Set([10, 20]);
  const lines = alignIndicatorLinesToTimes([{
    id: "plot",
    type: "histogram",
    data: [
      { time: 10, value: 1 },
      { time: 15, value: 99 },
      { time: 20, value: 2 },
    ],
    colorData: [
      { time: 10, color: "red" },
      { time: 15, color: "blue" },
      { time: 20, color: "green" },
    ],
  }], allowed);

  const line = mustBeDefined(lines[0]);
  assert.deepEqual(line.data, [
    { time: 10, value: 1, color: "red" },
    { time: 20, value: 2, color: "green" },
  ]);
  assert.deepEqual(line.colorData, [
    { time: 10, color: "red" },
    { time: 20, color: "green" },
  ]);
});

test("realtime histogram point colors override historical colorData and survive missing color entries", () => {
  const lines = alignIndicatorLinesToTimes([{
    id: "histogram",
    type: "histogram",
    data: [
      { time: 10, value: 1 },
      { time: 20, value: -2, color: "realtime-red" },
      { time: 30, value: 3, color: "realtime-green" },
    ],
    colorData: [
      { time: 10, color: "snapshot-green" },
      { time: 20, color: "stale-green" },
    ],
  }], new Set([10, 20, 30]));

  assert.deepEqual(mustBeDefined(lines[0]).data, [
    { time: 10, value: 1, color: "snapshot-green" },
    { time: 20, value: -2, color: "realtime-red" },
    { time: 30, value: 3, color: "realtime-green" },
  ]);
});

test("time filtering and normalization reuse immutable inputs until the time axis changes", () => {
  const data = [{ time: 10, value: 1 }, { time: 20, value: 2 }];
  const allowed = new Set([10]);
  const firstFiltered = filterEntriesByTime(data, allowed);
  const firstNormalized = normalizeLineSeriesData({ data }, allowed);

  assert.equal(filterEntriesByTime(data, allowed), firstFiltered);
  assert.equal(normalizeLineSeriesData({ data }, allowed), firstNormalized);

  allowed.add(20);
  assert.notEqual(filterEntriesByTime(data, allowed), firstFiltered);
  assert.notEqual(normalizeLineSeriesData({ data }, allowed), firstNormalized);
  assert.deepEqual(filterEntriesByTime(data, allowed), data);
});

test("histogram normalization preserves stable point identity across tail updates", () => {
  const first = { time: 10, value: 1 };
  const previous = normalizeLineSeriesData({
    type: "histogram",
    data: [first, { time: 20, value: 2 }],
    colorData: [{ time: 10, color: "red" }, { time: 20, color: "green" }],
  }, new Set([10, 20]));
  const next = normalizeLineSeriesData({
    type: "histogram",
    data: [first, { time: 20, value: 3 }],
    colorData: [{ time: 10, color: "red" }, { time: 20, color: "green" }],
  }, new Set([10, 20]));

  assert.equal(previous[0], next[0]);
  assert.equal(canUseTrailingSeriesUpdate(previous, next), true);
});

test("line normalization reuses unchanged data and invalidates when the mutable axis grows", () => {
  const allowed = new Set([10]);
  const line = {
    id: "plot",
    data: [{ time: 10, value: 1 }, { time: 20, value: 2 }],
  };
  const first = alignIndicatorLinesToTimes([line], allowed)[0]?.data;
  const second = alignIndicatorLinesToTimes([line], allowed)[0]?.data;
  assert.equal(second, first);

  allowed.add(20);
  const expanded = alignIndicatorLinesToTimes([line], allowed)[0]?.data;
  assert.notEqual(expanded, first);
  assert.deepEqual(expanded, line.data);
});

test("alignIndicatorMarkersToTimes and bgcolors clip payloads to the main bar time set", () => {
  const allowed = new Set([10]);

  assert.deepEqual(alignIndicatorMarkersToTimes([{ data: [{ time: 10 }, { time: 11 }] }], allowed), [
    { data: [{ time: 10 }] },
  ]);
  assert.deepEqual(alignIndicatorBgcolorsToTimes([{ data: [{ time: 10 }, { time: 11 }], regions: [{ time: 10 }, { time: 11 }] }], allowed), [
    { data: [{ time: 10 }], regions: [{ time: 10 }] },
  ]);
});

test("buildFillRenderEntries only uses shared clipped line times", () => {
  const payload = buildFillRenderEntries(
    [{ plot1_id: "upper", plot2_id: "lower", color: "rgba(1,2,3,0.5)" }],
    [
      { id: "upper", data: [{ time: 10, value: 3 }, { time: 20, value: 5 }] },
      { id: "lower", data: [{ time: 10, value: 1 }, { time: 30, value: 2 }] },
    ],
    "#000",
  );

  assert.equal(payload.matchedFillCount, 1);
  const entry = mustBeDefined(payload.entries[0]);
  assert.deepEqual(entry.upperData, [{ time: 10, value: 3 }]);
  assert.deepEqual(entry.lowerData, [{ time: 10, value: 1 }]);
});

test("buildFillRenderEntries aligns and sorts separate ordinal time objects by order", () => {
  const upperAtTwo = ordinal(2, 200);
  const upperAtOne = ordinal(1, 100);
  const payload = buildFillRenderEntries(
    [{ plot1_id: "upper", plot2_id: "lower", color: "blue" }],
    [
      { id: "upper", data: [{ time: upperAtTwo, value: 5 }, { time: upperAtOne, value: 3 }] },
      {
        id: "lower",
        data: [
          { time: ordinal(1, 100), value: 1 },
          { time: ordinal(2, 200), value: 2 },
        ],
      },
    ],
    "black",
  );

  const entry = mustBeDefined(payload.entries[0]);
  assert.deepEqual(entry.upperData, [
    { time: upperAtOne, value: 3 },
    { time: upperAtTwo, value: 5 },
  ]);
  assert.deepEqual(entry.lowerData, [
    { time: upperAtOne, value: 1 },
    { time: upperAtTwo, value: 2 },
  ]);
});

test("buildFillRenderEntries signature includes ordinal lineage and plotted values", () => {
  const makePayload = ({
    middleOrder = 2,
    middleSourceTime = 100,
    middleValue = 4,
    background = "black",
  } = {}) => (
    buildFillRenderEntries(
      [{ plot1_id: "upper", plot2_id: "lower", color: "blue" }],
      [
        {
          id: "upper",
          data: [
            { time: ordinal(1), value: 3 },
            { time: ordinal(middleOrder, middleSourceTime), value: middleValue },
            { time: ordinal(3), value: 5 },
          ],
        },
        {
          id: "lower",
          data: [
            { time: ordinal(1), value: 1 },
            { time: ordinal(middleOrder, middleSourceTime), value: 2 },
            { time: ordinal(3), value: 3 },
          ],
        },
      ],
      background,
    )
  );

  const baseline = makePayload().signature;
  assert.notEqual(makePayload({ middleOrder: 4 }).signature, baseline);
  assert.notEqual(makePayload({ middleSourceTime: 200 }).signature, baseline);
  assert.notEqual(makePayload({ middleValue: 40 }).signature, baseline);
  assert.notEqual(makePayload({ background: "white" }).signature, baseline);
});

test("ordinal filtering and histogram colors require matching source lineage", () => {
  const allowedTime = ordinal(2, 200);
  const lines = alignIndicatorLinesToTimes([{
    id: "histogram",
    type: "histogram",
    data: [
      { time: ordinal(2, 200), value: 7 },
      { time: ordinal(2, 999), value: 8 },
      { time: ordinal(3), value: 9 },
    ],
    colorData: [{ time: ordinal(2, 200), color: "red" }],
  }], new Set([allowedTime]));

  const line = mustBeDefined(lines[0]);
  assert.deepEqual(line.data, [{ time: ordinal(2, 200), value: 7, color: "red" }]);
});

test("trailing updates reject ordinal orders reassigned to different source lineage", () => {
  const previous = [
    { time: ordinal(0, 10), value: 1 },
    { time: ordinal(1, 20), value: 2 },
  ];

  assert.equal(canUseTrailingSeriesUpdate(previous, [
    { time: ordinal(0, 10), value: 1 },
    { time: ordinal(1, 20), value: 2 },
  ]), true);
  assert.equal(canUseTrailingSeriesUpdate(previous, [
    { time: ordinal(0, 15), value: 1 },
    { time: ordinal(1, 25), value: 2 },
  ]), false);
});

test("applyLineSeriesData clears existing indicator series when next data is empty", () => {
  const calls: unknown[][] = [];
  type RecordEvent = NonNullable<Parameters<typeof applyLineSeriesData>[4]>;
  const events: Array<{ name: string; detail: Parameters<RecordEvent>[1] }> = [];
  const recordEvent: RecordEvent = (name, detail) => {
    events.push({ name, detail });
  };
  const result = applyLineSeriesData(
    structuralMock<NonNullable<Parameters<typeof applyLineSeriesData>[0]>>({
      setData: (data: unknown[]) => { calls.push(data); },
    }),
    [],
    [{ time: 10, value: 1 }],
    { paneId: "volume", line: "hist" },
    recordEvent,
  );

  assert.equal(result, "clear");
  assert.deepEqual(calls, [[]]);
  const event = mustBeDefined(events[0]);
  assert.equal(event.name, "chart.indicatorSeries.setData");
  const detail = mustBeDefined(event.detail);
  assert.equal(detail.points, 0);
  assert.equal(detail.reason, "clear");
});

test("applyLineSeriesData performs no chart write for an unchanged normalized array", () => {
  const calls: string[] = [];
  const data = [{ time: 10, value: 1 }];
  const result = applyLineSeriesData(
    structuralMock<NonNullable<Parameters<typeof applyLineSeriesData>[0]>>({
      setData: () => { calls.push("setData"); },
      update: () => { calls.push("update"); },
    }),
    data,
    data,
    {},
    null,
  );

  assert.equal(result, "unchanged");
  assert.deepEqual(calls, []);
});

test("applyLineSeriesData can force a full reset for custom ordinal axes", () => {
  const calls: Array<[string, unknown]> = [];
  const series = structuralMock<NonNullable<Parameters<typeof applyLineSeriesData>[0]>>({
    setData: (data: unknown) => { calls.push(["setData", data]); },
    update: (point: unknown) => { calls.push(["update", point]); },
  });
  const previous = [
    { time: ordinal(0, 10), value: 1 },
    { time: ordinal(1, 20), value: 2 },
  ];
  const next = [
    { time: ordinal(0, 10), value: 1 },
    { time: ordinal(1, 20), value: 3 },
  ];

  const result = applyLineSeriesData(
    series,
    next,
    previous,
    {},
    null,
    { preferSetData: true },
  );

  assert.equal(result, "setData");
  assert.deepEqual(calls, [["setData", next]]);
});

test("applyLineSeriesData trusts an explicit realtime tail hint without weakening range updates", () => {
  const calls: Array<[string, unknown]> = [];
  const series = structuralMock<NonNullable<Parameters<typeof applyLineSeriesData>[0]>>({
    setData: (data: unknown) => { calls.push(["setData", data]); },
    update: (point: unknown) => { calls.push(["update", point]); },
  });
  const previous = [
    { time: 10, value: 1 },
    { time: 20, value: 2 },
  ];
  const next = [
    { time: 10, value: 999 },
    { time: 20, value: 3 },
  ];

  assert.equal(applyLineSeriesData(series, next, previous, {}, null), "setData");
  calls.length = 0;
  assert.equal(applyLineSeriesData(
    series,
    next,
    previous,
    {},
    null,
    { trustedTrailingUpdate: true },
  ), "update");
  assert.deepEqual(calls, [["update", next[1]]]);
});
