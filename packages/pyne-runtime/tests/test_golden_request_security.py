from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest

import pyne_runtime as pn


GOLDEN_DIR = Path(__file__).parent / "golden"


class GoldenProvider:
    def __init__(
        self,
        bars: list[dict[str, Any]] | dict[str, list[dict[str, Any]]],
        metadata: dict[str, Any] | None = None,
        invalid_symbols: list[str] | None = None,
    ) -> None:
        self.calls: list[tuple[str, str, int, int]] = []
        self._bars = bars
        self._metadata = metadata or {}
        self._invalid_symbols = set(invalid_symbols or [])
        self.capabilities = {
            "request.security": True,
            "request.security_lower_tf": True,
        }

    def get_ohlcv(
        self,
        symbol: str,
        timeframe: str,
        start: int,
        end: int,
    ) -> list[dict[str, Any]]:
        self.calls.append((symbol, timeframe, start, end))
        if symbol in self._invalid_symbols:
            raise pn.PyneInvalidSymbolError(symbol)
        if isinstance(self._bars, dict):
            bars = self._bars.get(f"{symbol}|{timeframe}", self._bars.get(timeframe, []))
        else:
            bars = self._bars
        return [_normalize_provider_bar(bar) for bar in bars]

    def get_request_metadata(self, symbol: str, timeframe: str) -> dict[str, Any]:
        return self._metadata.get(f"{symbol}|{timeframe}", self._metadata.get(timeframe, {}))


