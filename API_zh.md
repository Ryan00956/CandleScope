# CandleScope API 文档

[![English](https://img.shields.io/badge/Language-English-blue)](API.md) [![简体中文](https://img.shields.io/badge/语言-简体中文-red)](#)

本文档提供了 CandleScope 的 HTTP REST 接口与 WebSocket 实时流 API 的完整集成指南。
所有 K 线相关的查询端点（Endpoints）现已全面接入统一的 `DataManager`，由其自动调度 **三级缓存系统**（内存缓存 → SQLite 持久化 → 异步智能历史回填）。

---

## 根地址 (Base URL)

```text
http://localhost:8000/api/v1
```

---

## 1. REST API 数据查询接口

### 1.1 获取指定 K线数据 (默认端点)
获取特定交易对 (Symbol) 和时间周期 (Interval) 的最新若干条 K 线数据。

- **请求路径:** `/klines`
- **请求方式:** `GET`

| 参数名 | 类型 | 必填 | 默认值 | 描述 |
|-----------|------|----------|---------|-------------|
| `symbol`  | string| 否       | `BTCUSDT` | 交易对标识 |
| `interval`| string| 否       | `1m`      | 标准周期 (例如 `1m`, `1h`) 或 自定义合成周期 (如 `45m`, `3h`) |
| `limit`   | int  | 否       | `500`     | 请求的 K 线根数 (最大 1000) |

**成功响应 (JSON):**
```json
{
  "symbol": "BTCUSDT",
  "interval": "1m",
  "limit": 500,
  "count": 500,
  "source": "cache",
  "has_more": true,
  "fetched": 0,
  "cache": { "elapsed_ms": 1.2 },
  "data": [
    {
      "time": 1700000000,
      "open": 42000.5,
      "high": 42100.0,
      "low": 41950.0,
      "close": 42050.0,
      "volume": 12.5
    }
  ],
  "base_interval": null
}
```
*注：`source` 字段会真实返回本次数据的来源，可能为 `cache` (内存最高极速)、`storage` (SQLite 数据库)、`mixed` (混合)、或 `empty` (无数据，已触发后台回填)。*

---

### 1.2 获取最新 K线 (Latest K-lines)
通常在首次加载图表的最右侧时调用，仅拉取最近的 1 到 2 根数据，用于快速初始化最新价格形态。

- **请求路径:** `/klines/latest`
- **请求方式:** `GET`

| 参数名 | 类型 | 必填 | 默认值 | 描述 |
|-----------|------|----------|---------|-------------|
| `symbol`  | string| 否       | `BTCUSDT` | 交易对标识 |
| `interval`| string| 否       | `1m`      | K线周期 |
| `limit`   | int  | 否       | `2`       | 需要获取的最新条数 |

---

### 1.3 获取历史 K线 (Historical K-lines)
获取从当前时间点往前推算指定天数的历史 K 线数据。后端会自动折算成适当的 `limit`，并在发现数据缺失（Gap）时，将缺失任务直接甩给后台的缺口雷达异步并行执行。

- **请求路径:** `/klines/history`
- **请求方式:** `GET`

| 参数名 | 类型 | 必填 | 默认值 | 描述 |
|-----------|------|----------|---------|-------------|
| `symbol`  | string| 否       | `BTCUSDT` | 交易对标识 |
| `interval`| string| 否       | `1h`      | K线周期 |
| `days`    | int  | 否       | `7`       | 回溯的天数 (1-3650天) |

---

### 1.4 分页回溯历史 K线 (Paginated History Before Timestamp)
图表左侧无缝无限滚动的核心接口。专门用于严格拉取 **指定时间戳之前** 的远古时段数据。

- **请求路径:** `/klines/history/before`
- **请求方式:** `GET`

| 参数名 | 类型 | 必填 | 默认值 | 描述 |
|-----------|------|----------|---------|-------------|
| `symbol`  | string| 否       | `BTCUSDT` | 交易对标识 |
| `interval`| string| 否       | `1h`      | K线周期 |
| `before`  | int  | **是**  | 无       | Unix 秒级时间戳。要求拉取早于此时刻的数据。 |
| `bars`    | int  | 否       | `500`   | 本次拉取的条数 |

**成功响应特性:**
该接口的返回 JSON 中包含极为关键的 `has_more` 布尔值。如果恰遇本地无数据、但后台调度器 **触发了回填计划** 时，`has_more` 依然会坚定地返回 `true`，以防前端的滚动系统被过早熔断锁死。

---

### 1.5 存储容量健康度诊断 (Storage Metadata)
前端可依此判断本地到底沉淀了多少年的历史数据。

- **请求路径:** `/klines/storage/meta`
- **请求方式:** `GET`

**成功响应示例:**
```json
{
  "symbol": "BTCUSDT",
  "interval": "1h",
  "cache_count": 500,
  "storage_count": 120500,
  "storage_earliest": 1650000000,
  "storage_latest": 1700000000,
  "is_custom": false
}
```

---

## 2. WebSocket 实时全量事件流 API

提供了两种订阅流的方案。这些推送流与数据不只是“网络中继”，它们是高度集成的：经历了 Ingestion 摄取管道六层清洗 → BarAggregator 高级合成组装后 → 经由 EventBus 零损耗推送到前端图表。

### 2.1 单周期固定流 (Single-Interval Stream)

直接在 URL 参数里锁死想要监听的时间级别。

- **WebSocket URL:** `ws://localhost:8000/api/v1/stream`
- **查询参数:** `?symbol=BTCUSDT&interval=1m`

---

### 2.2 多路复用流 (Multi-Interval Stream - 强烈推荐)

允许前端建立**唯一一条**物理 WS 长连接，并能在客户端通过发送指令、随意热插拔地监听和退订任意多个（甚至是系统现场动态生成的自定义级别） K 线周期。

- **WebSocket URL:** `ws://localhost:8000/api/v1/stream/multi`
- **查询参数:** `?symbol=BTCUSDT`

**连接建立后，向服务端发送指令 (JSON格式):**

*订阅更多周期流:*
```json
{
  "action": "subscribe",
  "intervals": ["1m", "5m", "1h"]
}
```

*退订某些周期:*
```json
{
  "action": "unsubscribe",
  "intervals": ["5m"]
}
```

*心跳包 (Ping-Pong 避免代理截断):*
```json
"ping"
// 服务端会立即答复: "pong"
```

---

### 2.3 下行事件包结构 (Server -> Client)

所有由服务端扇出下发的推送，均为携带标准 `type` 字段的 JSON。

**1. K 线实时帧变动 (类型: `"kline"`)**
会在一根未收盘的活线里高频（比如每 250 毫秒）推送更新，并在该周期自然收盘（原生结束，或根据自定义时间桶边界判定为收束）的瞬间触发 `is_closed: true`。
```json
{
  "type": "kline",
  "interval": "1m",
  "data": {
    "time": 1700000000,
    "open": 42000.5,
    "high": 42100.0,
    "low": 41950.0,
    "close": 42050.0,
    "volume": 12.5,
    "is_closed": false
  }
}
```

**2. 缺失历史回填完毕通知 (类型: `"backfill_completed"`)**
该信号是系统中极为关键的**异步解耦信标**！当你的 `before` 滚轮拖拽接口刚刚没有读取到旧日志时，经过数秒后（后台向币安批量化请求完成），此消息会将喜讯广电推送至全服。
前端收到该事件后，需立即在本地执行重放拉取 `history/before` 动作。无需刷新网页，远古缺口便会自适应无缝显现。
```json
{
  "type": "backfill_completed",
  "symbol": "BTCUSDT",
  "interval": "1h",
  "status": "success"
}
```

**3. 底层通讯流健康探测标 (类型: `"stream_status"`)**
实时反映出后端 Ingestion 第一层管道是否跟真实交易所（例如 Binance WebSocket）断链降级，用于控制界面的转圈/绿色常绿等连接标识符。
```json
{
  "type": "stream_status",
  "symbol": "BTCUSDT",
  "interval": "1m",
  "status": "live"
}
```
*(其核心可用状态字面量可能包含: `starting`, `live`, `reconnecting`, `failed`, `stopped`)*
