import type { ReplayCatalog, ReplayCatalogEntry } from "./replayTypes.js";
import { ReplayV2ApiError } from "./replayV2Api.js";
import type { ReplayV2ApiClient } from "./replayV2Api.js";
import type {
  TrainingRunMarketSelectionPayload,
  TrainingRunMarketSelectionResponse,
} from "./replayV2Types.js";


type ReplayInitialMarketApi = Pick<
  ReplayV2ApiClient,
  "marketCatalog" | "planInitialMarket" | "selectInitialMarket"
>;

export interface ReplayInitialMarketSelectionResult {
  readonly response: TrainingRunMarketSelectionResponse;
  readonly catalog: ReplayCatalog;
  readonly catalogRefreshes: 0 | 1;
}

function sameMarket(left: ReplayCatalogEntry, right: ReplayCatalogEntry): boolean {
  return left.identity.exchange === right.identity.exchange
    && left.identity.market_type === right.identity.market_type
    && left.identity.symbol === right.identity.symbol;
}

function selectionFromEntry(
  catalog: ReplayCatalog,
  entry: ReplayCatalogEntry,
): TrainingRunMarketSelectionPayload {
  if (entry.selected_base_interval === null) {
    throw new Error("所选商品没有可用基础周期");
  }
  return {
    catalog_epoch: catalog.catalog_epoch,
    exchange: entry.identity.exchange,
    market_type: entry.identity.market_type,
    symbol: entry.identity.symbol,
    base_interval: entry.selected_base_interval,
    display_interval: entry.selected_base_interval,
    account_history_ref: null,
    hedge_public_history_ref: null,
    simulation_manifest_ref: null,
  };
}

export interface ReplayInitialMarketPreparedSelection {
  readonly selection: TrainingRunMarketSelectionPayload;
  readonly plan: Awaited<ReturnType<ReplayInitialMarketApi["planInitialMarket"]>>;
  readonly downgradeConfirmation: string | null;
}

function hedgeInputUnavailableMessage(reason: string): string {
  switch (reason) {
    case "NO_COMPLETE_CROSS_VERIFIED_INPUT_SET":
      return "当前商品缺少可验证的执行价格或所选盘口模式要求连续 L2，无法安全生成双向持仓输入。";
    case "BINANCE_USDM_EXACT_FUNDING_REQUIRED":
    case "BINANCE_USDM_EXACT_L2_AND_FUNDING_REQUIRED":
      return "双向持仓仅支持 Binance USD-M，并要求固定的 funding、mark、规则、费率与模拟清单；只有盘口辅助模式才要求历史 L2。";
    default:
      return `双向持仓输入不可用（${reason}）`;
  }
}

function selectionWithPreparedInputs(
  selection: TrainingRunMarketSelectionPayload,
  plan: Awaited<ReturnType<ReplayInitialMarketApi["planInitialMarket"]>>,
): TrainingRunMarketSelectionPayload {
  if (!plan.history_policy.accepted) {
    throw new Error(`历史策略不可用：${plan.history_policy.blocked_reason ?? "UNKNOWN"}`);
  }
  if (plan.historical_book.requested_mode === "BOOK_ASSISTED_REQUIRED"
    && plan.historical_book.capability_state !== "AVAILABLE_EXACT") {
    throw new Error(`历史盘口不可用：${plan.historical_book.reason}`);
  }
  if (plan.account_history.requested_mode === "HISTORICAL_EXACT"
    && (plan.account_history.capability_state !== "AVAILABLE_EXACT"
      || plan.account_history.account_history_ref === null)) {
    throw new Error(`精确账户历史不可用：${plan.account_history.reason}`);
  }
  if (plan.hedge_inputs.requested_position_mode === "HEDGE"
    && (plan.hedge_inputs.capability_state !== "AVAILABLE_EXACT"
      && plan.hedge_inputs.capability_state !== "AVAILABLE_APPROX"
      || plan.hedge_inputs.hedge_public_history_ref === null
      || plan.hedge_inputs.simulation_manifest_ref === null)) {
    throw new Error(hedgeInputUnavailableMessage(plan.hedge_inputs.reason));
  }
  return {
    ...selection,
    account_history_ref: plan.account_history.requested_mode === "HISTORICAL_EXACT"
      ? plan.account_history.account_history_ref
      : null,
    hedge_public_history_ref: plan.hedge_inputs.requested_position_mode === "HEDGE"
      ? plan.hedge_inputs.hedge_public_history_ref
      : null,
    simulation_manifest_ref: plan.hedge_inputs.requested_position_mode === "HEDGE"
      ? plan.hedge_inputs.simulation_manifest_ref
      : null,
  };
}

export function replayInitialMarketDowngradeConfirmation(
  plan: Awaited<ReturnType<ReplayInitialMarketApi["planInitialMarket"]>>,
): string | null {
  if (plan.hedge_inputs.requested_position_mode !== "HEDGE"
    || plan.hedge_inputs.capability_state !== "AVAILABLE_APPROX"
    || !plan.hedge_inputs.fallback_applied) {
    return null;
  }
  return "将使用 HEDGE_HYBRID：mark/index、规则与费率来自已揭示 K 线代理；历史资金费将关闭（OFF）。这不是交易所精确历史。";
}

export async function prepareReplayInitialMarketSelection({
  api,
  runId,
  catalog,
  entry,
}: {
  readonly api: ReplayInitialMarketApi;
  readonly runId: string;
  readonly catalog: ReplayCatalog;
  readonly entry: ReplayCatalogEntry;
}): Promise<ReplayInitialMarketPreparedSelection> {
  const selection = selectionFromEntry(catalog, entry);
  const plan = await api.planInitialMarket(runId, selection);
  return {
    selection: selectionWithPreparedInputs(selection, plan),
    plan,
    downgradeConfirmation: replayInitialMarketDowngradeConfirmation(plan),
  };
}

/**
 * Prepare and select the first market against one catalog epoch at a time.
 * Archive preparation can legitimately advance the capability epoch. Only
 * that conflict is refreshed and retried, exactly once, with a new plan.
 */
export async function selectReplayInitialMarketWithEpochRetry({
  api,
  runId,
  catalog,
  entry,
}: {
  readonly api: ReplayInitialMarketApi;
  readonly runId: string;
  readonly catalog: ReplayCatalog;
  readonly entry: ReplayCatalogEntry;
}): Promise<ReplayInitialMarketSelectionResult> {
  let activeCatalog = catalog;
  let activeEntry = entry;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const prepared = await prepareReplayInitialMarketSelection({
        api,
        runId,
        catalog: activeCatalog,
        entry: activeEntry,
      });
      const response = await api.selectInitialMarket(
        runId,
        prepared.selection,
      );
      return {
        response,
        catalog: activeCatalog,
        catalogRefreshes: attempt as 0 | 1,
      };
    } catch (reason) {
      if (!(reason instanceof ReplayV2ApiError)
        || reason.code !== "CATALOG_EPOCH_MISMATCH"
        || attempt !== 0) {
        throw reason;
      }
      activeCatalog = await api.marketCatalog(runId);
      const refreshedEntry = activeCatalog.entries.find((candidate) => (
        sameMarket(candidate, entry)
      ));
      if (refreshedEntry === undefined || refreshedEntry.selected_base_interval === null) {
        throw new Error("能力目录刷新后所选商品不再可用");
      }
      activeEntry = refreshedEntry;
    }
  }
  throw new Error("商品初始化重试状态不可达");
}
