import assert from "node:assert/strict";
import test from "node:test";

import { ProjectionStore } from "../projectionStore.js";
import { HeikinAshiProjector } from "../projectors/heikinAshiProjector.js";
import { IdentityProjector } from "../projectors/identityProjector.js";
import { KagiProjector } from "../projectors/kagiProjector.js";
import { LineBreakProjector } from "../projectors/lineBreakProjector.js";
import { PointFigureProjector } from "../projectors/pointFigureProjector.js";
import { RenkoProjector } from "../projectors/renkoProjector.js";
import { isOrdinalAxisTime } from "../axisTime.js";
import type {
  DisplayRow,
  OrdinalAxisTime,
  ProjectionProjectOptions,
  Projector,
  SourceBar,
} from "../chartRepresentationTypes.js";
import { malformedFixture, mustBeDefined } from "../../../test/testHelpers.js";

function row(time: number, overrides: Partial<SourceBar> = {}): SourceBar {
  return {
    time,
    open: time,
    high: time + 5,
    low: time - 3,
    close: time + 2,
    volume: time * 10,
    ...overrides,
  };
}

function rows(times: number[]): SourceBar[] {
  return times.map((time) => row(time));
}

function ohlc(data: readonly (SourceBar | DisplayRow)[]) {
  return data.map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume }));
}

function ordinalTime(item: DisplayRow): OrdinalAxisTime {
  if (!isOrdinalAxisTime(item.time)) throw new Error("Expected ordinal display time");
  return item.time;
}

class CountingHeikinAshiProjector extends HeikinAshiProjector {
  projectedRows: number;

  constructor() {
    super();
    this.projectedRows = 0;
  }

  project(
    nextRows: readonly SourceBar[] = [],
    options: ProjectionProjectOptions = {},
  ): DisplayRow[] {
    this.projectedRows += nextRows.length;
    return super.project(nextRows, options);
  }
}

test("tick replacement reprojects only the HA tail and returns a replace-tail patch", () => {
  const projector = new CountingHeikinAshiProjector();
  const store = new ProjectionStore({ projector });
  const source = rows([10, 20, 30]);
  store.reset(source);
  projector.projectedRows = 0;
  const next = [...source.slice(0, -1), row(30, { close: 41 })];

  const patch = store.applySourceDelta({ type: "tick", replaced: true, bar: next[2] }, next);

  assert.equal(projector.projectedRows, 1);
  assert.deepEqual(
    { kind: patch.kind, fromOutputIndex: patch.fromOutputIndex, deleteCount: patch.deleteCount, previousLength: patch.previousLength, nextLength: patch.nextLength },
    { kind: "replace-tail", fromOutputIndex: 2, deleteCount: 1, previousLength: 3, nextLength: 3 },
  );
  assert.equal(patch.insert.length, 1);
  assert.deepEqual(ohlc(patch.nextData), ohlc(new HeikinAshiProjector().project(next)));
});

test("multi-row append projects only the added HA tail", () => {
  const projector = new CountingHeikinAshiProjector();
  const store = new ProjectionStore({ projector });
  const initial = rows([10, 20]);
  const next = rows([10, 20, 30, 40]);
  store.reset(initial);
  projector.projectedRows = 0;

  const patch = store.applySourceDelta({ type: "append", addedRight: 2 }, next);

  assert.equal(projector.projectedRows, 2);
  assert.equal(patch.fromOutputIndex, 2);
  assert.equal(patch.deleteCount, 0);
  assert.equal(patch.insert.length, 2);
  assert.deepEqual(ohlc(patch.nextData), ohlc(new HeikinAshiProjector().project(next)));
});

