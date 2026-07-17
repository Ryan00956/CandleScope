import {
  exportDrawingDocument,
  savedDrawingFromEntity,
} from "../core/drawingCodec.js";
import {
  canonicalDrawingValueEquals,
  DRAWING_DOCUMENT_SCHEMA_VERSION,
  MAX_DRAWING_DOCUMENT_ENTITIES,
} from "../core/drawingDocument.js";
import type { DrawingDocument, DrawingEntity } from "../core/drawingDocument.js";
import { createPrimitiveFromSavedDrawing } from "../drawingPrimitiveFactory.js";
import {
  MAX_DRAWING_STORAGE_CHARS,
  MAX_SAVED_DRAWINGS,
  MAX_SAVED_FREEHAND_POINTS,
  MAX_SAVED_FREEHAND_SPANS,
} from "../drawingPersistence.js";
import type { DrawingPrimitive, SavedDrawing } from "../drawingTypes.js";

export type LegacyPrimitiveFactory = (drawing: SavedDrawing) => DrawingPrimitive | null;

export interface LegacyPrimitiveSurface {
  attachPrimitive?(primitive: DrawingPrimitive): boolean | void;
  detachPrimitive?(primitive: DrawingPrimitive): boolean | void;
}

export interface LegacyPrimitiveRendererOptions {
  surface?: LegacyPrimitiveSurface;
  createPrimitive?: LegacyPrimitiveFactory;
  /** Transitional Phase 4 policy: registry objects may exist without owning a chart attachment. */
  shouldAttachPrimitive?: (primitive: DrawingPrimitive) => boolean;
}

export interface LegacyPrimitiveAsyncReconcileOptions {
  readonly signal?: AbortSignal;
  readonly monotonicNow?: () => number;
  readonly yieldToHost?: () => Promise<void>;
  /** May lower, but never raise, the production 8ms work budget. */
  readonly chunkBudgetMs?: number;
  /** May lower, but never raise, the production 8-entity work budget. */
  readonly maxEntitiesPerChunk?: number;
}

export interface LegacyPrimitiveAsyncReconcileResult {
  readonly ok: boolean;
  readonly cancelled: boolean;
  readonly entityCount: number;
  readonly chunkCount: number;
  readonly maxChunkDurationMs: number;
}

export interface LegacyPrimitiveRenderer {
  /** Atomically materialize and replace the current canonical snapshot. */
  reconcile(document: DrawingDocument): boolean;
  /**
   * Fair-yield initial restore. Candidate construction is cancellable and
   * never touches the retained surface; the final compensated swap remains
   * atomic from the registry's point of view.
   */
  reconcileAsync(
    document: DrawingDocument,
    options?: LegacyPrimitiveAsyncReconcileOptions,
  ): Promise<LegacyPrimitiveAsyncReconcileResult>;
  /** Alias used by lifecycle code that treats each document as a full snapshot. */
  replaceDocument(document: DrawingDocument): boolean;
  /**
   * Register primitives that the legacy controller already attached itself.
   * This path performs no chart attach/detach operations.
   */
  adopt(document: DrawingDocument, primitives: readonly DrawingPrimitive[]): boolean;
  /**
   * Adopt a registry after the controller supplied checked attach/detach
   * credentials for the completed mutation.
   */
  adoptAttached(document: DrawingDocument, primitives: readonly DrawingPrimitive[]): boolean;
  /**
   * Incrementally materialize a document that was already committed by the
   * canonical store. Candidates are detached and own no surface credential.
   * A surface failure never rolls the retained document back.
   */
  adoptDetached(
    document: DrawingDocument,
    primitives?: readonly DrawingPrimitive[],
  ): boolean;
  /** Validate an adoption without changing renderer or chart state. */
  canAdopt(document: DrawingDocument, primitives: readonly DrawingPrimitive[]): boolean;
  /** Record checked external surface credentials before any document validation. */
  stageAttached(primitives: readonly DrawingPrimitive[]): void;
  snapshot(): readonly DrawingPrimitive[];
  attachedCount(): number;
  /** Canonical document currently represented by the retained registry. */
  documentSnapshot(): DrawingDocument | null;
  getPrimitiveById(id: string): DrawingPrimitive | null;
  /** Detach the current registry from its surface while retaining it for rebind. */
  detachSurface(): boolean;
  /** Attach the retained registry to the current surface. */
  rebindSurface(): boolean;
  /** Forget credentials after the owning chart confirms that surface removal completed. */
  releaseSurfaceCredentials(): void;
  /** Rebuild fresh primitives from a canonical snapshot after a failed draft. */
  restoreDocument(document: DrawingDocument): boolean;
  detachAll(): boolean;
  dispose(): void;
}

