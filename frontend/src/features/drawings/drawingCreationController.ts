/**
 * drawingCreationController — creation state machine for new drawings.
 *
 * Extracted from the main interaction controller so that adding / tuning a
 * drawing tool's creation flow lives here instead of being interleaved with
 * selection and drag handling. These are plain functions (not hooks): the host
 * still owns hit-testing and selection, and calls into these helpers for the
 * "build a new primitive" parts of its pointer handlers.
 *
 * Each function returns `true` when it has consumed the pointer event (the host
 * then returns from its handler). The serialized drawing schema is unchanged —
 * primitives are still produced by drawingPrimitiveFactory.
 */
import {
  SHAPE_TOOL_IDS,
  axisLineTypeFromTool,
  constrainShapeScreenPoint,
  shapeTypeFromTool,
} from "./drawingModel.js";
import {
  createAxisLinePrimitive,
  createFreehandPrimitive,
  createPositionPrimitive,
  createPreviewPrimitive,
  createTextPrimitive,
  createTwoPointDrawingPrimitive,
} from "./drawingPrimitiveFactory.js";
import {
  appendFreehandStrokeCaptureBatch,
  createFreehandStrokeDraft,
  getFreehandStrokeDraftPreviewPoints,
} from "./freehandStrokeModel.js";
import { parseDrawingAnchor } from "./drawingContracts.js";
import type { FreehandDrawingPrimitive } from "./primitives/FreehandDrawingPrimitive.js";
import type { DrawingDragDescriptor } from "./drawingDragResizeController.js";
import type { TextDrawingPrimitive } from "./primitives/TextDrawingPrimitive.js";
import type { AngleMeasurementPrimitive } from "./primitives/AngleMeasurementPrimitive.js";
import type { FibonacciDrawingPrimitive } from "./primitives/FibonacciDrawingPrimitive.js";
import type { LineDrawingPrimitive } from "./primitives/LineDrawingPrimitive.js";
import type { ShapeDrawingPrimitive } from "./primitives/ShapeDrawingPrimitive.js";
import type {
  AngleToolId,
  AxisLineToolId,
  DrawingAnchor,
  DrawingChartAdapter,
  DrawingDataPoint,
  DrawingDataToScreen,
  DrawingPointerEvent,
  DrawingPrimitive,
  FibonacciLevel,
  FibonacciToolId,
  FreehandCaptureBatch,
  FreehandStrokeDraft,
  FreehandToolId,
  MutableRef,
  PositionTimeRange,
  PositionToolId,
  ScreenPoint,
  ScreenToDrawingData,
  ShapeToolId,
  BasicLineToolId,
} from "./drawingTypes.js";

type TwoPointCreationTool = BasicLineToolId | AngleToolId | FibonacciToolId | ShapeToolId;
type TwoPointDrawingPrimitive = LineDrawingPrimitive
  | AngleMeasurementPrimitive
  | FibonacciDrawingPrimitive
  | ShapeDrawingPrimitive;
type AttachPrimitive = (primitive: DrawingPrimitive) => void;
type SelectPrimitive = (id: string) => void;

interface PositionSpanOptions {
  dataPoint: DrawingDataPoint;
  pos: ScreenPoint;
  screenToDrawingData: ScreenToDrawingData;
  chartContainerRef: MutableRef<HTMLElement | null>;
  adapter: DrawingChartAdapter | null;
}

interface StartFreehandStrokeOptions {
  tool: FreehandToolId;
  pos: ScreenPoint;
  e: DrawingPointerEvent;
  primitivesRef: MutableRef<DrawingPrimitive[]>;
  currentFreehandRef: MutableRef<FreehandDrawingPrimitive | null>;
  freehandDraftRef: MutableRef<FreehandStrokeDraft | null>;
  isDrawingFreehandRef: MutableRef<boolean>;
  attachPrim: AttachPrimitive;
  screenToData: ScreenToDrawingData;
  penColorRef: MutableRef<string>;
  penSizeRef: MutableRef<number>;
  sourceLineage?: boolean;
  captureBatch?: FreehandCaptureBatch | null;
  freehandCaptureIdentityRef?: MutableRef<unknown> | null;
}

interface PlaceTextDrawingOptions {
  pos: ScreenPoint;
  e: DrawingPointerEvent;
  primitivesRef: MutableRef<DrawingPrimitive[]>;
  attachPrim: AttachPrimitive;
  startTextEditing: (primitive: TextDrawingPrimitive) => void;
  screenToDrawingData: ScreenToDrawingData;
  drawingSnapEnabledRef: MutableRef<boolean>;
  penColorRef: MutableRef<string>;
  textFontSizeRef: MutableRef<number>;
  textBoldRef: MutableRef<boolean>;
  textItalicRef: MutableRef<boolean>;
}

