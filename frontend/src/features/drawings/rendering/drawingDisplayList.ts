import type { DrawingRenderRevisionStamp } from "../engine/drawingRenderScheduler.js";
import type { DrawingStyle } from "../core/drawingDocument.js";
import type {
  AxisLineType,
  BasicLineToolId,
  DrawingHit,
  DrawingKind,
  ScreenBox,
  ScreenPoint,
  ShapeLineStyle,
  ShapeType,
} from "../drawingTypes.js";

export const DRAWING_DISPLAY_KIND_CODES: Readonly<Record<DrawingKind, number>> = Object.freeze({
  line: 1,
  "axis-line": 2,
  "angle-measure": 3,
  text: 4,
  fibonacci: 5,
  position: 6,
  shape: 7,
  freehand: 8,
  highlighter: 9,
});

export type DrawingDisplayUnboundedAxis = "horizontal" | "vertical" | "both" | null;

/**
 * Fully-normalized paint instructions produced outside the canvas hot path.
 * Phase 4 deliberately emits specs only for the first migrated kinds; later
 * phases may extend this union without making the renderer inspect document
 * geometry or infer an opcode from point counts.
 */
export type DrawingDisplayRenderSpec =
  | Readonly<{
      op: "line";
      lineType: BasicLineToolId;
      strokeColor: string;
      selectionHighlightColor: string;
      lineWidthCssPx: number;
      selected: boolean;
      mainPointOffset: 0;
      anchorPointOffset: 2;
      drawEndpointDots: boolean;
    }>
  | Readonly<{
      op: "axis-line";
      axisLineType: AxisLineType;
      strokeColor: string;
      selectionHighlightColor: string;
      lineWidthCssPx: number;
      selected: boolean;
      segmentPointOffset: 0;
      segmentCount: 1 | 2;
      anchorPointOffset: number | null;
    }>
  | Readonly<{
      op: "angle";
      strokeColor: string;
      selectionHighlightColor: string;
      lineWidthCssPx: number;
      selected: boolean;
      rayPointOffset: number;
      baselinePointOffset: number;
      arcPointOffset: number;
      arcPointCount: number;
      labelBoxPointOffset: number;
      labelText: string;
    }>
  | Readonly<{
      op: "fibonacci";
      strokeColor: string;
      selectionHighlightColor: string;
      lineWidthCssPx: number;
      selected: boolean;
      trendPointOffset: number;
      startPrice: number;
      endPrice: number;
      levelLines: readonly Readonly<{
        color: string;
        level: number;
        logicalPrice: number;
        pointOffset: number;
      }>[];
    }>
  | Readonly<{
      op: "text";
      strokeColor: string;
      lineWidthCssPx: number;
      selected: boolean;
      boxPointOffset: number;
      lines: readonly Readonly<{
        text: string;
        widthCssPx: number;
      }>[];
      textColor: string;
      fontSizeCssPx: number;
      fontFamily: string;
      bold: boolean;
      italic: boolean;
      underline: boolean;
      align: "left" | "center" | "right";
      backgroundColor: string | null;
      borderColor: string | null;
      borderWidthCssPx: number;
      paddingCssPx: number;
      lineHeightCssPx: number;
      selectionColor: string;
    }>
  | Readonly<{
      op: "position";
      strokeColor: string;
      lineWidthCssPx: number;
      selected: boolean;
      entryLinePointOffset: number;
      entryColor: string;
      upColor: string;
      downColor: string;
      direction: "long" | "short";
      tpLevel: Readonly<{
        linePointOffset: number;
        bodyPointOffset: number;
        priceText: string;
        percentText: string;
        pnlText: string | null;
        color: string;
      }> | null;
      slLevel: Readonly<{
        linePointOffset: number;
        bodyPointOffset: number;
        priceText: string;
        percentText: string;
        pnlText: string | null;
        color: string;
      }> | null;
      panelBoxPointOffset: number;
      panelLines: readonly Readonly<{
        label: string;
        value: string;
        extra: string | null;
        color: string;
      }>[];
      badgeText: "LONG" | "SHORT";
      badgeColor: string;
    }>
  | Readonly<{
      op: "shape";
      shapeType: ShapeType;
      strokeColor: string;
      fillPaintColor: string | null;
      lineWidthCssPx: number;
      lineStyle: ShapeLineStyle;
      selected: boolean;
      boxPointOffset: 0;
    }>
  | Readonly<{
      op: "freehand";
      strokeColor: string;
      selectionHighlightColor: string;
      lineWidthCssPx: number;
      opacity: number;
      compositeOperation: GlobalCompositeOperation;
      brushShape: "round" | "square";
      /** LOD paths are already screen-error bounded and must not be re-smoothed. */
      pathInterpolation?: "linear" | "quadratic";
      selected: boolean;
    }>;

export interface DrawingDisplayHitZone {
  readonly kind: "arc" | "box" | "ellipse" | "point" | "polyline";
  readonly name?: string;
  /** Entity-local point index. */
  readonly pointOffset: number;
  readonly pointCount: number;
  readonly tolerance: number;
  /** Native arc geometry, used only when kind is arc. */
  readonly startAngle?: number;
  readonly angleDelta?: number;
  readonly radius?: number;
  readonly angleTolerance?: number;
  /** Exact legacy-compatible result. Omitted zones keep the body/name fallback. */
  readonly result?: Readonly<DrawingHit>;
}

