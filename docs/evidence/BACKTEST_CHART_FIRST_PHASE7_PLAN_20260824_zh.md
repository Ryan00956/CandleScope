# Backtest Chart-First Phase 7 执行计划（2026-08-24）

## 阶段边界

- 只实现执行文档 Phase 7：用 Run 内决策时证据解释交易，并在相同执行环境下与最近兼容 Run 做精确对比。
- 不提前实现 Phase 8 的参数扫描、Phase 9 的跨标的研究或任何自动调参编排。
- 后端 `BACKTEST_TRADE_EXPLANATION_ENABLED`、前端 `VITE_CHART_TRADE_EXPLANATION_ENABLED` 与 `VITE_CHART_RUN_COMPARE_ENABLED` 全部默认关闭；不推送、不合并、不部署、不修改生产数据。

## 仓库复用结论

- 复用现有 Chart Pyne 冻结语法树和 provider 决策时状态，在执行当刻生成有界白名单证据；不从成交结果反推策略理由。
- 复用订单、成交、拒绝和 round-trip trade 报告链路，补齐稳定 `decision_id`、`fill_id` 与 `TRADE_FINGERPRINT_V2`，不修改核心撮合语义。
- 复用现有 `ExternalMarkerSource` 与交易虚拟列表；marker 或交易行激活后在当前 cell 的结果区打开解释浮层。
- 复用现有 Run 对比 API 和高级研究页；升级为 `RUN_COMPARE_V3`，普通图表只显示兼容基线的核心摘要，高级页承载完整差异。
- 视觉实现只扩展既有结果上下文条、指标卡、表格与弹层样式，不引入新的颜色、字体、圆角或图标体系。

## 实现契约

1. `TRADE_EXPLANATION_V1` 只含决策时可见字段；对象除 `evidenceHash` 外按 `JCS_SHA256_V1` 规范化并计算小写 SHA-256，Python 与 TypeScript 用同一 fixture 复算一致。
2. 解释预算固定为 64 KiB、64 条条件、128 个变量、128-byte key 与 2 KiB string；按编译器源序和变量名序确定性裁剪，超限为 `PARTIAL` 并报告 omissions。
3. 非法字段、非有限数、不安全整数或 hash 不匹配统一降级为 `UNAVAILABLE`，前端不得展示未经验证的理由；不支持结构化解释的 provider 同样诚实返回 `UNAVAILABLE`。
4. Chart Pyne 为条件提供稳定 condition ID、源行/列和白名单变量，provider trace 有稳定 ordinal 与有界丢弃计数；checkpoint 恢复后输出、解释和 hash 不变。
5. 每个 order/fill/trade/rejection 都通过稳定 decision/order/fill 链接关联解释；成交 ID 按订单内出现次数生成，拒绝原因与策略原因分栏显示。
6. `comparison_context_hash` 覆盖市场/数据快照/范围/精度/账户/费用与执行模型/指标版本/provider-compiler-runtime-ABI-Host/RNG/builder 修订；策略源码、策略 revision 与参数不计入环境 hash。
7. 最近基线只从已完成且 context hash 完全相同的 Run 中选取；不兼容或无基线时不显示方向性优劣结论。
8. `RUN_COMPARE_V3` 服务端重算净收益、最大回撤、交易数和成本差异，并用 `TRADE_FINGERPRINT_V2` 的 occurrence-count multiset 精确计算新增/移除交易；同一时刻多动作保持重数。
9. 普通结果概览只显示净收益、最大回撤、交易数与新增/移除摘要；完整对比通过带 current/baseline Run 的高级研究深链打开。
10. 解释和对比分别由三个严格显式开启的 feature flag 控制；关闭时不请求、不显示，现有 Run 创建与 Phase 6 结果投影保持不变。

## 验证与证据

- 后端：JCS 跨语言 fixture、预算裁剪、非法/hash mismatch、checkpoint、entry/exit/reverse/rejection、未知 provider、context hash、最近基线、指标重算与 fingerprint 重数。
- 前端：解释验证与降级、marker/交易行激活、COMPLETE/PARTIAL/UNAVAILABLE、兼容/不兼容对比、普通摘要与高级深链、各 flag 默认关闭。
- 回归：backtest 专项、完整前端测试、类型检查、lint、architecture、i18n、默认关/显式开构建、相关后端测试。
- 浏览器：仓库内 Playwright CLI + headed Chrome；创建两个真实且兼容的本地 Run，验证解释、拒绝/成交来源、最近基线摘要、高级深链、刷新稳定性与 feature flag 关闭状态。
- 视觉：把 Phase 0 参考图与 Phase 7 实现截图放入同一比较输入，在相同 viewport/state 下检查弹层层级、文本截断、指标密度与小屏溢出并修正。
- 最终证据写入 `docs/evidence/backtest-chart-first-phase7/`、Phase 7 结果 Markdown 和机器可读 JSON，再做窄提交。
