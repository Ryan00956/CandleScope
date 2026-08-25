# Phase 12 Definition of Done 签署（2026-08-25）

状态约定：PASS / FAIL / ENV_STOP / HOLD。FAIL 与 ENV_STOP 不得写成 PASS。

## 15.1 产品

- [PASS] 用户只看到一个“策略”一级入口（TopBar `/strategy.html`）。
- [PASS] 当前图表和导入数据是同一产品中的两个来源。
- [PASS] 用户可以导入后只看图，不必运行策略。
- [PASS] 普通路径只有脚本、数据、运行和结果。
- [PASS] 高级研究按任务进入，不要求重新配置（launch context）。
- [PASS] /strategy.html 是 canonical URL。
- [PASS] /local.html 与 /backtest.html 兼容。

## 15.2 数据

- [PASS] 两条来源都冻结成 dataset_id + data_epoch + snapshot_hash（Phase 8 测试）。
- [PASS] 本地数据不联网、不插值、不静默换 revision（Phase 7/9）。
- [PASS] 质量、coverage、gap 和 revision 可审计。
- [PASS] 图表、指标、绘图、事件和 Run 使用同一数据身份。
- [PASS] revision 变化立即 stale。

## 15.3 后端

- [PASS] LocalDataRuntime 是唯一写入 owner（Phase 3）。
- [PASS] BacktestRuntime 使用注入的数据服务。
- [PASS] LIVE 本地资料库有真实的本机访问边界（F1–F6）。
- [PASS] LOCAL_OFFLINE network guard 和 API allowlist 继续生效（scoped + 60 min soak）。
- [PASS] 失败启动和 shutdown 无泄漏（offline profile 测试）。

## 15.4 前端

- [PASS] LocalApp/BacktestApp 不再各自维护业务编排（Phase 11）。
- [PASS] 当前 chart-first 快测无回归（test:backtest 121）。
- [PASS] StrategyResearchApp source-neutral。
- [PASS] legacy URL 只做 bootstrap。
- [PASS] flag=0 不增加首屏负担（rollback 测试）。
- [PASS] 多图 cell 状态隔离（既有 chart-first 测试）。

## 15.5 可信度

- [PASS] BAR 数据只声明 BAR_APPROX。
- [PASS] 解释来自决定时结构化证据。
- [PASS] 不可比较 Run 不给方向性结论。
- [PASS] 用户能查看数据版本、质量和执行精度。
- [PASS] 报告不把回测结果描述成真实胜率保证。

## 15.6 发布

- [PASS] scoped tests 通过。
- [FAIL] full backend/frontend tests 通过（后端全量失败簇后挂起；前端 1 个既有 pine-language 失败）。
- [ENV_STOP] browser acceptance 通过（无交互式浏览器 MCP）。
- [PASS] security matrix 通过（F1–F6 + soak 远程 Origin 403）。
- [PASS] LOCAL_OFFLINE 零外网证据通过（guard + soak 711 cycles）。
- [ENV_STOP] 60 分钟 mixed soak 通过（LOCAL_OFFLINE API 60 min PASS；LIVE 图表/导入看图浏览器路径未跑）。
- [PASS] 双旗标 rollback drill 通过（flag=0 隐藏导入、LocalApp 壳、LIVE 不挂载 `/api/v1/local`）。
- [PASS] release manifest 绑定候选 SHA 和证据 hash。
- [PASS] 旧分支只在用户授权后归档（本阶段未归档、未删除、未 merge）。

## 生产资格

HOLD。旗标默认 0。未 push。未 merge。未 deploy。
