# Indicator Runtime 路由

[English](RUNTIME_ROUTING.md)

Phase 4 把 CandleScope 稳定的 Indicator 传输接到通用脚本 runtime Host。Runtime
发行包仍然只实现公开 `candlescope-plugin-sdk`，不能导入 `app.indicator`、FastAPI
路由、DataManager 或前端 payload 代码。

## 两份相互独立的文件

插件激活和流量路由故意使用两套 schema：

- `runtime-registry.json` 说明 Host 可以启动哪个已验证 sidecar 安装；
- `indicator-runtime-routes.json` 说明每种脚本语言是否以及由哪个 runtime 执行。

默认路由文件与 activation registry 位于同一目录：

- Windows：`%LOCALAPPDATA%/CandleScope/plugins/indicator-runtime-routes.json`；
- Linux：`$XDG_DATA_HOME/candlescope/plugins/indicator-runtime-routes.json`，未设置
  时为 `~/.local/share/candlescope/plugins/indicator-runtime-routes.json`。

可用 `CANDLESCOPE_INDICATOR_RUNTIME_ROUTES` 指定其他文件。Phase 6 起，默认文件
不存在等价于内置的 `pyne=sidecar,candlescope.pyne`；如果插件尚未安装并激活，应用
会在启动时 fail closed。显式指定的文件缺失或非法同样会让应用启动失败。

```json
{
  "schemaVersion": 1,
  "routes": [
    {
      "language": "pyne",
      "mode": "shadow",
      "runtimeId": "candlescope.pyne"
    },
    {
      "language": "pine",
      "mode": "sidecar",
      "runtimeId": "candlescope.pine-compat"
    }
  ]
}
```

`language` 和 `runtimeId` 是稳定的小写标识符，每种语言只能出现一次，当前
`pyne` 路由必须显式存在。`legacy` 必须省略 `runtimeId`；`shadow` 和 `sidecar`
必须提供。路由只在启动时读取，不支持热加载。

现有客户端不传 `language`，因此仍然是 `pyne`。API/WS 客户端可以显式传入另一种
已配置的语言 ID，让社区 runtime 无需 CandleScope 私有适配层即可使用 `sidecar`。
Phase 4 只有 `pyne` 具备 legacy adapter，所以其他语言必须使用 `sidecar`。Phase 7 起，
前端从公开目录发现这些语言，不再维护封闭的 runtime ID 联合类型。

## 公开 runtime 目录

`GET /api/v1/indicators/runtimes` 把启动时已验证的 routes 和 runtime descriptors 投影为
版本化公开目录：

```json
{
  "schemaVersion": 1,
  "defaultLanguage": "pyne",
  "languages": [
    {
      "id": "pyne",
      "name": "Pyne",
      "extensions": [".pyne"],
      "aliases": ["pyne"],
      "runtimeId": "candlescope.pyne",
      "routeMode": "sidecar",
      "available": true,
      "features": ["batch-execution/1", "render.line-series/1"]
    }
  ],
  "runtimes": [
    {
      "id": "candlescope.pyne",
      "name": "CandleScope Pyne Runtime",
      "version": "0.2.0",
      "package": "candlescope-plugin-pyne",
      "languages": [
        {"id": "pyne", "name": "Pyne", "extensions": [".pyne"], "aliases": ["pyne"]}
      ],
      "features": ["batch-execution/1", "render.line-series/1"],
      "requiredHostFeatures": [],
      "meta": {}
    }
  ]
}
```

响应会在 `runtimes` 中包含每个被引用的 SDK 公开 runtime descriptor，但绝不包含
registry 路径、进程命令、PID、stderr 或宿主失败细节。Runtime metadata 只能是 JSON
数据；可选的 `meta.ui.languages.<language-id>` 约定可以提供 `monacoLanguage` 和
`starterSource` 字符串，不能注入前端代码。未知语言使用宿主的 plaintext editor fallback。

