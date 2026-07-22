# Plugin Platform v2 内存编排层

`app.plugin_platform` 把业务无关的 `EntrypointSupervisor` 组织成一个最小 Plugin Manager，
并把成功激活 generation 的 descriptor 投影到内存 contribution registry。

## 已有语义

- supervisor 按 `(plugin_id, entrypoint_id)` 确定性排序启动；
- required entrypoint 失败会停止并回滚此前已启动的 entrypoint；
- optional entrypoint 失败会关闭未激活 sidecar，只降级自身，并在 health/diagnostics 保留
  原因；
- contribution 只在 activation 成功后原子发布；
- 外部 ID 固定为 `<plugin-id>.<local-contribution-id>`；
- registry owner 是 `(plugin_id, entrypoint_id, generation)`，旧 generation 无权覆盖或删除
  新 generation；
- invoke 前后都核对 supervisor 状态与 generation；fatal request 会立即撤销 owner，idle
  crash 也会在 health/diagnostics 时清理残留注册；
- stop 先撤销内存注册，再停止所有 supervisor。

## 当前边界

这是仍未接入产品默认 lifecycle 的 opt-in 内存编排层：

- 不读取或写入 v1/v2 bundle activation registry；
- 不接入 FastAPI、`app.main` 或默认启动路径；
- enabled/disabled、grant 和安装状态分别由 Phase 3 registry 与 Phase 4 Grant Store 所有，
  manager 本身不复制持久化状态；
- activation 可接收经 Grant Store 解析的 `EffectiveGrant`，raw handle 由 Host authority mint；
- 不提供权限 UI、市场数据、文件、网络、secrets、前端或交易扩展点。

Phase 3/4 已提供 Bundle/Installer、Grant Store、capability 和可选 Windows OS 沙箱，但产品
组合根、真实核心贡献点和默认启动接线属于 Phase 5。当前代码不能绕过该阶段直接成为默认
产品路径。
