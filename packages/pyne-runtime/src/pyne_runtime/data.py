"""OHLCV data helpers for Pyne."""
from __future__ import annotations

import csv
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_COLUMNS = {
    "time": "time",
    "open": "open",
    "high": "high",
    "low": "low",
    "close": "close",
    "volume": "volume",
}


@dataclass(frozen=True)
class PyneData:
    """Small OHLCV container used by the friendly API."""

    _ohlcv: tuple[dict[str, Any], ...]

    @classmethod
    def from_ohlcv(cls, items: Iterable[dict[str, Any]], *, time_unit: str = "s") -> "PyneData":
        bars = tuple(_normalize_bar(item, time_unit=time_unit) for item in items)
        if not bars:
            raise ValueError("PyneData requires at least one OHLCV bar")
        return cls(bars)

    @classmethod
    def from_csv(
        cls,
        path: str | Path,
        *,
        time_unit: str = "s",
        columns: dict[str, str] | None = None,
    ) -> "PyneData":
        column_map = {**DEFAULT_COLUMNS, **(columns or {})}
        with Path(path).open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            rows = []
            for row in reader:
                rows.append({
                    key: row[source]
                    for key, source in column_map.items()
                    if source in row
                })
        return cls.from_ohlcv(rows, time_unit=time_unit)

    @classmethod
    def from_pandas(
        cls,
        df: Any,
        *,
        time: str = "time",
        open: str = "open",
        high: str = "high",
        low: str = "low",
        close: str = "close",
        volume: str = "volume",
        time_unit: str = "s",
    ) -> "PyneData":
        _require_pandas()
        rows = []
        for item in df.to_dict(orient="records"):
            rows.append({
                "time": item[time],
                "open": item[open],
                "high": item[high],
                "low": item[low],
                "close": item[close],
                "volume": item[volume],
            })
        return cls.from_ohlcv(rows, time_unit=time_unit)

    def to_ohlcv(self) -> list[dict[str, Any]]:
        return [dict(item) for item in self._ohlcv]

    def to_pandas(self) -> Any:
        pd = _require_pandas()
        return pd.DataFrame(self.to_ohlcv())

    def __len__(self) -> int:
        return len(self._ohlcv)

    def __iter__(self):
        return iter(self.to_ohlcv())

    def __repr__(self) -> str:
        first = self._ohlcv[0]["time"] if self._ohlcv else None
        last = self._ohlcv[-1]["time"] if self._ohlcv else None
        return f"PyneData(rows={len(self)}, start={first}, end={last})"


def coerce_ohlcv(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, PyneData):
        return data.to_ohlcv()
    if hasattr(data, "to_dict") and data.__class__.__module__.startswith("pandas"):
        return PyneData.from_pandas(data).to_ohlcv()
    if isinstance(data, (str, Path)):
        return PyneData.from_csv(data).to_ohlcv()
    return PyneData.from_ohlcv(data).to_ohlcv()


def _normalize_bar(item: dict[str, Any], *, time_unit: str) -> dict[str, Any]:
    missing = [key for key in DEFAULT_COLUMNS if key not in item]
    if missing:
        raise ValueError(f"OHLCV bar is missing required fields: {', '.join(missing)}")
    timestamp = int(float(item["time"]))
    if time_unit.lower() in {"ms", "millisecond", "milliseconds"}:
        timestamp //= 1000
    return {
        "time": timestamp,
        "open": float(item["open"]),
        "high": float(item["high"]),
        "low": float(item["low"]),
        "close": float(item["close"]),
        "volume": float(item["volume"]),
    }


def _require_pandas() -> Any:
    try:
        import pandas as pd
    except ImportError as exc:  # pragma: no cover - depends on optional env
        raise ImportError(
            "Pandas support requires the optional dependency: "
            "pip install pyne-runtime[pandas]"
        ) from exc
    return pd

