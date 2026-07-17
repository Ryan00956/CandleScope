import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { createPrimitiveFromSavedDrawing } from "./drawingPrimitiveFactory.js";
import {
  loadDrawings,
  saveDrawings,
} from "./drawingPersistence.js";
import {
  EMPTY_SELECTED_TEXT_UI,
  selectedTextUiFromSavedDrawing,
  selectedTextUiFromPrimitive,
} from "./drawingSelectionController.js";
import type { SelectedTextUi } from "./drawingSelectionController.js";
import { resolveDrawingDocumentAuthorityMode } from "./drawingDocumentAuthority.js";
import type { DrawingDocumentAuthorityMode } from "./drawingDocumentAuthority.js";
import { resolveDrawingRasterBackend } from "./drawingRasterBackend.js";
import { resolvePhase4DrawingEngineMode } from "./drawingEngineMode.js";
import type { DrawingEngineEffectiveMode } from "./drawingEngineMode.js";
import { createEmptyDrawingDocument } from "./core/drawingDocument.js";
import type { DrawingDocument, DrawingEntity } from "./core/drawingDocument.js";
import { savedDrawingFromEntity } from "./core/drawingCodec.js";
import {
  commitLegacyPrimitiveCommands,
  persistentLegacyPrimitives,
} from "./core/drawingDocumentRuntime.js";
import type { DrawingCommand } from "./core/drawingCommands.js";
import {
  drawingDocumentSessionRegistry,
} from "./core/drawingDocumentStore.js";
import type { DrawingDocumentStore } from "./core/drawingDocumentStore.js";
import {
  drawingPersistenceCoordinator,
} from "./persistence/drawingPersistenceCoordinator.js";
import type {
  DrawingPersistenceCoordinator,
  DrawingPersistenceFlushResult,
} from "./persistence/drawingPersistenceCoordinator.js";
import { legacyDrawingImporter } from "./persistence/legacyDrawingImporter.js";
import {
  encodeDrawingDocumentRecord,
  drawingDocumentRepository,
} from "./persistence/drawingDocumentRepository.js";
import type {
  DrawingDocumentLoadResult,
} from "./persistence/drawingDocumentRepository.js";
import {
  createLegacyPrimitiveRenderer,
} from "./legacy/legacyPrimitiveRenderer.js";
import type {
  LegacyPrimitiveRenderer,
  LegacyPrimitiveRendererOptions,
} from "./legacy/legacyPrimitiveRenderer.js";
import type {
  DrawingChartAdapter,
  DrawingKind,
  DrawingPrimitive,
  SavedDrawing,
} from "./drawingTypes.js";
import {
  createDrawingSceneRuntime,
} from "./engine/drawingSceneRuntime.js";
import type {
  DrawingSceneExactPaintReceipt,
  DrawingSceneRuntime,
  DrawingSceneRuntimeSnapshot,
} from "./engine/drawingSceneRuntime.js";
import {
  projectDrawingScene,
  projectDrawingSceneCanonicalGapIndexes,
  readDrawingSceneProjectorCacheSnapshot,
} from "./engine/drawingSceneProjector.js";
import { compareDrawingShadowParity } from "./engine/drawingShadowParity.js";
import { captureLegacyDrawingParityProbe } from "./legacy/legacyDrawingParityProbe.js";
import {
  hitTestDrawingHitIndex,
  queryDrawingHitIndex,
} from "./geometry/drawingHitIndex.js";
import type { FreehandDrawingPrimitive } from "./primitives/FreehandDrawingPrimitive.js";
import {
  drawingPerfCounters,
  registerDrawingPerfActivePersistenceDocumentRecordProvider,
  registerDrawingPerfLegacyCompatibilitySnapshotProvider,
  registerDrawingPerfPhase6HitOracleProvider,
  registerDrawingPerfPhase6RuntimeProvider,
  registerDrawingPerfShadowParityRequester,
  registerDrawingPerfRuntimeSummaryProvider,
} from "./performance/drawingPerfCounters.js";
import type { DrawingPerfRuntimeSummary } from "./performance/drawingPerfCounters.js";
import {
  createDrawingScenePrimitiveBridge,
} from "../../chart-adapter/drawingScenePrimitiveBridge.js";
import type {
  DrawingScenePrimitiveBridge,
  DrawingScenePrimitiveBridgeSnapshot,
} from "../../chart-adapter/drawingScenePrimitiveBridge.js";
import { DrawingScenePrimitive } from "./rendering/DrawingScenePrimitive.js";
import {
  drawingDisplayEntityScreenHandles,
  drawingDisplayEntityScreenBox,
  hitTestDrawingScreenDisplayList,
} from "./rendering/drawingDisplayList.js";
import type {
  DrawingDisplayHitResult,
  DrawingScreenDisplayList,
} from "./rendering/drawingDisplayList.js";
import type { ScreenBox, ScreenPoint } from "./drawingTypes.js";
import {
  isPhase8SceneDrawingKind,
  isPhase8SceneDrawingPrimitive,
} from "./rendering/drawingSceneMigration.js";
import { sameDrawingWorkerStamp } from "./worker/drawingWorkerProtocol.js";
import {
  createDrawingDocumentSceneRegistry,
} from "./rendering/drawingDocumentSceneRegistry.js";
import type {
  DrawingDocumentSceneRegistry,
  DrawingDocumentSceneRegistryEvidence,
} from "./rendering/drawingDocumentSceneRegistry.js";

// A drawing frame is published only after the chart has data, a measurable
// pane and a coherent visible range. Live startup and series replacement can
// legitimately take longer than one second, so do not mistake that normal
// readiness window for a scene failure and permanently fall back to legacy.
const VISIBLE_SCENE_FRAME_READY_RETRY_LIMIT = 600;
const VISIBLE_SCENE_ATTACH_RETRY_LIMIT = 3;
const VISIBLE_SCENE_RETRY_DELAY_MS = 16;

function runtimeRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

interface MutableDrawingDelegate<T> {
  read(): T;
  write(value: T): void;
}

function createMutableDrawingDelegate<T>(initial: T): MutableDrawingDelegate<T> {
  let value = initial;
  return Object.freeze({
    read: () => value,
    write: (next: T) => { value = next; },
  });
}

function runtimeArrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function runtimePrimitiveType(record: Record<string, unknown>): string {
  if (typeof record._lineType === "string" || typeof record.lineType === "string") return "line";
  if (typeof record._shapeType === "string" || typeof record.shapeType === "string") return "shape";
  const type = record.type ?? record._type;
  if (typeof type === "string" && type.trim()) return type.trim();
  const constructorRecord = runtimeRecord(record.constructor);
  const constructorName = constructorRecord?.name;
  return typeof constructorName === "string" && constructorName.trim()
    ? constructorName.trim()
    : "unknown";
}

function runtimePrimitivePointCount(record: Record<string, unknown>): number {
  const stroke = runtimeRecord(record.stroke ?? record._stroke);
  const strokePointCount = runtimeArrayLength(stroke?.points);
  if (strokePointCount !== null) return strokePointCount;
  const dataPointCount = runtimeArrayLength(record.dataPoints ?? record._dataPoints);
  if (dataPointCount !== null) return dataPointCount;
  return record.dataPoint !== undefined || record._dataPoint !== undefined ? 1 : 0;
}

function drawingMonotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function configureLegacyViewportBatching(
  primitives: readonly DrawingPrimitive[],
  enabled: boolean,
): void {
  for (const primitive of primitives) {
    const batchable = primitive as DrawingPrimitive & {
      setViewUpdateBatching?: (next: boolean) => void;
    };
    batchable.setViewUpdateBatching?.(enabled);
  }
}

export function summarizeDrawingRuntimePrimitives(
  primitives: readonly unknown[],
  attachedPrimitiveCount?: number,
): DrawingPerfRuntimeSummary {
  let entityCount = 0;
  let pointCount = 0;
  const typeCounts: Record<string, number> = {};
  for (const primitive of primitives) {
    const record = runtimeRecord(primitive);
    if (!record) continue;
    entityCount += 1;
    const type = runtimePrimitiveType(record);
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    pointCount += runtimePrimitivePointCount(record);
  }
  return {
    entityCount,
    pointCount,
    typeCounts,
    ...(attachedPrimitiveCount === undefined ? {} : { attachedPrimitiveCount }),
  };
}

function canonicalDrawingEntityPointCount(entity: DrawingEntity): number {
  const geometry = entity.geometry;
  switch (geometry.kind) {
    case "line":
    case "angle-measure":
    case "fibonacci":
    case "shape":
      return geometry.dataPoints?.length ?? 0;
    case "axis-line":
    case "text":
      return geometry.dataPoint === undefined ? 0 : 1;
    case "freehand":
    case "highlighter":
      return geometry.stroke?.points.length ?? geometry.dataPoints?.length ?? 0;
    case "position":
      // Keep the performance-fixture contract aligned with SavedDrawing:
      // position timeRange endpoints are not counted as dataPoint(s).
      return 0;
  }
}

/**
 * Phase 8 document-only scenes deliberately retain zero per-drawing primitive
 * instances. Performance restore evidence must therefore read the canonical
 * document directly instead of mistaking that zero-instance invariant for an
 * empty drawing scope.
 */
export function summarizeDrawingRuntimeDocument(
  document: DrawingDocument,
  attachedPrimitiveCount?: number,
): DrawingPerfRuntimeSummary {
  let pointCount = 0;
  const typeCounts: Record<string, number> = {};
  for (const entity of document.entities.values()) {
    typeCounts[entity.kind] = (typeCounts[entity.kind] ?? 0) + 1;
    pointCount += canonicalDrawingEntityPointCount(entity);
  }
  return {
    entityCount: document.entities.size,
    pointCount,
    typeCounts,
    ...(attachedPrimitiveCount === undefined ? {} : { attachedPrimitiveCount }),
  };
}

export interface DrawingLegacyPrimitiveRuntimeEvidence {
  readonly registryKind: "legacy-compatible" | "scene-document-only";
  readonly documentEntityCount: number;
  readonly legacyPrimitiveAttachedCount: number;
  readonly legacyPrimitiveInstanceCount: number;
  readonly zeroLegacyPrimitiveInvariant: boolean;
}

/**
 * Mount-time renderer selection. Keeping this as a pure seam makes the Phase
 * 8 zero-instance requirement independently testable without mounting React.
 */
export function createDrawingPersistenceRenderer(
  sceneDocumentOnly: boolean,
  legacyOptions: LegacyPrimitiveRendererOptions,
): LegacyPrimitiveRenderer {
  return sceneDocumentOnly
    ? createDrawingDocumentSceneRegistry()
    : createLegacyPrimitiveRenderer(legacyOptions);
}

export function shouldUseDrawingDocumentSceneRegistry(
  requested: boolean,
  authorityMode: DrawingDocumentAuthorityMode,
  engineMode: DrawingEngineEffectiveMode,
): boolean {
  return requested && authorityMode === "document" && engineMode === "scene-canary";
}

export function drawingLegacyPrimitiveRuntimeEvidence(
  sceneDocumentOnly: boolean,
  renderer: LegacyPrimitiveRenderer | null,
  primitives: readonly DrawingPrimitive[],
): DrawingLegacyPrimitiveRuntimeEvidence {
  if (sceneDocumentOnly) {
    const sceneRenderer = renderer as Partial<DrawingDocumentSceneRegistry> | null;
    const sceneEvidence = typeof sceneRenderer?.evidence === "function"
      ? (sceneRenderer.evidence() as DrawingDocumentSceneRegistryEvidence)
      : null;
    const documentEntityCount = sceneEvidence?.documentEntityCount
      ?? renderer?.documentSnapshot()?.entities.size
      ?? 0;
    const legacyPrimitiveAttachedCount = renderer?.attachedCount() ?? 0;
    const legacyPrimitiveInstanceCount = primitives.length;
    return Object.freeze({
      registryKind: "scene-document-only" as const,
      documentEntityCount,
      legacyPrimitiveAttachedCount,
      legacyPrimitiveInstanceCount,
      zeroLegacyPrimitiveInvariant: sceneEvidence?.registryKind === "scene-document-only"
        && sceneEvidence.legacyPrimitiveAttachedCount === 0
        && sceneEvidence.legacyPrimitiveInstanceCount === 0
        && legacyPrimitiveAttachedCount === 0
        && legacyPrimitiveInstanceCount === 0,
    });
  }
  // Legacy authority attaches primitives directly through the chart adapter
  // instead of adopting them into LegacyPrimitiveRenderer. Lightweight Charts
  // sets `_series` only after a successful attachment, so this is the narrow
  // runtime proof that the rollback build materialized visible primitives.
  const directlyAttachedPrimitiveCount = primitives.reduce((count, primitive) => (
    (primitive as DrawingPrimitive & { _series?: unknown })._series ? count + 1 : count
  ), 0);
  const rendererAttachedPrimitiveCount = renderer?.attachedCount() ?? 0;
  return Object.freeze({
    registryKind: "legacy-compatible" as const,
    documentEntityCount: Math.max(
      renderer?.documentSnapshot()?.entities.size ?? 0,
      primitives.length,
    ),
    legacyPrimitiveAttachedCount: Math.max(
      rendererAttachedPrimitiveCount,
      directlyAttachedPrimitiveCount,
    ),
    legacyPrimitiveInstanceCount: primitives.length,
    zeroLegacyPrimitiveInvariant: false,
  });
}

const drawingDocumentLoadPromises = new Map<
  string,
  Promise<DrawingDocumentLoadResult>
>();

function loadDrawingDocumentOnce(scopeKey: string): Promise<DrawingDocumentLoadResult> {
  const existing = drawingDocumentLoadPromises.get(scopeKey);
  if (existing) return existing;
  const request = drawingDocumentRepository.load(scopeKey);
  drawingDocumentLoadPromises.set(scopeKey, request);
  void request.finally(() => {
    if (drawingDocumentLoadPromises.get(scopeKey) === request) {
      drawingDocumentLoadPromises.delete(scopeKey);
    }
  });
  return request;
}

function persistAndMeasure(symbol: string, primitives: readonly DrawingPrimitive[]): void {
  const startedAt = typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
  try {
    saveDrawings(symbol, primitives);
  } finally {
    const endedAt = typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
    const durationMs = Math.max(0, endedAt - startedAt);
    drawingPerfCounters.recordPersistenceDuration(durationMs);
  }
}

