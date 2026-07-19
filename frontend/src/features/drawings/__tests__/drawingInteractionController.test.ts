import assert from "node:assert/strict";
import test from "node:test";

import {
  limitFreehandCapturePositions,
  mergePendingActiveDrawingMove,
} from "../drawingMoveBatch.js";
import {
  acquireDrawingExportInteractionPresentation,
  canApplyDrawingVisibilityToCurrentPrimitives,
  cancelFreehandPrimitiveOnSurface,
  commitSavedDrawingAfterDynamicFrame,
  createDrawingPointerRectCache,
  createDrawingExportVisibilityIntentGate,
  detachAndRemoveDrawingPrimitive,
  dynamicDecorationsForSavedDrawingDraft,
  dynamicPassiveFeedbackDecorations,
  dynamicSelectedHandleDecoration,
  dynamicSelectionHandlesForSavedDrawing,
  hitTestSelectedOverlayDrawingHandle,
  hitTestOverlayDrawingEntity,
  isDrawingCoordinateCleanupBoundaryCurrent,
  resolvePassiveCursorSelectedNonTextHit,
  resolveTopmostDrawingInteractionHit,
  runDrawingPointerTransientBarrier,
  runDrawingSurfaceDisposeBoundaryLifecycle,
  runDrawingSurfaceDisposeBarrier,
  scenePaintCoversDrawingHandoff,
  shouldDeferDrawingCoordinateCleanupToChartTypeBoundary,
  subscribeDrawingPointerRectInvalidation,
  withDrawingExportCaptureScene,
} from "../drawingInteractionController.js";
import type { DrawingExportLease } from "../drawingInteractionController.js";
import {
  abandonDrawingInteractionLifecycleActiveGesture,
  beginDrawingInteractionLifecycleFreehandGesture,
  markDrawingInteractionLifecycleBoundaryChange,
  readDrawingInteractionLifecycle,
  resetDrawingInteractionLifecycle,
} from "../interaction/drawingInteractionLifecycle.js";
import {
  canRecoverDrawingVisibleSceneInPlace,
  isDrawingVisibleScenePublicationReady,
  prepareDrawingMutationScope,
  restorePrePresentationHiddenDrawingSceneRuntime,
} from "../useDrawingPersistenceLifecycle.js";
import type { FreehandDrawingPrimitive } from "../primitives/FreehandDrawingPrimitive.js";
import type { DrawingPrimitiveHit } from "../drawingSelectionController.js";
import type { DrawingDisplayHitResult } from "../rendering/drawingDisplayList.js";
import type {
  ActiveDrawingMovePayload,
  DrawingDataToScreen,
  DrawingPrimitive,
  SavedDrawing,
  ScreenPoint,
} from "../drawingTypes.js";
import {
  malformedFixture,
  mustBeDefined,
  structuralMock,
} from "../../../test/testHelpers.js";

function point(x: number): ScreenPoint {
  return { x, y: x };
}

test("pointerdown recaptures geometry after a passive hover cached the previous rect", () => {
  let rect = structuralMock<DOMRect>({ left: 40, top: 80 });
  let rectReads = 0;
  const container = structuralMock<HTMLElement>({
    getBoundingClientRect() {
      rectReads += 1;
      return rect;
    },
  });
  const cache = createDrawingPointerRectCache();

  cache.capture(container);
  assert.equal(cache.peek()?.left, 40);
  rect = structuralMock<DOMRect>({ left: 140, top: 180 });
  assert.equal(cache.peek()?.left, 40, "passive pointermove must only read the cached rect");

  const pointerDownRect = cache.capture(container);
  assert.equal(pointerDownRect.left, 140);
  assert.equal(pointerDownRect.top, 180);
  assert.equal(rectReads, 2);
});

test("pointer rect layout subscriptions refresh out of band and fully clean up", () => {
  let rect = structuralMock<DOMRect>({ left: 10, top: 20 });
  let rectReads = 0;
  const documentTarget = structuralMock<Document>({});
  const container = structuralMock<HTMLElement>({
    ownerDocument: documentTarget,
    getBoundingClientRect() {
      rectReads += 1;
      return rect;
    },
  });
  const listeners = new Map<string, EventListener>();
  const removed: string[] = [];
  const eventTarget = {
    addEventListener(type: string, listener: EventListener) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      assert.strictEqual(listeners.get(type), listener);
      listeners.delete(type);
      removed.push(type);
    },
  };
  let resizeListener: ResizeObserverCallback | null = null;
  let observed: Element | null = null;
  let disconnected = 0;
  const cache = createDrawingPointerRectCache();
  const cleanup = subscribeDrawingPointerRectInvalidation({
    cache,
    container,
    eventTarget,
    createResizeObserver(listener) {
      resizeListener = listener;
      return {
        observe(target) { observed = target; },
        disconnect() { disconnected += 1; },
      };
    },
  });

  assert.strictEqual(observed, container);
  assert.equal(cache.peek()?.left, 10);
  assert.equal(rectReads, 1);

  const descendant = structuralMock<EventTarget>({});
  const unrelatedScroller = structuralMock<EventTarget>({
    contains: () => false,
  });
  listeners.get("scroll")?.(structuralMock<Event>({ target: descendant }));
  listeners.get("scroll")?.(structuralMock<Event>({ target: unrelatedScroller }));
  listeners.get("scroll")?.(structuralMock<Event>({ target: container }));
  assert.equal(rectReads, 1, "descendant, unrelated, and self scrolls must not read layout");

  const scrollAncestor = structuralMock<EventTarget>({
    contains: (candidate: Node | null) => candidate === container,
  });
  rect = structuralMock<DOMRect>({ left: 30, top: 40 });
  listeners.get("scroll")?.(structuralMock<Event>({ target: scrollAncestor }));
  assert.equal(cache.peek()?.left, 30);
  rect = structuralMock<DOMRect>({ left: 40, top: 50 });
  listeners.get("scroll")?.(structuralMock<Event>({ target: eventTarget as EventTarget }));
  assert.equal(cache.peek()?.left, 40, "window scroll must refresh");
  rect = structuralMock<DOMRect>({ left: 45, top: 55 });
  listeners.get("scroll")?.(structuralMock<Event>({ target: documentTarget }));
  assert.equal(cache.peek()?.left, 45, "document scroll must refresh");
  rect = structuralMock<DOMRect>({ left: 50, top: 60 });
  const notifyResize = resizeListener as ResizeObserverCallback | null;
  assert.ok(notifyResize);
  notifyResize([], structuralMock<ResizeObserver>({}));
  assert.equal(cache.peek()?.left, 50);
  assert.equal(rectReads, 5);

  cleanup();
  cleanup();
  assert.equal(cache.peek(), null);
  assert.equal(disconnected, 1);
  assert.deepEqual(removed.sort(), ["resize", "scroll"]);
  assert.equal(listeners.size, 0);

  notifyResize([], structuralMock<ResizeObserver>({}));
  assert.equal(rectReads, 5, "a disposed observer callback must not refresh the cache");
});

