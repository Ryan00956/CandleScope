# 交易所插件架构

这个包是交易所差异的长期边界。Data Engine、backfill、API 和前端都应该通过
`ExchangePlugin` 与 `ExchangeCapabilities` 消费交易所行为，而不是在业务模块里硬编码交易所名称，
也不应该直接调用 adapter 的交易所专有方法。

## 职责模型

| 层 | 职责 |
|---|---|
| `app.exchanges` | exchange registry、plugin API、plugin loading、兼容性检查 |
| Exchange plugin | REST path、WS connection model、payload routing、symbol 规则、pagination、rate limit、realtime policy、normalizer |
| Adapter | legacy facade，以及可选 symbol metadata 兼容入口 |
| `data_engine` | 通用 ingestion/backfill 编排 |
| Frontend | 读取后端 capabilities，并据此调整 UI |

adapter 不再是运行时协议行为的事实来源。新增交易所时，应优先从 `plugin.py`、
`protocol.py`、`pagination.py`、`symbols.py` 和 `normalizer.py` 开始。

## 核心契约

| 契约 | 文件 | 用途 |
|---|---|---|
| `ExchangePlugin` | `plugin.py` | 组合 protocol、normalizer 和各类 policy 的插件根 |
| `ExchangeProtocol` | `protocol.py` | REST request spec、WS connection spec、subscription payload、payload routing |
| `ExchangeCapabilities` | `models.py` | API 和前端消费的公开能力元数据 |
| `HistoricalPaginationPolicy` | `pagination.py` | 历史 REST 分页语义 |
| `RateLimitPolicy` | `rate_limits.py` | 按交易所/市场声明 fetch pacing |
| `RealtimePolicy` | `realtime.py` | native interval、base fanout 或 polling 行为 |
| `ExchangeContractCase` | `contracts.py` | 可复用插件契约测试 fixture |

## 运行时流向

```text
ExchangePlugin
  ├─ capabilities()      -> API + frontend capability-driven UI
  ├─ protocol()          -> ingestion transport REST/WS specs
  ├─ pagination_policy() -> backfill historical paging
  ├─ normalizer()        -> raw payload -> MarketEvent
  ├─ rate_limit_policy() -> backfill/transport pacing
  └─ adapter()           -> legacy facade only
```

Data Engine 代码不应该为了运行时行为调用 `plugin.adapter()`。adapter 入口只用于保持旧导入和
symbol metadata 兼容；新代码应走 plugin contracts。

## 共享 REST 预算与商品目录

历史行情 transport 与商品目录 HTTP 请求共用当前 event loop 的
`RateLimitManager` 和 endpoint semaphore。目录 endpoint 必须在 plugin policy 中声明
真实 request cost；普通网络错误可以切备用 host，但 HTTP 418/429 或交易所等价 body
code 会打开共享 cooldown，不能再靠轮换 host 绕过同一 IP 预算。

HTTP 429 cooldown 只作用于对应 bucket。到期后先只放行一个 request-cost 作为恢复探针，
其余预算按正常速率重新累积，不能把 `Retry-After` 期间攒满的 token 一次放出。HTTP 418
仍是交易所级 IP circuit，恢复时重置该交易所的全部匹配 bucket。

商品目录按 `(exchange, market_type)` 使用 TTL 和 physical singleflight。经过完整校验、
带版本的 last-known-good 快照会原子写入 `backend/data`，并在 API 启动前恢复。空结果、
异常、rate deferral 或可疑的大幅缩减都保留这份快照，并暴露 `stale`、
`last_success_at` 与 `retry_at_ms`。如果没有任何有效目录，API 会有界等待正在执行的
singleflight，然后明确返回可重试的 `503 symbol_catalog_unavailable`，不会伪装成
`200` 空列表。自动刷新失败会按有界 deadline 重试；启动和 TTL 投机刷新必须等前台
行情任务持续安静，用户主动请求目录则不受这段 dwell 限制。

生产共享限流器采用保守冷启动：新 bucket 第一次只放行一次精确 request-cost 探针，
避免进程重启把未知的交易所预算状态误当成满桶。启动时先完成核心 DataManager 初始化，
所有上游目录刷新任务在 shutdown 时都可取消并等待收口。

