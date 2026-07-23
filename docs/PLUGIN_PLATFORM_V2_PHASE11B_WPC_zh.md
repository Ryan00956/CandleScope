# CandleScope 通用插件平台 v2 — Phase 11B WP-C 执行记录

- 日期：2026-07-23
- 分支：`codex/plugin-platform-v1`
- 方案：Option 3 — 独立 Live Transaction Broker
- 工作包：WP-C — OKX Demo Spot read-only account binding
- 状态：技术验收完成、默认关闭；没有订单查询、下单、撤单或生产 Live

## 1. 阶段结论

WP-C 在 WP-B 的独立 Broker 内增加了第一个认证只读账户边界：

- connector identity 固定为 `candlescope.okx-demo-spot-readonly`；
- venue/environment/product 固定为 `okx / demo / spot`；
- API key 权限集合必须精确等于 `{read_only}`，含 `trade` 或 `withdraw`
  立即拒绝；
- Broker 只拥有两个认证网络动作：
  `GET /api/v5/account/config` 与
  `GET /api/v5/account/balance`；
- Host 只得到 `acct_` opaque reference 和脱敏 metadata；
- 插件 API、公开 SDK、management API、前端和 Paper Runtime 均未增加 Live
  account handle。

这代表“build-pinned 只读账户绑定边界已实现”，不代表已实现 Live 交易。默认 feature
flag 仍为 false，production release lock 仍为空。

## 2. 私有协议

协议升级为 `candlescope.live-broker/2`，在 WP-B 的七个方法上只增加：

```text
account.discover
account.describe
account.rebind
```

allowlist 仍没有 `query`、`sign`、`order`、`trade`、`submit`、`cancel`、`amend`、
`transfer` 或任意 URL/method。旧 client/worker 因协议版本不匹配 fail closed。

`account.discover` 必须使用当前 policy epoch 的 build-pinned credential。
同一 canonical account 不能静默覆盖；credential rotation 必须走 `account.rebind`，
重新执行两个认证只读请求并证明 canonical digest 相同。credential revoke 会把依赖
binding 标成 `credential-revoked`；policy advance 清空全部 account binding。

## 3. Credential、身份与持久状态

vault plaintext 是有界、exact-field、strict JSON，包含 OKX Demo API key、secret key
和 passphrase。重复 key、未知字段、错误 venue/environment、控制字符和大小越界全部
拒绝。明文只在 Broker 内短暂打开；DPAPI record、状态 JSON、response、argv、env、
stderr 与测试临时文件均通过 canary 扫描。

原始 `uid`、`mainUid` 不持久化也不返回。canonical identity 为：

```text
sha256("okx\0demo\0spot\0" + mainUid + "\0" + uid)
```

Broker state schema v2 只保存 account reference digest、canonical digest、
credential handle digest、connector/publisher/release digests、generation、模式、
资产数量、状态、时间和 policy epoch。feature 关闭时新状态仍写 schema v1，不发生
隐式迁移；只有显式打开 WP-C 时，已验证的 v1 才原子升级到空 account 集合的 v2。

Windows current-user DPAPI 重启测试证明 credential ciphertext 与 account binding
可重开，磁盘文件不含 secret canary。

## 4. 专用认证 transport

生产 transport 固定：

- host/port：`openapi.okx.com:443`；
- method：仅 `GET`；
- path：仅 account config 与 balance；
- Demo header：固定 `x-simulated-trading: 1`；
- 签名：Broker 内部为每个固定 path 生成 OKX HMAC-SHA256 signature；
- DNS：默认或注入 resolver 的所有结果都必须是公网 IP；
- connect：连接已验证 IP，TLS SNI/hostname 仍固定为 `openapi.okx.com`；
- TLS：系统 CA、hostname verification、最低 TLS 1.2；
- response：200、单一 JSON content type、1 MiB body 上限、strict JSON；
- redirect、proxy、WebSocket、通用 signer：不存在。

