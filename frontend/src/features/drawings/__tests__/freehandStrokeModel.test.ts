import assert from "node:assert/strict";
import test from "node:test";

import {
  FREEHAND_STROKE_V3_VERSION,
  MAX_FREEHAND_STROKE_POINTS,
  MAX_FREEHAND_STROKE_SPANS,
  MAX_LEGACY_FREEHAND_POINTS,
  appendFreehandStrokeCapture,
  appendFreehandStrokeCaptureBatch,
  appendFreehandStrokeCaptureBatchIncremental,
  cancelFreehandStrokeDraft,
  createFreehandStrokeDraft,
  finalizeFreehandStrokeDraft,
  getFreehandStrokeDraftPreviewPoints,
  getFreehandStrokeDraftRemainingCapacity,
  isFreehandStrokeDraftSaturated,
  normalizeLegacyFreehandDataPoints,
  normalizeSavedFreehandPayload,
  normalizeFreehandStroke,
  normalizeFreehandStrokeV2,
  normalizeFreehandStrokeV3,
  resolveFreehandStrokePoints,
  resolveFreehandStrokeV2Points,
  resolveFreehandStrokeV3Points,
} from "../freehandStrokeModel.js";
import type {
  ExactOrdinalAnchor,
  FreehandCaptureBatch,
  FreehandStroke,
  FreehandStrokeResolvers,
  FreehandStrokeV2,
  FreehandStrokeV3,
  SavedFreehandPayload,
  ScreenPoint,
  SourceLineageSpan,
} from "../drawingTypes.js";
import { malformedFixture, mustBeDefined } from "../../../test/testHelpers.js";

function stroke(overrides: Partial<FreehandStrokeV2> = {}): FreehandStrokeV2 {
  return {
    version: 2,
    sourceProjection: "renko",
    sourceProjectionConfig: "derived-ordinal:renko:{\"boxSize\":10}",
    spans: [{
      exact: {
        left: { time: 200, sourceOrdinal: 0 },
        right: { time: 200, sourceOrdinal: 1 },
      },
      fallback: {
        fromTime: 100,
        toTime: 200,
        leftRatio: 0.25,
        rightRatio: 0.75,
      },
    }],
    points: [
      { span: 0, ratio: 0, price: 10 },
      { span: 0, ratio: 0.5, price: 11 },
      { span: 0, ratio: 1, price: 12 },
    ],
    ...overrides,
  };
}

function strokeV3(overrides: Partial<FreehandStrokeV3> = {}): FreehandStrokeV3 {
  const base = stroke();
  return {
    ...base,
    version: FREEHAND_STROKE_V3_VERSION,
    points: [
      { span: 0, ratio: 0, price: 10 },
      { time: 250.5, price: 11 },
      { span: 0, ratio: 1, price: 12 },
    ],
    ...overrides,
  };
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectKeys(child, keys);
  }
  return keys;
}

function spanIndexes(value: FreehandStroke): number[] {
  return value.points.map((point) => {
    if (!("span" in point)) throw new Error("Expected a span-backed fixture point");
    return point.span;
  });
}

test("freehand v2 normalization preserves same-time ordinals without local axis fields", () => {
  const value = {
    ...stroke(),
    order: 99,
    logical: 42,
    spans: [{
      ...mustBeDefined(stroke().spans[0]),
      exact: {
        left: { ...mustBeDefined(stroke().spans[0]).exact.left, order: 5 },
        right: mustBeDefined(stroke().spans[0]).exact.right,
      },
    }],
    points: stroke().points.map((point, index) => (
      index === 0 ? { ...point, logical: 12.5 } : point
    )),
  };

  const normalized = mustBeDefined(normalizeFreehandStrokeV2(value));

  assert.deepEqual(mustBeDefined(normalized.spans[0]).exact, {
    left: { time: 200, sourceOrdinal: 0 },
    right: { time: 200, sourceOrdinal: 1 },
  });
  const keys = collectKeys(normalized);
  assert.equal(keys.has("order"), false);
  assert.equal(keys.has("logical"), false);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(mustBeDefined(normalized.spans[0]).exact.left), true);
  assert.strictEqual(normalizeFreehandStrokeV2(normalized), normalized);
});

