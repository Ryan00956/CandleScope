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
import { createPrimitiveFromSavedDrawing } from "./drawingPrimitiveFactory.js";
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
import type { DrawingDetachedCommitReceipt } from "./useDrawingPersistenceLifecycle.js";
import type { DrawingDisplayHitResult } from "./rendering/drawingDisplayList.js";
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
  recordDrawingPerfInteractionHandoffAcknowledged,
  recordDrawingPerfInteractionHandoffPrepared,
} from "./performance/drawingPerfCounters.js";
import { createDynamicOverlayController } from "./interaction/dynamicOverlayController.js";
import type {
  DynamicOverlayController,
  DynamicOverlayDecoration,
} from "./interaction/dynamicOverlayController.js";
import { createLiveInkController } from "./interaction/liveInkController.js";
import type { LiveInkController } from "./interaction/liveInkController.js";
import type { DrawingInteractionSurfaceMode } from "./interactionSurfaceMode.js";

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

interface DynamicHoverDecoration {
  readonly id: string | null;
  readonly point: ScreenPoint;
  readonly eraser: boolean;
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
  // Overlay-owned live drafts are intentionally never attached to LWC.
  if (primitive._series === null) return true;
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

function dataPointFromSavedHorizontalAnchor(
  anchor: unknown,
  price: unknown,
): DrawingDataPoint | null {
  if (typeof price !== "number" || !Number.isFinite(price)) return null;
  if (typeof anchor === "number" && Number.isFinite(anchor)) return { time: anchor, price };
  if (!anchor || typeof anchor !== "object") return null;
  return { ...(anchor as Record<string, unknown>), price } as DrawingDataPoint;
}

/** Project one detached interaction draft into cheap dynamic-canvas commands. */
export function dynamicDecorationsForDrawingDraft(
  primitive: DrawingPrimitive,
  dataToScreen: DrawingDataToScreen,
): readonly DynamicOverlayDecoration[] {
  const saved = serializeDrawingPrimitive(
    primitive as unknown as PersistableDrawingPrimitive,
  );
  if (!saved) return [];
  const color = "color" in saved && typeof saved.color === "string"
    ? saved.color
    : "#3b82f6";
  const lineWidth = "lineWidth" in saved && typeof saved.lineWidth === "number"
    ? saved.lineWidth
    : 2;
  if ("dataPoints" in saved && Array.isArray(saved.dataPoints)) {
    const projected = saved.dataPoints
      .map((point) => dataToScreen(point))
      .filter((point): point is ScreenPoint => point !== null);
    if (projected.length < 2) return [];
    const first = projected[0];
    const last = projected.at(-1);
    if (!first || !last) return [];
    if (saved.type === "shape") {
      return [Object.freeze({
        type: "shape",
        box: Object.freeze({
          x: Math.min(first.x, last.x),
          y: Math.min(first.y, last.y),
          width: Math.abs(last.x - first.x),
          height: Math.abs(last.y - first.y),
        }),
        shapeType: saved.shapeType ?? "rectangle",
        color,
        lineWidth,
        ...(saved.fillColor !== undefined ? { fillColor: saved.fillColor } : {}),
        ...(saved.fillOpacity !== undefined ? { fillOpacity: saved.fillOpacity } : {}),
        dashed: saved.lineStyle !== undefined && saved.lineStyle !== "solid",
        handles: Object.freeze([first, last]),
      })];
    }
    if (saved.type === "fibonacci") {
      const minX = Math.min(first.x, last.x);
      const maxX = Math.max(first.x, last.x);
      const startY = saved.inverted ? last.y : first.y;
      const endY = saved.inverted ? first.y : last.y;
      const levels = (saved.levels ?? []).filter((level) => level.enabled);
      return Object.freeze([
        Object.freeze({
          type: "line" as const,
          from: first,
          to: last,
          color,
          lineWidth,
          dashed: true,
          handles: Object.freeze([first, last]),
        }),
        ...levels.map((level) => {
          const y = startY + (endY - startY) * level.level;
          return Object.freeze({
            type: "line" as const,
            from: Object.freeze({ x: minX, y }),
            to: Object.freeze({ x: maxX, y }),
            color: level.color,
            lineWidth,
          });
        }),
      ]);
    }
    return [Object.freeze({
      type: "line",
      from: first,
      to: last,
      color,
      lineWidth,
      ...(saved.type === "line" ? { extension: saved.lineType ?? "line-segment" } : {}),
      handles: Object.freeze([first, last]),
    })];
  }
  if (saved.type === "axis-line" && saved.dataPoint) {
    const point = dataToScreen(saved.dataPoint);
    return point ? [Object.freeze({
      type: "axis-line",
      point,
      axisLineType: saved.axisLineType ?? "horizontal",
      color,
      lineWidth,
      handles: Object.freeze([point]),
    })] : [];
  }
  if (saved.type === "text" && saved.dataPoint) {
    const point = dataToScreen(saved.dataPoint);
    if (!point) return [];
    return [Object.freeze({
      type: "box",
      box: Object.freeze({
        x: point.x,
        y: point.y - (saved.fontSize ?? 14),
        width: saved.widthPx ?? 96,
        height: (saved.fontSize ?? 14) + (saved.padding ?? 6) * 2,
      }),
      color,
      dashed: false,
    })];
  }
  if (saved.type === "position" && saved.timeRange) {
    const start = dataPointFromSavedHorizontalAnchor(saved.timeRange.start, saved.entryPrice);
    const end = dataPointFromSavedHorizontalAnchor(saved.timeRange.end, saved.entryPrice);
    const startScreen = start ? dataToScreen(start) : null;
    const endScreen = end ? dataToScreen(end) : null;
    if (!startScreen || !endScreen) return [];
    const decorations: DynamicOverlayDecoration[] = [Object.freeze({
      type: "line",
      from: startScreen,
      to: endScreen,
      color,
      lineWidth,
      handles: Object.freeze([startScreen, endScreen]),
    })];
    for (const [price, levelColor] of [
      [saved.tpPrice, "#22c55e"],
      [saved.slPrice, "#ef4444"],
    ] as const) {
      if (typeof price !== "number" || !Number.isFinite(price)) continue;
      const levelStart = dataPointFromSavedHorizontalAnchor(saved.timeRange.start, price);
      const levelEnd = dataPointFromSavedHorizontalAnchor(saved.timeRange.end, price);
      const from = levelStart ? dataToScreen(levelStart) : null;
      const to = levelEnd ? dataToScreen(levelEnd) : null;
      if (!from || !to) continue;
      decorations.push(Object.freeze({
        type: "line",
        from,
        to,
        color: levelColor,
        lineWidth,
        handles: Object.freeze([from, to]),
      }));
    }
    return Object.freeze(decorations);
  }
  return [];
}

const DYNAMIC_BOX_HANDLE_NAMES = ["tl", "t", "tr", "r", "br", "b", "bl", "l"] as const;

export interface DynamicSelectionHandleSpec {
  readonly point: ScreenPoint;
  readonly hit: DrawingHit;
  readonly radius: number;
}

function dynamicBoxSelectionHandles(box: ScreenBox): readonly DynamicSelectionHandleSpec[] {
  const left = box.x;
  const top = box.y;
  const right = left + box.width;
  const bottom = top + box.height;
  const middleX = left + box.width / 2;
  const middleY = top + box.height / 2;
  const points = [
    { x: left, y: top },
    { x: middleX, y: top },
    { x: right, y: top },
    { x: right, y: middleY },
    { x: right, y: bottom },
    { x: middleX, y: bottom },
    { x: left, y: bottom },
    { x: left, y: middleY },
  ] as const;
  return Object.freeze(points.map((point, index) => {
    const handle = DYNAMIC_BOX_HANDLE_NAMES[index];
    if (!handle) throw new RangeError("Dynamic selection handle index is invalid");
    return Object.freeze({
      point: Object.freeze(point),
      hit: Object.freeze({ handle, zone: handle, pointIndex: -1 }),
      radius: 9,
    });
  }));
}

/** Exact selected-handle affordances owned by the Phase 5 overlay. */
export function dynamicSelectionHandlesForSavedDrawing(
  saved: SavedDrawing,
  dataToScreen: DrawingDataToScreen,
  screenBox: ScreenBox | null = null,
): readonly DynamicSelectionHandleSpec[] {
  if ((saved.type === "text" || saved.type === "shape") && screenBox) {
    return dynamicBoxSelectionHandles(screenBox);
  }
  if (saved.type === "freehand" || saved.type === "highlighter" || saved.type === "text") {
    return [];
  }
  if (saved.type === "position" && saved.timeRange) {
    const entryStart = dataPointFromSavedHorizontalAnchor(saved.timeRange.start, saved.entryPrice);
    const entryEnd = dataPointFromSavedHorizontalAnchor(saved.timeRange.end, saved.entryPrice);
    const start = entryStart ? dataToScreen(entryStart) : null;
    const end = entryEnd ? dataToScreen(entryEnd) : null;
    if (!start || !end) return [];
    const left = Math.min(start.x, end.x);
    const right = Math.max(start.x, end.x);
    const middleX = (left + right) / 2;
    const levels: Array<Readonly<{ zone: "entry" | "tp" | "sl"; price: number }>> = [
      Object.freeze({ zone: "entry", price: saved.entryPrice ?? Number.NaN }),
    ];
    if (typeof saved.tpPrice === "number" && Number.isFinite(saved.tpPrice)) {
      levels.push(Object.freeze({ zone: "tp", price: saved.tpPrice }));
    }
    if (typeof saved.slPrice === "number" && Number.isFinite(saved.slPrice)) {
      levels.push(Object.freeze({ zone: "sl", price: saved.slPrice }));
    }
    const levelHandles = levels.flatMap((level): readonly DynamicSelectionHandleSpec[] => {
      const anchor = dataPointFromSavedHorizontalAnchor(saved.timeRange?.start, level.price);
      const projected = anchor ? dataToScreen(anchor) : null;
      return projected ? [Object.freeze({
        point: Object.freeze({ x: middleX, y: projected.y }),
        hit: Object.freeze({ zone: level.zone, pointIndex: -1 }),
        radius: 9,
      })] : [];
    });
    if (levelHandles.length === 0) return [];
    const ys = levelHandles.map((handle) => handle.point.y);
    const middleY = (Math.min(...ys) + Math.max(...ys)) / 2;
    return Object.freeze([
      ...levelHandles,
      Object.freeze({
        point: Object.freeze({ x: left, y: middleY }),
        hit: Object.freeze({ zone: "left", pointIndex: -1 }),
        radius: 10,
      }),
      Object.freeze({
        point: Object.freeze({ x: right, y: middleY }),
        hit: Object.freeze({ zone: "right", pointIndex: -1 }),
        radius: 10,
      }),
    ]);
  }
  if (saved.type === "axis-line" && saved.dataPoint) {
    const point = dataToScreen(saved.dataPoint);
    return point ? [Object.freeze({
      point: Object.freeze(point),
      hit: Object.freeze({ zone: "center", pointIndex: 0 }),
      radius: 10,
    })] : [];
  }
  if ("dataPoints" in saved && Array.isArray(saved.dataPoints)) {
    const projected = saved.dataPoints
      .map((point) => dataToScreen(point))
      .filter((point): point is ScreenPoint => point !== null);
    if (projected.length < 2) return [];
    if (saved.type === "shape") {
      const first = projected[0];
      const last = projected.at(-1);
      if (!first || !last) return [];
      return dynamicBoxSelectionHandles({
        x: Math.min(first.x, last.x),
        y: Math.min(first.y, last.y),
        width: Math.abs(last.x - first.x),
        height: Math.abs(last.y - first.y),
      });
    }
    return Object.freeze(projected.map((point, pointIndex) => Object.freeze({
      point: Object.freeze(point),
      hit: Object.freeze({ pointIndex }),
      radius: 10,
    })));
  }
  return [];
}

/** Merge the two transitional Phase 4 owners using canonical document order. */
export function resolveTopmostDrawingInteractionHit(
  primitives: readonly DrawingPrimitive[],
  legacyHit: DrawingPrimitiveHit | null,
  sceneHit: DrawingDisplayHitResult | null,
): DrawingPrimitiveHit | null {
  if (!sceneHit) return legacyHit;
  if (sceneHit.kind !== "line" && sceneHit.kind !== "axis-line" && sceneHit.kind !== "shape") {
    return legacyHit;
  }
  const sceneIndex = primitives.findIndex((primitive) => primitive.id === sceneHit.entityId);
  if (sceneIndex < 0) return legacyHit;
  const primitive = primitives[sceneIndex];
  if (!primitive) return legacyHit;
  const type = sceneHit.kind === "line"
    ? "line"
    : sceneHit.kind === "axis-line" ? "axis-line" : "shape";
  const sceneCandidate = { prim: primitive, type, ...sceneHit } as DrawingPrimitiveHit;
  if (!legacyHit) return sceneCandidate;
  const legacyIndex = primitives.lastIndexOf(legacyHit.prim);
  return sceneIndex > legacyIndex ? sceneCandidate : legacyHit;
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
  interactionSurfaceMode?: DrawingInteractionSurfaceMode;
  dynamicCanvasRef?: MutableRefObject<HTMLCanvasElement | null>;
  liveInkCanvasRef?: MutableRefObject<HTMLCanvasElement | null>;
  onInteractionSurfaceFallback?: (() => void) | null;
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
  interactionSurfaceMode = "legacy",
  dynamicCanvasRef,
  liveInkCanvasRef,
  onInteractionSurfaceFallback,
  // Optional callback so the hook can flip the active tool back to null after
  // committing a text edit (PPT-style: clicking elsewhere exits text mode).
  onToolChange,
}: UseDrawingOptions): DrawingInteractionRuntime {
  const onToolChangeRef = useRef(onToolChange);
  const getChartAdapter = useCallback(() => chartAdapter || null, [chartAdapter]);
  const notifyDrawingSceneInvalidation = useCallback(() => {
    getChartAdapter()?.notifyDrawingFrameInvalidation?.();
  }, [getChartAdapter]);
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
  } = useDrawingSelection({
    primitivesRef,
    ...(interactionSurfaceMode === "overlay"
      ? { mutatePrimitiveVisualState: false }
      : { onSelectionChange: notifyDrawingSceneInvalidation }),
  });

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
  const dynamicOverlayControllerRef = useRef<DynamicOverlayController | null>(null);
  const liveInkControllerRef = useRef<LiveInkController | null>(null);
  const renderDynamicFeedbackRef = useRef<() => void>(() => {});
  const dynamicHoverDecorationRef = useRef<DynamicHoverDecoration | null>(null);
  const overlayTimeCaptureIdentityRef = useRef<object>({});
  const activeOverlayEntityIdRef = useRef<string | null>(null);
  const overlayDragPrimitiveRef = useRef<DrawingPrimitive | null>(null);
  const overlayDragOriginalRef = useRef<DrawingPrimitive | null>(null);
  const overlayDragRegistryRef = useRef<DrawingPrimitive[]>([]);
  const pendingOverlayCommitReceiptRef = useRef<DrawingDetachedCommitReceipt | null>(null);
  const deleteSelectedRef = useRef<() => void>(() => {});
  const dynamicPaintUnsubscribeRef = useRef<(() => void) | null>(null);
  const dynamicHandoffFrameRef = useRef<unknown>(null);
  const dynamicHandoffGenerationRef = useRef(0);
  const dynamicHandoffLockRef = useRef(false);

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

  const captureOverlayFreehandBatch = useCallback((positions: readonly ScreenPoint[]) => {
    const adapter = getChartAdapter();
    if (!adapter || positions.length === 0) return null;
    if (adapter.usesOrdinalTime?.() === true) {
      return adapter.captureFreehandStrokeBatch?.([...positions]) ?? null;
    }
    const captures: Array<Readonly<{
      time: number;
      price: number;
      screen: ScreenPoint;
    }>> = [];
    for (const point of positions) {
      const dataPoint = screenToFreehandData(point.x, point.y);
      if (!dataPoint || typeof dataPoint.time !== "number" || !Number.isFinite(dataPoint.time)) {
        return null;
      }
      captures.push(Object.freeze({
        time: dataPoint.time,
        price: dataPoint.price,
        screen: Object.freeze({ x: point.x, y: point.y }),
      }));
    }
    return Object.freeze({
      captureIdentity: overlayTimeCaptureIdentityRef.current,
      sourceProjection: "time",
      sourceProjectionConfig: "{}",
      captures: Object.freeze(captures),
    });
  }, [getChartAdapter, screenToFreehandData]);

  const isInsideMainPanePlot = useCallback((point: ScreenPoint): boolean => {
    if (interactionSurfaceMode !== "overlay") return true;
    const rect = getChartAdapter()?.getMainPanePlotRect?.();
    return !!rect
      && point.x >= rect.x
      && point.x <= rect.x + rect.width
      && point.y >= rect.y
      && point.y <= rect.y + rect.height;
  }, [getChartAdapter, interactionSurfaceMode]);

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
      attachPrimitive: (primitive: DrawingPrimitive) => {
        if (!attachDrawingPrimitive(adapter, primitive)) return false;
        if (interactionSurfaceMode === "overlay") {
          try { primitive.requestUpdate?.(); } catch { /* attachment remains authoritative */ }
          try { adapter.requestSeriesUpdate?.(); } catch { /* attachment remains authoritative */ }
        }
        return true;
      },
      detachPrimitive: (primitive: DrawingPrimitive) => detachDrawingPrimitive(adapter, primitive),
    };
  }, [getChartAdapter, interactionSurfaceMode]);

  const {
    clearDrawings,
    completeSurfaceDispose: completePersistenceSurfaceDispose,
    invalidateSurfaceCredentialsForSeriesReplacement,
    invalidateVisibleScene,
    persistActiveScopeDrawings,
    persistDetachedDrawings,
    persistDrawings,
    prepareSurfaceDispose: preparePersistenceSurfaceDispose,
    prepareUserMutationScope,
    hitTestScene,
    getSceneScreenBox,
    getSceneScreenHandles,
    subscribeVisibleScenePaint,
  } = useDrawingPersistenceLifecycle({
    beforeScopeTransitionRef,
    currentFreehandRef,
    draggingRef,
    getChartAdapter: getDrawingPersistenceAdapter,
    getDrawingSceneAdapter: getChartAdapter,
    hiddenRef,
    activeOverlayEntityIdRef,
    dynamicOverlayEnabled: interactionSurfaceMode === "overlay",
    isDrawingFreehandRef,
    prevSymbolRef,
    primitivesRef,
    selectedIdRef,
    seriesReady,
    setSelectedPrimId,
    setSelectedTextUi,
    symbol,
    symbolRef,
    ...(onInteractionSurfaceFallback === undefined
      ? {}
      : { onInteractionSurfaceFallback }),
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
    liveInkControllerRef.current?.cancel();
    return true;
  }, [detachPrim]);

  // ── Selection helpers are provided by useDrawingSelection above ──

  const hitTestSelectedOverlayHandle = useCallback((
    x: number,
    y: number,
    expectedPrimitive: DrawingPrimitive | null = null,
  ): DrawingPrimitiveHit | null => {
    if (interactionSurfaceMode !== "overlay" || hiddenRef.current) return null;
    const selectedId = selectedIdRef.current;
    if (!selectedId) return null;
    const primitive = expectedPrimitive
      ?? primitivesRef.current.find((candidate) => candidate.id === selectedId)
      ?? null;
    if (!primitive || primitive.id !== selectedId) return null;
    const saved = serializeDrawingPrimitive(
      primitive as unknown as PersistableDrawingPrimitive,
    );
    if (!saved) return null;
    let box: ScreenBox | null = null;
    if ("getBoundingBoxScreen" in primitive
      && typeof primitive.getBoundingBoxScreen === "function") {
      try {
        box = primitive.getBoundingBoxScreen() as ScreenBox | null;
      } catch {
        box = null;
      }
    }
    const handles = dynamicSelectionHandlesForSavedDrawing(saved, dataToScreen, box);
    const matched = handles.find((handle) => (
      Math.hypot(handle.point.x - x, handle.point.y - y) <= handle.radius
    ));
    if (!matched) return null;
    const type = saved.type === "angle-measure" ? "angle" : saved.type;
    return {
      prim: primitive,
      type,
      ...matched.hit,
    } as DrawingPrimitiveHit;
  }, [dataToScreen, interactionSurfaceMode, selectedIdRef]);

  // ── Hit-test all primitives ──

  const hitTestAll = useCallback(
    (x: number, y: number, hitRadius = 8): DrawingPrimitiveHit | null => {
      const selectedHandleHit = hitTestSelectedOverlayHandle(x, y);
      if (selectedHandleHit) return selectedHandleHit;
      const legacyHit = hitTestDrawingPrimitives(
        primitivesRef.current,
        x,
        y,
        hitRadius,
        (primitive) => primitive._series !== null,
      );
      const sceneHit = hitTestScene(x, y);
      return resolveTopmostDrawingInteractionHit(primitivesRef.current, legacyHit, sceneHit);
    },
    [hitTestScene, hitTestSelectedOverlayHandle],
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
      if (!(interactionSurfaceMode === "overlay" && previewRef.current._series === null)
        && !detachPrim(previewRef.current)) return false;
      previewRef.current = null;
      dynamicOverlayControllerRef.current?.clear();
    }
    anchorDataRef.current = null;
    pendingTwoPointToolRef.current = null;
    return true;
  }, [detachPrim, interactionSurfaceMode]);

  const cancelDynamicPaintHandoff = useCallback((clearDynamic = false): boolean => {
    const hadHandoff = dynamicHandoffLockRef.current
      || dynamicPaintUnsubscribeRef.current !== null
      || dynamicHandoffFrameRef.current !== null;
    dynamicHandoffLockRef.current = false;
    dynamicHandoffGenerationRef.current += 1;
    dynamicPaintUnsubscribeRef.current?.();
    dynamicPaintUnsubscribeRef.current = null;
    const handle = dynamicHandoffFrameRef.current;
    if (handle !== null) {
      if (typeof cancelAnimationFrame === "function" && typeof handle === "number") {
        cancelAnimationFrame(handle);
      } else {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      }
    }
    dynamicHandoffFrameRef.current = null;
    // Do not erase a legitimate two-point preview/selection frame when a new
    // pointerdown merely checks for an older committed-frame handoff.
    if (clearDynamic && hadHandoff) dynamicOverlayControllerRef.current?.clear();
    return hadHandoff;
  }, []);

  const prepareTerminalTextMutation = useCallback(() => {
    if (interactionSurfaceMode === "overlay") cancelDynamicPaintHandoff(true);
    if (liveInkControllerRef.current?.snapshot().retainingFinalFrame) {
      liveInkControllerRef.current.cancel();
    }
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
  }, [cancelActiveFreehandStroke, cancelDynamicPaintHandoff, interactionSurfaceMode, prepareUserMutationScope, removePreview]);

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

  useEffect(() => {
    if (interactionSurfaceMode !== "overlay") return undefined;
    const dynamicCanvas = dynamicCanvasRef?.current ?? null;
    const liveInkCanvas = liveInkCanvasRef?.current ?? null;
    const getPlotRect = () => getChartAdapter()?.getMainPanePlotRect?.() ?? null;
    const dynamicController = dynamicCanvas
      ? createDynamicOverlayController({ canvas: dynamicCanvas, getPlotRect })
      : null;
    const liveInkController = liveInkCanvas
      ? createLiveInkController({ canvas: liveInkCanvas, getPlotRect })
      : null;
    dynamicOverlayControllerRef.current = dynamicController;
    liveInkControllerRef.current = liveInkController;

    const refresh = () => {
      dynamicController?.refreshLayout();
      liveInkController?.refreshLayout();
    };
    const adapter = getChartAdapter();
    const handleFrameInvalidation = (reason?: "manual" | "viewport") => {
      // Exact paint tickets are viewport-bound. Retire an in-flight retained
      // frame before refreshing geometry when pan/zoom/resize advances that
      // revision, otherwise the rejected old ack could hold pixels forever.
      if (reason === "viewport") {
        cancelDynamicPaintHandoff(true);
        if (liveInkController?.snapshot().retainingFinalFrame) liveInkController.cancel();
      }
      refresh();
      renderDynamicFeedbackRef.current();
    };
    const unsubscribeFrameInvalidation = adapter?.subscribeDrawingFrameInvalidation?.(
      handleFrameInvalidation,
    );
    let settleFrame: number | null = null;
    let settleFramesRemaining = 8;
    refresh();
    if (typeof requestAnimationFrame === "function") {
      // LWC can settle the price-scale width over several startup paints. Keep
      // this mount-only loop bounded while re-reading the public pane geometry,
      // so both canvases converge without adding any pointermove chart work.
      const settle = () => {
        settleFrame = null;
        refresh();
        settleFramesRemaining -= 1;
        if (settleFramesRemaining > 0) settleFrame = requestAnimationFrame(settle);
      };
      settleFrame = requestAnimationFrame(settle);
    }
    const handleWindowResize = () => handleFrameInvalidation("viewport");
    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
      unsubscribeFrameInvalidation?.();
      if (settleFrame !== null) cancelAnimationFrame(settleFrame);
      dynamicController?.dispose();
      liveInkController?.dispose();
      if (dynamicOverlayControllerRef.current === dynamicController) {
        dynamicOverlayControllerRef.current = null;
      }
      if (liveInkControllerRef.current === liveInkController) {
        liveInkControllerRef.current = null;
      }
    };
  }, [
    cancelDynamicPaintHandoff,
    drawingCoordinateKey,
    dynamicCanvasRef,
    getChartAdapter,
    interactionSurfaceMode,
    liveInkCanvasRef,
    seriesReady,
  ]);

  const getDynamicScreenBox = useCallback((id: string | null): ScreenBox | null => {
    if (!id) return null;
    const sceneBox = getSceneScreenBox(id);
    if (sceneBox) return sceneBox;
    const primitive = getPrimitiveById(id) as DrawingPrimitive & {
      getBoundingBoxScreen?: () => ScreenBox | null;
    };
    try {
      const direct = primitive?.getBoundingBoxScreen?.() ?? null;
      if (direct) return direct;
    } catch {
      // Fall through to the serialized handle extent.
    }
    if (!primitive) return null;
    const saved = serializeDrawingPrimitive(
      primitive as unknown as PersistableDrawingPrimitive,
    );
    if (!saved) return null;
    const handles = dynamicSelectionHandlesForSavedDrawing(saved, dataToScreen);
    if (handles.length === 0) return null;
    const xs = handles.map((handle) => handle.point.x);
    const ys = handles.map((handle) => handle.point.y);
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }, [dataToScreen, getPrimitiveById, getSceneScreenBox]);

  const renderDynamicFeedback = useCallback((
    hover: DynamicHoverDecoration | null = dynamicHoverDecorationRef.current,
  ) => {
    if (interactionSurfaceMode !== "overlay") return;
    if (hiddenRef.current) {
      dynamicOverlayControllerRef.current?.clear();
      return;
    }
    // A committed handoff owns the exact last interaction pixels until the
    // matching scene paint (plus one rAF). Selection/hover React effects must
    // not replace that frame with a sparse box and create a visible gap.
    if (dynamicHandoffLockRef.current) return;
    // Transient geometry has strict visual ownership priority. Scene-paint and
    // selection effects can run between pointer frames; they must repaint the
    // complete detached draft/preview instead of replacing it with a sparse
    // selection box or an empty frame while the pointer is paused.
    const transient = overlayDragPrimitiveRef.current ?? previewRef.current;
    if (transient) {
      const transientDecorations = dynamicDecorationsForDrawingDraft(transient, dataToScreen);
      if (transientDecorations.length === 0) {
        dynamicOverlayControllerRef.current?.clear();
      } else {
        dynamicOverlayControllerRef.current?.render({ decorations: transientDecorations });
      }
      return;
    }
    const decorations = [];
    const selectedId = selectedIdRef.current;
    const selectionBox = getDynamicScreenBox(selectedId);
    if (selectionBox) {
      const sceneHandles = selectedId
        ? getSceneScreenHandles(selectedId)
        : null;
      const selectedPrimitive = selectedId ? getPrimitiveById(selectedId) : null;
      const saved = selectedPrimitive
        ? serializeDrawingPrimitive(
            selectedPrimitive as unknown as PersistableDrawingPrimitive,
          )
        : null;
      const fallbackHandles = saved
        ? dynamicSelectionHandlesForSavedDrawing(saved, dataToScreen, selectionBox)
          .map((handle) => handle.point)
        : [];
      const handles = sceneHandles?.length ? sceneHandles : fallbackHandles;
      decorations.push({
        type: "box" as const,
        box: selectionBox,
        color: "#3b82f6",
        ...(handles.length ? { handles } : {}),
      });
    }
    if (hover) {
      const hoverBox = getDynamicScreenBox(hover.id);
      if (hoverBox && hover.id !== selectedIdRef.current) {
        decorations.push({ type: "box" as const, box: hoverBox, color: "#ff6b6b" });
      }
      if (hover.eraser) {
        decorations.push({
          type: "cursor-ring" as const,
          center: hover.point,
          color: hover.id ? "#ff6b6b" : "rgba(148,163,184,0.8)",
          radius: 8,
        });
      }
    }
    if (decorations.length === 0) dynamicOverlayControllerRef.current?.clear();
    else dynamicOverlayControllerRef.current?.render({ decorations });
  }, [dataToScreen, getDynamicScreenBox, getPrimitiveById, getSceneScreenHandles, interactionSurfaceMode, selectedIdRef]);
  renderDynamicFeedbackRef.current = renderDynamicFeedback;

  const retainDynamicOverlayUntilPaint = useCallback((
    ticket: Readonly<{
      scopeKey: string;
      documentRevision: number;
      surfaceGeneration: number;
      viewportRevision: number;
    }> | null,
    { replayLastPaint = true }: Readonly<{ replayLastPaint?: boolean }> = {},
  ) => {
    if (interactionSurfaceMode !== "overlay") return;
    cancelDynamicPaintHandoff();
    if (!ticket) {
      // Without exact surface + viewport credentials there is no paint event
      // that can safely retire this frame. Drop back to current selection/
      // hover feedback instead of retaining stale committed pixels forever.
      renderDynamicFeedback();
      return;
    }
    dynamicHandoffLockRef.current = true;
    recordDrawingPerfInteractionHandoffPrepared("dynamic", ticket);
    const generation = dynamicHandoffGenerationRef.current;
    let matchedSynchronously = false;
    let matched = false;
    const onPainted = (stamp: Readonly<{
      scopeKey: string;
      documentRevision: number;
      surfaceGeneration: number;
      viewportRevision: number;
    }>) => {
      if (matched
        || generation !== dynamicHandoffGenerationRef.current
        || stamp.scopeKey !== ticket.scopeKey
        || stamp.documentRevision !== ticket.documentRevision
        || stamp.surfaceGeneration !== ticket.surfaceGeneration
        || stamp.viewportRevision !== ticket.viewportRevision) return;
      matched = true;
      recordDrawingPerfInteractionHandoffAcknowledged("dynamic", stamp);
      matchedSynchronously = true;
      dynamicPaintUnsubscribeRef.current?.();
      dynamicPaintUnsubscribeRef.current = null;
      const clearAfterPaint = () => {
        dynamicHandoffFrameRef.current = null;
        if (generation !== dynamicHandoffGenerationRef.current) return;
        dynamicHandoffLockRef.current = false;
        renderDynamicFeedback();
      };
      dynamicHandoffFrameRef.current = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(clearAfterPaint)
        : setTimeout(clearAfterPaint, 0);
    };
    const unsubscribe = subscribeVisibleScenePaint(onPainted, { replayLastPaint });
    dynamicPaintUnsubscribeRef.current = unsubscribe;
    if (matchedSynchronously) {
      unsubscribe();
      dynamicPaintUnsubscribeRef.current = null;
    }
  }, [cancelDynamicPaintHandoff, interactionSurfaceMode, renderDynamicFeedback, subscribeVisibleScenePaint]);

  useEffect(() => () => {
    cancelDynamicPaintHandoff();
  }, [cancelDynamicPaintHandoff]);

  useEffect(() => {
    if (interactionSurfaceMode === "overlay") {
      // An exact paint ticket is tied to one viewport/surface revision. If
      // those credentials move before acknowledgement, retire the stale
      // handoff instead of waiting forever for an ack the bridge must reject.
      cancelDynamicPaintHandoff();
      if (liveInkControllerRef.current?.snapshot().retainingFinalFrame) {
        liveInkControllerRef.current.cancel();
      }
    }
    dynamicOverlayControllerRef.current?.refreshLayout();
    liveInkControllerRef.current?.refreshLayout();
    renderDynamicFeedback();
  }, [cancelDynamicPaintHandoff, drawingCoordinateKey, interactionSurfaceMode, renderDynamicFeedback, seriesReady]);

  useEffect(() => {
    renderDynamicFeedback();
  }, [renderDynamicFeedback, selectedPrimId]);

  useEffect(() => {
    if (interactionSurfaceMode !== "overlay") return;
    return subscribeVisibleScenePaint(() => renderDynamicFeedback());
  }, [interactionSurfaceMode, renderDynamicFeedback, subscribeVisibleScenePaint]);

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
    if (interactionSurfaceMode === "overlay") {
      hoveredPrimRef.current = null;
      dynamicHoverDecorationRef.current = null;
      renderDynamicFeedback();
    } else {
      clearHoveredPrimitive(hoveredPrimRef);
    }
  }, [cancelPendingHoverFrame, interactionSurfaceMode, renderDynamicFeedback]);

  const applyHoverFeedback = useCallback(
    ({ tool, x, y }: HoverFeedbackPayload) => {
      const hit = tool === "eraser"
        ? hitTestAll(x, y)
        : hitTestInteractive(x, y);
      const hoverTarget = hoverTargetForTool(tool, hit);
      if (interactionSurfaceMode === "overlay") {
        hoveredPrimRef.current = hit?.prim ?? null;
        const decoration: DynamicHoverDecoration = {
          id: hit?.prim.id ?? null,
          point: { x, y },
          eraser: tool === "eraser",
        };
        dynamicHoverDecorationRef.current = decoration;
        renderDynamicFeedback(decoration);
      } else {
        syncHoveredPrimitive(hoveredPrimRef, hoverTarget);
      }

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
    [chartContainerRef, hitTestAll, hitTestInteractive, interactionSurfaceMode, renderDynamicFeedback],
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

  const ensureOverlayDragRegistry = useCallback((): MutableRefObject<DrawingPrimitive[]> => {
    const dragging = draggingRef.current;
    if (interactionSurfaceMode !== "overlay" || !dragging) return primitivesRef;
    if (overlayDragPrimitiveRef.current?.id === dragging.id) return overlayDragRegistryRef;
    const original = primitivesRef.current.find((primitive) => primitive.id === dragging.id) ?? null;
    const saved = original
      ? serializeDrawingPrimitive(original as unknown as PersistableDrawingPrimitive)
      : null;
    const draft = saved ? createPrimitiveFromSavedDrawing(saved) : null;
    if (!original || !draft) {
      // Overlay mode must never fall back to mutating the canonical primitive
      // from pointermove. A detached clone is the ownership boundary for the
      // entire gesture, so a clone failure cancels the drag fail-closed.
      draggingRef.current = null;
      overlayDragPrimitiveRef.current = null;
      overlayDragOriginalRef.current = null;
      overlayDragRegistryRef.current = [];
      return overlayDragRegistryRef;
    }

    overlayDragOriginalRef.current = original;
    overlayDragPrimitiveRef.current = draft;
    overlayDragRegistryRef.current = primitivesRef.current.map((primitive) => (
      primitive.id === dragging.id ? draft : primitive
    ));
    activeOverlayEntityIdRef.current = dragging.id;
    cancelDynamicPaintHandoff();
    renderDynamicFeedback();
    original.setHidden?.(true, false);
    invalidateVisibleScene();
    try { getChartAdapter()?.requestSeriesUpdate?.(); } catch { /* scene invalidation remains */ }
    return overlayDragRegistryRef;
  }, [cancelDynamicPaintHandoff, getChartAdapter, interactionSurfaceMode, invalidateVisibleScene, primitivesRef, renderDynamicFeedback]);

  const renderOverlayDragDraft = useCallback(() => {
    const draft = overlayDragPrimitiveRef.current;
    if (!draft || interactionSurfaceMode !== "overlay") return;
    const decorations = dynamicDecorationsForDrawingDraft(draft, dataToScreen);
    dynamicOverlayControllerRef.current?.render({ decorations });
  }, [dataToScreen, interactionSurfaceMode]);

  const releaseOverlayDrag = useCallback((restoreStatic: boolean, clearDynamic = true) => {
    const original = overlayDragOriginalRef.current;
    if (restoreStatic) original?.setHidden?.(false, false);
    activeOverlayEntityIdRef.current = null;
    overlayDragPrimitiveRef.current = null;
    overlayDragOriginalRef.current = null;
    overlayDragRegistryRef.current = [];
    invalidateVisibleScene();
    try { getChartAdapter()?.requestSeriesUpdate?.(); } catch { /* scene invalidation remains */ }
    if (clearDynamic) renderDynamicFeedback();
  }, [getChartAdapter, invalidateVisibleScene, renderDynamicFeedback]);

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
          const batch = interactionSurfaceMode === "overlay"
            ? captureOverlayFreehandBatch(capturePositions)
            : getChartAdapter()?.captureFreehandStrokeBatch?.(capturePositions);
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
          if (appendResult.previewPoints.length > 0) {
            if (interactionSurfaceMode === "overlay") {
              liveInkControllerRef.current?.appendFrame(appendResult.previewPoints);
            } else if (!currentFreehandRef.current.appendPreviewPoints(
              appendResult.previewPoints,
            )) {
              cancelActiveFreehandStroke();
              return true;
            }
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
          if (interactionSurfaceMode === "overlay") {
            liveInkControllerRef.current?.appendFrame([point]);
          }
          lastFreehandScreenPointRef.current = { x: point.x, y: point.y };
        }
        return true;
      }

      // ── Drag/resize of existing text & position drawings (extracted) ──
      const activePrimitivesRef = draggingRef.current
        ? ensureOverlayDragRegistry()
        : primitivesRef;
      if (applyTextAndPositionDrag({
        dragging: draggingRef.current,
        pos,
        e,
        primitivesRef: activePrimitivesRef,
        screenToData,
        dataToScreen,
        screenToDrawingData,
        refreshSelectedTextUi: interactionSurfaceMode === "overlay"
          ? () => {}
          : refreshSelectedTextUi,
        drawingSnapEnabledRef,
        chartContainerRef,
      })) {
        if (interactionSurfaceMode === "overlay") renderOverlayDragDraft();
        return true;
      }

      // ── LINE / FIB / SHAPE TOOLS ──
      if (isTwoPointCreationTool(tool) || isAxisLineToolId(tool)) {
        if (draggingRef.current) {
          applyLineFibShapeDrag({
            dragging: draggingRef.current,
            pos,
            e,
            primitivesRef: activePrimitivesRef,
            screenToData,
            dataToScreen,
            screenToDrawingData,
            drawingSnapEnabledRef,
          });
          if (interactionSurfaceMode === "overlay") renderOverlayDragDraft();
          return true;
        }

        if (isTwoPointCreationTool(tool) && updateTwoPointPreview({
          tool, pos, e, anchorDataRef, previewRef, screenToDrawingData, dataToScreen, drawingSnapEnabledRef,
        })) {
          if (interactionSurfaceMode === "overlay" && previewRef.current) {
            dynamicOverlayControllerRef.current?.render({
              decorations: dynamicDecorationsForDrawingDraft(previewRef.current, dataToScreen),
            });
          }
          return true;
        }
      }

      return false;
    },
    [cancelActiveFreehandStroke, captureOverlayFreehandBatch, ensureOverlayDragRegistry, getChartAdapter, interactionSurfaceMode, renderOverlayDragDraft, screenToFreehandData, screenToData, dataToScreen, screenToDrawingData, refreshSelectedTextUi, chartContainerRef],
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
    accumulateDrawingPerfFrameWork({
      activeOverlayCpuMs: durationMs,
      drawingMainThreadMs: durationMs,
    });
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
      if (interactionSurfaceMode === "overlay") {
        cancelActiveMoveFrame();
        pendingActiveMoveRef.current = null;
        clearCachedPointerRect();
        releaseOverlayDrag(true);
        draggingRef.current = null;
      } else {
        const commands = drawingCommandsForDrag(primitivesRef.current, committedDrag);
        if (!commands || persistActiveScopeDrawings(commands) === false) return false;
      }
    }
    const hadActiveFreehand = currentFreehandRef.current !== null;
    if (hadActiveFreehand && !cancelActiveFreehandStroke()) return false;
    if (!removePreview()) return false;
    // The backing primitive of a newly-created text annotation is deliberately
    // empty until confirmation. Cancel it before persistence snapshots the old
    // scope so it is detached as well as excluded by the canonical filter.
    return cancelTextEditing();
  }, [cancelActiveFreehandStroke, cancelActiveMoveFrame, cancelTextEditing, clearCachedPointerRect, flushActiveDrawingMove, interactionSurfaceMode, persistActiveScopeDrawings, releaseOverlayDrag, removePreview]);

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
      if (interactionSurfaceMode === "overlay") {
        cancelActiveDrawingMove();
        releaseOverlayDrag(true);
      } else {
        const commands = drawingCommandsForDrag(primitivesRef.current, committedDrag);
        if (!commands || persistDrawings(commands) === false) return;
      }
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
    interactionSurfaceMode,
    persistDrawings,
    releaseOverlayDrag,
    removePreview,
    resetCursorForActiveTool,
    seriesReady,
  ]);

  useEffect(() => () => {
    const committedDrag = !isDrawingFreehandRef.current
      ? draggingRef.current
      : null;
    if (interactionSurfaceMode !== "overlay") flushActiveDrawingMove();
    if (committedDrag && interactionSurfaceMode !== "overlay") {
      const commands = drawingCommandsForDrag(primitivesRef.current, committedDrag);
      if (!commands || persistDrawings(commands) === false) return;
    }
    cancelActiveDrawingMove();
    if (interactionSurfaceMode === "overlay") releaseOverlayDrag(true);
    cancelActiveFreehandStroke();
    liveInkControllerRef.current?.cancel();
    dynamicOverlayControllerRef.current?.clear();
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
    interactionSurfaceMode,
    persistDrawings,
    releaseOverlayDrag,
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
    if (interactionSurfaceMode === "overlay") ensureOverlayDragRegistry();
    return true;
  }, [ensureOverlayDragRegistry, interactionSurfaceMode]);

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
      if (!isInsideMainPanePlot(pos)) return;
      if (interactionSurfaceMode === "overlay") cancelDynamicPaintHandoff(true);
      if (liveInkControllerRef.current?.snapshot().retainingFinalFrame) {
        liveInkControllerRef.current.cancel();
      }

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
            const overlayHandleHit = hitTestSelectedOverlayHandle(pos.x, pos.y, sel);
            if (overlayHandleHit) hit = overlayHandleHit;
            else try { hit = sel.hitTestGeometry(pos.x, pos.y); } catch { /* ignore */ }
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
          const selectedHit = hitTestAll(pos.x, pos.y);
          const stillOnIt = selectedHit?.prim.id === sel.id;
          if (!stillOnIt) deselectAll();
        }
      }

      // ── ERASER: click to delete ──
      if (tool === "eraser") {
        const hit = hitTestAll(pos.x, pos.y);
        clearHoverFeedback();
        if (interactionSurfaceMode === "overlay" && hit) {
          const candidates = primitivesRef.current.filter((primitive) => primitive.id !== hit.prim.id);
          const receipt = persistDetachedDrawings(
            [Object.freeze({ type: "delete", id: hit.prim.id })],
            candidates,
          );
          if (receipt?.committed && selectedIdRef.current === hit.prim.id) {
            selectedIdRef.current = null;
            setSelectedPrimId(null);
            setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
          }
        } else {
          eraseDrawingAtPointer({
            detachPrim,
            hit,
            persistDrawings,
            primitivesRef,
            selectedIdRef,
            setSelectedPrimId,
            setSelectedTextUi,
          });
        }
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // ── PEN / HIGHLIGHTER (freehand): start stroke ──
      if (tool === "pen" || tool === "highlighter") {
        const adapter = getChartAdapter();
        const sourceLineage = interactionSurfaceMode === "overlay"
          || adapter?.usesOrdinalTime?.() === true;
        const captureBatch = interactionSurfaceMode === "overlay"
          ? captureOverlayFreehandBatch([pos])
          : sourceLineage ? adapter?.captureFreehandStrokeBatch?.([pos]) || null : null;
        const attachFreehandDraft = interactionSurfaceMode === "overlay"
          ? (primitive: DrawingPrimitive) => {
            primitive.setHidden?.(hiddenRef.current, false);
            return true;
          }
          : attachPrim;
        if (startFreehandStroke({
          tool, pos, e, primitivesRef, currentFreehandRef, isDrawingFreehandRef,
          freehandDraftRef, attachPrim: attachFreehandDraft, screenToData: screenToFreehandData,
          freehandCaptureIdentityRef, penColorRef, penSizeRef, sourceLineage, captureBatch,
        })) {
          const primitive = currentFreehandRef.current;
          if (interactionSurfaceMode === "overlay" && primitive) {
            const started = liveInkControllerRef.current?.start({
              color: primitive.color,
              lineWidth: primitive.lineWidth,
              opacity: primitive.opacity,
              tool,
              blendMode: primitive.compositeOperation,
              brushShape: primitive.brushShape,
            }, pos) === true;
            if (!started) {
              cancelActiveFreehandStroke();
              return;
            }
          }
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

          if (interactionSurfaceMode === "overlay" && draggingRef.current) {
            ensureOverlayDragRegistry();
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
        const overlaySurfaceAction = (primitive: DrawingPrimitive) => {
          primitive.setHidden?.(hiddenRef.current, false);
          return true;
        };
        const positionPersistence = interactionSurfaceMode === "overlay"
          ? (commands: readonly DrawingCommand[]) => {
            const receipt = persistDetachedDrawings(commands, primitivesRef.current);
            pendingOverlayCommitReceiptRef.current = receipt;
            return receipt?.committed === true;
          }
          : persistDrawings;
        if (placePositionDrawing({
          tool, pos, e, primitivesRef,
          attachPrim: interactionSurfaceMode === "overlay" ? overlaySurfaceAction : attachPrim,
          detachPrim: interactionSurfaceMode === "overlay" ? overlaySurfaceAction : detachPrim,
          selectPrimitive, persistDrawings: positionPersistence,
          screenToDrawingData, getChartAdapter, chartContainerRef, drawingSnapEnabledRef, positionSizeRef,
        })) {
          const receipt = pendingOverlayCommitReceiptRef.current;
          pendingOverlayCommitReceiptRef.current = null;
          retainDynamicOverlayUntilPaint(receipt?.ticket ?? null);
          if (!receipt?.committed) renderDynamicFeedback();
          return;
        }
      }

      // ── LINE/FIB/SHAPE TOOLS ──
      if (isTwoPointCreationTool(tool) || isAxisLineToolId(tool)) {
        const isAxisLineTool = isAxisLineToolId(tool);

        // Second click — commit new line/fib/shape
        if (isTwoPointCreationTool(tool)) {
          if (interactionSurfaceMode === "overlay" && previewRef.current) {
            dynamicHandoffLockRef.current = true;
          }
          const overlaySurfaceAction = (primitive: DrawingPrimitive) => {
            primitive.setHidden?.(hiddenRef.current, false);
            return true;
          };
          const commitPersistence = interactionSurfaceMode === "overlay"
            ? (commands: readonly DrawingCommand[]) => {
              const receipt = persistDetachedDrawings(commands, primitivesRef.current);
              pendingOverlayCommitReceiptRef.current = receipt;
              return receipt?.committed === true;
            }
            : persistDrawings;
          const handled = commitTwoPointDrawing({
            tool, pos, e, primitivesRef, anchorDataRef, previewRef,
            attachPrim: interactionSurfaceMode === "overlay" ? overlaySurfaceAction : attachPrim,
            detachPrim: interactionSurfaceMode === "overlay" ? overlaySurfaceAction : detachPrim,
            selectPrimitive, persistDrawings: commitPersistence,
            screenToDrawingData, dataToScreen, drawingSnapEnabledRef,
            penColorRef, penSizeRef, fibLevelsRef, fibInvertedRef,
          });
          if (handled) {
            const receipt = pendingOverlayCommitReceiptRef.current;
            pendingOverlayCommitReceiptRef.current = null;
            retainDynamicOverlayUntilPaint(receipt?.ticket ?? null);
            if (!receipt?.committed) renderDynamicFeedback();
            if (!previewRef.current && !anchorDataRef.current) {
              pendingTwoPointToolRef.current = null;
            }
            return;
          }
          dynamicHandoffLockRef.current = false;
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
              origBox: hit.prim.getBoundingBoxScreen?.()
                || getSceneScreenBox(hit.prim.id),
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

          if (interactionSurfaceMode === "overlay" && draggingRef.current) {
            ensureOverlayDragRegistry();
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
          if (interactionSurfaceMode === "overlay") ensureOverlayDragRegistry();
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
          if (interactionSurfaceMode === "overlay") {
            dynamicHandoffLockRef.current = true;
          }
          const overlaySurfaceAction = (primitive: DrawingPrimitive) => {
            primitive.setHidden?.(hiddenRef.current, false);
            return true;
          };
          const axisPersistence = interactionSurfaceMode === "overlay"
            ? (commands: readonly DrawingCommand[]) => {
              const receipt = persistDetachedDrawings(commands, primitivesRef.current);
              pendingOverlayCommitReceiptRef.current = receipt;
              return receipt?.committed === true;
            }
            : persistDrawings;
          if (beginAxisLineDrawing({
            tool, pos, e, primitivesRef, anchorDataRef, previewRef, draggingRef,
            attachPrim: interactionSurfaceMode === "overlay" ? overlaySurfaceAction : attachPrim,
            detachPrim: interactionSurfaceMode === "overlay" ? overlaySurfaceAction : detachPrim,
            selectPrimitive, persistDrawings: axisPersistence, removePreview, screenToDrawingData,
            drawingSnapEnabledRef, penColorRef, penSizeRef,
          })) {
            const receipt = pendingOverlayCommitReceiptRef.current;
            pendingOverlayCommitReceiptRef.current = null;
            retainDynamicOverlayUntilPaint(receipt?.ticket ?? null);
            if (!receipt?.committed) renderDynamicFeedback();
            if (interactionSurfaceMode === "overlay" && draggingRef.current) {
              ensureOverlayDragRegistry();
            }
            return;
          }
        }

        // First click — set anchor
        if (isTwoPointCreationTool(tool)) {
          const previewAttach = interactionSurfaceMode === "overlay"
            ? (primitive: DrawingPrimitive) => {
              primitive.setHidden?.(hiddenRef.current, false);
              return true;
            }
            : attachPrim;
          const handled = beginTwoPointDrawing({
            tool, pos, e, anchorDataRef, previewRef, attachPrim: previewAttach, screenToDrawingData,
            drawingSnapEnabledRef, penColorRef, penSizeRef, fibLevelsRef, fibInvertedRef,
          });
          if (handled) {
            pendingTwoPointToolRef.current = previewRef.current ? tool : null;
            if (interactionSurfaceMode === "overlay" && previewRef.current) {
              dynamicOverlayControllerRef.current?.render({
                decorations: dynamicDecorationsForDrawingDraft(previewRef.current, dataToScreen),
              });
            }
            return;
          }
          dynamicHandoffLockRef.current = false;
        }
      }
    },
    [flushActiveDrawingMove, getChartPos, isInsideMainPanePlot, captureOverlayFreehandBatch, interactionSurfaceMode, screenToFreehandData, screenToDrawingData, dataToScreen, detachPrim, attachPrim, hitTestAll, hitTestInteractive, hitTestSelectedOverlayHandle, selectPrimitive, deselectAll, getPrimitiveById, getSceneScreenBox, beginTextDrag, startTextEditing, commitTextEditing, cancelTextEditing, persistDetachedDrawings, persistDrawings, prepareUserMutationScope, removePreview, cancelActiveFreehandStroke, cancelDynamicPaintHandoff, ensureOverlayDragRegistry, getChartAdapter, chartContainerRef, drawingAnchorMode, editingTextIdRef, selectedIdRef, setSelectedPrimId, setSelectedTextUi, clearHoverFeedback, renderDynamicFeedback, retainDynamicOverlayUntilPaint],
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
    let completedDragDescriptor: DrawingDragDescriptor | null = null;
    let completedFreehand = false;
    let completedFreehandDraft: FreehandStrokeDraft | null = null;
    let completedFreehandPrimitive: FreehandDrawingPrimitive | null = null;
    let completedDragCandidates: readonly DrawingPrimitive[] | null = null;
    // End freehand drawing
    if (isDrawingFreehandRef.current) {
      // ── Decimate stroke via RDP to reduce render cost ──
      const prim = currentFreehandRef.current;
      const draft = freehandDraftRef.current;
      let committed = false;
      const finalizeStartedAt = drawingPerfNow();
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
      drawingPerfCounters.recordDuration(
        "mouseupFinalizeMs",
        Math.max(0, drawingPerfNow() - finalizeStartedAt),
      );
      if (committed && prim) {
        const commandStartedAt = drawingPerfNow();
        commands = drawingCommandsForLegacyPrimitive(prim, { type: "create" });
        drawingPerfCounters.recordDuration(
          "mouseupCommandMs",
          Math.max(0, drawingPerfNow() - commandStartedAt),
        );
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
        completedFreehandPrimitive = prim;
      } else {
        cancelActiveFreehandStroke();
      }
    }
    // End dragging
    if (!completedFreehand && draggingRef.current) {
      const committedDrag = draggingRef.current;
      completedDragCandidates = interactionSurfaceMode === "overlay"
        && overlayDragPrimitiveRef.current
        ? overlayDragRegistryRef.current
        : primitivesRef.current;
      commands = drawingCommandsForDrag(completedDragCandidates, committedDrag);
      completedDrag = true;
      completedDragDescriptor = committedDrag;
    }
    let persisted = !commands && !completedDrag;
    if (commands) {
      try {
        if (interactionSurfaceMode === "overlay"
          && completedFreehand
          && completedFreehandPrimitive) {
          const primitive = completedFreehandPrimitive;
          liveInkControllerRef.current?.finish();
          let painted = false;
          let committedTicket: Readonly<{
            scopeKey: string;
            documentRevision: number;
            surfaceGeneration: number;
            viewportRevision: number;
          }> | null = null;
          const ticketIsCurrent = () => {
            if (!committedTicket || symbolRef.current !== committedTicket.scopeKey) return false;
            const adapter = getChartAdapter();
            const frame = adapter?.captureDrawingFrame?.() ?? null;
            return !!frame
              && adapter?.isDrawingFrameCurrent?.(frame) === true
              && frame.surfaceGeneration === committedTicket.surfaceGeneration
              && frame.viewportRevision === committedTicket.viewportRevision;
          };
          const pendingPaintListeners = new Set<() => void>();
          const unsubscribePrimitivePaint = primitive.subscribeCommittedPaint(() => {
            if (committedTicket && !ticketIsCurrent()) return;
            painted = true;
            for (const listener of [...pendingPaintListeners]) listener();
          });
          const commitStartedAt = drawingPerfNow();
          const receipt = persistDetachedDrawings(commands, primitivesRef.current);
          drawingPerfCounters.recordDuration(
            "mouseupCommitMs",
            Math.max(0, drawingPerfNow() - commitStartedAt),
          );
          persisted = receipt?.committed === true;
          const ticket = receipt?.ticket ?? null;
          committedTicket = ticket;
          if (persisted && ticket) {
            recordDrawingPerfInteractionHandoffPrepared("live-ink", ticket);
            liveInkControllerRef.current?.retainUntilPaint(ticket, (listener) => {
              const deliver = () => {
                recordDrawingPerfInteractionHandoffAcknowledged("live-ink", ticket);
                listener(ticket);
              };
              pendingPaintListeners.add(deliver);
              if (painted && ticketIsCurrent()) deliver();
              return () => {
                pendingPaintListeners.delete(deliver);
                if (pendingPaintListeners.size === 0) unsubscribePrimitivePaint();
              };
            });
          } else {
            unsubscribePrimitivePaint();
            liveInkControllerRef.current?.cancel();
          }
        } else if (interactionSurfaceMode === "overlay"
          && completedDrag
          && overlayDragPrimitiveRef.current
          && completedDragCandidates) {
          activeOverlayEntityIdRef.current = null;
          invalidateVisibleScene();
          try {
            const receipt = persistDetachedDrawings(commands, completedDragCandidates);
            pendingOverlayCommitReceiptRef.current = receipt;
            persisted = receipt?.committed === true;
            const changed = receipt?.changed === true;
            releaseOverlayDrag(!persisted || !changed, !persisted || !changed);
            if (persisted
              && changed
              && completedDragDescriptor
              && (completedDragDescriptor.type === "text"
                || completedDragDescriptor.type === "text-handle")) {
              refreshSelectedTextUi(completedDragDescriptor.id);
            }
            if (persisted && changed) {
              retainDynamicOverlayUntilPaint(receipt?.ticket ?? null, {
                replayLastPaint: true,
              });
            }
          } finally {
            // A throwing persistence boundary still owns a hidden original and
            // detached clone. Restore/clear them before the outer catch exits.
            if (overlayDragPrimitiveRef.current) releaseOverlayDrag(true);
          }
        } else {
          persisted = persistDrawings(commands) !== false;
        }
      } catch {
        persisted = false;
      }
    }
    if (interactionSurfaceMode === "overlay"
      && completedDrag
      && overlayDragPrimitiveRef.current) {
      // Null command batches never enter the persistence branch above.
      releaseOverlayDrag(true);
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
    if (completedDrag && (persisted || interactionSurfaceMode === "overlay")) {
      draggingRef.current = null;
    }
    clearCachedPointerRect();
    const durationMs = Math.max(0, drawingPerfNow() - mouseupStartedAt);
    drawingPerfCounters.recordMouseupSyncDuration(durationMs);
    drawingPerfCounters.gestureEnded();
  }, [cancelActiveFreehandStroke, flushActiveDrawingMove, getChartAdapter, interactionSurfaceMode, invalidateVisibleScene, persistDetachedDrawings, persistDrawings, prepareUserMutationScope, dataToScreen, clearCachedPointerRect, refreshSelectedTextUi, releaseOverlayDrag, retainDynamicOverlayUntilPaint, symbolRef]);

  const handlePointerCancel = useCallback(() => {
    if (interactionSurfaceMode !== "overlay" && !isDrawingFreehandRef.current) {
      handleMouseUp();
      return;
    }
    cancelActiveDrawingMove();
    cancelActiveFreehandStroke();
    cancelDynamicPaintHandoff();
    removePreview();
    clearHoverFeedback();
    draggingRef.current = null;
    releaseOverlayDrag(true);
    clearCachedPointerRect();
  }, [cancelActiveDrawingMove, cancelActiveFreehandStroke, cancelDynamicPaintHandoff, clearCachedPointerRect, clearHoverFeedback, handleMouseUp, interactionSurfaceMode, releaseOverlayDrag, removePreview]);

  const handleMouseLeave = useCallback((e: DrawingDomPointerEvent) => {
    // Text overlays are siblings of the chart canvas container. Moving the
    // pointer over the floating format/edit bar fires mouseleave on the chart
    // container, but it should not terminate an in-progress text drag/resize.
    if (draggingRef.current && "relatedTarget" in e && isTextOverlayTarget(e.relatedTarget)) {
      return;
    }
    if (interactionSurfaceMode === "overlay"
      && (draggingRef.current || isDrawingFreehandRef.current)) return;
    handleMouseUp();
  }, [handleMouseUp, interactionSurfaceMode]);

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
    hasActiveInteractionGesture: () => interactionSurfaceMode === "overlay"
      && (draggingRef.current !== null || dynamicHoverDecorationRef.current !== null),
    cancelActiveInteractionGesture: () => {
      handlePointerCancel();
      return true;
    },
    deleteSelected: () => deleteSelectedRef.current(),
  });

  // ── Clean up when tool changes ──

  useEffect(() => {
    cancelActiveDrawingMove();
    if (interactionSurfaceMode === "overlay" && overlayDragPrimitiveRef.current) {
      releaseOverlayDrag(true);
      draggingRef.current = null;
    }
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
  }, [interactionSurfaceMode, isLineTool, isFibTool, isShapeTool, isPenTool, isHighlighterTool, isEraserTool, isTextTool, isPositionTool, removePreview, deselectAll, cancelTextEditing, selectedIdRef, clearHoverFeedback, cancelActiveDrawingMove, cancelActiveFreehandStroke, releaseOverlayDrag]);

  useDrawingPointerEvents({
    chartContainerRef,
    handleDblClick,
    handleContextMenu,
    handleMouseDown,
    handleMouseLeave,
    handleMouseMove,
    handleMouseUp,
    handlePointerCancel,
    ...(interactionSurfaceMode === "overlay" ? { handleWindowBlur: handlePointerCancel } : {}),
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
      cancelDynamicPaintHandoff(true);
      releaseOverlayDrag(true);
      liveInkControllerRef.current?.cancel();
      clearHoverFeedback();
      draggingRef.current = null;
      resetCursorForActiveTool();
    },
  ), [cancelActiveDrawingMove, cancelDynamicPaintHandoff, clearHoverFeedback, preparePersistenceSurfaceDispose, releaseOverlayDrag, resetCursorForActiveTool]);

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
    cancelDynamicPaintHandoff();
    releaseOverlayDrag(false);
    liveInkControllerRef.current?.cancel();
    dynamicOverlayControllerRef.current?.clear();
    clearHoverFeedback();
    completePersistenceSurfaceDispose();
  }, [cancelActiveDrawingMove, cancelDynamicPaintHandoff, clearHoverFeedback, completePersistenceSurfaceDispose, completeTextSurfaceDispose, releaseOverlayDrag]);

  /** Clear all drawings (lines + freehand + text) */
  const clearAll = useCallback(() => {
    if (!prepareTerminalTextMutation()) return;
    if (!cancelTextEditing()) return;
    if (!cancelActiveFreehandStroke()) return;
    if (!removePreview()) return;
    cancelActiveDrawingMove();
    releaseOverlayDrag(true);
    if (!clearDrawings()) return;
    primitivesRef.current = [];
    clearHoverFeedback();
    selectedIdRef.current = null;
    setSelectedPrimId(null);
    setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
    draggingRef.current = null;
  }, [clearDrawings, removePreview, cancelTextEditing, selectedIdRef, setSelectedPrimId, setSelectedTextUi, clearHoverFeedback, cancelActiveDrawingMove, cancelActiveFreehandStroke, prepareTerminalTextMutation, releaseOverlayDrag]);

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
      cancelDynamicPaintHandoff();
      removePreview();
      cancelTextEditing();
      clearHoverFeedback();
      cancelActiveDrawingMove();
      releaseOverlayDrag(true);
      cancelActiveFreehandStroke();
      liveInkControllerRef.current?.cancel();
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
    getChartAdapter()?.notifyDrawingFrameInvalidation?.();
  }, [cancelDynamicPaintHandoff, getChartAdapter, removePreview, cancelTextEditing, clearHoverFeedback, cancelActiveDrawingMove, cancelActiveFreehandStroke, prepareUserMutationScope, releaseOverlayDrag]);

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
    if (interactionSurfaceMode === "overlay") {
      const candidates = primitivesRef.current.filter((candidate) => candidate.id !== id);
      const receipt = persistDetachedDrawings(
        [Object.freeze({ type: "delete", id })],
        candidates,
      );
      if (!receipt?.committed) return;
      selectedIdRef.current = null;
      setSelectedPrimId(null);
      setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
      dynamicOverlayControllerRef.current?.clear();
      return;
    }
    const wasAttached = primitive._series !== null;
    if (wasAttached) {
      if (!detachAndRemoveDrawingPrimitive(primitivesRef.current, primitive, detachPrim)) return;
    } else {
      primitivesRef.current.splice(idx, 1);
    }
    let persisted = false;
    try {
      persisted = persistDrawings([Object.freeze({ type: "delete", id })]) !== false;
    } catch {
      persisted = false;
    }
    if (!persisted) {
      if (!primitivesRef.current.some((candidate) => candidate.id === id)) {
        if (!wasAttached || attachPrim(primitive)) {
          primitivesRef.current.splice(Math.min(idx, primitivesRef.current.length), 0, primitive);
        }
      }
      return;
    }
    selectedIdRef.current = null;
    setSelectedPrimId(null);
    setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
  }, [attachPrim, detachPrim, interactionSurfaceMode, persistDetachedDrawings, prepareTerminalTextMutation, persistDrawings, selectedIdRef, setSelectedPrimId, setSelectedTextUi]);

  useEffect(() => {
    deleteSelectedRef.current = deleteSelected;
    return () => {
      if (deleteSelectedRef.current === deleteSelected) deleteSelectedRef.current = () => {};
    };
  }, [deleteSelected]);

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
