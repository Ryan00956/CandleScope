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
  AXIS_LINE_TOOL_IDS,
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

function horizontalAnchorFromDataPoint(dataPoint) {
  if (!dataPoint) return null;
  if (dataPoint.time != null && Number.isFinite(Number(dataPoint.time))) {
    const anchor = { time: dataPoint.time };
    if (Number.isSafeInteger(dataPoint.sourceOrdinal) && dataPoint.sourceOrdinal >= 0) {
      anchor.sourceOrdinal = dataPoint.sourceOrdinal;
    }
    if (typeof dataPoint.sourceProjection === "string" && dataPoint.sourceProjection) {
      anchor.sourceProjection = dataPoint.sourceProjection;
    }
    if (typeof dataPoint.sourceProjectionConfig === "string"
      && dataPoint.sourceProjectionConfig) {
      anchor.sourceProjectionConfig = dataPoint.sourceProjectionConfig;
    }
    if (anchor.sourceOrdinal == null
      && anchor.sourceProjection == null
      && anchor.sourceProjectionConfig == null
      && typeof dataPoint.logical === "number"
      && Number.isFinite(dataPoint.logical)) {
      anchor.logical = dataPoint.logical;
    }
    return anchor;
  }
  if (typeof dataPoint.logical === "number" && Number.isFinite(dataPoint.logical)) {
    return { logical: dataPoint.logical };
  }
  return null;
}

/** Pen / highlighter: begin a freehand stroke. */
export function startFreehandStroke({
  tool,
  pos,
  e,
  primitivesRef,
  currentFreehandRef,
  isDrawingFreehandRef,
  attachPrim,
  screenToData,
  penColorRef,
  penSizeRef,
}) {
  const dataPoint = screenToData(pos.x, pos.y);
  if (!dataPoint) return true;
  const freehand = createFreehandPrimitive({
    tool,
    dataPoint,
    color: penColorRef.current,
    lineWidth: penSizeRef.current,
  });
  attachPrim(freehand);
  primitivesRef.current.push(freehand);
  currentFreehandRef.current = freehand;
  isDrawingFreehandRef.current = true;

  e.preventDefault();
  e.stopPropagation();
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
}) {
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

  e.preventDefault();
  e.stopPropagation();
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
}) {
  const dataA = screenToDrawingData(pos.x, pos.y, { snap: drawingSnapEnabledRef.current && !e.altKey });
  if (!dataA) return true;

  const entryPrice = dataA.price;

  // Calculate visible time range to auto-span ~30% of visible chart
  const adapter = getChartAdapter();
  let startAnchor = horizontalAnchorFromDataPoint(dataA);
  let endAnchor = horizontalAnchorFromDataPoint(dataA);
  if (adapter?.isReady?.()) {
    const vr = adapter.getVisibleTimeRange?.();
    if (vr && dataA.time != null) {
      const visibleSpan = vr.to - vr.from;
      endAnchor = { time: dataA.time + visibleSpan * 0.15 };
    } else if (dataA.logical != null) {
      const logicalRange = adapter.getVisibleRange?.()?.logical;
      const visibleBars = logicalRange ? Math.max(1, logicalRange.to - logicalRange.from) : 20;
      endAnchor = { logical: dataA.logical + Math.max(1, Math.round(visibleBars * 0.15)) };
    }
  }

  // Default TP/SL based on visible price range — ensures proper proportions on any timeframe
  let tpOffset, slOffset;
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
    timeRange: { start: startAnchor, end: endAnchor },
    tpOffset,
    slOffset,
    positionSize: positionSizeRef.current || 1000,
  });

  attachPrim(posPrim);
  primitivesRef.current.push(posPrim);
  selectPrimitive(posPrim.id);
  persistDrawings();

  e.preventDefault();
  e.stopPropagation();
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
}) {
  const isAxisLineTool = AXIS_LINE_TOOL_IDS.has(tool);
  const isShapeDrawingTool = SHAPE_TOOL_IDS.has(tool);
  const shapeType = shapeTypeFromTool(tool);

  if (isAxisLineTool || !anchorDataRef.current || !previewRef.current) return false;

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

  e.preventDefault();
  e.stopPropagation();
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
}) {
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

  e.preventDefault();
  e.stopPropagation();
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
}) {
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

  e.preventDefault();
  e.stopPropagation();
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
}) {
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