test("appended realtime tick projects exactly one HA row", () => {
  const projector = new CountingHeikinAshiProjector();
  const store = new ProjectionStore({ projector });
  const initial = rows([10, 20]);
  const next = rows([10, 20, 30]);
  store.reset(initial);
  projector.projectedRows = 0;

  const patch = store.applySourceDelta({ type: "tick", appended: true, bar: next[2] }, next);

  assert.equal(projector.projectedRows, 1);
  assert.equal(patch.fromOutputIndex, 2);
  assert.equal(patch.deleteCount, 0);
  assert.deepEqual(ohlc(patch.nextData), ohlc(new HeikinAshiProjector().project(next)));
});

test("HA tail projection carries state across whitespace rows", () => {
  const projector = new CountingHeikinAshiProjector();
  const store = new ProjectionStore({ projector });
  const initial = [row(10), { time: 20, __whitespace: true }];
  const next = [...initial, row(30)];
  store.reset(initial);
  projector.projectedRows = 0;

  const patch = store.applySourceDelta({ type: "tick", appended: true }, next);

  assert.equal(projector.projectedRows, 1);
  assert.deepEqual(ohlc(patch.nextData), ohlc(new HeikinAshiProjector().project(next)));
});

test("mid-window correction safely reprojects from the first changed source row", () => {
  const store = new ProjectionStore({ projector: new HeikinAshiProjector() });
  const source = rows([10, 20, 30, 40]);
  store.reset(source);
  const next = [...source];
  next[1] = row(20, { close: 35 });

  const patch = store.applySourceDelta({ type: "mid-merge" }, next);

  assert.equal(patch.fromOutputIndex, 1);
  assert.equal(patch.deleteCount, 3);
  assert.deepEqual(ohlc(patch.nextData), ohlc(new HeikinAshiProjector().project(next)));
});

test("prepend safely recomputes HA from the new beginning", () => {
  const store = new ProjectionStore({ projector: new HeikinAshiProjector() });
  store.reset(rows([30, 40]));
  const next = rows([10, 20, 30, 40]);

  const patch = store.applySourceDelta({ type: "prepend", addedLeft: 2 }, next);

  assert.equal(patch.fromOutputIndex, 0);
  assert.equal(patch.deleteCount, 2);
  assert.deepEqual(ohlc(patch.nextData), ohlc(new HeikinAshiProjector().project(next)));
});

test("left-trim append retains the existing HA anchor and projects only the new tail", () => {
  const projector = new CountingHeikinAshiProjector();
  const store = new ProjectionStore({ projector });
  const initial = rows([10, 20, 30, 40]);
  store.reset(initial);
  const before = store.displaySnapshot().slice();
  projector.projectedRows = 0;
  const next = rows([20, 30, 40, 50]);

  const patch = store.applySourceDelta({ type: "append", addedRight: 1, trimmedLeft: 1 }, next);

  assert.equal(projector.projectedRows, 1);
  assert.equal(patch.fromOutputIndex, 0);
  assert.deepEqual(ohlc(patch.nextData.slice(0, 3)), ohlc(before.slice(1)));
  assert.notEqual(
    mustBeDefined(patch.nextData[0]).open,
    mustBeDefined(new HeikinAshiProjector().project(next)[0]).open,
  );
  const expectedTail = projector.project(
    [mustBeDefined(next[3])],
    { previousDisplayRow: mustBeDefined(before[3]) },
  );
  assert.deepEqual(ohlc(patch.nextData.slice(3)), ohlc(expectedTail));
});

test("identity projection remains source-equivalent across reset, append and lookup", () => {
  const store = new ProjectionStore({ projector: new IdentityProjector() });
  const initial = rows([10, 20]);
  store.reset(initial);
  const next = rows([10, 20, 30]);
  const patch = store.applySourceDelta({ type: "tick", appended: true, bar: next[2] }, next);

  assert.deepEqual(ohlc(patch.nextData), ohlc(next));
  assert.deepEqual(store.sourceSnapshot(), next);
  assert.equal(store.indexOfDisplayTime(20), 1);
  assert.equal(mustBeDefined(store.getDisplayByTime(30)).close, 32);
  assert.deepEqual([...store.displayTimeSet()], [10, 20, 30]);
});

