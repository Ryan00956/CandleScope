# 本地数据与策略研究统一 Phase 7 结果（2026-08-25）

## 结论

Phase 7 通过。统一策略页对 IMPORTED_DATASET 复用 LocalKlineApi → SeriesDataFeed → SeriesWindowStore → SingleChartPanes，达到 local.html 图表/分析装配等价：周期聚合、左翻页、range 定位、共享指标、绘图、导出、主题、价格轴、视口与事件均按 `dataset_id + data_epoch` 隔离。CURRENT_CHART 图表仍为槽位（Phase 8）。StrategyResearchApp 是唯一 `useResearchDataLibrary` 所有者。LocalApp 只剩兼容装配。

## 测试

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm.cmd run test:research-data` | 0 | 68 passed（含 local-data） |
| `npm.cmd run test:backtest` | 0 | 118 passed |
| `npm.cmd run typecheck` | 0 | 通过 |
| `npm.cmd run check:architecture` | 0 | 0 allowlist |

网络 allowlist：LocalKlineApi history/before/range 与 local indicator compute 均落在 `/api/v1/local/datasets/...`；`getMultiStreamUrl()` 为空；compute body 不含浏览器 OHLCV。15m→30m/1h/90m 允许，89m 拒绝。VOL 在无 volume 时可见但禁用（既有 catalog 测试）。

浏览器网络面板未在本机有交互式浏览器工具时重跑；等价门禁用 fetch mock 与源码禁止 online kline/stream/indicator 导入。

## 回滚

关闭 `VITE_RESEARCH_DATA_LIBRARY_ENABLED`；`/local.html` 走 LocalApp 兼容装配。`candlescope:local-interval:v1:` / `candlescope:local-analysis:v1:` / `candlescope:local-indicators:v1:` 旧键不变。