interface PlacePositionDrawingOptions {
  tool: PositionToolId;
  pos: ScreenPoint;
  e: DrawingPointerEvent;
  primitivesRef: MutableRef<DrawingPrimitive[]>;
  attachPrim: AttachPrimitive;
  selectPrimitive: SelectPrimitive;
  persistDrawings: () => void;
  screenToDrawingData: ScreenToDrawingData;
  getChartAdapter: () => DrawingChartAdapter | null;
  chartContainerRef: MutableRef<HTMLElement | null>;
  drawingSnapEnabledRef: MutableRef<boolean>;
  positionSizeRef: MutableRef<number>;
}

interface TwoPointRefs {
  anchorDataRef: MutableRef<DrawingDataPoint | null>;
  previewRef: MutableRef<TwoPointDrawingPrimitive | null>;
}

interface TwoPointStyleRefs {
  penColorRef: MutableRef<string>;
  penSizeRef: MutableRef<number>;
  fibLevelsRef: MutableRef<FibonacciLevel[] | null>;
  fibInvertedRef: MutableRef<boolean>;
}

interface CommitTwoPointDrawingOptions extends TwoPointRefs, TwoPointStyleRefs {
  tool: TwoPointCreationTool;
  pos: ScreenPoint;
  e: DrawingPointerEvent;
  primitivesRef: MutableRef<DrawingPrimitive[]>;
  attachPrim: AttachPrimitive;
  detachPrim: AttachPrimitive;
  selectPrimitive: SelectPrimitive;
  persistDrawings: () => void;
  screenToDrawingData: ScreenToDrawingData;
  dataToScreen: DrawingDataToScreen;
  drawingSnapEnabledRef: MutableRef<boolean>;
}

interface BeginAxisLineDrawingOptions extends TwoPointRefs {
  tool: AxisLineToolId;
  pos: ScreenPoint;
  e: DrawingPointerEvent;
  primitivesRef: MutableRef<DrawingPrimitive[]>;
  draggingRef: MutableRef<DrawingDragDescriptor | null>;
  attachPrim: AttachPrimitive;
  selectPrimitive: SelectPrimitive;
  removePreview: () => void;
  screenToDrawingData: ScreenToDrawingData;
  drawingSnapEnabledRef: MutableRef<boolean>;
  penColorRef: MutableRef<string>;
  penSizeRef: MutableRef<number>;
}

interface BeginTwoPointDrawingOptions extends TwoPointRefs, TwoPointStyleRefs {
  tool: TwoPointCreationTool;
  pos: ScreenPoint;
  e: DrawingPointerEvent;
  attachPrim: AttachPrimitive;
  screenToDrawingData: ScreenToDrawingData;
  drawingSnapEnabledRef: MutableRef<boolean>;
}

interface UpdateTwoPointPreviewOptions extends TwoPointRefs {
  tool: TwoPointCreationTool;
  pos: ScreenPoint;
  e: DrawingPointerEvent;
  screenToDrawingData: ScreenToDrawingData;
  dataToScreen: DrawingDataToScreen;
  drawingSnapEnabledRef: MutableRef<boolean>;
}

function consumePointerEvent(event: DrawingPointerEvent | null | undefined): void {
  event?.preventDefault?.();
  event?.stopPropagation?.();
}

function horizontalAnchorFromDataPoint(
  dataPoint: DrawingDataPoint | null,
): DrawingAnchor | null {
  return dataPoint ? parseDrawingAnchor(dataPoint) : null;
}

function sameHorizontalAnchor(first: DrawingAnchor | null, second: DrawingAnchor | null): boolean {
  if (!first || !second) return false;
  return first.time === second.time
    && first.logical === second.logical
    && first.sourceOrdinal === second.sourceOrdinal
    && first.sourceProjection === second.sourceProjection
    && first.sourceProjectionConfig === second.sourceProjectionConfig;
}