## 能力元数据

`ExchangeCapabilities` 是 `GET /api/v1/exchanges/` 和
`GET /api/v1/exchanges/{exchange}/capabilities` 暴露的公开契约，包含：

- `plugin_api_version`
- `capability_schema_version`
- `markets`
- `channels`
- `native_intervals`
- `ws_connection_model`
- `protocol_features`
- `limits`
- `known_limitations`

schema v2+ 的每个 channel 会分别声明 transport、snapshot/delta、sequence/resync、
`available_fields`、`unavailable_fields` 和 `derived_fields`。K 线 P0 用这些字段门控
增强成交量与订单流代理，避免把插件占位值当作真实行情。
schema v3 增加 market 的 `calendar_id`/`timezone`、channel 的强类型
`history_policy`，以及标准化的 symbol 生命周期时间；旧的 dotted history limits
仍为 schema v1/v2 消费方保留。

前端使用这些元数据决定 interval 列表、可用 market type、WS 行为和用户可见限制。
新增交易所 UI 行为应放进 capabilities，而不是新增前端交易所分支。

## Registry 和加载

内置插件由 `bootstrap_default_adapters()` 注册：

- Binance：`app.exchanges.plugins.binance`
- OKX：`app.exchanges.plugins.okx`

`ExchangeRegistry.register()` 会在注册前检查兼容性：

- `capabilities.exchange` 必须匹配 `plugin.id`
- `plugin_api_version` 的 major version 必须匹配后端支持的 major
- `capability_schema_version` 不能高于后端支持的 schema version

外部插件可以显式加载：

```powershell
$env:CANDLESCOPE_EXCHANGE_PLUGINS = "my_package.exchange_plugin,my_other_plugin:make_plugin"
```

每个 spec 可以是 `module.path` 或 `module.path:factory`。如果没有指定 factory，
loader 会优先寻找 `create_plugin()`，其次寻找 `plugin`。

## Diagnostics

使用：

```bash
curl http://localhost:8000/api/v1/exchanges/diagnostics
```

diagnostics 会报告每个插件的 loaded/error 状态、来源、plugin API version、protocol class、
adapter facade 和 policy classes。外部插件加载失败会记录在这里，而不是静默污染 runtime。

## Contract Tests

插件契约测试 harness 位于 `contracts.py`。内置 fixtures 位于：

- `backend/tests/fixtures/exchanges/contract_cases.py`

运行：

```bash
cd backend
python -m pytest -q tests/test_exchange_plugin_contracts.py
```

contract cases 应覆盖：

- REST request specs 和 HTTP row extraction
- WS connection specs 和 subscription payload
- historical pagination request generation
- `MarketEvent.data` 的 normalizer output schema

新增交易所插件应先补 fixtures，再接入 runtime。

## 新增交易所步骤

1. 复制 `plugins/_template` 到 `plugins/<exchange>`。
2. 在 adapter facade 或插件能力 provider 中实现 capability metadata。
3. 在 `protocol.py` 中实现 REST/WS specs 和 payload routing。
4. 如果默认 reverse-time policy 不适用，在 `pagination.py` 中实现分页策略。
5. 在 `symbols.py` 中实现 canonical symbol 转换。
6. 在 `normalizer.py` 中实现 raw payload 到 `MarketEvent` 的转换。
7. 在 `plugin.py` 中组装 protocol、normalizer 和各类 policy。
8. 在 `tests/fixtures/exchanges/` 下添加 contract fixtures。
9. 注册为内置插件，或通过 `CANDLESCOPE_EXCHANGE_PLUGINS` 加载。
10. 验证 diagnostics、contract tests、data engine boundary tests 和 frontend capability 行为。

## 边界规则

- 不要在 `data_engine` 中为 REST path、WS URL、pagination、payload shape、rate limit 或 symbol format 添加交易所分支。
- 不要让 adapter 成为新增运行时行为的事实来源。
- 要通过 capabilities、protocol specs 和 policies 暴露新增交易所行为。
- 要先添加 contract fixtures，再让 ingestion/backfill 依赖该插件。
