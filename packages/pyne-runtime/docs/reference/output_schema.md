# Output Schema

Pyne results use `schemaVersion = 1`.

Top-level result keys:

- `schemaVersion`: output schema version.
- `ok`: whether execution succeeded.
- `error`: error message when execution failed.
- `code`: stable error code when execution failed.
- `errorDetail`: structured error detail when execution failed.
- `lines`: backward-compatible flat plotted series.
- `output`: structured output collections.
- `param_schema`: input parameter declarations collected from scripts.
- `meta`: indicator metadata collected from `indicator()`.

Structured output keys:

- `lines`
- `histograms`
- `markers`
- `hlines`
- `fills`
- `bgcolors`
- `barcolors`
- `signals`

Point format:

```json
{"time": 1710000000, "value": 123.45}
```

Pane values:

- `main`
- `separate`

See [error codes](error_codes.md) for structured failure payloads.
