# CandleScope K 线回放交易所规则级双向持仓与强平硬切换执行文档

状态：`PHASE_0_COMPLETE_DETERMINISTIC_SIMULATION / HARD_CUTOVER / NO_GRAY_RUNTIME / DEFAULT_ON_REQUIRED`

日期：2026-08-06

适用工作区：`H:\program\CandleScope`

产品真值：[`KLINE_REPLAY_TRAINING_PRODUCT_CONTRACT_zh.md`](KLINE_REPLAY_TRAINING_PRODUCT_CONTRACT_zh.md)

现有总执行文档：[`KLINE_REPLAY_TRAINING_EXECUTION_zh.md`](KLINE_REPLAY_TRAINING_EXECUTION_zh.md)

本文不是完成声明。它冻结下一轮实现范围、顺序、硬门禁和最终启用方式。只有本文最后的全部验收门禁在同一 clean HEAD 上通过后，才能把“交易所级双向持仓与强平”标记为完成。

Phase 0 数据可得性审计见 [`KLINE_REPLAY_HEDGE_PHASE0_DATA_CONTRACT_AUDIT_zh.md`](KLINE_REPLAY_HEDGE_PHASE0_DATA_CONTRACT_AUDIT_zh.md)。用户于 2026-08-06 明确接受近似后，Phase 0 已按 [`KLINE_REPLAY_HEDGE_DETERMINISTIC_SIMULATION_CONTRACT_zh.md`](KLINE_REPLAY_HEDGE_DETERMINISTIC_SIMULATION_CONTRACT_zh.md) 冻结为“历史公开输入 pinned + 私有保险基金/ADL 状态版本化确定性模拟”。这解除数据合同阻塞，但不授权宣称历史交易所 insurance/ADL exact。

---

## 1. 决策摘要

本轮把当前 HEDGE 基础实现升级为交易所规则级确定性模拟的双向合约账户。最终产品必须同时满足：

1. 同一商品的 `LONG`、`SHORT` 两条腿可独立开仓、加仓、减仓、止盈止损、调整保证金和强平。
2. `CROSS` 与 `ISOLATED` 都支持双向持仓，不再把 HEDGE 限制为全仓。
3. HEDGE 使用 pinned mark/index、版本化风险限额和维护保证金阶梯，不能绑定旧 `APPROX_PROXY`。
4. 资金费按结算时刻分别对两条腿入账，不能通过净仓位抵消后漏记。
5. 强平覆盖撤单释放保证金、重新评估、阶梯降档、部分强平、全部强平、破产结算、强平费、保险基金和 ADL。
6. 强平执行必须留下完整订单、成交、账本和状态机证据，不能直接改写仓位数量。
7. 正常构建默认开放回放入口、默认启用所需账户与盘口能力，新建 Run 默认选择 `HEDGE`；`ONE_WAY` 仍可由用户主动选择。
8. 不增加 HEDGE 灰度比例、实验组、双引擎或默认关闭开关；最终上线是整版硬切换。
9. 任一 required public input 或物化 simulation input 缺失时明确拒绝创建或暂停 Run，不回退到 bar/trade proxy、固定资金费、无限保险基金、运行时随机 cohort 或 Touch/Tape。
10. 回滚只允许回滚完整构建和相应数据版本，不允许运行时切回旧 HEDGE 账户模型。

### 1.1 “完整”的冻结边界

首个交付目标锁定为：

- 单一交易所规则适配器；首选与现有 archive/book 路径一致的 Binance USD-M；
- 线性、quote-settled 永续合约；
- 单结算资产的全仓与逐仓账户；
- `ONE_WAY` 与 `HEDGE`；
- Binance USD-M 规则级确定性模拟的保证金、资金费和强平生命周期；
- 版本化、物化并由 Run pin 的保险基金和 ADL cohort 模型；
- 有连续历史 L2 时的确定性强平执行。

“完整”指上述模拟账户与风险生命周期完整，不代表重建历史交易所中不可观测的保险基金账本、ADL 私有队列或其他用户订单排队。产品固定显示“交易所规则级确定性模拟”。若最终要求历史成交逐笔 queue-exact 或 insurance/ADL historical exact，必须另行取得权威私有数据并升级合同；仅有 L2 和合成 cohort 时不得作此声明。

本轮仍不包含：

- 实盘 API key、真实资金或实盘下单；
- inverse、期权、Greeks；
- multi-assets 或 portfolio margin；
- 跨交易所统一保证金；
- 把确定性模拟保险基金或 ADL 结果伪装成“历史交易所 exact”。

---

## 2. 当前基线与必须移除的限制

当前工作区已经有真正的双腿仓位容器和显式 `position_side`，但它只是本轮底座：

- `PositionBook.long` 与 `PositionBook.short` 独立保存；
- 开平仓、保护单和成交显式携带 `LONG|SHORT`；
- 风险敞口按两腿 gross notional 求和；
- 基础跨仓强平可撤单并依次关闭两条腿；
- UI、持久化、报告已能区分两条腿。

以下现状必须在最终交付中消失：

| 当前限制 | 位置 | 最终要求 |
|---|---|---|
| HEDGE 只能 `APPROX_PROXY` | `training/models.py` 创建合同 | HEDGE 只接受版本化 `DETERMINISTIC_SIMULATION` manifest；公开输入与模拟私有状态分别标记 |
| HEDGE 只能 `CROSS` | 创建合同和 Hub 禁用项 | 同时支持 CROSS 与逐腿 ISOLATED |
| HEDGE 强制 funding OFF | 创建合同和 Hub 禁用项 | 支持历史 exact funding，逐腿独立入账 |
| HEDGE 强制 book OFF | 创建合同和 Hub 禁用项 | 完整模式要求连续历史 L2，不允许 Touch/Tape 回退 |
| account-history 固定 ONE_WAY | `account_history.py` archive contract | 新 archive 版本支持 HEDGE 与 simulation input refs |
| 保证金主要按 gross notional / max leverage | broker/training account projection | 使用交易所适配器冻结的逐腿初始保证金和维持保证金公式 |
| 两腿一起强平时破产价为 null | liquidation detection | 每条腿和每一步都有可审计的破产/接管价格或明确的公式不适用原因 |
| 一个 track/sequence 只能有一个 liquidation event | training schema | 一个 case 下可有多 leg、多 step、多 order、多 fill |
| liquidation 只保存第一个 close order id | service/storage | 保存全部撤单、部分强平和最终平仓订单与成交 |
| 无保险基金和 ADL | replay domain 不存在 | 形成独立账本、状态机、审计和 UI |
| 新 Run 默认 ONE_WAY | Hub draft 和后端默认值 | 新 Run 默认 HEDGE，用户可主动选 ONE_WAY |
| replay/entry/account/book 默认关闭 | backend/frontend config | 正常构建默认启用；前端入口不再由默认关闭旗标隐藏 |

