# Backtest 历史合约数据合同 V1

状态：`M3_FROZEN`

## 1. 身份与边界

`HISTORICAL_CONTRACT_V1` 是新数据身份，不改变已有 `LEGACY_FIXED_V1` Run。一个可用于历史永续研究的 snapshot 必须绑定市场角色 `BARS` 或 `AGG_TRADE`，以及以下三个角色：

- `MARK_INDEX`
- `FUNDING`
- `INSTRUMENT_RULES`

Host 拥有导入、hash、覆盖校验、排序和 Run 准入真相。M3 只冻结事实输入；账户如何消费这些输入由 M4 的新账户模型定义。旧 V1 固定资金费和未建模 rules 仍只属于旧身份，不得标为历史事实。

运行时只读取已导入的本地不可变 revision。导入接口接收请求正文，不接收 URL，不会联网补数据。

## 2. Bundle schema

根 schema 为 `candlescope.contract-history.v1`：

```json
{
  "schema_version": "candlescope.contract-history.v1",
  "identity": {
    "venue": "binance",
    "market_type": "usdm",
    "symbol": "BTCUSDT"
  },
  "roles": {
    "MARK_INDEX": {},
    "FUNDING": {},
    "INSTRUMENT_RULES": {}
  }
}
```

每个 role 必须包含非空 `provenance`、明确 `retention_policy` 和非空 `records`。导入后每个 role 独立生成内容 hash、覆盖起止、行数、首尾事件、gap、duplicate、out-of-order；总 bundle 生成独立 hash。伴随 manifest schema 为 `candlescope.contract-history.manifest.v1`。

### 2.1 MARK_INDEX

角色额外字段为正整数 `cadence_ms`。每行只允许：

```text
event_time_ms, mark_price, index_price
```

时间必须严格递增。价格为正、有限、canonical Decimal 文本。相邻事件不是精确 cadence 时记录真实缺失区间；请求窗口与 `[first_event, last_event + cadence - 1]` 的差也属于缺失。

### 2.2 FUNDING

角色额外字段为正整数 `period_ms`；`settlement_tolerance_ms` 默认 1000，只用于容纳交易所结算时间戳的毫秒级抖动，不改变 period。每行只允许：

```text
settlement_time_ms, period_id, funding_rate, mark_price
```

`period_id` 和结算时间都必须唯一且严格递增；相邻结算与一个 period 的偏差不得超过 tolerance。费率必须位于 `[-1, 1]`，结算 mark 必须为正。覆盖定义为 `[first_settlement - period, last_settlement + period - 1]`，不会把固定配置费率冒充历史记录。

### 2.3 INSTRUMENT_RULES

每个生效记录只允许：

```text
effective_from_ms, effective_to_ms, rule_version,
contract_multiplier, price_tick, quantity_step,
min_quantity, max_quantity, min_notional, maintenance_tiers
```

`effective_to_ms=null` 只允许出现在最后一条。时间线不得重叠、回退或留空档。maintenance tier 从 notional `0` 起，后一档 floor 必须精确等于前一档 cap；rate 位于 `[0,1]`。rules provenance 必须保留操作者用于证明生效区间的原始 receipt；系统只验证 receipt 被固定，不推断交易所过去规则。

## 3. 同时间戳排序

冻结顺序：

```text
INSTRUMENT_RULES -> MARK_INDEX -> FUNDING -> MARKET_EVENT
```

排序键为 `event_time_ms -> frozen phase -> role component sequence`。快照迭代重建必须产生相同事件序列和 snapshot hash。

## 4. 本地导入

构建器只读取本地文件：

```powershell
$env:PYTHONPATH = (Resolve-Path backend).Path
python backend/scripts/build_backtest_contract_history.py `
  --mark-index-csv mark-index.csv `
  --funding-csv funding.csv `
  --rules-json rules.json `
  --output contract-history.json `
  --venue binance --market-type usdm --symbol BTCUSDT `
  --mark-cadence-ms 60000 --funding-period-ms 28800000 `
  --provider BINANCE_PINNED_PUBLIC_ARCHIVE `
  --source-url https://data.binance.vision/ `
  --capture-receipt receipt-20260815 `
  --source-sha256 sha256:<raw-input-set-hash>
```

随后在 `LOCAL_OFFLINE` 模式调用：

```text
POST /api/v1/local/datasets/{dataset_id}/contract-history?data_epoch={epoch}
Content-Type: application/json
Body: contract-history.json 原文
```

成功后不会修改原 revision，而是复制 BAR revision、绑定 bundle、计算新的 composite `data_epoch` 并原子发布。`GET /api/v1/local/datasets/{dataset_id}/quality?data_epoch=...` 可导出 manifest、质量报告和 receipt；项目包导出同时包含 bundle 与 manifest。

## 5. Preview 与失败关闭

Backtest preview 使用 `contract_data_mode=HISTORICAL_CONTRACT_V1` 时返回每个 role 的 `complete / partial / missing`、真实覆盖、gap、行数和 hash。页面逐 role 展示状态，并明确不会联网补取。

以下任一情况禁止 Run：

- role 缺失；
- 请求区间未完全覆盖；
- duplicate、out-of-order、非法 Decimal、重复 funding period；
- rules/tier 重叠或留空档；
- bundle 与伴随 manifest 重算不一致；
- dataset、venue、market type 或 symbol 身份不一致。

删除任一已导入行会使 bundle hash/manifest 不一致，preview 显示不完整且 Run 准入失败。恢复方式是重新导入原始、checksum 一致的 bundle，产生/激活正确 revision；不允许在原 revision 上修补。
