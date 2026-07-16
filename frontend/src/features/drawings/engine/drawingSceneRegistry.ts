import {
  canonicalDrawingValueEquals,
  MAX_DRAWING_DOCUMENT_ENTITIES,
} from "../core/drawingDocument.js";
import type {
  DrawingDocument,
  DrawingEntity,
} from "../core/drawingDocument.js";
import {
  createDrawingEntityGeometryBounds,
  isValidDrawingBoundsViewport,
} from "../geometry/drawingBounds.js";
import type {
  DrawingBoundsViewport,
  DrawingEntityGeometryBounds,
  DrawingGeometryBounds,
  DrawingHorizontalDomain,
} from "../geometry/drawingBounds.js";

export const DRAWING_PACKED_BOUND_DEFERRED = 1 << 0;
export const DRAWING_PACKED_BOUND_UNBOUNDED_HORIZONTAL = 1 << 1;
export const DRAWING_PACKED_BOUND_UNBOUNDED_VERTICAL = 1 << 2;

const DRAWING_PACKED_DOMAIN_NONE = 0;
const DRAWING_PACKED_DOMAIN_TIME = 1;
const DRAWING_PACKED_DOMAIN_LOGICAL = 2;

export interface DrawingSceneNode {
  readonly id: string;
  readonly entity: DrawingEntity;
  readonly bounds: DrawingEntityGeometryBounds;
  readonly geometryRevision: number;
  readonly styleRevision: number;
  readonly zIndex: number;
}

export interface PackedDrawingSceneBounds {
  readonly count: number;
  readonly nodeCount: number;
  readonly nodeIndexes: Uint16Array;
  /** -1 is the entity-level bound; non-negative values identify freehand chunks. */
  readonly chunkIndexes: Int32Array;
  readonly flags: Uint8Array;
  readonly horizontalDomains: Uint8Array;
  readonly minHorizontal: Float64Array;
  readonly maxHorizontal: Float64Array;
  readonly minPrice: Float64Array;
  readonly maxPrice: Float64Array;
}

export interface DrawingSceneRegistrySnapshot {
  readonly scopeKey: string;
  readonly documentRevision: number;
  readonly nodes: readonly DrawingSceneNode[];
  readonly packedBounds: PackedDrawingSceneBounds;
}

export interface DrawingSceneRegistryReconcileSuccess {
  readonly ok: true;
  readonly changed: boolean;
  readonly createdNodeCount: number;
  readonly removedNodeCount: number;
  readonly recomputedBoundsCount: number;
  readonly reordered: boolean;
  readonly snapshot: DrawingSceneRegistrySnapshot;
}

export interface DrawingSceneRegistryReconcileFailure {
  readonly ok: false;
  readonly changed: false;
  readonly error: string;
  readonly snapshot: DrawingSceneRegistrySnapshot;
}

export type DrawingSceneRegistryReconcileResult =
  | DrawingSceneRegistryReconcileSuccess
  | DrawingSceneRegistryReconcileFailure;

export interface DrawingSceneRegistryOptions {
  readonly createBounds?: (entity: DrawingEntity) => DrawingEntityGeometryBounds;
}

export interface DrawingSceneRegistry {
  readonly scopeKey: string;
  getNode(id: string): DrawingSceneNode | null;
  getSnapshot(): DrawingSceneRegistrySnapshot;
  query(viewport: DrawingBoundsViewport): readonly DrawingSceneNode[];
  reconcile(document: DrawingDocument): DrawingSceneRegistryReconcileResult;
}

interface PackedBoundRecord {
  readonly bounds: DrawingGeometryBounds;
  readonly chunkIndex: number;
  readonly nodeIndex: number;
  readonly requiresExactProjection: boolean;
}

interface PendingNodeUpdate {
  readonly bounds: DrawingEntityGeometryBounds;
  readonly entity: DrawingEntity;
  readonly isNew: boolean;
  readonly node: RetainedDrawingSceneNode;
  readonly recomputed: boolean;
  readonly styleChanged: boolean;
  readonly zIndex: number;
}

class RetainedDrawingSceneNode implements DrawingSceneNode {
  readonly id: string;
  #entity: DrawingEntity;
  #bounds: DrawingEntityGeometryBounds;
  #zIndex: number;

  constructor(
    entity: DrawingEntity,
    bounds: DrawingEntityGeometryBounds,
    zIndex: number,
  ) {
    this.id = entity.id;
    this.#entity = entity;
    this.#bounds = bounds;
    this.#zIndex = zIndex;
  }