test("scene paint handoff ignores superseded viewport but rejects wrong ownership or stale document", () => {
  const ticket = {
    scopeKey: "BTCUSDT",
    documentRevision: 7,
    surfaceGeneration: 3,
    viewportRevision: 11,
  } as const;

  assert.equal(scenePaintCoversDrawingHandoff(ticket, {
    ...ticket,
    viewportRevision: 12,
  }), true);
  assert.equal(scenePaintCoversDrawingHandoff(ticket, {
    ...ticket,
    documentRevision: 8,
    viewportRevision: 13,
  }), true);
  assert.equal(scenePaintCoversDrawingHandoff(ticket, {
    ...ticket,
    documentRevision: 6,
    viewportRevision: 12,
  }), false);
  assert.equal(scenePaintCoversDrawingHandoff(ticket, {
    ...ticket,
    scopeKey: "ETHUSDT",
    documentRevision: 8,
    viewportRevision: 12,
  }), false);
  assert.equal(scenePaintCoversDrawingHandoff(ticket, {
    ...ticket,
    documentRevision: 8,
    surfaceGeneration: 4,
    viewportRevision: 12,
  }), false);
});

test("hybrid hit ownership follows canonical z-order instead of legacy-first attachment order", () => {
  const legacy = malformedFixture<DrawingPrimitive>({ id: "legacy" });
  const scene = malformedFixture<DrawingPrimitive>({ id: "scene" });
  const legacyHit = malformedFixture<DrawingPrimitiveHit>({ prim: legacy, type: "freehand" });
  const sceneHit: DrawingDisplayHitResult = {
    entityId: "scene",
    kind: "shape",
    pointIndex: -1,
    zone: "body",
  };

  assert.strictEqual(
    resolveTopmostDrawingInteractionHit([legacy, scene], legacyHit, sceneHit)?.prim,
    scene,
  );
  assert.strictEqual(
    resolveTopmostDrawingInteractionHit([scene, legacy], legacyHit, sceneHit)?.prim,
    legacy,
  );
});

test("scene hit ownership accepts freehand and highlighter compatibility proxies", () => {
  for (const kind of ["freehand", "highlighter"] as const) {
    const legacy = malformedFixture<DrawingPrimitive>({ id: `legacy-${kind}` });
    const scene = malformedFixture<DrawingPrimitive>({ id: `scene-${kind}` });
    const legacyHit = malformedFixture<DrawingPrimitiveHit>({
      prim: legacy,
      type: "text",
    });
    const sceneHit: DrawingDisplayHitResult = {
      entityId: `scene-${kind}`,
      kind,
      pointIndex: -1,
    };

    const sceneTop = resolveTopmostDrawingInteractionHit(
      [legacy, scene],
      legacyHit,
      sceneHit,
    );
    assert.strictEqual(sceneTop?.prim, scene);
    assert.equal(sceneTop?.type, kind);

    assert.strictEqual(
      resolveTopmostDrawingInteractionHit([scene, legacy], legacyHit, sceneHit)?.prim,
      legacy,
    );
  }
});

test("512-entity overlay hover misses do not materialize or scan the drawing document", () => {
  const drawings = new Map<string, SavedDrawing>(Array.from({ length: 512 }, (_, index) => {
    const id = `line-${index}`;
    const drawing: SavedDrawing = {
      type: "line" as const,
      id,
      dataPoints: [],
    };
    return [id, drawing] as const;
  }));
  let lookupCount = 0;
  const getSavedDrawing = (id: string): SavedDrawing | null => {
    lookupCount += 1;
    return drawings.get(id) ?? null;
  };

  assert.equal(hitTestOverlayDrawingEntity(
    240,
    180,
    () => null,
    getSavedDrawing,
  ), null);
  assert.equal(lookupCount, 0);

  const target = mustBeDefined(drawings.get("line-511"));
  const hit = hitTestOverlayDrawingEntity(
    240,
    180,
    () => ({ entityId: "line-511", kind: "line", zone: "body" }),
    getSavedDrawing,
  );
  assert.strictEqual(hit?.saved, target);
  assert.equal(hit?.id, "line-511");
  assert.equal(lookupCount, 1);
});

