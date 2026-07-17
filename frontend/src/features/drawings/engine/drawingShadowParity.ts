import { exportDrawingDocument } from "../core/drawingCodec.js";
import { canonicalDrawingValueEquals } from "../core/drawingDocument.js";
import type { DrawingDocument } from "../core/drawingDocument.js";
import type { DrawingHit, DrawingKind, SavedDrawing } from "../drawingTypes.js";
import {
  hitTestDrawingScreenDisplayList,
  type DrawingDisplayHitResult,
  type DrawingScreenDisplayList,
} from "../rendering/drawingDisplayList.js";

export interface LegacyDrawingLayoutProbe {
  readonly entityId: string;
  readonly kind: DrawingKind;
  readonly visible: boolean;
  readonly bbox: readonly [number, number, number, number] | null;
  readonly handles: Readonly<Float64Array>;
  readonly handleNames: readonly string[];
  readonly unresolvedGapIndexes: readonly number[];
}

export interface DrawingShadowHitProbe {
  readonly x: number;
  readonly y: number;
  readonly selectedId: string | null;
  readonly legacy: Readonly<{
    entityId: string;
    kind: DrawingKind;
    hit: DrawingHit;
  }> | null;
}

export type DrawingShadowParityMismatchKind =
  | "canonical-order"
  | "legacy-order"
  | "visible-set"
  | "bbox"
  | "handles"
  | "hit"
  | "serialized"
  | "unresolved-gap"
  | "missing-probe";

export interface DrawingShadowParityMismatch {
  readonly kind: DrawingShadowParityMismatchKind;
  readonly entityId?: string;
  readonly detail: string;
}

export interface DrawingShadowParityResult {
  readonly ok: boolean;
  readonly comparedEntityCount: number;
  readonly comparedHitCount: number;
  readonly mismatches: readonly DrawingShadowParityMismatch[];
}

export interface CompareDrawingShadowParityOptions {
  readonly document: DrawingDocument;
  readonly plan: DrawingScreenDisplayList;
  /** Full retained scene order before viewport culling. */
  readonly sceneCanonicalIds: readonly string[];
  /** One fresh serialization sample in primitive z-order from the legacy probe. */
  readonly legacySerializedDrawings: readonly SavedDrawing[];
  readonly legacyLayouts: readonly LegacyDrawingLayoutProbe[];
  readonly hitProbes?: readonly DrawingShadowHitProbe[];
  /** Full-source gaps sampled from the same frame for visible long strokes. */
  readonly sceneCanonicalGapIndexes?: ReadonlyMap<string, Readonly<Uint32Array>>;
  readonly bboxTolerancePx?: number;
  readonly handleTolerancePx?: number;
}

// DrawingDocument snapshots are immutable. The benchmark and production
// sampler compare the same revision repeatedly, so rebuilding and measuring
// the complete legacy JSON payload on every parity tick is pure duplicate
// work. Weak keys avoid retaining superseded document revisions.
const serializedDocumentCache = new WeakMap<DrawingDocument, readonly SavedDrawing[] | null>();

