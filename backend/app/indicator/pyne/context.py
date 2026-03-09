"""
Pyne Context — runtime data context holding OHLCV arrays and derived fields.

The context is created once per script execution from the raw OHLCV data.
It provides numpy arrays for all standard fields (open, high, low, close,
volume, time) plus derived fields (hl2, hlc3, ohlc4, hlcc4).

These arrays are injected into the script's global namespace so users
can write ``ta.sma(close, 20)`` directly.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np


@dataclass
class PyneContext:
    """Holds all OHLCV data arrays for a single script execution.

    Attributes:
        open:    Open prices (numpy float64 array)
        high:    High prices
        low:     Low prices
        close:   Close prices
        volume:  Volume values
        time:    Timestamps (list of int, Unix seconds)
        bar_count: Number of bars
    """
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    volume: np.ndarray
    time: list[int]
    bar_count: int = 0

    # ── Derived fields (lazy-computed) ───────────────────────
    _hl2: np.ndarray | None = field(default=None, repr=False)
    _hlc3: np.ndarray | None = field(default=None, repr=False)
    _ohlc4: np.ndarray | None = field(default=None, repr=False)
    _hlcc4: np.ndarray | None = field(default=None, repr=False)

    @classmethod
    def from_ohlcv(cls, ohlcv: list[dict[str, Any]]) -> PyneContext:
        """Create context from a list of OHLCV dicts.

        Each dict must have: time, open, high, low, close, volume.
        """
        times = [int(d.get("time", 0)) for d in ohlcv]
        opens = np.array([float(d.get("open", 0)) for d in ohlcv], dtype=np.float64)
        highs = np.array([float(d.get("high", 0)) for d in ohlcv], dtype=np.float64)
        lows = np.array([float(d.get("low", 0)) for d in ohlcv], dtype=np.float64)
        closes = np.array([float(d.get("close", 0)) for d in ohlcv], dtype=np.float64)
        volumes = np.array([float(d.get("volume", 0)) for d in ohlcv], dtype=np.float64)

        return cls(
            open=opens,
            high=highs,
            low=lows,
            close=closes,
            volume=volumes,
            time=times,
            bar_count=len(ohlcv),
        )

    @property
    def hl2(self) -> np.ndarray:
        """(high + low) / 2"""
        if self._hl2 is None:
            self._hl2 = (self.high + self.low) / 2
        return self._hl2

    @property
    def hlc3(self) -> np.ndarray:
        """(high + low + close) / 3"""
        if self._hlc3 is None:
            self._hlc3 = (self.high + self.low + self.close) / 3
        return self._hlc3

    @property
    def ohlc4(self) -> np.ndarray:
        """(open + high + low + close) / 4"""
        if self._ohlc4 is None:
            self._ohlc4 = (self.open + self.high + self.low + self.close) / 4
        return self._ohlc4

    @property
    def hlcc4(self) -> np.ndarray:
        """(high + low + close + close) / 4"""
        if self._hlcc4 is None:
            self._hlcc4 = (self.high + self.low + self.close + self.close) / 4
        return self._hlcc4

    def resolve_source(self, source_name: str) -> np.ndarray:
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
