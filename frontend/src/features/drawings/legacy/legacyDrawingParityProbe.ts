import { serializeDrawingPrimitive } from "../drawingPersistence.js";
import type {
  DrawingHit,
  DrawingKind,
  DrawingPrimitive,
  SavedDrawing,
  ScreenBox,
  ScreenPoint,
} from "../drawingTypes.js";
import type {
  DrawingShadowHitProbe,
  LegacyDrawingLayoutProbe,
} from "../engine/drawingShadowParity.js";

export const DEFAULT_LEGACY_PARITY_MAX_HIT_PROBES = 32;
export const MAX_LEGACY_PARITY_ENTITIES = 512;
export const MAX_LEGACY_PARITY_HIT_PROBES = 64;

export interface LegacyDrawingParityProbeOptions {
  readonly widthCssPx: number;
  readonly heightCssPx: number;
  readonly maxHitProbes?: number;
}

export interface LegacyDrawingParityProbeIssue {
  readonly severity: "skipped" | "error";
  readonly stage: "identity" | "layout" | "hit";
  readonly entityId?: string;
  readonly detail: string;
}

export interface LegacyDrawingParityProbeResult {
  readonly legacyLayouts: readonly LegacyDrawingLayoutProbe[];
  readonly serializedDrawings: readonly SavedDrawing[];
  readonly hitProbes: readonly DrawingShadowHitProbe[];
  readonly skippedCount: number;
  readonly errorCount: number;
  readonly issues: readonly LegacyDrawingParityProbeIssue[];
}

interface Viewport {
  readonly width: number;
  readonly height: number;
}

interface CapturedPrimitive {
  readonly primitive: DrawingPrimitive;
  readonly serializedDrawing: SavedDrawing;
  readonly entityId: string;
  readonly kind: DrawingKind;
  readonly layout: LegacyDrawingLayoutProbe;
  readonly hitPadding: number;
  readonly bodyCandidates: readonly ScreenPoint[];
  readonly selectedHandleCandidates: readonly ScreenPoint[];
  readonly selected: boolean;
}

type CapturedPrimitiveLayout = Omit<
  CapturedPrimitive,
  "hitPadding" | "primitive" | "selected" | "serializedDrawing"
>;

interface PrimitivePaneViewLike {
  renderer(): unknown;
}

interface PrimitiveProbeLike {
  _selected?: unknown;
  paneViews(): readonly PrimitivePaneViewLike[];
  hitTestGeometry?(x: number, y: number): DrawingHit | boolean | null;
  getParityLabelBox?(): Readonly<ScreenBox> | null;
  getParityInfoPanelBox?(): Readonly<ScreenBox> | null;
  getParityPaintBox?(): Readonly<ScreenBox> | null;
  getParityScreenSnapshot?(): Readonly<{
    hidden: boolean;
    paths: readonly (readonly Readonly<ScreenPoint>[])[];
    unresolvedGapIndexes: readonly number[];
  }> | null;
  hitTestParityScreenSnapshot?(x: number, y: number): boolean;
}

interface RendererLike {
  _data?: unknown;
}

type Bbox = readonly [number, number, number, number];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function screenPoint(value: unknown): ScreenPoint | null {
  const record = asRecord(value);
  if (!record) return null;
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  return x === null || y === null ? null : { x, y };
}

function screenPoints(value: unknown): Array<ScreenPoint | null> {
  // Preserve source slots. Two-point primitives render canonical indexes 0/1;
  // filtering an unresolved first point would incorrectly promote indexes 1/2
  // for accepted legacy payloads that contain extra points.
  return Array.isArray(value) ? value.map(screenPoint) : [];
}

function bboxFromPoints(points: readonly ScreenPoint[]): Bbox | null {
  if (points.length === 0) return null;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return [left, top, right, bottom];
}

function unionBboxes(...boxes: readonly (Bbox | null)[]): Bbox | null {
  const finite = boxes.filter((box): box is Bbox => box !== null);
  if (finite.length === 0) return null;
  return [
    Math.min(...finite.map((box) => box[0])),
    Math.min(...finite.map((box) => box[1])),
    Math.max(...finite.map((box) => box[2])),
    Math.max(...finite.map((box) => box[3])),
  ];
}

