import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { ChartSession } from "../../chart-session/chartSessionTypes.js";
import type { ChartStrategyAttachmentRecord } from "../../chart-workspace/chartWorkspaceTypes.js";
import { t } from "../../../i18n/index.js";
import { useLocale } from "../../../i18n/useLocale.js";
import type {
  StrategyDraftAutoSaveState,
  StrategyDraftCursor,
  StrategyDraftRecord,
  StrategyDraftStore,
} from "./StrategyDraftStore.js";
import {
  createChartStrategyDraftId,
  strategyDraftContentRevision,
} from "./chartStrategyTesterDrafts.js";
import {
  CHART_STRATEGY_TEMPLATES,
  diagnoseChartStrategyDraft,
  type ChartStrategyDraftIssue,
  type ChartStrategyRunRequest,
  type ChartStrategyTesterEntryState,
} from "./chartStrategyTesterUiModel.js";

const StrategyScriptWorkspace = lazy(() => import("./StrategyScriptWorkspace.js"));

type PanelTab = "script" | "overview" | "trades" | "settings";
type StartView = "start" | "templates" | "recent" | "editor";

const MIN_PANEL_HEIGHT = 260;
const MAX_PANEL_HEIGHT = 520;

function clampPanelHeight(value: number): number {
  const viewportLimit = typeof window === "undefined"
    ? MAX_PANEL_HEIGHT
    : Math.max(MIN_PANEL_HEIGHT, Math.floor(window.innerHeight * 0.68));
  return Math.min(MAX_PANEL_HEIGHT, viewportLimit, Math.max(MIN_PANEL_HEIGHT, Math.round(value)));
}

function sameCursor(left: StrategyDraftCursor | null, right: StrategyDraftCursor | null): boolean {
  return left?.line === right?.line && left?.column === right?.column;
}

function attachmentForDraft(record: StrategyDraftRecord): ChartStrategyAttachmentRecord {
  return {
    schemaVersion: 1,
    strategyDraftId: record.id,
    strategyRevisionId: null,
    displayName: record.displayName,
    language: record.language,
    parameters: {},
    rangeMode: "ALL_AVAILABLE",
    customRange: null,
    fidelityPreference: "FAST",
    quickPresetId: "CRYPTO_PERP_STANDARD_V1",
    autoRun: false,
  };
}

function issueCopy(issue: ChartStrategyDraftIssue): { title: string; detail: string } {
  if (issue.code === "EMPTY_SOURCE") {
    return { title: t("chartTester.issue.emptyTitle"), detail: t("chartTester.issue.emptyDetail") };
  }
  if (issue.code === "UNDECLARED_TARGET") {
    return {
      title: t("chartTester.issue.location", { line: issue.line, column: issue.column }),
      detail: t("chartTester.issue.unknownVariable", { variable: issue.variable ?? "target" }),
    };
  }
  return {
    title: t("chartTester.issue.location", { line: issue.line, column: issue.column }),
    detail: t("chartTester.issue.delimiter", { delimiter: issue.variable ?? "?" }),
  };
}

export interface ChartStrategyTesterPanelProps {
  cellScope: string;
  session: ChartSession;
  attachment: ChartStrategyAttachmentRecord | null;
  draftStore: StrategyDraftStore;
  onAttachmentChange(attachment: ChartStrategyAttachmentRecord | null): void;
  onEntryStateChange(state: ChartStrategyTesterEntryState): void;
  onRunRequest(request: ChartStrategyRunRequest): void;
  onClose(): void;
}

