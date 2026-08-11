import {
  useEffect,
  useState,
  type FormEvent,
} from "react";
import type { ChartLinkViewportIssue } from "./chartLinkCoordinator.js";
import {
  summarizeChartDrawingLink,
  type ChartDrawingLinkSummary,
} from "./chartWorkspaceDrawingLink.js";
import { chartWorkspaceTemplateCellCount } from "./chartWorkspaceLayout.js";
import type { ChartWorkspacePersistenceMode } from "./chartWorkspaceRepository.js";
import {
  CHART_DRAWING_LAYER_SET_IDS,
  CHART_LINK_GROUP_IDS,
  type ChartDrawingLayerSetId,
  type ChartLinkGroupId,
  type ChartLinkGroupSettings,
  type ChartLinkRole,
  type ChartWorkspaceSummary,
  type ChartWorkspaceTemplateId,
} from "./chartWorkspaceTypes.js";
import type {
  ChartWorkspaceRuntime,
  ChartWorkspaceSaveState,
} from "./useChartWorkspaceRuntime.js";

type WorkspacePanelTab = "workspaces" | "layout" | "links";

const TABS: ReadonlyArray<{ id: WorkspacePanelTab; label: string }> = [
  { id: "workspaces", label: "工作区" },
  { id: "layout", label: "布局与窗口" },
  { id: "links", label: "联动" },
];

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

const LINK_SETTING_OPTIONS: ReadonlyArray<{
  key: keyof ChartLinkGroupSettings;
  label: string;
  description: string;
}> = [
  { key: "market", label: "品种", description: "同步交易所、市场类型和品种" },
  { key: "interval", label: "周期", description: "同步图表周期" },
  { key: "crosshair", label: "十字线", description: "按市场时间同步十字线" },
  { key: "timeAnchor", label: "右端", description: "对齐可视窗口右端，保留各图缩放" },
  { key: "dateRange", label: "范围", description: "同步完整日期范围与缩放" },
  { key: "drawings", label: "绘图", description: "同市场、同图层集共享绘图文档" },
];

const LINK_ROLE_OPTIONS: ReadonlyArray<{
  id: ChartLinkRole;
  label: string;
  description: string;
}> = [
  { id: "bidirectional", label: "↔ 双向", description: "本图既发送也接收联动变化" },
  { id: "source", label: "→ 源图", description: "本图只发送品种、周期与视图变化" },
  { id: "destination", label: "← 目标图", description: "本图只接收联动变化" },
];

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
  if (mode === "workspace-bus") return "WorkspaceBus 单写入者";
  return "本地自动保存";
}

function drawingLinkStatusText(summary: ChartDrawingLinkSummary): string {
  if (summary.state === "linked") return `绘图已与 ${summary.linkedPeerCount} 个图表共享`;
  if (summary.state === "waiting") return "绘图联动等待同组图表";
  if (summary.state === "market-mismatch") return "绘图未共享：同组图表的市场身份不同";
  if (summary.state === "layer-mismatch") return "绘图未共享：请选择相同图层集";
  return summary.state === "disabled" ? "绘图联动未开启" : "独立绘图文档";
}

export interface WorkspacePanelDesktopModel {
  mode: "web" | "native";
  multiWindowEnabled: boolean;
  displayCount: number;
  error: string | null;
}

export interface WorkspacePanelProps {
  isOpen: boolean;
  onClose(): void;
  runtime: ChartWorkspaceRuntime;
  desktop: WorkspacePanelDesktopModel;
  viewportIssue: ChartLinkViewportIssue | null;
}