test("selected passive cursor pointerdown reuses its first raw hit for every selection outcome", () => {
  type CursorHit = Readonly<{ id: string; type: "line" | "freehand" }>;
  const selectedId = "selected-line";
  const selectedHit: CursorHit = { id: selectedId, type: "line" };
  const unsupportedSelectedHit: CursorHit = { id: selectedId, type: "freehand" };
  const otherHit: CursorHit = { id: "other-line", type: "line" };
  const unsupportedHit: CursorHit = { id: "legacy-freehand", type: "freehand" };

  const scenarios: ReadonlyArray<Readonly<{
    name: string;
    rawHit: CursorHit | null;
    supported: boolean;
    expected: CursorHit | null;
    expectedDeselectCount: number;
  }>> = [
    {
      name: "same entity",
      rawHit: selectedHit,
      supported: true,
      expected: selectedHit,
      expectedDeselectCount: 0,
    },
    {
      name: "same entity with unsupported anchor",
      rawHit: unsupportedSelectedHit,
      supported: false,
      expected: null,
      expectedDeselectCount: 0,
    },
    {
      name: "blank",
      rawHit: null,
      supported: true,
      expected: null,
      expectedDeselectCount: 1,
    },
    {
      name: "another entity",
      rawHit: otherHit,
      supported: true,
      expected: otherHit,
      expectedDeselectCount: 1,
    },
    {
      name: "unsupported anchor",
      rawHit: unsupportedHit,
      supported: false,
      expected: null,
      expectedDeselectCount: 1,
    },
  ];

  for (const scenario of scenarios) {
    let sceneHitCount = 0;
    let hitIdReadCount = 0;
    let supportCheckCount = 0;
    let deselectCount = 0;
    const hitTestScene = (): CursorHit | null => {
      sceneHitCount += 1;
      return scenario.rawHit;
    };
    const resolved = resolvePassiveCursorSelectedNonTextHit({
      selectedId,
      hitTest: hitTestScene,
      hitId(hit) {
        hitIdReadCount += 1;
        return hit.id;
      },
      supportsHitType() {
        supportCheckCount += 1;
        return scenario.supported;
      },
      deselect() {
        deselectCount += 1;
      },
    });

    assert.strictEqual(resolved, scenario.expected, scenario.name);
    assert.equal(sceneHitCount, 1, `${scenario.name}: scene hit executes once`);
    assert.equal(
      hitIdReadCount,
      scenario.rawHit ? 1 : 0,
      `${scenario.name}: only a real raw hit needs identity resolution`,
    );
    assert.equal(
      supportCheckCount,
      scenario.rawHit ? 1 : 0,
      `${scenario.name}: only a real raw hit reaches anchor filtering`,
    );
    assert.equal(
      deselectCount,
      scenario.expectedDeselectCount,
      `${scenario.name}: selection transition`,
    );
  }
});

test("selected freehand and highlighter handle probes skip scene geometry reads", () => {
  for (const type of ["freehand", "highlighter"] as const) {
    const selectedId = `selected-${type}`;
    const saved: SavedDrawing = {
      id: selectedId,
      type,
      dataPoints: [{ time: 10, price: 20 }, { time: 20, price: 30 }],
    };
    let savedReadCount = 0;
    let sceneBoxReadCount = 0;
    let sceneHandlesReadCount = 0;
    let projectionCount = 0;

    assert.equal(hitTestSelectedOverlayDrawingHandle({
      selectedId,
      x: 10,
      y: 20,
      getSavedDrawing(id) {
        savedReadCount += 1;
        assert.equal(id, selectedId);
        return saved;
      },
      dataToScreen(dataPoint) {
        projectionCount += 1;
        return { x: Number(dataPoint.time), y: dataPoint.price };
      },
      getSceneScreenBox(id) {
        sceneBoxReadCount += 1;
        assert.equal(id, selectedId);
        return { x: 0, y: 0, width: 100, height: 100 };
      },
      getSceneScreenHandles(id) {
        sceneHandlesReadCount += 1;
        assert.equal(id, selectedId);
        return [{ x: 10, y: 20 }];
      },
    }), null, type);
    assert.equal(savedReadCount, 1, `${type}: canonical entity read`);
    assert.equal(sceneBoxReadCount, 0, `${type}: scene box must stay unread`);
    assert.equal(sceneHandlesReadCount, 0, `${type}: scene handles must stay unread`);
    assert.equal(projectionCount, 0, `${type}: handle projection must stay idle`);
  }
});

test("selected overlay handle probes preserve ordinary endpoint hit semantics", () => {
  const selectedId = "selected-line";
  const saved: SavedDrawing = {
    id: selectedId,
    type: "line",
    dataPoints: [{ time: 10, price: 20 }, { time: 40, price: 50 }],
  };
  let sceneBoxReadCount = 0;
  let sceneHandlesReadCount = 0;
  let projectionCount = 0;

  const hit = hitTestSelectedOverlayDrawingHandle({
    selectedId,
    x: 10,
    y: 20,
    getSavedDrawing: () => saved,
    dataToScreen(dataPoint) {
      projectionCount += 1;
      return typeof dataPoint.time === "number"
        ? { x: dataPoint.time, y: dataPoint.price }
        : null;
    },
    getSceneScreenBox() {
      sceneBoxReadCount += 1;
      return null;
    },
    getSceneScreenHandles() {
      sceneHandlesReadCount += 1;
      return null;
    },
  });

  assert.equal(hit?.id, selectedId);
  assert.strictEqual(hit?.saved, saved);
  assert.equal(hit?.type, "line");
  assert.equal(hit?.pointIndex, 0);
  assert.equal(sceneBoxReadCount, 1);
  assert.equal(sceneHandlesReadCount, 1);
  assert.equal(projectionCount, 2);
});

test("pending pen moves retain every coalesced batch before one RAF", () => {
  const firstEvent = { altKey: false };
  const latestEvent = { altKey: true };
  const pending = malformedFixture<ActiveDrawingMovePayload>({
    tool: "pen",
    pos: point(2),
    positions: [point(1), point(2)],
    e: firstEvent,
  });
  const payload = malformedFixture<ActiveDrawingMovePayload>({
    tool: "pen",
    pos: point(4),
    positions: [point(3), point(4)],
    e: latestEvent,
  });

  const merged = mergePendingActiveDrawingMove(pending, payload);
  assert.strictEqual(merged, pending);
  assert.deepEqual(mustBeDefined(merged).positions, [point(1), point(2), point(3), point(4)]);
  assert.deepEqual(mustBeDefined(merged).pos, point(4));
  assert.strictEqual(mustBeDefined(merged).e, latestEvent);
});

test("pending highlighter batches are bounded while preserving chronological prefix", () => {
  const pending: ActiveDrawingMovePayload = {
    tool: "highlighter",
    pos: point(2),
    positions: [point(1), point(2)],
  };
  const merged = mergePendingActiveDrawingMove(pending, {
    tool: "highlighter",
    pos: point(5),
    positions: [point(3), point(4), point(5)],
  }, 4);

  assert.deepEqual(mustBeDefined(merged).positions, [point(1), point(2), point(3), point(4)]);
  assert.deepEqual(mustBeDefined(merged).pos, point(5));
});

