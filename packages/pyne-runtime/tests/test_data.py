from __future__ import annotations

from pathlib import Path

import pytest

import pyne_runtime as pn


def test_read_ohlcv_csv(tmp_path: Path) -> None:
    csv_path = tmp_path / "bars.csv"
    csv_path.write_text(
        "time,open,high,low,close,volume\n"
        "1000,1,2,1,1.5,100\n"
        "2000,1.5,2.5,1.4,2,120\n",
        encoding="utf-8",
    )

    data = pn.read_ohlcv(csv_path, time_unit="ms")

    assert len(data) == 2
    assert data.to_ohlcv()[0]["time"] == 1
    assert data.to_ohlcv()[1]["close"] == 2.0


def test_pyne_data_requires_ohlcv_fields() -> None:
    with pytest.raises(ValueError, match="missing required fields"):
        pn.PyneData.from_ohlcv([{"time": 1, "close": 2}])


def test_pyne_data_rejects_duplicate_or_non_monotonic_times() -> None:
    bars = [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
    ]

    with pytest.raises(ValueError, match="unique"):
        pn.PyneData.from_ohlcv(bars)

    with pytest.raises(ValueError, match="strictly increasing"):
        pn.PyneData.from_ohlcv([bars[0], {**bars[1], "time": 0}])


def test_pyne_data_rejects_invalid_ohlc_relationships() -> None:
    with pytest.raises(ValueError, match="high must cover"):
        pn.PyneData.from_ohlcv([
            {"time": 1, "open": 3, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        ])

    with pytest.raises(ValueError, match="volume"):
        pn.PyneData.from_ohlcv([
            {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": -1},
        ])


def test_pyne_data_column_and_row_helpers() -> None:
    data = pn.PyneData.from_ohlcv([
        {"time": 1, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 3, "low": 1.5, "close": 2.5, "volume": 200},
        {"time": 3, "open": 3, "high": 4, "low": 2.5, "close": 3.5, "volume": 300},
    ])

    assert data.columns == ("time", "open", "high", "low", "close", "volume")
    assert data.first["time"] == 1
    assert data.last["close"] == 3.5
    assert data.time_range == (1, 3)
    assert data.column("close") == [1.5, 2.5, 3.5]
    assert data["close"] == [1.5, 2.5, 3.5]
    assert data[1]["volume"] == 200.0
    assert len(data[:2]) == 2
    assert len(data.head(2)) == 2
    assert data.tail(1)[0]["time"] == 3


def test_pyne_data_rejects_unknown_column() -> None:
    data = pn.PyneData.from_ohlcv([
        {"time": 1, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "volume": 100},
    ])

    with pytest.raises(KeyError, match="adjusted"):
        data.column("adjusted")
