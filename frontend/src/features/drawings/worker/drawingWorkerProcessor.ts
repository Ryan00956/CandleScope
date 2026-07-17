import {
  DRAWING_WORKER_SCHEMA_VERSION,
  HARD_DRAWING_WORKER_MAX_RESULT_BYTES,
  drawingWorkerResponseTransferables,
  drawingWorkerViewportByteLength,
  isDrawingWorkerJobHeader,
  isDrawingWorkerRequest,
  releaseDrawingWorkerDrawResult,
  type DrawingWorkerEntityPatch,
  type DrawingWorkerBitmapLayer,
  type DrawingWorkerErrorResponse,
  type DrawingWorkerFreehandPaintSpec,
  type DrawingWorkerJobHeader,
  type DrawingWorkerBitmapDrawResult,
  type DrawingWorkerRenderRequest,
  type DrawingWorkerRequest,
  type DrawingWorkerResponse,
  type DrawingWorkerTypedDrawResult,
} from "./drawingWorkerProtocol.js";
import type { DrawingKind } from "../drawingTypes.js";
import {
  createDrawingLodHierarchy,
  type DrawingLodHierarchy,
} from "../geometry/drawingLod.js";

interface DrawingWorkerLodMirror {
  readonly hierarchies: readonly DrawingLodHierarchy[];
  readonly finitePointCount: number;
  readonly gapPointCount: number;
  readonly pathCount: number;
  readonly endpointPointCount: number;
}

interface DrawingWorkerScreenLodMirror {
  readonly cacheKey: string;
  readonly lod: DrawingWorkerLodMirror;
}

function sumLodMetric(
  mirrors: readonly DrawingWorkerLodMirror[],
  key: Exclude<keyof DrawingWorkerLodMirror, "hierarchies">,
): number {
  return mirrors.reduce((sum, mirror) => sum + mirror[key], 0);
}

interface DrawingWorkerMirrorEntity {
  readonly entityId: string;
  readonly kind: DrawingKind;
  readonly documentRevision: number;
  readonly geometryRevision: number;
  readonly styleRevision: number;
  readonly canonicalPoints: Float64Array;
  readonly pathBreaks: Uint32Array;
  /** Nested topology only; canonical coordinates remain authoritative and immutable. */
  readonly canonicalLod: DrawingWorkerLodMirror | null;
}

interface DrawingWorkerMirrorScope {
  documentRevision: number;
  renderedPointCount: number;
  paintedEntityCount: number;
  lodHierarchyBuildCount: number;
  screenLodHierarchyBuildCount: number;
  screenLodHierarchyReuseCount: number;
  readonly entities: Map<string, DrawingWorkerMirrorEntity>;
  readonly entityDocumentRevisions: Map<string, number>;
  readonly screenLodEntities: Map<string, DrawingWorkerScreenLodMirror>;
}

export interface DrawingWorkerProcessorSnapshot {
  readonly cancelledThroughGeneration: number;
  readonly scopes: readonly Readonly<{
    scopeKey: string;
    documentRevision: number;
    entityIds: readonly string[];
    canonicalPointCount: number;
    lodEntityCount: number;
    lodFinitePointCount: number;
    lodGapPointCount: number;
    lodPathCount: number;
    lodEndpointPointCount: number;
    lodHierarchyBuildCount: number;
    screenLodEntityCount: number;
    screenLodFinitePointCount: number;
    screenLodGapPointCount: number;
    screenLodPathCount: number;
    screenLodEndpointPointCount: number;
    screenLodHierarchyBuildCount: number;
    screenLodHierarchyReuseCount: number;
    renderedPointCount: number;
    paintedEntityCount: number;
  }>[];
}

/** Minimal canvas contracts keep worker raster tests independent from browser globals. */
export interface DrawingWorkerRasterContext {
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  lineWidth: number;
  globalCompositeOperation: GlobalCompositeOperation;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
  save(): void;
  restore(): void;
  beginPath(): void;
  rect(x: number, y: number, width: number, height: number): void;
  clip(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  stroke(): void;
}

export interface DrawingWorkerRasterSurface {
  getContext(contextId: "2d"): DrawingWorkerRasterContext | null;
  transferToImageBitmap(): ImageBitmap;
}

export interface DrawingWorkerProcessorOptions {
  postMessage(message: DrawingWorkerResponse, transferables: Transferable[]): void;
  /** Cooperative event-loop yield, injected by tests and worker runtimes. */
  yieldControl?: () => Promise<void>;
  maxAllowedResultBytes?: number;
  /** Injectable for deterministic Node tests; omission probes global OffscreenCanvas. */
  offscreenCanvasFactory?: (
    widthPhysicalPx: number,
    heightPhysicalPx: number,
  ) => DrawingWorkerRasterSurface | null;
}

export interface DrawingWorkerProcessor {
  handleMessage(message: unknown): Promise<boolean>;
  snapshot(): DrawingWorkerProcessorSnapshot;
}

function defaultYieldControl(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function defaultOffscreenCanvasFactory(
  widthPhysicalPx: number,
  heightPhysicalPx: number,
): DrawingWorkerRasterSurface | null {
  if (typeof OffscreenCanvas !== "function") return null;
  return new OffscreenCanvas(widthPhysicalPx, heightPhysicalPx) as unknown as DrawingWorkerRasterSurface;
}

const MAX_ENTITIES_PER_YIELD = 16;
const MAX_PATHS_PER_YIELD = 16;
const MAX_SEGMENTS_PER_YIELD = 1_024;
const MAX_BITMAP_ATLAS_DIMENSION = 8_192;
const MIN_TILE_ANTIALIAS_PADDING_PHYSICAL_PX = 2;

function paintPaddingPhysicalPx(
  paintSpec: DrawingWorkerFreehandPaintSpec,
  dpr: number,
): number {
  const halfStrokePhysicalPx = paintSpec.lineWidthCssPx * dpr / 2;
  // A square cap can expose the half-stroke diagonal on an arbitrary segment;
  // round caps/joins stay within the radius. Two extra physical pixels retain
  // antialias coverage before the tile is composited back into the pane.
  const capAndJoinExtent = paintSpec.brushShape === "square"
    ? halfStrokePhysicalPx * Math.SQRT2
    : halfStrokePhysicalPx;
  return Math.ceil(capAndJoinExtent) + MIN_TILE_ANTIALIAS_PADDING_PHYSICAL_PX;
}

function isLodKind(kind: DrawingKind): boolean {
  return kind === "freehand" || kind === "highlighter";
}

function sameCanonicalPoints(left: Float64Array, right: Float64Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === rightValue
      || (Number.isNaN(leftValue) && Number.isNaN(rightValue))) continue;
    return false;
  }
  return true;
}

