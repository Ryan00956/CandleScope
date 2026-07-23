# WP-D Implementation Plan: Durable Journal And Query-only Reconciliation Shadow

## Decision

2026-07-23，用户明确授权 Option 3 的 WP-D。WP-D 继续绑定 WP-C 的
`okx / demo / spot` 与
`candlescope.okx-demo-spot-readonly`，但只增加：

- Broker 私有 durable shadow journal；
- Host 分配且永不复用的稳定 OKX `clOrdId`；
- `GET /api/v5/trade/order` query-by-client-ID；
- crash/restart 后的显式 `unknown` 恢复与 query-only reconciliation。

WP-D 不发送订单。协议、connector 和测试中都不得存在 submit/cancel/amend/transfer
动作；第一次允许 testnet submit 仍是 WP-F。

OKX 官方合同说明：

- Order details 是 `GET /api/v5/trade/order`，需要 `Read` permission；
- `instId` 必填，`ordId`/`clOrdId` 二选一；
- `clOrdId` 最长 32 位、区分大小写、只含字母数字；
- venue 只对 pending order 强制 `clOrdId` 唯一，终态后允许复用；
- 若历史上复用，按 `clOrdId` 查询只返回最新一笔。

因此 CandleScope 的合同比 venue 更严格：由 Broker 生成 32 位字母数字 ID，在一个
Broker journal 生命周期内永不删除、永不复用。不能依赖 venue 的 pending-only
唯一约束证明历史身份。

参考：