test("non-freehand active moves and tool changes remain latest-wins", () => {
  const linePayload: ActiveDrawingMovePayload = { tool: "line-segment", pos: point(2), positions: [point(2)] };
  assert.strictEqual(mergePendingActiveDrawingMove(
    { tool: "line-segment", pos: point(1), positions: [point(1)] },
    linePayload,
  ), linePayload);

  const highlighterPayload: ActiveDrawingMovePayload = { tool: "highlighter", pos: point(3), positions: [point(3)] };
  assert.strictEqual(mergePendingActiveDrawingMove(
    { tool: "pen", pos: point(2), positions: [point(2)] },
    highlighterPayload,
  ), highlighterPayload);
});

test("near-capacity capture drops an invalid tail before atomic coordinate capture", () => {
  const validPrefix = [point(1), point(2)];
  const invalidTail = { x: 999, y: Number.NaN };
  assert.deepEqual(
    limitFreehandCapturePositions([...validPrefix, invalidTail], 2),
    validPrefix,
  );
  assert.deepEqual(limitFreehandCapturePositions(validPrefix, 0), []);
  assert.deepEqual(limitFreehandCapturePositions(validPrefix, -1), []);
});

test("coordinate cleanup ignores rerenders until the real surface boundary changes", () => {
  const boundary = {
    drawingChartType: "candlestick",
    drawingInterval: "1h",
    drawingCoordinateKey: "binance:BTCUSDT:1h:time",
    seriesReady: 2,
  } as const;

  assert.equal(isDrawingCoordinateCleanupBoundaryCurrent(
    boundary,
    boundary.drawingChartType,
    boundary.drawingInterval,
    boundary.drawingCoordinateKey,
    boundary.seriesReady,
  ), true);
  assert.equal(isDrawingCoordinateCleanupBoundaryCurrent(
    boundary,
    boundary.drawingChartType,
    "4h",
    "binance:BTCUSDT:4h:time",
    boundary.seriesReady,
  ), false);
  assert.equal(isDrawingCoordinateCleanupBoundaryCurrent(
    boundary,
    boundary.drawingChartType,
    boundary.drawingInterval,
    boundary.drawingCoordinateKey,
    boundary.seriesReady + 1,
  ), false);
  assert.equal(isDrawingCoordinateCleanupBoundaryCurrent(
    null,
    boundary.drawingChartType,
    boundary.drawingInterval,
    boundary.drawingCoordinateKey,
    boundary.seriesReady,
  ), false);
});

test("chart-type surface disposal owns layout timing and retires the deferred gesture", () => {
  const previousBoundary = {
    drawingChartType: "candlestick",
    drawingInterval: "1h",
    drawingCoordinateKey: "binance:BTCUSDT:1h:time:0",
    seriesReady: 2,
  } as const;
  const deferToChartType = shouldDeferDrawingCoordinateCleanupToChartTypeBoundary(
    previousBoundary,
    "renko",
    "1h",
  );
  assert.equal(deferToChartType, true);
  // Projection/symbol-only coordinate changes keep the same chart type and
  // must still be cleaned by the coordinate owner.
  assert.equal(shouldDeferDrawingCoordinateCleanupToChartTypeBoundary(
    previousBoundary,
    "candlestick",
    "1h",
  ), false);
  // A simultaneous interval transition remains owned by interval cleanup.
  assert.equal(shouldDeferDrawingCoordinateCleanupToChartTypeBoundary(
    previousBoundary,
    "renko",
    "4h",
  ), false);

  resetDrawingInteractionLifecycle();
  beginDrawingInteractionLifecycleFreehandGesture();
  // Mirrors the layout effect: deferral leaves pointer-down intact until the
  // passive chart surface owner reaches prepareSurfaceDispose().
  if (!deferToChartType) abandonDrawingInteractionLifecycleActiveGesture();
  assert.equal(readDrawingInteractionLifecycle().active?.events.length, 1);

  const boundaryMarked = markDrawingInteractionLifecycleBoundaryChange({
    kind: "chart-type",
    beforeValue: "candlestick",
    afterValue: "renko",
  }) !== null;
  let physicalActive = true;
  assert.equal(runDrawingSurfaceDisposeBoundaryLifecycle({
    boundaryMarked,
    hasActiveFreehand: () => physicalActive,
    prepare: () => {
      physicalActive = false;
      // Ordinary physical cleanup must preserve the marked boundary receipt.
      assert.equal(abandonDrawingInteractionLifecycleActiveGesture(), false);
      return true;
    },
  }), true);
  const completed = readDrawingInteractionLifecycle();
  assert.equal(completed.active, null);
  assert.equal(completed.lastCompleted?.kind, "chart-type");
  assert.equal(completed.lastCompleted?.events[1].afterValue, "renko");
  assert.equal(completed.lastCompleted?.events[2].reason, "surface-dispose");
  resetDrawingInteractionLifecycle();
});

test("surface disposal lifecycle completes only a successful physical cancellation", () => {
  resetDrawingInteractionLifecycle();
  beginDrawingInteractionLifecycleFreehandGesture();
  assert.ok(markDrawingInteractionLifecycleBoundaryChange({
    kind: "chart-type",
    beforeValue: "candlestick",
    afterValue: "line",
  }));

  assert.equal(runDrawingSurfaceDisposeBoundaryLifecycle({
    boundaryMarked: true,
    hasActiveFreehand: () => false,
    prepare: () => true,
  }), true);
  const snapshot = readDrawingInteractionLifecycle();
  assert.equal(snapshot.active, null);
  assert.equal(snapshot.lastCompleted?.events[2].reason, "surface-dispose");
  resetDrawingInteractionLifecycle();
});

