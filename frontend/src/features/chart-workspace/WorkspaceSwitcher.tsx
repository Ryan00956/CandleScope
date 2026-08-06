import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { ChartWorkspaceSaveState } from "./useChartWorkspaceRuntime.js";
import type { ChartWorkspacePersistenceMode } from "./chartWorkspaceRepository.js";
import type {
  ChartWorkspaceId,
  ChartWorkspaceSummary,
  ChartWorkspaceTemplateId,
} from "./chartWorkspaceTypes.js";

const TEMPLATE_OPTIONS: ReadonlyArray<{
  id: ChartWorkspaceTemplateId;
  label: string;
  description: string;
  glyph: string;
}> = [
  { id: "single", label: "单图", description: "一个主图表", glyph: "□" },
  { id: "split-vertical", label: "左右双图", description: "并排比较", glyph: "▯▯" },
  { id: "split-horizontal", label: "上下双图", description: "上下确认", glyph: "▭" },
  { id: "main-confirmation", label: "主图 / 确认图", description: "左主图 + 右双确认", glyph: "◧" },
  { id: "quad", label: "四图", description: "多周期工作台", glyph: "▦" },
  { id: "grid-6", label: "六图", description: "2 × 3 矩阵", glyph: "2×3" },
  { id: "grid-8", label: "八图", description: "2 × 4 矩阵", glyph: "2×4" },
  { id: "grid-9", label: "九图", description: "3 × 3 矩阵", glyph: "3×3" },
  { id: "grid-12", label: "十二图", description: "3 × 4 矩阵", glyph: "3×4" },
  { id: "grid-16", label: "十六图", description: "4 × 4 矩阵", glyph: "4×4" },
];

const LAYOUT_LABELS: Record<ChartWorkspaceSummary["layout"], string> = {
  single: "单图",
  "split-vertical": "左右双图",
  "split-horizontal": "上下双图",
  "main-confirmation": "主图 / 确认图",
  quad: "四图",
  "grid-6": "六图",
  "grid-8": "八图",
  "grid-9": "九图",
  "grid-12": "十二图",
  "grid-16": "十六图",
  custom: "自定义布局",
};

function saveStateLabel(state: ChartWorkspaceSaveState): string {
  if (state === "loading") return "正在恢复";
  if (state === "saving") return "正在保存";
  if (state === "error") return "保存失败";
  return "已保存";
}

function persistenceLabel(mode: ChartWorkspacePersistenceMode | null): string {
  if (mode === "indexeddb") return "本地数据库自动保存";
  if (mode === "local-storage") return "本地兼容存储自动保存";
  if (mode === "memory") return "仅本次会话";
  return "本地自动保存";
}

export interface WorkspaceSwitcherProps {
  activeWorkspaceId: ChartWorkspaceId;
  activeWorkspaceName: string;
  workspaces: readonly ChartWorkspaceSummary[];
  ready: boolean;
  saveState: ChartWorkspaceSaveState;
  persistenceMode: ChartWorkspacePersistenceMode | null;
  error: string | null;
  maxCellsPerWindow: number;
  onSwitch(workspaceId: ChartWorkspaceId): void;
  onCreate(templateId: ChartWorkspaceTemplateId): void;
  onDuplicate(workspaceId: ChartWorkspaceId): void;
  onRename(workspaceId: ChartWorkspaceId, name: string): void;
  onDelete(workspaceId: ChartWorkspaceId): void;
}

