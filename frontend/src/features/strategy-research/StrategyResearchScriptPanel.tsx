import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";

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
import type { StrategyDraftRecord } from "../backtest/chart-tester/StrategyDraftStore.js";
import type { ResearchSourceKind } from "../research-data/researchDataTypes.js";

const StrategyScriptWorkspace = lazy(() => import("../backtest/chart-tester/StrategyScriptWorkspace.js"));

export function StrategyResearchScriptPanel({
  cellScope,
  session,
  sourceKind,
  barOnly,
  runStatus,
  needsData,
  onDraftId,
  onRun,
  onConfirmNeedsData,
}: {
  cellScope: string;
  session: ChartSession | null;
  sourceKind: ResearchSourceKind | null;
  barOnly: boolean;
  runStatus: string;
  needsData: boolean;
  onDraftId(draftId: string | null): void;
  onRun(request: ChartStrategyRunRequest): void;
  onConfirmNeedsData(): void;
}) {
  const draftStore = useMemo(() => getChartStrategyDraftStore(), []);
  const [draft, setDraft] = useState<StrategyDraftRecord | null>(null);
  const [source, setSource] = useState("");
  const [openEditor, setOpenEditor] = useState(false);

  useEffect(() => {
    onDraftId(draft?.id ?? null);
  }, [draft?.id, onDraftId]);

  const startDraft = useCallback(async (templateId: string) => {
    const template = CHART_STRATEGY_TEMPLATES.find((item) => item.id === templateId);
    if (!template || session === null) return;
    const record = await draftStore.save({
      id: createChartStrategyDraftId(),
      displayName: template.displayName,
      language: template.language,
      source: template.source,
      cursor: { line: 1, column: 1 },
    });
    setDraft(record);
    setSource(record.source);
    setOpenEditor(true);
  }, [draftStore, session]);

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
        </div>
      ) : (
        <>
          {openEditor ? (
            <Suspense fallback={<p>{t("strategy.scriptSlot")}</p>}>
              <StrategyScriptWorkspace
                source={source}
                language={draft.language}
                cursor={draft.cursor}
                issues={diagnoseChartStrategyDraft(source)}
                focusIssue={null}
                focusOnMount={false}
                onSourceChange={setSource}
                onCursorChange={() => undefined}
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
