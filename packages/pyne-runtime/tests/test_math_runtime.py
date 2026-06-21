from __future__ import annotations

import math

import pyne_runtime as pn


def _bars(count: int = 8) -> list[dict[str, float]]:
    bars = []
    for idx in range(count):
        close = 100.0 + idx
        bars.append({
            "time": idx + 1,
            "open": close - 0.5,
            "high": close + 1.0,
            "low": close - 1.0,
            "close": close,
            "volume": 1000.0 + idx * 10,
        })
    return bars


def _series_values(result: pn.PyneResult, name: str) -> list[float]:
    for line in result.lines:
        if line["name"] == name:
            return [point["value"] for point in line["data"]]
    raise AssertionError(f"missing series {name}")


def test_math_sum_and_variadic_min_max_are_series_aware() -> None:
    result = pn.run(
        """
plot(math.sum(close, 3), "Sum")
plot(math.max(close, open, 105), "Max")
plot(math.min(close, open, 105), "Min")
plot(math.avg(open, close, high, low), "Avg")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert _series_values(result, "Sum") == [303.0, 306.0, 309.0, 312.0, 315.0, 318.0]
    assert _series_values(result, "Max")[-1] == 107.0
    assert _series_values(result, "Min")[0] == 99.5
    assert _series_values(result, "Avg")[-1] == 106.875


def test_math_round_to_mintick_uses_symbol_metadata() -> None:
    result = pn.run(
        """
plot(math.round_to_mintick(close + 0.13), "Rounded")
plot(math.round_to_mintick(close + 0.125), "Rounded Tie")
""",
        _bars(3),
        settings=pn.PyneSettings(syminfo={"mintick": 0.25}),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert _series_values(result, "Rounded") == [100.25, 101.25, 102.25]
    assert _series_values(result, "Rounded Tie") == [100.25, 101.25, 102.25]


def test_math_round_precision_keyword_and_trunc_preserve_series_inputs() -> None:
    result = pn.run(
        """
plot(math.round(close / 3, precision=2), "Rounded")
plot(math.round(close / 3, digits=1), "Rounded Legacy")
plot(math.trunc((open - close) * 3), "Truncated")
""",
        _bars(3),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert _series_values(result, "Rounded") == [33.33, 33.67, 34.0]
    assert _series_values(result, "Rounded Legacy") == [33.3, 33.7, 34.0]
    assert _series_values(result, "Truncated") == [-1.0, -1.0, -1.0]


def test_math_fixnan_carries_forward_last_non_missing_series_value() -> None:
    result = pn.run(
        """
source = where(bar_index == 0, na, where(bar_index == 2, na, close))
plot(math.fixnan(source), "Fixed")
plot(nz(math.fixnan(na), 7), "Scalar Missing")
""",
        _bars(5),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert _series_values(result, "Fixed") == [101.0, 101.0, 103.0, 104.0]
    assert _series_values(result, "Scalar Missing") == [7.0, 7.0, 7.0, 7.0, 7.0]


def test_math_default_mintick_matches_symbol_metadata_default() -> None:
    assert pn.SymbolInfo().mintick == 1.0
    assert pn.PyneMath().mintick == 1.0
    assert pn.PyneMath(mintick=0).mintick == 1.0


def test_math_random_seed_is_deterministic_for_scalar_script_values() -> None:
    result = pn.run(
        """
a = math.random(1, 2, seed=42)
b = math.random(1, 2, seed=42)
plot(a, "Random A")
plot(b, "Random B")
""",
        _bars(3),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert _series_values(result, "Random A") == _series_values(result, "Random B")
    assert all(1.0 <= value <= 2.0 for value in _series_values(result, "Random A"))


def test_math_trig_and_power_helpers_preserve_series_inputs() -> None:
    result = pn.run(
        """
plot(math.sqrt(close), "Sqrt")
plot(math.pow(close, 2), "Pow")
plot(math.todegrees(math.asin(1)), "Degrees")
""",
        _bars(3),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert math.isclose(_series_values(result, "Sqrt")[0], 10.0, abs_tol=1e-8)
    assert _series_values(result, "Pow")[-1] == 10404.0
    assert _series_values(result, "Degrees") == [90.0, 90.0, 90.0]
