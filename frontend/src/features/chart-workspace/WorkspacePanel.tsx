import {
  useEffect,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import type { ChartLinkViewportIssue } from "./chartLinkCoordinator.js";
import {
  summarizeChartDrawingLink,
  type ChartDrawingLinkSummary,
} from "./chartWorkspaceDrawingLink.js";
import {
  chartWorkspaceTemplateCellCount,
  visibleCellIds,
} from "./chartWorkspaceLayout.js";
import {
  chartLinkGroupDepth,
  isChartLinkGroupDescendant,
} from "./chartWorkspaceLinkModel.js";
import type { ChartLinkGroupSettingsPatch } from "./chartWorkspaceLinkModel.js";
import type { ChartWorkspacePersistenceMode } from "./chartWorkspaceRepository.js";
import {
  CHART_DRAWING_LAYER_SET_IDS,
  type ChartDrawingLayerSetId,
  type ChartLinkGroupId,
  type ChartLinkGroupSettings,
  type ChartLinkIndicatorSettings,
  type ChartWorkspaceDocument,
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
  key: Exclude<keyof ChartLinkGroupSettings, "indicators">;
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

const INDICATOR_LINK_OPTIONS: ReadonlyArray<{
  key: keyof ChartLinkIndicatorSettings;
  label: string;
  description: string;
}> = [
  { key: "definitions", label: "指标列表", description: "同步新增、删除与指标类型" },
  { key: "parameters", label: "指标参数", description: "按稳定绑定 ID 同步参数" },
  { key: "visual", label: "显示样式", description: "同步显隐、线条和渲染样式" },
  { key: "paneLayout", label: "窗格位置", description: "同步主图或副图窗格位置" },
];

function LinkPolicyEditor({
  title,
  description,
  policy,
  disabled,
  includeDrawings = true,
  onChange,
}: {
  title: string;
  description: string;
  policy: ChartLinkGroupSettings;
  disabled: boolean;
  includeDrawings?: boolean;
  onChange(patch: ChartLinkGroupSettingsPatch): void;
}) {
  return (
    <section className="workspace-panel-section">
      <div className="workspace-panel-section-heading">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </div>
      <div className="workspace-panel-link-settings">
        {LINK_SETTING_OPTIONS.filter((option) => includeDrawings || option.key !== "drawings")
          .map((option) => (
          <button
            key={option.key}
            type="button"
            className={policy[option.key] ? "active" : ""}
            aria-pressed={policy[option.key]}
            title={option.description}
            disabled={disabled}
            onClick={() => onChange({ [option.key]: !policy[option.key] })}
          >
            <span>{option.label}</span>
            <small>{option.description}</small>
          </button>
          ))}
      </div>
      <div className="workspace-panel-section-heading">
        <div>
          <h3>指标联动</h3>
          <p>只传配置，不复制计算结果；每个目标图仍按自己的数据计算</p>
        </div>
      </div>
      <div className="workspace-panel-link-settings">
        {INDICATOR_LINK_OPTIONS.map((option) => (
          <button
            key={option.key}
            type="button"
            className={policy.indicators[option.key] ? "active" : ""}
            aria-pressed={policy.indicators[option.key]}
            title={option.description}
            disabled={disabled}
            onClick={() => onChange({
              indicators: { [option.key]: !policy.indicators[option.key] },
            })}
          >
            <span>{option.label}</span>
            <small>{option.description}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

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

function orderedLinkGroupTree(document: ChartWorkspaceDocument) {
  const ordered: Array<ChartWorkspaceDocument["linkGroups"][ChartLinkGroupId]> = [];
  const visit = (parentId: ChartLinkGroupId | null) => {
    Object.values(document.linkGroups)
      .filter((group) => group.parentId === parentId)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .forEach((group) => {
        ordered.push(group);
        visit(group.id);
      });
  };
  visit(null);
  return ordered;
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
  const [selectedGroupId, setSelectedGroupId] = useState<ChartLinkGroupId | null>(
    runtime.view.activeCell.linkGroupId,
  );

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
  const activeLinkGroupId = view.activeCell.linkGroupId;
  const orderedLinkGroups = orderedLinkGroupTree(view.document);
  const mountedLinkCellIds = new Set(Object.values(view.document.windows)
    .flatMap((window) => visibleCellIds(window.layoutTree)));
  const effectiveSelectedGroupId = selectedGroupId && view.document.linkGroups[selectedGroupId]
    ? selectedGroupId
    : activeLinkGroupId && view.document.linkGroups[activeLinkGroupId]
      ? activeLinkGroupId
      : orderedLinkGroups[0]?.id ?? null;
  const selectedGroup = effectiveSelectedGroupId
    ? view.document.linkGroups[effectiveSelectedGroupId] ?? null
    : null;
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
              <section
                className="workspace-panel-context-card"
                data-link-group={activeLinkGroupId ?? "none"}
                style={activeLinkGroupId ? {
                  "--chart-link-group-color": view.document.linkGroups[activeLinkGroupId]?.color,
                } as CSSProperties : undefined}
              >
                <div>
                  <span>当前活动图表</span>
                  <strong>图表 {activeCellOrdinal} / {view.layoutCellIds.length}</strong>
                </div>
                <span>{activeLinkGroupId
                  ? view.document.linkGroups[activeLinkGroupId]?.name ?? "未知联动组"
                  : "独立图表"}</span>
              </section>

              <section className="workspace-panel-section">
                <div className="workspace-panel-section-heading">
                  <div>
                    <h3>父子联动组</h3>
                    <p>同组平级互联；父组向全部子孙组单向传递</p>
                  </div>
                  <span className="workspace-panel-count-pill">{orderedLinkGroups.length} 组</span>
                </div>
                <div className="workspace-panel-workspace-list workspace-panel-link-group-tree">
                  {orderedLinkGroups.map((group) => {
                    const depth = chartLinkGroupDepth(view.document, group.id) - 1;
                    const cellCount = Object.values(view.document.cells)
                      .filter((cell) => mountedLinkCellIds.has(cell.id)
                        && cell.linkGroupId === group.id).length;
                    return (
                      <button
                        key={group.id}
                        type="button"
                        className={effectiveSelectedGroupId === group.id ? "active" : ""}
                        disabled={!view.ready}
                        style={{ paddingLeft: `${8 + depth * 18}px` }}
                        onClick={() => setSelectedGroupId(group.id)}
                      >
                        <span
                          className="workspace-panel-option-check"
                          style={{ color: group.color }}
                          aria-hidden="true"
                        >
                          {group.parentId ? "└" : "●"}
                        </span>
                        <span>
                          <strong>{group.name}</strong>
                          <small>{group.parentId ? "接收父组 · " : "根组 · "}{cellCount} 个图表</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="workspace-panel-window-actions">
                  <button
                    type="button"
                    disabled={!view.ready}
                    onClick={() => actions.createLinkGroup(null)}
                  >
                    + 根组
                  </button>
                  <button
                    type="button"
                    disabled={!view.ready || !selectedGroup}
                    onClick={() => actions.createLinkGroup(selectedGroup?.id ?? null)}
                  >
                    + 子组
                  </button>
                </div>
                <label className="workspace-panel-field">
                  <span>当前图表加入</span>
                  <select
                    value={activeLinkGroupId ?? ""}
                    disabled={!view.ready}
                    onChange={(event) => actions.setCellLinkGroup(
                      view.activeCellId,
                      (event.currentTarget.value || null) as ChartLinkGroupId | null,
                    )}
                  >
                    <option value="">独立，不联动</option>
                    {orderedLinkGroups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {"— ".repeat(chartLinkGroupDepth(view.document, group.id) - 1)}{group.name}
                      </option>
                    ))}
                  </select>
                </label>
              </section>

              {selectedGroup ? (
                <>
                  <section className="workspace-panel-section">
                    <div className="workspace-panel-section-heading">
                      <div>
                        <h3>组信息</h3>
                        <p>调整名称、颜色与父级；最多支持四层</p>
                      </div>
                    </div>
                    <div className="workspace-panel-link-group-fields">
                      <label className="workspace-panel-field">
                        <span>名称</span>
                        <input
                          value={selectedGroup.name}
                          disabled={!view.ready}
                          maxLength={32}
                          onChange={(event) => actions.updateLinkGroup(selectedGroup.id, {
                            name: event.currentTarget.value,
                          })}
                        />
                      </label>
                      <label className="workspace-panel-field workspace-panel-color-field">
                        <span>颜色</span>
                        <input
                          type="color"
                          value={selectedGroup.color}
                          disabled={!view.ready}
                          onChange={(event) => actions.updateLinkGroup(selectedGroup.id, {
                            color: event.currentTarget.value,
                          })}
                        />
                      </label>
                      <label className="workspace-panel-field">
                        <span>父组</span>
                        <select
                          value={selectedGroup.parentId ?? ""}
                          disabled={!view.ready}
                          onChange={(event) => actions.updateLinkGroup(selectedGroup.id, {
                            parentId: (event.currentTarget.value || null) as ChartLinkGroupId | null,
                          })}
                        >
                          <option value="">无，作为根组</option>
                          {orderedLinkGroups
                            .filter((group) => group.id !== selectedGroup.id
                              && !isChartLinkGroupDescendant(view.document, group.id, selectedGroup.id))
                            .map((group) => (
                              <option key={group.id} value={group.id}>{group.name}</option>
                            ))}
                        </select>
                      </label>
                    </div>
                    <button
                      type="button"
                      className="danger workspace-panel-delete-link-group"
                      disabled={!view.ready || orderedLinkGroups.length <= 1}
                      onClick={() => {
                        actions.deleteLinkGroup(selectedGroup.id);
                        setSelectedGroupId(selectedGroup.parentId);
                      }}
                    >
                      删除此组
                    </button>
                  </section>

                  <LinkPolicyEditor
                    title="同组平级联动"
                    description={`${selectedGroup.name} 内任意图表操作都会同步给同组其他图表`}
                    policy={selectedGroup.peerPolicy}
                    disabled={!view.ready}
                    onChange={(policyPatch) => actions.updateLinkGroupPolicy(
                      selectedGroup.id,
                      "peers",
                      policyPatch,
                    )}
                  />

                  {selectedGroup.parentId && (
                    <LinkPolicyEditor
                      title="接收父组"
                      description={`只接收 ${view.document.linkGroups[selectedGroup.parentId]?.name ?? "父组"} 及其上游事件，不会反向影响父组；绘图因写隔离仅同组共享`}
                      policy={selectedGroup.receiveFromParent}
                      disabled={!view.ready}
                      includeDrawings={false}
                      onChange={(policyPatch) => actions.updateLinkGroupPolicy(
                        selectedGroup.id,
                        "parent",
                        policyPatch,
                      )}
                    />
                  )}

                  {activeLinkGroupId === selectedGroup.id && selectedGroup.peerPolicy.drawings && (
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
                  <span aria-hidden="true">⌘</span>
                  <strong>请选择一个联动组</strong>
                  <p>可以创建根组或在现有组下创建子组。</p>
                </div>
              )}

              <div className="workspace-panel-link-status" data-state={drawingSummary.state}>
                {drawingLinkStatusText(drawingSummary)}
              </div>
              {viewportIssue?.group === activeLinkGroupId && (
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
