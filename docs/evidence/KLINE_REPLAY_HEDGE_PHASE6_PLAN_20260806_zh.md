# K 线回放 HEDGE Phase 6 执行计划（2026-08-06）

## 背景审计

Phase 3 已能验证、pin 和逐时重建 Binance USD-M diff-depth archive，Phase 5 已把强平拆成 durable state machine 并绑定真实 broker order/fill。但 Phase 6 开始前，L2 与成交仍是两条分离链路：

1. `HistoricalBookProjection` 只写入 `replay_historical_book_projection` 供 capability/UI/report 查询，没有进入 broker execution；
2. liquidation 仍发送普通 `CLOSE_POSITION`，TOUCH_OR_TAPE broker 按当前 mark/slippage 一次填满，`replay_training_liquidation_fill.book_level` 永远为 NULL；
3. projection 固定截断 20 档，即使 archive 保存了更多已验证深度，也无法证明大额强平的 depth coverage；
4. 全局推进预先重建 target book，只在整个 target 完成后提交；中途 mark/funding/risk wave 触发强平时没有同一 wave time 的 committed book；
5. depth 不足、book price 不符合 tick/filter 时没有独立 fail-closed 分支；
6. liquidation order/fill 没有保存 archive、book hash、last update id、执行计划 hash 和 queue fidelity；
7. 快进 planner 已把 BOOK、OPEN_POSITION、ACCOUNT_RISK 视为 path dependency，但还没有用真实强平用例证明“请求优化时强制 reference scan”与逐步执行最终 account/liquidation/report hash 一致。

## 冻结实现决策

- HEDGE liquidation 只允许 `BOOK_ASSISTED_REQUIRED`；没有 READY、同 virtual time、连续且 checksum 有效的 pinned projection 时 fail closed，绝不调用普通 `CLOSE_POSITION`。
- 每个全局 risk wave 在应用 mark/funding、执行风险检测之前，重建并提交该 wave 的 book projection；不得使用 target-time 未来盘口或上一个 wave 的陈旧盘口。
- execution side 为 SELL 时按 bids 价格降序、BUY 时按 asks 价格升序消费；每档最多消费可见 quantity，直到精确达到 durable step quantity。
- archive 可用深度上限与已验证 `max_depth_levels <= 5000` 一致；不再用 20 档展示截断限制强平。产品仍披露 `queue_exact=false`，模型命名固定为 `HISTORICAL_L2_VISIBLE_DEPTH_CONSERVATIVE_V1`。
- book 为空、单边为空、as-of 不一致、价格非正/重复/乱序、price tick 冲突、quantity 非正、可见深度不足或计划总量不等于 step quantity，生成 durable `FAILED_CLOSED` step；已提交的前序 fill 不回滚、不重复。
- 新增 training-owned book execution proof，固定 archive id、as-of、last update id、book hash、side、requested/visible quantity、levels、execution plan hash、fidelity 和 queue_exact。
- broker 新增仅训练内部可调用的 historical-book close command：一张 reduce-only MARKET order 按冻结 levels 生成多个真实 fills；外部 replay.v1/v3 不能直接提交该命令。
- broker order/fill 仍进入原 checkpoint、command receipt、position、ledger 和 state hash；training liquidation fill 逐条校验 price/quantity/sequence 与 durable book plan，并写 `book_level`。
- 快进只要存在 BOOK、position、funding、risk、insurance 或 ADL 路径依赖，就必须选 `FULL_EVENT_SCAN`。所谓 optimized request 不得越过 liquidation wave；测试比较请求优化的 advance 与逐事件 reference 的 account/liquidation/report hash。

## 实施顺序

1. schema v18：新增 liquidation book execution proof，并将其接入 portfolio/report/Review fork/hash。
2. 扩展 historical book projection，保存 archive 已验证的全部可见深度；全局时钟改为逐 wave commit book。
3. 在 liquidation step plan 中冻结 L2 consumption plan；累计扣除同 case/track/book 已被前序强平 fill 消耗的深度。
4. 新增 internal broker historical-book close，产生单 order、多 fill、真实 position/fee/ledger mutation。
5. `_reconcile_liquidations` 强制使用内部 L2 命令；普通 mark close 从 HEDGE liquidation 路径删除。
6. `commit_liquidation_execution` 验证 broker receipt 与 book plan 一致，写 proof/book level；后续 plan 失败转 durable `FAILED_CLOSED`，不回滚已执行强平。
7. 扩展 auditor 与 projection hash，验证 proof、fills、book levels、quantity sum、VWAP、queue disclosure 和 source identity。
8. 增加 Phase 6 专项测试：多档 partial fills、双腿方向、depth exhaustion、tick/filter conflict、book 缺失/gap、幂等恢复、优化请求/reference hash 等价。
9. 运行专项、完整 replay backend、frontend replay/typecheck/lint/build、Ruff/compile/diff gate，记录结果并独立提交。

## 完成门槛

- HEDGE liquidation 的每个真实 fill 都有非空 book level 和同 wave book proof；
- 无 book、陈旧 book、gap、深度不足或 filter 冲突均 `FAILED_CLOSED/PAUSED`，不存在 Touch/Tape fallback；
- 单 order 可产生多档 fills，filled/remaining/VWAP 与 position/ledger 精确一致；
- `queue_exact` 始终为 false，产品不声明历史排队精确；
- 优化开启时，任何 liquidation 路径仍走逐事件 reference scan，最终 account/liquidation/report hash 与显式逐步执行一致；
- 旧 ONE_WAY/非 HEDGE broker 行为不回归。
