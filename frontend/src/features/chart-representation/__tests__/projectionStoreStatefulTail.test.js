import assert from "node:assert/strict";
import test from "node:test";

import { ProjectionStore } from "../projectionStore.js";
import { KagiProjector } from "../projectors/kagiProjector.js";
import { LineBreakProjector } from "../projectors/lineBreakProjector.js";
import { PointFigureProjector } from "../projectors/pointFigureProjector.js";
import { RenkoProjector } from "../projectors/renkoProjector.js";

function row(time, close) {
  return { time, open: close, high: close, low: close, close, volume: time * 10 };
}

function source(closes) {
  return closes.map((close, index) => row(index + 1, close));
}

function outputOrders(rows) {
  return rows.map((item) => item.time.order);
}

function assertPatch(patch, previousDisplay, expected, fullProjection, message) {
  assert.deepEqual(
    {
      deleteCount: patch.deleteCount,
      fromOutputIndex: patch.fromOutputIndex,
      insertedOrders: outputOrders(patch.insert),
    },
    expected,
    message,
  );
  assert.deepEqual(
    patch.nextData,
    previousDisplay.slice(0, patch.fromOutputIndex).concat(patch.insert),
    `${message}: patch must reconstruct nextData`,
  );
  assert.deepEqual(patch.nextData, fullProjection, `${message}: tail result must match full projection`);
}

class CountingStatefulProjector {
  constructor(projector) {
    this.projector = projector;
    this.id = projector.id;
    this.oneToOne = projector.oneToOne;
    this.supportsStatefulTailProjection = projector.supportsStatefulTailProjection;
    this.projectedRows = 0;
  }

  project(rows, options) {
    return this.projector.project(rows, options);
  }

  projectWithState(rows, options) {
    this.projectedRows += rows?.length || 0;
    return this.projector.projectWithState(rows, options);
  }

  resetCount() {
    this.projectedRows = 0;
  }
}

const PROJECTORS = [
  {
    name: "Renko",
    create: () => new RenkoProjector({ boxSize: 2, minTick: 1 }),
    appendBase: [52, 54],
    appendCases: [
      {
        close: 55,
        expected: { fromOutputIndex: 1, deleteCount: 0, insertedOrders: [] },
        name: "no-op",
      },
      {
        close: 58,
        expected: { fromOutputIndex: 1, deleteCount: 0, insertedOrders: [1, 2] },
        name: "continuation",
      },
      {
        close: 50,
        expected: { fromOutputIndex: 1, deleteCount: 0, insertedOrders: [1] },
        name: "reversal",
      },
    ],
    replaceCases: [
      {
        initial: [52, 58],
        close: 53,
        expected: { fromOutputIndex: 0, deleteCount: 3, insertedOrders: [] },
        name: "deletes retracted bricks",
      },
    ],
  },
  {
    name: "Point & Figure",
    create: () => new PointFigureProjector({ boxSize: 1, minTick: 1, reversalAmount: 3 }),
    appendBase: [10, 13],
    appendCases: [
      {
        close: 12,
        expected: { fromOutputIndex: 1, deleteCount: 0, insertedOrders: [] },
        name: "no-op carry",
      },
      {
        close: 15,
        expected: { fromOutputIndex: 0, deleteCount: 1, insertedOrders: [0] },
        name: "extends active column",
      },
      {
        close: 10,
        expected: { fromOutputIndex: 1, deleteCount: 0, insertedOrders: [1] },
        name: "reversal",
      },
    ],
    replaceCases: [
      {
        initial: [10, 13, 15],
        close: 12,
        expected: { fromOutputIndex: 0, deleteCount: 1, insertedOrders: [0] },
        name: "restores a retracted active extension",
      },
      {
        initial: [10, 13, 10],
        close: 12,
        expected: { fromOutputIndex: 1, deleteCount: 1, insertedOrders: [] },
        name: "deletes a retracted reversal column",
      },
    ],
  },
  {
    name: "Kagi",
    create: () => new KagiProjector({ minTick: 1, reversalTicks: 3 }),
    appendBase: [10, 13],
    appendCases: [
      {
        close: 12,
        expected: { fromOutputIndex: 1, deleteCount: 0, insertedOrders: [] },
        name: "no-op carry",
      },
      {
        close: 15,
        expected: { fromOutputIndex: 0, deleteCount: 1, insertedOrders: [0] },
        name: "extends active leg",
      },
      {
        close: 10,
        expected: { fromOutputIndex: 1, deleteCount: 0, insertedOrders: [1] },
        name: "reversal",
      },
    ],
    replaceCases: [
      {
        initial: [10, 13, 15],
        close: 12,
        expected: { fromOutputIndex: 0, deleteCount: 1, insertedOrders: [0] },
        name: "restores a retracted active extension",
      },
      {
        initial: [10, 13, 10],
        close: 12,
        expected: { fromOutputIndex: 1, deleteCount: 1, insertedOrders: [] },
        name: "deletes a retracted reversal leg",
      },
    ],
  },
  {
    name: "Line Break",
    create: () => new LineBreakProjector({ minTick: 1, numberOfLines: 3 }),
    appendBase: [10, 12, 13, 14],
    appendCases: [
      {
        close: 13,
        expected: { fromOutputIndex: 3, deleteCount: 0, insertedOrders: [] },
        name: "no-op carry",
      },
      {
        close: 15,
        expected: { fromOutputIndex: 3, deleteCount: 0, insertedOrders: [3] },
        name: "up breakout",
      },
      {
        close: 9,
        expected: { fromOutputIndex: 3, deleteCount: 0, insertedOrders: [3] },
        name: "down breakout",
      },
    ],
    replaceCases: [
      {
        initial: [10, 12, 13, 14],
        close: 13,
        expected: { fromOutputIndex: 2, deleteCount: 1, insertedOrders: [] },
        name: "deletes a retracted breakout",
      },
    ],
  },
];

