import assert from "node:assert/strict";
import test from "node:test";

import { importSavedDrawings } from "../core/drawingCodec.js";
import { createDrawingDocument, createDrawingEntity } from "../core/drawingDocument.js";
import type { DrawingEntityInput } from "../core/drawingDocument.js";
import { createDrawingDocumentStore } from "../core/drawingDocumentStore.js";
import type { DrawingPersistenceCoordinator } from "../persistence/drawingPersistenceCoordinator.js";
import { createPrimitiveFromSavedDrawing } from "../drawingPrimitiveFactory.js";
import type { DrawingKind, DrawingPrimitive, SavedDrawing } from "../drawingTypes.js";
import type { DrawingSceneRuntimeSnapshot } from "../engine/drawingSceneRuntime.js";
import type { DrawingScreenDisplayList } from "../rendering/drawingDisplayList.js";
import type { DrawingScenePrimitiveBridgeSnapshot } from "../../../chart-adapter/drawingScenePrimitiveBridge.js";
import { createLegacyPrimitiveRenderer } from "../legacy/legacyPrimitiveRenderer.js";
import {
  commitDetachedDrawingCommands,
  createDrawingCommittedPaintTicket,
  createDrawingPersistenceRenderer,
  drawingLegacyPrimitiveRuntimeEvidence,
  ensureHiddenDrawingSceneRuntimeForExactExport,
  flushDrawingPersistenceTarget,
  isDrawingExportExactSceneEmpty,
  isDrawingHiddenExportFrameCurrent,
  isDrawingHiddenExportSceneRetired,
  restorePrePresentationHiddenDrawingSceneRuntime,
  shouldKeepDrawingSceneSuspendedWhileHidden,
  shouldUseDrawingDocumentSceneRegistry,
  shouldProjectVisibleSceneEntity,
  transitionDrawingSceneToHidden,
  visibleSceneSelectedId,
} from "../useDrawingPersistenceLifecycle.js";
import type { DrawingExportHiddenFrameReceipt } from "../useDrawingPersistenceLifecycle.js";
import { malformedFixture } from "../../../test/testHelpers.js";

function lineFixture(id: string, color = "#fff"): {
  entity: DrawingEntityInput;
  primitive: DrawingPrimitive;
} {
  const saved: SavedDrawing = {
    type: "line",
    id,
    lineType: "line-segment",
    dataPoints: [
      { time: 100, price: 10 },
      { time: 200, price: 20 },
    ],
    color,
    lineWidth: 2,
  };
  const document = importSavedDrawings("fixture", [saved]);
  const primitive = createPrimitiveFromSavedDrawing(saved);
  const entity = document?.entities.get(id);
  if (!document || !primitive || !entity) throw new Error("Invalid lifecycle line fixture");
  return { entity, primitive };
}

function persistenceCoordinatorSpy(hasScopeState: boolean) {
  let flushCount = 0;
  let scheduleCount = 0;
  const coordinator: DrawingPersistenceCoordinator = {
    clear: () => false,
    flush: async (scopeKey) => {
      flushCount += 1;
      return Object.freeze({
        ok: true as const,
        scopeKey,
        targetRevision: 1,
        persistedRevision: 1,
      });
    },
    flushAll: async () => Object.freeze([]),
    schedule: () => {
      scheduleCount += 1;
      return true;
    },
    snapshot: (scopeKey) => hasScopeState
      ? Object.freeze({
        scopeKey,
        phase: "error" as const,
        queueDepth: 1,
        inFlightRevision: null,
        pendingRevision: 1,
        dirtyRevision: 1,
        lastPersistedRevision: null,
        lastError: "quota exceeded",
        lastErrorName: "QuotaExceededError",
        legacySnapshotRevision: null,
        legacySnapshotError: null,
      })
      : null,
  };
  return {
    coordinator,
    flushCount: () => flushCount,
    scheduleCount: () => scheduleCount,
  };
}

