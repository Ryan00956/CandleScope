# CandleScope Pine Compatibility Plugin

This package bridges the independently released
[`pine-compat-runtime`](https://github.com/Ryan00956/pine-compat-runtime) wheel to
the public `candlescope.script-runtime/1` SDK. It contains adapter code only: no
Pine engine source snapshot and no imports from CandleScope private backend
packages.

The pinned `v0.2.0` engine supports closed-bar batch execution. Forming-bar,
incremental, strategy, `request.*`, imports, and native drawing-object families
remain fail-closed until a later public engine and host protocol are released.

Run locally:

```powershell
python -m pip install -e ..\candlescope-plugin-sdk -e .
python -m candlescope_plugin_pine_compat
```

The release builder accepts exactly three wheels: this bridge, SDK `0.2.0`, and
the SHA-pinned public Pine engine wheel.
