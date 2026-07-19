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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  DEFAULT_HIGHLIGHTER_BRUSH_SHAPE,
  DEFAULT_HIGHLIGHTER_COMPOSITE_OPERATION,
  DEFAULT_HIGHLIGHTER_OPACITY,
  FIB_TOOL_IDS,
  LINE_TOOL_IDS,
  POSITION_TOOL_IDS,
  SHAPE_TOOL_IDS,
  axisLineTypeFromTool,
  constrainShapeScreenPoint,
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
  selectedDrawingMetaFromSavedDrawing,
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
import {
  restorePrePresentationHiddenDrawingSceneRuntime,
  useDrawingPersistenceLifecycle,
} from "./useDrawingPersistenceLifecycle.js";
import type {
  DrawingActiveDocumentTarget,
  DrawingExportSceneReceipt,
  DrawingLegacyPrimitiveRuntimeEvidence,
} from "./useDrawingPersistenceLifecycle.js";
import {
  createDrawingExportBarrier,
} from "./export/drawingExportBarrier.js";
import type {
  DrawingExportBarrier,
  DrawingExportBarrierLease,
} from "./export/drawingExportBarrier.js";
import type { DrawingDisplayHitResult } from "./rendering/drawingDisplayList.js";
import { DEFAULT_FIBONACCI_RENDER_LEVELS } from "./rendering/drawingRenderDefaults.js";
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
import type { DrawingFrameThemePalette } from "../../chart-adapter/drawingFrameSnapshot.js";
import { supportsDrawingHitType } from "./drawingCapabilities.js";
import {
  beginAxisLineDrawing,
  beginTwoPointDrawing,
  commitTwoPointDrawing,
  placePositionDrawing,
  placeTextDrawing,
  positionTimeRangeFromScreen,
  startFreehandStroke,
  updateTwoPointPreview,
} from "./drawingCreationController.js";
import {
  appendFreehandStrokeCaptureBatchIncremental,
  appendFreehandStrokeCaptureBatch,
  cancelFreehandStrokeDraft,
  createFreehandStrokeDraft,
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
import {
  buildAngleDynamicOverlayDecoration,
  createDynamicOverlayController,
} from "./interaction/dynamicOverlayController.js";
import type {
  DynamicOverlayController,
  DynamicOverlayDecoration,
} from "./interaction/dynamicOverlayController.js";
import {
  drawingEntityHitFromSavedDrawing,
  drawingHitTypeFromSavedDrawing,
} from "./interaction/drawingEntityHit.js";
import type { DrawingEntityHit } from "./interaction/drawingEntityHit.js";
import { useDrawingEntityTextEdit } from "./interaction/useDrawingEntityTextEdit.js";
import type { DrawingEntityTextCommitReceipt } from "./interaction/useDrawingEntityTextEdit.js";
import {
  createAxisLineSavedDrawing,
  createFinalizedFreehandSavedDrawing,
  createPositionSavedDrawing,
  createTextSavedDrawing,
  createTwoPointSavedDrawing,
  drawingCreateCommandsForSavedDrawing,
} from "./interaction/drawingEntityCreation.js";
import {
  applyDrawingEntityDrag,
  drawingEntityGeometryCommandForDrag,
} from "./interaction/drawingEntityDrag.js";
import { createLiveInkController } from "./interaction/liveInkController.js";
import type { LiveInkController } from "./interaction/liveInkController.js";
import { buildDynamicPositionOverlayDecoration } from "./interaction/dynamicPositionOverlay.js";
import type { DrawingInteractionSurfaceMode } from "./interactionSurfaceMode.js";
import {
  abandonDrawingInteractionLifecycleActiveGesture,
  beginDrawingInteractionLifecycleFreehandGesture,
  completeDrawingInteractionLifecycleBoundaryCancellation,
  markDrawingInteractionLifecycleBoundaryChange,
  rollbackDrawingInteractionLifecycleBoundaryChange,
} from "./interaction/drawingInteractionLifecycle.js";
import {
  DEFAULT_DRAWING_POSITION_THEME_PALETTE,
} from "./drawingPositionColors.js";
import { drawingPositionCurrentPrice } from "./drawingPositionPresentation.js";

function drawingPerfNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function scenePaintCoversDrawingHandoff(
  ticket: Readonly<{
    scopeKey: string;
    documentRevision: number;
    surfaceGeneration: number;
    viewportRevision: number;
  }>,
  stamp: Readonly<{
    scopeKey: string;
    documentRevision: number;
    surfaceGeneration: number;
    viewportRevision: number;
  }>,
): boolean {
  return stamp.scopeKey === ticket.scopeKey
    && stamp.surfaceGeneration === ticket.surfaceGeneration
    && stamp.documentRevision >= ticket.documentRevision;
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

export interface DynamicHoverDecoration {
  readonly id: string | null;
  readonly point: ScreenPoint;
  readonly eraser: boolean;
}

/** Build passive hover/eraser feedback without repainting selected entities as boxes. */
export function dynamicPassiveFeedbackDecorations({
  getScreenBox,
  hover,
  selectedId,
}: Readonly<{
  getScreenBox: (id: string | null) => ScreenBox | null;
  hover: DynamicHoverDecoration | null;
  selectedId: string | null;
}>): readonly DynamicOverlayDecoration[] {
  if (!hover) return Object.freeze([]);
  const decorations: DynamicOverlayDecoration[] = [];
  const hoverBox = getScreenBox(hover.id);
  if (hoverBox && hover.id !== selectedId) {
    decorations.push(Object.freeze({
      type: "box" as const,
      box: hoverBox,
      color: "#ff6b6b",
    }));
  }
  if (hover.eraser) {
    decorations.push(Object.freeze({
      type: "cursor-ring" as const,
      center: hover.point,
      color: hover.id ? "#ff6b6b" : "rgba(148,163,184,0.8)",
      radius: 8,
    }));
  }
  return Object.freeze(decorations);
}

/** Preserve selected drag affordances without drawing a bounding rectangle. */
export function dynamicSelectedHandleDecoration(
  handles: readonly ScreenPoint[],
): DynamicOverlayDecoration | null {
  const validHandles = handles
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => Object.freeze({ x: point.x, y: point.y }));
  if (validHandles.length === 0) return null;
  return Object.freeze({
    type: "handles" as const,
    handles: Object.freeze(validHandles),
    color: "#3b82f6",
  });
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
 * Keep boundary telemetry aligned with the persistence barrier even when a
 * partial prepare throws. A failed prepare may leave the physical gesture
 * active (retryable) or may already have cancelled it; both cases must retire
 * the speculative boundary event before the original result/error escapes.
 */
export function runDrawingSurfaceDisposeBoundaryLifecycle({
  boundaryMarked,
  hasActiveFreehand,
  prepare,
}: Readonly<{
  boundaryMarked: boolean;
  hasActiveFreehand(): boolean;
  prepare(): boolean;
}>): boolean {
  let prepared = false;
  try {
    prepared = prepare();
    return prepared;
  } finally {
    if (boundaryMarked) {
      const activeAfterPrepare = hasActiveFreehand();
      if (prepared && !activeAfterPrepare) {
        completeDrawingInteractionLifecycleBoundaryCancellation("surface-dispose");
      } else {
        rollbackDrawingInteractionLifecycleBoundaryChange();
        if (!activeAfterPrepare) abandonDrawingInteractionLifecycleActiveGesture();
      }
    }
  }
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

export interface DrawingExportVisibilityRestoreCallbacks {
  applyPendingIntent(nextHidden: boolean): void;
  restoreCapturePresentation(): void;
  restoreInteraction(): void;
}

export interface DrawingExportVisibilityIntentGate {
  begin(): void;
  isLocked(): boolean;
  request(nextHidden: boolean): boolean;
  restore(callbacks: DrawingExportVisibilityRestoreCallbacks): boolean;
  snapshot(): Readonly<{ locked: boolean; pendingIntent: boolean | null }>;
}

/**
 * Keeps user visibility changes out of an exact export presentation. Internal
 * export visibility changes bypass this gate; user intent is latest-wins and
 * is applied only after the captured presentation and interaction UI restore.
 */
export function createDrawingExportVisibilityIntentGate(): DrawingExportVisibilityIntentGate {
  let locked = false;
  let pendingIntent: boolean | null = null;

  return Object.freeze({
    begin() {
      if (locked) throw new Error("drawing export visibility lease is already active");
      locked = true;
      pendingIntent = null;
    },
    isLocked() {
      return locked;
    },
    request(nextHidden: boolean) {
      if (!locked) return true;
      pendingIntent = !!nextHidden;
      return false;
    },
    restore(callbacks: DrawingExportVisibilityRestoreCallbacks) {
      if (!locked) return false;
      const failures: unknown[] = [];
      try {
        callbacks.restoreCapturePresentation();
      } catch (error) {
        failures.push(error);
      }
      try {
        callbacks.restoreInteraction();
      } catch (error) {
        failures.push(error);
      }

      const nextIntent = pendingIntent;
      pendingIntent = null;
      locked = false;
      if (nextIntent !== null) {
        try {
          callbacks.applyPendingIntent(nextIntent);
        } catch (error) {
          failures.push(error);
        }
      }

      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "drawing export visibility restore failed");
      }
      return true;
    },
    snapshot() {
      return Object.freeze({ locked, pendingIntent });
    },
  });
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

/** Project one canonical interaction draft into cheap dynamic-canvas commands. */
export function dynamicDecorationsForSavedDrawingDraft(
  saved: SavedDrawing,
  dataToScreen: DrawingDataToScreen,
  themePalette: DrawingFrameThemePalette = DEFAULT_DRAWING_POSITION_THEME_PALETTE,
  currentPrice: number | null = null,
): readonly DynamicOverlayDecoration[] {
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
      const firstPrice = saved.dataPoints[0]?.price;
      const lastPrice = saved.dataPoints.at(-1)?.price;
      const hasPrices = typeof firstPrice === "number"
        && Number.isFinite(firstPrice)
        && typeof lastPrice === "number"
        && Number.isFinite(lastPrice);
      const startPrice = saved.inverted ? lastPrice : firstPrice;
      const endPrice = saved.inverted ? firstPrice : lastPrice;
      const levels = (saved.levels ?? DEFAULT_FIBONACCI_RENDER_LEVELS)
        .filter((level) => level.enabled);
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
          const logicalPrice = hasPrices
            ? (startPrice as number) + ((endPrice as number) - (startPrice as number)) * level.level
            : null;
          return Object.freeze({
            type: "line" as const,
            from: Object.freeze({ x: minX, y }),
            to: Object.freeze({ x: maxX, y }),
            color: level.color,
            lineWidth,
            ...(logicalPrice === null
              ? {}
              : {
                  label: Object.freeze({
                    anchor: Object.freeze({ x: minX + 4, y: y - 2 }),
                    text: `${level.level} (${logicalPrice.toFixed(2)})`,
                  }),
                }),
          });
        }),
      ]);
    }
    if (saved.type === "angle-measure") {
      const decoration = buildAngleDynamicOverlayDecoration(
        first,
        last,
        color,
        lineWidth,
        true,
      );
      return decoration ? Object.freeze([decoration]) : [];
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
    const decoration = buildDynamicPositionOverlayDecoration(
      saved,
      dataToScreen,
      themePalette,
      currentPrice,
    );
    return decoration ? Object.freeze([decoration]) : [];
  }
  return [];
}

/**
 * Publish the complete interaction frame before a canonical create command can
 * invalidate the static scene. The returned commit result is intentionally
 * opaque so the ordering boundary stays directly testable without React.
 */
export function commitSavedDrawingAfterDynamicFrame<T>(
  saved: SavedDrawing,
  dataToScreen: DrawingDataToScreen,
  renderDynamicFrame: (decorations: readonly DynamicOverlayDecoration[]) => void,
  commit: () => T,
  themePalette: DrawingFrameThemePalette = DEFAULT_DRAWING_POSITION_THEME_PALETTE,
  currentPrice: number | null = null,
): T {
  const decorations = dynamicDecorationsForSavedDrawingDraft(
    saved,
    dataToScreen,
    themePalette,
    currentPrice,
  );
  if (decorations.length > 0) renderDynamicFrame(decorations);
  return commit();
}