test("drawing coordinate snapshots atomically version the numeric source horizon", () => {
  const store = new ProjectionStore({ projector: new IdentityProjector() });
  const emptySnapshot = store.drawingCoordinateSnapshot();
  assert.equal(emptySnapshot.sourceTimeHorizon, null);
  assert.deepEqual(emptySnapshot.seriesData, []);

  const initial = rows([10, 20]);
  store.reset(initial);
  const resetSnapshot = store.drawingCoordinateSnapshot();
  assert.equal(resetSnapshot.sourceTimeHorizon, 20);
  assert.strictEqual(resetSnapshot.seriesData, store.displaySnapshot());

  const replaced = [initial[0], row(20, { close: 41 })];
  store.applySourceDelta({ type: "tick", replaced: true }, replaced);
  const replacedSnapshot = store.drawingCoordinateSnapshot();
  assert.equal(replacedSnapshot.sourceTimeHorizon, 20);
  assert.strictEqual(replacedSnapshot.seriesData, store.displaySnapshot());

  const appended = [...replaced, row(30)];
  store.applySourceDelta({ type: "tick", appended: true }, appended);
  const appendedSnapshot = store.drawingCoordinateSnapshot();
  assert.equal(appendedSnapshot.sourceTimeHorizon, 30);
  assert.strictEqual(appendedSnapshot.seriesData, store.displaySnapshot());

  const trimmedLeft = appended.slice(1);
  store.applySourceDelta({ type: "trim-left", trimmedLeft: 1 }, trimmedLeft);
  const leftTrimSnapshot = store.drawingCoordinateSnapshot();
  assert.equal(leftTrimSnapshot.sourceTimeHorizon, 30);
  assert.strictEqual(leftTrimSnapshot.seriesData, store.displaySnapshot());

  const trimmedRight = trimmedLeft.slice(0, -1);
  store.applySourceDelta({ type: "trim-right", trimmedRight: 1 }, trimmedRight);
  const rightTrimSnapshot = store.drawingCoordinateSnapshot();
  assert.equal(rightTrimSnapshot.sourceTimeHorizon, 20);
  assert.strictEqual(rightTrimSnapshot.seriesData, store.displaySnapshot());

  store.applySourceDelta({ type: "clear" }, []);
  assert.equal(store.drawingCoordinateSnapshot().sourceTimeHorizon, null);

  // Previously returned snapshots retain primitive horizon values and their
  // versioned display arrays after later tail mutations.
  assert.equal(resetSnapshot.sourceTimeHorizon, 20);
  assert.equal(
    mustBeDefined(resetSnapshot.seriesData.at(-1)).close,
    mustBeDefined(initial.at(-1)).close,
  );
  assert.equal(appendedSnapshot.sourceTimeHorizon, 30);
  assert.equal(leftTrimSnapshot.sourceTimeHorizon, 30);
});

test("drawing coordinate horizon ignores non-numeric and non-finite source tail times", () => {
  const store = new ProjectionStore({ projector: new IdentityProjector() });
  store.reset([
    row(10),
    malformedFixture<SourceBar>({ ...row(20), time: "20" }),
    { ...row(30), time: Number.NaN },
  ]);

  assert.equal(store.drawingCoordinateSnapshot().sourceTimeHorizon, 10);
});

test("clear emits a full replace-tail deletion", () => {
  const store = new ProjectionStore();
  store.reset(rows([10, 20]));

  const patch = store.applySourceDelta({ type: "clear" }, []);

  assert.equal(patch.fromOutputIndex, 0);
  assert.equal(patch.deleteCount, 2);
  assert.equal(patch.nextLength, 0);
  assert.deepEqual(patch.nextData, []);
});

