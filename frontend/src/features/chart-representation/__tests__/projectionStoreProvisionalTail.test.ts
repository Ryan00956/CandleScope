import assert from "node:assert/strict";
import test from "node:test";

import { ProjectionStore } from "../projectionStore.js";
import { KagiProjector } from "../projectors/kagiProjector.js";
import { LineBreakProjector } from "../projectors/lineBreakProjector.js";
import { PointFigureProjector } from "../projectors/pointFigureProjector.js";
import { RenkoProjector } from "../projectors/renkoProjector.js";
import { isOrdinalAxisTime } from "../axisTime.js";
import type {
  DisplayRow,
  ProjectionProjectOptions,
  ProjectionResult,
  ProjectionState,
  Projector,
  SourceBar,
} from "../chartRepresentationTypes.js";
import { mustBeDefined } from "../../../test/testHelpers.js";

type StatefulProjector = Projector & {
  projectWithState: NonNullable<Projector["projectWithState"]>;
};

interface ProvisionalProjectorDescriptor {
  name: string;
  create(): StatefulProjector;
  anchor: number;
  forming: number;
  extension: number;
  retraction: number;
  next: number;
  nextExtension: number;
  third: number;
}

function row(time: number, close: number, isClosed: unknown = undefined): SourceBar {
  const result: SourceBar = {
    time,
    open: close,
    high: close,
    low: close,
    close,
    volume: time * 10,
  };
  if (isClosed !== undefined) result.is_closed = isClosed;
  return result;
}

function outputOrder(item: DisplayRow | undefined): number {
  if (!item || !isOrdinalAxisTime(item.time)) {
    throw new Error("Expected ordinal projection output");
  }
  return item.time.order;
}

function overlayProjection(
  confirmed: DisplayRow[],
  provisional: DisplayRow[],
): DisplayRow[] {
  if (provisional.length === 0) return confirmed;
  const firstOrder = outputOrder(provisional[0]);
  const overlayIndex = confirmed.findIndex((item) => outputOrder(item) >= firstOrder);
  const prefixLength = overlayIndex < 0 ? confirmed.length : overlayIndex;
  return confirmed.slice(0, prefixLength).concat(provisional);
}

function referenceProjection(
  projector: StatefulProjector,
  rows: SourceBar[],
  { seedState = null }: { seedState?: Readonly<ProjectionState> | null } = {},
) {
  const hasProvisionalTail = rows.at(-1)?.is_closed === false;
  const confirmedSourceLength = rows.length - Number(hasProvisionalTail);
  const confirmed = projector.projectWithState(
    rows.slice(0, confirmedSourceLength),
    { provisional: false, seedState },
  );
  if (!hasProvisionalTail) {
    return {
      ...confirmed,
      confirmedSourceLength,
    };
  }
  const trial = projector.projectWithState([mustBeDefined(rows.at(-1))], {
    provisional: true,
    seedState: confirmed.state,
  });
  return {
    checkpoints: confirmed.checkpoints.concat(trial.checkpoints),
    confirmedSourceLength,
    data: overlayProjection(confirmed.data, trial.data),
    state: confirmed.state,
    trialState: trial.state,
  };
}

function provisionalFlags(rows: DisplayRow[]): Array<boolean | undefined> {
  return rows.map((item) => item.customValues?.chartProjection?.provisional);
}

function assertMatchesReference(
  store: ProjectionStore,
  descriptor: ProvisionalProjectorDescriptor,
  rows: SourceBar[],
  options: { seedState?: Readonly<ProjectionState> | null } = {},
) {
  const expected = referenceProjection(descriptor.create(), rows, options);
  assert.deepEqual(store.sourceSnapshot(), rows);
  assert.deepEqual(store.displaySnapshot(), expected.data);
  assert.deepEqual(store._projectionFinalState, expected.state);
  assert.deepEqual(store._sourceCheckpoints, expected.checkpoints);
  assert.equal(store._confirmedSourceLength, expected.confirmedSourceLength);
  assert.equal(store._sourceCheckpoints.length, rows.length);
  return expected;
}

class CountingProjector implements Projector {
  readonly projector: StatefulProjector;
  readonly id: string;
  readonly oneToOne: boolean;
  readonly supportsStatefulTailProjection: boolean;
  projectedRows: number;