function positionSpanCandidateXs(pointerX: number, containerWidth: number | null): number[] {
  const usableWidth = typeof containerWidth === "number"
    && Number.isFinite(containerWidth)
    && containerWidth > 1
    ? containerWidth
    : null;
  const hasWidth = usableWidth !== null;
  const leftEdge = 0;
  const rightEdge = usableWidth !== null ? usableWidth - 1 : pointerX + 80;

  if (rightEdge <= leftEdge) return [];
  const span = hasWidth ? Math.max(1, (rightEdge - leftEdge) * 0.15) : 80;
  const clampToDataRegion = (x: number): number => Math.max(leftEdge, Math.min(rightEdge, x));
  const originX = clampToDataRegion(pointerX);
  const sides = [
    { available: rightEdge - originX, edge: rightEdge, target: originX + span },
    { available: originX - leftEdge, edge: leftEdge, target: originX - span },
  ];
  const fullSpanCandidates = sides
    .filter(({ available }) => available + 0.5 >= span)
    .map(({ target }) => clampToDataRegion(target));
  const fallbackEdges = [...sides]
    .sort((first, second) => second.available - first.available)
    .map(({ edge }) => edge);
  const candidates = [...fullSpanCandidates, ...fallbackEdges];
  return candidates.filter((candidate, index) => Number.isFinite(candidate)
    && Math.abs(candidate - pointerX) >= 0.5
    && candidates.findIndex((value) => Math.abs(value - candidate) < 0.5) === index);
}

/**
 * Pick both position endpoints through the shared screen-coordinate bridge.
 * On ordinal axes this may combine materialized lineage with an absolute
 * source-time future anchor, but never stores projection-local order/logical.
 */
function positionTimeRangeFromScreen({
  dataPoint,
  pos,
  screenToDrawingData,
  chartContainerRef,
  adapter,
}: PositionSpanOptions): PositionTimeRange | null {
  const pointerAnchor = horizontalAnchorFromDataPoint(dataPoint);
  if (!pointerAnchor) return null;

  const containerWidth = Number(chartContainerRef?.current?.clientWidth);
  let timeScaleWidth = null;
  try {
    timeScaleWidth = Number(adapter?.getTimeScaleWidth?.());
  } catch { /* fall back to the container width */ }
  const safeWidths = [containerWidth, timeScaleWidth]
    .filter((width): width is number => typeof width === "number"
      && Number.isFinite(width)
      && width > 1);
  const width = safeWidths.length > 0 ? Math.min(...safeWidths) : null;
  for (const candidateX of positionSpanCandidateXs(pos.x, width)) {
    const candidateData = screenToDrawingData(candidateX, pos.y, {
      price: false,
      snap: false,
    });
    const candidateAnchor = horizontalAnchorFromDataPoint(candidateData);
    if (!candidateAnchor || sameHorizontalAnchor(pointerAnchor, candidateAnchor)) continue;
    return candidateX < pos.x
      ? { start: candidateAnchor, end: pointerAnchor }
      : { start: pointerAnchor, end: candidateAnchor };
  }

  // A one-row/singular projection cannot express a safe horizontal span.
  // Do not fabricate an ordinal neighbor or silently persist duplicate anchors.
  return null;
}

/** Pen / highlighter: begin a freehand stroke. */
export function startFreehandStroke({
  tool,
  pos,
  e,
  primitivesRef,
  currentFreehandRef,
  freehandDraftRef,
  isDrawingFreehandRef,
  attachPrim,
  screenToData,
  penColorRef,
  penSizeRef,
  sourceLineage = false,
  captureBatch = null,
  freehandCaptureIdentityRef = null,
}: StartFreehandStrokeOptions): boolean {
  // The drawing tool owns this gesture even when atomic capture fails closed;
  // never leak the same pointerdown into Lightweight Charts pan/selection.
  consumePointerEvent(e);

  let dataPoint: DrawingDataPoint | null = null;
  let draft: FreehandStrokeDraft | null = null;
  let previewPoints: Array<ScreenPoint | null> | undefined;
  if (sourceLineage) {
    if (!captureBatch) return true;
    draft = createFreehandStrokeDraft({
      sourceProjection: captureBatch.sourceProjection,
      sourceProjectionConfig: captureBatch.sourceProjectionConfig,
      captureIdentity: captureBatch.captureIdentity,
    });
    if (!draft || !appendFreehandStrokeCaptureBatch(draft, captureBatch)) return true;
    previewPoints = getFreehandStrokeDraftPreviewPoints(draft);
  } else {
    dataPoint = screenToData(pos.x, pos.y);
    if (!dataPoint) return true;
  }
  const freehand = createFreehandPrimitive({
    tool,
    dataPoint,
    previewPoints,
    isPreview: true,
    color: penColorRef.current,
    lineWidth: penSizeRef.current,
  });
  attachPrim(freehand);
  primitivesRef.current.push(freehand);
  currentFreehandRef.current = freehand;
  freehandDraftRef.current = draft;
  if (freehandCaptureIdentityRef) {
    freehandCaptureIdentityRef.current = draft ? captureBatch?.captureIdentity ?? null : null;
  }
  isDrawingFreehandRef.current = true;
  return true;
}

