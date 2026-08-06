import { useRef, type CSSProperties, type ReactNode } from "react";
import type {
  ChartCellId,
  ChartWorkspaceCellRole,
  ChartWorkspaceLayoutNode,
} from "./chartWorkspaceTypes.js";
import { findChartWorkspaceCellRole } from "./chartWorkspaceLayout.js";
import WorkspaceSplitHandle from "./WorkspaceSplitHandles.js";

export interface WorkspaceLayoutTreeProps {
  tree: ChartWorkspaceLayoutNode;
  maximizedCellId: ChartCellId | null;
  disabled?: boolean;
  renderCell(cellId: ChartCellId, role: ChartWorkspaceCellRole | null): ReactNode;
  onSplitRatioChange(splitId: string, ratio: number): void;
}

interface WorkspaceLayoutNodeViewProps {
  node: ChartWorkspaceLayoutNode;
  disabled: boolean;
  renderCell: WorkspaceLayoutTreeProps["renderCell"];
  onSplitRatioChange: WorkspaceLayoutTreeProps["onSplitRatioChange"];
}

function WorkspaceLayoutNodeView({
  node,
  disabled,
  renderCell,
  onSplitRatioChange,
}: WorkspaceLayoutNodeViewProps) {
  const splitRef = useRef<HTMLDivElement | null>(null);
  if (node.kind === "cell") {
    return (
      <div
        className="workspace-layout-leaf"
        data-layout-cell-id={node.cellId}
        data-layout-cell-role={node.role ?? "standard"}
      >
        {renderCell(node.cellId, node.role ?? null)}
      </div>
    );
  }

  const style = {
    "--workspace-split-ratio": `${node.ratio * 100}%`,
  } as CSSProperties;
  return (
    <div
      ref={splitRef}
      className={`workspace-layout-split workspace-layout-split-${node.direction}`}
      data-layout-split-id={node.id}
      data-layout-split-direction={node.direction}
      data-layout-split-ratio={node.ratio.toFixed(3)}
      style={style}
    >
      <div className="workspace-layout-branch workspace-layout-branch-first">
        <WorkspaceLayoutNodeView
          node={node.first}
          disabled={disabled}
          renderCell={renderCell}
          onSplitRatioChange={onSplitRatioChange}
        />
      </div>
      <div className="workspace-layout-branch workspace-layout-branch-second">
        <WorkspaceLayoutNodeView
          node={node.second}
          disabled={disabled}
          renderCell={renderCell}
          onSplitRatioChange={onSplitRatioChange}
        />
      </div>
      <WorkspaceSplitHandle
        containerRef={splitRef}
        splitId={node.id}
        direction={node.direction}
        ratio={node.ratio}
        disabled={disabled}
        onCommit={onSplitRatioChange}
      />
    </div>
  );
}

export default function WorkspaceLayoutTree({
  tree,
  maximizedCellId,
  disabled = false,
  renderCell,
  onSplitRatioChange,
}: WorkspaceLayoutTreeProps) {
  if (maximizedCellId) {
    return (
      <div
        className="workspace-layout-leaf workspace-layout-leaf-maximized"
        data-layout-cell-id={maximizedCellId}
        data-layout-cell-role={findChartWorkspaceCellRole(tree, maximizedCellId) ?? "standard"}
      >
        {renderCell(
          maximizedCellId,
          findChartWorkspaceCellRole(tree, maximizedCellId),
        )}
      </div>
    );
  }
  return (
    <WorkspaceLayoutNodeView
      node={tree}
      disabled={disabled}
      renderCell={renderCell}
      onSplitRatioChange={onSplitRatioChange}
    />
  );
}
