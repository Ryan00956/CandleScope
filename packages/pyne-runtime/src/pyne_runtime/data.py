"""OHLCV data helpers for Pyne."""
from __future__ import annotations

import csv
from collections.abc import Iterable, Iterator
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

SESSION_COLUMNS = {
    "session",
    "session_ismarket",
    "ismarket",
    "is_market",
    "session_isfirstbar",
    "isfirstbar",
    "is_firstbar",
    "session_is_first_bar",
    "session_islastbar",
    "islastbar",
    "is_lastbar",
    "session_is_last_bar",
}
OPTIONAL_COLUMNS = {"time_close", *SESSION_COLUMNS}


@dataclass(frozen=True)
class PyneData:
    """Small OHLCV container used by the friendly API."""

    _ohlcv: tuple[dict[str, Any], ...]

    @classmethod
    def from_ohlcv(
        cls,
        items: Iterable[dict[str, Any]],
        *,
        time_unit: str = "s",
        allow_empty: bool = False,
        require_unique_times: bool = True,
    ) -> "PyneData":
        bars = tuple(_normalize_bar(item, time_unit=time_unit) for item in items)
        if not bars and not allow_empty:
            raise ValueError("PyneData requires at least one OHLCV bar")
        _validate_bars(bars, require_unique_times=require_unique_times)
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
        time_close: str | None = None,
        time_unit: str = "s",
    ) -> "PyneData":
        _require_pandas()
        rows = []
        for item in df.to_dict(orient="records"):
            row = {
                "time": item[time],
                "open": item[open],
                "high": item[high],
                "low": item[low],
                "close": item[close],
                "volume": item[volume],
            }
            if time_close is not None:
                row["time_close"] = item[time_close]
            rows.append(row)
        return cls.from_ohlcv(rows, time_unit=time_unit)

    def to_ohlcv(self) -> list[dict[str, Any]]:
        return [dict(item) for item in self._ohlcv]

    def to_pandas(self) -> Any:
        pd = _require_pandas()
        return pd.DataFrame(self.to_ohlcv())

    @property
    def columns(self) -> tuple[str, ...]:
        extras = tuple(key for key in sorted(OPTIONAL_COLUMNS) if any(key in item for item in self._ohlcv))
        return (*DEFAULT_COLUMNS, *extras)

    @property
    def first(self) -> dict[str, Any]:
        return dict(self._ohlcv[0])

    @property
    def last(self) -> dict[str, Any]:
        return dict(self._ohlcv[-1])

    @property
    def time_range(self) -> tuple[int, int]:
        return int(self._ohlcv[0]["time"]), int(self._ohlcv[-1]["time"])

    def column(self, name: str) -> list[Any]:
        if name not in DEFAULT_COLUMNS and name not in OPTIONAL_COLUMNS:
            raise KeyError(f"Unknown OHLCV column: {name}")
        if name in OPTIONAL_COLUMNS and not any(name in item for item in self._ohlcv):
            raise KeyError(f"Unknown OHLCV column: {name}")
        return [item.get(name) for item in self._ohlcv]

    def head(self, n: int = 5) -> list[dict[str, Any]]:
        return [dict(item) for item in self._ohlcv[:max(n, 0)]]

    def tail(self, n: int = 5) -> list[dict[str, Any]]:
        if n <= 0:
            return []
        return [dict(item) for item in self._ohlcv[-n:]]

    def __len__(self) -> int:
        return len(self._ohlcv)

    def __iter__(self) -> Iterator[dict[str, Any]]:
        return iter(self.to_ohlcv())

    def __getitem__(self, key: str | int | slice) -> Any:
        if isinstance(key, str):
            return self.column(key)
        if isinstance(key, int):
            return dict(self._ohlcv[key])
        if isinstance(key, slice):
            return [dict(item) for item in self._ohlcv[key]]
        raise TypeError("PyneData indices must be a column name, integer, or slice")

    def __repr__(self) -> str:
        first = self._ohlcv[0]["time"] if self._ohlcv else None
        last = self._ohlcv[-1]["time"] if self._ohlcv else None
        return f"PyneData(rows={len(self)}, start={first}, end={last})"


def coerce_ohlcv(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, PyneData):
        return data.to_ohlcv()
    if _is_pandas_dataframe(data):
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
    normalized = {
        "time": timestamp,
        "open": float(item["open"]),
        "high": float(item["high"]),
        "low": float(item["low"]),
        "close": float(item["close"]),
        "volume": float(item["volume"]),
    }
    if "time_close" in item and item["time_close"] is not None:
        time_close = int(float(item["time_close"]))
        if time_unit.lower() in {"ms", "millisecond", "milliseconds"}:
            time_close //= 1000
        normalized["time_close"] = time_close
    for key in SESSION_COLUMNS:
        if key in item and item[key] is not None:
            normalized[key] = _normalize_session_value(item[key])
    return normalized


def _validate_bars(
    bars: tuple[dict[str, Any], ...],
    *,
    require_unique_times: bool,
) -> None:
    previous_time: int | None = None
    seen_times: set[int] = set()
    for index, bar in enumerate(bars):
        timestamp = int(bar["time"])
        if require_unique_times:
            if timestamp in seen_times:
                raise ValueError(f"OHLCV time values must be unique; duplicate at row {index}")
            if previous_time is not None and timestamp <= previous_time:
                raise ValueError("OHLCV time values must be strictly increasing")
            seen_times.add(timestamp)
            previous_time = timestamp

        open_value = float(bar["open"])
        high_value = float(bar["high"])
        low_value = float(bar["low"])
        close_value = float(bar["close"])
        volume_value = float(bar["volume"])
        if high_value < low_value:
            raise ValueError(f"OHLCV high must be greater than or equal to low at row {index}")
        if high_value < max(open_value, close_value):
            raise ValueError(f"OHLCV high must cover open and close at row {index}")
        if low_value > min(open_value, close_value):
            raise ValueError(f"OHLCV low must cover open and close at row {index}")
        if volume_value < 0:
            raise ValueError(f"OHLCV volume must be non-negative at row {index}")


def _normalize_session_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _normalize_session_value(item) for key, item in value.items()}
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "y", "on"}:
            return True
        if normalized in {"false", "0", "no", "n", "off"}:
            return False
    return value


def _require_pandas() -> Any:
    try:
        import pandas as pd
    except ImportError as exc:  # pragma: no cover - depends on optional env
        raise ImportError(
            "Pandas support requires the optional dependency: "
            "pip install pyne-runtime[pandas]"
        ) from exc
    return pd


def _is_pandas_dataframe(value: Any) -> bool:
    try:
        import pandas as pd
    except ImportError:  # pragma: no cover - depends on optional env
        return False
    return isinstance(value, pd.DataFrame)
