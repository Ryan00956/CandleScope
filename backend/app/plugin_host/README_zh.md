# Plugin Host v2 内核

`app.plugin_host` 是 CandleScope Plugin Platform v2 的业务无关进程 Host。它只负责
sidecar 的进程、JSONL 传输、请求关联、生命周期、generation 和故障隔离；它不知道
指标、行情、HTTP 路由、数据库、UI 或交易。

## 职责

| 模块 | 唯一职责 |
| --- | --- |
| `framing.py` | 严格 UTF-8 JSONL、重复 key/非有限数拒绝、消息大小上限、单 reader 与串行 writer |
| `process.py` | 无 shell 启动、最小环境变量、bounded stderr、进程组终止 |
| `transport.py` | `candlescope.plugin/2` 双向 RPC、pending 关联、取消、重入、并发上限 |
| `supervisor.py` | handshake/describe/activate 生命周期、generation、health、重启窗口和熔断 |
| `errors.py` | 可观测且稳定的 Host 错误结构 |

依赖方向固定为：

```text
public SDK <- plugin_host <- plugin_platform
                    ^
                    └─ plugin_runtime v1 compatibility wrapper
```

`plugin_host` 不得反向导入 `app.plugin_platform`、`app.plugin_runtime` 或业务模块。现有
v1 supervisor 只复用低层 framing/process primitives，不改变 v1 wire contract。

## 生命周期与 generation

每个 `EntrypointSupervisor` 只拥有一个 manifest entrypoint：

```text
stopped -> starting -> ready -> activating -> active
   ^                                  |          |
   +------------ stopping <-----------+----------+
```

- 每次成功激活获得严格单调递增的 generation；失败或退出会撤销当前 generation 和 grants。
- descriptor 必须与 manifest 的插件、entrypoint、贡献点和权限边界一致。
- activation/deactivation/upgrade 的响应不完整、返回 RPC error 或状态不确定时，整个
  session 被丢弃。
- restart window 用有限预算控制自动重启；预算耗尽后打开 entrypoint circuit。

## 双向 RPC 与背压

传输层始终只有一个 stdout reader，通过 request ID 把响应分派给 pending future；写端由锁
串行化，因此插件在 Host 请求尚未完成时可以发起 `host.call`，Host handler 也可以重入调用
插件。总 in-flight 数达到上限时立即返回 `PLUGIN_PLATFORM_IN_FLIGHT_LIMIT`，不会创建无界
等待队列。

调用方取消时 Host 发送相关联的 `cancel`。迟到响应只命中有界 tombstone，不会被当成新
generation 的结果。wrong ID、旧 generation、stdout 污染、超大消息和进程异常都使当前
session fail closed。插件复用 Host call ID 或超过并发 Host call 上限时直接关闭 session，
不会为恶意洪泛创建拒绝任务队列。

插件发起的 `host.call` 还必须同时满足：

- 请求属于当前 active generation 和已声明 contribution；
- capability handle 存在、属于当前 activation 且尚未撤销；
- Host 显式配置了对应 broker handler。

Phase 2 只实现这些校验和 broker 接口，没有开放任何真实 Host API。
broker 若在 generation 被撤销后才返回，结果会被丢弃，不会跨 generation 回传 capability
数据。

## 进程边界

sidecar 使用 `asyncio.create_subprocess_exec` 启动，不经过 shell。子进程只继承白名单环境，
不会隐式继承 `PYTHONPATH` 或常见 secret/token/password 变量；stderr 只保留有界尾部，
session 关闭后仍可通过显式 diagnostics 读取最后尾部。

这不是 OS 沙箱。Phase 2 尚未提供 restricted token、Job Object 配额、网络隔离、文件 ACL
或资源配额；因此不能运行不受信任插件。那些能力属于 Phase 4 及之后的独立安全门。

## 验证入口

- `python backend/scripts/plugin_platform_phase2_probe.py`：真实父 Host + 真实 SDK Hello
  sidecar，但只在内存中注册贡献点。
- `backend/tests/test_plugin_host_v2.py`：故障、并发、取消、重入、generation 和 shutdown。
- `backend/tests/test_plugin_host_architecture.py`：依赖方向、无 shell、无无界 reader queue、
  未接产品路由等架构门禁。
