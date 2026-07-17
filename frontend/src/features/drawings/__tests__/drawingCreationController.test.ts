import assert from "node:assert/strict";
import test from "node:test";

import {
  beginAxisLineDrawing,
  beginTwoPointDrawing,
  commitTwoPointDrawing,
  placePositionDrawing,
  placeTextDrawing,
  startFreehandStroke,
} from "../drawingCreationController.js";
import type {
  DrawingDataPoint,
  DrawingPointerEvent,
  DrawingPrimitive,
  FreehandStrokeDraft,
  HorizontalDrawingAnchor,
  PositionToolId,
  ScreenPoint,
} from "../drawingTypes.js";
import type { DrawingCommand } from "../core/drawingCommands.js";
import type { FreehandDrawingPrimitive } from "../primitives/FreehandDrawingPrimitive.js";
import type { PositionDrawingPrimitive } from "../primitives/PositionDrawingPrimitive.js";
import type { TextDrawingPrimitive } from "../primitives/TextDrawingPrimitive.js";
import {
  malformedFixture,
  mustBeDefined,
  structuralMock,
} from "../../../test/testHelpers.js";

type TwoPointDrawingPrimitive = NonNullable<
  Parameters<typeof commitTwoPointDrawing>[0]["previewRef"]["current"]
>;
type TwoPointCreationTool = Parameters<typeof commitTwoPointDrawing>[0]["tool"];
type DrawingChartAdapter = NonNullable<
  ReturnType<Parameters<typeof placePositionDrawing>[0]["getChartAdapter"]>
>;

function eventStub(): DrawingPointerEvent {
  return {
    altKey: false,
    shiftKey: false,
    preventDefault() {},
    stopPropagation() {},
  };
}

function trackedEventStub() {
  const calls = { preventDefault: 0, stopPropagation: 0 };
  return {
    calls,
    event: {
      altKey: false,
      shiftKey: false,
      preventDefault() { calls.preventDefault += 1; },
      stopPropagation() { calls.stopPropagation += 1; },
    },
  };
}

function derivedPoint(time: number, sourceOrdinal: number, price: number): DrawingDataPoint {
  return {
    time,
    sourceOrdinal,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:atr:14:10:0.01",
    price,
  };
}

function sourceLineageCaptureBatch(identity: object = {}) {
  return {
    captureIdentity: identity,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:atr:14:10:0.01",
    captures: [{
      span: {
        exact: {
          left: { time: 100, sourceOrdinal: 0 },
          right: { time: 100, sourceOrdinal: 1 },
        },
        fallback: {
          fromTime: 100,
          toTime: 100,
          leftRatio: 0.25,
          rightRatio: 0.75,
        },
      },
      ratio: 0.4,
      price: 10,
      screen: { x: 20, y: 30 },
    }],
  };
}