/** Text tool: place a new text annotation and open its inline editor. */
export function placeTextDrawing({
  pos,
  e,
  primitivesRef,
  attachPrim,
  startTextEditing,
  screenToDrawingData,
  drawingSnapEnabledRef,
  penColorRef,
  textFontSizeRef,
  textBoldRef,
  textItalicRef,
}: PlaceTextDrawingOptions): boolean {
  consumePointerEvent(e);
  const dataPoint = screenToDrawingData(pos.x, pos.y, { snap: drawingSnapEnabledRef.current && !e.altKey });
  if (!dataPoint) return true;

  const textPrim = createTextPrimitive({
    dataPoint,
    color: penColorRef.current,
    fontSize: textFontSizeRef.current || 14,
    bold: textBoldRef.current || false,
    italic: textItalicRef.current || false,
  });
  attachPrim(textPrim);
  primitivesRef.current.push(textPrim);

  // Immediately open text editor
  startTextEditing(textPrim);

  return true;
}

/** Position tool: place a new long/short position with auto TP/SL. */
export function placePositionDrawing({
  tool,
  pos,
  e,
  primitivesRef,
  attachPrim,
  selectPrimitive,
  persistDrawings,
  screenToDrawingData,
  getChartAdapter,
  chartContainerRef,
  drawingSnapEnabledRef,
  positionSizeRef,
}: PlacePositionDrawingOptions): boolean {
  consumePointerEvent(e);
  const dataA = screenToDrawingData(pos.x, pos.y, { snap: drawingSnapEnabledRef.current && !e.altKey });
  if (!dataA) return true;

  const entryPrice = dataA.price;
  const adapter = getChartAdapter();

  // Resolve the default span from two real screen/display rows. In particular,
  // derived visible-range endpoints are ordinal objects and must never be
  // subtracted as if they were timestamps.
  const timeRange = positionTimeRangeFromScreen({
    dataPoint: dataA,
    pos,
    screenToDrawingData,
    chartContainerRef,
    adapter,
  });
  if (!timeRange) return true;

  // Default TP/SL based on visible price range — ensures proper proportions on any timeframe
  let tpOffset: number | undefined;
  let slOffset: number | undefined;
  if (adapter?.isReady?.()) {
    try {
      // Get the visible price range from the chart container's pixel height
      const container = chartContainerRef?.current;
      const chartHeight = container?.clientHeight || 400;
      const visiblePriceRange = adapter.getVisiblePriceRange?.(chartHeight);
      if (visiblePriceRange != null && isFinite(visiblePriceRange)) {
        tpOffset = visiblePriceRange * 0.12;  // TP at ~12% of visible range
        slOffset = visiblePriceRange * 0.06;   // SL at ~6% of visible range
      }
    } catch { /* fallback below */ }
  }
  // Fallback if we couldn't determine visible range
  if (!tpOffset) tpOffset = entryPrice * 0.03;
  if (!slOffset) slOffset = entryPrice * 0.015;

  const posPrim = createPositionPrimitive({
    tool,
    dataPoint: dataA,
    timeRange,
    tpOffset,
    slOffset,
    positionSize: positionSizeRef.current || 1000,
  });

  attachPrim(posPrim);
  primitivesRef.current.push(posPrim);
  selectPrimitive(posPrim.id);
  persistDrawings();

  return true;
}

/**
 * Line / fib / shape tools, second click: commit the two-point drawing using
 * the current anchor + preview. Returns true when a drawing was committed.
 */
export function commitTwoPointDrawing({
  tool,
  pos,
  e,
  primitivesRef,
  anchorDataRef,
  previewRef,
  attachPrim,
  detachPrim,
  selectPrimitive,
  persistDrawings,
  screenToDrawingData,
  dataToScreen,
  drawingSnapEnabledRef,
  penColorRef,
  penSizeRef,
  fibLevelsRef,
  fibInvertedRef,
}: CommitTwoPointDrawingOptions): boolean {
  const isShapeDrawingTool = SHAPE_TOOL_IDS.has(tool);
  const shapeType = shapeTypeFromTool(tool);

  if (!anchorDataRef.current || !previewRef.current) return false;
  consumePointerEvent(e);

  let targetPos = pos;
  if (isShapeDrawingTool && e.shiftKey) {
    const anchorScreen = dataToScreen(anchorDataRef.current);
    targetPos = constrainShapeScreenPoint(anchorScreen, pos);
  }
  const dataB = screenToDrawingData(targetPos.x, targetPos.y, { snap: drawingSnapEnabledRef.current && !e.altKey && !(isShapeDrawingTool && e.shiftKey) });
  if (!dataB) return true;

  // Remove preview
  detachPrim(previewRef.current);
  previewRef.current = null;

  const finalPrim = createTwoPointDrawingPrimitive({
    tool,
    shapeType: isShapeDrawingTool ? shapeType : null,
    dataPoints: [anchorDataRef.current, dataB],
    color: penColorRef.current,
    lineWidth: penSizeRef.current,
    fibLevels: fibLevelsRef.current,
    fibInverted: fibInvertedRef.current,
  });
  attachPrim(finalPrim);
  primitivesRef.current.push(finalPrim);

  anchorDataRef.current = null;
  selectPrimitive(finalPrim.id);
  persistDrawings();

  return true;
}