export interface ProjectedDrawingEntity {
  readonly id: string;
  readonly kind: DrawingKind;
  readonly geometryRevision: number;
  readonly styleRevision: number;
  readonly style: DrawingStyle;
  readonly renderSpec?: DrawingDisplayRenderSpec;
  /** Interleaved x/y Float64 coordinates. NaN pairs are unresolved gaps. */
  readonly points: Float64Array;
  readonly bbox: readonly [number, number, number, number] | null;
  readonly handles?: Float64Array;
  readonly handleNames?: readonly string[];
  /** Null entries retain handle geometry but intentionally do not hit. */
  readonly handleResults?: readonly (Readonly<DrawingHit> | null)[];
  readonly handleTolerance?: number;
  /** Entity-local point indexes at which a path is explicitly broken. */
  readonly pathBreaks?: Uint32Array;
  /** Canonical source-point indexes whose projection is unresolved. */
  readonly unresolvedSourcePointIndexes?: Uint32Array;
  /** True only when unresolved indexes cover the entity's entire canonical source. */
  readonly canonicalGapCoverageComplete?: boolean;
  readonly hitZones?: readonly DrawingDisplayHitZone[];
  readonly unboundedAxis?: DrawingDisplayUnboundedAxis;
}

export interface DrawingDisplayEntity {
  readonly id: string;
  readonly kind: DrawingKind;
  readonly geometryRevision: number;
  readonly styleRevision: number;
  readonly style: DrawingStyle;
  readonly renderSpec: DrawingDisplayRenderSpec | null;
  readonly pointOffset: number;
  readonly pointCount: number;
  readonly handleOffset: number;
  readonly handleCount: number;
  readonly handleNames: readonly string[];
  readonly handleResults: readonly (Readonly<DrawingHit> | null)[] | null;
  readonly handleTolerance: number;
  readonly pathBreakOffset: number;
  readonly pathBreakCount: number;
  readonly unresolvedGapOffset: number;
  readonly unresolvedGapCount: number;
  readonly canonicalGapCoverageComplete: boolean;
  readonly hitZones: readonly DrawingDisplayHitZone[];
  readonly unboundedAxis: DrawingDisplayUnboundedAxis;
}

/**
 * Worker-owned raster for the committed freehand/highlighter layer. Other
 * scene opcodes remain in the typed display list and are painted normally.
 */
export interface DrawingFreehandRasterLayer {
  readonly entityIndex: number;
  /** Inclusive end of a consecutive freehand run flattened into this tile. */
  readonly lastEntityIndex: number;
  readonly sourceXPhysicalPx: number;
  readonly sourceYPhysicalPx: number;
  readonly sourceWidthPhysicalPx: number;
  readonly sourceHeightPhysicalPx: number;
  readonly destinationXCssPx: number;
  readonly destinationYCssPx: number;
  readonly destinationWidthCssPx: number;
  readonly destinationHeightCssPx: number;
  readonly opacity: number;
  readonly compositeOperation: GlobalCompositeOperation;
}

export interface DrawingFreehandRasterBitmap {
  readonly bitmap: ImageBitmap;
  readonly widthCssPx: number;
  readonly heightCssPx: number;
  readonly dpr: number;
  readonly atlasWidthPhysicalPx: number;
  readonly atlasHeightPhysicalPx: number;
  readonly layers: readonly DrawingFreehandRasterLayer[];
}

export interface DrawingScreenDisplayList {
  readonly stamp: DrawingRenderRevisionStamp;
  readonly entities: readonly DrawingDisplayEntity[];
  readonly entityKindCodes: Readonly<Uint8Array>;
  readonly pointOffsets: Readonly<Uint32Array>;
  readonly pointCounts: Readonly<Uint32Array>;
  readonly points: Readonly<Float64Array>;
  readonly bboxes: Readonly<Float64Array>;
  readonly handleOffsets: Readonly<Uint32Array>;
  readonly handleCounts: Readonly<Uint32Array>;
  readonly handles: Readonly<Float64Array>;
  readonly pathBreakOffsets: Readonly<Uint32Array>;
  readonly pathBreakCounts: Readonly<Uint32Array>;
  readonly pathBreaks: Readonly<Uint32Array>;
  readonly unresolvedGapOffsets: Readonly<Uint32Array>;
  readonly unresolvedGapCounts: Readonly<Uint32Array>;
  readonly unresolvedSourcePointIndexes: Readonly<Uint32Array>;
  readonly unresolvedGapCount: number;
  readonly freehandRaster?: DrawingFreehandRasterBitmap;
}