function primitiveId(primitive: DrawingPrimitive): string | null {
  const candidate = primitive as DrawingPrimitive & { id?: unknown; _id?: unknown };
  if (typeof candidate.id === "string") return candidate.id;
  return typeof candidate._id === "string" ? candidate._id : null;
}

/**
 * Build a complete legacy primitive collection without touching the chart.
 * A single codec/factory/id failure rejects the whole candidate collection.
 */
export function materializeLegacyPrimitives(
  document: DrawingDocument,
  createPrimitive: LegacyPrimitiveFactory = createPrimitiveFromSavedDrawing,
): DrawingPrimitive[] | null {
  const saved = exportDrawingDocument(document);
  if (!saved) return null;
  const primitives: DrawingPrimitive[] = [];
  try {
    for (const drawing of saved) {
      const primitive = createPrimitive(drawing);
      if (!primitive || primitiveId(primitive) !== drawing.id) return null;
      primitives.push(primitive);
    }
    return primitives;
  } catch {
    return null;
  }
}

const LEGACY_RESTORE_CHUNK_BUDGET_MS = 8;
const LEGACY_RESTORE_MAX_ENTITIES_PER_CHUNK = 8;

interface AsyncMaterializationMetrics {
  readonly entityCount: number;
  readonly chunkCount: number;
  readonly maxChunkDurationMs: number;
}

type AsyncMaterializationResult =
  | Readonly<{
      status: "ready";
      primitives: readonly DrawingPrimitive[];
      byId: Map<string, DrawingPrimitive>;
      metrics: AsyncMaterializationMetrics;
    }>
  | Readonly<{
      status: "cancelled" | "rejected";
      metrics: AsyncMaterializationMetrics;
    }>;

function defaultMonotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function defaultYieldToHost(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function boundedChunkBudget(value: number | undefined): number {
  if (value === undefined) return LEGACY_RESTORE_CHUNK_BUDGET_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError("legacy primitive restore chunk budget must be positive");
  }
  return Math.min(value, LEGACY_RESTORE_CHUNK_BUDGET_MS);
}

function boundedChunkEntityCount(value: number | undefined): number {
  if (value === undefined) return LEGACY_RESTORE_MAX_ENTITIES_PER_CHUNK;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("legacy primitive restore entity budget must be a positive integer");
  }
  return Math.min(value, LEGACY_RESTORE_MAX_ENTITIES_PER_CHUNK);
}

function asyncMaterializationMetrics(
  entityCount: number,
  chunkCount: number,
  maxChunkDurationMs: number,
): AsyncMaterializationMetrics {
  return Object.freeze({ entityCount, chunkCount, maxChunkDurationMs });
}

function freehandPayloadCounts(drawing: SavedDrawing): Readonly<{
  points: number;
  spans: number;
}> {
  if (drawing.type !== "freehand" && drawing.type !== "highlighter") {
    return Object.freeze({ points: 0, spans: 0 });
  }
  return drawing.stroke === undefined
    ? Object.freeze({ points: drawing.dataPoints.length, spans: 0 })
    : Object.freeze({
        points: drawing.stroke.points.length,
        spans: drawing.stroke.spans.length,
      });
}

