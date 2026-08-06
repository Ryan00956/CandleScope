# CandleScope HEDGE 交易所等价回放 Phase 0 数据合同审计

状态：`BLOCKED_DATA_CONTRACT`

审计日期：2026-08-06

审计基线：`87aa32e66284bdc46f65fb5e09fc3eb13f04737e`

目标分支：`codex/replay-hedge-exchange-parity`

执行合同：[`KLINE_REPLAY_HEDGE_EXCHANGE_PARITY_EXECUTION_zh.md`](KLINE_REPLAY_HEDGE_EXCHANGE_PARITY_EXECUTION_zh.md)

本文件记录 Phase 0 的数据可得性门禁。它不是实现完成声明，也不授权把缺失的保险基金或 ADL 输入替换成近似模型。

---

## 1. 结论

当前本地 archive、Binance USD-M 官方 API 和 Binance 官方公共下载数据都不能提供执行合同所要求的历史完整输入：

1. 没有覆盖任意回放区间的保险基金逐变动账本；官方只提供当前余额快照。
2. 没有全市场 ADL 参与集合、排序分数或权威候选队列；官方只提供当前账户的 0–4 档粗分位和 symbol 级 low/medium/high 风险等级。
3. 用户强平/ADL 历史只记录该用户实际发生的结果，不能决定一个反事实训练账户是否会被 ADL。
4. 官方公开 trades 与 aggTrades 明确排除 insurance fund trades 和 ADL trades。
5. Binance 官方公共下载集合没有 insurance fund 或 ADL 数据集。

因此，现阶段不能同时满足：

- 任意历史区间；
- 反事实训练账户；
- 交易所权威保险基金余额变化；
- 可确定重建的 ADL 候选与选择顺序；
- 无近似、无灰度、无 fallback。

根据执行合同 Phase 0 的硬门禁，本阶段必须停在 `BLOCKED_DATA_CONTRACT`。在解除条件满足前，不进入 schema、账户或强平算法实现。

---

## 2. 本地实现审计

### 2.1 Exact account archive

当前 `backend/app/replay/training/account_history.py` 冻结：

- `ARCHIVE_SCHEMA_VERSION = replay.account-history.linear.v1`；
- `ARCHIVE_CONTRACT_MODEL = LINEAR_QUOTE_SETTLED_V1`；
- `ARCHIVE_POSITION_MODE = ONE_WAY`；
- `ARCHIVE_CAPTURE_MODE = OPERATOR_CAPTURED`。

archive 包含 instrument rule、mark/index、funding 和统一事件链，但不包含：

- HEDGE per-leg account state；
- insurance fund balance/posting；
- ADL participant set、queue snapshot 或 selection event；
- exchange takeover/insurance/ADL fills。

测试 fixture 是 `OPERATOR_CAPTURED_TEST_FIXTURE`，不能作为交易所历史权威样本。

### 2.2 Historical book archive

当前 `backend/app/replay/training/historical_book.py` 冻结 `replay.historical-book.binance-usdm.v1`，能验证 snapshot、diff-depth sequence、gap 和 pin，但当前产品合同只声明：

- `BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE`；
- 无 queue proof；
- 账户/成交内核仍不重建交易所私有排队；
- book archive 不包含 insurance fund 或 ADL 订单身份。

### 2.3 当前强平模型

当前强平是 CandleScope 模拟账户领域事件：

- 代理或 exact mark 触发维护保证金检查；
- 撤销普通订单；
- 通过 replay broker 关闭仓位；
- 计提 liquidation fee；
- 没有保险基金与 ADL。

这条路径可以继续作为已明确标注的模拟账户能力，但不能改名为本轮要求的交易所历史完整强平。

---

## 3. Binance USD-M 官方接口审计

以下结论基于 2026-08-06 读取的 Binance 官方开发者文档。

### 3.1 可用但需要版本化捕获的数据

| 能力 | 官方接口 | 能提供什么 | 仍缺什么 |
|---|---|---|---|
| HEDGE mode | `POST /fapi/v1/positionSide/dual` | 账户使用 One-way 或 Hedge mode | 历史 mode 时间线 |
| 当前账户 | `GET /fapi/v2/account`、`GET /fapi/v3/account` | 当前 LONG/SHORT、initial/maint margin、leverage、isolated 状态 | 任意历史时刻完整账户快照 |
| 风险阶梯 | `GET /fapi/v1/leverageBracket` | 当前用户 symbol bracket、max leverage、MMR、cum | 历史生效时间线；接口是 USER_DATA 且结果可有用户系数 |
| 用户强平结果 | `GET /fapi/v1/forceOrders` | 该用户实际 LIQUIDATION/ADL order | 反事实训练账户、其他参与者和全局选择顺序 |

官方账户文档：

- [USD-M Account REST API](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account)
- [USD-M Trade REST API](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade)

### 3.2 保险基金接口不足以重建历史账本

官方 `GET /fapi/v1/insuranceBalance`：

- 名称为 `Query Insurance Fund Balance Snapshot`；
- 只接受可选 `symbol`；
- 没有 `startTime`、`endTime`、sequence 或分页参数；
- 返回当前 symbols/assets 快照，而不是逐变动账本。

