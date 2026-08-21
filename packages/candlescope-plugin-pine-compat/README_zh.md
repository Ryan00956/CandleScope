# CandleScope Pine Compatibility 插件

本包把独立发布的
[`pine-compat-runtime`](https://github.com/helenananaa/pine-compat-runtime) wheel
桥接到公开的 `candlescope.script-runtime/1` SDK。包内只有适配代码，不包含 Pine
引擎源码快照，也不导入 CandleScope 后端私有模块。

当前锁定公开 `v0.2.0`，只承诺闭合 K 线批执行。forming bar、增量会话、策略、
`request.*`、imports 和原生绘图对象继续 fail-closed，直到相应引擎和宿主协议正式
发布。

本地运行：

```powershell
python -m pip install -e ..\candlescope-plugin-sdk -e .
python -m candlescope_plugin_pine_compat
```

发行构建器只接受三个 wheel：本 bridge、SDK `0.2.0` 和 SHA 锁定的公开 Pine
引擎 wheel。
