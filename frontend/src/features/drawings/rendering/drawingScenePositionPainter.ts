import type {
  DrawingDisplayEntity,
  DrawingScreenDisplayList,
} from "./drawingDisplayList.js";

type PositionSceneRenderSpec = Extract<
  NonNullable<DrawingDisplayEntity["renderSpec"]>,
  { readonly op: "position" }
>;
type PositionLevelSpec = NonNullable<PositionSceneRenderSpec["tpLevel"]>;

interface BitmapPoint {
  readonly x: number;
  readonly y: number;
}

interface BitmapBox {
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
}

interface PositionLevelPaint {
  readonly body: BitmapBox;
  readonly line: readonly [BitmapPoint, BitmapPoint];
  readonly spec: PositionLevelSpec;
}

function adjustAlpha(color: string, alpha: number): string {
  let red = 0;
  let green = 0;
  let blue = 0;
  if (color.startsWith("rgba")) {
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    const [, r, g, b] = match ?? [];
    if (r && g && b) {
      red = Number(r);
      green = Number(g);
      blue = Number(b);
    }
  } else if (color.startsWith("rgb")) {
    const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
    const [, r, g, b] = match ?? [];
    if (r && g && b) {
      red = Number(r);
      green = Number(g);
      blue = Number(b);
    }
  } else if (color.length === 4) {
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
  return `rgba(${red},${green},${blue},${alpha})`;
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

function boxFromPair(pair: readonly [BitmapPoint, BitmapPoint]): BitmapBox {
  const left = Math.min(pair[0].x, pair[1].x);
  const right = Math.max(pair[0].x, pair[1].x);
  const top = Math.min(pair[0].y, pair[1].y);
  const bottom = Math.max(pair[0].y, pair[1].y);
  return Object.freeze({
    bottom,
    height: bottom - top,
    left,
    right,
    top,
    width: right - left,
  });
}

function bitmapHandle(
  entity: DrawingDisplayEntity,
  list: DrawingScreenDisplayList,
  name: string,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
): BitmapPoint | null {
  const localIndex = entity.handleNames.indexOf(name);
  if (localIndex < 0 || localIndex >= entity.handleCount) return null;
  const pointIndex = entity.handleOffset + localIndex;
  const x = Number(list.handles[pointIndex * 2]);
  const y = Number(list.handles[pointIndex * 2 + 1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return Object.freeze({
    x: x * horizontalPixelRatio,
    y: y * verticalPixelRatio,
  });
}

function validLevelSpec(level: PositionLevelSpec | null): level is PositionLevelSpec {
  return !!level
    && typeof level.priceText === "string"
    && typeof level.percentText === "string"
    && (level.pnlText === null || typeof level.pnlText === "string")
    && typeof level.color === "string";
}

function validPanelLine(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const line = value as Record<string, unknown>;
  return typeof line.label === "string"
    && typeof line.value === "string"
    && (line.extra === null || typeof line.extra === "string")
    && typeof line.color === "string";
}

function resolveLevelPaint(
  entity: DrawingDisplayEntity,
  list: DrawingScreenDisplayList,
  level: PositionLevelSpec | null,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
): PositionLevelPaint | null {
  if (!validLevelSpec(level)) return null;
  const line = pointPair(
    entity,
    list,
    level.linePointOffset,
    horizontalPixelRatio,
    verticalPixelRatio,
  );
  const body = pointPair(
    entity,
    list,
    level.bodyPointOffset,
    horizontalPixelRatio,
    verticalPixelRatio,
  );
  return line && body ? Object.freeze({
    body: boxFromPair(body),
    line,
    spec: level,
  }) : null;
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function drawPriceBadge(
  context: CanvasRenderingContext2D,
  level: PositionLevelPaint,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
  minimumRatio: number,
): void {
  const textParts = [level.spec.priceText, level.spec.percentText];
  if (level.spec.pnlText) textParts.push(level.spec.pnlText);
  const text = textParts.join("  ");
  const fontSize = 10 * minimumRatio;
  context.font = `${fontSize}px sans-serif`;
  context.textAlign = "left";
  context.textBaseline = "middle";
  const textWidth = context.measureText(text).width;
  const paddingX = 6 * horizontalPixelRatio;
  const paddingY = 4 * verticalPixelRatio;
  const width = textWidth + paddingX * 2;
  const height = fontSize + paddingY * 2;
  const right = Math.max(level.line[0].x, level.line[1].x);
  const y = (level.line[0].y + level.line[1].y) / 2;
  const x = right + 4 * horizontalPixelRatio;
  const top = y - height / 2;

  context.fillStyle = adjustAlpha(level.spec.color, 0.9);
  roundRect(context, x, top, width, height, 3 * minimumRatio);
  context.fill();
  context.fillStyle = "#ffffff";
  context.fillText(text, x + paddingX, y);
}

function drawLevel(
  context: CanvasRenderingContext2D,
  level: PositionLevelPaint,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
  minimumRatio: number,
): void {
  context.fillStyle = adjustAlpha(level.spec.color, 0.15);
  context.fillRect(
    level.body.left,
    level.body.top,
    level.body.width,
    level.body.height,
  );
  context.strokeStyle = adjustAlpha(level.spec.color, 0.8);
  context.lineWidth = 2 * minimumRatio;
  context.setLineDash([6 * horizontalPixelRatio, 3 * horizontalPixelRatio]);
  context.beginPath();
  context.moveTo(level.line[0].x, level.line[0].y);
  context.lineTo(level.line[1].x, level.line[1].y);
  context.stroke();
  context.setLineDash([]);
  drawPriceBadge(
    context,
    level,
    horizontalPixelRatio,
    verticalPixelRatio,
    minimumRatio,
  );
}

function drawInfoPanel(
  context: CanvasRenderingContext2D,
  spec: PositionSceneRenderSpec,
  box: BitmapBox,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
  minimumRatio: number,
): void {
  const fontSize = 11 * minimumRatio;
  const lineHeight = fontSize + 6 * verticalPixelRatio;
  const paddingX = 8 * horizontalPixelRatio;
  const paddingY = 6 * verticalPixelRatio;

  context.fillStyle = "rgba(30, 33, 40, 0.92)";
  context.shadowColor = "rgba(0,0,0,0.4)";
  context.shadowBlur = 8 * minimumRatio;
  roundRect(context, box.left, box.top, box.width, box.height, 6 * minimumRatio);
  context.fill();
  context.shadowBlur = 0;

  context.strokeStyle = "rgba(255,255,255,0.08)";
  context.lineWidth = minimumRatio;
  roundRect(context, box.left, box.top, box.width, box.height, 6 * minimumRatio);
  context.stroke();
  context.textAlign = "left";
  context.textBaseline = "middle";

  spec.panelLines.forEach((line, index) => {
    const y = box.top + paddingY + lineHeight * index + lineHeight / 2;
    const label = `${line.label}: `;
    context.fillStyle = "rgba(255,255,255,0.5)";
    context.font = `${fontSize}px sans-serif`;
    context.fillText(label, box.left + paddingX, y);
    const labelWidth = context.measureText(label).width;

    context.fillStyle = line.color;
    context.font = `bold ${fontSize}px sans-serif`;
    context.fillText(line.value, box.left + paddingX + labelWidth, y);
    if (line.extra) {
      const valueWidth = context.measureText(`${line.value} `).width;
      context.fillStyle = adjustAlpha(line.color, 0.7);
      context.font = `${fontSize}px sans-serif`;
      context.fillText(line.extra, box.left + paddingX + labelWidth + valueWidth, y);
    }
  });

  if (!spec.selected) return;
  context.strokeStyle = "rgba(59, 130, 246, 0.55)";
  context.lineWidth = minimumRatio;
  context.setLineDash([4 * horizontalPixelRatio, 3 * horizontalPixelRatio]);
  roundRect(
    context,
    box.left - horizontalPixelRatio,
    box.top - verticalPixelRatio,
    box.width + 2 * horizontalPixelRatio,
    box.height + 2 * verticalPixelRatio,
    6 * minimumRatio,
  );
  context.stroke();
  context.setLineDash([]);

  const dotRadius = 1.2 * minimumRatio;
  const gripX = box.right - 13 * horizontalPixelRatio;
  const gripY = box.top + 9 * verticalPixelRatio;
  context.fillStyle = "rgba(255,255,255,0.55)";
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      context.beginPath();
      context.arc(
        gripX + column * 5 * horizontalPixelRatio,
        gripY + row * 5 * verticalPixelRatio,
        dotRadius,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
  }
}

function drawDirectionBadge(
  context: CanvasRenderingContext2D,
  spec: PositionSceneRenderSpec,
  entry: readonly [BitmapPoint, BitmapPoint],
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
  minimumRatio: number,
): void {
  const left = Math.min(entry[0].x, entry[1].x);
  const y = (entry[0].y + entry[1].y) / 2;
  const width = 48 * horizontalPixelRatio;
  const height = 20 * verticalPixelRatio;
  const x = left + 4 * horizontalPixelRatio;
  const top = y - height - 4 * verticalPixelRatio;
  context.fillStyle = spec.badgeColor;
  roundRect(context, x, top, width, height, 4 * minimumRatio);
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = `bold ${11 * minimumRatio}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(spec.badgeText, x + width / 2, top + height / 2);
}

function drawEntryHandle(
  context: CanvasRenderingContext2D,
  point: BitmapPoint,
  color: string,
  minimumRatio: number,
): void {
  context.fillStyle = "#ffffff";
  context.strokeStyle = color;
  context.lineWidth = 2 * minimumRatio;
  context.shadowColor = "rgba(0,0,0,0.3)";
  context.shadowBlur = 4 * minimumRatio;
  context.beginPath();
  context.arc(point.x, point.y, 5 * minimumRatio, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.shadowBlur = 0;
}

function drawDragBar(
  context: CanvasRenderingContext2D,
  level: PositionLevelPaint,
  arrowDirection: "up" | "down",
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
  minimumRatio: number,
): void {
  const left = Math.min(level.line[0].x, level.line[1].x);
  const right = Math.max(level.line[0].x, level.line[1].x);
  const y = (level.line[0].y + level.line[1].y) / 2;
  const height = 6 * verticalPixelRatio;
  const width = Math.min(60 * horizontalPixelRatio, (right - left) * 0.4);
  const middleX = (left + right) / 2;
  const x = middleX - width / 2;
  context.fillStyle = adjustAlpha(level.spec.color, 0.6);
  roundRect(context, x, y - height / 2, width, height, 3 * minimumRatio);
  context.fill();

  const arrowSize = 4 * minimumRatio;
  context.fillStyle = "#ffffff";
  context.beginPath();
  if (arrowDirection === "up") {
    context.moveTo(middleX, y - arrowSize);
    context.lineTo(middleX - arrowSize, y + arrowSize * 0.5);
    context.lineTo(middleX + arrowSize, y + arrowSize * 0.5);
  } else {
    context.moveTo(middleX, y + arrowSize);
    context.lineTo(middleX - arrowSize, y - arrowSize * 0.5);
    context.lineTo(middleX + arrowSize, y - arrowSize * 0.5);
  }
  context.closePath();
  context.fill();
}

function drawEdgeHandle(
  context: CanvasRenderingContext2D,
  point: BitmapPoint,
  top: number,
  bottom: number,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
  minimumRatio: number,
): void {
  const width = 4 * horizontalPixelRatio;
  const height = Math.min(24 * verticalPixelRatio, Math.abs(bottom - top) * 0.4);
  if (height < 4 * verticalPixelRatio) return;
  const x = point.x - width / 2;
  const y = point.y - height / 2;
  context.fillStyle = adjustAlpha("#90a4ae", 0.7);
  roundRect(context, x, y, width, height, 2 * minimumRatio);
  context.fill();

  context.strokeStyle = adjustAlpha("#ffffff", 0.6);
  context.lineWidth = minimumRatio;
  const gripGap = 3 * verticalPixelRatio;
  const gripCount = Math.min(3, Math.floor(height / (gripGap * 1.5)));
  const gripStart = point.y - (gripCount - 1) * gripGap / 2;
  for (let index = 0; index < gripCount; index += 1) {
    const gripY = gripStart + index * gripGap;
    context.beginPath();
    context.moveTo(x + horizontalPixelRatio, gripY);
    context.lineTo(x + width - horizontalPixelRatio, gripY);
    context.stroke();
  }
}

function drawCornerHandle(
  context: CanvasRenderingContext2D,
  point: BitmapPoint,
  minimumRatio: number,
): void {
  const size = 8 * minimumRatio;
  const half = size / 2;
  context.fillStyle = "#ffffff";
  context.strokeStyle = adjustAlpha("#90a4ae", 0.9);
  context.lineWidth = 1.5 * minimumRatio;
  context.shadowColor = "rgba(0,0,0,0.3)";
  context.shadowBlur = 3 * minimumRatio;
  roundRect(context, point.x - half, point.y - half, size, size, minimumRatio);
  context.fill();
  context.stroke();
  context.shadowBlur = 0;
}

/** Paint one committed, fully projected position entity. */
export function drawPositionSceneEntity(
  context: CanvasRenderingContext2D,
  entity: DrawingDisplayEntity,
  list: DrawingScreenDisplayList,
  horizontalPixelRatio: number,
  verticalPixelRatio: number,
): void {
  const spec = entity.renderSpec;
  const panelLines: unknown = spec?.op === "position" ? spec.panelLines : null;
  if (entity.kind !== "position"
    || !spec
    || spec.op !== "position"
    || !Number.isFinite(horizontalPixelRatio)
    || horizontalPixelRatio <= 0
    || !Number.isFinite(verticalPixelRatio)
    || verticalPixelRatio <= 0
    || !Number.isFinite(spec.lineWidthCssPx)
    || spec.lineWidthCssPx <= 0
    || typeof spec.strokeColor !== "string"
    || typeof spec.entryColor !== "string"
    || typeof spec.upColor !== "string"
    || typeof spec.downColor !== "string"
    || (spec.direction !== "long" && spec.direction !== "short")
    || !Array.isArray(panelLines)
    || panelLines.length === 0
    || panelLines.some((line: unknown) => !validPanelLine(line))
    || (spec.badgeText !== "LONG" && spec.badgeText !== "SHORT")
    || typeof spec.badgeColor !== "string") return;

  const entry = pointPair(
    entity,
    list,
    spec.entryLinePointOffset,
    horizontalPixelRatio,
    verticalPixelRatio,
  );
  const panelPair = pointPair(
    entity,
    list,
    spec.panelBoxPointOffset,
    horizontalPixelRatio,
    verticalPixelRatio,
  );
  if (!entry || !panelPair) return;
  const panel = boxFromPair(panelPair);

  const tp = spec.tpLevel === null
    ? null
    : resolveLevelPaint(
      entity,
      list,
      spec.tpLevel,
      horizontalPixelRatio,
      verticalPixelRatio,
    );
  const sl = spec.slLevel === null
    ? null
    : resolveLevelPaint(
      entity,
      list,
      spec.slLevel,
      horizontalPixelRatio,
      verticalPixelRatio,
    );
  if ((spec.tpLevel !== null && !tp) || (spec.slLevel !== null && !sl)) return;

  let entryHandle: BitmapPoint | null = null;
  let tpHandle: BitmapPoint | null = null;
  let slHandle: BitmapPoint | null = null;
  let leftHandle: BitmapPoint | null = null;
  let rightHandle: BitmapPoint | null = null;
  let topLeftHandle: BitmapPoint | null = null;
  let topRightHandle: BitmapPoint | null = null;
  let bottomLeftHandle: BitmapPoint | null = null;
  let bottomRightHandle: BitmapPoint | null = null;
  if (spec.selected) {
    entryHandle = bitmapHandle(
      entity,
      list,
      "entry",
      horizontalPixelRatio,
      verticalPixelRatio,
    );
    tpHandle = tp ? bitmapHandle(
      entity,
      list,
      "tp",
      horizontalPixelRatio,
      verticalPixelRatio,
    ) : null;
    slHandle = sl ? bitmapHandle(
      entity,
      list,
      "sl",
      horizontalPixelRatio,
      verticalPixelRatio,
    ) : null;
    leftHandle = bitmapHandle(
      entity,
      list,
      "left",
      horizontalPixelRatio,
      verticalPixelRatio,
    );
    rightHandle = bitmapHandle(
      entity,
      list,
      "right",
      horizontalPixelRatio,
      verticalPixelRatio,
    );
    if (tp && sl) {
      topLeftHandle = bitmapHandle(
        entity,
        list,
        "top-left",
        horizontalPixelRatio,
        verticalPixelRatio,
      );
      topRightHandle = bitmapHandle(
        entity,
        list,
        "top-right",
        horizontalPixelRatio,
        verticalPixelRatio,
      );
      bottomLeftHandle = bitmapHandle(
        entity,
        list,
        "bottom-left",
        horizontalPixelRatio,
        verticalPixelRatio,
      );
      bottomRightHandle = bitmapHandle(
        entity,
        list,
        "bottom-right",
        horizontalPixelRatio,
        verticalPixelRatio,
      );
    }
    if (!entryHandle || (tp && !tpHandle) || (sl && !slHandle) || !leftHandle || !rightHandle
      || (tp && sl && (!topLeftHandle || !topRightHandle || !bottomLeftHandle || !bottomRightHandle))) {
      return;
    }
  }

  const minimumRatio = Math.min(horizontalPixelRatio, verticalPixelRatio);
  context.save();
  if (tp) drawLevel(
    context,
    tp,
    horizontalPixelRatio,
    verticalPixelRatio,
    minimumRatio,
  );
  if (sl) drawLevel(
    context,
    sl,
    horizontalPixelRatio,
    verticalPixelRatio,
    minimumRatio,
  );

  context.strokeStyle = spec.entryColor;
  context.lineWidth = spec.lineWidthCssPx * minimumRatio;
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(entry[0].x, entry[0].y);
  context.lineTo(entry[1].x, entry[1].y);
  context.stroke();

  drawInfoPanel(
    context,
    spec,
    panel,
    horizontalPixelRatio,
    verticalPixelRatio,
    minimumRatio,
  );
  drawDirectionBadge(
    context,
    spec,
    entry,
    horizontalPixelRatio,
    verticalPixelRatio,
    minimumRatio,
  );

  if (spec.selected && entryHandle && leftHandle && rightHandle) {
    drawEntryHandle(context, entryHandle, spec.entryColor, minimumRatio);
    if (tp && tpHandle) drawDragBar(
      context,
      tp,
      spec.direction === "long" ? "up" : "down",
      horizontalPixelRatio,
      verticalPixelRatio,
      minimumRatio,
    );
    if (sl && slHandle) drawDragBar(
      context,
      sl,
      spec.direction === "long" ? "down" : "up",
      horizontalPixelRatio,
      verticalPixelRatio,
      minimumRatio,
    );
    const verticals = [entry[0].y, ...(tp ? [tp.line[0].y] : []), ...(sl ? [sl.line[0].y] : [])];
    const top = Math.min(...verticals);
    const bottom = Math.max(...verticals);
    drawEdgeHandle(
      context,
      leftHandle,
      top,
      bottom,
      horizontalPixelRatio,
      verticalPixelRatio,
      minimumRatio,
    );
    drawEdgeHandle(
      context,
      rightHandle,
      top,
      bottom,
      horizontalPixelRatio,
      verticalPixelRatio,
      minimumRatio,
    );
    if (topLeftHandle && topRightHandle && bottomLeftHandle && bottomRightHandle) {
      drawCornerHandle(context, topLeftHandle, minimumRatio);
      drawCornerHandle(context, topRightHandle, minimumRatio);
      drawCornerHandle(context, bottomLeftHandle, minimumRatio);
      drawCornerHandle(context, bottomRightHandle, minimumRatio);
    }
  }
  context.restore();
}