function samePathBreaks(left: Uint32Array, right: Uint32Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function createMirrorScope(): DrawingWorkerMirrorScope {
  return {
    documentRevision: 0,
    renderedPointCount: 0,
    paintedEntityCount: 0,
    lodHierarchyBuildCount: 0,
    screenLodHierarchyBuildCount: 0,
    screenLodHierarchyReuseCount: 0,
    entities: new Map(),
    entityDocumentRevisions: new Map(),
    screenLodEntities: new Map(),
  };
}

interface DrawingWorkerContinuousRun {
  readonly startPointIndex: number;
  readonly endPointIndex: number;
}

/** Split on both retained non-finite gaps and explicit path-start indexes. */
function continuousRuns(
  coordinates: Float64Array,
  pathBreaks: Uint32Array,
): readonly DrawingWorkerContinuousRun[] {
  const pointCount = coordinates.length / 2;
  const breaks = new Set<number>(pathBreaks);
  const runs: DrawingWorkerContinuousRun[] = [];
  let runStart = -1;
  for (let pointIndex = 0; pointIndex <= pointCount; pointIndex += 1) {
    const offset = pointIndex * 2;
    const finite = pointIndex < pointCount
      && Number.isFinite(coordinates[offset])
      && Number.isFinite(coordinates[offset + 1]);
    const forcedBreak = finite && breaks.has(pointIndex);
    if ((pointIndex === pointCount || !finite || forcedBreak) && runStart >= 0) {
      runs.push(Object.freeze({ startPointIndex: runStart, endPointIndex: pointIndex }));
      runStart = -1;
    }
    if (finite && runStart < 0) runStart = pointIndex;
  }
  return Object.freeze(runs);
}

async function buildLodMirror(
  coordinates: Float64Array,
  pathBreaks: Uint32Array,
  yieldControl: () => Promise<void>,
  isCancelled: () => boolean,
): Promise<DrawingWorkerLodMirror | "cancelled"> {
  const runs = continuousRuns(coordinates, pathBreaks);
  const hierarchies: DrawingLodHierarchy[] = [];
  let finitePointCount = 0;
  let endpointPointCount = 0;
  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const run = runs[runIndex];
    if (!run) continue;
    if (isCancelled()) return "cancelled";
    const hierarchy = createDrawingLodHierarchy(coordinates.slice(
      run.startPointIndex * 2,
      run.endPointIndex * 2,
    ));
    hierarchies.push(hierarchy);
    finitePointCount += hierarchy.finitePointCount;
    endpointPointCount += hierarchy.finitePointCount > 1 ? 2 : hierarchy.finitePointCount;
    // A worker cancellation message can run between continuous paths. Do not
    // yield after the final path here: entity-level callers batch that boundary
    // so 64 ordinary one-path strokes do not each pay a timer turn twice.
    if (runIndex + 1 < runs.length) {
      await yieldControl();
      if (isCancelled()) return "cancelled";
    }
  }
  return Object.freeze({
    hierarchies: Object.freeze(hierarchies),
    finitePointCount,
    gapPointCount: coordinates.length / 2 - finitePointCount,
    pathCount: hierarchies.length,
    endpointPointCount,
  });
}

function screenLodCacheKey(
  request: DrawingWorkerRenderRequest,
  entityIndex: number,
): string {
  const { stamp } = request.header;
  const viewport = request.viewport;
  const pointOffset = Number(viewport.pointOffsets[entityIndex]);
  const pointCount = Number(viewport.pointCounts[entityIndex]);
  const breakOffset = Number(viewport.pathBreakOffsets[entityIndex]);
  const breakCount = Number(viewport.pathBreakCounts[entityIndex]);
  return [
    stamp.documentRevision,
    stamp.surfaceGeneration,
    stamp.dataRevision,
    stamp.projectionRevision,
    stamp.lineageIndexRevision,
    stamp.viewportRevision,
    stamp.widthCssPx,
    stamp.heightCssPx,
    stamp.dpr,
    entityIndex,
    pointOffset,
    pointCount,
    breakOffset,
    breakCount,
  ].join(":");
}

