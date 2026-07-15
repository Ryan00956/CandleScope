import type {
  DrawingDisplayEntity,
  DrawingScreenDisplayList,
} from "./drawingDisplayList.js";

interface BitmapPoint {
  readonly x: number;
  readonly y: number;
}

interface FibonacciLevelPaint {
  readonly color: string;
  readonly level: number;
  readonly logicalPrice: number;
  readonly start: BitmapPoint;
  readonly end: BitmapPoint;
  readonly y: number;
}

function bitmapPoint(
  entity: DrawingDisplayEntity,
  list: DrawingScreenDisplayList,
  localPointOffset: number,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
): BitmapPoint | null {
  if (!Number.isSafeInteger(localPointOffset)
    || localPointOffset < 0
    || localPointOffset >= entity.pointCount) return null;
  const pointIndex = entity.pointOffset + localPointOffset;
  const x = Number(list.points[pointIndex * 2]);
  const y = Number(list.points[pointIndex * 2 + 1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return Object.freeze({
    x: x * horizontalPixelRatio,
    y: y * verticalPixelRatio,
  });
}

function pointPair(
  entity: DrawingDisplayEntity,
  list: DrawingScreenDisplayList,
  localPointOffset: number,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
): readonly [BitmapPoint, BitmapPoint] | null {
  const first = bitmapPoint(
    entity,
    list,
    localPointOffset,
    horizontalPixelRatio,
    verticalPixelRatio,
  );
  const second = bitmapPoint(
    entity,
    list,
    localPointOffset + 1,
    horizontalPixelRatio,
    verticalPixelRatio,
  );
  return first && second ? Object.freeze([first, second]) : null;
}

/** Paint one fully projected Fibonacci entity without consulting document geometry. */
export function drawFibonacciSceneEntity(
  context: CanvasRenderingContext2D,
  entity: DrawingDisplayEntity,
  list: DrawingScreenDisplayList,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
): void {
  const spec = entity.renderSpec;
  if (!spec
    || spec.op !== "fibonacci"
    || !Number.isFinite(horizontalPixelRatio)
    || horizontalPixelRatio <= 0
    || !Number.isFinite(verticalPixelRatio)
    || verticalPixelRatio <= 0
    || !Number.isFinite(spec.lineWidthCssPx)
    || spec.lineWidthCssPx <= 0
    || !Number.isFinite(spec.startPrice)
    || !Number.isFinite(spec.endPrice)) return;

  const trend = pointPair(
    entity,
    list,
    spec.trendPointOffset,
    horizontalPixelRatio,
    verticalPixelRatio,
  );
  if (!trend) return;

  const levelData: FibonacciLevelPaint[] = [];
  for (const level of spec.levelLines) {
    if (!Number.isFinite(level.level) || !Number.isFinite(level.logicalPrice)) return;
    const line = pointPair(
      entity,
      list,
      level.pointOffset,
      horizontalPixelRatio,
      verticalPixelRatio,
    );
    if (!line) return;
    levelData.push(Object.freeze({
      color: level.color,
      level: level.level,
      logicalPrice: level.logicalPrice,
      start: line[0],
      end: line[1],
      y: line[0].y,
    }));
  }
  levelData.sort((left, right) => left.y - right.y);

  const minimumRatio = Math.min(horizontalPixelRatio, verticalPixelRatio);
  const scaledWidth = spec.lineWidthCssPx * minimumRatio;
  const [anchorA, anchorB] = trend;
  const minX = Math.min(anchorA.x, anchorB.x);
  const maxX = Math.max(anchorA.x, anchorB.x);

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = scaledWidth;
  context.strokeStyle = spec.strokeColor;

  context.setLineDash([4 * horizontalPixelRatio, 4 * horizontalPixelRatio]);
  context.beginPath();
  context.moveTo(anchorA.x, anchorA.y);
  context.lineTo(anchorB.x, anchorB.y);
  context.stroke();
  context.setLineDash([]);

  context.globalAlpha = 0.1;
  for (let index = 0; index < levelData.length - 1; index += 1) {
    const first = levelData[index];
    const second = levelData[index + 1];
    if (!first || !second) continue;
    context.fillStyle = second.color;
    context.fillRect(minX, first.y, maxX - minX, second.y - first.y);
  }
  context.globalAlpha = 1;

  context.font = `${11 * horizontalPixelRatio}px sans-serif`;
  context.textAlign = "left";
  context.textBaseline = "bottom";
  for (const level of levelData) {
    context.strokeStyle = level.color;
    context.fillStyle = level.color;
    context.lineWidth = scaledWidth;
    context.beginPath();
    context.moveTo(level.start.x, level.start.y);
    context.lineTo(level.end.x, level.end.y);
    context.stroke();
    context.fillText(
      `${level.level} (${level.logicalPrice.toFixed(2)})`,
      minX + 4 * horizontalPixelRatio,
      level.y - 2 * verticalPixelRatio,
    );
  }

  if (!spec.selected) {
    const dotRadius = Math.max(scaledWidth, 3 * minimumRatio);
    context.fillStyle = spec.strokeColor;
    context.globalAlpha = 0.5;
    for (const anchor of trend) {
      context.beginPath();
      context.arc(anchor.x, anchor.y, dotRadius, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  } else {
    const handleRadius = 6 * minimumRatio;
    context.fillStyle = "#ffffff";
    context.strokeStyle = spec.strokeColor;
    context.lineWidth = 2 * minimumRatio;
    context.shadowColor = "rgba(0,0,0,0.3)";
    context.shadowBlur = 4 * minimumRatio;
    for (const anchor of trend) {
      context.beginPath();
      context.arc(anchor.x, anchor.y, handleRadius, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
    context.shadowBlur = 0;

    context.strokeStyle = spec.selectionHighlightColor;
    context.lineWidth = Math.max(
      scaledWidth + 12 * minimumRatio,
      16 * minimumRatio,
    );
    context.beginPath();
    context.moveTo(anchorA.x, anchorA.y);
    context.lineTo(anchorB.x, anchorB.y);
    context.stroke();
  }

  context.restore();
}
