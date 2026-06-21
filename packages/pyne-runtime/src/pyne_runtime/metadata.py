"""Pine-like runtime metadata namespaces."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Mapping

import numpy as np

from .series import PyneSeries


@dataclass(frozen=True)
class SymbolInfo:
    """Symbol metadata exposed as the Pine-like ``syminfo`` namespace."""

    ticker: str = ""
    tickerid: str = ""
    prefix: str = ""
    currency: str = ""
    basecurrency: str = ""
    mintick: float = 1.0
    pointvalue: float = 1.0
    type: str = ""

    @classmethod
    def from_value(cls, value: Any = None) -> "SymbolInfo":
        if isinstance(value, SymbolInfo):
            return value
        if value is None:
            return cls()
        if isinstance(value, str):
            return _symbol_from_mapping({"tickerid": value})
        if isinstance(value, Mapping):
            return _symbol_from_mapping(value)
        return cls()


@dataclass(frozen=True)
class TimeframeInfo:
    """Chart timeframe metadata exposed as ``timeframe``."""

    period: str = "1"
    multiplier: int = 1
    isintraday: bool = True
    isdaily: bool = False
    isweekly: bool = False
    ismonthly: bool = False

    @classmethod
    def from_value(cls, value: Any = None) -> "TimeframeInfo":
        if isinstance(value, TimeframeInfo):
            return value
        if value is None:
            return cls()
        if isinstance(value, Mapping):
            period = str(value.get("period") or value.get("timeframe") or "1").strip() or "1"
            parsed = _parse_timeframe(period)
            multiplier = value.get("multiplier")
            if multiplier is not None:
                try:
                    parsed = cls(
                        period=parsed.period,
                        multiplier=max(int(multiplier), 1),
                        isintraday=parsed.isintraday,
                        isdaily=parsed.isdaily,
                        isweekly=parsed.isweekly,
                        ismonthly=parsed.ismonthly,
                    )
                except (TypeError, ValueError):
                    pass
            return parsed
        return _parse_timeframe(str(value).strip() or "1")


@dataclass(frozen=True)
class SessionInfo:
    """Lightweight session metadata exposed as ``session``."""

    ismarket: bool = True
    isfirstbar: bool = False
    islastbar: bool = False

    @classmethod
    def from_value(cls, value: Any = None) -> "SessionInfo":
        if isinstance(value, SessionInfo):
            return value
        if value is None:
            return cls()
        if isinstance(value, bool):
            return cls(ismarket=value)
        if isinstance(value, Mapping):
            return cls(
                ismarket=bool(value.get("ismarket", True)),
                isfirstbar=bool(value.get("isfirstbar", False)),
                islastbar=bool(value.get("islastbar", False)),
            )
        return cls()


@dataclass(frozen=True)
class SessionNamespace:
    """Bar-level Pine-like ``session`` namespace exposed to batch scripts."""

    ismarket: PyneSeries
    isfirstbar: PyneSeries
    islastbar: PyneSeries


def normalize_symbol_info(value: Any = None) -> SymbolInfo:
    return SymbolInfo.from_value(value)


def normalize_timeframe_info(value: Any = None) -> TimeframeInfo:
    return TimeframeInfo.from_value(value)


def normalize_session_info(value: Any = None) -> SessionInfo:
    return SessionInfo.from_value(value)


def build_session_namespace(
    ohlcv: list[dict[str, Any]],
    session: Any = None,
) -> SessionNamespace:
    info = normalize_session_info(session)
    bar_count = len(ohlcv)
    market_values = _session_flag_values(
        ohlcv,
        names=("session_ismarket", "ismarket", "is_market"),
        default=info.ismarket,
    )
    first_values = _session_flag_values(
        ohlcv,
        names=("session_isfirstbar", "isfirstbar", "is_firstbar", "session_is_first_bar"),
        default=info.isfirstbar,
    )
    first_explicit = _has_session_flag(
        ohlcv,
        names=("session_isfirstbar", "isfirstbar", "is_firstbar", "session_is_first_bar"),
    )
    last_values = _session_flag_values(
        ohlcv,
        names=("session_islastbar", "islastbar", "is_lastbar", "session_is_last_bar"),
        default=info.islastbar,
    )
    last_explicit = _has_session_flag(
        ohlcv,
        names=("session_islastbar", "islastbar", "is_lastbar", "session_is_last_bar"),
    )

    if not first_explicit and not any(first_values) and bar_count:
        first_values[0] = True
    if not last_explicit and not any(last_values) and bar_count:
        last_values[-1] = True

    return SessionNamespace(
        ismarket=PyneSeries(np.array(market_values, dtype=bool), name="session.ismarket"),
        isfirstbar=PyneSeries(np.array(first_values, dtype=bool), name="session.isfirstbar"),
        islastbar=PyneSeries(np.array(last_values, dtype=bool), name="session.islastbar"),
    )


def _symbol_from_mapping(value: Mapping[str, Any]) -> SymbolInfo:
    tickerid = str(value.get("tickerid") or value.get("symbol") or "").strip()
    ticker = str(value.get("ticker") or "").strip()
    prefix = str(value.get("prefix") or "").strip()

    if tickerid and ":" in tickerid:
        inferred_prefix, inferred_ticker = tickerid.split(":", 1)
        prefix = prefix or inferred_prefix
        ticker = ticker or inferred_ticker
    elif tickerid:
        ticker = ticker or tickerid
    elif ticker:
        tickerid = ticker

    return SymbolInfo(
        ticker=ticker,
        tickerid=tickerid,
        prefix=prefix,
        currency=str(value.get("currency") or "").strip(),
        basecurrency=str(value.get("basecurrency") or value.get("base_currency") or "").strip(),
        mintick=_positive_float(value.get("mintick", value.get("min_tick", 1.0)), 1.0),
        pointvalue=_positive_float(value.get("pointvalue", value.get("point_value", 1.0)), 1.0),
        type=str(value.get("type") or "").strip(),
    )


def _positive_float(value: Any, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number <= 0:
        return default
    return number


def _session_flag_values(
    ohlcv: list[dict[str, Any]],
    *,
    names: tuple[str, ...],
    default: bool,
) -> list[bool]:
    values: list[bool] = []
    for item in ohlcv:
        flag_value = _lookup_session_flag(item, names)
        values.append(default if flag_value is None else bool(flag_value))
    return values


def _lookup_session_flag(item: Mapping[str, Any], names: tuple[str, ...]) -> Any:
    nested = item.get("session")
    if isinstance(nested, Mapping):
        for name in names:
            if name in nested:
                return nested[name]
    for name in names:
        if name in item:
            return item[name]
    return None


def _has_session_flag(ohlcv: list[dict[str, Any]], *, names: tuple[str, ...]) -> bool:
    return any(_lookup_session_flag(item, names) is not None for item in ohlcv)


def _parse_timeframe(period: str) -> TimeframeInfo:
    raw = period.strip() or "1"
    match = re.fullmatch(r"(\d+)?([A-Za-z]?)", raw)
    if match is None:
        return TimeframeInfo(period=raw, multiplier=1)

    number_text, suffix = match.groups()
    amount = int(number_text) if number_text else 1
    amount = max(amount, 1)

    if not suffix:
        return TimeframeInfo(period=raw, multiplier=amount, isintraday=True)

    if suffix in {"s", "S", "m"}:
        return TimeframeInfo(period=raw, multiplier=amount, isintraday=True)
    if suffix in {"h", "H"}:
        return TimeframeInfo(period=raw, multiplier=amount * 60, isintraday=True)
    if suffix in {"d", "D"}:
        return TimeframeInfo(
            period=raw,
            multiplier=amount,
            isintraday=False,
            isdaily=True,
        )
    if suffix in {"w", "W"}:
        return TimeframeInfo(
            period=raw,
            multiplier=amount,
            isintraday=False,
            isweekly=True,
        )
    if suffix == "M":
        return TimeframeInfo(
            period=raw,
            multiplier=amount,
            isintraday=False,
            ismonthly=True,
        )
    return TimeframeInfo(period=raw, multiplier=amount)
