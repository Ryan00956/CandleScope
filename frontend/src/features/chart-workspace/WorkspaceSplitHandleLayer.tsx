import type { RefObject } from "react";
import { t } from "../../i18n/index.js";
import type { WorkspaceLayoutGeometry } from "./chartWorkspaceGeometry.js";
import WorkspaceSplitHandle from "./WorkspaceSplitHandles.js";

export interface WorkspaceSplitHandleLayerProps {
  rootRef: RefObject<HTMLDivElement | null>;
  geometry: WorkspaceLayoutGeometry;
  disabled: boolean;
  onPreview(splitId: string, ratio: number | null): void;
  onCommit(splitId: string, ratio: number): void;
}

export default function WorkspaceSplitHandleLayer({
  rootRef,
  geometry,
  disabled,
  onPreview,
  onCommit,
}: WorkspaceSplitHandleLayerProps) {
  return (
    <div className="workspace-split-handle-layer" aria-label={t("workspace.splitLayer")}>
      {geometry.splits.map((split) => (
        <WorkspaceSplitHandle
          key={split.splitId}
          rootRef={rootRef}
          split={split}
          disabled={disabled}
          onPreview={onPreview}
          onCommit={onCommit}
        />
      ))}
    </div>
  );
}