  constructor(projector: StatefulProjector) {
    this.projector = projector;
    this.id = projector.id;
    this.oneToOne = projector.oneToOne;
    this.supportsStatefulTailProjection = projector.supportsStatefulTailProjection ?? false;
    this.projectedRows = 0;
  }

  project(
    rows: readonly SourceBar[] = [],
    options: ProjectionProjectOptions = {},
  ): DisplayRow[] {
    return this.projector.project(rows, options);
  }

  projectWithState(
    rows: readonly SourceBar[] = [],
    options: ProjectionProjectOptions = {},
  ): ProjectionResult {
    this.projectedRows += rows?.length || 0;
    return this.projector.projectWithState(rows, options);
  }
}

const PROJECTORS: ProvisionalProjectorDescriptor[] = [
  {
    name: "Renko",
    create: () => new RenkoProjector({ boxSize: 2, minTick: 1 }),
    anchor: 100,
    forming: 106,
    extension: 110,
    retraction: 101,
    next: 94,
    nextExtension: 90,
    third: 114,
  },
  {
    name: "Point & Figure",
    create: () => new PointFigureProjector({ boxSize: 1, minTick: 1, reversalAmount: 3 }),
    anchor: 10,
    forming: 13,
    extension: 16,
    retraction: 10,
    next: 9,
    nextExtension: 7,
    third: 15,
  },
  {
    name: "Kagi",
    create: () => new KagiProjector({ minTick: 1, reversalTicks: 3 }),
    anchor: 10,
    forming: 13,
    extension: 16,
    retraction: 11,
    next: 9,
    nextExtension: 7,
    third: 15,
  },
  {
    name: "Line Break",
    create: () => new LineBreakProjector({ minTick: 1, numberOfLines: 3 }),
    anchor: 10,
    forming: 12,
    extension: 15,
    retraction: 10,
    next: 14,
    nextExtension: 16,
    third: 8,
  },
];