test("failed surface disposal rolls back its boundary and retains a retryable gesture", () => {
  resetDrawingInteractionLifecycle();
  beginDrawingInteractionLifecycleFreehandGesture();
  assert.ok(markDrawingInteractionLifecycleBoundaryChange({
    kind: "chart-type",
    beforeValue: "candlestick",
    afterValue: "line",
  }));

  assert.equal(runDrawingSurfaceDisposeBoundaryLifecycle({
    boundaryMarked: true,
    hasActiveFreehand: () => true,
    prepare: () => false,
  }), false);
  const snapshot = readDrawingInteractionLifecycle();
  assert.equal(snapshot.active?.events.length, 1);
  assert.equal(snapshot.lastCompleted, null);
  resetDrawingInteractionLifecycle();
});

test("throwing partial surface disposal abandons an already-cancelled gesture", () => {
  resetDrawingInteractionLifecycle();
  beginDrawingInteractionLifecycleFreehandGesture();
  assert.ok(markDrawingInteractionLifecycleBoundaryChange({
    kind: "chart-type",
    beforeValue: "candlestick",
    afterValue: "line",
  }));

  assert.throws(() => runDrawingSurfaceDisposeBoundaryLifecycle({
    boundaryMarked: true,
    hasActiveFreehand: () => false,
    prepare: () => { throw new Error("partial detach"); },
  }), /partial detach/);
  assert.deepEqual(readDrawingInteractionLifecycle(), {
    active: null,
    lastCompleted: null,
  });
  resetDrawingInteractionLifecycle();
});

test("failed surface detach preserves the primitive registry for document retry", () => {
  const primitive = structuralMock<DrawingPrimitive>({ id: "drawing-1" });
  const primitives = [primitive];
  let attempts = 0;

  assert.equal(detachAndRemoveDrawingPrimitive(primitives, primitive, () => {
    attempts += 1;
    return false;
  }), false);
  assert.deepEqual(primitives, [primitive]);
  assert.equal(attempts, 1);

  assert.equal(detachAndRemoveDrawingPrimitive(primitives, primitive, () => {
    attempts += 1;
    return true;
  }), true);
  assert.deepEqual(primitives, []);
  assert.equal(attempts, 2);
});

test("freehand cancellation treats no active stroke as success and fails only on detach", () => {
  let detachCalls = 0;
  assert.equal(cancelFreehandPrimitiveOnSurface(null, () => {
    detachCalls += 1;
    return false;
  }), true);
  assert.equal(detachCalls, 0);

  let previewCancels = 0;
  const primitive = structuralMock<FreehandDrawingPrimitive>({
    cancelPreview: () => { previewCancels += 1; },
  });
  assert.equal(cancelFreehandPrimitiveOnSurface(primitive, () => {
    detachCalls += 1;
    return false;
  }), false);
  assert.equal(previewCancels, 1);
  assert.equal(detachCalls, 1);
});

test("surface disposal keeps transient state until the document barrier succeeds", () => {
  const calls: string[] = [];

  assert.equal(runDrawingSurfaceDisposeBarrier(
    () => {
      calls.push("prepare-failed");
      return false;
    },
    () => calls.push("finalize-failed"),
  ), false);
  assert.deepEqual(calls, ["prepare-failed"]);

  assert.equal(runDrawingSurfaceDisposeBarrier(
    () => {
      calls.push("prepare-succeeded");
      return true;
    },
    () => calls.push("finalize-succeeded"),
  ), true);
  assert.deepEqual(calls, [
    "prepare-failed",
    "prepare-succeeded",
    "finalize-succeeded",
  ]);
});

test("pointer commands stop when incompatible preview or freehand cleanup fails", () => {
  const calls: string[] = [];
  assert.equal(runDrawingPointerTransientBarrier({
    activeTool: "position-long",
    pendingTwoPointTool: "line-segment",
    hasPendingTwoPoint: true,
    hasActiveFreehand: false,
    removePreview() { calls.push("preview-failed"); return false; },
    cancelActiveFreehandStroke() { calls.push("freehand-unexpected"); return true; },
  }), false);
  assert.deepEqual(calls, ["preview-failed"]);

  assert.equal(runDrawingPointerTransientBarrier({
    activeTool: "position-long",
    pendingTwoPointTool: null,
    hasPendingTwoPoint: false,
    hasActiveFreehand: true,
    removePreview() { calls.push("preview-unexpected"); return true; },
    cancelActiveFreehandStroke() { calls.push("freehand-failed"); return false; },
  }), false);
  assert.deepEqual(calls, ["preview-failed", "freehand-failed"]);
});

test("matching two-point continuation retains its preview after transient cleanup", () => {
  const calls: string[] = [];
  assert.equal(runDrawingPointerTransientBarrier({
    activeTool: "fibonacci",
    pendingTwoPointTool: "fibonacci",
    hasPendingTwoPoint: true,
    hasActiveFreehand: true,
    removePreview() { calls.push("preview-unexpected"); return true; },
    cancelActiveFreehandStroke() { calls.push("freehand"); return true; },
  }), true);
  assert.deepEqual(calls, ["freehand"]);
});

test("failed same-series scope readiness requests a retry and blocks the mutation", () => {
  let retries = 0;
  const base = {
    activeScope: "BTCUSDT",
    hasSeries: true,
    previousScope: "BTCUSDT",
    requestedScope: "BTCUSDT",
    surfaceScope: "BTCUSDT",
  } as const;

  assert.equal(prepareDrawingMutationScope({
    ...base,
    ready: false,
  }, () => { retries += 1; }), false);
  assert.equal(retries, 1);

  assert.equal(prepareDrawingMutationScope({
    ...base,
    ready: true,
  }, () => { retries += 1; }), true);
  assert.equal(retries, 1);
});