/**
 * Owns the worker-side canonical mirror and processes one final screen payload.
 * The client guarantees one render job in flight; cancellation messages can
 * run while this processor yields at entity/path boundaries.
 */
export function createDrawingWorkerProcessor({
  postMessage,
  yieldControl = defaultYieldControl,
  maxAllowedResultBytes = HARD_DRAWING_WORKER_MAX_RESULT_BYTES,
  offscreenCanvasFactory = defaultOffscreenCanvasFactory,
}: DrawingWorkerProcessorOptions): DrawingWorkerProcessor {
  if (!Number.isSafeInteger(maxAllowedResultBytes)
    || maxAllowedResultBytes <= 0
    || maxAllowedResultBytes > HARD_DRAWING_WORKER_MAX_RESULT_BYTES) {
    throw new TypeError("drawing worker result byte limit is invalid");
  }
  const scopes = new Map<string, DrawingWorkerMirrorScope>();
  let cancelledThroughGeneration = 0;

  const publish = (response: DrawingWorkerResponse): void => {
    try {
      postMessage(response, drawingWorkerResponseTransferables(response));
    } catch (error) {
      // Ownership transfers only after postMessage succeeds. A failed clone or
      // terminated port leaves the result in this worker, so release its bitmap
      // or typed buffers deterministically before the caller reports the error.
      if (response.type === "drawing-worker/result") {
        releaseDrawingWorkerDrawResult(response.result);
      }
      throw error;
    }
  };

  const publishError = (
    header: DrawingWorkerJobHeader,
    code: DrawingWorkerErrorResponse["code"],
    message: string,
  ): void => {
    publish({
      type: "drawing-worker/error",
      header,
      code,
      message: message.slice(0, 240),
    });
  };

  const isCancelled = (generation: number): boolean => (
    generation <= cancelledThroughGeneration
  );

  const scopeFor = (scopeKey: string): DrawingWorkerMirrorScope => {
    let scope = scopes.get(scopeKey);
    if (!scope) {
      scope = createMirrorScope();
      scopes.set(scopeKey, scope);
    }
    return scope;
  };

  const applyPatches = (patches: readonly DrawingWorkerEntityPatch[]): void => {
    for (const patch of patches) {
      const scope = scopeFor(patch.scopeKey);
      const previousEntityRevision = scope.entityDocumentRevisions.get(patch.entityId) ?? -1;
      if (patch.documentRevision < previousEntityRevision) continue;
      scope.documentRevision = Math.max(scope.documentRevision, patch.documentRevision);
      scope.entityDocumentRevisions.set(patch.entityId, patch.documentRevision);
      if (patch.op === "delete") {
        scope.entities.delete(patch.entityId);
        scope.screenLodEntities.delete(patch.entityId);
        continue;
      }
      const previous = scope.entities.get(patch.entityId);
      const canonicalLod = previous
        && previous.kind === patch.kind
        && previous.geometryRevision === patch.geometryRevision
        && sameCanonicalPoints(previous.canonicalPoints, patch.canonicalPoints)
        && samePathBreaks(previous.pathBreaks, patch.pathBreaks)
        ? previous.canonicalLod
        : null;
      scope.entities.set(patch.entityId, Object.freeze({
        entityId: patch.entityId,
        kind: patch.kind,
        documentRevision: patch.documentRevision,
        geometryRevision: patch.geometryRevision,
        styleRevision: patch.styleRevision,
        canonicalPoints: patch.canonicalPoints,
        pathBreaks: patch.pathBreaks,
        canonicalLod,
      }));
    }
  };

  const ensureCanonicalLodMirrors = async (
    scope: DrawingWorkerMirrorScope,
    generation: number,
  ): Promise<boolean> => {
    let entitiesSinceYield = 0;
    for (const [entityId, entity] of scope.entities) {
      if (!isLodKind(entity.kind) || entity.canonicalLod) continue;
      if (isCancelled(generation)) return false;
      const lod = await buildLodMirror(
        entity.canonicalPoints,
        entity.pathBreaks,
        yieldControl,
        () => isCancelled(generation),
      );
      if (lod === "cancelled") return false;
      // Render processing is single-flight; preserve the patch buffers exactly
      // and attach only derived hierarchy metadata.
      if (scope.entities.get(entityId) === entity) {
        scope.entities.set(entityId, Object.freeze({ ...entity, canonicalLod: lod }));
        scope.lodHierarchyBuildCount += 1;
      }
      entitiesSinceYield += 1;
      if (entitiesSinceYield >= MAX_ENTITIES_PER_YIELD) {
        entitiesSinceYield = 0;
        await yieldControl();
        if (isCancelled(generation)) return false;
      }
    }
    // Empty/gap-only entities and a short final batch have no internal path
    // checkpoint of their own.
    if (entitiesSinceYield > 0) {
      await yieldControl();
      if (isCancelled(generation)) return false;
    }
    return true;
  };

  const updateScreenLodMirrors = async (
    scope: DrawingWorkerMirrorScope,
    request: DrawingWorkerRenderRequest,
  ): Promise<boolean> => {
    const { header, viewport } = request;
    const next = new Map<string, DrawingWorkerScreenLodMirror>();
    let entitiesSinceYield = 0;
    for (let entityIndex = 0; entityIndex < viewport.entityIds.length; entityIndex += 1) {
      const kindCode = Number(viewport.kindCodes[entityIndex]);
      if (kindCode !== 8 && kindCode !== 9) continue;
      if (isCancelled(header.generation)) return false;
      const entityId = viewport.entityIds[entityIndex];
      if (entityId === undefined) continue;
      const pointOffset = Number(viewport.pointOffsets[entityIndex]);
      const pointCount = Number(viewport.pointCounts[entityIndex]);
      const breakOffset = Number(viewport.pathBreakOffsets[entityIndex]);
      const breakCount = Number(viewport.pathBreakCounts[entityIndex]);
      const cacheKey = screenLodCacheKey(request, entityIndex);
      const cached = scope.screenLodEntities.get(entityId);
      if (cached?.cacheKey === cacheKey) {
        next.set(entityId, cached);
        scope.screenLodHierarchyReuseCount += 1;
      } else {
        const coordinates = viewport.points.slice(
          pointOffset * 2,
          (pointOffset + pointCount) * 2,
        );
        const pathBreaks = new Uint32Array(breakCount);
        for (let index = 0; index < breakCount; index += 1) {
          pathBreaks[index] = Number(viewport.pathBreaks[breakOffset + index]) - pointOffset;
        }
        const lod = await buildLodMirror(
          coordinates,
          pathBreaks,
          yieldControl,
          () => isCancelled(header.generation),
        );
        if (lod === "cancelled") return false;
        next.set(entityId, Object.freeze({ cacheKey, lod }));
        scope.screenLodHierarchyBuildCount += 1;
      }
      entitiesSinceYield += 1;
      if (entitiesSinceYield >= MAX_ENTITIES_PER_YIELD) {
        entitiesSinceYield = 0;
        await yieldControl();
        if (isCancelled(header.generation)) return false;
      }
    }
    if (entitiesSinceYield > 0) {
      await yieldControl();
      if (isCancelled(header.generation)) return false;
    }
    scope.screenLodEntities.clear();
    for (const [entityId, lod] of next) scope.screenLodEntities.set(entityId, lod);
    return true;
  };

  const processRender = async (request: DrawingWorkerRenderRequest): Promise<void> => {
    const { header, viewport } = request;
    try {
      applyPatches(request.patches);
      const byteLength = drawingWorkerViewportByteLength(viewport);
      if (byteLength > maxAllowedResultBytes || byteLength > request.maxResultBytes) {
        publishError(header, "result-too-large", "drawing worker result exceeds byte budget");
        return;
      }

      // Yield after mirror mutation so an already queued cancellation becomes
      // observable before expensive per-entity/path inspection begins.
      await yieldControl();
      if (isCancelled(header.generation)) {
        publish({ type: "drawing-worker/cancelled", header });
        return;
      }

      const mirrorScope = scopeFor(header.stamp.scopeKey);
      mirrorScope.documentRevision = Math.max(
        mirrorScope.documentRevision,
        header.stamp.documentRevision,
      );
      if (!await ensureCanonicalLodMirrors(mirrorScope, header.generation)
        || !await updateScreenLodMirrors(mirrorScope, request)) {
        publish({ type: "drawing-worker/cancelled", header });
        return;
      }
      let rawPointCount = 0;
      for (let entityIndex = 0; entityIndex < viewport.entityIds.length; entityIndex += 1) {
        const entityId = viewport.entityIds[entityIndex];
        const mirrored = entityId === undefined ? undefined : mirrorScope?.entities.get(entityId);
        rawPointCount += mirrored
          ? mirrored.canonicalPoints.length / 2
          : Number(viewport.pointCounts[entityIndex] ?? 0);
      }

      const renderedPointCount = viewport.points.length / 2;
      mirrorScope.renderedPointCount = renderedPointCount;
      mirrorScope.paintedEntityCount = viewport.paintSpecs.length;

      const bitmapResult = await paintBitmapResult(
        request,
        rawPointCount,
        mirrorScope.entities.size,
        offscreenCanvasFactory,
        yieldControl,
        () => isCancelled(header.generation),
        maxAllowedResultBytes,
      );
      if (bitmapResult === "cancelled") {
        publish({ type: "drawing-worker/cancelled", header });
        return;
      }
      if (bitmapResult) {
        publish({ type: "drawing-worker/result", header, result: bitmapResult });
        return;
      }

      const result: DrawingWorkerTypedDrawResult = {
        kind: "typed-draw-result",
        widthCssPx: viewport.widthCssPx,
        heightCssPx: viewport.heightCssPx,
        dpr: viewport.dpr,
        entityIds: viewport.entityIds,
        kindCodes: viewport.kindCodes,
        pointOffsets: viewport.pointOffsets,
        pointCounts: viewport.pointCounts,
        points: viewport.points,
        bboxes: viewport.bboxes,
        pathBreakOffsets: viewport.pathBreakOffsets,
        pathBreakCounts: viewport.pathBreakCounts,
        pathBreaks: viewport.pathBreaks,
        paintSpecs: viewport.paintSpecs,
        byteLength,
        rawPointCount,
        renderedPointCount,
        canonicalEntityCount: mirrorScope.entities.size,
      };
      publish({ type: "drawing-worker/result", header, result });
    } catch (error) {
      publishError(
        header,
        "processing-failed",
        error instanceof Error ? error.message : "drawing worker processing failed",
      );
    }
  };

  const handleMessage = async (message: unknown): Promise<boolean> => {
    if (!isDrawingWorkerRequest(message)) {
      const candidate = message as { readonly header?: unknown } | null;
      if (isDrawingWorkerJobHeader(candidate?.header)) {
        publishError(candidate.header, "invalid-request", "drawing worker request is invalid");
      }
      return false;
    }
    const request: DrawingWorkerRequest = message;
    if (request.type === "drawing-worker/cancel") {
      cancelledThroughGeneration = Math.max(
        cancelledThroughGeneration,
        request.throughGeneration,
      );
      return true;
    }
    await processRender(request);
    return true;
  };

  return Object.freeze({
    handleMessage,
    snapshot(): DrawingWorkerProcessorSnapshot {
      return Object.freeze({
        cancelledThroughGeneration,
        scopes: Object.freeze(Array.from(scopes, ([scopeKey, scope]) => {
          const entities = Array.from(scope.entities.values());
          const canonicalLods = entities.flatMap((entity) => (
            entity.canonicalLod ? [entity.canonicalLod] : []
          ));
          const screenLods = Array.from(scope.screenLodEntities.values(), ({ lod }) => lod);
          return Object.freeze({
            scopeKey,
            documentRevision: scope.documentRevision,
            entityIds: Object.freeze([...scope.entities.keys()].sort()),
            canonicalPointCount: entities.reduce(
              (sum, entity) => sum + entity.canonicalPoints.length / 2,
              0,
            ),
            lodEntityCount: canonicalLods.length,
            lodFinitePointCount: sumLodMetric(canonicalLods, "finitePointCount"),
            lodGapPointCount: sumLodMetric(canonicalLods, "gapPointCount"),
            lodPathCount: sumLodMetric(canonicalLods, "pathCount"),
            lodEndpointPointCount: sumLodMetric(canonicalLods, "endpointPointCount"),
            lodHierarchyBuildCount: scope.lodHierarchyBuildCount,
            screenLodEntityCount: screenLods.length,
            screenLodFinitePointCount: sumLodMetric(screenLods, "finitePointCount"),
            screenLodGapPointCount: sumLodMetric(screenLods, "gapPointCount"),
            screenLodPathCount: sumLodMetric(screenLods, "pathCount"),
            screenLodEndpointPointCount: sumLodMetric(screenLods, "endpointPointCount"),
            screenLodHierarchyBuildCount: scope.screenLodHierarchyBuildCount,
            screenLodHierarchyReuseCount: scope.screenLodHierarchyReuseCount,
            renderedPointCount: scope.renderedPointCount,
            paintedEntityCount: scope.paintedEntityCount,
          });
        })),
      });
    },
  });
}