test("freehand v2 rejects ambiguous exact and fallback spans", () => {
  assert.equal(normalizeFreehandStrokeV2(stroke({
    spans: [{
      exact: {
        left: { time: 200, sourceOrdinal: 1 },
        right: { time: 200, sourceOrdinal: 0 },
      },
      fallback: {
        fromTime: 100,
        toTime: 200,
        leftRatio: 0.25,
        rightRatio: 0.75,
      },
    }],
  })), null);

  assert.equal(normalizeFreehandStrokeV2(stroke({
    spans: [{
      exact: {
        left: { time: 200, sourceOrdinal: 0 },
        right: { time: 200, sourceOrdinal: 1 },
      },
      fallback: {
        fromTime: 200,
        toTime: 200,
        leftRatio: 0.75,
        rightRatio: 0.25,
      },
    }],
  })), null);
});

test("freehand v2 resolves each unique referenced span once", () => {
  const value = stroke({
    spans: [mustBeDefined(stroke().spans[0]), {
      exact: {
        left: { time: 300, sourceOrdinal: 0 },
        right: { time: 400, sourceOrdinal: 0 },
      },
      fallback: {
        fromTime: 300,
        toTime: 400,
        leftRatio: 0,
        rightRatio: 1,
      },
    }],
    points: [
      { span: 0, ratio: 0, price: 10 },
      { span: 0, ratio: 0.5, price: 11 },
      { span: 1, ratio: 0.25, price: 12 },
      { span: 0, ratio: 1, price: 13 },
    ],
  });
  const calls: number[] = [];

  const points = resolveFreehandStrokeV2Points(value, (_span, index) => {
    calls.push(index);
    return index === 0 ? { left: 10, right: 20 } : { left: 30, right: 50 };
  });

  assert.deepEqual(calls, [0, 1]);
  assert.deepEqual(points, [
    { x: 10, price: 10 },
    { x: 15, price: 11 },
    { x: 35, price: 12 },
    { x: 20, price: 13 },
  ]);
});

test("freehand v2 emits path gaps for unresolved spans", () => {
  const value = stroke({
    spans: [mustBeDefined(stroke().spans[0]), {
      exact: {
        left: { time: 300, sourceOrdinal: 0 },
        right: { time: 400, sourceOrdinal: 0 },
      },
      fallback: {
        fromTime: 300,
        toTime: 400,
        leftRatio: 0,
        rightRatio: 1,
      },
    }],
    points: [
      { span: 0, ratio: 0, price: 10 },
      { span: 1, ratio: 0.5, price: 11 },
      { span: 0, ratio: 1, price: 12 },
    ],
  });

  assert.deepEqual(resolveFreehandStrokeV2Points(
    value,
    (_span, index) => (index === 0 ? { left: 10, right: 20 } : null),
  ), [
    { x: 10, price: 10 },
    null,
    { x: 20, price: 12 },
  ]);
});

test("freehand v2 enforces span and point caps before normalization", () => {
  assert.equal(normalizeFreehandStrokeV2(stroke({
    spans: Array(MAX_FREEHAND_STROKE_SPANS + 1).fill(stroke().spans[0]),
  })), null);
  assert.equal(normalizeFreehandStrokeV2(stroke({
    points: Array(MAX_FREEHAND_STROKE_POINTS + 1).fill(stroke().points[0]),
  })), null);
});

test("freehand v3 normalizes frozen span, exact-anchor, and absolute point unions", () => {
  const base = strokeV3();
  const value = {
    ...base,
    order: 99,
    logical: 42,
    points: [
      { ...mustBeDefined(base.points[0]), logical: 12 },
      { ...mustBeDefined(base.points[1]), order: 13 },
      { anchor: { time: 200, sourceOrdinal: 0, order: 99 }, price: 11.5 },
      ...base.points.slice(2),
    ],
  };

  const normalized = mustBeDefined(normalizeFreehandStrokeV3(value));

  assert.deepEqual(normalized.points, [
    { span: 0, ratio: 0, price: 10 },
    { time: 250.5, price: 11 },
    { anchor: { time: 200, sourceOrdinal: 0 }, price: 11.5 },
    { span: 0, ratio: 1, price: 12 },
  ]);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.spans), true);
  assert.equal(Object.isFrozen(normalized.points), true);
  assert.equal(Object.isFrozen(normalized.points[1]), true);
  const exactPoint = mustBeDefined(normalized.points[2]);
  assert.ok("anchor" in exactPoint);
  assert.equal(Object.isFrozen(exactPoint.anchor), true);
  assert.strictEqual(normalizeFreehandStroke(normalized), normalized);
  assert.strictEqual(normalizeFreehandStrokeV3(normalized), normalized);
  assert.equal(normalizeFreehandStrokeV2(normalized), null);
});

