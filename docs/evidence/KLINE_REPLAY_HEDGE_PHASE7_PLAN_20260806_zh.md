# K 线回放 HEDGE Phase 7 执行计划（2026-08-06）

## 背景审计

Phase 1–6 已把 HEDGE、逐腿保证金、pinned 公开输入、资金费、完整强平、保险基金、ADL 与历史 L2 成交证据落到权威关系表和账户投影中。但 Phase 7 开始前，产品表面仍停留在旧合同：

1. 新建 Run 的数据模型已默认 `HEDGE + DETERMINISTIC_SIMULATION`，后端省略 `position_mode` 也已默认 HEDGE；创建对话框却仍显示“首版仅支持近似账户、全仓、资金费关闭和 Touch/Tape”，并用 disabled option 表达旧限制；
2. HEDGE 的 `ISOLATED`、pinned historical funding 和 `BOOK_ASSISTED_REQUIRED` 后端路径已经可用，前端没有把“可选、按数据合同 fail closed”与“功能被禁用”清楚区分；
3. `replay_training_position_leg` 已保存逐腿 quantity、entry、mark、leverage、initial/maintenance margin、liquidation/bankruptcy price、funding、fees 与 protection，但 portfolio position 只投影其中一部分；右栏强平价仍写死为 `--`；
4. portfolio 已包含 liquidation case、legs、steps、orders、fills、insurance postings、ADL events 和 L2 proof，但前端把整个时间线当作任意 JSON，风险页只显示 case 数量；ADL selection/counterparty posting 没有嵌套在对应 step；
5. ReviewMode 与 portfolio 分别手写两套 liquidation projection，顶层分别使用 `liquidation_id` 和 `case_id`，字段不一致；报告 JSON 虽携带 modelled account，CSV 只导出强平 case 数量；
6. 顶栏入口仍受 `VITE_REPLAY_ENTRY_ENABLED` 控制，未设置时隐藏；后端 `REPLAY_ENABLED` 的代码默认值仍为 `0`。这与“正常构建默认可见、默认启用、无灰度”的产品合同冲突；
7. 现有严格解析器会拒绝后端已经返回的 `liquidation_recoveries` 字段，说明真实 API 与前端 fixture 尚未通过同一个端到端合同收敛；
8. 当前右栏已按 `track_id + position_side` 分卡片并正确提交逐腿命令，可在此基础上扩展，无需引入第二套 HEDGE UI 或运行时开关。

## 冻结实现决策

- 新 Run 默认保持 `HEDGE + DETERMINISTIC_SIMULATION + CROSS`；`ONE_WAY` 仅在用户主动选择时进入旧账户数据选项。
- HEDGE 账户数据选择器只展示唯一合法的 `DETERMINISTIC_SIMULATION`，不展示灰掉的旧 `APPROX_PROXY/HISTORICAL_EXACT`；这不把历史私有账户伪装为 exact。historical exact funding 与 historical L2 继续作为 pinned 公开输入能力，可选择但在具体 dataset 不满足时 fail closed。
- `ISOLATED`、funding 和 book 控件不因 HEDGE 被 disabled。仅与明确练习模式有关的 `SANDBOX_FIXED` 约束继续通过合法选项集合表达，不作为 HEDGE 功能灰度。
- 定义一套公开安全的 liquidation timeline 合同，portfolio、ReviewMode、报告 JSON、CSV 和右栏统一使用 `case_id -> legs -> steps -> orders -> fills / insurance_postings / adl_events` 命名和层级。
- liquidation timeline 不暴露 archive path、actual market time 或未来数据；L2 只投影 virtual time、visible levels、proof hash 和 `queue_exact=false`。
- portfolio position 直接投影权威 leg 字段；前端严格解析 quantity、entry、mark、leverage、initial/maintenance margin、liquidation/bankruptcy price、funding、fee 与 protection，不从 `hedge_state` 任意 JSON 临时猜字段。
- 前端入口始终渲染并向后端查询 capability；数据不可用显示原因，但不再存在 Vite 隐藏开关。后端 replay 默认启用，显式 `REPLAY_ENABLED=0` 暂保留为整个旧版构建的运维停止手段，Phase 10 再按硬切换发布合同清理旧回滚脚本和文档。
- 所有产品文案固定披露“交易所规则级确定性模拟”；insurance/ADL 不得称为历史交易所 exact。

## 实施顺序

1. 新增后端共享 liquidation public projection，统一 portfolio 与 ReviewMode 的字段、嵌套 ADL selection/counterparty ledger，并过滤 recovery case 到独立 `liquidation_recoveries`。
2. 扩展 portfolio 逐腿 position 投影，加入 liquidation/bankruptcy price、accumulated funding、fees 和 protection；报告继续复用同一 modelled account。
3. 把前端 portfolio position 与 liquidation timeline 升级为严格类型和 fail-closed parser；同时接受并解析 recovery timeline。
4. 更新右栏双腿卡片，逐腿显示 quantity、entry、mark、leverage、IM、MM、liquidation/bankruptcy price、funding 和保护单。
5. 实现强平时间线 UI，展开显示 case、legs、partial/full steps、orders、fills、费用、insurance、ADL 与 L2 fidelity。
6. 在 ReviewMode 报告区复用同一 timeline 展示；CSV 为 position/case/leg/step/order/fill/insurance/ADL 分别输出稳定行。
7. 清理创建对话框旧 disabled/stale 文案，保持 HEDGE 默认且 ONE_WAY 显式可选；加入受支持组合与无灰项测试。
8. 移除 `VITE_REPLAY_ENTRY_ENABLED` 入口依赖并把后端代码默认改为 enabled；更新 capability/入口测试，确保 unavailable 是可见的 disabled reason 而不是隐藏。
9. 增加 Phase 7 前后端专项测试：严格 parser、双腿字段、timeline 同构、CSV、Review、入口默认、刷新/切换保留，以及 1440×900/最小尺寸结构无横向裁切合同。
10. 运行专项、完整 replay backend、frontend replay/typecheck/lint/build、Ruff/compile/diff gate，记录结果并独立提交。

## 完成门槛

- 不设置任何前端入口环境变量时，顶栏显示 K 线回放入口；后端无 `REPLAY_ENABLED` 时 capability 为 enabled；
- 新建 Run 首屏默认 HEDGE，ONE_WAY 可主动选择；HEDGE 不再出现 exact/isolated/funding/book 的灰色旧限制；
- 同一 track 的 LONG/SHORT 分别完整显示逐腿风险、资金费和保护字段，刷新及 symbol/interval 切换不串腿；
- 右栏、ReviewMode、报告 JSON 和 CSV 对 liquidation case 使用相同命名与嵌套，包含全部 order/fill/fee/insurance/ADL 证据；
- strict parser 对未知、缺失、非规范十进制和错误枚举 fail closed；
- 1440×900 与产品最小尺寸下，右栏和时间线使用内部滚动/折叠，不产生页面级横向裁切；
- UI 不显示 archive path、actual market time 或未揭示未来时间；
- 不新增 HEDGE 灰度、实验比例、双引擎或默认关闭开关，ONE_WAY 与既有非 HEDGE 行为不回归。
