# Backtest Chart-first Phase 7 交易解释与自动比较（2026-08-24）

## 结论

Phase 7 状态为 `COMPLETE`。已完成 Run 现在携带有预算、可复算、只含决策时信息的
`TradeExplanationV1`；图表 marker 与交易行可打开同一份结构化证据。普通概览会自动选择最近一个
执行上下文完全一致的已完成 Run，并只在 `comparison_context_hash` 完整相等时显示方向性 delta；完整
比较通过带两个 Run ID 的高级研究 deep-link 打开。

三个新 flag 均默认关闭。本阶段没有启动 Phase 8 自动运行，没有推送、合并、部署或修改生产数据。

## 可验证解释合同

- Python 与 TypeScript 使用同一 `JCS_SHA256_V1` fixture 复算 SHA-256；不安全整数、非法数值或 hash
  不匹配统一降级为 `UNAVAILABLE`，前端不显示未经验证的理由。
- 单条解释预算固定为 64 KiB、64 条条件、128 个变量、128-byte key 与 2 KiB string；按编译器源序和
  变量名序确定性截断，超限为 `PARTIAL` 并保留 omissions。
- Chart Pyne 在决策发生时记录稳定 decision ID、trace ordinal、condition ID、源码行列和白名单变量；
  trace 总预算为 10,000 行 / 1 MiB。checkpoint 恢复后的解释与 hash 保持一致。
- decision、order、fill、trade 和 rejection 使用稳定链接；策略理由与 Host 执行/拒绝理由分开保存。
  provider 不支持解释时诚实返回 `UNAVAILABLE`，不从成交结果反推文本。
- 浏览器真实 Run `bt_9848f731699249aeafbc5bac4461d2fb` 的 explanation 为 `COMPLETE`，捕获 3 条
  decision trace、3 笔 fill 和 1 笔完整 trade。入场证据 hash 为
  `07124898b18a46cd225ca91d0bb1200f49b2eb3cc4f31b7f1fd9e627ea30ccdf`，出场证据 hash 为
  `bb6a3af1ced8d52286bdcf76aa232de73010380b4eb82e5f3db5b1114ef0bf86`。

## 自动比较合同

- `COMPARISON_CONTEXT_V1` 覆盖市场、不可变数据、范围、fidelity、账户、费用/执行、指标版本、provider、
  compiler、runtime、ABI、Host、RNG 和 builder revision；缺字段时 `complete=false`，不得直接比较。
- 最近基线只从早于当前 Run 且 context hash 完全相同的 `COMPLETED` Run 中选取。普通用户无需输入
  Run ID；没有基线或上下文不兼容时显示真实原因，不显示优劣结论。
- `RUN_COMPARE_V3` 在服务端复算净收益、最大回撤、交易数和成本差异。交易对齐只使用
  `TRADE_FINGERPRINT_V2` occurrence-count multiset，不做模糊匹配。
- 当前 Run 与基线 `bt_7c2ae00863644798a6cd01c3eb7089a2` 的 context hash 均为
  `74a48bd4513a71b3a74fda5aa36771008876b6ddfe4a778492dad1414f993f4c`，因此允许直接比较；精确结果为
  净收益 delta `0E-7`、交易数 delta `0`、新增/消失交易 `0/0`。两者 decision/report hash 不同，证明
  比较没有把不同策略 revision 合并成同一 Run。
- 当前 report hash 为 `sha256:879a604a0ea71348d5b5cade60441154c0d33c2a54efc799361899adcfb6eea9`，
  decision hash 为 `sha256:93b998114f9225db3add66cd7a2fff10e675ec0f5fd5f5b841ed6f4db9814b3e`，
  chart hash 为 `sha256:fcaec980917fdbca3e80f28d3c9e6fe5f18809633c1aee01735900d840b17afd`。

## 行情页与高级研究体验

- marker 或交易行激活后，当前 cell 定位到对应 K 线并打开 `TradeExplanationPopover`。弹层显示入场/出场
  `COMPLETE`、策略条件、源码位置、决策时变量，以及 Host 的 `FILLED / NEXT_BAR_OPEN`。
- 普通概览增加“与最近一次相同条件运行对比”，只显示净收益、最大回撤、交易数与新增/消失交易，
  延续 Phase 6 的卡片、间距、颜色、圆角和 fixed bottom panel。
- “完整对比”打开
  `/backtest.html?run=bt_9848f731699249aeafbc5bac4461d2fb&compare=bt_7c2ae00863644798a6cd01c3eb7089a2`；
  高级页自动选择两个 Run 并展示 `RUN_COMPARE_V3`，无需再次手工输入 ID。
