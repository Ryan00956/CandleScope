# Plugin Platform V2 Phase 11B WP-E 执行记录

日期：2026-07-23

## 1. 结论

WP-E 已完成并通过技术验收：CandleScope 现在具备默认关闭、Host 原生且持久化的
Live 权限控制层，包括 `DISARMED` / `ARMED` / `KILLED` 状态、intent-bound
短期单次确认回执、global kill/revoke、持久 Live 横幅、Host modal 和可离线验证的
脱敏审计导出。

这不是 Live 交易执行交付。本阶段没有增加 submit、cancel、amend、transfer、
withdraw、通用签名或任意认证网络方法；没有确认回执消费 API，也没有向插件 SDK、
manifest、sandbox iframe 或普通 network gateway 暴露 Live 权限。WP-F 尚未授权。

## 2. 启用边界

WP-E 只有在以下四个 Host feature flag 同时启用时才可用：

- `CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENABLED`
- `CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENABLED`
- `CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_RECONCILIATION_SHADOW_ENABLED`
- `CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_NATIVE_CONTROL_ENABLED`

平台还必须通过 WP-A 的 `first-party-pinned` evidence。任一依赖、trust、vault、
Broker handshake、policy epoch 或持久状态验证失败时都 fail closed。flag 关闭时
不创建、不打开 WP-E control store，也不注册 Host mutation 路由。

生产 release lock 继续为空；本阶段没有真实 credential、testnet 或 production
交易所调用。

## 3. 已实现合同

### 3.1 Broker 私有控制账本

- 新增独立的 `live-control-v1.sqlite3`，不修改 WP-C state 或 WP-D shadow journal。
- SQLite/WAL 使用精确 schema、外键、固定 index 集合和 append-only SHA-256
  event chain；未知表、列、index、view、trigger 或 event/projection 不一致都会
  阻止 Broker 启动。
- 新 store 总是从 `disarmed` 开始，绝不从配置或旧内存状态恢复为 `armed`。
- control generation 与 Broker policy epoch 一起约束所有确认回执。
- restart 保留控制投影；发现控制投影与 policy 不一致时保守恢复为 `killed`。

### 3.2 Host-only 确认

- `preview` 从当前 `prepared` shadow 和 account binding 生成精确 intent，包含
  instrument、side、order type、quantity、limit price、client order ID、
  plugin、publisher、connector、intent hash、policy epoch 和 control generation。
- Host 原生 modal 显示精确 intent；typed confirmation 后才可 `issue`。
- receipt 是 15–120 秒的 opaque bearer reference，数据库只保存它的 SHA-256。
- receipt 严格绑定 account、shadow、intent、client order ID、plugin、publisher、
  connector、policy epoch 和 control generation。
- duplicate issue、过期、stale epoch/generation、cross-account/cross-shadow 或
  shadow 已进入 reconciliation 均被拒绝。
- 内部原子 consume primitive 已用并发测试冻结为 single-use，但 WP-E 协议、API、
  SDK 和 iframe 均没有 consume 方法。它只能由未来单独授权的 Broker execution
  工作包调用。

### 3.3 Kill 与 revoke

- `disarm` 阻止新 receipt 并撤销全部 outstanding receipt。
- `global kill` 在返回前推进 policy epoch、清除 credential/account binding、
  撤销全部 outstanding receipt，并持久化 `killed`。
- grant revoke、plugin disable/rollback/uninstall、publisher revoke、credential
  revoke/rotation 都复用同一保守 authority-revoke 路径。
- `killed` 后重新 arm 需要显式 Host acknowledgement；被清除的 credential/account
  不会被自动恢复。

### 3.4 Host UI 与安全边界

- public API 只暴露可安全显示的 control projection。
- mutation API 继续要求 loopback、session、CSRF、fresh user action 和 exact body。
- Live 横幅属于 Host 主文档，持续显示 `DISARMED`、`ARMED`、`KILLED` 或
  `UNAVAILABLE`；关闭控制面板不会隐藏横幅。
- typed arm/disarm/kill/revoke 与 exact-intent confirmation 使用 Host modal，
  层级高于所有 sandbox iframe。
- iframe 不获得 control token、confirmation draft、receipt 或 audit export。

### 3.5 审计导出

- 导出格式为 `candlescope.live-audit-export/1`。
- 导出同时包含完整 WP-E control event chain、完整 WP-D shadow event chain、
  source heads、当前投影和最终 envelope SHA-256。
