from __future__ import annotations

from candlescope_plugin_sdk import (
    AnalyzeRequest,
    Bar,
    ExecuteBatchRequest,
    MarketContext,
)
from candlescope_plugin_sdk.examples.hello_runtime import HelloRuntime


CONTEXT = MarketContext(
    exchange="binance",
    market_type="spot",
    symbol="BTCUSDT",
    interval="1m",
)


def test_hello_runtime_analyzes_only_its_documented_source() -> None:
    runtime = HelloRuntime()

    valid = runtime.analyze(AnalyzeRequest(source="plot(close)", context=CONTEXT))
    invalid = runtime.analyze(AnalyzeRequest(source="plot(open)", context=CONTEXT))

    assert valid.ok is True
    assert valid.executable is True
    assert invalid.ok is False
    assert invalid.diagnostics[0].code == "HELLO_UNSUPPORTED_SOURCE"


def test_hello_runtime_executes_close_as_candlescope_render_ir() -> None:
    runtime = HelloRuntime()
    result = runtime.execute_batch(
        ExecuteBatchRequest(
            source="plot(close)",
            context=CONTEXT,
            bars=(
                Bar(1, 10, 12, 9, 11, 100),
                Bar(2, 11, 13, 10, 12, 110),
            ),
        )
    )

    assert result.ok is True
    assert result.output is not None
    assert result.output.schema == "candlescope.render/1"
    assert result.output.series[0].id == "close"
    assert [point.value for point in result.output.series[0].points] == [11.0, 12.0]


def test_hello_runtime_returns_diagnostic_instead_of_raising_for_bad_source() -> None:
    result = HelloRuntime().execute_batch(
        ExecuteBatchRequest(
            source="import os",
            context=CONTEXT,
            bars=(),
        )
    )

    assert result.ok is False
    assert result.output is None
    assert result.diagnostics[0].severity == "error"
