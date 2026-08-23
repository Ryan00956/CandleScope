import {
  useEffect,
  useRef,
  useState,
} from "react";
import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import type {
  ChartCellCreationMode,
  ChartCellId,
  ChartWorkspaceSplitDirection,
} from "./chartWorkspaceTypes.js";

export interface WorkspaceCellLayoutMenuProps {
  cellId: ChartCellId;
  layoutCellIds: readonly ChartCellId[];
  maxCellsPerWindow?: number;
  disabled?: boolean;
  onSplit(
    cellId: ChartCellId,
    direction: ChartWorkspaceSplitDirection,
    creationMode: ChartCellCreationMode,
  ): void;
  onClose(cellId: ChartCellId): void;
  onSwap(firstCellId: ChartCellId, secondCellId: ChartCellId): void;
}

function cellNumber(cellId: ChartCellId): string {
  return cellId.slice("cell-".length);
}

export default function WorkspaceCellLayoutMenu({
  cellId,
  layoutCellIds,
  maxCellsPerWindow = 4,
  disabled = false,
  onSplit,
  onClose,
  onSwap,
}: WorkspaceCellLayoutMenuProps) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [creationMode, setCreationMode] = useState<ChartCellCreationMode>("copy");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const canSplit = layoutCellIds.length < maxCellsPerWindow;
  const canClose = layoutCellIds.length > 1;
  const swapTargets = layoutCellIds.filter((candidate) => candidate !== cellId);
  const menuOpen = open && !disabled;

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  const runAndClose = (action: () => void) => {
    action();
    setOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className="workspace-cell-layout-menu"
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <button
        ref={triggerRef}
        type="button"
        className="multi-chart-cell-layout-trigger"
        aria-label={t("workspace.cellMenu", { n: cellNumber(cellId) })}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        title={t("workspace.cellMenuTitle")}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        ⋯
      </button>
      {menuOpen && (
        <div
          className="workspace-cell-layout-popover"
          role="dialog"
          aria-label={t("workspace.cellMenu", { n: cellNumber(cellId) })}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <strong>{t("workspace.cellLayout", { n: cellNumber(cellId) })}</strong>
          <fieldset disabled={!canSplit}>
            <legend>{t("workspace.newContent")}</legend>
            <label>
              <input
                type="radio"
                name={`${cellId}-creation-mode`}
                value="copy"
                checked={creationMode === "copy"}
                onChange={() => setCreationMode("copy")}
              />
              {t("workspace.copyConfig")}
            </label>
            <label>
              <input
                type="radio"
                name={`${cellId}-creation-mode`}
                value="blank"
                checked={creationMode === "blank"}
                onChange={() => setCreationMode("blank")}
              />
              {t("workspace.blankChart")}
            </label>
          </fieldset>
          <div className="workspace-cell-layout-actions">
            <button
              type="button"
              disabled={!canSplit}
              onClick={() => runAndClose(() => onSplit(cellId, "columns", creationMode))}
            >
              {t("workspace.splitRight")}
            </button>
            <button
              type="button"
              disabled={!canSplit}
              onClick={() => runAndClose(() => onSplit(cellId, "rows", creationMode))}
            >
              {t("workspace.splitDown")}
            </button>
          </div>
          {swapTargets.length > 0 && (
            <div className="workspace-cell-swap-actions" aria-label={t("workspace.swap")}>
              <span>{t("workspace.swapLabel")}</span>
              <div>
                {swapTargets.map((targetCellId) => (
                  <button
                    key={targetCellId}
                    type="button"
                    onClick={() => runAndClose(() => onSwap(cellId, targetCellId))}
                  >
                    {t("workspace.cellN", { n: cellNumber(targetCellId) })}
                  </button>
                ))}
              </div>
            </div>
          )}
          <button
            type="button"
            className="workspace-cell-close-action"
            disabled={!canClose}
            onClick={() => runAndClose(() => onClose(cellId))}
          >
            {canClose ? t("workspace.closeChart") : t("workspace.keepOneChart")}
          </button>
        </div>
      )}
    </div>
  );
}