test("confirmed attach failure never publishes or persists a new primitive", () => {
  const freehandPrimitives: { current: DrawingPrimitive[] } = { current: [] };
  const currentFreehandRef: { current: FreehandDrawingPrimitive | null } = { current: null };
  const freehandDraftRef: { current: FreehandStrokeDraft | null } = { current: null };
  const isDrawingFreehandRef = { current: false };
  assert.equal(startFreehandStroke({
    tool: "pen",
    pos: { x: 10, y: 20 },
    e: eventStub(),
    primitivesRef: freehandPrimitives,
    currentFreehandRef,
    freehandDraftRef,
    isDrawingFreehandRef,
    attachPrim: () => false,
    screenToData: () => ({ time: 1, price: 1 }),
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
  }), true);
  assert.deepEqual(freehandPrimitives.current, []);
  assert.equal(currentFreehandRef.current, null);
  assert.equal(freehandDraftRef.current, null);
  assert.equal(isDrawingFreehandRef.current, false);

  const textPrimitives: { current: DrawingPrimitive[] } = { current: [] };
  let textEditorStarts = 0;
  assert.equal(placeTextDrawing({
    pos: { x: 10, y: 20 },
    e: eventStub(),
    primitivesRef: textPrimitives,
    attachPrim: () => false,
    startTextEditing: () => { textEditorStarts += 1; return true; },
    cancelTextEditing: () => true,
    screenToDrawingData: () => ({ time: 1, price: 1 }),
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    textFontSizeRef: { current: 14 },
    textBoldRef: { current: false },
    textItalicRef: { current: false },
  }), true);
  assert.deepEqual(textPrimitives.current, []);
  assert.equal(textEditorStarts, 0);

  const positionPrimitives: { current: DrawingPrimitive[] } = { current: [] };
  let selected = 0;
  let persisted = 0;
  assert.equal(placePositionDrawing({
    tool: "position-long",
    pos: { x: 100, y: 20 },
    e: eventStub(),
    primitivesRef: positionPrimitives,
    attachPrim: () => false,
    selectPrimitive: () => { selected += 1; },
    persistDrawings: () => { persisted += 1; },
    screenToDrawingData: (x) => x === 100
      ? { time: 1, price: 10 }
      : { time: 2, price: 10 },
    getChartAdapter: () => structuralMock<DrawingChartAdapter>({
      isReady: () => true,
      getVisiblePriceRange: () => 100,
    }),
    chartContainerRef: {
      current: structuralMock<HTMLElement>({ clientHeight: 400, clientWidth: 800 }),
    },
    drawingSnapEnabledRef: { current: true },
    positionSizeRef: { current: 1_000 },
  }), true);
  assert.deepEqual(positionPrimitives.current, []);
  assert.equal(selected, 0);
  assert.equal(persisted, 0);

  const axisPrimitives: { current: DrawingPrimitive[] } = { current: [] };
  const draggingRef = { current: null };
  assert.equal(beginAxisLineDrawing({
    tool: "line-horizontal",
    pos: { x: 10, y: 20 },
    e: eventStub(),
    primitivesRef: axisPrimitives,
    anchorDataRef: { current: null },
    previewRef: { current: null },
    draggingRef,
    attachPrim: () => false,
    selectPrimitive: () => { selected += 1; },
    persistDrawings: () => true,
    removePreview() { return true; },
    screenToDrawingData: () => ({ time: 1, price: 10 }),
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
  }), true);
  assert.deepEqual(axisPrimitives.current, []);
  assert.equal(draggingRef.current, null);
  assert.equal(selected, 0);

  const previewAnchorRef = { current: null as DrawingDataPoint | null };
  const failedPreviewRef = { current: null as TwoPointDrawingPrimitive | null };
  assert.equal(beginTwoPointDrawing({
    tool: "line-segment",
    pos: { x: 10, y: 20 },
    e: eventStub(),
    anchorDataRef: previewAnchorRef,
    previewRef: failedPreviewRef,
    attachPrim: () => false,
    screenToDrawingData: () => ({ time: 1, price: 10 }),
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
    fibLevelsRef: { current: [] },
    fibInvertedRef: { current: false },
  }), true);
  assert.equal(previewAnchorRef.current, null);
  assert.equal(failedPreviewRef.current, null);

  const committedAnchor = { time: 1, price: 10 };
  const retainedPreview = structuralMock<TwoPointDrawingPrimitive>({ id: "__preview__" });
  const committedAnchorRef = { current: committedAnchor };
  const retainedPreviewRef = { current: retainedPreview };
  const surfaceCalls: Array<[string, DrawingPrimitive]> = [];
  assert.equal(commitTwoPointDrawing({
    tool: "line-segment",
    pos: { x: 20, y: 30 },
    e: eventStub(),
    primitivesRef: { current: [] },
    anchorDataRef: committedAnchorRef,
    previewRef: retainedPreviewRef,
    attachPrim: (primitive) => {
      surfaceCalls.push(["attach", primitive]);
      return primitive === retainedPreview;
    },
    detachPrim: (primitive) => {
      surfaceCalls.push(["detach", primitive]);
      return primitive === retainedPreview;
    },
    selectPrimitive: () => { selected += 1; },
    persistDrawings: () => { persisted += 1; },
    screenToDrawingData: () => ({ time: 2, price: 20 }),
    dataToScreen: () => ({ x: 0, y: 0 }),
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
    fibLevelsRef: { current: [] },
    fibInvertedRef: { current: false },
  }), true);
  assert.strictEqual(committedAnchorRef.current, committedAnchor);
  assert.strictEqual(retainedPreviewRef.current, retainedPreview);
  assert.equal(surfaceCalls[0]?.[0], "detach");
  assert.strictEqual(surfaceCalls[0]?.[1], retainedPreview);
  assert.equal(surfaceCalls[1]?.[0], "attach");
  assert.notStrictEqual(surfaceCalls[1]?.[1], retainedPreview);
  assert.deepEqual(surfaceCalls[2], ["attach", retainedPreview]);
  assert.equal(selected, 0);
  assert.equal(persisted, 0);
});

test("text placement immediately cancels an editor draft whose coordinate is unavailable", () => {
  for (const cancelled of [true, false]) {
    const primitivesRef: { current: DrawingPrimitive[] } = { current: [] };
    const attached: DrawingPrimitive[] = [];
    let trackedDraft: TextDrawingPrimitive | null = null;
    let cancelOptions: Readonly<{ clearSelection?: boolean; exitTool?: boolean }> | undefined;

    assert.equal(placeTextDrawing({
      pos: { x: 10, y: 20 },
      e: eventStub(),
      primitivesRef,
      attachPrim(primitive) {
        attached.push(primitive);
        return true;
      },
      startTextEditing(primitive) {
        trackedDraft = primitive;
        return false;
      },
      cancelTextEditing(options) {
        cancelOptions = options;
        if (cancelled) primitivesRef.current = [];
        return cancelled;
      },
      screenToDrawingData: () => ({ time: 1, price: 1 }),
      drawingSnapEnabledRef: { current: true },
      penColorRef: { current: "#fff" },
      textFontSizeRef: { current: 14 },
      textBoldRef: { current: false },
      textItalicRef: { current: false },
    }), true);

    assert.equal(attached.length, 1);
    assert.strictEqual(trackedDraft, attached[0]);
    assert.equal(
      structuralMock<TextDrawingPrimitive>(mustBeDefined(attached[0])).isUnconfirmedText,
      true,
    );
    assert.deepEqual(cancelOptions, { clearSelection: true, exitTool: false });
    assert.equal(
      primitivesRef.current.length,
      cancelled ? 0 : 1,
      "a failed checked detach keeps the explicitly tracked draft retryable",
    );
  }
});

