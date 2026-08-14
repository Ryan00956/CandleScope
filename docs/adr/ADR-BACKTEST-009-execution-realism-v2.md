# ADR-BACKTEST-009：成交真实性 V2

- 状态：Accepted
- 日期：2026-08-15
- 基线：`461ed7bf59eb082a83b96ce0b4fbc815dbb845c5`

## 决策

新增不可变身份 `EXECUTION_REALISM_V2`。旧 Run 未声明该身份时继续使用
`BAR_NEXT_BAR_WORST_CASE_V1` 或 `TRADE_NEXT_PRINT_CONSERVATIVE_V1`，旧配置、序列化和
结果 hash 不变。V2 的 BAR fill policy 为 `BAR_VOLUME_PARTICIPATION_WORST_CASE_V2`，
aggTrade fill policy 为 `AGG_TRADE_LATENCY_PARTICIPATION_V2`。

BAR 只允许 `OHLC_WORST_CASE_STOP_FIRST_V1`：market 使用下一根 bar open，limit/stop 使用
既有穿价与 gap 规则，同一 OCO 的止损和止盈同时命中时止损优先。它是保守 scenario，不是
K 线内部历史路径。每根 bar 可用数量为 `volume * participation_rate`，按订单接受顺序共享，
超额订单跨 bar 保持 `PARTIAL`。

aggTrade 订单同时满足 `accepted sequence + 1 + latency_events` 与
`accepted event_time + latency_ms` 后才可成交。market 从第一笔满足两道门的 print 开始；limit
只能在后续合格 print 穿价时成交。每个事件可用数量为 `trade qty * participation_rate`，按订单
接受顺序共享。当前不读取 aggressor/maker 标记，因此不推断 maker 身份，也不声称 raw trade、
spread、depth、hidden liquidity 或 queue position。

## 生命周期、TIF 与结束策略

Host 记录追加式 `NEW -> ACCEPTED -> OPEN -> PARTIAL -> FILLED`，并记录 `CANCELLED`、
`EXPIRED`、`REJECTED`。V2 支持 `GTC` 与 `IOC`；IOC 在第一笔合格市场事件后将未成交余量标为
`EXPIRED`。`FOK` 和 `POST_ONLY` 仍拒绝。区间结束策略是身份字段，只允许
`CANCEL_AT_END` 或 `KEEP_OPEN`。

每笔 V2 fill 包含 source kind、sequence、event time 和完整权威市场事件的 SHA-256。BAR fill
只指向权威 BAR，并不因此获得 intrabar 真相；aggTrade fill 只指向权威聚合成交。

## 成本敏感性与报告容量

每个 V2 Run 使用主 Run 已冻结的 Host intents 重放五档：baseline、费用与滑点 +25%、费用与
滑点 +50%、latency +100 ms/+1 event、participation 降为一半。BAR 的 latency 档明确标记
`NOT_APPLICABLE_BAR_CLOCK`。矩阵有独立 hash，不进入主 Run config hash，也不得用于自动调参。

V2 决策使用包含前序 hash 的逐事件链，报告只保留每 100 个市场事件的权益点；两者及采样间隔
都属于新身份。这样百万事件仍保留完整决策计数和可验证最终状态，报告不超过 16 MiB。M6 首次
受控产品基线冻结于 `docs/perf-baselines/backtest-m6-product-20260815.json`；合成数据性能证据
不替代 M10 的真实 aggTrade 与发布证据。

## 后果

所有账户和成交仍由 Host/Decimal 账本拥有。没有数据库 migration；报告 schema 维持 v1，新增
字段均为 additive，旧报告读取不变。所有 backtest 生产 flags 和前端入口继续默认关闭。回滚为
revert 独立 M6 commit，不改写任何历史 Run。