当前 `APPROX_PROXY` 可以继续服务明确标注的 ONE_WAY 沙盒训练，但不得再成为 HEDGE 的可选项、隐式默认或失败回退。HEDGE 的唯一模型是 Phase 0 冻结的 `DETERMINISTIC_SIMULATION`。

---

## 3. 非灰度与默认启用合同

### 3.1 禁止的实现方式

不得新增或保留以下行为：

- `HEDGE_ENABLED=0`、`HEDGE_EXPERIMENT_PERCENT` 或同类产品开关；
- 按用户、Run、symbol、机器或流量比例选择新旧 HEDGE 引擎；
- 新模型失败后自动调用旧 `APPROX_PROXY` 强平；
- exact mark 缺失后改用 last、trade、bar close 或前一条 mark；
- funding 缺失后按 0 结算；
- book gap 后退回 Touch/Tape；
- ADL cohort/保险基金 simulation manifest 缺数据后仅在 UI 隐藏该环节并继续执行；
- 同一数据库中让相同模型版本由两个不同公式解释；
- 把阶段性代码通过隐藏入口部署到正常构建中等待放量。

### 3.2 允许的开发与故障边界

- 各 Phase 可在独立开发分支上提交；阶段提交不是运行时灰度。
- 最终合并前，正常发布构建不得包含可被用户创建的半成品 HEDGE Run。
- 数据不满足 pinned-public + materialized-simulation 合同时，能力保持默认启用，但具体 dataset/Run 返回明确的 `UNAVAILABLE`、`QUARANTINED` 或 `PAUSED`；这不是 feature disabled。
- 运维可以通过回滚完整构建处理事故，但不能在新构建中静默切换旧公式。
- 非产品正确性开关，例如 GC、预下载并发或性能优化，可以独立配置；关闭它们不得改变账户、成交或强平结果。

### 3.3 最终默认值

最终 hard-cutover commit 必须满足：

- 后端 replay capability 正常构建默认启用；若保留 `REPLAY_ENABLED`，默认值改为 `1`。
- 前端移除 `VITE_REPLAY_ENTRY_ENABLED` 对入口可见性的依赖；入口默认显示，再由后端 capability 返回数据可用性。
- pinned account-history/simulation manifest 与 historical book 能力默认启用；若保留对应环境变量，默认值必须为 `1`。
- 禁止增加新的 HEDGE、liquidation、insurance fund 或 ADL 默认关闭开关。
- 前端新建 Run 的 `positionMode` 默认值为 `HEDGE`。
- 后端省略 `position_mode` 时的规范化默认值改为 `HEDGE`；canonical/hash 合同同步升级，不能用旧默认值保持新旧语义混合。
- `.env.example`、README、测试服务器、发布校验器和回滚脚本使用同一默认值。

---

## 4. Pinned 公开输入与物化模拟输入合同

HEDGE 不允许依赖旧通用代理规则。每个 Run 必须 pin 一个不可变的 exchange simulation dataset manifest，至少包含下列时间线：

| 数据 | 必需字段 | 连续性要求 | 缺失行为 |
|---|---|---|---|
| 商品与账户规则 | symbol filters、contract size、leverage bracket、risk limit、maintenance rate/deduction、liquidation fee、effective time | 覆盖 Run 全区间，规则变更有单调序号 | 拒绝创建或暂停 |
| mark/index | event time、sequence、mark、index、来源 | 严格单调、无未解释 gap、同毫秒总序冻结 | 暂停，不使用 last/trade 代理 |
| funding | settlement time、rate、settlement mark、规则版本 | 覆盖所有结算点，幂等键唯一 | 暂停，不按 0 跳过 |
| 历史 L2 | snapshot、增量、exchange sequence、gap/resync | 每个强制 FULL track 连续 | 整个 Run 暂停，不回退 Touch/Tape |
| 保险基金模拟 | 资产、非负初值、变动、effective time、simulation model version | 能重建每次接管前后的余额；manifest 标记 simulated | 暂停，不使用无限或固定运行时 fallback |
| ADL cohort 模拟 | model version、物化参与集合、方向、数量、margin/position 输入、effective time | 能按冻结公式确定性重建选择顺序；manifest 标记 simulated | 暂停，不生成运行时随机候选 |
| 手续费 | maker/taker/liquidation fee policy、账户 tier、生效时间 | 覆盖每个 fill | 暂停，不使用当前配置替代历史策略 |

所有输入必须：

1. 由 operator importer 或版本化离线 simulation builder 物化后导入 replay-owned object store；
2. 记录 source identity、schema、时间范围、checksum、行数、连续性证明和 capture receipt；
3. 通过 quarantine 后才能绑定 Run；
4. 被 Run manifest pin，后续 catalog 刷新不能改变既有 Run；
5. 以 Decimal canonical string 保存，禁止 float 进入账户公式；
6. 有独立 component hash、event chain hash 和最终 dataset hash；
7. 缺失、重复、回退、越界或被篡改时 fail closed。

公开规则和行情仍必须来自目标交易所的版本化规则或已验证 capture。保险基金与 ADL 私有状态按 `BINANCE_USDM_LINEAR_HEDGE_DETERMINISTIC_SIMULATION_V1` 物化；产品和 API 必须显式携带 fidelity。实现代码不能把规则网页内容或合成参数散落成无版本常量。

---

## 5. 目标领域模型

### 5.1 双向仓位

每个 `(run_id, track_id, position_side)` 是独立 `PositionLeg`，至少包含：

- `position_side=LONG|SHORT`；
- signed quantity 与 absolute quantity；
- entry price、mark price、notional；
- realized/unrealized PnL；
- initial margin、maintenance margin；
- leverage、margin mode、isolated wallet；
- liquidation price、bankruptcy price；
- accumulated funding、fees；
- active risk tier 和 rule revision；
- protection/order references；
- component revision 和 hash。

等量 LONG/SHORT 不是空仓。是否允许初始保证金抵扣、维持保证金抵扣或共享风险限额，只能由版本化 exchange adapter 决定，不能统一写死为 gross 或 net。

### 5.2 保证金账户

账户至少拆分：

- settlement cash；
- cross wallet balance；
- 每条逐仓腿的 isolated wallet；
- open-order initial margin；
- position initial margin；
- maintenance margin；
- available balance；
- realized/unrealized PnL；
- funding、trading fee、liquidation fee；
- insurance transfer 与 ADL posting；
- account status 与 risk snapshot hash。

调整逐仓保证金必须是领域命令和账本事件，不能直接修改 JSON allocation。切换 margin mode、position mode 或影响历史公式的参数在 Run 创建后不可变，除非产品合同明确允许并记录版本化 mutation。

### 5.3 强平 case、step 与 fill

现有单行 liquidation event 升级为：