test("axis-line creation fails closed when an existing preview cannot detach", () => {
  const anchor = { time: 1, price: 10 };
  const preview = structuralMock<TwoPointDrawingPrimitive>({ id: "__preview__" });
  const anchorDataRef = { current: anchor };
  const previewRef = { current: preview };
  const draggingRef = { current: null };
  let attached = 0;
  let persisted = 0;
  let selected = 0;
  let converted = 0;

  assert.equal(beginAxisLineDrawing({
    tool: "line-horizontal",
    pos: { x: 10, y: 20 },
    e: eventStub(),
    primitivesRef: { current: [] },
    anchorDataRef,
    previewRef,
    draggingRef,
    attachPrim() { attached += 1; return true; },
    selectPrimitive() { selected += 1; },
    persistDrawings() { persisted += 1; return true; },
    removePreview: () => false,
    screenToDrawingData() { converted += 1; return { time: 2, price: 20 }; },
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
  }), true);

  assert.strictEqual(anchorDataRef.current, anchor);
  assert.strictEqual(previewRef.current, preview);
  assert.equal(draggingRef.current, null);
  assert.equal(converted, 0);
  assert.equal(attached, 0);
  assert.equal(persisted, 0);
  assert.equal(selected, 0);
});

test("invalid create payloads are rejected before final surface attachment", () => {
  let positionAttaches = 0;
  let positionPersists = 0;
  assert.equal(placePositionDrawing({
    tool: "position-long",
    pos: { x: 100, y: 20 },
    e: eventStub(),
    primitivesRef: { current: [] },
    attachPrim() { positionAttaches += 1; return true; },
    detachPrim: () => true,
    selectPrimitive() {},
    persistDrawings() { positionPersists += 1; return true; },
    screenToDrawingData: (x) => x === 100
      ? { time: 1, price: 10 }
      : { time: 2, price: 10 },
    getChartAdapter: () => structuralMock<DrawingChartAdapter>({
      isReady: () => true,
      getVisiblePriceRange: () => 100,
    }),
    chartContainerRef: {
      current: structuralMock<HTMLElement>({ clientHeight: 400, clientWidth: 800 }),
    },
    drawingSnapEnabledRef: { current: true },
    positionSizeRef: { current: Number.POSITIVE_INFINITY },
  }), true);
  assert.equal(positionAttaches, 0);
  assert.equal(positionPersists, 0);

  const anchor = { time: 1, price: 10 };
  const preview = structuralMock<TwoPointDrawingPrimitive>({ id: "__preview__" });
  const anchorDataRef = { current: anchor };
  const previewRef = { current: preview };
  let finalAttaches = 0;
  let previewDetaches = 0;
  let fibPersists = 0;
  assert.equal(commitTwoPointDrawing({
    tool: "fibonacci",
    pos: { x: 20, y: 30 },
    e: eventStub(),
    primitivesRef: { current: [] },
    anchorDataRef,
    previewRef,
    attachPrim() { finalAttaches += 1; return true; },
    detachPrim() { previewDetaches += 1; return true; },
    selectPrimitive() {},
    persistDrawings() { fibPersists += 1; return true; },
    screenToDrawingData: () => ({ time: 2, price: 20 }),
    dataToScreen: () => ({ x: 0, y: 0 }),
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
    fibLevelsRef: {
      current: [{ level: Number.POSITIVE_INFINITY, color: "#fff", enabled: true }],
    },
    fibInvertedRef: { current: false },
  }), true);
  assert.strictEqual(anchorDataRef.current, anchor);
  assert.strictEqual(previewRef.current, preview);
  assert.equal(finalAttaches, 0);
  assert.equal(previewDetaches, 0);
  assert.equal(fibPersists, 0);
});

test("persistence rejection compensates an attached created primitive before selection", () => {
  const primitivesRef: { current: DrawingPrimitive[] } = { current: [] };
  const attached: DrawingPrimitive[] = [];
  const detached: DrawingPrimitive[] = [];
  let selected = 0;
  assert.equal(placePositionDrawing({
    tool: "position-short",
    pos: { x: 100, y: 20 },
    e: eventStub(),
    primitivesRef,
    attachPrim(primitive) { attached.push(primitive); return true; },
    detachPrim(primitive) { detached.push(primitive); return true; },
    selectPrimitive() { selected += 1; },
    persistDrawings: () => false,
    screenToDrawingData: (x) => x === 100
      ? { time: 1, price: 10 }
      : { time: 2, price: 10 },
    getChartAdapter: () => structuralMock<DrawingChartAdapter>({
      isReady: () => true,
      getVisiblePriceRange: () => 100,
    }),
    chartContainerRef: {
      current: structuralMock<HTMLElement>({ clientHeight: 400, clientWidth: 800 }),
    },
    drawingSnapEnabledRef: { current: true },
    positionSizeRef: { current: 1_000 },
  }), true);
  assert.equal(attached.length, 1);
  assert.deepEqual(detached, attached);
  assert.deepEqual(primitivesRef.current, []);
  assert.equal(selected, 0);
});