- 真实浏览器首次打开策略面板发现内联 `onOpenPanel` 每次 render 改变身份，引发 React 最大更新深度；
  改为稳定 `useCallback` 并增加源码合同回归。首次真实 Run validate 还暴露 API schema 未接受 `symbol`，
  补齐有界字段及 Pydantic 回归后，真实 Run 全链路成功。

## 真实浏览器与视觉证据

仓库内 Playwright CLI 驱动 headed Chrome，viewport 为 1440×900；Vite 使用临时端口 15179，后端是
18089 上的隔离 `LOCAL_OFFLINE` runtime。Playwright 只为主行情 BTCUSDT 1h history/latest 返回同一真实
Run chart 的 60 根 K 线，revision/resolve/smoke/validate/create/poll/report/chart/comparison API 均未拦截。

为了在隔离浏览器数据库中构造“最近且更早”的兼容基线，测试准备步骤只修改临时文件
`output/phase7-browser-runtime/backtest.db` 中基线 Run 的 `created_at_ms`，不修改仓库 fixture、生产数据或
Run payload/hash。主行情以外的插件、盘口和 WebSocket 在 LOCAL_OFFLINE 下按合同失败关闭；console
因此有预期 error/warning，没有声称 clean console。

Phase 6 完成态参考与 Phase 7 普通比较态已在同一个 2880×900 输入中并排检查。新增比较卡保持既有
设计系统，未发现新增裁切、错误边距、层级冲突或横向溢出；解释弹层在行情页结果区内有界滚动。高级
legacy 工作台本身仍是密集表单，其整体视觉重构不属于 Phase 7；本阶段只验证 deep-link 自动载入双 Run。

| 资产 | SHA-256 |
| --- | --- |
| [普通概览自动比较](backtest-chart-first-phase7/comparison-1440x900.png) | `c4b2e03814fe27205b2f3c563589bcc14a683ea6b1fa47bbb9219761bff41c19` |
| [交易解释弹层](backtest-chart-first-phase7/trade-explanation-1440x900.png) | `237b078073345f326b52c5d15635d87eb98e0fec371e85ef5f4441c3b70a480f` |
| [高级页双 Run 对比](backtest-chart-first-phase7/advanced-comparison-1440x900.png) | `df84285838a10e60b767b66b0ceafbee3ad4b1e0ca0228f6224a4e6f626b7756` |
| [Phase 6 参考与 Phase 7 实现并排](backtest-chart-first-phase7/reference-vs-actual.png) | `27f7566e5d459382172c5d4a083c3d15411dec390b4d62d4e033b3175eee06b6` |

## 自动化门禁

| 验证 | 结果 |
| --- | --- |
| 后端 backtest 全量 pytest | PASS，234 tests，0 fail；4 条既有 FastAPI deprecation warning |
| `npm run test:backtest` | PASS，88 tests / 3 suites，0 fail |
| `npm test` | PASS，3,365 tests / 3 suites，0 fail，145.58 s |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS，全仓 ESLint |
| `npm run check:i18n` | PASS，3,747 catalog keys / 610 source files |
| `npm run check:architecture` | PASS，0 migration allowlist entries |
| Python Black / Ruff（变更文件） | PASS，8 files unchanged / 0 issue |
| 默认 flag-off `npm run build` | PASS，649 modules；既有 >500 kB chunk warning |
| 显式 flag-on `npm run build` | PASS，649 modules；既有 >500 kB chunk warning |
| `git diff --check` | PASS |

额外尝试运行整个 backend 仓库时，在约 44% 遇到两个 `LOCAL_OFFLINE` 子进程用例失败；原因是该手工
命令的 `PYTHONPATH` 漏掉仓库内 `candlescope-plugin-sdk/src`，不是产品回归。加入正确的仓库 SDK 路径后，
这两个用例 2/2 通过；Phase 7 的 234 项后端覆盖集始终全绿。

## 退出标准与回滚

- 支持解释的 trade/fill/rejection 均可追到结构化决策证据：PASS（浏览器 trade，自动化覆盖 rejection）。
- JCS 跨语言复算、预算截断、非法/hash mismatch、checkpoint 和未知 provider 降级：PASS。
- 最近兼容基线、完整 context gate、V2 fingerprint 多重集差与汇总安全比较：PASS。
- 普通用户无需选择 Run ID，高级 deep-link 保持权威 Run 重读：PASS。
- 所有新 flag 默认关闭：PASS。

回滚可关闭三个前端 flag 和后端解释 flag，或 revert 本阶段单提交；底层不可变 Run 与基础 Phase 6 结果
继续保留，不删除用户数据。Phase 8 尚未开始。