/** Attach a matching worker raster without copying or weakening typed geometry ownership. */
export function withDrawingFreehandRaster(
  list: DrawingScreenDisplayList,
  raster: DrawingFreehandRasterBitmap,
): DrawingScreenDisplayList {
  if (!raster
    || typeof raster.bitmap !== "object"
    || raster.bitmap === null
    || raster.widthCssPx !== list.stamp.widthCssPx
    || raster.heightCssPx !== list.stamp.heightCssPx
    || raster.dpr !== list.stamp.dpr
    || !Number.isSafeInteger(raster.atlasWidthPhysicalPx)
    || raster.atlasWidthPhysicalPx <= 0
    || !Number.isSafeInteger(raster.atlasHeightPhysicalPx)
    || raster.atlasHeightPhysicalPx <= 0
    || raster.bitmap.width !== raster.atlasWidthPhysicalPx
    || raster.bitmap.height !== raster.atlasHeightPhysicalPx) {
    throw new TypeError("drawing freehand raster does not match its display-list stamp");
  }
  const layers: readonly DrawingFreehandRasterLayer[] = raster.layers;
  if (!Array.isArray(layers as unknown) || layers.length === 0) {
    throw new TypeError("drawing freehand raster does not match its display-list stamp");
  }
  let previousLastEntityIndex = -1;
  for (const layer of layers) {
    const invalid = (
      !Number.isSafeInteger(layer.entityIndex)
      || layer.entityIndex < 0
      || layer.entityIndex >= list.entities.length
      || !Number.isSafeInteger(layer.lastEntityIndex)
      || layer.lastEntityIndex < layer.entityIndex
      || layer.lastEntityIndex >= list.entities.length
      || layer.entityIndex <= previousLastEntityIndex
      || !Number.isSafeInteger(layer.sourceXPhysicalPx)
      || layer.sourceXPhysicalPx < 0
      || !Number.isSafeInteger(layer.sourceYPhysicalPx)
      || layer.sourceYPhysicalPx < 0
      || !Number.isSafeInteger(layer.sourceWidthPhysicalPx)
      || layer.sourceWidthPhysicalPx <= 0
      || !Number.isSafeInteger(layer.sourceHeightPhysicalPx)
      || layer.sourceHeightPhysicalPx <= 0
      || layer.sourceXPhysicalPx + layer.sourceWidthPhysicalPx > raster.atlasWidthPhysicalPx
      || layer.sourceYPhysicalPx + layer.sourceHeightPhysicalPx > raster.atlasHeightPhysicalPx
      || !Number.isFinite(layer.destinationXCssPx)
      || !Number.isFinite(layer.destinationYCssPx)
      || !Number.isFinite(layer.destinationWidthCssPx)
      || layer.destinationWidthCssPx <= 0
      || !Number.isFinite(layer.destinationHeightCssPx)
      || layer.destinationHeightCssPx <= 0
      || !Number.isFinite(layer.opacity)
      || layer.opacity < 0
      || layer.opacity > 1
      || (layer.compositeOperation !== "source-over"
        && layer.compositeOperation !== "multiply")
    );
    if (invalid) {
      throw new TypeError("drawing freehand raster does not match its display-list stamp");
    }
    for (let entityIndex = layer.entityIndex; entityIndex <= layer.lastEntityIndex; entityIndex += 1) {
      const renderSpec = list.entities[entityIndex]?.renderSpec;
      if (renderSpec?.op !== "freehand") {
        throw new TypeError("drawing freehand raster cannot cover non-freehand entities");
      }
      const grouped = layer.lastEntityIndex > layer.entityIndex;
      const effectiveOpacity = renderSpec.selected ? 0.6 : renderSpec.opacity;
      const effectiveCompositeOperation = renderSpec.selected
        ? "source-over"
        : renderSpec.compositeOperation;
      if (grouped
        ? renderSpec.opacity !== 1
          || renderSpec.compositeOperation !== "source-over"
          || renderSpec.selected
          || layer.opacity !== 1
          || layer.compositeOperation !== "source-over"
        : effectiveOpacity !== layer.opacity
          || effectiveCompositeOperation !== layer.compositeOperation) {
        throw new TypeError("drawing freehand raster cannot change entity compositing semantics");
      }
    }
    previousLastEntityIndex = layer.lastEntityIndex;
  }
  return Object.freeze({
    ...list,
    freehandRaster: Object.freeze({
      ...raster,
      layers: Object.freeze(layers.map((layer) => Object.freeze({ ...layer }))),
    }),
  });
}

export interface DrawingDisplayHitResult extends DrawingHit {
  readonly entityId: string;
  readonly kind: DrawingKind;
}

/**
 * Spatial broad-phase output. Entity indexes are already in descending
 * canonical z-order; polyline entries contain entity-local segment starts.
 * Keeping this small contract beside the exact oracle avoids a dependency
 * from the retained display list back into a particular index implementation.
 */
export interface DrawingDisplayHitCandidates {
  readonly entityIndexes: readonly number[];
  readonly polylineSegmentStartsByEntity?: ReadonlyMap<number, readonly number[]>;
}

export function drawingDisplayEntityScreenBox(
  list: DrawingScreenDisplayList,
  entityId: string,
): ScreenBox | null {
  const entityIndex = list.entities.findIndex((entity) => entity.id === entityId);
  if (entityIndex < 0) return null;
  const entity = list.entities[entityIndex];
  if (!entity) return null;
  const rawBoxPointOffset = entity.kind === "shape" && entity.renderSpec?.op === "shape"
    ? entity.renderSpec.boxPointOffset
    : entity.kind === "text" && entity.renderSpec?.op === "text"
      ? entity.renderSpec.boxPointOffset
      : null;
  if (rawBoxPointOffset !== null) {
    // The broad-phase bbox is pane-clipped. Resize must instead retain both
    // raw projected corners so moving one side cannot snap its offscreen peer.
    const first = pointAt(
      list.points,
      entity.pointOffset + rawBoxPointOffset,
    );
    const second = pointAt(
      list.points,
      entity.pointOffset + rawBoxPointOffset + 1,
    );
    if (!first || !second) return null;
    const minX = Math.min(first[0], second[0]);
    const minY = Math.min(first[1], second[1]);
    const maxX = Math.max(first[0], second[0]);
    const maxY = Math.max(first[1], second[1]);
    return Object.freeze({
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    });
  }
  const offset = entityIndex * 4;
  const minX = Number(list.bboxes[offset]);
  const minY = Number(list.bboxes[offset + 1]);
  const maxX = Number(list.bboxes[offset + 2]);
  const maxY = Number(list.bboxes[offset + 3]);
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX < minX || maxY < minY) {
    return null;
  }
  return Object.freeze({
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  });
}

/** Return the exact accepted interaction handles for one scene entity. */
export function drawingDisplayEntityScreenHandles(
  list: DrawingScreenDisplayList,
  entityId: string,
): readonly ScreenPoint[] | null {
  const entity = list.entities.find((candidate) => candidate.id === entityId);
  if (!entity) return null;
  const handles: ScreenPoint[] = [];
  for (let index = 0; index < entity.handleCount; index += 1) {
    const point = pointAt(list.handles, entity.handleOffset + index);
    if (!point) continue;
    handles.push(Object.freeze({ x: point[0], y: point[1] }));
  }
  return Object.freeze(handles);
}

