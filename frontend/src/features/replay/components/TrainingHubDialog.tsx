import type { ReplayCatalogEntry } from "../replayTypes.js";
import type { TrainingRunDraft } from "../trainingHubModel.js";
import {
  REPLAY_POLICY_MUTATIONS,
  type ReplayPolicyMutation,
} from "../replayIntegrityModel.js";
import type {
  ReplayV2RunState,
  ReplayV2SourceKind,
  TrainingRunCompatibility,
} from "../replayV2Types.js";
import type { TrainingHubRuntime } from "../useTrainingHub.js";

export interface TrainingHubDialogProps {
  readonly runtime: TrainingHubRuntime;
}

function patchDraft(
  runtime: TrainingHubRuntime,
  patch: Partial<TrainingRunDraft>,
): void {
  if (runtime.draft === null) return;
  runtime.actions.setDraft({ ...runtime.draft, ...patch });
}

function chooseCatalogEntry(runtime: TrainingHubRuntime, symbol: string): void {
  const entry = runtime.catalog?.entries.find((candidate) => candidate.identity.symbol === symbol);
  if (entry === undefined || runtime.draft === null) return;
  const interval = entry.selected_base_interval ?? entry.base_intervals[0] ?? "1m";
  patchDraft(runtime, {
    exchange: entry.identity.exchange,
    marketType: entry.identity.market_type,
    symbol: entry.identity.symbol,
    baseInterval: interval,
    displayInterval: interval,
  });
}

function CatalogOption({ entry }: { readonly entry: ReplayCatalogEntry }) {
  return (
    <option value={entry.identity.symbol}>
      {entry.identity.exchange} · {entry.identity.market_type} · {entry.identity.symbol}
    </option>
  );
}

