# Plugin Platform V2 Phase 11B WP-F 执行记录

日期：2026-07-23

## 1. 结论

WP-F 已完成本地实现与技术验收：CandleScope 现在有一个默认关闭、只允许
`OKX Demo / Spot cash / BTC-USDT / limit` 的 first-party pinned 提交、撤单和查询闭环。
每次 mutation 都要求 action-bound 单次回执和第二次 Host 原生 typed confirmation；
发送前持久化，任何不确定结果都进入 `unknown` 或 `cancel_unknown`，不会自动重试。

这不是 production Live 交付，也不是通用交易插件 API。公开 SDK、manifest、
sandbox iframe 和普通 network gateway 没有新增下单能力；production release lock
继续为空。market、margin、derivative、amend、batch、transfer、deposit 和 withdraw
仍不可达，WP-G 未授权。

## 2. 启用与信任边界

新增 feature flag：

`CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_TESTNET_EXECUTION_ENABLED`

它默认 `false`，并要求 WP-B 到 WP-E 的四个 Live flag 同时开启，且平台 trust 必须为
`first-party-pinned`。flag 关闭时不构造 execution connector、不创建或打开
`live-execution-v1.sqlite3`，Host execution routes 返回不可用，既有 Paper、WP-C
只读账户、WP-D shadow 和 WP-E control 行为不变。

WP-F 使用独立 connector `candlescope.okx-demo-spot-execution`。账户发现必须证明
`okx / demo / spot`、Spot account mode 和精确的 Read + Trade 权限；包含 Withdraw、
权限缺失或额外权限都会在执行前失败。WP-C 的 read-only binding 不会被静默升级。

## 3. 固定执行合同

Broker 只增加三个 operation-specific 网络动作：

- `POST /api/v5/trade/order`
- `POST /api/v5/trade/cancel-order`
- `GET /api/v5/trade/order?instId=BTC-USDT&clOrdId=<stable-id>`

origin 固定为 `https://openapi.okx.com:443`，执行公共地址 DNS 验证和 TLS hostname
验证；不支持 redirect、proxy、任意 path、任意 header、任意 body 或通用 signer。
Demo 请求固定携带 `x-simulated-trading: 1`。提交 body 只包含 `instId`、`tdMode=cash`、
`side`、`ordType=limit`、`sz`、`px` 和 Broker 生成的 32 位稳定 `clOrdId`，并带不超过
五秒的 `expTime`；撤单只能按同一个 `clOrdId`。

成功提交 ack 只进入 `unknown`，成功撤单 ack 只进入 `cancel_unknown`；只有查询可以
投影 `live`、`partially_filled`、`filled`、`canceled` 或 `mmp_canceled`。OKX 明确为
结果不确定的 `50004` 无论出现在 envelope code 还是逐单 `sCode`，都强制保留未知态，
绝不按确定拒单释放风险额度。

## 4. 风控、确认与持久状态

Broker 在 mutation 前重新检查以下 build-time 固定边界：

- instrument 必须为 `BTC-USDT`，且只能 Spot cash limit；
- 单笔名义价值不超过 `100 USDT`；
- 未终态订单最多 2 笔；
- 未终态名义价值合计不超过 `200 USDT`；
- account、credential、plugin、publisher、connector、intent、policy epoch、
  control generation 和 action-bound receipt 必须全部匹配；
- control mode 必须仍为 `armed`。

receipt issuance 本身不发送网络请求。提交和撤单分别要求新的 Host preview、
`CONFIRM LIVE INTENT`、单次 receipt，以及第二层 `EXECUTE DEMO SUBMIT` 或
`EXECUTE DEMO CANCEL`。回执在 Broker 内先持久 consume；执行账本再落盘
`submitting` 或 `canceling`，两者均完成后才允许一次网络发送。两库之间崩溃只会
损失该回执，不会发送未记录订单。

独立 `live-execution-v1.sqlite3` 使用 SQLite/WAL、`synchronous=FULL`、STRICT exact
schema、固定 index、行数上限和 append-only SHA-256 event chain。启动会验证
schema、foreign key、event hash 和 projection；中断的 `submitting` / `canceling`
恢复为保守未知态。账本不保存 credential、认证 header、签名、passphrase、原始响应
或原始 venue order ID。

## 5. Host API、UI、审计与回滚

新增 Host-only management routes：

- `GET /manage/live/execution/{shadow_ref}`
- `POST /manage/live/execution/submit`
- `POST /manage/live/execution/cancel`
- `POST /manage/live/execution/reconcile`