function validAsyncDocumentHeader(document: DrawingDocument): boolean {
  const entityCount = document?.entities?.size;
  return document?.schemaVersion === DRAWING_DOCUMENT_SCHEMA_VERSION
    && typeof document.scopeKey === "string"
    && document.scopeKey.length > 0
    && Number.isSafeInteger(document.documentRevision)
    && document.documentRevision >= 0
    && Number.isSafeInteger(entityCount)
    && entityCount >= 0
    && entityCount <= MAX_DRAWING_DOCUMENT_ENTITIES
    && entityCount <= MAX_SAVED_DRAWINGS
    && typeof document.entities.get === "function"
    && Array.isArray(document.zOrder)
    && document.zOrder.length === entityCount;
}

/**
 * Build one complete candidate registry without the synchronous
 * exportDrawingDocument(document) pass. Validation and legacy-size accounting
 * happen per entity, and no surface credential is touched before completion.
 */
async function materializeLegacyPrimitivesAsync(
  document: DrawingDocument,
  createPrimitive: LegacyPrimitiveFactory,
  {
    signal,
    monotonicNow = defaultMonotonicNow,
    yieldToHost = defaultYieldToHost,
    chunkBudgetMs: requestedChunkBudgetMs,
    maxEntitiesPerChunk: requestedMaxEntitiesPerChunk,
  }: LegacyPrimitiveAsyncReconcileOptions,
): Promise<AsyncMaterializationResult> {
  const chunkBudgetMs = boundedChunkBudget(requestedChunkBudgetMs);
  const maxEntitiesPerChunk = boundedChunkEntityCount(requestedMaxEntitiesPerChunk);
  if (!validAsyncDocumentHeader(document)) {
    return Object.freeze({
      status: "rejected" as const,
      metrics: asyncMaterializationMetrics(0, 0, 0),
    });
  }
  if (signal?.aborted) {
    return Object.freeze({
      status: "cancelled" as const,
      metrics: asyncMaterializationMetrics(0, 0, 0),
    });
  }

  const primitives: DrawingPrimitive[] = [];
  const byId = new Map<string, DrawingPrimitive>();
  const seenIds = new Set<string>();
  let totalPoints = 0;
  let totalSpans = 0;
  let serializedLength = 2;
  let chunkCount = 0;
  let chunkEntityCount = 0;
  let chunkStartedAt = 0;
  let chunkOpen = false;
  let maxChunkDurationMs = 0;

  const startChunk = (): void => {
    chunkOpen = true;
    chunkCount += 1;
    chunkEntityCount = 0;
    chunkStartedAt = monotonicNow();
  };
  const finishChunk = (): number => {
    if (!chunkOpen) return 0;
    const duration = Math.max(0, monotonicNow() - chunkStartedAt);
    maxChunkDurationMs = Math.max(maxChunkDurationMs, duration);
    return duration;
  };
  const metrics = (): AsyncMaterializationMetrics => asyncMaterializationMetrics(
    primitives.length,
    chunkCount,
    maxChunkDurationMs,
  );
  const stop = (status: "cancelled" | "rejected"): AsyncMaterializationResult => {
    finishChunk();
    return Object.freeze({ status, metrics: metrics() });
  };

  for (let index = 0; index < document.zOrder.length; index += 1) {
    if (signal?.aborted) return stop("cancelled");
    if (!chunkOpen) startChunk();
    const id = document.zOrder[index];
    if (typeof id !== "string" || seenIds.has(id)) return stop("rejected");
    const entity = document.entities.get(id);
    if (!entity || entity.id !== id) return stop("rejected");

    let drawing: SavedDrawing | null = null;
    let primitive: DrawingPrimitive | null = null;
    let itemRaw: string | null = null;
    try {
      drawing = savedDrawingFromEntity(entity);
      if (drawing) {
        itemRaw = JSON.stringify(drawing);
        primitive = createPrimitive(drawing);
      }
    } catch {
      return stop("rejected");
    }
    if (!drawing
      || typeof itemRaw !== "string"
      || !primitive
      || primitiveId(primitive) !== id) return stop("rejected");

    const counts = freehandPayloadCounts(drawing);
    totalPoints += counts.points;
    totalSpans += counts.spans;
    serializedLength += itemRaw.length + (index === 0 ? 0 : 1);
    if (totalPoints > MAX_SAVED_FREEHAND_POINTS
      || totalSpans > MAX_SAVED_FREEHAND_SPANS
      || serializedLength > MAX_DRAWING_STORAGE_CHARS) return stop("rejected");

    seenIds.add(id);
    primitives.push(primitive);
    byId.set(id, primitive);
    chunkEntityCount += 1;
    const chunkDuration = Math.max(0, monotonicNow() - chunkStartedAt);
    const hasMoreEntities = index + 1 < document.zOrder.length;
    if (hasMoreEntities
      && (chunkEntityCount >= maxEntitiesPerChunk || chunkDuration >= chunkBudgetMs)) {
      finishChunk();
      chunkOpen = false;
      try {
        await yieldToHost();
      } catch {
        return Object.freeze({ status: "rejected" as const, metrics: metrics() });
      }
      if (signal?.aborted) {
        return Object.freeze({ status: "cancelled" as const, metrics: metrics() });
      }
    }
  }

  finishChunk();
  return Object.freeze({
    status: "ready" as const,
    primitives: Object.freeze(primitives),
    byId,
    metrics: metrics(),
  });
}

