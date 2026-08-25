# 本地数据与策略研究统一 Phase 5 执行计划（2026-08-25）

## 范围

- source / script / result 三个独立 slice。
- 数据查看不创建 Run。
- VITE_RESEARCH_DATA_LIBRARY_ENABLED 默认 0，关闭时不渲染导入入口。
- revision 变化发出 DATA_REVISION_CHANGED 并在同一更新中使结果 STALE。
- LOCAL_OFFLINE 隐藏可运行 CURRENT_CHART 并给原因。
- malformed localStorage fail-closed。
- 不创建 /strategy.html（Phase 6）。