function TrainingRunCreatePanel({ runtime }: TrainingHubDialogProps) {
  const { draft, evaluation } = runtime;
  if (!runtime.createOpen) return null;
  if (draft === null || evaluation === null || runtime.catalog === null) {
    return (
      <section className="training-hub-create" aria-label="新建训练配置">
        <div className="replay-loading-spinner" />
        <p>正在按需加载服务端能力与盲化目录…</p>
        <button type="button" onClick={runtime.actions.closeCreate}>取消</button>
      </section>
    );
  }
  const busy = runtime.operation === "create";
  const toggleMutation = (mutation: ReplayPolicyMutation, checked: boolean) => {
    const next = checked
      ? [...draft.allowedMutations, mutation]
      : draft.allowedMutations.filter((item) => item !== mutation);
    patchDraft(runtime, { allowedMutations: [...new Set(next)] });
  };
  return (
    <section className="training-hub-create" aria-label="新建训练配置">
      <header>
        <div>
          <span className="training-hub-kicker">ATOMIC CREATE · replay.v2</span>
          <h2>新建训练</h2>
          <p>提交后一次事务创建存档、单轨 adapter、规则、账户和初始 checkpoint。</p>
        </div>
        <button type="button" onClick={runtime.actions.closeCreate} disabled={busy}>关闭</button>
      </header>
      <div className="training-hub-form-grid">
        <label>
          存档名称
          <input
            value={draft.name}
            maxLength={80}
            onChange={(event) => patchDraft(runtime, { name: event.target.value })}
          />
        </label>
        <label>
          商品
          <select
            value={draft.symbol}
            onChange={(event) => chooseCatalogEntry(runtime, event.target.value)}
          >
            {runtime.catalog.entries.map((entry) => (
              <CatalogOption
                key={`${entry.identity.exchange}:${entry.identity.market_type}:${entry.identity.symbol}`}
                entry={entry}
              />
            ))}
          </select>
        </label>
        <label>
          历史源
          <select
            value={draft.sourceKind}
            onChange={(event) => patchDraft(runtime, {
              sourceKind: event.target.value as ReplayV2SourceKind,
            })}
          >
            <option value="BAR">BAR · 精确 OHLCV</option>
            <option
              value="AGG_TRADE"
              disabled={!runtime.capabilities?.sources.agg_trade.enabled}
            >
              AGG_TRADE · 仅服务端有精确归档时可选
            </option>
          </select>
        </label>
        <label>
          开始方式
          <select
            value={draft.startMode}
            onChange={(event) => patchDraft(runtime, {
              startMode: event.target.value as TrainingRunDraft["startMode"],
              requestedStartMs: event.target.value === "RANDOM" ? null : draft.requestedStartMs,
            })}
          >
            <option value="RANDOM">随机合格窗口</option>
            <option value="MANUAL">手动毫秒时间</option>
          </select>
        </label>
        {draft.startMode === "MANUAL" && (
          <>
            <label>
              请求开始时间（ms）
              <input
                type="number"
                min={0}
                value={draft.requestedStartMs ?? ""}
                onChange={(event) => patchDraft(runtime, {
                  requestedStartMs: event.target.value === "" ? null : Number(event.target.value),
                })}
              />
            </label>
            <p className="training-hub-field-warning" role="note">
              手动起点属于已知时间；即使隐藏显示，也不会获得严格 Challenge 结果标签。
            </p>
          </>
        )}
        <label>
          完整性模式
          <select
            value={draft.integrityMode}
            onChange={(event) => {
              const integrityMode = event.target.value as TrainingRunDraft["integrityMode"];
              patchDraft(runtime, {
                integrityMode,
                allowedMutations: integrityMode === "CHALLENGE"
                  ? []
                  : integrityMode === "SANDBOX"
                    ? REPLAY_POLICY_MUTATIONS
                    : ["deposit", "withdraw"],
              });
            }}
          >
            <option value="CHALLENGE">Challenge · 全部规则锁定</option>
            <option value="PRACTICE">Practice · 显式白名单</option>
            <option value="SANDBOX">Sandbox · 全部变更可审计</option>
          </select>
        </label>
        <label>
          时间披露
          <select
            value={draft.timeDisclosurePolicy}
            onChange={(event) => patchDraft(runtime, {
              timeDisclosurePolicy: event.target.value as TrainingRunDraft["timeDisclosurePolicy"],
            })}
          >
            <option value="NONE">NONE · 显示历史时间</option>
            <option value="HIDE_YEAR">HIDE_YEAR · 隐藏年份</option>
            <option value="HIDE_MONTH">HIDE_MONTH · 隐藏年月</option>
            <option value="HIDE_DAY">HIDE_DAY · 相对日期</option>
            <option value="HIDE_HOUR">HIDE_HOUR · 相对小时</option>
            <option value="HIDE_MINUTE">HIDE_MINUTE · 相对分钟</option>
            <option value="HIDE_ALL">HIDE_ALL · 完全相对时间</option>
          </select>
        </label>
        <label>
          基础 / 显示周期
          <input value={`${draft.baseInterval} / ${draft.displayInterval}`} readOnly />
        </label>
        <label>
          预热 BAR
          <input
            type="number"
            min={1}
            value={draft.warmupBars}
            onChange={(event) => patchDraft(runtime, { warmupBars: Number(event.target.value) })}
          />
        </label>
        <label>
          前向缓存（ms）
          <input
            type="number"
            min={1}
            value={draft.forwardCacheMs}
            onChange={(event) => patchDraft(runtime, { forwardCacheMs: Number(event.target.value) })}
          />
        </label>
        <label>
          初始权益
          <input
            inputMode="decimal"
            value={draft.initialEquity}
            onChange={(event) => patchDraft(runtime, { initialEquity: event.target.value })}
          />
        </label>
        <label>
          最大杠杆
          <input
            inputMode="decimal"
            value={draft.maxLeverage}
            onChange={(event) => patchDraft(runtime, { maxLeverage: event.target.value })}
          />
        </label>
        <label>
          Maker / Taker bps
          <span className="training-hub-inline-inputs">
            <input
              inputMode="decimal"
              value={draft.makerFeeBps}
              aria-label="Maker bps"
              onChange={(event) => patchDraft(runtime, { makerFeeBps: event.target.value })}
            />
            <input
              inputMode="decimal"
              value={draft.takerFeeBps}
              aria-label="Taker bps"
              onChange={(event) => patchDraft(runtime, { takerFeeBps: event.target.value })}
            />
          </span>
        </label>
        <label>
          市价滑点 bps
          <input
            inputMode="decimal"
            value={draft.marketSlippageBps}
            onChange={(event) => patchDraft(runtime, { marketSlippageBps: event.target.value })}
          />
        </label>
      </div>
      <fieldset className="training-hub-mutation-policy" disabled={draft.integrityMode !== "PRACTICE" || busy}>
        <legend>Practice 可审计变更白名单</legend>
        {REPLAY_POLICY_MUTATIONS.map((mutation) => (
          <label key={mutation}>
            <input
              type="checkbox"
              checked={draft.allowedMutations.includes(mutation)}
              onChange={(event) => toggleMutation(mutation, event.target.checked)}
            />
            {mutation}
          </label>
        ))}
        <p>入金、出金和不可逆时间揭示已接通；费率、杠杆上限与资金费策略当前命令会明确拒绝。</p>
      </fieldset>
      <div className="training-hub-capability-boundary" aria-label="Phase 5 能力边界">
        <h3>Phase 5 多商品已启用</h3>
        <p>进入训练后可在同交易所、同市场类型、同结算资产范围添加 MarketTrack，并使用 NONE / WARM / FULL 分级。</p>
        <h3>后续阶段明确不可用</h3>
        <ul>
          <li><strong>资金费</strong> — {evaluation.unsupported.funding}</li>
          <li><strong>历史盘口</strong> — {evaluation.unsupported.historical_l2}</li>
          <li><strong>动态规则</strong> — {evaluation.unsupported.rule_changes}</li>
          <li><strong>逐仓保证金</strong> — {evaluation.unsupported.isolated_margin}</li>
        </ul>
      </div>
      {evaluation.errors.length > 0 && (
        <div className="replay-error-summary" role="alert">
          {evaluation.errors.map((message) => <span key={message}>{message}</span>)}
        </div>
      )}
      <button
        className="replay-primary-action"
        type="button"
        disabled={!evaluation.canSubmit || busy}
        onClick={() => void runtime.actions.createRun(draft)}
      >
        {busy ? "正在原子创建…" : "创建并进入训练"}
      </button>
    </section>
  );
}

