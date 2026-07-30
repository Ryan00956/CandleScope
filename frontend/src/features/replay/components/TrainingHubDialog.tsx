import type { ReplayCatalogEntry } from "../replayTypes.js";
import type { TrainingRunDraft } from "../trainingHubModel.js";
import {
  formatUtcReplayStartInput,
  parseUtcReplayStartInput,
  replayStartWindow,
} from "../trainingHubModel.js";
import {
  REPLAY_POLICY_MUTATIONS,
  type ReplayPolicyMutation,
} from "../replayIntegrityModel.js";
import type {
  ReplayV2RunState,
  ReplayV2SourceKind,
  TrainingRunCompatibility,
} from "../replayV2Types.js";
import { replayCatalogIdentity } from "../replayUiModel.js";
import type { TrainingHubRuntime } from "../useTrainingHub.js";
import ReplayStorageGovernancePanel from "./ReplayStorageGovernancePanel.js";

export interface TrainingHubDialogProps {
  readonly runtime: TrainingHubRuntime;
  readonly presentation?: "page" | "modal";
  readonly onRequestClose?: () => void;
  readonly launchLabel?: string;
}

function patchDraft(
  runtime: TrainingHubRuntime,
  patch: Partial<TrainingRunDraft>,
): void {
  if (runtime.draft === null) return;
  runtime.actions.setDraft({ ...runtime.draft, ...patch });
}