## 三种模式的语义

| 模式 | 用户收到的结果 | Sidecar 行为 | 失败行为 |
|---|---|---|---|
| `legacy` | 现有进程内结果 | 不调用 | 保持现状 |
| `shadow` | 完全原样的 legacy 结果 | 接收同一份 source、context、params、options 和不可变 bars batch | 只记内部诊断，不改变响应 |
| `sidecar` | 从 `candlescope.render/1` 适配的插件结果 | 唯一执行者 | 返回宿主定义的不可用错误，绝不静默回退 |

Shadow 与 legacy 同时开始，但不会延长用户响应时间。每个进程最多接纳 64 个待完成
对比；达到硬上限后，请求仍执行并返回 legacy，但不再启动新的 sidecar 工作，诊断中的
`shadowSkipped`、`pendingShadow` 与 `maxPendingShadow` 会暴露这一状态。已接纳的对比由
应用生命周期持有。诊断只保存 hash、不同的顶层字段名、transport、runtime ID、状态和
计数，不保存源码、K 线、参数、进程命令、stderr 或本地路由文件路径。

每条非 legacy 路由在启动时都会核对 runtime descriptor。Runtime 必须声明目标语言，
并具备 `batch-execution/1` 与 `render.line-series/1`。拼写错误或能力不匹配会在接收
Indicator 请求前 fail closed。

## 传输覆盖

同一个 `IndicatorRuntimeService` 同时服务：

- `GET /api/v1/indicators/runtimes`，供前端按 descriptor 发现语言；
- `POST /api/v1/indicators/compute`；
- `POST /api/v1/indicators/range`；
- `POST /api/v1/indicators/range/batch`；
- `WS /api/v1/stream/indicators` 中的脚本订阅。

Host 负责构造 market context 与 OHLCV 输入；插件输出由 CandleScope 拥有的适配器
转换，因此插件不能重定义 HTTP/WS envelope。Range 遇到 Host 故障时不会把瞬时错误
写入 range cache；缓存 payload 会重新绑定到本次请求的 `clientId`/`indicatorId`。
脚本缓存 identity 包含 language，因此不同 runtime 不会仅因源码 hash 相同就复用结果或
合并 singleflight。

Render IR v1 的基础能力仍是 line series；`render.histogram-series/1` 与
`render.structured-output/1` 以可协商方式增加 histogram、marker、hline、fill、背景、
K 线着色、signal、strategy report 和 drawing objects。Pyne 0.2.0 bridge 已通过这两项
能力重建 Phase 0 冻结 payload。真正有状态的 realtime session 仍不在协议 v1 内；
sidecar 对确认 bars 使用 batch 执行。

## 安全上线顺序

1. 安装并激活固定摘要的 `.cspkg`，重启 CandleScope。
2. 语言路由先保持 `legacy`，确认 `/health` 中 runtime 已 ready。
3. 只把这一种语言改为 `shadow`，再次重启。
4. 覆盖 compute、range/batch 和 WebSocket 流量；在
   `/api/v1/indicators/diagnostics` 的 `scriptRuntimeRouting` 查看结果。
5. 要求冻结的兼容 golden 全绿，并达到约定的 shadow 匹配窗口。
6. 把路由改为 `sidecar`；Phase 6 内置默认值已经完成此切换。保留旧实现，以便在源码
   删除提交前显式修改路由回滚。
7. 只有在之后的独立提交里才能删除 vendored runtime 源码快照。

紧急回滚是把路由文件改回 `legacy` 并重启。`CANDLESCOPE_PLUGIN_HOST_ENABLED=0`
可以关闭整个 Host；但如果仍配置了 `shadow`/`sidecar`，启动会有意失败，而不是伪装
成健康的 rollout。

Phase 4 不发行 Pyne bridge，也不删除 CandleScope 当前的 Pyne 源码快照；它们分别
属于 Phase 5/6。