test("scene-canary mutation readiness waits for an accepted current-surface publication", () => {
  const accepted = {
    attachedSurfaceGeneration: 7,
    publishedSurfaceGeneration: 7,
    requestedScope: "BTCUSDT",
    runtimeActive: true,
    runtimePublicationReady: true,
    runtimeScope: "BTCUSDT",
    sceneCanaryEnabled: true,
  } as const;

  assert.equal(isDrawingVisibleScenePublicationReady(accepted), true);
  assert.equal(isDrawingVisibleScenePublicationReady({
    ...accepted,
    publishedSurfaceGeneration: null,
  }), false);
  assert.equal(isDrawingVisibleScenePublicationReady({
    ...accepted,
    runtimePublicationReady: false,
  }), false);
  assert.equal(isDrawingVisibleScenePublicationReady({
    ...accepted,
    publishedSurfaceGeneration: 6,
  }), false);
  assert.equal(isDrawingVisibleScenePublicationReady({
    ...accepted,
    runtimeScope: "ETHUSDT",
  }), false);
  assert.equal(isDrawingVisibleScenePublicationReady({
    ...accepted,
    sceneCanaryEnabled: false,
    publishedSurfaceGeneration: null,
    runtimeActive: false,
    runtimePublicationReady: false,
    runtimeScope: null,
  }), true);

  let retries = 0;
  assert.equal(prepareDrawingMutationScope({
    activeScope: "BTCUSDT",
    hasSeries: true,
    previousScope: "BTCUSDT",
    ready: isDrawingVisibleScenePublicationReady({
      ...accepted,
      publishedSurfaceGeneration: null,
    }),
    requestedScope: "BTCUSDT",
    surfaceScope: "BTCUSDT",
  }, () => { retries += 1; }), false);
  assert.equal(retries, 1);
});

test("only a post-boundary current-surface plan qualifies for in-place recovery", () => {
  const faulted = {
    attachedSurfaceGeneration: 7,
    publishedSurfaceGeneration: 7,
    requestedScope: "BTCUSDT",
    runtimeActive: false,
    runtimePublicationReady: false,
    runtimeScope: "BTCUSDT",
    sceneCanaryEnabled: true,
    mutationStarted: true,
  } as const;

  assert.equal(canRecoverDrawingVisibleSceneInPlace(faulted), true);
  assert.equal(canRecoverDrawingVisibleSceneInPlace({
    ...faulted,
    mutationStarted: false,
  }), false);
  assert.equal(canRecoverDrawingVisibleSceneInPlace({
    ...faulted,
    publishedSurfaceGeneration: 6,
  }), false);
  assert.equal(canRecoverDrawingVisibleSceneInPlace({
    ...faulted,
    runtimePublicationReady: true,
  }), false);
});

test("requested symbol cannot mutate the previous active document", () => {
  let retries = 0;
  assert.equal(prepareDrawingMutationScope({
    activeScope: "BTCUSDT",
    hasSeries: true,
    previousScope: "BTCUSDT",
    ready: true,
    requestedScope: "ETHUSDT",
    surfaceScope: "BTCUSDT",
  }, () => { retries += 1; }), false);
  assert.equal(retries, 1);
});

test("stale scope may be hidden but cannot be made visible", () => {
  assert.equal(canApplyDrawingVisibilityToCurrentPrimitives(false, true), true);
  assert.equal(canApplyDrawingVisibilityToCurrentPrimitives(false, false), false);
  assert.equal(canApplyDrawingVisibilityToCurrentPrimitives(true, false), true);
});

test("export lease exposes the final hidden capture scene without replacing lease authority", async () => {
  const visibleScene = malformedFixture<DrawingExportLease["receipt"]["scene"]>({
    plan: Object.freeze({}),
    stamp: Object.freeze({ surfaceGeneration: 3 }),
    sceneEpoch: 1,
    lodToleranceClass: "settledExact",
    attachmentRevision: 1,
    paintSequence: 1,
  });
  const hiddenScene = malformedFixture<DrawingExportLease["receipt"]["scene"]>({
    kind: "hidden-frame",
    scopeKey: "scope",
    documentRevision: 5,
    document: Object.freeze({}),
    sceneEpoch: 2,
    attachmentRevision: 2,
    paintSequence: 2,
  });
  let revalidateCount = 0;
  let restoreCount = 0;
  const lease = Object.freeze({
    leaseId: 7,
    receipt: Object.freeze({
      leaseId: 7,
      scopeKey: "scope",
      documentRevision: 5,
      persistence: Object.freeze({ persistedRevision: 5, writePerformed: false }),
      scene: visibleScene,
      paint: 11,
    }),
    revalidate: async () => { revalidateCount += 1; return true; },
    restore: async () => { restoreCount += 1; },
  }) as unknown as DrawingExportLease;

  assert.strictEqual(withDrawingExportCaptureScene(lease, visibleScene), lease);
  const captureLease = withDrawingExportCaptureScene(lease, hiddenScene);
  assert.notStrictEqual(captureLease, lease);
  assert.ok(Object.isFrozen(captureLease));
  assert.ok(Object.isFrozen(captureLease.receipt));
  assert.strictEqual(captureLease.receipt.scene, hiddenScene);
  assert.strictEqual(lease.receipt.scene, visibleScene);
  assert.equal(await captureLease.revalidate(), true);
  await captureLease.restore();
  assert.equal(revalidateCount, 1);
  assert.equal(restoreCount, 1);
});

test("pre-presentation export failure preserves a newer visible intent and active runtime", () => {
  let currentlyHidden = true;
  let runtimeActive = true;
  let suspendCount = 0;

  // The export started globally hidden and temporarily activated an exact
  // empty scene. Before its exact wait failed, the user requested show.
  currentlyHidden = false;
  const cleanupOwned = restorePrePresentationHiddenDrawingSceneRuntime(
    true,
    currentlyHidden,
    false,
    () => {
      currentlyHidden = true;
      runtimeActive = false;
      suspendCount += 1;
    },
  );

  assert.equal(cleanupOwned, false);
  assert.equal(currentlyHidden, false);
  assert.equal(runtimeActive, true);
  assert.equal(suspendCount, 0);
});

