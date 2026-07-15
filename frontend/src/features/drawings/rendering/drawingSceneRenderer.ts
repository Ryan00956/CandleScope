import type { PrimitiveCanvasTarget, PrimitivePaneRenderer } from "../drawingTypes.js";
import {
  accumulateDrawingPerfFrameWork,
} from "../performance/drawingPerfCounters.js";
import type {
  DrawingDisplayEntity,
  DrawingFreehandRasterLayer,
  DrawingScreenDisplayList,
} from "./drawingDisplayList.js";

function drawingPerfNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function finitePoint(
  points: Readonly<Float64Array>,
  pointIndex: number,
): boolean {
  return Number.isFinite(points[pointIndex * 2])
    && Number.isFinite(points[pointIndex * 2 + 1]);
}

function drawLine(
  context: CanvasRenderingContext2D,
  entity: DrawingDisplayEntity,
  list: DrawingScreenDisplayList,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
  bitmapWidth: number,
  bitmapHeight: number,
): void {
  const spec = entity.renderSpec;
  if (!spec || spec.op !== "line") return;
  const anchorAIndex = entity.pointOffset + spec.anchorPointOffset;
  const anchorBIndex = anchorAIndex + 1;
  if (!finitePoint(list.points, anchorAIndex) || !finitePoint(list.points, anchorBIndex)) return;
  const ax = Number(list.points[anchorAIndex * 2]) * horizontalPixelRatio;
  const ay = Number(list.points[anchorAIndex * 2 + 1]) * verticalPixelRatio;
  const bx = Number(list.points[anchorBIndex * 2]) * horizontalPixelRatio;
  const by = Number(list.points[anchorBIndex * 2 + 1]) * verticalPixelRatio;
  const minimumRatio = Math.min(horizontalPixelRatio, verticalPixelRatio);
  const scaledWidth = spec.lineWidthCssPx * minimumRatio;
  let x1 = ax;
  let y1 = ay;
  let x2 = bx;
  let y2 = by;
  if (spec.lineType !== "line-segment") {
    const deltaX = bx - ax;
    const deltaY = by - ay;
    const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY) || 1;
    const unitX = deltaX / length;
    const unitY = deltaY / length;
    const extension = Math.sqrt(bitmapWidth * bitmapWidth + bitmapHeight * bitmapHeight) * 2;
    x2 = ax + unitX * extension;
    y2 = ay + unitY * extension;
    if (spec.lineType === "line-infinite") {
      x1 = ax - unitX * extension;
      y1 = ay - unitY * extension;
    }
  }

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = scaledWidth;
  context.strokeStyle = spec.strokeColor;
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();

  if (spec.drawEndpointDots && !spec.selected) {
    const dotRadius = Math.max(scaledWidth, 3 * minimumRatio);
    context.fillStyle = spec.strokeColor;
    context.globalAlpha = 0.5;
    context.beginPath();
    context.arc(ax, ay, dotRadius, 0, Math.PI * 2);
    context.fill();
    context.beginPath();
    context.arc(bx, by, dotRadius, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 1;
  }

  if (spec.selected) {
    const handleRadius = 6 * minimumRatio;
    context.fillStyle = "#ffffff";
    context.strokeStyle = spec.strokeColor;
    context.lineWidth = 2 * minimumRatio;
    context.shadowColor = "rgba(0,0,0,0.3)";
    context.shadowBlur = 4 * minimumRatio;
    context.beginPath();
    context.arc(ax, ay, handleRadius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.beginPath();
    context.arc(bx, by, handleRadius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.shadowBlur = 0;
    context.strokeStyle = spec.selectionHighlightColor;
    context.lineWidth = Math.max(scaledWidth + 12 * minimumRatio, 16 * minimumRatio);
    context.beginPath();
    context.moveTo(ax, ay);
    context.lineTo(bx, by);
    context.stroke();
  }
  context.restore();
}

function appendAxisSegments(
  context: CanvasRenderingContext2D,
  entity: DrawingDisplayEntity,
  list: DrawingScreenDisplayList,
  segmentCount: number,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
): void {
  const spec = entity.renderSpec;
  if (!spec || spec.op !== "axis-line") return;
  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const firstIndex = entity.pointOffset + spec.segmentPointOffset + segmentIndex * 2;
    const secondIndex = firstIndex + 1;
    if (!finitePoint(list.points, firstIndex) || !finitePoint(list.points, secondIndex)) continue;
    context.moveTo(
      Number(list.points[firstIndex * 2]) * horizontalPixelRatio,
      Number(list.points[firstIndex * 2 + 1]) * verticalPixelRatio,
    );
    context.lineTo(
      Number(list.points[secondIndex * 2]) * horizontalPixelRatio,
      Number(list.points[secondIndex * 2 + 1]) * verticalPixelRatio,
    );
  }
}

function drawAxisLine(
  context: CanvasRenderingContext2D,
  entity: DrawingDisplayEntity,
  list: DrawingScreenDisplayList,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
): void {
  const spec = entity.renderSpec;
  if (!spec || spec.op !== "axis-line") return;
  const minimumRatio = Math.min(horizontalPixelRatio, verticalPixelRatio);
  const scaledWidth = spec.lineWidthCssPx * minimumRatio;
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  if (spec.selected) {
    context.strokeStyle = spec.selectionHighlightColor;
    context.lineWidth = Math.max(scaledWidth + 10 * minimumRatio, 12 * minimumRatio);
    context.beginPath();
    appendAxisSegments(
      context,
      entity,
      list,
      spec.segmentCount,
      horizontalPixelRatio,
      verticalPixelRatio,
    );
    context.stroke();
  }
  context.strokeStyle = spec.strokeColor;
  context.lineWidth = scaledWidth;
  context.beginPath();
  appendAxisSegments(
    context,
    entity,
    list,
    spec.segmentCount,
    horizontalPixelRatio,
    verticalPixelRatio,
  );
  context.stroke();

  if (spec.selected && spec.anchorPointOffset !== null) {
    const anchorIndex = entity.pointOffset + spec.anchorPointOffset;
    if (finitePoint(list.points, anchorIndex)) {
      const x = Number(list.points[anchorIndex * 2]) * horizontalPixelRatio;
      const y = Number(list.points[anchorIndex * 2 + 1]) * verticalPixelRatio;
      context.fillStyle = "#ffffff";
      context.strokeStyle = spec.strokeColor;
      context.lineWidth = 2 * minimumRatio;
      context.shadowColor = "rgba(0,0,0,0.3)";
      context.shadowBlur = 4 * minimumRatio;
      context.beginPath();
      context.arc(x, y, 6 * minimumRatio, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.shadowBlur = 0;
    }
  }
  context.restore();
}

function beginShapePath(
  context: CanvasRenderingContext2D,
  shapeType: "rectangle" | "ellipse",
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  context.beginPath();
  if (shapeType === "ellipse") {
    context.ellipse(
      left + width / 2,
      top + height / 2,
      Math.abs(width / 2),
      Math.abs(height / 2),
      0,
      0,
      Math.PI * 2,
    );
  } else {
    context.rect(left, top, width, height);
  }
}

function drawShapeHandle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
): void {
  context.beginPath();
  context.rect(x - size / 2, y - size / 2, size, size);
  context.fill();
  context.stroke();
}

function drawShape(
  context: CanvasRenderingContext2D,
  entity: DrawingDisplayEntity,
  list: DrawingScreenDisplayList,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
  emptyDashScratch: number[],
  dashedScratch: number[],
  dottedScratch: number[],
  selectionScratch: number[],
): void {
  const spec = entity.renderSpec;
  if (!spec || spec.op !== "shape") return;
  const firstIndex = entity.pointOffset + spec.boxPointOffset;
  const secondIndex = firstIndex + 1;
  if (!finitePoint(list.points, firstIndex) || !finitePoint(list.points, secondIndex)) return;
  const firstX = Number(list.points[firstIndex * 2]) * horizontalPixelRatio;
  const firstY = Number(list.points[firstIndex * 2 + 1]) * verticalPixelRatio;
  const secondX = Number(list.points[secondIndex * 2]) * horizontalPixelRatio;
  const secondY = Number(list.points[secondIndex * 2 + 1]) * verticalPixelRatio;
  const left = Math.min(firstX, secondX);
  const top = Math.min(firstY, secondY);
  const width = Math.abs(secondX - firstX);
  const height = Math.abs(secondY - firstY);
  if (width < 0.5 || height < 0.5) return;
  const minimumRatio = Math.min(horizontalPixelRatio, verticalPixelRatio);

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  if (spec.fillPaintColor !== null) {
    context.fillStyle = spec.fillPaintColor;
    beginShapePath(context, spec.shapeType, left, top, width, height);
    context.fill();
  }
  context.lineWidth = spec.lineWidthCssPx * minimumRatio;
  context.strokeStyle = spec.strokeColor;
  if (spec.lineStyle === "dashed") context.setLineDash(dashedScratch);
  else if (spec.lineStyle === "dotted") context.setLineDash(dottedScratch);
  beginShapePath(context, spec.shapeType, left, top, width, height);
  context.stroke();
  context.setLineDash(emptyDashScratch);

  if (spec.selected) {
    context.strokeStyle = "#3b82f6";
    context.lineWidth = minimumRatio;
    selectionScratch[0] = 4 * horizontalPixelRatio;
    selectionScratch[1] = 3 * horizontalPixelRatio;
    context.setLineDash(selectionScratch);
    context.strokeRect(
      left - 0.5 * horizontalPixelRatio,
      top - 0.5 * verticalPixelRatio,
      width + horizontalPixelRatio,
      height + verticalPixelRatio,
    );
    context.setLineDash(emptyDashScratch);
    const middleX = left + width / 2;
    const middleY = top + height / 2;
    const handleSize = 7 * minimumRatio;
    context.fillStyle = "#ffffff";
    context.strokeStyle = "#3b82f6";
    context.lineWidth = 1.25 * minimumRatio;
    context.shadowColor = "rgba(0,0,0,0.3)";
    context.shadowBlur = 4 * minimumRatio;
    drawShapeHandle(context, left, top, handleSize);
    drawShapeHandle(context, middleX, top, handleSize);
    drawShapeHandle(context, left + width, top, handleSize);
    drawShapeHandle(context, left + width, middleY, handleSize);
    drawShapeHandle(context, left + width, top + height, handleSize);
    drawShapeHandle(context, middleX, top + height, handleSize);
    drawShapeHandle(context, left, top + height, handleSize);
    drawShapeHandle(context, left, middleY, handleSize);
    context.shadowBlur = 0;
  }
  context.restore();
}

function traceFreehandRun(
  context: CanvasRenderingContext2D,
  points: Readonly<Float64Array>,
  startPointIndex: number,
  endPointIndex: number,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
  linearPath: boolean,
): boolean {
  const length = endPointIndex - startPointIndex;
  if (length < 2 || !finitePoint(points, startPointIndex)) return false;
  context.moveTo(
    Number(points[startPointIndex * 2]) * horizontalPixelRatio,
    Number(points[startPointIndex * 2 + 1]) * verticalPixelRatio,
  );
  if (length === 2 || linearPath) {
    for (let pointIndex = startPointIndex + 1; pointIndex < endPointIndex; pointIndex += 1) {
      if (!finitePoint(points, pointIndex)) return false;
      context.lineTo(
        Number(points[pointIndex * 2]) * horizontalPixelRatio,
        Number(points[pointIndex * 2 + 1]) * verticalPixelRatio,
      );
    }
    return true;
  }
  for (let pointIndex = startPointIndex + 1; pointIndex < endPointIndex - 1; pointIndex += 1) {
    if (!finitePoint(points, pointIndex) || !finitePoint(points, pointIndex + 1)) return false;
    const x = Number(points[pointIndex * 2]) * horizontalPixelRatio;
    const y = Number(points[pointIndex * 2 + 1]) * verticalPixelRatio;
    const nextX = Number(points[(pointIndex + 1) * 2]) * horizontalPixelRatio;
    const nextY = Number(points[(pointIndex + 1) * 2 + 1]) * verticalPixelRatio;
    context.quadraticCurveTo(x, y, (x + nextX) / 2, (y + nextY) / 2);
  }
  const penultimate = endPointIndex - 2;
  const last = endPointIndex - 1;
  if (!finitePoint(points, penultimate) || !finitePoint(points, last)) return false;
  context.quadraticCurveTo(
    Number(points[penultimate * 2]) * horizontalPixelRatio,
    Number(points[penultimate * 2 + 1]) * verticalPixelRatio,
    Number(points[last * 2]) * horizontalPixelRatio,
    Number(points[last * 2 + 1]) * verticalPixelRatio,
  );
  return true;
}

function drawFreehand(
  context: CanvasRenderingContext2D,
  entity: DrawingDisplayEntity,
  list: DrawingScreenDisplayList,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
): void {
  const spec = entity.renderSpec;
  if (!spec || spec.op !== "freehand") return;
  const squareBrush = spec.brushShape === "square";
  const linearPath = squareBrush || spec.pathInterpolation === "linear";
  const endPointIndex = entity.pointOffset + entity.pointCount;
  context.save();
  context.lineCap = squareBrush ? "square" : "round";
  context.lineJoin = squareBrush ? "bevel" : "round";
  context.lineWidth = spec.lineWidthCssPx * Math.min(horizontalPixelRatio, verticalPixelRatio);
  context.globalCompositeOperation = spec.selected ? "source-over" : spec.compositeOperation;
  context.strokeStyle = spec.selected ? spec.selectionHighlightColor : spec.strokeColor;
  context.globalAlpha = spec.selected ? 0.6 : spec.opacity;
  context.beginPath();
  let traced = false;
  let runStart = -1;
  for (let pointIndex = entity.pointOffset; pointIndex <= endPointIndex; pointIndex += 1) {
    const finite = pointIndex < endPointIndex && finitePoint(list.points, pointIndex);
    if (finite && runStart < 0) runStart = pointIndex;
    if (finite || runStart < 0) continue;
    traced = traceFreehandRun(
      context,
      list.points,
      runStart,
      pointIndex,
      horizontalPixelRatio,
      verticalPixelRatio,
      linearPath,
    ) || traced;
    runStart = -1;
  }
  if (traced) context.stroke();
  context.restore();
}

function drawFreehandRasterLayer(
  context: CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  layer: DrawingFreehandRasterLayer,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
): void {
  context.save();
  context.globalAlpha = layer.opacity;
  context.globalCompositeOperation = layer.compositeOperation;
  context.drawImage(
    bitmap,
    layer.sourceXPhysicalPx,
    layer.sourceYPhysicalPx,
    layer.sourceWidthPhysicalPx,
    layer.sourceHeightPhysicalPx,
    layer.destinationXCssPx * horizontalPixelRatio,
    layer.destinationYCssPx * verticalPixelRatio,
    layer.destinationWidthCssPx * horizontalPixelRatio,
    layer.destinationHeightCssPx * verticalPixelRatio,
  );
  context.restore();
}

/** Pure canvas consumer: no document, projection, adapter, JSON, or React access. */
export class DrawingSceneRenderer implements PrimitivePaneRenderer {
  readonly #emptyDashScratch: number[] = [];
  readonly #dashedScratch = [6, 4];
  readonly #dottedScratch = [1, 4];
  readonly #selectionScratch = [4, 3];
  readonly #onPainted: ((plan: DrawingScreenDisplayList) => void) | null;
  #plan: DrawingScreenDisplayList | null = null;

  constructor(onPainted: ((plan: DrawingScreenDisplayList) => void) | null = null) {
    this.#onPainted = onPainted;
  }

  setPlan(plan: DrawingScreenDisplayList | null): void {
    const previousBitmap = this.#plan?.freehandRaster?.bitmap;
    const nextBitmap = plan?.freehandRaster?.bitmap;
    if (previousBitmap && previousBitmap !== nextBitmap) {
      try { previousBitmap.close(); } catch { /* already released */ }
    }
    this.#plan = plan;
  }

  plan(): DrawingScreenDisplayList | null {
    return this.#plan;
  }

  draw(target: PrimitiveCanvasTarget): void {
    const plan = this.#plan;
    if (!plan) return;
    const startedAt = drawingPerfNow();
    if (plan.entities.length > 0) {
      target.useBitmapCoordinateSpace((scope) => {
        const horizontalPixelRatio = scope.horizontalPixelRatio;
        const verticalPixelRatio = scope.verticalPixelRatio;
        const raster = plan.freehandRaster;
        const matchingRaster = raster !== undefined
          && raster.widthCssPx === plan.stamp.widthCssPx
          && raster.heightCssPx === plan.stamp.heightCssPx
          && raster.dpr === plan.stamp.dpr
          && raster.bitmap.width === raster.atlasWidthPhysicalPx
          && raster.bitmap.height === raster.atlasHeightPhysicalPx
          ? raster
          : null;
        let rasterLayerCursor = 0;
        let rasterCoveredThroughEntityIndex = -1;
        this.#dashedScratch[0] = 6 * horizontalPixelRatio;
        this.#dashedScratch[1] = 4 * horizontalPixelRatio;
        this.#dottedScratch[0] = horizontalPixelRatio;
        this.#dottedScratch[1] = 4 * horizontalPixelRatio;
        for (let entityIndex = 0; entityIndex < plan.entities.length; entityIndex += 1) {
          if (entityIndex <= rasterCoveredThroughEntityIndex) continue;
          const entity = plan.entities[entityIndex];
          if (!entity) continue;
          const op = entity.renderSpec?.op;
          if (op === "line") {
            drawLine(
              scope.context,
              entity,
              plan,
              horizontalPixelRatio,
              verticalPixelRatio,
              scope.bitmapSize.width,
              scope.bitmapSize.height,
            );
          } else if (op === "axis-line") {
            drawAxisLine(
              scope.context,
              entity,
              plan,
              horizontalPixelRatio,
              verticalPixelRatio,
            );
          } else if (op === "shape") {
            drawShape(
              scope.context,
              entity,
              plan,
              horizontalPixelRatio,
              verticalPixelRatio,
              this.#emptyDashScratch,
              this.#dashedScratch,
              this.#dottedScratch,
              this.#selectionScratch,
            );
          } else if (op === "freehand") {
            const layer = matchingRaster?.layers[rasterLayerCursor];
            if (matchingRaster && layer?.entityIndex === entityIndex) {
              drawFreehandRasterLayer(
                scope.context,
                matchingRaster.bitmap,
                layer,
                horizontalPixelRatio,
                verticalPixelRatio,
              );
              rasterCoveredThroughEntityIndex = layer.lastEntityIndex;
              rasterLayerCursor += 1;
              continue;
            }
            drawFreehand(
              scope.context,
              entity,
              plan,
              horizontalPixelRatio,
              verticalPixelRatio,
            );
          }
        }
      });
    }
    const durationMs = Math.max(0, drawingPerfNow() - startedAt);
    accumulateDrawingPerfFrameWork({
      drawingMainThreadMs: durationMs,
      sceneProjectPaintMs: durationMs,
    });
    // A non-null empty display list is still a visible scene state: invoking
    // draw proves that the chart consumed that exact empty revision. Null
    // means no scene is published and therefore cannot acknowledge anything.
    this.#onPainted?.(plan);
  }
}
