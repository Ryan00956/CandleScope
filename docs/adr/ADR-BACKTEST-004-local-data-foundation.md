# ADR-BACKTEST-004：本地不可变数据底座不得整枝合并

- 状态：Accepted
- 日期：2026-08-14
- 基线：`main@5df19ae7`；参考树 `codex/local-offline-mode@d3c2fe37`

## 背景

本地模式分支提供导入、质量、不可变 revision、项目包和整数倍向上重采样，是回测最有价值的数据底座。但该分支落后 main 189 个提交，且工作区混有插件 release / lock / README 噪声。

## 决策

Phase 1 从当前 main 语义移植本地数据能力，禁止整枝 merge。插件版本噪声必须排除。公共接口冻结为 `MarketDatasetSnapshotProvider`。`LOCAL_OFFLINE` 不得因安装回测而自动启动策略 Host。

## 后果

Phase 1 需要逐提交整理和独立回归。回测核心在该底座验收前不得依赖尚未移植的本地文件。