test("export flush reuses an existing failed persistence job without rescheduling it", async () => {
  const store = createDrawingDocumentStore("export-retry");
  const dispatched = store.dispatch(Object.freeze({
    type: "create" as const,
    entity: lineFixture("line-retry").entity,
  }));
  assert.equal(dispatched.ok, true);
  assert.equal(store.dirty, true);
  const spy = persistenceCoordinatorSpy(true);
  const result = await flushDrawingPersistenceTarget(spy.coordinator, store, {
    scopeKey: "export-retry",
    documentRevision: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(spy.scheduleCount(), 0);
  assert.equal(spy.flushCount(), 1);
});

test("export flush schedules a dirty scope only when the coordinator has no state", async () => {
  const store = createDrawingDocumentStore("export-first-flush");
  const dispatched = store.dispatch(Object.freeze({
    type: "create" as const,
    entity: lineFixture("line-first").entity,
  }));
  assert.equal(dispatched.ok, true);
  const spy = persistenceCoordinatorSpy(false);
  const result = await flushDrawingPersistenceTarget(spy.coordinator, store, {
    scopeKey: "export-first-flush",
    documentRevision: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(spy.scheduleCount(), 1);
  assert.equal(spy.flushCount(), 1);
});

test("ordinary hide suspends the scene while export hide keeps an exact-empty path", () => {
  const events: string[] = [];
  const runtime = {
    invalidate(reason?: string) {
      events.push(`invalidate:${reason ?? ""}`);
      return true;
    },
    suspend() {
      events.push("suspend");
    },
  };
  const clearPlan = (requestUpdate = true) => {
    events.push(`clear:${requestUpdate}`);
  };

  assert.equal(transitionDrawingSceneToHidden(runtime, clearPlan), true);
  assert.deepEqual(events, ["suspend", "clear:false"]);

  events.length = 0;
  assert.equal(transitionDrawingSceneToHidden(runtime, clearPlan, {
    exactExport: true,
  }), true);
  assert.deepEqual(events, ["clear:true", "invalidate:export-visibility-hidden"]);
});

test("hidden scene reconciliation stays suspended unless exact export owns activation", () => {
  assert.equal(shouldKeepDrawingSceneSuspendedWhileHidden(true, true), true);
  assert.equal(shouldKeepDrawingSceneSuspendedWhileHidden(
    true,
    true,
    { allowHiddenExact: true },
  ), false);
  assert.equal(shouldKeepDrawingSceneSuspendedWhileHidden(true, false), false);
  assert.equal(shouldKeepDrawingSceneSuspendedWhileHidden(false, true), false);
});

test("failed export hide stays blank and rejects the exact capture path", () => {
  const events: string[] = [];
  const runtime = {
    invalidate(reason?: string) {
      events.push(`invalidate:${reason ?? ""}`);
      return false;
    },
    suspend() {
      events.push("suspend");
    },
  };

  assert.equal(transitionDrawingSceneToHidden(
    runtime,
    (requestUpdate = true) => { events.push(`clear:${requestUpdate}`); },
    { exactExport: true },
  ), false);
  assert.deepEqual(events, [
    "clear:true",
    "invalidate:export-visibility-hidden",
    "suspend",
    "clear:false",
  ]);
});

test("globally hidden export reactivates only the exact empty scene runtime", () => {
  let activationCount = 0;
  const activate = () => {
    activationCount += 1;
    return true;
  };

  assert.equal(ensureHiddenDrawingSceneRuntimeForExactExport(true, false, activate), true);
  assert.equal(activationCount, 1);
  assert.equal(ensureHiddenDrawingSceneRuntimeForExactExport(true, true, activate), true);
  assert.equal(ensureHiddenDrawingSceneRuntimeForExactExport(false, false, activate), true);
  assert.equal(activationCount, 1);
});

test("hidden export frame retires the live plan without weakening document identity", () => {
  const document = createDrawingDocument({ scopeKey: "scope-a" });
  const emptyPlan = malformedFixture<DrawingScreenDisplayList>({ entities: [] });
  const exactReceipt = malformedFixture<Parameters<typeof isDrawingExportExactSceneEmpty>[0]>({
    plan: emptyPlan,
  });
  assert.equal(isDrawingExportExactSceneEmpty(exactReceipt), true);
  assert.equal(isDrawingExportExactSceneEmpty(malformedFixture({
    ...exactReceipt,
    plan: malformedFixture<DrawingScreenDisplayList>({ entities: [malformedFixture({})] }),
  })), false);

  const runtime = malformedFixture<DrawingSceneRuntimeSnapshot>({
    active: false,
    hitIndex: null,
    lastWorkerPublishedStamp: null,
    lastWorkerRequestedStamp: null,
    plan: null,
    publicationReady: false,
    scopeKey: null,
    worker: null,
  });
  const bridge = malformedFixture<DrawingScenePrimitiveBridgeSnapshot<DrawingScreenDisplayList>>({
    lastPaintedStamp: null,
    publishedPlan: null,
  });
  assert.equal(isDrawingHiddenExportSceneRetired(runtime, bridge), true);
  const disposedWorkerWithHistory = malformedFixture<
    NonNullable<DrawingSceneRuntimeSnapshot["worker"]>
  >({
    availability: "disposed",
    queueDepth: 0,
    inFlight: 0,
    pending: 0,
    latestSubmittedHeader: malformedFixture({ jobId: 7 }),
    inFlightHeader: null,
    pendingHeader: null,
  });
  assert.equal(isDrawingHiddenExportSceneRetired(
    malformedFixture({ ...runtime, worker: disposedWorkerWithHistory }),
    bridge,
  ), true);
  assert.equal(isDrawingHiddenExportSceneRetired(
    malformedFixture({
      ...runtime,
      worker: malformedFixture({ ...disposedWorkerWithHistory, inFlight: 1 }),
    }),
    bridge,
  ), false);

  const receipt: DrawingExportHiddenFrameReceipt = {
    kind: "hidden-frame",
    scopeKey: "scope-a",
    documentRevision: 0,
    document,
    sceneEpoch: 1,
    attachmentRevision: 1,
    paintSequence: 1,
  };
  const target = { scopeKey: "scope-a", documentRevision: 0 };
  assert.equal(isDrawingHiddenExportFrameCurrent(
    target,
    receipt,
    document,
    true,
    runtime,
    bridge,
  ), true);
  assert.equal(isDrawingHiddenExportFrameCurrent(
    target,
    receipt,
    document,
    false,
    runtime,
    bridge,
  ), false);
  assert.equal(isDrawingHiddenExportFrameCurrent(
    target,
    receipt,
    createDrawingDocument({ scopeKey: "scope-a" }),
    true,
    runtime,
    bridge,
  ), false);
  assert.equal(isDrawingHiddenExportFrameCurrent(
    target,
    receipt,
    document,
    true,
    malformedFixture({ ...runtime, active: true }),
    bridge,
  ), false);
  assert.equal(isDrawingHiddenExportFrameCurrent(
    target,
    receipt,
    document,
    true,
    runtime,
    malformedFixture({ ...bridge, publishedPlan: emptyPlan }),
  ), false);
});

test("pre-presentation hidden export cleanup restores ordinary suspension ownership", () => {
  let suspendCount = 0;
  const suspend = () => { suspendCount += 1; };

  assert.equal(restorePrePresentationHiddenDrawingSceneRuntime(
    true,
    true,
    false,
    suspend,
  ), true);
  assert.equal(suspendCount, 1);
  assert.equal(restorePrePresentationHiddenDrawingSceneRuntime(
    true,
    true,
    true,
    suspend,
  ), false);
  assert.equal(restorePrePresentationHiddenDrawingSceneRuntime(
    false,
    true,
    false,
    suspend,
  ), false);
  assert.equal(restorePrePresentationHiddenDrawingSceneRuntime(
    true,
    false,
    false,
    suspend,
  ), false);
  assert.equal(suspendCount, 1);
});

test("detached commits publish the document before the first surface mutation", () => {
  const scopeKey = "detached-document-first";
  const store = createDrawingDocumentStore(scopeKey);
  const events: string[] = [];
  store.subscribe((document) => {
    events.push(`document:${document.documentRevision}`);
  });
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) {
        events.push(`attach:${primitive.id}`);
        assert.equal(store.getSnapshot().entities.has(primitive.id), true);
        assert.equal(store.getSnapshot().documentRevision, 1);
        return true;
      },
      detachPrimitive(primitive) {
        events.push(`detach:${primitive.id}`);
        return true;
      },
    },
  });
  assert.equal(renderer.reconcile(store.getSnapshot()), true);
  events.length = 0;
  const { entity, primitive } = lineFixture("created");

  const result = commitDetachedDrawingCommands({
    commands: [{ type: "create", entity }],
    primitives: [primitive],
    renderer,
    scopeKey,
    store,
  });

  assert.ok(result);
  assert.equal(result.changed, true);
  assert.equal(result.rendererAdopted, true);
  assert.equal(result.surfaceSynchronized, true);
  assert.strictEqual(result.document, store.getSnapshot());
  assert.strictEqual(renderer.documentSnapshot(), store.getSnapshot());
  assert.deepEqual(events, ["document:1", "attach:created"]);
});