test("export presentation acquisition owns and rolls back synchronous clear failures", () => {
  const gate = createDrawingExportVisibilityIntentGate();
  const setupError = new Error("clear presentation failed");
  const order: string[] = [];
  let selected = true;
  let hidden = true;

  assert.throws(() => acquireDrawingExportInteractionPresentation({
    beginVisibilityLease() {
      order.push("begin");
      gate.begin();
    },
    clearPresentation() {
      assert.equal(gate.isLocked(), true);
      order.push("clear");
      selected = false;
      assert.equal(gate.request(false), false);
      throw setupError;
    },
    rollbackFailedAcquisition() {
      order.push("rollback");
      gate.restore({
        restoreCapturePresentation() {},
        restoreInteraction() {
          selected = true;
        },
        applyPendingIntent(nextHidden) {
          hidden = nextHidden;
        },
      });
    },
    restoreInteraction() {
      order.push("unexpected-lease-restore");
    },
  }), (error: unknown) => error === setupError);

  assert.deepEqual(order, ["begin", "clear", "rollback"]);
  assert.equal(selected, true);
  assert.equal(hidden, false);
  assert.equal(gate.isLocked(), false);
});

test("export visibility lease restores capture state before applying latest queued intent", () => {
  const gate = createDrawingExportVisibilityIntentGate();
  const order: string[] = [];

  assert.equal(gate.request(true), true);
  gate.begin();
  assert.equal(gate.request(false), false);
  assert.equal(gate.request(true), false);
  assert.deepEqual(gate.snapshot(), { locked: true, pendingIntent: true });

  assert.equal(gate.restore({
    restoreCapturePresentation() {
      assert.equal(gate.isLocked(), true);
      order.push("restore-capture");
    },
    restoreInteraction() {
      assert.equal(gate.isLocked(), true);
      order.push("restore-interaction");
    },
    applyPendingIntent(nextHidden) {
      assert.equal(gate.isLocked(), false);
      order.push(`apply-pending:${String(nextHidden)}`);
    },
  }), true);

  assert.deepEqual(order, [
    "restore-capture",
    "restore-interaction",
    "apply-pending:true",
  ]);
  assert.deepEqual(gate.snapshot(), { locked: false, pendingIntent: null });
});

test("export visibility lease releases once and preserves cleanup failures", () => {
  const gate = createDrawingExportVisibilityIntentGate();
  const captureFailure = new Error("capture restore failed");
  const order: string[] = [];
  gate.begin();
  assert.equal(gate.request(true), false);

  assert.throws(() => gate.restore({
    restoreCapturePresentation() {
      order.push("restore-capture");
      throw captureFailure;
    },
    restoreInteraction() {
      order.push("restore-interaction");
    },
    applyPendingIntent(nextHidden) {
      order.push(`apply-pending:${String(nextHidden)}`);
    },
  }), (error: unknown) => error === captureFailure);

  assert.deepEqual(order, [
    "restore-capture",
    "restore-interaction",
    "apply-pending:true",
  ]);
  assert.deepEqual(gate.snapshot(), { locked: false, pendingIntent: null });
  assert.equal(gate.restore({
    restoreCapturePresentation() { order.push("unexpected-capture"); },
    restoreInteraction() { order.push("unexpected-interaction"); },
    applyPendingIntent() { order.push("unexpected-pending"); },
  }), false);
  assert.equal(order.some((item) => item.startsWith("unexpected")), false);
});

test("dynamic selection handles expose only real per-kind drag affordances", () => {
  const project: DrawingDataToScreen = (dataPoint) => (
    typeof dataPoint.time === "number"
      ? { x: dataPoint.time, y: dataPoint.price }
      : null
  );
  const text: SavedDrawing = { type: "text", dataPoint: { time: 10, price: 20 } };
  const textHandles = dynamicSelectionHandlesForSavedDrawing(
    text,
    project,
    { x: 10, y: 20, width: 80, height: 40 },
  );
  assert.deepEqual(textHandles.map((handle) => handle.hit.handle), [
    "tl", "t", "tr", "r", "br", "b", "bl", "l",
  ]);

  const position: SavedDrawing = {
    type: "position",
    entryPrice: 100,
    tpPrice: 120,
    slPrice: 90,
    timeRange: { start: 10, end: 30 },
  };
  const positionHandles = dynamicSelectionHandlesForSavedDrawing(position, project);
  assert.deepEqual(positionHandles.map((handle) => handle.hit.zone), [
    "entry", "tp", "sl", "left", "right",
  ]);
  assert.deepEqual(positionHandles.slice(-2).map((handle) => handle.point.x), [10, 30]);

  const foldedSceneHandles = [
    { x: 50, y: 50 },
    { x: 50, y: 10 },
    { x: 50, y: 70 },
    { x: 38, y: 40 },
    { x: 62, y: 40 },
  ];
  const foldedPositionHandles = dynamicSelectionHandlesForSavedDrawing(
    position,
    () => ({ x: 50, y: 40 }),
    null,
    foldedSceneHandles,
  );
  assert.deepEqual(
    foldedPositionHandles.map((handle) => [handle.hit.zone, handle.point.x, handle.point.y]),
    [
      ["entry", 50, 50],
      ["tp", 50, 10],
      ["sl", 50, 70],
      ["left", 38, 40],
      ["right", 62, 40],
    ],
  );

  const freehand: SavedDrawing = {
    type: "freehand",
    dataPoints: [{ time: 10, price: 10 }, { time: 20, price: 20 }],
  };
  assert.deepEqual(dynamicSelectionHandlesForSavedDrawing(freehand, project), []);
});

test("passive feedback does not paint a blue selection box after drawing completion", () => {
  let screenBoxReads = 0;
  const selectedOnly = dynamicPassiveFeedbackDecorations({
    selectedId: "completed-line",
    hover: null,
    getScreenBox() {
      screenBoxReads += 1;
      return { x: 10, y: 20, width: 40, height: 30 };
    },
  });

  assert.deepEqual(selectedOnly, []);
  assert.equal(screenBoxReads, 0, "selection bounds are not read for passive painting");

  const hover = dynamicPassiveFeedbackDecorations({
    selectedId: "completed-line",
    hover: { id: "other-line", point: { x: 30, y: 40 }, eraser: false },
    getScreenBox() {
      screenBoxReads += 1;
      return { x: 20, y: 30, width: 50, height: 10 };
    },
  });
  assert.deepEqual(hover, [{
    type: "box",
    box: { x: 20, y: 30, width: 50, height: 10 },
    color: "#ff6b6b",
  }], "red hover feedback remains available");
});

