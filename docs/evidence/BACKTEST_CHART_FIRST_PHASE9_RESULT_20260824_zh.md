# Backtest Chart-first Phase 9 共享行情图表平台（2026-08-24）

## 结论

Phase 9 状态为 `COMPLETE`。普通行情页的生产 `LiveChartCell` 已经通过
`createLiveReferenceSource -> MarketChartSurface` 使用共享图表平台；高级研究可直接创建
`LIVE_REFERENCE`、`FROZEN_SNAPSHOT` 或 `RUN_RESULT` source，不需要 import `LiveChartCell`、回测 UI 或
workspace store。

本阶段没有新增产品 flag，也没有默认开启任何后续高级研究能力；未推送、合并、部署或修改生产数据。

## 实现合同

- `MarketChartSourceRuntime` 冻结三种 mode：`LIVE_REFERENCE`、`FROZEN_SNAPSHOT`、`RUN_RESULT`，并提供
  ACTIVE/PAUSED/DISPOSED 生命周期、描述信息和显式 execution identity。
- LIVE adapter 只包装现有 `useMarketDataRuntime`，不创建 REST、WebSocket、cache 或第二套行情客户端；其
  `executionIdentity=null`，`assertExecutableMarketChartSource` 会以
  `LIVE_REFERENCE_IS_NOT_IMMUTABLE_EXECUTION_INPUT` 失败关闭。
- FROZEN_SNAPSHOT 复制输入 K 线到独立 `SeriesWindowStore`，以 dataset/data epoch/snapshot hash 标识；
  RUN_RESULT 以 Run/config/report/chart hash 标识。两者创建、暂停和恢复均不联网。
- `MarketChartSurface` 从 source 绑定 session、dataset key、series store、loading/meta、分页和 suspension；
  marker、plugin layer、supplemental panes 均为显式输入。现有绘图 readiness 仍由 app 组合层负责。
- `MarketChartSourceSlot` 在切换前 dispose 旧 source 并清空静态 series；React effect guard 防止开发
  StrictMode 的 setup/cleanup/setup 回放提前终止复用 source，同时真实 unmount 下一微任务完成 dispose。
- 架构检查禁止 `market-chart-platform` 直接或 type-only import backtest、replay、app 和 chart-workspace
  产品组合层；平台本身不反向依赖高级研究或回测 UI。

## 浏览器前后对照

仓库内 Playwright CLI 驱动用户批准的 headed Chrome，固定 1440×900。Vite preview 为 15180，隔离
LOCAL_OFFLINE 后端为 18090；history/latest 继续使用 Phase 8 的受控本地 K 线，图表外回测 API 未拦截。

| 指标 | 抽取前 | 抽取后 | 结论 |
| --- | ---: | ---: | --- |
| chart cells | 1 | 1 | 相同 |
| Lightweight Charts | 1 | 1 | 相同 |
| canvas | 9 | 9 | 相同 |
| `.chart-area` | 1 | 1 | 相同 |
| 启动 history 请求 | 1 | 1 | 相同 |
| 启动 latest 请求 | 2 | 2 | 相同 |
| 行情 WebSocket URL | 3 | 3 | 端点集合完全相同 |
| source 诊断属性 | 0 | `LIVE_REFERENCE / ACTIVE` | 新合同可观测 |
| used JS heap（单次诊断） | 28,331,402 B | 27,073,847 B | 无可见增长；不作为长期 leak 结论 |

三条 WebSocket 仍为 order-book、prices 和当前 BTCUSDT Binance spot 的 `klines_multi`；没有新增 socket
或第二个 kline lease。LOCAL_OFFLINE 的 `/debug/capacity` 返回 403，因此没有伪造后端 lease 数；本阶段以
相同端点集合、相同请求拓扑、Host 生命周期测试和 source dispose 测试作为资源证据，正式 16 图与长稳态
lease gate 留在 Phase 12。

同视口拼图已经人工检查：主图、工具栏、侧栏、时间轴、价格轴、间距和边框没有裁切、溢出或层级变化。
盘口区域的“连接中/立即重试”差异来自 LOCAL_OFFLINE WebSocket 的瞬时状态，不是共享 surface 的 DOM 或样式
变化。console 中也保留预期的插件、盘口和 WebSocket 失败关闭，未声称 clean console。

| 资产 | SHA-256 |
| --- | --- |
| [抽取前](backtest-chart-first-phase9/before-1440x900.png) | `5c7aee0d97e9f356aa5025aac1e1e8ce240d2d1afe6a84e0c0bad3bc84d515bb` |
| [抽取后](backtest-chart-first-phase9/after-1440x900.png) | `22419646495aaea447c1f66b110a10b0ae87608e1f54e3abd231115a5b262392` |
| [同屏前后对照](backtest-chart-first-phase9/before-after-1440x900.png) | `3bc72c04fbc5ad5acf7d92542068acea7b5e531e2cfcbfdcd4ebad3e93cdfb20` |

## 自动化门禁

| 验证 | 结果 |
| --- | --- |
| source/runtime 定向测试 | PASS，6 tests，覆盖 live fail-closed、离线冻结、Run 隔离、切换清理、StrictMode、surface 绑定 |
| architecture 脚本与 fixtures | PASS，22 tests，0 migration allowlist entries |
| 完整前端 suite | PASS，3,381 tests，0 fail；使用 Phase 8 隔离 ESLint 工具目录补足共享树缺失的 `@babel/core` |
| TypeScript browser/node configs | PASS |
| 全仓 ESLint | PASS |
| i18n | PASS，3,761 catalog keys / 618 source files |
| 默认 flag-off build | PASS，655 modules；既有 >500 kB chunk warning |
| 显式 chart tester/auto-run/explanation/compare flag-on build | PASS，655 modules；既有 >500 kB chunk warning |
| headed Chrome DOM/request/WS/source/heap 对照 | PASS |

抽取前 flag-off live chunk 为 541.74 kB，最终 flag-off 为 542.09 kB；增加约 0.35 kB，gzip 增加约
0.14 kB。单图运行时 heap 诊断未增长，完整容量策略测试通过；这里不把单次 heap 样本描述为正式 16 图或
长稳态发布资格。

## 退出标准与回滚

- 生产实时页使用共享 adapter：PASS。
- 不存在第二套行情客户端或额外请求/WebSocket：PASS。
- LIVE 不可作为执行输入，FROZEN 离线可读，RUN_RESULT 不受 live 更新影响：PASS。
- source 切换清除旧 store，marker 订阅仍由既有 chart effect 清理，真实 unmount terminal dispose：PASS。
- 平台不反向依赖 backtest/replay/app/workspace：PASS。
- 视觉、DOM 与启动资源拓扑无回归：PASS。

回滚为单提交 revert：`ChartCellCanvas` 恢复直接组合 `SingleChartPanes`，不会删除 Run、workspace、缓存或
Host lease。Phase 10 的高级研究 flag 此时仍不存在或默认关闭。