function bboxFromScreenBox(value: unknown): Bbox | null {
  const box = asRecord(value);
  if (!box) return null;
  const x = finiteNumber(box.x);
  const y = finiteNumber(box.y);
  const width = finiteNumber(box.width);
  const height = finiteNumber(box.height);
  if (x === null || y === null || width === null || height === null || width < 0 || height < 0) {
    return null;
  }
  return [x, y, x + width, y + height];
}

function clipBbox(box: Bbox | null, viewport: Viewport): Bbox | null {
  if (!box || box[2] < 0 || box[3] < 0 || box[0] > viewport.width || box[1] > viewport.height) {
    return null;
  }
  return [
    Math.max(0, box[0]),
    Math.max(0, box[1]),
    Math.min(viewport.width, box[2]),
    Math.min(viewport.height, box[3]),
  ];
}

interface ClippedPolylineCapture {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function captureClippedSegment(
  a: ScreenPoint,
  b: ScreenPoint,
  viewport: Viewport,
  bounds: ClippedPolylineCapture,
  bodyCandidates: ScreenPoint[],
): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let minT = 0;
  let maxT = 1;
  if (dx === 0) {
    if (a.x < 0 || a.x > viewport.width) return false;
  } else {
    let first = -a.x / dx;
    let second = (viewport.width - a.x) / dx;
    if (first > second) [first, second] = [second, first];
    minT = Math.max(minT, first);
    maxT = Math.min(maxT, second);
    if (minT > maxT) return false;
  }
  if (dy === 0) {
    if (a.y < 0 || a.y > viewport.height) return false;
  } else {
    let first = -a.y / dy;
    let second = (viewport.height - a.y) / dy;
    if (first > second) [first, second] = [second, first];
    minT = Math.max(minT, first);
    maxT = Math.min(maxT, second);
    if (minT > maxT) return false;
  }
  const firstX = a.x + dx * minT;
  const firstY = a.y + dy * minT;
  const secondX = a.x + dx * maxT;
  const secondY = a.y + dy * maxT;
  bounds.left = Math.min(bounds.left, firstX, secondX);
  bounds.top = Math.min(bounds.top, firstY, secondY);
  bounds.right = Math.max(bounds.right, firstX, secondX);
  bounds.bottom = Math.max(bounds.bottom, firstY, secondY);
  if (bodyCandidates.length < 2) {
    bodyCandidates.push({
      x: (firstX + secondX) / 2,
      y: (firstY + secondY) / 2,
    });
  }
  return true;
}

function freezeBbox(box: Bbox | null): Bbox | null {
  return box ? Object.freeze([...box] as [number, number, number, number]) : null;
}

function handleBuffer(points: readonly ScreenPoint[]): Float64Array {
  const buffer = new Float64Array(points.length * 2);
  points.forEach((point, index) => {
    buffer[index * 2] = point.x;
    buffer[index * 2 + 1] = point.y;
  });
  return buffer;
}

function makeLayout(
  entityId: string,
  kind: DrawingKind,
  visibleBbox: Bbox | null,
  handles: readonly ScreenPoint[] = [],
  handleNames: readonly string[] = [],
  unresolvedGapIndexes: readonly number[] = [],
): LegacyDrawingLayoutProbe {
  return Object.freeze({
    entityId,
    kind,
    visible: visibleBbox !== null,
    bbox: freezeBbox(visibleBbox),
    handles: handleBuffer(handles),
    handleNames: Object.freeze([...handleNames]),
    unresolvedGapIndexes: Object.freeze([...unresolvedGapIndexes]),
  });
}

