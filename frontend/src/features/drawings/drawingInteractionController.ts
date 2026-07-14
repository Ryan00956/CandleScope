/**
 * useDrawing — Unified React hook for ALL native drawing on the chart.
 *
 * Uses Lightweight Charts v5 Plugin API (ISeriesPrimitive) to render
 * everything directly inside the chart's Canvas pipeline — zero lag.
 *
 * Handles:
 *   - Freehand pen ("pen") and highlighter ("highlighter"): click-drag polylines in data coords
 *   - Two-click lines ("line-segment" / "line-ray" / "line-infinite")
 *   - One-point axis lines ("line-horizontal" / "line-vertical" / "line-cross")
 *   - Angle measurement ("angle-measure") with a visual degree label
 *   - Text annotations ("text"): click to place, inline editing
 *   - Live preview while placing second point of a line
 *   - Magnet snapping to nearby candle OHLC / series values (except pen)
 *   - Selecting / dragging existing lines & text (endpoints or whole body)
 *   - Eraser ("eraser"): click to delete any drawing
 *   - Hover highlight for eraser
 *   - Delete selected element via Delete / Backspace / Escape
 *   - Double-click text to edit
 *   - Clear all drawings
 */
import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { TextDrawingPrimitive } from "./primitives/TextDrawingPrimitive.js";
import { FreehandDrawingPrimitive } from "./primitives/FreehandDrawingPrimitive.js";
import type { AngleMeasurementPrimitive } from "./primitives/AngleMeasurementPrimitive.js";
import type { FibonacciDrawingPrimitive } from "./primitives/FibonacciDrawingPrimitive.js";
import type { LineDrawingPrimitive } from "./primitives/LineDrawingPrimitive.js";
import type { ShapeDrawingPrimitive } from "./primitives/ShapeDrawingPrimitive.js";
import {
  AXIS_LINE_TOOL_IDS,
  FIB_TOOL_IDS,
  LINE_TOOL_IDS,
  POSITION_TOOL_IDS,
  SHAPE_TOOL_IDS,
  cursorStyleForPassiveTool,
  decimateScreenPoints,
  isPassiveCursorTool,
  isTextOverlayTarget,
  setCursor,
} from "./drawingModel.js";
import {
  EMPTY_SELECTED_TEXT_UI,
  hitTestDrawingPrimitives,
  selectedDrawingMetaFromPrimitive,
  useDrawingSelection,
} from "./drawingSelectionController.js";
import type {
  DrawingPrimitiveHit,
  SelectedDrawingMeta,
  SelectedTextSnapshot,
} from "./drawingSelectionController.js";
import {
  canonicalDrawingAnchorFromCoordinate,
  snapDataPointAtPointer,
} from "./drawingSnapController.js";
import { eraseDrawingAtPointer } from "./drawingEraseController.js";
import {
  clearHoveredPrimitive,
  cursorForLineToolHit,
  cursorForPositionToolHit,
  cursorForShapeToolHit,
  cursorForTextToolHit,
  hoverTargetForTool,
  shouldAppendFreehandPoint,
  syncHoveredPrimitive,
} from "./drawingHoverController.js";
import { useDrawingPersistenceLifecycle } from "./useDrawingPersistenceLifecycle.js";
import {
  drawingCommandsForLegacyPrimitive,
  drawingCommandsForSavedDrawing,
} from "./core/drawingDocumentRuntime.js";
import type { DrawingCommand } from "./core/drawingCommands.js";
import { serializeDrawingPrimitive } from "./drawingPersistence.js";
import { useChartPointerPosition, useDrawingPointerEvents } from "./drawingPointerController.js";
import type { DrawingDomPointerEvent } from "./drawingPointerController.js";
import { useDrawingTextEdit } from "./drawingTextEditController.js";
import type { TextEditingOptions } from "./drawingTextEditController.js";
import { useDrawingKeyboard } from "./drawingKeyboardController.js";
import {
  applyTextAndPositionDrag,
  applyLineFibShapeDrag,
  drawingGeometryCommandForDrag,
} from "./drawingDragResizeController.js";
import type { DrawingDragDescriptor } from "./drawingDragResizeController.js";
import {
  coordinateToFractionalLogical,
  coordinateToInterpolatedSeriesTime,
} from "../../chart-adapter/coordinateBridge.js";
import { supportsDrawingHitType } from "./drawingCapabilities.js";
import {
  beginAxisLineDrawing,
  beginTwoPointDrawing,
  commitTwoPointDrawing,
  placePositionDrawing,
  placeTextDrawing,
  startFreehandStroke,
  updateTwoPointPreview,
} from "./drawingCreationController.js";
import {
  appendFreehandStrokeCaptureBatchIncremental,
  cancelFreehandStrokeDraft,
  finalizeFreehandStrokeDraft,
  getFreehandStrokeDraftRemainingCapacity,
  isFreehandStrokeDraftSaturated,
} from "./freehandStrokeModel.js";
import {
  limitFreehandCapturePositions,
  mergePendingActiveDrawingMove,
} from "./drawingMoveBatch.js";
import type {
  ActiveDrawingMovePayload,
  AngleToolId,
  AxisLineToolId,
  BasicLineToolId,
  DrawingAnchorMode,
  DrawingChartAdapter,
  DrawingCoordinateOptions,
  DrawingDataPoint,
  DrawingDataToScreen,
  DrawingHit,
  DrawingPointerEvent,
  DrawingPrimitive,
  DrawingToolId,
  FibonacciToolId,
  FibonacciLevel,
  FreehandStrokeDraft,
  ScreenBox,
  ScreenPoint,
  ScreenToDrawingData,
  ShapeToolId,
  PositionToolId,
  PersistableDrawingPrimitive,
  SavedDrawing,
  TextDrawingPatch,
} from "./drawingTypes.js";
import {
  accumulateDrawingPerfFrameWork,
  drawingPerfCounters,
} from "./performance/drawingPerfCounters.js";

function drawingPerfNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

const TEXT_UI_STABLE_FRAME_LIMIT = 12;

type TwoPointDrawingPrimitive = LineDrawingPrimitive
  | AngleMeasurementPrimitive
  | FibonacciDrawingPrimitive
  | ShapeDrawingPrimitive;
type LineToolId = BasicLineToolId | AxisLineToolId | AngleToolId;
type TwoPointCreationTool = BasicLineToolId | AngleToolId | FibonacciToolId | ShapeToolId;

function isLineToolId(tool: DrawingToolId | null | undefined): tool is LineToolId {
  return tool === "line-segment"
    || tool === "line-ray"
    || tool === "line-infinite"
    || tool === "line-horizontal"
    || tool === "line-vertical"
    || tool === "line-cross"
    || tool === "angle-measure";
}

function isAxisLineToolId(tool: DrawingToolId | null | undefined): tool is AxisLineToolId {
  return tool === "line-horizontal" || tool === "line-vertical" || tool === "line-cross";
}

function isFibonacciToolId(tool: DrawingToolId | null | undefined): tool is FibonacciToolId {
  return tool === "fibonacci";
}

function isPositionToolId(tool: DrawingToolId | null | undefined): tool is PositionToolId {
  return tool === "position-long" || tool === "position-short";
}

function isShapeToolId(tool: DrawingToolId | null | undefined): tool is ShapeToolId {
  return tool === "shape-rectangle" || tool === "shape-ellipse";
}

function isTwoPointCreationTool(
  tool: DrawingToolId | null | undefined,
): tool is TwoPointCreationTool {
  return tool === "line-segment"
    || tool === "line-ray"
    || tool === "line-infinite"
    || tool === "angle-measure"
    || tool === "fibonacci"
    || tool === "shape-rectangle"
    || tool === "shape-ellipse";
}

interface ScreenToDataOptions extends DrawingCoordinateOptions {
  includeLogical?: boolean;
}

interface HoverFeedbackPayload {
  tool: DrawingToolId | null;
  x: number;
  y: number;
}

interface ActiveDrawingMoveInput extends ActiveDrawingMovePayload {
  tool: DrawingToolId | null;
  pos: ScreenPoint;
  positions: ScreenPoint[];
  e: DrawingPointerEvent;
}

function isActiveDrawingMoveInput(
  payload: ActiveDrawingMovePayload | null | undefined,
): payload is ActiveDrawingMoveInput {
  return !!payload
    && (payload.tool == null || typeof payload.tool === "string")
    && !!payload.pos
    && Array.isArray(payload.positions)
    && !!payload.e
    && typeof payload.e.preventDefault === "function"
    && typeof payload.e.stopPropagation === "function";
}

function attachDrawingPrimitive(
  adapter: DrawingChartAdapter,
  primitive: DrawingPrimitive,
): boolean {
  try {
    const attach = adapter.attachPrimitive as (value: object | null | undefined) => boolean;
    return attach(primitive) === true;
  } catch {
    return false;
  }
}

function detachDrawingPrimitive(
  adapter: DrawingChartAdapter,
  primitive: DrawingPrimitive,
): boolean {
  try {
    const detach = adapter.detachPrimitive as (value: object | null | undefined) => boolean;
    return detach(primitive) === true;
  } catch {
    return false;
  }
}

/** Remove a primitive from the runtime registry only after surface detach is confirmed. */
export function detachAndRemoveDrawingPrimitive(
  primitives: DrawingPrimitive[],
  primitive: DrawingPrimitive,
  detachPrimitive: (primitive: DrawingPrimitive) => boolean,
): boolean {
  const index = primitives.indexOf(primitive);
  if (index < 0 || !detachPrimitive(primitive)) return false;
  primitives.splice(index, 1);
  return true;
}