test("detached commit validation failures preserve the document and never touch the surface", () => {
  const scopeKey = "detached-validation-failure";
  const store = createDrawingDocumentStore(scopeKey);
  const initial = store.getSnapshot();
  const surfaceEvents: string[] = [];
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) {
        surfaceEvents.push(`attach:${primitive.id}`);
        return true;
      },
      detachPrimitive(primitive) {
        surfaceEvents.push(`detach:${primitive.id}`);
        return true;
      },
    },
  });
  assert.equal(renderer.reconcile(initial), true);
  const commandFixture = lineFixture("command-id");
  const mismatchedCandidate = lineFixture("candidate-id");

  const result = commitDetachedDrawingCommands({
    commands: [{ type: "create", entity: commandFixture.entity }],
    primitives: [mismatchedCandidate.primitive],
    renderer,
    scopeKey,
    store,
  });

  assert.equal(result, null);
  assert.strictEqual(store.getSnapshot(), initial);
  assert.strictEqual(renderer.documentSnapshot(), initial);
  assert.equal(store.dirty, false);
  assert.deepEqual(surfaceEvents, []);
});

test("surface failures cannot roll back an already committed detached document", () => {
  const scopeKey = "detached-surface-failure";
  const store = createDrawingDocumentStore(scopeKey);
  const events: string[] = [];
  store.subscribe((document) => {
    events.push(`document:${document.documentRevision}`);
  });
  const renderer = createLegacyPrimitiveRenderer({
    surface: {
      attachPrimitive(primitive) {
        events.push(`attach-rejected:${primitive.id}`);
        return false;
      },
      detachPrimitive(primitive) {
        events.push(`detach:${primitive.id}`);
        return true;
      },
    },
  });
  assert.equal(renderer.reconcile(store.getSnapshot()), true);
  events.length = 0;
  const { entity, primitive } = lineFixture("retained");

  const result = commitDetachedDrawingCommands({
    commands: [{ type: "create", entity }],
    primitives: [primitive],
    renderer,
    scopeKey,
    store,
  });

  assert.ok(result);
  assert.equal(result.changed, true);
  assert.equal(result.rendererAdopted, true);
  assert.equal(result.surfaceSynchronized, false);
  assert.strictEqual(result.document, store.getSnapshot());
  assert.strictEqual(renderer.documentSnapshot(), store.getSnapshot());
  assert.equal(store.getSnapshot().entities.has("retained"), true);
  assert.equal(store.dirty, true);
  assert.deepEqual(events, ["document:1", "attach-rejected:retained"]);
});

