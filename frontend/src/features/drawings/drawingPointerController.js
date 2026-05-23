import { useCallback, useEffect } from "react";

export function getChartPointerPosition(chartContainerRef, event) {
  const container = chartContainerRef?.current;
  if (!container) return null;
  const rect = container.getBoundingClientRect();
  const clientX = event.touches ? event.touches[0].clientX : event.clientX;
  const clientY = event.touches ? event.touches[0].clientY : event.clientY;
  return { x: clientX - rect.left, y: clientY - rect.top };
}

export function useChartPointerPosition(chartContainerRef) {
  return useCallback(
    (event) => getChartPointerPosition(chartContainerRef, event),
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
}) {
  useEffect(() => {
    const container = chartContainerRef?.current;
    if (!container) return undefined;

    container.addEventListener("mousedown", handleMouseDown, true);
    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("mouseup", handleMouseUp, true);
    container.addEventListener("mouseleave", handleMouseLeave);
    container.addEventListener("dblclick", handleDblClick);
    container.addEventListener("contextmenu", handleContextMenu);
    container.addEventListener("touchstart", handleMouseDown, { passive: false, capture: true });
    container.addEventListener("touchmove", handleMouseMove, { passive: false });
    container.addEventListener("touchend", handleMouseUp);
    container.addEventListener("touchcancel", handleMouseUp);

    return () => {
      container.removeEventListener("mousedown", handleMouseDown, true);
      document.removeEventListener("mousemove", handleMouseMove, true);
      document.removeEventListener("mouseup", handleMouseUp, true);
      container.removeEventListener("mouseleave", handleMouseLeave);
      container.removeEventListener("dblclick", handleDblClick);
      container.removeEventListener("contextmenu", handleContextMenu);
      container.removeEventListener("touchstart", handleMouseDown, true);
      container.removeEventListener("touchmove", handleMouseMove);
      container.removeEventListener("touchend", handleMouseUp);
      container.removeEventListener("touchcancel", handleMouseUp);
    };
  }, [
    chartContainerRef,
    handleContextMenu,
    handleDblClick,
    handleMouseDown,
    handleMouseLeave,
    handleMouseMove,
    handleMouseUp,
  ]);
}