export interface DrawingPersistenceAdapter {
  hasSeries?(): boolean;
  attachPrimitive?(primitive: DrawingPrimitive): unknown;
  detachPrimitive?(primitive: DrawingPrimitive): unknown;
}

export interface DrawingMutationScopeState {
  activeScope: string;
  hasSeries: boolean;
  previousScope: string | null;
  ready: boolean;
  requestedScope: string;
  surfaceScope: string;
}

export interface DrawingVisibleScenePublicationState {
  attachedSurfaceGeneration: number | null;
  publishedSurfaceGeneration: number | null;
  requestedScope: string;
  runtimeActive: boolean;
  runtimePublicationReady: boolean;
  runtimeScope: string | null;
  sceneCanaryEnabled: boolean;
}

export interface DrawingCommittedPaintTicket {
  readonly scopeKey: string;
  readonly documentRevision: number;
  readonly surfaceGeneration: number;
  readonly viewportRevision: number;
}

export interface DrawingDetachedCommitReceipt {
  /** True means the document store already accepted the command batch. */
  readonly committed: true;
  readonly changed: boolean;
  readonly surfaceSynchronized: boolean;
  readonly ticket: DrawingCommittedPaintTicket | null;
}

export interface DrawingActiveDocumentTarget {
  readonly scopeKey: string;
  readonly documentRevision: number;
}

export type DrawingActiveDocumentFlushResult = DrawingPersistenceFlushResult | Readonly<{
  ok: true;
  scopeKey: string;
  targetRevision: number;
  persistedRevision: number;
  skipped: true;
}>;

export async function flushDrawingPersistenceTarget(
  coordinator: DrawingPersistenceCoordinator,
  store: DrawingDocumentStore,
  target: DrawingActiveDocumentTarget,
): Promise<DrawingActiveDocumentFlushResult> {
  const document = store.getSnapshot();
  if (document.scopeKey !== target.scopeKey
    || document.documentRevision !== target.documentRevision) {
    return Object.freeze({
      ok: false as const,
      scopeKey: target.scopeKey,
      targetRevision: target.documentRevision,
      error: new Error("drawing export persistence target is stale"),
    });
  }
  if (!store.dirty) {
    return Object.freeze({
      ok: true as const,
      scopeKey: target.scopeKey,
      targetRevision: target.documentRevision,
      persistedRevision: target.documentRevision,
      skipped: true as const,
    });
  }
  if (coordinator.snapshot(target.scopeKey) === null
    && !coordinator.schedule(store)) {
    return Object.freeze({
      ok: false as const,
      scopeKey: target.scopeKey,
      targetRevision: target.documentRevision,
      error: new Error("drawing export persistence could not be scheduled"),
    });
  }
  return coordinator.flush(target.scopeKey);
}

export interface DrawingExportHiddenFrameReceipt {
  readonly kind: "hidden-frame";
  readonly scopeKey: string;
  readonly documentRevision: number;
  /** Canonical immutable snapshot whose exact empty scene was acknowledged. */
  readonly document: DrawingDocument;
  readonly sceneEpoch: number;
  readonly attachmentRevision: number;
  readonly paintSequence: number;
}

export type DrawingExportSceneReceipt = DrawingSceneExactPaintReceipt
  | Readonly<DrawingExportHiddenFrameReceipt>
  | Readonly<{
    kind: "legacy-frame";
    scopeKey: string;
    documentRevision: number;
  }>;

export interface DetachedDrawingCommandCommitResult {
  readonly changed: boolean;
  readonly document: DrawingDocument;
  readonly rendererAdopted: boolean;
  readonly surfaceSynchronized: boolean;
}

export interface CommitDetachedDrawingCommandsOptions {
  readonly commands: readonly DrawingCommand[];
  readonly primitives: readonly DrawingPrimitive[];
  readonly renderer: LegacyPrimitiveRenderer;
  readonly scopeKey: string;
  readonly store: DrawingDocumentStore;
}

/**
 * Pure document-first mutation boundary for detached interaction candidates.
 * Candidate serialization and command equivalence are validated before the
 * store publishes; every surface action happens only after that publication.
 */
export function commitDetachedDrawingCommands({
  commands,
  primitives,
  renderer,
  scopeKey,
  store,
}: CommitDetachedDrawingCommandsOptions): DetachedDrawingCommandCommitResult | null {
  const committed = commitLegacyPrimitiveCommands(
    store,
    scopeKey,
    primitives,
    commands,
    (document, candidates) => renderer.canAdopt(document, candidates),
  );
  if (!committed.ok) return null;
  const surfaceSynchronized = renderer.adoptDetached(
    committed.document,
    committed.primitives,
  );
  return Object.freeze({
    changed: committed.changed,
    document: committed.document,
    rendererAdopted: renderer.documentSnapshot() === committed.document,
    surfaceSynchronized,
  });
}

export function createDrawingCommittedPaintTicket(
  document: DrawingDocument,
  frame: Readonly<{ surfaceGeneration: number; viewportRevision: number }> | null,
  attachedSurfaceGeneration: number | null,
): DrawingCommittedPaintTicket | null {
  if (!frame
    || !Number.isSafeInteger(frame.surfaceGeneration)
    || frame.surfaceGeneration < 0
    || !Number.isSafeInteger(frame.viewportRevision)
    || frame.viewportRevision < 0
    || attachedSurfaceGeneration !== frame.surfaceGeneration) return null;
  return Object.freeze({
    scopeKey: document.scopeKey,
    documentRevision: document.documentRevision,
    surfaceGeneration: frame.surfaceGeneration,
    viewportRevision: frame.viewportRevision,
  });
}

export function visibleSceneSelectedId(
  selectedId: string | null,
  dynamicOverlayEnabled: boolean,
): string | null {
  return dynamicOverlayEnabled ? null : selectedId;
}

export function shouldProjectVisibleSceneEntity(
  kind: DrawingKind,
  id: string,
  dynamicOverlayEnabled: boolean,
  activeOverlayEntityId: string | null,
): boolean {
  return isPhase8SceneDrawingKind(kind)
    && (!dynamicOverlayEnabled || id !== activeOverlayEntityId);
}

function hasCurrentDrawingVisibleScenePublication({
  attachedSurfaceGeneration,
  publishedSurfaceGeneration,
  requestedScope,
  runtimeScope,
}: DrawingVisibleScenePublicationState): boolean {
  return requestedScope.length > 0
    && runtimeScope === requestedScope
    && attachedSurfaceGeneration !== null
    && publishedSurfaceGeneration === attachedSurfaceGeneration;
}

/**
 * The scene-canary mutation boundary opens only after the current runtime and
 * surface generation accepted a visible publication. Legacy/shadow operation
 * bypasses this additional gate and retains its existing scope semantics.
 */
export function isDrawingVisibleScenePublicationReady(
  state: DrawingVisibleScenePublicationState,
): boolean {
  return !state.sceneCanaryEnabled
    || (state.runtimeActive
      && state.runtimePublicationReady
      && hasCurrentDrawingVisibleScenePublication(state));
}

export function canRecoverDrawingVisibleSceneInPlace(
  state: DrawingVisibleScenePublicationState & Readonly<{ mutationStarted: boolean }>,
): boolean {
  return state.sceneCanaryEnabled
    && state.mutationStarted
    && !state.runtimePublicationReady
    && state.publishedSurfaceGeneration !== null
    && hasCurrentDrawingVisibleScenePublication(state);
}

/**
 * A user mutation may only touch the surface/store pair that belongs to the
 * symbol currently requested by React. During a failed A -> B transition the
 * old A store deliberately remains active, so `ready` alone is insufficient.
 */
export function isDrawingMutationScopeReady({
  activeScope,
  hasSeries,
  previousScope,
  ready,
  requestedScope,
  surfaceScope,
}: DrawingMutationScopeState): boolean {
  return ready
    && hasSeries
    && requestedScope.length > 0
    && activeScope === requestedScope
    && surfaceScope === requestedScope
    && previousScope === requestedScope;
}

export function prepareDrawingMutationScope(
  state: DrawingMutationScopeState,
  requestRetry: () => void,
): boolean {
  const ready = isDrawingMutationScopeReady(state);
  if (!ready) requestRetry();
  return ready;
}

export interface DrawingSceneHiddenTransitionOptions {
  /** Keep the scene binding alive long enough to publish an exact empty plan for export. */
  readonly exactExport?: boolean;
}

export interface DrawingSceneActivationOptions {
  /** Export-only permission to activate a scene while global visibility is hidden. */
  readonly allowHiddenExact?: boolean;
}

export function shouldKeepDrawingSceneSuspendedWhileHidden(
  visibleCanary: boolean,
  hidden: boolean,
  options: DrawingSceneActivationOptions = {},
): boolean {
  return visibleCanary && hidden && options.allowHiddenExact !== true;
}

/**
 * Ordinary visibility toggles fully suspend the scene/worker. An export-only
 * hide instead retires the visible plan synchronously, then keeps the binding
 * alive so the exact-paint barrier can acknowledge a fresh empty scene.
 */
export function transitionDrawingSceneToHidden(
  runtime: Pick<DrawingSceneRuntime, "invalidate" | "suspend">,
  clearPlan: (requestUpdate?: boolean) => void,
  options: DrawingSceneHiddenTransitionOptions = {},
): boolean {
  if (!options.exactExport) {
    runtime.suspend();
    clearPlan(false);
    return true;
  }

  clearPlan();
  if (runtime.invalidate("export-visibility-hidden")) return true;

  // If an exact empty publication cannot be scheduled, retain the ordinary
  // fail-closed blank state and let the export barrier reject the capture.
  runtime.suspend();
  clearPlan(false);
  return false;
}

/** A globally hidden scene is normally suspended; export may reactivate it only as an empty scene. */
export function ensureHiddenDrawingSceneRuntimeForExactExport(
  hidden: boolean,
  runtimeActive: boolean,
  activateHiddenScene: () => boolean,
): boolean {
  return !hidden || runtimeActive || activateHiddenScene();
}

/** Exact hidden acknowledgement must prove that no drawable entity survived projection. */
export function isDrawingExportExactSceneEmpty(
  receipt: DrawingSceneExactPaintReceipt,
): boolean {
  return receipt.plan.entities.length === 0
    && receipt.plan.freehandRaster === undefined;
}

/**
 * A hidden-frame receipt is stable only after the live scene runtime and its
 * worker have retired and the attached composite primitive owns no plan.
 */
export function isDrawingHiddenExportSceneRetired(
  runtime: Pick<
    DrawingSceneRuntimeSnapshot,
    | "active"
    | "hitIndex"
    | "lastWorkerPublishedStamp"
    | "lastWorkerRequestedStamp"
    | "plan"
    | "publicationReady"
    | "scopeKey"
    | "worker"
  >,
  bridge: Pick<
    DrawingScenePrimitiveBridgeSnapshot<DrawingScreenDisplayList>,
    "lastPaintedStamp" | "publishedPlan"
  >,
): boolean {
  const worker = runtime.worker;
  const workerRetired = worker === null || (
    worker.availability === "disposed"
    && worker.queueDepth === 0
    && worker.inFlight === 0
    && worker.pending === 0
    && worker.inFlightHeader === null
    && worker.pendingHeader === null
  );
  return !runtime.active
    && runtime.scopeKey === null
    && runtime.plan === null
    && runtime.hitIndex === null
    && !runtime.publicationReady
    && runtime.lastWorkerRequestedStamp === null
    && runtime.lastWorkerPublishedStamp === null
    && workerRetired
    && bridge.publishedPlan === null
    && bridge.lastPaintedStamp === null;
}

/** Hidden capture stays exact without retaining a live, invalidatable plan. */
export function isDrawingHiddenExportFrameCurrent(
  target: DrawingActiveDocumentTarget,
  receipt: DrawingExportHiddenFrameReceipt,
  currentDocument: DrawingDocument,
  currentlyHidden: boolean,
  runtime: Parameters<typeof isDrawingHiddenExportSceneRetired>[0],
  bridge: Parameters<typeof isDrawingHiddenExportSceneRetired>[1],
): boolean {
  return receipt.scopeKey === target.scopeKey
    && receipt.documentRevision === target.documentRevision
    && currentDocument.scopeKey === target.scopeKey
    && currentDocument.documentRevision === target.documentRevision
    && receipt.document === currentDocument
    && currentlyHidden
    && isDrawingHiddenExportSceneRetired(runtime, bridge);
}

/** Own cleanup when a hidden export activated the runtime before presentation existed. */
export function restorePrePresentationHiddenDrawingSceneRuntime(
  hiddenAtStart: boolean,
  currentlyHidden: boolean,
  presentationRestored: boolean,
  restoreOrdinaryHiddenLifecycle: () => void,
): boolean {
  // Exact-scene waiting happens before the export visibility gate is locked.
  // A user may therefore show drawings while that wait is pending. The old
  // hidden state owns cleanup only while it is still the current visibility
  // intent; otherwise suspending here would overwrite the newer visible state.
  if (!hiddenAtStart || !currentlyHidden || presentationRestored) return false;
  restoreOrdinaryHiddenLifecycle();
  return true;
}

export interface UseDrawingPersistenceLifecycleOptions {
  activeOverlayEntityIdRef?: MutableRefObject<string | null>;
  beforeScopeTransitionRef: MutableRefObject<() => boolean>;
  currentFreehandRef: MutableRefObject<FreehandDrawingPrimitive | null>;
  draggingRef: MutableRefObject<unknown | null>;
  dynamicOverlayEnabled?: boolean;
  getChartAdapter(): DrawingPersistenceAdapter | null;
  getDrawingSceneAdapter(): DrawingChartAdapter | null;
  hiddenRef: MutableRefObject<boolean>;
  isDrawingFreehandRef: MutableRefObject<boolean>;
  onInteractionSurfaceFallback?: (() => void) | null;
  prevSymbolRef: MutableRefObject<string | null>;
  primitivesRef: MutableRefObject<DrawingPrimitive[]>;
  selectedIdRef: MutableRefObject<string | null>;
  /**
   * Phase 8 mount-locked cutover. It is honored only by document-authority
   * scene-canary; legacy and shadow retain the primitive rollback renderer.
   */
  sceneDocumentOnly?: boolean;
  seriesReady: number;
  setSelectedPrimId: Dispatch<SetStateAction<string | null>>;
  setSelectedTextUi: Dispatch<SetStateAction<SelectedTextUi>>;
  symbol: string;
  symbolRef: MutableRefObject<string>;
}

