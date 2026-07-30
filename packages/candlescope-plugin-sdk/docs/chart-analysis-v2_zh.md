# CandleScope 图表分析插件 SDK

本文描述当前源码中的 additive 图表分析契约。它面向自动数浪、结构识别、
趋势通道、目标区和失效位等插件；不会改变冻结的 `chart-layer/1` 与
`candlescope.render/1` marker 行为。

> 当前状态是源码候选能力，不是已经发布的新 SDK wheel。开发插件可以先固定到
> 同一 CandleScope 源码提交；对外分发前仍需构建、签名、发布并验证新的 SDK 与
> `.cspkg` 工件。

## 1. 可用边界

当前闭环支持：

- 读取 Host 当前 `main-chart` 的 live exchange、market type、symbol、interval；
- 读取历史 K 线，并订阅同一 live series 的增量 K 线；
- 在 `event_batch()` 内继续发起受 capability 和 request context 约束的 Host call；
- 发布 marker、polyline、price-line、band、label；
- Host-owned Canvas 渲染、pan/zoom 坐标转换、DPI 适配和价格 autoscale；
- 图表切换事件、chart revision、layer revision 和 generation 防陈旧覆盖；
- item、point、text、byte、rate 和 activation quota。

当前明确不支持：

- Replay 图表上下文；
- Renko、PnF、Kagi、Line Break 等 derived/ordinal 主图上的分析图层；
- 插件直接获得 Lightweight Charts、Canvas、DOM 或前端 JavaScript；
- 插件自定义点击、拖拽或 hit-test 回调；
- tick 级二进制图层通道。当前 UI 快照刷新上限约为 2 秒。

因此它适合先开发“按 K 线增量更新”的自动数浪 MVP，不应宣传为 tick 级或 Replay
版本。

## 2. Manifest 最小声明

```json
{
  "contributions": [
    {
      "id": "start",
      "kind": "command/1",
      "title": "Start auto wave",
      "entrypoint": "main",
      "configuration": {
        "requiresUserAction": true,
        "placements": ["commandPalette", "topToolbar"],
        "inputSchema": {
          "type": "object",
          "properties": {},
          "required": [],
          "additionalProperties": false
        }
      }
    },
    {
      "id": "chart-events",
      "kind": "event-subscriber/1",
      "title": "Chart context changes",
      "entrypoint": "main",
      "configuration": {
        "events": ["candlescope.chart.context-changed/1"],
        "queueCapacity": 8,
        "maxBatch": 4,
        "maxLatencyMs": 50
      }
    },
    {
      "id": "waves",
      "kind": "chart-layer/2",
      "title": "Elliott wave candidates",
      "entrypoint": "main",
      "configuration": {
        "target": "main-chart",
        "zOrder": "above-series",
        "maxItems": 128,
        "maxPoints": 4096,
        "maxBytes": 262144,
        "maxTextChars": 64
      }
    }
  ],
  "permissions": {
    "required": [
      {
        "id": "chart.context.read",
        "scope": {
          "chartIds": ["main-chart"],
          "contexts": ["live"],
          "exchanges": ["binance"],
          "marketTypes": ["spot"],
          "symbols": ["BTCUSDT", "ETHUSDT"],
          "intervals": ["1m", "5m", "1h"]
        }
      },
      {
        "id": "market.bars.read",
        "scope": {
          "contexts": ["live"],
          "exchanges": ["binance"],
          "marketTypes": ["spot"],
          "symbols": ["BTCUSDT", "ETHUSDT"],
          "intervals": ["1m", "5m", "1h"],
          "maxHistoryBars": 5000,
          "maxConcurrent": 1
        }
      },
      {
        "id": "market.bars.subscribe",
        "scope": {
          "contexts": ["live"],
          "exchanges": ["binance"],
          "marketTypes": ["spot"],
          "symbols": ["BTCUSDT", "ETHUSDT"],
          "intervals": ["1m", "5m", "1h"],
          "maxConcurrent": 1
        }
      },
      {
        "id": "chart.layer.publish",
        "scope": {
          "chartIds": ["main-chart"],
          "contexts": ["live"],
          "exchanges": ["binance"],
          "marketTypes": ["spot"],
          "symbols": ["BTCUSDT", "ETHUSDT"],
          "intervals": ["1m", "5m", "1h"],
          "layers": ["waves"],
          "maxItems": 128,
          "maxPoints": 4096
        }
      },
      {
        "id": "events.public.subscribe",
        "scope": {
          "events": ["candlescope.chart.context-changed/1"]
        }
      }
    ],
    "optional": []
  }
}
```

权限 scope 是上限，不是通配符。插件只能读取和绘制 manifest 明确列出的市场与周期。

## 3. 读取当前图表

