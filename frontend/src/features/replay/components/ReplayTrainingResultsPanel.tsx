import { useEffect, useState } from "react";

import { getNumberLocale, t } from "../../../i18n/index.js";
import { useLocale } from "../../../i18n/useLocale.js";
import type { LocaleId } from "../../../i18n/locale.js";
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

function decimal(value: string | null, digits = 2, locale: LocaleId): string {
  if (value === null) return "--";
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString(getNumberLocale(locale), { maximumFractionDigits: digits })
    : value;
}

function percent(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(1)}%` : "--";
}

function duration(valueMs: number, locale: LocaleId): string {
  if (valueMs < 60_000) return t("replay.results.sec", { count: Math.round(valueMs / 1_000) }, locale);
  if (valueMs < 3_600_000) return t("replay.results.min", { count: Math.round(valueMs / 60_000) }, locale);
  if (valueMs < 86_400_000) return t("replay.results.hour", { count: (valueMs / 3_600_000).toFixed(1) }, locale);
  return t("replay.results.day", { count: (valueMs / 86_400_000).toFixed(1) }, locale);
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
  const locale = useLocale();
  const plan = item.plans[0] ?? null;
  const pnl = Number(item.gross_realized_pnl);
  return (
    <article className="replay-training-result-row" data-pnl={pnl > 0 ? "profit" : pnl < 0 ? "loss" : "flat"}>
      <header>
        <strong>{item.symbol} · {item.position_side === "BUY" ? t("replay.results.long") : t("replay.results.short")}</strong>
        <span>{decimal(item.gross_realized_pnl, 2, locale)} {item.settlement_asset} · {item.r_multiple === null ? t("replay.results.noPlanR") : `${decimal(item.r_multiple, 2, locale)}R`}</span>
      </header>
      <dl>
        <div><dt>{t("replay.results.entryExit")}</dt><dd>{decimal(item.entry_price, 8, locale)} / {decimal(item.exit_price, 8, locale)}</dd></div>
        <div><dt>MAE / MFE</dt><dd>{decimal(item.mae, 2, locale)} / {decimal(item.mfe, 2, locale)} {item.settlement_asset}</dd></div>
        <div><dt>{t("replay.results.hold")}</dt><dd>{duration(item.holding_duration_ms, locale)}</dd></div>
        <div><dt>{t("replay.results.qty")}</dt><dd>{decimal(item.quantity, 8, locale)}</dd></div>
        <div><dt>{t("replay.results.risk")}</dt><dd>{decimal(item.initial_risk_amount, 2, locale)} {item.settlement_asset}</dd></div>
        <div><dt>{t("replay.results.plan")}</dt><dd>{plan === null ? t("replay.results.unrecorded") : `${decimal(plan.risk_amount, 2, locale)} ${item.settlement_asset} · ${decimal(plan.reward_risk_ratio, 2, locale)} R:R`}</dd></div>
      </dl>
      {plan !== null && <p title={plan.plan_hash}>{plan.reason}</p>}
      <footer>
        <button
          type="button"
          disabled={!canReview || item.review_event_id === null || jumping}
          onClick={onJump}
        >{jumping ? t("replay.results.jumping") : t("replay.results.jump")}</button>
        <button
          type="button"
          disabled={!canReview || item.review_event_id === null || forking}
          onClick={onFork}
        >{forking ? t("replay.results.forking") : t("replay.results.fork")}</button>
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
  const locale = useLocale();
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
      setError(cause instanceof Error ? cause.message : t("replay.results.loadFailed"));
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
      setError(cause instanceof Error ? cause.message : t("replay.results.jumpFailed"));
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
      setError(cause instanceof Error ? cause.message : t("replay.results.forkFailed"));
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
          <span className="training-hub-kicker">{t("replay.kicker.results")}</span>
          <h2>{t("replay.results.title")}</h2>
          <p>{t("replay.results.hint")}</p>
        </div>
        <div>
          <button type="button" disabled={loading} onClick={() => load()}>{t("replay.hub.refresh")}</button>
          <button type="button" onClick={onClose}>{t("replay.hub.close")}</button>
        </div>
      </header>

      {summary !== null && (
        <dl className="replay-training-result-summary">
          <div><dt>{t("replay.results.winRate")}</dt><dd>{percent(summary.win_rate)}</dd></div>
          <div><dt>{t("replay.results.payoff")}</dt><dd>{decimal(summary.payoff_ratio, 2, locale)}</dd></div>
          <div><dt>{t("replay.results.drawdown")}</dt><dd>{decimal(summary.max_drawdown, 2, locale)} {summaryAsset}</dd></div>
          <div><dt>{t("replay.results.net")}</dt><dd>{decimal(summary.net_realized_pnl, 2, locale)} {summaryAsset}</dd></div>
          <div><dt>{t("replay.results.avgR")}</dt><dd>{summary.average_r_multiple === null ? "--" : `${decimal(summary.average_r_multiple, 2, locale)}R`}</dd></div>
          <div><dt>{t("replay.results.avgHold")}</dt><dd>{duration(summary.average_holding_duration_ms, locale)}</dd></div>
          <div><dt>{t("replay.results.avgMae")}</dt><dd>{decimal(summary.average_mae, 2, locale)} {summaryAsset}</dd></div>
          <div><dt>{t("replay.results.avgMfe")}</dt><dd>{decimal(summary.average_mfe, 2, locale)} {summaryAsset}</dd></div>
        </dl>
      )}

      {!canReview && <p className="replay-training-results-notice">{t("replay.results.pauseToJump")}</p>}
      {forkedRunId !== null && <p className="replay-training-results-notice">{t("replay.results.forked", { id: forkedRunId })}</p>}
      {error !== null && <p className="replay-training-results-error" role="alert">{error}</p>}
      {loading && results === null && <p>{t("replay.results.loading")}</p>}
      {!loading && results !== null && results.items.length === 0 && <p>{t("replay.results.empty")}</p>}
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
      {results?.truncated && <p>{t("replay.results.truncated", { count: results.returned_count })}</p>}
    </section>
  );
}