  get entity(): DrawingEntity { return this.#entity; }
  get bounds(): DrawingEntityGeometryBounds { return this.#bounds; }
  get geometryRevision(): number { return this.#entity.geometryRevision; }
  get styleRevision(): number { return this.#entity.styleRevision; }
  get zIndex(): number { return this.#zIndex; }

  update(
    entity: DrawingEntity,
    bounds: DrawingEntityGeometryBounds,
    zIndex: number,
  ): void {
    this.#entity = entity;
    this.#bounds = bounds;
    this.#zIndex = zIndex;
  }
}

function frozenEmptyPackedBounds(nodeCount = 0): PackedDrawingSceneBounds {
  return Object.freeze({
    count: 0,
    nodeCount,
    nodeIndexes: new Uint16Array(0),
    chunkIndexes: new Int32Array(0),
    flags: new Uint8Array(0),
    horizontalDomains: new Uint8Array(0),
    minHorizontal: new Float64Array(0),
    maxHorizontal: new Float64Array(0),
    minPrice: new Float64Array(0),
    maxPrice: new Float64Array(0),
  });
}

function frozenSnapshot(
  scopeKey: string,
  documentRevision: number,
  nodes: readonly DrawingSceneNode[],
  packedBounds: PackedDrawingSceneBounds,
): DrawingSceneRegistrySnapshot {
  return Object.freeze({
    scopeKey,
    documentRevision,
    nodes: Object.freeze([...nodes]),
    packedBounds,
  });
}

function horizontalDomainCode(domain: DrawingHorizontalDomain | null): number {
  if (domain === "time") return DRAWING_PACKED_DOMAIN_TIME;
  if (domain === "logical") return DRAWING_PACKED_DOMAIN_LOGICAL;
  return DRAWING_PACKED_DOMAIN_NONE;
}

function recordsForNodes(nodes: readonly DrawingSceneNode[]): PackedBoundRecord[] {
  const records: PackedBoundRecord[] = [];
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const node = nodes[nodeIndex];
    if (!node) continue;
    if (node.bounds.chunks.length === 0) {
      records.push({
        bounds: node.bounds.bounds,
        chunkIndex: -1,
        nodeIndex,
        requiresExactProjection: false,
      });
      continue;
    }
    for (let chunkIndex = 0; chunkIndex < node.bounds.chunks.length; chunkIndex += 1) {
      const chunk = node.bounds.chunks[chunkIndex];
      if (chunk) records.push({
        bounds: chunk.bounds,
        chunkIndex,
        nodeIndex,
        requiresExactProjection: chunk.requiresExactProjection,
      });
    }
  }
  return records;
}

/** Pack every entity/chunk bbox into parallel typed arrays for a bounded linear scan. */
export function createPackedDrawingSceneBounds(
  nodes: readonly DrawingSceneNode[],
): PackedDrawingSceneBounds {
  if (nodes.length === 0) return frozenEmptyPackedBounds();
  if (nodes.length > MAX_DRAWING_DOCUMENT_ENTITIES) {
    throw new RangeError("drawing scene node budget exceeded");
  }
  const records = recordsForNodes(nodes);
  const count = records.length;
  const nodeIndexes = new Uint16Array(count);
  const chunkIndexes = new Int32Array(count);
  const flags = new Uint8Array(count);
  const horizontalDomains = new Uint8Array(count);
  const minHorizontal = new Float64Array(count);
  const maxHorizontal = new Float64Array(count);
  const minPrice = new Float64Array(count);
  const maxPrice = new Float64Array(count);

  minHorizontal.fill(Number.NaN);
  maxHorizontal.fill(Number.NaN);
  minPrice.fill(Number.NaN);
  maxPrice.fill(Number.NaN);

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const bounds = record.bounds;
    nodeIndexes[index] = record.nodeIndex;
    chunkIndexes[index] = record.chunkIndex;
    if (record.requiresExactProjection || bounds.kind === "deferred") {
      flags[index] = DRAWING_PACKED_BOUND_DEFERRED;
      continue;
    }
    horizontalDomains[index] = horizontalDomainCode(bounds.horizontalDomain);
    if (bounds.kind === "unbounded") {
      if (bounds.axis === "horizontal" || bounds.axis === "both") {
        flags[index] = (flags[index] ?? 0) | DRAWING_PACKED_BOUND_UNBOUNDED_HORIZONTAL;
      }
      if (bounds.axis === "vertical" || bounds.axis === "both") {
        flags[index] = (flags[index] ?? 0) | DRAWING_PACKED_BOUND_UNBOUNDED_VERTICAL;
      }
    }
    if (bounds.minHorizontal !== null) minHorizontal[index] = bounds.minHorizontal;
    if (bounds.maxHorizontal !== null) maxHorizontal[index] = bounds.maxHorizontal;
    if (bounds.minPrice !== null) minPrice[index] = bounds.minPrice;
    if (bounds.maxPrice !== null) maxPrice[index] = bounds.maxPrice;
  }

  return Object.freeze({
    count,
    nodeCount: nodes.length,
    nodeIndexes,
    chunkIndexes,
    flags,
    horizontalDomains,
    minHorizontal,
    maxHorizontal,
    minPrice,
    maxPrice,
  });
}

function packedRecordIntersects(
  packed: PackedDrawingSceneBounds,
  index: number,
  viewport: DrawingBoundsViewport,
): boolean {
  const flags = packed.flags[index] ?? 0;
  if ((flags & DRAWING_PACKED_BOUND_DEFERRED) !== 0) return true;
  const horizontalUnbounded = (flags & DRAWING_PACKED_BOUND_UNBOUNDED_HORIZONTAL) !== 0;
  const verticalUnbounded = (flags & DRAWING_PACKED_BOUND_UNBOUNDED_VERTICAL) !== 0;
  const expectedDomain = horizontalDomainCode(viewport.horizontalDomain);
  const actualDomain = packed.horizontalDomains[index] ?? DRAWING_PACKED_DOMAIN_NONE;
  const domainComparable = actualDomain === DRAWING_PACKED_DOMAIN_NONE
    || actualDomain === expectedDomain;
  const recordMinHorizontal = packed.minHorizontal[index] ?? Number.NaN;
  const recordMaxHorizontal = packed.maxHorizontal[index] ?? Number.NaN;
  const recordMinPrice = packed.minPrice[index] ?? Number.NaN;
  const recordMaxPrice = packed.maxPrice[index] ?? Number.NaN;
  const horizontalIntersects = horizontalUnbounded
    || !domainComparable
    || !Number.isFinite(recordMinHorizontal)
    || !Number.isFinite(recordMaxHorizontal)
    || (recordMaxHorizontal >= viewport.minHorizontal
      && recordMinHorizontal <= viewport.maxHorizontal);
  const priceIntersects = verticalUnbounded
    || !Number.isFinite(recordMinPrice)
    || !Number.isFinite(recordMaxPrice)
    || (recordMaxPrice >= viewport.minPrice && recordMinPrice <= viewport.maxPrice);
  return horizontalIntersects && priceIntersects;
}

/**
 * Sequentially scan packed records and return unique node indexes in z-order.
 * A multi-chunk freehand node is emitted once when any chunk intersects.
 */
export function scanPackedDrawingSceneBounds(
  packed: PackedDrawingSceneBounds,
  viewport: DrawingBoundsViewport,
): readonly number[] {
  if (!isValidDrawingBoundsViewport(viewport) || packed.nodeCount === 0) {
    return Object.freeze([]);
  }
  const visible = new Uint8Array(packed.nodeCount);
  for (let index = 0; index < packed.count; index += 1) {
    if (!packedRecordIntersects(packed, index, viewport)) continue;
    const nodeIndex = packed.nodeIndexes[index];
    if (nodeIndex !== undefined && nodeIndex < packed.nodeCount) visible[nodeIndex] = 1;
  }
  const result: number[] = [];
  for (let nodeIndex = 0; nodeIndex < visible.length; nodeIndex += 1) {
    if (visible[nodeIndex] === 1) result.push(nodeIndex);
  }
  return Object.freeze(result);
}

function validDocumentRegistryShape(document: DrawingDocument): string | null {
  if (document.entities.size > MAX_DRAWING_DOCUMENT_ENTITIES
    || document.zOrder.length > MAX_DRAWING_DOCUMENT_ENTITIES) {
    return "drawing scene entity budget exceeded";
  }
  if (document.entities.size !== document.zOrder.length
    || new Set(document.zOrder).size !== document.zOrder.length) {
    return "drawing scene z-order is not a bijection";
  }
  for (const id of document.zOrder) {
    const entity = document.entities.get(id);
    if (!entity || entity.id !== id) return "drawing scene z-order references an invalid entity";
  }
  return null;
}

function geometryChanged(node: DrawingSceneNode, entity: DrawingEntity): boolean {
  return node.entity.kind !== entity.kind
    || node.geometryRevision !== entity.geometryRevision
    || !canonicalDrawingValueEquals(node.entity.geometry, entity.geometry);
}

function reconcileFailure(
  snapshot: DrawingSceneRegistrySnapshot,
  error: unknown,
): DrawingSceneRegistryReconcileFailure {
  return Object.freeze({
    ok: false,
    changed: false,
    error: error instanceof Error ? error.message : String(error),
    snapshot,
  });
}

function unchangedReconcileSuccess(
  snapshot: DrawingSceneRegistrySnapshot,
): DrawingSceneRegistryReconcileSuccess {
  return Object.freeze({
    ok: true,
    changed: false,
    createdNodeCount: 0,
    removedNodeCount: 0,
    recomputedBoundsCount: 0,
    reordered: false,
    snapshot,
  });
}

export function createDrawingSceneRegistry(
  scopeKey: string,
  options: DrawingSceneRegistryOptions = {},
): DrawingSceneRegistry {
  if (typeof scopeKey !== "string") throw new TypeError("drawing scene scope key is invalid");
  const createBounds = options.createBounds ?? createDrawingEntityGeometryBounds;
  let nodes: readonly RetainedDrawingSceneNode[] = Object.freeze([]);
  let byId = new Map<string, RetainedDrawingSceneNode>();
  let packedBounds = frozenEmptyPackedBounds();
  let snapshot = frozenSnapshot(scopeKey, 0, nodes, packedBounds);
  let lastDocument: DrawingDocument | null = null;
  let lastUnchangedResult: DrawingSceneRegistryReconcileSuccess | null = null;

  const registry: DrawingSceneRegistry = {
    scopeKey,
    getNode(id) {
      return byId.get(id) ?? null;
    },
    getSnapshot() {
      return snapshot;
    },
    query(viewport) {
      const indexes = scanPackedDrawingSceneBounds(packedBounds, viewport);
      return Object.freeze(indexes.flatMap((index) => {
        const node = nodes[index];
        return node ? [node] : [];
      }));
    },
    reconcile(document) {
      if (document === lastDocument) {
        lastUnchangedResult ??= unchangedReconcileSuccess(snapshot);
        return lastUnchangedResult;
      }
      if (document.scopeKey !== scopeKey) {
        return reconcileFailure(snapshot, "drawing scene scope does not match the registry");
      }
      const shapeError = validDocumentRegistryShape(document);
      if (shapeError) return reconcileFailure(snapshot, shapeError);

      const pending: PendingNodeUpdate[] = [];
      let recomputedBoundsCount = 0;
      let createdNodeCount = 0;
      try {
        for (let zIndex = 0; zIndex < document.zOrder.length; zIndex += 1) {
          const id = document.zOrder[zIndex];
          const entity = id === undefined ? undefined : document.entities.get(id);
          if (!entity) throw new TypeError("drawing scene entity disappeared during reconcile");
          const existing = byId.get(entity.id);
          const reusable = existing?.entity.kind === entity.kind ? existing : null;
          const recomputed = !reusable || geometryChanged(reusable, entity);
          const styleChanged = !reusable
            || reusable.styleRevision !== entity.styleRevision
            || !canonicalDrawingValueEquals(reusable.entity.style, entity.style);
          const bounds = recomputed ? createBounds(entity) : reusable.bounds;
          if (recomputed) recomputedBoundsCount += 1;
          if (!reusable) createdNodeCount += 1;
          pending.push({
            bounds,
            entity,
            isNew: reusable === null,
            node: reusable ?? new RetainedDrawingSceneNode(entity, bounds, zIndex),
            recomputed,
            styleChanged,
            zIndex,
          });
        }
      } catch (error) {
        return reconcileFailure(snapshot, error);
      }

      const nextNodes = pending.map((entry) => entry.node);
      const nextIds = new Set(document.zOrder);
      const removedNodeCount = [...byId.keys()].filter((id) => !nextIds.has(id)).length;
      const reordered = nodes.length === nextNodes.length
        && nodes.some((node, index) => node.id !== nextNodes[index]?.id);
      const structureChanged = createdNodeCount > 0 || removedNodeCount > 0 || reordered;
      const needsRepack = structureChanged || recomputedBoundsCount > 0;

      for (const entry of pending) {
        entry.node.update(entry.entity, entry.bounds, entry.zIndex);
      }
      nodes = structureChanged
        ? Object.freeze(nextNodes)
        : nodes;
      if (!structureChanged && nodes.length === 0 && nextNodes.length === 0) {
        nodes = Object.freeze([]);
      }
      byId = new Map(nodes.map((node) => [node.id, node] as const));
      if (needsRepack) packedBounds = createPackedDrawingSceneBounds(nodes);
      const changed = snapshot.documentRevision !== document.documentRevision
        || pending.some((entry) => entry.isNew
          || entry.recomputed
          || entry.styleChanged)
        || removedNodeCount > 0
        || reordered;
      snapshot = frozenSnapshot(scopeKey, document.documentRevision, nodes, packedBounds);
      const result: DrawingSceneRegistryReconcileSuccess = Object.freeze({
        ok: true,
        changed,
        createdNodeCount,
        removedNodeCount,
        recomputedBoundsCount,
        reordered,
        snapshot,
      });
      lastDocument = document;
      lastUnchangedResult = changed ? null : result;
      return result;
    },
  };
  return Object.freeze(registry);
}