function finitePairBuffer(value: Float64Array): boolean {
  if (!(value instanceof Float64Array) || value.length % 2 !== 0) return false;
  for (let index = 0; index < value.length; index += 2) {
    const x = value[index];
    const y = value[index + 1];
    if (Number.isFinite(x) && Number.isFinite(y)) continue;
    if (Number.isNaN(x) && Number.isNaN(y)) continue;
    return false;
  }
  return true;
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validBbox(value: ProjectedDrawingEntity["bbox"]): boolean {
  return value === null || (value.length === 4
    && value.every(Number.isFinite)
    && value[0] <= value[2]
    && value[1] <= value[3]);
}

function validHitResult(value: unknown): value is Readonly<DrawingHit> {
  if (!value || typeof value !== "object") return false;
  const hit = value as DrawingHit;
  return (hit.pointIndex === undefined
      || (Number.isSafeInteger(hit.pointIndex) && Number(hit.pointIndex) >= -1))
    && (hit.zone === undefined || typeof hit.zone === "string")
    && (hit.handle === undefined || typeof hit.handle === "string")
    && (hit.body === undefined || typeof hit.body === "boolean")
    && (hit.pointIndex !== undefined
      || hit.zone !== undefined
      || hit.handle !== undefined
      || hit.body !== undefined);
}

function unknownRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function validFibonacciLevelLines(value: unknown, pointCount: number): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((candidate: unknown) => {
    const level = unknownRecord(candidate);
    if (!level) return false;
    const color = level.color;
    const ratio = level.level;
    const logicalPrice = level.logicalPrice;
    const pointOffset = level.pointOffset;
    return typeof color === "string"
      && typeof ratio === "number"
      && Number.isFinite(ratio)
      && typeof logicalPrice === "number"
      && Number.isFinite(logicalPrice)
      && typeof pointOffset === "number"
      && Number.isSafeInteger(pointOffset)
      && pointOffset >= 0
      && pointOffset + 2 <= pointCount;
  });
}

function validTextRenderLines(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((candidate: unknown) => {
    const line = unknownRecord(candidate);
    if (!line) return false;
    const text = line.text;
    const widthCssPx = line.widthCssPx;
    return typeof text === "string"
      && typeof widthCssPx === "number"
      && Number.isFinite(widthCssPx)
      && widthCssPx >= 0;
  });
}

function validPositionPanelLines(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((candidate: unknown) => {
    const line = unknownRecord(candidate);
    if (!line) return false;
    const label = line.label;
    const lineValue = line.value;
    const extra = line.extra;
    const color = line.color;
    return typeof label === "string"
      && typeof lineValue === "string"
      && (extra === null || typeof extra === "string")
      && typeof color === "string";
  });
}

function validRenderSpec(
  entity: ProjectedDrawingEntity,
  spec: DrawingDisplayRenderSpec | undefined,
): boolean {
  if (spec === undefined) return true;
  if (!Number.isFinite(spec.lineWidthCssPx) || spec.lineWidthCssPx <= 0
    || typeof spec.strokeColor !== "string" || typeof spec.selected !== "boolean") {
    return false;
  }
  if (spec.op === "line") {
    return entity.kind === "line"
      && (spec.lineType === "line-segment"
        || spec.lineType === "line-ray"
        || spec.lineType === "line-infinite")
      && spec.mainPointOffset === 0
      && spec.anchorPointOffset === 2
      && typeof spec.selectionHighlightColor === "string"
      && spec.drawEndpointDots === (spec.lineType === "line-segment")
      && entity.points.length >= 8;
  }
  if (spec.op === "axis-line") {
    return entity.kind === "axis-line"
      && (spec.axisLineType === "horizontal"
        || spec.axisLineType === "vertical"
        || spec.axisLineType === "cross")
      && spec.segmentPointOffset === 0
      && typeof spec.selectionHighlightColor === "string"
      && (spec.segmentCount === 1 || spec.segmentCount === 2)
      && spec.segmentCount * 4 <= entity.points.length
      && (spec.anchorPointOffset === null
        || (Number.isSafeInteger(spec.anchorPointOffset)
          && spec.anchorPointOffset >= spec.segmentCount * 2
          && (spec.anchorPointOffset + 1) * 2 <= entity.points.length));
  }
  if (spec.op === "angle") {
    const pointCount = entity.points.length / 2;
    return entity.kind === "angle-measure"
      && typeof spec.selectionHighlightColor === "string"
      && typeof spec.labelText === "string"
      && Number.isSafeInteger(spec.rayPointOffset)
      && spec.rayPointOffset >= 0
      && spec.rayPointOffset + 2 <= pointCount
      && Number.isSafeInteger(spec.baselinePointOffset)
      && spec.baselinePointOffset >= 0
      && spec.baselinePointOffset + 2 <= pointCount
      && Number.isSafeInteger(spec.arcPointOffset)
      && spec.arcPointOffset >= 0
      && Number.isSafeInteger(spec.arcPointCount)
      && spec.arcPointCount >= 2
      && spec.arcPointOffset + spec.arcPointCount <= pointCount
      && Number.isSafeInteger(spec.labelBoxPointOffset)
      && spec.labelBoxPointOffset >= 0
      && spec.labelBoxPointOffset + 2 <= pointCount;
  }
  if (spec.op === "fibonacci") {
    const pointCount = entity.points.length / 2;
    return entity.kind === "fibonacci"
      && typeof spec.selectionHighlightColor === "string"
      && Number.isSafeInteger(spec.trendPointOffset)
      && spec.trendPointOffset >= 0
      && spec.trendPointOffset + 2 <= pointCount
      && Number.isFinite(spec.startPrice)
      && Number.isFinite(spec.endPrice)
      && validFibonacciLevelLines(spec.levelLines, pointCount);
  }
  if (spec.op === "text") {
    const pointCount = entity.points.length / 2;
    return entity.kind === "text"
      && Number.isSafeInteger(spec.boxPointOffset)
      && spec.boxPointOffset >= 0
      && spec.boxPointOffset + 2 <= pointCount
      && validTextRenderLines(spec.lines)
      && typeof spec.textColor === "string"
      && Number.isFinite(spec.fontSizeCssPx)
      && spec.fontSizeCssPx > 0
      && typeof spec.fontFamily === "string"
      && spec.fontFamily.length > 0
      && typeof spec.bold === "boolean"
      && typeof spec.italic === "boolean"
      && typeof spec.underline === "boolean"
      && (spec.align === "left" || spec.align === "center" || spec.align === "right")
      && (spec.backgroundColor === null || typeof spec.backgroundColor === "string")
      && (spec.borderColor === null || typeof spec.borderColor === "string")
      && Number.isFinite(spec.borderWidthCssPx)
      && spec.borderWidthCssPx >= 0
      && Number.isFinite(spec.paddingCssPx)
      && spec.paddingCssPx >= 0
      && Number.isFinite(spec.lineHeightCssPx)
      && spec.lineHeightCssPx > 0
      && typeof spec.selectionColor === "string";
  }
  if (spec.op === "position") {
    const pointCount = entity.points.length / 2;
    const validPairOffset = (offset: number): boolean => Number.isSafeInteger(offset)
      && offset >= 0
      && offset + 2 <= pointCount;
    const validLevel = (level: typeof spec.tpLevel): boolean => level === null || (
      validPairOffset(level.linePointOffset)
      && validPairOffset(level.bodyPointOffset)
      && typeof level.priceText === "string"
      && typeof level.percentText === "string"
      && (level.pnlText === null || typeof level.pnlText === "string")
      && typeof level.color === "string"
    );
    return entity.kind === "position"
      && validPairOffset(spec.entryLinePointOffset)
      && typeof spec.entryColor === "string"
      && typeof spec.upColor === "string"
      && typeof spec.downColor === "string"
      && (spec.direction === "long" || spec.direction === "short")
      && validLevel(spec.tpLevel)
      && validLevel(spec.slLevel)
      && validPairOffset(spec.panelBoxPointOffset)
      && validPositionPanelLines(spec.panelLines)
      && (spec.badgeText === "LONG" || spec.badgeText === "SHORT")
      && typeof spec.badgeColor === "string";
  }
  if (spec.op === "shape") {
    return entity.kind === "shape"
      && (spec.shapeType === "rectangle" || spec.shapeType === "ellipse")
      && (spec.fillPaintColor === null || typeof spec.fillPaintColor === "string")
      && (spec.lineStyle === "solid" || spec.lineStyle === "dashed" || spec.lineStyle === "dotted")
      && spec.boxPointOffset === 0
      && entity.points.length >= 4;
  }
  return (entity.kind === "freehand" || entity.kind === "highlighter")
    && typeof spec.selectionHighlightColor === "string"
    && Number.isFinite(spec.opacity)
    && spec.opacity >= 0
    && spec.opacity <= 1
    && typeof spec.compositeOperation === "string"
    && spec.compositeOperation.length > 0
    && (spec.brushShape === "round" || spec.brushShape === "square")
    && (spec.pathInterpolation === undefined
      || spec.pathInterpolation === "linear"
      || spec.pathInterpolation === "quadratic");
}

