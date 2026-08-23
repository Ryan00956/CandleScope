import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { t } from "../../i18n/index.js";
import type {
  ChartCellId,
  ChartWorkspaceCellRole,
  ChartWorkspaceLayoutNode,
} from "./chartWorkspaceTypes.js";
import {
  assessWorkspaceLayoutSpace,
  computeWorkspaceLayoutGeometry,
} from "./chartWorkspaceGeometry.js";
import { updateChartWorkspaceSplitRatio } from "./chartWorkspaceLayout.js";
import WorkspaceCellLayer from "./WorkspaceCellLayer.js";
import WorkspaceSplitHandleLayer from "./WorkspaceSplitHandleLayer.js";

export interface WorkspaceLayoutTreeProps {
  tree: ChartWorkspaceLayoutNode;
  maximizedCellId: ChartCellId | null;
  disabled?: boolean;
  renderCell(
    cellId: ChartCellId,
    role: ChartWorkspaceCellRole | null,
    obscured: boolean,
  ): ReactNode;
  onSplitRatioChange(splitId: string, ratio: number): void;
  onCellDrop(sourceCellId: ChartCellId, targetCellId: ChartCellId): void;
}

interface PreviewRatio {
  splitId: string;
  ratio: number;
}

export default function WorkspaceLayoutTree({
  tree,
  maximizedCellId,
  disabled = false,
  renderCell,
  onSplitRatioChange,
  onCellDrop,
}: WorkspaceLayoutTreeProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<PreviewRatio | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const previewTree = useMemo(
    () => preview ? updateChartWorkspaceSplitRatio(tree, preview.splitId, preview.ratio) : tree,
    [preview, tree],
  );
  const geometry = useMemo(
    () => computeWorkspaceLayoutGeometry(previewTree),
    [previewTree],
  );

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return undefined;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setViewport((current) => current.width === rect.width && current.height === rect.height
        ? current
        : { width: rect.width, height: rect.height });
    };
    update();
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const assessment = viewport.width > 0 && viewport.height > 0
    ? assessWorkspaceLayoutSpace(geometry, viewport.width, viewport.height)
    : null;
  const spaceWarning = geometry.leaves.length >= 6 && assessment?.sufficient === false;

  return (
    <div
      ref={rootRef}
      className="workspace-layout-root"
      data-layout-cell-count={geometry.leaves.length}
      data-layout-space={spaceWarning ? "insufficient" : "sufficient"}
    >
      <WorkspaceCellLayer
        rootRef={rootRef}
        geometry={geometry}
        maximizedCellId={maximizedCellId}
        disabled={disabled}
        renderCell={renderCell}
        onCellDrop={onCellDrop}
      />
      {!maximizedCellId && (
        <WorkspaceSplitHandleLayer
          rootRef={rootRef}
          geometry={geometry}
          disabled={disabled}
          onPreview={(splitId, ratio) => setPreview(ratio === null ? null : { splitId, ratio })}
          onCommit={(splitId, ratio) => {
            setPreview(null);
            onSplitRatioChange(splitId, ratio);
          }}
        />
      )}
      {spaceWarning && assessment && (
        <div className="workspace-layout-space-warning" role="status" aria-live="polite">
          {t("workspace.spaceWarning", {
            width: Math.round(assessment.minimumCellWidth),
            height: Math.round(assessment.minimumCellHeight),
          })}
        </div>
      )}
    </div>
  );
}
