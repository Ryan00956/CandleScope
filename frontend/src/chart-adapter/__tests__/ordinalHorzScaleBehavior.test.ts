import assert from "node:assert/strict";
import test from "node:test";

import {
  OrdinalHorzScaleBehavior,
  createOrdinalHorzScaleBehavior,
} from "../ordinalHorzScaleBehavior.js";
import type { OrdinalAxisTime } from "../../features/chart-representation/chartRepresentationTypes.js";
import { malformedFixture, structuralMock } from "../../test/testHelpers.js";

type OrdinalBehavior = ReturnType<typeof createOrdinalHorzScaleBehavior>;

function configureTimeFormatting(behavior: OrdinalBehavior, overrides: object = {}) {
  behavior.setOptions(structuralMock<Parameters<OrdinalBehavior["setOptions"]>[0]>({
    localization: {
      dateFormat: "yyyy-MM-dd",
      locale: "en-US",
    },
    timeScale: {
      secondsVisible: true,
      timeVisible: true,
      ...overrides,
    },
  }));
}

function axisItem(order: number, sourceTime: number, sourceOrdinal = 0): OrdinalAxisTime {
  return { order, sourceTime, sourceOrdinal };
}

test("factory creates a complete ordinal behavior backed by the default time behavior", () => {
  const behavior = createOrdinalHorzScaleBehavior();

  assert.ok(behavior instanceof OrdinalHorzScaleBehavior);
  assert.equal(typeof behavior.options, "function");
  assert.equal(typeof behavior.setOptions, "function");
  assert.equal(typeof behavior.maxTickMarkWeight, "function");
  assert.equal(typeof behavior.fillWeightsForPoints, "function");
});

test("order provides unique numeric keys even when source timestamps repeat", () => {
  const behavior = createOrdinalHorzScaleBehavior();
  const first = axisItem(40, 1_720_000_000, 0);
  const second = axisItem(41, 1_720_000_000, 1);
  const firstInternal = behavior.convertHorzItemToInternal(first);
  const secondInternal = behavior.convertHorzItemToInternal(second);

  assert.equal(behavior.key(first), 40);
  assert.equal(behavior.key(firstInternal), 40);
  assert.equal(behavior.cacheKey(firstInternal), 40);
  assert.equal(behavior.key(secondInternal), 41);
  assert.equal(behavior.cacheKey(secondInternal), 41);
  assert.equal(typeof behavior.key(first), "number");
  assert.notEqual(behavior.key(first), behavior.key(second));
});

test("preprocessing and conversion validate the ordinal item contract", () => {
  const behavior = createOrdinalHorzScaleBehavior();
  const data = [
    { time: axisItem(-1, 100, 0), value: 10 },
    { time: axisItem(0, 100, 1), value: 11 },
  ];

  assert.doesNotThrow(() => behavior.preprocessData(data));
  assert.doesNotThrow(() => behavior.preprocessData(data[0]));

  const converter = behavior.createConverterToInternalObj(data);
  const converted = converter(data[1].time);
  assert.equal(behavior.key(converted), 0);
  assert.equal(behavior.cacheKey(converted), 0);
  const ordinalInternal = structuralMock<{
    _ordinal_sourceOrdinal: number;
    _ordinal_sourceTime: number;
  }>(converted);
  assert.equal(ordinalInternal._ordinal_sourceOrdinal, 1);
  assert.equal(ordinalInternal._ordinal_sourceTime, 100);

  assert.throws(
    () => behavior.key(malformedFixture<OrdinalAxisTime>({
      order: "1",
      sourceTime: 100,
      sourceOrdinal: 0,
    })),
    /order must be a safe integer/,
  );
  assert.throws(
    () => behavior.convertHorzItemToInternal(axisItem(1, Number.NaN, 0)),
    /sourceTime must be a finite number/,
  );
  assert.throws(
    () => behavior.preprocessData({ time: axisItem(1, 100, -1), value: 10 }),
    /sourceOrdinal must be a safe integer/,
  );
  assert.throws(
    () => behavior.cacheKey(malformedFixture<Parameters<typeof behavior.cacheKey>[0]>(
      axisItem(1, 100, 0),
    )),
    /cache item must be internal/,
  );
});

test("order controls sorting independently from source time and source ordinal", () => {
  const behavior = createOrdinalHorzScaleBehavior();
  const items = [
    axisItem(12, 300, 0),
    axisItem(10, 100, 0),
    axisItem(11, 100, 1),
  ];

  items.sort((left, right) => behavior.key(left) - behavior.key(right));

  assert.deepEqual(items.map((item) => item.order), [10, 11, 12]);
  assert.deepEqual(items.map((item) => item.sourceTime), [100, 100, 300]);
});

test("labels are formatted from sourceTime rather than ordinal order", () => {
  const behavior = createOrdinalHorzScaleBehavior();
  configureTimeFormatting(behavior);
  const sourceTime = Date.UTC(2024, 4, 6, 7, 8, 9) / 1000;
  const internal = behavior.convertHorzItemToInternal(axisItem(999_999, sourceTime, 3));

  assert.equal(behavior.formatHorzItem(internal), "2024-05-06   07:08:09");

  let formatterTime = null;
  configureTimeFormatting(behavior, {
    tickMarkFormatter: (time: number) => {
      formatterTime = time;
      return `source:${time}`;
    },
  });
  assert.equal(behavior.formatTickmark(structuralMock<
    Parameters<typeof behavior.formatTickmark>[0]
  >({
    index: 0,
    originalTime: axisItem(999_999, sourceTime, 3),
    time: internal,
    weight: 20,
  }), structuralMock<Parameters<typeof behavior.formatTickmark>[1]>({
    locale: "en-US",
  })), `source:${sourceTime}`);
  assert.equal(formatterTime, sourceTime);
});

test("tick weights follow source-time boundaries while repeated timestamps stay ordinal", () => {
  const behavior = createOrdinalHorzScaleBehavior();
  const midnight = Date.UTC(2024, 0, 2) / 1000;
  const points = [
    axisItem(0, midnight, 0),
    axisItem(1, midnight, 1),
    axisItem(2, midnight + 60, 0),
    axisItem(3, midnight + 24 * 60 * 60, 0),
  ].map((item) => ({
    originalTime: item,
    time: behavior.convertHorzItemToInternal(item),
    timeWeight: 0,
  }));

  behavior.fillWeightsForPoints(structuralMock<
    Parameters<typeof behavior.fillWeightsForPoints>[0]
  >(points), 0);

  assert.deepEqual(points.map((point) => point.timeWeight), [50, 0, 20, 50]);
  assert.equal(behavior.maxTickMarkWeight(structuralMock<
    Parameters<typeof behavior.maxTickMarkWeight>[0]
  >(points.map((point) => ({
    coord: 0,
    label: "",
    needAlignCoordinate: false,
    weight: point.timeWeight,
  })))), 50);
});