test("freehand v3 permits empty spans for absolute-time strokes", () => {
  const normalized = mustBeDefined(normalizeFreehandStrokeV3(strokeV3({
    spans: [],
    points: [
      { time: -10.25, price: 10 },
      { time: Number.MAX_SAFE_INTEGER, price: 11 },
    ],
  })));

  assert.deepEqual(normalized.spans, []);
  assert.deepEqual(normalized.points, [
    { time: -10.25, price: 10 },
    { time: Number.MAX_SAFE_INTEGER, price: 11 },
  ]);
});

test("freehand v3 rejects mixed point shapes, unsafe times, and invalid span references", () => {
  const invalidPoints = [
    { time: 250, span: 0, ratio: 0.5, price: 10 },
    { time: 250, ratio: 0.5, price: 10 },
    { span: 0, price: 10 },
    { ratio: 0.5, price: 10 },
    { time: Number.MAX_SAFE_INTEGER + 1, price: 10 },
    { anchor: { time: 250 }, price: 10 },
    { anchor: { time: 250, sourceOrdinal: -1 }, price: 10 },
    { anchor: { time: 250, sourceOrdinal: 0 }, time: 250, price: 10 },
    { anchor: { time: 250, sourceOrdinal: 0 }, span: 0, ratio: 0.5, price: 10 },
  ];
  for (const point of invalidPoints) {
    assert.equal(normalizeFreehandStrokeV3(strokeV3({
      points: malformedFixture<FreehandStrokeV3["points"]>([
        point,
        { time: 300, price: 11 },
      ]),
    })), null);
  }

  assert.equal(normalizeFreehandStrokeV3(strokeV3({
    spans: [],
    points: [
      { span: 0, ratio: 0.5, price: 10 },
      { time: 300, price: 11 },
    ],
  })), null);
  assert.equal(normalizeFreehandStrokeV3(strokeV3({
    spans: Array(MAX_FREEHAND_STROKE_SPANS + 1).fill(stroke().spans[0]),
  })), null);
  assert.equal(normalizeFreehandStrokeV3(strokeV3({
    points: Array(MAX_FREEHAND_STROKE_POINTS + 1).fill({ time: 300, price: 10 }),
  })), null);
});

test("freehand version dispatcher and saved payload reject unknown or mixed schemas", () => {
  assert.equal(normalizeFreehandStroke({ ...strokeV3(), version: 4 }), null);
  assert.deepEqual(resolveFreehandStrokePoints({ ...strokeV3(), version: 4 }), []);
  assert.equal(normalizeSavedFreehandPayload({
    stroke: strokeV3(),
    dataPoints: [{ time: 100, price: 10 }, { time: 200, price: 11 }],
  }), null);

  const payload = mustBeDefined(normalizeSavedFreehandPayload({ stroke: strokeV3() }));
  assert.equal(mustBeDefined(payload.stroke).version, FREEHAND_STROKE_V3_VERSION);
  assert.equal(Object.hasOwn(payload, "dataPoints"), false);
});

