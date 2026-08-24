# Backtest Chart-first Phase 6 结果投影与可信度闭环（2026-08-24）

## 结论

Phase 6 状态为 `COMPLETE`。一次已完成的不可变 Run 现在可以回到发起它的行情单元格，在固定底部
面板中显示上下文、概览、权益、交易和设置，并把成交标记投影到同一张主图。结果严格绑定
`Run ID + config_hash + report_hash + chart_hash`；切换交易对、周期、数据范围、数据 epoch、策略草稿
或参数后，旧标记在同一状态发布前被清空，ResultContextBar 明确显示“结果已过期”。

本阶段没有开始 Phase 7 的高级研究能力扩展，也没有改变任何默认 flag、生产数据、部署或主工作树。

## 结果身份与缓存

- 后端 chart payload 新增稳定 `chart_hash`，由 canonical JSON 的 SHA-256 生成；同一不可变 Run 重读
  保持完全相同。
- quick Run request 显式保留 `chart_range_mode`，因此 `ALL_AVAILABLE` 可以在报告上下文中准确显示为
  “全部本地可用数据”，同时给出绝对起止时间；界面没有声称“全部历史”。
- 前端 cache 只有在 Run 为 `COMPLETED`、config 可严格解析、Run/report/chart 三者 `run_id` 一致且
  report/chart hash 均存在时才接纳；key 为 `runId|reportHash|chartHash`，错误组合失败关闭。
- 当前浏览器真实 Run 为 `bt_5ebf71207bc04de69fd56c6528c999cb`，report hash 为
  `sha256:feee4412a4995119ffae2c83bf4913bdbdbdec4bfb95dcd622317716ad01377f`，chart hash 为
  `sha256:464a4c13e0710211402b411b6334760db5aa140fa1a22d34b08202204339ebc9`。

## 行情页结果体验

- 底部面板固定四个 tab：脚本、概览、交易、设置。ResultContextBar 固定显示完成/过期、symbol、
  interval、范围和绝对边界、fidelity、费用来源、taker/maker/slippage 以及“可信度详情”深链。
- 概览显示净收益、最大回撤、完整交易、胜率四项；缺失字段为 `—`，零交易与缺失报告均有独立状态，
  不把空值伪装为零。
- 权益曲线从既有 Backtest 结果组件中提取复用；最多确定性采样 2,000 点。
- 交易列表使用 38 px 行高和 6 行 overscan 的虚拟窗口。100,000 笔 fixture 的单元测试验证 DOM 窗口
  有界；点击交易只调用当前单元格的时间锚点与 crosshair 定位。
- 回测标记实现为真实 `ExternalMarkerSource`。只投影可见区加 20 bars/25% overscan，最多 5,000 枚并
  确定性采样；最后源码审查补上 snapshot 引用稳定性，避免未失效时反复触发外部 store 渲染。
- panel 高度和 tab 以 workspace/cell scope 独立保存在本地。浏览器把高度从 383 px 拖到 459 px，
  reload 并重新打开后仍恢复 459 px 与“概览”；cell 2 没有继承 cell 1 的结果。
- “可信度详情”打开 `/backtest.html?run=...`，高级研究页严格接受有界 Run ID 并选中同一 Run、报告
  和 chart；非法 deep link 不进入选择状态。

## 真实浏览器与 API 证据

浏览器为仓库内 Playwright CLI 驱动的 headed Chrome；Vite 为 `127.0.0.1:15178`，后端为隔离的
`LOCAL_OFFLINE` runtime `127.0.0.1:18088`。所有 feature flag 仅对这两个临时进程显式开启。
后端 fixture 含 60 根 BTCUSDT 1h K 线，时间范围为 2024-01-01 00:00:00Z 至
2024-01-03 11:59:59.999Z，准备脚本禁止网络访问。

真实请求顺序中的 revision、resolve、smoke、validate、create、poll、report 与 chart 均返回 200。
Run create request 显式包含 `chart_range_mode=ALL_AVAILABLE`、dataset/data_epoch/snapshot、1h interval、
绝对起止时间，以及 `exchange-market-preset / 10 / 10 / 1 bps` 费用身份。

### 完成、标记、过期与隔离

- 1440×900 完成态显示“全部本地可用数据 · 2024/01/01 08:00 至 2024/01/03 19:59”、快速估算、
  fee source/taker/maker/slippage、四项指标、权益和最近交易。
- 为了让主行情在 `LOCAL_OFFLINE` 下仍可做真实画布验证，Playwright 只拦截 BTCUSDT 1h 的主行情
  history/latest，并把同一真实 Run chart response 作为 60-bar `phase6-playwright-fixture` 返回；其他
  周期继续走后端并诚实失败。该路由没有替换 Run/report/chart API 或其 hash。
- 主图实际渲染三枚标记：`开多 104.0104`、`平多 105.9894`、`开多 100.01`。点击 15m 后，浏览器
  同一动作完成时已得到 `interval=15m / stale=1`，主图进入新上下文且三枚旧标记全部消失；旧汇总仍
  可回看并明确要求重新运行。
- 四图工作区中，cell 1 的 1h 有完成结果，切到 cell 2 的 15m 显示“未附着”且无结果，证明没有跨格
  复制。交易定位动作也只影响当前 cell 1。
- 1366×768 下 document `scrollWidth/clientWidth=1366`、`scrollHeight/clientHeight=768`；459 px
  panel 完整位于 viewport 内，没有页面溢出。

### 截图导出范围

- 页面可见区导出为 2732×1536，包含底部 ResultContextBar 与结果内容。
- 整张图表和主窗格导出均为 1033×357，包含 60 根行情与三枚回测标记，不包含底部结果面板。
- 当前 fixture 只有一个 chart pane，因此“整张图表”和“主窗格”输出逐字节相同，SHA-256 均为
  `97fec4b4cac4ce2caaf3bcc768d46c23ec44fbd6a0e29573ffb225e7a481d55b`；这不是空图或替代证据。

