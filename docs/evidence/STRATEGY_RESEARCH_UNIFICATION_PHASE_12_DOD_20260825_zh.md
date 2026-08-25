# Phase 12 Definition of Done 签署（2026-08-25）

状态约定：PASS / FAIL / ENV_STOP / HOLD。FAIL 与 ENV_STOP 不得写成 PASS。

## 15.1 产品

- [PASS] 用户只看到一个“策略”一级入口（TopBar `/strategy.html`）。
- [PASS] 当前图表和导入数据是同一产品中的两个来源：行情页承担真实当前图表快测，策略页承担导入数据研究，并提供两者之间的明确跳转。
- [PASS] 用户可以导入后只看图，不必运行策略。
- [PASS] 普通路径只有脚本、数据、运行和结果。
- [PASS] 高级研究按任务进入，不要求重新配置（launch context）。
- [PASS] `/strategy.html` 是 canonical URL。
- [PASS] `/local.html` 与 `/backtest.html` 保持兼容。

## 15.2 数据

- [PASS] 可运行来源均通过后端冻结为 `dataset_id + data_epoch + snapshot_hash`，前端不得伪造 snapshot。
- [PASS] 本地数据不联网、不插值、不静默换 revision。
- [PASS] 质量、coverage、gap 和 revision 可审计。
- [PASS] 图表、指标、绘图、事件和 Run 使用同一数据身份。
- [PASS] revision 或脚本内容变化立即将既有结果标记为 stale。

## 15.3 后端

- [PASS] `LocalDataRuntime` 是唯一写入 owner。
- [PASS] `BacktestRuntime` 使用注入的数据服务。
- [PASS] LIVE 本地资料库具有受信本机访问边界（F1–F6）。
- [PASS] LOCAL_OFFLINE network guard 和 API allowlist 继续生效。
- [PASS] 失败启动和 shutdown 无泄漏。

## 15.4 前端

- [PASS] `LocalApp` / `BacktestApp` 不再各自维护业务编排。
- [PASS] 行情页 chart-first 快测无回归（`test:backtest` 122 passed）。
- [PASS] `/strategy.html?source=current` 不虚构交易所、品种、周期或图表会话；未绑定时明确回到行情页。
- [PASS] 行情页快测绑定真实 `ChartSession`；本次浏览器验收观察到 `BTCUSDT · 1h` 和 1501 根已加载 K 线，这只是本次真实会话，不是策略页硬编码。
- [PASS] React StrictMode rehearsal 不再提前销毁 tester runtime。
- [PASS] legacy URL 只做 bootstrap；flag=0 不增加首屏负担；多图 cell 状态隔离。

## 15.5 可信度

- [PASS] BAR 数据只声明 `BAR_APPROX`。
- [PASS] 解释来自决定时结构化证据。
- [PASS] 不可比较 Run 不给方向性结论。
- [PASS] 用户能查看数据版本、质量和执行精度。
- [PASS] 报告不把回测结果描述成真实胜率保证。

## 15.6 发布

- [PASS] scoped tests 通过：后端策略路径 91、research-data 93、backtest 122。
- [FAIL] full backend/frontend tests 全部通过：前端全量 3481/3481 PASS；后端全量在 2334 passed 后因既有 Phase 1 历史契约漂移失败，另一个顺序相关节点可定向通过。
- [FAIL] full lint 通过：本次变更文件 lint PASS；仓库全量仍有 140 个既有错误。
- [PASS] browser acceptance 通过：LOCAL_OFFLINE 导入、看图、运行、报告闭环；LIVE 真实当前图表与 chart-first tester 绑定闭环；console error 均为 0。
- [PASS] security matrix 通过（F1–F6 与远程 Origin 拒绝）。
- [PASS] LOCAL_OFFLINE 零外网证据通过（guard + 60 分钟 API soak 711 cycles）。
- [ENV_STOP] 60 分钟 mixed browser soak：只完成 60 分钟 LOCAL_OFFLINE API soak；本次 LIVE/LOCAL_OFFLINE 浏览器验收不是 60 分钟持续运行。
- [PASS] 双旗标 rollback drill 通过（flag=0 隐藏导入、恢复兼容壳、LIVE 不挂载 `/api/v1/local`）。
- [PASS] release manifest 绑定候选 SHA、证据 hash，且候选之后只允许 `docs/evidence/*` 变化。
- [PASS] 旧分支未归档、未删除、未 merge。

## 生产资格

**HOLD**。工程路径已修复并完成短时浏览器验收，但全量后端、全量 lint 和 60 分钟 mixed browser soak 尚未全部通过。旗标默认 0；未 push、未 merge、未 deploy。
