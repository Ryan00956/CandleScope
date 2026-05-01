# CandleScope API 文档

[![English](https://img.shields.io/badge/Language-English-blue)](API.md) [![简体中文](https://img.shields.io/badge/语言-简体中文-red)](#)

本文档提供了 CandleScope 的 HTTP REST 接口与 WebSocket 实时流 API 的完整集成指南。
所有 K 线相关的查询端点（Endpoints）现已全面接入统一的 `DataManager`，由其自动调度 **三级缓存系统**（内存缓存 → SQLite 持久化 → 异步智能历史回填）。
正式数据接口不再回退到 legacy/mock 数据路径：如果 `DataManager` 未初始化，K 线 REST 接口会返回 `503 Service Unavailable`，WebSocket 会发送错误消息并关闭连接。

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
*注：`source` 字段会真实返回本次数据的来源，可能为 `cache` (内存最高极速)、`storage` (SQLite 数据库)、`mixed` (混合)、或 `empty` (无数据，已提交后台回填请求)。`backfill_triggered` 为 true 时，前端应等待后续 WebSocket 回填完成事件后重拉。*

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
获取从当前时间点往前推算指定天数的历史 K 线数据。后端会自动折算成适当的 `limit`，并在发现数据缺失（Gap）时，通过 `BackfillCoordinator` 异步提交修复请求。

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

提供了三种订阅流方案。这些推送流不是“网络中继”：K 线事件经历 Ingestion 摄取管道六层清洗 → BarAggregator 合成组装 → DataManager EventBus 推送到前端；价格事件由 ingestion ticker 源进入 DataManager `PriceSnapshotCache` 后推送。

### 2.1 单周期固定流 (Single-Interval Stream)

直接在 URL 参数里锁死想要监听的时间级别。

- **WebSocket URL:** `ws://localhost:8000/api/v1/stream/klines`
- **查询参数:** `?symbol=BTCUSDT&interval=1m`

---

### 2.2 多路复用流 (Multi-Interval Stream - 强烈推荐)

允许前端建立**唯一一条**物理 WS 长连接，并能在客户端通过发送指令、随意热插拔地监听和退订任意多个（甚至是系统现场动态生成的自定义级别） K 线周期。

- **WebSocket URL:** `ws://localhost:8000/api/v1/stream/klines_multi`
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
该信号是系统的异步解耦信标。当 `history/before` 或 `history` 查询提交了后台修复请求，`BackfillCoordinator` 完成 storage 写入和 DataManager cache 回灌后，会通过 EventBus 推送该消息。
前端收到该事件后，应重拉对应区间或重新执行 `history/before`。
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

---

### 2.4 价格实时流 (Price Stream)

- **REST 快照:** `GET /subscriptions/prices`
- **WebSocket URL:** `ws://localhost:8000/api/v1/stream/prices`

价格数据源为 DataManager price cache，不依赖旧 `PriceTickerService`。订阅等级为 `price` 或 `full` 的交易对会由 `dm.ensure_price_stream()` 启动 ticker ingestion。

WebSocket 建连后先返回当前快照：

```json
{
  "type": "prices",
  "data": [
    {
      "symbol": "BTCUSDT",
      "exchange": "binance",
      "market_type": "spot",
      "price": 42050.0,
      "daily_open": 41800.0,
      "timestamp_ms": 1700000000000
    }
  ]
}
```

随后每次 `PRICE_UPDATED` 事件都会发送同样的 `prices` 包，`data` 中只包含本次更新的价格项。

---

## 3. 运维与辅助计算接口 (Utility API)

### 3.1 周期合成自省解析
供前端验证某周期（如 `45m`）是否合法，并获取该周期合成所需的基准组件和乘数计算公式。

- **请求路径:** `/klines/resolve`
- **请求方式:** `GET`

| 参数名 | 类型 | 必填 | 描述 |
|-----------|------|----------|-------------|
| `interval`| string| **是**  | 请求探测的周期字母串 (如 `45m`) |

**成功响应:**
```json
{
  "requested": "45m",
  "is_custom": true,
  "base_interval": "1m",
  "multiplier": 45,
  "seconds": 2700
}
```

### 3.2 强行擦除存储区 (Delete Storage Data)
维护工具接口：选择性销毁某区间保存在 SQLite 里的缓存数据（注意，不会清空内存中的 Cache）。下次图表滚动到该区域时会强制触发从币安重新拉取的回填逻辑。

- **请求路径:** `/klines/storage`
- **请求方式:** `DELETE`

| 参数名 | 类型 | 必填 | 描述 |
|-----------|------|----------|-------------|
| `symbol`  | string| **是**  | 交易对标识 |
| `interval`| string| **是**  | K线周期 |
| `start`   | int  | 否       | 开始擦除的边界秒级时间戳 |
| `end`     | int  | 否       | 最晚擦除的边界秒级时间戳 |

### 3.3 快速移动平均线 (SMA 快算)
轻量级辅点接口，通过服务端直接算好单根 MA 线并投递给前端图表划线，节省客户端资源。完整的公式计算请移步下方的 Indicator Engine API。

- **请求路径:** `/klines/indicators/sma`
- **请求方式:** `GET`

| 参数名 | 类型 | 必填 | 默认值 | 描述 |
|-----------|------|----------|---------|-------------|
| `symbol`  | string| **是**  | `BTCUSDT` | 交易对标识 |
| `interval`| string| **是**  | `1h`      | 计算参照周期 |
| `period`  | int  | 否       | `20`      | 多长周期的均线 |

---

## 4. 指标运算沙盒 API (Indicator Engine)

系统内建的沙盒执行引擎 API（完全用 Python 环境隔绝对前端代码注入进行重型数值计算和划线推演）。

### 4.1 指标脚本 CRUD

- **`GET /indicators/presets`**: 获取全部系统预装出厂指标信息 (不含脚本源码，仅下发元信息)。
- **`GET /indicators/presets/{preset_id}`**: 单纯抓取某一个系统预设的全部计算源码及描绘参数。
- **`GET /indicators/custom`**: 游览用户自己在图表平台手写的全套自定义指标库。
- **`POST /indicators/custom`**: 保存或新建脚本。
  *(Body: `{ "id": "uuid" (新建可不传), "name": "...", "script": "def main(data)..." }`)*
- **`DELETE /indicators/custom/{indicator_id}`**: 强力删除。

### 4.2 核心云计算算力网关 (Compute Indicator)
重型接口。前端把本地拖拽出来的 **成百万条 OHLCV 数据阵** 打包发往服务端，服务端在隔离沙盒内载入用户书写的 Python 函数，瞬间进行向量计算并传回划线数组以供图表画出线形图。

- **请求路径:** `/indicators/compute`
- **请求方式:** `POST`

**Request Body:**
```json
{
  "script": "def main(klines, params):\n    return [{'time': k['time'], 'value': k['close']}]",
  "ohlcv": [
    { "time": 1700000000, "open": ..., "close": ... }
  ],
  "params": {
    "my_multiplier": 1.5
  }
}
```

**极其精细的数组绘图矢量数据应答:**
```json
{
  "ok": true,
  "error": null,
  "lines": [
    {
       "id": "line_0",
       "color": "#ff0000",
       "data": [ {"time": 1700000000, "value": 42050.0} ]
    }
  ]
}
```