test("ordinal display rows can be looked up with an equivalent axis item", () => {
  const projector: Projector = {
    id: "ordinal-lookup-test",
    oneToOne: false,
    project: (source = []) => source.map((item, index) => ({
      ...item,
      time: { order: index, sourceTime: item.time, sourceOrdinal: 0 },
    })),
  };
  const store = new ProjectionStore({ projector });
  store.reset(rows([10, 20]));

  assert.equal(store.indexOfDisplayTime({ order: 1, sourceTime: 20, sourceOrdinal: 0 }), 1);
  assert.equal(
    store.resolveDisplayAnchorIndex({ order: 0, sourceTime: 20, sourceOrdinal: 0 }),
    1,
  );
  assert.equal(
    mustBeDefined(store.getDisplayByTime({ order: 0, sourceTime: 10, sourceOrdinal: 0 })).close,
    12,
  );
});

test("non-one-to-one projectors fall back to a correct full projection", () => {
  const projector: Projector = {
    id: "fanout-test",
    oneToOne: false,
    project: (source = []) => source.flatMap((item, sourceIndex) => [0, 1].map((sourceOrdinal) => ({
      ...item,
      time: {
        order: sourceIndex * 2 + sourceOrdinal,
        sourceTime: item.time,
        sourceOrdinal,
      },
    }))),
  };
  const store = new ProjectionStore({ projector });
  store.reset(rows([10, 20]));

  const patch = store.applySourceDelta(
    { type: "tick", appended: true },
    rows([10, 20, 30]),
  );

  assert.equal(patch.fromOutputIndex, 0);
  assert.equal(patch.deleteCount, 4);
  assert.equal(patch.nextLength, 6);
  assert.deepEqual(
    patch.nextData.map((item) => {
      const time = ordinalTime(item);
      return [time.order, time.sourceTime, time.sourceOrdinal];
    }),
    [[0, 10, 0], [1, 10, 1], [2, 20, 0], [3, 20, 1], [4, 30, 0], [5, 30, 1]],
  );
});

test("stateful non-one-to-one projection keeps its path seed across trim-left", () => {
  const store = new ProjectionStore({
    projector: new RenkoProjector({ boxSize: 2, minTick: 1 }),
  });
  const source = [
    row(1, { open: 52, high: 52, low: 52, close: 52 }),
    row(2, { open: 54, high: 54, low: 54, close: 54 }),
    row(3, { open: 51, high: 51, low: 51, close: 51 }),
    row(4, { open: 50, high: 50, low: 50, close: 50 }),
    row(5, { open: 48, high: 48, low: 48, close: 48 }),
  ];
  store.reset(source);

  const patch = store.applySourceDelta(
    { type: "trim-left", trimmedLeft: 2 },
    source.slice(2),
  );

  assert.equal(patch.fromOutputIndex, 0);
  assert.deepEqual(
    patch.nextData.map((point) => {
      const time = ordinalTime(point);
      return [point.open, point.close, time.order, time.sourceTime];
    }),
    [[52, 50, 1, 4], [50, 48, 2, 5]],
  );
});

test("stateful projection can trim the entire source prefix and append from final checkpoint", () => {
  const store = new ProjectionStore({
    projector: new RenkoProjector({ boxSize: 2, minTick: 1 }),
  });
  const initial = [
    row(1, { open: 52, high: 52, low: 52, close: 52 }),
    row(2, { open: 54, high: 54, low: 54, close: 54 }),
  ];
  store.reset(initial);
  const next = [row(3, { open: 56, high: 56, low: 56, close: 56 })];

  const patch = store.applySourceDelta(
    { type: "append", addedRight: 1, trimmedLeft: 2 },
    next,
  );

  assert.deepEqual(
    patch.nextData.map((point) => [point.open, point.close, ordinalTime(point).order]),
    [[54, 56, 1]],
  );
});