function validateEntity(entity: ProjectedDrawingEntity): void {
  if (!entity.id || !(entity.kind in DRAWING_DISPLAY_KIND_CODES)) {
    throw new TypeError("display entity identity is invalid");
  }
  if (!validRevision(entity.geometryRevision) || !validRevision(entity.styleRevision)) {
    throw new TypeError("display entity revisions are invalid");
  }
  if (!finitePairBuffer(entity.points)
    || !finitePairBuffer(entity.handles ?? new Float64Array())) {
    throw new TypeError("display entity coordinate buffers are invalid");
  }
  if (!validBbox(entity.bbox)) throw new TypeError("display entity bbox is invalid");
  if (!validRenderSpec(entity, entity.renderSpec)) {
    throw new TypeError("display entity render spec is invalid");
  }
  const pointCount = entity.points.length / 2;
  const handleCount = (entity.handles?.length ?? 0) / 2;
  if ((entity.handleNames?.length ?? 0) !== handleCount) {
    throw new TypeError("display entity handle names do not match coordinates");
  }
  if (entity.handleResults !== undefined
    && (entity.handleResults.length !== handleCount
      || entity.handleResults.some((result) => result !== null && !validHitResult(result)))) {
    throw new TypeError("display entity handle results do not match coordinates");
  }
  if (entity.handleTolerance !== undefined
    && (!Number.isFinite(entity.handleTolerance) || entity.handleTolerance < 0)) {
    throw new TypeError("display entity handle tolerance is invalid");
  }
  for (const gap of entity.pathBreaks ?? []) {
    if (!Number.isSafeInteger(gap) || gap >= pointCount) {
      throw new TypeError("display entity path gap is out of bounds");
    }
  }
  let previousSourceIndex = -1;
  for (const sourceIndex of entity.unresolvedSourcePointIndexes ?? []) {
    if (!Number.isSafeInteger(sourceIndex) || sourceIndex <= previousSourceIndex) {
      throw new TypeError("display entity unresolved source indexes are invalid");
    }
    previousSourceIndex = sourceIndex;
  }
  if (entity.canonicalGapCoverageComplete !== undefined
    && typeof entity.canonicalGapCoverageComplete !== "boolean") {
    throw new TypeError("display entity canonical gap coverage is invalid");
  }
  if (entity.canonicalGapCoverageComplete === true
    && entity.kind !== "freehand" && entity.kind !== "highlighter") {
    throw new TypeError("only freehand entities can own complete canonical gap coverage");
  }
  for (const zone of entity.hitZones ?? []) {
    if (!Number.isSafeInteger(zone.pointOffset)
      || !Number.isSafeInteger(zone.pointCount)
      || zone.pointOffset < 0
      || zone.pointCount < 0
      || zone.pointOffset + zone.pointCount > pointCount
      || !Number.isFinite(zone.tolerance)
      || zone.tolerance < 0
      || (zone.kind === "arc" && (
        zone.pointCount !== 1
        || !Number.isFinite(zone.startAngle)
        || !Number.isFinite(zone.angleDelta)
        || !Number.isFinite(zone.radius)
        || Number(zone.radius) < 0
        || !Number.isFinite(zone.angleTolerance)
        || Number(zone.angleTolerance) < 0
      ))
      || (zone.kind === "ellipse" && zone.pointCount !== 2)
      || (zone.result !== undefined && !validHitResult(zone.result))) {
      throw new TypeError("display entity hit zone is invalid");
    }
  }
}