function serializedDocument(document: DrawingDocument): readonly SavedDrawing[] | null {
  if (serializedDocumentCache.has(document)) {
    return serializedDocumentCache.get(document) ?? null;
  }
  const exported = exportDrawingDocument(document);
  const cached = exported ? Object.freeze(exported) : null;
  serializedDocumentCache.set(document, cached);
  return cached;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function finiteTolerance(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function planBboxNear(
  plan: DrawingScreenDisplayList,
  entityIndex: number,
  legacy: readonly number[] | null,
  tolerance: number,
): boolean {
  const offset = entityIndex * 4;
  const first = plan.bboxes[offset];
  const second = plan.bboxes[offset + 1];
  const third = plan.bboxes[offset + 2];
  const fourth = plan.bboxes[offset + 3];
  const finite = Number.isFinite(first)
    && Number.isFinite(second)
    && Number.isFinite(third)
    && Number.isFinite(fourth);
  if (!finite || legacy === null) return !finite && legacy === null;
  return legacy.length === 4
    && Math.abs(Number(first) - Number(legacy[0])) <= tolerance
    && Math.abs(Number(second) - Number(legacy[1])) <= tolerance
    && Math.abs(Number(third) - Number(legacy[2])) <= tolerance
    && Math.abs(Number(fourth) - Number(legacy[3])) <= tolerance;
}

function nearBufferRange(
  left: Readonly<Float64Array>,
  leftOffset: number,
  leftLength: number,
  right: Readonly<Float64Array>,
  tolerance: number,
): boolean {
  if (leftLength !== right.length || leftOffset < 0 || leftOffset + leftLength > left.length) {
    return false;
  }
  for (let index = 0; index < leftLength; index += 1) {
    const a = left[leftOffset + index];
    const b = right[index];
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(Number(a) - Number(b)) > tolerance) {
      return false;
    }
  }
  return true;
}

function sameNumberRange(
  left: ArrayLike<number>,
  leftOffset: number,
  leftLength: number,
  right: ArrayLike<number>,
): boolean {
  if (leftLength !== right.length || leftOffset < 0 || leftOffset + leftLength > left.length) {
    return false;
  }
  for (let index = 0; index < leftLength; index += 1) {
    if (Number(left[leftOffset + index]) !== Number(right[index])) return false;
  }
  return true;
}

function normalizedHit(hit: DrawingDisplayHitResult | null): unknown {
  if (!hit) return null;
  return {
    entityId: hit.entityId,
    kind: hit.kind,
    ...(hit.zone === undefined ? {} : { zone: hit.zone }),
    ...(hit.handle === undefined ? {} : { handle: hit.handle }),
    ...(hit.pointIndex === undefined ? {} : { pointIndex: hit.pointIndex }),
    ...(hit.body === undefined ? {} : { body: hit.body }),
  };
}

function normalizedLegacyHit(probe: DrawingShadowHitProbe["legacy"]): unknown {
  if (!probe) return null;
  return {
    entityId: probe.entityId,
    kind: probe.kind,
    ...(probe.hit.zone === undefined ? {} : { zone: probe.hit.zone }),
    ...(probe.hit.handle === undefined ? {} : { handle: probe.hit.handle }),
    ...(probe.hit.pointIndex === undefined ? {} : { pointIndex: probe.hit.pointIndex }),
    ...(probe.hit.body === undefined ? {} : { body: probe.hit.body }),
  };
}

/** Strict, side-effect-free comparison; it never persists or touches a surface. */
export function compareDrawingShadowParity({
  document,
  plan,
  sceneCanonicalIds,
  legacySerializedDrawings,
  legacyLayouts,
  hitProbes = [],
  sceneCanonicalGapIndexes,
  bboxTolerancePx = 0.5,
  handleTolerancePx = 0.25,
}: CompareDrawingShadowParityOptions): DrawingShadowParityResult {
  const bboxTolerance = finiteTolerance(bboxTolerancePx, 0.5);
  const handleTolerance = finiteTolerance(handleTolerancePx, 0.25);
  const mismatches: DrawingShadowParityMismatch[] = [];
  const planIds = plan.entities.map((entity) => entity.id);
  if (!sameStrings(document.zOrder, sceneCanonicalIds)) {
    mismatches.push({ kind: "canonical-order", detail: "document and scene ids/z-order differ" });
  }
  const legacyIds = legacySerializedDrawings.flatMap((drawing) => (
    typeof drawing.id === "string" ? [drawing.id] : []
  ));
  if (!sameStrings(document.zOrder, legacyIds)) {
    mismatches.push({ kind: "legacy-order", detail: "document and legacy ids/z-order differ" });
  }

  const documentSerialization = serializedDocument(document);
  if (!documentSerialization
    || !canonicalDrawingValueEquals(documentSerialization, legacySerializedDrawings)) {
    mismatches.push({ kind: "serialized", detail: "normalized SavedDrawing output differs" });
  }

  const layoutById = new Map(legacyLayouts.map((layout) => [layout.entityId, layout] as const));
  const legacyVisible = legacyLayouts.filter((layout) => layout.visible).map((layout) => layout.entityId);
  if (!sameStrings(planIds, legacyVisible)) {
    mismatches.push({ kind: "visible-set", detail: "visible entity set differs" });
  }

  plan.entities.forEach((entity, entityIndex) => {
    const legacy = layoutById.get(entity.id);
    if (!legacy) {
      mismatches.push({ kind: "missing-probe", entityId: entity.id, detail: "legacy layout probe missing" });
      return;
    }
    if (!planBboxNear(plan, entityIndex, legacy.bbox, bboxTolerance)) {
      mismatches.push({ kind: "bbox", entityId: entity.id, detail: "screen bbox exceeds tolerance" });
    }
    if (!sameStrings(entity.handleNames, legacy.handleNames)
      || !nearBufferRange(
        plan.handles,
        entity.handleOffset * 2,
        entity.handleCount * 2,
        legacy.handles,
        handleTolerance,
      )) {
      mismatches.push({ kind: "handles", entityId: entity.id, detail: "handle layout exceeds tolerance" });
    }
    const canonicalGaps = sceneCanonicalGapIndexes?.get(entity.id);
    const gapMatches = canonicalGaps
      ? sameNumberRange(canonicalGaps, 0, canonicalGaps.length, legacy.unresolvedGapIndexes)
      : sameNumberRange(
        plan.unresolvedSourcePointIndexes,
        entity.unresolvedGapOffset,
        entity.unresolvedGapCount,
        legacy.unresolvedGapIndexes,
      );
    if (!gapMatches) {
      mismatches.push({
        kind: "unresolved-gap",
        entityId: entity.id,
        detail: "unresolved path gap indexes differ",
      });
    }
  });

  for (const probe of hitProbes) {
    const sceneHit = hitTestDrawingScreenDisplayList(
      plan,
      probe.x,
      probe.y,
      probe.selectedId,
    );
    if (!canonicalDrawingValueEquals(normalizedHit(sceneHit), normalizedLegacyHit(probe.legacy))) {
      mismatches.push({ kind: "hit", detail: `hit result differs at ${probe.x},${probe.y}` });
    }
  }

  return Object.freeze({
    ok: mismatches.length === 0,
    comparedEntityCount: plan.entities.length,
    comparedHitCount: hitProbes.length,
    mismatches: Object.freeze(mismatches.map((mismatch) => Object.freeze(mismatch))),
  });
}