for (const descriptor of PROJECTORS) {
  test(`${descriptor.name} reset keeps a forming tail out of confirmed state`, () => {
    const rows = [
      row(1, descriptor.anchor, true),
      row(2, descriptor.forming, false),
    ];
    const store = new ProjectionStore({ projector: descriptor.create() });

    store.reset(rows);

    const expected = assertMatchesReference(store, descriptor, rows);
    assert.ok(expected.data.length > 0);
    assert.deepEqual(provisionalFlags(expected.data), expected.data.map(() => true));
    assert.notDeepEqual(expected.state, expected.trialState);
  });

  test(`${descriptor.name} forming replacements retract without advancing the confirmed seed`, () => {
    let rows = [
      row(1, descriptor.anchor, true),
      row(2, descriptor.forming, false),
    ];
    const counting = new CountingProjector(descriptor.create());
    const store = new ProjectionStore({ projector: counting });
    store.reset(rows);
    const confirmedState = structuredClone(store._projectionFinalState);

    for (const close of [descriptor.extension, descriptor.retraction, descriptor.forming]) {
      counting.projectedRows = 0;
      rows = [rows[0], row(2, close, false)];
      store.applySourceDelta({ type: "tick", replaced: true }, rows);

      assert.equal(counting.projectedRows, 1);
      assert.deepEqual(store._projectionFinalState, confirmedState);
      assertMatchesReference(store, descriptor, rows);
    }

    rows = [rows[0], row(2, descriptor.forming, true)];
    const patch = store.applySourceDelta({ type: "tick", replaced: true }, rows);

    const expected = assertMatchesReference(store, descriptor, rows);
    assert.ok(patch.deleteCount > 0 || patch.insert.length > 0);
    assert.deepEqual(provisionalFlags(expected.data), expected.data.map(() => false));
    assert.notDeepEqual(store._projectionFinalState, confirmedState);
  });

  test(`${descriptor.name} implicitly confirms a missed close before the next forming bar`, () => {
    let rows = [
      row(1, descriptor.anchor, true),
      row(2, descriptor.forming, false),
    ];
    const counting = new CountingProjector(descriptor.create());
    const store = new ProjectionStore({ projector: counting });
    store.reset(rows);
    counting.projectedRows = 0;
    rows = [...rows, row(3, descriptor.next, false)];

    store.applySourceDelta({ type: "tick", appended: true }, rows);

    const expected = assertMatchesReference(store, descriptor, rows);
    assert.equal(counting.projectedRows, 2);
    assert.equal(store._confirmedSourceLength, 2);
    assert.ok(provisionalFlags(expected.data).includes(false));
    assert.ok(provisionalFlags(expected.data).includes(true));
    assert.notDeepEqual(expected.state, expected.trialState);

    counting.projectedRows = 0;
    rows = [
      ...rows.slice(0, -1),
      row(3, descriptor.nextExtension, false),
    ];
    store.applySourceDelta({ type: "tick", replaced: true }, rows);
    assert.equal(counting.projectedRows, 1);
    assertMatchesReference(store, descriptor, rows);
  });

  test(`${descriptor.name} preserves the confirmed checkpoint when only a forming row remains visible`, () => {
    const original = [
      row(1, descriptor.anchor, true),
      row(2, descriptor.forming, false),
    ];
    const store = new ProjectionStore({ projector: descriptor.create() });
    store.reset(original);
    const hiddenSeed = store._sourceCheckpoints[1];
    const retained = [original[1]];

    store.applySourceDelta({ type: "trim-left", trimmedLeft: 1 }, retained);

    assertMatchesReference(store, descriptor, retained, { seedState: hiddenSeed });
    assert.equal(store._confirmedSourceLength, 0);

    const closed = [row(2, descriptor.forming, true)];
    store.applySourceDelta({ type: "tick", replaced: true }, closed);
    assertMatchesReference(store, descriptor, closed, { seedState: hiddenSeed });
    assert.equal(store._confirmedSourceLength, 1);
  });

  test(`${descriptor.name} confirms a forming tail before an append trims it out`, () => {
    const oldTail = row(1, descriptor.anchor, false);
    const store = new ProjectionStore({ projector: descriptor.create() });
    store.reset([oldTail]);
    const hiddenSeed = descriptor.create().projectWithState(
      [oldTail],
      { provisional: false, seedState: null },
    ).state;
    const nextRows = [row(2, descriptor.forming, false)];

    store.applySourceDelta(
      { type: "tick", appended: true, trimmedLeft: 1 },
      nextRows,
    );

    assertMatchesReference(store, descriptor, nextRows, { seedState: hiddenSeed });
    assert.deepEqual(store._projectionSeedState, hiddenSeed);
    assert.equal(store._confirmedSourceLength, 0);
    assert.ok(store.displaySnapshot().length > 0);
  });

  test(`${descriptor.name} structural merges and multi-row appends retain provisional semantics`, () => {
    let rows = [
      row(1, descriptor.anchor, true),
      row(2, descriptor.forming, false),
    ];
    const store = new ProjectionStore({ projector: descriptor.create() });
    store.reset(rows);

    rows = [
      row(1, descriptor.anchor + 1, true),
      row(2, descriptor.forming, false),
    ];
    store.applySourceDelta({ type: "mid-merge" }, rows);
    assertMatchesReference(store, descriptor, rows);

    rows = [
      ...rows,
      row(3, descriptor.next, false),
      row(4, descriptor.third, false),
    ];
    store.applySourceDelta({ type: "append", addedRight: 2 }, rows);
    assertMatchesReference(store, descriptor, rows);
    assert.equal(store._confirmedSourceLength, rows.length - 1);
  });
}

test("missing close state stays backward-compatible while wire aliases can mark a forming tail", () => {
  const projector = () => new RenkoProjector({ boxSize: 2, minTick: 1 });
  const confirmedRows = [row(1, 100), row(2, 106)];
  const confirmedStore = new ProjectionStore({ projector: projector() });
  confirmedStore.reset(confirmedRows);
  assert.equal(confirmedStore._confirmedSourceLength, confirmedRows.length);
  assert.deepEqual(
    provisionalFlags(confirmedStore.displaySnapshot()),
    confirmedStore.displaySnapshot().map(() => false),
  );

  for (const finality of [
    { is_closed: false },
    { isClosed: false },
    { is_closed: "forming" },
    { is_closed: "0" },
  ]) {
    const formingRows = [
      row(1, 100, true),
      { ...row(2, 106), ...finality },
    ];
    const store = new ProjectionStore({ projector: projector() });
    store.reset(formingRows);
    assert.equal(store._confirmedSourceLength, 1);
    assert.deepEqual(
      provisionalFlags(store.displaySnapshot()),
      store.displaySnapshot().map(() => true),
    );
  }
});
