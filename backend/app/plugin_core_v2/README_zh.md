# Plugin Platform v2 核心产品组合根

`app.plugin_core_v2` 是 Phase 5–11B WP-B 的产品组合层。它把 Phase 2 的进程 Host、Phase 3 的
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
| `chart-layer/1` | Host 校验 marker-only `candlescope.render/1`、item/byte/text budget、revision 与 generation |
| `storage.private` | publisher + plugin 命名空间的 KV/document/blob、逻辑配额、snapshot 和事务迁移 |
| `market.*.read` | 只经 DataManager facade 返回 symbol、K 线、TradeFlow 与 partial order-book 公共 DTO |
| `market.bars.subscribe` | 精确 series lease、有界队列、forming latest-coalesce、closed/amended 可靠投递与 resync |
| `view/1` | Host 原生声明式 UI，或 opaque-origin、严格 bridge 的 sandbox surface |
| `http-endpoint/1` | loopback namespace 内的受控 endpoint；网络与用户文件均经 Host gateway |
| `symbol-provider/1` + `market-data-provider/1` | 成对 sidecar provider；输出回到 Host ingestion/Data Engine 真相路径 |
| `account-provider/1` + `order-executor/1` | first-party pinned、显式开启的 Paper-only intent/ack；账本、成交和风控归 Host |

公共事件当前只有 `candlescope.app.ready/1`、`candlescope.app.stopping/1`、
`candlescope.plugin.enabled/1` 和 `candlescope.plugin.disabled/1`。插件不能订阅
`DataEventBus`，也不能获得 `DataManager`、SQLite connection 或 `app.state`。

## 生命周期

产品默认是零状态关闭：

```powershell
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED='1'
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_ROOT='C:\managed\candlescope-plugin-platform-v2'
```

Paper 还必须同时显式设置：

```powershell
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST='first-party-pinned'
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_PAPER_TRADING_ENABLED='1'
```

WP-B Broker foundation 也必须同时使用 first-party pinned 平台并单独显式开启：

```powershell
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST='first-party-pinned'
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENABLED='1'
```

该开关只启动零网络 Broker foundation，不会开放账户、签名、query、submit 或 cancel。
默认/推荐值仍是 `0`；production release lock 当前为空。

未设置 `CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED` 时，`app.main` 只挂载返回空 catalog 的
disabled facade，不读取 registry、不创建 supervisor、不注册 event/job，也不启动插件进程。
显式启用后，组合根只对 registry 中 `active` 且 grant 完整的 installation 建立惰性
supervisor。disabled/staged 插件只经过静态 bundle/receipt/content/launch binding 校验，绝不
执行其代码。

普通插件只因 command、event delivery 或 job execution 激活。`onStartup` 还必须同时出现在
`CANDLESCOPE_PLUGIN_PLATFORM_V2_STARTUP_ALLOWLIST`。disable、uninstall、rollback 或 grant
变化统一走 `reconcile_plugin()`：先释放 market subscription/layer/provider/Paper broker，再撤销 handle、event、job、settings binding 和 supervisor，
再读取新 registry；旧 generation 和迟到结果不能重新发布。

环境 bootstrap 默认 `local-trusted`。把
`CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST=untrusted` 写进环境会直接失败，因为安全的
AppContainer runtime roots 不能从字符串推断；调用方必须注入显式 `SandboxPolicy` factory。

## API

- `GET /api/v2/plugins/catalog` 是公开安全投影，不含 executable、安装路径、PID、stderr、
  capability handle 或 secret；
- `/api/v2/plugins/manage/*` 提供 diagnostics、权限决策、enable/disable、rollback、uninstall、
  command/job、settings、notification 与 Paper status/account/submit/cancel/recover/kill-switch 管理操作；
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
├── paper-v1/paper-state-v1.json
├── live-broker-v1/
│   ├── broker.lock
│   ├── broker-state-v1.json
│   └── vault-v1/<record-id>.dpapi
└── private/<publisher-hash>/<plugin-id>/
    ├── storage-v1.sqlite
    └── snapshots/snapshot-<uuid>.json
```

namespace 始终来自已验证的 `CapabilityLease`，调用参数不能选择 plugin 或 publisher。
KV/document/blob 写入在 SQLite transaction 内计算逻辑使用量，越 quota 整体回滚。迁移开始前
生成带 payload SHA-256 的原子 snapshot；迁移操作、版本更新或 quota 检查失败时数据库事务
保留旧状态，显式 restore 同样是原子事务。

## Phase 11 边界

声明式前端、Plugin Manager、sandbox UI、受控网络/文件/HTTP gateway、公开数据提供器与
Paper-only 账户/订单已交付。Paper 插件没有 secret、真实账户连接、raw socket 或 live execution
handle；`secrets.use`、`trade.submit`、`trade.cancel` 继续不可授予。移除 Paper policy 后，磁盘上旧
grant 也不会成为 effective capability。签名 publisher、Live opt-in 与 Marketplace 仍属于后续阶段。

执行证据和回滚边界见
[`docs/PLUGIN_PLATFORM_V2_PHASE5_zh.md`](../../../docs/PLUGIN_PLATFORM_V2_PHASE5_zh.md)。
Phase 6 市场数据、背压和参考扫描器证据见
[`docs/PLUGIN_PLATFORM_V2_PHASE6_zh.md`](../../../docs/PLUGIN_PLATFORM_V2_PHASE6_zh.md)。
Phase 11A Paper 合同与证据见
[`docs/PLUGIN_PLATFORM_V2_PHASE11A_zh.md`](../../../docs/PLUGIN_PLATFORM_V2_PHASE11A_zh.md)。
Phase 11B WP-A/WP-B 的 build-pinned publisher evidence、零网络 Broker、DPAPI 与回滚证据见
[`docs/PLUGIN_PLATFORM_V2_PHASE11B_WPA_zh.md`](../../../docs/PLUGIN_PLATFORM_V2_PHASE11B_WPA_zh.md)
和
[`docs/PLUGIN_PLATFORM_V2_PHASE11B_WPB_zh.md`](../../../docs/PLUGIN_PLATFORM_V2_PHASE11B_WPB_zh.md)。
