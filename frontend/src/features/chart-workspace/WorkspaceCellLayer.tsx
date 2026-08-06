import {
  useEffect,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  ChartCellId,
  ChartWorkspaceCellRole,
} from "./chartWorkspaceTypes.js";
import type {
  WorkspaceLayoutGeometry,
  WorkspaceLayoutLeafGeometry,
} from "./chartWorkspaceGeometry.js";
import {
  nextWorkspaceCellInDirection,
  workspaceLayoutRectStyle,
} from "./chartWorkspaceGeometry.js";
import {
  hasChartCellDragData,
  readChartCellDragData,
} from "./chartWorkspaceDrag.js";

export interface WorkspaceCellLayerProps {
  rootRef: RefObject<HTMLDivElement | null>;
  geometry: WorkspaceLayoutGeometry;
  maximizedCellId: ChartCellId | null;
  disabled: boolean;
  renderCell(cellId: ChartCellId, role: ChartWorkspaceCellRole | null, obscured: boolean): ReactNode;
  onCellDrop(sourceCellId: ChartCellId, targetCellId: ChartCellId): void;
}

function WorkspaceCellHost({
  leaf,
  rootRef,
  geometry,
  maximizedCellId,
  disabled,
  renderCell,
  onCellDrop,
}: Omit<WorkspaceCellLayerProps, "maximizedCellId"> & {
  leaf: WorkspaceLayoutLeafGeometry;
  maximizedCellId: ChartCellId | null;
}) {
  const [dropActive, setDropActive] = useState(false);
  const obscured = maximizedCellId !== null && maximizedCellId !== leaf.cellId;
  const maximized = maximizedCellId === leaf.cellId;
  useEffect(() => {
    if (!dropActive) return undefined;
    const clear = () => setDropActive(false);
    document.addEventListener("dragend", clear);
    document.addEventListener("drop", clear);
    return () => {
      document.removeEventListener("dragend", clear);
      document.removeEventListener("drop", clear);
    };
  }, [dropActive]);

  const handleKeyboardNavigation = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement)
      || !event.target.matches(".multi-chart-cell")) return;
    const direction = event.key === "ArrowLeft" ? "left"
      : event.key === "ArrowRight" ? "right"
        : event.key === "ArrowUp" ? "up"
          : event.key === "ArrowDown" ? "down"
            : null;
    if (!direction) return;
    const targetCellId = nextWorkspaceCellInDirection(geometry, leaf.cellId, direction);
    if (!targetCellId) return;
    event.preventDefault();
    rootRef.current
      ?.querySelector<HTMLElement>(`.multi-chart-cell[data-chart-cell-id="${CSS.escape(targetCellId)}"]`)
      ?.focus();
  };
  const acceptDrag = (event: DragEvent<HTMLDivElement>) => {
    if (disabled || obscured || !hasChartCellDragData(event.dataTransfer)) return false;
    event.preventDefault();
    setDropActive(true);
    return true;
  };

  return (
    <div
      className={`workspace-layout-leaf${maximized ? " workspace-layout-leaf-maximized" : ""}${obscured ? " workspace-layout-leaf-obscured" : ""}${dropActive ? " drop-target" : ""}`}
      data-layout-cell-id={leaf.cellId}
      data-layout-cell-role={leaf.role ?? "standard"}
      data-layout-visual-index={leaf.visualIndex}
      data-obscured={obscured ? "true" : "false"}
      aria-hidden={obscured}
      style={maximized ? { inset: 0 } : workspaceLayoutRectStyle(leaf.rect)}
      onKeyDown={handleKeyboardNavigation}
      onDragEnter={acceptDrag}
      onDragOver={(event) => {
        if (acceptDrag(event)) event.dataTransfer.dropEffect = "move";
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDropActive(false);
        if (disabled || obscured) return;
        const sourceCellId = readChartCellDragData(event.dataTransfer);
        if (sourceCellId && sourceCellId !== leaf.cellId) onCellDrop(sourceCellId, leaf.cellId);
      }}
    >
      {renderCell(leaf.cellId, leaf.role, obscured)}
    </div>
  );
}

export default function WorkspaceCellLayer(props: WorkspaceCellLayerProps) {
  return (
    <div className="workspace-cell-layer" data-stable-cell-layer="true">
      {props.geometry.leaves.map((leaf) => (
        <WorkspaceCellHost
          key={leaf.cellId}
          {...props}
          leaf={leaf}
        />
      ))}
    </div>
  );
}
