import { useEffect, useState } from "react";

import { defaultReplayV2Api } from "../replayV2Api.js";
import type {
  ReplayTrainingResultItem,
  ReplayTrainingResultsResponse,
} from "../replayV2Types.js";
import type { ReplayIntegrityRuntime } from "../useReplayIntegrityRuntime.js";

interface ReplayTrainingResultsPanelProps {
  readonly runId: string;
  readonly integrityRuntime: ReplayIntegrityRuntime;
  readonly trainingState: string | null;
  readonly onClose: () => void;
}

function decimal(value: string | null, digits = 2): string {
  if (value === null) return "--";
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString("zh-CN", { maximumFractionDigits: digits })
    : value;
}

function percent(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(1)}%` : "--";
}

function duration(valueMs: number): string {
  if (valueMs < 60_000) return `${Math.round(valueMs / 1_000)} 秒`;
  if (valueMs < 3_600_000) return `${Math.round(valueMs / 60_000)} 分钟`;
  if (valueMs < 86_400_000) return `${(valueMs / 3_600_000).toFixed(1)} 小时`;
  return `${(valueMs / 86_400_000).toFixed(1)} 天`;
}

function TradeRow({
  item,
  jumping,
  forking,
  canReview,
  onJump,
  onFork,
}: {
  readonly item: ReplayTrainingResultItem;
  readonly jumping: boolean;
  readonly forking: boolean;
  readonly canReview: boolean;
  readonly onJump: () => void;
  readonly onFork: () => void;
}) {
  const plan = item.plans[0] ?? null;
  const pnl = Number(item.gross_realized_pnl);
  return (
    <article className="replay-training-result-row" data-pnl={pnl > 0 ? "profit" : pnl < 0 ? "loss" : "flat"}>
      <header>
        <strong>{item.symbol} · {item.position_side === "BUY" ? "多" : "空"}</strong>
        <span>{decimal(item.gross_realized_pnl)} {item.settlement_asset} · {item.r_multiple === null ? "无计划 R" : `${decimal(item.r_multiple)}R`}</span>
      </header>
      <dl>
        <div><dt>入场 / 出场</dt><dd>{decimal(item.entry_price, 8)} / {decimal(item.exit_price, 8)}</dd></div>
        <div><dt>MAE / MFE</dt><dd>{decimal(item.mae)} / {decimal(item.mfe)} {item.settlement_asset}</dd></div>
        <div><dt>持仓</dt><dd>{duration(item.holding_duration_ms)}</dd></div>
        <div><dt>数量</dt><dd>{decimal(item.quantity, 8)}</dd></div>
        <div><dt>初始风险</dt><dd>{decimal(item.initial_risk_amount)} {item.settlement_asset}</dd></div>
        <div><dt>计划</dt><dd>{plan === null ? "未记录" : `${decimal(plan.risk_amount)} ${item.settlement_asset} · ${decimal(plan.reward_risk_ratio)} R:R`}</dd></div>
      </dl>
      {plan !== null && <p title={plan.plan_hash}>{plan.reason}</p>}
      <footer>
        <button
          type="button"
          disabled={!canReview || item.review_event_id === null || jumping}
          onClick={onJump}
        >{jumping ? "定位中…" : "跳到对应 K 线"}</button>
        <button
          type="button"
          disabled={!canReview || item.review_event_id === null || forking}
          onClick={onFork}
        >{forking ? "Fork 中…" : "从这里 Fork"}</button>
      </footer>
    </article>
  );
}

export default function ReplayTrainingResultsPanel({
  runId,
  integrityRuntime,
  trainingState,
  onClose,
}: ReplayTrainingResultsPanelProps) {
  const [results, setResults] = useState<ReplayTrainingResultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jumpingId, setJumpingId] = useState<string | null>(null);
  const [forkingId, setForkingId] = useState<string | null>(null);
  const [forkedRunId, setForkedRunId] = useState<string | null>(null);

  const load = () => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void defaultReplayV2Api.trainingResultsRun(runId, controller.signal).then((response) => {
      setResults(response);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "训练成绩加载失败");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return controller;
  };

  useEffect(() => {
    const controller = load();
    return () => controller.abort();
    // The panel is remounted for each run; explicit refresh handles later mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const canReview = trainingState === "PAUSED" || trainingState === "ENDED";
  const jump = async (item: ReplayTrainingResultItem) => {
    if (item.review_event_id === null) return;
    setJumpingId(item.trade_id);
    setError(null);
    try {
      if (integrityRuntime.review === null) {
        await integrityRuntime.actions.startReview(item.review_event_id);
      } else {
        await integrityRuntime.actions.controlReview("JUMP", {
          eventId: item.review_event_id,
        });
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法定位到成交 K 线");
    } finally {
      setJumpingId(null);
    }
  };

  const fork = async (item: ReplayTrainingResultItem) => {
    if (item.review_event_id === null) return;
    setForkingId(item.trade_id);
    setError(null);
    try {
      const response = await integrityRuntime.actions.forkReview(item.review_event_id);
      setForkedRunId(response.run.run_id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法从成交事件 Fork");
    } finally {
      setForkingId(null);
    }
  };

  const summary = results?.summary ?? null;
  const summaryAsset = results?.items[0]?.settlement_asset ?? "";
  return (
    <section className="replay-training-results-panel" data-replay-panel="training-results">
      <header>
        <div>
          <span className="training-hub-kicker">TRAINING RESULTS</span>
          <h2>训练成绩</h2>
          <p>逐笔结果来自已揭示成交路径；MAE/MFE 为保守的 mark-to-market 路径值。</p>
        </div>
        <div>
          <button type="button" disabled={loading} onClick={() => load()}>刷新</button>
          <button type="button" onClick={onClose}>关闭</button>
        </div>
      </header>

      {summary !== null && (
        <dl className="replay-training-result-summary">
          <div><dt>胜率</dt><dd>{percent(summary.win_rate)}</dd></div>
          <div><dt>盈亏比</dt><dd>{decimal(summary.payoff_ratio)}</dd></div>
          <div><dt>最大回撤</dt><dd>{decimal(summary.max_drawdown)} {summaryAsset}</dd></div>
          <div><dt>净已实现</dt><dd>{decimal(summary.net_realized_pnl)} {summaryAsset}</dd></div>
          <div><dt>平均 R</dt><dd>{summary.average_r_multiple === null ? "--" : `${decimal(summary.average_r_multiple)}R`}</dd></div>
          <div><dt>平均持仓</dt><dd>{duration(summary.average_holding_duration_ms)}</dd></div>
          <div><dt>平均 MAE</dt><dd>{decimal(summary.average_mae)} {summaryAsset}</dd></div>
          <div><dt>平均 MFE</dt><dd>{decimal(summary.average_mfe)} {summaryAsset}</dd></div>
        </dl>
      )}

      {!canReview && <p className="replay-training-results-notice">暂停训练后，才能跳转 K 线或从该事件 Fork。</p>}
      {forkedRunId !== null && <p className="replay-training-results-notice">已创建 Fork：{forkedRunId}</p>}
      {error !== null && <p className="replay-training-results-error" role="alert">{error}</p>}
      {loading && results === null && <p>正在读取训练成绩…</p>}
      {!loading && results !== null && results.items.length === 0 && <p>暂无已平仓交易。完成一次平仓后，这里会生成逐笔结果。</p>}
      <div className="replay-training-result-list">
        {results?.items.map((item) => (
          <TradeRow
            key={`${item.track_id}:${item.trade_id}`}
            item={item}
            jumping={jumpingId === item.trade_id}
            forking={forkingId === item.trade_id}
            canReview={canReview}
            onJump={() => void jump(item)}
            onFork={() => void fork(item)}
          />
        ))}
      </div>
      {results?.truncated && <p>仅显示最近 {results.returned_count} 笔，汇总指标仍覆盖全部交易。</p>}
    </section>
  );
}