- `LiquidationCase`：一次账户风险破口；
- `LiquidationLeg`：case 涉及的 LONG/SHORT 腿；
- `LiquidationStep`：撤单、重评估、部分强平、全平、破产接管、保险基金或 ADL；
- `LiquidationOrder`：每一步产生的全部订单；
- `LiquidationFill`：订单的逐次成交；
- `InsuranceFundPosting`：基金流入流出；
- `ADLEvent`：候选排名、选中对象、数量、价格和账本影响。

一个 case 可以覆盖多个 track 和多条腿。数据库不得继续用 `(run_id, track_id, trigger_source_sequence)` 唯一约束压扁账户级事件。

---

## 6. 强平状态机与原子顺序

### 6.1 状态机

```text
ACTIVE
  -> RISK_BREACH_DETECTED
  -> CANCELING_ORDERS
  -> RISK_RECHECK
  -> PARTIAL_LIQUIDATION (0..N)
  -> FULL_LIQUIDATION (必要时)
  -> BANKRUPTCY_TRANSFER (出现账户缺口时)
  -> INSURANCE_FUND_SETTLEMENT
  -> ADL (保险基金不足且规则要求时)
  -> ACTIVE | BANKRUPT | FAILED_CLOSED
```

`FAILED_CLOSED` 必须暂停整个 Run，并保存失败前最后一个已提交的原子状态。重启后从 durable step 恢复，不得重复撤单、成交、收费、保险基金扣款或 ADL。

### 6.2 同一虚拟时刻的总序

Phase 0 必须冻结目标交易所适配器的总序，至少覆盖：

1. 规则/风险限额生效；
2. 市场 trade/book 事件与已有订单成交；
3. mark/index 更新；
4. funding settlement；
5. 条件单触发和挂单状态变化；
6. 账户风险快照与强平检测；
7. 强平撤单、部分平仓、全平、破产、保险基金和 ADL；
8. ledger、projection、checkpoint 与 hash 提交。

用户命令按服务端 accepted sequence 排序，只能影响接受之后的状态，不能插回已提交的同毫秒事件之前。

### 6.3 强平算法

每次风险检查必须执行完整流程：

1. 用 pinned mark、active rule revision 和当前订单/仓位构造不可变 `RiskSnapshot`。
2. 按 exchange adapter 分别计算 CROSS account 与各条 ISOLATED leg 的风险。
3. 命中阈值后创建唯一 `LiquidationCase`，冻结普通增仓命令。
4. 取消规则要求取消的活动订单，逐笔记录并释放订单保证金。
5. 使用撤单后的账户状态重新计算；若恢复安全，记录 `RECOVERED_AFTER_CANCEL` 并结束 case。
6. 若仍不安全，按照 risk tier 和交易所降档规则计算最小部分强平数量。
7. 通过强平订单走历史 L2 执行，保存全部 partial fills、滑点、费用和未成交量。
8. 每次 fill 后更新腿、账户、tier 和风险快照；达到安全阈值立即停止继续减仓。
9. 无法通过部分强平恢复时进入全平；两条腿是否同时处理、先后顺序和共享保证金释放由适配器规则决定。
10. 计算每条腿的接管价/破产价、账户缺口和 liquidation fee，禁止仅保存净数量。
11. 缺口先进入版本化模拟保险基金账本；基金不足时按冻结的物化 ADL cohort 和排名规则执行 ADL。
12. 最终原子提交 case、steps、orders、fills、ledger、account、positions、report projection 和 state hash。

任何一步缺数据、违反数量/价格 filter、盘口断档或不能确定 ADL 顺序，都进入 `FAILED_CLOSED`，不得直接把 quantity 清零。

---

## 7. Schema、协议与兼容策略

当前 training schema 为 v13。本轮必须升级到下一版本，并为以下数据提供一等结构，不能继续只塞入单个 `position_json` 或 liquidation 单行：

- per-leg position state；
- per-leg margin/leverage/risk tier；
- cross 与 isolated margin buckets；
- exchange rule adapter/version；
- HEDGE public-history ref 与 simulation manifest ref；
- liquidation case/leg/step/order/fill；
- insurance fund balance/posting；
- materialized ADL cohort snapshot/event；
- risk snapshot 和 audit proof。

协议与 canonical 变更要求：

- `position_mode` 省略默认值从 ONE_WAY 改为 HEDGE，协议版本必须同步升级；
- 所有 open/close/protection/margin 命令在 HEDGE 下要求 `position_side`；
- liquidation 返回数组化 order/fill/leg，不保留“只记录第一个 close order”的兼容解释；
- state hash、component hash、report hash 覆盖新字段；
- checkpoint、fork、review、export/import 和 recovery 使用同一模型版本；
- 旧 HEDGE Run 不得被新公式静默解释。

本项目既有开发期 cutover 已允许清空训练数据。本轮执行时仍必须先生成数据库路径、schema、size、checksum 和 Run 数量清单，再进行一次性开发数据重建；不得删除 live 数据库、行情 archive 或用户未授权的其他目录。若发现已存在需要保留的正式 HEDGE Run，必须停止并另写显式迁移合同。

---

## 8. 分阶段执行计划

各 Phase 在独立分支上连续完成。每个 Phase 只提交显式路径，不能 `git add -A`，不能带入当前工作区无关的 design QA 或 preview 文件。任一 Phase 未通过自己的门禁，不进入下一阶段。

### Phase 0：合同、交易所规则与数据可得性冻结

工作内容：

- 修改产品合同，删除 HEDGE 的 `APPROX_PROXY + CROSS + funding OFF + book OFF` 首版限制。
- 从非目标中移除本轮要求覆盖的保险基金和 ADL。
- 冻结首个 exchange adapter、合约类型、结算资产、保证金和强平公式版本。
- 冻结 pinned public input 与 materialized simulation manifest、连续性、quarantine、fidelity 和缺失行为。
- 冻结强平总序、状态机、部分强平算法、保险基金和 ADL 输入合同。
- 生成当前 replay 数据盘点和可恢复备份清单。

硬门禁：

- 不存在“稍后决定”的保证金、强平或 ADL 公式。
- 每个公开 required source 都有来源/连续性合同；每个模拟 required source 都有物化样本、模型版本、golden hash 和 gap/fail-closed 测试。
- 产品、API、报告和导出固定披露 insurance/ADL 属于确定性模拟，不得宣称历史交易所 exact。

完成证据：