test("selected feedback keeps drag handles without a bounding box", () => {
  const decoration = dynamicSelectedHandleDecoration([
    { x: 10, y: 20 },
    { x: 50, y: 60 },
    { x: Number.NaN, y: 80 },
  ]);

  assert.deepEqual(decoration, {
    type: "handles",
    handles: [{ x: 10, y: 20 }, { x: 50, y: 60 }],
    color: "#3b82f6",
  });
  assert.notEqual(decoration?.type, "box");
});

test("fibonacci draft without explicit levels previews the default retracement grid", () => {
  const fibonacci: SavedDrawing = {
    id: "fibonacci-default-preview",
    type: "fibonacci",
    dataPoints: [
      { time: 10, price: 20 },
      { time: 50, price: 80 },
    ],
    color: "#123456",
    lineWidth: 2,
  };
  const decorations = dynamicDecorationsForSavedDrawingDraft(
    fibonacci,
    (point) => typeof point.time === "number"
      ? { x: point.time, y: point.price }
      : null,
  );

  assert.equal(decorations[0]?.type, "line", "trend line remains the first decoration");
  assert.equal(decorations.length, 8, "trend line plus seven enabled default levels");
  assert.deepEqual(decorations.slice(1).map((decoration) => (
    decoration.type === "line" ? decoration.color : null
  )), ["#787b86", "#f44336", "#81c784", "#4caf50", "#009688", "#64b5f6", "#787b86"]);
  assert.deepEqual(decorations.slice(1).map((decoration) => (
    decoration.type === "line" ? decoration.label?.text : null
  )), [
    "0 (20.00)",
    "0.236 (34.16)",
    "0.382 (42.92)",
    "0.5 (50.00)",
    "0.618 (57.08)",
    "0.786 (67.16)",
    "1 (80.00)",
  ]);
  assert.deepEqual(
    decorations[1]?.type === "line" ? decorations[1].label?.anchor : null,
    { x: 14, y: 18 },
  );
});

test("position creation paints its complete dynamic handoff frame before document commit", () => {
  const position: SavedDrawing = {
    id: "position-handoff",
    type: "position",
    direction: "long",
    entryPrice: 100,
    tpPrice: 120,
    slPrice: 90,
    timeRange: { start: 10, end: 30 },
  };
  const project: DrawingDataToScreen = (dataPoint) => (
    typeof dataPoint.time === "number"
      ? { x: dataPoint.time, y: dataPoint.price }
      : null
  );
  const order: string[] = [];
  const receipt = { committed: true, ticket: { documentRevision: 2 } } as const;
  const themePalette = { upColor: "#00aa11", downColor: "#dd0022" } as const;

  const result = commitSavedDrawingAfterDynamicFrame(
    position,
    project,
    (decorations) => {
      order.push("dynamic");
      assert.equal(decorations.length, 1);
      const decoration = decorations[0];
      assert.equal(decoration?.type, "position");
      if (decoration?.type !== "position") return;
      assert.equal(decoration.entryColor, "#2196f3");
      assert.equal(decoration.tpLevel?.color, themePalette.upColor);
      assert.equal(decoration.slLevel?.color, themePalette.downColor);
      assert.deepEqual(decoration.panelLines.map((line) => line.label), [
        "入场", "止盈", "止损", "现价", "盈亏比", "仓位",
      ]);
      assert.equal(decoration.badgeText, "LONG");
    },
    () => {
      assert.deepEqual(order, ["dynamic"]);
      order.push("commit");
      return receipt;
    },
    themePalette,
    110,
  );

  assert.strictEqual(result, receipt);
  assert.deepEqual(order, ["dynamic", "commit"]);
});

test("short-position dynamic levels follow the static scene price-direction palette", () => {
  const position: SavedDrawing = {
    id: "short-position-theme",
    type: "position",
    direction: "short",
    entryPrice: 100,
    tpPrice: 80,
    slPrice: 110,
    timeRange: { start: 10, end: 30 },
  };
  const project: DrawingDataToScreen = (dataPoint) => (
    typeof dataPoint.time === "number"
      ? { x: dataPoint.time, y: dataPoint.price }
      : null
  );
  const themePalette = { upColor: "#00aa11", downColor: "#dd0022" } as const;

  commitSavedDrawingAfterDynamicFrame(
    position,
    project,
    (decorations) => {
      const decoration = decorations[0];
      assert.equal(decoration?.type, "position");
      if (decoration?.type !== "position") return;
      assert.equal(decoration.tpLevel?.color, themePalette.downColor);
      assert.equal(decoration.slLevel?.color, themePalette.upColor);
      assert.equal(decoration.badgeColor, themePalette.downColor);
    },
    () => undefined,
    themePalette,
  );
});

test("two-point final click paints the exact endpoint before document commit", () => {
  const finalDrawing: SavedDrawing = {
    id: "line-final-click",
    type: "line",
    lineType: "line-ray",
    color: "#123456",
    lineWidth: 3,
    dataPoints: [
      { time: 10, price: 20 },
      { time: 47, price: 83 },
    ],
  };
  const project: DrawingDataToScreen = (dataPoint) => (
    typeof dataPoint.time === "number"
      ? { x: dataPoint.time, y: dataPoint.price }
      : null
  );
  const order: string[] = [];
  let paintedEndpoint: ScreenPoint = { x: 35, y: 70 };

  commitSavedDrawingAfterDynamicFrame(
    finalDrawing,
    project,
    (decorations) => {
      order.push("dynamic");
      const line = decorations[0];
      assert.equal(line?.type, "line");
      if (line?.type !== "line") return;
      paintedEndpoint = line.to;
      assert.equal(line.extension, "line-ray");
      assert.deepEqual(paintedEndpoint, { x: 47, y: 83 });
    },
    () => {
      assert.deepEqual(order, ["dynamic"]);
      assert.deepEqual(paintedEndpoint, { x: 47, y: 83 });
      order.push("commit");
    },
  );

  assert.deepEqual(order, ["dynamic", "commit"]);
});
