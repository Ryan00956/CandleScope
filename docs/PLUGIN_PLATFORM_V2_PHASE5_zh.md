# CandleScope 通用插件平台 v2 — Phase 5 执行记录

> 状态：**实现与技术验收已完成，随本阶段独立提交交付**，2026-07-22。
>
> 父基线：`codex/plugin-platform-v1@e20d7c4`（Phase 4）。
>
> 边界：本阶段交付最小通用后端插件平台，但产品 feature flag 默认关闭，环境 bootstrap
> 只允许显式 `local-trusted`；没有交付市场数据、图表图层、插件前端、网络、文件、secrets、
> 账户、交易、签名 publisher 或 Marketplace。

## 1. 验收结论

Phase 5 把前四阶段的独立 SDK、Host、Installer 和安全控制面接成了一个可由产品生命周期
消费的组合根：

- `command/1`、`settings/1`、`notification/1`、`event-subscriber/1`、`job/1` 五类
  Host-owned 核心贡献点；
- publisher + plugin 隔离的 KV/document/blob、quota、snapshot 和 transaction migration；
- 版本化 public app event、有界 per-subscriber queue 和不等待插件的 producer；
- single-flight job、timeout、指数退避、手动触发、定时执行和 revoke/disable cancellation；
- 从 active v2 registry 生成 supervisor 的产品组合根、惰性激活和静态 disabled 校验；
- 公开安全 catalog 与受 Phase 4 本地管理门保护的 lifecycle/permission/command/job/settings API；
- SDK 自带 Hello Command 和无 UI Scheduled Notification 两个真实参考插件。

据此，截至 Phase 5 的代码可以称为**最小通用插件平台**，不再只是“自定义指标 runtime”
或孤立的 sidecar 基础设施。“最小”很重要：当时 Phase 6–12 的领域能力尚未实现，插件仍
不能绕过 Host 边界获得任意功能。Phase 6 的后续只读 market/chart-layer 交付见
[`PLUGIN_PLATFORM_V2_PHASE6_zh.md`](PLUGIN_PLATFORM_V2_PHASE6_zh.md)。

## 2. 产品组合根与零状态默认值

`CorePluginPlatform` 统一持有 Installer、Grant Store、Audit Log、Capability Authority/Broker、
Plugin Manager、私有 storage、settings、notification、event hub 和 job scheduler。`app.main`
在 indicator v1 runtime 启动后创建该组合根，在 Data Engine ready 后发布
`candlescope.app.ready/1`，shutdown 前发布 `candlescope.app.stopping/1` 并回收全部插件工作。

默认环境不启用 v2：

```text
CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED      # 默认 0
CANDLESCOPE_PLUGIN_PLATFORM_V2_ROOT         # 可选独立 managed root
CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST        # 默认 local-trusted
CANDLESCOPE_PLUGIN_PLATFORM_V2_MANAGEMENT_ORIGINS
CANDLESCOPE_PLUGIN_PLATFORM_V2_STARTUP_ALLOWLIST
```

disabled facade 不读取 registry，不创建 supervisor，不注册 subscriber/job，也不启动进程；公开
catalog 返回 `enabled=false` 的空列表。显式启用后，bootstrap 静态复核 bundle、receipt、内容
摘要、installation identity、activation identity、required permissions 和绝对 launch target，
但不执行 disabled/staged 插件。fresh-process semantic probe 继续是 install/check gate，不会在
每次产品启动时导入所有插件。

普通 active 插件也不自动启动：command 第一次 invoke、public event delivery 或 job run 才激活
对应 entrypoint。manifest 的 `onStartup` 只有 plugin ID 同时进入显式 startup allowlist 才运行。
同一组合根完成 stop 后可再次 start；旧 supervisor 表、generation lock、event 和 job 不残留。

## 3. 贡献点契约

manifest 仍由公共 SDK v2 parser 负责通用字段，Phase 5 再对五类核心 configuration 做逐字段
白名单验证：未知字段、错误类型、不相容 schema keyword、倒置 min/max、重复 enum、未知事件、
越界 queue/job 配额都会使该插件 fail closed，不进入 live manager。

