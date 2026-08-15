from __future__ import annotations

import pytest

from candlescope_backtest_sdk import PythonStrategyContractError, loads_strict
from candlescope_backtest_sdk.contract import MAX_SAFE_INTEGER


def test_rejects_duplicate_keys() -> None:
    with pytest.raises(PythonStrategyContractError, match="DUPLICATE_KEY"):
        loads_strict(b'{"a":1,"a":2}')


def test_rejects_nan_and_infinity_tokens() -> None:
    with pytest.raises(PythonStrategyContractError, match="NON_FINITE_NUMBER"):
        loads_strict(b"NaN")
    with pytest.raises(PythonStrategyContractError, match="NON_FINITE_NUMBER"):
        loads_strict(b"Infinity")
    with pytest.raises(PythonStrategyContractError, match="NON_FINITE_NUMBER"):
        loads_strict(b"-Infinity")


def test_rejects_unsafe_integers() -> None:
    with pytest.raises(PythonStrategyContractError, match="UNSAFE_INTEGER"):
        loads_strict(str(MAX_SAFE_INTEGER + 1).encode("utf-8"))


def test_accepts_safe_integer_boundary() -> None:
    assert loads_strict(str(MAX_SAFE_INTEGER).encode("utf-8")) == MAX_SAFE_INTEGER
