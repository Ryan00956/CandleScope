import type { ChartSession } from "../../chart-session/chartSessionTypes.js";
import type { ChartStrategyAttachmentRecord } from "../../chart-workspace/chartWorkspaceTypes.js";
import type { ChartContextResolution } from "../backtestApi.js";
import type { BacktestResearchLaunchContextInput } from "../backtestTypes.js";
import type { ChartStrategyResultBundle } from "../chart-tester/chartStrategyResultCache.js";

export function buildBacktestResearchLaunchContext(input: {
  workspaceId: string;
  cellId: string;
  session: ChartSession;
  attachment: ChartStrategyAttachmentRecord;
  result: ChartStrategyResultBundle | null;
  resolution: ChartContextResolution | null;
  activeRunId: string | null;
  baselineRunId: string | null;
  entryTask?: BacktestResearchLaunchContextInput["entry_task"];
}): BacktestResearchLaunchContextInput {
  const draftId = input.attachment.strategyDraftId;
  if (!draftId) throw new Error("A saved strategy draft is required before opening research.");
  const resultConfig = input.result?.config;
  const rangeMode = input.attachment.rangeMode;
  const resolvedDataset = input.resolution?.dataset_id
    && input.resolution.data_epoch
    && input.resolution.snapshot_hash
    ? {
        dataset_id: input.resolution.dataset_id,
        data_epoch: input.resolution.data_epoch,
        snapshot_hash: input.resolution.snapshot_hash,
      }
    : input.result?.run.dataset_id
      && input.result.run.data_epoch
      && input.result.run.snapshot_hash
      ? {
          dataset_id: input.result.run.dataset_id,
          data_epoch: input.result.run.data_epoch,
          snapshot_hash: input.result.run.snapshot_hash,
        }
      : null;
  const resultStart = Number(resultConfig?.start_time_ms);
  const resultEnd = Number(resultConfig?.end_time_ms);
  const customRange = input.attachment.customRange;
  return {
    source_workspace_id: input.workspaceId,
    source_cell_id: input.cellId,
    strategy_draft_id: draftId,
    strategy_revision_id: input.attachment.strategyRevisionId,
    parameters: { ...input.attachment.parameters },
    quick_preset_id: input.attachment.quickPresetId,
    chart_session: {
      exchange: input.session.exchange,
      market_type: input.session.marketType,
      symbol: input.session.symbol,
      interval: input.session.interval,
    },
    range: {
      mode: rangeMode,
      start_time_ms: Number.isSafeInteger(resultStart)
        ? resultStart
        : customRange?.startMs ?? null,
      end_time_ms: Number.isSafeInteger(resultEnd)
        ? resultEnd
        : customRange?.endMs ?? null,
    },
    dataset_identity: resolvedDataset,
    latest_run_id: input.result?.run.run_id ?? input.activeRunId,
    baseline_run_id: input.baselineRunId,
    entry_task: input.entryTask ?? null,
  };
}

export function backtestResearchContextHref(contextId: string): string {
  if (!/^brc_[A-Za-z0-9_-]{8,128}$/.test(contextId)) {
    throw new Error("Invalid BacktestResearchLaunchContext ID");
  }
  return `/backtest.html?context=${encodeURIComponent(contextId)}`;
}