test("freehand generic resolver preserves v3 gaps and resolves each span once", () => {
  const value = strokeV3({
    points: [
      { span: 0, ratio: 0, price: 10 },
      { time: 250.5, price: 11 },
      { span: 0, ratio: 1, price: 12 },
      { anchor: { time: 200, sourceOrdinal: 0 }, price: 12.5 },
      { time: 300, price: 13 },
    ],
  });
  const spanCalls: number[] = [];
  const timeCalls: Array<[number, number]> = [];
  const anchorCalls: Array<[ExactOrdinalAnchor, number]> = [];
  const resolvers: FreehandStrokeResolvers = {
    resolveAnchor: (anchor, index) => {
      anchorCalls.push([anchor, index]);
      return 30;
    },
    resolveSpan: (_span, index) => {
      spanCalls.push(index);
      return { left: 10, right: 20 };
    },
    resolveTime: (time, index) => {
      timeCalls.push([time, index]);
      if (time === 300) throw new Error("unresolved");
      return 40.5;
    },
  };

  assert.deepEqual(resolveFreehandStrokePoints(value, resolvers), [
    { x: 10, price: 10 },
    { x: 40.5, price: 11 },
    { x: 20, price: 12 },
    { x: 30, price: 12.5 },
    null,
  ]);
  assert.deepEqual(spanCalls, [0]);
  assert.deepEqual(timeCalls, [[250.5, 1], [300, 4]]);
  assert.deepEqual(anchorCalls, [[{ time: 200, sourceOrdinal: 0 }, 3]]);
  assert.deepEqual(resolveFreehandStrokeV3Points(value, {
    resolveSpan: mustBeDefined(resolvers.resolveSpan),
  }), [{ x: 10, price: 10 }, null, { x: 20, price: 12 }, null, null]);
  assert.deepEqual(resolveFreehandStrokeV3Points(value, {
    resolveTime: () => 30,
  }), [null, { x: 30, price: 11 }, null, null, { x: 30, price: 13 }]);
});

test("legacy freehand normalization stays v1 and removes unsafe point fields", () => {
  const payload = normalizeSavedFreehandPayload({
    dataPoints: [{
      time: 100,
      logical: 1.5,
      order: 99,
      price: 10,
    }, {
      time: 200,
      sourceOrdinal: 1,
      sourceProjection: "renko",
      sourceProjectionConfig: "derived-ordinal:renko:{}",
      logical: 2.5,
      order: 100,
      price: 11,
    }],
  });

  assert.deepEqual(payload, {
    dataPoints: [{ time: 100, logical: 1.5, price: 10 }, {
      time: 200,
      sourceOrdinal: 1,
      sourceProjection: "renko",
      sourceProjectionConfig: "derived-ordinal:renko:{}",
      price: 11,
    }],
  });
  assert.equal(Object.hasOwn(payload, "stroke"), false);
});

test("legacy freehand normalization rejects malformed and oversized point arrays", () => {
  const point = { time: 100, price: 10 };
  assert.equal(normalizeLegacyFreehandDataPoints({}), null);
  assert.equal(normalizeLegacyFreehandDataPoints([]), null);
  assert.equal(normalizeLegacyFreehandDataPoints([point]), null);
  assert.equal(normalizeLegacyFreehandDataPoints([null]), null);
  assert.equal(normalizeLegacyFreehandDataPoints([{ time: 100, price: "10" }]), null);
  assert.equal(normalizeLegacyFreehandDataPoints(
    Array(MAX_LEGACY_FREEHAND_POINTS + 1).fill(point),
  ), null);
});

test("freehand v2 rejects zero-width resolved spans", () => {
  assert.deepEqual(resolveFreehandStrokeV2Points(
    stroke(),
    () => ({ left: 10, right: 10 }),
  ), [null, null, null]);
  assert.deepEqual(resolveFreehandStrokeV2Points(stroke(), undefined), []);
});

function capture(
  span: SourceLineageSpan,
  x: number | null,
  y: number,
  ratio = 0.5,
  price = y,
) {
  return { span, ratio, price, screen: x === null ? null : { x, y } };
}

function absoluteCapture(time: number, x: number | null, y: number, price = y) {
  return { time, price, screen: x === null ? null : { x, y } };
}

function exactAnchorCapture(
  time: number,
  sourceOrdinal: number,
  x: number | null,
  y: number,
  price = y,
) {
  return {
    anchor: { time, sourceOrdinal },
    price,
    screen: x === null ? null : { x, y },
  };
}

function draftBatch(identity: unknown, captures: unknown[]): FreehandCaptureBatch {
  return {
    captureIdentity: identity,
    sourceProjection: "renko",
    sourceProjectionConfig: "derived-ordinal:renko:{\"boxSize\":10}",
    captures,
  };
}