function lineVisibleBbox(
  a: ScreenPoint,
  b: ScreenPoint,
  lineType: unknown,
  viewport: Viewport,
): Bbox | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return clipBbox([a.x, a.y, a.x, a.y], viewport);
  let minT = lineType === "line-infinite" ? Number.NEGATIVE_INFINITY : 0;
  let maxT = lineType === "line-segment" ? 1 : Number.POSITIVE_INFINITY;

  const constrain = (origin: number, delta: number, minimum: number, maximum: number): boolean => {
    if (delta === 0) return origin >= minimum && origin <= maximum;
    let first = (minimum - origin) / delta;
    let second = (maximum - origin) / delta;
    if (first > second) [first, second] = [second, first];
    minT = Math.max(minT, first);
    maxT = Math.min(maxT, second);
    return minT <= maxT;
  };

  if (!constrain(a.x, dx, 0, viewport.width)
    || !constrain(a.y, dy, 0, viewport.height)
    || !Number.isFinite(minT)
    || !Number.isFinite(maxT)) return null;
  return bboxFromPoints([
    { x: a.x + dx * minT, y: a.y + dy * minT },
    { x: a.x + dx * maxT, y: a.y + dy * maxT },
  ]);
}

function shortestAngleDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function angleWithinSweep(angle: number, start: number, delta: number): boolean {
  const offset = shortestAngleDelta(start, angle);
  return delta >= 0 ? offset >= 0 && offset <= delta : offset <= 0 && offset >= delta;
}

function angleGeometryPoints(a: ScreenPoint, b: ScreenPoint): ScreenPoint[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.5) return [a, b];
  const refDirection = dx >= 0 ? 1 : -1;
  const referenceLength = Math.max(Math.abs(dx), Math.min(distance, 80), 32);
  const startAngle = refDirection > 0 ? 0 : Math.PI;
  const delta = shortestAngleDelta(startAngle, Math.atan2(dy, dx));
  const radius = Math.min(Math.max(18, distance * 0.28), 54);
  const points = [a, b, { x: a.x + refDirection * referenceLength, y: a.y }];
  const angles = [startAngle, startAngle + delta, 0, Math.PI / 2, Math.PI, Math.PI * 1.5];
  for (const angle of angles) {
    if (!angleWithinSweep(angle, startAngle, delta)) continue;
    points.push({ x: a.x + Math.cos(angle) * radius, y: a.y + Math.sin(angle) * radius });
  }
  return points;
}

function boxHandles(box: Bbox): ScreenPoint[] {
  const [left, top, right, bottom] = box;
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  return [
    { x: left, y: top },
    { x: centerX, y: top },
    { x: right, y: top },
    { x: right, y: centerY },
    { x: right, y: bottom },
    { x: centerX, y: bottom },
    { x: left, y: bottom },
    { x: left, y: centerY },
  ];
}

const BOX_HANDLE_NAMES = Object.freeze(["tl", "t", "tr", "r", "br", "b", "bl", "l"]);

function captureLine(
  entityId: string,
  kind: DrawingKind,
  data: Record<string, unknown>,
  viewport: Viewport,
): CapturedPrimitiveLayout | null {
  const points = screenPoints(data.points);
  const a = points[0];
  const b = points[1];
  const hidden = data.hidden === true;
  const bbox = !hidden && a && b ? lineVisibleBbox(a, b, data.lineType, viewport) : null;
  const handles = a && b ? [a, b] : [];
  return {
    entityId,
    kind,
    layout: makeLayout(entityId, kind, bbox, handles, handles.length ? ["start", "end"] : []),
    bodyCandidates: a && b ? [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }] : [],
    selectedHandleCandidates: handles,
  };
}

function captureAxisLine(
  entityId: string,
  kind: DrawingKind,
  data: Record<string, unknown>,
  viewport: Viewport,
): CapturedPrimitiveLayout {
  const pointRecord = asRecord(data.point);
  const x = finiteNumber(pointRecord?.x);
  const y = finiteNumber(pointRecord?.y);
  const type = data.axisLineType;
  const hidden = data.hidden === true;
  const horizontal = !hidden && (type === "horizontal" || type === "cross") && y !== null;
  const vertical = !hidden && (type === "vertical" || type === "cross") && x !== null;
  const rawBbox = horizontal && vertical
    ? [0, 0, viewport.width, viewport.height] as const
    : horizontal
      ? [0, y, viewport.width, y] as const
      : vertical
        ? [x, 0, x, viewport.height] as const
        : null;
  const bbox = clipBbox(rawBbox, viewport);
  const center = x !== null && y !== null ? [{ x, y }] : [];
  const bodyCandidates: ScreenPoint[] = [];
  if (horizontal && y !== null) bodyCandidates.push({ x: viewport.width / 2, y });
  if (vertical && x !== null) bodyCandidates.push({ x, y: viewport.height / 2 });
  return {
    entityId,
    kind,
    layout: makeLayout(entityId, kind, bbox, center, center.length ? ["center"] : []),
    bodyCandidates,
    selectedHandleCandidates: center,
  };
}

