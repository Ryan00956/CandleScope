from __future__ import annotations

import pyne_runtime as pn


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 1.5, "high": 2.5, "low": 1.4, "close": 2.0, "volume": 120},
        {"time": 3, "open": 2.0, "high": 2.3, "low": 1.8, "close": 2.1, "volume": 150},
    ]


def test_run_list_of_dicts_inline() -> None:
    result = pn.run(
        'indicator("Close", overlay=True)\nplot(close, "Close")',
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert len(result.lines) == 1
    assert result.lines[0]["name"] == "Close"


def test_validate_reports_syntax_error() -> None:
    diagnostics = pn.validate("plot(")

    assert diagnostics
    assert diagnostics[0]["code"] == "PYNE_SYNTAX_ERROR"


def test_schema_exposes_ohlcv_contract() -> None:
    schema = pn.schema()

    assert schema["input"]["type"] == "ohlcv"
    assert "close" in schema["input"]["required"]