function chooseCatalogEntry(runtime: TrainingHubRuntime, identity: string): void {
  const entry = runtime.catalog?.entries.find(
    (candidate) => replayCatalogIdentity(candidate) === identity,
  );
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
    <option value={replayCatalogIdentity(entry)}>
      {entry.identity.exchange} · {entry.identity.market_type} · {entry.identity.symbol}
    </option>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
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
  const busy = runtime.operation === "create"
    || runtime.operation === "plan"
    || runtime.operation === "create-context";
  const busyLabel = runtime.operation === "create"
    ? "正在原子创建…"
    : runtime.operation === "create-context"
      ? "正在校验时间目录…"
      : "正在校验数据…";
  const historicalBook = runtime.segmentPlan?.historical_book ?? null;
  const historicalBookExact = historicalBook?.capability_state === "AVAILABLE_EXACT";
  const accountHistory = runtime.segmentPlan?.account_history ?? null;
  const accountHistoryExact = accountHistory?.capability_state === "AVAILABLE_EXACT";
  const startWindow = evaluation.selectedEntry === null
    ? null
    : replayStartWindow(evaluation.selectedEntry);
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
            data-training-field="market-identity"
            value={`${draft.exchange}:${draft.marketType}:${draft.symbol}`}
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
            <option value="MANUAL">手动选择 UTC 时间</option>
          </select>
        </label>
        {draft.startMode === "MANUAL" && (
          <>
            <label>
              开始时间（UTC）
              <input
                type="datetime-local"
                min={formatUtcReplayStartInput(startWindow?.earliestEligibleMs ?? null)}
                max={formatUtcReplayStartInput(startWindow?.latestEligibleMs ?? null)}
                step={startWindow?.stepSeconds ?? 60}
                value={formatUtcReplayStartInput(draft.requestedStartMs)}
                onChange={(event) => patchDraft(runtime, {
                  requestedStartMs: parseUtcReplayStartInput(event.target.value),
                })}
              />
            </label>
            <button
              type="button"
              disabled={startWindow?.earliestEligibleMs == null}
              onClick={() => patchDraft(runtime, {
                requestedStartMs: startWindow?.earliestEligibleMs ?? null,
              })}
            >
              使用最早合格起点
            </button>
            <p className="training-hub-field-warning" role="note">
              手动起点属于已知时间；即使隐藏显示，也不会获得严格 Challenge 结果标签。
            </p>
          </>
        )}
        <p className="training-hub-field-note" role="note">
          {startWindow?.eligibleWindowCount ?? 0} 个合格随机窗口
          {startWindow?.earliestHistoryMs == null
            ? "；盲化目录不会披露历史边界"
            : `；历史最早 ${formatUtcReplayStartInput(startWindow.earliestHistoryMs)} UTC`}
        </p>
        <label>
          完整性模式
          <select
            value={draft.integrityMode}
            onChange={(event) => {
              const integrityMode = event.target.value as TrainingRunDraft["integrityMode"];
              patchDraft(runtime, {
                integrityMode,
                fundingMode: integrityMode === "SANDBOX" || draft.fundingMode !== "SANDBOX_FIXED"
                  ? draft.fundingMode
                  : "OFF",
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
          指标预热 BAR
          <input
            type="number"
            min={1}
            value={draft.indicatorWarmupBars}
            onChange={(event) => patchDraft(runtime, {
              indicatorWarmupBars: Number(event.target.value),
            })}
          />
          <small>只保证指标计算所需数据，不决定图表可向前滚动多远。</small>
        </label>
        <label>
          可见历史
          <select
            value={draft.visibleHistoryMode}
            onChange={(event) => {
              const mode = event.target.value as TrainingRunDraft["visibleHistoryMode"];
              patchDraft(runtime, {
                visibleHistoryMode: mode,
                visibleHistoryLookbackMs: mode === "ALL_AVAILABLE"
                  ? null
                  : draft.visibleHistoryLookbackMs
                    ?? draft.indicatorWarmupBars
                      * (startWindow?.stepSeconds ?? 60)
                      * 1_000,
              });
            }}
          >
            <option value="ALL_AVAILABLE">全部可用（默认，按需加载）</option>
            <option value="DURATION">固定时长（兼容旧 Run）</option>
          </select>
        </label>
        {draft.visibleHistoryMode === "ALL_AVAILABLE" && (
          <p className="training-hub-field-note">
            像实时行情一样向左按需分页，直到所选连续数据段的最早一根；不会把全部历史塞进执行快照。
          </p>
        )}
        {draft.visibleHistoryMode === "DURATION" && (
          <label>
            可见历史时长（ms）
            <input
              type="number"
              min={(startWindow?.stepSeconds ?? 60) * 1_000}
              step={(startWindow?.stepSeconds ?? 60) * 1_000}
              value={draft.visibleHistoryLookbackMs ?? ""}
              onChange={(event) => patchDraft(runtime, {
                visibleHistoryLookbackMs: Number(event.target.value),
              })}
            />
            <small>必须是基础周期的整数倍；该模式会把左侧边界固定在 Run 中。</small>
          </label>
        )}
        <label>
          前向缓存（ms）
          <input
            data-training-field="forward-cache-ms"
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
          保证金模式
          <select
            value={draft.marginMode}
            onChange={(event) => patchDraft(runtime, {
              marginMode: event.target.value as TrainingRunDraft["marginMode"],
            })}
          >
            <option value="CROSS">CROSS · 共享结算权益</option>
            <option value="ISOLATED">ISOLATED · 按轨道显式分配</option>
          </select>
        </label>
        <label>
          账户数据
          <select
            value={draft.accountDataMode}
            onChange={(event) => {
              const accountDataMode = event.target.value as TrainingRunDraft["accountDataMode"];
              patchDraft(runtime, {
                accountDataMode,
                fundingMode: accountDataMode === "HISTORICAL_EXACT"
                  ? draft.fundingMode === "SANDBOX_FIXED" ? "OFF" : draft.fundingMode
                  : draft.fundingMode === "HISTORICAL_EXACT" ? "OFF" : draft.fundingMode,
              });
            }}
          >
            <option value="APPROX_PROXY">APPROX_PROXY · 已揭示价格代理模拟账户</option>
            <option value="HISTORICAL_EXACT">HISTORICAL_EXACT · 固定历史 mark/index/规则</option>
          </select>
          <small>Exact 必须手动起点，并由服务端返回不可变 archive ref；不会接受公开 K 线代理。</small>
        </label>
        <label>
          资金费模式
          <select
            value={draft.fundingMode}
            onChange={(event) => patchDraft(runtime, {
              fundingMode: event.target.value as TrainingRunDraft["fundingMode"],
            })}
          >
            <option value="OFF">OFF</option>
            <option value="SANDBOX_FIXED" disabled={draft.integrityMode !== "SANDBOX"}>
              SANDBOX_FIXED · 近似练习
            </option>
            <option
              value="HISTORICAL_EXACT"
              disabled={draft.accountDataMode !== "HISTORICAL_EXACT"
                || !accountHistoryExact
                || !accountHistory?.historical_funding_exact}
            >
              HISTORICAL_EXACT · 归档结算
            </option>
          </select>
        </label>
        <label>
          历史盘口
          <select
            value={draft.bookMode}
            onChange={(event) => patchDraft(runtime, {
              bookMode: event.target.value as TrainingRunDraft["bookMode"],
            })}
          >
            <option value="OFF">OFF · Touch/Tape</option>
            <option value="BOOK_ASSISTED_REQUIRED" disabled={!historicalBookExact}>
              BOOK_ASSISTED_REQUIRED · 连续历史 L2
            </option>
          </select>
          <small>只有服务端证明 snapshot + ordered deltas 连续且可 pin 时可选；始终不声明 queue-exact。</small>
        </label>
        {draft.fundingMode === "SANDBOX_FIXED" && (
          <>
            <label>
              固定资金费率
              <input
                inputMode="decimal"
                value={draft.fixedFundingRate}
                onChange={(event) => patchDraft(runtime, {
                  fixedFundingRate: event.target.value,
                })}
              />
            </label>
            <label>
              结算间隔（ms）
              <input
                type="number"
                min={60_000}
                max={30 * 86_400_000}
                value={draft.fundingIntervalMs}
                onChange={(event) => patchDraft(runtime, {
                  fundingIntervalMs: Number(event.target.value),
                })}
              />
            </label>
          </>
        )}
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
        <p>入金、出金、费率、杠杆上限、Sandbox 固定资金费与不可逆时间揭示均写入审计事件；Challenge 仍全部锁定。</p>
      </fieldset>
      <div className="training-hub-capability-boundary" aria-label="Phase 14 数据与能力边界">
        <h3>Phase 14 按需数据策略</h3>
        {runtime.segmentPlan === null ? (
          <p>参数变更后会在提交前重新生成服务端 prepare plan；选择商品本身不会加载历史。</p>
        ) : (
          <ul>
            <li><strong>动作</strong> — {runtime.segmentPlan.prepare_action}</li>
            <li><strong>预计范围</strong> — {runtime.segmentPlan.estimated_rows} rows · {formatBytes(runtime.segmentPlan.estimated_size_bytes)}</li>
            <li>
              <strong>指标预热</strong> — {runtime.segmentPlan.history_policy.indicator_warmup_bars} rows
            </li>
            <li>
              <strong>可见历史</strong> — {runtime.segmentPlan.history_policy.visible_history_lookback.mode}
              {runtime.segmentPlan.history_policy.visible_history_lookback.duration_ms === null
                ? " · 按需分页至选中连续数据段起点"
                : ` · ${runtime.segmentPlan.history_policy.visible_history_lookback.duration_ms} ms · ${runtime.segmentPlan.history_policy.visible_history_rows_estimate ?? "未对齐"} rows`}
            </li>
            <li>
              <strong>执行快照预热估算</strong> — {runtime.segmentPlan.history_policy.effective_warmup_bars_estimate} rows；
              前向 {runtime.segmentPlan.history_policy.forward_rows_estimate} rows
            </li>
            <li>
              <strong>执行快照预算</strong> — {runtime.segmentPlan.history_policy.accepted
                ? `预校验通过（上限 ${runtime.segmentPlan.history_policy.max_dataset_rows} rows；左侧分页不计入）`
                : `拒绝：${runtime.segmentPlan.history_policy.blocked_reason ?? "UNKNOWN"}`}
            </li>
            <li><strong>本地同源 READY 库存</strong> — {runtime.segmentPlan.existing_ready_segments} segments · {formatBytes(runtime.segmentPlan.existing_ready_bytes)}（创建时再核对范围）</li>
            <li><strong>失败策略</strong> — 校验失败 quarantine，禁止 Run 引用</li>
            <li><strong>后台下载</strong> — {runtime.segmentPlan.download_worker_enabled ? "显式启用" : "默认关闭"}</li>
            <li><strong>自动 GC</strong> — {runtime.segmentPlan.auto_gc_enabled ? "显式启用" : "默认关闭"}</li>
          </ul>
        )}
        <h3>Phase 9 历史 L2</h3>
        <button
          type="button"
          disabled={busy}
          onClick={() => void runtime.actions.refreshCreatePlan()}
        >
          {runtime.operation === "plan" ? "正在校验…" : "按当前参数校验盘口能力"}
        </button>
        {historicalBook === null ? (
          <p>尚无当前参数的服务端校验结果；BOOK_ASSISTED 保持 fail closed。</p>
        ) : (
          <ul data-historical-book-capability={historicalBook.capability_state}>
            <li><strong>能力</strong> — {historicalBook.capability_state} · {historicalBook.reason}</li>
            <li><strong>来源</strong> — Binance USD-M snapshot + ordered diff-depth</li>
            <li><strong>连续性</strong> — {historicalBook.continuity_contract}</li>
            <li><strong>可固定</strong> — {historicalBook.pinnable ? "是" : "否"}</li>
            <li><strong>本地 READY</strong> — {formatBytes(historicalBook.ready_archive_bytes)}</li>
            <li><strong>执行 fidelity</strong> — {historicalBook.execution_fidelity}</li>
            <li><strong>Queue exact</strong> — 否</li>
          </ul>
        )}
        <h3>Phase 16 精确账户历史</h3>
        {accountHistory === null ? (
          <p>尚无当前参数的服务端校验结果；HISTORICAL_EXACT 保持 fail closed。</p>
        ) : (
          <ul data-account-history-capability={accountHistory.capability_state}>
            <li><strong>能力</strong> — {accountHistory.capability_state} · {accountHistory.reason}</li>
            <li><strong>模型</strong> — {accountHistory.supported_contract_model} · {accountHistory.supported_position_mode} · {accountHistory.supported_margin_asset_mode}</li>
            <li><strong>Mark / index / 规则</strong> — {accountHistoryExact ? "固定归档 exact" : "不可用"}</li>
            <li><strong>Funding</strong> — {accountHistory.historical_funding_exact ? "完整历史结算可用" : "无完整 exact 结算"}</li>
            <li><strong>公开 K 线代理</strong> — {accountHistory.public_kline_proxy_accepted ? "接受" : "拒绝"}</li>
            <li><strong>本地 READY</strong> — {formatBytes(accountHistory.ready_archive_bytes)} / {formatBytes(accountHistory.max_archive_bytes)}</li>
            <li><strong>Archive ref</strong> — <code>{accountHistory.account_history_ref?.archive_id ?? "none"}</code></li>
          </ul>
        )}
        <h3>Phase 6 合约账户基础</h3>
        <p>Run 仍固定使用 TOUCH_OR_TAPE_V2；BOOK_ASSISTED 只增加连续 L2 能力门禁与报告区分，当前已揭示参考价立即 taker，后续触价挂单 maker，并持续标注“不含盘口排队”。</p>
        <h3>能力与 fidelity 边界</h3>
        <ul>
          <li><strong>账户历史</strong> — {evaluation.unsupported.account_history}</li>
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
        {busy ? busyLabel : "创建并进入训练"}
      </button>
    </section>
  );
}

export default function TrainingHubDialog({
  runtime,
  presentation = "page",
  onRequestClose,
  launchLabel,
}: TrainingHubDialogProps) {
  const busy = runtime.operation !== null;
  const modal = presentation === "modal";
  return (
    <main
      className={`training-hub-page ${modal ? "training-hub-modal-surface" : ""}`}
      role="dialog"
      aria-modal={modal}
      aria-labelledby="training-hub-title"
      data-training-hub-phase={runtime.phase}
      data-training-hub-presentation={presentation}
    >
      <section className="training-hub-shell">
        <header className="training-hub-heading">
          <div>
            <span className="training-hub-kicker">SERVER-AUTHORITATIVE ARCHIVE WORKBENCH</span>
            <h1 id="training-hub-title">训练存档大厅</h1>
            <p>
              {launchLabel ?? "这里只读取轻量存档摘要；历史数据集在进入具体训练前不会加载。"}
            </p>
          </div>
          <div className="training-hub-heading-actions">
            <button type="button" onClick={runtime.actions.refresh} disabled={busy}>刷新</button>
            <button type="button" onClick={() => void runtime.actions.openCreate()} disabled={busy}>
              新建训练
            </button>
            <button type="button" onClick={() => void runtime.actions.openStorage()} disabled={busy}>
              存储管理
            </button>
            {modal ? (
              <button type="button" onClick={onRequestClose}>关闭</button>
            ) : (
              <a href="/" target="_blank" rel="noopener noreferrer">实时行情 ↗</a>
            )}
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
        <ReplayStorageGovernancePanel runtime={runtime} />
      </section>
    </main>
  );
}
