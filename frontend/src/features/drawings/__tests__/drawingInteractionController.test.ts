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
  createDrawingExportVisibilityIntentGate,
  detachAndRemoveDrawingPrimitive,
  dynamicSelectionHandlesForSavedDrawing,
  hitTestOverlayDrawingEntity,
  isDrawingCoordinateCleanupBoundaryCurrent,
  resolveTopmostDrawingInteractionHit,
  runDrawingPointerTransientBarrier,
  runDrawingSurfaceDisposeBarrier,
  scenePaintCoversDrawingHandoff,
} from "../drawingInteractionController.js";
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
    drawingCoordinateKey: "binance:BTCUSDT:1h:time",
    seriesReady: 2,
  } as const;

  assert.equal(isDrawingCoordinateCleanupBoundaryCurrent(
    boundary,
    boundary.drawingCoordinateKey,
    boundary.seriesReady,
  ), true);
  assert.equal(isDrawingCoordinateCleanupBoundaryCurrent(
    boundary,
    "binance:BTCUSDT:4h:time",
    boundary.seriesReady,
  ), false);
  assert.equal(isDrawingCoordinateCleanupBoundaryCurrent(
    boundary,
    boundary.drawingCoordinateKey,
    boundary.seriesReady + 1,
  ), false);
  assert.equal(isDrawingCoordinateCleanupBoundaryCurrent(
    null,
    boundary.drawingCoordinateKey,
    boundary.seriesReady,
  ), false);
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
      assert.equal(decorations.length, 3);
      assert.deepEqual(decorations.map((decoration) => decoration.type), [
        "line", "line", "line",
      ]);
      assert.deepEqual(decorations.map((decoration) => (
        decoration.type === "line" ? decoration.color : null
      )), ["#3b82f6", themePalette.upColor, themePalette.downColor]);
    },
    () => {
      assert.deepEqual(order, ["dynamic"]);
      order.push("commit");
      return receipt;
    },
    themePalette,
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
      assert.deepEqual(decorations.map((decoration) => (
        decoration.type === "line" ? decoration.color : null
      )), ["#3b82f6", themePalette.downColor, themePalette.upColor]);
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