- [OKX API guide](https://www.okx.com/docs-v5/en/)；
- [OKX order placement guide](https://www.okx.com/docs-v5/trick_en/)；
- [OKX API changelog](https://www.okx.com/docs-v5/log_en/)。

## Storage Decision

WP-D 选择 Broker 私有 SQLite/WAL，而不是原子 JSON 全文件重写或裸 append log：

- `shadow_order` projection、唯一 idempotency digest、唯一 `clOrdId` 和 append-only
  event 可在同一 `BEGIN IMMEDIATE` transaction 内提交；
- WAL 能覆盖进程退出后的 committed transaction recovery；
- `synchronous=FULL`、foreign keys、schema version、quick check 与 event hash chain
  提供明确的 fail-closed 启动门；
- bounded row/event/attempt limits 防止 journal 变成无限内存索引；
- WP-D rollback 可保留数据库原样，WP-C 代码不会打开或删除它。

文件固定为：

```text
live-broker-v1/live-order-shadow-v1.sqlite
live-broker-v1/live-order-shadow-v1.sqlite-wal
live-broker-v1/live-order-shadow-v1.sqlite-shm
```

数据库只存脱敏 Broker-owned metadata，不存 API key、passphrase、认证 header、
signature、raw account reference 或 raw idempotency key。

## Shadow Intent Contract

WP-D 只冻结最小 Spot limit DTO：

```text
idempotencyKey  intent_<43 base64url chars>
accountRef      acct_<43 base64url chars>
instrumentId    BASE-QUOTE
side            buy | sell
orderType       limit
quantity        canonical positive decimal
limitPrice      canonical positive decimal
```

Broker 校验 active canonical account、current policy epoch 与 build-pinned connector，
然后在一个 durable transaction 中：

1. 计算 raw idempotency key 的 SHA-256，不持久化 raw key；
2. 计算 exact canonical intent SHA-256；
3. 由 broker ID + idempotency key 的 HMAC 生成稳定 `shdw_` reference；
4. 由不同 domain-separated HMAC 生成 32 位字母数字 `clOrdId`；
5. 插入 `prepared` projection 和 append-only `prepared` event。

同一个 idempotency key + 同一 intent 返回相同 reference/client ID；相同 key 配不同
intent 必须冲突。不存在 delete/reuse 方法。

## Journal State Machine

WP-D 状态为：

```text
prepared
  -> querying
  -> live | partially_filled | filled | canceled | mmp_canceled
  -> unknown

unknown | live | partially_filled
  -> querying
```

`querying` 必须在 HTTPS 前 durable commit。成功响应在第二个 transaction 中写 projection
与 event；transport/response 失败写 `unknown`。若 worker 在两者之间退出，下一次打开
journal 会把残留 `querying` 原子恢复成 `unknown` 并追加 recovery event。

终态不能继续 query。`order not found`、空 data、未知 venue code/state、client ID/
instrument mismatch 都不能证明安全重试，只能保持 `unknown`。WP-D 没有 retry submit
路径，因此任何异常都不会产生资金动作。

每个 event 存 global sequence、previous event digest 和 canonical event digest。启动时
验证完整 hash chain、projection 类型/枚举、唯一约束、broker identity 与
`PRAGMA quick_check`；失败时 Broker 不开放 journal/reconciliation。

## Query-only Connector

生产 connector 只构造：

```text
GET /api/v5/trade/order?instId=<validated>&clOrdId=<broker-generated>
```

约束：

- origin 继续固定 `openapi.okx.com:443`；
- Demo header 固定 `x-simulated-trading: 1`；
- query order 与签名 prehash 使用同一个 canonical target；
- `instId` 与 `clOrdId` 都通过字符/长度校验后直接拼成唯一 canonical query order；
- 不接受 `ordId`、额外 query、重复 key、fragment、任意 path 或任意 method；
- DNS/public-IP、TLS、body/header/status limit 继承 WP-C transport；
- response 只读取 required order fields，raw body/auth/signature 不进入 journal/error；
- credential 仍只能从 Broker vault context 打开。

WP-C account connector 仍声明两个 network methods；WP-D 独立 query connector 只声明
一个。health 在 shadow flag 打开时报告总计三个，不把 query 伪装成零网络。

## Private Protocol

协议只增加：

```text
shadow.prepare
shadow.describe
shadow.reconcile
```

- `shadow.prepare` 只写本地 journal；
- `shadow.describe` 只读脱敏 projection；
- `shadow.reconcile` 是唯一可能触发 WP-D 认证网络的方法，而且永远是 GET query。

没有插件可见 API、SDK contribution、management endpoint 或 Live grant。Host-side
controller 类型同样是 internal，不进入普通插件 RPC。

## Feature Gate

新增：

```text
CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_RECONCILIATION_SHADOW_ENABLED=0
```

必须同时满足：

- Plugin Platform v2 enabled；
- trust = `first-party-pinned`；
- Broker foundation enabled；
- WP-C read-only account enabled。

false 时不打开/创建 SQLite、不构造 query connector、不增加第三个网络方法。已有 journal
文件保持原样，不读取、不迁移、不删除。

## Migration And Rollback

WP-D 不改变 Broker JSON schema v2；它新增独立 journal schema v1。首次显式启用时创建，
以后只接受精确 schema v1。未知 schema、损坏 WAL、broker ID mismatch 或 event chain
错误全部 fail closed。

回滚 WP-D：

1. 关闭 shadow flag；
2. 停止 Broker；
3. checkpoint/备份 SQLite、WAL、SHM；
4. 保留 unresolved journal，不删除；
5. 回退 WP-D commit，WP-C 忽略 journal 文件。

WP-C→WP-B 降级工具在发现 WP-D journal 文件后必须拒绝，直到 operator 把 journal 三件套
完整归档到明确位置；不能把账户 metadata 降级后留下无法解释的 order identity。

## Acceptance Gates

- protocol 只有三个 shadow 方法，无 submit/cancel/order mutation；
- stable `clOrdId` 长度/字符符合 OKX，journal 内永久唯一；
- same idempotency/same intent 幂等，same key/different intent 冲突；
- durable write 在 query 前可观察，所有 query attempt 都有 event；
- crash at pre-query/post-response-pre-persist 恢复为 `unknown`；
- query transport 可以安全重试，但任何路径都不能 retry submit；
- terminal、credential-revoked、cross-account、stale epoch 全部拒绝；
- response client ID/instrument/state mismatch 保持 `unknown`；
- SQLite/WAL restart、hash-chain corruption、schema mismatch、limits fail closed；
- feature off 零 journal create/open、零 query connector、WP-C network count 保持 2；
- secret/raw account/idempotency canary 不进入 journal、response、stderr、argv/env；
- Paper runtime 和数据保持不变；
- focused、affected、backend full、SDK、frontend 与 diff hygiene 重新验证。

## Stop Gate

完成 WP-D 只表示“query-only reconciliation shadow ready”。WP-E 的 Host-native
confirmation、persistent Live control、kill/revoke 与 audit export 需要新的明确授权。
WP-F 前不得出现 submit/cancel；真实 Demo query smoke 需要用户提供专用纯只读 Demo
credential，不能由 fake connector 测试替代。