- 机器合同：`backend/app/replay/training/hedge_simulation_contract.py`；
- 合同 hash：`sha256:eb93972d289057909f7c8fd8ef66376876f7e0c60b2e46dbe6c5ca4c609f9c4b`；
- simulation manifest 黄金样本：`backend/tests/fixtures/replay/hedge_simulation_manifest_v1.json`，hash `sha256:a5fe1beb59b87a6a000faa6f46d9871394288c48acd84f2a7295b710d92a1236`；
- 人类合同：[`KLINE_REPLAY_HEDGE_DETERMINISTIC_SIMULATION_CONTRACT_zh.md`](KLINE_REPLAY_HEDGE_DETERMINISTIC_SIMULATION_CONTRACT_zh.md)；
- 数据盘点：[`evidence/KLINE_REPLAY_HEDGE_PHASE0_DATA_INVENTORY_20260806.json`](evidence/KLINE_REPLAY_HEDGE_PHASE0_DATA_INVENTORY_20260806.json)；
- 当前盘点为 training schema 13、1 个 legacy-unspecified Run、0 个显式 HEDGE rule；未复制、删除或重建数据。

状态：`COMPLETE`。Phase 1 从本合同升级协议与 schema，不得修改 v1 公式原义。

### Phase 1：协议、canonical 与 schema

工作内容：

- 升级 replay/training 协议和 training schema。
- 新增唯一 HEDGE account mode `DETERMINISTIC_SIMULATION`，并把 public/simulated fidelity 写入 canonical；拒绝旧 HEDGE `APPROX_PROXY` payload。
- 落地 per-leg position、margin bucket、risk snapshot、liquidation case/step/fill、insurance、ADL 表。
- 更新 API/parser/types/canonical/checkpoint/fork/review/export。
- 后端和前端默认 `position_mode=HEDGE`。
- 对旧 HEDGE payload 明确拒绝，不做静默 canonical 兼容。

硬门禁：

- schema foreign-key、unique、restart 和 corruption 测试通过。
- 同一 payload 在 Python/TypeScript 解析和 canonical hash 上一致。
- 无单行 liquidation event 压扁多腿结果的路径。

预估：4–6 个工程日。

状态：`COMPLETE`。wire 已硬切到 `replay.v3`，training schema 已硬切到
v14 / `replay.training.v2`，默认 HEDGE + DETERMINISTIC_SIMULATION；旧 HEDGE
近似/历史 exact payload 与旧协议均 fail-closed。单行 liquidation event 已从 fresh
schema 和生产路径删除，14 张 HEDGE 关系表成为 checkpoint、fork、review、audit、
portfolio/export 的权威来源。阶段证据见
[`evidence/KLINE_REPLAY_HEDGE_PHASE1_RESULT_20260806_zh.md`](evidence/KLINE_REPLAY_HEDGE_PHASE1_RESULT_20260806_zh.md)。

### Phase 2：双向账户、杠杆与保证金核心

工作内容：

- 把 PositionBook 升级为完整 per-leg risk state。
- 实现逐腿 leverage、initial margin、maintenance margin 和 risk tier。
- 实现 CROSS 与逐腿 ISOLATED；支持增加/减少逐仓保证金。
- 按 exchange adapter 实现 HEDGE 下的保证金抵扣或不抵扣规则。
- 重构 order capacity、reserved margin、reduce-only 和 close capacity。
- 所有 Decimal rounding 从 rule adapter 读取。

硬门禁：

- LONG/SHORT 同时存在时，任何 account 字段都可从 ledger 和 position legs 独立重算。
- 等量双腿不会被当成 flat，也不会错误释放全部保证金。
- CROSS 和 ISOLATED 的一条腿变化不会串改另一条腿。

预估：5–7 个工程日。

状态：`COMPLETE`。broker 已持久化逐腿 active leverage 与订单 effective leverage，
新增原子 `set_position_leverage` 命令；初始/维持保证金、risk tier、rounding、
opening reservation 与 close capacity 均由统一 Decimal rule adapter 按目标腿计算。
CROSS 不做双腿净额抵扣；HEDGE ISOLATED wallet/allocation/bucket/ledger/fork/UI
全部硬切到逐腿 key，单腿调杠杆、分配或释放不会串改另一腿。portfolio 可从
ledger、position legs 与 active orders 独立重算并对篡改 fail-closed。阶段证据见
[`evidence/KLINE_REPLAY_HEDGE_PHASE2_RESULT_20260806_zh.md`](evidence/KLINE_REPLAY_HEDGE_PHASE2_RESULT_20260806_zh.md)。

### Phase 3：HEDGE pinned public archive 与 simulation manifest

工作内容：

- 新增 HEDGE public-history archive、simulation manifest schema 和 importer/builder。
- 导入并 pin mark/index、funding、rule/risk tier、fee、模拟 insurance 和物化 ADL cohort 时间线。
- 把 account-only event 纳入全局虚拟时钟。
- 实现 source sequence、same-ms phase、checksum、quarantine 和 rehydration。
- 删除 HEDGE 对 `APPROX_PROXY` 的依赖和可选入口，只保留 `DETERMINISTIC_SIMULATION`。

硬门禁：

- 任一源删除、篡改、重复、gap 或时间倒退都会暂停 Run。
- 关闭网络后可完全从 pinned archive 重放并得到同一 hash。
- 不存在 mark/funding/book fallback。

预估：5–8 个工程日；真实数据准备另计。

状态：`COMPLETE`。新增 replay-owned public/simulation catalog、不可变 importer、
原子 Run binding、T0 no-lookahead projection、全局 phase 10/20/30/40/70 输入时钟、
pinned mark no-fallback、runtime guard、显式 trusted-source rehydration 与独立 input
auditor。HEDGE 单 track 同样使用全局输入时钟；Review fork 固定同一 generation/proof
并为 child 重算 applied receipt。portfolio 与前端严格 parser 已暴露并验证不含本地路径的
input proof。完整 replay 后端 `851 passed`，前端 replay `326 passed`，typecheck、lint、
build、Ruff、compile 与 diff check 全部通过。阶段证据见
[`evidence/KLINE_REPLAY_HEDGE_PHASE3_RESULT_20260806_zh.md`](evidence/KLINE_REPLAY_HEDGE_PHASE3_RESULT_20260806_zh.md)。

### Phase 4：双向资金费、手续费与账本审计

工作内容：

- funding 按结算前持仓快照分别结算 LONG/SHORT。
- maker/taker/liquidation fee 使用对应 effective policy revision。
- 所有 position/margin/funding/fee mutation 形成 hash-chained ledger entry。
- 更新 portfolio、report、review 和 export 的逐腿账本。
- 扩展 account auditor，从初始权益完整重算两条腿和账户。

硬门禁：

- 相同数量的 LONG/SHORT 仍分别产生方向相反的 funding cash flow。
- response loss、重试和重启不会重复结算。
- auditor 对正常样本零差异，对任一篡改明确失败字段。

预估：3–5 个工程日。

