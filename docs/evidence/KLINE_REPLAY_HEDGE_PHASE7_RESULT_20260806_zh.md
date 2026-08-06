# K 线回放 HEDGE Phase 7 完成证据：API、右栏、报告与默认体验

日期：2026-08-06

分支：`codex/replay-hedge-exchange-parity`

计划：[`KLINE_REPLAY_HEDGE_PHASE7_PLAN_20260806_zh.md`](KLINE_REPLAY_HEDGE_PHASE7_PLAN_20260806_zh.md)

## 1. 完成结论

Phase 7 已完成。K 线回放入口、HEDGE 创建、历史盘口和账户历史在代码默认值中直接启用；前端不再依赖 `VITE_REPLAY_ENTRY_ENABLED`，也没有为 HEDGE、ISOLATED、历史 funding 或 book-assisted 保留灰色禁用项。若某个 Run 缺少所选数据，具体操作继续按数据合同 fail closed，但产品能力本身不被灰度或默认关闭。

右栏、ReviewMode、报告与 CSV 现在消费同一个公开安全投影。交易所不可获得的保险基金与 ADL 私有状态仍明确标注为确定性模拟，不伪装为历史交易所事实；用户接受的近似没有改变历史 L2、mark/index/rule/funding 等公开输入的固定与校验要求。

## 2. 已实现范围

### 2.1 默认入口与创建合同

- `REPLAY_ENABLED`、`REPLAY_HISTORICAL_BOOK_ENABLED`、`REPLAY_ACCOUNT_HISTORY_ENABLED` 的代码默认值改为 `1`，示例环境和 release acceptance 同步为 hard cutover default-on。
- 删除前端 Vite 入口旗标；实时页始终显示 K 线回放入口，服务端 capability 只决定当前是否可操作及其明确原因。
- 新建 Run 默认 `HEDGE + DETERMINISTIC_SIMULATION`；`ONE_WAY` 仍是显式可选项。
- 清理创建对话框中对 HEDGE/ISOLATED/HISTORICAL_EXACT/BOOK_ASSISTED 的旧 disabled 文案和灰色选项。
- README、backend README、replay README 和环境示例同步说明：无灰度、默认启用、数据缺口按操作 fail closed、保险基金/ADL 为确定性近似。

### 2.2 持续逐腿风险投影

- portfolio 的每条 LONG/SHORT 腿完整投影 quantity、entry、mark、leverage、initial/maintenance margin、risk ratio、liquidation/bankruptcy price、funding、trading/liquidation fees 和 protection orders。
- 把 Phase 5 冻结的 adverse-tick 公式抽为活跃仓位与强平 case 共用的价格计算，避免活跃仓位仍显示 `--`、触发后才计算的合同分裂。
- CROSS 使用共享 equity/maintenance scope；ISOLATED 使用逐腿 wallet、PnL 和 maintenance scope。价格仍按 instrument price tick 和方向确定性取整。
- 真实浏览器 active fixture 同时显示 LONG 2.4 与 SHORT 0.4；LONG 强平/破产价为 `63.1/62.4`，SHORT 为 `352.9/356.6`，LONG 同时显示 stop-loss/take-profit 保护单。

### 2.3 单一强平时间线

- 新增共享 `liquidation_projection`，portfolio、report 和 ReviewMode 使用同一 case → legs → steps → orders → fills / insurance / ADL 结构。
- 时间线展开显示 trigger/final snapshot、逐腿强平/破产/接管价、PARTIAL/FULL step、历史 L2 档位和 `queue_exact=false`、真实 broker order/fill、交易与强平费、保险基金 posting、ADL selection 及 counterparty ledger。
- step 内部 durable plan 不直接暴露给公共 UI；公开 reason 只保留有界 cause，避免 archive id、adapter session id 或内部执行计划进入 DOM/ARIA/报告。
- CSV 按 position、case、leg、step、order、fill、insurance、ADL 输出稳定行；Review 报告复用相同命名和嵌套字段。

### 2.4 严格跨语言协议修复

- Python/TypeScript/golden 同步加入 `HISTORICAL_FEE_POLICY`、`HISTORICAL_FUNDING`、`HISTORICAL_L2`、`SIMULATED_INSURANCE_FUND`、`SIMULATED_ADL_COHORT` 及其 pinned/materialized 状态。
- 修正 Run card nullable Decimal 误用非负正则的问题；破产后的负 equity 可被严格解析，非法 Decimal 仍 fail closed。
- parser 继续拒绝未知 capability、queue-exact 声明和私有字段，未用宽松 JSON 或 silent fallback 绕过合同。

## 3. 真实浏览器验收

使用真实 `ReplayService + SQLite + Decimal`、离线 smoke fixture 和生产构建进行验收：

- 1440×900：document `clientWidth=1440`、`scrollWidth=1440`；侧栏 `clientWidth=446`、`scrollWidth=446`。
- 1024×720：document `clientWidth=1024`、`scrollWidth=1024`；侧栏仍显示且 `clientWidth=446`、`scrollWidth=446`。
- active Run：刷新后仍有两条腿及逐腿强平价/破产价/保护单。
- liquidated Run：周期从 1m 切到 3m 后仍有 Case #2 和全部 8 个 step；刷新后重新打开风险页仍保留 Case #2。
- 强平链路实见：两次 `FULL_LIQUIDATION`、`HISTORICAL_L2_VISIBLE_DEPTH_CONSERVATIVE_V1`、真实 order/fill、保险基金 `LIQUIDATION_FEE_INFLOW` / `BANKRUPTCY_DEFICIT_DEBIT`、ADL candidate 与一条对手方账本。
- production preview 正确加载打包字体，不再出现 worktree 开发服务器因共享 `node_modules` 目录产生的字体 fs 403。

截图保存在本地 QA 产物目录 `output/playwright/hedge-phase7-20260806/.playwright-cli/`；其中生产 active 双腿截图为 `page-2026-08-06T09-27-47-362Z.png`，完整 ADL 展开截图为 `page-2026-08-06T09-15-57-613Z.png`。

## 4. 自动化测试与门禁

- 完整 replay 后端：`877 passed, 2322 deselected, 4 warnings in 155.74s`。
  - 4 个 warning 均为既有 FastAPI `on_event` 弃用提示。
- 前端 replay：`329 passed`。
- Python/TypeScript 黄金协议专项：后端 `90 passed`，前端 `24 passed`。
- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm run build`：通过；仅保留既有 chunk-size warning。
- 修改范围 Ruff format/check：通过。
- Python compileall：通过。
- `git diff --check`：通过。

## 5. 下一阶段边界

Phase 7 已完成默认产品表面和共享公开投影。Phase 8 将针对 command retry、response loss、process kill、SQLite busy/WAL、archive rehydrate 及每个 liquidation 状态转换做故障注入，并要求 reference、optimized、recovered 的最终 hash、幂等键和 fork 父 Run hash 全部一致。
