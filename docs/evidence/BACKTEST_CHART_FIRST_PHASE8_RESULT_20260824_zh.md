# Backtest Chart-first Phase 8 自动运行、并发与缓存（2026-08-24）

## 结论

Phase 8 状态为 `COMPLETE`。已附着策略的图表在 FAST 模式下会于 chart-session 稳定 600 ms 后自动运行；
同一 cell 只保留最新 generation，全 workspace 最多并发两个自动任务，其余排队。PRECISE、NEEDS_DATA、
unsupported 与后端容量不足均停止自动链路并显示具体原因，不会隐藏下载或无限重试。

`VITE_CHART_STRATEGY_AUTO_RUN_ENABLED` 仍严格默认关闭。本阶段未推送、合并、部署或修改生产数据。

## 实现合同

- 新 attachment 默认 `autoRun=true`，但只有本地 feature flag 显式开启后生效；初始 mount、split/copy 和只切换
  active cell 不形成自动 Run intent。
- `ChartStrategyAutoRunCoordinator` 按 workspace 管理最多 2 个 active 自动任务，按 cell/generation 去重排队；
  手动运行先取消 debounce 与尚未提交的队列任务，并可中止尚未创建后端 Run 的自动 pipeline。
- 每次自动请求冻结 draft、attachment 与 chart-session；600 ms 后再次核对 context key、generation 和 runtime。
  旧响应无法写入新 context。
- 相同不可变 identity 的已完成 Run 由后端幂等键复用，前端直接读取权威 Run/report/chart/comparison，不额外轮询
  已完成 Run。结果缓存仍要求 Run、report、chart hash 和完整 identity 一致。
- 后端容量返回 `RUN_CAPACITY_EXCEEDED`、HTTP 429、`Retry-After: 1` 与 `retryable=true`；自动链路显示暂停，
  不自行无限重试。
- 浏览器四图测试暴露同一 revision 在多个 snapshot 上的 smoke 查询只取“最近一条”，会让旧 snapshot 错误得到
  `SMOKE_REQUIRED`。修复为按 `revision_id + dataset_id + snapshot_hash` 精确查询，并增加回归测试。
- PRECISE 设置页现在明确显示“已开启，精算需手动运行”，与暂停原因一致；自动完成后入口状态同步为“已就绪”。

## 真实浏览器证据

仓库内 Playwright CLI 驱动 headed Chrome，viewport 为 1440×900；Vite preview 使用 15180，隔离
`LOCAL_OFFLINE` 后端使用 18090。backtest revision/resolve/smoke/validate/create/poll/report/chart/comparison
均访问真实后端；Playwright 只为行情 history/latest 提供受控本地 K 线。

- 单图 FAST：稳定后自动创建或复用真实 Run，并显示权威完成结果。最终截图中的 Run 为
  `bt_9848f731699249aeafbc5bac4461d2fb`。
- 快速切换：`2H -> 4H -> 1H` 在 182 ms 内完成，只有最终 1h 形成新 resolve/create pipeline，中间 context
  没有进入结果。
- 四图：四个 session 同时变化时观测到 `maxActive=2`；前两项结束后后两项才开始。干净记录中首批开始于
  `1787550046552/6553`，第二批开始于 `1787550050584/0620`，最大并发始终为 2。
- PRECISE：从 1h 切到 2h 并等待 1.5 s，捕获到的 backtest 请求为 0；面板显示不会自动下载或提交的原因。
- 64 个初始已附着 cell、初始 copy/mount 均由无浏览器依赖的 coordinator 测试证明不产生 intent。

主行情以外的插件、盘口与 WebSocket 在 LOCAL_OFFLINE 下按合同失败关闭，因此 console 存在预期
error/warning，本阶段没有声称 clean console。探索期间曾使用无效的浏览器延迟脚本污染一次统计；证据只采用
清空记录后的上述四图观测。

Phase 7 参考与 Phase 8 完成态使用同一 1440×900 源视口并排检查。自动运行没有引入新的布局层级、裁切、
横向溢出或设计系统偏移；图表可见范围差异来自受控行情 fixture 的当前 viewport，不是 surface 结构变化。

| 资产 | SHA-256 |
| --- | --- |
| [FAST 自动完成态](backtest-chart-first-phase8/auto-completed-1440x900.png) | `888207186c4109b688f05ac59215a06819a91cfc0993e2e00f3912e1faca15fa` |
| [四图并发队列](backtest-chart-first-phase8/four-cell-queue-1440x900.png) | `fc71656fb1c926ce1375718f9f491c223f4ab8826404f89ae1f3337c29ad09d7` |
| [PRECISE 暂停态](backtest-chart-first-phase8/precise-paused-1440x900.png) | `7d0a8a6257520003b6a792ad32d0511c9730e2150a9c41b960b0f3091225b723` |
| [Phase 7 参考与 Phase 8 实现并排](backtest-chart-first-phase8/reference-vs-actual.png) | `bd3b3829b4cb43b6f13d4818cdd914cbda7226f124afea175df8ecf8bafcdd25` |

## 自动化门禁

| 验证 | 结果 |
| --- | --- |
| 后端 backtest 全覆盖集 | PASS，237 tests，0 fail；4 条既有 FastAPI deprecation warning |
| 前端 backtest | PASS，96 tests / 3 suites，0 fail |
| TypeScript browser/node configs | PASS |
| Black / Ruff（变更文件） | PASS |
| 全仓 ESLint | PASS；缺失的 `@babel/core@7.29.7` 从精确 lockfile 安装到忽略目录并通过，不修改共享 node_modules |
| 架构检查 | PASS，0 migration allowlist entries |
| i18n 检查 | PASS，3,761 catalog keys / 611 source files |
| 默认 flag-off build | PASS，650 modules；既有 >500 kB chunk warning |
| 显式 flag-on build | PASS，650 modules；既有 >500 kB chunk warning |
| 完整前端 suite 探索 | 3,372/3,373 product tests PASS；唯一非产品失败为共享依赖树缺 `@babel/core`，隔离补齐后对应 boundaries 5/5 PASS |

额外尝试整个 backend 仓库时，在 53% 的一个 managed-runtime venv 恢复用例耗时过长而人工停止；Phase 8 的
backtest API/service/runtime/snapshot/Study/chart-context 覆盖集 237/237 全绿，未把该探索停止描述为产品失败。

## 退出标准与回滚

- TV-like FAST 自动更新、最终 generation 独占结果：PASS。
- workspace 两并发、其余排队、手动优先：PASS。
- PRECISE/NEEDS_DATA/unsupported 无隐藏下载或提交：PASS。
- 完成 Run identity 精确复用、跨 snapshot smoke 正确：PASS。
- 后端容量可重试且无无限重试：PASS。
- 新 flag 默认关闭：PASS。

回滚可关闭 `VITE_CHART_STRATEGY_AUTO_RUN_ENABLED`，保留手动运行；必要时再关闭整个 chart tester flag。
不可变 Run、workspace attachment 与既有结果均不删除。
