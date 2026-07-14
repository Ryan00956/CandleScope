# K 线增强字段与订单流代理契约

本文描述 P0 后端 K 线增强输出。它只使用交易所 K 线响应中已经存在的字段，不新增上游订阅，也不替代后续基于逐笔成交的真实订单流链路。

## 生效接口

- `GET /api/v1/klines/` 及同模块的 latest、history、range、before 等 K 线查询。
- `WS /api/v1/stream/klines`。
- `WS /api/v1/stream/klines_multi`。

`BarData.to_dict()` 继续保留旧 OHLCV 形状，避免指标和其他内部消费者被动增加载荷；K 线 HTTP/WS 显式使用 `BarData.to_kline_dict()`。

## 单根 K 线输出

```json
{
  "time": 1700000000,
  "open": 100,
  "high": 110,
  "low": 90,
  "close": 105,
  "volume": 10,
  "is_closed": true,
  "quote_volume": 1000,
  "trades": 25,
  "taker_buy_base": 6,
  "taker_buy_quote": 650,
  "order_flow": {
    "taker_sell_base": 4,
    "volume_delta_base": 2,
    "taker_buy_ratio_base": 0.6,
    "cvd_contribution_base": 2
  }
}
```

派生公式：

```text
taker_sell_base      = volume - taker_buy_base
volume_delta_base    = taker_buy_base - taker_sell_base
taker_buy_ratio_base = taker_buy_base / volume
```

为控制 5000 根历史窗口的响应体和序列化成本，P0 只发送 UI/CVD 当前需要的 base-volume 派生项；`quote_volume` 与 `taker_buy_quote` 仍作为原始字段保留，未重复发送 quote 侧的 sell/delta/ratio/CVD 派生值。

2026-07-14 本机 5000 根纯序列化 smoke：初版双 base/quote 派生结构约 `2.56 MB / 58 ms`；收敛后的契约约 `1.44 MB / 42.5 ms`。这是提交前的相对成本检查，不替代后续并发 p95/p99 压测。

分母为 0 时比例为 `null`，但合法的 `0/0` K 线仍可拥有 `volume_delta = 0`。负数、非有限数、非整数成交笔数或主动买量大于总量等非法输入均 fail closed 为 `null`；无法计算 base 订单流时整个 `order_flow` 为 `null`。接口不会输出增强字段中的 `NaN` 或 `Infinity`。为兼容升级前可能落库的 trade-mode 占位值，`volume > 0` 但 `quote_volume = 0` 的不一致组合也会整体 fail closed。

## Capability 与不可用数据

Capability schema v2 的 Kline channel 通过 `available_fields` 声明原始字段，通过 `derived_fields` 声明可由这些原始字段稳定推导的指标。

- Binance spot/futures 当前声明全部四个增强原始字段以及订单流派生字段。
- OKX 当前只有 `quote_volume` 可用；插件归一化产生的 `trades/taker_buy_* = 0` 是占位值。因此这些字段输出 `null`，`order_flow = null`，不能在 UI 上显示成真实零值。运行时的 `swap/perpetual` market alias 使用 futures capability。
- schema v1、未知交易所或缺失 Kline capability 一律 fail closed。

字段 availability 会随 BarInput、BarState、FetchedBar、warm-start、cache 和 storage 传播；不可用字段落库为 SQL `NULL`，避免重启后把内存中的 fail-closed 状态重新解释成真实零值。自定义 StorageBackend 即使省略 row 内的 exchange/market，也会使用查询的显式 SeriesKey 上下文进行门控；完全没有上下文时 fail closed。

## CVD 语义

后端输出的是每根 K 线的 CVD contribution，而不是页面局部起点伪装成的绝对 CVD：

```text
CVD[i] = anchor + sum(cvd_contribution_base[j])  (j <= i)
```

消费端只应在连续、按时间排序的范围内计算前缀和。分页拼接、历史修订或 gap 修复后，要从受影响位置向后重算。形成中 K 线的 WS 更新是同一桶的累计快照，因此必须替换该桶旧 contribution，不能把每次更新重复相加。单路和多路 K 线 WS 都会把 `BAR_AMENDED` 作为 `is_closed = true` 的同时间桶替换事件发出，也会转发用户可见的 `backfill_completed`，供客户端重拉受影响范围。

## 自定义周期

`quote_volume`、`trades`、`taker_buy_base`、`taker_buy_quote` 都是可加字段。自定义周期先分别求和，再从聚合后的总量计算 sell、delta 和 ratio；不会平均子周期 ratio。

只有当组成目标 K 线的每一根源 K 线都提供合法字段，且组件从目标桶起点连续、无中间 gap 时才求和。已收盘目标桶还必须覆盖到桶尾；形成中目标桶允许连续覆盖到当前 forming 组件。缺首根、缺中间根、缺尾根、单组件非法或任一组成缺字段时，相应聚合字段为 `null`，避免不完整或互相抵消的样本生成假订单流。