export default function WorkspaceSwitcher({
  activeWorkspaceId,
  activeWorkspaceName,
  workspaces,
  ready,
  saveState,
  persistenceMode,
  error,
  maxCellsPerWindow,
  onSwitch,
  onCreate,
  onDuplicate,
  onRename,
  onDelete,
}: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(activeWorkspaceName);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      setEditingName(false);
      setConfirmDelete(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (editingName) {
        setEditingName(false);
        setNameDraft(activeWorkspaceName);
        return;
      }
      setOpen(false);
      setConfirmDelete(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeWorkspaceName, editingName, open]);

  useEffect(() => {
    if (editingName) nameInputRef.current?.select();
  }, [editingName]);

  const submitRename = (event: FormEvent) => {
    event.preventDefault();
    if (!nameDraft.trim()) return;
    onRename(activeWorkspaceId, nameDraft);
    setEditingName(false);
  };
  const stateLabel = saveStateLabel(saveState);

  return (
    <div
      ref={rootRef}
      className="workspace-switcher"
      data-save-state={saveState}
    >
      <button
        ref={triggerRef}
        type="button"
        className="workspace-switcher-trigger"
        aria-label={`工作区：${activeWorkspaceName}，${stateLabel}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!ready}
        title={`${activeWorkspaceName} · ${stateLabel}`}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <span className="workspace-save-indicator" aria-hidden="true" />
        <span className="workspace-switcher-name">{activeWorkspaceName}</span>
        <span className="workspace-switcher-chevron" aria-hidden="true">⌄</span>
      </button>

      {open && (
        <div
          className="workspace-switcher-panel"
          role="dialog"
          aria-label="管理图表工作区"
        >
          <div className="workspace-switcher-heading">
            <div>
              <strong>工作区</strong>
              <span>{workspaces.length} 个本地工作区</span>
            </div>
            <span
              className="workspace-persistence-state"
              data-save-state={saveState}
              aria-live="polite"
              title={error ?? stateLabel}
            >
              {stateLabel}
            </span>
          </div>

          <div className="workspace-switcher-list" role="listbox" aria-label="已保存工作区">
            {workspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                className={`workspace-switcher-option${workspace.id === activeWorkspaceId ? " active" : ""}`}
                role="option"
                aria-selected={workspace.id === activeWorkspaceId}
                onClick={() => {
                  onSwitch(workspace.id);
                  setOpen(false);
                }}
              >
                <span className="workspace-switcher-option-check" aria-hidden="true">
                  {workspace.id === activeWorkspaceId ? "✓" : ""}
                </span>
                <span className="workspace-switcher-option-copy">
                  <strong>{workspace.name}</strong>
                  <small>{LAYOUT_LABELS[workspace.layout]}</small>
                </span>
              </button>
            ))}
          </div>

          {editingName ? (
            <form className="workspace-rename-form" onSubmit={submitRename}>
              <label htmlFor="workspace-name-input">重命名当前工作区</label>
              <div>
                <input
                  ref={nameInputRef}
                  id="workspace-name-input"
                  value={nameDraft}
                  maxLength={48}
                  onChange={(event) => setNameDraft(event.currentTarget.value)}
                />
                <button type="submit" disabled={!nameDraft.trim()}>确定</button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingName(false);
                    setNameDraft(activeWorkspaceName);
                  }}
                >
                  取消
                </button>
              </div>
            </form>
          ) : (
            <div className="workspace-switcher-actions" aria-label="当前工作区操作">
              <button
                type="button"
                onClick={() => {
                  setNameDraft(activeWorkspaceName);
                  setEditingName(true);
                  setConfirmDelete(false);
                }}
              >
                重命名
              </button>
              <button
                type="button"
                onClick={() => {
                  onDuplicate(activeWorkspaceId);
                  setOpen(false);
                }}
              >
                另存副本
              </button>
              <button
                type="button"
                className={confirmDelete ? "danger confirm" : "danger"}
                disabled={workspaces.length <= 1}
                title={workspaces.length <= 1 ? "至少保留一个工作区" : "删除当前工作区"}
                onClick={() => {
                  if (!confirmDelete) {
                    setConfirmDelete(true);
                    return;
                  }
                  onDelete(activeWorkspaceId);
                  setOpen(false);
                }}
              >
                {confirmDelete ? "确认删除" : "删除"}
              </button>
            </div>
          )}

          <div className="workspace-template-section">
            <div className="workspace-template-title">
              <strong>新建工作区</strong>
              <span>沿用当前品种与图表偏好</span>
            </div>
            <div className="workspace-template-grid">
              {TEMPLATE_OPTIONS.filter((template) => {
                const cells = Number(template.id.match(/grid-(\d+)/)?.[1]
                  ?? (template.id === "quad" ? 4
                    : template.id === "main-confirmation" ? 3
                      : template.id === "single" ? 1 : 2));
                return cells <= maxCellsPerWindow;
              }).map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => {
                    onCreate(template.id);
                    setOpen(false);
                  }}
                >
                  <span className="workspace-template-glyph" aria-hidden="true">{template.glyph}</span>
                  <span>
                    <strong>{template.label}</strong>
                    <small>{template.description}</small>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="workspace-switcher-footer">
            <span>{persistenceLabel(persistenceMode)}</span>
            {error && <span className="workspace-switcher-error">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