export default function TrainingHubDialog({ runtime }: TrainingHubDialogProps) {
  const busy = runtime.operation !== null;
  return (
    <main
      className="training-hub-page"
      role="dialog"
      aria-modal="false"
      aria-labelledby="training-hub-title"
      data-training-hub-phase={runtime.phase}
    >
      <section className="training-hub-shell">
        <header className="training-hub-heading">
          <div>
            <span className="training-hub-kicker">SERVER-AUTHORITATIVE ARCHIVE WORKBENCH</span>
            <h1 id="training-hub-title">训练存档大厅</h1>
            <p>这里只读取轻量存档摘要；历史数据集在进入具体训练前不会加载。</p>
          </div>
          <div className="training-hub-heading-actions">
            <button type="button" onClick={runtime.actions.refresh} disabled={busy}>刷新</button>
            <button type="button" onClick={() => void runtime.actions.openCreate()} disabled={busy}>
              新建训练
            </button>
            <a href="/" target="_blank" rel="noopener noreferrer">实时行情 ↗</a>
          </div>
        </header>

        <div className="training-hub-filters" aria-label="存档筛选">
          <label>
            状态
            <select
              value={runtime.filters.state ?? ""}
              onChange={(event) => runtime.actions.setFilters({
                ...runtime.filters,
                state: event.target.value === "" ? null : event.target.value as ReplayV2RunState,
              })}
            >
              <option value="">全部状态</option>
              {(["PAUSED", "PLAYING", "ADVANCING", "ENDED", "ERROR"] as const).map((state) => (
                <option key={state} value={state}>{state}</option>
              ))}
            </select>
          </label>
          <label>
            历史源
            <select
              value={runtime.filters.sourceKind ?? ""}
              onChange={(event) => runtime.actions.setFilters({
                ...runtime.filters,
                sourceKind: event.target.value === "" ? null : event.target.value as ReplayV2SourceKind,
              })}
            >
              <option value="">全部历史源</option>
              <option value="BAR">BAR</option>
              <option value="AGG_TRADE">AGG_TRADE</option>
            </select>
          </label>
          <label>
            兼容性
            <select
              value={runtime.filters.compatibility ?? ""}
              onChange={(event) => runtime.actions.setFilters({
                ...runtime.filters,
                compatibility: event.target.value === ""
                  ? null
                  : event.target.value as TrainingRunCompatibility,
              })}
            >
              <option value="">全部兼容性</option>
              <option value="READY">READY</option>
              <option value="LEGACY_ADAPTER">LEGACY_ADAPTER</option>
              <option value="LEGACY_V1">LEGACY_V1</option>
              <option value="UNAVAILABLE">UNAVAILABLE</option>
            </select>
          </label>
        </div>

        {runtime.error !== null && (
          <div className="replay-error-summary" role="alert">
            <strong>{runtime.error.code}</strong>
            <span>{runtime.error.message}</span>
            {runtime.error.code === "CATALOG_EPOCH_MISMATCH" && (
              <button type="button" onClick={() => void runtime.actions.openCreate()}>
                重新校验能力目录
              </button>
            )}
          </div>
        )}

        {runtime.phase === "LOADING" && runtime.items.length === 0 ? (
          <div className="training-hub-empty"><div className="replay-loading-spinner" />正在读取存档摘要…</div>
        ) : runtime.items.length === 0 ? (
          <div className="training-hub-empty">
            <strong>还没有训练存档</strong>
            <span>创建第一条服务端权威训练；默认使用盲化随机窗口。</span>
          </div>
        ) : (
          <div className="training-hub-card-grid">
            {runtime.items.map((card) => (
              <article className="training-hub-card" key={`${card.kind}:${card.run_id}`}>
                <header>
                  <div>
                    <span>{card.kind === "LEGACY_V1" ? "LEGACY V1" : "TRAINING RUN"}</span>
                    <h2>{card.name}</h2>
                  </div>
                  <strong data-run-state={card.state}>{card.state}</strong>
                </header>
                <dl>
                  <div><dt>商品</dt><dd>{card.last_symbol}</dd></div>
                  <div><dt>历史源</dt><dd>{card.source_kind}</dd></div>
                  <div><dt>进度</dt><dd>#{card.progress.source_sequence}</dd></div>
                  <div>
                    <dt>权益</dt>
                    <dd>{card.equity_status === "CURRENT" ? `${card.equity} ${card.settlement_asset}` : card.equity_status}</dd>
                  </div>
                  <div><dt>时间披露</dt><dd>{card.time_disclosure_policy}</dd></div>
                  <div><dt>兼容层</dt><dd>{card.compatibility}</dd></div>
                </dl>
                <p>{card.status.message}</p>
                <footer>
                  <button
                    type="button"
                    disabled={busy || card.resume_action === "UNAVAILABLE"}
                    onClick={() => runtime.actions.continueRun(card)}
                  >
                    继续训练
                  </button>
                  {card.kind === "LEGACY_V1" && card.resume_action !== "UNAVAILABLE" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void runtime.actions.migrateLegacy(card.adapter_session_id, card.name)}
                    >
                      建立 v2 包装并继续
                    </button>
                  )}
                </footer>
              </article>
            ))}
          </div>
        )}
        {runtime.nextCursor !== null && (
          <button
            className="training-hub-load-more"
            type="button"
            disabled={busy}
            onClick={runtime.actions.loadNext}
          >
            加载下一页
          </button>
        )}
        <TrainingRunCreatePanel runtime={runtime} />
      </section>
    </main>
  );
}
