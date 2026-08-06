import { useRef, type RefObject } from "react";
import {
  MAX_CHART_SPLIT_RATIO,
  MIN_CHART_SPLIT_RATIO,
  normalizeChartSplitRatio,
  ratioFromPointerPosition,
} from "./chartWorkspaceLayout.js";
import type { ChartWorkspaceSplitDirection } from "./chartWorkspaceTypes.js";

interface DragState {
  pointerId: number;
  ratio: number;
}

export interface WorkspaceSplitHandleProps {
  containerRef: RefObject<HTMLDivElement | null>;
  splitId: string;
  direction: ChartWorkspaceSplitDirection;
  ratio: number;
  disabled?: boolean;
  onCommit(splitId: string, ratio: number): void;
}

export default function WorkspaceSplitHandle({
  containerRef,
  splitId,
  direction,
  ratio,
  disabled = false,
  onCommit,
}: WorkspaceSplitHandleProps) {
  const dragRef = useRef<DragState | null>(null);
  const orientation = direction === "columns" ? "vertical" : "horizontal";

  const previewRatio = (nextRatio: number) => {
    containerRef.current?.style.setProperty("--workspace-split-ratio", `${nextRatio * 100}%`);
  };
  const commitRatio = (nextRatio: number) => {
    onCommit(splitId, normalizeChartSplitRatio(nextRatio, ratio));
  };

  return (
    <div
      className={`workspace-split-handle workspace-split-handle-${orientation}`}
      data-split-id={splitId}
      data-split-direction={direction}
      role="separator"
      aria-label={direction === "columns" ? "调整左右图表宽度" : "调整上下图表高度"}
      aria-orientation={orientation}
      aria-valuemin={Math.round(MIN_CHART_SPLIT_RATIO * 100)}
      aria-valuemax={Math.round(MAX_CHART_SPLIT_RATIO * 100)}
      aria-valuenow={Math.round(ratio * 100)}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { pointerId: event.pointerId, ratio };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        const container = containerRef.current;
        if (!drag || drag.pointerId !== event.pointerId || !container) return;
        const rect = container.getBoundingClientRect();
        const next = ratioFromPointerPosition(
          direction === "columns" ? event.clientX : event.clientY,
          direction === "columns" ? rect.left : rect.top,
          direction === "columns" ? rect.width : rect.height,
        );
        if (next === null) return;
        drag.ratio = next;
        previewRatio(next);
        event.currentTarget.setAttribute("aria-valuenow", String(Math.round(next * 100)));
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        commitRatio(drag.ratio);
      }}
      onPointerCancel={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        previewRatio(ratio);
      }}
      onDoubleClick={(event) => {
        if (disabled) return;
        event.preventDefault();
        event.stopPropagation();
        previewRatio(0.5);
        commitRatio(0.5);
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        const decrement = direction === "columns"
          ? event.key === "ArrowLeft"
          : event.key === "ArrowUp";
        const increment = direction === "columns"
          ? event.key === "ArrowRight"
          : event.key === "ArrowDown";
        let next = ratio;
        if (decrement) next -= 0.02;
        else if (increment) next += 0.02;
        else if (event.key === "Home") next = MIN_CHART_SPLIT_RATIO;
        else if (event.key === "End") next = MAX_CHART_SPLIT_RATIO;
        else return;
        event.preventDefault();
        next = normalizeChartSplitRatio(next, ratio);
        previewRatio(next);
        commitRatio(next);
      }}
    />
  );
}