function copyInto(target: Float64Array, offset: number, source: Float64Array): void {
  target.set(source, offset);
}

function freezeRenderSpec(spec: DrawingDisplayRenderSpec): DrawingDisplayRenderSpec {
  if (spec.op === "fibonacci") {
    return Object.freeze({
      ...spec,
      levelLines: Object.freeze(spec.levelLines.map((level) => Object.freeze({ ...level }))),
    });
  }
  if (spec.op === "text") {
    return Object.freeze({
      ...spec,
      lines: Object.freeze(spec.lines.map((line) => Object.freeze({ ...line }))),
    });
  }
  if (spec.op === "position") {
    return Object.freeze({
      ...spec,
      tpLevel: spec.tpLevel ? Object.freeze({ ...spec.tpLevel }) : null,
      slLevel: spec.slLevel ? Object.freeze({ ...spec.slLevel }) : null,
      panelLines: Object.freeze(spec.panelLines.map((line) => Object.freeze({ ...line }))),
    });
  }
  return Object.freeze({ ...spec });
}

/** Build one compact, copy-owned screen display list in document z-order. */
export function createDrawingScreenDisplayList(
  stamp: DrawingRenderRevisionStamp,
  projected: readonly ProjectedDrawingEntity[],
): DrawingScreenDisplayList {
  for (const entity of projected) validateEntity(entity);
  const totalPointValues = projected.reduce((sum, entity) => sum + entity.points.length, 0);
  const totalHandleValues = projected.reduce(
    (sum, entity) => sum + (entity.handles?.length ?? 0),
    0,
  );
  const totalBreaks = projected.reduce(
    (sum, entity) => sum + (entity.pathBreaks?.length ?? 0),
    0,
  );
  const totalUnresolvedGaps = projected.reduce(
    (sum, entity) => sum + (entity.unresolvedSourcePointIndexes?.length ?? 0),
    0,
  );
  const count = projected.length;
  const kindCodes = new Uint8Array(count);
  const pointOffsets = new Uint32Array(count);
  const pointCounts = new Uint32Array(count);
  const points = new Float64Array(totalPointValues);
  const bboxes = new Float64Array(count * 4);
  bboxes.fill(Number.NaN);
  const handleOffsets = new Uint32Array(count);
  const handleCounts = new Uint32Array(count);
  const handles = new Float64Array(totalHandleValues);
  const pathBreakOffsets = new Uint32Array(count);
  const pathBreakCounts = new Uint32Array(count);
  const pathBreaks = new Uint32Array(totalBreaks);
  const unresolvedGapOffsets = new Uint32Array(count);
  const unresolvedGapCounts = new Uint32Array(count);
  const unresolvedSourcePointIndexes = new Uint32Array(totalUnresolvedGaps);
  const entities: DrawingDisplayEntity[] = [];
  let pointValueOffset = 0;
  let handleValueOffset = 0;
  let pathBreakOffset = 0;
  let unresolvedGapOffset = 0;

  projected.forEach((entity, index) => {
    const pointOffset = pointValueOffset / 2;
    const pointCount = entity.points.length / 2;
    const handleOffset = handleValueOffset / 2;
    const handleCount = (entity.handles?.length ?? 0) / 2;
    kindCodes[index] = DRAWING_DISPLAY_KIND_CODES[entity.kind];
    pointOffsets[index] = pointOffset;
    pointCounts[index] = pointCount;
    copyInto(points, pointValueOffset, entity.points);
    pointValueOffset += entity.points.length;
    if (entity.bbox) bboxes.set(entity.bbox, index * 4);
    handleOffsets[index] = handleOffset;
    handleCounts[index] = handleCount;
    if (entity.handles) {
      copyInto(handles, handleValueOffset, entity.handles);
      handleValueOffset += entity.handles.length;
    }
    const entityBreaks = entity.pathBreaks ?? new Uint32Array();
    pathBreakOffsets[index] = pathBreakOffset;
    pathBreakCounts[index] = entityBreaks.length;
    for (let gapIndex = 0; gapIndex < entityBreaks.length; gapIndex += 1) {
      pathBreaks[pathBreakOffset + gapIndex] = pointOffset + Number(entityBreaks[gapIndex]);
    }
    const entityUnresolvedGaps = entity.unresolvedSourcePointIndexes ?? new Uint32Array();
    unresolvedGapOffsets[index] = unresolvedGapOffset;
    unresolvedGapCounts[index] = entityUnresolvedGaps.length;
    unresolvedSourcePointIndexes.set(entityUnresolvedGaps, unresolvedGapOffset);
    const displayEntity: DrawingDisplayEntity = Object.freeze({
      id: entity.id,
      kind: entity.kind,
      geometryRevision: entity.geometryRevision,
      styleRevision: entity.styleRevision,
      style: entity.style,
      renderSpec: entity.renderSpec ? freezeRenderSpec(entity.renderSpec) : null,
      pointOffset,
      pointCount,
      handleOffset,
      handleCount,
      handleNames: Object.freeze([...(entity.handleNames ?? [])]),
      handleResults: entity.handleResults === undefined
        ? null
        : Object.freeze(entity.handleResults.map((result) => (
          result === null ? null : Object.freeze({ ...result })
        ))),
      handleTolerance: entity.handleTolerance ?? 7,
      pathBreakOffset,
      pathBreakCount: entityBreaks.length,
      unresolvedGapOffset,
      unresolvedGapCount: entityUnresolvedGaps.length,
      canonicalGapCoverageComplete: entity.canonicalGapCoverageComplete === true,
      hitZones: Object.freeze((entity.hitZones ?? []).map((zone) => Object.freeze({
        ...zone,
        ...(zone.result ? { result: Object.freeze({ ...zone.result }) } : {}),
      }))),
      unboundedAxis: entity.unboundedAxis ?? null,
    });
    entities.push(displayEntity);
    pathBreakOffset += entityBreaks.length;
    unresolvedGapOffset += entityUnresolvedGaps.length;
  });

  return Object.freeze({
    stamp: Object.freeze({ ...stamp }),
    entities: Object.freeze(entities),
    entityKindCodes: kindCodes,
    pointOffsets,
    pointCounts,
    points,
    bboxes,
    handleOffsets,
    handleCounts,
    handles,
    pathBreakOffsets,
    pathBreakCounts,
    pathBreaks,
    unresolvedGapOffsets,
    unresolvedGapCounts,
    unresolvedSourcePointIndexes,
    unresolvedGapCount: totalUnresolvedGaps,
  });
}