test("freehand draft deduplicates structurally equal spans", () => {
  const identity = Object.freeze({ series: 1 });
  const draft = createFreehandStrokeDraft(draftBatch(identity, []));
  const firstSpan = mustBeDefined(stroke().spans[0]);
  const clonedSpan = structuredClone(firstSpan);

  assert.equal(appendFreehandStrokeCaptureBatch(draft, draftBatch(identity, [
    capture(firstSpan, 0, 0, 0),
    capture(clonedSpan, 1, 1, 0.5),
    capture(firstSpan, 2, 0, 1),
  ])), true);
  const finalized = mustBeDefined(finalizeFreehandStrokeDraft(
    draft,
    { captureIdentity: identity, epsilon: 0 },
  ));

  assert.equal(finalized.version, 2);
  assert.equal(finalized.spans.length, 1);
  assert.deepEqual(spanIndexes(finalized), [0, 0, 0]);
});

test("freehand draft finalizes absolute-only captures as v3 with no spans", () => {
  const identity = {};
  const draft = createFreehandStrokeDraft(draftBatch(identity, []));
  assert.equal(appendFreehandStrokeCaptureBatch(draft, draftBatch(identity, [
    absoluteCapture(200.25, 0, 10),
    absoluteCapture(250.5, 1, 20, 11),
    absoluteCapture(300.75, 2, 10),
  ])), true);

  const finalized = mustBeDefined(finalizeFreehandStrokeDraft(draft, {
    captureIdentity: identity,
    epsilon: 0,
  }));
  assert.equal(finalized.version, FREEHAND_STROKE_V3_VERSION);
  assert.deepEqual(finalized.spans, []);
  assert.deepEqual(finalized.points, [
    { time: 200.25, price: 10 },
    { time: 250.5, price: 11 },
    { time: 300.75, price: 10 },
  ]);
});

test("freehand draft preserves an exact materialized anchor beside future time", () => {
  const identity = {};
  const draft = createFreehandStrokeDraft(draftBatch(identity, []));
  assert.equal(appendFreehandStrokeCaptureBatch(draft, draftBatch(identity, [
    exactAnchorCapture(200, 0, 0, 10),
    absoluteCapture(250.5, 1, 20, 11),
    exactAnchorCapture(200, 1, 2, 12),
  ])), true);

  const finalized = mustBeDefined(finalizeFreehandStrokeDraft(draft, {
    captureIdentity: identity,
    epsilon: 0,
  }));
  assert.equal(finalized.version, FREEHAND_STROKE_V3_VERSION);
  assert.deepEqual(finalized.points, [
    { anchor: { time: 200, sourceOrdinal: 0 }, price: 10 },
    { time: 250.5, price: 11 },
    { anchor: { time: 200, sourceOrdinal: 1 }, price: 12 },
  ]);
});

test("freehand draft retains mixed v3 point types and null-screen separators", () => {
  const identity = {};
  const draft = createFreehandStrokeDraft(draftBatch(identity, []));
  const lineageSpan = mustBeDefined(stroke().spans[0]);
  assert.equal(appendFreehandStrokeCaptureBatch(draft, draftBatch(identity, [
    capture(lineageSpan, 0, 0, 0),
    capture(lineageSpan, 1, 0, 0.2),
    absoluteCapture(250.5, null, 0),
    absoluteCapture(300.5, 100, 0),
    absoluteCapture(350.5, 101, 0),
  ])), true);

  const finalized = mustBeDefined(finalizeFreehandStrokeDraft(draft, {
    captureIdentity: identity,
    epsilon: 10_000,
  }));
  assert.equal(finalized.version, FREEHAND_STROKE_V3_VERSION);
  assert.deepEqual(finalized.points, [
    { span: 0, ratio: 0, price: 0 },
    { span: 0, ratio: 0.2, price: 0 },
    { time: 250.5, price: 0 },
    { time: 300.5, price: 0 },
    { time: 350.5, price: 0 },
  ]);
});

test("freehand draft chooses the minimum schema after RDP", () => {
  const identity = {};
  const draft = createFreehandStrokeDraft(draftBatch(identity, []));
  const lineageSpan = mustBeDefined(stroke().spans[0]);
  assert.equal(appendFreehandStrokeCaptureBatch(draft, draftBatch(identity, [
    capture(lineageSpan, 0, 0, 0),
    absoluteCapture(250.5, 1, 0),
    capture(lineageSpan, 2, 0, 1),
  ])), true);

  const finalized = mustBeDefined(finalizeFreehandStrokeDraft(draft, {
    captureIdentity: identity,
    epsilon: 1,
  }));
  assert.equal(finalized.version, 2);
  assert.deepEqual(finalized.points, [
    { span: 0, ratio: 0, price: 0 },
    { span: 0, ratio: 1, price: 0 },
  ]);
});