export const DRAWING_WORKER_PROCESSOR_SCHEMA_VERSION = DRAWING_WORKER_SCHEMA_VERSION;

async function paintBitmapResult(
  request: DrawingWorkerRenderRequest,
  rawPointCount: number,
  canonicalEntityCount: number,
  offscreenCanvasFactory: NonNullable<DrawingWorkerProcessorOptions["offscreenCanvasFactory"]>,
  yieldControl: () => Promise<void>,
  isCancelled: () => boolean,
  maxAllowedResultBytes: number,
): Promise<DrawingWorkerBitmapDrawResult | "cancelled" | null> {
  const { viewport } = request;
  if (viewport.paintSpecs.length === 0) return null;
  const atlas = layoutBitmapAtlas(
    viewport,
    Math.min(
      request.maxResultBytes,
      maxAllowedResultBytes,
      HARD_DRAWING_WORKER_MAX_RESULT_BYTES,
    ),
  );
  if (!atlas) return null;
  let surface: DrawingWorkerRasterSurface | null;
  try {
    surface = offscreenCanvasFactory(atlas.widthPhysicalPx, atlas.heightPhysicalPx);
  } catch {
    return null;
  }
  if (!surface) return null;
  let context: DrawingWorkerRasterContext | null;
  try {
    context = surface.getContext("2d");
  } catch {
    return null;
  }
  if (!context) return null;

  let entitiesSinceYield = 0;
  let pathsSinceYield = 0;
  let segmentsSinceYield = 0;
  const checkpoint = async (force = false): Promise<boolean> => {
    if (!force
      && entitiesSinceYield < MAX_ENTITIES_PER_YIELD
      && pathsSinceYield < MAX_PATHS_PER_YIELD
      && segmentsSinceYield < MAX_SEGMENTS_PER_YIELD) return false;
    entitiesSinceYield = 0;
    pathsSinceYield = 0;
    segmentsSinceYield = 0;
    await yieldControl();
    return isCancelled();
  };
  if (await checkpoint(true)) return "cancelled";

  for (const tile of atlas.tiles) {
    if (isCancelled()) return "cancelled";
    context.save();
    try {
      context.beginPath();
      context.rect(
        tile.sourceXPhysicalPx,
        tile.sourceYPhysicalPx,
        tile.sourceWidthPhysicalPx,
        tile.sourceHeightPhysicalPx,
      );
      context.clip();
      for (const paintSpec of tile.paintSpecs) {
        const entityIndex = paintSpec.entityIndex;
        const start = Number(viewport.pointOffsets[entityIndex] ?? 0);
        const end = start + Number(viewport.pointCounts[entityIndex] ?? 0);
        const breakOffset = Number(viewport.pathBreakOffsets[entityIndex] ?? 0);
        const breakCount = Number(viewport.pathBreakCounts[entityIndex] ?? 0);
        const breaks = new Set<number>();
        for (let index = 0; index < breakCount; index += 1) {
          breaks.add(Number(viewport.pathBreaks[breakOffset + index]));
        }
        applyPaintSpec(context, paintSpec, viewport.dpr);
        context.beginPath();
        let traced = false;
        let runStart = -1;
        for (let pointIndex = start; pointIndex <= end; pointIndex += 1) {
          const forcedBreak = pointIndex < end && breaks.has(pointIndex);
          const finite = pointIndex < end && finitePoint(viewport.points, pointIndex);
          if ((!finite || forcedBreak) && runStart >= 0) {
            const traceResult = await traceFreehandRun(
              context,
              viewport.points,
              runStart,
              pointIndex,
              viewport.dpr,
              tile.sourceXPhysicalPx - tile.destinationXCssPx * viewport.dpr,
              tile.sourceYPhysicalPx - tile.destinationYCssPx * viewport.dpr,
              paintSpec.brushShape === "square" || paintSpec.pathInterpolation === "linear",
              () => {
                segmentsSinceYield += 1;
                return segmentsSinceYield >= MAX_SEGMENTS_PER_YIELD ? checkpoint() : null;
              },
            );
            if (traceResult === "cancelled") return "cancelled";
            traced = traceResult || traced;
            pathsSinceYield += 1;
            runStart = -1;
            if (await checkpoint()) return "cancelled";
          }
          if (finite && runStart < 0) runStart = pointIndex;
        }
        if (traced) context.stroke();
        entitiesSinceYield += 1;
        if (await checkpoint()) return "cancelled";
      }
    } finally {
      context.restore();
    }
  }
  if (await checkpoint(true)) return "cancelled";
  try {
    return {
      kind: "bitmap-draw-result",
      bitmap: surface.transferToImageBitmap(),
      widthCssPx: viewport.widthCssPx,
      heightCssPx: viewport.heightCssPx,
      dpr: viewport.dpr,
      atlasWidthPhysicalPx: atlas.widthPhysicalPx,
      atlasHeightPhysicalPx: atlas.heightPhysicalPx,
      byteLength: atlas.byteLength,
      layers: Object.freeze(atlas.tiles.map(toBitmapLayer)),
      rawPointCount,
      renderedPointCount: viewport.points.length / 2,
      canonicalEntityCount,
    };
  } catch {
    return null;
  }
}