test("Point & Figure trim-left carries an unchanged active column", () => {
  const store = new ProjectionStore({
    projector: new PointFigureProjector({ boxSize: 1, minTick: 1 }),
  });
  const source = [
    row(1, { open: 10, high: 10, low: 10, close: 10 }),
    row(2, { open: 13, high: 13, low: 13, close: 13 }),
    row(3, { open: 12, high: 12, low: 12, close: 12 }),
    row(4, { open: 12, high: 12, low: 12, close: 12 }),
  ];
  store.reset(source);

  const patch = store.applySourceDelta(
    { type: "trim-left", trimmedLeft: 2 },
    source.slice(2),
  );

  assert.deepEqual(
    patch.nextData.map((point) => [
      point.open,
      point.high,
      point.low,
      point.close,
      ordinalTime(point).order,
    ]),
    [[11, 13, 11, 13, 0]],
  );
});

test("Point & Figure trim-left keeps the active extreme for extension and exact reversal", () => {
  const projector = new PointFigureProjector({ boxSize: 1, minTick: 1 });
  const store = new ProjectionStore({ projector });
  const initial = [
    row(1, { open: 10, high: 10, low: 10, close: 10 }),
    row(2, { open: 13, high: 13, low: 13, close: 13 }),
  ];
  store.reset(initial);
  const extended = [
    row(3, { open: 15, high: 15, low: 15, close: 15 }),
    row(4, { open: 12, high: 12, low: 12, close: 12 }),
  ];

  const patch = store.applySourceDelta(
    { type: "append", addedRight: 2, trimmedLeft: 2 },
    extended,
  );

  assert.deepEqual(
    patch.nextData.map((point) => [
      point.open,
      point.high,
      point.low,
      point.close,
      ordinalTime(point).order,
    ]),
    [
      [11, 15, 11, 15, 0],
      [14, 14, 12, 12, 1],
    ],
  );
});

test("Point & Figure trim-left clears display when the source window becomes empty", () => {
  const store = new ProjectionStore({
    projector: new PointFigureProjector({ boxSize: 1, minTick: 1 }),
  });
  const source = [
    row(1, { open: 10, high: 10, low: 10, close: 10 }),
    row(2, { open: 13, high: 13, low: 13, close: 13 }),
  ];
  store.reset(source);

  const patch = store.applySourceDelta(
    { type: "trim-left", trimmedLeft: source.length },
    [],
  );

  assert.deepEqual(patch.nextData, []);
  assert.equal(patch.nextLength, 0);
});

test("Kagi trim-left carries an unchanged active leg", () => {
  const store = new ProjectionStore({
    projector: new KagiProjector({ minTick: 1, reversalTicks: 3 }),
  });
  const source = [
    row(1, { open: 10, high: 10, low: 10, close: 10 }),
    row(2, { open: 15, high: 15, low: 15, close: 15 }),
    row(3, { open: 14, high: 14, low: 14, close: 14 }),
    row(4, { open: 13, high: 13, low: 13, close: 13 }),
  ];
  store.reset(source);

  const patch = store.applySourceDelta(
    { type: "trim-left", trimmedLeft: 2 },
    source.slice(2),
  );

  assert.deepEqual(
    patch.nextData.map((point) => [point.open, point.close, ordinalTime(point).order]),
    [[10, 15, 0]],
  );
});

test("Kagi checkpoints retain shoulder state and split a post-trim breakout leg", () => {
  const store = new ProjectionStore({
    projector: new KagiProjector({ minTick: 1, reversalTicks: 3 }),
  });
  const initial = [
    row(1, { open: 10, high: 10, low: 10, close: 10 }),
    row(2, { open: 15, high: 15, low: 15, close: 15 }),
    row(3, { open: 11, high: 11, low: 11, close: 11 }),
  ];
  store.reset(initial);
  const next = [row(4, { open: 16, high: 16, low: 16, close: 16 })];

  const patch = store.applySourceDelta(
    { type: "append", addedRight: 1, trimmedLeft: initial.length },
    next,
  );

  assert.deepEqual(
    patch.nextData.map((point) => [point.open, point.close, ordinalTime(point).order]),
    [[15, 11, 1], [11, 16, 2]],
  );
  const kagi = mustBeDefined(mustBeDefined(patch.nextData[1]).customValues).kagi;
  assert.ok(kagi && typeof kagi === "object" && "sections" in kagi);
  assert.deepEqual(kagi.sections, [
    { from: 11, to: 15, style: "yin" },
    { from: 15, to: 16, style: "yang" },
  ]);
});

