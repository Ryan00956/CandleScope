# Plugin Platform v2 核心产品组合根

`app.plugin_core_v2` 是 Phase 5 的产品组合层。它把 Phase 2 的进程 Host、Phase 3 的
immutable installation/activation registry 和 Phase 4 的 Grant Store/capability broker
组合成最小通用插件平台，同时保持业务数据库、Data Engine 和私有 Python 对象不可见。

## 当前提供的公开面

| 类型 | Host 所有权与语义 |
| --- | --- |
| `command/1` | 严格 object input schema；默认要求当前用户动作；首次调用才激活 sidecar |
| `settings/1` | Host 校验的有限 JSON Schema 子集；按 publisher + plugin + contribution 持久化 |
| `notification/1` | 只进入有界 Host notification projection；插件不能直接操作前端 |
| `event-subscriber/1` | 只订阅版本化 public app event；每 subscriber 独立有界队列和 drop-oldest 计数 |
| `job/1` | 静态 interval、single-flight、timeout、指数退避、手动触发和 disable/revoke 取消 |
| `storage.private` | publisher + plugin 命名空间的 KV/document/blob、逻辑配额、snapshot 和事务迁移 |

公共事件当前只有 `candlescope.app.ready/1`、`candlescope.app.stopping/1`、
`candlescope.plugin.enabled/1` 和 `candlescope.plugin.disabled/1`。插件不能订阅
`DataEventBus`，也不能获得 `DataManager`、SQLite connection 或 `app.state`。

## 生命周期

产品默认是零状态关闭：

```powershell
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED='1'
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_ROOT='C:\managed\candlescope-plugin-platform-v2'
```

未设置 `CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED` 时，`app.main` 只挂载返回空 catalog 的
disabled facade，不读取 registry、不创建 supervisor、不注册 event/job，也不启动插件进程。
显式启用后，组合根只对 registry 中 `active` 且 grant 完整的 installation 建立惰性
supervisor。disabled/staged 插件只经过静态 bundle/receipt/content/launch binding 校验，绝不
执行其代码。

普通插件只因 command、event delivery 或 job execution 激活。`onStartup` 还必须同时出现在
`CANDLESCOPE_PLUGIN_PLATFORM_V2_STARTUP_ALLOWLIST`。disable、uninstall、rollback 或 grant
变化统一走 `reconcile_plugin()`：先撤销 handle、event、job、settings binding 和 supervisor，
再读取新 registry；旧 generation 和迟到结果不能重新发布。

环境 bootstrap 默认 `local-trusted`。把
`CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST=untrusted` 写进环境会直接失败，因为安全的
AppContainer runtime roots 不能从字符串推断；调用方必须注入显式 `SandboxPolicy` factory。

## API

- `GET /api/v2/plugins/catalog` 是公开安全投影，不含 executable、安装路径、PID、stderr、
  capability handle 或 secret；
- `/api/v2/plugins/manage/*` 提供 diagnostics、权限决策、enable/disable、rollback、uninstall、
  command/job、settings 和 notification 管理操作；
- 所有 management 请求要求 loopback client/Host、精确 Origin 和 ephemeral local session；
  mutation 还要求 CSRF 与显式 user-action ID；
- session/CSRF 只保存在 Host 内存，不通过 HTTP 返回。Phase 7 的可信桌面 handoff 和管理 UI
  尚未交付。

## 持久化

```text
plugin-platform-v2/
├── platform-registry-v2.json
├── platform-grants-v2.json
├── plugin-settings-v1.json
├── installations/
├── history/
├── audit-v2/events/
└── private/<publisher-hash>/<plugin-id>/
    ├── storage-v1.sqlite
    └── snapshots/snapshot-<uuid>.json
```

namespace 始终来自已验证的 `CapabilityLease`，调用参数不能选择 plugin 或 publisher。
KV/document/blob 写入在 SQLite transaction 内计算逻辑使用量，越 quota 整体回滚。迁移开始前
生成带 payload SHA-256 的原子 snapshot；迁移操作、版本更新或 quota 检查失败时数据库事务
保留旧状态，显式 restore 同样是原子事务。

## 尚未开放

Phase 5 只达到“最小通用插件平台”。市场数据 consumer、图表 Render IR layer、声明式前端、
sandbox UI、网络/文件/HTTP gateway、数据提供器、secrets、账户、交易、签名 publisher 和
Marketplace 都属于 Phase 6–12。没有对应 Host adapter 的 permission 仍然不可调用。

执行证据和回滚边界见
[`docs/PLUGIN_PLATFORM_V2_PHASE5_zh.md`](../../../docs/PLUGIN_PLATFORM_V2_PHASE5_zh.md)。