状态：`COMPLETE`。training schema v16 已新增完整 fee-policy extension 与逐腿
funding settlement；FUNDING 按结算前 LONG/SHORT 快照分别产生现金与不可变事实，
fill fee 绑定成交时刻生效的完整公开策略。HEDGE position/margin/accounting mutation
均进入同一 hash-chained ledger，portfolio/report/account-record export/Review fork 已暴露
并重建 child-owned 逐腿证据。account auditor 以 `(track_id, position_side)` 重演 fills、
funding、fees、最终两腿和账户，正常/重试/重启/fork 零差异，篡改结算前数量、逐腿累计
或 ledger hash 均返回精确字段。完整 replay 后端 `855 passed`，前端 replay `326 passed`，
typecheck、lint、build、Ruff、compile 与 diff check 通过。阶段证据见
[`evidence/KLINE_REPLAY_HEDGE_PHASE4_RESULT_20260806_zh.md`](evidence/KLINE_REPLAY_HEDGE_PHASE4_RESULT_20260806_zh.md)。

### Phase 5：完整强平、破产、保险基金与 ADL

工作内容：

- 实现本文第 6 节的完整状态机。
- 撤单释放保证金后重新评估。
- 实现 risk-tier step-down、部分强平、多次 fill 和必要时全平。
- 实现逐腿 liquidation/bankruptcy/takeover 价格。
- 实现 insurance fund posting、余额约束和不足处理。
- 实现 ADL ranking、selection、position reduction、counterparty ledger 和 audit proof。
- 支持多 track cross account 的账户级 liquidation case。

硬门禁：

- 不存在直接清零 quantity 的捷径。
- 一个 case 的所有 legs、steps、orders、fills 和 postings 可完整查询。
- 在每个 durable step 注入崩溃后，恢复结果与无崩溃参考路径 hash 相同。
- 保险基金不能透支；不足时必须进入 ADL 或 fail closed。

预估：8–12 个工程日。

状态：`COMPLETE`。training schema v17 已把 CROSS/ISOLATED 风险检测硬切为账户级/
逐腿 case，并实现 cancel、recheck、partial/full、bankruptcy、insurance、ADL、complete
逐 transaction 状态机。所有 close 使用显式数量并绑定真实 broker order/fill；逐腿价格
proof、基金 posting、ADL selection 与 counterparty hash-chain 均可查询。七个 durable
commit 点逐一注入崩溃后，恢复路径无重复副作用，最终 case/step hash 与同 seed 无崩溃
reference 一致。保险基金不透支，cohort 不足时 Run `FAILED_CLOSED/PAUSED`。完整 replay
后端 `868 passed`，前端 replay `326 passed`，typecheck、lint、build、Ruff、compile 与
diff check 通过。阶段证据见
[`evidence/KLINE_REPLAY_HEDGE_PHASE5_RESULT_20260806_zh.md`](evidence/KLINE_REPLAY_HEDGE_PHASE5_RESULT_20260806_zh.md)。

### Phase 6：历史 L2 强平执行

工作内容：

- HEDGE 完整模式强制 `BOOK_ASSISTED_REQUIRED` 数据合同。
- 强平订单按历史 L2 的可见深度逐档成交，产生 partial fills。
- 冻结无法观测 queue position 时的保守执行规则，并在产品命名中保持数据边界。
- book gap、深度不足、price band/filter 冲突进入暂停或下一条交易所规则分支。
- 快进 planner 将 position、orders、funding、risk、insurance 和 ADL 视为路径依赖。

硬门禁：

- book gap 永不回退 Touch/Tape。
- optimized path 与逐事件 reference path 的 account/liquidation/report hash 一致。
- 不宣称仅凭 L2 得到历史 queue-exact fill。

预估：4–7 个工程日。

状态：`COMPLETE`。training schema v18 已在风险 case 创建时冻结同一 virtual time 的
历史 L2 快照，并为每个 HEDGE liquidation step 保存逐档 execution proof。强平通过仅
training 内部可调用的 historical-book close 命令生成单 order、多 real fills；每个 fill
都绑定非空 book level、book/execution-plan hash 与
`HISTORICAL_L2_VISIBLE_DEPTH_CONSERVATIVE_V1`，且永久声明 `queue_exact=false`。
快照缺失/陈旧、archive/ref 不可用、深度耗尽、price tick 或 quantity step 冲突均形成
durable `FAILED_CLOSED` 并暂停 Run，不回退普通 `CLOSE_POSITION`/Touch/Tape。触发时快照
可跨进程恢复，公开 Review 投影不泄漏 archive/actual time，精确 Review fork 可恢复历史
L2 fills。优化开启的 advance 仍选择 `FULL_EVENT_SCAN`，与逐步 reference 的 hedge state
和 execution plan hashes 一致。完整 replay 后端 `875 passed`，前端 replay `326 passed`，
typecheck、lint、build、Ruff、compile 与 diff check 通过。阶段证据见
[`evidence/KLINE_REPLAY_HEDGE_PHASE6_RESULT_20260806_zh.md`](evidence/KLINE_REPLAY_HEDGE_PHASE6_RESULT_20260806_zh.md)。

### Phase 7：API、右栏、报告与默认体验

工作内容：

- 新建 Run 默认 HEDGE，ONE_WAY 为显式可选项。
- 去掉 HEDGE 对 exact/isolated/funding/book 的 disabled UI。
- 右栏分别展示两腿 quantity、entry、mark、leverage、margin、MM、liquidation price、bankruptcy price、funding 和保护单。
- 强平时间线展示 case、partial steps、orders/fills、fee、insurance 和 ADL。
- 报告、ReviewMode、导出保持相同字段和命名。
- 前端入口默认显示，不依赖 Vite 默认关闭旗标。

硬门禁：

- 1440×900 与项目支持的最小尺寸无截断、遮挡和不可操作项。
- 刷新、切 symbol、切 interval 不丢失任一腿或强平步骤。
- DOM/ARIA、日志、URL 和导出中不存在未来时间泄漏。

预估：4–6 个工程日。

完成记录（2026-08-06）：已完成。入口、HEDGE 创建、历史盘口和账户历史改为代码默认启用，移除 Vite 入口旗标及 HEDGE/ISOLATED/funding/book 灰色禁用项；新建 Run 默认 HEDGE，ONE_WAY 保持显式可选。portfolio、ReviewMode、报告和 CSV 现在共享公开安全的逐腿持仓与完整强平时间线，包含持续 liquidation/bankruptcy price、保护单、L2 order/fill、fee、insurance 和 ADL；内部执行计划已从公共 reason 中清除。Python/TypeScript/golden capability 协议同步，破产负权益可严格解析。真实浏览器在 1440×900 和 1024×720 无横向溢出，刷新和 1m→3m 切换后仍保留两腿或全部强平步骤。完整 replay 后端 `877 passed`，前端 replay `329 passed`，typecheck、lint、build、Ruff、compile 与 diff check 通过。阶段证据见 [`evidence/KLINE_REPLAY_HEDGE_PHASE7_RESULT_20260806_zh.md`](evidence/KLINE_REPLAY_HEDGE_PHASE7_RESULT_20260806_zh.md)。

