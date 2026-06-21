"""
Pyne Context — runtime data context holding OHLCV arrays and derived fields.

The context is created once per script execution from the raw OHLCV data.
It provides numpy arrays for all standard fields (open, high, low, close,
volume, time) plus derived fields (hl2, hlc3, ohlc4, hlcc4).

These series are injected into the script's global namespace so users
can write ``ta.sma(close, 20)`` directly.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .barstate import PyneBarState
from .data import PyneData
from .metadata import SessionNamespace, SymbolInfo, TimeframeInfo
from .metadata import build_session_namespace, normalize_symbol_info, normalize_timeframe_info
from .series import PyneSeries


@dataclass
class PyneContext:
    """Holds all OHLCV data arrays for a single script execution.

    Attributes:
        open:    Open prices (numpy float64 array)
        high:    High prices
        low:     Low prices
        close:   Close prices
        volume:  Volume values
        time:    Timestamps as a Pine-like series
        time_close: Bar close timestamps as a Pine-like series
        times:   Raw timestamp list used for output serialization
        bar_count: Number of bars
    """
    open: PyneSeries
    high: PyneSeries
    low: PyneSeries
    close: PyneSeries
    volume: PyneSeries
    time: PyneSeries
    time_close: PyneSeries
    times: list[int]
    syminfo: SymbolInfo = field(default_factory=SymbolInfo)
    timeframe: TimeframeInfo = field(default_factory=TimeframeInfo)
    session: SessionNamespace = field(default_factory=lambda: build_session_namespace([]))
    bar_count: int = 0

    # ── Derived fields (lazy-computed) ───────────────────────
    _hl2: PyneSeries | None = field(default=None, repr=False)
    _hlc3: PyneSeries | None = field(default=None, repr=False)
    _ohlc4: PyneSeries | None = field(default=None, repr=False)
    _hlcc4: PyneSeries | None = field(default=None, repr=False)
    _bar_index: PyneSeries | None = field(default=None, repr=False)
    _last_bar_index: PyneSeries | None = field(default=None, repr=False)
    _barstate: PyneBarState | None = field(default=None, repr=False)

    @classmethod
    def from_ohlcv(
        cls,
        ohlcv: list[dict[str, Any]],
        *,
        syminfo: Any = None,
        timeframe: Any = None,
        session: Any = None,
        allow_empty: bool = False,
        require_unique_times: bool = True,
    ) -> PyneContext:
        """Create context from a list of OHLCV dicts.

        Each dict must have: time, open, high, low, close, volume.
        """
        ohlcv = PyneData.from_ohlcv(
            ohlcv,
            allow_empty=allow_empty,
            require_unique_times=require_unique_times,
        ).to_ohlcv()
        timeframe_info = normalize_timeframe_info(timeframe)
        times = [int(d.get("time", 0)) for d in ohlcv]
        opens = np.array([float(d.get("open", 0)) for d in ohlcv], dtype=np.float64)
        highs = np.array([float(d.get("high", 0)) for d in ohlcv], dtype=np.float64)
        lows = np.array([float(d.get("low", 0)) for d in ohlcv], dtype=np.float64)
        closes = np.array([float(d.get("close", 0)) for d in ohlcv], dtype=np.float64)
        volumes = np.array([float(d.get("volume", 0)) for d in ohlcv], dtype=np.float64)
        time_closes = np.array(_derive_time_close(ohlcv, times, timeframe_info), dtype=np.float64)

        return cls(
            open=PyneSeries(opens, name="open"),
            high=PyneSeries(highs, name="high"),
            low=PyneSeries(lows, name="low"),
            close=PyneSeries(closes, name="close"),
            volume=PyneSeries(volumes, name="volume"),
            time=PyneSeries(np.array(times, dtype=np.float64), name="time"),
            time_close=PyneSeries(time_closes, name="time_close"),
            times=times,
            syminfo=normalize_symbol_info(syminfo),
            timeframe=timeframe_info,
            session=build_session_namespace(ohlcv, session),
            bar_count=len(ohlcv),
        )

    @property
    def hl2(self) -> PyneSeries:
        """(high + low) / 2"""
        if self._hl2 is None:
            self._hl2 = PyneSeries(((self.high + self.low) / 2).values, name="hl2")
        return self._hl2

    @property
    def hlc3(self) -> PyneSeries:
        """(high + low + close) / 3"""
        if self._hlc3 is None:
            self._hlc3 = PyneSeries(((self.high + self.low + self.close) / 3).values, name="hlc3")
        return self._hlc3

    @property
    def ohlc4(self) -> PyneSeries:
        """(open + high + low + close) / 4"""
        if self._ohlc4 is None:
            self._ohlc4 = PyneSeries(
                ((self.open + self.high + self.low + self.close) / 4).values,
                name="ohlc4",
            )
        return self._ohlc4

    @property
    def hlcc4(self) -> PyneSeries:
        """(high + low + close + close) / 4"""
        if self._hlcc4 is None:
            self._hlcc4 = PyneSeries(
                ((self.high + self.low + self.close + self.close) / 4).values,
                name="hlcc4",
            )
        return self._hlcc4

    @property
    def bar_index(self) -> PyneSeries:
        """Zero-based bar index series."""
        if self._bar_index is None:
            self._bar_index = PyneSeries(
                np.arange(self.bar_count, dtype=np.float64),
                name="bar_index",
            )
        return self._bar_index

    @property
    def last_bar_index(self) -> PyneSeries:
        """Series containing the last available bar index."""
        if self._last_bar_index is None:
            last = max(self.bar_count - 1, 0)
            self._last_bar_index = PyneSeries(
                np.full(self.bar_count, float(last), dtype=np.float64),
                name="last_bar_index",
            )
        return self._last_bar_index

    @property
    def barstate(self) -> PyneBarState:
        """Pine-like barstate flags for batch execution."""
        if self._barstate is None:
            self._barstate = PyneBarState.for_batch(self.bar_count)
        return self._barstate

    def resolve_source(self, source_name: str) -> PyneSeries:
        """Resolve a source name string to its numpy array.

        Args:
            source_name: One of "open", "high", "low", "close", "volume",
                         "hl2", "hlc3", "ohlc4", "hlcc4".

        Returns:
            The corresponding numpy array.

        Raises:
            ValueError: If the source name is unknown.
        """
        mapping = {
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "time": self.time,
            "time_close": self.time_close,
            "hl2": self.hl2,
            "hlc3": self.hlc3,
            "ohlc4": self.ohlc4,
            "hlcc4": self.hlcc4,
        }
        if source_name not in mapping:
            raise ValueError(
                f"Unknown source '{source_name}'. "
                f"Available: {list(mapping.keys())}"
            )
        return mapping[source_name]


def _derive_time_close(
    ohlcv: list[dict[str, Any]],
    times: list[int],
    timeframe: TimeframeInfo,
) -> list[float]:
    values: list[float] = []
    duration = _timeframe_seconds(timeframe)
    for index, item in enumerate(ohlcv):
        explicit = item.get("time_close")
        if explicit is not None:
            values.append(float(explicit))
        elif index + 1 < len(times):
            values.append(float(times[index + 1]))
        elif duration is not None:
            values.append(float(times[index] + duration))
        else:
            values.append(float("nan"))
    return values


def _timeframe_seconds(timeframe: TimeframeInfo) -> int | None:
    period = timeframe.period.strip()
    if not period:
        return None
    suffix = period[-1]
    if suffix.isdigit():
        return timeframe.multiplier * 60
    if suffix in {"s", "S"}:
        return timeframe.multiplier
    if suffix == "m":
        return timeframe.multiplier * 60
    if suffix in {"h", "H"}:
        return timeframe.multiplier * 60
    if suffix in {"d", "D"}:
        return timeframe.multiplier * 86_400
    if suffix in {"w", "W"}:
        return timeframe.multiplier * 7 * 86_400
    if suffix == "M":
        return timeframe.multiplier * 30 * 86_400
    return None
