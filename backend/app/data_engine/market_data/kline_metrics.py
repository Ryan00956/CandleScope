"""Capability-gated helpers for enhanced Kline fields and derived metrics."""
from __future__ import annotations

import math
from functools import lru_cache
from typing import Any, Collection, Mapping


KLINE_ENHANCED_FIELDS: tuple[str, ...] = (
    "quote_volume",
    "trades",
    "taker_buy_base",
    "taker_buy_quote",
)

KLINE_DERIVED_FIELDS: tuple[str, ...] = (
    "taker_sell_base",
    "volume_delta_base",
    "taker_buy_ratio_base",
    "cvd_contribution_base",
)


@lru_cache(maxsize=128)
def kline_available_fields(exchange: str, market_type: str) -> frozenset[str]:
    """Return authoritative schema-v2 normalized Kline fields.

    Legacy or malformed capability documents fail closed so placeholder values
    cannot silently become user-visible market data.
    """

    try:
        from app.data_engine.market_data.models import MarketChannel
        from app.exchanges import bootstrap_default_adapters

        capabilities = bootstrap_default_adapters().get_capabilities(exchange)
        if getattr(capabilities, "capability_schema_version", 1) != 2:
            return frozenset()
        normalized_market = str(market_type or "").strip().lower()
        channel = capabilities.channel_capability(MarketChannel.KLINE, normalized_market)
        if channel is None and normalized_market in {"swap", "perpetual", "perp"}:
            channel = capabilities.channel_capability(MarketChannel.KLINE, "futures")
        if channel is None:
            return frozenset()
        return frozenset(channel.available_fields)
    except (AttributeError, KeyError, TypeError, ValueError):
        return frozenset()


def declared_enhanced_fields(
    exchange: str,
    market_type: str,
    values: Mapping[str, Any],
    *,
    explicit_fields: Collection[str] | None = None,
) -> frozenset[str]:
    """Resolve enhanced fields that are both declared and present.

    ``explicit_fields`` is used by internal custom-interval aggregation, where
    the source ``BarData`` has already been capability-gated.  Otherwise the
    exchange capability document is authoritative.
    """

    declared = (
        frozenset(explicit_fields)
        if explicit_fields is not None
        else kline_available_fields(exchange, market_type)
    )
    if not declared:
        return frozenset()
    validated = serialize_kline_enhancements(
        volume=values.get("volume"),
        quote_volume=values.get("quote_volume"),
        trades=values.get("trades"),
        taker_buy_base=values.get("taker_buy_base"),
        taker_buy_quote=values.get("taker_buy_quote"),
    )
    return frozenset(
        field
        for field in KLINE_ENHANCED_FIELDS
        if field in declared and validated[field] is not None
    )


def serialize_kline_enhancements(
    *,
    volume: Any,
    quote_volume: Any,
    trades: Any,
    taker_buy_base: Any,
    taker_buy_quote: Any,
) -> dict[str, Any]:
    """Build JSON-safe raw and derived Kline order-flow fields.

    The result is a Kline-level taker-volume proxy.  A CVD series is the prefix
    sum of ``cvd_contribution_*`` over a contiguous ordered range; forming-bar
    updates replace the current bucket contribution rather than adding it.
    """

    safe_volume = _finite_nonnegative(volume)
    safe_quote_volume = _finite_nonnegative(quote_volume)
    safe_trades = _nonnegative_int(trades)
    base_pair = _derive_pair(safe_volume, taker_buy_base)
    quote_pair = _derive_pair(safe_quote_volume, taker_buy_quote)

    # A positive base volume cannot have zero quote turnover.  This pattern is
    # also how older trade-mode states were persisted with synthetic zeros, so
    # suppress the whole enhanced bundle instead of presenting "all sells".
    if safe_volume is not None and safe_volume > 0 and safe_quote_volume == 0:
        safe_quote_volume = None
        safe_trades = None
        base_pair = None
        quote_pair = None

    safe_taker_buy_base = base_pair[0] if base_pair is not None else None
    safe_taker_buy_quote = quote_pair[0] if quote_pair is not None else None
    base_metrics = _pair_metrics(base_pair)
    order_flow = None
    if base_pair is not None:
        order_flow = {
            "taker_sell_base": base_metrics["sell"],
            "volume_delta_base": base_metrics["delta"],
            "taker_buy_ratio_base": base_metrics["ratio"],
            "cvd_contribution_base": base_metrics["delta"],
        }

    return {
        "quote_volume": _round_optional(safe_quote_volume),
        "trades": safe_trades,
        "taker_buy_base": _round_optional(safe_taker_buy_base),
        "taker_buy_quote": _round_optional(safe_taker_buy_quote),
        "order_flow": order_flow,
    }


def _finite_nonnegative(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(number) or number < 0:
        return None
    return number


def _nonnegative_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
        integer = int(number)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(number) or number < 0 or number != integer:
        return None
    return integer


def _derive_pair(total: Any, buy: Any) -> tuple[float, float] | None:
    safe_total = _finite_nonnegative(total)
    safe_buy = _finite_nonnegative(buy)
    if safe_total is None or safe_buy is None:
        return None

    tolerance = max(1e-10, safe_total * 1e-10)
    if safe_buy > safe_total + tolerance:
        return None
    safe_buy = min(safe_buy, safe_total)
    return safe_buy, max(safe_total - safe_buy, 0.0)


def _pair_metrics(pair: tuple[float, float] | None) -> dict[str, float | None]:
    if pair is None:
        return {"sell": None, "delta": None, "ratio": None}
    buy, sell = pair
    total = buy + sell
    return {
        "sell": _round_optional(sell),
        "delta": _round_optional(buy - sell),
        "ratio": None if total == 0 else _round_optional(buy / total),
    }


def _round_optional(value: float | None) -> float | None:
    return None if value is None else round(value, 8)
