# 本地数据与策略研究统一 Phase 8 结果（2026-08-25）

## 结论

Phase 8 通过。IMPORTED_DATASET 与 CURRENT_CHART 在 Run 创建前汇合到 FrozenResearchContextV1。CURRENT_CHART 保持 chart-context resolve/materialize；导入数据只用 preview，不 materialize、不 resolve 在线行情。Run schema 无 source_kind 分叉。结果缓存 key 含 dataset/data_epoch/snapshot。source/revision 变化同一帧 STALE 并隐藏 marker。导入数据强制 BAR_APPROX，UI 不声称成交序列精算。统一页接入 Script/Result 面板。

## 测试

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm.cmd run test:research-data` | 0 | 71 passed |
| `npm.cmd run test:backtest` | 0 | 121 passed |
| `npm.cmd run typecheck` | 0 | 通过 |
| `npm.cmd run check:architecture` | 0 | 0 allowlist |
| `pytest` research_source + contracts + chart_context | 0 | 28 passed |

## 回滚

关闭 `VITE_RESEARCH_DATA_LIBRARY_ENABLED`；CURRENT_CHART 继续现有 chart-context，导入数据回到只看图。