test("Kagi trim-left clears display when the source window becomes empty", () => {
  const store = new ProjectionStore({
    projector: new KagiProjector({ minTick: 1, reversalTicks: 3 }),
  });
  const source = [
    row(1, { open: 10, high: 10, low: 10, close: 10 }),
    row(2, { open: 15, high: 15, low: 15, close: 15 }),
  ];
  store.reset(source);

  const patch = store.applySourceDelta(
    { type: "trim-left", trimmedLeft: source.length },
    [],
  );

  assert.deepEqual(patch.nextData, []);
  assert.equal(patch.nextLength, 0);
});

test("Line Break trim-left carries the latest line and preserves the N-line threshold", () => {
  const store = new ProjectionStore({
    projector: new LineBreakProjector({ minTick: 1, numberOfLines: 3 }),
  });
  const source = [
    row(1, { open: 10, high: 10, low: 10, close: 10 }),
    row(2, { open: 12, high: 12, low: 12, close: 12 }),
    row(3, { open: 13, high: 13, low: 13, close: 13 }),
    row(4, { open: 14, high: 14, low: 14, close: 14 }),
    row(5, { open: 13, high: 13, low: 13, close: 13 }),
    row(6, { open: 12, high: 12, low: 12, close: 12 }),
    row(7, { open: 9, high: 9, low: 9, close: 9 }),
  ];
  store.reset(source);

  const patch = store.applySourceDelta(
    { type: "trim-left", trimmedLeft: 4 },
    source.slice(4),
  );

  assert.deepEqual(
    patch.nextData.map((point) => [point.open, point.close, ordinalTime(point).order]),
    [[13, 14, 2], [13, 9, 3]],
  );
  assert.deepEqual(mustBeDefined(mustBeDefined(patch.nextData[1]).customValues).lineBreak, {
    direction: "down",
    numberOfLines: 3,
    source: "close",
    referenceHigh: 14,
    referenceLow: 10,
  });
});

test("Line Break can trim the entire source and append from final state", () => {
  const store = new ProjectionStore({
    projector: new LineBreakProjector({ minTick: 1, numberOfLines: 3 }),
  });
  const initial = [
    row(1, { open: 10, high: 10, low: 10, close: 10 }),
    row(2, { open: 12, high: 12, low: 12, close: 12 }),
    row(3, { open: 13, high: 13, low: 13, close: 13 }),
  ];
  store.reset(initial);
  const next = [row(4, { open: 14, high: 14, low: 14, close: 14 })];

  const patch = store.applySourceDelta(
    { type: "append", addedRight: 1, trimmedLeft: initial.length },
    next,
  );

  assert.deepEqual(
    patch.nextData.map((point) => [point.open, point.close, ordinalTime(point).order]),
    [[12, 13, 1], [13, 14, 2]],
  );
});

test("Line Break trim-left clears display when the source window becomes empty", () => {
  const store = new ProjectionStore({
    projector: new LineBreakProjector({ minTick: 1, numberOfLines: 3 }),
  });
  const source = [
    row(1, { open: 10, high: 10, low: 10, close: 10 }),
    row(2, { open: 12, high: 12, low: 12, close: 12 }),
  ];
  store.reset(source);

  const patch = store.applySourceDelta(
    { type: "trim-left", trimmedLeft: source.length },
    [],
  );

  assert.deepEqual(patch.nextData, []);
  assert.equal(patch.nextLength, 0);
});