def test_golden_request_security_lower_tf_alignment() -> None:
    fixture = _load_fixture("request_security_lower_tf_alignment.json")
    provider = GoldenProvider(fixture["provider_bars"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_alignment() -> None:
    fixture = _load_fixture("request_security_alignment.json")
    provider = GoldenProvider(fixture["provider_bars"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_htf_capture() -> None:
    fixture = _load_fixture("request_security_htf_capture.json")
    provider = GoldenProvider(fixture["provider_bars"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_lower_tf_capture() -> None:
    fixture = _load_fixture("request_security_lower_tf_capture.json")
    provider = GoldenProvider(fixture["provider_bars"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_lower_tf_helpers_capture() -> None:
    fixture = _load_fixture("request_security_lower_tf_helpers_capture.json")
    provider = GoldenProvider(fixture["provider_bars"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_same_timeframe_capture() -> None:
    fixture = _load_fixture("request_security_same_timeframe_capture.json")
    provider = GoldenProvider(fixture["provider_bars"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_time_close_capture() -> None:
    fixture = _load_fixture("request_security_time_close_capture.json")
    provider = GoldenProvider(fixture["provider_bars"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_metadata_capture() -> None:
    fixture = _load_fixture("request_security_metadata_capture.json")
    provider = GoldenProvider(fixture["provider_bars"], fixture["provider_metadata"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_gaps_lookahead_capture() -> None:
    fixture = _load_fixture("request_security_gaps_lookahead_capture.json")
    provider = GoldenProvider(fixture["provider_bars"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_daily_context_capture() -> None:
    fixture = _load_fixture("request_security_daily_context_capture.json")
    provider = GoldenProvider(fixture["provider_bars"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_session_flags_capture() -> None:
    fixture = _load_fixture("request_security_session_flags_capture.json")
    provider = GoldenProvider(fixture["provider_bars"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_timezone_capture() -> None:
    fixture = _load_fixture("request_security_timezone_capture.json")
    provider = GoldenProvider(fixture["provider_bars"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_expression_context_capture() -> None:
    fixture = _load_fixture("request_security_expression_context_capture.json")
    provider = GoldenProvider(fixture["provider_bars"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_invalid_symbol_ignore_capture() -> None:
    fixture = _load_fixture("request_security_invalid_symbol_ignore_capture.json")
    provider = GoldenProvider(fixture["provider_bars"], invalid_symbols=fixture["invalid_symbols"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_invalid_symbol_expression_ignore_capture() -> None:
    fixture = _load_fixture("request_security_invalid_symbol_expression_ignore_capture.json")
    provider = GoldenProvider(fixture["provider_bars"], invalid_symbols=fixture["invalid_symbols"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_invalid_symbol_tuple_ignore_capture() -> None:
    fixture = _load_fixture("request_security_invalid_symbol_tuple_ignore_capture.json")
    provider = GoldenProvider(fixture["provider_bars"], invalid_symbols=fixture["invalid_symbols"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_lower_tf_invalid_symbol_ignore_capture() -> None:
    fixture = _load_fixture("request_security_lower_tf_invalid_symbol_ignore_capture.json")
    provider = GoldenProvider(fixture["provider_bars"], invalid_symbols=fixture["invalid_symbols"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_lower_tf_invalid_symbol_expression_ignore_capture() -> None:
    fixture = _load_fixture(
        "request_security_lower_tf_invalid_symbol_expression_ignore_capture.json"
    )
    provider = GoldenProvider(fixture["provider_bars"], invalid_symbols=fixture["invalid_symbols"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_lower_tf_invalid_symbol_tuple_ignore_capture() -> None:
    fixture = _load_fixture("request_security_lower_tf_invalid_symbol_tuple_ignore_capture.json")
    provider = GoldenProvider(fixture["provider_bars"], invalid_symbols=fixture["invalid_symbols"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_lower_tf_invalid_timeframe_ignore_capture() -> None:
    fixture = _load_fixture("request_security_lower_tf_invalid_timeframe_ignore_capture.json")
    provider = GoldenProvider(fixture["provider_bars"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_lower_tf_invalid_timeframe_tuple_ignore_capture() -> None:
    fixture = _load_fixture("request_security_lower_tf_invalid_timeframe_tuple_ignore_capture.json")
    provider = GoldenProvider(fixture["provider_bars"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_lower_tf_requested_context_capture() -> None:
    fixture = _load_fixture("request_security_lower_tf_requested_context_capture.json")
    provider = GoldenProvider(fixture["provider_bars"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_lower_tf_timezone_capture() -> None:
    fixture = _load_fixture("request_security_lower_tf_timezone_capture.json")
    provider = GoldenProvider(fixture["provider_bars"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def test_golden_request_security_tradingview_htf_capture_parity() -> None:
    fixture = _load_fixture("request_security_htf_capture.json")
    capture = fixture["external_capture"]
    provider = GoldenProvider(capture["provider_bars"])

    result = pn.run(
        fixture["script"],
        capture["bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    for name, expected in capture["series"].items():
        _assert_series_matches(
            result.get_series(name),
            expected,
            tolerance=float(capture.get("tolerance", 0.0)),
        )


def test_golden_request_security_edge_cases() -> None:
    fixture = _load_fixture("request_security_edge_cases.json")
    provider = GoldenProvider(fixture["provider_bars"])

    result = pn.run(
        fixture["script"],
        fixture["chart_bars"],
        data_provider=provider,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [list(call) for call in provider.calls] == fixture["expected_provider_calls"]
    for name, expected in fixture["expected_series"].items():
        _assert_series_matches(result.get_series(name), expected)


def _load_fixture(name: str) -> dict[str, Any]:
    return json.loads((GOLDEN_DIR / name).read_text(encoding="utf-8"))


def _normalize_provider_bar(bar: dict[str, Any]) -> dict[str, Any]:
    return {
        key: (math.nan if value is None and key != "time" else value)
        for key, value in bar.items()
    }


def _assert_series_matches(
    actual: list[dict[str, Any]],
    expected: list[dict[str, Any]],
    *,
    tolerance: float = 1e-9,
) -> None:
    assert len(actual) == len(expected)
    for actual_point, expected_point in zip(actual, expected):
        assert actual_point.keys() == expected_point.keys()
        for key, expected_value in expected_point.items():
            actual_value = actual_point[key]
            if key == "value" and isinstance(expected_value, (int, float)):
                assert actual_value == pytest.approx(expected_value, abs=tolerance)
            else:
                assert actual_value == expected_value
