import {
  useEffect,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { t, type MessageKey } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import { useRightDrawerResize } from "../../shared/useRightDrawerResize.js";
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
import { chartLinkGroupDisplayName } from "./chartWorkspaceI18n.js";
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

const TABS: ReadonlyArray<{ id: WorkspacePanelTab; labelKey: MessageKey }> = [
  { id: "workspaces", labelKey: "workspace.tab.workspaces" },
  { id: "layout", labelKey: "workspace.tab.layout" },
  { id: "links", labelKey: "workspace.tab.links" },
];

const TEMPLATE_OPTIONS: ReadonlyArray<{
  id: ChartWorkspaceTemplateId;
  labelKey: MessageKey;
  descriptionKey: MessageKey;
  glyph: string;
}> = [
  { id: "single", labelKey: "workspace.template.single", descriptionKey: "workspace.template.singleDesc", glyph: "□" },
  { id: "split-vertical", labelKey: "workspace.template.splitVertical", descriptionKey: "workspace.template.splitVerticalDesc", glyph: "▯▯" },
  { id: "split-horizontal", labelKey: "workspace.template.splitHorizontal", descriptionKey: "workspace.template.splitHorizontalDesc", glyph: "▭" },
  { id: "main-confirmation", labelKey: "workspace.template.mainConfirm", descriptionKey: "workspace.template.mainConfirmDesc", glyph: "◧" },
  { id: "quad", labelKey: "workspace.template.quad", descriptionKey: "workspace.template.quadDesc", glyph: "▦" },
  { id: "grid-6", labelKey: "workspace.template.grid6", descriptionKey: "workspace.template.grid6Desc", glyph: "2×3" },
  { id: "grid-8", labelKey: "workspace.template.grid8", descriptionKey: "workspace.template.grid8Desc", glyph: "2×4" },
  { id: "grid-9", labelKey: "workspace.template.grid9", descriptionKey: "workspace.template.grid9Desc", glyph: "3×3" },
  { id: "grid-12", labelKey: "workspace.template.grid12", descriptionKey: "workspace.template.grid12Desc", glyph: "3×4" },
  { id: "grid-16", labelKey: "workspace.template.grid16", descriptionKey: "workspace.template.grid16Desc", glyph: "4×4" },
];

const LAYOUT_LABELS: Record<ChartWorkspaceSummary["layout"], MessageKey> = {
  single: "workspace.template.single",
  "split-vertical": "workspace.template.splitVertical",
  "split-horizontal": "workspace.template.splitHorizontal",
  "main-confirmation": "workspace.template.mainConfirm",
  quad: "workspace.template.quad",
  "grid-6": "workspace.template.grid6",
  "grid-8": "workspace.template.grid8",
  "grid-9": "workspace.template.grid9",
  "grid-12": "workspace.template.grid12",
  "grid-16": "workspace.template.grid16",
  custom: "workspace.layout.custom",
};

const LINK_SETTING_OPTIONS: ReadonlyArray<{
  key: Exclude<keyof ChartLinkGroupSettings, "indicators">;
  labelKey: MessageKey;
  descriptionKey: MessageKey;
}> = [
  { key: "market", labelKey: "workspace.link.market", descriptionKey: "workspace.link.marketDesc" },
  { key: "interval", labelKey: "workspace.link.interval", descriptionKey: "workspace.link.intervalDesc" },
  { key: "crosshair", labelKey: "workspace.link.crosshair", descriptionKey: "workspace.link.crosshairDesc" },
  { key: "timeAnchor", labelKey: "workspace.link.timeAnchor", descriptionKey: "workspace.link.timeAnchorDesc" },
  { key: "dateRange", labelKey: "workspace.link.dateRange", descriptionKey: "workspace.link.dateRangeDesc" },
  { key: "drawings", labelKey: "workspace.link.drawings", descriptionKey: "workspace.link.drawingsDesc" },
];

const INDICATOR_LINK_OPTIONS: ReadonlyArray<{
  key: keyof ChartLinkIndicatorSettings;
  labelKey: MessageKey;
  descriptionKey: MessageKey;
}> = [
  { key: "definitions", labelKey: "workspace.link.definitions", descriptionKey: "workspace.link.definitionsDesc" },
  { key: "parameters", labelKey: "workspace.link.parameters", descriptionKey: "workspace.link.parametersDesc" },
  { key: "visual", labelKey: "workspace.link.visual", descriptionKey: "workspace.link.visualDesc" },
  { key: "paneLayout", labelKey: "workspace.link.paneLayout", descriptionKey: "workspace.link.paneLayoutDesc" },
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
            title={t(option.descriptionKey)}
            disabled={disabled}
            onClick={() => onChange({ [option.key]: !policy[option.key] })}
          >
            <span>{t(option.labelKey)}</span>
            <small>{t(option.descriptionKey)}</small>
          </button>
          ))}
      </div>
      <div className="workspace-panel-section-heading">
        <div>
          <h3>{t("workspace.indicatorLink")}</h3>
          <p>{t("workspace.indicatorLinkHint")}</p>
        </div>
      </div>
      <div className="workspace-panel-link-settings">
        {INDICATOR_LINK_OPTIONS.map((option) => (
          <button
            key={option.key}
            type="button"
            className={policy.indicators[option.key] ? "active" : ""}
            aria-pressed={policy.indicators[option.key]}
            title={t(option.descriptionKey)}
            disabled={disabled}
            onClick={() => onChange({
              indicators: { [option.key]: !policy.indicators[option.key] },
            })}
          >
            <span>{t(option.labelKey)}</span>
            <small>{t(option.descriptionKey)}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function saveStateLabel(state: ChartWorkspaceSaveState): string {
  if (state === "loading") return t("workspace.save.loading");
  if (state === "saving") return t("workspace.save.saving");
  if (state === "error") return t("workspace.save.error");
  return t("workspace.save.saved");
}

function persistenceLabel(mode: ChartWorkspacePersistenceMode | null): string {
  if (mode === "indexeddb") return t("workspace.persist.indexeddb");
  if (mode === "local-storage") return t("workspace.persist.localStorage");
  if (mode === "memory") return t("workspace.persist.memory");
  if (mode === "workspace-bus") return t("workspace.persist.bus");
  return t("workspace.persist.local");
}

function drawingLinkStatusText(summary: ChartDrawingLinkSummary): string {
  if (summary.state === "linked") return t("workspace.drawing.linked", { count: summary.linkedPeerCount });
  if (summary.state === "waiting") return t("workspace.drawing.waiting");
  if (summary.state === "market-mismatch") return t("workspace.drawing.marketMismatch");
  if (summary.state === "layer-mismatch") return t("workspace.drawing.layerMismatch");
  return summary.state === "disabled" ? t("workspace.drawing.disabled") : t("workspace.drawing.independent");
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
  useLocale();
  const [tab, setTab] = useState<WorkspacePanelTab>("workspaces");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(runtime.view.activeWorkspaceName);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<ChartLinkGroupId | null>(
    runtime.view.activeCell.linkGroupId,
  );
  const {
    width: panelWidth,
    isResizing,
    resizeHandleProps,
  } = useRightDrawerResize({
    initialWidth: 430,
    minWidth: 360,
    maxWidth: 780,
  });

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !editingName) return;
      event.preventDefault();
      setEditingName(false);
      setNameDraft(runtime.view.activeWorkspaceName);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [editingName, isOpen, runtime.view.activeWorkspaceName]);

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
    ? t("workspace.webWindows")
    : nativeWindowsEnabled
      ? windowCount >= 4
        ? t("workspace.windowCap")
        : t("workspace.windowStatus", { count: windowCount, displays: desktop.displayCount })
      : t("workspace.nativeOff"));

  const submitRename = (event: FormEvent) => {
    event.preventDefault();
    if (!nameDraft.trim()) return;
    actions.renameWorkspace(view.activeWorkspaceId, nameDraft);
    setEditingName(false);
  };

  return (
    <div className={`workspace-panel-overlay right-drawer-overlay ${isResizing ? "is-resizing" : ""}`}>
      <aside
        className="workspace-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("workspace.manage")}
        style={{ width: `${panelWidth}px` }}
      >
        <div
          {...resizeHandleProps}
          className="right-drawer-resize-handle"
          aria-label={t("rail.resizeWidth")}
        />
        <header className="workspace-panel-header">
          <div>
            <div className="workspace-panel-kicker">{t("workspace.kicker")}</div>
            <h2>{t("workspace.title")}</h2>
            <p>{t("workspace.chartCount", { name: view.activeWorkspaceName, count: view.layoutCellIds.length })}</p>
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
              aria-label={t("workspace.close")}
            >
              ✕
            </button>
          </div>
        </header>

        <nav className="workspace-panel-tabs" aria-label={t("workspace.tabs")} role="tablist">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              className={tab === item.id ? "active" : ""}
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </nav>

        <div className="workspace-panel-content">
          {tab === "workspaces" && (
            <div className="workspace-panel-section-stack" data-workspace-panel-tab="workspaces">
              <section className="workspace-panel-section">
                <div className="workspace-panel-section-heading">
                  <div>
                    <h3>{t("workspace.saved")}</h3>
                    <p>{t("workspace.savedHint", { count: view.workspaces.length })}</p>
                  </div>
                </div>

                <div className="workspace-panel-workspace-list" role="listbox" aria-label={t("workspace.saved")}>
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
                        <small>{t(LAYOUT_LABELS[workspace.layout])}</small>
                      </span>
                    </button>
                  ))}
                </div>

                {editingName ? (
                  <form className="workspace-panel-rename-form" onSubmit={submitRename}>
                    <label htmlFor="workspace-panel-name-input">{t("workspace.renameCurrent")}</label>
                    <div>
                      <input
                        autoFocus
                        id="workspace-panel-name-input"
                        value={nameDraft}
                        maxLength={48}
                        onChange={(event) => setNameDraft(event.currentTarget.value)}
                      />
                      <button type="submit" disabled={!nameDraft.trim()}>{t("workspace.ok")}</button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingName(false);
                          setNameDraft(view.activeWorkspaceName);
                        }}
                      >
                        {t("workspace.cancel")}
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="workspace-panel-current-actions" aria-label={t("workspace.currentActions")}>
                    <button
                      type="button"
                      onClick={() => {
                        setNameDraft(view.activeWorkspaceName);
                        setEditingName(true);
                        setConfirmDelete(false);
                      }}
                    >
                      {t("workspace.rename")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDelete(false);
                        actions.duplicateWorkspace(view.activeWorkspaceId);
                      }}
                    >
                      {t("workspace.duplicate")}
                    </button>
                    <button
                      type="button"
                      className={confirmDelete ? "danger confirm" : "danger"}
                      disabled={view.workspaces.length <= 1}
                      title={view.workspaces.length <= 1 ? t("workspace.keepOne") : t("workspace.deleteCurrent")}
                      onClick={() => {
                        if (!confirmDelete) {
                          setConfirmDelete(true);
                          return;
                        }
                        setConfirmDelete(false);
                        actions.deleteWorkspace(view.activeWorkspaceId);
                      }}
                    >
                      {confirmDelete ? t("workspace.confirmDelete") : t("workspace.delete")}
                    </button>
                  </div>
                )}
              </section>

              <section className="workspace-panel-section">
                <div className="workspace-panel-section-heading">
                  <div>
                    <h3>{t("workspace.create")}</h3>
                    <p>{t("workspace.createHint")}</p>
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
                        <strong>{t(template.labelKey)}</strong>
                        <small>{t(template.descriptionKey)}</small>
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
                    <h3>{t("workspace.currentLayout")}</h3>
                    <p>{view.layoutLocked ? t("workspace.layoutLockedHint") : t("workspace.layoutHint")}</p>
                  </div>
                  <span className="workspace-panel-count-pill">{t("workspace.chartCountPill", { count: view.layoutCellIds.length })}</span>
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
                        <strong>{t(template.labelKey)}</strong>
                        <small>{t(template.descriptionKey)}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="workspace-panel-section">
                <div className="workspace-panel-section-heading">
                  <div>
                    <h3>{t("workspace.layoutActions")}</h3>
                    <p>{t("workspace.layoutActionsHint")}</p>
                  </div>
                </div>
                <div className="workspace-panel-action-grid">
                  <button
                    type="button"
                    disabled={!view.ready || view.layoutLocked || !view.canUndoLayout}
                    onClick={actions.undoLayout}
                  >
                    <span aria-hidden="true">↶</span>
                    {t("workspace.undo")}
                    <small>Ctrl + Z</small>
                  </button>
                  <button
                    type="button"
                    disabled={!view.ready || view.layoutLocked || !view.canRedoLayout}
                    onClick={actions.redoLayout}
                  >
                    <span aria-hidden="true">↷</span>
                    {t("workspace.redo")}
                    <small>Ctrl + Shift + Z</small>
                  </button>
                  <button
                    type="button"
                    disabled={!view.ready || view.layoutLocked}
                    onClick={actions.resetLayout}
                  >
                    <span aria-hidden="true">⟲</span>
                    {t("workspace.keepCurrent")}
                  </button>
                  <button
                    type="button"
                    className={view.layoutLocked ? "active" : ""}
                    disabled={!view.ready}
                    aria-pressed={view.layoutLocked}
                    onClick={() => actions.setLayoutLocked(!view.layoutLocked)}
                  >
                    <span aria-hidden="true">{view.layoutLocked ? "🔒" : "🔓"}</span>
                    {view.layoutLocked ? t("workspace.unlock") : t("workspace.lock")}
                  </button>
                </div>
              </section>

              <section className="workspace-panel-section">
                <div className="workspace-panel-section-heading workspace-panel-window-heading">
                  <div>
                    <h3>{t("workspace.nativeWindows")}</h3>
                    <p data-state={desktop.error ? "error" : "ready"}>{windowStatus}</p>
                  </div>
                  <span className="workspace-panel-count-pill">{t("workspace.windowCount", { count: windowCount })}</span>
                </div>
                {nativeWindowsEnabled ? (
                  <div className="workspace-panel-window-actions">
                    <button
                      type="button"
                      disabled={!view.ready || windowCount >= 4}
                      onClick={actions.createWindow}
                    >
                      {t("workspace.newNativeWindow")}
                    </button>
                    {view.window.id !== "main-window" && (
                      <button
                        type="button"
                        className="danger"
                        disabled={!view.ready}
                        onClick={() => actions.closeWindow(view.window.id)}
                      >
                        {t("workspace.closeWindow")}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="workspace-panel-guidance">
                    {t("workspace.nativeHint")}
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
                  <span>{t("workspace.activeChart")}</span>
                  <strong>{t("workspace.activeChartValue", { current: activeCellOrdinal, total: view.layoutCellIds.length })}</strong>
                </div>
                <span>{activeLinkGroupId
                  ? view.document.linkGroups[activeLinkGroupId]
                    ? chartLinkGroupDisplayName(view.document.linkGroups[activeLinkGroupId])
                    : t("workspace.unknownGroup")
                  : t("workspace.independent")}</span>
              </section>

              <section className="workspace-panel-section">
                <div className="workspace-panel-section-heading">
                  <div>
                    <h3>{t("workspace.linkGroups")}</h3>
                    <p>{t("workspace.linkGroupsHint")}</p>
                  </div>
                  <span className="workspace-panel-count-pill">{t("workspace.groupCount", { count: orderedLinkGroups.length })}</span>
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
                          <strong>{chartLinkGroupDisplayName(group)}</strong>
                          <small>{group.parentId ? t("workspace.childGroup") : t("workspace.rootGroup")}{t("workspace.groupCharts", { count: cellCount })}</small>
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
                    {t("workspace.addRoot")}
                  </button>
                  <button
                    type="button"
                    disabled={!view.ready || !selectedGroup}
                    onClick={() => actions.createLinkGroup(selectedGroup?.id ?? null)}
                  >
                    {t("workspace.addChild")}
                  </button>
                </div>
                <label className="workspace-panel-field">
                  <span>{t("workspace.joinGroup")}</span>
                  <select
                    value={activeLinkGroupId ?? ""}
                    disabled={!view.ready}
                    onChange={(event) => actions.setCellLinkGroup(
                      view.activeCellId,
                      (event.currentTarget.value || null) as ChartLinkGroupId | null,
                    )}
                  >
                    <option value="">{t("workspace.noLink")}</option>
                    {orderedLinkGroups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {"— ".repeat(chartLinkGroupDepth(view.document, group.id) - 1)}{chartLinkGroupDisplayName(group)}
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
                        <h3>{t("workspace.groupInfo")}</h3>
                        <p>{t("workspace.groupInfoHint")}</p>
                      </div>
                    </div>
                    <div className="workspace-panel-link-group-fields">
                      <label className="workspace-panel-field">
                        <span>{t("workspace.groupName")}</span>
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
                        <span>{t("workspace.groupColor")}</span>
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
                        <span>{t("workspace.parentGroup")}</span>
                        <select
                          value={selectedGroup.parentId ?? ""}
                          disabled={!view.ready}
                          onChange={(event) => actions.updateLinkGroup(selectedGroup.id, {
                            parentId: (event.currentTarget.value || null) as ChartLinkGroupId | null,
                          })}
                        >
                          <option value="">{t("workspace.noParent")}</option>
                          {orderedLinkGroups
                            .filter((group) => group.id !== selectedGroup.id
                              && !isChartLinkGroupDescendant(view.document, group.id, selectedGroup.id))
                            .map((group) => (
                              <option key={group.id} value={group.id}>{chartLinkGroupDisplayName(group)}</option>
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
                      {t("workspace.deleteGroup")}
                    </button>
                  </section>

                  <LinkPolicyEditor
                    title={t("workspace.peerLink")}
                    description={t("workspace.peerLinkHint", { name: selectedGroup.name })}
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
                      title={t("workspace.receiveParent")}
                      description={t("workspace.receiveParentHint", { name: view.document.linkGroups[selectedGroup.parentId]?.name ?? t("workspace.parentFallback") })}
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
                          <h3>{t("workspace.sharedLayers")}</h3>
                          <p>{t("workspace.sharedLayersHint")}</p>
                        </div>
                      </div>
                      <div className="workspace-panel-segmented" role="group" aria-label={t("workspace.layerSet")}>
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
                            {t("workspace.layer", { id: layerSet })}
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                </>
              ) : (
                <div className="workspace-panel-empty-state">
                  <span aria-hidden="true">⌘</span>
                  <strong>{t("workspace.selectGroup")}</strong>
                  <p>{t("workspace.selectGroupHint")}</p>
                </div>
              )}

              <div className="workspace-panel-link-status" data-state={drawingSummary.state}>
                {drawingLinkStatusText(drawingSummary)}
              </div>
              {viewportIssue?.group === activeLinkGroupId && (
                <div className="workspace-panel-link-status warning" role="status">
                  {viewportIssue.kind === "timeAnchor" ? t("workspace.timeAnchor") : t("workspace.dateRange")}
                  {t("workspace.viewportIssue", { count: viewportIssue.failedCellIds.length })}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
