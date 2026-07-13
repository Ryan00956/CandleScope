import { useCallback, useEffect } from "react";
import type { MutableRefObject } from "react";
import type { ScreenPoint } from "./drawingTypes.js";

export type DrawingDomPointerEvent = MouseEvent | PointerEvent | TouchEvent;
export type DrawingPointerHandler = (event: DrawingDomPointerEvent) => void;

export function getChartPointerPosition(
  chartContainerRef: MutableRefObject<HTMLElement | null> | null | undefined,
  event: DrawingDomPointerEvent,
  rectOverride: DOMRect | null = null,
): ScreenPoint | null {
  const container = chartContainerRef?.current;
  if (!container) return null;
  const rect = rectOverride || container.getBoundingClientRect();
  const clientX = "touches" in event ? event.touches[0]?.clientX : event.clientX;
  const clientY = "touches" in event ? event.touches[0]?.clientY : event.clientY;
  if (clientX == null || clientY == null) return null;
  return { x: clientX - rect.left, y: clientY - rect.top };
}

export function useChartPointerPosition(
  chartContainerRef: MutableRefObject<HTMLElement | null>,
): (event: DrawingDomPointerEvent, rectOverride?: DOMRect | null) => ScreenPoint | null {
  return useCallback(
    (event: DrawingDomPointerEvent, rectOverride: DOMRect | null = null) => (
      getChartPointerPosition(chartContainerRef, event, rectOverride)
    ),
    [chartContainerRef],
  );
}

export function useDrawingPointerEvents({
  chartContainerRef,
  handleDblClick,
  handleContextMenu,
  handleMouseDown,
  handleMouseLeave,
  handleMouseMove,
  handleMouseUp,
  handlePointerCancel = handleMouseUp,
}: {
  chartContainerRef: MutableRefObject<HTMLElement | null>;
  handleDblClick: (event: MouseEvent) => void;
  handleContextMenu: (event: MouseEvent) => void;
  handleMouseDown: DrawingPointerHandler;
  handleMouseLeave: DrawingPointerHandler;
  handleMouseMove: DrawingPointerHandler;
  handleMouseUp: DrawingPointerHandler;
  handlePointerCancel?: DrawingPointerHandler;
}): void {
  useEffect(() => {
    const container = chartContainerRef?.current;
    if (!container) return undefined;

    const supportsPointerEvents = typeof window !== "undefined" && "PointerEvent" in window;

    if (supportsPointerEvents) {
      container.addEventListener("pointerdown", handleMouseDown, true);
      document.addEventListener("pointermove", handleMouseMove, true);
      document.addEventListener("pointerup", handleMouseUp, true);
      document.addEventListener("pointercancel", handlePointerCancel, true);
      container.addEventListener("pointerleave", handleMouseLeave);
    } else {
      container.addEventListener("mousedown", handleMouseDown, true);
      document.addEventListener("mousemove", handleMouseMove, true);
      document.addEventListener("mouseup", handleMouseUp, true);
      container.addEventListener("mouseleave", handleMouseLeave);
      container.addEventListener("touchstart", handleMouseDown, { passive: false, capture: true });
      container.addEventListener("touchmove", handleMouseMove, { passive: false });
      container.addEventListener("touchend", handleMouseUp);
      container.addEventListener("touchcancel", handlePointerCancel);
    }

    container.addEventListener("dblclick", handleDblClick);
    container.addEventListener("contextmenu", handleContextMenu);

    return () => {
      if (supportsPointerEvents) {
        container.removeEventListener("pointerdown", handleMouseDown, true);
        document.removeEventListener("pointermove", handleMouseMove, true);
        document.removeEventListener("pointerup", handleMouseUp, true);
        document.removeEventListener("pointercancel", handlePointerCancel, true);
        container.removeEventListener("pointerleave", handleMouseLeave);
      } else {
        container.removeEventListener("mousedown", handleMouseDown, true);
        document.removeEventListener("mousemove", handleMouseMove, true);
        document.removeEventListener("mouseup", handleMouseUp, true);
        container.removeEventListener("mouseleave", handleMouseLeave);
        container.removeEventListener("touchstart", handleMouseDown, true);
        container.removeEventListener("touchmove", handleMouseMove);
        container.removeEventListener("touchend", handleMouseUp);
        container.removeEventListener("touchcancel", handlePointerCancel);
      }

      container.removeEventListener("dblclick", handleDblClick);
      container.removeEventListener("contextmenu", handleContextMenu);
    };
  }, [
    chartContainerRef,
    handleContextMenu,
    handleDblClick,
    handleMouseDown,
    handleMouseLeave,
    handleMouseMove,
    handleMouseUp,
    handlePointerCancel,
  ]);
}