test("committed paint tickets require the exact attached surface and retain the viewport revision", () => {
  const document = createDrawingDocument({
    scopeKey: "paint-ticket",
    documentRevision: 7,
  });
  const frame = Object.freeze({ surfaceGeneration: 11, viewportRevision: 29 });

  const ticket = createDrawingCommittedPaintTicket(document, frame, 11);

  assert.deepEqual(ticket, {
    scopeKey: "paint-ticket",
    documentRevision: 7,
    surfaceGeneration: 11,
    viewportRevision: 29,
  });
  assert.equal(Object.isFrozen(ticket), true);
  assert.equal(createDrawingCommittedPaintTicket(document, frame, 10), null);
  assert.equal(createDrawingCommittedPaintTicket(document, frame, null), null);
  assert.equal(createDrawingCommittedPaintTicket(document, null, 11), null);
});

test("committed paint tickets reject non-exact surface and viewport coordinates", () => {
  const document = createDrawingDocument({ scopeKey: "invalid-paint-ticket" });
  const invalidFrames = [
    { surfaceGeneration: -1, viewportRevision: 0 },
    { surfaceGeneration: 0.5, viewportRevision: 0 },
    { surfaceGeneration: Number.MAX_SAFE_INTEGER + 1, viewportRevision: 0 },
    { surfaceGeneration: 0, viewportRevision: -1 },
    { surfaceGeneration: 0, viewportRevision: 0.5 },
    { surfaceGeneration: 0, viewportRevision: Number.MAX_SAFE_INTEGER + 1 },
  ] as const;

  for (const frame of invalidFrames) {
    assert.equal(
      createDrawingCommittedPaintTicket(document, frame, frame.surfaceGeneration),
      null,
    );
  }
});