依据是 [OKX API guide](https://www.okx.com/docs-v5/en/) 对 API key 权限、Demo header、
账户配置和余额接口的公开合同；域名更新依据
[OKX API changelog](https://www.okx.com/docs-v5/log_en/)。

本工作包没有使用用户 credential，也没有发起真实 OKX Demo 认证 smoke。fake
transport 覆盖签名、响应和权限合同；worker start/health 证明未调用 discovery 时没有
DNS/网络。真实 Demo 兼容性必须在未来由用户提供专用纯只读 Demo key 后作为单独 smoke
验证，不能从 mock 结果推断。

## 5. Feature gate

启用只读绑定必须同时满足：

```powershell
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED='1'
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST='first-party-pinned'
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENABLED='1'
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENABLED='1'
```

最后一个开关默认 `0`。foundation=false、trust 不是
`first-party-pinned`、release evidence 不匹配、vault 不可用或权限不是纯
`read_only` 时全部 fail closed。单独打开 feature 不会向 production 空 release lock
添加 connector，也不会让普通插件获得账户能力。

## 6. 验证证据

使用绝对源码路径：

```powershell
$env:PYTHONPATH='H:\program\CandleScope-plugin-platform\backend;H:\program\CandleScope-plugin-platform\packages\candlescope-plugin-sdk\src'
$env:PYTHONIOENCODING='utf-8'
$env:PYTHONUTF8='1'
```

最终结果：

- WP-A/WP-B/WP-C 聚焦：49 passed；
- Core/Host/Capability/Paper/management 受影响回归：109 passed；
- backend 全量：2127 passed、0 failed、8 warnings，耗时 369.47 秒；
- SDK 全量：80 passed；
- frontend：architecture、plugin boundary、typecheck、ESLint、2353 tests 与
  production build 全部通过；
- Ruff、`compileall`、`git diff --check`：通过。

8 条 backend warning 为 4 条既有 FastAPI `on_event` deprecation 和 4 条 Windows
AppContainer 测试 subprocess reader 的本地编码 warning；没有 WP-C failure。此前
WP-B 记录的 Windows Job Object 零等待 residual 已由 `2fedb4f` 改为有界 2 秒回收门，
连续隔离复跑及本次全量均通过。

负向覆盖包括：trade/withdraw 权限、未知/重复 credential 字段、非固定 path/header、
默认与注入 resolver 的私网地址、duplicate account、cross-account rebind、revoked
credential、stale account、feature-off schema 保持、v1→v2 migration、显式
v2→v1 downgrade、DPAPI restart、secret/raw UID canary 和协议架构扫描。

## 7. 回滚

优先回滚方式是保持 WP-C 代码、关闭 read-only flag。若必须把代码回退到 WP-B：

1. 把 `CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENABLED` 设为 `0`；
2. 停止 Broker；
3. 确认仓库没有 WP-D journal/order 状态；
4. 备份 DPAPI ciphertext；
5. 使用受测工具把 state v2 的只读 account metadata 显式降为 v1：

```powershell
Push-Location 'H:\program\CandleScope-plugin-platform\backend'
python -m scripts.downgrade_live_broker_state_v2_to_v1 `
  --root 'C:\managed\candlescope-plugin-platform-v2\live-broker-v1' `
  --backup-path 'C:\managed\backups\broker-state-v2-before-wpc-rollback.json' `
  --confirm-drop-account-bindings
Pop-Location
```

工具要求输入严格为 schema v2、backup 不存在，并先以 exclusive create 保存原始字节，
再原子写 v1；有 account binding 而没有显式确认时不修改任何文件。它保留 credential
metadata 和 DPAPI ciphertext，只删除 WP-C account metadata。

## 8. 未开放能力与下一门

WP-C 仍没有：

- order/history query 或 private WebSocket；
- journal、stable venue client order ID 或 reconciliation；
- risk/confirmation/audit export 的 Live 合同；
- submit、cancel、amend、transfer、withdraw、leverage 或 production Live；
- `secrets.use`、`trade.submit`、`trade.cancel` grant；
- 真实 Demo key、真实资金或任何自动化交易。

下一工作包是 WP-D：durable journal、稳定订单身份和 query-only reconciliation
shadow。它需要新的明确授权；本提交在 WP-C 停止，不会自动继续。
