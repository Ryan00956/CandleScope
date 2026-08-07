# CandleScope 64 图回滚 Runbook

## 触发条件

出现任一情况立即停止扩大灰度：64 图 ready p95 超过 8 秒、输入 p95 超过 150 ms、事件循环 p99 超过 100 ms、静默订阅/指标失败、closed/amended 身份不一致、连接或 lease 持续增长、WorkspaceBus 冲突，或四屏窗口无法恢复。

## 回滚顺序

按以下顺序逐层关闭，不删除 Chromium profile、IndexedDB、localStorage 或 SQLite：

1. `MULTI_CHART_64_ENABLED=0`：禁止四窗口 64 图，保留单窗口 16 图。
2. `MULTI_WINDOW_ENABLED=0`：只允许 `main-window`。
3. `MULTI_CHART_16_ENABLED=0`：UI 回到最多 4 Cell。
4. `KLINE_BATCH_STREAM_ENABLED=0`、`CHART_WINDOW_BROKER_ENABLED=0`：回到旧的兼容传输路径。
5. 若仍异常，按 Phase 8 → 1 的提交逆序 revert；不得通过删除用户数据“修复”。

Vite 构建期开关使用对应的 `VITE_` 前缀。桌面主进程开关不带 `VITE_`。每次变更后必须完全退出所有 CandleScope 窗口并确认 sidecar 已停止，再启动目标 build。

## 每层验证

| 层级 | 原生窗口 | 可见 Cell | 必须保留 |
|---|---:|---:|---|
| 64 | 4 | 每窗 16 | v6 文档 64 Cell / 4 Window，v5 sentinel |
| 16 | 1 | 16 | 与 64 层相同的 v6 semantic SHA、v5 SHA |
| 4 | 1 | 4 | 与 64 层相同的 v6 semantic SHA、v5 SHA |

执行：

```powershell
npm --prefix frontend run desktop:rollback:phase8
```

只有 `phase8-flag-rollback-*.json` 为 `pass`，且三个阶段使用同一 `userData`，才算真实回滚。`documentContentSha256` 与 v5 sentinel SHA 必须一致；revision 允许正常关机带来一次单调递增，但不得倒退或重建文档。

## 回滚后检查

- 当前层窗口数和 Cell 数精确匹配；
- 端口无遗留监听，sidecar PID 已退出或被新进程替换；
- WorkspaceBus 无 conflict，保存状态为 `saved`；
- 旧 v6 工作区仍可在重新启用高层 flag 后恢复；
- v5 sentinel 同时存在于 IndexedDB 和 localStorage；
- 不执行数据库清理、store 删除、profile 重置或重新初始化。

重新启用 64 图必须重新跑 W1～W3、F1～F3、4 小时 soak、打包 fresh-process，并取得独立 release review；原有 PASS 不自动跨代码或硬件变更继承。
