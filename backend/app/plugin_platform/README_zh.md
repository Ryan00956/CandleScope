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

这是 Phase 2 的 opt-in 内存切片，不是产品插件注册表：

- 不读取或写入 v1/v2 bundle activation registry；
- 不接入 FastAPI、`app.main` 或默认启动路径；
- 不持久化 enabled/disabled、grant 或 contribution 状态；
- 不提供安装、升级、回滚、权限 UI、市场数据、文件、网络、secrets、前端或交易扩展点。

Phase 3 才会设计 Bundle/Installer v2 和原子 activation registry。当前代码不能绕过该阶段
直接成为默认产品路径。