export default function WorkspacePanel({
  isOpen,
  onClose,
  runtime,
  desktop,
  viewportIssue,
}: WorkspacePanelProps) {
  const [tab, setTab] = useState<WorkspacePanelTab>("workspaces");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(runtime.view.activeWorkspaceName);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (editingName) {
        setEditingName(false);
        setNameDraft(runtime.view.activeWorkspaceName);
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [editingName, isOpen, onClose, runtime.view.activeWorkspaceName]);

  if (!isOpen) return null;

  const {
    actions,
    status,
    view,
  } = runtime;
  const stateLabel = saveStateLabel(status.saveState);
  const activeCellOrdinal = Math.max(0, view.layoutCellIds.indexOf(view.activeCellId)) + 1;
  const linkGroup = view.activeCell.linkGroup;
  const linkSettings = linkGroup ? view.document.linkGroups[linkGroup] : null;
  const drawingSummary = summarizeChartDrawingLink(
    view.document,
    view.activeCellId,
    view.visibleCellIds,
  );
  const nativeWindowsEnabled = desktop.mode === "native" && desktop.multiWindowEnabled;
  const windowCount = Object.keys(view.document.windows).length;
  const windowStatus = desktop.error || (desktop.mode === "web"
    ? "Web 单窗口 · 原生多窗口不可用"
    : nativeWindowsEnabled
      ? windowCount >= 4
        ? "4 / 4 窗口 · 已达应用上限"
        : `${windowCount} / 4 窗口 · ${desktop.displayCount} 个显示器`
      : "原生多窗口未启用");

  const submitRename = (event: FormEvent) => {
    event.preventDefault();
    if (!nameDraft.trim()) return;
    actions.renameWorkspace(view.activeWorkspaceId, nameDraft);
    setEditingName(false);
  };

  return (
    <div className="workspace-panel-overlay" onClick={onClose}>
      <aside
        className="workspace-panel"
        role="dialog"
        aria-modal="true"
        aria-label="图表工作区管理"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="workspace-panel-header">
          <div>
            <div className="workspace-panel-kicker">MULTI-CHART</div>
            <h2>图表工作区</h2>
            <p>{view.activeWorkspaceName} · {view.layoutCellIds.length} 个图表</p>
          </div>
          <div className="workspace-panel-header-actions">
            <span
              className="workspace-panel-save-state"
              data-save-state={status.saveState}
              title={status.error ?? stateLabel}
            >
              <span aria-hidden="true" />
              {stateLabel}
            </span>
            <button
              type="button"
              className="workspace-panel-close"
              onClick={onClose}
              aria-label="关闭图表工作区侧栏"
            >
              ✕
            </button>
          </div>
        </header>

        <nav className="workspace-panel-tabs" aria-label="图表工作区管理分类" role="tablist">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              className={tab === item.id ? "active" : ""}
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="workspace-panel-content">
          {tab === "workspaces" && (
            <div className="workspace-panel-section-stack" data-workspace-panel-tab="workspaces">
              <section className="workspace-panel-section">
                <div className="workspace-panel-section-heading">
                  <div>
                    <h3>已保存工作区</h3>
                    <p>{view.workspaces.length} 个本地工作区，切换后自动恢复布局</p>
                  </div>
                </div>

                <div className="workspace-panel-workspace-list" role="listbox" aria-label="已保存工作区">
                  {view.workspaces.map((workspace) => (
                    <button
                      key={workspace.id}
                      type="button"
                      className={workspace.id === view.activeWorkspaceId ? "active" : ""}
                      role="option"
                      aria-selected={workspace.id === view.activeWorkspaceId}
                      disabled={!view.ready}
                      onClick={() => {
                        setEditingName(false);
                        setConfirmDelete(false);
                        actions.switchWorkspace(workspace.id);
                      }}
                    >
                      <span className="workspace-panel-option-check" aria-hidden="true">
                        {workspace.id === view.activeWorkspaceId ? "✓" : ""}
                      </span>
                      <span>
                        <strong>{workspace.name}</strong>
                        <small>{LAYOUT_LABELS[workspace.layout]}</small>
                      </span>
                    </button>
                  ))}
                </div>

                {editingName ? (
                  <form className="workspace-panel-rename-form" onSubmit={submitRename}>
                    <label htmlFor="workspace-panel-name-input">重命名当前工作区</label>
                    <div>
                      <input
                        autoFocus
                        id="workspace-panel-name-input"
                        value={nameDraft}
                        maxLength={48}
                        onChange={(event) => setNameDraft(event.currentTarget.value)}
                      />
                      <button type="submit" disabled={!nameDraft.trim()}>确定</button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingName(false);
                          setNameDraft(view.activeWorkspaceName);
                        }}
                      >
                        取消
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="workspace-panel-current-actions" aria-label="当前工作区操作">
                    <button
                      type="button"
                      onClick={() => {
                        setNameDraft(view.activeWorkspaceName);
                        setEditingName(true);
                        setConfirmDelete(false);
                      }}
                    >
                      重命名
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDelete(false);
                        actions.duplicateWorkspace(view.activeWorkspaceId);
                      }}
                    >
                      另存副本
                    </button>
                    <button
                      type="button"
                      className={confirmDelete ? "danger confirm" : "danger"}
                      disabled={view.workspaces.length <= 1}
                      title={view.workspaces.length <= 1 ? "至少保留一个工作区" : "删除当前工作区"}
                      onClick={() => {
                        if (!confirmDelete) {
                          setConfirmDelete(true);
                          return;
                        }
                        setConfirmDelete(false);
                        actions.deleteWorkspace(view.activeWorkspaceId);
                      }}
                    >
                      {confirmDelete ? "确认删除" : "删除"}
                    </button>
                  </div>
                )}
              </section>

              <section className="workspace-panel-section">
                <div className="workspace-panel-section-heading">
                  <div>
                    <h3>新建工作区</h3>
                    <p>沿用当前品种与图表偏好</p>
                  </div>
                </div>
                <div className="workspace-panel-template-grid workspace-panel-template-grid-compact">
                  {TEMPLATE_OPTIONS.filter((template) => (
                    chartWorkspaceTemplateCellCount(template.id) <= view.maxCellsPerWindow
                  )).map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      disabled={!view.ready}
                      onClick={() => {
                        setEditingName(false);
                        setConfirmDelete(false);
                        actions.createWorkspace(template.id);
                      }}
                    >
                      <span className="workspace-panel-template-glyph" aria-hidden="true">{template.glyph}</span>
                      <span>
                        <strong>{template.label}</strong>
                        <small>{template.description}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </section>

              <footer className="workspace-panel-persistence">
                <span>{persistenceLabel(status.persistenceMode)}</span>
                {status.error && <strong>{status.error}</strong>}
              </footer>
            </div>
          )}

          {tab === "layout" && (
            <div className="workspace-panel-section-stack" data-workspace-panel-tab="layout">
              <section className="workspace-panel-section">
                <div className="workspace-panel-section-heading">
                  <div>
                    <h3>当前窗口布局</h3>
                    <p>{view.layoutLocked ? "布局已锁定，先解锁再调整" : "选择模板会保留当前活动图表内容"}</p>
                  </div>
                  <span className="workspace-panel-count-pill">{view.layoutCellIds.length} 图</span>
                </div>
                <div className="workspace-panel-template-grid">
                  {TEMPLATE_OPTIONS.filter((template) => (
                    chartWorkspaceTemplateCellCount(template.id) <= view.maxCellsPerWindow
                  )).map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      className={view.layout === template.id ? "active" : ""}
                      disabled={!view.ready || view.layoutLocked}
                      aria-pressed={view.layout === template.id}
                      onClick={() => actions.setLayout(template.id)}
                    >
                      <span className="workspace-panel-template-glyph" aria-hidden="true">{template.glyph}</span>
                      <span>
                        <strong>{template.label}</strong>
                        <small>{template.description}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="workspace-panel-section">
                <div className="workspace-panel-section-heading">
                  <div>
                    <h3>布局操作</h3>
                    <p>撤销、重做与重置只影响当前工作区</p>
                  </div>
                </div>
                <div className="workspace-panel-action-grid">
                  <button
                    type="button"
                    disabled={!view.ready || view.layoutLocked || !view.canUndoLayout}
                    onClick={actions.undoLayout}
                  >
                    <span aria-hidden="true">↶</span>
                    撤销
                    <small>Ctrl + Z</small>
                  </button>
                  <button
                    type="button"
                    disabled={!view.ready || view.layoutLocked || !view.canRedoLayout}
                    onClick={actions.redoLayout}
                  >
                    <span aria-hidden="true">↷</span>
                    重做
                    <small>Ctrl + Shift + Z</small>
                  </button>
                  <button
                    type="button"
                    disabled={!view.ready || view.layoutLocked}
                    onClick={actions.resetLayout}
                  >
                    <span aria-hidden="true">⟲</span>
                    只保留当前图
                  </button>
                  <button
                    type="button"
                    className={view.layoutLocked ? "active" : ""}
                    disabled={!view.ready}
                    aria-pressed={view.layoutLocked}
                    onClick={() => actions.setLayoutLocked(!view.layoutLocked)}
                  >
                    <span aria-hidden="true">{view.layoutLocked ? "🔒" : "🔓"}</span>
                    {view.layoutLocked ? "解锁布局" : "锁定布局"}
                  </button>
                </div>
              </section>

              <section className="workspace-panel-section">
                <div className="workspace-panel-section-heading workspace-panel-window-heading">
                  <div>
                    <h3>原生窗口</h3>
                    <p data-state={desktop.error ? "error" : "ready"}>{windowStatus}</p>
                  </div>
                  <span className="workspace-panel-count-pill">{windowCount} 窗口</span>
                </div>
                {nativeWindowsEnabled ? (
                  <div className="workspace-panel-window-actions">
                    <button
                      type="button"
                      disabled={!view.ready || windowCount >= 4}
                      onClick={actions.createWindow}
                    >
                      + 新建原生窗口
                    </button>
                    {view.window.id !== "main-window" && (
                      <button
                        type="button"
                        className="danger"
                        disabled={!view.ready}
                        onClick={() => actions.closeWindow(view.window.id)}
                      >
                        关闭当前窗口
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="workspace-panel-guidance">
                    多窗口由桌面版功能开关控制；Web 页面仍可在单窗口内使用全部多图布局。
                  </div>
                )}
              </section>
            </div>
          )}

          {tab === "links" && (
            <div className="workspace-panel-section-stack" data-workspace-panel-tab="links">
              <section className="workspace-panel-context-card" data-link-group={linkGroup ?? "none"}>
                <div>
                  <span>当前活动图表</span>
                  <strong>图表 {activeCellOrdinal} / {view.layoutCellIds.length}</strong>
                </div>
                <span>{linkGroup ? `联动组 ${linkGroup}` : "独立图表"}</span>
              </section>

              <section className="workspace-panel-section">
                <div className="workspace-panel-section-heading">
                  <div>
                    <h3>联动组</h3>
                    <p>同组图表可以按需同步品种、周期与视图</p>
                  </div>
                </div>
                <label className="workspace-panel-field">
                  <span>当前图表加入</span>
                  <select
                    value={linkGroup ?? ""}
                    disabled={!view.ready}
                    onChange={(event) => actions.setCellLinkGroup(
                      view.activeCellId,
                      (event.currentTarget.value || null) as ChartLinkGroupId | null,
                    )}
                  >
                    <option value="">独立，不联动</option>
                    {CHART_LINK_GROUP_IDS.map((group) => (
                      <option key={group} value={group}>组 {group}</option>
                    ))}
                  </select>
                </label>
              </section>

              {linkGroup && linkSettings ? (
                <>
                  <section className="workspace-panel-section">
                    <div className="workspace-panel-section-heading">
                      <div>
                        <h3>本图角色</h3>
                        <p>{LINK_ROLE_OPTIONS.find((option) => option.id === view.activeCell.linkRole)?.description}</p>
                      </div>
                    </div>
                    <div className="workspace-panel-segmented" role="group" aria-label="当前图表联动角色">
                      {LINK_ROLE_OPTIONS.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          className={view.activeCell.linkRole === option.id ? "active" : ""}
                          aria-pressed={view.activeCell.linkRole === option.id}
                          disabled={!view.ready}
                          onClick={() => actions.setCellLinkRole(view.activeCellId, option.id)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="workspace-panel-section">
                    <div className="workspace-panel-section-heading">
                      <div>
                        <h3>同步内容</h3>
                        <p>设置会应用到整个联动组 {linkGroup}</p>
                      </div>
                    </div>
                    <div className="workspace-panel-link-settings">
                      {LINK_SETTING_OPTIONS.map((option) => (
                        <button
                          key={option.key}
                          type="button"
                          className={linkSettings[option.key] ? "active" : ""}
                          aria-pressed={linkSettings[option.key]}
                          title={option.description}
                          disabled={!view.ready}
                          onClick={() => actions.updateLinkGroupSettings(linkGroup, {
                            [option.key]: !linkSettings[option.key],
                          })}
                        >
                          <span>{option.label}</span>
                          <small>{option.description}</small>
                        </button>
                      ))}
                    </div>
                  </section>

                  {linkSettings.drawings && (
                    <section className="workspace-panel-section">
                      <div className="workspace-panel-section-heading">
                        <div>
                          <h3>共享绘图图层</h3>
                          <p>同组且同市场的图表需要选择相同图层集</p>
                        </div>
                      </div>
                      <div className="workspace-panel-segmented" role="group" aria-label="共享绘图图层集">
                        {CHART_DRAWING_LAYER_SET_IDS.map((layerSet) => (
                          <button
                            key={layerSet}
                            type="button"
                            className={view.activeCell.drawingLayerSet === layerSet ? "active" : ""}
                            aria-pressed={view.activeCell.drawingLayerSet === layerSet}
                            disabled={!view.ready}
                            onClick={() => actions.setCellDrawingLayerSet(
                              view.activeCellId,
                              layerSet as ChartDrawingLayerSetId,
                            )}
                          >
                            图层 {layerSet}
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                </>
              ) : (
                <div className="workspace-panel-empty-state">
                  <span aria-hidden="true">↔</span>
                  <strong>当前图表保持独立</strong>
                  <p>选择 A–D 任一联动组后，可继续设置同步方向与内容。</p>
                </div>
              )}

              <div className="workspace-panel-link-status" data-state={drawingSummary.state}>
                {drawingLinkStatusText(drawingSummary)}
              </div>
              {viewportIssue?.group === linkGroup && (
                <div className="workspace-panel-link-status warning" role="status">
                  {viewportIssue.kind === "timeAnchor" ? "右端时间" : "日期范围"}
                  {`无法映射到 ${viewportIssue.failedCellIds.length} 个目标图，目标图已保持原位。`}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