function captureAngle(
  primitive: DrawingPrimitive,
  entityId: string,
  kind: DrawingKind,
  data: Record<string, unknown>,
  viewport: Viewport,
): CapturedPrimitiveLayout | null {
  const points = screenPoints(data.points);
  const a = points[0];
  const b = points[1];
  if (data.hidden === true) {
    return {
      entityId,
      kind,
      layout: makeLayout(entityId, kind, null),
      bodyCandidates: [],
      selectedHandleCandidates: [],
    };
  }
  const geometry = a && b ? bboxFromPoints(angleGeometryPoints(a, b)) : null;
  const label = bboxFromScreenBox((primitive as PrimitiveProbeLike).getParityLabelBox?.());
  // A renderable angle always publishes its measured label during paint. Null
  // here means there is no coherent last-painted snapshot to compare.
  if (!geometry || !label) return null;
  const bbox = clipBbox(unionBboxes(geometry, label), viewport);
  const handles = a && b ? [a, b] : [];
  return {
    entityId,
    kind,
    layout: makeLayout(entityId, kind, bbox, handles, handles.length ? ["vertex", "ray"] : []),
    bodyCandidates: a && b ? [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }] : [],
    selectedHandleCandidates: handles,
  };
}

function captureFibonacci(
  entityId: string,
  kind: DrawingKind,
  data: Record<string, unknown>,
  viewport: Viewport,
): CapturedPrimitiveLayout {
  const points = screenPoints(data.points);
  const a = points[0];
  const b = points[1];
  const geometryPoints: ScreenPoint[] = a && b ? [a, b] : [];
  if (a && b && Array.isArray(data.levels)) {
    const startY = data.inverted === true ? b.y : a.y;
    const endY = data.inverted === true ? a.y : b.y;
    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, b.x);
    for (const value of data.levels) {
      const level = asRecord(value);
      const ratio = finiteNumber(level?.level);
      if (!level || level.enabled !== true || ratio === null) continue;
      const y = startY + (endY - startY) * ratio;
      geometryPoints.push({ x: left, y }, { x: right, y });
    }
  }
  const bbox = data.hidden === true ? null : clipBbox(bboxFromPoints(geometryPoints), viewport);
  const handles = a && b ? [a, b] : [];
  return {
    entityId,
    kind,
    layout: makeLayout(entityId, kind, bbox, handles, handles.length ? ["start", "end"] : []),
    bodyCandidates: a && b ? [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }] : [],
    selectedHandleCandidates: handles,
  };
}

function captureShape(
  entityId: string,
  kind: DrawingKind,
  data: Record<string, unknown>,
  viewport: Viewport,
): CapturedPrimitiveLayout {
  const points = screenPoints(data.points);
  const a = points[0];
  const b = points[1];
  const raw = a && b ? bboxFromPoints([a, b]) : null;
  const handles = raw ? boxHandles(raw) : [];
  const bbox = data.hidden === true ? null : clipBbox(raw, viewport);
  return {
    entityId,
    kind,
    layout: makeLayout(entityId, kind, bbox, handles, raw ? BOX_HANDLE_NAMES : []),
    bodyCandidates: raw ? [{ x: (raw[0] + raw[2]) / 2, y: (raw[1] + raw[3]) / 2 }] : [],
    selectedHandleCandidates: handles,
  };
}