interface DrawingWorkerAtlasTile extends DrawingWorkerBitmapLayer {
  readonly paintSpecs: readonly DrawingWorkerFreehandPaintSpec[];
}

interface DrawingWorkerAtlasLayout {
  readonly widthPhysicalPx: number;
  readonly heightPhysicalPx: number;
  readonly byteLength: number;
  readonly tiles: readonly DrawingWorkerAtlasTile[];
}

interface DrawingWorkerUnplacedTile {
  readonly entityIndex: number;
  readonly lastEntityIndex: number;
  readonly paintSpecs: readonly DrawingWorkerFreehandPaintSpec[];
  readonly widthPhysicalPx: number;
  readonly heightPhysicalPx: number;
  readonly destinationXCssPx: number;
  readonly destinationYCssPx: number;
  readonly dpr: number;
  readonly opacity: number;
  readonly compositeOperation: GlobalCompositeOperation;
}

interface MutablePaintGroup {
  readonly flattenable: boolean;
  readonly paintSpecs: DrawingWorkerFreehandPaintSpec[];
}

function layoutBitmapAtlas(
  viewport: DrawingWorkerRenderRequest["viewport"],
  maxResultBytes: number,
): DrawingWorkerAtlasLayout | null {
  const frameWidthPhysicalPx = Math.ceil(viewport.widthCssPx * viewport.dpr);
  const frameHeightPhysicalPx = Math.ceil(viewport.heightCssPx * viewport.dpr);
  if (!Number.isSafeInteger(frameWidthPhysicalPx)
    || !Number.isSafeInteger(frameHeightPhysicalPx)) return null;
  const groups: MutablePaintGroup[] = [];
  for (const paintSpec of [...viewport.paintSpecs].sort(
    (left, right) => left.entityIndex - right.entityIndex,
  )) {
    const flattenable = !paintSpec.selected
      && paintSpec.compositeOperation === "source-over"
      && paintSpec.opacity === 1;
    const previous = groups.at(-1);
    const previousSpec = previous?.paintSpecs.at(-1);
    if (flattenable
      && previous?.flattenable
      && previousSpec
      && paintSpec.entityIndex === previousSpec.entityIndex + 1) {
      previous.paintSpecs.push(paintSpec);
    } else {
      groups.push({ flattenable, paintSpecs: [paintSpec] });
    }
  }

  const unplaced: DrawingWorkerUnplacedTile[] = [];
  let totalArea = 0;
  for (const group of groups) {
    let leftPhysicalPx = Number.POSITIVE_INFINITY;
    let topPhysicalPx = Number.POSITIVE_INFINITY;
    let rightPhysicalPx = Number.NEGATIVE_INFINITY;
    let bottomPhysicalPx = Number.NEGATIVE_INFINITY;
    for (const paintSpec of group.paintSpecs) {
      const paddingPhysicalPx = paintPaddingPhysicalPx(paintSpec, viewport.dpr);
      const bboxOffset = paintSpec.entityIndex * 4;
      const minX = Number(viewport.bboxes[bboxOffset]);
      const minY = Number(viewport.bboxes[bboxOffset + 1]);
      const maxX = Number(viewport.bboxes[bboxOffset + 2]);
      const maxY = Number(viewport.bboxes[bboxOffset + 3]);
      if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX < minX || maxY < minY) {
        return null;
      }
      leftPhysicalPx = Math.min(
        leftPhysicalPx,
        Math.max(0, Math.floor(minX * viewport.dpr) - paddingPhysicalPx),
      );
      topPhysicalPx = Math.min(
        topPhysicalPx,
        Math.max(0, Math.floor(minY * viewport.dpr) - paddingPhysicalPx),
      );
      rightPhysicalPx = Math.max(
        rightPhysicalPx,
        Math.min(
          frameWidthPhysicalPx,
          Math.ceil(maxX * viewport.dpr) + paddingPhysicalPx,
        ),
      );
      bottomPhysicalPx = Math.max(
        bottomPhysicalPx,
        Math.min(
          frameHeightPhysicalPx,
          Math.ceil(maxY * viewport.dpr) + paddingPhysicalPx,
        ),
      );
    }
    const widthPhysicalPx = rightPhysicalPx - leftPhysicalPx;
    const heightPhysicalPx = bottomPhysicalPx - topPhysicalPx;
    if (widthPhysicalPx <= 0 || heightPhysicalPx <= 0) continue;
    if (widthPhysicalPx > MAX_BITMAP_ATLAS_DIMENSION
      || heightPhysicalPx > MAX_BITMAP_ATLAS_DIMENSION) return null;
    totalArea += widthPhysicalPx * heightPhysicalPx;
    if (!Number.isSafeInteger(totalArea) || totalArea * 4 > maxResultBytes) return null;
    const firstPaintSpec = group.paintSpecs[0];
    const lastPaintSpec = group.paintSpecs.at(-1);
    if (!firstPaintSpec || !lastPaintSpec) return null;
    unplaced.push({
      entityIndex: firstPaintSpec.entityIndex,
      lastEntityIndex: lastPaintSpec.entityIndex,
      paintSpecs: Object.freeze([...group.paintSpecs]),
      widthPhysicalPx,
      heightPhysicalPx,
      destinationXCssPx: leftPhysicalPx / viewport.dpr,
      destinationYCssPx: topPhysicalPx / viewport.dpr,
      dpr: viewport.dpr,
      opacity: firstPaintSpec.selected ? 0.6 : firstPaintSpec.opacity,
      compositeOperation: firstPaintSpec.selected
        ? "source-over"
        : firstPaintSpec.compositeOperation,
    });
  }
  if (unplaced.length === 0) return null;

  const maximumTileWidth = Math.max(...unplaced.map((tile) => tile.widthPhysicalPx));
  const maximumAtlasWidth = Math.min(frameWidthPhysicalPx, MAX_BITMAP_ATLAS_DIMENSION);
  const candidateWidths = new Set([
    maximumTileWidth,
    Math.max(maximumTileWidth, Math.ceil(Math.sqrt(totalArea))),
    maximumAtlasWidth,
  ].map((width) => Math.min(maximumAtlasWidth, width)));
  let best: DrawingWorkerAtlasLayout | null = null;
  for (const widthPhysicalPx of candidateWidths) {
    const candidate = packAtlasShelves(unplaced, widthPhysicalPx, maxResultBytes);
    if (!candidate || (best && candidate.byteLength >= best.byteLength)) continue;
    best = candidate;
  }
  return best;
}

