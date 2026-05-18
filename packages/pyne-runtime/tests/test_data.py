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

