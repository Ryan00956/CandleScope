"""Pine-like ticker id helper namespace."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, urlencode

from .metadata import SymbolInfo


@dataclass(frozen=True)
class _TickerParts:
    base: str
    params: dict[str, str]


class TickerNamespace:
    """Pine-like ``ticker.*`` namespace."""

    session_regular = "regular"
    session_extended = "extended"
    adjustment_none = "none"
    adjustment_splits = "splits"
    adjustment_dividends = "dividends"

    def __init__(self, syminfo: SymbolInfo | None = None) -> None:
        self._syminfo = syminfo or SymbolInfo()

    def new(
        self,
        prefix: str | None = None,
        ticker: str | None = None,
        session: str | None = None,
        adjustment: str | None = None,
    ) -> str:
        """Build a ticker id from exchange prefix, symbol, and optional modifiers."""
        resolved_prefix = _clean(prefix if prefix is not None else self._syminfo.prefix)
        resolved_ticker = _clean(ticker if ticker is not None else self._syminfo.ticker)
        if not resolved_ticker and self._syminfo.tickerid:
            parts = _parse_tickerid(self._syminfo.tickerid)
            base_prefix, base_ticker = _split_base(parts.base)
            resolved_prefix = resolved_prefix or base_prefix
            resolved_ticker = base_ticker
        base = _join_base(resolved_prefix, resolved_ticker)
        return _format_tickerid(base, _modifier_params(session=session, adjustment=adjustment))

    def inherit(
        self,
        ticker: str | None = None,
        session: str | None = None,
        adjustment: str | None = None,
    ) -> str:
        """Build a ticker id using the current symbol prefix by default."""
        return self.new(self._syminfo.prefix, ticker or self._syminfo.ticker, session, adjustment)

    def modify(
        self,
        tickerid: str,
        session: str | None = None,
        adjustment: str | None = None,
    ) -> str:
        """Return ``tickerid`` with updated session/adjustment modifiers."""
        parts = _parse_tickerid(tickerid)
        params = dict(parts.params)
        params.update(_modifier_params(session=session, adjustment=adjustment))
        return _format_tickerid(parts.base, params)

    def standard(self, tickerid: str | None = None) -> str:
        """Return the unmodified base ticker id."""
        raw = tickerid or self._syminfo.tickerid or self.new()
        return _parse_tickerid(raw).base

    def heikinashi(self, tickerid: str | None = None) -> str:
        return self._chart_ticker(tickerid, "heikinashi")

    def renko(
        self,
        tickerid: str | None = None,
        style: str | None = None,
        param: int | float | None = None,
    ) -> str:
        params: dict[str, str] = {"chart": "renko"}
        if style is not None:
            params["style"] = str(style)
        if param is not None:
            params["param"] = _number_text(param)
        return self._with_params(tickerid, params)

    def linebreak(self, tickerid: str | None = None, lines: int | None = None) -> str:
        params = {"chart": "linebreak"}
        if lines is not None:
            params["lines"] = str(int(lines))
        return self._with_params(tickerid, params)

    def kagi(
        self,
        tickerid: str | None = None,
        reversal: int | float | None = None,
    ) -> str:
        params = {"chart": "kagi"}
        if reversal is not None:
            params["reversal"] = _number_text(reversal)
        return self._with_params(tickerid, params)

    def pointfigure(
        self,
        tickerid: str | None = None,
        style: str | None = None,
        param: int | float | None = None,
        reversal: int | float | None = None,
    ) -> str:
        params = {"chart": "pointfigure"}
        if style is not None:
            params["style"] = str(style)
        if param is not None:
            params["param"] = _number_text(param)
        if reversal is not None:
            params["reversal"] = _number_text(reversal)
        return self._with_params(tickerid, params)

    def _chart_ticker(self, tickerid: str | None, chart: str) -> str:
        return self._with_params(tickerid, {"chart": chart})

    def _with_params(self, tickerid: str | None, updates: dict[str, str]) -> str:
        raw = tickerid or self._syminfo.tickerid or self.new()
        parts = _parse_tickerid(raw)
        params = dict(parts.params)
        params.update(updates)
        return _format_tickerid(parts.base, params)


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _parse_tickerid(tickerid: str) -> _TickerParts:
    raw = _clean(tickerid)
    if "?" not in raw:
        return _TickerParts(base=raw, params={})
    base, query = raw.split("?", 1)
    return _TickerParts(base=base, params={key: value for key, value in parse_qsl(query)})


def _split_base(base: str) -> tuple[str, str]:
    if ":" not in base:
        return "", base
    prefix, ticker = base.split(":", 1)
    return prefix, ticker


def _join_base(prefix: str, ticker: str) -> str:
    if prefix and ticker:
        return f"{prefix}:{ticker}"
    return ticker or prefix


def _modifier_params(
    *,
    session: str | None = None,
    adjustment: str | None = None,
) -> dict[str, str]:
    params: dict[str, str] = {}
    if session is not None:
        params["session"] = str(session)
    if adjustment is not None:
        params["adjustment"] = str(adjustment)
    return params


def _format_tickerid(base: str, params: dict[str, str]) -> str:
    cleaned = {key: value for key, value in params.items() if value not in {"", None}}
    if not cleaned:
        return base
    return f"{base}?{urlencode(cleaned)}"


def _number_text(value: int | float) -> str:
    number = float(value)
    return str(int(number)) if number.is_integer() else str(number)
