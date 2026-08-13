import { useEffect, useState } from "react";
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
  ReplayV2SourceKind,
  TrainingRunCard,
  TrainingRunCompatibility,
} from "../replayV2Types.js";
import type { TrainingHubRuntime } from "../useTrainingHub.js";
import {
  formatTrainingEquity,
  trainingCompatibilityLabel,
  trainingIntegrityLabel,
  trainingRunStateLabel,
  trainingSourceKindLabel,
  trainingTimeDisclosureLabel,
} from "../trainingHubLabels.js";
import ReplayStorageGovernancePanel from "./ReplayStorageGovernancePanel.js";

const CREATE_SECTIONS = [
  ["training-hub-create-start", "1", "起点与历史源"],
  ["training-hub-create-rules", "2", "规则与账户"],
  ["training-hub-create-advanced", "3", "高级设置"],
] as const;

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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<string>("training-hub-create-start");
  useEffect(() => {
    if (!runtime.createOpen || draft === null || evaluation === null) return undefined;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      if (visible?.target.id) setActiveSection(visible.target.id);
    }, { rootMargin: "-20% 0px -60% 0px", threshold: [0.15, 0.4, 0.7] });
    for (const [id] of CREATE_SECTIONS) {
      const node = document.getElementById(id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [draft, evaluation, runtime.createOpen]);
  if (!runtime.createOpen) return null;
  if (draft === null || evaluation === null) {
    return (
      <div className="training-hub-create-overlay" role="presentation">
        <section
          className="training-hub-create training-hub-create-loading"
          role="dialog"
          aria-modal="true"
          aria-label="新建训练配置"
        >
          <div className="replay-loading-spinner" />
          <p>正在读取创建 Run 所需的服务端能力…</p>
          <button type="button" onClick={runtime.actions.closeCreate}>取消</button>
        </section>
      </div>
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
  const scrollToSection = (sectionId: string) => {
    if (sectionId === "training-hub-create-advanced") setAdvancedOpen(true);
    setActiveSection(sectionId);
    requestAnimationFrame(() => {
      document.getElementById(sectionId)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  };
  return (
    <div className="training-hub-create-overlay" role="presentation">
      <section
        className="training-hub-create"
        role="dialog"
        aria-modal="true"
        aria-labelledby="training-hub-create-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) runtime.actions.closeCreate();
        }}
      >
        <header className="training-hub-create-top">
          <div>
            <span className="training-hub-kicker">先冻结时间 · 再选商品</span>
            <h2 id="training-hub-create-title">新建训练</h2>
            <p>先创建模拟账户并永久冻结开局时间；进入 Run 后再选择支持该时间的商品。</p>
            <nav className="training-hub-create-steps" aria-label="配置分区">
              {CREATE_SECTIONS.map(([id, number, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-current={activeSection === id}
                  onClick={() => scrollToSection(id)}
                >
                  <em>{number}</em>{label}
                </button>
              ))}
            </nav>
          </div>
          <button type="button" autoFocus onClick={runtime.actions.closeCreate} disabled={busy}>关闭</button>
        </header>

        <div className="training-hub-create-body">
          <div className="training-hub-create-main">
            <section className="training-hub-form-section" id="training-hub-create-start">
              <header>
                <div><h3>起点与历史源</h3><p>创建时只冻结账户、规则和 T0；商品仍在 Run 内选择。</p></div>
                <span>01</span>
              </header>
              <div className="training-hub-section-body">
                <label className="training-hub-field training-hub-field-wide">
                  <span>存档名称</span>
                  <input
                    value={draft.name}
                    maxLength={80}
                    onChange={(event) => patchDraft(runtime, { name: event.target.value })}
                  />
                </label>
                <div className="training-hub-field">
                  <span>历史源</span>
                  <div className="training-hub-choice-grid" role="group" aria-label="历史源">
                    <button
                      type="button"
                      aria-pressed={draft.sourceKind === "BAR"}
                      disabled={busy}
                      onClick={() => patchDraft(runtime, {
                        sourceKind: "BAR",
                        requestedStartMs: null,
                        randomRangeStartMs: null,
                        randomRangeEndMs: null,
                      })}
                    >
                      <small>BAR</small><strong>K 线</strong><span>精确 OHLCV，适合大多数节奏训练。</span>
                    </button>
                    <button
                      type="button"
                      aria-pressed={draft.sourceKind === "AGG_TRADE"}
                      disabled={busy || !runtime.capabilities?.sources.agg_trade.enabled}
                      onClick={() => patchDraft(runtime, {
                        sourceKind: "AGG_TRADE",
                        requestedStartMs: null,
                        randomRangeStartMs: null,
                        randomRangeEndMs: null,
                      })}
                    >
                      <small>AGG_TRADE</small><strong>成交</strong><span>选择时下载并校验官方成交归档。</span>
                    </button>
                  </div>
                </div>
                <div className="training-hub-field">
                  <span>开始方式</span>
                  <div className="training-hub-choice-grid" role="group" aria-label="开始方式">
                    <button
                      type="button"
                      aria-pressed={draft.startMode === "RANDOM"}
                      disabled={busy}
                      onClick={() => patchDraft(runtime, {
                        startMode: "RANDOM",
                        requestedStartMs: null,
                      })}
                    >
                      <small>RANDOM</small><strong>随机合格窗口</strong><span>盲化抽取，严格挑战模式的推荐默认。</span>
                    </button>
                    <button
                      type="button"
                      aria-pressed={draft.startMode === "MANUAL"}
                      disabled={busy}
                      onClick={() => patchDraft(runtime, {
                        startMode: "MANUAL",
                        randomRangeStartMs: null,
                        randomRangeEndMs: null,
                      })}
                    >
                      <small>MANUAL</small><strong>手动 UTC 时间</strong><span>已知起点，不获得严格挑战标签。</span>
                    </button>
                  </div>
                </div>
                <div className="training-hub-field-grid">
                  {draft.startMode === "MANUAL" ? (
                    <>
                      <label className="training-hub-field">
                        <span>开始时间（UTC）</span>
                        <input
                          data-training-field="requested-start-utc"
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
                  ) : (
                    <>
                      <label className="training-hub-field">
                        <span>随机区间开始（UTC）</span>
                        <input
                          type="datetime-local"
                          step={60}
                          value={formatUtcReplayStartInput(draft.randomRangeStartMs)}
                          onChange={(event) => patchDraft(runtime, {
                            randomRangeStartMs: parseUtcReplayStartInput(event.target.value),
                          })}
                        />
                      </label>
                      <label className="training-hub-field">
                        <span>随机区间结束（UTC）</span>
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
                </div>
                <p className="training-hub-field-note" role="note">
                  创建确认后 T0 永久不变。商品只做兼容性判断；不支持时需另开一局，系统不会改时间或重抽。
                </p>
                {runtime.catalog !== null && (
                  <p className="training-hub-field-note training-hub-field-note-ok" role="status">
                    当前历史源可选商品 {runtime.catalog.entries.length} 个；时间输入已按其覆盖范围校验。
                  </p>
                )}
              </div>
            </section>

            <section className="training-hub-form-section" id="training-hub-create-rules">
              <header>
                <div><h3>规则与账户</h3><p>完整性模式决定可变范围；资金和持仓模式创建后不可改。</p></div>
                <span>02</span>
              </header>
              <div className="training-hub-section-body">
                <div className="training-hub-field">
                  <span>完整性模式</span>
                  <div className="training-hub-choice-grid training-hub-choice-grid-three" role="group" aria-label="完整性模式">
                    {([
                      ["CHALLENGE", "挑战", "全部规则锁定，最严格训练标签。"],
                      ["PRACTICE", "练习", "显式白名单内的变更可审计。"],
                      ["SANDBOX", "沙盒", "全部变更可审计，适合实验。"],
                    ] as const).map(([integrityMode, label, description]) => (
                      <button
                        key={integrityMode}
                        type="button"
                        aria-pressed={draft.integrityMode === integrityMode}
                        disabled={busy}
                        onClick={() => patchDraft(runtime, {
                          integrityMode,
                          fundingMode: integrityMode === "SANDBOX" || draft.fundingMode !== "SANDBOX_FIXED"
                            ? draft.fundingMode
                            : "OFF",
                          allowedMutations: integrityMode === "CHALLENGE"
                            ? []
                            : integrityMode === "SANDBOX"
                              ? REPLAY_POLICY_MUTATIONS
                              : ["deposit", "withdraw"],
                        })}
                      >
                        <small>{integrityMode}</small><strong>{label}</strong><span>{description}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <label className="training-hub-field training-hub-field-half">
                  <span>时间披露</span>
                  <select
                    data-training-field="time-disclosure-policy"
                    value={draft.timeDisclosurePolicy}
                    onChange={(event) => patchDraft(runtime, {
                      timeDisclosurePolicy: event.target.value as TrainingRunDraft["timeDisclosurePolicy"],
                    })}
                  >
                    <option value="NONE">显示历史时间（NONE）</option>
                    <option value="HIDE_YEAR">隐藏年份（HIDE_YEAR）</option>
                    <option value="HIDE_MONTH">隐藏年月（HIDE_MONTH）</option>
                    <option value="HIDE_DAY">相对日期（HIDE_DAY）</option>
                    <option value="HIDE_HOUR">相对小时（HIDE_HOUR）</option>
                    <option value="HIDE_MINUTE">相对分钟（HIDE_MINUTE）</option>
                    <option value="HIDE_ALL">完全相对时间（HIDE_ALL）</option>
                  </select>
                </label>
                <fieldset className="training-hub-mutation-policy" disabled={draft.integrityMode !== "PRACTICE" || busy}>
                  <legend>Practice 可审计变更白名单</legend>
                  <div>
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
                  </div>
                  <p>入金、出金、费率、杠杆上限、Sandbox 固定资金费与不可逆时间揭示均写入审计事件；Challenge 仍全部锁定。</p>
                </fieldset>
                <div className="training-hub-field-grid training-hub-field-grid-three">
                  <label className="training-hub-field">
                    <span>初始权益</span>
                    <input inputMode="decimal" value={draft.initialEquity} onChange={(event) => patchDraft(runtime, { initialEquity: event.target.value })} />
                  </label>
                  <label className="training-hub-field">
                    <span>最大杠杆</span>
                    <input inputMode="decimal" value={draft.maxLeverage} onChange={(event) => patchDraft(runtime, { maxLeverage: event.target.value })} />
                  </label>
                  <label className="training-hub-field">
                    <span>保证金模式</span>
                    <select value={draft.marginMode} onChange={(event) => patchDraft(runtime, { marginMode: event.target.value as TrainingRunDraft["marginMode"] })}>
                      <option value="CROSS">全仓 · 共享结算权益</option>
                      <option value="ISOLATED">逐仓 · 按腿显式分配</option>
                    </select>
                  </label>
                </div>
                <label className="training-hub-field">
                  <span>持仓模式</span>
                  <select
                    value={draft.positionMode}
                    onChange={(event) => {
                      const positionMode = event.target.value as TrainingRunDraft["positionMode"];
                      patchDraft(runtime, {
                        positionMode,
                        ...(positionMode === "HEDGE" ? {
                          accountDataMode: "DETERMINISTIC_SIMULATION",
                          fundingMode: "OFF",
                        } : draft.accountDataMode === "DETERMINISTIC_SIMULATION" ? {
                          accountDataMode: "APPROX_PROXY",
                          fundingMode: draft.fundingMode === "HISTORICAL_EXACT" ? "OFF" : draft.fundingMode,
                        } : {}),
                      });
                    }}
                  >
                    <option value="ONE_WAY">单向净持仓（ONE_WAY）</option>
                    <option value="HEDGE">多空双向持仓（HEDGE）</option>
                  </select>
                  <small>显式选择双向模式后，多空腿独立计算保证金、强平与保护单。完整历史输入优先；缺少可近似项时自动使用清楚标记的 HEDGE_HYBRID，不会改成单向。</small>
                </label>
                <div className="training-hub-capability-boundary" aria-label="选品与数据边界">
                  <h3>商品在 Run 内选择</h3>
                  <p>创建时不固定商品、交易所、市场类型、基础周期或数据集，但会提交不可变 T0。进入空 Run 后搜索商品，服务端只校验它是否支持这个时间，再原子创建首条 MarketTrack。</p>
                  <p>HEDGE 会优先绑定完整历史输入；缺失 mark/rule/fee/funding 时可生成版本化混合输入并逐项降级披露。只有明确选择盘口辅助模式时，连续历史 L2 仍是硬门槛。</p>
                </div>
              </div>
            </section>

            <details
              className="training-hub-advanced"
              id="training-hub-create-advanced"
              open={advancedOpen}
              onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
            >
              <summary>高级设置 · 历史窗口、账户数据与执行细节</summary>
            <section className="training-hub-form-section" id="training-hub-create-history">
              <header>
                <div><h3>历史窗口</h3><p>控制指标预热、左侧可见历史和前向缓存，不扩大执行快照。</p></div>
                <span>03</span>
              </header>
              <div className="training-hub-section-body">
                <div className="training-hub-field-grid training-hub-field-grid-three">
                  <label className="training-hub-field">
                    <span>指标预热 BAR</span>
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
                  <label className="training-hub-field">
                    <span>前向缓存（ms）</span>
                    <input
                      data-training-field="forward-cache-ms"
                      type="number"
                      min={1}
                      value={draft.forwardCacheMs}
                      onChange={(event) => patchDraft(runtime, { forwardCacheMs: Number(event.target.value) })}
                    />
                  </label>
                  <label className="training-hub-field">
                    <span>可见历史</span>
                    <select
                      value={draft.visibleHistoryMode}
                      onChange={(event) => {
                        const mode = event.target.value as TrainingRunDraft["visibleHistoryMode"];
                        patchDraft(runtime, {
                          visibleHistoryMode: mode,
                          visibleHistoryLookbackMs: mode === "ALL_AVAILABLE"
                            ? null
                            : draft.visibleHistoryLookbackMs ?? draft.indicatorWarmupBars * 60 * 1_000,
                        });
                      }}
                    >
                      <option value="ALL_AVAILABLE">全部可用（默认，按需加载）</option>
                      <option value="DURATION">固定时长（兼容旧 Run）</option>
                    </select>
                  </label>
                </div>
                {draft.visibleHistoryMode === "ALL_AVAILABLE" ? (
                  <p className="training-hub-field-note">
                    像实时行情一样向左按需分页，直到所选连续数据段的最早一根；不会把全部历史塞进执行快照。
                  </p>
                ) : (
                  <label className="training-hub-field training-hub-field-half">
                    <span>可见历史时长（ms）</span>
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
              </div>
            </section>

            <section className="training-hub-form-section" id="training-hub-create-account">
              <header>
                <div><h3>账户数据与执行</h3><p>费率和 fidelity 边界；Exact 能力继续 fail-closed。</p></div>
                <span>04</span>
              </header>
              <div className="training-hub-section-body">
                <div className="training-hub-field-grid">
                  <label className="training-hub-field">
                    <span>账户数据</span>
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
                      {draft.positionMode === "HEDGE" ? (
                        <option value="DETERMINISTIC_SIMULATION">DETERMINISTIC_SIMULATION · 精确或混合公开输入 + 模拟私有状态</option>
                      ) : (
                        <>
                          <option value="APPROX_PROXY">APPROX_PROXY · 已揭示价格代理模拟账户</option>
                          <option value="HISTORICAL_EXACT">HISTORICAL_EXACT · 固定历史 mark/index/规则</option>
                        </>
                      )}
                    </select>
                    <small>HEDGE 唯一账户模型是交易所规则级确定性模拟；不会把不可观测的历史 insurance/ADL 宣称为 exact。</small>
                  </label>
                  <label className="training-hub-field">
                    <span>资金费模式</span>
                    <select value={draft.fundingMode} onChange={(event) => patchDraft(runtime, { fundingMode: event.target.value as TrainingRunDraft["fundingMode"] })}>
                      <option value="OFF">OFF</option>
                      {draft.integrityMode === "SANDBOX" && <option value="SANDBOX_FIXED">SANDBOX_FIXED · 近似练习</option>}
                      {(draft.accountDataMode === "HISTORICAL_EXACT" || draft.accountDataMode === "DETERMINISTIC_SIMULATION") && (
                        <option value="HISTORICAL_EXACT">HISTORICAL_EXACT · pinned 归档结算</option>
                      )}
                    </select>
                  </label>
                  <label className="training-hub-field">
                    <span>历史盘口</span>
                    <select value={draft.bookMode} onChange={(event) => patchDraft(runtime, { bookMode: event.target.value as TrainingRunDraft["bookMode"] })}>
                      <option value="OFF">OFF · Touch/Tape</option>
                      <option value="BOOK_ASSISTED_REQUIRED">BOOK_ASSISTED_REQUIRED · 连续历史 L2</option>
                    </select>
                    <small>盘口 OFF 时使用 Touch/Tape；资金费是否结算由上方资金费模式决定。mark/index 可使用已揭示 BAR/AGG_TRADE 价格代理。L2 只有连续性可证明时可选，且始终不声明 queue-exact。</small>
                  </label>
                  {draft.fundingMode === "SANDBOX_FIXED" && (
                    <>
                      <label className="training-hub-field">
                        <span>固定资金费率</span>
                        <input inputMode="decimal" value={draft.fixedFundingRate} onChange={(event) => patchDraft(runtime, { fixedFundingRate: event.target.value })} />
                      </label>
                      <label className="training-hub-field">
                        <span>结算间隔（ms）</span>
                        <input type="number" min={60_000} max={30 * 86_400_000} value={draft.fundingIntervalMs} onChange={(event) => patchDraft(runtime, { fundingIntervalMs: Number(event.target.value) })} />
                      </label>
                    </>
                  )}
                  <label className="training-hub-field">
                    <span>Maker / Taker bps</span>
                    <span className="training-hub-inline-inputs">
                      <input inputMode="decimal" value={draft.makerFeeBps} aria-label="Maker bps" onChange={(event) => patchDraft(runtime, { makerFeeBps: event.target.value })} />
                      <input inputMode="decimal" value={draft.takerFeeBps} aria-label="Taker bps" onChange={(event) => patchDraft(runtime, { takerFeeBps: event.target.value })} />
                    </span>
                  </label>
                  <label className="training-hub-field">
                    <span>市价滑点 bps</span>
                    <input inputMode="decimal" value={draft.marketSlippageBps} onChange={(event) => patchDraft(runtime, { marketSlippageBps: event.target.value })} />
                  </label>
                </div>
              </div>
            </section>
            </details>
          </div>

          <aside className="training-hub-create-side">
            <div className="training-hub-create-side-scroll">
              <section className="training-hub-summary-card">
                <h3>配置摘要</h3>
                <strong>{draft.name || "未命名训练"}</strong>
                <dl>
                  <div><dt>历史源</dt><dd>{trainingSourceKindLabel(draft.sourceKind)}</dd></div>
                  <div><dt>开始</dt><dd>{draft.startMode === "RANDOM" ? "随机窗口" : "手动时间"}</dd></div>
                  <div><dt>完整性</dt><dd>{trainingIntegrityLabel(draft.integrityMode)}</dd></div>
                  <div><dt>时间披露</dt><dd>{trainingTimeDisclosureLabel(draft.timeDisclosurePolicy)}</dd></div>
                  <div><dt>权益 / 杠杆</dt><dd>{draft.initialEquity} · {draft.maxLeverage}×</dd></div>
                  <div><dt>持仓 / 保证金</dt><dd>{draft.positionMode === "HEDGE" ? "双向" : "单向"} · {draft.marginMode === "ISOLATED" ? "逐仓" : "全仓"}</dd></div>
                  <div><dt>商品</dt><dd>进入 Run 后选择</dd></div>
                </dl>
              </section>
              <section className="training-hub-summary-card">
                <h3>能力与 fidelity 边界</h3>
                <dl>
                  <div><dt>账户历史</dt><dd>{evaluation.unsupported.account_history}</dd></div>
                  <div><dt>资金费</dt><dd>{evaluation.unsupported.funding}</dd></div>
                  <div><dt>历史盘口</dt><dd>{evaluation.unsupported.historical_l2}</dd></div>
                  <div><dt>动态规则</dt><dd>{evaluation.unsupported.rule_changes}</dd></div>
                  <div><dt>逐仓保证金</dt><dd>{evaluation.unsupported.isolated_margin}</dd></div>
                </dl>
              </section>
              {evaluation.errors.length > 0 && (
                <div className="replay-error-summary" role="alert">
                  {evaluation.errors.map((message) => <span key={message}>{message}</span>)}
                </div>
              )}
            </div>
            <div className="training-hub-create-actions">
              <button
                className="replay-primary-action"
                type="button"
                disabled={!evaluation.canSubmit || busy}
                onClick={() => void runtime.actions.createRun(draft)}
              >
                {busy ? busyLabel : "确认时间并创建 Run"}
              </button>
              <button type="button" onClick={runtime.actions.closeCreate} disabled={busy}>取消</button>
              <p>提交后服务端原子创建；历史数据仅在进入具体训练时按需加载。</p>
            </div>
          </aside>
        </div>
      </section>
    </div>
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
  const loadedRunCount = runtime.items.length;
  const resumableRunCount = runtime.items.filter((card) => (
    card.resume_action !== "UNAVAILABLE" && card.state !== "ENDED"
  )).length;
  const activeRunCount = runtime.items.filter((card) => (
    card.state === "PLAYING" || card.state === "ADVANCING"
  )).length;
  const completedRunCount = runtime.items.filter((card) => card.state === "ENDED").length;
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
          <div className="training-hub-brand">
            <div className="training-hub-brand-mark" aria-hidden="true">R2</div>
            <div>
              <span className="training-hub-kicker">K 线回放 · 存档大厅</span>
              <h1 id="training-hub-title">训练存档大厅</h1>
              <p>
                {launchLabel ?? "这里只读取轻量存档摘要；历史数据集在进入具体训练前不会加载。"}
              </p>
            </div>
          </div>
          <div className="training-hub-heading-actions">
            <button type="button" onClick={() => void runtime.actions.openStorage()} disabled={busy}>
              存储管理
            </button>
            {modal ? (
              <button type="button" onClick={onRequestClose}>关闭</button>
            ) : (
              <a href="/" target="_blank" rel="noopener noreferrer">实时行情 ↗</a>
            )}
            <button type="button" onClick={runtime.actions.refresh} disabled={busy}>刷新</button>
            <button className="training-hub-primary-button" type="button" onClick={() => void runtime.actions.openCreate()} disabled={busy}>
              新建训练
            </button>
          </div>
        </header>

        <section className="training-hub-stats" aria-label="存档概览">
          <article data-tone="violet"><span>全部</span><strong>{loadedRunCount}</strong><small>当前列表</small></article>
          <article data-tone="amber"><span>可继续</span><strong>{resumableRunCount}</strong><small>可进入的存档</small></article>
          <article data-tone="green"><span>进行中</span><strong>{activeRunCount}</strong><small>正在播放</small></article>
          <article data-tone="cyan"><span>已结束</span><strong>{completedRunCount}</strong><small>可打开复盘</small></article>
        </section>

        <div className="training-hub-toolbar">
          <div className="training-hub-filters" aria-label="存档筛选">
            <div className="training-hub-filter-chips" role="group" aria-label="快捷状态">
              {([
                [null, "全部"],
                ["AWAITING_MARKET", "待选商品"],
                ["PAUSED", "暂停中"],
                ["PLAYING", "进行中"],
                ["ENDED", "已结束"],
              ] as const).map(([state, label]) => (
                <button
                  key={label}
                  type="button"
                  aria-pressed={runtime.filters.state === state}
                  onClick={() => runtime.actions.setFilters({ ...runtime.filters, state })}
                >
                  {label}
                </button>
              ))}
            </div>
            <label>
              历史源
              <select
                value={runtime.filters.sourceKind ?? ""}
                onChange={(event) => runtime.actions.setFilters({
                  ...runtime.filters,
                  sourceKind: event.target.value === "" ? null : event.target.value as ReplayV2SourceKind,
                })}
              >
                <option value="">全部</option>
                <option value="BAR">K 线</option>
                <option value="AGG_TRADE">成交</option>
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
                <option value="">全部</option>
                <option value="READY">可用</option>
                <option value="UNAVAILABLE">不可用</option>
              </select>
            </label>
          </div>
          <span className="training-hub-toolbar-meta">
            已加载 {loadedRunCount} 条{runtime.nextCursor !== null ? " · 还有下一页" : " · 已到当前列表末尾"}
          </span>
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
            <div className="training-hub-empty-mark" aria-hidden="true">R2</div>
            <strong>还没有训练存档</strong>
            <span>创建第一条服务端权威训练；默认使用盲化随机窗口。</span>
            <button type="button" onClick={() => void runtime.actions.openCreate()} disabled={busy}>新建第一条训练</button>
          </div>
        ) : (
          <div className="training-hub-card-grid" aria-label="训练存档列表">
            {runtime.items.map((card) => (
              <article className="training-hub-card" data-state={card.state} key={card.run_id}>
                <header className="training-hub-card-head">
                  <div>
                    <span>训练 · {trainingIntegrityLabel(card.integrity_mode)}</span>
                    <h2>{card.name}</h2>
                  </div>
                  <strong className="training-hub-state-badge" data-run-state={card.state}>{trainingRunStateLabel(card.state)}</strong>
                </header>
                <div className="training-hub-card-hero">
                  {card.state === "AWAITING_MARKET" || card.last_symbol === null ? (
                    <>
                      <span>当前商品</span>
                      <strong>未选择商品</strong>
                    </>
                  ) : (
                    <>
                      <span>账户权益</span>
                      <strong>
                        {card.equity_status === "CURRENT" && card.equity !== null
                          ? formatTrainingEquity(card.equity)
                          : card.equity_status}
                        {card.equity_status === "CURRENT" && <small>{card.settlement_asset}</small>}
                      </strong>
                    </>
                  )}
                </div>
                <dl className="training-hub-card-meta">
                  <div><dt>账户商品</dt><dd>{card.last_symbol ?? "未选择"}{card.subscribed_track_count > 0 ? ` · ${card.subscribed_track_count} 个活动轨道` : ""}</dd></div>
                  <div><dt>历史源</dt><dd>{trainingSourceKindLabel(card.source_kind)}</dd></div>
                  <div><dt>进度</dt><dd>#{card.progress.source_sequence}</dd></div>
                  <div><dt>时间披露</dt><dd>{trainingTimeDisclosureLabel(card.time_disclosure_policy)}</dd></div>
                  <div><dt>兼容性</dt><dd>{trainingCompatibilityLabel(card.compatibility)}</dd></div>
                  <div><dt>完整性</dt><dd>{trainingIntegrityLabel(card.integrity_mode)}</dd></div>
                </dl>
                <p className="training-hub-card-message">{trainingRunStatusMessage(card)}</p>
                <footer className="training-hub-card-actions">
                  <button
                    className="training-hub-primary-button"
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
                    删除
                  </button>
                </footer>
              </article>
            ))}
          </div>
        )}
        {runtime.nextCursor !== null && (
          <div className="training-hub-load-more-wrap">
            <button
              className="training-hub-load-more"
              type="button"
              disabled={busy}
              onClick={runtime.actions.loadNext}
            >
              加载下一页
            </button>
          </div>
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