test("two-point preview detach failure never attaches or publishes the candidate", () => {
  const anchor = { time: 1, price: 10 };
  const preview = structuralMock<TwoPointDrawingPrimitive>({ id: "__preview__" });
  const anchorDataRef = { current: anchor };
  const previewRef = { current: preview };
  const primitivesRef: { current: DrawingPrimitive[] } = { current: [] };
  const attached: DrawingPrimitive[] = [];
  const rolledBack: DrawingPrimitive[] = [];
  let selected = 0;
  let persisted = 0;

  assert.equal(commitTwoPointDrawing({
    tool: "line-segment",
    pos: { x: 20, y: 30 },
    e: eventStub(),
    primitivesRef,
    anchorDataRef,
    previewRef,
    attachPrim(primitive) {
      attached.push(primitive);
      return true;
    },
    detachPrim(primitive) {
      if (primitive === preview) return false;
      rolledBack.push(primitive);
      return true;
    },
    selectPrimitive: () => { selected += 1; },
    persistDrawings: () => { persisted += 1; },
    screenToDrawingData: () => ({ time: 2, price: 20 }),
    dataToScreen: () => ({ x: 0, y: 0 }),
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
    fibLevelsRef: { current: [] },
    fibInvertedRef: { current: false },
  }), true);

  assert.equal(attached.length, 0);
  assert.deepEqual(rolledBack, []);
  assert.strictEqual(anchorDataRef.current, anchor);
  assert.strictEqual(previewRef.current, preview);
  assert.deepEqual(primitivesRef.current, []);
  assert.equal(selected, 0);
  assert.equal(persisted, 0);
});

test("failed final attach with failed preview compensation releases the detached draft", () => {
  const anchor = { time: 1, price: 10 };
  const preview = structuralMock<TwoPointDrawingPrimitive>({ id: "__preview__" });
  const anchorDataRef = { current: anchor };
  const previewRef = { current: preview };
  const primitivesRef: { current: DrawingPrimitive[] } = { current: [] };
  const attached: DrawingPrimitive[] = [];
  const detached: DrawingPrimitive[] = [];
  let selected = 0;
  let persisted = 0;

  assert.equal(commitTwoPointDrawing({
    tool: "line-segment",
    pos: { x: 20, y: 30 },
    e: eventStub(),
    primitivesRef,
    anchorDataRef,
    previewRef,
    attachPrim(primitive) {
      attached.push(primitive);
      return false;
    },
    detachPrim(primitive) {
      detached.push(primitive);
      return true;
    },
    selectPrimitive: () => { selected += 1; },
    persistDrawings: () => { persisted += 1; },
    screenToDrawingData: () => ({ time: 2, price: 20 }),
    dataToScreen: () => ({ x: 0, y: 0 }),
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
    fibLevelsRef: { current: [] },
    fibInvertedRef: { current: false },
  }), true);

  assert.deepEqual(detached, [preview]);
  assert.equal(attached.length, 2);
  assert.notStrictEqual(attached[0], preview);
  assert.strictEqual(attached[1], preview);
  assert.equal(anchorDataRef.current, null);
  assert.equal(previewRef.current, null);
  assert.deepEqual(primitivesRef.current, []);
  assert.equal(selected, 0);
  assert.equal(persisted, 0);
});

test("creation controller persists a complete create command payload", () => {
  const primitivesRef: { current: DrawingPrimitive[] } = { current: [] };
  const persisted: Array<readonly DrawingCommand[]> = [];

  assert.equal(placePositionDrawing({
    tool: "position-long",
    pos: { x: 100, y: 120 },
    e: eventStub(),
    primitivesRef,
    attachPrim: () => true,
    selectPrimitive() {},
    persistDrawings(commands) {
      persisted.push(commands);
      return true;
    },
    screenToDrawingData: (x) => x === 100
      ? { time: 100, price: 10 }
      : { time: 200, price: 10 },
    getChartAdapter: () => structuralMock<DrawingChartAdapter>({
      isReady: () => true,
      getVisiblePriceRange: () => 100,
    }),
    chartContainerRef: {
      current: structuralMock<HTMLElement>({ clientHeight: 400, clientWidth: 800 }),
    },
    drawingSnapEnabledRef: { current: true },
    positionSizeRef: { current: 1_000 },
  }), true);

  assert.equal(persisted.length, 1);
  const commands = mustBeDefined(persisted[0]);
  assert.equal(commands.length, 1);
  const command = mustBeDefined(commands[0]);
  assert.equal(command.type, "create");
  if (command.type !== "create") throw new Error("Expected a create command");
  const primitive = mustBeDefined(primitivesRef.current[0]);
  assert.equal(command.entity.id, primitive.id);
  assert.equal(command.entity.kind, "position");
  assert.equal(command.entity.geometry.kind, "position");
  assert.equal(command.entity.style.kind, "position");
  assert.deepEqual(
    Object.keys(command.entity).sort(),
    ["bounds", "geometry", "geometryRevision", "id", "kind", "style", "styleRevision"],
  );
});