```python
from candlescope_plugin_sdk.platform_v2 import (
    CHART_CONTEXT_READ_METHOD,
    ChartContextReadRequest,
    ChartContextSnapshot,
    HostCallInvocation,
    HostCallRequest,
)


def read_chart_context(request_context, capability_handle):
    return HostCallInvocation(
        token="read-chart-context",
        call=HostCallRequest(
            capability_handle=capability_handle,
            method=CHART_CONTEXT_READ_METHOD,
            params=ChartContextReadRequest().to_wire(),
            request_context=request_context,
        ),
    )


def consume_chart_context(response):
    return ChartContextSnapshot.from_wire(response.result)
```

`active=false` 表示当前没有可授权的 live 主图。插件必须停止订阅或保持空闲，不能猜
symbol/interval。

## 4. 发布数浪图层

```python
from candlescope_plugin_sdk.platform_v2 import (
    CHART_LAYER_PUBLISH_METHOD,
    RENDER_IR_V2,
    ChartLayerPublishRequest,
    HostCallInvocation,
    HostCallRequest,
)


def publish_wave_layer(snapshot, request_context, capability_handle, revision):
    render = {
        "schemaVersion": RENDER_IR_V2,
        "items": [
            {
                "id": "candidate-a-path",
                "type": "polyline",
                "points": [
                    {"time": 1700000000, "price": 42000.0},
                    {"time": 1700003600, "price": 43800.0},
                    {"time": 1700007200, "price": 42900.0}
                ],
                "color": "#3B82F6",
                "width": 2,
                "style": "solid"
            },
            {
                "id": "candidate-a-wave-2",
                "type": "label",
                "time": 1700007200,
                "price": 42900.0,
                "text": "(2)",
                "color": "#FFFFFF",
                "backgroundColor": "#1D4ED8CC",
                "position": "below"
            },
            {
                "id": "candidate-a-invalid",
                "type": "price-line",
                "price": 41950.0,
                "color": "#EF4444",
                "width": 1,
                "style": "dashed",
                "text": "A invalid"
            },
            {
                "id": "candidate-a-target",
                "type": "band",
                "startTime": 1700007200,
                "endTime": 1700021600,
                "lowerPrice": 45000.0,
                "upperPrice": 46200.0,
                "fillColor": "#22C55E22",
                "borderColor": "#22C55E"
            }
        ]
    }
    params = ChartLayerPublishRequest(
        layer_id="waves",
        chart_id=snapshot.chart_id,
        chart_revision=snapshot.revision,
        context=snapshot.context,
        series=snapshot.series,
        revision=revision,
        render=render,
    )
    return HostCallInvocation(
        token=f"publish-wave-{revision}",
        call=HostCallRequest(
            capability_handle=capability_handle,
            method=CHART_LAYER_PUBLISH_METHOD,
            params=params.to_wire(),
            request_context=request_context,
        ),
    )
```

同一 activation generation 内，layer `revision` 必须严格递增。图表
`chartRevision` 则完全由 Host 拥有；切换 symbol/interval 后，旧 revision 的发布会
以 `CHART_LAYER_CONTEXT_STALE` 失败。

## 5. 增量事件链

Host 在 public event 与 market bar 的 delivery metadata 中加入：

```json
{
  "requestContext": {
    "contributionId": "chart-events",
    "userAction": false,
    "generation": 3,
    "traceId": "event-batch-12"
  }
}
```

插件从 `delivery["requestContext"]` 创建 `RequestContext`，然后可以从
`event_batch()` 返回 `HostCallInvocation`。`complete_host_call()` 可继续返回下一步
Host call，形成有界串行链，例如：

```text
chart changed
  -> chart.context.read
  -> market.bars.cancel(old)
  -> market.bars.read(new)
  -> market.bars.subscribe(new)
  -> chart.layer.publish
```

bar batch 同样可以：

```text
bar.updated / bar.closed
  -> 更新 provisional / confirmed pivot
  -> 增量维护候选
  -> chart.layer.publish(next revision)
```

每条链都必须原样保留 Host 签发的 request context。事件上下文永远是
`userAction=false`，不能调用需要当前用户操作的能力。请求完成、取消、超时或 generation
变化后，该上下文立即失效。

## 6. 自动数浪插件的建议切片

第一版建议只实现：

1. `chart.context.read`；
2. `market.bars.read` 拉取 1000–5000 根历史；
3. ATR ZigZag 和 provisional/confirmed pivot；
4. 标准 impulse 的 Top-3 候选；
5. `polyline + label + price-line + band`；
6. `market.bars.subscribe` 增量更新；
7. chart context change 后取消旧订阅并重新绑定。

先不要把 Replay、组合调整浪、任意多级递归、hit-test UI 或 tick 级更新塞入同一
MVP。上述七步已经能形成可验证、不会把事后拟合冒充实时识别的完整产品闭环。