| 贡献点 | 当前语义 |
| --- | --- |
| `command/1` | object input schema；默认需 user action；Host 通过 full contribution ID 调用 |
| `settings/1` | object root；有限 JSON Schema；默认值和每次写入均由 Host 验证 |
| `notification/1` | 声明 channel/severity；插件只能通过 `notifications.show` capability 发布 |
| `event-subscriber/1` | 只允许 Host 注册的版本化 public event 和有界 batch 参数 |
| `job/1` | 可选静态 interval、timeout、attempt、backoff、run-on-startup 声明 |

catalog 只投影安全 descriptor。disabled、staged、load-failed、platform-stopped 或 runtime 构建失败
都会得到 `available=false` 和稳定 reason；不会因为“bundle 可解析”就把不可调用贡献点标成可用。
插件 runtime 返回的 descriptor 仍在首次 activation 时由 Phase 2 Host 与 manifest 严格比对。

## 4. 私有状态

storage namespace 固定为：

```text
SHA-256(publisher identity) + plugin ID
```

该身份只从验证后的 `CapabilityLease` 派生。`storage.*` 参数出现 `pluginId` 或 publisher 等未知
字段会在 handler 前失败，因此插件不能通过伪造参数选择其他 namespace。

每个 namespace 使用独立 SQLite：

- KV value 和 document 使用 canonical JSON；document 支持 revision compare-and-set；
- blob 使用严格 base64、受限 media type 和 per-value size；
- list 使用有界 cursor/limit；
- KV/document/blob 写操作在 `BEGIN IMMEDIATE` 中更新并检查 logical byte quota，超限回滚；
- snapshot 是原子替换的 strict JSON，绑定 namespace、schema version 和 payload SHA-256；
- migration 只接受有限的 Host-owned declarative operation，开始前先建 snapshot，在同一数据库
  transaction 内执行 operation、quota check 和 data-version 更新；任一步失败保留旧数据库状态；
- restore 先验证 snapshot identity/hash/shape，再在 transaction 内整体替换。

当前 quota 约束 live KV/document/blob 逻辑数据；每个 snapshot 仍有 128 MiB 绝对上限，但
snapshot aggregate retention/GC 尚未产品化。安装/卸载默认保留私有数据，删除数据仍是未来独立
用户动作，不能与 uninstall 混为一谈。

## 5. Event、Job 与失效语义

Host 当前公开四个 app event：ready、stopping、plugin enabled 和 plugin disabled，均带独立
`/1` schema。每个 subscriber 有自己的 queue capacity、batch size 和 latency；queue 满时只对
该 subscriber drop oldest 并累计 dropped counter。`publish()` 不 await 插件，因此慢插件、失败
退避或 crash 不会阻塞主 producer，也没有直接暴露 DataEventBus。

job scheduler 只注册同时拥有 `jobs.schedule` effective grant 且 scope 覆盖该 job/频率的静态
贡献点。每个 job single-flight，调用有 timeout、有限 attempts 和指数 backoff；手动触发要求
当前 user action。disable、uninstall、rollback 或 permission revoke 时，组合根按以下顺序处理：

1. 从 scheduler/event hub 移除并取消 active work；
2. revoke plugin capability lease；
3. unbind settings contract；
4. 从 manager 删除并停止全部 entrypoint；
5. 静态重读 registry/grants，再决定是否建立新 generation。

Host invoke/event 在返回前再次核对 generation；job 在记录成功前再次核对 registration stop
event。旧 handle、旧 generation、排队 event、active job 和迟到结果都不能重新发布。

## 6. Catalog 与 management API

公开端点：

```text
GET /api/v2/plugins/catalog
```

它不返回 installation path、executable、working directory、PID、stderr、session token、
capability handle 或 secret。受保护端点位于 `/api/v2/plugins/manage/*`，包括：

- sanitized diagnostics 和 permission summary；
- enable、disable、rollback、uninstall；
- grant、deny、revoke；
- command invoke、manual job run；
- settings read/write 和 notification projection。

management guard 同时要求 loopback TCP client、loopback Host、无 forwarded headers、精确 Origin
和 ephemeral session；mutation 再要求 CSRF 与显式 user-action ID。token 不通过 HTTP 返回。
Phase 7 前没有可信桌面 handoff 或 Plugin Manager UI，因此当前主要由嵌入测试/显式集成消费，
本地安装仍使用 Phase 3/4 CLI。

## 7. 参考插件