### Phase 8：恢复、审计与故障注入

工作内容：

- 覆盖 command retry、response loss、process kill、SQLite busy、WAL recovery、archive rehydrate。
- 在 liquidation 每个状态转换前后注入崩溃。
- 从 ledger、rules、marks、funding、fills、insurance 和 ADL 完整重建账户。
- 验证 fork/review 不改变父 Run hash。
- 验证多 FULL track 同一全局时钟和强平顺序。

硬门禁：

- 所有 reference/optimized/recovered 路径最终 hash 一致。
- 所有幂等键在重启和重试后唯一。
- 任一证据链断裂都 fail closed，不沿用旧 projection。

预估：4–6 个工程日。

完成记录（2026-08-06）：已完成。七个强平 durable transition 的提交前崩溃和提交后响应丢失均覆盖真实服务关闭/重开，修复了历史 L2 close 在重启后用新 revision 重构相同 command ID 导致 `COMMAND_ID_REUSED` 的问题；现在重用并严格校验原始持久化 command envelope。账户审计新增 insurance 与 ADL 的独立重建和完整 hash chain 校验，任一证据损坏会暂停 HEDGE Run 并将账户置为 `FAILED_CLOSED`。SQLite busy exhaustion 不推进 projection，WAL 重开恢复与 reference hash 一致；active public/simulation/L2 archive rehydrate、fork/review 父 hash 和多 FULL track 时钟/顺序门禁通过。完整 replay 后端 `900 passed`，前端 `329 passed`，typecheck、lint、build、Ruff、compile 与 diff check 通过。阶段证据见 [`evidence/KLINE_REPLAY_HEDGE_PHASE8_RESULT_20260806_zh.md`](evidence/KLINE_REPLAY_HEDGE_PHASE8_RESULT_20260806_zh.md)。

### Phase 9：性能、长稳与发布验收

工作内容：

- 测量 `track 数 × 双腿持仓 × 订单/成交历史 × mark/funding 频率 × liquidation steps`。
- 使用真实 ReplayService、SQLite、Decimal、archive 和浏览器，不用空仓微基准替代。
- 完成 1/2/4/8 FULL tracks 的普通 mark wave 和强平波测试。
- 完成 4 小时 soak、100 次生命周期循环、1,000,000 projection events。
- 生成绑定 clean HEAD 的外部 release manifest 和完整 rollback drill。

硬门禁：

- 1/2/4/8 FULL positioned tracks 的普通 simulation-account wave 与强平波
  必须分别报告 p50/p95/max，不与普通推进平均；墙钟延迟和吞吐是
  `MEASURE_ONLY_NON_BLOCKING`，不设置发布通过阈值。
- 不得省略 benchmark、减少轨数/正式样本或增加 `skip-performance` 旗标；
  benchmark artifact 缺测量仍拒绝发布。
- 内存、数据库、WAL、archive 和浏览器无单调泄漏。
- 全量 backend、frontend、architecture、typecheck、lint、build 全通过。
- 4 小时 soak、故障注入、审计和回滚全部通过。

预估：4–6 个工程日，不含 4 小时机器运行时间和问题修复。

完成记录（2026-08-06，以候选提交后的 clean-HEAD 外部 release manifest 为最终判定）：逐轨 HEDGE public archive binding/projection/applied receipt、真实 ADD_TRACK 多标的输入、全局屏障强平判定、22 项验收矩阵、HEDGE 浏览器 fixture/账户连续性和 release manifest v3 已实现。候选提交前 replay 后端 `916 passed`，前端综合门禁 `2936 passed`；8 FULL 双腿普通 wave p95 `357.662 ms`，强平 wave p95/max `1374.952 ms`，冻结阈值未调整。完整构建回滚工具已跟随两阶段 Run/market、`adapter_session_id`、`replay.v3` wire、可见但禁用的紧急停机入口和 cross-root 前回放基线隔离合同。长时诊断已修复 MarketTrack 权威刷新饥饿、CDP Network 观测保留、计划重载请求竞态、挂起绘图 RAF 和冻结 replay rail transition；`f7cee596` 的 40-cycle 压缩门禁在原 `64 MiB / 32 MiB` 堆阈值下全部通过。初始 market 的 catalog epoch 乐观并发现在按 requestId/body 严格证明最多一次 `409 CATALOG_EPOCH_MISMATCH -> 201`，其他 4xx/5xx 仍拒绝；`f4c47cbd` 的真实 smoke 31 项与 rollback 17 项 acceptance 全真。训练命令成功响应现在还必须精确匹配请求 `run_id/command_id`，soak 独立保留并关联全部命令 request/response/body；`fb42c834` 的压缩 100-cycle 复验完成 100/100 training/archive lifecycle、712/712 命令身份关联且 32 项 acceptance 全真，越过旧 cycle 70 错配故障边界。该结果只允许进入最终证据链，正式真实来源、全量 checks、benchmark、smoke、rollback、4 小时 soak 和 manifest 仍必须在本记录提交后的同一 clean HEAD 从头执行。详见 [`evidence/KLINE_REPLAY_HEDGE_PHASE9_RESULT_20260806_zh.md`](evidence/KLINE_REPLAY_HEDGE_PHASE9_RESULT_20260806_zh.md)。

后续正式 4 小时轮在完成 100/100 周期后捕获到一次 `replay.v1` session command 的无响应体代理 500。产品已经按同一 canonical `command_id` 在新权威快照后 fail-closed 对账，验收捕获却只覆盖 `replay.v3` Run command，无法证明恢复链，因此该轮保持 FAIL。正式 soak 现同时捕获 v1/v3 命令，并新增硬合同：最多 1 次无结构化响应的传输丢失，必须由唯一一次 method/URL/body 字节完全相同的重试和匹配 protocol、Run/session、`command_id` 的 2xx 响应闭环；结构化 5xx、第二次丢失/重试、修改命令或身份不一致仍拒绝。修复后的新 clean HEAD 必须重跑本阶段全部正式证据。

再后一轮 clean-HEAD 正式 soak 在约 74.8 分钟、第 30 个训练周期捕获 `GET /runs/session/<id>/tracks` 的 Vite proxy `read ECONNRESET`/无效 500 body；session/controller/权威时钟和此前 250 个命令身份都健康，但客户端因一次幂等状态读取失败清空 tracks/bars 并永久禁用命令。该失败属于正确性与长稳硬门禁，不属于已豁免的墙钟性能阈值。产品现仅对 GET 的首次传输失败、body 中断或无结构化正文 5xx 自动重试一次；所有 mutation、结构化错误、成功但非法 JSON、第二次失败仍 fail closed。正式 soak 按 requestId/body/序号证明唯一同 URL GET 2xx 闭环，并将命令与读取恢复合并限制为整场最多一次；新 clean HEAD 仍必须重跑本阶段全部正式证据。