for (const descriptor of PROJECTORS) {
  for (const appendCase of descriptor.appendCases) {
    test(`${descriptor.name} stateful append: ${appendCase.name}`, () => {
      const projector = descriptor.create();
      const store = new ProjectionStore({ projector });
      const initial = source(descriptor.appendBase);
      store.reset(initial);
      const previousDisplay = store.displaySnapshot().slice();
      const next = [...initial, row(initial.length + 1, appendCase.close)];

      const patch = store.applySourceDelta(
        { type: "tick", appended: true, bar: next[next.length - 1] },
        next,
      );

      assertPatch(
        patch,
        previousDisplay,
        appendCase.expected,
        descriptor.create().project(next),
        `${descriptor.name} ${appendCase.name}`,
      );
    });
  }

  for (const replaceCase of descriptor.replaceCases) {
    test(`${descriptor.name} stateful replace-last: ${replaceCase.name}`, () => {
      const projector = descriptor.create();
      const store = new ProjectionStore({ projector });
      const initial = source(replaceCase.initial);
      store.reset(initial);
      const previousDisplay = store.displaySnapshot().slice();
      const next = [
        ...initial.slice(0, -1),
        row(initial.length, replaceCase.close),
      ];

      const patch = store.applySourceDelta(
        { type: "tick", replaced: true, bar: next[next.length - 1] },
        next,
      );

      assertPatch(
        patch,
        previousDisplay,
        replaceCase.expected,
        descriptor.create().project(next),
        `${descriptor.name} ${replaceCase.name}`,
      );
    });
  }
}

