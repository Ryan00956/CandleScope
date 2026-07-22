# CandleScope 通用插件平台 v2 — Phase 2 执行记录

> 状态：**实现与技术验收已完成，随本阶段独立提交交付**，2026-07-22。
>
> 父基线：`codex/plugin-platform-v1@d29ad4d`（Phase 1）。
>
> 边界：本阶段交付通用 Host 控制面和 opt-in 内存 Plugin Manager。没有接入产品默认启动、
> FastAPI、持久化 registry 或 Bundle/Installer v2，也没有开放市场数据、网络、文件、
> secrets、UI、账户或交易能力。Phase 3 尚未开始。

## 1. 验收结论

Phase 2 已把 CandleScope 的进程宿主能力从“脚本 runtime 专用 supervisor”向业务无关 Host
内核推进，并用真实父/子进程跑通 Hello Command 的 activate、invoke、eventBatch、health
和 shutdown。它证明通用 contribution 可以在内存控制面运行，但仍不是一个可安装、可授权、
可运行不受信任社区插件的产品平台。

| 退出门 | 当前结果 | 证据 |
| --- | --- | --- |
| business-neutral Host | 通过 | 架构测试禁止 `plugin_host` 导入业务、v1 compatibility 或 manager 层 |
| async 双向 RPC | 通过 | 单 reader、串行 writer、Host call、重入、24 并发请求无串线 |
| 有界背压与取消 | 通过 | 容量耗尽 fail-fast；调用方取消发送 `cancel`；晚到响应只命中有界 tombstone |
| generation 隔离 | 通过 | 激活 generation 单调递增；旧/错误 generation 不发布业务结果或 registry 更新 |
| lifecycle 与熔断 | 通过 | start/activate/deactivate/upgrade/shutdown 严格状态；remote error 也关闭不确定 session；restart window 超限打开 circuit |
| contribution registry | 通过 | generation-owned 原子替换、全局 ID、冲突和 stale owner 拒绝 |
| required/optional 启动 | 通过 | required 失败回滚已启动项；optional 失败只隔离自身 |
| v1 compatibility | 通过 | v1 supervisor 复用 framing/process primitives；原 v1 Host 与 service 聚焦回归通过 |
| 产品面保持关闭 | 通过 | 架构测试确认 `app.main`/API 未导入 manager；无 bundle/registry/schema 变更 |
| 完整仓库门禁 | 通过 | SDK 58、backend 1981、frontend 2334 项通过；wheel/sdist 构建和 Python 3.12/3.13 fresh smoke 通过 |

## 2. 本阶段交付物

### 2.1 业务无关 Host 内核

`backend/app/plugin_host` 新增：

- strict bounded JSONL framing，拒绝非 UTF-8、重复 key、NaN/Infinity、超限消息和 stdout
  污染；
- 无 shell 的 sidecar 启动、环境变量白名单、bounded stderr、进程组 graceful/force stop；
- `candlescope.plugin/2` 双向 transport：唯一 reader、相关联 pending、串行 writer、取消、
  重入、并发上限和晚到响应隔离；
- entrypoint supervisor：handshake、describe、activate、invoke、eventBatch、healthCheck、
  prepareUpgrade、deactivate、shutdown；
- instance ID、单调 generation、capability handle 校验、restart window、circuit breaker 和
  结构化 diagnostics。

Host 内核只依赖 Python 标准库和公开 SDK，不依赖 DataManager、指标、行情或路由模块。

### 2.2 内存 Plugin Manager

`backend/app/plugin_platform` 新增：

- 确定性 entrypoint 启动和 required/optional 失败语义；
- activation 成功后才发布 contribution；
- `<plugin-id>.<local-id>` 全局 contribution ID；
- `(plugin_id, entrypoint_id, generation)` owner 和原子替换；
- invoke 返回前的 active generation 二次校验、fatal request 后的立即撤销以及 idle crash 后的
  stale prune；
- optional activation failure 会关闭未激活 sidecar，并在 health/diagnostics 中保留稳定原因；
- 停止时撤销 contribution 并终止所有 sidecar。

registry 只存在于当前 Python 进程内，既不读取也不修改现有 v1 activation registry。

### 2.3 v1 compatibility extraction

`app.plugin_runtime.RuntimeSupervisor` 继续拥有 v1 的业务协议、序列化请求和稳定错误码，但
进程启动、环境净化、信号以及严格 JSON parsing 改为复用 `app.plugin_host` 的低层 primitives。
这不是 v1→v2 自动升级，也没有 fallback 到另一个 runtime。

### 2.4 真实进程参考切片

`backend/scripts/plugin_platform_phase2_probe.py` 自身作为父 Host 启动同一 SDK 的 Hello
Command 子进程，只在内存中完成：

```text
handshake -> describe -> activate(generation=1)
          -> invoke(candlescope.hello-command.hello)
          -> eventBatch -> healthCheck -> deactivate -> shutdown
```

成功输出为单行 canonical JSON，stdout 不混入日志，stderr 为空。该 probe 不访问 FastAPI、
数据库、bundle installer 或持久化 registry。

冻结输出为：