export function useDrawingPersistenceLifecycle({
  activeOverlayEntityIdRef,
  beforeScopeTransitionRef,
  currentFreehandRef,
  draggingRef,
  dynamicOverlayEnabled = false,
  getChartAdapter,
  getDrawingSceneAdapter,
  hiddenRef,
  isDrawingFreehandRef,
  onInteractionSurfaceFallback,
  prevSymbolRef,
  primitivesRef,
  selectedIdRef,
  sceneDocumentOnly = false,
  seriesReady,
  setSelectedPrimId,
  setSelectedTextUi,
  symbol,
  symbolRef,
}: UseDrawingPersistenceLifecycleOptions): {
  clearDrawings(): boolean;
  completeSurfaceDispose(): void;
  invalidateSurfaceCredentialsForSeriesReplacement(): void;
  invalidateVisibleScene(): boolean;
  synchronizeVisibleSceneVisibility(
    hidden: boolean,
    options?: DrawingSceneHiddenTransitionOptions,
  ): boolean;
  persistDetachedDrawings(
    commands: readonly DrawingCommand[],
    candidatePrimitives?: readonly DrawingPrimitive[],
  ): DrawingDetachedCommitReceipt | null;
  persistSceneCommands(commands: readonly DrawingCommand[]): DrawingDetachedCommitReceipt | null;
  persistDrawings(commands: readonly DrawingCommand[]): boolean;
  persistActiveScopeDrawings(commands: readonly DrawingCommand[]): boolean;
  subscribeVisibleScenePaint(
    listener: (stamp: DrawingCommittedPaintTicket) => void,
    options?: Readonly<{ replayLastPaint?: boolean }>,
  ): () => void;
  prepareUserMutationScope(): boolean;
  prepareSurfaceDispose(): boolean;
  hitTestScene(x: number, y: number): DrawingDisplayHitResult | null;
  getSceneScreenBox(id: string): ScreenBox | null;
  getSceneScreenHandles(id: string): readonly ScreenPoint[] | null;
  getSavedDrawing(id: string): SavedDrawing | null;
  getLegacyPrimitiveRuntimeEvidence(): DrawingLegacyPrimitiveRuntimeEvidence;
  getActiveDocumentTarget(): DrawingActiveDocumentTarget | null;
  flushActiveDocument(
    target: DrawingActiveDocumentTarget,
  ): Promise<DrawingActiveDocumentFlushResult>;
  waitForExactExportScene(
    target: DrawingActiveDocumentTarget,
    signal?: AbortSignal,
  ): Promise<DrawingExportSceneReceipt>;
  revalidateExportScene(
    target: DrawingActiveDocumentTarget,
    receipt: DrawingExportSceneReceipt,
  ): boolean;
} {
  const authorityMode = resolveDrawingDocumentAuthorityMode();
  const [engineMode] = useState(() => (
    authorityMode === "document"
      ? resolvePhase4DrawingEngineMode()
      : Object.freeze({
          requested: "legacy" as const,
          effective: "legacy" as const,
          source: "default" as const,
          failedClosed: false,
        })
  ));
  const adapterGetterRef = useRef(getChartAdapter);
  const [sceneDocumentOnlyEnabled] = useState(() => (
    shouldUseDrawingDocumentSceneRegistry(
      sceneDocumentOnly,
      authorityMode,
      engineMode.effective,
    )
  ));
  // One-time scene objects call these delegates only after render; the
  // delegates let passive effects replace the current host callbacks without
  // turning deferred work into a render-time React ref read.
  const [sceneAdapterGetterDelegate] = useState(() => (
    createMutableDrawingDelegate(getDrawingSceneAdapter)
  ));
  const mutationStartedRef = useRef(false);
  const sceneFallbackCountRef = useRef(0);
  const legacyFallbackSucceededCountRef = useRef(0);
  const sceneFallbackLastReasonRef = useRef<string | null>(null);
  const recordSceneFallback = useCallback((reason: unknown): void => {
    drawingPerfCounters.incrementCounter("sceneRuntimeFaultCount");
    sceneFallbackCountRef.current = Math.min(
      Number.MAX_SAFE_INTEGER,
      sceneFallbackCountRef.current + 1,
    );
    sceneFallbackLastReasonRef.current = reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : typeof reason === "string"
        ? reason
        : "unknown scene fallback";
  }, []);
  const [rasterBackend] = useState(() => resolveDrawingRasterBackend());
  const sceneCanaryEnabledRef = useRef(engineMode.effective === "scene-canary");
  const [sceneRuntimeErrorHandlerDelegate] = useState(() => (
    createMutableDrawingDelegate<(error: unknown) => void>((error) => {
      recordSceneFallback(error);
      console.warn("Drawing scene runtime failed before its lifecycle handler was ready", error);
    })
  ));
  const [scenePaintRecoveryDelegate] = useState(() => (
    createMutableDrawingDelegate<() => void>(() => {})
  ));
  const [scenePrimitive] = useState(() => new DrawingScenePrimitive());
  const [sceneBridge] = useState<DrawingScenePrimitiveBridge<
    import("./rendering/drawingDisplayList.js").DrawingScreenDisplayList
  >>(() => createDrawingScenePrimitiveBridge({
    primitive: scenePrimitive,
    attachPrimitive: (primitive) => {
      const adapter = sceneAdapterGetterDelegate.read()();
      return adapter?.attachPrimitive?.(primitive) === true;
    },
    detachPrimitive: (primitive) => {
      const adapter = sceneAdapterGetterDelegate.read()();
      return adapter?.detachPrimitive?.(primitive) === true;
    },
    captureDrawingFrame: () => sceneAdapterGetterDelegate.read()()?.captureDrawingFrame?.() ?? null,
    isDrawingFrameCurrent: (frame) => (
      sceneAdapterGetterDelegate.read()()?.isDrawingFrameCurrent?.(frame) === true
    ),
    onCurrentPaintRejected: () => scenePaintRecoveryDelegate.read()(),
  }));
  // Effect cleanups suspend this state-owned runtime instead of disposing it.
  // React StrictMode replays cleanup/setup against the same state instance in
  // development; disposing here would make the second activation permanently
  // fail closed even though the chart surface is healthy.
  const [sceneRuntime] = useState<DrawingSceneRuntime>(() => createDrawingSceneRuntime({
    mode: engineMode.effective,
    rasterBackend: rasterBackend.effective,
    workerResultDeliveryDelayMs: rasterBackend.workerResultDeliveryDelayMs,
    onError: (error) => {
      drawingPerfCounters.incrementCounter("shadowErrorCount");
      if (engineMode.effective === "scene-canary") {
        sceneRuntimeErrorHandlerDelegate.read()(error);
      } else {
        console.warn("Drawing shadow scene failed; the legacy renderer remains authoritative", error);
      }
    },
    onMetrics: (metrics) => {
      drawingPerfCounters.setGauge("shadowSceneBuildMs", metrics.buildDurationMs);
      drawingPerfCounters.recordSceneRebuild();
      drawingPerfCounters.setGauge("visibleEntities", metrics.visibleEntityCount);
      drawingPerfCounters.setGauge("culledEntities", metrics.culledEntityCount);
    },
    onParity: (result) => {
      drawingPerfCounters.incrementCounter("shadowCompareCount");
      if (!result.ok) {
        drawingPerfCounters.incrementCounter("shadowParityMismatchCount");
      }
      drawingPerfCounters.setGauge("shadowComparedEntities", result.comparedEntityCount);
      drawingPerfCounters.setGauge("shadowComparedHits", result.comparedHitCount);
      drawingPerfCounters.setGauge("shadowMismatchItems", result.mismatches.length);
    },
    onParityDuration: (durationMs) => {
      drawingPerfCounters.setGauge("shadowParityMs", durationMs);
    },
    onSkipped: () => {
      drawingPerfCounters.incrementCounter("shadowSkippedCount");
    },
  }));
  useEffect(() => {
    const recoverCurrentPaint = () => {
      sceneRuntime.invalidate("visible-paint-frame-stale");
    };
    scenePaintRecoveryDelegate.write(recoverCurrentPaint);
    return () => scenePaintRecoveryDelegate.write(() => {});
  }, [scenePaintRecoveryDelegate, sceneRuntime]);
  const [initialStore] = useState(() => drawingDocumentSessionRegistry.getStore(symbol));
  const [scopeRetryGeneration, setScopeRetryGeneration] = useState(0);
  const activeStoreRef = useRef<DrawingDocumentStore>(initialStore);
  const rendererRef = useRef<LegacyPrimitiveRenderer | null>(null);
  const requestedScopeRef = useRef(symbol);
  const persistenceRestoreSourceRef = useRef<Readonly<{
    scopeKey: string;
    source: "v2" | "legacy" | "none" | null;
  }>>({ scopeKey: symbol, source: null });
  const scopeReadyRef = useRef(false);
  const sceneSurfaceRetryCountRef = useRef(0);
  const sceneSurfaceRetryHandleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boundedRestoreRetryRef = useRef({ scopeKey: symbol, attempts: 0 });

  useEffect(() => {
    if (authorityMode !== "document"
      || typeof document === "undefined"
      || typeof window === "undefined") return undefined;
    const flushAll = (reason: "pagehide" | "visibility-hidden"): void => {
      void drawingPersistenceCoordinator.flushAll().then((results) => {
        for (const result of results) {
          if (!result.ok) console.warn(`Failed to flush drawings on ${reason}`, result.error);
        }
      });
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") flushAll("visibility-hidden");
    };
    const handlePageHide = (): void => flushAll("pagehide");
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [authorityMode]);

  // Native pointer listeners and the imperative host API are replaced in
  // passive effects. Close the commit -> passive-effect window in layout so
  // even an old callback observes the newly requested scope and fails closed.
  useLayoutEffect(() => {
    requestedScopeRef.current = symbol;
    scopeReadyRef.current = false;
    if (persistenceRestoreSourceRef.current.scopeKey !== symbol) {
      persistenceRestoreSourceRef.current = { scopeKey: symbol, source: null };
    }
  }, [getChartAdapter, seriesReady, symbol]);

  useEffect(() => {
    adapterGetterRef.current = getChartAdapter;
  }, [getChartAdapter]);

  useEffect(() => {
    sceneAdapterGetterDelegate.write(getDrawingSceneAdapter);
  }, [getDrawingSceneAdapter, sceneAdapterGetterDelegate]);

  useEffect(() => {
    if (rendererRef.current) return;
    rendererRef.current = createDrawingPersistenceRenderer(sceneDocumentOnlyEnabled, {
      surface: {
        attachPrimitive: (primitive) => {
          const adapter = adapterGetterRef.current();
          if (!adapter?.attachPrimitive) return false;
          return adapter.attachPrimitive(primitive) !== false;
        },
        detachPrimitive: (primitive) => {
          const adapter = adapterGetterRef.current();
          if (!adapter?.detachPrimitive) return false;
          return adapter.detachPrimitive(primitive) !== false;
        },
      },
      createPrimitive: (saved) => {
        const primitive = createPrimitiveFromSavedDrawing(saved);
        if (!primitive) return null;
        primitive.setHidden?.(hiddenRef.current, false);
        configureLegacyViewportBatching([primitive], sceneCanaryEnabledRef.current);
        const selectable = primitive as DrawingPrimitive & {
          setSelected?: (selected: boolean) => void;
        };
        selectable.setSelected?.(primitive.id === selectedIdRef.current);
        return primitive;
      },
      shouldAttachPrimitive: (primitive) => (
        !sceneCanaryEnabledRef.current || !isPhase8SceneDrawingPrimitive(primitive)
      ),
    });
  }, [hiddenRef, sceneDocumentOnlyEnabled, selectedIdRef]);

  const fallbackVisibleSceneBeforeMutation = useCallback((reason: unknown): boolean => {
    if (engineMode.effective !== "scene-canary"
      || !sceneCanaryEnabledRef.current
      || mutationStartedRef.current) return false;
    recordSceneFallback(reason);
    if (sceneSurfaceRetryHandleRef.current !== null) {
      clearTimeout(sceneSurfaceRetryHandleRef.current);
      sceneSurfaceRetryHandleRef.current = null;
    }
    sceneSurfaceRetryCountRef.current = 0;
    sceneRuntime.suspend();
    if (sceneDocumentOnlyEnabled) {
      // There is deliberately no per-drawing renderer to fall back to. Keep
      // the canonical document intact, synchronously retire the scene/worker,
      // and leave the mutation scope closed until the scene surface recovers.
      sceneBridge.clearPlan(false);
      scopeReadyRef.current = false;
      console.warn("Drawing document-only scene failed closed; legacy primitive fallback is disabled", reason);
      return false;
    }
    if (!sceneBridge.detach()) {
      scopeReadyRef.current = false;
      console.warn("Drawing scene initialization failed and its partial attachment could not be removed", reason);
      return false;
    }
    sceneCanaryEnabledRef.current = false;
    // Keep the interaction owner aligned with the irreversible runtime
    // downgrade even if this particular legacy rebind attempt still fails.
    // The scope remains blocked and retries the surface, but no overlay-side
    // detached mutation may run against a legacy static owner in the interim.
    onInteractionSurfaceFallback?.();
    const renderer = rendererRef.current;
    if (renderer) configureLegacyViewportBatching(renderer.snapshot(), false);
    if (renderer && !renderer.rebindSurface()) {
      scopeReadyRef.current = false;
      console.warn("Drawing scene fallback could not restore the full legacy surface", reason);
      return false;
    }
    console.warn("Drawing scene initialization failed before the first mutation; using the legacy surface", reason);
    legacyFallbackSucceededCountRef.current = Math.min(
      Number.MAX_SAFE_INTEGER,
      legacyFallbackSucceededCountRef.current + 1,
    );
    drawingPerfCounters.incrementCounter("legacyFallbackSucceededCount");
    return true;
  }, [
    engineMode.effective,
    onInteractionSurfaceFallback,
    recordSceneFallback,
    sceneBridge,
    sceneDocumentOnlyEnabled,
    sceneRuntime,
  ]);

  const scheduleVisibleSceneSurfaceRetry = useCallback((attemptLimit: number): boolean => {
    if (sceneSurfaceRetryCountRef.current >= attemptLimit) return false;
    sceneSurfaceRetryCountRef.current += 1;
    if (sceneSurfaceRetryHandleRef.current !== null) return true;
    sceneSurfaceRetryHandleRef.current = setTimeout(() => {
      sceneSurfaceRetryHandleRef.current = null;
      setScopeRetryGeneration((generation) => (
        generation >= Number.MAX_SAFE_INTEGER ? 0 : generation + 1
      ));
    }, VISIBLE_SCENE_RETRY_DELAY_MS);
    return true;
  }, []);

  useEffect(() => {
    sceneRuntimeErrorHandlerDelegate.write((error) => {
      if (!fallbackVisibleSceneBeforeMutation(error)) {
        // Once a user mutation closes the fallback boundary, the canonical
        // scope remains structurally ready while the scene runtime is faulted.
        // prepareUserMutationScope additionally checks publication readiness,
        // so interactions stay blocked until an in-place recovery publishes.
        // A pre-boundary fallback failure has no retained plan and must keep
        // the whole scope closed.
        if (!mutationStartedRef.current) scopeReadyRef.current = false;
        else recordSceneFallback(error);
        console.warn("Drawing scene runtime failed after the fallback boundary; retaining the last valid plan", error);
      }
    });
    return () => {
      sceneRuntimeErrorHandlerDelegate.write(() => {});
    };
  }, [fallbackVisibleSceneBeforeMutation, recordSceneFallback, sceneRuntimeErrorHandlerDelegate]);

  const ensureVisibleSceneSurface = useCallback((): boolean => {
    if (engineMode.effective !== "scene-canary" || !sceneCanaryEnabledRef.current) return true;
    const adapter = sceneAdapterGetterDelegate.read()();
    if (!adapter?.captureDrawingFrame
      || !adapter.isDrawingFrameCurrent
      || !adapter.attachPrimitive
      || !adapter.detachPrimitive) {
      return fallbackVisibleSceneBeforeMutation("scene adapter capabilities are unavailable");
    }
    const frame = adapter.captureDrawingFrame();
    if (!frame || adapter.isDrawingFrameCurrent(frame) !== true) {
      if (scheduleVisibleSceneSurfaceRetry(VISIBLE_SCENE_FRAME_READY_RETRY_LIMIT)) return false;
      return fallbackVisibleSceneBeforeMutation("scene surface did not become current during initialization");
    }
    if (sceneBridge.attach()) {
      sceneSurfaceRetryCountRef.current = 0;
      if (sceneSurfaceRetryHandleRef.current !== null) {
        clearTimeout(sceneSurfaceRetryHandleRef.current);
        sceneSurfaceRetryHandleRef.current = null;
      }
      return true;
    }
    if (scheduleVisibleSceneSurfaceRetry(VISIBLE_SCENE_ATTACH_RETRY_LIMIT)) return false;
    return fallbackVisibleSceneBeforeMutation("scene primitive attachment failed");
  }, [engineMode.effective, fallbackVisibleSceneBeforeMutation, sceneAdapterGetterDelegate, sceneBridge, scheduleVisibleSceneSurfaceRetry]);

  const activateDrawingScene = useCallback((
    store: DrawingDocumentStore,
    renderer: LegacyPrimitiveRenderer,
    options: DrawingSceneActivationOptions = {},
  ): boolean => {
    const visibleCanary = engineMode.effective === "scene-canary"
      && sceneCanaryEnabledRef.current;
    if (authorityMode !== "document"
      || (engineMode.effective !== "shadow" && !visibleCanary)) return false;
    if (shouldKeepDrawingSceneSuspendedWhileHidden(
      visibleCanary,
      hiddenRef.current,
      options,
    )) {
      // Hidden is a synchronized blank state, not an activation failure. Keep
      // ordinary React reconciliation from reviving the exact-export runtime
      // after its hidden-frame receipt deliberately retired it.
      sceneRuntime.suspend();
      sceneBridge.clearPlan(false);
      return true;
    }
    const adapter = sceneAdapterGetterDelegate.read()();
    if (!adapter?.captureDrawingFrame
      || !adapter.isDrawingFrameCurrent
      || !adapter.projectDrawingFrameDataPoints
      || !adapter.projectDrawingFrameSourceLineageSpan
      || !adapter.measureText
      || !adapter.subscribeDrawingFrameInvalidation) {
      sceneRuntime.suspend();
      return false;
    }
    return sceneRuntime.activate({
      adapter,
      renderer,
      store,
      projectScene: projectDrawingScene,
      isVisible: () => !hiddenRef.current,
      selectedId: () => visibleSceneSelectedId(selectedIdRef.current, dynamicOverlayEnabled),
      ...(visibleCanary ? {
        shouldProjectNode: (node) => shouldProjectVisibleSceneEntity(
          node.entity.kind,
          node.id,
          dynamicOverlayEnabled,
          activeOverlayEntityIdRef?.current ?? null,
        ),
        publishScene: (plan) => sceneBridge.publish(plan),
        subscribeScenePainted: (listener) => sceneBridge.subscribePainted(
          (ack) => listener(ack.stamp),
        ),
        subscribeSceneExactPainted: (listener) => sceneBridge.subscribePainted(listener),
        clearScene: () => sceneBridge.clearPlan(),
      } : {}),
      ...(engineMode.effective === "shadow" ? { compareParity: (plan, document, sceneCanonicalIds, frame) => {
        const probeStartedAt = drawingMonotonicNow();
        const legacyPrimitives = renderer.snapshot();
        const legacy = captureLegacyDrawingParityProbe(legacyPrimitives, {
          widthCssPx: plan.stamp.widthCssPx,
          heightCssPx: plan.stamp.heightCssPx,
        });
        drawingPerfCounters.setGauge(
          "shadowLegacyProbeMs",
          Math.max(0, drawingMonotonicNow() - probeStartedAt),
        );
        if (legacy.skippedCount > 0) {
          drawingPerfCounters.incrementCounter("shadowSkippedCount", legacy.skippedCount);
        }
        if (legacy.errorCount > 0) {
          drawingPerfCounters.incrementCounter("shadowErrorCount", legacy.errorCount);
        }
        // Layout capture reads the last coherent legacy paint. During the
        // short window between a document/frame publication and the next
        // paint, pixel-sized primitives may not have a usable painted box.
        // Treat that sample as unavailable instead of manufacturing strict
        // visible-set/missing-probe mismatches from a partial registry. A
        // hit-only skip remains comparable for layout and serialization.
        if (legacy.legacyLayouts.length !== legacyPrimitives.length
          || legacy.serializedDrawings.length !== legacyPrimitives.length) {
          return null;
        }
        const gapStartedAt = drawingMonotonicNow();
        const sceneCanonicalGapIndexes = projectDrawingSceneCanonicalGapIndexes({
          adapter,
          document,
          plan,
          frame,
        });
        drawingPerfCounters.setGauge(
          "shadowGapProjectionMs",
          Math.max(0, drawingMonotonicNow() - gapStartedAt),
        );
        if (!sceneCanonicalGapIndexes || !adapter.isDrawingFrameCurrent(frame)) {
          return null;
        }
        const compareStartedAt = drawingMonotonicNow();
        const result = compareDrawingShadowParity({
          document,
          plan,
          sceneCanonicalIds,
          legacySerializedDrawings: legacy.serializedDrawings,
          legacyLayouts: legacy.legacyLayouts,
          hitProbes: legacy.hitProbes,
          sceneCanonicalGapIndexes,
        });
        drawingPerfCounters.setGauge(
          "shadowParityCompareMs",
          Math.max(0, drawingMonotonicNow() - compareStartedAt),
        );
        return result;
      } } : {}),
    });
  }, [activeOverlayEntityIdRef, authorityMode, dynamicOverlayEnabled, engineMode.effective, hiddenRef, sceneAdapterGetterDelegate, sceneBridge, sceneRuntime, selectedIdRef]);

  const commitPrimitiveDraft = useCallback((
    scopeKey: string,
    store: DrawingDocumentStore,
    primitives: readonly DrawingPrimitive[],
    options: Readonly<{
      adoptRenderer?: boolean;
      commands?: readonly DrawingCommand[];
      restoreOnFailure?: boolean;
    }> = {},
  ): boolean => {
    const adoptRenderer = options.adoptRenderer !== false;
    const restoreOnFailure = options.restoreOnFailure !== false;
    const renderer = rendererRef.current;
    if (!renderer) return false;
    if (sceneDocumentOnlyEnabled) {
      if (primitives.length > 0) {
        console.warn("Document-only scene rejected a legacy primitive mutation candidate");
        return false;
      }
      const current = store.getSnapshot();
      if (!scopeKey || current.scopeKey !== scopeKey) return false;
      const dispatched = options.commands && options.commands.length > 0
        ? store.dispatchMany(options.commands)
        : Object.freeze({ ok: true as const, changed: false, document: current });
      if (!dispatched.ok) {
        console.warn("Failed to commit drawing document:", dispatched.error);
        return false;
      }
      const synchronized = !adoptRenderer
        ? renderer.documentSnapshot() === dispatched.document
        : renderer.reconcile(dispatched.document);
      if (!adoptRenderer && !synchronized) {
        console.warn("Document-only lifecycle barrier observed a stale scene registry");
        scopeReadyRef.current = false;
        return false;
      }
      if (adoptRenderer && (!synchronized
        || renderer.documentSnapshot() !== dispatched.document
        || renderer.snapshot().length !== 0
        || renderer.attachedCount() !== 0)) {
        console.warn("Document-only scene registry violated its zero-primitive synchronization invariant");
        scopeReadyRef.current = false;
        return false;
      }
      primitivesRef.current = [];
      if (dispatched.changed || store.dirty) {
        if (!drawingPersistenceCoordinator.schedule(store)) {
          console.warn("Failed to schedule drawing document persistence; the in-memory document remains dirty");
        }
      }
      if (adoptRenderer && renderer.documentSnapshot() === store.getSnapshot()) {
        const activated = activateDrawingScene(store, renderer);
        if (!activated) {
          scopeReadyRef.current = false;
          console.warn("Drawing scene could not reactivate after a document-only mutation");
        }
      }
      return true;
    }
    configureLegacyViewportBatching(primitives, sceneCanaryEnabledRef.current);
    const hasCommands = options.commands !== undefined;
    // Register only delta objects relative to the renderer registry before
    // validation. Terminal commands own their normal candidates; an empty
    // lifecycle barrier can also recover a candidate retained after an
    // exceptional controller callback failed before reaching this hook.
    renderer.stageAttached(persistentLegacyPrimitives(primitives));
    const result = commitLegacyPrimitiveCommands(
      store,
      scopeKey,
      primitives,
      options.commands ?? [],
      // A terminal command stages the exact externally-mutated candidate so
      // failure recovery owns every surface credential. Lifecycle barriers
      // pass an empty command batch and only validate the tracked projection;
      // they can never synthesize a document mutation from primitives.
      hasCommands
        ? (document, candidates) => renderer.adoptAttached(document, candidates)
        : (document, candidates) => renderer.canAdopt(document, candidates),
    );
    if (!result.ok) {
      console.warn("Failed to commit drawing document:", result.error);
      if (restoreOnFailure) {
        if (renderer.restoreDocument(store.getSnapshot())) {
          primitivesRef.current = [...renderer.snapshot()];
        } else {
          console.warn("Failed to restore the canonical drawing document after draft rejection");
        }
      }
      return false;
    }
    if (adoptRenderer) {
      const adopted = hasCommands
        ? renderer.adoptAttached(result.document, result.primitives)
        : renderer.adopt(result.document, result.primitives);
      if (!adopted) {
        if (!renderer.restoreDocument(result.document)) {
          console.warn("Failed to adopt or restore the committed drawing document; persistence was skipped");
          return false;
        }
        primitivesRef.current = [...renderer.snapshot()];
      }
    }
    if (result.changed || store.dirty) {
      if (!drawingPersistenceCoordinator.schedule(store)) {
        console.warn("Failed to schedule drawing document persistence; the in-memory document remains dirty");
      }
    }
    if (adoptRenderer && renderer.documentSnapshot() === store.getSnapshot()) {
      const activated = activateDrawingScene(store, renderer);
      if (!activated && engineMode.effective === "scene-canary"
        && sceneCanaryEnabledRef.current) {
        scopeReadyRef.current = false;
        console.warn("Drawing scene could not reactivate after a canonical mutation; the last plan was retained");
      }
    }
    return true;
  }, [activateDrawingScene, engineMode.effective, primitivesRef, sceneDocumentOnlyEnabled]);

  const requestScopeRetry = useCallback((): void => {
    if (engineMode.effective === "scene-canary" && sceneCanaryEnabledRef.current) {
      const runtimeSnapshot = sceneRuntime.snapshot();
      const bridgeSnapshot = sceneBridge.snapshot();
      const publicationState = {
        attachedSurfaceGeneration: bridgeSnapshot.surfaceGeneration,
        publishedSurfaceGeneration: runtimeSnapshot.plan?.stamp.surfaceGeneration ?? null,
        requestedScope: requestedScopeRef.current,
        runtimeActive: runtimeSnapshot.active,
        runtimePublicationReady: runtimeSnapshot.publicationReady,
        runtimeScope: runtimeSnapshot.scopeKey,
        sceneCanaryEnabled: true,
      } satisfies DrawingVisibleScenePublicationState;
      if (runtimeSnapshot.plan === null && runtimeSnapshot.active) {
        // The initial frame is already scheduled. Coalesce the rejected user
        // action into that runtime instead of re-running the React effect,
        // whose teardown would merely restart the same first-publish wait.
        if (sceneRuntime.invalidate("mutation-before-first-publish")) return;
      } else if (canRecoverDrawingVisibleSceneInPlace({
        ...publicationState,
        mutationStarted: mutationStartedRef.current,
      })) {
        const renderer = rendererRef.current;
        if (renderer && activateDrawingScene(activeStoreRef.current, renderer)) return;
        // Fall through to the effect retry. Its recovery guard preserves the
        // accepted plan for this exact scope/surface while it reconciles.
      }
    }
    setScopeRetryGeneration((generation) => (
      generation >= Number.MAX_SAFE_INTEGER ? 0 : generation + 1
    ));
  }, [activateDrawingScene, engineMode.effective, sceneBridge, sceneRuntime]);

  const invalidateVisibleScene = useCallback((): boolean => {
    if (authorityMode !== "document"
      || engineMode.effective !== "scene-canary"
      || !sceneCanaryEnabledRef.current) return false;
    let adapterInvalidated = false;
    const adapter = sceneAdapterGetterDelegate.read()();
    if (adapter?.notifyDrawingFrameInvalidation) {
      try {
        adapter.notifyDrawingFrameInvalidation();
        adapterInvalidated = true;
      } catch {
        // The runtime invalidation below remains the fail-closed fallback.
      }
    }
    return sceneRuntime.invalidate("interaction-overlay") || adapterInvalidated;
  }, [authorityMode, engineMode.effective, sceneAdapterGetterDelegate, sceneRuntime]);

  const synchronizeVisibleSceneVisibility = useCallback((
    hidden: boolean,
    options: DrawingSceneHiddenTransitionOptions = {},
  ): boolean => {
    if (authorityMode !== "document"
      || engineMode.effective !== "scene-canary"
      || !sceneCanaryEnabledRef.current) return false;
    hiddenRef.current = hidden;
    if (hidden) {
      return transitionDrawingSceneToHidden(
        sceneRuntime,
        (requestUpdate) => sceneBridge.clearPlan(requestUpdate),
        options,
      );
    }
    const renderer = rendererRef.current;
    const store = activeStoreRef.current;
    if (!renderer
      || renderer.documentSnapshot() !== store.getSnapshot()
      || !activateDrawingScene(store, renderer)) {
      scopeReadyRef.current = false;
      requestScopeRetry();
      return false;
    }
    return true;
  }, [activateDrawingScene, authorityMode, engineMode.effective, hiddenRef, requestScopeRetry, sceneBridge, sceneRuntime]);

  const subscribeVisibleScenePaint = useCallback((
    listener: (stamp: DrawingCommittedPaintTicket) => void,
    { replayLastPaint = true }: Readonly<{ replayLastPaint?: boolean }> = {},
  ): (() => void) => {
    if (typeof listener !== "function") return () => {};
    const unsubscribe = sceneBridge.subscribePainted((ack) => listener(ack.stamp));
    const lastPaintedStamp = sceneBridge.snapshot().lastPaintedStamp;
    if (replayLastPaint && lastPaintedStamp) listener(lastPaintedStamp);
    return unsubscribe;
  }, [sceneBridge]);

  const prepareUserMutationScope = useCallback((): boolean => {
    const adapter = adapterGetterRef.current();
    const activeScope = authorityMode === "document"
      ? activeStoreRef.current.getSnapshot().scopeKey
      : symbolRef.current;
    const runtimeSnapshot = sceneRuntime.snapshot();
    const bridgeSnapshot = sceneBridge.snapshot();
    const scenePublicationReady = isDrawingVisibleScenePublicationReady({
      attachedSurfaceGeneration: bridgeSnapshot.surfaceGeneration,
      publishedSurfaceGeneration: runtimeSnapshot.plan?.stamp.surfaceGeneration ?? null,
      requestedScope: requestedScopeRef.current,
      runtimeActive: runtimeSnapshot.active,
      runtimePublicationReady: runtimeSnapshot.publicationReady,
      runtimeScope: runtimeSnapshot.scopeKey,
      sceneCanaryEnabled: engineMode.effective === "scene-canary"
        && sceneCanaryEnabledRef.current,
    });
    const prepared = prepareDrawingMutationScope({
      activeScope,
      hasSeries: adapter?.hasSeries?.() === true,
      previousScope: prevSymbolRef.current,
      ready: scopeReadyRef.current && scenePublicationReady,
      requestedScope: requestedScopeRef.current,
      surfaceScope: symbolRef.current,
    }, requestScopeRetry);
    // Close the fallback latch before a controller can mutate a detached
    // interaction proxy. This is intentionally conservative for selection and
    // visibility actions: after the first accepted user action, runtime faults
    // retain the last valid scene instead of bulk-attaching legacy owners.
    if (prepared && engineMode.effective === "scene-canary"
      && sceneCanaryEnabledRef.current) mutationStartedRef.current = true;
    return prepared;
  }, [authorityMode, engineMode.effective, prevSymbolRef, requestScopeRetry, sceneBridge, sceneRuntime, symbolRef]);

  // Scope transitions must be able to finish the old gesture against the old
  // store even after React has requested a new symbol. This path is private to
  // the transition barrier; normal user mutations always use persistDrawings.
  const persistActiveScopeDrawings = useCallback((commands: readonly DrawingCommand[]): boolean => {
    if (authorityMode === "legacy") {
      try {
        persistAndMeasure(symbolRef.current, primitivesRef.current);
        return true;
      } catch (error) {
        console.warn("Legacy drawing persistence threw", error);
        return false;
      }
    }
    const store = activeStoreRef.current;
    if (commands.length > 0) mutationStartedRef.current = true;
    return commitPrimitiveDraft(
      store.getSnapshot().scopeKey,
      store,
      primitivesRef.current,
      { commands },
    );
  }, [authorityMode, commitPrimitiveDraft, primitivesRef, symbolRef]);

  const persistDrawings = useCallback((commands: readonly DrawingCommand[]): boolean => {
    if (!prepareUserMutationScope()) return false;
    return persistActiveScopeDrawings(commands);
  }, [persistActiveScopeDrawings, prepareUserMutationScope]);

  const persistDetachedDrawings = useCallback((
    commands: readonly DrawingCommand[],
    candidatePrimitives: readonly DrawingPrimitive[] = primitivesRef.current,
  ): DrawingDetachedCommitReceipt | null => {
    if (!dynamicOverlayEnabled
      || authorityMode !== "document"
      || !prepareUserMutationScope()) return null;
    const renderer = rendererRef.current;
    if (!renderer || commands.length === 0) return null;
    const store = activeStoreRef.current;
    if (sceneDocumentOnlyEnabled) {
      if (candidatePrimitives.length > 0) {
        console.warn("Document-only scene rejected detached legacy primitive candidates");
        return null;
      }
      const previousDocument = store.getSnapshot();
      mutationStartedRef.current = true;
      if (!commitPrimitiveDraft(previousDocument.scopeKey, store, [], { commands })) return null;
      const document = store.getSnapshot();
      const evidence = drawingLegacyPrimitiveRuntimeEvidence(true, renderer, primitivesRef.current);
      if (!evidence.zeroLegacyPrimitiveInvariant) {
        scopeReadyRef.current = false;
        return Object.freeze({
          committed: true,
          changed: document !== previousDocument,
          surfaceSynchronized: false,
          ticket: null,
        });
      }
      if (activeOverlayEntityIdRef?.current) {
        return Object.freeze({
          committed: true,
          changed: document !== previousDocument,
          surfaceSynchronized: true,
          ticket: null,
        });
      }
      const adapter = sceneAdapterGetterDelegate.read()();
      const frame = adapter?.captureDrawingFrame?.() ?? null;
      const ticket = frame && adapter?.isDrawingFrameCurrent?.(frame) === true
        ? createDrawingCommittedPaintTicket(
            document,
            frame,
            sceneBridge.snapshot().surfaceGeneration,
          )
        : null;
      return Object.freeze({
        committed: true,
        changed: document !== previousDocument,
        surfaceSynchronized: true,
        ticket,
      });
    }
    const persistentCandidates = persistentLegacyPrimitives(candidatePrimitives);
    configureLegacyViewportBatching(persistentCandidates, true);
    mutationStartedRef.current = true;

    const committed = commitDetachedDrawingCommands({
      commands,
      primitives: persistentCandidates,
      renderer,
      scopeKey: store.getSnapshot().scopeKey,
      store,
    });
    if (!committed) {
      console.warn("Failed to commit detached drawing candidates");
      return null;
    }

    if (committed.changed || store.dirty) {
      if (!drawingPersistenceCoordinator.schedule(store)) {
        console.warn("Failed to schedule detached drawing persistence; the in-memory document remains authoritative");
      }
    }

    if (committed.rendererAdopted) {
      primitivesRef.current = [...renderer.snapshot()];
    }
    if (!committed.rendererAdopted || !committed.surfaceSynchronized) {
      scopeReadyRef.current = false;
      requestScopeRetry();
      return Object.freeze({
        committed: true,
        changed: committed.changed,
        surfaceSynchronized: false,
        ticket: null,
      });
    }

    if (engineMode.effective === "scene-canary" && sceneCanaryEnabledRef.current) {
      // The active runtime already subscribed to this authoritative store;
      // dispatch scheduled its document invalidation before renderer adoption.
      // Re-activating the identical binding on every mouseup would tear down
      // and reinstall subscriptions in the synchronous interaction budget.
      const runtimeSnapshot = sceneRuntime.snapshot();
      const activated = runtimeSnapshot.active
        && runtimeSnapshot.scopeKey === committed.document.scopeKey
        ? true
        : activateDrawingScene(store, renderer);
      if (!activated) {
        scopeReadyRef.current = false;
        requestScopeRetry();
        return Object.freeze({
          committed: true,
          changed: committed.changed,
          surfaceSynchronized: true,
          ticket: null,
        });
      }
    }
    if (activeOverlayEntityIdRef?.current) {
      return Object.freeze({
        committed: true,
        changed: committed.changed,
        surfaceSynchronized: true,
        ticket: null,
      });
    }

    const adapter = sceneAdapterGetterDelegate.read()();
    const frame = adapter?.captureDrawingFrame?.() ?? null;
    if (!frame || adapter?.isDrawingFrameCurrent?.(frame) !== true) {
      return Object.freeze({
        committed: true,
        changed: committed.changed,
        surfaceSynchronized: true,
        ticket: null,
      });
    }
    const ticket = createDrawingCommittedPaintTicket(
      committed.document,
      frame,
      engineMode.effective === "scene-canary" && sceneCanaryEnabledRef.current
        ? sceneBridge.snapshot().surfaceGeneration
        : frame.surfaceGeneration,
    );
    return Object.freeze({
      committed: true,
      changed: committed.changed,
      surfaceSynchronized: true,
      ticket,
    });
  }, [
    activeOverlayEntityIdRef,
    activateDrawingScene,
    authorityMode,
    commitPrimitiveDraft,
    dynamicOverlayEnabled,
    engineMode.effective,
    prepareUserMutationScope,
    primitivesRef,
    requestScopeRetry,
    sceneAdapterGetterDelegate,
    sceneBridge,
    sceneDocumentOnlyEnabled,
    sceneRuntime,
  ]);

  const persistSceneCommands = useCallback((
    commands: readonly DrawingCommand[],
  ): DrawingDetachedCommitReceipt | null => {
    if (!dynamicOverlayEnabled
      || authorityMode !== "document"
      || commands.length === 0
      || !prepareUserMutationScope()) return null;
    if (sceneDocumentOnlyEnabled && primitivesRef.current.length > 0) {
      console.warn("Document-only scene command was blocked by retained legacy primitive instances");
      scopeReadyRef.current = false;
      return null;
    }
    const store = activeStoreRef.current;
    mutationStartedRef.current = true;
    const result = store.dispatchMany(commands);
    if (!result.ok) {
      console.warn("Failed to commit drawing scene commands:", result.error);
      return null;
    }
    const renderer = rendererRef.current;
    let compatibilitySynchronized = true;
    if (renderer) {
      compatibilitySynchronized = renderer.reconcile(result.document);
      if (compatibilitySynchronized) primitivesRef.current = [...renderer.snapshot()];
      else console.warn("Drawing scene committed while the rollback renderer remained stale");
    }
    if (sceneDocumentOnlyEnabled) {
      const evidence = drawingLegacyPrimitiveRuntimeEvidence(
        true,
        renderer,
        primitivesRef.current,
      );
      compatibilitySynchronized = compatibilitySynchronized
        && evidence.zeroLegacyPrimitiveInvariant;
      if (!compatibilitySynchronized) {
        scopeReadyRef.current = false;
        console.warn("Drawing scene committed while the document-only registry invariant was not synchronized");
      }
    }
    if (result.changed || store.dirty) {
      if (!drawingPersistenceCoordinator.schedule(store)) {
        console.warn("Failed to schedule scene drawing persistence; the in-memory document remains authoritative");
      }
    }
    if (engineMode.effective === "scene-canary" && sceneCanaryEnabledRef.current) {
      const runtimeSnapshot = sceneRuntime.snapshot();
      const activated = compatibilitySynchronized && (runtimeSnapshot.active
        && runtimeSnapshot.scopeKey === result.document.scopeKey
        ? true
        : renderer ? activateDrawingScene(store, renderer) : false);
      if (!activated) {
        scopeReadyRef.current = false;
        requestScopeRetry();
        return Object.freeze({
          committed: true,
          changed: result.changed,
          surfaceSynchronized: false,
          ticket: null,
        });
      }
    }
    if (activeOverlayEntityIdRef?.current) {
      return Object.freeze({
        committed: true,
        changed: result.changed,
        surfaceSynchronized: compatibilitySynchronized,
        ticket: null,
      });
    }
    const adapter = sceneAdapterGetterDelegate.read()();
    const frame = adapter?.captureDrawingFrame?.() ?? null;
    const ticket = frame && adapter?.isDrawingFrameCurrent?.(frame) === true
      ? createDrawingCommittedPaintTicket(
          result.document,
          frame,
          engineMode.effective === "scene-canary" && sceneCanaryEnabledRef.current
            ? sceneBridge.snapshot().surfaceGeneration
            : frame.surfaceGeneration,
        )
      : null;
    return Object.freeze({
      committed: true,
      changed: result.changed,
      surfaceSynchronized: compatibilitySynchronized,
      ticket,
    });
  }, [
    activeOverlayEntityIdRef,
    activateDrawingScene,
    authorityMode,
    dynamicOverlayEnabled,
    engineMode.effective,
    prepareUserMutationScope,
    primitivesRef,
    requestScopeRetry,
    sceneAdapterGetterDelegate,
    sceneBridge,
    sceneDocumentOnlyEnabled,
    sceneRuntime,
  ]);

  const clearDrawings = useCallback((): boolean => {
    // This check happens before any canonical primitive is detached. In a
    // failed A -> B transition it prevents a B-side clear action from clearing
    // the still-active A document and schedules the transition effect to retry.
    if (!prepareUserMutationScope()) return false;
    if (authorityMode === "legacy") {
      persistAndMeasure(symbolRef.current, []);
      const adapter = getChartAdapter();
      for (const primitive of primitivesRef.current) {
        try {
          adapter?.detachPrimitive?.(primitive);
        } catch {
          // Legacy rollback retains its historical best-effort clear behavior.
        }
      }
      return true;
    }
    const renderer = rendererRef.current;
    const store = activeStoreRef.current;
    if (!renderer) return false;
    mutationStartedRef.current = true;
    if (engineMode.effective === "scene-canary" && sceneCanaryEnabledRef.current) {
      // Clear pixels, hit geometry, scheduled frames and worker ownership
      // before mutating persistence. A failed clear therefore remains blank
      // and closed instead of letting stale geometry survive.
      sceneRuntime.suspend();
      sceneBridge.clearPlan(false);
    }
    if (sceneDocumentOnlyEnabled) {
      if (primitivesRef.current.length > 0) {
        scopeReadyRef.current = false;
        console.warn("Document-only clear was blocked by retained legacy primitive instances");
        return false;
      }
      return commitPrimitiveDraft(store.getSnapshot().scopeKey, store, [], {
        commands: [Object.freeze({ type: "clear" })],
      });
    }
    const currentPrimitives = persistentLegacyPrimitives(primitivesRef.current);
    if (!renderer.canAdopt(store.getSnapshot(), currentPrimitives)
      || !renderer.adopt(store.getSnapshot(), currentPrimitives)) {
      console.warn("Failed to stage drawing clear against the current renderer registry");
      return false;
    }
    if (!renderer.detachSurface()) {
      renderer.rebindSurface();
      console.warn("Failed to detach every drawing before clear; the document was not changed");
      return false;
    }
    if (!commitPrimitiveDraft(store.getSnapshot().scopeKey, store, [], {
      commands: [Object.freeze({ type: "clear" })],
    })) return false;
    return true;
  }, [authorityMode, commitPrimitiveDraft, engineMode.effective, getChartAdapter, prepareUserMutationScope, primitivesRef, sceneBridge, sceneDocumentOnlyEnabled, sceneRuntime, symbolRef]);

  const prepareSurfaceDispose = useCallback((): boolean => {
    scopeReadyRef.current = false;
    if (!beforeScopeTransitionRef.current()) {
      scopeReadyRef.current = true;
      return false;
    }
    if (authorityMode === "legacy") {
      persistAndMeasure(symbolRef.current, primitivesRef.current);
      const adapter = getChartAdapter();
      let detached = true;
      for (const primitive of primitivesRef.current) {
        try {
          if (adapter?.detachPrimitive?.(primitive) === false) detached = false;
        } catch {
          detached = false;
        }
      }
      if (detached) sceneRuntime.suspend();
      else scopeReadyRef.current = true;
      return detached;
    }

    const renderer = rendererRef.current;
    const store = activeStoreRef.current;
    if (!renderer) return false;
    const committed = commitPrimitiveDraft(
      store.getSnapshot().scopeKey,
      store,
      primitivesRef.current,
      { adoptRenderer: !sceneDocumentOnlyEnabled },
    );
    if (!committed) {
      scopeReadyRef.current = true;
      return false;
    }
    if (store.dirty) {
      void drawingPersistenceCoordinator.flush(store.getSnapshot().scopeKey).then((result) => {
        if (!result.ok) console.warn("Failed to flush drawings before surface disposal", result.error);
      });
    }
    // Retire the public plan and dispose the worker before any chart/series
    // credential can become invalid. This also makes a failed detach blank and
    // fail-closed instead of accepting a late worker publication.
    sceneRuntime.suspend();
    sceneBridge.clearPlan(false);
    const detached = renderer.detachSurface();
    if (!detached) {
      renderer.rebindSurface();
      scopeReadyRef.current = true;
      return false;
    }
    if (!sceneBridge.detach()) {
      renderer.rebindSurface();
      scopeReadyRef.current = true;
      return false;
    }
    return true;
  }, [authorityMode, beforeScopeTransitionRef, commitPrimitiveDraft, getChartAdapter, primitivesRef, sceneBridge, sceneDocumentOnlyEnabled, sceneRuntime, symbolRef]);

  const completeSurfaceDispose = useCallback((): void => {
    scopeReadyRef.current = false;
    sceneRuntime.suspend();
    sceneBridge.clearPlan(false);
    sceneBridge.releaseSurfaceCredentials();
    if (authorityMode === "document") {
      // chart.remove() invalidates even credentials whose explicit detach
      // failed. Forget them only after the surface owner confirms removal so
      // the next series rebuild attaches the canonical registry exactly once.
      const renderer = rendererRef.current;
      renderer?.releaseSurfaceCredentials();
      if (!sceneDocumentOnlyEnabled) {
        const scopeKey = activeStoreRef.current.getSnapshot().scopeKey;
        renderer?.adopt(createEmptyDrawingDocument(scopeKey), []);
      }
      primitivesRef.current = [];
    }
  }, [authorityMode, primitivesRef, sceneBridge, sceneDocumentOnlyEnabled, sceneRuntime]);

  const invalidateSurfaceCredentialsForSeriesReplacement = useCallback((): void => {
    // removeSeries() invalidates primitive-owned series bindings without
    // removing the chart itself. Preserve document and primitive registries,
    // but forget every old-series credential so the generation effect must
    // attach each canonical primitive to the replacement series.
    scopeReadyRef.current = false;
    sceneRuntime.suspend();
    sceneBridge.clearPlan(false);
    sceneBridge.releaseSurfaceCredentials();
    try {
      rendererRef.current?.releaseSurfaceCredentials();
    } catch {
      // This imperative invalidation boundary is deliberately no-throw.
    }
  }, [sceneBridge, sceneRuntime]);

  useEffect(() => registerDrawingPerfRuntimeSummaryProvider(() => {
    const bridgeSnapshot = sceneBridge.snapshot();
    const runtimeSnapshot = sceneRuntime.snapshot();
    const effectiveEngineMode = engineMode.effective === "scene-canary"
      && !sceneCanaryEnabledRef.current
      ? "legacy"
      : engineMode.effective;
    const adapter = sceneAdapterGetterDelegate.read()();
    const plotRect = adapter?.getMainPanePlotRect?.() ?? null;
    const legacyPrimitiveEvidence = drawingLegacyPrimitiveRuntimeEvidence(
      sceneDocumentOnlyEnabled,
      rendererRef.current,
      primitivesRef.current,
    );
    const attachedPrimitiveCount = Math.max(
      rendererRef.current?.attachedCount() ?? 0,
      legacyPrimitiveEvidence.legacyPrimitiveAttachedCount,
    ) + bridgeSnapshot.attachedPrimitiveCount;
    const runtimeSummary = sceneDocumentOnlyEnabled
      ? summarizeDrawingRuntimeDocument(
          activeStoreRef.current.getSnapshot(),
          attachedPrimitiveCount,
        )
      : summarizeDrawingRuntimePrimitives(
          primitivesRef.current,
          attachedPrimitiveCount,
        );
    return {
      ...runtimeSummary,
      effectiveEngineMode,
      scenePublicationReady: effectiveEngineMode === "scene-canary"
        && isDrawingVisibleScenePublicationReady({
          attachedSurfaceGeneration: bridgeSnapshot.surfaceGeneration,
          publishedSurfaceGeneration: runtimeSnapshot.plan?.stamp.surfaceGeneration ?? null,
          requestedScope: requestedScopeRef.current,
          runtimeActive: runtimeSnapshot.active,
          runtimePublicationReady: runtimeSnapshot.publicationReady,
          runtimeScope: runtimeSnapshot.scopeKey,
          sceneCanaryEnabled: sceneCanaryEnabledRef.current,
        }),
      ...(plotRect ? { mainPanePlotRect: plotRect } : {}),
    };
  }), [engineMode.effective, primitivesRef, sceneAdapterGetterDelegate, sceneBridge, sceneDocumentOnlyEnabled, sceneRuntime]);

  useEffect(() => registerDrawingPerfPhase6RuntimeProvider(() => {
    const bridgeSnapshot = sceneBridge.snapshot();
    const runtimeSnapshot = sceneRuntime.snapshot();
    const perf = drawingPerfCounters.snapshot();
    const activePersistenceSnapshot = drawingPersistenceCoordinator.snapshot(
      activeStoreRef.current.getSnapshot().scopeKey,
    );
    const activePersistenceRestoreSource = persistenceRestoreSourceRef.current.scopeKey
      === activeStoreRef.current.getSnapshot().scopeKey
      ? persistenceRestoreSourceRef.current.source
      : null;
    const worker = runtimeSnapshot.worker;
    const sceneAdapter = sceneAdapterGetterDelegate.read()();
    const lineageStats = sceneAdapter?.readDrawingFrameSourceLineageStats?.() ?? null;
    const cache = sceneAdapter ? readDrawingSceneProjectorCacheSnapshot(sceneAdapter) : null;
    const planStamp = runtimeSnapshot.plan?.stamp ?? null;
    const paintedStamp = runtimeSnapshot.lastPaintedStamp;
    const currentPlanPainted = !!planStamp
      && !!paintedStamp
      && !!bridgeSnapshot.lastPaintedStamp
      && sameDrawingWorkerStamp(planStamp, paintedStamp)
      && sameDrawingWorkerStamp(planStamp, bridgeSnapshot.lastPaintedStamp);
    // Freshness is a visible-scene invariant, including plans whose entities
    // do not require a worker raster. Worker-specific job/result evidence is
    // reported separately; the requested stamp here is always the current
    // accepted plan that the bridge must acknowledge after paint.
    const requestedStamp = planStamp;
    // A worker publication is evidence only after DrawingSceneRenderer has
    // consumed the bitmap and the generation-safe bridge acknowledged that
    // exact plan. Runtime acceptance alone is too early for a raster gate.
    const publishedStamp = currentPlanPainted ? paintedStamp : null;
    const paintReceipt = currentPlanPainted
      && runtimeSnapshot.paintReceipt
      && sameDrawingWorkerStamp(runtimeSnapshot.paintReceipt.stamp, paintedStamp)
      ? runtimeSnapshot.paintReceipt
      : null;
    const snapshotWorkerIdentity = (
      identity: typeof runtimeSnapshot.latestSubmittedWorkerIdentity,
    ) => identity ? Object.freeze({
      schemaVersion: identity.schemaVersion,
      jobId: identity.jobId,
      generation: identity.generation,
      stamp: Object.freeze({ ...identity.stamp }),
    }) : null;
    const rawPoints = runtimeSnapshot.rawPointCount;
    const renderedPoints = runtimeSnapshot.renderedPointCount;
    const canonicalRawPoints = Array.from(
      activeStoreRef.current.getSnapshot().entities.values(),
    ).reduce((count, entity) => {
      const geometry = entity.geometry;
      return geometry.kind === "freehand" || geometry.kind === "highlighter"
        ? count + (geometry.stroke?.points.length ?? geometry.dataPoints?.length ?? 0)
        : count;
    }, 0);
    const currentPlan = runtimeSnapshot.plan;
    const vertexBudgetPassed = currentPlan?.entities.every((entity) => (
      entity.kind !== "freehand" && entity.kind !== "highlighter"
        ? true
        : Math.max(0, entity.pointCount - entity.pathBreakCount)
          <= Math.floor(currentPlan.stamp.widthCssPx * 3)
    )) ?? true;
    return Object.freeze({
      engineMode: engineMode.effective,
      scenePublicationReady: runtimeSnapshot.publicationReady,
      attachedPrimitiveCount: (rendererRef.current?.attachedCount() ?? 0)
        + bridgeSnapshot.attachedPrimitiveCount,
      backend: runtimeSnapshot.rasterBackend,
      backendSource: rasterBackend.source,
      workerResultDelayMs: runtimeSnapshot.workerResultDeliveryDelayMs,
      workerAvailability: worker?.availability ?? null,
      workerUnavailableReason: worker?.unavailableReason ?? null,
      sourceLineageExactResolveCount: lineageStats?.exactProjectionCount ?? 0,
      sourceLineageFallbackResolveCount: lineageStats?.fallbackProjectionCount ?? 0,
      sourceLineageUnresolvedResolveCount: lineageStats?.unresolvedProjectionCount ?? 0,
      offscreenSupported: runtimeSnapshot.offscreenSupported,
      queueDepthMax: perf.gaugeMaxima.workerQueue,
      inFlightMax: perf.gaugeMaxima.workerInFlight,
      queueDepthCurrent: worker?.queueDepth ?? 0,
      inFlightCurrent: worker?.inFlight ?? 0,
      workerJobDelta: worker?.submittedCount ?? 0,
      workerResultDelta: worker?.resultCount ?? 0,
      pendingDropDelta: worker?.queueDropCount ?? 0,
      staleResultDropDelta: worker?.staleResultCount ?? 0,
      stalePublishCount: runtimeSnapshot.staleWorkerPublishCount,
      sceneFallbackCount: sceneFallbackCountRef.current,
      sceneRuntimeFaultCount: sceneFallbackCountRef.current,
      legacyFallbackSucceededCount: legacyFallbackSucceededCountRef.current,
      sceneFallbackLastReason: sceneFallbackLastReasonRef.current,
      persistence: activePersistenceSnapshot ? Object.freeze({ ...activePersistenceSnapshot }) : null,
      persistenceRestoreSource: activePersistenceRestoreSource,
      persistenceAttemptCount: perf.counters.persistenceAttemptCount,
      persistenceFailureCount: perf.counters.persistenceFailureCount,
      persistenceQuotaFailureCount: perf.counters.persistenceQuotaFailureCount,
      persistenceOtherFailureCount: perf.counters.persistenceOtherFailureCount,
      rawPoints,
      renderedPoints,
      lodRatio: rawPoints > 0 ? Math.min(1, renderedPoints / rawPoints) : 0,
      canonicalRawPreserved: rawPoints === canonicalRawPoints,
      vertexBudgetPassed,
      cacheBytes: cache?.totalBytes ?? 0,
      cacheBytesMax: Math.max(cache?.totalBytes ?? 0, perf.gaugeMaxima.cacheBytes),
      cacheBudgetBytes: cache?.budgetBytes ?? 0,
      cacheHardLimitBytes: cache?.hardLimitBytes ?? 0,
      cacheEntryCount: cache?.entryCount ?? 0,
      cacheBudgetEvictionCount: cache?.budgetEvictionCount ?? 0,
      cacheEntryBytes: cache?.entryBytes ?? 0,
      cacheEntryBudgetBytes: cache?.entryBudgetBytes ?? 0,
      cacheMetadataBytes: cache?.metadataBytes ?? 0,
      cacheMetadataBudgetBytes: cache?.metadataBudgetBytes ?? 0,
      cacheRecentHierarchyKeyCount: cache?.recentHierarchyKeyCount ?? 0,
      cacheRecentHierarchyKeysPerRequestLimit:
        cache?.recentHierarchyKeysPerRequestLimit ?? 0,
      cacheRecentRequestCount: cache?.recentRequestCount ?? 0,
      cacheRecentRequestLimit: cache?.recentRequestLimit ?? 0,
      exactRenderMs: runtimeSnapshot.lastExactSettleMs,
      lastRequestedStamp: requestedStamp ? Object.freeze({ ...requestedStamp }) : null,
      lastPublishedStamp: publishedStamp ? Object.freeze({ ...publishedStamp }) : null,
      lastPaintedStamp: currentPlanPainted ? Object.freeze({ ...paintedStamp }) : null,
      paintReceipt: paintReceipt ? Object.freeze({
        kind: paintReceipt.kind,
        observedAt: paintReceipt.observedAt,
        stamp: Object.freeze({ ...paintReceipt.stamp }),
        attachmentRevision: paintReceipt.attachmentRevision,
        paintSequence: paintReceipt.paintSequence,
      }) : null,
      submittedWorkerHeaders: Object.freeze(runtimeSnapshot.submittedWorkerHeaders.map(
        (identity) => snapshotWorkerIdentity(identity)!,
      )),
      returnedWorkerIdentity: snapshotWorkerIdentity(runtimeSnapshot.returnedWorkerIdentity),
      acceptedWorkerIdentity: snapshotWorkerIdentity(runtimeSnapshot.acceptedWorkerIdentity),
      publishedWorkerIdentity: snapshotWorkerIdentity(runtimeSnapshot.publishedWorkerIdentity),
      latestSubmittedWorkerIdentity: snapshotWorkerIdentity(
        runtimeSnapshot.latestSubmittedWorkerIdentity,
      ),
    });
  }), [
    engineMode.effective,
    rasterBackend,
    sceneAdapterGetterDelegate,
    sceneBridge,
    sceneRuntime,
  ]);

  useEffect(() => registerDrawingPerfActivePersistenceDocumentRecordProvider(() => (
    encodeDrawingDocumentRecord(activeStoreRef.current.getSnapshot(), 0)
  )), []);

  useEffect(() => registerDrawingPerfLegacyCompatibilitySnapshotProvider(() => {
    const scopeKey = activeStoreRef.current.getSnapshot().scopeKey;
    const loaded = legacyDrawingImporter.load(scopeKey);
    if (loaded.status !== "found") return null;
    const record = encodeDrawingDocumentRecord(loaded.document, 0);
    if (!record) return null;
    return Object.freeze({
      scopeKey,
      raw: loaded.raw,
      normalizedRaw: JSON.stringify(loaded.savedDrawings),
      record,
    });
  }), []);

  useEffect(() => registerDrawingPerfPhase6HitOracleProvider((points) => {
    const runtimeSnapshot = sceneRuntime.snapshot();
    const plan = runtimeSnapshot.plan;
    const index = runtimeSnapshot.hitIndex;
    if (!plan || !index || index.list !== plan) {
      return Object.freeze({
        queryCount: 0,
        mismatchCount: 0,
        maxCandidates: 0,
        totalSegments: 0,
        indexedResults: Object.freeze([]),
        oracleResults: Object.freeze([]),
      });
    }
    const safePoints = points.slice(0, 1_000);
    const indexedResults: Array<DrawingDisplayHitResult | null> = [];
    const oracleResults: Array<DrawingDisplayHitResult | null> = [];
    let mismatchCount = 0;
    let maxCandidates = 0;
    for (const point of safePoints) {
      const query = queryDrawingHitIndex(index, point.x, point.y);
      maxCandidates = Math.max(maxCandidates, query.candidateEntityCount);
      const startedAt = drawingMonotonicNow();
      const indexed = hitTestDrawingHitIndex(index, point.x, point.y, selectedIdRef.current);
      drawingPerfCounters.recordHitQueryDuration(
        Math.max(0, drawingMonotonicNow() - startedAt),
      );
      const oracle = hitTestDrawingScreenDisplayList(
        plan,
        point.x,
        point.y,
        selectedIdRef.current,
      );
      indexedResults.push(indexed);
      oracleResults.push(oracle);
      if (JSON.stringify(indexed) !== JSON.stringify(oracle)) mismatchCount += 1;
    }
    return Object.freeze({
      queryCount: safePoints.length,
      mismatchCount,
      maxCandidates,
      totalSegments: index.stats.segmentCount,
      indexedResults: Object.freeze(indexedResults),
      oracleResults: Object.freeze(oracleResults),
    });
  }), [sceneRuntime, selectedIdRef]);

  useEffect(() => registerDrawingPerfShadowParityRequester(
    () => sceneRuntime.requestParity(),
  ), [sceneRuntime]);

  const hitTestScene = useCallback((x: number, y: number): DrawingDisplayHitResult | null => {
    if (!sceneCanaryEnabledRef.current || hiddenRef.current) return null;
    const snapshot = sceneRuntime.snapshot();
    if (!snapshot.plan || !snapshot.hitIndex || snapshot.hitIndex.list !== snapshot.plan) return null;
    const startedAt = drawingMonotonicNow();
    try {
      return hitTestDrawingHitIndex(snapshot.hitIndex, x, y, selectedIdRef.current);
    } finally {
      drawingPerfCounters.recordHitQueryDuration(
        Math.max(0, drawingMonotonicNow() - startedAt),
      );
    }
  }, [hiddenRef, sceneRuntime, selectedIdRef]);

  const getSceneScreenBox = useCallback((id: string): ScreenBox | null => {
    if (!sceneCanaryEnabledRef.current) return null;
    const plan = sceneRuntime.snapshot().plan;
    return plan ? drawingDisplayEntityScreenBox(plan, id) : null;
  }, [sceneRuntime]);

  const getSceneScreenHandles = useCallback((id: string): readonly ScreenPoint[] | null => {
    if (!sceneCanaryEnabledRef.current) return null;
    const plan = sceneRuntime.snapshot().plan;
    return plan ? drawingDisplayEntityScreenHandles(plan, id) : null;
  }, [sceneRuntime]);

  const getSavedDrawing = useCallback((id: string): SavedDrawing | null => {
    if (authorityMode !== "document" || !id) return null;
    const document = activeStoreRef.current.getSnapshot();
    if (document.scopeKey !== requestedScopeRef.current
      || document.scopeKey !== symbolRef.current) return null;
    const entity = document.entities.get(id);
    return entity ? savedDrawingFromEntity(entity) : null;
  }, [authorityMode, symbolRef]);

  const getLegacyPrimitiveRuntimeEvidence = useCallback((): DrawingLegacyPrimitiveRuntimeEvidence => (
    drawingLegacyPrimitiveRuntimeEvidence(
      sceneDocumentOnlyEnabled,
      rendererRef.current,
      primitivesRef.current,
    )
  ), [primitivesRef, sceneDocumentOnlyEnabled]);

  const getActiveDocumentTarget = useCallback((): DrawingActiveDocumentTarget | null => {
    if (authorityMode !== "document" || !scopeReadyRef.current) return null;
    const document = activeStoreRef.current.getSnapshot();
    if (document.scopeKey !== requestedScopeRef.current
      || document.scopeKey !== symbolRef.current) return null;
    return Object.freeze({
      scopeKey: document.scopeKey,
      documentRevision: document.documentRevision,
    });
  }, [authorityMode, symbolRef]);

  const flushActiveDocument = useCallback(async (
    target: DrawingActiveDocumentTarget,
  ): Promise<DrawingActiveDocumentFlushResult> => flushDrawingPersistenceTarget(
    drawingPersistenceCoordinator,
    activeStoreRef.current,
    target,
  ), []);

  const waitForExactExportScene = useCallback(async (
    target: DrawingActiveDocumentTarget,
    signal?: AbortSignal,
  ): Promise<DrawingExportSceneReceipt> => {
    const store = activeStoreRef.current;
    const document = store.getSnapshot();
    if (document.scopeKey !== target.scopeKey
      || document.documentRevision !== target.documentRevision) {
      throw new Error("drawing export scene target is stale");
    }
    if (engineMode.effective === "scene-canary" && sceneCanaryEnabledRef.current) {
      const exactRuntimeReady = ensureHiddenDrawingSceneRuntimeForExactExport(
        hiddenRef.current,
        sceneRuntime.snapshot().active,
        () => {
          const renderer = rendererRef.current;
          return !!renderer
            && renderer.documentSnapshot() === document
            && activateDrawingScene(store, renderer, { allowHiddenExact: true });
        },
      );
      if (!exactRuntimeReady) {
        throw new Error("drawing export hidden scene runtime could not reactivate");
      }
      const exactReceipt = await sceneRuntime.waitForExactPaint({
        scopeKey: target.scopeKey,
        documentRevision: target.documentRevision,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!hiddenRef.current) return exactReceipt;

      // The exact empty paint is the evidence boundary. Keeping its runtime
      // live throughout a page capture would allow an unrelated viewport/tick
      // invalidation to replace the empty plan and make a strict identity
      // receipt stale. Retire it immediately; the barrier still waits its one
      // presentation frame before capture, so the cleared composite is visible.
      if (!isDrawingExportExactSceneEmpty(exactReceipt)) {
        sceneRuntime.suspend();
        throw new Error("drawing export hidden scene acknowledgement was not empty");
      }
      sceneRuntime.suspend();
      if (!isDrawingHiddenExportSceneRetired(
        sceneRuntime.snapshot(),
        sceneBridge.snapshot(),
      )) {
        sceneBridge.clearPlan(false);
        throw new Error("drawing export hidden scene runtime did not retire");
      }
      return Object.freeze({
        kind: "hidden-frame" as const,
        scopeKey: target.scopeKey,
        documentRevision: target.documentRevision,
        document,
        sceneEpoch: exactReceipt.sceneEpoch,
        attachmentRevision: exactReceipt.attachmentRevision,
        paintSequence: exactReceipt.paintSequence,
      });
    }
    // The rollback renderer has no composite paint receipt. Request its one
    // coherent chart update; the export orchestrator still waits a frame and
    // revalidates the canonical document before capture.
    try { sceneAdapterGetterDelegate.read()()?.requestSeriesUpdate?.(); } catch { /* best effort */ }
    return Object.freeze({
      kind: "legacy-frame" as const,
      scopeKey: target.scopeKey,
      documentRevision: target.documentRevision,
    });
  }, [activateDrawingScene, engineMode.effective, hiddenRef, sceneAdapterGetterDelegate, sceneBridge, sceneRuntime]);

  const revalidateExportScene = useCallback((
    target: DrawingActiveDocumentTarget,
    receipt: DrawingExportSceneReceipt,
  ): boolean => {
    const document = activeStoreRef.current.getSnapshot();
    if (document.scopeKey !== target.scopeKey
      || document.documentRevision !== target.documentRevision) return false;
    if ("kind" in receipt && receipt.kind === "hidden-frame") {
      return isDrawingHiddenExportFrameCurrent(
        target,
        receipt,
        document,
        hiddenRef.current,
        sceneRuntime.snapshot(),
        sceneBridge.snapshot(),
      );
    }
    if ("kind" in receipt) {
      return receipt.scopeKey === target.scopeKey
        && receipt.documentRevision === target.documentRevision;
    }
    const snapshot = sceneRuntime.snapshot();
    return receipt.stamp.scopeKey === target.scopeKey
      && receipt.stamp.documentRevision === target.documentRevision
      && receipt.lodToleranceClass === "settledExact"
      && snapshot.plan === receipt.plan
      && snapshot.lodToleranceClass === "settledExact";
  }, [hiddenRef, sceneBridge, sceneRuntime]);

  useEffect(() => {
    const runtimeBeforeTransition = sceneRuntime.snapshot();
    const bridgeBeforeTransition = sceneBridge.snapshot();
    const preservePostBoundaryPlan = canRecoverDrawingVisibleSceneInPlace({
      attachedSurfaceGeneration: bridgeBeforeTransition.surfaceGeneration,
      publishedSurfaceGeneration: runtimeBeforeTransition.plan?.stamp.surfaceGeneration ?? null,
      requestedScope: requestedScopeRef.current,
      runtimeActive: runtimeBeforeTransition.active,
      runtimePublicationReady: runtimeBeforeTransition.publicationReady,
      runtimeScope: runtimeBeforeTransition.scopeKey,
      sceneCanaryEnabled: engineMode.effective === "scene-canary"
        && sceneCanaryEnabledRef.current,
      mutationStarted: mutationStartedRef.current,
    });
    scopeReadyRef.current = false;
    // A same-scope, same-surface post-boundary retry replaces the plan
    // transactionally. Keep the last accepted pixels and runtime binding until
    // the replacement publication succeeds; new scopes/surfaces still clear.
    if (!preservePostBoundaryPlan) sceneRuntime.suspend();
    const adapter = getChartAdapter();
    const renderer = rendererRef.current;
    if (!adapter?.hasSeries?.() || !renderer || !symbol || !seriesReady) return;
    if (!ensureVisibleSceneSurface()) return;

    const prevSymbol = prevSymbolRef.current;
    const symbolChanged = prevSymbol && prevSymbol !== symbol;
    if (authorityMode === "document" && symbolChanged) {
      if (!beforeScopeTransitionRef.current()) {
        for (const primitive of renderer.snapshot()) primitive.setHidden?.(true);
        console.warn("Drawing scope transition preparation failed; the previous scope remains authoritative");
        return;
      }
    }

    if (authorityMode === "legacy") {
      if (symbolChanged) {
        if (primitivesRef.current.length > 0) {
          persistAndMeasure(prevSymbol, primitivesRef.current);
        }

        for (const prim of primitivesRef.current) adapter.detachPrimitive?.(prim);
        primitivesRef.current = [];
        selectedIdRef.current = null;
        setSelectedPrimId(null);
        setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
        draggingRef.current = null;
        isDrawingFreehandRef.current = false;
        currentFreehandRef.current = null;
        prevSymbolRef.current = symbol;
        symbolRef.current = symbol;
      }

      if (!symbolChanged && primitivesRef.current.length > 0) {
        for (const prim of primitivesRef.current) {
          try {
            adapter.detachPrimitive?.(prim);
            prim.setHidden?.(hiddenRef.current, false);
            adapter.attachPrimitive?.(prim);
          } catch (err) {
            console.warn("Failed to re-attach drawing:", err);
          }
        }
        prevSymbolRef.current = symbol;
        symbolRef.current = symbol;
        scopeReadyRef.current = true;
        return;
      }

      for (const item of loadDrawings(symbol)) {
        let primitive = null;
        try {
          primitive = createPrimitiveFromSavedDrawing(item);
        } catch (err) {
          console.warn("Failed to restore drawing:", err, item);
        }
        if (primitive) {
          primitive.setHidden?.(hiddenRef.current, false);
          adapter.attachPrimitive?.(primitive);
          primitivesRef.current.push(primitive);
        }
      }
      drawingPerfCounters.setGauge("visibleEntities", primitivesRef.current.length);
      prevSymbolRef.current = symbol;
      symbolRef.current = symbol;
      scopeReadyRef.current = true;
      return;
    }

    if (symbolChanged) {
      const previousStore = activeStoreRef.current;
      if (!commitPrimitiveDraft(prevSymbol, previousStore, primitivesRef.current, {
        adoptRenderer: false,
        restoreOnFailure: false,
      })) {
        console.warn("Failed to commit the previous drawing scope before switching symbols");
      } else if (previousStore.dirty) {
        void drawingPersistenceCoordinator.flush(prevSymbol).then((result) => {
          if (!result.ok) console.warn("Failed to flush the previous drawing scope", result.error);
        });
      }
      const detached = renderer.detachSurface();
      if (!detached) {
        // Some primitives may still belong to the old surface. Keep the old
        // registry/store authoritative and hide anything that remains attached;
        // activating the next scope here would mix symbols irreversibly.
        for (const primitive of renderer.snapshot()) primitive.setHidden?.(true);
        console.warn("Failed to detach the previous drawing scope completely; the scope transition was kept fail-closed");
        return;
      }
      primitivesRef.current = [];
      if (!sceneDocumentOnlyEnabled) {
        renderer.adopt(createEmptyDrawingDocument(prevSymbol), []);
      }
      selectedIdRef.current = null;
      setSelectedPrimId(null);
      setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
      draggingRef.current = null;
      isDrawingFreehandRef.current = false;
      currentFreehandRef.current = null;
      prevSymbolRef.current = symbol;
    }

    if (!symbolChanged && primitivesRef.current.length > 0) {
      const currentPrimitives = persistentLegacyPrimitives(primitivesRef.current);
      configureLegacyViewportBatching(currentPrimitives, sceneCanaryEnabledRef.current);
      for (const prim of currentPrimitives) prim.setHidden?.(hiddenRef.current, false);
      let rebound = true;
      if (!renderer.adopt(activeStoreRef.current.getSnapshot(), currentPrimitives)
        || !renderer.rebindSurface()) {
        if (renderer.restoreDocument(activeStoreRef.current.getSnapshot())) {
          primitivesRef.current = [...renderer.snapshot()];
        } else {
          rebound = false;
          for (const primitive of renderer.snapshot()) primitive.setHidden?.(true);
          console.warn("Failed to restore the drawing renderer registry after a series rebuild; the surface was kept fail-closed");
        }
      } else {
        primitivesRef.current = [...currentPrimitives];
      }
      prevSymbolRef.current = symbol;
      symbolRef.current = symbol;
      scopeReadyRef.current = rebound;
      if (rebound && !activateDrawingScene(activeStoreRef.current, renderer)
        && engineMode.effective === "scene-canary" && sceneCanaryEnabledRef.current) {
        fallbackVisibleSceneBeforeMutation("scene runtime activation failed after series rebind");
      }
      return;
    }

    const store = drawingDocumentSessionRegistry.getStore(symbol);
    activeStoreRef.current = store;
    symbolRef.current = symbol;
    prevSymbolRef.current = symbol;
    if (!drawingDocumentSessionRegistry.isLoaded(symbol) && store.dirty) {
      // A dirty in-memory snapshot is newer than disk by definition. Mark it
      // as the session's loaded source so a host remount cannot overwrite the
      // unsaved revision with an older localStorage payload.
      drawingDocumentSessionRegistry.markLoaded(symbol, store);
    } else if (drawingDocumentSessionRegistry.shouldLoadFromPersistence(symbol, store)) {
      let active = true;
      const requestedStore = store;
      const requestedSymbol = symbol;
      void loadDrawingDocumentOnce(requestedSymbol).then((loaded) => {
        if (!active
          || requestedScopeRef.current !== requestedSymbol
          || activeStoreRef.current !== requestedStore
          || requestedStore.getSnapshot().scopeKey !== requestedSymbol) return;
        if (requestedStore.dirty) {
          drawingDocumentSessionRegistry.markLoaded(requestedSymbol, requestedStore);
        } else if (loaded.status === "found") {
          const result = requestedStore.loadDocument(loaded.document);
          if (!result.ok) {
            console.warn("Failed to load drawing document:", result.error);
            return;
          } else {
            drawingDocumentSessionRegistry.markLoaded(requestedSymbol, requestedStore);
            persistenceRestoreSourceRef.current = {
              scopeKey: requestedSymbol,
              source: loaded.source,
            };
            if (loaded.source === "v2") {
              drawingPerfCounters.recordDuration(
                "restoreChunkMs",
                loaded.decodeMetrics.maxChunkDurationMs,
              );
            }
          }
        } else if (loaded.status === "missing") {
          drawingDocumentSessionRegistry.markLoaded(requestedSymbol, requestedStore);
          persistenceRestoreSourceRef.current = {
            scopeKey: requestedSymbol,
            source: "none",
          };
        } else {
          console.warn(
            "Drawing document restore failed closed; mutations remain disabled:",
            loaded.source,
            loaded.error,
          );
          return;
        }
        setScopeRetryGeneration((generation) => (
          generation >= Number.MAX_SAFE_INTEGER ? 0 : generation + 1
        ));
      }).catch((error) => {
        if (!active) return;
        console.warn("Drawing document restore threw; mutations remain disabled", error);
      });
      return () => { active = false; };
    }

    const documentToRestore = store.getSnapshot();
    if (renderer.documentSnapshot() !== documentToRestore
      && documentToRestore.entities.size >= 32) {
      let active = true;
      let retryHandle: ReturnType<typeof setTimeout> | null = null;
      const abortController = new AbortController();
      const scheduleBoundedRetry = (): void => {
        const retry = boundedRestoreRetryRef.current;
        if (retry.scopeKey !== symbol) {
          retry.scopeKey = symbol;
          retry.attempts = 0;
        }
        if (retry.attempts >= 2) return;
        retry.attempts += 1;
        retryHandle = setTimeout(() => {
          retryHandle = null;
          if (!active) return;
          setScopeRetryGeneration((generation) => (
            generation >= Number.MAX_SAFE_INTEGER ? 0 : generation + 1
          ));
        }, 50);
      };
      void renderer.reconcileAsync(documentToRestore, {
        signal: abortController.signal,
      }).then((result) => {
        if (!active
          || requestedScopeRef.current !== symbol
          || activeStoreRef.current !== store
          || store.getSnapshot() !== documentToRestore) return;
        if (!result.ok) {
          if (!result.cancelled) {
            console.warn("Failed to materialize the drawing document in bounded restore chunks");
            scheduleBoundedRetry();
          }
          return;
        }
        boundedRestoreRetryRef.current = { scopeKey: symbol, attempts: 0 };
        drawingPerfCounters.recordDuration("restoreChunkMs", result.maxChunkDurationMs);
        setScopeRetryGeneration((generation) => (
          generation >= Number.MAX_SAFE_INTEGER ? 0 : generation + 1
        ));
      }).catch((error) => {
        if (active) {
          console.warn("Bounded drawing document restore failed closed", error);
          scheduleBoundedRetry();
        }
      });
      return () => {
        active = false;
        if (retryHandle !== null) clearTimeout(retryHandle);
        abortController.abort("drawing restore scope changed");
      };
    }

    if (!renderer.reconcile(documentToRestore)) {
      console.warn("Failed to materialize the drawing document; the document was retained for retry");
    } else {
      primitivesRef.current = [...renderer.snapshot()];
      if (sceneDocumentOnlyEnabled) {
        const selectedEntity = selectedIdRef.current
          ? documentToRestore.entities.get(selectedIdRef.current) ?? null
          : null;
        const selectedDrawing = selectedEntity
          ? savedDrawingFromEntity(selectedEntity)
          : null;
        setSelectedTextUi(selectedTextUiFromSavedDrawing(selectedDrawing, null));
        if (selectedIdRef.current && !selectedEntity) {
          selectedIdRef.current = null;
          setSelectedPrimId(null);
        }
      } else {
        const selected = selectedIdRef.current
          ? renderer.getPrimitiveById(selectedIdRef.current)
          : null;
        setSelectedTextUi(selectedTextUiFromPrimitive(selected));
        if (selectedIdRef.current && !selected) {
          selectedIdRef.current = null;
          setSelectedPrimId(null);
        }
      }
      scopeReadyRef.current = true;
      if (!activateDrawingScene(store, renderer)
        && engineMode.effective === "scene-canary" && sceneCanaryEnabledRef.current) {
        fallbackVisibleSceneBeforeMutation("scene runtime activation failed");
      }
    }
    drawingPerfCounters.setGauge(
      "visibleEntities",
      sceneDocumentOnlyEnabled
        ? documentToRestore.entities.size
        : primitivesRef.current.length,
    );

    prevSymbolRef.current = symbol;
  }, [
    currentFreehandRef,
    activateDrawingScene,
    authorityMode,
    beforeScopeTransitionRef,
    commitPrimitiveDraft,
    draggingRef,
    getChartAdapter,
    ensureVisibleSceneSurface,
    engineMode.effective,
    fallbackVisibleSceneBeforeMutation,
    hiddenRef,
    isDrawingFreehandRef,
    prevSymbolRef,
    primitivesRef,
    selectedIdRef,
    sceneBridge,
    sceneDocumentOnlyEnabled,
    sceneRuntime,
    seriesReady,
    setSelectedPrimId,
    setSelectedTextUi,
    symbol,
    symbolRef,
    // A rejected user mutation increments this generation so the exact same
    // symbol/series pair re-enters the transition effect instead of remaining
    // permanently stuck on the previous store.
    scopeRetryGeneration,
  ]);

  useEffect(() => () => {
    if (sceneSurfaceRetryHandleRef.current !== null) {
      clearTimeout(sceneSurfaceRetryHandleRef.current);
      sceneSurfaceRetryHandleRef.current = null;
    }
    scopeReadyRef.current = false;
    sceneRuntime.suspend();
    const sceneDetached = sceneBridge.detach();
    const adapter = getChartAdapter();
    if (authorityMode === "document") {
      const prepared = beforeScopeTransitionRef.current();
      const store = activeStoreRef.current;
      if (prepared) {
        commitPrimitiveDraft(store.getSnapshot().scopeKey, store, primitivesRef.current, {
          adoptRenderer: false,
          restoreOnFailure: false,
        });
        if (store.dirty) {
          void drawingPersistenceCoordinator.flush(store.getSnapshot().scopeKey).then((result) => {
            if (!result.ok) console.warn("Failed to flush drawing scope during teardown", result.error);
          });
        }
      }
    }
    const renderer = rendererRef.current;
    let detached = true;
    if (authorityMode === "document" && renderer) {
      detached = renderer.detachSurface();
    } else {
      for (const prim of primitivesRef.current) {
        try {
          if (adapter?.detachPrimitive?.(prim) === false) detached = false;
        } catch {
          detached = false;
          // Best-effort teardown. The owning chart may already be disposing.
        }
      }
    }
    if (!detached || !sceneDetached) console.warn("Drawing surface teardown was incomplete; the next surface will retry attachment");
    if (detached && sceneDetached) {
      const activeScope = activeStoreRef.current.getSnapshot().scopeKey;
      if (!sceneDocumentOnlyEnabled) {
        renderer?.adopt(createEmptyDrawingDocument(activeScope), []);
      }
    }
  }, [authorityMode, beforeScopeTransitionRef, commitPrimitiveDraft, getChartAdapter, primitivesRef, sceneBridge, sceneDocumentOnlyEnabled, sceneRuntime]);

  return {
    clearDrawings,
    completeSurfaceDispose,
    invalidateSurfaceCredentialsForSeriesReplacement,
    invalidateVisibleScene,
    synchronizeVisibleSceneVisibility,
    persistActiveScopeDrawings,
    persistDetachedDrawings,
    persistSceneCommands,
    persistDrawings,
    prepareSurfaceDispose,
    prepareUserMutationScope,
    hitTestScene,
    getSceneScreenBox,
    getSceneScreenHandles,
    getSavedDrawing,
    getLegacyPrimitiveRuntimeEvidence,
    getActiveDocumentTarget,
    flushActiveDocument,
    waitForExactExportScene,
    revalidateExportScene,
    subscribeVisibleScenePaint,
  };
}
