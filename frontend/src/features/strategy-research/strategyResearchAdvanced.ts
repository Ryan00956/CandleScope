import { defaultBacktestApi } from "../backtest/backtestApi.js";
import {
  backtestResearchContextHref,
  buildBacktestResearchLaunchContext,
} from "../backtest/research/backtestResearchLaunch.js";
import type { ChartStrategyResultBundle } from "../backtest/chart-tester/chartStrategyResultCache.js";
import { chartStrategyQuickPresetIdForMarket } from "../backtest/chart-tester/chartStrategyRunRequest.js";
import type { ChartSession } from "../chart-session/chartSessionTypes.js";
import type { ResearchSourceRefV1 } from "../research-data/researchDataTypes.js";

export function strategyResearchAdvancedCellId(source: ResearchSourceRefV1 | null): "imported" | "current" {
  return source?.kind === "IMPORTED_DATASET" ? "imported" : "current";
}

export async function createStrategyResearchAdvancedHref(input: {
  source: ResearchSourceRefV1 | null;
  session: ChartSession;
  draftId: string;
  result: ChartStrategyResultBundle | null;
}): Promise<string> {
  const payload = buildBacktestResearchLaunchContext({
    workspaceId: "strategy-research",
    cellId: strategyResearchAdvancedCellId(input.source),
    session: input.session,
    attachment: {
      schemaVersion: 1,
      strategyDraftId: input.draftId,
      strategyRevisionId: null,
      displayName: "Strategy",
      language: "pyne",
      parameters: {},
      rangeMode: "ALL_AVAILABLE",
      customRange: null,
      fidelityPreference: "FAST",
      quickPresetId: chartStrategyQuickPresetIdForMarket(input.session.marketType),
      autoRun: false,
    },
    result: input.result,
    resolution: null,
    activeRunId: input.result?.run.run_id ?? null,
    baselineRunId: null,
  });
  const context = await defaultBacktestApi.createResearchLaunchContext(payload);
  return backtestResearchContextHref(context.context_id);
}
