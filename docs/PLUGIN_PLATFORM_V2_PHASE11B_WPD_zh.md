# CandleScope 通用插件平台 v2 — Phase 11B WP-D 执行记录

- 日期：2026-07-23
- 分支：`codex/plugin-platform-v1`
- 方案：Option 3 — 独立 Live Transaction Broker
- 工作包：WP-D — durable journal、稳定订单身份与 query-only reconciliation shadow
- 状态：技术验收完成、默认关闭；没有下单、撤单或生产 Live

## 1. 阶段结论

WP-D 在 WP-C 的 `okx / demo / spot` 纯只读账户边界内增加了订单身份与只读对账基础：

- Broker 私有 SQLite/WAL journal，固定 schema v1、`synchronous=FULL`；
- Broker 生成且永不复用的 32 位字母数字 OKX `clOrdId`；
- 同 idempotency key + 同 intent 返回同一 shadow/client ID，不同 intent 冲突；
- 唯一认证网络增量是
  `GET /api/v5/trade/order?instId=...&clOrdId=...`；
- query 前先 durable 写 `querying`，成功或失败再写第二个 transaction；
- crash 留下的 `querying` 在下次打开时恢复为 `unknown`，不会触发 submit retry；
- Host 只得到 `shdw_` opaque reference 和脱敏 projection。

这只代表“query-only reconciliation shadow ready”。代码中没有 submit、cancel、
amend、transfer 或 withdraw；普通插件、公开 SDK、management API、前端和 Paper
Runtime 都没有获得 Live order capability。

## 2. 私有协议与状态机

Broker 协议升级为 `candlescope.live-broker/3`，只增加：

```text
shadow.prepare
shadow.describe
shadow.reconcile
```

`shadow.prepare` 只写本地 journal，`shadow.describe` 只读脱敏 projection，
`shadow.reconcile` 是 WP-D 唯一认证网络入口，而且只能执行固定 GET。

冻结的最小 intent 是 Spot limit：

```text
idempotencyKey  intent_<43 base64url chars>
instrumentId    BASE-QUOTE
side            buy | sell
orderType       limit
quantity        canonical positive decimal
limitPrice      canonical positive decimal
```

状态机为：

```text
prepared -> querying
querying -> unknown | live | partially_filled | filled | canceled | mmp_canceled
unknown | live | partially_filled -> querying
```

终态不能再 query。transport 失败、venue not-found/非零 code、空结果、未知 state、
instrument/client ID 不一致、venue order ID 漂移、fill 回退或超出 intent quantity
都不能证明可安全重提，只会保持 `unknown` 或 fail closed。

## 3. Durable journal

固定文件为：

```text
live-broker-v1/live-order-shadow-v1.sqlite
live-broker-v1/live-order-shadow-v1.sqlite-wal
live-broker-v1/live-order-shadow-v1.sqlite-shm
```

数据库包含 `broker_meta`、`shadow_order` 和 append-only `journal_event`。启动时验证：

- 精确表、列、类型、主键、唯一索引和 foreign key；
- schema/user version、broker identity、row/event hard limit；
- `PRAGMA quick_check` 与 `foreign_key_check`；
- 每个 projection 的类型、枚举与 attempt 上限；
- 全局 event sequence、previous hash、canonical event hash；
- event transition 与最终 projection state/attempt 一致。

journal 不保存 API key、passphrase、认证 header/signature、raw account reference 或 raw
idempotency key，只保存摘要、稳定 client ID、规范 intent 与查询结果。测试在 checkpoint
后扫描 SQLite，并在 DPAPI 重启后扫描整个 Broker 根目录，secret/account/idempotency
canary 均未出现。

## 4. OKX query-only connector

生产 connector 继续固定 `openapi.okx.com:443`、系统 CA/hostname verification、
TLS 1.2+、公网 DNS 结果、200、单一 JSON content type、1 MiB body 和 strict JSON。
query target 与签名 prehash 使用同一个 canonical 字符串，不接受 `ordId`、额外 query、
重复 key、fragment、任意 path 或任意 method。

