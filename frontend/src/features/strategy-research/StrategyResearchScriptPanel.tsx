import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { t } from "../../i18n/index.js";
import type { ChartSession } from "../chart-session/chartSessionTypes.js";
import {
  CHART_STRATEGY_TEMPLATES,
  diagnoseChartStrategyDraft,
  type ChartStrategyRunRequest,
} from "../backtest/chart-tester/chartStrategyTesterUiModel.js";
import {
  createChartStrategyDraftId,
  getChartStrategyDraftStore,
  strategyDraftContentRevision,
} from "../backtest/chart-tester/chartStrategyTesterDrafts.js";
import { chartStrategyQuickPresetIdForMarket } from "../backtest/chart-tester/chartStrategyRunRequest.js";
import {
  pendingStrategyDraftSave,
  type SaveStrategyDraftInput,
  type StrategyDraftCursor,
  type StrategyDraftRecord,
} from "../backtest/chart-tester/StrategyDraftStore.js";
import type { ResearchSourceKind } from "../research-data/researchDataTypes.js";

const StrategyScriptWorkspace = lazy(() => import("../backtest/chart-tester/StrategyScriptWorkspace.js"));

async function flushStrategyResearchDraft(
  pending: {
    draft: StrategyDraftRecord | null;
    source: string;
    cursor: StrategyDraftCursor | null;
  },
  save: (input: SaveStrategyDraftInput) => Promise<StrategyDraftRecord>,
  pendingOperation: Promise<StrategyDraftRecord> | null,
): Promise<void> {
  const input = pendingStrategyDraftSave(pending);
  if (input !== null) {
    await save(input);
    return;
  }
  await pendingOperation;
}