### 环境差异

LOCAL_OFFLINE 对其他周期、插件平台、实时盘口和 WebSocket 按合同失败关闭，浏览器 console 因此有
预期 error/warning；没有把它写成 clean console。首个 Playwright route handler 还因 CLI sandbox 中
没有全局 `URL` 而失败，移除并改成不依赖该全局的 handler 后，受控 1h 路由和全部结果 API 正常。

## 截图与视觉对照

| 资产 | SHA-256 |
| --- | --- |
| [完成态 1440×900](backtest-chart-first-phase6/completed-1440x900.png) | `a7552bc3ac19ee7f477ab5274f170feeacb8a49a2a52771f20f3afeb9532bea1` |
| [完成态 1366×768](backtest-chart-first-phase6/completed-1366x768.png) | `1d5a71881ef4a58c6656f9b3d5c0db79d98c58602b5c78f5eb8839f6c8ed5ebd` |
| [四图 cell 1 真实标记](backtest-chart-first-phase6/four-cell-result-markers-cell1-1440x900.png) | `73df69f1c30580edd2b0481f6987ca48761b959e723de3b1cbcb60e55c149a41` |
| [切换 15m 后标记同帧隐藏](backtest-chart-first-phase6/stale-markers-hidden-1440x900.png) | `ab7e8af4eb9ed79f11a74a5595bf9fdc8d38a6880c62ace160cc1c19e43479d4` |
| [四图结果隔离](backtest-chart-first-phase6/four-cell-isolation-1440x900.png) | `9483e5b34d2e2f172f974338356bf6a125f93865d28c15934c23fab2d8d3af06` |
| [页面导出，包含结果](backtest-chart-first-phase6/export-page-with-results.png) | `7f95fe1e39b97dd6f28953e86b5bf32d18ca4f5037a4d4e4feeadb2b5ff79d74` |
| [整张图表导出，不含结果](backtest-chart-first-phase6/export-chart-with-markers-no-results.png) | `97fec4b4cac4ce2caaf3bcc768d46c23ec44fbd6a0e29573ffb225e7a481d55b` |
| [主窗格导出，不含结果](backtest-chart-first-phase6/export-main-pane-with-markers-no-results.png) | `97fec4b4cac4ce2caaf3bcc768d46c23ec44fbd6a0e29573ffb225e7a481d55b` |

Phase 0 完成/过期参考与 Phase 6 实现图已在同一视觉输入中两轮对照。实现沿用现有 CandleScope
颜色、间距、圆角、tab、panel 和状态体系；完成态绿色、过期态琥珀色、四卡片、权益/最近交易和固定
上下文条与参考目标一致。1366×768 和 1440×900 均未发现裁切、错误边距或布局破坏。

## 自动化门禁

| 验证 | 结果 |
| --- | --- |
| `npm run test:backtest` | PASS，81 tests / 3 suites，0 fail；最终 snapshot 修复后复跑 |
| 后端 Phase 6 focused pytest | PASS，18 tests，0 fail |
| `npm test` | PASS，3,358 tests / 3 suites，0 fail，151.29 s |
| 后端 backtest 全量 pytest | PASS，226 tests，0 fail；4 条既有 FastAPI deprecation warning |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS，全仓 ESLint |
| `npm run check:architecture` | PASS，0 migration allowlist entries |
| `npm run check:i18n` | PASS，3,712 keys / 609 source files |
| 默认 flag-off `npm run build` | PASS，648 modules；既有 >500 kB chunk warning |
| 显式 flag-on `npm run build` | PASS，648 modules；既有 >500 kB chunk warning |
| Python `py_compile` | PASS |
| `git diff --check` | PASS |

flag-off build 的 live entry 为 537.13 kB raw / 155.86 kB gzip；flag-on 同级，Phase 6 bridge chunk
为 59.11 / 17.58 kB。功能继续位于 lazy boundary，默认关闭时不创建结果 runtime 或 marker source。

## 已处理的非通过尝试

1. 提取 `BacktestEquityCurve` 后，M9 源码合同仍只查旧文件，首次 targeted suite 失败；合同改为同时验证
   新组件和旧 re-export 后通过。
2. 首轮 lint/typecheck 暴露 fast-refresh helper、effect 同步 setState、依赖与 nullable store/fixture hash
   问题；拆分 helper、异步发布并收紧类型后全部通过，没有禁用规则。
3. 最终源码审查发现 marker `getSnapshot()` 在无 revision 变化时仍可能返回新数组/对象；新增 revision
   memoization 和 strict identity 回归，81 项回测测试复跑通过。
4. 首个 Playwright 1h fixture route 使用了 CLI sandbox 不提供的全局 `URL`；卸载错误 route 后用稳定
   handler 重装，最终完成真实 chart/marker、过期隐藏和三种导出范围验证。

## 退出标准与回滚

- ResultContextBar、四指标、权益、交易、设置、可信度 deep link：PASS。
- Run/report/chart hash cache 与跨 Run 失败关闭：PASS。
- 标记可见区预算、100k 交易虚拟化、resize/compact viewport：PASS。
- chart context 变化同帧隐藏旧标记且保留 stale 汇总：PASS。
- panel preference 与多图 result/locator 隔离：PASS。
- 页面/整图/主窗格导出范围：PASS。
- 所有相关前后端 flags 继续默认关闭。回滚本阶段单提交或关闭 flag 即不再加载结果投影；已存在的
  不可变 Run 保留在高级研究中，不删除用户数据。

Phase 7 尚未开始。