test("source-lineage freehand creation starts a transient v2 draft preview", () => {
  const primitivesRef: { current: DrawingPrimitive[] } = { current: [] };
  const currentFreehandRef: { current: FreehandDrawingPrimitive | null } = { current: null };
  const freehandDraftRef: { current: FreehandStrokeDraft | null } = { current: null };
  const isDrawingFreehandRef = { current: false };
  const attached: DrawingPrimitive[] = [];

  assert.equal(startFreehandStroke({
    tool: "pen",
    pos: { x: 20, y: 30 },
    e: eventStub(),
    primitivesRef,
    currentFreehandRef,
    freehandDraftRef,
    isDrawingFreehandRef,
    attachPrim: (primitive) => { attached.push(primitive); return true; },
    screenToData: () => { throw new Error("source lineage must not fall back to v1"); },
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
    sourceLineage: true,
    captureBatch: sourceLineageCaptureBatch(),
  }), true);

  assert.equal(attached.length, 1);
  assert.strictEqual(primitivesRef.current[0], attached[0]);
  assert.strictEqual(currentFreehandRef.current, attached[0]);
  assert.ok(freehandDraftRef.current);
  assert.equal(isDrawingFreehandRef.current, true);
  const freehand = mustBeDefined(currentFreehandRef.current);
  assert.equal(freehand.isPreview, true);
  assert.deepEqual(freehand.previewPoints, [{ x: 20, y: 30 }]);
  assert.deepEqual(freehand.dataPoints, []);
});

test("synthetic freehand creation may start directly from an absolute future capture", () => {
  const identity = {};
  const primitivesRef: { current: DrawingPrimitive[] } = { current: [] };
  const currentFreehandRef: { current: FreehandDrawingPrimitive | null } = { current: null };
  const freehandDraftRef: { current: FreehandStrokeDraft | null } = { current: null };
  const freehandCaptureIdentityRef = { current: null };
  const isDrawingFreehandRef = { current: false };
  const attached: DrawingPrimitive[] = [];
  const captureBatch = {
    captureIdentity: identity,
    sourceProjection: "renko",
    sourceProjectionConfig: "dataset-a:renko:atr:14:10:0.01",
    captures: [{
      time: 300.5,
      price: 10,
      screen: { x: 200, y: 30 },
    }],
  };

  assert.equal(startFreehandStroke({
    tool: "pen",
    pos: { x: 200, y: 30 },
    e: eventStub(),
    primitivesRef,
    currentFreehandRef,
    freehandDraftRef,
    isDrawingFreehandRef,
    attachPrim: (primitive) => { attached.push(primitive); return true; },
    screenToData: () => { throw new Error("synthetic future capture must not use v1"); },
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
    sourceLineage: true,
    captureBatch,
    freehandCaptureIdentityRef,
  }), true);

  assert.equal(attached.length, 1);
  assert.ok(freehandDraftRef.current);
  assert.strictEqual(freehandCaptureIdentityRef.current, identity);
  assert.equal(isDrawingFreehandRef.current, true);
  assert.deepEqual(mustBeDefined(currentFreehandRef.current).previewPoints, [{ x: 200, y: 30 }]);
});

test("source-time freehand creation keeps the legacy model transient until pointerup", () => {
  const primitivesRef: { current: DrawingPrimitive[] } = { current: [] };
  const currentFreehandRef: { current: FreehandDrawingPrimitive | null } = { current: null };
  const freehandDraftRef: { current: FreehandStrokeDraft | null } = {
    current: structuralMock<FreehandStrokeDraft>({ stale: true }),
  };
  const isDrawingFreehandRef = { current: false };
  const point = { time: 100, logical: 1.5, price: 10 };

  assert.equal(startFreehandStroke({
    tool: "highlighter",
    pos: { x: 20, y: 30 },
    e: eventStub(),
    primitivesRef,
    currentFreehandRef,
    freehandDraftRef,
    isDrawingFreehandRef,
    attachPrim() { return true; },
    screenToData: () => point,
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 8 },
  }), true);

  assert.equal(freehandDraftRef.current, null);
  assert.equal(mustBeDefined(currentFreehandRef.current).isPreview, true);
  assert.deepEqual(mustBeDefined(currentFreehandRef.current).dataPoints, [point]);
});

