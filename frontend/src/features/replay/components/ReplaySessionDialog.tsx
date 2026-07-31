import { useMemo, useState } from "react";
import {
  buildReplaySessionConfig,
  createReplaySessionDraft,
  evaluateReplaySessionDraft,
  replayCatalogIdentity,
} from "../replayUiModel.js";
import type { ReplaySessionDraft } from "../replayUiModel.js";
import type { ReplayRuntime } from "../useReplayRuntime.js";

export interface ReplaySessionDialogProps {
  readonly runtime: ReplayRuntime;
}

function numericValue(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default function ReplaySessionDialog({ runtime }: ReplaySessionDialogProps) {
  const [draftOverride, setDraft] = useState<ReplaySessionDraft | null>(null);
  const draft = draftOverride ?? createReplaySessionDraft(runtime.catalog);
  const [localError, setLocalError] = useState<string | null>(null);
  const evaluation = useMemo(
    () => evaluateReplaySessionDraft(draft, runtime.capabilities, runtime.catalog),
    [draft, runtime.capabilities, runtime.catalog],
  );

  const update = <K extends keyof ReplaySessionDraft>(key: K, value: ReplaySessionDraft[K]) => {
    setDraft((current) => ({ ...(current ?? createReplaySessionDraft(runtime.catalog)), [key]: value }));
  };
  const busy = runtime.operation === "catalog" || runtime.operation === "create";
  const sourceCapability = runtime.capabilities?.sources[draft.sourceKind];
  const sourceLabel = draft.sourceKind === "agg_trade" ? "AGG_TRADE" : "BAR";

  return (
    <main className="replay-config-page" data-replay-state="configuring">
      <section className="replay-session-dialog" role="dialog" aria-labelledby="replay-session-title" aria-describedby="replay-session-summary">
        <div className="replay-dialog-heading">
          <div>
            <span className="replay-mode-badge">REPLAY</span>
            <h1 id="replay-session-title">新建 K 线训练回放</h1>
            <p>创建后市场、数据源、起点、seed 与执行模型不可原地修改。</p>
          </div>
          <a href="/" target="_blank" rel="noopener noreferrer">打开实时行情 ↗</a>
        </div>

        {(runtime.error || localError) && (
          <div className="replay-error-summary" role="alert" data-replay-error={runtime.error?.code ?? "FORM_ERROR"}>
            <strong>无法开始回放</strong>
            <span>{runtime.error?.code ? `${runtime.error.code}: ` : ""}{runtime.error?.message ?? localError}</span>
          </div>
        )}

        <div className="replay-form-grid">
          <label>
            数据源
            <select
              data-replay-field="source-kind"
              value={draft.sourceKind}
              disabled={busy}
              aria-describedby="replay-source-help"
              onChange={(event) => update("sourceKind", event.target.value as ReplaySessionDraft["sourceKind"])}
            >
              <option value="bar" disabled={runtime.capabilities?.sources.bar.enabled === false}>BAR</option>
              <option value="agg_trade" disabled={runtime.capabilities?.sources.agg_trade.enabled !== true}>
                AGG_TRADE{runtime.capabilities?.sources.agg_trade.enabled === false
                  ? `（${runtime.capabilities.sources.agg_trade.reason ?? "不可用"}）`
                  : ""}
              </option>
            </select>
            <small id="replay-source-help">
              {sourceCapability?.enabled
                ? `${sourceLabel} 已通过能力门，创建时仍会冻结并复核所选窗口。`
                : sourceCapability?.reason ?? "等待服务端能力确认。"}
            </small>
          </label>

          <label>
            市场
            <select
              data-replay-field="identity"
              value={draft.catalogIdentity}
              onChange={(event) => {
                const identity = event.target.value;
                const entry = runtime.catalog?.entries.find((item) => replayCatalogIdentity(item) === identity);
                const baseInterval = entry?.selected_base_interval ?? entry?.base_intervals[0] ?? "1m";
                setDraft((current) => ({
                  ...(current ?? createReplaySessionDraft(runtime.catalog)),
                  catalogIdentity: identity,
                  displayInterval: baseInterval === "1m" ? "5m" : baseInterval,
                }));
              }}
              disabled={busy || !runtime.catalog?.entries.length}
            >
              {!runtime.catalog?.entries.length && <option value="">没有 eligible dataset</option>}
              {runtime.catalog?.entries.map((entry) => (
                <option key={replayCatalogIdentity(entry)} value={replayCatalogIdentity(entry)}>
                  {entry.identity.exchange} · {entry.identity.market_type} · {entry.identity.symbol}
                </option>
              ))}
            </select>
          </label>

          <label>
            展示周期
            <select
              data-replay-field="display-interval"
              value={draft.displayInterval}
              onChange={(event) => update("displayInterval", event.target.value)}
              disabled={busy || evaluation.availableDisplayIntervals.length === 0}
            >
              {evaluation.availableDisplayIntervals.map((interval) => <option key={interval}>{interval}</option>)}
            </select>
          </label>

          <label>
            起点策略
            <select
              value={draft.startPolicy}
              onChange={(event) => update("startPolicy", event.target.value as ReplaySessionDraft["startPolicy"])}
              disabled={busy}
            >
              <option value="random_eligible">随机 eligible window</option>
              <option value="manual">手动起点</option>
            </select>
          </label>

          {draft.startPolicy === "manual" && (
            <label>
              手动起点（UTC）
              <input
                type="datetime-local"
                onChange={(event) => update("requestedStartMs", event.target.value ? Date.parse(`${event.target.value}Z`) : null)}
                disabled={busy}
              />
            </label>
          )}

          <label>
            训练 horizon
            <select value={draft.horizonMs} onChange={(event) => update("horizonMs", numericValue(event.target.value, 604_800_000))} disabled={busy}>
              <option value={86_400_000}>1 天</option>
              <option value={259_200_000}>3 天</option>
              <option value={604_800_000}>7 天</option>
              <option value={2_592_000_000}>30 天</option>
            </select>
          </label>

          <label>
            初始权益（USDT）
            <input value={draft.initialEquity} inputMode="decimal" onChange={(event) => update("initialEquity", event.target.value)} disabled={busy} />
          </label>

          <label className="replay-checkbox-field">
            <input type="checkbox" checked={draft.blindMode} onChange={(event) => update("blindMode", event.target.checked)} disabled={busy} />
            Blind mode（隐藏真实日期）
          </label>
        </div>

        <details className="replay-advanced-settings">
          <summary>高级设置</summary>
          <div className="replay-form-grid">
            <label>Base interval<input value={evaluation.baseInterval ?? "--"} readOnly /></label>
            <label>Warmup bars<input type="number" min={1} value={draft.warmupBars} onChange={(event) => update("warmupBars", numericValue(event.target.value, 500))} /></label>
            <label>Seed<input type="number" min={0} value={draft.randomSeed} onChange={(event) => update("randomSeed", numericValue(event.target.value, 20_260_718))} /></label>
            <label>Quality<select value="exact" disabled><option>exact</option><option disabled>best_effort（未开放）</option></select></label>
            <label>Maker fee (bps)<input value={draft.makerBps} onChange={(event) => update("makerBps", event.target.value)} /></label>
            <label>Taker fee (bps)<input value={draft.takerBps} onChange={(event) => update("takerBps", event.target.value)} /></label>
            <label>Market slippage (bps)<input value={draft.marketSlippageBps} onChange={(event) => update("marketSlippageBps", event.target.value)} /></label>
            <label>最大杠杆<input value={draft.maxLeverage} onChange={(event) => update("maxLeverage", event.target.value)} /></label>
            <label>Execution model<input value="paper_linear_v1" readOnly /></label>
          </div>
        </details>

        <div className="replay-fidelity-summary" id="replay-session-summary" data-replay-fidelity={evaluation.dataFidelity}>
          <strong>训练保真度</strong>
          <span>{sourceLabel} · {evaluation.dataFidelity} · {evaluation.executionFidelity}</span>
          <span>{draft.sourceKind === "agg_trade"
            ? "聚合成交 tape 的 checksum 与 ID 连续性会严格校验；K 线由 tape 近似聚合，可能不同于官方 K 线，且不模拟历史 L2 队列位置。"
            : "无历史 L2；同一 BAR 内多路径触发按最不利、保守路径处理。"}</span>
        </div>

        <button
          className="replay-primary-action"
          data-replay-action="create-session"
          type="button"
          disabled={busy || !evaluation.canSubmit}
          title={evaluation.disabledReason ?? "开始回放"}
          onClick={() => {
            setLocalError(null);
            try {
              const config = buildReplaySessionConfig(draft, evaluation);
              void runtime.actions.createSession(config).catch((error: unknown) => {
                setLocalError(error instanceof Error ? error.message : "创建 session 失败");
              });
            } catch (error) {
              setLocalError(error instanceof Error ? error.message : "配置无效");
            }
          }}
        >
          {runtime.operation === "create" ? "正在创建…" : "开始回放"}
        </button>
        {evaluation.disabledReason && <p className="replay-disabled-reason">{evaluation.disabledReason}</p>}
      </section>
    </main>
  );
}