/** Cancelling an absent freehand draft is an idempotent success. */
export function cancelFreehandPrimitiveOnSurface(
  primitive: FreehandDrawingPrimitive | null,
  detachPrimitive: (primitive: DrawingPrimitive) => boolean,
): boolean {
  if (!primitive) return true;
  primitive.cancelPreview?.();
  return detachPrimitive(primitive);
}

/**
 * Cross the document/persistence barrier before discarding interaction state.
 * A failed barrier deliberately leaves the transient descriptor available for
 * the next lifecycle retry.
 */
export function runDrawingSurfaceDisposeBarrier(
  preparePersistenceSurfaceDispose: () => boolean,
  finalizeTransientState: () => void,
): boolean {
  if (!preparePersistenceSurfaceDispose()) return false;
  finalizeTransientState();
  return true;
}

/**
 * Resolve incompatible transient surface credentials before a pointerdown may
 * publish any terminal document command. A matching two-point tool may keep
 * its preview for the legitimate second click; freehand pointerdowns always
 * retire an already-active stroke before starting another gesture.
 */
export function runDrawingPointerTransientBarrier({
  activeTool,
  pendingTwoPointTool,
  hasPendingTwoPoint,
  hasActiveFreehand,
  removePreview,
  cancelActiveFreehandStroke,
}: Readonly<{
  activeTool: DrawingToolId | null;
  pendingTwoPointTool: DrawingToolId | null;
  hasPendingTwoPoint: boolean;
  hasActiveFreehand: boolean;
  removePreview(): boolean;
  cancelActiveFreehandStroke(): boolean;
}>): boolean {
  if (hasActiveFreehand && !cancelActiveFreehandStroke()) return false;
  if (!hasPendingTwoPoint) return true;
  if (isTwoPointCreationTool(activeTool) && activeTool === pendingTwoPointTool) return true;
  return removePreview();
}

/** Hiding stale credentials is fail-closed; showing them must await scope ownership. */
export function canApplyDrawingVisibilityToCurrentPrimitives(
  scopeReady: boolean,
  nextHidden: boolean,
): boolean {
  return scopeReady || nextHidden;
}

export function drawingCommandsForDrag(
  primitives: readonly DrawingPrimitive[],
  dragging: DrawingDragDescriptor,
): readonly DrawingCommand[] | null {
  const primitive = primitives.find((candidate) => candidate.id === dragging.id);
  if (!primitive) return null;
  return drawingCommandsForLegacyPrimitive(primitive, {
    type: "update",
    geometryCommand: drawingGeometryCommandForDrag(dragging),
  });
}

function hasMutableColor(
  primitive: DrawingPrimitive,
): primitive is DrawingPrimitive & { color: string; setColor(color: string): void } {
  return "color" in primitive
    && typeof primitive.color === "string"
    && "setColor" in primitive
    && typeof primitive.setColor === "function";
}

function hasMutableLineWidth(
  primitive: DrawingPrimitive,
): primitive is DrawingPrimitive & { lineWidth: number; setLineWidth(width: number): void } {
  return "lineWidth" in primitive
    && typeof primitive.lineWidth === "number"
    && "setLineWidth" in primitive
    && typeof primitive.setLineWidth === "function";
}

function hasMutableOpacity(
  primitive: DrawingPrimitive,
): primitive is DrawingPrimitive & { opacity: number; setOpacity(opacity: number): void } {
  return "opacity" in primitive
    && typeof primitive.opacity === "number"
    && "setOpacity" in primitive
    && typeof primitive.setOpacity === "function";
}

export interface DrawingStylePatch {
  color?: string;
  lineWidth?: number;
  opacity?: number;
}

export interface UseDrawingOptions {
  chartAdapter: DrawingChartAdapter | null;
  chartContainerRef: MutableRefObject<HTMLElement | null>;
  activeTool: DrawingToolId | null;
  penColor: string;
  penSize: number;
  textFontSize: number;
  textBold: boolean;
  textItalic: boolean;
  fibLevels: FibonacciLevel[] | null;
  fibInverted: boolean;
  positionSize: number;
  drawingSnapEnabled?: boolean;
  symbol: string;
  seriesReady: number;
  drawingCoordinateKey: string;
  drawingAnchorMode: DrawingAnchorMode;
  onToolChange?: ((tool: DrawingToolId | null) => void) | null;
}

export interface DrawingInteractionRuntime {
  clearAll(): void;
  completeSurfaceDispose(): void;
  invalidateSurfaceCredentialsForSeriesReplacement(): void;
  prepareSurfaceDispose(): boolean;
  setHidden(hidden: boolean): void;
  primitivesRef: MutableRefObject<DrawingPrimitive[]>;
  selectedPrimId: string | null;
  selectedDrawingMeta: SelectedDrawingMeta | null;
  editingTextId: string | null;
  editingTextValue: string;
  editingTextPos: ScreenPoint | null;
  setEditingTextValue: Dispatch<SetStateAction<string>>;
  commitTextEditing(options?: TextEditingOptions): boolean;
  cancelTextEditing(options?: TextEditingOptions): boolean;
  editInputRef: MutableRefObject<HTMLTextAreaElement | null>;
  selectedTextSnapshot: SelectedTextSnapshot | null;
  selectedTextBox: ScreenBox | null;
  updateSelectedText(patch: TextDrawingPatch): void;
  updateSelectedDrawingStyle(patch: DrawingStylePatch): void;
  deleteSelected(): void;
}

