# PyneRuntime

`PyneRuntime` is the host-facing execution class.

```python
import pyne_runtime as pn

runtime = pn.PyneRuntime(settings=pn.PyneSettings(security_mode="safe"))
result = runtime.execute(script, ohlcv, params={})
```

Most users should call `pn.run()`. Hosts can use `PyneRuntime` when they need a persistent runtime object or explicit settings.

