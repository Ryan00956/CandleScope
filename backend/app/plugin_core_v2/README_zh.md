# Plugin Platform v2 核心产品组合根

`app.plugin_core_v2` 是 Phase 5–12 的产品组合层。它把 Phase 2 的进程 Host、Phase 3 的
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

签名 Marketplace 同样是独立、默认关闭的能力：

```powershell
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_MARKETPLACE_ENABLED='1'
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_MARKETPLACE_ROOTS='C:\build\official-marketplace-roots.json'
```

默认 `official-marketplace-roots.json` 不含任何 root；启用 Marketplace 但没有 build-pinned
enabled root 会失败。生产包应携带审核后的 roots，环境路径只用于受控打包/测试。

WP-B Broker foundation 也必须同时使用 first-party pinned 平台并单独显式开启：

```powershell
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST='first-party-pinned'
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENABLED='1'
```

只读 OKX Demo Spot account binding 还必须单独开启：

```powershell
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENABLED='1'
```

foundation 单独开启仍是零网络；read-only flag 开启后，Broker 也只允许固定的 account
config/balance 两个认证 GET 和 discover/describe/rebind 三个私有方法，不开放订单
query、通用签名、submit 或 cancel。两个开关默认/推荐值均为 `0`；production release
lock 当前为空。

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
  command/job、settings、notification、Paper/Live 管理操作，以及 Marketplace 的
  refresh/prepare/apply/activate；
- `GET /api/v2/plugins/marketplace/catalog` 只投影签名 publisher/release 与安装状态；
- Marketplace 的 prepare、inactive apply 和 explicit activate 是三个独立 mutation；没有自动更新、
  自动权限或自动激活；
- 所有 management 请求要求 loopback client/Host、精确 Origin 和 ephemeral local session；
  mutation 还要求 CSRF 与显式 user-action ID；
- session/CSRF 只保存在 Host 内存，并通过一次性桌面 bootstrap 交给 Plugin Manager；公共
  catalog/status 不返回这些令牌。

## 持久化

```text
plugin-platform-v2/
├── platform-registry-v2.json
├── platform-grants-v2.json
├── plugin-settings-v1.json
├── marketplace-state-v1.json
├── marketplace-v1/
│   ├── indexes/<sha256>.json
│   └── artifacts/<sha256>.cspkg
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

## Phase 12 边界

声明式前端、Plugin Manager、sandbox UI、受控网络/文件/HTTP gateway、公开数据提供器与
Paper-only 账户/订单、默认关闭的 WP-A～WP-F Live Broker 技术路径和签名 Marketplace 已交付。
Marketplace 用 root/publisher Ed25519 签名、不可变 index/artifact cache、SBOM/许可证绑定、
transparency/revocation、permission diff 和显式 staged activation 验证发布来源。

`verified-publisher` 不等于可信代码或 Live 资格：社区 backend 仍按 `untrusted` 在 Windows
AppContainer 中运行，Grant Store 仍独立决定权限，Phase 11B Live 仍只接受独立 build-pinned
first-party evidence。普通/社区插件没有 credential、认证 header、raw socket 或 Live account
handle；`secrets.use`、公开 `trade.submit`、`trade.cancel` 继续不可授予。真实 Demo/真钱测试、
production canary 和 WP-G 未执行。

执行证据和回滚边界见
[`docs/PLUGIN_PLATFORM_V2_PHASE5_zh.md`](../../../docs/PLUGIN_PLATFORM_V2_PHASE5_zh.md)。
Phase 6 市场数据、背压和参考扫描器证据见
[`docs/PLUGIN_PLATFORM_V2_PHASE6_zh.md`](../../../docs/PLUGIN_PLATFORM_V2_PHASE6_zh.md)。
Phase 11A Paper 合同与证据见
[`docs/PLUGIN_PLATFORM_V2_PHASE11A_zh.md`](../../../docs/PLUGIN_PLATFORM_V2_PHASE11A_zh.md)。
Phase 11B WP-A/WP-B/WP-C 的 build-pinned publisher evidence、独立 Broker、DPAPI、
认证只读账户与回滚证据见
[`docs/PLUGIN_PLATFORM_V2_PHASE11B_WPA_zh.md`](../../../docs/PLUGIN_PLATFORM_V2_PHASE11B_WPA_zh.md)
和
[`docs/PLUGIN_PLATFORM_V2_PHASE11B_WPB_zh.md`](../../../docs/PLUGIN_PLATFORM_V2_PHASE11B_WPB_zh.md)
以及
[`docs/PLUGIN_PLATFORM_V2_PHASE11B_WPC_zh.md`](../../../docs/PLUGIN_PLATFORM_V2_PHASE11B_WPC_zh.md)。
Phase 12 签名、更新、撤销、离线 cache、AppContainer 与 Manager 证据见
[`docs/PLUGIN_PLATFORM_V2_PHASE12_zh.md`](../../../docs/PLUGIN_PLATFORM_V2_PHASE12_zh.md)。