for (const descriptor of PROJECTORS) {
  test(`${descriptor.name} projects one row for 100-row append and replace-last`, () => {
    const counting = new CountingStatefulProjector(descriptor.create());
    const store = new ProjectionStore({ projector: counting });
    const initial = Array.from({ length: 100 }, (_, index) => row(index + 1, 100 + index));
    store.reset(initial);

    counting.resetCount();
    const appended = [...initial, row(101, 200)];
    const appendPatch = store.applySourceDelta(
      { type: "tick", appended: true, bar: appended[100] },
      appended,
    );
    assert.equal(counting.projectedRows, 1);
    assert.deepEqual(appendPatch.nextData, descriptor.create().project(appended));

    counting.resetCount();
    const replaced = [...appended.slice(0, -1), row(101, 202)];
    const replacePatch = store.applySourceDelta(
      { type: "tick", replaced: true, bar: replaced[100] },
      replaced,
    );
    assert.equal(counting.projectedRows, 1);
    assert.deepEqual(replacePatch.nextData, descriptor.create().project(replaced));
  });

  test(`${descriptor.name} mid-merge and trim bypass the one-row stateful fast path`, () => {
    const initial = Array.from({ length: 100 }, (_, index) => row(index + 1, 100 + index));

    const midCounting = new CountingStatefulProjector(descriptor.create());
    const midStore = new ProjectionStore({ projector: midCounting });
    midStore.reset(initial);
    midCounting.resetCount();
    const merged = [...initial];
    merged[50] = row(51, 250);
    const midPatch = midStore.applySourceDelta({ type: "mid-merge" }, merged);
    assert.equal(midCounting.projectedRows, merged.length);
    assert.equal(midPatch.fromOutputIndex, 0);
    assert.deepEqual(midPatch.nextData, descriptor.create().project(merged));

    const trimCounting = new CountingStatefulProjector(descriptor.create());
    const trimStore = new ProjectionStore({ projector: trimCounting });
    trimStore.reset(initial);
    trimCounting.resetCount();
    const trimmed = [...initial.slice(1), row(101, 200)];
    const trimPatch = trimStore.applySourceDelta(
      { type: "append", addedRight: 1, trimmedLeft: 1 },
      trimmed,
    );
    assert.equal(trimCounting.projectedRows, trimmed.length);
    assert.equal(trimPatch.fromOutputIndex, 0);
  });
}

function numericIndex(property) {
  return /^(0|[1-9]\d*)$/.test(String(property));
}

function assertDisplayIndexIntegrity(store) {
  const display = store.displaySnapshot();
  const timeSet = store.displayTimeSet();
  assert.equal(store._displayTimeIndex.size, display.length);
  assert.equal(timeSet.size, display.length);
  assert.deepEqual([...timeSet], display.map((item) => item.time));
  [...timeSet].forEach((time, index) => assert.strictEqual(time, display[index].time));
  for (let index = 0; index < display.length; index += 1) {
    assert.equal(store.indexOfDisplayTime(display[index].time), index);
    assert.equal(store.indexOfDisplayTime({ ...display[index].time }), index);
    assert.strictEqual(store.getDisplayByTime(display[index].time), display[index]);
  }
}

test("stateful tail updates keep an independent source array and preserve prior snapshots", () => {
  const store = new ProjectionStore({
    projector: new LineBreakProjector({ minTick: 1, numberOfLines: 3 }),
  });
  const initial = source([10, 12, 13, 14]);
  store.reset(initial);
  const sourceCache = store._source;
  const checkpointCache = store._sourceCheckpoints;
  const oldSnapshot = store.sourceSnapshot();
  const next = [...initial, row(5, 15)];

  store.applySourceDelta({ type: "tick", appended: true }, next);

  assert.strictEqual(store._source, sourceCache);
  assert.strictEqual(store._sourceCheckpoints, checkpointCache);
  assert.deepEqual(oldSnapshot, initial);
  assert.deepEqual(store.sourceSnapshot(), next);
  next[next.length - 1] = row(5, 999);
  assert.equal(store.sourceSnapshot().at(-1).close, 15);
  const callerSnapshot = store.sourceSnapshot();
  callerSnapshot.length = 0;
  assert.equal(store.sourceSnapshot().length, next.length);
});

test("stateful display changes stay copy-on-write while semantic no-ops retain identity", () => {
  const store = new ProjectionStore({
    projector: new LineBreakProjector({ minTick: 1, numberOfLines: 3 }),
  });
  const initial = source([10, 12, 13, 14]);
  store.reset(initial);
  const beforeAppend = store.displaySnapshot();
  const beforeAppendValue = structuredClone(beforeAppend);
  const lineageIndex = store.drawingLineageIndex();
  const beforeAppendRevision = lineageIndex.revision;
  const appended = [...initial, row(5, 15)];

  store.applySourceDelta({ type: "tick", appended: true }, appended);
  const afterAppend = store.displaySnapshot();
  assert.notStrictEqual(afterAppend, beforeAppend);
  assert.deepEqual(beforeAppend, beforeAppendValue);
  assert.strictEqual(store.drawingLineageIndex(), lineageIndex);
  assert.equal(lineageIndex.revision, beforeAppendRevision + 1);

  const noOpRows = [
    ...appended.slice(0, -1),
    { ...appended.at(-1), volume: 9999 },
  ];
  const beforeNoOpRevision = lineageIndex.revision;
  store.applySourceDelta({ type: "tick", replaced: true }, noOpRows);
  assert.strictEqual(store.displaySnapshot(), afterAppend);
  assert.strictEqual(store.drawingLineageIndex(), lineageIndex);
  assert.equal(lineageIndex.revision, beforeNoOpRevision);
});