function captureText(
  primitive: DrawingPrimitive,
  entityId: string,
  kind: DrawingKind,
  data: Record<string, unknown>,
  viewport: Viewport,
): CapturedPrimitiveLayout | null {
  if (data.hidden === true) {
    return {
      entityId,
      kind,
      layout: makeLayout(entityId, kind, null),
      bodyCandidates: [],
      selectedHandleCandidates: [],
    };
  }
  const box = (primitive as PrimitiveProbeLike).getParityPaintBox?.();
  const raw = bboxFromScreenBox(box);
  if (!raw) return null;
  const handles = boxHandles(raw);
  return {
    entityId,
    kind,
    layout: makeLayout(entityId, kind, clipBbox(raw, viewport), handles, BOX_HANDLE_NAMES),
    bodyCandidates: [{ x: (raw[0] + raw[2]) / 2, y: (raw[1] + raw[3]) / 2 }],
    selectedHandleCandidates: handles,
  };
}

function capturePosition(
  primitive: DrawingPrimitive,
  entityId: string,
  kind: DrawingKind,
  data: Record<string, unknown>,
  viewport: Viewport,
): CapturedPrimitiveLayout | null {
  if (data.hidden === true) {
    return {
      entityId,
      kind,
      layout: makeLayout(entityId, kind, null),
      bodyCandidates: [],
      selectedHandleCandidates: [],
    };
  }
  const left = finiteNumber(data.leftX);
  const right = finiteNumber(data.rightX);
  const entry = finiteNumber(data.entryY);
  const ys = [entry, finiteNumber(data.tpY), finiteNumber(data.slY)]
    .filter((value): value is number => value !== null);
  const main = left !== null && right !== null && entry !== null && ys.length > 0
    ? [Math.min(left, right), Math.min(...ys), Math.max(left, right), Math.max(...ys)] as const
    : null;
  const panel = bboxFromScreenBox((primitive as PrimitiveProbeLike).getParityInfoPanelBox?.());
  // Persisted position primitives publish a panel box during paint. Requiring
  // it prevents mixing newly updated pane data with an older painted panel.
  if (!main || !panel) return null;
  const raw = unionBboxes(main, panel);
  const middleY = main ? (main[1] + main[3]) / 2 : null;
  const handles = main && middleY !== null
    ? [{ x: main[0], y: middleY }, { x: main[2], y: middleY }]
    : [];
  return {
    entityId,
    kind,
    layout: makeLayout(entityId, kind, clipBbox(raw, viewport), handles, main ? ["left", "right"] : []),
    bodyCandidates: main && entry !== null
      ? [{ x: (main[0] + main[2]) / 2, y: entry }]
      : [],
    selectedHandleCandidates: handles,
  };
}

function captureFreehand(
  primitive: DrawingPrimitive,
  entityId: string,
  kind: DrawingKind,
  viewport: Viewport,
): CapturedPrimitiveLayout | null {
  const snapshot = (primitive as PrimitiveProbeLike).getParityScreenSnapshot?.();
  if (!snapshot) return null;
  const drawablePaths = snapshot.paths.filter((path) => path.length >= 2);
  const bounds: ClippedPolylineCapture = {
    left: Number.POSITIVE_INFINITY,
    top: Number.POSITIVE_INFINITY,
    right: Number.NEGATIVE_INFINITY,
    bottom: Number.NEGATIVE_INFINITY,
  };
  const bodyCandidates: ScreenPoint[] = [];
  if (!snapshot.hidden) {
    // Canvas clips each continuous segment. A whole-path bbox would let Y
    // extrema from a horizontally offscreen prefix pollute the visible bbox.
    for (const path of drawablePaths) {
      for (let index = 1; index < path.length; index += 1) {
        const a = path[index - 1];
        const b = path[index];
        if (!a || !b) continue;
        captureClippedSegment(a, b, viewport, bounds, bodyCandidates);
      }
    }
  }
  const bbox: Bbox | null = Number.isFinite(bounds.left)
    ? [bounds.left, bounds.top, bounds.right, bounds.bottom]
    : null;
  return {
    entityId,
    kind,
    layout: makeLayout(entityId, kind, bbox, [], [], snapshot.unresolvedGapIndexes),
    bodyCandidates,
    selectedHandleCandidates: [],
  };
}