export default function ChartStrategyTesterPanel({
  cellScope,
  session,
  attachment,
  draftStore,
  onAttachmentChange,
  onEntryStateChange,
  onRunRequest,
  onClose,
}: ChartStrategyTesterPanelProps) {
  const locale = useLocale();
  const [height, setHeight] = useState(() => clampPanelHeight(383));
  const [activeTab, setActiveTab] = useState<PanelTab>("script");
  const [startView, setStartView] = useState<StartView>(attachment ? "editor" : "start");
  const currentAttachment = attachment;
  const [draft, setDraft] = useState<StrategyDraftRecord | null>(null);
  const activeDraft = draft?.id === currentAttachment?.strategyDraftId ? draft : null;
  const [source, setSource] = useState("");
  const [cursor, setCursor] = useState<StrategyDraftCursor | null>(null);
  const [saveState, setSaveState] = useState<StrategyDraftAutoSaveState>("IDLE");
  const [issues, setIssues] = useState<ChartStrategyDraftIssue[]>([]);
  const [focusIssue, setFocusIssue] = useState<ChartStrategyDraftIssue | null>(null);
  const [focusOnMount, setFocusOnMount] = useState(false);
  const [runReady, setRunReady] = useState(false);
  const [recentDrafts, setRecentDrafts] = useState<StrategyDraftRecord[]>([]);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const pendingSaveRef = useRef<{
    draft: StrategyDraftRecord | null;
    source: string;
    cursor: StrategyDraftCursor | null;
  }>({ draft: null, source: "", cursor: null });

  useEffect(() => () => resizeCleanupRef.current?.(), []);
  useEffect(() => {
    pendingSaveRef.current = { draft: activeDraft, source, cursor };
  }, [activeDraft, cursor, source]);
  useEffect(() => () => {
    const pending = pendingSaveRef.current;
    if (!pending.draft
      || (pending.draft.source === pending.source
        && sameCursor(pending.draft.cursor, pending.cursor))) return;
    void draftStore.save({
      id: pending.draft.id,
      displayName: pending.draft.displayName,
      language: pending.draft.language,
      source: pending.source,
      cursor: pending.cursor,
    }).catch(() => undefined);
  }, [draftStore]);

  useEffect(() => {
    const draftId = currentAttachment?.strategyDraftId;
    if (!draftId) return undefined;
    let cancelled = false;
    void draftStore.load(draftId).then((view) => {
      if (cancelled || !view.record) return;
      setDraft(view.record);
      setSource(view.record.source);
      setCursor(view.record.cursor);
      setIssues(diagnoseChartStrategyDraft(view.record.source));
      setSaveState(view.saveState);
    });
    const unsubscribe = draftStore.subscribe((id, view) => {
      if (id !== draftId || !view.record) return;
      setDraft(view.record);
      setSaveState(view.saveState);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [currentAttachment?.strategyDraftId, draftStore]);

  useEffect(() => {
    if (!activeDraft
      || (activeDraft.source === source && sameCursor(activeDraft.cursor, cursor))) return undefined;
    const timer = window.setTimeout(() => {
      void draftStore.save({
        id: activeDraft.id,
        displayName: activeDraft.displayName,
        language: activeDraft.language,
        source,
        cursor,
      }).catch(() => undefined);
    }, 550);
    return () => window.clearTimeout(timer);
  }, [activeDraft, cursor, draftStore, source]);

  useEffect(() => {
    if (!activeDraft) return undefined;
    const timer = window.setTimeout(() => setIssues(diagnoseChartStrategyDraft(source)), 320);
    return () => window.clearTimeout(timer);
  }, [activeDraft, source]);

  const visibleIssues = activeDraft ? issues : [];

  useEffect(() => {
    if (!currentAttachment) onEntryStateChange("unattached");
    else if (visibleIssues.length > 0) onEntryStateChange("error");
    else if (saveState === "SAVING") onEntryStateChange("saving");
    else if (runReady) onEntryStateChange("ready");
    else onEntryStateChange("editing");
  }, [currentAttachment, onEntryStateChange, runReady, saveState, visibleIssues.length]);

  const refreshRecent = useCallback(() => {
    void draftStore.recent(8).then(setRecentDrafts).catch(() => setRecentDrafts([]));
  }, [draftStore]);

  useEffect(() => {
    refreshRecent();
  }, [refreshRecent]);

  const attachRecord = useCallback((
    record: StrategyDraftRecord,
    shouldFocus: boolean,
    nextSaveState: StrategyDraftAutoSaveState = "SAVED",
  ) => {
    const nextAttachment = attachmentForDraft(record);
    setDraft(record);
    setSource(record.source);
    setCursor(record.cursor);
    setIssues(diagnoseChartStrategyDraft(record.source));
    setSaveState(nextSaveState);
    setStartView("editor");
    setActiveTab("script");
    setFocusOnMount(shouldFocus);
    setRunReady(false);
    onAttachmentChange(nextAttachment);
  }, [onAttachmentChange]);

  const createDraft = useCallback(async (
    displayName: string,
    sourceText: string,
    shouldFocus: boolean,
  ) => {
    const id = createChartStrategyDraftId();
    try {
      const record = await draftStore.save({
        id,
        displayName,
        language: "pyne",
        source: sourceText,
        cursor: { line: 1, column: 1 },
      });
      attachRecord(record, shouldFocus);
    } catch {
      const failed = draftStore.snapshot(id);
      if (failed.record) attachRecord(failed.record, shouldFocus, "ERROR");
    }
  }, [attachRecord, draftStore]);

  const run = useCallback(() => {
    if (!activeDraft || !currentAttachment) return;
    const nextIssues = diagnoseChartStrategyDraft(source, { requireSource: true });
    setIssues(nextIssues);
    setRunReady(false);
    if (nextIssues[0]) {
      setActiveTab("script");
      setStartView("editor");
      setFocusIssue(nextIssues[0]);
      onEntryStateChange("error");
      return;
    }
    onRunRequest({
      cellScope,
      session: { ...session },
      draftId: activeDraft.id,
      draftContentRevision: strategyDraftContentRevision(source),
      displayName: activeDraft.displayName,
      language: activeDraft.language,
      source,
      attachment: { ...currentAttachment, parameters: { ...currentAttachment.parameters } },
    });
    setRunReady(true);
    onEntryStateChange("ready");
  }, [activeDraft, cellScope, currentAttachment, onEntryStateChange, onRunRequest, session, source]);

  const retrySave = useCallback(() => {
    if (!activeDraft) return;
    void draftStore.save({
      id: activeDraft.id,
      displayName: activeDraft.displayName,
      language: activeDraft.language,
      source,
      cursor,
    }).catch(() => undefined);
  }, [activeDraft, cursor, draftStore, source]);

  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const handleMove = (moveEvent: PointerEvent) => {
      setHeight(clampPanelHeight(startHeight + startY - moveEvent.clientY));
    };
    const finish = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finish);
      resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current?.();
    resizeCleanupRef.current = finish;
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finish, { once: true });
  }, [height]);

  const handleResizeKey = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowUp" ? 16 : event.key === "ArrowDown" ? -16 : 0;
    if (delta !== 0) {
      event.preventDefault();
      setHeight((current) => clampPanelHeight(current + delta));
    } else if (event.key === "Home") {
      event.preventDefault();
      setHeight(MIN_PANEL_HEIGHT);
    } else if (event.key === "End") {
      event.preventDefault();
      setHeight(clampPanelHeight(MAX_PANEL_HEIGHT));
    }
  }, []);

  const saveLabel = useMemo(() => {
    if (!currentAttachment) return t("chartTester.autosave.none");
    if (saveState === "ERROR") return t("chartTester.autosave.error");
    if (saveState === "SAVING") return t("chartTester.autosave.saving");
    if (activeDraft && activeDraft.source !== source) return t("chartTester.autosave.editing");
    return t("chartTester.autosave.saved");
  }, [activeDraft, currentAttachment, saveState, source]);

  const panelStyle = { "--chart-strategy-panel-height": `${height}px` } as CSSProperties;
  const showEditor = activeTab === "script" && startView === "editor" && activeDraft !== null;

  return (
    <section
      id="chart-strategy-tester-panel"
      className="chart-strategy-tester-panel"
      style={panelStyle}
      aria-label={t("chartTester.panelAria")}
      data-chart-strategy-panel
      onKeyDownCapture={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div
        className="chart-strategy-resize-handle"
        role="separator"
        tabIndex={0}
        aria-label={t("chartTester.resize")}
        aria-orientation="horizontal"
        aria-valuemin={MIN_PANEL_HEIGHT}
        aria-valuemax={MAX_PANEL_HEIGHT}
        aria-valuenow={height}
        onPointerDown={beginResize}
        onKeyDown={handleResizeKey}
      />
      <header className="chart-strategy-tester-head">
        <div className="chart-strategy-tester-title">
          <strong>{currentAttachment?.displayName ?? t("chartTester.title")}</strong>
          <span>{t("chartTester.currentChart", { symbol: session.symbol, interval: session.interval })}</span>
        </div>
        <div className="chart-strategy-tabs" role="tablist" aria-label={t("chartTester.tabsAria")}>
          {(["script", "overview", "trades", "settings"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              tabIndex={activeTab === tab ? 0 : -1}
              className={activeTab === tab ? "active" : ""}
              onClick={() => setActiveTab(tab)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                const tabs: PanelTab[] = ["script", "overview", "trades", "settings"];
                const direction = event.key === "ArrowRight" ? 1 : -1;
                const next = tabs[(tabs.indexOf(tab) + direction + tabs.length) % tabs.length]!;
                setActiveTab(next);
                requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(
                  `.chart-strategy-tabs [aria-selected="true"]`,
                )?.focus());
              }}
            >
              {t(`chartTester.tab.${tab}`)}
            </button>
          ))}
        </div>
        <div className="chart-strategy-head-spacer" />
        <span className={`chart-strategy-autosave state-${saveState.toLowerCase()}`}>{saveLabel}</span>
        {saveState === "ERROR" && (
          <button type="button" className="chart-strategy-link-button" onClick={retrySave}>
            {t("chartTester.retrySave")}
          </button>
        )}
        {currentAttachment && (
          <button type="button" className="chart-strategy-run-button" onClick={run}>
            {t("chartTester.run")}
          </button>
        )}
        <button type="button" className="chart-strategy-close-button" onClick={onClose}>
          {t("chartTester.close")}
        </button>
      </header>

      <div className="chart-strategy-tester-body" role="tabpanel">
        {activeTab === "script" && startView === "start" && (
          <div className="chart-strategy-start-view">
            <div className="chart-strategy-first-copy">
              <div>
                <p className="chart-strategy-eyebrow">{t("chartTester.startEyebrow")}</p>
                <h2>{t("chartTester.startTitle")}</h2>
                <p>{t("chartTester.startLead", { symbol: session.symbol, interval: session.interval })}</p>
              </div>
              <a href="/backtest.html" className="chart-strategy-advanced-link">
                {t("chartTester.openAdvanced")}
              </a>
            </div>
            <div className="chart-strategy-start-grid">
              <button type="button" onClick={() => setStartView("templates")}>
                <span>01</span><strong>{t("chartTester.start.template")}</strong>
                <small>{t("chartTester.start.templateDetail")}</small>
              </button>
              <button type="button" onClick={() => { refreshRecent(); setStartView("recent"); }}>
                <span>02</span><strong>{t("chartTester.start.recent")}</strong>
                <small>{t("chartTester.start.recentDetail")}</small>
              </button>
              <button
                type="button"
                onClick={() => void createDraft(t("chartTester.untitled"), "", true)}
              >
                <span>03</span><strong>{t("chartTester.start.paste")}</strong>
                <small>{t("chartTester.start.pasteDetail")}</small>
              </button>
            </div>
            <p className="chart-strategy-privacy">{t("chartTester.privacy")}</p>
          </div>
        )}

        {activeTab === "script" && startView === "templates" && (
          <div className="chart-strategy-picker-view">
            <div className="chart-strategy-picker-heading">
              <div><p className="chart-strategy-eyebrow">{t("chartTester.templateEyebrow")}</p><h2>{t("chartTester.templateTitle")}</h2></div>
              <button type="button" onClick={() => setStartView("start")}>{t("chartTester.back")}</button>
            </div>
            <div className="chart-strategy-template-grid">
              {CHART_STRATEGY_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => void createDraft(template.displayName, template.source, false)}
                >
                  <strong>{t(template.nameKey)}</strong>
                  <span>{t(template.descriptionKey)}</span>
                  <small>{t("chartTester.language.pyne")}</small>
                </button>
              ))}
            </div>
          </div>
        )}

        {activeTab === "script" && startView === "recent" && (
          <div className="chart-strategy-picker-view">
            <div className="chart-strategy-picker-heading">
              <div><p className="chart-strategy-eyebrow">{t("chartTester.recentEyebrow")}</p><h2>{t("chartTester.recentTitle")}</h2></div>
              <button type="button" onClick={() => setStartView("start")}>{t("chartTester.back")}</button>
            </div>
            {recentDrafts.length === 0 ? (
              <div className="chart-strategy-empty-recent">{t("chartTester.recentEmpty")}</div>
            ) : (
              <div className="chart-strategy-recent-list">
                {recentDrafts.map((record) => (
                  <button key={record.id} type="button" onClick={() => attachRecord(record, false)}>
                    <strong>{record.displayName}</strong>
                    <span>{record.language === "pine"
                      ? t("chartTester.language.pine")
                      : t("chartTester.language.pyne")}</span>
                    <time dateTime={new Date(record.updatedAt).toISOString()}>
                      {new Date(record.updatedAt).toLocaleString(locale)}
                    </time>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {showEditor && activeDraft && (
          <div className="chart-strategy-editor-layout">
            <section className="chart-strategy-editor-shell" aria-label={t("chartTester.editorAria")}>
              <div className="chart-strategy-editor-head">
                {t("chartTester.editorHead", {
                  name: activeDraft.displayName,
                  language: activeDraft.language === "pine"
                    ? t("chartTester.language.pine")
                    : t("chartTester.language.pyne"),
                })}
              </div>
              <Suspense fallback={<div className="chart-strategy-editor-loading">{t("chartTester.editorLoading")}</div>}>
                <StrategyScriptWorkspace
                  source={source}
                  language={activeDraft.language}
                  cursor={cursor}
                  issues={visibleIssues}
                  focusIssue={focusIssue}
                  focusOnMount={focusOnMount}
                  onSourceChange={(value) => { setSource(value); setRunReady(false); }}
                  onCursorChange={setCursor}
                  onRun={run}
                />
              </Suspense>
            </section>
            <aside className="chart-strategy-problems" aria-label={t("chartTester.problemsAria")}>
              <div className="chart-strategy-problems-head">{t("chartTester.problems")}</div>
              <div className="chart-strategy-problems-body">
                {visibleIssues.length === 0 ? (
                  <p className="chart-strategy-no-problems">
                    {runReady ? t("chartTester.readyForRun") : t("chartTester.noProblems")}
                  </p>
                ) : (
                  <>
                    <strong className="chart-strategy-problem-count">
                      {t("chartTester.problemCount", { count: visibleIssues.length })}
                    </strong>
                    {visibleIssues.map((issue, index) => {
                      const copy = issueCopy(issue);
                      return (
                        <div className="chart-strategy-problem" key={`${issue.code}:${issue.line}:${issue.column}:${index}`}>
                          <strong>{copy.title}</strong>
                          <p>{copy.detail}</p>
                          <button type="button" onClick={() => setFocusIssue({ ...issue })}>
                            {t("chartTester.goToLine", { line: issue.line })}
                          </button>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            </aside>
          </div>
        )}

        {activeTab !== "script" && (
          <div className="chart-strategy-placeholder">
            <strong>{t(`chartTester.tab.${activeTab}`)}</strong>
            <p>{t(`chartTester.placeholder.${activeTab}`)}</p>
          </div>
        )}
      </div>
    </section>
  );
}