test("drawing lineage snapshots recover after clearing an ordinal display", () => {
  const store = new ProjectionStore({
    projector: new LineBreakProjector({ minTick: 1, numberOfLines: 3 }),
  });
  store.reset(source([10, 12, 13]));
  assert.ok(store.drawingLineageIndex());

  store.applySourceDelta({ type: "clear" }, []);
  const emptySnapshot = store.drawingCoordinateSnapshot();
  assert.deepEqual(emptySnapshot.seriesData, []);
  assert.equal(emptySnapshot.ordinalSeriesIndex, null);

  const baselineRows = [row(10, 20)];
  store.applySourceDelta({ type: "tick", appended: true }, baselineRows);
  assert.equal(store.drawingCoordinateSnapshot().ordinalSeriesIndex, null);

  const nextRows = [...baselineRows, row(11, 21)];
  store.applySourceDelta({ type: "tick", appended: true }, nextRows);
  const restoredSnapshot = store.drawingCoordinateSnapshot();
  assert.strictEqual(restoredSnapshot.seriesData, store.displaySnapshot());
  assert.strictEqual(
    restoredSnapshot.ordinalSeriesIndex.seriesData,
    restoredSnapshot.seriesData,
  );
  assert.equal(restoredSnapshot.ordinalSeriesIndex.latestLineage, 11);
});

test("stateful tail patches update the private time index and lazily version the public time set", () => {
  const store = new ProjectionStore({
    projector: new LineBreakProjector({ minTick: 1, numberOfLines: 3 }),
  });
  const initial = source([10, 12, 13, 14]);
  store.reset(initial);
  const oldDisplay = store.displaySnapshot();
  const oldLastTime = oldDisplay.at(-1).time;
  const oldTimeSet = store.displayTimeSet();
  const originalClear = store._displayTimeIndex.clear;
  store._displayTimeIndex.clear = () => assert.fail("tail patch rebuilt the full time index");
  const replaced = [...initial.slice(0, -1), row(4, 13)];

  store.applySourceDelta({ type: "tick", replaced: true }, replaced);

  store._displayTimeIndex.clear = originalClear;
  assert.equal(store.indexOfDisplayTime(oldLastTime), -1);
  assert.equal(oldTimeSet.size, oldDisplay.length);
  const nextTimeSet = store.displayTimeSet();
  assert.notStrictEqual(nextTimeSet, oldTimeSet);
  assert.strictEqual(store.displayTimeSet(), nextTimeSet);
  assertDisplayIndexIntegrity(store);
});

test("a malformed projector with duplicate display orders never enters the incremental index path", () => {
  const projector = {
    oneToOne: false,
    projectedRows: 0,
    supportsStatefulTailProjection: true,
    project(rows, options) {
      return this.projectWithState(rows, options).data;
    },
    projectWithState(rows) {
      this.projectedRows += rows.length;
      return {
        checkpoints: rows.map((_, index) => ({ nextOrder: index })),
        data: rows.map((item, index) => ({
          ...item,
          time: {
            order: index === 2 ? 1 : index,
            sourceOrdinal: 0,
            sourceTime: item.time,
          },
        })),
        state: { nextOrder: rows.length },
      };
    },
  };
  const store = new ProjectionStore({ projector });
  const initial = source([10, 12, 14]);
  store.reset(initial);
  projector.projectedRows = 0;
  const next = [...initial.slice(0, -1), row(3, 16)];

  const patch = store.applySourceDelta({ type: "tick", replaced: true }, next);

  assert.equal(projector.projectedRows, next.length);
  assert.equal(patch.fromOutputIndex, 0);
  assert.equal(store.indexOfDisplayTime({ order: 1 }), 2);
});

