import { useState } from "react";
import type { TrainingRunDraft } from "../trainingHubModel.js";
import {
  formatUtcReplayStartInput,
  parseUtcReplayStartInput,
} from "../trainingHubModel.js";
import {
  REPLAY_POLICY_MUTATIONS,
  type ReplayPolicyMutation,
} from "../replayIntegrityModel.js";
import type {
  ReplayV2RunState,
  ReplayV2SourceKind,
  TrainingRunCard,
  TrainingRunCompatibility,
} from "../replayV2Types.js";
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

function trainingRunStatusMessage(card: TrainingRunCard): string {
  if (card.state !== "ENDED") return card.status.message;
  return card.resume_action === "UNAVAILABLE"
    ? "训练已结束；当前存档无法打开复盘。"
    : "训练已结束，可打开复盘。";
}

function trainingRunPrimaryActionLabel(card: TrainingRunCard): string {
  if (card.state === "AWAITING_MARKET") return "选择商品";
  return card.state === "ENDED" ? "打开复盘" : "继续训练";
}

export interface TrainingRunDeleteConfirmationProps {
  readonly card: TrainingRunCard;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function TrainingRunDeleteConfirmation({
  card,
  busy,
  onCancel,
  onConfirm,
}: TrainingRunDeleteConfirmationProps) {
  return (
    <div className="replay-modal-backdrop" role="presentation">
      <section
        className="replay-end-dialog training-hub-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="training-hub-delete-title"
        aria-describedby="training-hub-delete-description"
      >
        <h2 id="training-hub-delete-title">永久删除训练存档</h2>
        <p id="training-hub-delete-description">
          将删除服务端存档、关联训练会话和本机工作区偏好，删除后无法恢复。
        </p>
        <strong>{card.name}</strong>
        <div className="replay-dialog-actions">
          <button type="button" autoFocus onClick={onCancel}>取消</button>
          <button type="button" disabled={busy} onClick={onConfirm}>
            确认永久删除
          </button>
        </div>
      </section>
    </div>
  );
}

function TrainingRunCreatePanel({ runtime }: TrainingHubDialogProps) {
  const { draft, evaluation } = runtime;
  if (!runtime.createOpen) return null;
  if (draft === null || evaluation === null) {
    return (
      <section className="training-hub-create" aria-label="新建训练配置">
        <div className="replay-loading-spinner" />
        <p>正在读取创建 Run 所需的服务端能力…</p>
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
          <span className="training-hub-kicker">CREATE RUN · SELECT MARKET LATER</span>
          <h2>新建训练</h2>
          <p>先创建模拟账户并永久冻结开局时间；进入 Run 后再选择支持该时间的商品。</p>
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
              AGG_TRADE · 成交归档已校验，K 线近似聚合
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
              randomRangeStartMs: event.target.value === "MANUAL" ? null : draft.randomRangeStartMs,
              randomRangeEndMs: event.target.value === "MANUAL" ? null : draft.randomRangeEndMs,
            })}
          >
            <option value="RANDOM">给定区间内随机</option>
            <option value="MANUAL">手动选择 UTC 时间</option>
          </select>
        </label>
        {draft.startMode === "MANUAL" && (
          <>
            <label>
              开始时间（UTC）
              <input
                type="datetime-local"
                step={60}
                value={formatUtcReplayStartInput(draft.requestedStartMs)}
                onChange={(event) => patchDraft(runtime, {
                  requestedStartMs: parseUtcReplayStartInput(event.target.value),
                })}
              />
            </label>
            <p className="training-hub-field-warning" role="note">
              手动起点属于已知时间；即使隐藏显示，也不会获得严格 Challenge 结果标签。
            </p>
          </>
        )}
        {draft.startMode === "RANDOM" && (
          <>
            <label>
              随机区间开始（UTC）
              <input
                type="datetime-local"
                step={60}
                value={formatUtcReplayStartInput(draft.randomRangeStartMs)}
                onChange={(event) => patchDraft(runtime, {
                  randomRangeStartMs: parseUtcReplayStartInput(event.target.value),
                })}
              />
            </label>
            <label>
              随机区间结束（UTC）
              <input
                type="datetime-local"
                step={60}
                value={formatUtcReplayStartInput(draft.randomRangeEndMs)}
                onChange={(event) => patchDraft(runtime, {
                  randomRangeEndMs: parseUtcReplayStartInput(event.target.value),
                })}
              />
            </label>
          </>
        )}
        <p className="training-hub-field-note" role="note">
          创建确认后 T0 永久不变。商品只做兼容性判断；不支持时需另开一局，系统不会改时间或重抽。
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
                      * 60
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
              min={60_000}
              step={60_000}
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
              disabled={draft.accountDataMode !== "HISTORICAL_EXACT"}
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
            <option value="BOOK_ASSISTED_REQUIRED">
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
      <div className="training-hub-capability-boundary" aria-label="选品与数据边界">
        <h3>商品在 Run 内选择</h3>
        <p>创建时不固定商品、交易所、市场类型、基础周期或数据集，但会提交不可变 T0。进入空 Run 后搜索商品，服务端只校验它是否支持这个时间，再原子创建首条 MarketTrack。</p>
        <p>历史 L2、精确账户历史与 funding 仍 fail closed：它们会在选中具体商品后绑定对应 archive ref，校验失败时 Run 保持空局。</p>
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
        {busy ? busyLabel : "确认时间并创建 Run"}
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
  const [deleteCandidate, setDeleteCandidate] = useState<TrainingRunCard | null>(
    null,
  );
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
              {(["AWAITING_MARKET", "PAUSED", "PLAYING", "ADVANCING", "ENDED", "ERROR"] as const).map((state) => (
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
            可用性
            <select
              value={runtime.filters.compatibility ?? ""}
              onChange={(event) => runtime.actions.setFilters({
                ...runtime.filters,
                compatibility: event.target.value === ""
                  ? null
                  : event.target.value as TrainingRunCompatibility,
              })}
            >
              <option value="">全部可用性</option>
              <option value="READY">READY</option>
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
              <article className="training-hub-card" key={card.run_id}>
                <header>
                  <div>
                    <span>TRAINING RUN</span>
                    <h2>{card.name}</h2>
                  </div>
                  <strong data-run-state={card.state}>{card.state}</strong>
                </header>
                <dl>
                  <div><dt>当前商品</dt><dd>{card.last_symbol ?? "未选择"}</dd></div>
                  <div><dt>历史源</dt><dd>{card.source_kind}</dd></div>
                  <div><dt>进度</dt><dd>#{card.progress.source_sequence}</dd></div>
                  <div>
                    <dt>权益</dt>
                    <dd>{card.equity_status === "CURRENT" ? `${card.equity} ${card.settlement_asset}` : card.equity_status}</dd>
                  </div>
                  <div><dt>时间披露</dt><dd>{card.time_disclosure_policy}</dd></div>
                  <div><dt>可用性</dt><dd>{card.compatibility}</dd></div>
                </dl>
                <p>{trainingRunStatusMessage(card)}</p>
                <footer>
                  <button
                    type="button"
                    disabled={busy || card.resume_action === "UNAVAILABLE"}
                    onClick={() => runtime.actions.continueRun(card)}
                  >
                    {trainingRunPrimaryActionLabel(card)}
                  </button>
                  <button
                    className="training-hub-delete-action"
                    type="button"
                    disabled={busy}
                    onClick={() => setDeleteCandidate(card)}
                  >
                    删除存档
                  </button>
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
      {deleteCandidate !== null && (
        <TrainingRunDeleteConfirmation
          card={deleteCandidate}
          busy={busy}
          onCancel={() => setDeleteCandidate(null)}
          onConfirm={() => {
            const runId = deleteCandidate.run_id;
            setDeleteCandidate(null);
            void runtime.actions.deleteRun(runId);
          }}
        />
      )}
    </main>
  );
}