/** Transitional primitive wrapper retained for the legacy interaction surface. */
export function dynamicDecorationsForDrawingDraft(
  primitive: DrawingPrimitive,
  dataToScreen: DrawingDataToScreen,
  themePalette: DrawingFrameThemePalette = DEFAULT_DRAWING_POSITION_THEME_PALETTE,
  currentPrice: number | null = null,
): readonly DynamicOverlayDecoration[] {
  const saved = serializeDrawingPrimitive(
    primitive as unknown as PersistableDrawingPrimitive,
  );
  return saved
    ? dynamicDecorationsForSavedDrawingDraft(saved, dataToScreen, themePalette, currentPrice)
    : [];
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
  sceneHandles: readonly ScreenPoint[] | null = null,
  positionBarSpacing: number | null = null,
): readonly DynamicSelectionHandleSpec[] {
  if ((saved.type === "text" || saved.type === "shape") && screenBox) {
    return dynamicBoxSelectionHandles(screenBox);
  }
  if (saved.type === "freehand" || saved.type === "highlighter" || saved.type === "text") {
    return [];
  }
  if (saved.type === "position" && saved.timeRange) {
    const positionZones: Array<"entry" | "tp" | "sl" | "left" | "right"> = ["entry"];
    if (typeof saved.tpPrice === "number" && Number.isFinite(saved.tpPrice)) {
      positionZones.push("tp");
    }
    if (typeof saved.slPrice === "number" && Number.isFinite(saved.slPrice)) {
      positionZones.push("sl");
    }
    positionZones.push("left", "right");
    if (sceneHandles?.length === positionZones.length) {
      return Object.freeze(sceneHandles.map((point, index) => {
        const zone = positionZones[index];
        if (!zone) throw new RangeError("Position scene handle index is invalid");
        return Object.freeze({
          point: Object.freeze({ x: point.x, y: point.y }),
          hit: Object.freeze({ zone, pointIndex: -1 }),
          radius: zone === "left" || zone === "right" ? 10 : 9,
        });
      }));
    }
    const entryStart = dataPointFromSavedHorizontalAnchor(saved.timeRange.start, saved.entryPrice);
    const entryEnd = dataPointFromSavedHorizontalAnchor(saved.timeRange.end, saved.entryPrice);
    const start = entryStart ? dataToScreen(entryStart) : null;
    const end = entryEnd ? dataToScreen(entryEnd) : null;
    if (!start || !end) return [];
    const requestedWidth = Math.max(
      24,
      Math.min(
        40,
        typeof positionBarSpacing === "number"
          && Number.isFinite(positionBarSpacing)
          && positionBarSpacing > 0
          ? positionBarSpacing
          : 24,
      ),
    );
    let left = Math.min(start.x, end.x);
    let right = Math.max(start.x, end.x);
    if (right - left < requestedWidth) {
      const center = (left + right) / 2;
      left = center - requestedWidth / 2;
      right = center + requestedWidth / 2;
    }
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

/** Merge transitional scene/legacy owners using canonical document order. */
export function resolveTopmostDrawingInteractionHit(
  primitives: readonly DrawingPrimitive[],
  legacyHit: DrawingPrimitiveHit | null,
  sceneHit: DrawingDisplayHitResult | null,
): DrawingPrimitiveHit | null {
  if (!sceneHit) return legacyHit;
  const sceneIndex = primitives.findIndex((primitive) => primitive.id === sceneHit.entityId);
  if (sceneIndex < 0) return legacyHit;
  const primitive = primitives[sceneIndex];
  if (!primitive) return legacyHit;
  const type = sceneHit.kind === "angle-measure" ? "angle" : sceneHit.kind;
  const sceneCandidate = { prim: primitive, type, ...sceneHit } as DrawingPrimitiveHit;
  if (!legacyHit) return sceneCandidate;
  const legacyIndex = primitives.lastIndexOf(legacyHit.prim);
  return sceneIndex > legacyIndex ? sceneCandidate : legacyHit;
}

/** Hit the scene first, then resolve only the one canonical entity that won. */
export function hitTestOverlayDrawingEntity(
  x: number,
  y: number,
  hitTestScene: (sceneX: number, sceneY: number) => DrawingDisplayHitResult | null,
  getSavedDrawing: (id: string) => SavedDrawing | null,
): DrawingEntityHit | null {
  const sceneHit = hitTestScene(x, y);
  if (!sceneHit) return null;
  return drawingEntityHitFromSavedDrawing(
    getSavedDrawing(sceneHit.entityId),
    sceneHit,
  );
}

type DrawingInteractionHit = DrawingPrimitiveHit | DrawingEntityHit;

export interface PassiveCursorSelectedNonTextHitOptions<
  T extends { readonly type: string },
> {
  readonly selectedId: string;
  readonly hitTest: () => T | null;
  readonly hitId: (hit: T) => string;
  readonly supportsHitType: (type: T["type"]) => boolean;
  readonly deselect: () => void;
}

export function resolvePassiveCursorSelectedNonTextHit<
  T extends { readonly type: string },
>({
  selectedId,
  hitTest,
  hitId,
  supportsHitType,
  deselect,
}: PassiveCursorSelectedNonTextHitOptions<T>): T | null {
  const hit = hitTest();
  if (!hit || hitId(hit) !== selectedId) deselect();
  return hit && supportsHitType(hit.type) ? hit : null;
}

export interface SelectedOverlayHandleHitTestOptions {
  readonly selectedId: string;
  readonly x: number;
  readonly y: number;
  readonly getSavedDrawing: (id: string) => SavedDrawing | null;
  readonly dataToScreen: DrawingDataToScreen;
  readonly getSceneScreenBox: (id: string) => ScreenBox | null;
  readonly getSceneScreenHandles: (id: string) => readonly ScreenPoint[] | null;
  readonly getPositionBarSpacing?: () => number | null;
}

export function hitTestSelectedOverlayDrawingHandle({
  selectedId,
  x,
  y,
  getSavedDrawing,
  dataToScreen,
  getSceneScreenBox,
  getSceneScreenHandles,
  getPositionBarSpacing,
}: SelectedOverlayHandleHitTestOptions): DrawingEntityHit | null {
  const saved = getSavedDrawing(selectedId);
  if (!saved) return null;
  if (saved.type === "freehand" || saved.type === "highlighter") return null;
  const box = getSceneScreenBox(selectedId);
  const handles = dynamicSelectionHandlesForSavedDrawing(
    saved,
    dataToScreen,
    box,
    getSceneScreenHandles(selectedId),
    saved.type === "position" ? getPositionBarSpacing?.() ?? null : null,
  );
  const matched = handles.find((handle) => (
    Math.hypot(handle.point.x - x, handle.point.y - y) <= handle.radius
  ));
  if (!matched) return null;
  return Object.freeze({
    id: selectedId,
    saved,
    type: drawingHitTypeFromSavedDrawing(saved),
    ...matched.hit,
  });
}

function isDrawingEntityHit(hit: DrawingInteractionHit): hit is DrawingEntityHit {
  return "saved" in hit;
}

function drawingInteractionHitId(hit: DrawingInteractionHit): string {
  return isDrawingEntityHit(hit) ? hit.id : hit.prim.id;
}

function savedDrawingFromInteractionHit(
  hit: DrawingInteractionHit,
): SavedDrawing | null {
  if (isDrawingEntityHit(hit)) return hit.saved;
  return serializeDrawingPrimitive(
    hit.prim as unknown as PersistableDrawingPrimitive,
  );
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
  manageChartCursor?: boolean;
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
  drawingChartType: string;
  drawingInterval: string;
  drawingCoordinateKey: string;
  drawingAnchorMode: DrawingAnchorMode;
  interactionSurfaceMode?: DrawingInteractionSurfaceMode;
  dynamicCanvasRef?: MutableRefObject<HTMLCanvasElement | null>;
  liveInkCanvasRef?: MutableRefObject<HTMLCanvasElement | null>;
  onInteractionSurfaceFallback?: (() => void) | null;
  onToolChange?: ((tool: DrawingToolId | null) => void) | null;
}

export interface DrawingCoordinateCleanupBoundary {
  readonly drawingChartType: string;
  readonly drawingInterval: string;
  readonly drawingCoordinateKey: string;
  readonly seriesReady: number;
}

/** Ignore callback-identity rerenders; only a real surface coordinate boundary owns cleanup. */
export function isDrawingCoordinateCleanupBoundaryCurrent(
  boundary: DrawingCoordinateCleanupBoundary | null,
  drawingChartType: string,
  drawingInterval: string,
  drawingCoordinateKey: string,
  seriesReady: number,
): boolean {
  return boundary?.drawingChartType === drawingChartType
    && boundary.drawingInterval === drawingInterval
    && boundary.drawingCoordinateKey === drawingCoordinateKey
    && boundary.seriesReady === seriesReady;
}

/**
 * Chart-type transitions own active-gesture cancellation through the explicit
 * surface-dispose barrier. React layout effects run before the chart owner's
 * passive cleanup, so they must not consume that gesture first. The later
 * series generation remains a fail-safe cleanup if surface disposal cannot run.
 */
export function shouldDeferDrawingCoordinateCleanupToChartTypeBoundary(
  boundary: DrawingCoordinateCleanupBoundary | null,
  drawingChartType: string,
  drawingInterval: string,
): boolean {
  return boundary !== null
    && boundary.drawingChartType !== drawingChartType
    && boundary.drawingInterval === drawingInterval;
}

export interface DrawingExportInteractionLease {
  restore(): void;
}

export interface DrawingExportInteractionAcquisitionCallbacks {
  beginVisibilityLease(): void;
  clearPresentation(): void;
  rollbackFailedAcquisition(): void;
  restoreInteraction(): void;
}

/**
 * Acquire visibility ownership before mutating presentation-only surfaces.
 * If synchronous setup fails before the barrier can retain a presentation,
 * rollback remains owned here so selection/hover state and the gate cannot be
 * stranded in a partially cleared state.
 */
export function acquireDrawingExportInteractionPresentation(
  callbacks: DrawingExportInteractionAcquisitionCallbacks,
): DrawingExportInteractionLease {
  callbacks.beginVisibilityLease();
  try {
    callbacks.clearPresentation();
  } catch (error) {
    try {
      callbacks.rollbackFailedAcquisition();
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "Drawing export interaction acquisition and rollback both failed",
      );
    }
    throw error;
  }

  let restored = false;
  return Object.freeze({
    restore() {
      if (restored) return;
      restored = true;
      callbacks.restoreInteraction();
    },
  });
}

export interface DrawingExportPrepareOptions {
  readonly hideDrawings?: boolean;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface DrawingSurfaceDisposeBoundaryDescriptor {
  readonly kind: "chart-type";
  readonly beforeValue: string;
  readonly afterValue: string;
}

export interface DrawingExportPersistenceState {
  readonly persistedRevision: number;
  readonly writePerformed: boolean;
}

export type DrawingExportLease = DrawingExportBarrierLease<
  DrawingExportPersistenceState,
  DrawingExportSceneReceipt,
  number
>;

export function withDrawingExportCaptureScene(
  lease: DrawingExportLease,
  captureScene: DrawingExportSceneReceipt,
): DrawingExportLease {
  if (captureScene === lease.receipt.scene) return lease;
  return Object.freeze({
    leaseId: lease.leaseId,
    receipt: Object.freeze({ ...lease.receipt, scene: captureScene }),
    revalidate: () => lease.revalidate(),
    restore: () => lease.restore(),
  });
}

interface DrawingExportPresentationState {
  readonly interaction: DrawingExportInteractionLease;
  readonly previousHidden: boolean;
  readonly visibilityChanged: boolean;
  readonly replacementScene: DrawingExportSceneReceipt | null;
}

export interface DrawingInteractionRuntime {
  clearAll(): void;
  completeSurfaceDispose(): void;
  invalidateSurfaceCredentialsForSeriesReplacement(): void;
  prepareSurfaceDispose(boundary?: DrawingSurfaceDisposeBoundaryDescriptor): boolean;
  prepareExport(options?: DrawingExportPrepareOptions): Promise<DrawingExportLease>;
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
  getLegacyPrimitiveRuntimeEvidence(): DrawingLegacyPrimitiveRuntimeEvidence;
}

export interface DrawingPointerRectCache {
  capture(container: Pick<HTMLElement, "getBoundingClientRect">): DOMRect;
  clear(): void;
  peek(): DOMRect | null;
}

interface DrawingPointerRectInvalidationTarget {
  addEventListener(
    type: "resize" | "scroll",
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: "resize" | "scroll",
    listener: EventListener,
    options?: boolean | EventListenerOptions,
  ): void;
}

interface DrawingPointerRectResizeObserver {
  disconnect(): void;
  observe(target: Element): void;
}

export function createDrawingPointerRectCache(): DrawingPointerRectCache {
  let current: DOMRect | null = null;
  return {
    capture(container) {
      current = container.getBoundingClientRect();
      return current;
    },
    clear() {
      current = null;
    },
    peek() {
      return current;
    },
  };
}

function scrollCanMoveDrawingContainer({
  container,
  event,
  eventTarget,
}: {
  container: HTMLElement;
  event: Event;
  eventTarget: DrawingPointerRectInvalidationTarget | null;
}): boolean {
  const target = event.target;
  if (!target) return false;
  const ownerDocument = container.ownerDocument;
  if (target === eventTarget
    || target === ownerDocument
    || target === ownerDocument?.defaultView) {
    return true;
  }
  // Scrolling the chart itself (or one of its descendants) does not move the
  // container's viewport rect. Only a strict scroll ancestor can do that.
  if (target === container) return false;
  const potentialAncestor = target as EventTarget & {
    contains?: (candidate: Node | null) => boolean;
  };
  return typeof potentialAncestor.contains === "function"
    && potentialAncestor.contains(container);
}

/**
 * Refresh pointer geometry at layout boundaries so native pointermove handlers
 * only consume an already-captured rect. Pointerdown still performs its own
 * authoritative capture before starting an interaction.
 */
export function subscribeDrawingPointerRectInvalidation({
  cache,
  container,
  eventTarget = typeof window === "undefined"
    ? null
    : window as unknown as DrawingPointerRectInvalidationTarget,
  createResizeObserver = typeof ResizeObserver === "undefined"
    ? null
    : (listener: ResizeObserverCallback) => new ResizeObserver(listener),
}: {
  cache: DrawingPointerRectCache;
  container: HTMLElement;
  eventTarget?: DrawingPointerRectInvalidationTarget | null;
  createResizeObserver?: ((listener: ResizeObserverCallback) => DrawingPointerRectResizeObserver) | null;
}): () => void {
  let disposed = false;
  const refresh = () => {
    if (!disposed) cache.capture(container);
  };
  const handleResize: EventListener = () => refresh();
  const handleScroll: EventListener = (event) => {
    if (scrollCanMoveDrawingContainer({ container, event, eventTarget })) refresh();
  };
  const resizeObserver = createResizeObserver?.(() => refresh()) ?? null;

  refresh();
  resizeObserver?.observe(container);
  eventTarget?.addEventListener("resize", handleResize);
  // Scroll does not bubble, but a capture listener on window observes scrolls
  // from any ancestor that can move the chart container in viewport space.
  eventTarget?.addEventListener("scroll", handleScroll, true);

  return () => {
    if (disposed) return;
    disposed = true;
    resizeObserver?.disconnect();
    eventTarget?.removeEventListener("resize", handleResize);
    eventTarget?.removeEventListener("scroll", handleScroll, true);
    cache.clear();
  };
}

export function useDrawing({
  chartAdapter,
  chartContainerRef,
  activeTool,
  manageChartCursor = true,
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
  drawingChartType,
  drawingInterval,
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
  const getDynamicFramePresentation = useCallback((): Readonly<{
    barSpacing: number | null;
    currentPrice: number | null;
    themePalette: DrawingFrameThemePalette;
  }> => {
    try {
      const frame = getChartAdapter()?.captureDrawingFrame?.() ?? null;
      return Object.freeze({
        barSpacing: frame?.barSpacing ?? null,
        currentPrice: frame ? drawingPositionCurrentPrice(frame) : null,
        themePalette: frame?.themePalette ?? DEFAULT_DRAWING_POSITION_THEME_PALETTE,
      });
    } catch {
      return Object.freeze({
        barSpacing: null,
        currentPrice: null,
        themePalette: DEFAULT_DRAWING_POSITION_THEME_PALETTE,
      });
    }
  }, [getChartAdapter]);
  const getDynamicThemePalette = useCallback(
    (): DrawingFrameThemePalette => getDynamicFramePresentation().themePalette,
    [getDynamicFramePresentation],
  );
  const notifyDrawingSceneInvalidation = useCallback(() => {
    getChartAdapter()?.notifyDrawingFrameInvalidation?.();
  }, [getChartAdapter]);
  // ── All primitives (lines + freehand strokes + text) ──
  const primitivesRef = useRef<DrawingPrimitive[]>([]); // (LineDrawingPrimitive | FreehandDrawingPrimitive | TextDrawingPrimitive)[]
  const savedDrawingGetterRef = useRef<(id: string) => SavedDrawing | null>(() => null);
  const sceneScreenBoxGetterRef = useRef<(id: string) => ScreenBox | null>(() => null);

  // ── Visibility toggle (hide all without deleting) ──
  const hiddenRef = useRef(false);
  const [exportVisibilityIntentGate] = useState(createDrawingExportVisibilityIntentGate);
  const applyExportVisibilityIntentRef = useRef<((nextHidden: boolean) => void) | null>(null);

  // ── Line-specific state ──
  const previewRef = useRef<TwoPointDrawingPrimitive | null>(null); // LineDrawingPrimitive (dashed preview)
  const previewEntityRef = useRef<SavedDrawing | null>(null);
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
    getSavedDrawingById: (id) => savedDrawingGetterRef.current(id),
    getScreenBoxById: (id) => sceneScreenBoxGetterRef.current(id),
    ...(interactionSurfaceMode === "overlay"
      ? { mutatePrimitiveVisualState: false }
      : { onSelectionChange: notifyDrawingSceneInvalidation }),
  });

  // ── Freehand-specific state ──
  const currentFreehandRef = useRef<FreehandDrawingPrimitive | null>(null); // FreehandDrawingPrimitive being drawn
  const freehandDraftRef = useRef<FreehandStrokeDraft | null>(null); // transient synthetic v2/v3 draft, never persisted
  const freehandCaptureIdentityRef = useRef<unknown>(null); // last successful atomic batch identity
  const freehandEntityStyleRef = useRef<Readonly<{
    tool: "pen" | "highlighter";
    color: string;
    lineWidth: number;
  }> | null>(null);
  const isDrawingFreehandRef = useRef(false);
  const lastFreehandScreenPointRef = useRef<ScreenPoint | null>(null);
  const hoveredPrimRef = useRef<DrawingPrimitive | null>(null);
  const hoverFrameRef = useRef<number>(0);
  const pendingHoverRef = useRef<HoverFeedbackPayload | null>(null);
  const activeMoveFrameRef = useRef<number>(0);
  const pendingActiveMoveRef = useRef<ActiveDrawingMovePayload | null>(null);
  const beforeScopeTransitionRef = useRef<() => boolean>(() => true);
  const pointerRectCacheRef = useRef<DrawingPointerRectCache | null>(null);
  if (!pointerRectCacheRef.current) {
    pointerRectCacheRef.current = createDrawingPointerRectCache();
  }
  const pointerRectCache = pointerRectCacheRef.current;
  const dynamicOverlayControllerRef = useRef<DynamicOverlayController | null>(null);
  const liveInkControllerRef = useRef<LiveInkController | null>(null);
  const renderDynamicFeedbackRef = useRef<() => void>(() => {});
  const dynamicHoverDecorationRef = useRef<DynamicHoverDecoration | null>(null);
  const overlayTimeCaptureIdentityRef = useRef<object>({});
  const activeOverlayEntityIdRef = useRef<string | null>(null);
  const overlayDragEntityDraftRef = useRef<SavedDrawing | null>(null);
  const overlayDragPrimitiveRef = useRef<DrawingPrimitive | null>(null);
  const overlayDragOriginalRef = useRef<DrawingPrimitive | null>(null);
  const overlayDragRegistryRef = useRef<DrawingPrimitive[]>([]);
  const deleteSelectedRef = useRef<() => void>(() => {});
  const dynamicPaintUnsubscribeRef = useRef<(() => void) | null>(null);
  const dynamicHandoffFrameRef = useRef<unknown>(null);
  const dynamicHandoffGenerationRef = useRef(0);
  const dynamicHandoffLockRef = useRef(false);
  const coordinateCleanupBoundaryRef = useRef<DrawingCoordinateCleanupBoundary | null>(null);

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

  // Pointer handlers read these refs synchronously. A passive effect leaves a
  // small post-commit window where the toolbar already shows the new tool but
  // the chart still handles the next pointer with the previous one.
  useLayoutEffect(() => {
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
    if (!manageChartCursor) return;
    const container = chartContainerRef?.current;
    if (!container) return;
    const tool = activeToolRef.current;
    setCursor(
      container,
      isPassiveCursorTool(tool) ? cursorStyleForPassiveTool(tool) : "crosshair",
    );
  }, [chartContainerRef, manageChartCursor]);

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

  const isInsideDrawingPanePlot = useCallback((point: ScreenPoint): boolean => {
    if (interactionSurfaceMode !== "overlay") return true;
    const adapter = getChartAdapter();
    const rect = adapter?.getDrawingPanePlotRect?.() ?? adapter?.getMainPanePlotRect?.();
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
    synchronizeVisibleSceneVisibility,
    persistActiveScopeDrawings,
    persistDetachedDrawings,
    persistSceneCommands,
    persistDrawings,
    prepareSurfaceDispose: preparePersistenceSurfaceDispose,
    prepareUserMutationScope: preparePersistenceUserMutationScope,
    hitTestScene: hitTestPaneScene,
    getSceneScreenBox: getPaneSceneScreenBox,
    getSceneScreenHandles: getPaneSceneScreenHandles,
    getSavedDrawing,
    getLegacyPrimitiveRuntimeEvidence,
    getActiveDocumentTarget,
    flushActiveDocument,
    waitForExactExportScene,
    revalidateExportScene,
    subscribeVisibleScenePaint,
    subscribeVisibleScenePublication,
  } = useDrawingPersistenceLifecycle({
    beforeScopeTransitionRef,
    currentFreehandRef,
    draggingRef,
    getChartAdapter: getDrawingPersistenceAdapter,
    getDrawingSceneAdapter: getChartAdapter,
    hiddenRef,
    activeOverlayEntityIdRef,
    dynamicOverlayEnabled: interactionSurfaceMode === "overlay",
    sceneDocumentOnly: interactionSurfaceMode === "overlay",
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
  const containerToDrawingPaneY = useCallback((y: number): number => {
    const converted = getChartAdapter()?.containerToDrawingPaneY?.(y);
    return typeof converted === "number" && Number.isFinite(converted) ? converted : y;
  }, [getChartAdapter]);
  const drawingPaneToContainerY = useCallback((y: number): number => {
    const converted = getChartAdapter()?.drawingPaneToContainerY?.(y);
    return typeof converted === "number" && Number.isFinite(converted) ? converted : y;
  }, [getChartAdapter]);
  const hitTestScene = useCallback((x: number, y: number) => (
    hitTestPaneScene(x, containerToDrawingPaneY(y))
  ), [containerToDrawingPaneY, hitTestPaneScene]);
  const getSceneScreenBox = useCallback((id: string): ScreenBox | null => {
    const box = getPaneSceneScreenBox(id);
    if (!box) return null;
    const y = drawingPaneToContainerY(box.y);
    return Object.freeze({
      ...box,
      y,
      ...(typeof box.bottom === "number" && Number.isFinite(box.bottom)
        ? { bottom: drawingPaneToContainerY(box.bottom) }
        : {}),
    });
  }, [drawingPaneToContainerY, getPaneSceneScreenBox]);
  const getSceneScreenHandles = useCallback((id: string): readonly ScreenPoint[] | null => {
    const handles = getPaneSceneScreenHandles(id);
    if (!handles) return null;
    return Object.freeze(handles.map((point) => Object.freeze({
      x: point.x,
      y: drawingPaneToContainerY(point.y),
    })));
  }, [drawingPaneToContainerY, getPaneSceneScreenHandles]);
  savedDrawingGetterRef.current = getSavedDrawing;
  sceneScreenBoxGetterRef.current = getSceneScreenBox;
  const prepareUserMutationScope = useCallback((): boolean => (
    !exportVisibilityIntentGate.isLocked() && preparePersistenceUserMutationScope()
  ), [exportVisibilityIntentGate, preparePersistenceUserMutationScope]);

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
    freehandEntityStyleRef.current = null;
    currentFreehandRef.current = null;
    isDrawingFreehandRef.current = false;
    lastFreehandScreenPointRef.current = null;
    liveInkControllerRef.current?.cancel();
    abandonDrawingInteractionLifecycleActiveGesture();
    return true;
  }, [detachPrim]);

  // ── Selection helpers are provided by useDrawingSelection above ──

  const hitTestSelectedOverlayHandle = useCallback((
    x: number,
    y: number,
  ): DrawingEntityHit | null => {
    if (interactionSurfaceMode !== "overlay" || hiddenRef.current) return null;
    const selectedId = selectedIdRef.current;
    if (!selectedId) return null;
    return hitTestSelectedOverlayDrawingHandle({
      selectedId,
      x,
      y,
      getSavedDrawing,
      dataToScreen,
      getSceneScreenBox,
      getSceneScreenHandles,
      getPositionBarSpacing: () => getDynamicFramePresentation().barSpacing,
    });
  }, [dataToScreen, getDynamicFramePresentation, getSavedDrawing, getSceneScreenBox, getSceneScreenHandles, interactionSurfaceMode, selectedIdRef]);

  // ── Hit-test all primitives ──

  const hitTestAll = useCallback(
    (x: number, y: number, hitRadius = 8): DrawingInteractionHit | null => {
      const selectedHandleHit = hitTestSelectedOverlayHandle(x, y);
      if (selectedHandleHit) return selectedHandleHit;
      if (interactionSurfaceMode === "overlay") {
        return hitTestOverlayDrawingEntity(x, y, hitTestScene, getSavedDrawing);
      }
      const legacyHit = hitTestDrawingPrimitives(
        primitivesRef.current,
        x,
        containerToDrawingPaneY(y),
        hitRadius,
        (primitive) => primitive._series !== null,
      );
      const sceneHit = hitTestScene(x, y);
      return resolveTopmostDrawingInteractionHit(primitivesRef.current, legacyHit, sceneHit);
    },
    [containerToDrawingPaneY, getSavedDrawing, hitTestScene, hitTestSelectedOverlayHandle, interactionSurfaceMode],
  );

  const hitTestInteractive = useCallback(
    (x: number, y: number, hitRadius = 8): DrawingInteractionHit | null => {
      const hit = hitTestAll(x, y, hitRadius);
      return hit && supportsDrawingHitType(drawingAnchorMode, hit.type) ? hit : null;
    },
    [drawingAnchorMode, hitTestAll],
  );

  // ── Remove line preview ──

  const removePreview = useCallback(() => {
    if (previewEntityRef.current) {
      previewEntityRef.current = null;
      dynamicOverlayControllerRef.current?.clear();
    }
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
      hasPendingTwoPoint: anchorDataRef.current !== null
        || previewRef.current !== null
        || previewEntityRef.current !== null,
      hasActiveFreehand: isDrawingFreehandRef.current
        || currentFreehandRef.current !== null
        || freehandDraftRef.current !== null,
      removePreview,
      cancelActiveFreehandStroke,
    })) return false;
    return prepareUserMutationScope();
  }, [cancelActiveFreehandStroke, cancelDynamicPaintHandoff, interactionSurfaceMode, prepareUserMutationScope, removePreview]);

  const deferCommittedTextScenePaint = useCallback((
    receipt: DrawingEntityTextCommitReceipt,
    complete: () => void,
  ): (() => void) | null => {
    const ticket = receipt.ticket;
    if (interactionSurfaceMode !== "overlay" || !ticket) return null;
    let cancelled = false;
    let matchedSynchronously = false;
    let unsubscribe: (() => void) | null = null;
    let completionFrame:
      | Readonly<{ kind: "raf"; handle: number }>
      | Readonly<{ kind: "timeout"; handle: ReturnType<typeof setTimeout> }>
      | null = null;
    const cancel = (): void => {
      cancelled = true;
      unsubscribe?.();
      unsubscribe = null;
      if (completionFrame !== null) {
        if (completionFrame.kind === "raf" && typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(completionFrame.handle);
        } else {
          clearTimeout(completionFrame.handle as ReturnType<typeof setTimeout>);
        }
      }
      completionFrame = null;
    };
    const onPainted = (stamp: DrawingEntityTextCommitReceipt["ticket"]): void => {
      if (cancelled || !stamp || !scenePaintCoversDrawingHandoff(ticket, stamp)) return;
      matchedSynchronously = true;
      unsubscribe?.();
      unsubscribe = null;
      const finish = (): void => {
        completionFrame = null;
        if (!cancelled) complete();
      };
      completionFrame = typeof requestAnimationFrame === "function"
        ? Object.freeze({ kind: "raf" as const, handle: requestAnimationFrame(finish) })
        : Object.freeze({ kind: "timeout" as const, handle: setTimeout(finish, 0) });
    };
    unsubscribe = subscribeVisibleScenePaint(onPainted, {
      // An unchanged text commit keeps its document revision. The last
      // replayable paint may still omit the active editor entity, so it must
      // wait for the fresh visibility-only scene paint.
      replayLastPaint: receipt.changed,
    });
    if (matchedSynchronously) {
      unsubscribe();
      unsubscribe = null;
    }
    return cancel;
  }, [interactionSurfaceMode, subscribeVisibleScenePaint]);

  // ── Text editing lifecycle (extracted) ──

  const legacyTextEdit = useDrawingTextEdit({
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
  const entityTextEdit = useDrawingEntityTextEdit({
    beforeTerminalMutation: prepareTerminalTextMutation,
    dataToScreen,
    deselectAll,
    getActiveTool: () => activeToolRef.current,
    getSavedDrawingById: getSavedDrawing,
    getSelectedDrawingId: () => selectedIdRef.current,
    onToolChange: (tool) => onToolChangeRef.current?.(tool),
    persistSceneCommands,
    deferCommittedScenePaint: deferCommittedTextScenePaint,
    refreshSelectedTextUi,
    selectDrawing: selectPrimitive,
    setActiveSceneEntityId: (id) => {
      activeOverlayEntityIdRef.current = id;
      invalidateVisibleScene();
      renderDynamicFeedbackRef.current();
    },
  });
  const activeTextEdit = interactionSurfaceMode === "overlay"
    ? entityTextEdit
    : legacyTextEdit;
  const {
    editingTextId,
    editingTextValue,
    editingTextPos,
    editingTextIdRef,
    editInputRef,
    setEditingTextValue,
    setEditingTextPos,
    commitTextEditing,
    cancelTextEditing: cancelActiveTextEditing,
    completeSurfaceDispose: completeTextSurfaceDispose,
  } = activeTextEdit;
  const startTextEditing = legacyTextEdit.startTextEditing;
  const startEntityTextEditing = entityTextEdit.startTextEditing;
  const cancelTextEditing = useCallback((options?: TextEditingOptions): boolean => {
    if (interactionSurfaceMode === "overlay" && !editingTextIdRef.current) return true;
    return cancelActiveTextEditing(options);
  }, [cancelActiveTextEditing, editingTextIdRef, interactionSurfaceMode]);

  // ── Get mouse position relative to chart container ──

  const getChartPos = useChartPointerPosition(chartContainerRef);

  const getCachedPointerRect = useCallback(
    () => pointerRectCache.peek(),
    [pointerRectCache],
  );
  const capturePointerRect = useCallback(() => {
    const container = chartContainerRef?.current;
    return container ? pointerRectCache.capture(container) : null;
  }, [chartContainerRef, pointerRectCache]);

  useLayoutEffect(() => {
    const container = chartContainerRef?.current;
    if (!container) {
      pointerRectCache.clear();
      return undefined;
    }
    return subscribeDrawingPointerRectInvalidation({ cache: pointerRectCache, container });
  }, [chartContainerRef, drawingCoordinateKey, pointerRectCache, seriesReady]);

  useEffect(() => {
    if (interactionSurfaceMode !== "overlay") return undefined;
    const dynamicCanvas = dynamicCanvasRef?.current ?? null;
    const liveInkCanvas = liveInkCanvasRef?.current ?? null;
    const getPlotRect = () => {
      const adapter = getChartAdapter();
      return adapter?.getDrawingPanePlotRect?.() ?? adapter?.getMainPanePlotRect?.() ?? null;
    };
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
      if (reason === "viewport") dynamicController?.flush();
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
    // matching scene paint (plus one rAF). Passive-feedback React effects must
    // not replace that frame and create a visible gap.
    if (dynamicHandoffLockRef.current) return;
    // Transient geometry has strict visual ownership priority. Scene-paint and
    // selection effects can run between pointer frames; they must repaint the
    // complete detached draft/preview instead of replacing it with an empty
    // frame while the pointer is paused.
    const entityTransient = overlayDragEntityDraftRef.current ?? previewEntityRef.current;
    const transient = overlayDragPrimitiveRef.current ?? previewRef.current;
    if (entityTransient || transient) {
      const presentation = getDynamicFramePresentation();
      const transientDecorations = entityTransient
        ? dynamicDecorationsForSavedDrawingDraft(
            entityTransient,
            dataToScreen,
            presentation.themePalette,
            presentation.currentPrice,
          )
        : dynamicDecorationsForDrawingDraft(
            transient as DrawingPrimitive,
            dataToScreen,
            presentation.themePalette,
            presentation.currentPrice,
          );
      if (transientDecorations.length === 0) {
        dynamicOverlayControllerRef.current?.clear();
      } else {
        dynamicOverlayControllerRef.current?.render({ decorations: transientDecorations });
      }
      return;
    }
    const decorations: DynamicOverlayDecoration[] = [];
    const selectedId = selectedIdRef.current;
    if (selectedId) {
      const selectionBox = getDynamicScreenBox(selectedId);
      const selectedPrimitive = selectedId ? getPrimitiveById(selectedId) : null;
      const saved = selectedId ? getSavedDrawing(selectedId) : null;
      const selectionSaved = saved ?? (selectedPrimitive
        ? serializeDrawingPrimitive(
            selectedPrimitive as unknown as PersistableDrawingPrimitive,
          )
        : null);
      const handles = selectionSaved
        ? dynamicSelectionHandlesForSavedDrawing(
            selectionSaved,
            dataToScreen,
            selectionBox,
            getSceneScreenHandles(selectedId),
            selectionSaved.type === "position"
              ? getDynamicFramePresentation().barSpacing
              : null,
          ).map((handle) => handle.point)
        : [];
      const handleDecoration = dynamicSelectedHandleDecoration(handles);
      if (handleDecoration) decorations.push(handleDecoration);
    }
    decorations.push(...dynamicPassiveFeedbackDecorations({
      getScreenBox: getDynamicScreenBox,
      hover,
      selectedId,
    }));
    if (decorations.length === 0) dynamicOverlayControllerRef.current?.clear();
    else dynamicOverlayControllerRef.current?.render({ decorations });
  }, [dataToScreen, getDynamicFramePresentation, getDynamicScreenBox, getPrimitiveById, getSavedDrawing, getSceneScreenHandles, interactionSurfaceMode, selectedIdRef]);
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
      // Without stable scope + surface credentials there is no paint event
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
        || !scenePaintCoversDrawingHandoff(ticket, stamp)) return;
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
      // A paint ticket is tied to one drawing surface. If that surface's
      // credentials move before acknowledgement, retire the stale
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
    return subscribeVisibleScenePublication(() => {
      renderDynamicFeedback();
      dynamicOverlayControllerRef.current?.flush();
    });
  }, [interactionSurfaceMode, renderDynamicFeedback, subscribeVisibleScenePublication]);

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
      const hoverTarget = hit && !isDrawingEntityHit(hit)
        ? hoverTargetForTool(tool, hit)
        : null;
      if (interactionSurfaceMode === "overlay") {
        hoveredPrimRef.current = null;
        const decoration: DynamicHoverDecoration = {
          id: hit ? drawingInteractionHitId(hit) : null,
          point: { x, y },
          eraser: tool === "eraser",
        };
        dynamicHoverDecorationRef.current = decoration;
        renderDynamicFeedback(decoration);
      } else {
        syncHoveredPrimitive(hoveredPrimRef, hoverTarget);
      }

      const container = chartContainerRef?.current;
      if (!container || !manageChartCursor) return;
      const cursorHit = hit
        && isDrawingEntityHit(hit)
        && hit.saved.type === "axis-line"
        && hit.saved.axisLineType
        ? { ...hit, axisLineType: hit.saved.axisLineType }
        : hit;

      if (isLineToolId(tool)) {
        setCursor(container, cursorForLineToolHit(cursorHit));
      } else if (isShapeToolId(tool)) {
        setCursor(container, cursorForShapeToolHit(cursorHit));
      } else if (isPositionToolId(tool)) {
        setCursor(container, cursorForPositionToolHit(cursorHit));
      } else if (tool === "text") {
        setCursor(container, cursorForTextToolHit(cursorHit));
      }
    },
    [chartContainerRef, hitTestAll, hitTestInteractive, interactionSurfaceMode, manageChartCursor, renderDynamicFeedback],
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
    if (interactionSurfaceMode !== "overlay") invalidateVisibleScene();
    try { getChartAdapter()?.requestSeriesUpdate?.(); } catch { /* scene invalidation remains */ }
    return overlayDragRegistryRef;
  }, [cancelDynamicPaintHandoff, getChartAdapter, interactionSurfaceMode, invalidateVisibleScene, primitivesRef, renderDynamicFeedback]);

  const beginOverlayEntityDrag = useCallback((saved: SavedDrawing): boolean => {
    if (interactionSurfaceMode !== "overlay" || !saved.id || !draggingRef.current) return false;
    overlayDragEntityDraftRef.current = saved;
    activeOverlayEntityIdRef.current = saved.id;
    cancelDynamicPaintHandoff();
    invalidateVisibleScene();
    renderDynamicFeedback();
    return true;
  }, [cancelDynamicPaintHandoff, interactionSurfaceMode, invalidateVisibleScene, renderDynamicFeedback]);

  const renderOverlayDragDraft = useCallback(() => {
    const entityDraft = overlayDragEntityDraftRef.current;
    const presentation = getDynamicFramePresentation();
    if (entityDraft && interactionSurfaceMode === "overlay") {
      dynamicOverlayControllerRef.current?.render({
        decorations: dynamicDecorationsForSavedDrawingDraft(
          entityDraft,
          dataToScreen,
          presentation.themePalette,
          presentation.currentPrice,
        ),
      });
      return;
    }
    const draft = overlayDragPrimitiveRef.current;
    if (!draft || interactionSurfaceMode !== "overlay") return;
    const decorations = dynamicDecorationsForDrawingDraft(
      draft,
      dataToScreen,
      presentation.themePalette,
      presentation.currentPrice,
    );
    dynamicOverlayControllerRef.current?.render({ decorations });
  }, [dataToScreen, getDynamicFramePresentation, interactionSurfaceMode]);

  const releaseOverlayDrag = useCallback((restoreStatic: boolean, clearDynamic = true) => {
    const original = overlayDragOriginalRef.current;
    if (restoreStatic) original?.setHidden?.(false, false);
    activeOverlayEntityIdRef.current = null;
    overlayDragEntityDraftRef.current = null;
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
      if ((tool === "pen" || tool === "highlighter")
        && isDrawingFreehandRef.current
        && (currentFreehandRef.current || freehandDraftRef.current)) {
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
            } else {
              const primitive = currentFreehandRef.current;
              if (!primitive?.appendPreviewPoints(appendResult.previewPoints)) {
                cancelActiveFreehandStroke();
                return true;
              }
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

        const primitive = currentFreehandRef.current;
        if (!primitive) {
          cancelActiveFreehandStroke();
          return true;
        }
        for (const point of accepted) {
          const dataPoint = screenToFreehandData(point.x, point.y);
          if (!dataPoint) continue;
          primitive.addPoint(dataPoint);
          if (interactionSurfaceMode === "overlay") {
            liveInkControllerRef.current?.appendFrame([point]);
          }
          lastFreehandScreenPointRef.current = { x: point.x, y: point.y };
        }
        return true;
      }

      // ── Drag/resize of existing text & position drawings (extracted) ──
      const entityDraft = interactionSurfaceMode === "overlay"
        ? overlayDragEntityDraftRef.current
        : null;
      if (draggingRef.current && entityDraft) {
        const next = applyDrawingEntityDrag({
          descriptor: draggingRef.current,
          drawing: entityDraft,
          pos,
          screenToData,
          dataToScreen,
          screenToDrawingData,
          snap: drawingSnapEnabledRef.current && !e.altKey,
        });
        if (next) {
          overlayDragEntityDraftRef.current = next;
          renderOverlayDragDraft();
        }
        return true;
      }

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

        if (interactionSurfaceMode === "overlay"
          && isTwoPointCreationTool(tool)
          && anchorDataRef.current
          && previewEntityRef.current) {
          const isShape = SHAPE_TOOL_IDS.has(tool);
          const target = isShape && e.shiftKey
            ? constrainShapeScreenPoint(dataToScreen(anchorDataRef.current), pos)
            : pos;
          const dataB = screenToDrawingData(target.x, target.y, {
            snap: drawingSnapEnabledRef.current && !e.altKey && !(isShape && e.shiftKey),
          });
          if (dataB) {
            previewEntityRef.current = Object.freeze({
              ...previewEntityRef.current,
              dataPoints: Object.freeze([
                Object.freeze({ ...anchorDataRef.current }),
                Object.freeze({ ...dataB }),
              ]),
            }) as SavedDrawing;
            renderDynamicFeedback();
          }
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
    [cancelActiveFreehandStroke, captureOverlayFreehandBatch, ensureOverlayDragRegistry, getChartAdapter, interactionSurfaceMode, renderDynamicFeedback, renderOverlayDragDraft, screenToFreehandData, screenToData, dataToScreen, screenToDrawingData, refreshSelectedTextUi, chartContainerRef],
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
        releaseOverlayDrag(true);
        draggingRef.current = null;
      } else {
        const commands = drawingCommandsForDrag(primitivesRef.current, committedDrag);
        if (!commands || persistActiveScopeDrawings(commands) === false) return false;
      }
    }
    const hadActiveFreehand = currentFreehandRef.current !== null
      || freehandDraftRef.current !== null
      || isDrawingFreehandRef.current;
    if (hadActiveFreehand && !cancelActiveFreehandStroke()) return false;
    if (!removePreview()) return false;
    // The backing primitive of a newly-created text annotation is deliberately
    // empty until confirmation. Cancel it before persistence snapshots the old
    // scope so it is detached as well as excluded by the canonical filter.
    return cancelTextEditing();
  }, [cancelActiveFreehandStroke, cancelActiveMoveFrame, cancelTextEditing, flushActiveDrawingMove, interactionSurfaceMode, persistActiveScopeDrawings, releaseOverlayDrag, removePreview]);

  useEffect(() => {
    beforeScopeTransitionRef.current = prepareDrawingScopeTransition;
    return () => {
      beforeScopeTransitionRef.current = () => true;
    };
  }, [prepareDrawingScopeTransition]);

  const cancelActiveDrawingMove = useCallback(() => {
    cancelActiveMoveFrame();
    pendingActiveMoveRef.current = null;
  }, [cancelActiveMoveFrame]);

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

  useLayoutEffect(() => {
    const previousBoundary = coordinateCleanupBoundaryRef.current;
    if (isDrawingCoordinateCleanupBoundaryCurrent(
      previousBoundary,
      drawingChartType,
      drawingInterval,
      drawingCoordinateKey,
      seriesReady,
    )) return;
    const chartTypeBoundaryOwned = shouldDeferDrawingCoordinateCleanupToChartTypeBoundary(
      previousBoundary,
      drawingChartType,
      drawingInterval,
    );
    coordinateCleanupBoundaryRef.current = Object.freeze({
      drawingChartType,
      drawingInterval,
      drawingCoordinateKey,
      seriesReady,
    });
    if (!seriesReady || chartTypeBoundaryOwned) return;

    const hadActiveFreehand = currentFreehandRef.current !== null
      || freehandDraftRef.current !== null
      || isDrawingFreehandRef.current;
    const coordinateBoundaryMarked = hadActiveFreehand
      && previousBoundary !== null
      && previousBoundary.drawingCoordinateKey !== drawingCoordinateKey
      && previousBoundary.drawingInterval !== drawingInterval
      && markDrawingInteractionLifecycleBoundaryChange({
        kind: "interval",
        beforeValue: previousBoundary.drawingInterval,
        afterValue: drawingInterval,
      }) !== null;

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

    const freehandCancelled = cancelActiveFreehandStroke();
    if (coordinateBoundaryMarked) {
      if (freehandCancelled) {
        completeDrawingInteractionLifecycleBoundaryCancellation("coordinate-change");
      } else {
        rollbackDrawingInteractionLifecycleBoundaryChange();
      }
    }
  }, [
    cancelActiveDrawingMove,
    cancelTextEditing,
    clearHoverFeedback,
    deselectAll,
    drawingChartType,
    drawingInterval,
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

  // Keep unmount cleanup current without making every callback identity change
  // behave like an unmount. The old cleanup-only effect depended on these
  // callbacks, so selecting an entity re-rendered the hook and synchronously
  // cleared the drag descriptor before the first pointermove could consume it.
  const interactionUnmountCleanupRef = useRef<() => void>(() => {});
  useEffect(() => {
    interactionUnmountCleanupRef.current = () => {
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
      if (manageChartCursor) setCursor(chartContainerRef?.current, "default");
    };
  }, [
    cancelActiveDrawingMove,
    cancelActiveFreehandStroke,
    chartContainerRef,
    clearHoverFeedback,
    removePreview,
    flushActiveDrawingMove,
    interactionSurfaceMode,
    manageChartCursor,
    persistDrawings,
    releaseOverlayDrag,
  ]);
  useEffect(() => () => {
    interactionUnmountCleanupRef.current();
  }, []);

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

  const beginSavedTextDrag = useCallback((
    saved: SavedDrawing,
    hit: DrawingHit | false | null,
    pos: ScreenPoint | null,
  ): boolean => {
    if (saved.type !== "text" || !saved.id || !saved.dataPoint || !hit || !pos) return false;
    const box = getSceneScreenBox(saved.id);
    if (hit.handle && box) {
      draggingRef.current = {
        id: saved.id,
        type: "text-handle",
        handle: hit.handle,
        startMouse: pos,
        origBox: box,
        origFontSize: saved.fontSize || 14,
        origWidthPx: saved.widthPx ?? null,
        origDataPoint: { ...saved.dataPoint },
      };
    } else {
      draggingRef.current = {
        id: saved.id,
        type: "text",
        startMouse: pos,
        origDataPoint: { ...saved.dataPoint },
      };
    }
    return beginOverlayEntityDrag(saved);
  }, [beginOverlayEntityDrag, getSceneScreenBox]);

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
      const saved = interactionSurfaceMode === "overlay"
        ? getSavedDrawing(activeId)
        : null;
      const dataPoint = prim instanceof TextDrawingPrimitive
        ? prim.dataPoint
        : saved?.type === "text" ? saved.dataPoint : null;
      if (dataPoint) {
        const sp = dataToScreen(dataPoint);
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
    getSavedDrawing,
    interactionSurfaceMode,
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
      // Establish one geometry snapshot for the interaction. Every pane host
      // shares this chart container, so the following document-level samples
      // can reuse the stable rect instead of entering layout again.
      const pos = getChartPos(e, capturePointerRect());
      if (!pos) return;
      if (!isInsideDrawingPanePlot(pos)) return;
      if (interactionSurfaceMode === "overlay") cancelDynamicPaintHandoff(true);
      if (liveInkControllerRef.current?.snapshot().retainingFinalFrame) {
        liveInkControllerRef.current.cancel();
      }

      if (!runDrawingPointerTransientBarrier({
        activeTool: tool,
        pendingTwoPointTool: pendingTwoPointToolRef.current,
        hasPendingTwoPoint: anchorDataRef.current !== null
          || previewRef.current !== null
          || previewEntityRef.current !== null,
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
      let passiveCursorInteractiveHit: DrawingInteractionHit | null | undefined;

      // Editing text owns the next chart click. Commit through the same path
      // for blank clicks, text clicks, and text-tool clicks so blur does not
      // become a separate hidden state transition.
      if (editingTextIdRef.current) {
        const hit = hitTestInteractive(pos.x, pos.y);
        const clickedTextId = hit?.type === "text" ? drawingInteractionHitId(hit) : null;
        commitTextEditing({ clearSelection: !clickedTextId, exitTool: true });
        if (clickedTextId && (interactionSurfaceMode === "overlay"
          ? getSavedDrawing(clickedTextId) !== null
          : primitivesRef.current.some((p) => p.id === clickedTextId))) {
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
        const savedSelection = interactionSurfaceMode === "overlay"
          ? getSavedDrawing(selectedIdRef.current)
          : null;
        if (sel instanceof TextDrawingPrimitive || savedSelection?.type === "text") {
          if (supportsDrawingHitType(drawingAnchorMode, "text")) {
            let hit: DrawingHit | false = false;
            const overlayHandleHit = hitTestSelectedOverlayHandle(pos.x, pos.y);
            if (overlayHandleHit) hit = overlayHandleHit;
            else if (sel instanceof TextDrawingPrimitive) {
              try { hit = sel.hitTestGeometry(pos.x, pos.y); } catch { /* ignore */ }
            }
            if (hit) {
              clearHoverFeedback();
              if (savedSelection?.type === "text") beginSavedTextDrag(savedSelection, hit, pos);
              else if (sel) beginTextDrag(sel, hit, pos);
              e.preventDefault();
              e.stopPropagation();
              return;
            }
          }
          // Clicked outside the selected text → drop selection.
          deselectAll();
        } else if (sel || savedSelection) {
          const selectedId = sel?.id ?? savedSelection?.id;
          if (!selectedId) {
            deselectAll();
            passiveCursorInteractiveHit = null;
          } else {
            passiveCursorInteractiveHit = resolvePassiveCursorSelectedNonTextHit({
              selectedId,
              hitTest: () => hitTestAll(pos.x, pos.y),
              hitId: drawingInteractionHitId,
              supportsHitType: (type) => supportsDrawingHitType(drawingAnchorMode, type),
              deselect: deselectAll,
            });
          }
        }
      }

      // ── ERASER: click to delete ──
      if (tool === "eraser") {
        const hit = hitTestAll(pos.x, pos.y);
        clearHoverFeedback();
        if (interactionSurfaceMode === "overlay" && hit) {
          const id = drawingInteractionHitId(hit);
          const receipt = persistSceneCommands([Object.freeze({ type: "delete", id })]);
          if (receipt?.committed && selectedIdRef.current === id) {
            selectedIdRef.current = null;
            setSelectedPrimId(null);
            setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
          }
        } else if (!hit || !isDrawingEntityHit(hit)) {
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
        if (interactionSurfaceMode === "overlay") {
          e.preventDefault();
          e.stopPropagation();
          if (!captureBatch) return;
          const draft = createFreehandStrokeDraft({
            sourceProjection: captureBatch.sourceProjection,
            sourceProjectionConfig: captureBatch.sourceProjectionConfig,
            captureIdentity: captureBatch.captureIdentity,
          });
          if (!draft || !appendFreehandStrokeCaptureBatch(draft, captureBatch)) {
            if (draft) cancelFreehandStrokeDraft(draft);
            return;
          }
          freehandDraftRef.current = draft;
          freehandCaptureIdentityRef.current = captureBatch.captureIdentity;
          freehandEntityStyleRef.current = Object.freeze({
            tool,
            color: penColorRef.current,
            lineWidth: penSizeRef.current,
          });
          isDrawingFreehandRef.current = true;
          const isHighlighter = tool === "highlighter";
          const started = liveInkControllerRef.current?.start({
            color: penColorRef.current,
            lineWidth: penSizeRef.current,
            opacity: isHighlighter ? DEFAULT_HIGHLIGHTER_OPACITY : 1,
            tool,
            blendMode: isHighlighter
              ? DEFAULT_HIGHLIGHTER_COMPOSITE_OPERATION
              : "source-over",
            brushShape: isHighlighter ? DEFAULT_HIGHLIGHTER_BRUSH_SHAPE : "round",
          }, pos) === true;
          if (!started) {
            cancelActiveFreehandStroke();
            return;
          }
          beginDrawingInteractionLifecycleFreehandGesture();
          lastFreehandScreenPointRef.current = { x: pos.x, y: pos.y };
          clearHoverFeedback();
          return;
        }
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
          const id = drawingInteractionHitId(hit);
          selectPrimitive(id);
          clearHoverFeedback();
          if (isDrawingEntityHit(hit)) beginSavedTextDrag(hit.saved, hit, pos);
          else beginTextDrag(hit.prim, hit, pos);
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // Deselect if something was selected
        if (selectedIdRef.current) {
          deselectAll();
        }

        // Place new text
        if (interactionSurfaceMode === "overlay") {
          e.preventDefault();
          e.stopPropagation();
          const dataPoint = screenToDrawingData(pos.x, pos.y, {
            snap: drawingSnapEnabledRef.current && !e.altKey,
          });
          if (!dataPoint) return;
          const saved = createTextSavedDrawing({
            dataPoint,
            color: penColorRef.current,
            fontSize: textFontSizeRef.current || 14,
            bold: textBoldRef.current || false,
            italic: textItalicRef.current || false,
          });
          if (!saved) return;
          if (!startEntityTextEditing(saved, { isNew: true, screenPoint: pos })) {
            cancelTextEditing({ clearSelection: true, exitTool: false });
          }
          return;
        }
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
          const saved = savedDrawingFromInteractionHit(hit);
          const id = saved?.id;
          const entryPrice = saved?.type === "position" ? saved.entryPrice : null;
          const timeRange = saved?.type === "position" ? saved.timeRange : null;
          if (!saved
            || saved.type !== "position"
            || !id
            || typeof entryPrice !== "number"
            || !Number.isFinite(entryPrice)
            || !timeRange) return;
          selectPrimitive(id);

          // Start dragging TP or SL handle
          if (hit.zone === "tp") {
            draggingRef.current = {
              id,
              type: "position-tp",
              startMouse: pos,
              origTpPrice: saved.tpPrice ?? null,
            };
          } else if (hit.zone === "sl") {
            draggingRef.current = {
              id,
              type: "position-sl",
              startMouse: pos,
              origSlPrice: saved.slPrice ?? null,
            };
          } else if (hit.zone === "entry" || hit.zone === "body") {
            // Drag the whole position
            draggingRef.current = {
              id,
              type: "position-move",
              startMouse: pos,
              origEntry: entryPrice,
              origTp: saved.tpPrice ?? null,
              origSl: saved.slPrice ?? null,
              origTimeRange: { ...timeRange },
            };
          } else if (hit.zone === "panel") {
            draggingRef.current = {
              id,
              type: "position-panel",
              startMouse: pos,
              origInfoPanelOffset: { ...(saved.infoPanelOffset ?? { x: 10, y: 10 }) },
            };
          } else if (hit.zone === "left") {
            draggingRef.current = {
              id,
              type: "position-left",
              startMouse: pos,
              origTimeRange: { ...timeRange },
            };
          } else if (hit.zone === "right") {
            draggingRef.current = {
              id,
              type: "position-right",
              startMouse: pos,
              origTimeRange: { ...timeRange },
            };
          }

          if (interactionSurfaceMode === "overlay" && draggingRef.current) {
            if (isDrawingEntityHit(hit)) beginOverlayEntityDrag(saved);
            else ensureOverlayDragRegistry();
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
        if (interactionSurfaceMode === "overlay") {
          e.preventDefault();
          e.stopPropagation();
          const dataPoint = screenToDrawingData(pos.x, pos.y, {
            snap: drawingSnapEnabledRef.current && !e.altKey,
          });
          if (!dataPoint) return;
          const adapter = getChartAdapter();
          const timeRange = positionTimeRangeFromScreen({
            dataPoint,
            pos,
            screenToDrawingData,
            chartContainerRef,
            adapter,
          });
          if (!timeRange) return;
          let visiblePriceRange: number | null = null;
          try {
            const height = chartContainerRef.current?.clientHeight || 400;
            const candidate = adapter?.getVisiblePriceRange?.(height);
            visiblePriceRange = typeof candidate === "number" && Number.isFinite(candidate)
              ? candidate
              : null;
          } catch { /* use entry-relative defaults */ }
          const saved = createPositionSavedDrawing({
            tool,
            dataPoint,
            timeRange,
            visiblePriceRange,
            positionSize: positionSizeRef.current,
          });
          const commands = drawingCreateCommandsForSavedDrawing(saved);
          if (!saved?.id || !commands) return;
          const dynamicPresentation = getDynamicFramePresentation();
          let receipt: ReturnType<typeof persistSceneCommands>;
          try {
            receipt = commitSavedDrawingAfterDynamicFrame(
              saved,
              dataToScreen,
              (decorations) => {
                const controller = dynamicOverlayControllerRef.current;
                if (!controller) return;
                controller.render({ decorations });
                dynamicHandoffLockRef.current = true;
              },
              () => persistSceneCommands(commands),
              dynamicPresentation.themePalette,
              dynamicPresentation.currentPrice,
            );
          } catch (error) {
            dynamicHandoffLockRef.current = false;
            renderDynamicFeedback();
            throw error;
          }
          if (!receipt?.committed) {
            dynamicHandoffLockRef.current = false;
            renderDynamicFeedback();
            return;
          }
          selectPrimitive(saved.id);
          retainDynamicOverlayUntilPaint(receipt.ticket ?? null);
          return;
        }

        if (placePositionDrawing({
          tool, pos, e, primitivesRef,
          attachPrim,
          detachPrim,
          selectPrimitive, persistDrawings,
          screenToDrawingData, getChartAdapter, chartContainerRef, drawingSnapEnabledRef, positionSizeRef,
        })) {
          return;
        }
      }

      // ── LINE/FIB/SHAPE TOOLS ──
      if (isTwoPointCreationTool(tool) || isAxisLineToolId(tool)) {
        const isAxisLineTool = isAxisLineToolId(tool);

        // Second click — commit new line/fib/shape
        if (isTwoPointCreationTool(tool)) {
          if (interactionSurfaceMode === "overlay"
            && anchorDataRef.current
            && previewEntityRef.current) {
            e.preventDefault();
            e.stopPropagation();
            const anchor = anchorDataRef.current;
            const isShape = SHAPE_TOOL_IDS.has(tool);
            const target = isShape && e.shiftKey
              ? constrainShapeScreenPoint(dataToScreen(anchor), pos)
              : pos;
            const dataB = screenToDrawingData(target.x, target.y, {
              snap: drawingSnapEnabledRef.current && !e.altKey && !(isShape && e.shiftKey),
            });
            if (!dataB) return;
            const finalDrawing = Object.freeze({
              ...previewEntityRef.current,
              dataPoints: Object.freeze([
                Object.freeze({ ...anchor }),
                Object.freeze({ ...dataB }),
              ]),
            }) as SavedDrawing;
            const commands = drawingCreateCommandsForSavedDrawing(finalDrawing);
            if (!commands || !finalDrawing.id) return;
            // The click can land after the last pointermove. Publish the exact
            // committed endpoint before the static scene is invalidated so the
            // retained dynamic frame never shows stale preview geometry.
            previewEntityRef.current = finalDrawing;
            let receipt: ReturnType<typeof persistSceneCommands>;
            try {
              receipt = commitSavedDrawingAfterDynamicFrame(
                finalDrawing,
                dataToScreen,
                (decorations) => {
                  const controller = dynamicOverlayControllerRef.current;
                  if (!controller) return;
                  controller.render({ decorations });
                  dynamicHandoffLockRef.current = true;
                },
                () => persistSceneCommands(commands),
                getDynamicThemePalette(),
              );
            } catch (error) {
              dynamicHandoffLockRef.current = false;
              renderDynamicFeedback();
              throw error;
            }
            if (!receipt?.committed) {
              dynamicHandoffLockRef.current = false;
              renderDynamicFeedback();
              return;
            }
            previewEntityRef.current = null;
            anchorDataRef.current = null;
            pendingTwoPointToolRef.current = null;
            selectPrimitive(finalDrawing.id);
            retainDynamicOverlayUntilPaint(receipt.ticket ?? null);
            return;
          }
          if (interactionSurfaceMode !== "overlay") {
            const handled = commitTwoPointDrawing({
              tool, pos, e, primitivesRef, anchorDataRef, previewRef,
              attachPrim,
              detachPrim,
              selectPrimitive, persistDrawings,
              screenToDrawingData, dataToScreen, drawingSnapEnabledRef,
              penColorRef, penSizeRef, fibLevelsRef, fibInvertedRef,
            });
            if (handled) {
              if (!previewRef.current && !anchorDataRef.current) {
                pendingTwoPointToolRef.current = null;
              }
              return;
            }
          }
        }

        // Hit existing element?
        const hit = hitTestInteractive(pos.x, pos.y);
        if (hit && (hit.type === "line" || hit.type === "axis-line" || hit.type === "angle" || hit.type === "fibonacci" || hit.type === "shape")) {
          const saved = savedDrawingFromInteractionHit(hit);
          const id = saved?.id;
          if (!saved || !id) return;
          selectPrimitive(id);

          if (hit.type === "axis-line") {
            const originalDataPoint = saved.type === "axis-line" ? saved.dataPoint : null;
            if (!originalDataPoint) return;
            draggingRef.current = {
              id,
              type: "axis-line",
              zone: hit.zone || "body",
              startMouse: pos,
              origDataPoint: { ...originalDataPoint },
            };
          } else if (hit.type === "shape") {
            if (saved.type !== "shape" || !saved.dataPoints?.length) return;
            draggingRef.current = {
              id,
              type: "shape",
              zone: hit.zone || "body",
              startMouse: pos,
              origPoints: saved.dataPoints.map((point) => ({ ...point })),
              origBox: (!isDrawingEntityHit(hit)
                ? hit.prim.getBoundingBoxScreen?.()
                : null) || getSceneScreenBox(id),
            };
          } else if ((hit.pointIndex ?? -1) >= 0) {
            const dataPoints = "dataPoints" in saved ? saved.dataPoints : null;
            if (!dataPoints?.length) return;
            // Start dragging endpoint
            draggingRef.current = {
              id,
              type: hit.type,
              pointIndex: hit.pointIndex ?? -1,
              startMouse: pos,
              origPoints: dataPoints.map((point) => ({ ...point })),
            };
          } else {
            const dataPoints = "dataPoints" in saved ? saved.dataPoints : null;
            if (!dataPoints?.length) return;
            // Start dragging entire line/fib
            draggingRef.current = {
              id,
              type: hit.type,
              pointIndex: -1,
              startMouse: pos,
              origPoints: dataPoints.map((point) => ({ ...point })),
            };
          }

          if (interactionSurfaceMode === "overlay" && draggingRef.current) {
            if (isDrawingEntityHit(hit)) beginOverlayEntityDrag(saved);
            else ensureOverlayDragRegistry();
          }

          clearHoverFeedback();
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        if (hit && hit.type === "text") {
          const saved = savedDrawingFromInteractionHit(hit);
          if (!saved?.id || saved.type !== "text" || !saved.dataPoint) return;
          selectPrimitive(saved.id);
          draggingRef.current = {
            id: saved.id,
            type: "text",
            startMouse: pos,
            origDataPoint: { ...saved.dataPoint },
          };
          if (interactionSurfaceMode === "overlay") {
            if (isDrawingEntityHit(hit)) beginOverlayEntityDrag(saved);
            else ensureOverlayDragRegistry();
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

        // One-point axis lines: click creates immediately; drag before mouseup adjusts it.
        if (isAxisLineTool) {
          if (interactionSurfaceMode === "overlay") {
            e.preventDefault();
            e.stopPropagation();
            if (!removePreview()) return;
            const axisLineType = axisLineTypeFromTool(tool);
            const dataPoint = screenToDrawingData(pos.x, pos.y, {
              snap: drawingSnapEnabledRef.current && !e.altKey,
              time: axisLineType !== "horizontal",
              price: axisLineType !== "vertical",
            });
            if (!dataPoint) return;
            const saved = createAxisLineSavedDrawing({
              tool,
              dataPoint,
              color: penColorRef.current,
              lineWidth: penSizeRef.current,
            });
            const commands = drawingCreateCommandsForSavedDrawing(saved);
            if (!saved?.id || !commands) return;
            const receipt = persistSceneCommands(commands);
            if (!receipt?.committed) return;
            selectPrimitive(saved.id);
            draggingRef.current = {
              id: saved.id,
              type: "axis-line",
              zone: "center",
              startMouse: pos,
              origDataPoint: { ...dataPoint },
            };
            beginOverlayEntityDrag(saved);
            renderOverlayDragDraft();
            return;
          }
          if (beginAxisLineDrawing({
            tool, pos, e, primitivesRef, anchorDataRef, previewRef, draggingRef,
            attachPrim,
            detachPrim,
            selectPrimitive, persistDrawings, removePreview, screenToDrawingData,
            drawingSnapEnabledRef, penColorRef, penSizeRef,
          })) {
            return;
          }
        }

        // First click — set anchor
        if (isTwoPointCreationTool(tool)) {
          if (interactionSurfaceMode === "overlay") {
            e.preventDefault();
            e.stopPropagation();
            const dataPoint = screenToDrawingData(pos.x, pos.y, {
              snap: drawingSnapEnabledRef.current && !e.altKey,
            });
            if (!dataPoint) return;
            const saved = createTwoPointSavedDrawing({
              tool,
              dataPoints: [dataPoint, dataPoint],
              color: penColorRef.current,
              lineWidth: penSizeRef.current,
              fibLevels: fibLevelsRef.current,
              fibInverted: fibInvertedRef.current,
            });
            if (!saved) return;
            anchorDataRef.current = dataPoint;
            previewEntityRef.current = saved;
            pendingTwoPointToolRef.current = tool;
            renderDynamicFeedback();
            return;
          }
          const handled = beginTwoPointDrawing({
            tool, pos, e, anchorDataRef, previewRef, attachPrim, screenToDrawingData,
            drawingSnapEnabledRef, penColorRef, penSizeRef, fibLevelsRef, fibInvertedRef,
          });
          if (handled) {
            pendingTwoPointToolRef.current = previewRef.current ? tool : null;
            return;
          }
          dynamicHandoffLockRef.current = false;
        }
      }

      // Passive cursor mode is also the neutral selection entry point for
      // committed scene entities. In particular, freehand/highlighter have no
      // creation-tool hit branch (a pen pointerdown must remain a new stroke),
      // so without this path their public style toolbar was unreachable.
      if (isPassiveCursorTool(tool)) {
        const hit = passiveCursorInteractiveHit === undefined
          ? hitTestInteractive(pos.x, pos.y)
          : passiveCursorInteractiveHit;
        if (hit) {
          selectPrimitive(drawingInteractionHitId(hit));
          clearHoverFeedback();
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    },
    [flushActiveDrawingMove, capturePointerRect, getChartPos, isInsideDrawingPanePlot, captureOverlayFreehandBatch, interactionSurfaceMode, screenToFreehandData, screenToDrawingData, dataToScreen, detachPrim, attachPrim, hitTestAll, hitTestInteractive, hitTestSelectedOverlayHandle, selectPrimitive, deselectAll, getPrimitiveById, getSavedDrawing, getSceneScreenBox, beginOverlayEntityDrag, beginSavedTextDrag, beginTextDrag, startEntityTextEditing, startTextEditing, commitTextEditing, cancelTextEditing, persistDrawings, persistSceneCommands, prepareUserMutationScope, removePreview, cancelActiveFreehandStroke, cancelDynamicPaintHandoff, ensureOverlayDragRegistry, getChartAdapter, getDynamicFramePresentation, getDynamicThemePalette, chartContainerRef, drawingAnchorMode, editingTextIdRef, selectedIdRef, setSelectedPrimId, setSelectedTextUi, clearHoverFeedback, renderDynamicFeedback, renderOverlayDragDraft, retainDynamicOverlayUntilPaint],
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
        if (isDrawingEntityHit(hit)) {
          if (hit.saved.type === "text") startEntityTextEditing(hit.saved);
        } else {
          startTextEditing(hit.prim);
        }
        e.preventDefault();
        e.stopPropagation();
      }
    },
    [getChartPos, hitTestInteractive, prepareTerminalTextMutation, startEntityTextEditing, startTextEditing],
  );

  // ════════════════════════════════════════════════════
  //  MOUSE MOVE
  // ════════════════════════════════════════════════════

  const handleMouseMove = useCallback(
    (e: DrawingDomPointerEvent) => {
      const tool = activeToolRef.current;
      const hasFreehandMove = (tool === "pen" || tool === "highlighter")
        && isDrawingFreehandRef.current
        && (currentFreehandRef.current || freehandDraftRef.current);
      const hasDragMove = !!draggingRef.current;
      const hasPreviewMove = (isTwoPointCreationTool(tool) || isAxisLineToolId(tool))
        && anchorDataRef.current
        && (previewRef.current || previewEntityRef.current);

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

      // Passive cursor movement is delivered to every pane host. Reusing the
      // interaction rect removes O(panes) forced DOM layout reads from every
      // native pointer sample while preserving pane-local coordinate gates.
      const pos = getChartPos(e, getCachedPointerRect());
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
    let completedFreehandDrawing: SavedDrawing | null = null;
    let completedDragCandidates: readonly DrawingPrimitive[] | null = null;
    let completedEntityDragDraft: SavedDrawing | null = null;
    // End freehand drawing
    if (isDrawingFreehandRef.current) {
      // ── Decimate stroke via RDP to reduce render cost ──
      const prim = currentFreehandRef.current;
      const draft = freehandDraftRef.current;
      let committed = false;
      const finalizeStartedAt = drawingPerfNow();
      if (interactionSurfaceMode === "overlay" && draft) {
        const stroke = finalizeFreehandStrokeDraft(draft, {
          captureIdentity: freehandCaptureIdentityRef.current,
          epsilon: 1.5,
        });
        const style = freehandEntityStyleRef.current;
        completedFreehandDrawing = stroke && style
          ? style.tool === "pen"
            ? createFinalizedFreehandSavedDrawing({
                tool: "pen",
                stroke,
                color: style.color,
                lineWidth: style.lineWidth,
              })
            : createFinalizedFreehandSavedDrawing({
                tool: "highlighter",
                stroke,
                color: style.color,
                lineWidth: style.lineWidth,
              })
          : null;
        commands = drawingCreateCommandsForSavedDrawing(completedFreehandDrawing);
        committed = !!completedFreehandDrawing && !!commands;
      } else if (prim && draft) {
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
      if (committed && prim && interactionSurfaceMode !== "overlay") {
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
      if (committed && (prim || completedFreehandDrawing)) {
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
      completedEntityDragDraft = interactionSurfaceMode === "overlay"
        ? overlayDragEntityDraftRef.current
        : null;
      if (completedEntityDragDraft) {
        commands = drawingCommandsForSavedDrawing(completedEntityDragDraft, {
          type: "update",
          geometryCommand: drawingEntityGeometryCommandForDrag(committedDrag),
        });
      } else {
        completedDragCandidates = interactionSurfaceMode === "overlay"
          && overlayDragPrimitiveRef.current
          ? overlayDragRegistryRef.current
          : primitivesRef.current;
        commands = drawingCommandsForDrag(completedDragCandidates, committedDrag);
      }
      completedDrag = true;
      completedDragDescriptor = committedDrag;
    }
    let persisted = !commands && !completedDrag;
    if (commands) {
      try {
        if (interactionSurfaceMode === "overlay"
          && completedFreehand
          && (completedFreehandDrawing || completedFreehandPrimitive)) {
          liveInkControllerRef.current?.finish();
          const commitStartedAt = drawingPerfNow();
          const receipt = completedFreehandDrawing
            ? persistSceneCommands(commands)
            : persistDetachedDrawings(commands, primitivesRef.current);
          drawingPerfCounters.recordDuration(
            "mouseupCommitMs",
            Math.max(0, drawingPerfNow() - commitStartedAt),
          );
          persisted = receipt?.committed === true;
          const ticket = receipt?.ticket ?? null;
          if (persisted && completedFreehandDrawing?.id) {
            selectPrimitive(completedFreehandDrawing.id);
          }
          if (persisted && ticket) {
            recordDrawingPerfInteractionHandoffPrepared("live-ink", ticket);
            liveInkControllerRef.current?.retainUntilPaint(ticket, (listener) => {
              let acknowledged = false;
              return subscribeVisibleScenePaint((stamp) => {
                const coversHandoff = scenePaintCoversDrawingHandoff(ticket, stamp);
                if (coversHandoff && !acknowledged) {
                  acknowledged = true;
                  recordDrawingPerfInteractionHandoffAcknowledged("live-ink", stamp);
                }
                listener(stamp);
              }, { replayLastPaint: true });
            });
          } else {
            liveInkControllerRef.current?.cancel();
          }
        } else if (interactionSurfaceMode === "overlay"
          && completedDrag
          && completedEntityDragDraft) {
          activeOverlayEntityIdRef.current = null;
          invalidateVisibleScene();
          try {
            const receipt = persistSceneCommands(commands);
            persisted = receipt?.committed === true;
            const changed = receipt?.changed === true;
            // Even an unchanged click removes the active-entity exclusion from
            // the static scene. Keep the exact detached pixels until that
            // visibility-only repaint is acknowledged; otherwise a click with
            // no geometric movement can flash an empty frame.
            releaseOverlayDrag(!persisted, !persisted);
            if (persisted
              && changed
              && completedDragDescriptor
              && (completedDragDescriptor.type === "text"
                || completedDragDescriptor.type === "text-handle")) {
              refreshSelectedTextUi(completedDragDescriptor.id);
            }
            if (persisted) {
              retainDynamicOverlayUntilPaint(receipt?.ticket ?? null, {
                // A no-op geometry command keeps the same document revision.
                // The replayable last paint may still be the active-entity-
                // excluded frame, so only a changed document can safely use it.
                replayLastPaint: changed,
              });
            }
          } finally {
            if (overlayDragEntityDraftRef.current) releaseOverlayDrag(true);
          }
        } else if (interactionSurfaceMode === "overlay"
          && completedDrag
          && overlayDragPrimitiveRef.current
          && completedDragCandidates) {
          activeOverlayEntityIdRef.current = null;
          invalidateVisibleScene();
          try {
            const receipt = persistDetachedDrawings(commands, completedDragCandidates);
            persisted = receipt?.committed === true;
            const changed = receipt?.changed === true;
            releaseOverlayDrag(!persisted, !persisted);
            if (persisted
              && changed
              && completedDragDescriptor
              && (completedDragDescriptor.type === "text"
                || completedDragDescriptor.type === "text-handle")) {
              refreshSelectedTextUi(completedDragDescriptor.id);
            }
            if (persisted) {
              retainDynamicOverlayUntilPaint(receipt?.ticket ?? null, {
                replayLastPaint: changed,
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
      && (overlayDragPrimitiveRef.current || overlayDragEntityDraftRef.current)) {
      // Null command batches never enter the persistence branch above.
      releaseOverlayDrag(true);
    }
    if (completedFreehand) {
      if (persisted) {
        if (completedFreehandDraft) cancelFreehandStrokeDraft(completedFreehandDraft);
        freehandDraftRef.current = null;
        freehandCaptureIdentityRef.current = null;
        freehandEntityStyleRef.current = null;
        isDrawingFreehandRef.current = false;
        currentFreehandRef.current = null;
        lastFreehandScreenPointRef.current = null;
        abandonDrawingInteractionLifecycleActiveGesture();
      } else {
        cancelActiveFreehandStroke();
      }
    }
    if (completedDrag && (persisted || interactionSurfaceMode === "overlay")) {
      draggingRef.current = null;
    }
    const durationMs = Math.max(0, drawingPerfNow() - mouseupStartedAt);
    drawingPerfCounters.recordMouseupSyncDuration(durationMs);
    drawingPerfCounters.gestureEnded();
  }, [cancelActiveFreehandStroke, flushActiveDrawingMove, interactionSurfaceMode, invalidateVisibleScene, persistDetachedDrawings, persistDrawings, persistSceneCommands, prepareUserMutationScope, dataToScreen, refreshSelectedTextUi, releaseOverlayDrag, retainDynamicOverlayUntilPaint, selectPrimitive, subscribeVisibleScenePaint]);

  const terminalizeExportInteraction = useCallback((): boolean => {
    if (editingTextIdRef.current) {
      const committed = commitTextEditing({ clearSelection: false, exitTool: false });
      if (!committed && !cancelTextEditing({ clearSelection: false, exitTool: false })) {
        return false;
      }
    }

    if (draggingRef.current || isDrawingFreehandRef.current) {
      handleMouseUp();
      if (draggingRef.current || isDrawingFreehandRef.current) return false;
    }
    return removePreview();
  }, [
    cancelTextEditing,
    commitTextEditing,
    editingTextIdRef,
    handleMouseUp,
    removePreview,
  ]);

  const acquireExportPresentation = useCallback((): DrawingExportInteractionLease => {
    const selectedId = selectedIdRef.current;
    const hover = dynamicHoverDecorationRef.current
      ? Object.freeze({ ...dynamicHoverDecorationRef.current })
      : null;
    const restoreInteraction = (): void => {
      if (selectedId) {
        const primitive = getPrimitiveById(selectedId);
        if (primitive || getSavedDrawing(selectedId)) selectPrimitive(selectedId);
      }
      if (interactionSurfaceMode === "overlay" && hover) {
        dynamicHoverDecorationRef.current = hover;
        renderDynamicFeedback(hover);
      }
      if (interactionSurfaceMode !== "overlay") invalidateVisibleScene();
    };

    return acquireDrawingExportInteractionPresentation({
      beginVisibilityLease() {
        exportVisibilityIntentGate.begin();
      },
      clearPresentation() {
        cancelDynamicPaintHandoff(true);
        clearHoverFeedback();
        liveInkControllerRef.current?.cancel();
        dynamicOverlayControllerRef.current?.clear();
        deselectAll();
        setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
        // Overlay-mode selection/hover/live ink are presentation-only canvases.
        // Invalidating the committed scene here would replace the exact plan that
        // the export barrier just acknowledged and make its own receipt stale.
        if (interactionSurfaceMode !== "overlay") invalidateVisibleScene();
      },
      rollbackFailedAcquisition() {
        exportVisibilityIntentGate.restore({
          restoreCapturePresentation() {},
          restoreInteraction,
          applyPendingIntent(nextHidden) {
            const applyIntent = applyExportVisibilityIntentRef.current;
            if (!applyIntent) {
              throw new Error("Drawing export visibility intent handler is unavailable");
            }
            applyIntent(nextHidden);
          },
        });
      },
      restoreInteraction,
    });
  }, [
    cancelDynamicPaintHandoff,
    clearHoverFeedback,
    deselectAll,
    exportVisibilityIntentGate,
    getPrimitiveById,
    getSavedDrawing,
    interactionSurfaceMode,
    invalidateVisibleScene,
    renderDynamicFeedback,
    selectPrimitive,
    selectedIdRef,
    setSelectedTextUi,
  ]);

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
  }, [cancelActiveDrawingMove, cancelActiveFreehandStroke, cancelDynamicPaintHandoff, clearHoverFeedback, handleMouseUp, interactionSurfaceMode, releaseOverlayDrag, removePreview]);

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
    if (interactionSurfaceMode === "overlay"
      && (overlayDragPrimitiveRef.current || overlayDragEntityDraftRef.current)) {
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
      const savedSelection = interactionSurfaceMode === "overlay" && selectedIdRef.current
        ? getSavedDrawing(selectedIdRef.current)
        : null;
      if (!(sel instanceof TextDrawingPrimitive) && savedSelection?.type !== "text") {
        deselectAll();
      }
    }
    const expectedFreehandType = isHighlighterTool
      ? "highlighter"
      : (isPenTool ? "freehand" : null);
    const expectedFreehandTool = isHighlighterTool
      ? "highlighter"
      : (isPenTool ? "pen" : null);
    if (isDrawingFreehandRef.current
      && ((interactionSurfaceMode === "overlay"
        && freehandEntityStyleRef.current?.tool !== expectedFreehandTool)
        || (interactionSurfaceMode !== "overlay"
          && currentFreehandRef.current?.type !== expectedFreehandType))) {
      cancelActiveFreehandStroke();
    }
    // A passive effect from the render before a toolbar click can flush after
    // pointerdown has already opened the editor. Read the layout-synchronized
    // ref so that stale cleanup cannot cancel a newly-created text draft.
    if (activeToolRef.current !== "text") {
      cancelTextEditing();
    }
    if (!isEraserTool) {
      clearHoverFeedback();
    }
  }, [interactionSurfaceMode, isLineTool, isFibTool, isShapeTool, isPenTool, isHighlighterTool, isEraserTool, isTextTool, isPositionTool, removePreview, deselectAll, cancelTextEditing, selectedIdRef, clearHoverFeedback, cancelActiveDrawingMove, cancelActiveFreehandStroke, getSavedDrawing, releaseOverlayDrag]);

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
  const prepareSurfaceDispose = useCallback((
    boundary?: DrawingSurfaceDisposeBoundaryDescriptor,
  ): boolean => {
    const hadActiveFreehand = currentFreehandRef.current !== null
      || freehandDraftRef.current !== null
      || isDrawingFreehandRef.current;
    const boundaryMarked = !!boundary
      && hadActiveFreehand
      && markDrawingInteractionLifecycleBoundaryChange(boundary) !== null;
    return runDrawingSurfaceDisposeBoundaryLifecycle({
      boundaryMarked,
      hasActiveFreehand: () => currentFreehandRef.current !== null
        || freehandDraftRef.current !== null
        || isDrawingFreehandRef.current,
      prepare: () => runDrawingSurfaceDisposeBarrier(
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
      ),
    });
  }, [cancelActiveDrawingMove, cancelDynamicPaintHandoff, clearHoverFeedback, preparePersistenceSurfaceDispose, releaseOverlayDrag, resetCursorForActiveTool]);

  const completeSurfaceDispose = useCallback((): void => {
    // The chart owner has confirmed remove(). Surface-only drafts can now be
    // abandoned without another detach call, while the document store remains
    // the sole source used to materialize the replacement series.
    completeTextSurfaceDispose();
    if (freehandDraftRef.current) cancelFreehandStrokeDraft(freehandDraftRef.current);
    freehandDraftRef.current = null;
    freehandCaptureIdentityRef.current = null;
    freehandEntityStyleRef.current = null;
    currentFreehandRef.current = null;
    isDrawingFreehandRef.current = false;
    lastFreehandScreenPointRef.current = null;
    abandonDrawingInteractionLifecycleActiveGesture();
    previewRef.current = null;
    previewEntityRef.current = null;
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
  const setHidden = useCallback((
    next: boolean,
    bypassExportLock = false,
    exactExport = false,
  ): boolean => {
    const value = !!next;
    if (!bypassExportLock && !exportVisibilityIntentGate.request(value)) return false;
    const scopeReady = bypassExportLock
      ? preparePersistenceUserMutationScope()
      : prepareUserMutationScope();
    const changed = hiddenRef.current !== value;
    // Keep the requested visibility as an intent even while A -> B is blocked.
    // The eventual B reconciliation reads hiddenRef. Showing is deferred so an
    // old A credential can never be made visible on B's rendered surface;
    // hiding is safe and remains available as a fail-closed visual operation.
    hiddenRef.current = value;
    const sceneVisibilityPrepared = synchronizeVisibleSceneVisibility(
      value,
      exactExport ? { exactExport: true } : undefined,
    );
    if (!canApplyDrawingVisibilityToCurrentPrimitives(scopeReady, value)) return false;
    if (!changed && scopeReady) return !exactExport || sceneVisibilityPrepared;

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
    return !exactExport || sceneVisibilityPrepared;
  }, [cancelDynamicPaintHandoff, getChartAdapter, removePreview, cancelTextEditing, clearHoverFeedback, cancelActiveDrawingMove, cancelActiveFreehandStroke, exportVisibilityIntentGate, preparePersistenceUserMutationScope, prepareUserMutationScope, releaseOverlayDrag, synchronizeVisibleSceneVisibility]);
  applyExportVisibilityIntentRef.current = (nextHidden) => {
    setHidden(nextHidden);
  };

  const activeExportPresentationRef = useRef<DrawingExportPresentationState | null>(null);
  const restoreExportVisibilityPresentation = useCallback((
    presentation: DrawingExportPresentationState | null,
  ): boolean => {
    const activePresentation = activeExportPresentationRef.current;
    // A timed-out setup operation can reject after the barrier has already
    // released its token. Never let that stale continuation restore a newer
    // export lease that began in the meantime.
    if (presentation !== null && activePresentation !== presentation) return false;
    const currentPresentation = presentation ?? activePresentation;
    if (!currentPresentation) return false;
    try {
      return exportVisibilityIntentGate.restore({
        restoreCapturePresentation() {
          if (currentPresentation?.visibilityChanged) {
            setHidden(currentPresentation.previousHidden, true);
          } else if (currentPresentation?.previousHidden) {
            // A globally hidden scene is temporarily reactivated only to
            // publish an exact empty export receipt. Return it to the normal
            // suspended/worker-retired hidden lifecycle after capture.
            setHidden(true, true);
          }
        },
        restoreInteraction() {
          currentPresentation?.interaction.restore();
        },
        applyPendingIntent(nextHidden) {
          setHidden(nextHidden);
        },
      });
    } finally {
      if (!exportVisibilityIntentGate.isLocked()) {
        activeExportPresentationRef.current = null;
      }
    }
  }, [exportVisibilityIntentGate, setHidden]);

  const exportRequestRef = useRef<Readonly<{
    hiddenAtStart: boolean;
    hideDrawings: boolean;
  }> | null>(null);
  const exportBarrierRef = useRef<DrawingExportBarrier<
    DrawingExportPersistenceState,
    DrawingExportSceneReceipt,
    number
  > | null>(null);
  if (exportBarrierRef.current === null) {
    exportBarrierRef.current = createDrawingExportBarrier<
      DrawingExportPersistenceState,
      DrawingExportPresentationState,
      DrawingExportSceneReceipt,
      number
    >({
      terminalizeInteraction() {
        if (!terminalizeExportInteraction()) {
          throw new Error("Drawing export could not finish the active interaction");
        }
        const target = getActiveDocumentTarget();
        if (!target) throw new Error("Drawing export document is not ready");
        return target;
      },
      async flushTargetDocument({ target }) {
        const result = await flushActiveDocument(target);
        if (!result.ok) throw result.error;
        if (result.scopeKey !== target.scopeKey
          || result.targetRevision !== target.documentRevision
          || result.persistedRevision < target.documentRevision) {
          throw new Error("Drawing export persistence receipt is stale");
        }
        return Object.freeze({
          ...target,
          persistence: Object.freeze({
            persistedRevision: result.persistedRevision,
            writePerformed: !("skipped" in result),
          }),
        });
      },
      async applyAndClearPresentation({ target, signal }) {
        const request = exportRequestRef.current;
        if (!request) throw new Error("Drawing export request state is unavailable");
        const previousHidden = hiddenRef.current;
        const interaction = acquireExportPresentation();
        const visibilityChanged = request.hideDrawings && !previousHidden;
        const pendingPresentation = Object.freeze({
          interaction,
          previousHidden,
          visibilityChanged,
          replacementScene: null,
        });
        activeExportPresentationRef.current = pendingPresentation;
        try {
          if (visibilityChanged) {
            const exactHiddenSceneRequired = interactionSurfaceMode === "overlay";
            if (!setHidden(true, true, exactHiddenSceneRequired)) {
              throw new Error("Drawing export could not prepare the hidden scene");
            }
          }
          // Legacy selection handles and hide-drawings both change the static
          // scene after the barrier's first exact receipt. Wait for a second
          // exact receipt here so the following single-frame capture never
          // relies on a fixed-frame guess or revalidates an intentionally
          // replaced plan.
          const replacementScene = interactionSurfaceMode !== "overlay" || visibilityChanged
            ? await waitForExactExportScene(target, signal)
            : null;
          const completedPresentation = Object.freeze({
            interaction,
            previousHidden,
            visibilityChanged,
            replacementScene,
          });
          activeExportPresentationRef.current = completedPresentation;
          return completedPresentation;
        } catch (error) {
          try {
            restoreExportVisibilityPresentation(pendingPresentation);
          } catch (restoreError) {
            throw new AggregateError(
              [error, restoreError],
              "Drawing export presentation setup and restore both failed",
            );
          }
          throw error;
        }
      },
      async awaitExactScene({ target, signal }) {
        const scene = await waitForExactExportScene(target, signal);
        return Object.freeze({ ...target, scene });
      },
      waitForNextFrame({ signal }) {
        return new Promise<number>((resolve, reject) => {
          if (signal.aborted) {
            reject(new DOMException("Drawing export frame wait was aborted", "AbortError"));
            return;
          }
          let settled = false;
          let handle: unknown = null;
          const finish = (timestamp: number): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", abort);
            resolve(timestamp);
          };
          const abort = (): void => {
            if (settled) return;
            settled = true;
            if (typeof handle === "number" && typeof cancelAnimationFrame === "function") {
              cancelAnimationFrame(handle);
            } else if (handle !== null) {
              clearTimeout(handle as ReturnType<typeof setTimeout>);
            }
            reject(new DOMException("Drawing export frame wait was aborted", "AbortError"));
          };
          signal.addEventListener("abort", abort, { once: true });
          if (typeof requestAnimationFrame === "function") {
            handle = requestAnimationFrame(finish);
          } else {
            handle = setTimeout(() => finish(Date.now()), 16);
          }
        });
      },
      revalidate({ target, presentation, receipt }) {
        return revalidateExportScene(
          target,
          presentation.replacementScene ?? receipt.scene,
        );
      },
      restorePresentation({ presentation }) {
        let presentationRestored = false;
        try {
          presentationRestored = restoreExportVisibilityPresentation(presentation);
        } finally {
          restorePrePresentationHiddenDrawingSceneRuntime(
            exportRequestRef.current?.hiddenAtStart === true,
            hiddenRef.current,
            presentationRestored,
            () => { setHidden(true, true); },
          );
        }
      },
    });
  }

  const prepareExport = useCallback(async (
    options: DrawingExportPrepareOptions = {},
  ): Promise<DrawingExportLease> => {
    const barrier = exportBarrierRef.current;
    if (!barrier) throw new Error("Drawing export barrier is unavailable");
    const prepareBarrierLease = async (): Promise<DrawingExportLease> => {
      const lease = await barrier.prepare({
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      const captureScene = activeExportPresentationRef.current?.replacementScene
        ?? lease.receipt.scene;
      return withDrawingExportCaptureScene(lease, captureScene);
    };
    if (barrier.snapshot().locked) {
      return prepareBarrierLease();
    }
    exportRequestRef.current = Object.freeze({
      hiddenAtStart: hiddenRef.current,
      hideDrawings: options.hideDrawings === true,
    });
    try {
      return await prepareBarrierLease();
    } finally {
      exportRequestRef.current = null;
    }
  }, []);

  // ── Selected-text helpers (consumed by floating format toolbar) ──

  /**
   * Apply a partial style/text patch to the currently selected text primitive.
   * Triggers persistence + a React re-render of the format bar snapshot.
   */
  const updateSelectedText = useCallback((patch: TextDrawingPatch) => {
    const id = selectedIdRef.current;
    if (!id) return;
    if (interactionSurfaceMode === "overlay") {
      const saved = getSavedDrawing(id);
      if (saved?.type !== "text") return;
      const candidate = Object.freeze({ ...saved, ...patch });
      const commands = drawingCommandsForSavedDrawing(candidate, { type: "update-style" });
      if (!commands || !prepareTerminalTextMutation()) return;
      const receipt = persistSceneCommands(commands);
      if (!receipt?.committed) return;
      refreshSelectedTextUi(id);
      setSelectedDrawingMeta(selectedDrawingMetaFromSavedDrawing(candidate));
      return;
    }
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
  }, [getPrimitiveById, getSavedDrawing, interactionSurfaceMode, persistSceneCommands, prepareTerminalTextMutation, refreshSelectedTextUi, persistDrawings, selectedIdRef, setSelectedDrawingMeta]);

  /** Delete the currently selected primitive (any type). */
  const deleteSelected = useCallback(() => {
    const id = selectedIdRef.current;
    if (!id) return;
    if (interactionSurfaceMode === "overlay") {
      if (!getSavedDrawing(id) || !prepareTerminalTextMutation()) return;
      const receipt = persistSceneCommands([Object.freeze({ type: "delete", id })]);
      if (!receipt?.committed) return;
      selectedIdRef.current = null;
      setSelectedPrimId(null);
      setSelectedTextUi(EMPTY_SELECTED_TEXT_UI);
      setSelectedDrawingMeta(null);
      dynamicOverlayControllerRef.current?.clear();
      return;
    }
    const idx = primitivesRef.current.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const primitive = primitivesRef.current[idx];
    if (!primitive) return;
    if (!prepareTerminalTextMutation()) return;
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
  }, [attachPrim, detachPrim, getSavedDrawing, interactionSurfaceMode, persistSceneCommands, prepareTerminalTextMutation, persistDrawings, selectedIdRef, setSelectedDrawingMeta, setSelectedPrimId, setSelectedTextUi]);

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
    if (interactionSurfaceMode === "overlay") {
      const saved = getSavedDrawing(id);
      if (!saved) return;
      const candidate = { ...saved } as SavedDrawing & {
        color?: string;
        lineWidth?: number;
        opacity?: number;
      };
      let changed = false;
      if (typeof patch.color === "string"
        && "color" in saved
        && patch.color !== saved.color) {
        candidate.color = patch.color;
        changed = true;
      }
      if (typeof patch.lineWidth === "number"
        && "lineWidth" in saved
        && patch.lineWidth !== saved.lineWidth) {
        candidate.lineWidth = patch.lineWidth;
        changed = true;
      }
      if (typeof patch.opacity === "number"
        && saved.type === "highlighter"
        && patch.opacity !== saved.opacity) {
        candidate.opacity = patch.opacity;
        changed = true;
      }
      if (!changed) return;
      const commands = drawingCommandsForSavedDrawing(candidate, { type: "update-style" });
      if (!commands || !prepareTerminalTextMutation()) return;
      const receipt = persistSceneCommands(commands);
      if (!receipt?.committed) return;
      setSelectedDrawingMeta(selectedDrawingMetaFromSavedDrawing(candidate));
      if (candidate.type === "text") refreshSelectedTextUi(id);
      return;
    }
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
  }, [getSavedDrawing, interactionSurfaceMode, persistSceneCommands, prepareTerminalTextMutation, persistDrawings, refreshSelectedTextUi, selectedIdRef, setSelectedDrawingMeta]);

  const selectedTextSnapshot = selectedTextUi.snapshot;
  const selectedTextBox = selectedTextUi.box;

  return {
    clearAll,
    completeSurfaceDispose,
    invalidateSurfaceCredentialsForSeriesReplacement,
    prepareExport,
    prepareSurfaceDispose,
    setHidden,
    getLegacyPrimitiveRuntimeEvidence,
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