function pointAt(buffer: Readonly<Float64Array>, pointIndex: number): readonly [number, number] | null {
  const x = buffer[pointIndex * 2];
  const y = buffer[pointIndex * 2 + 1];
  return Number.isFinite(x) && Number.isFinite(y) ? [Number(x), Number(y)] : null;
}

function distanceSquaredToSegment(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    const pointDx = x - ax;
    const pointDy = y - ay;
    return pointDx * pointDx + pointDy * pointDy;
  }
  const ratio = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared));
  const closestDx = x - (ax + ratio * dx);
  const closestDy = y - (ay + ratio * dy);
  return closestDx * closestDx + closestDy * closestDy;
}

function shortestAngleDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function zoneHit(
  list: DrawingScreenDisplayList,
  entity: DrawingDisplayEntity,
  zone: DrawingDisplayHitZone,
  x: number,
  y: number,
  polylineSegmentStarts?: readonly number[],
): boolean {
  const start = entity.pointOffset + zone.pointOffset;
  if (zone.kind === "arc") {
    const center = pointAt(list.points, start);
    const radius = zone.radius;
    const startAngle = zone.startAngle;
    const angleDelta = zone.angleDelta;
    const angleTolerance = zone.angleTolerance;
    if (!center || radius === undefined || startAngle === undefined
      || angleDelta === undefined || angleTolerance === undefined) return false;
    const dx = x - center[0];
    const dy = y - center[1];
    if (Math.abs(Math.hypot(dx, dy) - radius) > zone.tolerance) return false;
    const pointDelta = shortestAngleDelta(startAngle, Math.atan2(dy, dx));
    return angleDelta >= 0
      ? pointDelta >= -angleTolerance && pointDelta <= angleDelta + angleTolerance
      : pointDelta <= angleTolerance && pointDelta >= angleDelta - angleTolerance;
  }
  if (zone.kind === "ellipse") {
    const first = pointAt(list.points, start);
    const second = pointAt(list.points, start + 1);
    if (!first || !second) return false;
    const left = Math.min(first[0], second[0]);
    const right = Math.max(first[0], second[0]);
    const top = Math.min(first[1], second[1]);
    const bottom = Math.max(first[1], second[1]);
    const radiusX = (right - left) / 2;
    const radiusY = (bottom - top) / 2;
    if (radiusX <= 0 || radiusY <= 0) return false;
    const normalizedX = (x - (left + radiusX)) / (radiusX + zone.tolerance);
    const normalizedY = (y - (top + radiusY)) / (radiusY + zone.tolerance);
    return normalizedX * normalizedX + normalizedY * normalizedY <= 1;
  }
  if (zone.kind === "point") {
    const toleranceSquared = zone.tolerance * zone.tolerance;
    for (let index = 0; index < zone.pointCount; index += 1) {
      const point = pointAt(list.points, start + index);
      if (point) {
        const dx = x - point[0];
        const dy = y - point[1];
        if (dx * dx + dy * dy <= toleranceSquared) return true;
      }
    }
    return false;
  }
  if (zone.kind === "box") {
    const leftTop = pointAt(list.points, start);
    const rightBottom = pointAt(list.points, start + Math.max(0, zone.pointCount - 1));
    if (!leftTop || !rightBottom) return false;
    const left = Math.min(leftTop[0], rightBottom[0]) - zone.tolerance;
    const right = Math.max(leftTop[0], rightBottom[0]) + zone.tolerance;
    const top = Math.min(leftTop[1], rightBottom[1]) - zone.tolerance;
    const bottom = Math.max(leftTop[1], rightBottom[1]) + zone.tolerance;
    return x >= left && x <= right && y >= top && y <= bottom;
  }
  const toleranceSquared = zone.tolerance * zone.tolerance;
  if (polylineSegmentStarts) {
    for (const segmentStart of polylineSegmentStarts) {
      if (!Number.isSafeInteger(segmentStart)
        || segmentStart < zone.pointOffset
        || segmentStart + 1 >= zone.pointOffset + zone.pointCount) continue;
      const first = pointAt(list.points, entity.pointOffset + segmentStart);
      const second = pointAt(list.points, entity.pointOffset + segmentStart + 1);
      if (first && second && distanceSquaredToSegment(
        x,
        y,
        first[0],
        first[1],
        second[0],
        second[1],
      ) <= toleranceSquared) return true;
    }
    return false;
  }
  let previous: readonly [number, number] | null = null;
  for (let index = 0; index < zone.pointCount; index += 1) {
    const point = pointAt(list.points, start + index);
    if (!point) {
      previous = null;
      continue;
    }
    if (previous && distanceSquaredToSegment(
      x,
      y,
      previous[0],
      previous[1],
      point[0],
      point[1],
    ) <= toleranceSquared) {
      return true;
    }
    previous = point;
  }
  return false;
}

