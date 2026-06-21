"""Incremental bar model and bar metadata helpers."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..metadata import SessionInfo, normalize_session_info


@dataclass
class IncrementalBar:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    is_confirmed: bool = True
    bar_index: int = -1
    last_bar_index: int = -1
    is_first: bool = False
    is_last: bool = False
    is_history: bool = False
    is_realtime: bool = False
    is_new: bool = False
    is_last_confirmed_history: bool = False
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, item: dict[str, Any], *, is_confirmed: bool = True) -> "IncrementalBar":
        return cls(
            time=int(item.get("time", 0)),
            open=float(item.get("open", 0)),
            high=float(item.get("high", 0)),
            low=float(item.get("low", 0)),
            close=float(item.get("close", 0)),
            volume=float(item.get("volume", 0)),
            is_confirmed=is_confirmed,
            raw=dict(item),
        )

def _session_info_for_bar(bar: IncrementalBar, default: SessionInfo) -> SessionInfo:
    raw = dict(bar.raw or {})
    nested = raw.get("session")
    if isinstance(nested, dict):
        raw.update(nested)
    return normalize_session_info({
        "ismarket": _first_present(
            raw,
            ("session_ismarket", "ismarket", "is_market"),
            default.ismarket,
        ),
        "isfirstbar": _first_present(
            raw,
            ("session_isfirstbar", "isfirstbar", "is_firstbar", "session_is_first_bar"),
            default.isfirstbar or bar.is_first,
        ),
        "islastbar": _first_present(
            raw,
            ("session_islastbar", "islastbar", "is_lastbar", "session_is_last_bar"),
            default.islastbar or bar.is_last,
        ),
    })

def _first_present(raw: dict[str, Any], names: tuple[str, ...], default: bool) -> bool:
    for name in names:
        if name in raw:
            return bool(raw[name])
    return bool(default)
