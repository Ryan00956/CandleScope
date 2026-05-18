# PyneResult

`PyneResult` is returned from `pn.run()` and `PyneRuntime.execute()`.

Important fields:

- `ok`
- `lines`
- `output`
- `param_schema`
- `meta`
- `error_detail`

Methods:

- `to_dict()`
- `to_json(indent=None)`
- `to_frame()`
- `plot()`

`to_frame()` requires `pyne-runtime[pandas]`.
`plot()` requires `pyne-runtime[plot]`.

