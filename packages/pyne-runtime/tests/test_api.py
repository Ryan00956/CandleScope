from __future__ import annotations

from typing import get_type_hints
import math

import pyne_runtime as pn
import pyne_runtime.settings as settings_module
from pyne_runtime.executor import execute_pyne_script
from pyne_runtime.request import DataProvider


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
    assert "hint" in diagnostics[0]
    assert "docsUrl" in diagnostics[0]


def test_validate_reports_series_if_migration_hint() -> None:
    diagnostics = pn.validate(
        """
if close > open:
    plot(close, "Up Close")
"""
    )

    assert diagnostics
    assert diagnostics[0]["code"] == "PYNE_MIGRATION_HINT"
    assert diagnostics[0]["line"] == 2
    assert "when" in diagnostics[0]["hint"]
    assert "pine_to_pyne_cookbook" in diagnostics[0]["docsUrl"]


def test_validate_reports_series_ternary_migration_hint() -> None:
    diagnostics = pn.validate('plot(close if close > open else na, "Up Close")')

    assert diagnostics
    assert diagnostics[0]["code"] == "PYNE_MIGRATION_HINT"
    assert "ternary" in diagnostics[0]["message"]
    assert "when" in diagnostics[0]["hint"]


def test_validate_reports_python_boolean_series_migration_hints() -> None:
    diagnostics = pn.validate("signal = (close > open) and (close > close[1])")

    assert diagnostics
    assert diagnostics[0]["code"] == "PYNE_MIGRATION_HINT"
    assert "'and'" in diagnostics[0]["message"]
    assert "&" in diagnostics[0]["hint"]

    diagnostics = pn.validate("signal = (close > open) or (close > close[1])")
    assert diagnostics
    assert diagnostics[0]["code"] == "PYNE_MIGRATION_HINT"
    assert "'or'" in diagnostics[0]["message"]
    assert "|" in diagnostics[0]["hint"]

    diagnostics = pn.validate("signal = not (close > open)")
    assert diagnostics
    assert diagnostics[0]["code"] == "PYNE_MIGRATION_HINT"
    assert "'not'" in diagnostics[0]["message"]
    assert "~" in diagnostics[0]["hint"]


def test_validate_allows_bitwise_boolean_series_composition() -> None:
    assert pn.validate("signal = (close > open) & (close > close[1])") == []
    assert pn.validate("signal = (close > open) | (close > close[1])") == []
    assert pn.validate("signal = ~(close > open)") == []


def test_validate_reports_request_bare_expression_migration_hint() -> None:
    diagnostics = pn.validate(
        'higher = request.security("BTCUSDT", "1h", ta.ema(close, 20))'
    )

    assert diagnostics
    assert diagnostics[0]["code"] == "PYNE_MIGRATION_HINT"
    assert "request.security" in diagnostics[0]["message"]
    assert "lambda ctx" in diagnostics[0]["hint"]


def test_validate_allows_supported_request_field_and_thunk_expressions() -> None:
    assert pn.validate('higher = request.security("BTCUSDT", "1h", close)') == []
    assert pn.validate('higher = request.security("BTCUSDT", "1h", close[1])') == []
    assert pn.validate(
        'higher = request.security("BTCUSDT", "1h", lambda ctx: ctx.ta.ema(ctx.close, 20))'
    ) == []


def test_validate_reports_array_from_keyword_migration_hint() -> None:
    diagnostics = pn.validate("items = array.from(close, open)")

    assert len(diagnostics) == 2
    assert diagnostics[0]["code"] == "PYNE_SYNTAX_ERROR"
    assert diagnostics[1]["code"] == "PYNE_MIGRATION_HINT"
    assert "array.from" in diagnostics[1]["message"]
    assert "array.from_values" in diagnostics[1]["hint"]


def test_validate_reports_negative_history_migration_hint() -> None:
    diagnostics = pn.validate('plot(close[-1], "Forward")')

    assert diagnostics
    assert diagnostics[0]["code"] == "PYNE_MIGRATION_HINT"
    assert "Negative history" in diagnostics[0]["message"]
    assert "close[1]" in diagnostics[0]["hint"]


def test_validate_reports_negative_shift_migration_hint() -> None:
    diagnostics = pn.validate('plot(shift(close, -1), "Forward")')

    assert diagnostics
    assert diagnostics[0]["code"] == "PYNE_MIGRATION_HINT"
    assert "Negative history offsets" in diagnostics[0]["message"]
    assert "shift(close, 1)" in diagnostics[0]["hint"]

    diagnostics = pn.validate('plot(ref(close, periods=-1), "Forward")')
    assert diagnostics
    assert diagnostics[0]["code"] == "PYNE_MIGRATION_HINT"


def test_validate_allows_non_negative_history_and_shift() -> None:
    assert pn.validate('plot(close[1], "Previous")') == []
    assert pn.validate('plot(shift(close, 1), "Previous")') == []
    assert pn.validate('plot(ref(close, periods=1), "Previous")') == []


def test_schema_exposes_ohlcv_contract() -> None:
    schema = pn.schema()

    assert schema["input"]["type"] == "ohlcv"
    assert schema["input"]["schemaVersion"] == pn.PYNE_INPUT_SCHEMA_VERSION
    assert "close" in schema["input"]["required"]


def test_barmerge_namespace_is_public_api() -> None:
    assert pn.barmerge.gaps_on == "barmerge.gaps_on"
    assert pn.barmerge.gaps_off == "barmerge.gaps_off"
    assert pn.barmerge.lookahead_on == "barmerge.lookahead_on"
    assert pn.barmerge.lookahead_off == "barmerge.lookahead_off"


def test_invalid_symbol_error_is_public_api() -> None:
    assert issubclass(pn.PyneInvalidSymbolError, Exception)


def test_missing_value_helpers_are_public_api() -> None:
    fixed = pn.fixnan([pn.na, 1.0, pn.na, 3.0])

    assert math.isnan(pn.nz(pn.na, pn.na))
    assert pn.nz(pn.na, 7) == 7
    assert math.isnan(fixed[0])
    assert fixed.tolist()[1:] == [1.0, 1.0, 3.0]


def test_data_provider_annotations_use_public_protocol() -> None:
    expected = DataProvider | None

    assert get_type_hints(pn.run)["data_provider"] == expected
    assert get_type_hints(
        pn.PyneSettings,
        globalns={**vars(settings_module), "DataProvider": DataProvider},
    )["data_provider"] == expected
    assert get_type_hints(execute_pyne_script)["data_provider"] == expected