mutation 继续要求 loopback、session、CSRF、fresh user action 和 exact body。Host
modal 明示 OKX Demo、订单事实、固定限额、未知态和不可用的 production/资金动作；
插件 iframe 无法覆盖或调用这些接口。

审计格式升级为 `candlescope.live-audit-export/2`，同时验证 control、shadow 和
execution 三条完整 hash chain、source head、最终投影和 envelope digest。导出只含
脱敏摘要。旧 downgrade 工具发现 WP-F store 时拒绝继续。

有序回滚应先停止新的 submit，查询并撤掉仍在场的 Demo 订单，直到终态，再执行
global kill、下载并验证 v2 audit、停止 Broker 和归档 execution SQLite 三件套。
如果事故要求先 global kill，credential/account 会立即清除，之后只能走显式
unresolved export 和人工 venue review，不能把本地 socket 关闭解释为撤单。

从 `backend` 目录执行归档命令：

```powershell
python -m scripts.archive_live_execution_v1 `
  --root <broker-private-root> `
  --audit-export <audit-export-v2.json> `
  --archive-path <live-execution-archive.zip> `
  --confirm-killed `
  --confirm-remove-source
```

存在 unresolved record 时还必须显式传入
`--confirm-unresolved-manual-review`。完成归档后关闭 WP-F flag，再回退 WP-F 独立提交。

## 6. 自动化验证

- WP-F execution 聚焦：`19 passed`
- WP-B/WP-E + WP-F 相关 Broker 聚焦：`33 passed`
- backend 全量：`2171 passed, 8 warnings in 375.45s`
- 强制 UTF-8 全量中的 4 个 Windows AppContainer 本地化输出告警，改用系统 CP936
  单独复跑：`4 passed`，无 warning
- SDK 全量：`80 passed`
- frontend WP-F 聚焦：`20 passed`
- frontend 全量：`2360 passed in 25998.3 ms`
- frontend architecture、plugin sandbox、typecheck、lint 和 production build：通过
- changed Python Ruff、4 个 WP-F 新文件 Ruff format 和 compileall：通过

backend 的另外 4 条 warning 是既有 FastAPI `on_event` deprecation；UTF-8 下新增显示
的 4 条 warning 来自未改动的 Windows sandbox 测试用 `utf-8` 解码本地化 `icacls`
输出。frontend build 保留既有 `>500 kB` chunk warning。以上均明确记录，没有包装成
“零告警”。

## 7. 生产构建浏览器证据

端口 `18132` 上使用 production Vite build、真实 Host management API、真实
Broker service/SQLite/control/shadow/execution 代码和显式
`executionBackend=explicit-test-fake` 完成：

1. `DISARMED → ARMED`
2. issue submit receipt，确认此时 mutation call 仍为 0
3. 第二次 typed confirmation 后 `submitCalls=1`，状态为 `unknown`
4. query 后为 `live`
5. 使用全新 cancel receipt 和第二次 typed confirmation
6. `cancelCalls=1`，状态为 `cancel_unknown`
7. 第二次 query 后为 `canceled`

最终 fake venue 计数为 submit 1、cancel 1、query 2；execution projection 为
1 个终态、0 个未决、event sequence 6。浏览器 console 为 0 error / 0 warning。
截图 SHA-256 为
`42b2edc53f4549de3dd5f00e240286e18dbb3e7d52ed7beaa2d82fa75573462d`。
结构化证据见
[`security/phase11b-live-authority/evidence/phase11b-wpf-browser-local-fake-20260723.json`](security/phase11b-live-authority/evidence/phase11b-wpf-browser-local-fake-20260723.json)。

这份证据明确只证明本地 fake venue 的 Host/Broker 语义，没有使用真实 OKX
credential，也没有向 `openapi.okx.com` 发送请求，因此不能声称真实 OKX Demo
兼容。

## 8. 真实 Demo 与停止门

真实 OKX Demo smoke 尚未执行，因为当前没有用户提供的 exact Read + Trade Demo key，
也没有对某笔外部 mutation 的单独授权。执行真实 smoke 前仍需：

- 用户选择 Demo account 和测试订单事实；
- 确认 API key 无 Withdraw，且只属于 Demo；
- 明确授权一次真实 submit/query/cancel/query；
- 保存脱敏 audit 和交易所侧订单证据。

WP-F 在本地 fake 验收与独立提交后停止。WP-G、production credential、production
release lock、资金动作、自动策略下单和通用第三方交易执行必须另行设计与授权。

官方合同依据：

- <https://www.okx.com/docs-v5/en/>
- <https://www.okx.com/en-us/help/api-faq>