function rendererData(primitive: DrawingPrimitive): Record<string, unknown> | null {
  const candidate = primitive as PrimitiveProbeLike;
  const view = candidate.paneViews()[0];
  if (!view) return null;
  const renderer = asRecord(view.renderer()) as RendererLike | null;
  return asRecord(renderer?._data);
}

function capturePrimitive(
  primitive: DrawingPrimitive,
  saved: SavedDrawing,
  entityId: string,
  viewport: Viewport,
): CapturedPrimitive | null {
  const kind = saved.type;
  const data = rendererData(primitive);
  if (!data) return null;
  let partial: CapturedPrimitiveLayout | null;
  if (kind === "line") partial = captureLine(entityId, kind, data, viewport);
  else if (kind === "axis-line") partial = captureAxisLine(entityId, kind, data, viewport);
  else if (kind === "angle-measure") partial = captureAngle(primitive, entityId, kind, data, viewport);
  else if (kind === "fibonacci") partial = captureFibonacci(entityId, kind, data, viewport);
  else if (kind === "position") partial = capturePosition(primitive, entityId, kind, data, viewport);
  else if (kind === "shape") partial = captureShape(entityId, kind, data, viewport);
  else if (kind === "text") partial = captureText(primitive, entityId, kind, data, viewport);
  else partial = captureFreehand(primitive, entityId, kind, viewport);
  if (!partial) return null;
  const savedRecord = asRecord(saved);
  const lineWidth = finiteNumber(savedRecord?.lineWidth) ?? 1;
  return Object.freeze({
    ...partial,
    // Covers legacy endpoint/handle/body tolerances for every current tool.
    // This conservative broad phase only rejects probes well outside the
    // already captured visible layout; the primitive remains the authority
    // for the exact hit result.
    hitPadding: Math.max(16, 12 + lineWidth),
    primitive,
    serializedDrawing: saved,
    selected: (primitive as PrimitiveProbeLike)._selected === true,
  });
}

function normalizeHit(value: DrawingHit | boolean | null): DrawingHit | null {
  if (value === true) return Object.freeze({ body: true });
  if (!value) return null;
  const raw = asRecord(value);
  if (!raw) return null;
  const hit: DrawingHit = {};
  if (Number.isSafeInteger(raw.pointIndex)) hit.pointIndex = Number(raw.pointIndex);
  if (typeof raw.zone === "string") hit.zone = raw.zone;
  if (typeof raw.handle === "string") hit.handle = raw.handle;
  if (raw.body === true) hit.body = true;
  return Object.freeze(hit);
}

function hitAt(
  captures: readonly CapturedPrimitive[],
  x: number,
  y: number,
): Readonly<{ entityId: string; kind: DrawingKind; hit: DrawingHit }> | null {
  for (let index = captures.length - 1; index >= 0; index -= 1) {
    const capture = captures[index];
    if (!capture) continue;
    const bbox = capture.layout.bbox;
    if (!capture.selected && (!bbox
      || x < bbox[0] - capture.hitPadding
      || x > bbox[2] + capture.hitPadding
      || y < bbox[1] - capture.hitPadding
      || y > bbox[3] + capture.hitPadding)) continue;
    const candidate = capture.primitive as PrimitiveProbeLike;
    const hitTest = candidate.hitTestParityScreenSnapshot ?? candidate.hitTestGeometry;
    if (!hitTest) continue;
    const hit = normalizeHit(hitTest.call(capture.primitive, x, y));
    if (!hit) continue;
    return Object.freeze({ entityId: capture.entityId, kind: capture.kind, hit });
  }
  return null;
}

function normalizedMaxHitProbes(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return DEFAULT_LEGACY_PARITY_MAX_HIT_PROBES;
  return Math.min(Number(value), MAX_LEGACY_PARITY_HIT_PROBES);
}

