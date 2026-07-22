# Plugin Platform v2 性能基线

本目录只保存与 `GENERAL_PLUGIN_PLATFORM_V2_EXECUTION_zh.md` 阶段门绑定的、经过复核的
机器可读基线。临时运行、quick 模式输出和包含用户数据的诊断不得提交到这里。

当前基线：

- `phase0-2026-07-22-windows-amd64.json`：在
  `codex/plugin-platform-v1@400e520a9fa8a816229a5ad64330f10e8de9ddaf` 上采集的
  Phase 0 Windows/AMD64 标准基线；
- artifact SHA-256：
  `b37d2a2bc74eda8a111cd5a3d6c9365065377b28d7adcc7dd83b05605998bced`；
- 采集器：`backend/scripts/plugin_platform_phase0_baseline.py`；
- 方法、限制、威胁模型和门禁结果见 `docs/PLUGIN_PLATFORM_V2_PHASE0_zh.md`。

性能数字是本机基线，不是生产 SLO。协议和 fixture 哈希是精确迁移门：如果契约需要变化，
必须新增版本及迁移说明，不能直接改写预期值来让检查通过。