test("dynamic overlay owns selection and excludes only its active migrated entity", () => {
  assert.equal(visibleSceneSelectedId("selected", false), "selected");
  assert.equal(visibleSceneSelectedId("selected", true), null);
  assert.equal(visibleSceneSelectedId(null, true), null);

  const migratedKinds: readonly DrawingKind[] = [
    "line",
    "axis-line",
    "shape",
    "freehand",
    "highlighter",
    "angle-measure",
    "text",
    "fibonacci",
    "position",
  ];
  for (const kind of migratedKinds) {
    assert.equal(shouldProjectVisibleSceneEntity(kind, "active", false, "active"), true);
    assert.equal(shouldProjectVisibleSceneEntity(kind, "active", true, "active"), false);
    assert.equal(shouldProjectVisibleSceneEntity(kind, "other", true, "active"), true);
    assert.equal(shouldProjectVisibleSceneEntity(kind, "active", true, null), true);
  }

});

test("document-only renderer selection never invokes legacy construction or surface attachment", () => {
  assert.equal(shouldUseDrawingDocumentSceneRegistry(true, "document", "scene-canary"), true);
  assert.equal(shouldUseDrawingDocumentSceneRegistry(false, "document", "scene-canary"), false);
  assert.equal(shouldUseDrawingDocumentSceneRegistry(true, "document", "shadow"), false);
  assert.equal(shouldUseDrawingDocumentSceneRegistry(true, "document", "legacy"), false);
  assert.equal(shouldUseDrawingDocumentSceneRegistry(true, "legacy", "scene-canary"), false);
  const fixture = lineFixture("document-only-line");
  const document = createDrawingDocument({
    scopeKey: "document-only",
    documentRevision: 3,
    entities: [createDrawingEntity(fixture.entity)],
  });
  let factoryCalls = 0;
  let attachCalls = 0;
  const renderer = createDrawingPersistenceRenderer(true, {
    createPrimitive() {
      factoryCalls += 1;
      return fixture.primitive;
    },
    surface: {
      attachPrimitive() {
        attachCalls += 1;
        return true;
      },
    },
  });

  assert.equal(renderer.reconcile(document), true);
  assert.equal(factoryCalls, 0);
  assert.equal(attachCalls, 0);
  assert.equal(renderer.snapshot().length, 0);
  assert.equal(renderer.attachedCount(), 0);
  assert.deepEqual(drawingLegacyPrimitiveRuntimeEvidence(true, renderer, []), {
    registryKind: "scene-document-only",
    documentEntityCount: 1,
    legacyPrimitiveAttachedCount: 0,
    legacyPrimitiveInstanceCount: 0,
    zeroLegacyPrimitiveInvariant: true,
  });
  assert.deepEqual(drawingLegacyPrimitiveRuntimeEvidence(true, renderer, [fixture.primitive]), {
    registryKind: "scene-document-only",
    documentEntityCount: 1,
    legacyPrimitiveAttachedCount: 0,
    legacyPrimitiveInstanceCount: 1,
    zeroLegacyPrimitiveInvariant: false,
  });
  assert.equal(
    drawingLegacyPrimitiveRuntimeEvidence(true, null, []).zeroLegacyPrimitiveInvariant,
    false,
  );
});

test("legacy renderer selection retains materialization and attachment behavior", () => {
  const fixture = lineFixture("legacy-line");
  const document = createDrawingDocument({
    scopeKey: "legacy-renderer",
    entities: [createDrawingEntity(fixture.entity)],
  });
  let factoryCalls = 0;
  let attachCalls = 0;
  const renderer = createDrawingPersistenceRenderer(false, {
    createPrimitive() {
      factoryCalls += 1;
      return fixture.primitive;
    },
    surface: {
      attachPrimitive() {
        attachCalls += 1;
        return true;
      },
    },
  });

  assert.equal(renderer.reconcile(document), true);
  assert.equal(factoryCalls, 1);
  assert.equal(attachCalls, 1);
  assert.equal(renderer.snapshot().length, 1);
  assert.equal(renderer.attachedCount(), 1);
  assert.equal(
    drawingLegacyPrimitiveRuntimeEvidence(false, renderer, renderer.snapshot())
      .zeroLegacyPrimitiveInvariant,
    false,
  );
});
