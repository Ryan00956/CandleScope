import type {
  DrawingDisplayEntity,
  DrawingDisplayRenderSpec,
  DrawingScreenDisplayList,
} from "./drawingDisplayList.js";

type TextSceneRenderSpec = Extract<DrawingDisplayRenderSpec, Readonly<{ op: "text" }>>;

interface CssPoint {
  readonly x: number;
  readonly y: number;
}

const TEXT_HANDLE_KEYS = ["tl", "t", "tr", "r", "br", "b", "bl", "l"] as const;

function textSpec(entity: DrawingDisplayEntity): TextSceneRenderSpec | null {
  const spec = entity.renderSpec;
  return spec?.op === "text" ? spec : null;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validTextSpec(spec: TextSceneRenderSpec): boolean {
  return typeof spec.strokeColor === "string"
    && finiteNonNegative(spec.lineWidthCssPx)
    && typeof spec.selected === "boolean"
    && Number.isInteger(spec.boxPointOffset)
    && spec.boxPointOffset >= 0
    && spec.lines.length > 0
    && spec.lines.every((line) => (
      typeof line.text === "string" && finiteNonNegative(line.widthCssPx)
    ))
    && typeof spec.textColor === "string"
    && finiteNonNegative(spec.fontSizeCssPx)
    && spec.fontSizeCssPx > 0
    && typeof spec.fontFamily === "string"
    && spec.fontFamily.length > 0
    && typeof spec.bold === "boolean"
    && typeof spec.italic === "boolean"
    && typeof spec.underline === "boolean"
    && (spec.align === "left" || spec.align === "center" || spec.align === "right")
    && (spec.backgroundColor === null || typeof spec.backgroundColor === "string")
    && (spec.borderColor === null || typeof spec.borderColor === "string")
    && finiteNonNegative(spec.borderWidthCssPx)
    && finiteNonNegative(spec.paddingCssPx)
    && finiteNonNegative(spec.lineHeightCssPx)
    && spec.lineHeightCssPx > 0
    && typeof spec.selectionColor === "string";
}

function cssPoint(
  entity: DrawingDisplayEntity,
  list: DrawingScreenDisplayList,
  localPointOffset: number,
): CssPoint | null {
  if (!Number.isInteger(localPointOffset)
    || localPointOffset < 0
    || localPointOffset >= entity.pointCount) return null;
  const pointIndex = entity.pointOffset + localPointOffset;
  const x = Number(list.points[pointIndex * 2]);
  const y = Number(list.points[pointIndex * 2 + 1]);
  return Number.isFinite(x) && Number.isFinite(y)
    ? Object.freeze({ x, y })
    : null;
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const resolvedRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + resolvedRadius, y);
  context.lineTo(x + width - resolvedRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + resolvedRadius);
  context.lineTo(x + width, y + height - resolvedRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - resolvedRadius, y + height);
  context.lineTo(x + resolvedRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - resolvedRadius);
  context.lineTo(x, y + resolvedRadius);
  context.quadraticCurveTo(x, y, x + resolvedRadius, y);
  context.closePath();
}

function fontString(spec: TextSceneRenderSpec): string {
  return `${spec.italic ? "italic " : ""}${spec.bold ? "bold " : ""}`
    + `${spec.fontSizeCssPx}px ${spec.fontFamily}`;
}

function handlePositions(
  x: number,
  y: number,
  width: number,
  height: number,
): Readonly<Record<typeof TEXT_HANDLE_KEYS[number], CssPoint>> {
  return Object.freeze({
    tl: Object.freeze({ x, y }),
    t: Object.freeze({ x: x + width / 2, y }),
    tr: Object.freeze({ x: x + width, y }),
    r: Object.freeze({ x: x + width, y: y + height / 2 }),
    br: Object.freeze({ x: x + width, y: y + height }),
    b: Object.freeze({ x: x + width / 2, y: y + height }),
    bl: Object.freeze({ x, y: y + height }),
    l: Object.freeze({ x, y: y + height / 2 }),
  });
}

/** Paint one fully projected text entity using the legacy CSS-pixel contract. */
export function drawTextSceneEntity(
  context: CanvasRenderingContext2D,
  entity: DrawingDisplayEntity,
  list: DrawingScreenDisplayList,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
): void {
  const spec = textSpec(entity);
  if (!spec
    || !validTextSpec(spec)
    || !Number.isFinite(horizontalPixelRatio)
    || horizontalPixelRatio <= 0
    || !Number.isFinite(verticalPixelRatio)
    || verticalPixelRatio <= 0) return;

  const topLeft = cssPoint(entity, list, spec.boxPointOffset);
  const bottomRight = cssPoint(entity, list, spec.boxPointOffset + 1);
  if (!topLeft || !bottomRight) return;
  const boxWidth = bottomRight.x - topLeft.x;
  const boxHeight = bottomRight.y - topLeft.y;
  if (!finiteNonNegative(boxWidth) || !finiteNonNegative(boxHeight)) return;

  const boxX = topLeft.x;
  const boxY = topLeft.y;
  const innerWidth = Math.max(0, boxWidth - spec.paddingCssPx * 2);

  context.save();
  context.scale(horizontalPixelRatio, verticalPixelRatio);
  context.font = fontString(spec);
  context.textAlign = "left";
  context.textBaseline = "top";

  if (spec.backgroundColor && spec.backgroundColor !== "transparent") {
    context.fillStyle = spec.backgroundColor;
    roundedRect(context, boxX, boxY, boxWidth, boxHeight, 4);
    context.fill();
  }

  if (spec.borderColor && spec.borderColor !== "transparent") {
    context.strokeStyle = spec.borderColor;
    context.lineWidth = spec.borderWidthCssPx || 1;
    roundedRect(context, boxX, boxY, boxWidth, boxHeight, 4);
    context.stroke();
  }

  context.fillStyle = spec.textColor;
  context.globalAlpha = 1;
  spec.lines.forEach((line, index) => {
    let lineX = boxX + spec.paddingCssPx;
    if (spec.align === "center") {
      lineX += (innerWidth - line.widthCssPx) / 2;
    } else if (spec.align === "right") {
      lineX += innerWidth - line.widthCssPx;
    }
    const lineY = boxY + spec.paddingCssPx + index * spec.lineHeightCssPx;
    context.fillText(line.text, lineX, lineY);

    if (spec.underline) {
      const underlineY = lineY + spec.fontSizeCssPx + 1;
      context.beginPath();
      context.moveTo(lineX, underlineY);
      context.lineTo(lineX + line.widthCssPx, underlineY);
      context.lineWidth = Math.max(1, spec.fontSizeCssPx / 14);
      context.strokeStyle = spec.textColor;
      context.stroke();
    }
  });

  if (spec.selected) {
    context.globalAlpha = 1;
    context.strokeStyle = spec.selectionColor;
    context.lineWidth = 1;
    context.setLineDash([4, 3]);
    context.strokeRect(boxX - 0.5, boxY - 0.5, boxWidth + 1, boxHeight + 1);
    context.setLineDash([]);

    const handles = handlePositions(boxX, boxY, boxWidth, boxHeight);
    const handleSize = 7;
    context.fillStyle = "#ffffff";
    context.strokeStyle = spec.selectionColor;
    context.lineWidth = 1.25;
    for (const key of TEXT_HANDLE_KEYS) {
      const point = handles[key];
      context.beginPath();
      context.rect(
        point.x - handleSize / 2,
        point.y - handleSize / 2,
        handleSize,
        handleSize,
      );
      context.fill();
      context.stroke();
    }
  }

  context.restore();
}