test("source-lineage freehand creation fails closed without an atomic capture", () => {
  const primitivesRef: { current: DrawingPrimitive[] } = { current: [] };
  const currentFreehandRef: { current: FreehandDrawingPrimitive | null } = { current: null };
  const freehandDraftRef: { current: FreehandStrokeDraft | null } = { current: null };
  const isDrawingFreehandRef = { current: false };

  const tracked = trackedEventStub();
  assert.equal(startFreehandStroke({
    tool: "pen",
    pos: { x: 20, y: 30 },
    e: tracked.event,
    primitivesRef,
    currentFreehandRef,
    freehandDraftRef,
    isDrawingFreehandRef,
    attachPrim() { return true; },
    screenToData: () => derivedPoint(100, 0, 10),
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
    sourceLineage: true,
    captureBatch: null,
  }), true);

  assert.deepEqual(primitivesRef.current, []);
  assert.equal(currentFreehandRef.current, null);
  assert.equal(freehandDraftRef.current, null);
  assert.equal(isDrawingFreehandRef.current, false);
  assert.deepEqual(tracked.calls, { preventDefault: 1, stopPropagation: 1 });
});

test("active text and position tools retain pointer ownership when first capture fails", () => {
  const textEvent = trackedEventStub();
  assert.equal(placeTextDrawing({
    pos: { x: 10, y: 20 },
    e: textEvent.event,
    primitivesRef: { current: [] },
    attachPrim() { return true; },
    startTextEditing() { return true; },
    cancelTextEditing: () => true,
    screenToDrawingData: () => null,
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    textFontSizeRef: { current: 14 },
    textBoldRef: { current: false },
    textItalicRef: { current: false },
  }), true);
  assert.deepEqual(textEvent.calls, { preventDefault: 1, stopPropagation: 1 });

  const positionEvent = trackedEventStub();
  assert.equal(placePositionDrawing({
    tool: "position-long",
    pos: { x: 10, y: 20 },
    e: positionEvent.event,
    primitivesRef: { current: [] },
    attachPrim() { return true; },
    selectPrimitive() {},
    persistDrawings() {},
    screenToDrawingData: () => null,
    getChartAdapter: () => { throw new Error("adapter should not be read"); },
    chartContainerRef: { current: null },
    drawingSnapEnabledRef: { current: true },
    positionSizeRef: { current: 1000 },
  }), true);
  assert.deepEqual(positionEvent.calls, { preventDefault: 1, stopPropagation: 1 });
});

test("position tool retains pointer ownership when its second row cannot resolve", () => {
  const tracked = trackedEventStub();
  const primitivesRef = { current: [] };
  let persisted = 0;
  assert.equal(placePositionDrawing({
    tool: "position-short",
    pos: { x: 100, y: 20 },
    e: tracked.event,
    primitivesRef,
    attachPrim() { return true; },
    selectPrimitive() {},
    persistDrawings: () => { persisted += 1; },
    screenToDrawingData: (x) => (x === 100 ? derivedPoint(100, 0, 10) : null),
    getChartAdapter: () => structuralMock<DrawingChartAdapter>({ isReady: () => true }),
    chartContainerRef: { current: structuralMock<HTMLElement>({ clientHeight: 400, clientWidth: 800 }) },
    drawingSnapEnabledRef: { current: true },
    positionSizeRef: { current: 1000 },
  }), true);
  assert.deepEqual(tracked.calls, { preventDefault: 1, stopPropagation: 1 });
  assert.deepEqual(primitivesRef.current, []);
  assert.equal(persisted, 0);
});

test("pending two-point placement owns a failed second capture, but an inapplicable commit does not", () => {
  const pendingEvent = trackedEventStub();
  const anchor = derivedPoint(100, 0, 10);
  const preview = structuralMock<TwoPointDrawingPrimitive>({ id: "__preview__" });
  const anchorDataRef = { current: anchor };
  const previewRef = { current: preview };
  assert.equal(commitTwoPointDrawing({
    tool: "line-segment",
    pos: { x: 20, y: 30 },
    e: pendingEvent.event,
    primitivesRef: { current: [] },
    anchorDataRef,
    previewRef,
    attachPrim() { return true; },
    detachPrim() { return true; },
    selectPrimitive() {},
    persistDrawings() {},
    screenToDrawingData: () => null,
    dataToScreen: () => ({ x: 0, y: 0 }),
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
    fibLevelsRef: { current: [] },
    fibInvertedRef: { current: false },
  }), true);
  assert.deepEqual(pendingEvent.calls, { preventDefault: 1, stopPropagation: 1 });
  assert.strictEqual(anchorDataRef.current, anchor);
  assert.strictEqual(previewRef.current, preview);

  const inactiveEvent = trackedEventStub();
  assert.equal(commitTwoPointDrawing(structuralMock<Parameters<typeof commitTwoPointDrawing>[0]>({
    tool: "line-segment",
    pos: { x: 20, y: 30 },
    e: inactiveEvent.event,
    anchorDataRef: { current: null },
    previewRef: { current: null },
  })), false);
  assert.deepEqual(inactiveEvent.calls, { preventDefault: 0, stopPropagation: 0 });
});