export function StrategyResearchScriptPanel({
  cellScope,
  session,
  sourceKind,
  draftId,
  barOnly,
  runStatus,
  needsData,
  onDraftId,
  onDraftRevision,
  onRun,
  onConfirmNeedsData,
  onOpenAdvanced,
}: {
  cellScope: string;
  session: ChartSession | null;
  sourceKind: ResearchSourceKind | null;
  draftId: string | null;
  barOnly: boolean;
  runStatus: string;
  needsData: boolean;
  onDraftId(draftId: string | null): void;
  onDraftRevision(revision: number): void;
  onRun(request: ChartStrategyRunRequest): void;
  onConfirmNeedsData(): void;
  onOpenAdvanced(): void;
}) {
  const draftStore = useMemo(() => getChartStrategyDraftStore(), []);
  const [draft, setDraft] = useState<StrategyDraftRecord | null>(null);
  const [source, setSource] = useState("");
  const [cursor, setCursor] = useState<StrategyDraftCursor | null>(null);
  const [openEditor, setOpenEditor] = useState(false);
  const restoreGenerationRef = useRef(0);
  const restorePromiseRef = useRef<Promise<void> | null>(null);
  const pendingSavePromiseRef = useRef<Promise<StrategyDraftRecord> | null>(null);
  const pendingSaveRef = useRef<{
    draft: StrategyDraftRecord | null;
    source: string;
    cursor: StrategyDraftCursor | null;
  }>({ draft: null, source: "", cursor: null });

  useLayoutEffect(() => {
    pendingSaveRef.current = { draft, source, cursor };
  }, [cursor, draft, source]);

  useEffect(() => {
    if (draft === null) {
      if (draftId === null) onDraftRevision(0);
      return;
    }
    onDraftRevision(strategyDraftContentRevision(source));
  }, [draft, draftId, onDraftRevision, source]);

  const saveDraft = useCallback((input: SaveStrategyDraftInput) => {
    const operation = draftStore.save(input);
    pendingSavePromiseRef.current = operation;
    void operation.then(() => {
      if (pendingSavePromiseRef.current === operation) pendingSavePromiseRef.current = null;
    }, () => {
      if (pendingSavePromiseRef.current === operation) pendingSavePromiseRef.current = null;
    });
    return operation;
  }, [draftStore]);

  const flushPendingDraft = useCallback(async () => {
    await flushStrategyResearchDraft(
      pendingSaveRef.current,
      saveDraft,
      pendingSavePromiseRef.current,
    );
  }, [saveDraft]);

  useEffect(() => {
    const generation = restoreGenerationRef.current + 1;
    restoreGenerationRef.current = generation;
    const previousPending = pendingSaveRef.current;
    const previousOperation = pendingSavePromiseRef.current;
    if (draftId === null) {
      restorePromiseRef.current = null;
      setDraft(null);
      setSource("");
      setCursor(null);
      setOpenEditor(false);
      void flushStrategyResearchDraft(previousPending, saveDraft, previousOperation).catch(() => undefined);
      return undefined;
    }
    let cancelled = false;
    const restore = flushStrategyResearchDraft(previousPending, saveDraft, previousOperation)
      .then(() => draftStore.load(draftId))
      .then((view) => {
        if (cancelled || restoreGenerationRef.current !== generation) return;
        if (view.record === null) {
          setDraft(null);
          setSource("");
          setCursor(null);
          setOpenEditor(false);
          onDraftId(null);
          return;
        }
        setDraft(view.record);
        setSource(view.record.source);
        setCursor(view.record.cursor);
        setOpenEditor(true);
      });
    restorePromiseRef.current = restore;
    void restore.catch(() => undefined);
    const unsubscribe = draftStore.subscribe((id, view) => {
      if (
        cancelled
        || restoreGenerationRef.current !== generation
        || id !== draftId
        || view.record === null
      ) return;
      const pending = pendingSaveRef.current;
      const dirty = pendingStrategyDraftSave(pending) !== null;
      setDraft(view.record);
      if (!dirty) {
        setSource(view.record.source);
        setCursor(view.record.cursor);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
      if (restoreGenerationRef.current === generation) restoreGenerationRef.current += 1;
      if (restorePromiseRef.current === restore) restorePromiseRef.current = null;
    };
  }, [draftId, draftStore, onDraftId, saveDraft]);

  useEffect(() => {
    const input = pendingStrategyDraftSave({ draft, source, cursor });
    if (input === null) return undefined;
    const timer = window.setTimeout(() => {
      void saveDraft(input).catch(() => undefined);
    }, 550);
    return () => window.clearTimeout(timer);
  }, [cursor, draft, saveDraft, source]);

  useEffect(() => {
    const flush = () => {
      void flushPendingDraft().catch(() => undefined);
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [flushPendingDraft]);

  const startDraft = useCallback(async (templateId: string) => {
    const template = CHART_STRATEGY_TEMPLATES.find((item) => item.id === templateId);
    if (!template || session === null) return;
    const generation = restoreGenerationRef.current + 1;
    restoreGenerationRef.current = generation;
    const record = await saveDraft({
      id: createChartStrategyDraftId(),
      displayName: template.displayName,
      language: template.language,
      source: template.source,
      cursor: { line: 1, column: 1 },
    });
    if (restoreGenerationRef.current !== generation) return;
    setDraft(record);
    setSource(record.source);
    setCursor(record.cursor);
    setOpenEditor(true);
    onDraftId(record.id);
  }, [onDraftId, saveDraft, session]);

  const openAdvanced = useCallback(async () => {
    try {
      await restorePromiseRef.current;
      if (draftId !== null && pendingSaveRef.current.draft?.id !== draftId) return;
      await flushPendingDraft();
    } catch {
      return;
    }
    onOpenAdvanced();
  }, [draftId, flushPendingDraft, onOpenAdvanced]);

  const run = useCallback(() => {
    if (draft === null || session === null) return;
    onRun({
      cellScope,
      session,
      draftId: draft.id,
      draftContentRevision: strategyDraftContentRevision(source),
      displayName: draft.displayName,
      language: draft.language,
      source,
      attachment: {
        schemaVersion: 1,
        strategyDraftId: draft.id,
        strategyRevisionId: null,
        displayName: draft.displayName,
        language: draft.language,
        parameters: {},
        rangeMode: "ALL_AVAILABLE",
        customRange: null,
        fidelityPreference: "FAST",
        quickPresetId: chartStrategyQuickPresetIdForMarket(session.marketType),
        autoRun: false,
      },
    });
  }, [cellScope, draft, onRun, session, source]);

  if (session === null || sourceKind === null) {
    return <p data-testid="strategy-research-script-empty">{t("strategy.scriptSlot")}</p>;
  }

  return (
    <section className="strategy-research-script-panel" data-testid="strategy-research-script-panel">
      {barOnly ? (
        <p className="strategy-research-bar-only" data-testid="strategy-research-bar-only">
          {t("chartTester.result.fidelityFast")}
        </p>
      ) : null}
      {draft === null ? (
        <div className="strategy-research-templates" data-testid="strategy-research-templates">
          {CHART_STRATEGY_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              data-testid={`strategy-research-template-${template.id}`}
              onClick={() => void startDraft(template.id)}
            >
              {t(template.nameKey)}
            </button>
          ))}
          <button
            type="button"
            className="chart-strategy-advanced-link"
            data-testid="strategy-research-open-advanced"
            onClick={() => void openAdvanced()}
          >
            {t("strategy.advanced")}
          </button>
        </div>
      ) : (
        <>
          {openEditor ? (
            <Suspense fallback={<p>{t("strategy.scriptSlot")}</p>}>
              <StrategyScriptWorkspace
                source={source}
                language={draft.language}
                cursor={cursor}
                issues={diagnoseChartStrategyDraft(source)}
                focusIssue={null}
                focusOnMount={false}
                onSourceChange={setSource}
                onCursorChange={setCursor}
                onRun={run}
              />
            </Suspense>
          ) : null}
          <button
            type="button"
            data-testid="strategy-research-run"
            disabled={runStatus === "RUNNING" || runStatus === "QUEUED" || runStatus === "RESOLVING"}
            onClick={run}
          >
            {t("chartTester.run")}
          </button>
          <button
            type="button"
            className="chart-strategy-advanced-link"
            data-testid="strategy-research-open-advanced"
            onClick={() => void openAdvanced()}
          >
            {t("strategy.advanced")}
          </button>
        </>
      )}
      {needsData ? (
        <button
          type="button"
          data-testid="strategy-research-confirm-data"
          onClick={onConfirmNeedsData}
        >
          {t("chartTester.prepareDataRun")}
        </button>
      ) : null}
    </section>
  );
}
