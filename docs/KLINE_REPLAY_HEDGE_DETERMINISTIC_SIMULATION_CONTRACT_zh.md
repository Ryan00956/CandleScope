# CandleScope HEDGE 交易所规则级确定性模拟合同 v1

状态：`FROZEN / PHASE_0_COMPLETE / HARD_CUTOVER_INPUT`

日期：2026-08-06

机器真值：`backend/app/replay/training/hedge_simulation_contract.py`

合同 hash：`sha256:eb93972d289057909f7c8fd8ef66376876f7e0c60b2e46dbe6c5ca4c609f9c4b`

用户于 2026-08-06 明确接受近似后，本合同替代“必须取得交易所历史全量保险基金账本和 ADL 私有队列”的阻塞条件。近似范围只覆盖不可观测的交易所私有状态；产品必须显示“交易所规则级确定性模拟”，不得改写成“历史交易所 exact”。

---

## 1. 身份与版本

| 项目 | 冻结值 |
|---|---|
| schema | `replay.hedge-simulation-contract.v1` |
| 总模型 | `BINANCE_USDM_LINEAR_HEDGE_DETERMINISTIC_SIMULATION_V1` |
| 账户公式 | `CANDLESCOPE_HEDGE_ACCOUNT_V1` |
| 强平公式 | `CANDLESCOPE_HEDGE_LIQUIDATION_V1` |
| 保险基金 | `CANDLESCOPE_INSURANCE_FUND_SIMULATION_V1` |
| ADL | `CANDLESCOPE_ADL_COHORT_SIMULATION_V1` |
| 交易所规则族 | Binance USD-M |
| 合约 | 线性 USDT 本位永续 |
| 保证金资产 | 单结算资产 USDT |
| 持仓模式 | `ONE_WAY`、`HEDGE` |
| 保证金模式 | `CROSS`、逐腿 `ISOLATED` |

正常运行只允许一个总模型版本。不得按 Run、用户、symbol 或流量选择新旧 HEDGE 引擎。

## 2. 真实性边界

### 2.1 仍要求 pinned 的历史公开输入

- 商品 filter、风险阶梯、维护保证金率与 deduction、强平费和生效时刻；
- mark/index 时间线；
- funding 结算时刻、费率与 settlement mark；
- maker/taker/liquidation fee policy；
- 当 `book_mode=BOOK_ASSISTED_REQUIRED` 时，连续历史 L2 snapshot/delta/sequence/gap proof。

规则、mark/index、funding 或 fee 输入缺失时 Run 暂停，不得退回 last/trade/bar close 或 0 funding。L2 只在 `BOOK_ASSISTED_REQUIRED` 中是强制输入；`book_mode=OFF` 不导入、不投影也不读取 L2，并使用本合同第 5 节冻结的 no-book 强平执行模型。

### 2.2 明确属于确定性模拟的私有状态

- 保险基金初值、余额和 posting 时间线；
- ADL cohort snapshot、候选 margin/position 输入、排名和 selection。

二者必须在 Run 创建前物化、版本化、校验、hash 并由 manifest pin。运行时禁止随机生成、重新采样或回退固定无限基金。相同 manifest、命令和事件链必须得到相同 hash。

### 2.3 禁止宣称

- 历史交易所保险基金余额 exact；
- 历史全市场 ADL 队列 exact；
- 仅凭 L2 得到 queue-exact fill；
- 当前模拟账户结果就是某个真实 Binance 账户当时必然发生的结果。

## 3. Decimal、舍入与保证金

所有账户输入使用 Decimal canonical string，禁止 float。

- notional：`abs(quantity) × mark_price × contract_size`；
- initial margin：`notional ÷ active_leverage`，按 quote step 向上；
- maintenance margin：`max(0, notional × tier_rate - tier_deduction)`，按 quote step 向上；
- LONG unrealized PnL：`(mark - entry) × quantity × contract_size`；
- SHORT unrealized PnL：`(entry - mark) × quantity × contract_size`；
- HEDGE 不做两腿保证金抵扣，两腿 initial/maintenance margin 分别计算后求和；
- CROSS breach：`cross wallet + Σ unrealized PnL <= Σ maintenance margin`；
- ISOLATED breach：`isolated wallet + leg unrealized PnL <= leg maintenance margin`。

费用和保证金按 quote step 向上；下单价格使用 adverse price tick；部分强平数量按 quantity step 向上且不超过仓位。

## 4. 同一虚拟时刻总序

| phase | 事件 |
|---:|---|
| 10 | 规则与风险限额生效 |
| 20 | 市场事件与已有订单成交 |
| 30 | mark/index 更新 |
| 40 | funding settlement |
| 50 | 条件单触发与订单状态变化 |
| 60 | risk snapshot 与 breach detection |
| 70 | 强平、保险基金与 ADL |
| 80 | ledger、projection、checkpoint 与 hash 原子提交 |

用户命令只按服务端 accepted sequence 进入尚未提交的时刻，不能插回已提交事件之前。

## 5. 强平规则

状态顺序固定为：

```text
ACTIVE -> RISK_BREACH_DETECTED -> CANCELING_ORDERS -> RISK_RECHECK
-> PARTIAL_LIQUIDATION (0..N) -> FULL_LIQUIDATION
-> BANKRUPTCY_TRANSFER -> INSURANCE_FUND_SETTLEMENT -> ADL
-> ACTIVE | BANKRUPT | FAILED_CLOSED
```