test("throwing tail time accessors fall back before committing partial index state", () => {
  const projector = {
    calls: 0,
    oneToOne: false,
    supportsStatefulTailProjection: true,
    project(rows, options) {
      return this.projectWithState(rows, options).data;
    },
    projectWithState(rows, { seedState = null } = {}) {
      this.calls += 1;
      const startOrder = seedState?.nextOrder || 0;
      const data = rows.map((item, index) => ({
        ...item,
        time: {
          order: startOrder + index,
          sourceOrdinal: 0,
          sourceTime: item.time,
        },
      }));
      if (this.calls === 2 && data.length > 0) {
        const time = data[0].time;
        let reads = 0;
        Object.defineProperty(data[0], "time", {
          configurable: true,
          get() {
            reads += 1;
            if (reads >= 4) throw new Error("time getter failed");
            return time;
          },
        });
      }
      return {
        checkpoints: rows.map((_, index) => ({ nextOrder: startOrder + index })),
        data,
        state: { nextOrder: startOrder + rows.length },
      };
    },
  };
  const store = new ProjectionStore({ projector });
  const initial = source([10, 12]);
  store.reset(initial);
  const next = [...initial, row(3, 14)];

  const patch = store.applySourceDelta({ type: "tick", appended: true }, next);

  assert.equal(projector.calls, 3);
  assert.equal(patch.fromOutputIndex, 0);
  assert.deepEqual(store.sourceSnapshot(), next);
  assertDisplayIndexIntegrity(store);
});