function entityBboxMayContainZoneHit(
  list: DrawingScreenDisplayList,
  entity: DrawingDisplayEntity,
  entityIndex: number,
  x: number,
  y: number,
): boolean {
  const offset = entityIndex * 4;
  const left = list.bboxes[offset];
  const top = list.bboxes[offset + 1];
  const right = list.bboxes[offset + 2];
  const bottom = list.bboxes[offset + 3];
  if (!Number.isFinite(left) || !Number.isFinite(top)
    || !Number.isFinite(right) || !Number.isFinite(bottom)) return true;
  let tolerance = 0;
  for (const zone of entity.hitZones) tolerance = Math.max(tolerance, zone.tolerance);
  return x >= Number(left) - tolerance
    && x <= Number(right) + tolerance
    && y >= Number(top) - tolerance
    && y <= Number(bottom) + tolerance;
}

function crossAxisLineHitZone(
  list: DrawingScreenDisplayList,
  entity: DrawingDisplayEntity,
  x: number,
  y: number,
): DrawingDisplayHitZone | null {
  const center = entity.hitZones.find((zone) => zone.name === "center");
  if (center && zoneHit(list, entity, center, x, y)) return center;
  const horizontal = entity.hitZones.find((zone) => zone.name === "horizontal");
  const vertical = entity.hitZones.find((zone) => zone.name === "vertical");
  const horizontalHit = horizontal ? zoneHit(list, entity, horizontal, x, y) : false;
  const verticalHit = vertical ? zoneHit(list, entity, vertical, x, y) : false;
  if (!horizontalHit) return verticalHit ? vertical ?? null : null;
  if (!verticalHit) return horizontal ?? null;
  if (!horizontal || !vertical) return horizontal ?? vertical ?? null;
  const horizontalPoint = pointAt(
    list.points,
    entity.pointOffset + horizontal.pointOffset,
  );
  const verticalPoint = pointAt(
    list.points,
    entity.pointOffset + vertical.pointOffset,
  );
  if (!horizontalPoint || !verticalPoint) return null;
  const horizontalDistance = Math.abs(y - horizontalPoint[1]);
  const verticalDistance = Math.abs(x - verticalPoint[0]);
  // Match AxisLineDrawingPrimitive: equal distance resolves horizontally.
  return horizontalDistance <= verticalDistance ? horizontal : vertical;
}

function selectedHandleHit(
  list: DrawingScreenDisplayList,
  x: number,
  y: number,
  selectedId: string | null,
): DrawingDisplayHitResult | null {
  if (!selectedId) return null;
  const entityIndex = list.entities.findIndex((entity) => entity.id === selectedId);
  const entity = entityIndex >= 0 ? list.entities[entityIndex] : undefined;
  if (!entity) return null;
  for (let index = 0; index < entity.handleCount; index += 1) {
    const handle = pointAt(list.handles, entity.handleOffset + index);
    const handleName = entity.handleNames[index];
    const exactResult = entity.handleResults?.[index];
    if (handle && handleName
      && Math.abs(x - handle[0]) <= entity.handleTolerance
      && Math.abs(y - handle[1]) <= entity.handleTolerance) {
      if (entity.handleResults && !exactResult) continue;
      return Object.freeze({
        entityId: entity.id,
        kind: entity.kind,
        ...(exactResult ?? { handle: handleName, pointIndex: index }),
      });
    }
  }
  return null;
}

/**
 * Exact hit oracle. Without candidates it remains the Phase 3 reverse-z
 * sequential reference; production Phase 6 supplies a uniform-grid subset.
 */
export function hitTestDrawingScreenDisplayList(
  list: DrawingScreenDisplayList,
  x: number,
  y: number,
  selectedId: string | null = null,
  candidates: DrawingDisplayHitCandidates | null = null,
): DrawingDisplayHitResult | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const handleHit = selectedHandleHit(list, x, y, selectedId);
  if (handleHit) return handleHit;
  const entityIndexes = candidates?.entityIndexes ?? Array.from(
    { length: list.entities.length },
    (_, index) => list.entities.length - 1 - index,
  );
  for (const entityIndex of entityIndexes) {
    if (!Number.isSafeInteger(entityIndex)
      || entityIndex < 0
      || entityIndex >= list.entities.length) continue;
    const entity = list.entities[entityIndex];
    if (!entity) continue;
    // Selected handles intentionally run first because a handle may extend
    // beyond the painted geometry. Ordinary zones can use the exact projected
    // bbox as a conservative broad phase, avoiding O(entities * points) scans
    // for strict parity probes that are nowhere near most long strokes.
    if (!entityBboxMayContainZoneHit(list, entity, entityIndex, x, y)) continue;
    if (entity.renderSpec?.op === "axis-line"
      && entity.renderSpec.axisLineType === "cross") {
      const zone = crossAxisLineHitZone(list, entity, x, y);
      if (!zone) continue;
      return Object.freeze({
        entityId: entity.id,
        kind: entity.kind,
        ...(zone.result ?? (zone.name ? { zone: zone.name } : { body: true })),
      });
    }
    for (const zone of entity.hitZones) {
      const indexedSegments = zone.kind === "polyline"
        ? candidates?.polylineSegmentStartsByEntity?.get(entityIndex)
        : undefined;
      if (!zoneHit(list, entity, zone, x, y, indexedSegments)) continue;
      return Object.freeze({
        entityId: entity.id,
        kind: entity.kind,
        ...(zone.result ?? (zone.name ? { zone: zone.name } : { body: true })),
      });
    }
  }
  return null;
}
