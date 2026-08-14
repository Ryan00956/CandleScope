# Backtest 成熟化 M6 验收结果

M6「成交真实性 V2」已在 `461ed7bf59eb082a83b96ce0b4fbc815dbb845c5` 基线上实现并通过
阶段门禁，等待本阶段独立本地 commit。实现身份为 `EXECUTION_REALISM_V2`；未声明该身份的
BAR/TRADE Run 保持 V1 路径和 golden hash。

## 已实现

- BAR：冻结 `OHLC_WORST_CASE_STOP_FIRST_V1`，按 `bar volume * participation` 共享容量，
  大订单跨 K 线部分成交；不把 OHLC path 写成历史事实。
- aggTrade：同时执行毫秒和事件数 latency，按 `trade qty * participation` 共享容量；market、
  limit、stop 只能使用 latency 后的合格 print；每个 fill 绑定权威事件 SHA-256。
- 生命周期：`NEW/ACCEPTED/OPEN/PARTIAL/FILLED/CANCELLED/EXPIRED/REJECTED`，新增 IOC；
  FOK/POST_ONLY 仍失败关闭。结束残单策略冻结为 `CANCEL_AT_END` 或 `KEEP_OPEN`。
- 报告/UI：展示 fill policy、假设边界、源事件、生命周期、部分成交、K 线标记、权益曲线和
  五档成本敏感性。敏感性重放冻结 Host intents，有独立 matrix hash，不进入主 config hash。
- 百万事件容量：V2 使用逐事件 decision hash chain 和身份内每 100 事件权益采样，使完整产品
  报告保持在 16 MiB 上限内；没有把私有 `_match` 微基准当作证据。

## 验收

- 后端 M6 focused/public Runtime：`8 passed`；兼容修复定向：`11 passed`。
- 后端相关回归：`180 passed, 3576 deselected`；合同/release/rollback：`34 passed`。
- Ruff check/format、`git diff --check`：PASS。
- 前端 typecheck、全量 ESLint、8 个 backtest tests：PASS；前端全量 `3249 passed`；build PASS，
  仅保留既有 `live` chunk 大于 500 kB warning。
- 真实浏览器：loopback 页面与真实 FastAPI/SQLite Run；7 个跨 K 部分 fill、7/7 权威 BAR
  trace、6 次 PARTIAL 后 FILLED、五档敏感性、K 线和权益曲线均可见；0 console error，2 个既有
  CSS `slider-vertical` warning。
- 正式隔离百万 aggTrade 产品路径：`1,000,000` decisions、`2,000` partial fills、五档矩阵、
  Decimal ledger、SQLite report write；`267.823335 s / 3733.805 events/s / 481091584 B RSS`，
  通过冻结的 `2300 events/s / 430 s / 768 MiB` 门槛。
- 浏览器 SQLite：`quick_check=ok`、foreign key violation `0`。所有生产 flags 仍默认关闭。

## 边界

BAR 只实现一个明确命名的保守 scenario；BAR latency 档明确为 `NOT_APPLICABLE_BAR_CLOCK`。
aggTrade 不使用 aggressor/maker 标记，不声明 raw trade、spread、depth、hidden liquidity 或 queue
position。M6 性能 fixture 是确定性合成数据，只证明产品路径容量；真实归档性能、checkpoint 故障
注入、长稳与 clean-SHA release evidence 属于 M10。本阶段无数据库 migration、无生产启用、无
merge/push。