export function useDrawing({
  chartAdapter,
  chartContainerRef,
  activeTool,
  penColor,
  penSize,
  textFontSize,
  textBold,
  textItalic,
  fibLevels,
  fibInverted,
  positionSize,
  drawingSnapEnabled = true,
  symbol,
  seriesReady,
  drawingCoordinateKey,
  drawingAnchorMode,
  // Optional callback so the hook can flip the active tool back to null after
  // committing a text edit (PPT-style: clicking elsewhere exits text mode).
  onToolChange,
}: UseDrawingOptions): DrawingInteractionRuntime {
  const onToolChangeRef = useRef(onToolChange);
  const getChartAdapter = useCallback(() => chartAdapter || null, [chartAdapter]);
  // ── All primitives (lines + freehand strokes + text) ──
  const primitivesRef = useRef<DrawingPrimitive[]>([]); // (LineDrawingPrimitive | FreehandDrawingPrimitive | TextDrawingPrimitive)[]

  // ── Visibility toggle (hide all without deleting) ──
  const hiddenRef = useRef(false);

  // ── Line-specific state ──
  const previewRef = useRef<TwoPointDrawingPrimitive | null>(null); // LineDrawingPrimitive (dashed preview)
  const anchorDataRef = useRef<DrawingDataPoint | null>(null); // { logical, price } first click
  const pendingTwoPointToolRef = useRef<TwoPointCreationTool | null>(null);
  const draggingRef = useRef<DrawingDragDescriptor | null>(null); // { id, pointIndex, startMouse, origPoints | origDataPoint }

  // ── Selection state + lifecycle (extracted) ──
  const {
    selectedIdRef,
    selectedPrimId,
    selectedTextUi,
    selectedDrawingMeta,
    setSelectedPrimId,
    setSelectedTextUi,
    setSelectedDrawingMeta,
    selectPrimitive,
    deselectAll,
    getPrimitiveById,
    refreshSelectedTextUi,
  } = useDrawingSelection({ primitivesRef });

  // ── Freehand-specific state ──
  const currentFreehandRef = useRef<FreehandDrawingPrimitive | null>(null); // FreehandDrawingPrimitive being drawn
  const freehandDraftRef = useRef<FreehandStrokeDraft | null>(null); // transient synthetic v2/v3 draft, never persisted
  const freehandCaptureIdentityRef = useRef<unknown>(null); // last successful atomic batch identity
  const isDrawingFreehandRef = useRef(false);
  const lastFreehandScreenPointRef = useRef<ScreenPoint | null>(null);
  const hoveredPrimRef = useRef<DrawingPrimitive | null>(null);
  const hoverFrameRef = useRef<number>(0);
  const pendingHoverRef = useRef<HoverFeedbackPayload | null>(null);
  const activeMoveFrameRef = useRef<number>(0);
  const pendingActiveMoveRef = useRef<ActiveDrawingMovePayload | null>(null);
  const beforeScopeTransitionRef = useRef<() => boolean>(() => true);
  const pointerRectRef = useRef<DOMRect | null>(null);

  // ── Tool refs (avoid stale closures) ──
  const activeToolRef = useRef(activeTool);
  const penColorRef = useRef(penColor);
  const penSizeRef = useRef(penSize);
  const textFontSizeRef = useRef(textFontSize);
  const textBoldRef = useRef(textBold);
  const textItalicRef = useRef(textItalic);
  const fibLevelsRef = useRef(fibLevels);
  const fibInvertedRef = useRef(fibInverted);
  const positionSizeRef = useRef(positionSize);
  const drawingSnapEnabledRef = useRef(drawingSnapEnabled);

  const symbolRef = useRef(symbol);

  useEffect(() => {
    onToolChangeRef.current = onToolChange;
    activeToolRef.current = activeTool;
    penColorRef.current = penColor;
    penSizeRef.current = penSize;
    textFontSizeRef.current = textFontSize;
    textBoldRef.current = textBold;
    textItalicRef.current = textItalic;
    fibLevelsRef.current = fibLevels;
    fibInvertedRef.current = fibInverted;
    positionSizeRef.current = positionSize;
    drawingSnapEnabledRef.current = drawingSnapEnabled;
  }, [onToolChange, activeTool, penColor, penSize, textFontSize, textBold, textItalic, fibLevels, fibInverted, positionSize, drawingSnapEnabled]);

  // Track previous symbol so we can detect symbol switches and swap drawing sets
  const prevSymbolRef = useRef(symbol);

  const isLineTool = isLineToolId(activeTool);
  const isFibTool = isFibonacciToolId(activeTool);
  const isPositionTool = isPositionToolId(activeTool);
  const isShapeTool = isShapeToolId(activeTool);
  const isPenTool = activeTool === "pen";
  const isHighlighterTool = activeTool === "highlighter";
  const isTextTool = activeTool === "text";
  const isEraserTool = activeTool === "eraser";

  const resetCursorForActiveTool = useCallback(() => {
    const container = chartContainerRef?.current;
    if (!container) return;
    const tool = activeToolRef.current;
    setCursor(
      container,
      isPassiveCursorTool(tool) ? cursorStyleForPassiveTool(tool) : "crosshair",
    );
  }, [chartContainerRef]);

  useEffect(() => {
    resetCursorForActiveTool();
  }, [activeTool, resetCursorForActiveTool]);

  // ── Coordinate helpers ──
  // Data points keep source-domain Unix time so drawings survive timeframe
  // and chart-representation switches. Time axes preserve a continuous
  // interpolated timestamp. Derived ordinal axes add sourceOrdinal and the
  // projection identity, but never persist projection-local order/logical.
  //
  // During rendering every primitive goes through the shared coordinate
  // bridge, which either interpolates time data or resolves source lineage.

  const screenToData = useCallback(
    (x: number, y: number, options: ScreenToDataOptions = {}): DrawingDataPoint | null => {
      const adapter = getChartAdapter();
      if (!adapter?.isReady?.()) return null;
      try {
        const price = adapter.coordinateToPrice?.(y);
        if (price == null || !isFinite(price)) return null;

        if (adapter.usesOrdinalTime?.() === true) {
          const anchor = canonicalDrawingAnchorFromCoordinate(adapter, x);
          return anchor ? { ...anchor, price } : null;
        }

        const fracLogical = coordinateToFractionalLogical(adapter, x);
        if (fracLogical == null || !isFinite(fracLogical)) return null;

        const time = coordinateToInterpolatedSeriesTime(adapter, x, fracLogical);

        if (time != null && isFinite(time)) {
          return options.includeLogical
            ? { time, price, logical: fracLogical }
            : { time, price };
        }

        return { time: null, price, logical: fracLogical };
      } catch {
        return null;
      }
    },
    [getChartAdapter],
  );

  const screenToFreehandData = useCallback(
    (x: number, y: number) => screenToData(x, y, { includeLogical: true }),
    [screenToData],
  );

  const dataToScreen: DrawingDataToScreen = useCallback(
    (dp: DrawingDataPoint) => {
      const adapter = getChartAdapter();
      if (!adapter?.isReady?.() || !dp) return null;
      try {
        let x = null;
        if (typeof adapter.dataPointToCoordinate === "function") {
          x = adapter.dataPointToCoordinate(dp);
        }
        if ((x == null || !isFinite(x))
          && adapter.usesOrdinalTime?.() !== true
          && dp.time != null) {
          // Try exact match first (fast path)
          if (x == null || !isFinite(x)) x = adapter.timeToCoordinate?.(dp.time);

          // If exact match failed, interpolate between bracketing candles
          if (x == null || !isFinite(x)) {
            x = adapter.timeToCoordinateInterpolated?.(dp.time);
          }
        }
        // Fallback to logical if time-based conversion failed
        if ((x == null || !isFinite(x))
          && adapter.usesOrdinalTime?.() !== true
          && dp.logical != null) {
          x = adapter.logicalToCoordinateInterpolated?.(dp.logical);
        }
        const y = adapter.priceToCoordinate?.(dp.price);
        if (x == null || y == null || !isFinite(x) || !isFinite(y)) return null;
        return { x, y };
      } catch {
        return null;
      }
    },
    [getChartAdapter],
  );

  const snapDataPoint = useCallback(
    (dataPoint: DrawingDataPoint | null, x: number, y: number, options: DrawingCoordinateOptions = {}) => {
      if (!dataPoint || options.snap === false) return dataPoint;
      const allowTime = options.time !== false;
      const allowPrice = options.price !== false;
      if (!allowTime && !allowPrice) return dataPoint;

      return snapDataPointAtPointer(dataPoint, x, y, options, getChartAdapter());
    },
    [getChartAdapter],
  );

  const screenToDrawingData: ScreenToDrawingData = useCallback(
    (x: number, y: number, options: DrawingCoordinateOptions = {}) => {
      const dataPoint = screenToData(x, y);
      if (!dataPoint) return null;
      return snapDataPoint(dataPoint, x, y, options);
    },
    [screenToData, snapDataPoint],
  );

  // ── Attach / detach primitive helpers ──

  const attachPrim = useCallback(
    (prim: DrawingPrimitive): boolean => {
      const adapter = getChartAdapter();
      if (!adapter?.hasSeries?.()) return false;
      prim.setHidden?.(hiddenRef.current, false);
      if (!attachDrawingPrimitive(adapter, prim)) return false;
      try { prim.requestUpdate?.(); } catch { /* attachment already succeeded */ }
      try { adapter.requestSeriesUpdate?.(); } catch { /* attachment already succeeded */ }
      return true;
    },
    [getChartAdapter],
  );

  const detachPrim = useCallback(
    (prim: DrawingPrimitive): boolean => {
      const adapter = getChartAdapter();
      return adapter ? detachDrawingPrimitive(adapter, prim) : false;
    },
    [getChartAdapter],
  );

  const getDrawingPersistenceAdapter = useCallback(() => {
    const adapter = getChartAdapter();
    if (!adapter) return null;
    return {
      hasSeries: () => adapter.hasSeries?.() === true,
      attachPrimitive: (primitive: DrawingPrimitive) => attachDrawingPrimitive(adapter, primitive),
      detachPrimitive: (primitive: DrawingPrimitive) => detachDrawingPrimitive(adapter, primitive),
    };
  }, [getChartAdapter]);

  const {
    clearDrawings,
    completeSurfaceDispose: completePersistenceSurfaceDispose,
    invalidateSurfaceCredentialsForSeriesReplacement,
    persistActiveScopeDrawings,
    persistDrawings,
    prepareSurfaceDispose: preparePersistenceSurfaceDispose,
    prepareUserMutationScope,
  } = useDrawingPersistenceLifecycle({
    beforeScopeTransitionRef,
    currentFreehandRef,
    draggingRef,
    getChartAdapter: getDrawingPersistenceAdapter,
    hiddenRef,
    isDrawingFreehandRef,
    prevSymbolRef,
    primitivesRef,
    selectedIdRef,
    seriesReady,
    setSelectedPrimId,
    setSelectedTextUi,
    symbol,
    symbolRef,
  });

  const cancelActiveFreehandStroke = useCallback(() => {
    const draft = freehandDraftRef.current;
    const primitive = currentFreehandRef.current;
    if (draft) cancelFreehandStrokeDraft(draft);
    if (!cancelFreehandPrimitiveOnSurface(primitive, detachPrim)) return false;
    if (primitive) {
      primitivesRef.current = primitivesRef.current.filter((item) => item !== primitive);
    }
    freehandDraftRef.current = null;
    freehandCaptureIdentityRef.current = null;
    currentFreehandRef.current = null;
    isDrawingFreehandRef.current = false;
    lastFreehandScreenPointRef.current = null;
    return true;
  }, [detachPrim]);

  // ── Selection helpers are provided by useDrawingSelection above ──

  // ── Hit-test all primitives ──

  const hitTestAll = useCallback(
    (x: number, y: number, hitRadius = 8): DrawingPrimitiveHit | null => {
      return hitTestDrawingPrimitives(primitivesRef.current, x, y, hitRadius);
    },
    [],
  );

  const hitTestInteractive = useCallback(
    (x: number, y: number, hitRadius = 8): DrawingPrimitiveHit | null => {
      const hit = hitTestAll(x, y, hitRadius);
      return hit && supportsDrawingHitType(drawingAnchorMode, hit.type) ? hit : null;
    },
    [drawingAnchorMode, hitTestAll],
  );

  // ── Remove line preview ──

  const removePreview = useCallback(() => {
    if (previewRef.current) {
      if (!detachPrim(previewRef.current)) return false;
      previewRef.current = null;
    }
    anchorDataRef.current = null;
    pendingTwoPointToolRef.current = null;
    return true;
  }, [detachPrim]);

  const prepareTerminalTextMutation = useCallback(() => {
    if (!runDrawingPointerTransientBarrier({
      // Text commit is never a legitimate continuation of a two-point draft,
      // even if the toolbar still reports the old line/fib/shape tool.
      activeTool: "text",
      pendingTwoPointTool: pendingTwoPointToolRef.current,
      hasPendingTwoPoint: anchorDataRef.current !== null || previewRef.current !== null,
      hasActiveFreehand: isDrawingFreehandRef.current
        || currentFreehandRef.current !== null
        || freehandDraftRef.current !== null,
      removePreview,
      cancelActiveFreehandStroke,
    })) return false;
    return prepareUserMutationScope();
  }, [cancelActiveFreehandStroke, prepareUserMutationScope, removePreview]);

  // ── Text editing lifecycle (extracted) ──

  const {
    editingTextId,
    editingTextValue,
    editingTextPos,
    editingTextIdRef,
    editInputRef,
    setEditingTextValue,
    setEditingTextPos,
    startTextEditing,
    commitTextEditing,
    cancelTextEditing,
    completeSurfaceDispose: completeTextSurfaceDispose,
  } = useDrawingTextEdit({
    primitivesRef,
    selectedIdRef,
    getPrimitiveById,
    attachPrim,
    detachPrim,
    deselectAll,
    selectPrimitive,
    refreshSelectedTextUi,
    beforeTerminalMutation: prepareTerminalTextMutation,
    persistDrawings,
    dataToScreen,
    activeToolRef,
    onToolChangeRef,
    setSelectedPrimId,
    setSelectedTextUi,
  });

  // ── Get mouse position relative to chart container ──

  const getChartPos = useChartPointerPosition(chartContainerRef);

  const getCachedPointerRect = useCallback(() => {
    const container = chartContainerRef?.current;
    if (!container) return null;
    if (!pointerRectRef.current) {
      pointerRectRef.current = container.getBoundingClientRect();
    }
    return pointerRectRef.current;
  }, [chartContainerRef]);

  const clearCachedPointerRect = useCallback(() => {
    pointerRectRef.current = null;
  }, []);

  const makePointerEventSnapshot = useCallback((e: DrawingDomPointerEvent): DrawingPointerEvent => ({
    altKey: !!e.altKey,
    shiftKey: !!e.shiftKey,
    preventDefault() {},
    stopPropagation() {},
  }), []);

  const cancelPendingHoverFrame = useCallback(() => {
    if (!hoverFrameRef.current) return;
    if (typeof hoverFrameRef.current === "number" && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(hoverFrameRef.current);
    } else {
      clearTimeout(hoverFrameRef.current);
    }
    hoverFrameRef.current = 0;
    pendingHoverRef.current = null;
  }, []);

  const clearHoverFeedback = useCallback(() => {
    cancelPendingHoverFrame();
    clearHoveredPrimitive(hoveredPrimRef);
  }, [cancelPendingHoverFrame]);

  const applyHoverFeedback = useCallback(
    ({ tool, x, y }: HoverFeedbackPayload) => {
      const hit = tool === "eraser"
        ? hitTestAll(x, y)
        : hitTestInteractive(x, y);
      syncHoveredPrimitive(hoveredPrimRef, hoverTargetForTool(tool, hit));

      const container = chartContainerRef?.current;
      if (!container) return;

      if (isLineToolId(tool)) {
        setCursor(container, cursorForLineToolHit(hit));
      } else if (isShapeToolId(tool)) {
        setCursor(container, cursorForShapeToolHit(hit));
      } else if (isPositionToolId(tool)) {
        setCursor(container, cursorForPositionToolHit(hit));
      } else if (tool === "text") {
        setCursor(container, cursorForTextToolHit(hit));
      }
    },
    [chartContainerRef, hitTestAll, hitTestInteractive],
  );

  const scheduleHoverFeedback = useCallback(
    ({ tool, x, y }: HoverFeedbackPayload) => {
      pendingHoverRef.current = { tool, x, y };
      if (hoverFrameRef.current) return;

      const schedule: (callback: () => void) => number =
        typeof requestAnimationFrame === "function"
          ? (callback) => requestAnimationFrame(callback)
          : (callback) => window.setTimeout(callback, 16);

      hoverFrameRef.current = schedule(() => {
        hoverFrameRef.current = 0;
        const next = pendingHoverRef.current;
        pendingHoverRef.current = null;
        if (next) applyHoverFeedback(next);
      });
    },
    [applyHoverFeedback],
  );

  useEffect(() => () => {
    cancelPendingHoverFrame();
  }, [cancelPendingHoverFrame]);

  const applyActiveDrawingMove = useCallback(
    ({ tool, pos, positions, e }: ActiveDrawingMoveInput): boolean => {
      // ── PEN / HIGHLIGHTER (freehand): extend stroke ──
      if ((tool === "pen" || tool === "highlighter") && isDrawingFreehandRef.current && currentFreehandRef.current) {
        const minDistance = tool === "highlighter" ? 1.5 : 1;
        const accepted: ScreenPoint[] = [];
        let latestPoint = lastFreehandScreenPointRef.current;
        for (const point of positions?.length ? positions : [pos]) {
          if (!point || !shouldAppendFreehandPoint(latestPoint, point, minDistance)) {
            continue;
          }
          accepted.push(point);
          latestPoint = { x: point.x, y: point.y };
        }
        if (accepted.length === 0) return true;

        const draft = freehandDraftRef.current;
        if (draft) {
          if (isFreehandStrokeDraftSaturated(draft)) return true;
          const remainingCapacity = getFreehandStrokeDraftRemainingCapacity(draft);
          if (typeof remainingCapacity !== "number" || !Number.isSafeInteger(remainingCapacity)) {
            cancelActiveFreehandStroke();
            return true;
          }
          const capturePositions = limitFreehandCapturePositions(
            accepted,
            remainingCapacity,
          );
          if (capturePositions.length === 0) return true;
          const batch = getChartAdapter()?.captureFreehandStrokeBatch?.(capturePositions);
          if (!batch) {
            cancelActiveFreehandStroke();
            return true;
          }
          const appendResult = appendFreehandStrokeCaptureBatchIncremental(draft, batch);
          if (!appendResult) {
            cancelActiveFreehandStroke();
            return true;
          }
          freehandCaptureIdentityRef.current = batch.captureIdentity;
          if (appendResult.previewPoints.length > 0
            && !currentFreehandRef.current.appendPreviewPoints(
              appendResult.previewPoints,
            )) {
            cancelActiveFreehandStroke();
            return true;
          }
          let lastPreviewPoint: ScreenPoint | null = null;
          for (let index = appendResult.previewPoints.length - 1; index >= 0; index -= 1) {
            const previewPoint = appendResult.previewPoints[index];
            if (previewPoint) {
              lastPreviewPoint = previewPoint;
              break;
            }
          }
          if (lastPreviewPoint) {
            lastFreehandScreenPointRef.current = { ...lastPreviewPoint };
          }
          return true;
        }

        for (const point of accepted) {
          const dataPoint = screenToFreehandData(point.x, point.y);
          if (!dataPoint) continue;
          currentFreehandRef.current.addPoint(dataPoint);
          lastFreehandScreenPointRef.current = { x: point.x, y: point.y };
        }
        return true;
      }

      // ── Drag/resize of existing text & position drawings (extracted) ──
      if (applyTextAndPositionDrag({
        dragging: draggingRef.current,
        pos,
        e,
        primitivesRef,
        screenToData,
        dataToScreen,
        screenToDrawingData,
        refreshSelectedTextUi,
        drawingSnapEnabledRef,
        chartContainerRef,
      })) {
        return true;
      }

      // ── LINE / FIB / SHAPE TOOLS ──
      if (isTwoPointCreationTool(tool) || isAxisLineToolId(tool)) {
        if (draggingRef.current) {
          applyLineFibShapeDrag({
            dragging: draggingRef.current,
            pos,
            e,
            primitivesRef,
            screenToData,
            dataToScreen,
            screenToDrawingData,
            drawingSnapEnabledRef,
          });
          return true;
        }

        if (isTwoPointCreationTool(tool) && updateTwoPointPreview({
          tool, pos, e, anchorDataRef, previewRef, screenToDrawingData, dataToScreen, drawingSnapEnabledRef,
        })) return true;
      }

      return false;
    },
    [cancelActiveFreehandStroke, getChartAdapter, screenToFreehandData, screenToData, dataToScreen, screenToDrawingData, refreshSelectedTextUi, chartContainerRef],
  );

  const cancelActiveMoveFrame = useCallback(() => {
    if (!activeMoveFrameRef.current) return;
    if (typeof activeMoveFrameRef.current === "number" && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(activeMoveFrameRef.current);
    } else {
      clearTimeout(activeMoveFrameRef.current);
    }
    activeMoveFrameRef.current = 0;
  }, []);

  const applyMeasuredActiveDrawingMove = useCallback((input: ActiveDrawingMoveInput) => {
    const startedAt = drawingPerfNow();
    const result = applyActiveDrawingMove(input);
    const durationMs = Math.max(0, drawingPerfNow() - startedAt);
    drawingPerfCounters.recordInteractionDuration(durationMs);
    drawingPerfCounters.recordActiveOverlayCpuDuration(durationMs);
    accumulateDrawingPerfFrameWork({ drawingMainThreadMs: durationMs });
    return result;
  }, [applyActiveDrawingMove]);

  const flushActiveDrawingMove = useCallback(() => {
    cancelActiveMoveFrame();
    const next = pendingActiveMoveRef.current;
    pendingActiveMoveRef.current = null;
    if (isActiveDrawingMoveInput(next)) applyMeasuredActiveDrawingMove(next);
  }, [applyMeasuredActiveDrawingMove, cancelActiveMoveFrame]);

  const prepareDrawingScopeTransition = useCallback(() => {
    const committedDrag = !isDrawingFreehandRef.current
      ? draggingRef.current
      : null;
    flushActiveDrawingMove();
    if (committedDrag) {
      const commands = drawingCommandsForDrag(primitivesRef.current, committedDrag);
      if (!commands || persistActiveScopeDrawings(commands) === false) return false;
    }
    const hadActiveFreehand = currentFreehandRef.current !== null;
    if (hadActiveFreehand && !cancelActiveFreehandStroke()) return false;
    if (!removePreview()) return false;
    // The backing primitive of a newly-created text annotation is deliberately
    // empty until confirmation. Cancel it before persistence snapshots the old
    // scope so it is detached as well as excluded by the canonical filter.
    return cancelTextEditing();
  }, [cancelActiveFreehandStroke, cancelTextEditing, flushActiveDrawingMove, persistActiveScopeDrawings, removePreview]);

  useEffect(() => {
    beforeScopeTransitionRef.current = prepareDrawingScopeTransition;
    return () => {
      beforeScopeTransitionRef.current = () => true;
    };
  }, [prepareDrawingScopeTransition]);

  const cancelActiveDrawingMove = useCallback(() => {
    cancelActiveMoveFrame();
    pendingActiveMoveRef.current = null;
    clearCachedPointerRect();
  }, [cancelActiveMoveFrame, clearCachedPointerRect]);

  const scheduleActiveDrawingMove = useCallback(
    (payload: ActiveDrawingMoveInput) => {
      pendingActiveMoveRef.current = mergePendingActiveDrawingMove(
        pendingActiveMoveRef.current,
        payload,
      ) ?? null;
      if (activeMoveFrameRef.current) return;

      const schedule: (callback: () => void) => number =
        typeof requestAnimationFrame === "function"
          ? (callback) => requestAnimationFrame(callback)
          : (callback) => window.setTimeout(callback, 16);

      activeMoveFrameRef.current = schedule(() => {
        activeMoveFrameRef.current = 0;
        const next = pendingActiveMoveRef.current;
        pendingActiveMoveRef.current = null;
        if (isActiveDrawingMoveInput(next)) applyMeasuredActiveDrawingMove(next);
      });
    },
    [applyMeasuredActiveDrawingMove],
  );

  useEffect(() => {
    if (!seriesReady) return;

    const committedDrag = !isDrawingFreehandRef.current
      ? draggingRef.current
      : null;
    flushActiveDrawingMove();
    if (committedDrag) {
      const commands = drawingCommandsForDrag(primitivesRef.current, committedDrag);
      if (!commands || persistDrawings(commands) === false) return;
    }
    cancelActiveDrawingMove();
    removePreview();
    clearHoverFeedback();
    cancelTextEditing();
    deselectAll();
    draggingRef.current = null;
    resetCursorForActiveTool();

    cancelActiveFreehandStroke();
  }, [
    cancelActiveDrawingMove,
    cancelTextEditing,
    clearHoverFeedback,
    deselectAll,
    drawingCoordinateKey,
    cancelActiveFreehandStroke,
    flushActiveDrawingMove,
    persistDrawings,
    removePreview,
    resetCursorForActiveTool,
    seriesReady,
  ]);

  useEffect(() => () => {
    const committedDrag = !isDrawingFreehandRef.current
      ? draggingRef.current
      : null;
    flushActiveDrawingMove();
    if (committedDrag) {
      const commands = drawingCommandsForDrag(primitivesRef.current, committedDrag);
      if (!commands || persistDrawings(commands) === false) return;
    }
    cancelActiveDrawingMove();
    cancelActiveFreehandStroke();
    removePreview();
    clearHoverFeedback();
    draggingRef.current = null;
    setCursor(chartContainerRef?.current, "default");
  }, [
    cancelActiveDrawingMove,
    cancelActiveFreehandStroke,
    chartContainerRef,
    clearHoverFeedback,
    removePreview,
    flushActiveDrawingMove,
    persistDrawings,
  ]);

  const beginTextDrag = useCallback((
    prim: DrawingPrimitive,
    hit: DrawingHit | false | null,
    pos: ScreenPoint | null,
  ): boolean => {
    if (!(prim instanceof TextDrawingPrimitive) || !hit || !pos) return false;

    const box = prim.getBoundingBoxScreen();
    if (hit.handle && box) {
      draggingRef.current = {
        id: prim.id,
        type: "text-handle",
        handle: hit.handle,
        startMouse: pos,
        origBox: box,
        origFontSize: prim.fontSize,
        origWidthPx: prim.widthPx,
        origDataPoint: { ...prim.dataPoint },
      };
    } else {
      draggingRef.current = {
        id: prim.id,
        type: "text",
        startMouse: pos,
        origDataPoint: { ...prim.dataPoint },
      };
    }
    return true;
  }, []);

  // ── While editing OR a text is selected, keep the textarea and toolbar
  // pinned during chart interactions, then stop once the position stabilizes.
  useEffect(() => {
    const activeId = editingTextId || selectedPrimId;
    if (!activeId) return;

    let raf = 0;
    let lastX = NaN;
    let lastY = NaN;
    let stableFrames = 0;

    const stop = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    const tick = () => {
      const prim = primitivesRef.current.find((p) => p.id === activeId);
      if (prim && prim instanceof TextDrawingPrimitive) {
        const sp = dataToScreen(prim.dataPoint);
        if (sp && (Math.abs(sp.x - lastX) > 0.5 || Math.abs(sp.y - lastY) > 0.5)) {
          lastX = sp.x;
          lastY = sp.y;
          if (editingTextId === activeId) {
            setEditingTextPos({ x: sp.x, y: sp.y });
          } else {
            refreshSelectedTextUi(activeId);
          }
          stableFrames = 0;
        } else {
          stableFrames += 1;
        }
      } else {
        stableFrames += 1;
      }

      if (stableFrames < TEXT_UI_STABLE_FRAME_LIMIT) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = 0;
      }
    };

    const start = () => {
      if (raf) return;
      stableFrames = 0;
      raf = requestAnimationFrame(tick);
    };

    start();

    const container = chartContainerRef?.current;
    container?.addEventListener("wheel", start, { passive: true });
    container?.addEventListener("pointerdown", start, true);
    container?.addEventListener("pointermove", start, { passive: true });
    window.addEventListener("resize", start);

    return () => {
      stop();
      container?.removeEventListener("wheel", start);
      container?.removeEventListener("pointerdown", start, true);
      container?.removeEventListener("pointermove", start);
      window.removeEventListener("resize", start);
    };
  }, [
    chartContainerRef,
    dataToScreen,
    drawingCoordinateKey,
    editingTextId,
    refreshSelectedTextUi,
    selectedPrimId,
    seriesReady,
    setEditingTextPos,
  ]);

  // ════════════════════════════════════════════════════
  //  MOUSE DOWN
  // ════════════════════════════════════════════════════

  const handleMouseDown = useCallback(
    (e: DrawingDomPointerEvent) => {
      flushActiveDrawingMove();
      const tool = activeToolRef.current;
      const pos = getChartPos(e);
      if (!pos) return;

      if (!runDrawingPointerTransientBarrier({
        activeTool: tool,
        pendingTwoPointTool: pendingTwoPointToolRef.current,
        hasPendingTwoPoint: anchorDataRef.current !== null || previewRef.current !== null,
        hasActiveFreehand: isDrawingFreehandRef.current
          || currentFreehandRef.current !== null
          || freehandDraftRef.current !== null,
        removePreview,
        cancelActiveFreehandStroke,
      })) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // React may already render symbol B while a failed transition still owns
      // symbol A's store/surface credentials. Consume this first B-side action
      // and schedule the lifecycle effect to retry before creating, selecting,
      // dragging, or otherwise mutating any canonical primitive.
      if (!prepareUserMutationScope()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // Editing text owns the next chart click. Commit through the same path
      // for blank clicks, text clicks, and text-tool clicks so blur does not
      // become a separate hidden state transition.
      if (editingTextIdRef.current) {
        const hit = hitTestInteractive(pos.x, pos.y);
        const clickedTextId = hit?.type === "text" ? hit.prim.id : null;
        commitTextEditing({ clearSelection: !clickedTextId, exitTool: true });
        if (clickedTextId && primitivesRef.current.some((p) => p.id === clickedTextId)) {
          selectPrimitive(clickedTextId);
        }
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // Passive cursor mode: PPT-style click-away deselect for text boxes,
      // OR re-grab the selected text for move/resize so the floating format
      // toolbar mode stays useful (drag body to move, drag a handle to scale).
      if (isPassiveCursorTool(tool) && selectedIdRef.current) {
        const sel = getPrimitiveById(selectedIdRef.current);
        if (sel instanceof TextDrawingPrimitive) {
          if (supportsDrawingHitType(drawingAnchorMode, "text")) {
            let hit: DrawingHit | false = false;
            try { hit = sel.hitTestGeometry(pos.x, pos.y); } catch { /* ignore */ }
            if (hit) {
              clearHoverFeedback();
              beginTextDrag(sel, hit, pos);
              e.preventDefault();
              e.stopPropagation();
              return;
            }
          }
          // Clicked outside the selected text → drop selection.
          deselectAll();
        } else if (sel) {
          let stillOnIt = false;
          try {
            if (typeof sel.hitTestGeometry === "function") {
              stillOnIt = !!sel.hitTestGeometry(pos.x, pos.y);
            }
          } catch { /* ignore */ }
          if (!stillOnIt) deselectAll();
        }
      }

      // ── ERASER: click to delete ──
      if (tool === "eraser") {
        const hit = hitTestAll(pos.x, pos.y);
        clearHoverFeedback();
        eraseDrawingAtPointer({
          detachPrim,
          hit,
          persistDrawings,
          primitivesRef,
          selectedIdRef,
          setSelectedPrimId,
          setSelectedTextUi,
        });
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // ── PEN / HIGHLIGHTER (freehand): start stroke ──
      if (tool === "pen" || tool === "highlighter") {
        const adapter = getChartAdapter();
        const sourceLineage = adapter?.usesOrdinalTime?.() === true;
        const captureBatch = sourceLineage
          ? adapter.captureFreehandStrokeBatch?.([pos]) || null
          : null;
        if (startFreehandStroke({
          tool, pos, e, primitivesRef, currentFreehandRef, isDrawingFreehandRef,
          freehandDraftRef, attachPrim, screenToData: screenToFreehandData,
          freehandCaptureIdentityRef, penColorRef, penSizeRef, sourceLineage, captureBatch,
        })) {
          lastFreehandScreenPointRef.current = currentFreehandRef.current ? { x: pos.x, y: pos.y } : null;
          clearHoverFeedback();
          return;
        }
      }

      // ── TEXT TOOL ──
      if (tool === "text") {
        // Check if clicking on existing text → select it (or grab a handle)
        const hit = hitTestInteractive(pos.x, pos.y);
        if (hit && hit.type === "text") {
          selectPrimitive(hit.prim.id);
          clearHoverFeedback();
          beginTextDrag(hit.prim, hit, pos);
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // Deselect if something was selected
        if (selectedIdRef.current) {
          deselectAll();
        }

        // Place new text
        if (placeTextDrawing({
          pos, e, primitivesRef, attachPrim, startTextEditing, cancelTextEditing,
          screenToDrawingData,
          drawingSnapEnabledRef, penColorRef, textFontSizeRef, textBoldRef, textItalicRef,
        })) return;
      }

      // ── POSITION TOOLS ──
      if (isPositionToolId(tool)) {
        // Clicking on existing position → select
        const hit = hitTestInteractive(pos.x, pos.y);
        if (hit && hit.type === "position") {
          selectPrimitive(hit.prim.id);

          // Start dragging TP or SL handle
          if (hit.zone === "tp") {
            draggingRef.current = {
              id: hit.prim.id,
              type: "position-tp",
              startMouse: pos,
              origTpPrice: hit.prim.tpPrice,
            };
          } else if (hit.zone === "sl") {
            draggingRef.current = {
              id: hit.prim.id,
              type: "position-sl",
              startMouse: pos,
              origSlPrice: hit.prim.slPrice,
            };
          } else if (hit.zone === "entry" || hit.zone === "body") {
            // Drag the whole position
            draggingRef.current = {
              id: hit.prim.id,
              type: "position-move",
              startMouse: pos,
              origEntry: hit.prim.entryPrice,
              origTp: hit.prim.tpPrice,
              origSl: hit.prim.slPrice,
              origTimeRange: { ...hit.prim.timeRange },
            };
          } else if (hit.zone === "panel") {
            draggingRef.current = {
              id: hit.prim.id,
              type: "position-panel",
              startMouse: pos,
              origInfoPanelOffset: { ...hit.prim.infoPanelOffset },
            };
          } else if (hit.zone === "left") {
            draggingRef.current = {
              id: hit.prim.id,
              type: "position-left",
              startMouse: pos,
              origTimeRange: { ...hit.prim.timeRange },
            };
          } else if (hit.zone === "right") {
            draggingRef.current = {
              id: hit.prim.id,
              type: "position-right",
              startMouse: pos,
              origTimeRange: { ...hit.prim.timeRange },
            };
          }

          clearHoverFeedback();
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // Deselect if something was selected
        if (selectedIdRef.current) {
          deselectAll();
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // Place new position: click sets entry price
        if (placePositionDrawing({
          tool, pos, e, primitivesRef, attachPrim, detachPrim, selectPrimitive, persistDrawings,
          screenToDrawingData, getChartAdapter, chartContainerRef, drawingSnapEnabledRef, positionSizeRef,
        })) return;
      }

      // ── LINE/FIB/SHAPE TOOLS ──
      if (isTwoPointCreationTool(tool) || isAxisLineToolId(tool)) {
        const isAxisLineTool = isAxisLineToolId(tool);

        // Second click — commit new line/fib/shape
        if (isTwoPointCreationTool(tool)) {
          const handled = commitTwoPointDrawing({
            tool, pos, e, primitivesRef, anchorDataRef, previewRef, attachPrim, detachPrim,
            selectPrimitive, persistDrawings, screenToDrawingData, dataToScreen, drawingSnapEnabledRef,
            penColorRef, penSizeRef, fibLevelsRef, fibInvertedRef,
          });
          if (handled) {
            if (!previewRef.current && !anchorDataRef.current) {
              pendingTwoPointToolRef.current = null;
            }
            return;
          }
        }

        // Hit existing element?
        const hit = hitTestInteractive(pos.x, pos.y);
        if (hit && (hit.type === "line" || hit.type === "axis-line" || hit.type === "angle" || hit.type === "fibonacci" || hit.type === "shape")) {
          selectPrimitive(hit.prim.id);

          if (hit.type === "axis-line") {
            const originalDataPoint = hit.prim.dataPoint;
            if (!originalDataPoint) return;
            draggingRef.current = {
              id: hit.prim.id,
              type: "axis-line",
              zone: hit.zone || "body",
              startMouse: pos,
              origDataPoint: { ...originalDataPoint },
            };
          } else if (hit.type === "shape") {
            draggingRef.current = {
              id: hit.prim.id,
              type: "shape",
              zone: hit.zone || "body",
              startMouse: pos,
              origPoints: hit.prim.dataPoints.map((p) => ({ ...p })),
              origBox: hit.prim.getBoundingBoxScreen?.() || null,
            };
          } else if ((hit.pointIndex ?? -1) >= 0) {
            // Start dragging endpoint
            draggingRef.current = {
              id: hit.prim.id,
              type: hit.type,
              pointIndex: hit.pointIndex ?? -1,
              startMouse: pos,
              origPoints: hit.prim.dataPoints.map((p) => ({ ...p })),
            };
          } else {
            // Start dragging entire line/fib
            draggingRef.current = {
              id: hit.prim.id,
              type: hit.type,
              pointIndex: -1,
              startMouse: pos,
              origPoints: hit.prim.dataPoints.map((p) => ({ ...p })),
            };
          }

          clearHoverFeedback();
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        if (hit && hit.type === "text") {
          selectPrimitive(hit.prim.id);
          draggingRef.current = {
            id: hit.prim.id,
            type: "text",
            startMouse: pos,
            origDataPoint: { ...hit.prim.dataPoint },
          };
          clearHoverFeedback();
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // Deselect if something was selected
        if (selectedIdRef.current) {
          deselectAll();
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // One-point axis lines: click creates immediately; drag before mouseup adjusts it.
        if (isAxisLineTool) {
          if (beginAxisLineDrawing({
            tool, pos, e, primitivesRef, anchorDataRef, previewRef, draggingRef, attachPrim, detachPrim,
            selectPrimitive, persistDrawings, removePreview, screenToDrawingData,
            drawingSnapEnabledRef, penColorRef, penSizeRef,
          })) return;
        }

        // First click — set anchor
        if (isTwoPointCreationTool(tool)) {
          const handled = beginTwoPointDrawing({
            tool, pos, e, anchorDataRef, previewRef, attachPrim, screenToDrawingData,
            drawingSnapEnabledRef, penColorRef, penSizeRef, fibLevelsRef, fibInvertedRef,
          });
          if (handled) {
            pendingTwoPointToolRef.current = previewRef.current ? tool : null;
            return;
          }
        }
      }
    },
    [flushActiveDrawingMove, getChartPos, screenToFreehandData, screenToDrawingData, dataToScreen, detachPrim, attachPrim, hitTestAll, hitTestInteractive, selectPrimitive, deselectAll, getPrimitiveById, beginTextDrag, startTextEditing, commitTextEditing, cancelTextEditing, persistDrawings, prepareUserMutationScope, removePreview, cancelActiveFreehandStroke, getChartAdapter, chartContainerRef, drawingAnchorMode, editingTextIdRef, selectedIdRef, setSelectedPrimId, setSelectedTextUi, clearHoverFeedback],
  );

  // ════════════════════════════════════════════════════
  //  DOUBLE CLICK — edit text
  // ════════════════════════════════════════════════════

  const handleDblClick = useCallback(
    (e: MouseEvent) => {
      const pos = getChartPos(e);
      if (!pos) return;

      const hit = hitTestInteractive(pos.x, pos.y);
      if (hit && hit.type === "text") {
        if (!prepareTerminalTextMutation()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        startTextEditing(hit.prim);
        e.preventDefault();
        e.stopPropagation();
      }
    },
    [getChartPos, hitTestInteractive, prepareTerminalTextMutation, startTextEditing],
  );

  // ════════════════════════════════════════════════════
  //  MOUSE MOVE
  // ════════════════════════════════════════════════════

  const handleMouseMove = useCallback(
    (e: DrawingDomPointerEvent) => {
      const tool = activeToolRef.current;
      const hasFreehandMove = (tool === "pen" || tool === "highlighter")
        && isDrawingFreehandRef.current
        && currentFreehandRef.current;
      const hasDragMove = !!draggingRef.current;
      const hasPreviewMove = (isTwoPointCreationTool(tool) || isAxisLineToolId(tool))
        && anchorDataRef.current
        && previewRef.current;

      if (hasFreehandMove || hasDragMove || hasPreviewMove) {
        if (!prepareUserMutationScope()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        const inputStartedAt = drawingPerfNow();
        const rect = getCachedPointerRect();
        const coalescedEvents = hasFreehandMove
          && "getCoalescedEvents" in e
          && typeof e.getCoalescedEvents === "function"
          ? e.getCoalescedEvents()
          : null;
        const sourceEvents = coalescedEvents?.length ? coalescedEvents : [e];
        const positions = sourceEvents
          .map((event: DrawingDomPointerEvent) => getChartPos(event, rect))
          .filter((point: ScreenPoint | null): point is ScreenPoint => point !== null);
        const pos = positions[positions.length - 1] || getChartPos(e, rect);
        if (!pos) return;
        const inputDurationMs = Math.max(0, drawingPerfNow() - inputStartedAt);
        drawingPerfCounters.recordInputDuration(inputDurationMs);
        if (sourceEvents.length > 1) {
          drawingPerfCounters.incrementCounter("inputCount", sourceEvents.length - 1);
        }

        e.preventDefault();
        e.stopPropagation();
        scheduleActiveDrawingMove({
          tool,
          pos,
          positions,
          e: makePointerEventSnapshot(e),
        });
        return;
      }

      const pos = getChartPos(e);
      if (!pos) return;

      // ── ERASER: hover highlight ──
      if (tool === "eraser") {
        scheduleHoverFeedback({ tool, x: pos.x, y: pos.y });
        return;
      }

      // ── LINE / FIB / SHAPE TOOLS ──
      if (isTwoPointCreationTool(tool) || isAxisLineToolId(tool)) {
        // Hover feedback on lines, fibs and text
        scheduleHoverFeedback({ tool, x: pos.x, y: pos.y });
      }

      // ── POSITION TOOL: hover feedback ──
      if (isPositionToolId(tool) && !draggingRef.current) {
        scheduleHoverFeedback({ tool, x: pos.x, y: pos.y });
      }

      // ── TEXT TOOL: hover feedback for existing text + handle cursors ──
      if (tool === "text" && !draggingRef.current) {
        scheduleHoverFeedback({ tool, x: pos.x, y: pos.y });
      }
    },
    [getCachedPointerRect, getChartPos, makePointerEventSnapshot, prepareUserMutationScope, scheduleActiveDrawingMove, scheduleHoverFeedback],
  );

  // ════════════════════════════════════════════════════
  //  MOUSE UP
  // ════════════════════════════════════════════════════

  const handleMouseUp = useCallback(() => {
    // Do not flush a B-side pointer sample into an A-side gesture. The retrying
    // scope effect owns the old gesture and flushes its last legal A sample via
    // the private active-scope persistence path.
    if (!prepareUserMutationScope()) return;
    const mouseupStartedAt = drawingPerfNow();
    flushActiveDrawingMove();
    let commands: readonly DrawingCommand[] | null = null;
    let completedDrag = false;
    let completedFreehand = false;
    let completedFreehandDraft: FreehandStrokeDraft | null = null;
    // End freehand drawing
    if (isDrawingFreehandRef.current) {
      // ── Decimate stroke via RDP to reduce render cost ──
      const prim = currentFreehandRef.current;
      const draft = freehandDraftRef.current;
      let committed = false;
      if (prim && draft) {
        const stroke = finalizeFreehandStrokeDraft(draft, {
          captureIdentity: freehandCaptureIdentityRef.current,
          epsilon: 1.5,
        });
        committed = !!stroke && prim.commitStroke?.(stroke) === true;
      } else if (prim && prim.dataPoints.length > 3) {
        // Convert data points to screen coordinates for pixel-space RDP
        const indexed: Array<ScreenPoint & { _i: number }> = [];
        for (let i = 0; i < prim.dataPoints.length; i += 1) {
          const dataPoint = prim.dataPoints[i];
          if (!dataPoint) continue;
          const s = dataToScreen(dataPoint);
          if (s) indexed.push({ x: s.x, y: s.y, _i: i });
        }
        if (indexed.length > 3) {
          const kept = decimateScreenPoints(indexed, 1.5); // ~1.5px tolerance
          const decimated: DrawingDataPoint[] = [];
          for (const sp of kept) {
            const dataPoint = prim.dataPoints[sp._i];
            if (dataPoint) decimated.push(dataPoint);
          }
          prim.setDataPoints(decimated);
        }
        committed = prim.commitDataPoints?.() === true;
      } else if (prim) {
        committed = prim.commitDataPoints?.() === true;
      }
      if (committed && prim) {
        commands = drawingCommandsForLegacyPrimitive(prim, { type: "create" });
        if (!commands) {
          cancelActiveFreehandStroke();
          committed = false;
        }
      }
      if (committed && prim) {
        // Keep the active descriptor until the document command is accepted.
        // A rejected/throwing persistence boundary can then perform checked
        // surface compensation or retain the descriptor for the next barrier.
        completedFreehand = true;
        completedFreehandDraft = draft;
      } else {
        cancelActiveFreehandStroke();
      }
    }
    // End dragging
    if (!completedFreehand && draggingRef.current) {
      const committedDrag = draggingRef.current;
      commands = drawingCommandsForDrag(primitivesRef.current, committedDrag);
      completedDrag = true;
    }
    let persisted = !commands && !completedDrag;
    if (commands) {
      try {
        persisted = persistDrawings(commands) !== false;
      } catch {
        persisted = false;
      }
    }
    if (completedFreehand) {
      if (persisted) {
        if (completedFreehandDraft) cancelFreehandStrokeDraft(completedFreehandDraft);
        freehandDraftRef.current = null;
        freehandCaptureIdentityRef.current = null;
        isDrawingFreehandRef.current = false;
        currentFreehandRef.current = null;
        lastFreehandScreenPointRef.current = null;
      } else {
        cancelActiveFreehandStroke();
      }
    }
    if (persisted && completedDrag) draggingRef.current = null;
    clearCachedPointerRect();
    const durationMs = Math.max(0, drawingPerfNow() - mouseupStartedAt);
    drawingPerfCounters.recordMouseupSyncDuration(durationMs);
    drawingPerfCounters.gestureEnded();
  }, [cancelActiveFreehandStroke, flushActiveDrawingMove, persistDrawings, prepareUserMutationScope, dataToScreen, clearCachedPointerRect]);

  const handlePointerCancel = useCallback(() => {
    if (!isDrawingFreehandRef.current) {
      handleMouseUp();
      return;
    }
    cancelActiveDrawingMove();
    cancelActiveFreehandStroke();
    clearCachedPointerRect();
  }, [cancelActiveDrawingMove, cancelActiveFreehandStroke, clearCachedPointerRect, handleMouseUp]);

  const handleMouseLeave = useCallback((e: DrawingDomPointerEvent) => {
    // Text overlays are siblings of the chart canvas container. Moving the
    // pointer over the floating format/edit bar fires mouseleave on the chart
    // container, but it should not terminate an in-progress text drag/resize.
    if (draggingRef.current && "relatedTarget" in e && isTextOverlayTarget(e.relatedTarget)) {
      return;
    }
    handleMouseUp();
  }, [handleMouseUp]);

  // ── RIGHT-CLICK: cancel pending two-point placement ──

  const handleContextMenu = useCallback(
    (e: MouseEvent) => {
      const tool = activeToolRef.current;
      if ((isTwoPointCreationTool(tool) || isAxisLineToolId(tool)) && anchorDataRef.current) {
        e.preventDefault();
        removePreview();
      }
    },
    [removePreview],
  );

  // ── KEYBOARD: Escape / Delete (extracted) ──

  useDrawingKeyboard({
    active: isLineTool || isFibTool || isShapeTool || isPenTool || isHighlighterTool || isEraserTool || isTextTool || isPositionTool || !!selectedPrimId || !!editingTextId,
    anchorDataRef,
    selectedIdRef,
    editingTextIdRef,
    primitivesRef,
    removePreview,
    deselectAll,
    detachPrim,
    beforeTerminalMutation: prepareTerminalTextMutation,
    persistDrawings,
    setSelectedPrimId,
    setSelectedTextUi,
    hasActiveFreehandStroke: () => isDrawingFreehandRef.current
      || currentFreehandRef.current !== null
      || freehandDraftRef.current !== null,
    cancelActiveFreehandStroke,
  });

  // ── Clean up when tool changes ──

  useEffect(() => {
    cancelActiveDrawingMove();
    if (!isLineTool && !isFibTool && !isShapeTool) {
      removePreview();
      draggingRef.current = null;
      clearHoverFeedback();
    }
    if (!isLineTool && !isFibTool && !isShapeTool && !isTextTool && !isPositionTool) {
      // Keep a currently-selected text primitive selected even after we
      // leave the text tool — so the floating format toolbar remains
      // visible right after committing a freshly-created text annotation
      // (PPT-style "click out of edit mode → still selected").
      const sel = selectedIdRef.current
        ? primitivesRef.current.find((p) => p.id === selectedIdRef.current)
        : null;
      if (!(sel instanceof TextDrawingPrimitive)) {
        deselectAll();
      }
    }
    const expectedFreehandType = isHighlighterTool
      ? "highlighter"
      : (isPenTool ? "freehand" : null);
    if (isDrawingFreehandRef.current
      && currentFreehandRef.current?.type !== expectedFreehandType) {
      cancelActiveFreehandStroke();
    }
    if (!isTextTool) {
      cancelTextEditing();
    }
    if (!isEraserTool) {
      clearHoverFeedback();
    }
  }, [isLineTool, isFibTool, isShapeTool, isPenTool, isHighlighterTool, isEraserTool, isTextTool, isPositionTool, removePreview, deselectAll, cancelTextEditing, selectedIdRef, clearHoverFeedback, cancelActiveDrawingMove, cancelActiveFreehandStroke]);

  useDrawingPointerEvents({
    chartContainerRef,
    handleDblClick,
    handleContextMenu,
    handleMouseDown,
    handleMouseLeave,
    handleMouseMove,
    handleMouseUp,
    handlePointerCancel,
  });

  // ── Public API ──

  /**
   * Release every primitive from its current series without changing the
   * saved drawing model. The chart surface calls this synchronously before it
   * disposes/recreates Lightweight Charts; the persistence lifecycle then
   * attaches the same primitives to the replacement series.
   */
  const prepareSurfaceDispose = useCallback((): boolean => runDrawingSurfaceDisposeBarrier(
    preparePersistenceSurfaceDispose,
    () => {
      cancelActiveDrawingMove();
      clearHoverFeedback();
      draggingRef.current = null;
      resetCursorForActiveTool();
    },
  ), [cancelActiveDrawingMove, clearHoverFeedback, preparePersistenceSurfaceDispose, resetCursorForActiveTool]);

  const completeSurfaceDispose = useCallback((): void => {
    // The chart owner has confirmed remove(). Surface-only drafts can now be
    // abandoned without another detach call, while the document store remains
    // the sole source used to materialize the replacement series.
    completeTextSurfaceDispose();
    if (freehandDraftRef.current) cancelFreehandStrokeDraft(freehandDraftRef.current);
    freehandDraftRef.current = null;
    freehandCaptureIdentityRef.current = null;
    currentFreehandRef.current = null;
    isDrawingFreehandRef.current = false;
    lastFreehandScreenPointRef.current = null;
    previewRef.current = null;
    anchorDataRef.current = null;
    pendingTwoPointToolRef.current = null;
    draggingRef.current = null;
    cancelActiveDrawingMove();
    clearHoverFeedback();
    completePersistenceSurfaceDispose();
  }, [cancelActiveDrawingMove, clearHoverFeedback, completePersistenceSurfaceDispose, completeTextSurfaceDispose]);

  /** Clear all drawings (lines + freehand + text) */
  const clearAll = useCallback(() => {
    if (!prepareTerminalTextMutation()) return;
    if (!cancelTextEditing()) return;
    if (!cancelActiveFreehandStroke()) return;
    if (!removePreview()) return;
    cancelActiveDrawingMove();
    if (!clearDrawings()) return;
    primitivesRef.current = [];
    clearHoverFeedback();
    selectedIdRef.current = null;
    setSelectedPrimId(null);
    setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
    draggingRef.current = null;
  }, [clearDrawings, removePreview, cancelTextEditing, selectedIdRef, setSelectedPrimId, setSelectedTextUi, clearHoverFeedback, cancelActiveDrawingMove, cancelActiveFreehandStroke, prepareTerminalTextMutation]);

  /**
   * Toggle visibility of all drawings without deleting them.
   * Primitives stay attached; their renderers and hit-tests skip hidden items.
   * This avoids doing one attach/detach cycle per drawing on every toggle.
   */
  const setHidden = useCallback((next: boolean) => {
    const value = !!next;
    const scopeReady = prepareUserMutationScope();
    const changed = hiddenRef.current !== value;
    // Keep the requested visibility as an intent even while A -> B is blocked.
    // The eventual B reconciliation reads hiddenRef. Showing is deferred so an
    // old A credential can never be made visible on B's rendered surface;
    // hiding is safe and remains available as a fail-closed visual operation.
    hiddenRef.current = value;
    if (!canApplyDrawingVisibilityToCurrentPrimitives(scopeReady, value)) return;
    if (!changed && scopeReady) return;

    if (value && scopeReady) {
      // Also drop preview / transient edit state so nothing stays on screen.
      removePreview();
      cancelTextEditing();
      clearHoverFeedback();
      cancelActiveDrawingMove();
      cancelActiveFreehandStroke();
      draggingRef.current = null;
    }

    let updateRequested = false;
    for (const prim of primitivesRef.current) {
      if (typeof prim.setHidden === "function") {
        prim.setHidden(value, false);
      } else {
        Reflect.set(prim, "_hidden", value);
      }
      if (!updateRequested && typeof prim.requestUpdate === "function" && prim._series) {
        prim.requestUpdate();
        updateRequested = true;
      }
    }

    if (!updateRequested) {
      // Force a lightweight redraw when there are no attached primitives that
      // can request one themselves.
      getChartAdapter()?.requestSeriesUpdate?.();
    }
  }, [getChartAdapter, removePreview, cancelTextEditing, clearHoverFeedback, cancelActiveDrawingMove, cancelActiveFreehandStroke, prepareUserMutationScope]);

  // ── Selected-text helpers (consumed by floating format toolbar) ──

  /**
   * Apply a partial style/text patch to the currently selected text primitive.
   * Triggers persistence + a React re-render of the format bar snapshot.
   */
  const updateSelectedText = useCallback((patch: TextDrawingPatch) => {
    const id = selectedIdRef.current;
    if (!id) return;
    const prim = getPrimitiveById(id);
    if (!prim || !(prim instanceof TextDrawingPrimitive)) return;
    const saved = serializeDrawingPrimitive(
      prim as unknown as PersistableDrawingPrimitive,
    );
    if (!saved || saved.type !== "text") return;
    const commands = drawingCommandsForSavedDrawing(
      { ...saved, ...patch },
      { type: "update-style" },
    );
    if (!commands || !prepareTerminalTextMutation()) return;
    const previous: TextDrawingPatch = {
      text: prim.text,
      color: prim.color,
      fontSize: prim.fontSize,
      fontFamily: prim.fontFamily,
      bold: prim.bold,
      italic: prim.italic,
      underline: prim.underline,
      align: prim.align,
      bgColor: prim.bgColor,
      borderColor: prim.borderColor,
      borderWidth: prim.borderWidth,
      widthPx: prim.widthPx,
      padding: prim.padding,
    };
    const changed = prim.applyPatch(patch);
    if (changed) {
      let persisted = false;
      try {
        persisted = persistDrawings(commands) !== false;
      } catch {
        persisted = false;
      }
      if (!persisted) {
        prim.applyPatch(previous);
        return;
      }
      refreshSelectedTextUi(id);
    }
  }, [getPrimitiveById, prepareTerminalTextMutation, refreshSelectedTextUi, persistDrawings, selectedIdRef]);

  /** Delete the currently selected primitive (any type). */
  const deleteSelected = useCallback(() => {
    const id = selectedIdRef.current;
    if (!id) return;
    const idx = primitivesRef.current.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const primitive = primitivesRef.current[idx];
    if (!primitive) return;
    if (!prepareTerminalTextMutation()) return;
    if (!detachAndRemoveDrawingPrimitive(primitivesRef.current, primitive, detachPrim)) return;
    let persisted = false;
    try {
      persisted = persistDrawings([Object.freeze({ type: "delete", id })]) !== false;
    } catch {
      persisted = false;
    }
    if (!persisted) {
      if (!primitivesRef.current.some((candidate) => candidate.id === id)
        && attachPrim(primitive)) {
        primitivesRef.current.splice(Math.min(idx, primitivesRef.current.length), 0, primitive);
      }
      return;
    }
    selectedIdRef.current = null;
    setSelectedPrimId(null);
    setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
  }, [attachPrim, detachPrim, prepareTerminalTextMutation, persistDrawings, selectedIdRef, setSelectedPrimId, setSelectedTextUi]);

  /**
   * Update the color and/or lineWidth of the currently selected
   * line / freehand / fibonacci drawing. Persists the change and refreshes
   * the toolbar's meta snapshot.
   */
  const updateSelectedDrawingStyle = useCallback((patch: DrawingStylePatch) => {
    const id = selectedIdRef.current;
    if (!id || !patch) return;
    const prim = primitivesRef.current.find((p) => p.id === id);
    if (!prim) return;
    const saved = serializeDrawingPrimitive(
      prim as unknown as PersistableDrawingPrimitive,
    );
    if (!saved) return;
    const candidate = { ...saved } as SavedDrawing & {
      color?: string;
      lineWidth?: number;
      opacity?: number;
    };
    const mutations: Array<Readonly<{ apply(): void; rollback(): void }>> = [];
    if (typeof patch.color === "string" && hasMutableColor(prim) && patch.color !== prim.color) {
      const previous = prim.color;
      candidate.color = patch.color;
      mutations.push({
        apply: () => prim.setColor(patch.color as string),
        rollback: () => prim.setColor(previous),
      });
    }
    if (typeof patch.lineWidth === "number" && hasMutableLineWidth(prim) && patch.lineWidth !== prim.lineWidth) {
      const previous = prim.lineWidth;
      candidate.lineWidth = patch.lineWidth;
      mutations.push({
        apply: () => prim.setLineWidth(patch.lineWidth as number),
        rollback: () => prim.setLineWidth(previous),
      });
    }
    if (typeof patch.opacity === "number" && hasMutableOpacity(prim) && patch.opacity !== prim.opacity) {
      const previous = prim.opacity;
      candidate.opacity = patch.opacity;
      mutations.push({
        apply: () => prim.setOpacity(patch.opacity as number),
        rollback: () => prim.setOpacity(previous),
      });
    }
    if (mutations.length > 0) {
      const commands = drawingCommandsForSavedDrawing(candidate, { type: "update-style" });
      if (!commands || !prepareTerminalTextMutation()) return;
      for (const mutation of mutations) mutation.apply();
      let persisted = false;
      try {
        persisted = persistDrawings(commands) !== false;
      } catch {
        persisted = false;
      }
      if (!persisted) {
        for (let index = mutations.length - 1; index >= 0; index -= 1) {
          mutations[index]?.rollback();
        }
        return;
      }
      const current = primitivesRef.current.find((candidate) => candidate.id === id) ?? null;
      setSelectedDrawingMeta(current ? selectedDrawingMetaFromPrimitive(current) : null);
    }
  }, [prepareTerminalTextMutation, persistDrawings, selectedIdRef, setSelectedDrawingMeta]);

  const selectedTextSnapshot = selectedTextUi.snapshot;
  const selectedTextBox = selectedTextUi.box;

  return {
    clearAll,
    completeSurfaceDispose,
    invalidateSurfaceCredentialsForSeriesReplacement,
    prepareSurfaceDispose,
    setHidden,
    primitivesRef,
    selectedPrimId,
    selectedDrawingMeta,
    // Text editing state (for rendering the inline editor in the component)
    editingTextId,
    editingTextValue,
    editingTextPos,
    setEditingTextValue,
    commitTextEditing,
    cancelTextEditing,
    editInputRef,
    // Selected-text bag (for the floating format toolbar)
    selectedTextSnapshot,
    selectedTextBox,
    updateSelectedText,
    updateSelectedDrawingStyle,
    deleteSelected,
  };
}

export default useDrawing;
