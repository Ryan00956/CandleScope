import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { PaneMoveDirection } from "./paneControlModel.js";

interface PaneControlBarProps {
  paneId: string;
  paneLabel: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canCollapse: boolean;
  canMaximize: boolean;
  canDelete: boolean;
  collapsed: boolean;
  maximized: boolean;
  onMove(direction: PaneMoveDirection): void;
  onToggleCollapse(): void;
  onToggleMaximize(): void;
  onDelete(): void;
}

function PaneIcon({ kind }: { kind: "up" | "down" | "collapse" | "expand" | "maximize" | "restore" | "delete" }) {
  if (kind === "up" || kind === "down") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d={kind === "up" ? "M5 12.5 10 7l5 5.5" : "m5 7.5 5 5.5 5-5.5"} />
      </svg>
    );
  }
  if (kind === "collapse" || kind === "expand") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M4 10h12" />
        {kind === "collapse" ? (
          <>
            <path d="m7 5 3 3 3-3" />
            <path d="m7 15 3-3 3 3" />
          </>
        ) : (
          <>
            <path d="m7 8 3-3 3 3" />
            <path d="m7 12 3 3 3-3" />
          </>
        )}
      </svg>
    );
  }
  if (kind === "delete") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M4.5 6h11M8 3.5h4M6.5 6l.7 10h5.6l.7-10M8.5 8.5v5M11.5 8.5v5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      {kind === "maximize" ? (
        <>
          <path d="M7.5 4H4v3.5M12.5 4H16v3.5M7.5 16H4v-3.5M12.5 16H16v-3.5" />
        </>
      ) : (
        <>
          <path d="M4 7.5h3.5V4M16 7.5h-3.5V4M4 12.5h3.5V16M16 12.5h-3.5V16" />
        </>
      )}
    </svg>
  );
}

function stopPointer(event: ReactPointerEvent<HTMLDivElement>) {
  event.stopPropagation();
}

function stopClick(event: ReactMouseEvent<HTMLDivElement>) {
  event.stopPropagation();
}

export default function PaneControlBar({
  paneId,
  paneLabel,
  canMoveUp,
  canMoveDown,
  canCollapse,
  canMaximize,
  canDelete,
  collapsed,
  maximized,
  onMove,
  onToggleCollapse,
  onToggleMaximize,
  onDelete,
}: PaneControlBarProps) {
  const title = paneLabel || "主图";
  return (
    <div
      className="pane-control-bar pane-overlay-anchor export-exclude"
      data-pane-id={paneId}
      data-pane-collapsed={collapsed ? "true" : "false"}
      data-pane-maximized={maximized ? "true" : "false"}
      role="toolbar"
      aria-label={`${title}窗格控制`}
      onPointerDown={stopPointer}
      onClick={stopClick}
    >
      <button
        type="button"
        className="pane-control-button"
        aria-label={`上移${title}`}
        title={canMoveUp ? "上移" : "已经位于可移动范围顶部"}
        disabled={!canMoveUp}
        onClick={() => onMove("up")}
      >
        <PaneIcon kind="up" />
      </button>
      <button
        type="button"
        className="pane-control-button"
        aria-label={`下移${title}`}
        title={canMoveDown ? "下移" : "已经位于可移动范围底部"}
        disabled={!canMoveDown}
        onClick={() => onMove("down")}
      >
        <PaneIcon kind="down" />
      </button>
      <button
        type="button"
        className={`pane-control-button${collapsed ? " active" : ""}`}
        aria-label={`${collapsed ? "展开" : "折叠"}${title}`}
        aria-pressed={collapsed}
        title={collapsed ? "展开" : "折叠"}
        disabled={!canCollapse}
        onClick={onToggleCollapse}
      >
        <PaneIcon kind={collapsed ? "expand" : "collapse"} />
      </button>
      <button
        type="button"
        className={`pane-control-button${maximized ? " active" : ""}`}
        aria-label={`${maximized ? "退出全屏" : "全屏"}${title}`}
        aria-pressed={maximized}
        title={canMaximize ? (maximized ? "退出全屏" : "全屏窗格") : "当前已经是唯一窗格"}
        disabled={!canMaximize}
        onClick={onToggleMaximize}
      >
        <PaneIcon kind={maximized ? "restore" : "maximize"} />
      </button>
      <button
        type="button"
        className="pane-control-button danger"
        aria-label={`删除${title}`}
        title={canDelete ? "删除窗格" : "主图不能删除"}
        disabled={!canDelete}
        onClick={onDelete}
      >
        <PaneIcon kind="delete" />
      </button>
    </div>
  );
}
