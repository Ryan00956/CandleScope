# CandleScope Plugin SDK

[English](README.md)

`candlescope-plugin-sdk` 是社区开发 CandleScope 脚本 runtime 插件时使用的零
运行时依赖 Python 契约。插件作为隔离 sidecar 运行，通过 stdin/stdout 交换
UTF-8 JSON-RPC 2.0 JSON Lines。

v1 协议 ID：

```text
candlescope.script-runtime/1
```

## v1 已冻结能力

- 生命周期方法：`handshake`、`describe`、`analyze`、`executeBatch`、
  `shutdown`；
- 执行前显式协商能力，不支持的能力直接拒绝；
- 类型化 chart context 和 OHLCV batch；
- 源码与执行错误使用结构化 diagnostics；
- 输出使用 CandleScope 拥有的 `candlescope.render/1`；line series 是基础能力，
  histogram 与结构化 render collections 通过附加能力协商；
- stdout 只允许协议响应，日志必须写 stderr；
- 默认单消息上限 16 MiB，重复 JSON key、NaN 和 Infinity 会被拒绝。

Realtime session、宿主数据回调、secrets、交易动作、任意前端 JavaScript 和
marketplace packaging 不属于 v1。sidecar 进程隔离是依赖与传输边界，不等同于
完整安全沙箱；资源和权限策略由 CandleScope host 负责。

需要 marker、hline、fill、背景、K 线着色、signal、strategy report 或 drawing
objects 的插件声明 `render.structured-output/1`，并使用 SDK 的
`RenderCollections`。集合名称和 JSON-only 校验属于公开协议，因此社区 runtime
不需要再维护 CandleScope 私有 serializer。完整字段见
[`docs/protocol-v1.md`](docs/protocol-v1.md)。

## 从 Hello Runtime 开始

安装 wheel 后可直接运行：

```powershell
candlescope-hello-runtime
```

它只接受 `plot(close)`，并返回一个 close line series。完整实现位于
`candlescope_plugin_sdk.examples.hello_runtime`，可作为新 runtime 的最小模板。

前端从 runtime descriptor 动态发现语言，不使用封闭的 runtime ID 联合类型。插件可在
`RuntimeDescriptor.meta.ui.languages.<language-id>` 下提供安全的 editor hints：

```python
meta={
    "ui": {
        "languages": {
            "my": {
                "monacoLanguage": "plaintext",
                "starterSource": "plot(close)\n",
            }
        }
    }
}
```

这只是可选的 JSON 展示 metadata；宿主可以忽略，且绝不会因此加载插件提供的
JavaScript、CSS 或 component。未知语言仍可使用宿主的 plaintext editor fallback。

社区插件应继承 `BaseRuntimePlugin` 并实现：

```python
describe()
analyze(request)
execute_batch(request)
shutdown()  # 可选资源清理，默认空实现
```

使用 `serve_runtime(MyRuntime())` 即可获得同一套有界 JSON-RPC server、握手、
错误映射和 stdout 保护。精确 wire 契约见
[docs/protocol-v1.md](docs/protocol-v1.md)。

## 打包给 CandleScope

Phase 3 不要求社区作者维护 CandleScope 私有适配层。为插件及全部运行时依赖构建
wheel，复制并修改
[`examples/hello-runtime.manifest.json`](examples/hello-runtime.manifest.json)，再使用
CandleScope 的 `scripts/candlescope_plugin.py build` 生成 `.cspkg`。安装器会为每个
bundle 建独立 venv，离线安装 wheel，并用 manifest 中的固定 analyze/execute 结果
探针完成 descriptor 和行为校验。

完整格式、SHA-256 发布和安装/回滚流程见
[`backend/app/plugin_runtime/INSTALLER_zh.md`](../../backend/app/plugin_runtime/INSTALLER_zh.md)。
插件不能导入 `app.*` 或依赖 CandleScope 源码快照；Host 适配只发生在公开 SDK
协议和 Render IR 上。

## 开发门禁

```powershell
python -m ruff check .
python -m ruff format --check .
python -m pytest -q
python -m build
python scripts/package_smoke.py --dist-dir dist
```

`package_smoke.py` 会把构建出的 wheel 离线安装到全新临时 venv，再通过真实
console entry point 重放固定五方法 transcript。