function packAtlasShelves(
  unplaced: readonly DrawingWorkerUnplacedTile[],
  widthPhysicalPx: number,
  maxResultBytes: number,
): DrawingWorkerAtlasLayout | null {
  if (widthPhysicalPx <= 0 || widthPhysicalPx > MAX_BITMAP_ATLAS_DIMENSION) return null;
  const tiles: DrawingWorkerAtlasTile[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  for (const tile of unplaced) {
    if (cursorX > 0 && cursorX + tile.widthPhysicalPx > widthPhysicalPx) {
      cursorX = 0;
      cursorY += rowHeight;
      rowHeight = 0;
    }
    if (cursorY + tile.heightPhysicalPx > MAX_BITMAP_ATLAS_DIMENSION) return null;
    tiles.push({
      entityIndex: tile.entityIndex,
      lastEntityIndex: tile.lastEntityIndex,
      sourceXPhysicalPx: cursorX,
      sourceYPhysicalPx: cursorY,
      sourceWidthPhysicalPx: tile.widthPhysicalPx,
      sourceHeightPhysicalPx: tile.heightPhysicalPx,
      destinationXCssPx: tile.destinationXCssPx,
      destinationYCssPx: tile.destinationYCssPx,
      destinationWidthCssPx: tile.widthPhysicalPx / tile.dpr,
      destinationHeightCssPx: tile.heightPhysicalPx / tile.dpr,
      opacity: tile.opacity,
      compositeOperation: tile.compositeOperation,
      paintSpecs: tile.paintSpecs,
    });
    cursorX += tile.widthPhysicalPx;
    rowHeight = Math.max(rowHeight, tile.heightPhysicalPx);
  }
  const heightPhysicalPx = cursorY + rowHeight;
  const byteLength = widthPhysicalPx * heightPhysicalPx * 4;
  if (heightPhysicalPx <= 0
    || !Number.isSafeInteger(byteLength)
    || byteLength > maxResultBytes) return null;
  return Object.freeze({
    widthPhysicalPx,
    heightPhysicalPx,
    byteLength,
    tiles: Object.freeze(tiles),
  });
}

function toBitmapLayer(tile: DrawingWorkerAtlasTile): Readonly<DrawingWorkerBitmapLayer> {
  return Object.freeze({
    entityIndex: tile.entityIndex,
    lastEntityIndex: tile.lastEntityIndex,
    sourceXPhysicalPx: tile.sourceXPhysicalPx,
    sourceYPhysicalPx: tile.sourceYPhysicalPx,
    sourceWidthPhysicalPx: tile.sourceWidthPhysicalPx,
    sourceHeightPhysicalPx: tile.sourceHeightPhysicalPx,
    destinationXCssPx: tile.destinationXCssPx,
    destinationYCssPx: tile.destinationYCssPx,
    destinationWidthCssPx: tile.destinationWidthCssPx,
    destinationHeightCssPx: tile.destinationHeightCssPx,
    opacity: tile.opacity,
    compositeOperation: tile.compositeOperation,
  });
}

function applyPaintSpec(
  context: DrawingWorkerRasterContext,
  paintSpec: DrawingWorkerFreehandPaintSpec,
  dpr: number,
): void {
  const squareBrush = paintSpec.brushShape === "square";
  context.lineCap = squareBrush ? "square" : "round";
  context.lineJoin = squareBrush ? "bevel" : "round";
  context.lineWidth = paintSpec.lineWidthCssPx * dpr;
  // Each atlas tile is independent. Final target compositing happens when the
  // ordered layer is inserted at its canonical scene entity index.
  context.globalCompositeOperation = "source-over";
  context.strokeStyle = paintSpec.selected
    ? paintSpec.selectionHighlightColor
    : paintSpec.strokeColor;
  context.globalAlpha = 1;
}

async function traceFreehandRun(
  context: DrawingWorkerRasterContext,
  points: Float64Array,
  startPointIndex: number,
  endPointIndex: number,
  dpr: number,
  offsetXPhysicalPx: number,
  offsetYPhysicalPx: number,
  linearPath: boolean,
  checkpoint: () => Promise<boolean> | null,
): Promise<boolean | "cancelled"> {
  const length = endPointIndex - startPointIndex;
  if (length < 2 || !finitePoint(points, startPointIndex)) return false;
  context.moveTo(
    Number(points[startPointIndex * 2]) * dpr + offsetXPhysicalPx,
    Number(points[startPointIndex * 2 + 1]) * dpr + offsetYPhysicalPx,
  );
  if (length === 2 || linearPath) {
    for (let pointIndex = startPointIndex + 1; pointIndex < endPointIndex; pointIndex += 1) {
      if (!finitePoint(points, pointIndex)) return false;
      context.lineTo(
        Number(points[pointIndex * 2]) * dpr + offsetXPhysicalPx,
        Number(points[pointIndex * 2 + 1]) * dpr + offsetYPhysicalPx,
      );
      const pendingCheckpoint = checkpoint();
      if (pendingCheckpoint && await pendingCheckpoint) return "cancelled";
    }
    return true;
  }
  for (let pointIndex = startPointIndex + 1; pointIndex < endPointIndex - 1; pointIndex += 1) {
    if (!finitePoint(points, pointIndex) || !finitePoint(points, pointIndex + 1)) return false;
    const x = Number(points[pointIndex * 2]) * dpr + offsetXPhysicalPx;
    const y = Number(points[pointIndex * 2 + 1]) * dpr + offsetYPhysicalPx;
    const nextX = Number(points[(pointIndex + 1) * 2]) * dpr + offsetXPhysicalPx;
    const nextY = Number(points[(pointIndex + 1) * 2 + 1]) * dpr + offsetYPhysicalPx;
    context.quadraticCurveTo(x, y, (x + nextX) / 2, (y + nextY) / 2);
    const pendingCheckpoint = checkpoint();
    if (pendingCheckpoint && await pendingCheckpoint) return "cancelled";
  }
  const penultimate = endPointIndex - 2;
  const last = endPointIndex - 1;
  if (!finitePoint(points, penultimate) || !finitePoint(points, last)) return false;
  context.quadraticCurveTo(
    Number(points[penultimate * 2]) * dpr + offsetXPhysicalPx,
    Number(points[penultimate * 2 + 1]) * dpr + offsetYPhysicalPx,
    Number(points[last * 2]) * dpr + offsetXPhysicalPx,
    Number(points[last * 2 + 1]) * dpr + offsetYPhysicalPx,
  );
  const pendingCheckpoint = checkpoint();
  if (pendingCheckpoint && await pendingCheckpoint) return "cancelled";
  return true;
}

function finitePoint(points: Float64Array, pointIndex: number): boolean {
  return Number.isFinite(points[pointIndex * 2])
    && Number.isFinite(points[pointIndex * 2 + 1]);
}