for (const operation of ["append", "replace"]) {
  test(`stateful ${operation} reads only a constant-sized source/checkpoint tail`, () => {
    const size = 2000;
    const store = new ProjectionStore({
      projector: new LineBreakProjector({ minTick: 1, numberOfLines: 3 }),
    });
    const initial = Array.from({ length: size }, (_, index) => row(index + 1, 100 + index));
    store.reset(initial);
    let sourceReads = 0;
    let checkpointReads = 0;
    let displayTimeReads = 0;
    const checkpointCache = new Proxy(store._sourceCheckpoints, {
      get(target, property, receiver) {
        if (numericIndex(property)) checkpointReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    store._sourceCheckpoints = checkpointCache;
    store._display = store._display.map((item) => new Proxy(item, {
      get(target, property, receiver) {
        if (property === "time") displayTimeReads += 1;
        return Reflect.get(target, property, receiver);
      },
    }));
    // This test intentionally replaces the store's private display array to
    // instrument reads. Keep the projection-owned drawing lookup on that same
    // array identity, then measure only the following realtime tail update.
    store._drawingLineageIndex.reset(store._display);
    const drawingLineageIndex = store.drawingLineageIndex();
    const drawingLineageRevision = drawingLineageIndex.revision;
    displayTimeReads = 0;
    const next = operation === "append"
      ? [...initial, row(size + 1, 100 + size)]
      : [...initial.slice(0, -1), row(size, 100 + size + 5)];
    const observedRows = new Proxy(next, {
      get(target, property, receiver) {
        if (numericIndex(property)) sourceReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    store.applySourceDelta(
      operation === "append"
        ? { type: "tick", appended: true }
        : { type: "tick", replaced: true },
      observedRows,
    );

    assert.ok(sourceReads < 20, `read ${sourceReads} source rows`);
    assert.ok(checkpointReads < 4, `read ${checkpointReads} checkpoints`);
    assert.ok(displayTimeReads < 64, `read ${displayTimeReads} display times`);
    assert.strictEqual(store._sourceCheckpoints, checkpointCache);
    assert.strictEqual(store.drawingLineageIndex(), drawingLineageIndex);
    assert.strictEqual(drawingLineageIndex.seriesData, store.displaySnapshot());
    assert.equal(drawingLineageIndex.revision, drawingLineageRevision + 1);
    assertDisplayIndexIntegrity(store);
  });
}

for (const descriptor of PROJECTORS) {
  test(`${descriptor.name} projects only a multi-row append tail`, () => {
    const counting = new CountingStatefulProjector(descriptor.create());
    const store = new ProjectionStore({ projector: counting });
    const initial = source(descriptor.appendBase);
    store.reset(initial);
    counting.resetCount();
    const lastClose = descriptor.appendBase[descriptor.appendBase.length - 1];
    const next = [
      ...initial,
      row(initial.length + 1, lastClose + 6),
      row(initial.length + 2, lastClose - 8),
    ];

    const patch = store.applySourceDelta({ type: "append", addedRight: 2 }, next);

    assert.equal(counting.projectedRows, 2);
    assert.deepEqual(patch.nextData, descriptor.create().project(next));
  });
}

function deterministicRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = ((state * 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

for (const [descriptorIndex, descriptor] of PROJECTORS.entries()) {
  test(`${descriptor.name} repeated append and replace-last stays full-projection equivalent`, () => {
    const random = deterministicRandom(0x5eed + descriptorIndex);
    const store = new ProjectionStore({ projector: descriptor.create() });
    let current = source(descriptor.appendBase);
    store.reset(current);

    for (let operation = 0; operation < 160; operation += 1) {
      const previousDisplay = store.displaySnapshot();
      const close = 85 + Math.floor(random() * 40);
      if (random() < 0.65) {
        current = [...current.slice(0, -1), row(current.length, close)];
        store.applySourceDelta(
          { type: "tick", replaced: true, bar: current[current.length - 1] },
          current,
        );
      } else {
        current = [...current, row(current.length + 1, close)];
        store.applySourceDelta(
          { type: "tick", appended: true, bar: current[current.length - 1] },
          current,
        );
      }
      assert.deepEqual(
        store.displaySnapshot(),
        descriptor.create().project(current),
        `${descriptor.name} diverged after operation ${operation}`,
      );
      assertDisplayIndexIntegrity(store);
      const retainedOrders = new Set(outputOrders(store.displaySnapshot()));
      for (const previousRow of previousDisplay) {
        if (!retainedOrders.has(previousRow.time.order)) {
          assert.equal(store.indexOfDisplayTime(previousRow.time), -1);
        }
      }
    }
  });
}

test("a mismatched append seam falls back to a full stateful projection", () => {
  const counting = new CountingStatefulProjector(
    new LineBreakProjector({ minTick: 1, numberOfLines: 3 }),
  );
  const store = new ProjectionStore({ projector: counting });
  const initial = source([10, 12, 13, 14]);
  store.reset(initial);
  counting.resetCount();
  const next = [
    ...initial.slice(0, -1),
    row(4, 9),
    row(5, 8),
  ];

  const patch = store.applySourceDelta({ type: "append", addedRight: 1 }, next);

  assert.equal(counting.projectedRows, next.length);
  assert.equal(patch.fromOutputIndex, 0);
  assert.deepEqual(patch.nextData, new LineBreakProjector({ minTick: 1 }).project(next));
});

test("semantic metadata changes are not hidden by an unchanged synthetic order and OHLC", () => {
  const projector = new LineBreakProjector({ minTick: 1, numberOfLines: 3 });
  const store = new ProjectionStore({ projector });
  const initial = [
    row(1, 10),
    { ...row(2, 12), customValues: { nested: { revision: "old" } } },
  ];
  store.reset(initial);
  const next = [
    initial[0],
    { ...row(2, 12), customValues: { nested: { revision: "new" } } },
  ];

  const patch = store.applySourceDelta(
    { type: "tick", replaced: true, bar: next[1] },
    next,
  );

  assert.equal(patch.fromOutputIndex, 0);
  assert.equal(patch.deleteCount, 1);
  assert.equal(patch.insert.length, 1);
  assert.equal(patch.insert[0].customValues.nested.revision, "new");
});

test("cyclic metadata with different graph topology is not reused as a common prefix", () => {
  const oldGraph = { label: "head" };
  oldGraph.next = oldGraph;
  const newGraph = { label: "head" };
  const newTail = { label: "head" };
  newGraph.next = newTail;
  newTail.next = newTail;
  const projector = new LineBreakProjector({ minTick: 1, numberOfLines: 3 });
  const store = new ProjectionStore({ projector });
  const initial = [
    row(1, 10),
    { ...row(2, 12), customValues: { graph: oldGraph } },
  ];
  store.reset(initial);
  const next = [
    initial[0],
    { ...row(2, 12), customValues: { graph: newGraph } },
  ];

  const patch = store.applySourceDelta(
    { type: "tick", replaced: true, bar: next[1] },
    next,
  );

  assert.equal(patch.fromOutputIndex, 0);
  assert.equal(patch.deleteCount, 1);
  assert.equal(patch.insert.length, 1);
  assert.notStrictEqual(
    patch.insert[0].customValues.graph.next,
    patch.insert[0].customValues.graph,
  );
  assert.strictEqual(
    patch.insert[0].customValues.graph.next.next,
    patch.insert[0].customValues.graph.next,
  );
});

test("a volume-only source tick becomes a no-op when Line Break semantics are unchanged", () => {
  const projector = new LineBreakProjector({ minTick: 1, numberOfLines: 3 });
  const store = new ProjectionStore({ projector });
  const initial = source([10, 12]);
  store.reset(initial);
  const next = [initial[0], { ...initial[1], volume: 999 }];

  const patch = store.applySourceDelta(
    { type: "tick", replaced: true, bar: next[1] },
    next,
  );

  assert.equal(patch.fromOutputIndex, 1);
  assert.equal(patch.deleteCount, 0);
  assert.deepEqual(patch.insert, []);
});

for (const descriptor of PROJECTORS) {
  test(`${descriptor.name} keeps hidden trim seed state across later tail deltas`, () => {
    const fastCounting = new CountingStatefulProjector(descriptor.create());
    const fastStore = new ProjectionStore({ projector: fastCounting });
    const referenceProjector = new CountingStatefulProjector(descriptor.create());
    referenceProjector.supportsStatefulTailProjection = false;
    const referenceStore = new ProjectionStore({ projector: referenceProjector });
    const initial = Array.from({ length: 40 }, (_, index) => (
      row(index + 1, 100 + Math.round(Math.sin(index / 2) * 18))
    ));
    fastStore.reset(initial);
    referenceStore.reset(initial);
    const retained = initial.slice(20);
    fastStore.applySourceDelta({ type: "trim-left", trimmedLeft: 20 }, retained);
    referenceStore.applySourceDelta({ type: "trim-left", trimmedLeft: 20 }, retained);

    fastCounting.resetCount();
    const appended = [...retained, row(41, 135)];
    fastStore.applySourceDelta({ type: "tick", appended: true }, appended);
    referenceStore.applySourceDelta({ type: "tick", appended: true }, appended);
    assert.equal(fastCounting.projectedRows, 1);
    assert.deepEqual(fastStore.displaySnapshot(), referenceStore.displaySnapshot());

    fastCounting.resetCount();
    const replaced = [...appended.slice(0, -1), row(41, 70)];
    fastStore.applySourceDelta({ type: "tick", replaced: true }, replaced);
    referenceStore.applySourceDelta({ type: "tick", replaced: true }, replaced);
    assert.equal(fastCounting.projectedRows, 1);
    assert.deepEqual(fastStore.displaySnapshot(), referenceStore.displaySnapshot());
  });

  test(`${descriptor.name} appends incrementally after the visible source was trimmed empty`, () => {
    const fastCounting = new CountingStatefulProjector(descriptor.create());
    const fastStore = new ProjectionStore({ projector: fastCounting });
    const referenceProjector = new CountingStatefulProjector(descriptor.create());
    referenceProjector.supportsStatefulTailProjection = false;
    const referenceStore = new ProjectionStore({ projector: referenceProjector });
    const initial = source(descriptor.appendBase);
    fastStore.reset(initial);
    referenceStore.reset(initial);
    fastStore.applySourceDelta(
      { type: "trim-left", trimmedLeft: initial.length },
      [],
    );
    referenceStore.applySourceDelta(
      { type: "trim-left", trimmedLeft: initial.length },
      [],
    );

    fastCounting.resetCount();
    const next = [row(initial.length + 1, 150)];
    fastStore.applySourceDelta({ type: "tick", appended: true }, next);
    referenceStore.applySourceDelta({ type: "tick", appended: true }, next);

    assert.equal(fastCounting.projectedRows, 1);
    assert.deepEqual(fastStore.displaySnapshot(), referenceStore.displaySnapshot());
  });
}