35-cycle 高密度复验随后完成全部周期并越过旧 cycle 30，但网络审计发现 capture 将 `canceled=true / net::ERR_ABORTED` 的页面生命周期主动取消误配为 GET retry，因此仍保持 FAIL。主动取消现在单独审计且不消耗恢复预算、不设置 pending；只有这两个字段同时精确匹配才分类为 abort，其他 canceled/网络错误仍受严格恢复合同约束。若主动取消中断已开始的真实 retry，原恢复链仍因缺少成功 2xx 而失败。修复后的新 clean HEAD 继续从高密度复验起重跑。

再下一轮 clean-HEAD 高密度、来源、全检查与完整 benchmark 已通过，但正式 smoke 捕获 Windows Chrome launcher 以 `0` 退出并把真实 browser 交接到子进程的生命周期差异。旧 harness 将 launcher exit 误判为 browser 死亡，且 cleanup 因遗漏真实 browser 留下被锁 profile。harness 现仅对 Chrome 的显式 Windows 成功交接继续等待 browser readiness，随后持有 browser-level CDP 控制，收尾发送 `Browser.close`、执行 PID fallback，并以调试端点有界消失作为删除临时目录前的硬证明；非零 launcher exit、其他服务提前退出、端点仍存活均继续 fail closed。新 clean HEAD 仍须重跑本阶段全部正式证据。

Windows lifecycle 修复后的专用真实 smoke 已通过并证明无新 Chrome/profile 残留；随后正式全量 backend checks 的唯一失败来自未改动的限流测试以 50ms `Retry-After` 同时充当“circuit 必须仍开启”的观察窗。宿主调度恰好发生在两个连续 inspect 之间，第一项仍为 `circuit_open`、第二项已进入恢复后的 `budget`；backend diff 为空且独立连续 30 次通过，判定为测试时钟竞争。该不等待恢复的跨 bucket 可见性测试现使用 5s 观察窗以隔离调度抖动，生产限流实现、默认 cooldown 和真实 Retry-After 行为均不变。新 clean HEAD 仍须重跑本阶段全部正式证据。

该新 HEAD 的来源、checks、完整 measure-only benchmark、真实 smoke 与 rollback 随后全部通过；正式 4 小时 soak 在约 212 分钟、第 88 个训练周期捕获 `replay.v3 set_speed` POST 已发送但 120 秒内既无 response/body 也无 loading-failed，页面永久停在 `controlPending=set_speed`。这是命令 ACK/liveness 正确性失败，不属于墙钟性能豁免。Run API 现对六类快速时钟控制设置固定 ACK 截止，并且只在结果未知时用完全相同的 method/URL/body 与 canonical `command_id` 对账一次；结构化拒绝、身份错配、主动取消、第二次失败继续硬拒绝，长 advance/scan/end 不套用快速截止。没有灰度、默认关闭或 fallback；新 clean HEAD 仍须先做高密度复验，再从零重跑完整 Phase 9 正式证据链。

`b09ab3a6932d5dc0313fd53f89ab95d8ecea9d42` 的正式来源、全量 checks（后端 `3253 passed`、前端 `2996 passed`）、7/7 组件 measure-only benchmark、真实浏览器 smoke 和 rollback 全部通过；正式 4 小时 soak 在约 `8,964 s`、第 62 个训练周期因等待 `set_speed` ACK 超时硬失败。失败时页面与权威 Run 时钟均已是 `PAUSED`，但同一 canonical 命令的原请求和唯一对账请求都以 `net::ERR_ABORTED` 结束；后端队列、actor、持久化、恢复和 SQLite 仍健康。这不是墙钟性能门槛，而是有持仓播放批次长期持有 Run 串行锁造成的控制命令活性失败：PAUSE 可先设置停止信号和时钟状态，却仍要等当前批次释放锁才能返回；SET_SPEED 同样在锁外等待。HEDGE 的资金费/标记价依赖还会禁用终态优化，因此普通逐 BAR 参考路径也可能按累计时间在一个锁区间内推进最多 64 根，不能只修复原 32 根终态批次。播放调度现对 `OPEN_ORDER` / `OPEN_POSITION` 路径统一限制为每次 Run 锁只提交 1 个 BAR 屏障，覆盖优化和参考路径；空账户批处理保持不变，成交、标记、强平、保险基金和 ADL 仍按原全局屏障顺序执行。回归测试强制注入 64 根追赶量，在 LONG/SHORT 双腿同时持仓时证明只提交 1 根、游标只增 1、排队 PAUSE 在有界时间返回；Phase 9 HEDGE 与播放调度定向集 `18 passed`。没有开关、灰度、默认关闭、降级或性能阈值变更；本提交后必须先越过旧第 62 周期，再由新 clean HEAD 从零重建全部正式证据。

该锁修复的 `13c3f1c73af416a89e902b2f0eef41ab6b6a359e` 已通过 70/70 高密度真实浏览器周期并越过旧第 62 轮；573 条命令 request/response/body 身份精确，双腿、账户连续性、恢复、资源和 35 项 acceptance 全真。随后正式全量 checks 的唯一失败来自无关的 Windows 插件沙箱测试：1 秒 CPU JobObject 配额已用 NTSTATUS `0xC0000044 (STATUS_QUOTA_EXCEEDED)` 终止子进程，`status=exited / violation=null`，但受宿主调度影响墙钟为 `8328 ms`，超过测试写死的 `8000 ms`。独立连续 5 次均通过，保留现场再次得到同一 NTSTATUS；本机 Windows SDK 也把 `0xC0000044` 定义为 `STATUS_QUOTA_EXCEEDED`。测试现删除任意墙钟性能判断，改为精确验证 `violation=null` 与该 NTSTATUS；生产 AppContainer、1 秒 CPU 配额、10 秒 wall-time 保护和只终止 sandbox Job 的行为均未修改。该测试/文档提交再次形成新 HEAD，70-cycle 与正式来源只能作诊断，仍须从新 clean HEAD 重跑 Phase 9 全链。

`52ed928b92fd76d034104b3787f85f6367981e9e` 随后重新通过 70/70 高密度周期、真实来源、全量 checks 与 7/7 measure-only benchmark；正式 smoke 的产品生命周期完成，但网络审计捕获 `/order-capacity` 与 `/public-times` 两个并发 POST 被 Vite 以 `socket hang up / read ECONNRESET` 转为无正文 500。后端没有结构化错误且同 HEAD 立即复跑通过。受控实验先确认后端就绪，再把 Uvicorn 空闲截止缩至 1 秒：旧 `keepAlive=true` 配置的 240 次 Vite 边界请求中稳定复现 25 个同签名 500；dev/preview `/api` 代理改为显式 `keepAlive=false` 的私有 Agent后，同口径 `240/240` 全部成功。每次 API 请求现建立新上游连接；没有给查询 POST 加重试、没有放宽整场一次传输恢复预算、没有忽略 500。新 clean HEAD 仍须从 70-cycle 起重跑 Phase 9 全链。

