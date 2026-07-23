# WP-C Implementation Plan: OKX Demo Read-only Account Binding

## Decision

2026-07-23，用户授权继续 Option 3 的下一工作包。WP-C 选择第一个
build-pinned 目标为：

- venue：`okx`；
- environment：`demo`；
- product scope：`spot`；
- connector identity：`candlescope.okx-demo-spot-readonly`；
- credential permission：必须严格为 `read_only`；
- vault：继续使用 WP-B 已验证的 Windows current-user DPAPI store；
- transport：Broker 私有、operation-specific HTTPS transport。

选择 OKX Demo 是因为 CandleScope 已有 OKX 市场标识与 spot 语义，而且 OKX 官方
文档明确区分 `Read`、`Trade`、`Withdraw` 权限；Demo 请求需要
`x-simulated-trading: 1`，账户配置响应提供 `uid`、`mainUid`、`perm`、账户模式等
建立规范身份所需信息。

参考：

- [OKX API guide](https://www.okx.com/docs-v5/en/)；
- [Binance Spot request security](https://developers.binance.com/en/docs/products/spot/rest-api)。

Binance 仍是后续可选 connector，但不在 WP-C 同时实现，避免一次工作包引入两套认证
和账户语义。

## Authorized Scope

WP-C 只增加：

1. OKX Demo credential envelope 的严格解析；
2. 固定 `GET /api/v5/account/config` 与
   `GET /api/v5/account/balance` 的 Broker-owned 签名和 HTTPS；
3. `account.discover`、`account.describe`、`account.rebind` 三个私有 Broker 方法；
4. canonical account binding、credential generation、状态迁移和恢复；
5. 默认关闭的独立 read-only account feature flag；
6. fake transport、协议、状态、secret canary、DNS/TLS 与权限负向测试。

WP-C 明确不增加：

- 任意 URL、任意 method 或通用 signer；
- order/history query、WebSocket private stream；
- submit、cancel、amend、transfer、withdraw、deposit、borrow、leverage；
- `trade.submit`、`trade.cancel`、`secrets.use` 或新的插件 grant；
- 插件可见 API、management API 或原生 Live UI；
- 真实 API key、真实 Demo 账户 smoke；
- production Live。

## Credential Contract

Vault plaintext 是有界 strict JSON：

```json
{
  "schemaVersion": 1,
  "venue": "okx",
  "environment": "demo",
  "apiKey": "<secret>",
  "secretKey": "<secret>",
  "passphrase": "<secret>"
}
```

字段缺失、未知字段、重复 JSON key、错误 venue/environment、控制字符、大小越界全部
失败。解析、签名和 transport 错误不把字段值写入 response、stderr、exception
details、state 或临时文件。

`credential.put` 仍只返回 `cred_` opaque handle。WP-C 不增加 reveal/use/sign
方法；credential plaintext 只在 Broker 内为两个固定 GET 短暂打开，并在使用后对
可变 buffer 做 best-effort wipe。

## Canonical Account Contract

账户发现必须同时满足：

1. credential 来自当前 policy epoch；
2. publisher evidence 仍匹配 Host build 内置 release lock；
3. connector identity 精确等于
   `candlescope.okx-demo-spot-readonly`；
4. Demo header 固定为 `x-simulated-trading: 1`；
5. `/account/config` 的权限集合精确等于 `{read_only}`；
6. config 与 balance 都返回 OKX success code；
7. `uid`、`mainUid`、account mode 和 position mode 通过严格类型/长度检查。

Broker 不持久化或返回原始 `uid`/`mainUid`。规范身份为：

```text
sha256("okx\0demo\0spot\0" + mainUid + "\0" + uid)
```

对 Host 返回稳定的 `acct_` opaque reference；state 只保存 reference digest、
canonical digest、connector/publisher digests、credential handle digest、
credential generation、模式、资产数量、时间与 policy epoch。

`account.discover` 不静默替换既有 binding。同一 canonical account 已存在时必须调用
`account.rebind`；新 credential 必须重新执行两个只读查询，得到相同 canonical
digest，且仍是纯 `read_only` 权限，才能原子增加 generation。不同账户、不同
connector、旧 epoch 或已撤销 credential 全部拒绝。

credential revoke 会把依赖账户标成 `credential-revoked`；policy epoch advance
使所有旧 account reference 失效。WP-C 没有订单，因此无需 drain 或 venue cleanup。

## Transport Contract

生产 transport 固定：

- host：`openapi.okx.com`；
- port：`443`；
- scheme：HTTPS；
- method：GET；
- paths：仅 `/api/v5/account/config` 与
  `/api/v5/account/balance`；
- redirect：拒绝；
- proxy/environment routing：不使用；
- DNS：所有解析结果必须是 public IP，连接使用已验证 IP，TLS SNI/hostname 仍使用
  固定 host，避免二次解析；
- TLS：系统 trust store、hostname verification、最低 TLS 1.2；
- response：状态必须 200，JSON body 有硬上限，重复 key 拒绝；
- timeout：DNS、connect/read 与整个 Broker request 都有界。

WP-C 不做静态证书/SPKI digest pin：OKX 没有在所引用官方接口合同中发布稳定 pin，
硬编码当前证书会把正常轮换变成不可恢复故障。这里的 TLS pin 指固定 origin、验证后
IP、SNI/hostname 和系统 CA 验证；若未来需要 SPKI pin，必须有双 pin 轮换和独立
运维工作包。

## State And Migration

Broker state 从 schema v1 升到 v2：

- v1 只含 credentials/pending deletes；
- v2 additive 增加 account bindings；
- feature false 时新状态继续写 v1，且读取 v1 不迁移；
- 只有 feature true 时，读取 v1 才先严格验证，再原子写成 accounts 为空的 v2；
- 已存在 v2 即使随后关闭 feature 也不被隐式降级；
- 未知 schema、半迁移 state 或 active account 指向缺失 credential 时 fail closed；
- state 写盘成功后才发布新的内存 binding。

回滚 WP-C 前必须：

1. 关闭 read-only account flag；
2. 停止 Broker；
3. 确认没有 WP-D journal/order；
4. 备份 v2 state 与 DPAPI ciphertext；
5. 使用
   `backend/scripts/downgrade_live_broker_state_v2_to_v1.py`
   备份并删除只读 account metadata 后写回 v1，或保留 WP-C 代码但关闭功能；不能让
   旧 WP-B 直接读取未知 v2。

## Feature Gates

新增：

```text
CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENABLED=0
```

约束：

- 默认 false；
- 只有 foundation flag 同时为 true 且 Core trust 为
  `first-party-pinned` 才可启用；
- false 时不构造 connector、不解析 credential、不做 DNS/网络、不创建 account；
- production release lock 继续为空，因此仅打开 flag 仍没有可用 connector evidence。

## Acceptance Gates

- protocol bump 后旧 client/worker 组合 fail closed；
- only three account methods；没有 order/trade/submit/cancel/generic sign；
- exact two authenticated GET paths；错误 host/path/method/header 被拒绝；
- API key 权限含 `trade` 或 `withdraw` 时在 account persistence 前拒绝；
- secret canary 不出现在 state、response、stderr、argv、env、exception、临时文件；
- raw `uid`/`mainUid` 不出现在持久 state 或 Host response；
- duplicate discovery、cross-account rebind、stale epoch、revoked credential 拒绝；
- v1→v2 migration、restart、DPAPI reopen、credential revoke/rebind 通过；
- feature off 为零 DNS、零 socket、零 account state；
- Broker crash 不改变 Paper；
- WP-B Windows job teardown residual gate 保持绿色；
- 聚焦、关联、backend 全量、SDK、frontend 与 diff hygiene 重新验证或明确记录新
  blocker。

## Stop Gate

完成 WP-C 也只代表“认证只读账户 binding ready”。WP-D 的 journal、稳定 venue
order identity、query-only reconciliation shadow 需要新的明确授权；WP-F 前没有
submit/cancel，任何测试通过都不会自动启用真实 Demo 或 production Live。