function invokeSurfaceAction(
  action: ((primitive: DrawingPrimitive) => boolean | void) | undefined,
  primitive: DrawingPrimitive,
): boolean {
  if (!action) return true;
  try {
    return action(primitive) !== false;
  } catch {
    return false;
  }
}

function adoptionRegistry(
  document: DrawingDocument,
  primitives: readonly DrawingPrimitive[],
): Map<string, DrawingPrimitive> | null {
  // DrawingDocument snapshots crossing this renderer are already normalized
  // by the document store/codec. Adoption only needs to prove exact registry
  // identity and z-order; re-exporting the full document here would stringify
  // large freehand geometry several times on mouseup.
  const zOrder: readonly unknown[] = document?.zOrder ?? [];
  if (!document
    || !document.entities
    || typeof document.entities.get !== "function"
    || !Number.isSafeInteger(document.entities.size)
    || !Array.isArray(zOrder)
    || zOrder.length !== document.entities.size
    || zOrder.length !== primitives.length) return null;
  const byId = new Map<string, DrawingPrimitive>();
  for (let index = 0; index < zOrder.length; index += 1) {
    const candidateId: unknown = zOrder.at(index);
    if (typeof candidateId !== "string") return null;
    const id = candidateId;
    const entity = document.entities.get(id);
    const primitive = primitives[index];
    if (!entity || entity.id !== id || !primitive || byId.has(id)) return null;
    if (primitiveId(primitive) !== id) return null;
    byId.set(id, primitive);
  }
  return byId;
}

function canonicalEntityEquals(left: DrawingEntity, right: DrawingEntity): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && left.geometryRevision === right.geometryRevision
    && left.styleRevision === right.styleRevision
    && canonicalDrawingValueEquals(left.geometry, right.geometry)
    && canonicalDrawingValueEquals(left.style, right.style)
    && canonicalDrawingValueEquals(left.bounds, right.bounds);
}

/**
 * Resolve the canonical entity ids whose primitive materialization changed.
 * Reordering alone deliberately returns an empty delta so existing primitive
 * identity and surface ownership remain untouched.
 */
