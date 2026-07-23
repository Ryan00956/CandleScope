# v1 Script Runtime 兼容适配

Phase 13 继续冻结 `candlescope.script-runtime/1` 与
`candlescope.render/1`。v1 runtime 不会被重打包成
`candlescope.plugin/2` backend，v1 activation 也不会复制进 v2 activation
registry。CandleScope 只在已经通过 v1 Host 校验的 runtime/route 外层生成一个只读的
`script-runtime/1` compatibility contribution。

## SDK 模板

继续直接使用现有模板，不要切换协议族：

- runtime 实现：`candlescope_plugin_sdk.examples.hello_runtime`；
- bundle manifest：`examples/hello-runtime.manifest.json`；
- wire transcript：`tests/fixtures/hello_transcript_v1.json`；
- 完整协议：`docs/protocol-v1.md`。

runtime 仍继承 `BaseRuntimePlugin`、返回 `RuntimeDescriptor`，并通过
`serve_runtime(...)` 服务。`.cspkg` 仍使用数值型 v1 `schemaVersion`，声明
`candlescope.script-runtime/1`，固定全部 wheel，并携带精确 analyze/execute
probe SHA-256。

不要在 v2 manifest 中声明 `script-runtime/1`。它是 Host 拥有的兼容投影，不是社区
插件可自行选择的 v2 contribution kind；声明它仍会被视为不受支持，也不会让 v1 进程
获得任何 v2 Host capability。

## 发布清单

1. 从目标源码构建每个 wheel 并记录 SHA-256；
2. 更新 v1 manifest 版本和精确 wheel 集；
3. 重算固定 analyze/execute probe SHA-256；
4. 构建单个不可变 `.cspkg`，在 release metadata 固定 bundle SHA-256；
5. 在全新 Python 3.12/3.13 环境运行 SDK transcript 与 package smoke；
6. 运行 v1 installer check、fresh install、quick repeat、fresh-process 语义探针和
   rollback；
7. 确认 HTTP compute、HTTP range、Indicator WebSocket 与
   `/api/v1/indicators/runtimes` canonical fixture 没有变化；
8. 在 Plugin Manager 先预览 registry import，只应用完全一致的 preview SHA-256。

导入只保存有界的公开 catalog snapshot，不会执行 runtime、改写 v1 registry、修改
v1 route table 或安装 v2 bundle。

## 兼容矩阵

| runtime/release | 安装与 activation 所有者 | 统一发现 | 执行协议 | 支持的迁移 |
| --- | --- | --- | --- | --- |
| 现有 pinned Pyne/Pine v1 `.cspkg` | v1 installer/RuntimeHost | Host compatibility contribution | `candlescope.script-runtime/1` | 仅显式 catalog import |
| 社区 v1 runtime | v1 installer/RuntimeHost | descriptor/route 校验后可见 | `candlescope.script-runtime/1` | 仅显式 catalog import |
| 通用 v2 plugin | v2 installer/Core Host | 原生 v2 catalog | `candlescope.plugin/2` | v2 staged lifecycle |
| v2 manifest 声明 `script-runtime/1` | 无 | 显示 unsupported | 无 | 拒绝，不猜测转换 |
| 回滚到 v1-only 产品 | v1 installer/RuntimeHost | 保留 live compatibility discovery | `candlescope.script-runtime/1` | 忽略 v2 状态 |

## 故障排查

- `PLUGIN_V1_COMPATIBILITY_PREVIEW_STALE`：live route、descriptor、managed
  identity 或 import revision 已变化；重新预览，不能复用旧摘要。
- `PLUGIN_V1_COMPATIBILITY_STATE_INVALID`：独立兼容状态损坏、超限或路径不安全；
  不要修改 v1 registry，保留异常文件用于诊断，并先以 v1-only 模式运行。
- runtime 显示 unavailable：检查 v1 Host health 和 route mode；sidecar route 不会静默
  回落到 legacy。
- bundle SHA-256 不同：立即停止，不能原地替换 immutable release；发布新版本与新摘要。
- import 按钮不可用：启用通用 Plugin Platform，并从可信本地管理会话操作；live v1 发现
  与执行本身不依赖 snapshot import。