依据 OKX 当前公开合同，Order details 是需要 Read permission 的
`GET /api/v5/trade/order`；`clOrdId` 最长 32 位且只要求 pending order 内唯一。
历史复用时 query 会匹配最新记录，所以 CandleScope 采用更严格规则：同一 journal
生命周期内永不删除或复用 Broker client ID。

参考：

- [OKX API guide](https://www.okx.com/docs-v5/en/)；
- [OKX order placement guide](https://www.okx.com/docs-v5/trick_en/)；
- [OKX API changelog](https://www.okx.com/docs-v5/log_en/)。

本阶段没有使用用户 credential，也没有发起真实 OKX Demo 请求。签名、target、响应和
异常合同使用 fake transport/connector 验证；这不能替代未来专用纯只读 Demo key 的
真实兼容性 smoke。

## 5. Feature gate

启用 WP-D 必须同时满足：

```powershell
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED='1'
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST='first-party-pinned'
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENABLED='1'
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENABLED='1'
$env:CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_RECONCILIATION_SHADOW_ENABLED='1'
```

最后一个开关默认 `0`。关闭时不创建/打开 SQLite、不构造 query connector，WP-C
仍只报告两个认证网络动作；打开时 health 明确报告三个，不把 order query 伪装成
零网络。production first-party release lock 仍为空。

## 6. 验证证据

使用绝对源码路径：

```powershell
$env:PYTHONPATH='H:\program\CandleScope-plugin-platform\backend;H:\program\CandleScope-plugin-platform\packages\candlescope-plugin-sdk\src'
$env:PYTHONIOENCODING='utf-8'
$env:PYTHONUTF8='1'
```

最终结果：

- WP-A/WP-B/WP-C/WP-D 聚焦：63 passed；
- Core/Host/Capability/Paper/management 受影响回归：60 passed；
- backend 全量：2141 passed、0 failed、4 warnings，耗时 423.18 秒；
- SDK 全量：80 passed；
- frontend：architecture、plugin boundary、typecheck、ESLint、2353 tests 与
  production build 全部通过；
- WP-D 影响范围 Ruff、backend `compileall`、JSON parse 与
  `git diff --check`：通过。

4 条 backend warning 是既有 FastAPI `on_event` deprecation。frontend build 保留既有
大 chunk 提示；都没有被包装成零告警。额外执行的仓库级
`ruff check app tests scripts` 仍报告 34 个既有问题，位于本阶段未修改的
`data_engine`、`exchanges`、`indicator` 和旧测试路径；没有越权混入本提交，也不把
影响范围 Ruff 绿灯包装成仓库全量 Ruff 已绿。

负向/恢复覆盖包括：same-key conflict、terminal retry、query-only retry、venue
not-found、identity/state/fill mismatch、private DNS、额外 query、credential revoke、
cross-account、stale epoch、query 前 crash、response 后 persist 前 crash、WAL restart、
event hash/schema tamper、feature-off 零 journal、DPAPI restart 与降级拒绝。

## 7. 回滚

优先回滚方式是保持代码并关闭 shadow flag。若必须回退 WP-D：

1. 把 `CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_RECONCILIATION_SHADOW_ENABLED` 设为 `0`；
2. 停止 Broker；
3. checkpoint 并完整备份 SQLite、WAL、SHM；
4. 保留所有 unresolved shadow，不删除、不复用 client ID；
5. 回退 WP-D 独立提交；WP-C 不会打开这些文件。

WP-C→WP-B 的现有降级工具现在发现任一 WP-D journal 文件就拒绝，直到 operator 把
三件套完整归档到明确位置。它不会先删除 account metadata 再留下无法解释的订单身份。

## 8. 未开放能力与下一门

WP-D 仍没有：

- Host-native intent confirmation、persistent Live control、kill/revoke UI 或 audit export；
- submit、cancel、amend、transfer、withdraw、leverage、margin 或 production Live；
- `secrets.use`、`trade.submit`、`trade.cancel` grant；
- private WebSocket、订单历史扫描或通用认证 HTTP/signing；
- 真实 Demo key、真实资金或自动化交易。

下一工作包是 WP-E：Host-native confirmation、persistent Live control、kill/revoke
和 audit export。它需要新的明确授权；本提交在 WP-D 停止，不会自动进入 WP-E。