function candidatePoints(captures: readonly CapturedPrimitive[]): ScreenPoint[] {
  const points: ScreenPoint[] = [];
  const seen = new Set<string>();
  for (const capture of captures) {
    if (!capture.layout.visible) continue;
    const candidates = capture.selected
      ? [...capture.selectedHandleCandidates.slice(0, 2), ...capture.bodyCandidates]
      : capture.bodyCandidates;
    for (const point of candidates) {
      const key = `${point.x}:${point.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      points.push(point);
    }
  }
  return points;
}

/**
 * Low-frequency Phase 3 probe. Screen layout comes from the pane data supplied
 * to visible legacy renderers; hit results come from the legacy primitives'
 * own hitTestGeometry methods in reverse z-order. It never calls a scene
 * projector, attaches a canvas, installs listeners, or writes persistence.
 */
export function captureLegacyDrawingParityProbe(
  primitives: readonly DrawingPrimitive[],
  options: LegacyDrawingParityProbeOptions,
): LegacyDrawingParityProbeResult {
  const width = finiteNumber(options.widthCssPx);
  const height = finiteNumber(options.heightCssPx);
  if (width === null || height === null || width <= 0 || height <= 0) {
    throw new TypeError("legacy parity viewport must be finite and positive");
  }
  if (primitives.length > MAX_LEGACY_PARITY_ENTITIES) {
    throw new RangeError(`legacy parity probe is capped at ${MAX_LEGACY_PARITY_ENTITIES} entities`);
  }
  const viewport = Object.freeze({ width, height });
  const issues: LegacyDrawingParityProbeIssue[] = [];
  const captures: CapturedPrimitive[] = [];
  let skippedCount = 0;
  let errorCount = 0;

  for (const primitive of primitives) {
    let entityId: string | undefined;
    try {
      const saved = serializeDrawingPrimitive(primitive);
      entityId = saved?.id;
      if (!saved || !entityId) {
        skippedCount += 1;
        issues.push(Object.freeze({
          severity: "skipped",
          stage: "identity",
          detail: "primitive is not a canonical persisted drawing",
        }));
        continue;
      }
      const capture = capturePrimitive(primitive, saved, entityId, viewport);
      if (!capture) {
        skippedCount += 1;
        issues.push(Object.freeze({
          severity: "skipped",
          stage: "layout",
          entityId,
          detail: "visible renderer screen data is unavailable",
        }));
        continue;
      }
      captures.push(capture);
    } catch (error) {
      errorCount += 1;
      issues.push(Object.freeze({
        severity: "error",
        stage: "layout",
        ...(entityId ? { entityId } : {}),
        detail: error instanceof Error ? error.message : "legacy layout probe failed",
      }));
    }
  }

  const hitProbes: DrawingShadowHitProbe[] = [];
  const selected = captures.filter((capture) => capture.selected);
  if (captures.length === primitives.length && selected.length <= 1) {
    const maxHitProbes = normalizedMaxHitProbes(options.maxHitProbes);
    const selectedId = selected[0]?.entityId ?? null;
    for (const point of candidatePoints(captures).slice(0, maxHitProbes)) {
      try {
        hitProbes.push(Object.freeze({
          x: point.x,
          y: point.y,
          selectedId,
          legacy: hitAt(captures, point.x, point.y),
        }));
      } catch (error) {
        errorCount += 1;
        issues.push(Object.freeze({
          severity: "error",
          stage: "hit",
          detail: error instanceof Error ? error.message : "legacy hit probe failed",
        }));
      }
    }
  } else if (captures.length === primitives.length && selected.length > 1) {
    skippedCount += 1;
    issues.push(Object.freeze({
      severity: "skipped",
      stage: "hit",
      detail: "multiple selected legacy primitives make selected hit ownership ambiguous",
    }));
  } else if (primitives.length > 0) {
    skippedCount += 1;
    issues.push(Object.freeze({
      severity: "skipped",
      stage: "hit",
      detail: "hit probes require a complete legacy primitive registry",
    }));
  }

  return Object.freeze({
    legacyLayouts: Object.freeze(captures.map((capture) => capture.layout)),
    serializedDrawings: Object.freeze(captures.map((capture) => capture.serializedDrawing)),
    hitProbes: Object.freeze(hitProbes),
    skippedCount,
    errorCount,
    issues: Object.freeze(issues),
  });
}
