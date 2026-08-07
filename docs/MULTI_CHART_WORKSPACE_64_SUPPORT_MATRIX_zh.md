# CandleScope 四窗口 64 图支持矩阵

状态：**实现候选已验证；尚未发布支持**。默认容量 flags 保持关闭，等待四个真实显示器验收和独立 release review。

| 维度 | 已验证范围 | 状态 | 不在声明内 |
|---|---|---|---|
| 操作系统 | Windows x64 | 实现 PASS | macOS、Linux |
| 桌面壳 | Electron 43.3，四个原生 `BrowserWindow`，一个 sidecar | 实现 PASS | 浏览器弹窗模拟四窗口 |
| 窗口/图表 | 4 窗口 × 16 Cell = 64 Cell | 实现 PASS | 第 65 Cell；五个或更多窗口 |
| 显示器 | 单显示器上的四个真实原生窗口；越界回收 | 实现 PASS | 四块物理显示器拔插与真实混合 DPI 尚待硬件验收 |
| 市场 | Binance Spot、USDT 交易对 | PASS | Futures、OKX 及其他交易所的 64 图容量 |
| 周期 | `1m` | PASS | 其他周期组合的 64 图容量 |
| 指标 | 每 Cell 两个 local builtin：MA20、RSI14，共 128 定义 | PASS | hosted、community、Pine/Pyne 远端运行时 |
| 数据状态 | 冻结 warm SQLite + 冻结 symbol catalog；运行时逐项健康筛选 | PASS | 无网络且从未缓存的 cold 数据集 |
| K 线传输 | 每窗口一个 batch WS；全局 4 个物理浏览器 WS、64 logical clients/series/leases | PASS | legacy per-Cell 路径的 64 图声明 |
| 容错 | exchange/proxy/HTTP 429、sidecar 重启、单窗口崩溃与同 ID 恢复 | PASS | 整机掉电、磁盘损坏 |
| 数据恢复 | 同一 Chromium profile 的 64 → 16 → 4，v6 64-Cell 与 v5 sentinel 不删除 | PASS | schema 降写或主动删除旧 store |
| 打包 | Windows unpacked validation candidate，两次 fresh process | PASS | 安装器、自动更新、已发布签名制品 |

## 量化证据摘要

- W3：ready `4363 ms`、输入 p95 `3.2 ms`、event-loop p99 `28 ms`、long task `0/min`，closed K 线 `61/61/61` 精确一致。
- 精确 4 小时 soak：输入 p95 `101.3 ms`、全局 long task `12.948/min`、焦点 `0.033/min`、event-loop p99 `68 ms`；`14,906 sent = received = committed`，0 静默失败。
- 内存：heap 30 分钟 `-3.365%`、sidecar private 1 小时 `3.315%`；heap/renderer/sidecar retained low-watermark 分别 `1.083%/1.031%/-1.447%`，均非单调增长。
- 当前代码 package：两次 fresh process ready `4114/4343 ms`，使用不同 profile 和不同 sidecar PID；结果 `pass`。
- 完整门：前端 architecture/plugins/typecheck/lint/tests/desktop/build 全部 0 退出；后端 `3121 passed, 31 failed, 8 errors`，39 个非通过节点与 Phase 0 既有 allowlist 完全一致，新增失败为 0。

机器证据：`docs/perf-baselines/multi-chart-workspace/phase8-release-20260807.json`。聚合结果为 `implementation-pass-hardware-and-review-pending`，不是 release `pass`。

发布边界：只有 machine-readable Phase 8 release evidence 为 `pass`，且默认 flag 经独立审核后，才能把“四屏 64 图”称为发布支持。当前单显示器证据只允许表述为“四窗口 64 图实现候选通过，四物理屏硬件门待完成”。