- 导出只写 opaque handle 的 hash；不包含 credential、认证 header、签名、
  passphrase、原始 venue order ID、原始网络响应或原始 opaque reference。
- `backend/scripts/verify_live_audit_export.py` 可在 Host/Broker 外独立验证 schema、
  两条事件链、source heads 和最终 digest。

## 4. 回滚与归档

回滚顺序固定为：

1. 在 Host 执行 global kill。
2. 下载审计导出并离线验证。
3. 停止 Broker，确认没有持有 Broker 根目录锁。
4. checkpoint、验证并归档 `live-control-v1.sqlite3`、`-wal`、`-shm` 和审计导出。
5. 只有显式传入 `--confirm-remove-source` 才删除归档后的源 SQLite 三件套。
6. 关闭 WP-E flag，再回退 WP-E 独立提交。

从 `backend` 目录执行：

```powershell
python -m scripts.verify_live_audit_export <audit-export.json>

python -m scripts.archive_live_control_v1 `
  --root <broker-private-root> `
  --audit-export <audit-export.json> `
  --archive-path <live-control-archive.zip> `
  --confirm-killed `
  --confirm-remove-source
```

归档工具要求 audit 已验证且最终 control mode 为 `killed`，并通过独占目录锁确认
Broker 已停止；归档写入 manifest、audit 与完整 SQLite checkpoint。WP-C 的旧
downgrade 工具发现 WP-D journal 或 WP-E control store 时会拒绝降级，避免旧代码
静默忽略新状态。

## 5. 自动化验证

最终源代码上的门禁结果：

- WP-E control 聚焦测试：`11 passed`
- 受影响 backend 回归：`113 passed in 94.93s`
- backend 全量：`2152 passed, 4 warnings in 333.16s`
- SDK 全量：`80 passed in 0.96s`
- frontend WP-E 聚焦：`17 passed`
- frontend 全量：`2357 passed in 23324.8437 ms`
- frontend architecture boundary：通过
- frontend plugin sandbox boundary：通过，仍为 `16 host files, one opaque-origin sandbox gateway`
- frontend typecheck、lint、production build：通过
- changed Python Ruff 与 compile/py_compile：通过

backend 的 4 条 warning 是既有 FastAPI `on_event` deprecation。frontend build
仍有既有的 `>500 kB` chunk 提示；frontend 全量测试仍打印一个不导致失败的既有
`24678` WebSocket 端口诊断。以上没有被包装成“零告警”。

## 6. 真实浏览器证据

在本机端口 `18135` 启动真实 production frontend build 和 Phase 11 fixture
backend，使用私有 Broker、fake vault、空 production lock，未使用真实 credential：

1. 页面初始为 `DISARMED`。
2. typed ARM 后变为 `ARMED`。
3. typed global kill 后变为 `KILLED`。
4. reload 后仍保持 `KILLED`。
5. banner 为 Host fixed layer，计算后的 `z-index` 为 `2100`。
6. Host modal 为 `aria-modal` fixed layer，父层 `z-index` 为 `2400`。
7. 交互面扫描没有 Live submit、cancel、amend、transfer 或 withdraw 动作。
8. 浏览器 console error 为 0。

下载的审计导出离线验证结果：

```text
LIVE_AUDIT_EXPORT_OK control=3 shadow=0 digest=sha256:e88569def4653385dd1aba2d2140c0ca2f49875c26b9647b97ed1ad0ace7f6aa
```

导出文件 SHA-256：

```text
645E49BF0B748AFB27092C79E71C8D88871BECA45F074A8BCB961E6EE971969A
```

本地、被 Git 忽略的运行证据位于：
`frontend/output/playwright/phase11e-wpe-20260723-run1/`。

## 7. 停止门

WP-E 到此独立提交并停止。当前平台只具备 Live authority/control/audit 基础，
仍不具备任何 Live 订单或资金 mutation。以下内容必须分别重新设计、授权和验收：

- WP-F 的单一 build-pinned testnet submit/cancel 路径；
- venue response 与 durable journal 的执行态迁移；
- 风控、限额、撤单、断线恢复和 operator runbook；
- 真实 Demo/testnet compatibility；
- production Live credential、production lock 和正式上线。

因此，WP-E 测试通过不能解释为已经兼容 OKX Demo 下单，更不能解释为 production
Live 已可用。