来源：[USD-M Market Data - Query Insurance Fund Balance Snapshot](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#query-insurance-fund-balance-snapshot)

定时轮询该接口只能从部署之后形成采样序列，不能恢复部署前历史；两次采样之间发生的多次流入流出也不能唯一分解。因此它不能作为任意历史区间的 exact posting ledger。

### 3.3 ADL Risk 不是 ADL 队列

官方公共 `GET /fapi/v1/symbolAdlRisk`：

- 只返回 symbol 级 `low|medium|high`；
- 每 30 分钟更新；
- 文档说明它综合保险基金、持仓集中度、盘口深度、波动率、平均杠杆、未实现 PnL 和保证金利用率；
- 不返回参与者、排序分数、数量、方向或选择结果。

来源：[USD-M Market Data - ADL Risk](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#adl-risk)

该值只能表示发生 ADL 的粗风险，不能确定训练账户在队列中的精确位置，也不能计算一次 ADL 应减少哪条腿和多少数量。

### 3.4 ADL Quantile 只反映当前用户粗分位

官方 USER_DATA `GET /fapi/v1/adlQuantile`：

- 每 30 秒更新；
- 返回 0–4 五档分位，而不是连续排序分数；
- HEDGE isolated 可分别返回 LONG/SHORT；
- HEDGE cross 两侧使用按合并未实现 PnL 计算的相同值，并带 `HEDGE` 标记；
- 没有 `startTime`、`endTime` 或历史分页；
- 只属于调用 API key 的账户。

来源：[USD-M Trade - Position ADL Quantile Estimation](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#position-adl-quantile-estimation)

五档分位不能给出同一档内的严格顺序，也不能给出其他参与者数量、方向和可被减仓数量，所以不能构造执行合同要求的 `ADL queue snapshot/event`。

### 3.5 用户 Force Orders 只能验证实际结果

官方 USER_DATA `GET /fapi/v1/forceOrders` 支持 `autoCloseType=LIQUIDATION|ADL`，但只返回该用户实际发生的强平或 ADL order。

来源：[USD-M Trade - User's Force Orders](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#users-force-orders)

它可以用于回放一个真实账户已经发生的 ADL 结果，不能用于回答反事实问题：如果用户当时下了另一组订单、持有另一组仓位，是否会被选中 ADL。

### 3.6 公开成交明确排除保险基金与 ADL

官方市场数据文档明确说明：

- `/fapi/v1/aggTrades` 只聚合普通市场成交，排除 insurance fund trades 和 ADL trades；
- historical/recent trades 同样排除 insurance fund trades 和 ADL trades。

来源：[USD-M Market Data REST API](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data)

因此不能通过当前 aggTrade/trade archive 反向推导保险基金接管或 ADL 成交。

---

## 4. Binance 官方公共下载数据审计

Binance 官方 `binance-public-data` 仓库列出的 USD-M 数据包括普通 aggTrades、trades、klines 及相关公开市场数据。其 README 不列出 insurance fund ledger、ADL participant queue 或 ADL trade 数据集。

来源：[binance/binance-public-data README](https://github.com/binance/binance-public-data/blob/master/README.md)

公开下载数据不能补齐第 3 节缺失的私有账户与全局风险状态。

---

## 5. 已排除的替代方案

| 替代方案 | 为什么不满足执行合同 |
|---|---|
| 定时采集当前 insurance balance | 只能前瞻采样；采样间变动不可分解，不能覆盖任意历史区间 |
| 定时采集一个账户的 ADL quantile | 只有五档粗分位，没有全局参与者和同档顺序 |
| 使用 symbolAdlRisk | 只有 low/medium/high，不能决定 ADL selection 或 quantity |
| 使用用户 forceOrders | 只能重放实际历史，不能支持训练账户的反事实仓位 |
| 从 L2、OI、long/short ratio 推导 | 缺少参与者逐账户 leverage、PnL、margin utilization 和 position concentration |
| 从普通 trades/aggTrades 推导 | 官方明确排除 insurance fund 和 ADL trades |
| 创建 synthetic participant cohort | 属于模拟/近似 ADL，违反用户的无灰度、无近似要求 |
| 保险基金无限或固定初值 | 会改变破产缺口和 ADL 触发，不能称交易所等价 |

---

## 6. 解除阻塞的必要条件

至少满足以下一种路径后，才能重新进入 Phase 0：

### 路径 A：交易所或授权数据商提供完整历史输入

需要同时提供：

- 保险基金逐变动账本或可证明无遗漏的 balance/posting 序列；
- ADL 参与集合、方向、数量、排序分数/严格顺序和 selection event；
- 规则版本、生效时刻和同毫秒事件顺序；
- 可覆盖目标回放区间的 checksum、sequence、gap 与 provenance 证明；
- 允许本项目持久化和重放的授权。

### 路径 B：交易所提供权威历史结果服务

服务必须能以冻结输入查询一个反事实账户状态下的 insurance/ADL 结果，并提供版本、幂等键和可审计 receipt。当前公开 API 不具备该能力。

### 路径 C：用户显式修改产品合同

若用户主动接受“版本化确定性模拟 ADL，而非交易所历史 exact”，可以另写合同并实现模拟 participant cohort。但这会改变本轮已经明确的“无近似模型”目标，不能由实现者自行决定。

### 路径 D：切换到全状态透明的目标交易场所

必须重新做 Phase 0，证明该场所公开且可持久重建完整 participant、insurance 和 ADL 状态，同时评估现有 Binance replay archive 的替换成本。不能只因为 Binance 数据不足就默认切换交易所。

---

## 7. 停止点

本次 Phase 0 已完成以下只读工作：

- 核对本地 exact account、historical book、liquidation schema 和 fixture；
- 核对 Binance USD-M current account、position mode、leverage bracket、insurance balance、ADL risk、ADL quantile 和 force-order 官方合同；
- 核对 Binance 官方公共下载数据；
- 排除 sampling、proxy、synthetic cohort 和普通成交反推方案。

未执行：

- 未修改产品合同降低标准；
- 未设计 approximate ADL；
- 未进入 schema vNext；
- 未修改账户、强平、前端或默认启用代码；
- 未导入或删除任何 replay 数据。

下一步不是继续编码，而是取得第 6 节的一条权威输入路径或由用户明确修订目标。