test("freehand draft rejects malformed mixed captures atomically", () => {
  const identity = {};
  const draft = createFreehandStrokeDraft(draftBatch(identity, []));
  const lineageSpan = mustBeDefined(stroke().spans[0]);
  assert.equal(appendFreehandStrokeCaptureBatch(draft, draftBatch(identity, [
    capture(lineageSpan, 0, 0, 0),
    absoluteCapture(250.5, 1, 0),
  ])), true);
  const preview = getFreehandStrokeDraftPreviewPoints(draft);

  assert.equal(appendFreehandStrokeCaptureBatch(draft, draftBatch(identity, [
    absoluteCapture(300.5, 2, 0),
    {
      span: lineageSpan,
      ratio: 0.5,
      time: 300.5,
      price: 10,
      screen: { x: 3, y: 0 },
    },
  ])), false);
  assert.deepEqual(getFreehandStrokeDraftPreviewPoints(draft), preview);
});

test("freehand draft keeps null screen captures as path gaps", () => {
  const identity = {};
  const draft = createFreehandStrokeDraft(draftBatch(identity, []));
  const firstSpan = mustBeDefined(stroke().spans[0]);
  const gapSpan = {
    exact: {
      left: { time: 300, sourceOrdinal: 0 },
      right: { time: 400, sourceOrdinal: 0 },
    },
    fallback: { fromTime: 300, toTime: 400, leftRatio: 0, rightRatio: 1 },
  };
  assert.equal(appendFreehandStrokeCaptureBatch(draft, draftBatch(identity, [
    capture(firstSpan, 0, 0, 0),
    capture(firstSpan, 1, 0, 0.2),
    capture(gapSpan, null, 0),
    capture(firstSpan, 100, 0, 0.8),
    capture(firstSpan, 101, 0, 1),
  ])), true);

  assert.deepEqual(getFreehandStrokeDraftPreviewPoints(draft), [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    null,
    { x: 100, y: 0 },
    { x: 101, y: 0 },
  ]);
  const finalized = mustBeDefined(finalizeFreehandStrokeDraft(draft, {
    captureIdentity: identity,
    epsilon: 10_000,
  }));
  assert.equal(finalized.points.length, 5);
  assert.deepEqual(spanIndexes(finalized), [0, 0, 1, 0, 0]);
});

test("freehand draft drops unused spans and remaps retained point indexes", () => {
  const identity = {};
  const draft = createFreehandStrokeDraft(draftBatch(identity, []));
  const keptSpan = mustBeDefined(stroke().spans[0]);
  const droppedSpan = {
    exact: {
      left: { time: 300, sourceOrdinal: 0 },
      right: { time: 400, sourceOrdinal: 0 },
    },
    fallback: { fromTime: 300, toTime: 400, leftRatio: 0, rightRatio: 1 },
  };
  assert.equal(appendFreehandStrokeCaptureBatch(draft, draftBatch(identity, [
    capture(keptSpan, 0, 0, 0),
    capture(droppedSpan, 1, 0),
    capture(droppedSpan, 2, 0),
    capture(keptSpan, 3, 0, 1),
  ])), true);

  const finalized = mustBeDefined(finalizeFreehandStrokeDraft(draft, {
    captureIdentity: identity,
    epsilon: 1,
  }));
  assert.equal(finalized.spans.length, 1);
  assert.deepEqual(finalized.spans[0], keptSpan);
  assert.deepEqual(spanIndexes(finalized), [0, 0]);
});

