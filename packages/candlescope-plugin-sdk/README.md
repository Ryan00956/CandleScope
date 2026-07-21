# CandleScope Plugin SDK

[简体中文](README_zh.md)

`candlescope-plugin-sdk` is the dependency-free Python contract for building
CandleScope script runtime plugins. A plugin runs as an isolated sidecar and
speaks UTF-8 JSON-RPC 2.0 over newline-delimited stdin/stdout.

The v1 protocol identifier is:

```text
candlescope.script-runtime/1
```

## What v1 freezes

- Required lifecycle methods: `handshake`, `describe`, `analyze`,
  `executeBatch`, and `shutdown`.
- Explicit feature negotiation before any runtime work.
- Typed chart context and OHLCV batch input.
- Structured diagnostics for source/runtime failures.
- CandleScope-owned `candlescope.render/1` output with line series.
- Protocol-only stdout: plugins must send logs to stderr.

Realtime sessions, host data callbacks, secrets, trading actions, arbitrary
frontend JavaScript, and marketplace packaging are intentionally outside v1.
Process separation is a transport and dependency boundary, not a complete
security sandbox; the future CandleScope host remains responsible for resource
limits, process termination, permissions, and trust policy.

## Minimal runtime

```python
from candlescope_plugin_sdk import (
    AnalyzeResult,
    BaseRuntimePlugin,
    ExecuteBatchResult,
    FEATURE_BATCH_EXECUTION_V1,
    FEATURE_RENDER_LINE_SERIES_V1,
    FEATURE_SOURCE_ANALYSIS_V1,
    LanguageDescriptor,
    LinePoint,
    LineSeries,
    RenderOutput,
    RuntimeDescriptor,
    serve_runtime,
)


class MyRuntime(BaseRuntimePlugin):
    def describe(self) -> RuntimeDescriptor:
        return RuntimeDescriptor(
            id="my-runtime",
            name="My Runtime",
            version="0.1.0",
            package="candlescope-plugin-my-runtime",
            languages=(LanguageDescriptor(id="my", name="My Script"),),
            features=(
                FEATURE_SOURCE_ANALYSIS_V1,
                FEATURE_BATCH_EXECUTION_V1,
                FEATURE_RENDER_LINE_SERIES_V1,
            ),
            required_host_features=(
                FEATURE_BATCH_EXECUTION_V1,
                FEATURE_RENDER_LINE_SERIES_V1,
            ),
        )

    def analyze(self, request):
        return AnalyzeResult(ok=True, executable=True)

    def execute_batch(self, request):
        points = tuple(LinePoint(bar.time, bar.close) for bar in request.bars)
        return ExecuteBatchResult(
            ok=True,
            output=RenderOutput(
                series=(LineSeries(id="close", title="Close", points=points),)
            ),
        )


if __name__ == "__main__":
    raise SystemExit(serve_runtime(MyRuntime()))
```

The installed package also includes a working `candlescope-hello-runtime`
command. It accepts the tiny source `plot(close)` and returns one line series.

See [docs/protocol-v1.md](docs/protocol-v1.md) for the wire contract.

## Development checks

```powershell
python -m ruff check .
python -m ruff format --check .
python -m pytest -q
python -m build
python scripts/package_smoke.py --dist-dir dist
```

Use `python -m build --no-isolation` only when the selected interpreter already
has the declared build backend installed.
