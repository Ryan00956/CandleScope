import type {
  DrawingDisplayEntity,
  DrawingDisplayRenderSpec,
  DrawingScreenDisplayList,
} from "./drawingDisplayList.js";

type AngleSceneRenderSpec = Extract<DrawingDisplayRenderSpec, Readonly<{ op: "angle" }>>;

interface BitmapPoint {
  readonly x: number;
  readonly y: number;
}

function adjustAlpha(color: string, alpha: number): string {
  if (!color || color === "transparent") return "transparent";
  const normalizedAlpha = Math.max(0, Math.min(1, Number(alpha)));

  if (color.startsWith("rgba")) {
    const match = color.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
    if (match) {
      const baseAlpha = Math.max(0, Math.min(1, Number(match[4])));
      return `rgba(${match[1]},${match[2]},${match[3]},${baseAlpha * normalizedAlpha})`;
    }
  }
  if (color.startsWith("rgb")) {
    const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (match) return `rgba(${match[1]},${match[2]},${match[3]},${normalizedAlpha})`;
  }

  let red = 0;
  let green = 0;
  let blue = 0;
  if (color.length === 4) {
    red = Number.parseInt(color.charAt(1).repeat(2), 16);
    green = Number.parseInt(color.charAt(2).repeat(2), 16);
    blue = Number.parseInt(color.charAt(3).repeat(2), 16);
  } else if (color.length === 7) {
    red = Number.parseInt(color.slice(1, 3), 16);
    green = Number.parseInt(color.slice(3, 5), 16);
    blue = Number.parseInt(color.slice(5, 7), 16);
  } else {
    return color;
  }
  return `rgba(${red},${green},${blue},${normalizedAlpha})`;
}

function bitmapPoint(
  entity: DrawingDisplayEntity,
  list: DrawingScreenDisplayList,
  localPointOffset: number,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
): BitmapPoint | null {
  if (!Number.isInteger(localPointOffset)
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

function angleSpec(entity: DrawingDisplayEntity): AngleSceneRenderSpec | null {
  const spec = entity.renderSpec;
  return spec?.op === "angle" ? spec : null;
}

/** Paint one fully projected angle entity without consulting document geometry. */
export function drawAngleSceneEntity(
  context: CanvasRenderingContext2D,
  entity: DrawingDisplayEntity,
  list: DrawingScreenDisplayList,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
): void {
  const spec = angleSpec(entity);
  if (!spec
    || !Number.isFinite(horizontalPixelRatio)
    || horizontalPixelRatio <= 0
    || !Number.isFinite(verticalPixelRatio)
    || verticalPixelRatio <= 0
    || !Number.isFinite(spec.lineWidthCssPx)
    || spec.lineWidthCssPx <= 0
    || !Number.isInteger(spec.arcPointCount)
    || spec.arcPointCount < 2) return;

  const ray = pointPair(
    entity,
    list,
    spec.rayPointOffset,
    horizontalPixelRatio,
    verticalPixelRatio,
  );
  const baseline = pointPair(
    entity,
    list,
    spec.baselinePointOffset,
    horizontalPixelRatio,
    verticalPixelRatio,
  );
  const labelBox = pointPair(
    entity,
    list,
    spec.labelBoxPointOffset,
    horizontalPixelRatio,
    verticalPixelRatio,
  );
  const arcPoints: BitmapPoint[] = [];
  for (let index = 0; index < spec.arcPointCount; index += 1) {
    const point = bitmapPoint(
      entity,
      list,
      spec.arcPointOffset + index,
      horizontalPixelRatio,
      verticalPixelRatio,
    );
    if (!point) return;
    arcPoints.push(point);
  }
  if (!ray || !baseline || !labelBox) return;

  const minimumRatio = Math.min(horizontalPixelRatio, verticalPixelRatio);
  const scaledWidth = spec.lineWidthCssPx * minimumRatio;
  const [rayStart, rayEnd] = ray;

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";

  if (spec.selected) {
    context.strokeStyle = spec.selectionHighlightColor;
    context.lineWidth = Math.max(scaledWidth + 10 * minimumRatio, 12 * minimumRatio);
    context.beginPath();
    context.moveTo(rayStart.x, rayStart.y);
    context.lineTo(rayEnd.x, rayEnd.y);
    context.stroke();
  }

  context.strokeStyle = spec.strokeColor;
  context.lineWidth = scaledWidth;
  context.beginPath();
  context.moveTo(rayStart.x, rayStart.y);
  context.lineTo(rayEnd.x, rayEnd.y);
  context.stroke();

  context.save();
  context.globalAlpha = 0.65;
  context.setLineDash([4 * horizontalPixelRatio, 4 * horizontalPixelRatio]);
  context.beginPath();
  context.moveTo(baseline[0].x, baseline[0].y);
  context.lineTo(baseline[1].x, baseline[1].y);
  context.stroke();
  context.restore();

  context.setLineDash([]);
  context.globalAlpha = 1;
  context.strokeStyle = spec.strokeColor;
  context.lineWidth = Math.max(1.5 * minimumRatio, scaledWidth * 0.85);
  context.beginPath();
  const firstArcPoint = arcPoints[0];
  if (!firstArcPoint) {
    context.restore();
    return;
  }
  context.moveTo(firstArcPoint.x, firstArcPoint.y);
  for (let index = 1; index < arcPoints.length; index += 1) {
    const point = arcPoints[index];
    if (point) context.lineTo(point.x, point.y);
  }
  context.stroke();

  const boxLeft = Math.min(labelBox[0].x, labelBox[1].x);
  const boxTop = Math.min(labelBox[0].y, labelBox[1].y);
  const boxWidth = Math.abs(labelBox[1].x - labelBox[0].x);
  const boxHeight = Math.abs(labelBox[1].y - labelBox[0].y);
  const labelX = boxLeft + boxWidth / 2;
  const labelY = boxTop + boxHeight / 2;
  context.font = `600 ${11 * minimumRatio}px sans-serif`;
  context.textBaseline = "middle";
  context.textAlign = "center";
  context.fillStyle = "rgba(15, 23, 42, 0.86)";
  context.strokeStyle = adjustAlpha(spec.strokeColor, 0.55);
  context.lineWidth = minimumRatio;
  context.beginPath();
  context.roundRect(boxLeft, boxTop, boxWidth, boxHeight, 4 * minimumRatio);
  context.fill();
  context.stroke();
  context.fillStyle = spec.strokeColor;
  context.fillText(spec.labelText, labelX, labelY + 0.5 * verticalPixelRatio);

  const handleRadius = (spec.selected ? 6 : 3.5) * minimumRatio;
  context.fillStyle = spec.selected ? "#ffffff" : adjustAlpha(spec.strokeColor, 0.5);
  context.strokeStyle = spec.strokeColor;
  context.lineWidth = (spec.selected ? 2 : 1.25) * minimumRatio;
  context.shadowColor = "rgba(0,0,0,0.3)";
  context.shadowBlur = spec.selected ? 4 * minimumRatio : 0;
  for (const point of ray) {
    context.beginPath();
    context.arc(point.x, point.y, handleRadius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
  context.shadowBlur = 0;
  context.restore();
}