test("axis-line and first two-point capture failures retain active-tool pointer ownership", () => {
  const axisEvent = trackedEventStub();
  assert.equal(beginAxisLineDrawing({
    tool: "line-vertical",
    pos: { x: 10, y: 20 },
    e: axisEvent.event,
    primitivesRef: { current: [] },
    anchorDataRef: { current: null },
    previewRef: { current: null },
    draggingRef: { current: null },
    attachPrim() { return true; },
    selectPrimitive() {},
    persistDrawings: () => true,
    removePreview() { return true; },
    screenToDrawingData: () => null,
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
  }), true);
  assert.deepEqual(axisEvent.calls, { preventDefault: 1, stopPropagation: 1 });

  const twoPointEvent = trackedEventStub();
  assert.equal(beginTwoPointDrawing({
    tool: "shape-rectangle",
    pos: { x: 10, y: 20 },
    e: twoPointEvent.event,
    anchorDataRef: { current: null },
    previewRef: { current: null },
    attachPrim() { return true; },
    screenToDrawingData: () => null,
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
    fibLevelsRef: { current: [] },
    fibInvertedRef: { current: false },
  }), true);
  assert.deepEqual(twoPointEvent.calls, { preventDefault: 1, stopPropagation: 1 });
});

interface CapturedTwoPointDrawing {
  _shapeType?: string;
  _type?: string;
  dataPoints: DrawingDataPoint[];
  type?: string;
}

function commitDerivedTwoPointTool(tool: TwoPointCreationTool): CapturedTwoPointDrawing {
  const first = derivedPoint(100, 1, 10);
  const second = derivedPoint(200, 2, 20);
  const primitivesRef: { current: DrawingPrimitive[] } = { current: [] };
  const anchorDataRef = { current: first };
  const preview = structuralMock<TwoPointDrawingPrimitive>({ id: "__preview__" });
  const previewRef = { current: preview };
  const attached: DrawingPrimitive[] = [];
  const detached: DrawingPrimitive[] = [];
  let persisted = 0;

  const consumed = commitTwoPointDrawing({
    tool,
    pos: { x: 20, y: 30 },
    e: eventStub(),
    primitivesRef,
    anchorDataRef,
    previewRef,
    attachPrim: (primitive) => { attached.push(primitive); return true; },
    detachPrim: (primitive) => { detached.push(primitive); return true; },
    selectPrimitive() {},
    persistDrawings: () => { persisted += 1; },
    screenToDrawingData: () => second,
    dataToScreen: () => ({ x: 0, y: 0 }),
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    penSizeRef: { current: 2 },
    fibLevelsRef: { current: [] },
    fibInvertedRef: { current: false },
  });

  assert.equal(consumed, true);
  assert.deepEqual(detached, [preview]);
  assert.equal(attached.length, 1);
  assert.strictEqual(primitivesRef.current[0], attached[0]);
  const finalDrawing = structuralMock<CapturedTwoPointDrawing>(mustBeDefined(attached[0]));
  assert.deepEqual(finalDrawing.dataPoints, [first, second]);
  assert.equal(anchorDataRef.current, null);
  assert.equal(previewRef.current, null);
  assert.equal(persisted, 1);
  return finalDrawing;
}

test("angle measurement commits canonical source-lineage endpoints", () => {
  const primitive = commitDerivedTwoPointTool("angle-measure");
  assert.equal(primitive.type, "angle-measure");
});

test("shape drawing commits canonical source-lineage corners", () => {
  const primitive = commitDerivedTwoPointTool("shape-rectangle");
  assert.equal(primitive._type, "shape");
  assert.equal(primitive._shapeType, "rectangle");
});

test("text drawing keeps its canonical source-lineage anchor", () => {
  const dataPoint = derivedPoint(300, 3, 30);
  const primitivesRef = { current: [] };
  let editingPrimitive = null;
  const attached: DrawingPrimitive[] = [];

  assert.equal(placeTextDrawing({
    pos: { x: 10, y: 20 },
    e: eventStub(),
    primitivesRef,
    attachPrim: (primitive) => { attached.push(primitive); return true; },
    startTextEditing: (primitive) => { editingPrimitive = primitive; return true; },
    cancelTextEditing: () => true,
    screenToDrawingData: () => dataPoint,
    drawingSnapEnabledRef: { current: true },
    penColorRef: { current: "#fff" },
    textFontSizeRef: { current: 14 },
    textBoldRef: { current: false },
    textItalicRef: { current: false },
  }), true);

  assert.equal(attached.length, 1);
  assert.strictEqual(primitivesRef.current[0], attached[0]);
  assert.strictEqual(editingPrimitive, attached[0]);
  assert.deepEqual(structuralMock<TextDrawingPrimitive>(mustBeDefined(attached[0])).dataPoint, dataPoint);
});

interface PlaceDerivedPositionOptions {
  pointerX?: number;
  width?: number;
  adapterOverrides?: object;
  candidateForX?: (x: number) => object | null;
}

