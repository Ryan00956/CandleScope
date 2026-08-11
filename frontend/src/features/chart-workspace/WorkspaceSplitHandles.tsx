import { useRef, type RefObject } from "react";
import type { WorkspaceLayoutSplitGeometry } from "./chartWorkspaceGeometry.js";
import { workspaceLayoutRectStyle } from "./chartWorkspaceGeometry.js";
import {
  MAX_CHART_SPLIT_RATIO,
  MIN_CHART_SPLIT_RATIO,
  normalizeChartSplitRatio,
  ratioFromPointerPosition,
} from "./chartWorkspaceLayout.js";

interface DragState {
  pointerId: number;
  ratio: number;
}

export interface WorkspaceSplitHandleProps {
  rootRef: RefObject<HTMLDivElement | null>;
  split: WorkspaceLayoutSplitGeometry;
  disabled?: boolean;
  onPreview(splitId: string, ratio: number | null): void;
  onCommit(splitId: string, ratio: number): void;
}

export default function WorkspaceSplitHandle({
  rootRef,
  split,
  disabled = false,
  onPreview,
  onCommit,
}: WorkspaceSplitHandleProps) {
  const dragRef = useRef<DragState | null>(null);
  const orientation = split.direction === "columns" ? "vertical" : "horizontal";
  const commitRatio = (nextRatio: number) => {
    onCommit(split.splitId, normalizeChartSplitRatio(nextRatio, split.ratio));
  };

  return (
    <div
      className={`workspace-split-handle workspace-split-handle-${orientation}`}
      data-split-id={split.splitId}
      data-split-direction={split.direction}
      role="separator"
      aria-label={split.direction === "columns" ? "调整左右图表宽度" : "调整上下图表高度"}
      aria-orientation={orientation}
      aria-valuemin={Math.round(MIN_CHART_SPLIT_RATIO * 100)}
      aria-valuemax={Math.round(MAX_CHART_SPLIT_RATIO * 100)}
      aria-valuenow={Math.round(split.ratio * 100)}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      style={workspaceLayoutRectStyle(split.handleRect)}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { pointerId: event.pointerId, ratio: split.ratio };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        const root = rootRef.current;
        if (!drag || drag.pointerId !== event.pointerId || !root) return;
        const rootRect = root.getBoundingClientRect();
        const containerStart = split.direction === "columns"
          ? rootRect.left + split.rect.x * rootRect.width
          : rootRect.top + split.rect.y * rootRect.height;
        const containerSize = split.direction === "columns"
          ? split.rect.width * rootRect.width
          : split.rect.height * rootRect.height;
        const next = ratioFromPointerPosition(
          split.direction === "columns" ? event.clientX : event.clientY,
          containerStart,
          containerSize,
        );
        if (next === null) return;
        drag.ratio = next;
        onPreview(split.splitId, next);
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
        onPreview(split.splitId, null);
      }}
      onDoubleClick={(event) => {
        if (disabled) return;
        event.preventDefault();
        event.stopPropagation();
        commitRatio(0.5);
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        const decrement = split.direction === "columns"
          ? event.key === "ArrowLeft"
          : event.key === "ArrowUp";
        const increment = split.direction === "columns"
          ? event.key === "ArrowRight"
          : event.key === "ArrowDown";
        let next = split.ratio;
        if (decrement) next -= 0.02;
        else if (increment) next += 0.02;
        else if (event.key === "Home") next = MIN_CHART_SPLIT_RATIO;
        else if (event.key === "End") next = MAX_CHART_SPLIT_RATIO;
        else return;
        event.preventDefault();
        commitRatio(next);
      }}
    />
  );
}