test("freehand draft decimation is iterative at the point cap", () => {
  const identity = {};
  const draft = createFreehandStrokeDraft(draftBatch(identity, []));
  const span = mustBeDefined(stroke().spans[0]);
  const captures = Array.from({ length: MAX_FREEHAND_STROKE_POINTS }, (_value, index) => (
    capture(span, index, 0, index / (MAX_FREEHAND_STROKE_POINTS - 1), index)
  ));
  assert.equal(appendFreehandStrokeCaptureBatch(draft, draftBatch(identity, captures)), true);
  assert.equal(isFreehandStrokeDraftSaturated(draft), true);
  const finalized = mustBeDefined(finalizeFreehandStrokeDraft(draft, {
    captureIdentity: identity,
    epsilon: 0.1,
  }));
  assert.equal(finalized.points.length, 2);
  assert.deepEqual(finalized.points.map((point) => point.price), [0, MAX_FREEHAND_STROKE_POINTS - 1]);
});

test("incremental freehand append preserves a saturated draft for mouseup commit", () => {
  const identity = {};
  const draft = createFreehandStrokeDraft(draftBatch(identity, []));
  const span = mustBeDefined(stroke().spans[0]);
  const initial = Array.from(
    { length: MAX_FREEHAND_STROKE_POINTS - 1 },
    (_value, index) => capture(
      span,
      index,
      0,
      index / (MAX_FREEHAND_STROKE_POINTS - 1),
      index,
    ),
  );
  assert.equal(appendFreehandStrokeCaptureBatch(
    draft,
    draftBatch(identity, initial),
  ), true);
  assert.equal(getFreehandStrokeDraftRemainingCapacity(draft), 1);

  const result = appendFreehandStrokeCaptureBatchIncremental(draft, draftBatch(identity, [
    capture(span, MAX_FREEHAND_STROKE_POINTS - 1, 0, 1, MAX_FREEHAND_STROKE_POINTS - 1),
    capture(span, MAX_FREEHAND_STROKE_POINTS, 0, 1, 99_999),
  ]));
  assert.deepEqual(result, {
    appendedCount: 1,
    previewPoints: [{ x: MAX_FREEHAND_STROKE_POINTS - 1, y: 0 }],
    saturated: true,
  });
  assert.equal(isFreehandStrokeDraftSaturated(draft), true);
  assert.equal(getFreehandStrokeDraftRemainingCapacity(draft), 0);
  assert.deepEqual(
    appendFreehandStrokeCaptureBatchIncremental(draft, draftBatch(identity, [
      capture(span, MAX_FREEHAND_STROKE_POINTS + 1, 0, 1, 100_000),
    ])),
    { appendedCount: 0, previewPoints: [], saturated: true },
  );

  const finalized = finalizeFreehandStrokeDraft(draft, {
    captureIdentity: identity,
    epsilon: 0.1,
  });
  assert.ok(finalized);
  assert.deepEqual(finalized.points.map((point) => point.price), [
    0,
    MAX_FREEHAND_STROKE_POINTS - 1,
  ]);
});

test("incremental freehand append still fails closed on identity drift", () => {
  const identity = {};
  const draft = createFreehandStrokeDraft(draftBatch(identity, []));
  const span = mustBeDefined(stroke().spans[0]);
  assert.equal(appendFreehandStrokeCaptureBatchIncremental(
    draft,
    draftBatch({}, [capture(span, 0, 0)]),
  ), null);
  assert.equal(isFreehandStrokeDraftSaturated(draft), false);
  assert.deepEqual(getFreehandStrokeDraftPreviewPoints(draft), []);
});

test("freehand draft fails closed on identity, caps, invalid input, and cancel", () => {
  const identity = {};
  const draft = createFreehandStrokeDraft(draftBatch(identity, []));
  const span = mustBeDefined(stroke().spans[0]);
  assert.equal(appendFreehandStrokeCapture(draft, capture(span, 0, 0), {}), false);
  assert.equal(getFreehandStrokeDraftPreviewPoints(draft).length, 0);
  assert.equal(appendFreehandStrokeCaptureBatch(draft, draftBatch(identity,
    Array(MAX_FREEHAND_STROKE_POINTS + 1).fill(capture(span, 0, 0)))), false);
  assert.equal(getFreehandStrokeDraftPreviewPoints(draft).length, 0);
  assert.equal(cancelFreehandStrokeDraft(draft), true);
  assert.equal(getFreehandStrokeDraftRemainingCapacity(draft), null);
  assert.equal(appendFreehandStrokeCapture(draft, capture(span, 0, 0), identity), false);
  assert.equal(finalizeFreehandStrokeDraft(draft, { captureIdentity: identity }), null);
});