function placeDerivedPosition(tool: PositionToolId, {
  pointerX = 100,
  width = 1000,
  adapterOverrides = {},
  candidateForX = (x) => (x >= 200
    ? { ...derivedPoint(200, 2, 100), order: 9, logical: 91 }
    : null),
}: PlaceDerivedPositionOptions = {}) {
  const pointerData = malformedFixture<DrawingDataPoint>({
    ...derivedPoint(100, 1, 100),
    order: 7,
    logical: 71,
  });
  const primitivesRef: { current: DrawingPrimitive[] } = { current: [] };
  const attached: PositionDrawingPrimitive[] = [];
  const convertedXs: number[] = [];
  let persisted = 0;

  const consumed = placePositionDrawing({
    tool,
    pos: { x: pointerX, y: 120 },
    e: eventStub(),
    primitivesRef,
    attachPrim: (primitive) => {
      attached.push(structuralMock<PositionDrawingPrimitive>(primitive));
      return true;
    },
    selectPrimitive() {},
    persistDrawings: () => { persisted += 1; },
    screenToDrawingData: (x) => {
      convertedXs.push(x);
      if (Math.abs(x - pointerX) < 0.5) return pointerData;
      const candidate = candidateForX(x);
      return candidate ? structuralMock<DrawingDataPoint>(candidate) : null;
    },
    getChartAdapter: () => structuralMock<DrawingChartAdapter>({
      isReady: () => true,
      getVisibleTimeRange() {
        throw new Error("position creation must not subtract ordinal visible-range objects");
      },
      getVisiblePriceRange: () => 100,
      ...adapterOverrides,
    }),
    chartContainerRef: { current: structuralMock<HTMLElement>({ clientHeight: 400, clientWidth: width }) },
    drawingSnapEnabledRef: { current: true },
    positionSizeRef: { current: 2500 },
  });

  return { attached, consumed, convertedXs, persisted, primitivesRef };
}

test("derived long and short positions use two canonical screen-row anchors", () => {
  const cases: Array<[PositionToolId, "long" | "short"]> = [
    ["position-long", "long"],
    ["position-short", "short"],
  ];
  for (const [tool, direction] of cases) {
    const result = placeDerivedPosition(tool);
    assert.equal(result.consumed, true);
    assert.equal(result.attached.length, 1);
    assert.strictEqual(result.primitivesRef.current[0], result.attached[0]);
    assert.equal(result.persisted, 1);
    const attached = mustBeDefined(result.attached[0]);
    assert.equal(attached.direction, direction);
    assert.deepEqual(attached.timeRange, {
      start: {
        time: 100,
        sourceOrdinal: 1,
        sourceProjection: "renko",
        sourceProjectionConfig: "dataset-a:renko:atr:14:10:0.01",
      },
      end: {
        time: 200,
        sourceOrdinal: 2,
        sourceProjection: "renko",
        sourceProjectionConfig: "dataset-a:renko:atr:14:10:0.01",
      },
    });
    assert.equal(mustBeDefined(result.convertedXs[0]), 100);
    assert.ok(Math.abs(mustBeDefined(result.convertedXs[1]) - 250) < 1);
    assert.equal(JSON.stringify(attached.timeRange).includes("logical"), false);
    assert.equal(JSON.stringify(attached.timeRange).includes("order"), false);
  }
});

test("position creation tries the opposite screen direction near the right edge", () => {
  const result = placeDerivedPosition("position-long", {
    pointerX: 980,
    candidateForX: (x) => (x < 900
      ? { ...derivedPoint(50, 0, 100), order: 1, logical: 2 }
      : { ...derivedPoint(300, 0, 100), order: 3, logical: 4 }),
  });

  assert.equal(result.attached.length, 1);
  assert.equal(mustBeDefined(result.convertedXs[0]), 980);
  assert.ok(Math.abs(mustBeDefined(result.convertedXs[1]) - 830) < 1);
  assert.equal(result.convertedXs.length, 2);
  const attached = mustBeDefined(result.attached[0]);
  assert.equal(anchorTime(attached.timeRange.start), 50);
  assert.equal(anchorTime(attached.timeRange.end), 100);
});

test("position creation refuses a duplicate or unresolved second display row", () => {
  const result = placeDerivedPosition("position-long", {
    candidateForX: () => ({
      ...derivedPoint(100, 1, 100),
      order: 999,
      logical: 999,
    }),
  });

  assert.equal(result.consumed, true);
  assert.equal(result.attached.length, 0);
  assert.equal(result.primitivesRef.current.length, 0);
  assert.equal(result.persisted, 0);
});

test("derived positions may extend from materialized lineage into absolute future time", () => {
  const result = placeDerivedPosition("position-long", {
    pointerX: 700,
    adapterOverrides: { getTimeScaleWidth: () => 900 },
    candidateForX: (x) => (x > 800 && x < 900
      ? { time: 300.5, price: 100 }
      : null),
  });

  assert.equal(result.attached.length, 1);
  const convertedX = mustBeDefined(result.convertedXs[1]);
  const attached = mustBeDefined(result.attached[0]);
  assert.ok(Math.abs(convertedX - 834.85) < 1);
  assert.ok(convertedX < 900);
  assert.equal(anchorTime(attached.timeRange.start), 100);
  assert.deepEqual(attached.timeRange.end, { time: 300.5 });
  assert.equal(JSON.stringify(attached.timeRange).includes("logical"), false);
  assert.equal(JSON.stringify(attached.timeRange).includes("order"), false);
});

function anchorTime(anchor: HorizontalDrawingAnchor | null): number | null | undefined {
  if (typeof anchor === "number") return anchor;
  return anchor && "time" in anchor ? anchor.time : undefined;
}
