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

多运行时 Phase 2 Python Provider 等价基线：

- `multi-runtime-phase2-2026-08-03-windows-amd64.json`：同一 v2 bundle 分别走
  Provider 默认路径与内部 rollback 路径，各做 3 次真实冷启动、Windows working set
  采样和 Host stop 残留检查；
- Provider 与 rollback 的 executable/argv 必须精确一致；安装耗时对照 Phase 0，启动与
  内存对照同次 rollback 样本；
- 采集器及 fail-closed gate：
  `backend/scripts/plugin_platform_multi_runtime_phase2.py`；
- 完整契约、适用范围和限制见
  `docs/PLUGIN_PLATFORM_MULTI_RUNTIME_PHASE2_zh.md`。

多运行时 Phase 3 Native Provider 基线：

- `multi-runtime-phase3-2026-08-03-windows-amd64.json`：对锁定 Rust reference
  executable 做真实 install/check/quick-repeat、3 次冷启动、Windows working set、
  trusted-local Job Object 与 AppContainer 进程证据；
- Rust release 编译时间只作信息记录，不计入预编译 `.cspkg` 的安装耗时；
- first install 对照 Phase 0，启动与内存对照 Phase 2 Python Provider；受限门另外要求
  包外文件不可读、包外 executable 无法启动、Host stop 后无残留；
- 采集器及 fail-closed gate：
  `backend/scripts/plugin_platform_multi_runtime_phase3.py`；
- 完整契约、适用范围和限制见
  `docs/PLUGIN_PLATFORM_MULTI_RUNTIME_PHASE3_zh.md`。

WP-B Broker foundation 基线：

- `phase11b-wpb-2026-07-23-windows-amd64.json`：10 次独立 worker 冷启动和
  10,000 次串行 `foundation.health` 私有 pipe 往返，并记录请求前后 RSS；
- 采集器：`backend/scripts/plugin_live_broker_benchmark.py`；
- 该基线使用 fake vault、空 production release lock、零 credential、零网络方法，
  只测量 WP-B 的固定本地 hop 和 idle RSS；
- artifact SHA-256 与完整验收说明见
  `docs/PLUGIN_PLATFORM_V2_PHASE11B_WPB_zh.md`。

性能数字是本机基线，不是生产 SLO。协议和 fixture 哈希是精确迁移门：如果契约需要变化，
必须新增版本及迁移说明，不能直接改写预期值来让检查通过。
