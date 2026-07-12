import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_FREEHAND_STROKE_POINTS,
  MAX_FREEHAND_STROKE_SPANS,
  MAX_LEGACY_FREEHAND_POINTS,
  appendFreehandStrokeCapture,
  appendFreehandStrokeCaptureBatch,
  cancelFreehandStrokeDraft,
  createFreehandStrokeDraft,
  finalizeFreehandStrokeDraft,
  getFreehandStrokeDraftPreviewPoints,
  normalizeLegacyFreehandDataPoints,
  normalizeSavedFreehandPayload,
  normalizeFreehandStrokeV2,
  resolveFreehandStrokeV2Points,
} from "../freehandStrokeModel.js";

function stroke(overrides = {}) {
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

function collectKeys(value, keys = new Set()) {
  if (!value || typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectKeys(child, keys);
  }
  return keys;
}

test("freehand v2 normalization preserves same-time ordinals without local axis fields", () => {
  const value = stroke({ order: 99, logical: 42 });
  value.spans[0].exact.left.order = 5;
  value.points[0].logical = 12.5;

  const normalized = normalizeFreehandStrokeV2(value);

  assert.deepEqual(normalized.spans[0].exact, {
    left: { time: 200, sourceOrdinal: 0 },
    right: { time: 200, sourceOrdinal: 1 },
  });
  const keys = collectKeys(normalized);
  assert.equal(keys.has("order"), false);
  assert.equal(keys.has("logical"), false);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.spans[0].exact.left), true);
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
    spans: [stroke().spans[0], {
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
  const calls = [];

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
    spans: [stroke().spans[0], {
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
});

function capture(span, x, y, ratio = 0.5, price = y) {
  return { span, ratio, price, screen: x === null ? null : { x, y } };
}

function draftBatch(identity, captures) {
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
  const firstSpan = stroke().spans[0];
  const clonedSpan = structuredClone(firstSpan);

  assert.equal(appendFreehandStrokeCaptureBatch(draft, draftBatch(identity, [
    capture(firstSpan, 0, 0, 0),
    capture(clonedSpan, 1, 1, 0.5),
    capture(firstSpan, 2, 0, 1),
  ])), true);
  const finalized = finalizeFreehandStrokeDraft(draft, { captureIdentity: identity, epsilon: 0 });

  assert.equal(finalized.spans.length, 1);
  assert.deepEqual(finalized.points.map((point) => point.span), [0, 0, 0]);
});

test("freehand draft keeps null screen captures as path gaps", () => {
  const identity = {};
  const draft = createFreehandStrokeDraft(draftBatch(identity, []));
  const firstSpan = stroke().spans[0];
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
  const finalized = finalizeFreehandStrokeDraft(draft, {
    captureIdentity: identity,
    epsilon: 10_000,
  });
  assert.equal(finalized.points.length, 5);
  assert.deepEqual(finalized.points.map((point) => point.span), [0, 0, 1, 0, 0]);
});

test("freehand draft drops unused spans and remaps retained point indexes", () => {
  const identity = {};
  const draft = createFreehandStrokeDraft(draftBatch(identity, []));
  const keptSpan = stroke().spans[0];
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

  const finalized = finalizeFreehandStrokeDraft(draft, {
    captureIdentity: identity,
    epsilon: 1,
  });
  assert.equal(finalized.spans.length, 1);
  assert.deepEqual(finalized.spans[0], keptSpan);
  assert.deepEqual(finalized.points.map((point) => point.span), [0, 0]);
});

test("freehand draft decimation is iterative at the point cap", () => {
  const identity = {};
  const draft = createFreehandStrokeDraft(draftBatch(identity, []));
  const span = stroke().spans[0];
  const captures = Array.from({ length: MAX_FREEHAND_STROKE_POINTS }, (_value, index) => (
    capture(span, index, 0, index / (MAX_FREEHAND_STROKE_POINTS - 1), index)
  ));
  assert.equal(appendFreehandStrokeCaptureBatch(draft, draftBatch(identity, captures)), true);
  const finalized = finalizeFreehandStrokeDraft(draft, {
    captureIdentity: identity,
    epsilon: 0.1,
  });
  assert.equal(finalized.points.length, 2);
  assert.deepEqual(finalized.points.map((point) => point.price), [0, MAX_FREEHAND_STROKE_POINTS - 1]);
});

test("freehand draft fails closed on identity, caps, invalid input, and cancel", () => {
  const identity = {};
  const draft = createFreehandStrokeDraft(draftBatch(identity, []));
  const span = stroke().spans[0];
  assert.equal(appendFreehandStrokeCapture(draft, capture(span, 0, 0), {}), false);
  assert.equal(getFreehandStrokeDraftPreviewPoints(draft).length, 0);
  assert.equal(appendFreehandStrokeCaptureBatch(draft, draftBatch(identity,
    Array(MAX_FREEHAND_STROKE_POINTS + 1).fill(capture(span, 0, 0)))), false);
  assert.equal(getFreehandStrokeDraftPreviewPoints(draft).length, 0);
  assert.equal(cancelFreehandStrokeDraft(draft), true);
  assert.equal(appendFreehandStrokeCapture(draft, capture(span, 0, 0), identity), false);
  assert.equal(finalizeFreehandStrokeDraft(draft, { captureIdentity: identity }), null);
});
