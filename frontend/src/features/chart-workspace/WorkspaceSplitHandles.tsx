import React, { useRef, type RefObject } from "react";
import {
  layoutRatioKey,
  MAX_CHART_SPLIT_RATIO,
  MIN_CHART_SPLIT_RATIO,
  normalizeChartSplitRatio,
  ratioFromPointerPosition,
  type ChartWorkspaceSplitAxis,
} from "./chartWorkspaceLayout.js";
import type {
  ChartWorkspaceLayout,
  ChartWorkspaceLayoutRatios,
} from "./chartWorkspaceTypes.js";

interface DragState {
  axis: ChartWorkspaceSplitAxis;
  pointerId: number;
  ratio: number;
}

export interface WorkspaceSplitHandlesProps {
  containerRef: RefObject<HTMLDivElement | null>;
  layout: ChartWorkspaceLayout;
  ratios: ChartWorkspaceLayoutRatios;
  disabled?: boolean;
  onCommit(key: keyof ChartWorkspaceLayoutRatios, ratio: number): void;
}

function axesForLayout(layout: ChartWorkspaceLayout): ChartWorkspaceSplitAxis[] {
  if (layout === "split-vertical") return ["columns"];
  if (layout === "split-horizontal") return ["rows"];
  if (layout === "quad") return ["columns", "rows"];
  return [];
}

function cssProperty(axis: ChartWorkspaceSplitAxis): string {
  return axis === "columns" ? "--workspace-column-ratio" : "--workspace-row-ratio";
}

function currentRatio(
  layout: ChartWorkspaceLayout,
  ratios: ChartWorkspaceLayoutRatios,
  axis: ChartWorkspaceSplitAxis,
): number {
  const key = layoutRatioKey(layout, axis);
  return key ? ratios[key] : 0.5;
}

export default function WorkspaceSplitHandles({
  containerRef,
  layout,
  ratios,
  disabled = false,
  onCommit,
}: WorkspaceSplitHandlesProps) {
  const dragRef = useRef<DragState | null>(null);

  const previewRatio = (axis: ChartWorkspaceSplitAxis, ratio: number) => {
    containerRef.current?.style.setProperty(cssProperty(axis), `${ratio * 100}%`);
  };

  const commitRatio = (axis: ChartWorkspaceSplitAxis, ratio: number) => {
    const key = layoutRatioKey(layout, axis);
    if (key) onCommit(key, normalizeChartSplitRatio(ratio));
  };

  return axesForLayout(layout).map((axis) => {
    const ratio = currentRatio(layout, ratios, axis);
    const orientation = axis === "columns" ? "vertical" : "horizontal";
    return (
      <div
        key={axis}
        className={`workspace-split-handle workspace-split-handle-${orientation}`}
        data-split-axis={axis}
        role="separator"
        aria-label={axis === "columns" ? "调整左右图表宽度" : "调整上下图表高度"}
        aria-orientation={orientation}
        aria-valuemin={Math.round(MIN_CHART_SPLIT_RATIO * 100)}
        aria-valuemax={Math.round(MAX_CHART_SPLIT_RATIO * 100)}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { axis, pointerId: event.pointerId, ratio };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          const container = containerRef.current;
          if (!drag || drag.axis !== axis || drag.pointerId !== event.pointerId || !container) return;
          const rect = container.getBoundingClientRect();
          const next = ratioFromPointerPosition(
            axis === "columns" ? event.clientX : event.clientY,
            axis === "columns" ? rect.left : rect.top,
            axis === "columns" ? rect.width : rect.height,
          );
          if (next === null) return;
          drag.ratio = next;
          previewRatio(axis, next);
          event.currentTarget.setAttribute("aria-valuenow", String(Math.round(next * 100)));
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.axis !== axis || drag.pointerId !== event.pointerId) return;
          dragRef.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          commitRatio(axis, drag.ratio);
        }}
        onPointerCancel={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.axis !== axis || drag.pointerId !== event.pointerId) return;
          dragRef.current = null;
          previewRatio(axis, ratio);
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          previewRatio(axis, 0.5);
          commitRatio(axis, 0.5);
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          const decrement = axis === "columns" ? event.key === "ArrowLeft" : event.key === "ArrowUp";
          const increment = axis === "columns" ? event.key === "ArrowRight" : event.key === "ArrowDown";
          let next = ratio;
          if (decrement) next -= 0.02;
          else if (increment) next += 0.02;
          else if (event.key === "Home") next = MIN_CHART_SPLIT_RATIO;
          else if (event.key === "End") next = MAX_CHART_SPLIT_RATIO;
          else return;
          event.preventDefault();
          next = normalizeChartSplitRatio(next);
          previewRatio(axis, next);
          commitRatio(axis, next);
        }}
      />
    );
  });
}