export function legacyPrimitiveDocumentDeltaIds(
  previous: DrawingDocument,
  next: DrawingDocument,
): readonly string[] | null {
  if (previous.scopeKey !== next.scopeKey) return null;
  const changed = new Set<string>();
  for (const id of next.zOrder) {
    const nextEntity = next.entities.get(id);
    const previousEntity = previous.entities.get(id);
    if (!nextEntity || !previousEntity || !canonicalEntityEquals(previousEntity, nextEntity)) {
      changed.add(id);
    }
  }
  for (const id of previous.zOrder) {
    if (!next.entities.has(id)) changed.add(id);
  }
  return Object.freeze([...changed]);
}

class LegacyPrimitiveRendererImpl implements LegacyPrimitiveRenderer {
  readonly #surface: LegacyPrimitiveSurface;
  readonly #createPrimitive: LegacyPrimitiveFactory;
  readonly #shouldAttachPrimitive: (primitive: DrawingPrimitive) => boolean;
  #primitives: DrawingPrimitive[] = [];
  #byId = new Map<string, DrawingPrimitive>();
  #document: DrawingDocument | null = null;
  #attached = new Set<DrawingPrimitive>();
  #surfaceSynchronized = true;
  #registryGeneration = 0;

  constructor(options: LegacyPrimitiveRendererOptions) {
    this.#surface = options.surface ?? {};
    this.#createPrimitive = options.createPrimitive ?? createPrimitiveFromSavedDrawing;
    this.#shouldAttachPrimitive = options.shouldAttachPrimitive ?? (() => true);
  }

  #surfaceMatchesRegistry(): boolean {
    const desired = this.#primitives.filter(this.#shouldAttachPrimitive);
    return this.#attached.size === desired.length
      && desired.every((primitive) => this.#attached.has(primitive));
  }

  #attach(primitive: DrawingPrimitive): boolean {
    if (!this.#shouldAttachPrimitive(primitive)) return true;
    if (this.#attached.has(primitive)) return true;
    if (!invokeSurfaceAction(this.#surface.attachPrimitive, primitive)) return false;
    this.#attached.add(primitive);
    return true;
  }

  #detach(primitive: DrawingPrimitive): boolean {
    if (!this.#attached.has(primitive)) return true;
    if (!invokeSurfaceAction(this.#surface.detachPrimitive, primitive)) return false;
    this.#attached.delete(primitive);
    return true;
  }

  #setRegistry(
    document: DrawingDocument | null,
    primitives: readonly DrawingPrimitive[],
    byId?: Map<string, DrawingPrimitive>,
  ): void {
    this.#registryGeneration = this.#registryGeneration >= Number.MAX_SAFE_INTEGER
      ? 1
      : this.#registryGeneration + 1;
    this.#document = document;
    this.#primitives = [...primitives];
    this.#byId = byId ?? new Map(primitives.flatMap((primitive) => {
      const id = primitiveId(primitive);
      return id ? [[id, primitive] as const] : [];
    }));
    this.#surfaceSynchronized = this.#surfaceMatchesRegistry();
  }

  #rollbackCandidateReplacement(
    attachedCandidates: readonly DrawingPrimitive[],
    detachedPrevious: readonly DrawingPrimitive[],
  ): void {
    for (const detached of detachedPrevious) this.#attach(detached);
    for (let index = attachedCandidates.length - 1; index >= 0; index -= 1) {
      const attached = attachedCandidates[index];
      if (attached) this.#detach(attached);
    }
    this.#surfaceSynchronized = this.#surfaceMatchesRegistry();
  }