`Hello Command` 证明 disabled/active catalog 和首次 command invoke 的 lazy activation。
`Scheduled Notification` 不包含 UI，声明 `notification/1` + `job/1`，请求
`notifications.show` + `jobs.schedule`，并在 job invoke 中通过双向 `host.call` 发布 toast。

集成测试从真实 SDK 源构建 wheel 和 `.cspkg`，执行离线安装、grant、enable、product start、
manual job、Host call、notification receipt、permission revoke 和完整 process reclaim。SDK package
smoke 还会在全新 venv 中确认 Scheduled Notification 模块、manifest resource 和 console entry
point 确实包含在构建 wheel 内。

## 8. 退出门与自动化证据

| 退出门 | 证据 |
| --- | --- |
| disabled 零 process/subscriber/job | default-off bootstrap 与 disable/reconcile 集成用例 |
| crash 只影响自身 | Phase 2 supervisor/manager transport-fatal 与多 owner 回归；产品组合根不接触 Data Engine 私有对象 |
| storage 跨 plugin/publisher/quota 拒绝 | lease-derived namespace、三 namespace 负例、transaction quota rollback |
| event queue 有界且 producer 不阻塞 | 1-slot 慢 subscriber + 100 次同步 publish/drop 计数 |
| disable/revoke 清除 handle/job/event/late result | scheduled reference revoke、manager generation 与 capability revoke 回归 |
| migration 失败保留旧状态且 snapshot 可恢复 | 失败 transaction、成功 migration、显式 restore 与 dataVersion 校验 |

| 自动化门禁 | 最终结果 |
| --- | --- |
| Phase 5 core | 9 passed |
| 加固后的 core + installer 定向 | 16 passed |
| 完整 backend 独占回归 | 2032 passed；4 条既有 FastAPI `on_event` 弃用警告 |
| 公共 SDK | 59 passed |
| SDK build/package smoke | wheel + sdist 构建成功；全新离线 venv、v1/v2 transcript、新 reference 资源/入口通过 |
| static | Phase 5 范围 Ruff、format、compileall、`git diff --check` 全通过 |

首轮把 SDK 与 backend 全量并行运行时，Windows CPU quota 用例为 8.281s，超过固定 8s 门
0.281s；隔离复跑 5.05s 通过。第二轮 backend 独占运行时，独立 Replay 用例的 0.2s shutdown
窗口在套件尾部抖动，隔离复跑 0.88s 通过。没有修改这两个无关阈值；第三轮 backend 独占运行
获得上述 2032 项全绿结果。

完整 backend 通过后只增加了 diagnostics `loadFailures` 的路径脱敏投影及其断言，没有修改
生命周期或执行路径；最新 Phase 5 core 9 项已重新全量覆盖该收口。

## 9. 保留边界与下一阶段

以下陈述仍然不成立：

- “任意社区 wheel 已可在产品默认路径安全执行”；
- “`untrusted` 可以只靠一个环境字符串启用”；
- “插件已能读取 CandleScope 行情、订单簿或图表上下文”；
- “插件能注入主页面组件或自定义 JavaScript”；
- “network/files/secrets/accounts/trade permission 已有 Host adapter”；
- “publisher 已签名，Marketplace 可以开放”。

环境 bootstrap 明确拒绝自动推断 `untrusted` SandboxPolicy。只有调用方能提供经过验证的
AppContainer installation/runtime/private roots 时才可构造 untrusted 组合根；否则继续
`first-party-pinned`/`local-trusted`。Phase 6 应只新增只读 market data consumer 和
`chart-layer/1` Render IR，不能顺手开放网络、provider 或交易能力。

## 10. 回滚

Phase 5 是 additive 且默认关闭，可独立回滚：

1. 保持 `CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED=0`，停止组合根；
2. 从 `app.main` 移除 v2 router/lifecycle/health 投影；
3. revert `app.plugin_core_v2`、manager 动态 owner、static activation verifier 和 SDK scheduled
   reference；
4. 保留 Phase 3 immutable installations/registry/history 与 Phase 4 grants/audit，不删除用户数据；
5. v1 Pyne/Pine indicator runtime、Data Engine、业务 SQLite、HTTP/WS 和前端均不需要迁移。

如需删除 v2 private/settings，必须另做显式、可确认的数据删除动作，不能把它隐含在代码回滚或
plugin uninstall 中。