/**
 * Axis-line tools: click creates the line immediately and starts a drag so the
 * user can adjust it before mouseup. Returns true when handled.
 */
export function beginAxisLineDrawing({
  tool,
  pos,
  e,
  primitivesRef,
  anchorDataRef,
  previewRef,
  draggingRef,
  attachPrim,
  selectPrimitive,
  removePreview,
  screenToDrawingData,
  drawingSnapEnabledRef,
  penColorRef,
  penSizeRef,
}: BeginAxisLineDrawingOptions): boolean {
  consumePointerEvent(e);
  if (anchorDataRef.current || previewRef.current) {
    removePreview();
  }
  const axisLineType = axisLineTypeFromTool(tool);
  const dataA = screenToDrawingData(pos.x, pos.y, {
    snap: drawingSnapEnabledRef.current && !e.altKey,
    time: axisLineType !== "horizontal",
    price: axisLineType !== "vertical",
  });
  if (!dataA) return true;

  const axisPrim = createAxisLinePrimitive({
    axisLineType,
    dataPoint: dataA,
    color: penColorRef.current,
    lineWidth: penSizeRef.current,
  });
  attachPrim(axisPrim);
  primitivesRef.current.push(axisPrim);
  selectPrimitive(axisPrim.id);
  draggingRef.current = {
    id: axisPrim.id,
    type: "axis-line",
    zone: "center",
    startMouse: pos,
    origDataPoint: { ...dataA },
  };

  return true;
}

/**
 * Line / fib / shape tools, first click: set the anchor and attach a live
 * preview primitive. Returns true when handled.
 */
export function beginTwoPointDrawing({
  tool,
  pos,
  e,
  anchorDataRef,
  previewRef,
  attachPrim,
  screenToDrawingData,
  drawingSnapEnabledRef,
  penColorRef,
  penSizeRef,
  fibLevelsRef,
  fibInvertedRef,
}: BeginTwoPointDrawingOptions): boolean {
  consumePointerEvent(e);
  const isShapeDrawingTool = SHAPE_TOOL_IDS.has(tool);
  const shapeType = shapeTypeFromTool(tool);

  const dataA = screenToDrawingData(pos.x, pos.y, { snap: drawingSnapEnabledRef.current && !e.altKey });
  if (!dataA) return true;
  anchorDataRef.current = dataA;

  const preview = createPreviewPrimitive({
    tool,
    shapeType: isShapeDrawingTool ? shapeType : null,
    dataPoint: dataA,
    color: penColorRef.current,
    lineWidth: penSizeRef.current,
    fibLevels: fibLevelsRef.current,
    fibInverted: fibInvertedRef.current,
  });
  previewRef.current = preview;
  attachPrim(preview);

  return true;
}

/**
 * Line / fib / shape tools, pointer move: update the preview's second point.
 * Returns true when a preview update was applied.
 */
export function updateTwoPointPreview({
  tool,
  pos,
  e,
  anchorDataRef,
  previewRef,
  screenToDrawingData,
  dataToScreen,
  drawingSnapEnabledRef,
}: UpdateTwoPointPreviewOptions): boolean {
  if (!anchorDataRef.current || !previewRef.current) return false;

  let targetPos = pos;
  if (SHAPE_TOOL_IDS.has(tool) && e.shiftKey) {
    const anchorScreen = dataToScreen(anchorDataRef.current);
    targetPos = constrainShapeScreenPoint(anchorScreen, pos);
  }
  const dataB = screenToDrawingData(targetPos.x, targetPos.y, { snap: drawingSnapEnabledRef.current && !e.altKey && !(SHAPE_TOOL_IDS.has(tool) && e.shiftKey) });
  if (dataB) {
    previewRef.current.setDataPoints([anchorDataRef.current, dataB]);
  }
  return true;
}