  #commitCandidateReplacement(
    document: DrawingDocument,
    candidates: readonly DrawingPrimitive[],
    byId: Map<string, DrawingPrimitive>,
    signal: AbortSignal | null,
  ): Readonly<{ ok: boolean; cancelled: boolean }> {
    const cancelled = (): boolean => signal?.aborted === true;
    if (cancelled()) return Object.freeze({ ok: false, cancelled: true });

    // Recover every retained credential before replacing the logical registry.
    // A failed compensation is retryable and never forgotten or duplicated.
    if (!this.#surfaceSynchronized && !this.rebindSurface()) {
      return Object.freeze({ ok: false, cancelled: cancelled() });
    }
    if (cancelled()) return Object.freeze({ ok: false, cancelled: true });

    const attachedCandidates: DrawingPrimitive[] = [];
    for (const primitive of candidates) {
      if (cancelled()) {
        this.#rollbackCandidateReplacement(attachedCandidates, []);
        return Object.freeze({ ok: false, cancelled: true });
      }
      if (!this.#attach(primitive)) {
        this.#rollbackCandidateReplacement(attachedCandidates, []);
        return Object.freeze({ ok: false, cancelled: cancelled() });
      }
      attachedCandidates.push(primitive);
    }

    // Phase two replaces the attached snapshot. If detaching an old primitive
    // fails (or cancellation arrives from a synchronous surface callback),
    // restore old owners and remove the candidate set before returning.
    const detachedPrevious: DrawingPrimitive[] = [];
    for (const primitive of this.#primitives) {
      if (cancelled()) {
        this.#rollbackCandidateReplacement(attachedCandidates, detachedPrevious);
        return Object.freeze({ ok: false, cancelled: true });
      }
      if (!this.#detach(primitive)) {
        this.#rollbackCandidateReplacement(attachedCandidates, detachedPrevious);
        return Object.freeze({ ok: false, cancelled: cancelled() });
      }
      detachedPrevious.push(primitive);
    }
    if (cancelled()) {
      this.#rollbackCandidateReplacement(attachedCandidates, detachedPrevious);
      return Object.freeze({ ok: false, cancelled: true });
    }

    this.#setRegistry(document, candidates, byId);
    return Object.freeze({ ok: this.#surfaceSynchronized, cancelled: false });
  }

  reconcile(document: DrawingDocument): boolean {
    if (document === this.#document) {
      return this.#surfaceSynchronized ? true : this.rebindSurface();
    }

    // Recover every retained credential before replacing the logical registry.
    // A failed compensation is retryable and never forgotten or duplicated.
    if (!this.#surfaceSynchronized && !this.rebindSurface()) return false;

    // Phase one is pure construction. Never detach the current collection until
    // every candidate has passed the codec and primitive factory boundaries.
    const candidates = materializeLegacyPrimitives(document, this.#createPrimitive);
    if (!candidates) return false;

    const byId = new Map<string, DrawingPrimitive>();
    for (const primitive of candidates) {
      const id = primitiveId(primitive);
      if (id) byId.set(id, primitive);
    }
    return this.#commitCandidateReplacement(document, candidates, byId, null).ok;
  }

  async reconcileAsync(
    document: DrawingDocument,
    options: LegacyPrimitiveAsyncReconcileOptions = {},
  ): Promise<LegacyPrimitiveAsyncReconcileResult> {
    const emptyResult = (
      ok: boolean,
      cancelled: boolean,
    ): LegacyPrimitiveAsyncReconcileResult => Object.freeze({
      ok,
      cancelled,
      entityCount: 0,
      chunkCount: 0,
      maxChunkDurationMs: 0,
    });
    if (options.signal?.aborted) return emptyResult(false, true);
    if (document === this.#document) {
      const ok = this.#surfaceSynchronized ? true : this.rebindSurface();
      const cancelled = options.signal?.aborted === true;
      return emptyResult(cancelled ? false : ok, cancelled);
    }

    const expectedRegistryGeneration = this.#registryGeneration;
    let materialized: AsyncMaterializationResult;
    try {
      materialized = await materializeLegacyPrimitivesAsync(
        document,
        this.#createPrimitive,
        options,
      );
    } catch {
      return emptyResult(false, options.signal?.aborted === true);
    }
    const result = (
      ok: boolean,
      cancelled: boolean,
      commitDurationMs = 0,
    ): LegacyPrimitiveAsyncReconcileResult => Object.freeze({
      ok,
      cancelled,
      entityCount: materialized.metrics.entityCount,
      chunkCount: materialized.metrics.chunkCount,
      maxChunkDurationMs: Math.max(
        materialized.metrics.maxChunkDurationMs,
        commitDurationMs,
      ),
    });
    if (materialized.status !== "ready") {
      return result(false, materialized.status === "cancelled");
    }
    if (options.signal?.aborted) return result(false, true);
    // A sync reconcile/adoption/dispose may run while construction yields. A
    // stale async candidate must never overwrite that newer registry.
    if (this.#registryGeneration !== expectedRegistryGeneration) {
      return result(false, false);
    }
    const monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
    const commitStartedAt = monotonicNow();
    const committed = this.#commitCandidateReplacement(
      document,
      materialized.primitives,
      materialized.byId,
      options.signal ?? null,
    );
    const commitDurationMs = Math.max(0, monotonicNow() - commitStartedAt);
    return result(committed.ok, committed.cancelled, commitDurationMs);
  }

  replaceDocument(document: DrawingDocument): boolean {
    return this.reconcile(document);
  }

  adopt(document: DrawingDocument, primitives: readonly DrawingPrimitive[]): boolean {
    const byId = adoptionRegistry(document, primitives);
    if (!byId) return false;
    this.#setRegistry(document, primitives, byId);
    return true;
  }

  adoptAttached(document: DrawingDocument, primitives: readonly DrawingPrimitive[]): boolean {
    const byId = adoptionRegistry(document, primitives);
    if (!byId) return false;
    this.stageAttached(primitives);
    this.#setRegistry(document, primitives, byId);
    const desired = new Set(primitives.filter(this.#shouldAttachPrimitive));
    for (const primitive of [...this.#attached]) {
      if (!desired.has(primitive) && !this.#detach(primitive)) {
        this.#surfaceSynchronized = false;
        return false;
      }
    }
    this.#surfaceSynchronized = this.#surfaceMatchesRegistry();
    return this.#surfaceSynchronized;
  }

  adoptDetached(
    document: DrawingDocument,
    primitives?: readonly DrawingPrimitive[],
  ): boolean {
    const previousDocument = this.#document;
    if (!previousDocument) return false;
    if (document === previousDocument) {
      return this.#surfaceSynchronized ? true : this.rebindSurface();
    }
    const deltaIds = legacyPrimitiveDocumentDeltaIds(previousDocument, document);
    if (!deltaIds) return false;
    const delta = new Set(deltaIds);
    const suppliedById = primitives === undefined
      ? null
      : adoptionRegistry(document, primitives);
    if (primitives !== undefined && !suppliedById) return false;
    const saved = suppliedById ? null : exportDrawingDocument(document);
    if (!suppliedById && !saved) return false;
    const nextPrimitives: DrawingPrimitive[] = [];
    const nextById = new Map<string, DrawingPrimitive>();

    // Pure construction comes first. Unchanged ids retain their exact object;
    // only canonical delta ids cross the primitive factory boundary.
    try {
      for (let index = 0; index < document.zOrder.length; index += 1) {
        const id = document.zOrder[index];
        const drawing = saved?.[index] ?? null;
        if (!id || (!suppliedById && (!drawing || drawing.id !== id))) return false;
        const primitive = delta.has(id)
          ? suppliedById?.get(id) ?? (drawing ? this.#createPrimitive(drawing) : null)
          : this.#byId.get(id) ?? null;
        if (!primitive || primitiveId(primitive) !== id || nextById.has(id)) {
          return false;
        }
        if (!delta.has(id)
          && suppliedById
          && suppliedById.get(id) !== primitive) return false;
        nextPrimitives.push(primitive);
        nextById.set(id, primitive);
      }
    } catch {
      return false;
    }

    // The canonical store already committed this document. Advance the
    // retained registry before touching the surface so attach/detach failures
    // cannot demote the legacy renderer back into document authority.
    this.#setRegistry(document, nextPrimitives, nextById);

    for (const id of delta) {
      const candidate = nextById.get(id) ?? null;
      let staleOwnerRetained = false;
      for (const attached of [...this.#attached]) {
        if (attached !== candidate && primitiveId(attached) === id && !this.#detach(attached)) {
          staleOwnerRetained = true;
        }
      }
      // Never attach a second owner for one canonical id. A failed detach
      // leaves the new detached candidate retryable and the surface marked
      // unsynchronized instead of producing duplicate visual ownership.
      if (staleOwnerRetained) continue;
      if (candidate) this.#attach(candidate);
    }

    this.#surfaceSynchronized = this.#surfaceMatchesRegistry();
    return this.#surfaceSynchronized;
  }

  canAdopt(document: DrawingDocument, primitives: readonly DrawingPrimitive[]): boolean {
    return adoptionRegistry(document, primitives) !== null;
  }

  stageAttached(primitives: readonly DrawingPrimitive[]): void {
    const previous = new Set(this.#primitives);
    const next = new Set(primitives);
    for (const primitive of this.#primitives) {
      if (!next.has(primitive)) this.#attached.delete(primitive);
    }
    // The controller only supplies new surface credentials for objects that
    // entered its registry during this mutation. Existing objects retain their
    // last checked credential: a partially detached registry must never be
    // silently certified as attached by a later style/move command.
    for (const primitive of primitives) {
      if (!previous.has(primitive)) this.#attached.add(primitive);
    }
    this.#surfaceSynchronized = this.#surfaceMatchesRegistry();
  }

  snapshot(): readonly DrawingPrimitive[] {
    return Object.freeze([...this.#primitives]);
  }

  attachedCount(): number {
    return this.#attached.size;
  }

  documentSnapshot(): DrawingDocument | null {
    return this.#document;
  }

  getPrimitiveById(id: string): DrawingPrimitive | null {
    return this.#byId.get(id) ?? null;
  }

  detachSurface(): boolean {
    for (const primitive of [...this.#attached]) {
      this.#detach(primitive);
    }
    this.#surfaceSynchronized = false;
    return this.#attached.size === 0;
  }

  rebindSurface(): boolean {
    const desired = new Set(this.#primitives.filter(this.#shouldAttachPrimitive));
    let recovered = true;
    for (const primitive of [...this.#attached]) {
      if (!desired.has(primitive) && !this.#detach(primitive)) recovered = false;
    }
    if (!recovered) {
      this.#surfaceSynchronized = false;
      return false;
    }

    const attached: DrawingPrimitive[] = [];
    for (const primitive of desired) {
      if (this.#attached.has(primitive)) continue;
      if (!this.#attach(primitive)) {
        for (let index = attached.length - 1; index >= 0; index -= 1) {
          const candidate = attached[index];
          if (candidate) this.#detach(candidate);
        }
        this.#surfaceSynchronized = false;
        return false;
      }
      attached.push(primitive);
    }
    this.#surfaceSynchronized = this.#surfaceMatchesRegistry();
    return this.#surfaceSynchronized;
  }

  releaseSurfaceCredentials(): void {
    this.#attached.clear();
    this.#surfaceSynchronized = this.#surfaceMatchesRegistry();
  }

  restoreDocument(document: DrawingDocument): boolean {
    const candidates = materializeLegacyPrimitives(document, this.#createPrimitive);
    if (!candidates) return false;
    const byId = adoptionRegistry(document, candidates);
    if (!byId) return false;
    this.#setRegistry(document, candidates, byId);
    this.#surfaceSynchronized = false;
    return this.rebindSurface();
  }

  detachAll(): boolean {
    if (!this.detachSurface()) return false;
    this.#setRegistry(null, []);
    return true;
  }

  dispose(): void {
    this.detachAll();
  }
}

export function createLegacyPrimitiveRenderer(
  options: LegacyPrimitiveRendererOptions = {},
): LegacyPrimitiveRenderer {
  return new LegacyPrimitiveRendererImpl(options);
}
