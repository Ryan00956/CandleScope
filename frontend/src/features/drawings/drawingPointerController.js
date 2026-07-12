import { useCallback, useEffect } from "react";

export function getChartPointerPosition(chartContainerRef, event, rectOverride = null) {
  const container = chartContainerRef?.current;
  if (!container) return null;
  const rect = rectOverride || container.getBoundingClientRect();
  const clientX = event.touches ? event.touches[0].clientX : event.clientX;
  const clientY = event.touches ? event.touches[0].clientY : event.clientY;
  return { x: clientX - rect.left, y: clientY - rect.top };
}

export function useChartPointerPosition(chartContainerRef) {
  return useCallback(
    (event, rectOverride = null) => getChartPointerPosition(chartContainerRef, event, rectOverride),
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
}) {
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