```json
{"activeSummary":{"active":1,"configured":1,"contributions":1,"enabled":1,"failed":0,"status":"ok"},"contributionId":"candlescope.hello-command.hello","eventBatch":{"accepted":1},"generation":1,"health":{"pending":0,"status":"ready"},"invoke":{"contributionId":"hello","message":"Hello, Plugin Platform v2!"},"protocol":"candlescope.plugin/2","schemaVersion":1,"stoppedState":"stopped"}
```

含结尾换行的 SHA-256 为
`b0d2051adbc6527fd01ee9b8b14da1916a8cbc44eb8575eb7869340582a20701`。

## 3. 永久故障语义

| 故障 | Host 行为 | 可否发布业务结果 |
| --- | --- | --- |
| crash/startup exit | 终止 session，记录稳定错误 | 否 |
| hang/timeout | 取消请求并丢弃不确定 session | 否 |
| stdout 污染、重复 key、oversize | 视为协议破坏并终止 | 否 |
| wrong request ID | 视为协议破坏并终止 | 否 |
| stale generation | 撤销旧 owner，拒绝结果 | 否 |
| in-flight 满 | 立即返回 `PLUGIN_PLATFORM_IN_FLIGHT_LIMIT` | 否 |
| 并发 `host.call` 超限/复用 ID | 视为协议破坏并终止，不创建拒绝任务队列 | 否 |
| 调用方取消 | 发送 `cancel`，迟到响应被隔离 | 否 |
| 未知/撤销 capability handle | 该 `host.call` 失败；当前合法 session 可继续 | 否 |
| broker 在 revoke 后才返回 | 丢弃结果，不跨 generation 回传 capability 数据 | 否 |
| lifecycle RPC error | 状态不确定，终止整个 session | 否 |
| restart storm | 打开 entrypoint circuit | 否 |
| optional entrypoint 失败 | 只降级该 entrypoint | 其他已激活项可继续 |
| required entrypoint 失败 | 回滚此前启动项，整体启动失败 | 否 |

所有 lifecycle 响应只要无法证明状态确定，就按失败关闭处理；不得基于“子进程可能已经做完”
猜测成功。

## 4. 安全边界

Phase 2 做到的是协议与进程故障隔离，不是针对恶意代码的安全沙箱：

- 子进程环境采用白名单并剥离常见 ambient secrets；
- Host 不把数据库连接、DataManager、EventBus、DOM 或 React 对象交给插件；
- capability handle 与 active generation 绑定，未配置 broker 时 `host.call` fail closed；
- 但当前没有 Windows restricted token/AppContainer、Job Object 资源配额、direct network
  deny、文件 ACL 或签名信任链。

因此本阶段只允许受控参考插件和测试 sidecar。运行不受信任插件必须等待 Phase 4 的 OS
沙箱与权限门，外部数据/文件/网络能力必须等待各自后续阶段。

## 5. 构建与验证证据

### 5.1 聚焦门禁

- SDK：`python -m pytest -q packages/candlescope-plugin-sdk/tests`，**58 passed**；
- Phase 0/v1 golden：baseline、transport routing、main lifecycle、supervisor、service、
  architecture 合计 **45 passed**；
- Phase 2 覆盖 crash、hang、stdout pollution、oversize、wrong ID、stale generation、
  lifecycle remote error、restart storm、Host call 重入/撤销/超限、取消 shutdown、required/
  optional rollback 和真实 probe；
- 变更范围 Ruff 全绿，backend/SDK `compileall` 通过。

### 5.2 完整仓库门禁

| 门禁 | 结果 |
| --- | --- |
| SDK pytest | 58 passed |
| backend pytest | 1981 passed；4 条既有 FastAPI `on_event` 弃用警告 |
| frontend architecture/typecheck/lint/test/build | 2334 passed；Vite production build 成功 |
| `git diff --check` | 通过 |

### 5.3 分发制品 smoke

从当前 SDK 源码重新构建 `candlescope-plugin-sdk==0.2.0`，未复用旧 wheel：

| 制品 | SHA-256 |
| --- | --- |
| `candlescope_plugin_sdk-0.2.0-py3-none-any.whl` | `15fe9167f593511cf8c2fef1d8c0ecfa719610207e420b740ddf6309f5856430` |
| `candlescope_plugin_sdk-0.2.0.tar.gz` | `96734d21f2b93924ea3900c092a8050e1cd04c744938056c070264597a0f4715` |

wheel 分别在全新 CPython **3.12.7** 与 **3.13.9** venv 中通过离线 `--no-deps`
安装、packaged schema 加载、v1/v2 console entrypoint 和 transcript 重放。制品仅用于本阶段
验收，没有发布或覆盖仓库 Release。

## 6. 回滚

本阶段是 additive 且未进入默认产品路径，可单独 revert：

1. 删除 `app.plugin_host`、`app.plugin_platform`、Phase 2 probe/tests/docs；
2. 将 v1 supervisor 恢复为阶段前的本地 framing/process helpers；
3. 删除 SDK request model 的 additive `to_wire()` helpers。

现有 bundle 格式、activation registry、官方 Pyne/Pine runtime 路由、HTTP/range/WS 和前端
均无迁移，因此不需要数据回滚。

## 7. Phase 3 前置门

Phase 3 只能在本阶段完整门禁和独立提交完成后开始。下一阶段将限定为 Bundle/Installer v2、
immutable installation store、staged validation 和原子 activation/rollback；不得借此提前开放
Host API、任意 UI、网络、文件、secrets 或交易。