1. 先撤销 breach margin scope 中全部非 reduce-only 活动订单并释放保证金。
2. 撤单后立即重算；恢复安全则记录 `RECOVERED_AFTER_CANCEL`。
3. 仍不安全时，选腿顺序固定为 maintenance margin 降序、绝对 notional 降序、track ID 升序、同 track 下 LONG 先于 SHORT。
4. 每张部分强平单最多下降一个 risk tier；第一档目标为零仓位。
5. `BOOK_ASSISTED_REQUIRED` 强平单按连续历史 L2 可见深度逐档成交；`OFF` 强平单按 case 创建时冻结的已揭示 mark 加配置的不利 market slippage 成交。两种模式都在每个 durable step 后重算，恢复安全立即停止。
6. `BOOK_ASSISTED_REQUIRED` 的 L2 gap、深度耗尽、filter 冲突或价格越界均暂停 Run，不回退 no-book；`OFF` 不创建 L2 证明，缺失冻结 mark、规则或滑点合同则暂停 Run。
7. liquidation price 是 adverse tick grid 上第一个满足 scope equity 小于等于 maintenance margin 的价格。
8. bankruptcy/takeover price 是 adverse tick grid 上 scope equity 到零的根；CROSS 的逐腿证明固定其他腿 mark 不变，并明确标记为 counterfactual leg proof。

`OFF` 模式的执行 fidelity 固定为 `TOUCH_OR_TAPE_MARK_SLIPPAGE_V1`。同一 liquidation case 的每条 HEDGE 腿必须使用各自在 case 创建时冻结的 mark proof 独立计算滑点；成交价不是市场数据更新，不能污染另一条腿的参考 mark。该模式不声称可见深度、partial queue 或 queue-exact。

## 6. 保险基金模拟

manifest 必须给出非负 opening balance。posting 顺序固定为：

1. 强平费流入；
2. 破产缺口扣款。

公式：

```text
available = opening_balance + liquidation_fee_inflow
coverage = min(available, bankruptcy_deficit)
closing_balance = available - coverage
uncovered_deficit = bankruptcy_deficit - coverage
```

基金永不透支。`uncovered_deficit > 0` 必须进入 ADL；所有 posting 使用幂等键和 hash chain。

## 7. ADL cohort 模拟

ADL 只读取已物化并 pin 的 cohort snapshot。候选必须具有 candidate ID、symbol、position side、quantity、entry、mark、initial margin 和 margin balance。

资格条件：

- 与破产腿方向相反；
- quantity 大于零；
- unrealized PnL 大于零。

评分：

```text
profit_ratio = positive_unrealized_pnl / max(initial_margin, quote_step)
effective_leverage = notional / max(margin_balance, quote_step)
score = profit_ratio * effective_leverage
```

排序依次为 `score DESC`、`profit_ratio DESC`、`effective_leverage DESC`、`candidate_id ASC`。按顺序消费候选 quantity，成交价为 bankruptcy takeover price，直到 takeover quantity 为零。cohort 耗尽仍有剩余时进入 `FAILED_CLOSED_COHORT_EXHAUSTED`，不得新增运行时随机候选。

## 8. 输入、连续性与失败行为

simulation manifest 必须覆盖 Run 全区间：

- 首个 insurance balance 在 Run start 前或同刻生效；
- insurance posting sequence 严格单调且相邻 hash 连续；
- 每个可能进入 ADL 的时刻有 active cohort snapshot；
- candidate ID 在 snapshot 内唯一，所有数量符合 symbol step；
- component hash、event-chain hash 与 dataset hash 完整。

删除、重复、回退、时间倒序、hash 篡改、覆盖 gap 或 schema/version 不匹配均暂停整个 Run。

## 9. 性能观测与资源预算

- 1/2/4/8 个 FULL positioned tracks 的普通 wave 与强平 wave 必须分别测量
  p50/p95/max 并写入同 HEAD benchmark artifact；墙钟延迟与吞吐只作观测，
  不设置发布通过阈值。
- 不得通过跳过 benchmark、减少轨数/样本、伪造固定值或增加运行时 skip flag
  来绕过测量。
- 进程 RSS 增量不超过 64 MiB；内存、存储、队列和审计边界仍是硬门禁。

本节自 2026-08-08 起取代此前 500/2,000/5,000 ms 墙钟冻结值；历史
artifact 中的旧阈值只说明当时测量，不再参与当前 release acceptance。

## 10. Phase 0 黄金样本

机器测试冻结以下结果：

- simulation manifest 黄金样本 hash 为 `sha256:a5fe1beb59b87a6a000faa6f46d9871394288c48acd84f2a7295b710d92a1236`；
- `notional=25000, leverage=20` 的 initial margin 为 `1250`；
- `notional=75000, rate=0.01, deduction=250` 的 maintenance margin 为 `500`；
- fund `50`、fee inflow `5`、deficit `80` 后 coverage `55`、closing `0`、uncovered `25`；
- ADL 样本对破产 LONG 只选择盈利 SHORT，顺序 `short-b -> short-a`；
- cohort quantity 不足时结果必须是 `FAILED_CLOSED_COHORT_EXHAUSTED`。

任何公式、字段、顺序、预算或真实性命名变更，都必须升级合同版本和 golden hash，不允许原地修改 v1 语义。