### Phase 10：整版 hard cutover

工作内容：

- 合并全部 Phase 到一个已验收 HEAD。
- 修改最终默认值并删除前端入口旗标依赖。
- 删除旧 HEDGE proxy 创建合同、UI 选项、fallback 和测试 fixture。
- 重建允许清空的开发 replay 数据并保留盘点/备份证据。
- 更新 README、产品合同、执行文档、运维说明和 release manifest。
- 从全新进程和全新浏览器 profile 验证默认入口和默认 HEDGE。

硬门禁：

- 不设置任何 replay/HEDGE 环境变量，启动后入口可见、后端 capability enabled、新建 Run 默认 HEDGE。
- 缺 pinned-public/simulation dataset 时显示数据不可用原因，而不是 feature disabled 或 proxy fallback。
- 搜索代码、文档、脚本和测试，不存在 HEDGE 默认关闭、百分比灰度或旧 proxy fallback。
- rollback 只能把整个构建和 schema 恢复到上一已知版本；回滚演练通过。

预估：2–3 个工程日。

---

## 9. 最低验收矩阵

以下场景必须使用真实 service、SQLite 和 Decimal 执行，不能只测纯函数：

1. 同商品同时开 LONG/SHORT，分别加仓、部分平仓、保护和平仓。
2. 等量双腿下 gross、net、initial margin、maintenance 和 available balance 符合适配器规则。
3. CROSS 中一条腿亏损影响共享权益，但不会错误改写另一条腿数量。
4. ISOLATED LONG 被强平而 SHORT 保持活动；反向场景同样通过。
5. 两条腿在同一 funding 时刻分别结算，重启后不重复。
6. 规则和 risk tier 在同毫秒变更时按冻结总序生效。
7. 撤销挂单释放保证金后账户恢复安全，不再错误强平。
8. 部分强平降低 risk tier 后恢复安全，不继续全平。
9. 部分强平多次 partial fill 后才恢复安全。
10. 盘口深度不足时不直接把剩余仓位清零。
11. 全平到破产价后缺口由保险基金覆盖。
12. 保险基金不足触发 ADL，并能审计候选排序和最终选择。
13. 多商品 CROSS 账户一次 risk breach 形成一个账户级 case，不重复收费。
14. 两条腿同时进入强平时分别记录价格、订单、成交和账本，不保存为一个净仓事件。
15. mark/index、funding、rule、book、insurance、ADL 任一 gap 都暂停，不回退代理数据。
16. 每个 liquidation state 前后 process kill，恢复结果与 reference path 相同。
17. command response 丢失与重试不产生重复订单、fill、fee、funding、insurance 或 ADL。
18. fork/review/export/import 保留完整双腿和 liquidation case。
19. 快进 reference 与 optimization 的 component/account/report hash 一致。
20. 无环境变量全新启动时，入口默认可见、新 Run 默认 HEDGE、exact/book capability 默认启用。
21. 主动选择 ONE_WAY 时既有单向账户语义和测试不回归。
22. 浏览器刷新、断线恢复、切商品和切周期不改变 server-authoritative account state。

---

## 10. 发布级门禁

最终 release manifest 必须绑定同一 clean HEAD，并至少包含：

- Git HEAD、tree cleanliness、submodule/依赖锁定状态；
- backend 全量测试结果；
- frontend 全量测试、typecheck、lint、build；
- schema/canonical golden hash；
- 22 项最低验收矩阵结果；
- source manifest/checksum/continuity/quarantine 证据；
- account auditor 与 liquidation auditor 结果；
- 1/2/4/8 track 性能分布；
- 4 小时 soak；
- 故障注入和恢复等价性；
- 无默认关闭/灰度/fallback 的静态审计；
- 全新进程、全新数据库、全新浏览器的默认启用验证；
- 完整构建 rollback 和数据恢复演练。

任何旧 HEAD 的 benchmark、soak、浏览器截图或 manifest 都不能继承到新 HEAD。不得省略墙钟测量、减少场景、关闭强平分支或改用 fixture-only 证据；延迟/吞吐数值不参与 PASS/FAIL，资源、正确性、长稳和回滚门禁不得放宽。

---

## 11. 回滚策略

本轮不使用运行时灰度，因此回滚单位是完整构建：

1. 暂停所有 active TrainingRun 并持久化 checkpoint。
2. 导出 replay schema/version、Run 清单、archive refs 和数据库 checksum。
3. 停止新构建进程。
4. 恢复上一已验证构建及其匹配的 replay 数据版本或备份。
5. 运行 SQLite quick check、foreign key check、hash audit 和最小 smoke。
6. 验证 live 行情运行时未被 replay 回滚影响。

禁止通过设置某个 HEDGE flag，让同一新 schema 数据重新进入旧强平公式。若旧构建不能读取新 schema，就必须恢复匹配的数据备份，不能“尽量兼容”。

---

## 12. 总工期与关键路径

在所需公开 archive 与物化 simulation manifest 可构建的前提下，预计 6–9 个工程周。关键路径是：

```text
规则/数据合同
  -> schema 与 canonical
  -> 双向保证金账户
  -> pinned mark/funding/book
  -> 部分强平/破产
  -> 保险基金/ADL
  -> 恢复与审计
  -> 真实性能/4h soak
  -> 默认启用 hard cutover
```

保险基金与 ADL 权威历史输入不可获得的事实已在 Phase 0 审计保留。用户明确接受近似后，项目使用已冻结的版本化确定性模拟继续；任何界面、API、报告或发布说明都必须保留该 fidelity，不能继续宣称“历史交易所 exact”。

---

## 13. Definition of Done

只有同时满足以下条件，任务才完成：

- 产品合同已经反映完整 HEDGE、强平、保险基金、ADL 和默认启用决策；
- 当前 HEDGE 的四项首版限制全部删除；
- 22 项最低验收矩阵全部通过；
- 全量测试、审计、性能、4 小时 soak、浏览器和 rollback 全部通过；
- clean HEAD release manifest 为 PASS；
- 正常构建无环境变量启动即默认启用，入口可见，新 Run 默认 HEDGE；
- 任一 required public/simulation input 缺失都 fail closed，且没有旧 `APPROX_PROXY`、Touch/Tape、0 funding、无限基金或运行时随机 cohort fallback；
- 没有 HEDGE 灰度、双引擎、默认关闭开关或阶段性完成声明；
- 所有订单、成交、资金费、保证金、强平、保险基金和 ADL 都能从不可变输入与 hash-chained ledger 独立重算；
- 用户未授权的工作区文件没有被暂存、提交、覆盖或删除。
