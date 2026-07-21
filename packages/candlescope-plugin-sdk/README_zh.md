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
- 输出使用 CandleScope 拥有的 `candlescope.render/1`，首版只包含 line
  series；
- stdout 只允许协议响应，日志必须写 stderr；
- 默认单消息上限 16 MiB，重复 JSON key、NaN 和 Infinity 会被拒绝。

Realtime session、宿主数据回调、secrets、交易动作、任意前端 JavaScript 和
marketplace packaging 不属于 v1。sidecar 进程隔离是依赖与传输边界，不等同于
完整安全沙箱；资源和权限策略由 CandleScope host 负责。

## 从 Hello Runtime 开始

安装 wheel 后可直接运行：

```powershell
candlescope-hello-runtime
```

它只接受 `plot(close)`，并返回一个 close line series。完整实现位于
`candlescope_plugin_sdk.examples.hello_runtime`，可作为新 runtime 的最小模板。

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
