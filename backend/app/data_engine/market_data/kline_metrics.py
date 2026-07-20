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
        if getattr(capabilities, "capability_schema_version", 1) < 2:
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

    fields, _ = resolve_declared_kline_enhancements(
        exchange,
        market_type,
        values,
        explicit_fields=explicit_fields,
    )
    return fields


def resolve_declared_kline_enhancements(
    exchange: str,
    market_type: str,
    values: Mapping[str, Any],
    *,
    explicit_fields: Collection[str] | None = None,
) -> tuple[frozenset[str], tuple[float | None, int | None, float | None, float | None]]:
    """Resolve declared fields and retain their normalized additive values."""
    declared = _resolve_available_fields(
        exchange,
        market_type,
        explicit_fields=explicit_fields,
    )
    if not declared:
        return frozenset(), (None, None, None, None)
    normalized = _normalize_declared_fields(declared, values)
    fields = frozenset(
        field
        for field, value in zip(KLINE_ENHANCED_FIELDS, normalized, strict=True)
        if value is not None
    )
    return fields, normalized


def normalize_declared_kline_enhancements(
    exchange: str,
    market_type: str,
    values: Mapping[str, Any],
    *,
    explicit_fields: Collection[str] | None = None,
) -> tuple[float | None, int | None, float | None, float | None]:
    """Return capability-gated raw fields without allocating a field set."""
    declared = _resolve_available_fields(
        exchange,
        market_type,
        explicit_fields=explicit_fields,
    )
    if not declared:
        return None, None, None, None
    return _normalize_declared_fields(declared, values)


def _resolve_available_fields(
    exchange: str,
    market_type: str,
    *,
    explicit_fields: Collection[str] | None,
) -> frozenset[str]:
    if isinstance(explicit_fields, frozenset):
        return explicit_fields
    if explicit_fields is not None:
        return frozenset(explicit_fields)
    return kline_available_fields(exchange, market_type)


def _normalize_declared_fields(
    declared: frozenset[str],
    values: Mapping[str, Any],
) -> tuple[float | None, int | None, float | None, float | None]:
    normalized = _raw_kline_aggregation_fields(
        volume=values.get("volume"),
        quote_volume=values.get("quote_volume"),
        trades=values.get("trades"),
        taker_buy_base=values.get("taker_buy_base"),
        taker_buy_quote=values.get("taker_buy_quote"),
    )
    return (
        normalized[0] if "quote_volume" in declared else None,
        normalized[1] if "trades" in declared else None,
        normalized[2] if "taker_buy_base" in declared else None,
        normalized[3] if "taker_buy_quote" in declared else None,
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

    safe_quote_volume, safe_trades, base_pair, quote_pair = (
        _validated_kline_components(
            volume=volume,
            quote_volume=quote_volume,
            trades=trades,
            taker_buy_base=taker_buy_base,
            taker_buy_quote=taker_buy_quote,
        )
    )

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


def normalize_kline_aggregation_fields(
    *,
    volume: Any,
    quote_volume: Any,
    trades: Any,
    taker_buy_base: Any,
    taker_buy_quote: Any,
) -> tuple[float | None, int | None, float | None, float | None]:
    """Return the exact raw fields consumed by custom aggregation.

    The legacy custom-query path first calls ``BarData.to_aggregation_dict``
    and then passes that dictionary through ``serialize_kline_enhancements``
    again.  The second pass is a meaningful fail-closed boundary because the
    first pass rounds raw values to eight decimals.  Repeating the full public
    serializer also computes order-flow ratios and allocates dictionaries that
    aggregation immediately discards.

    This helper composes those two raw-field validation passes without
    calculating derived metrics.  Its tuple is intentionally ordered like
    ``KLINE_ENHANCED_FIELDS``.
    """
    fast_numeric_inputs = bool(
        _is_fast_nonnegative_number(volume)
        and (
            quote_volume is None
            or _is_fast_nonnegative_number(quote_volume)
        )
        and (
            trades is None
            or (
                _is_fast_nonnegative_number(trades)
                and int(trades) == trades
            )
        )
        and (
            taker_buy_base is None
            or _is_fast_nonnegative_number(taker_buy_base)
        )
        and (
            taker_buy_quote is None
            or _is_fast_nonnegative_number(taker_buy_quote)
        )
    )
    if fast_numeric_inputs:
        safe_volume = float(volume)
        safe_quote = (
            None if quote_volume is None else float(quote_volume)
        )
        safe_trades = None if trades is None else int(trades)
        safe_base_buy: float | None = None
        if taker_buy_base is not None:
            candidate = float(taker_buy_base)
            tolerance = max(1e-10, safe_volume * 1e-10)
            if candidate <= safe_volume + tolerance:
                safe_base_buy = min(candidate, safe_volume)
        safe_quote_buy: float | None = None
        if safe_quote is not None and taker_buy_quote is not None:
            candidate = float(taker_buy_quote)
            tolerance = max(1e-10, safe_quote * 1e-10)
            if candidate <= safe_quote + tolerance:
                safe_quote_buy = min(candidate, safe_quote)

        if safe_volume > 0 and safe_quote == 0:
            safe_quote = None
            safe_trades = None
            safe_base_buy = None
            safe_quote_buy = None

        # First public-serializer boundary.
        first_quote = _round_optional(safe_quote)
        first_base_buy = _round_optional(safe_base_buy)
        first_quote_buy = _round_optional(safe_quote_buy)

        # ``BarData.to_dict`` rounds volume before the legacy second pass.
        second_volume = round(volume, 8)
        second_base_buy: float | None = None
        if first_base_buy is not None:
            tolerance = max(1e-10, second_volume * 1e-10)
            if first_base_buy <= second_volume + tolerance:
                second_base_buy = min(first_base_buy, second_volume)
        second_quote_buy: float | None = None
        if first_quote is not None and first_quote_buy is not None:
            tolerance = max(1e-10, first_quote * 1e-10)
            if first_quote_buy <= first_quote + tolerance:
                second_quote_buy = min(first_quote_buy, first_quote)

        if second_volume > 0 and first_quote == 0:
            first_quote = None
            safe_trades = None
            second_base_buy = None
            second_quote_buy = None
        return (
            _round_optional(first_quote),
            safe_trades,
            _round_optional(second_base_buy),
            _round_optional(second_quote_buy),
        )

    first = _raw_kline_aggregation_fields(
        volume=volume,
        quote_volume=quote_volume,
        trades=trades,
        taker_buy_base=taker_buy_base,
        taker_buy_quote=taker_buy_quote,
    )
    return _raw_kline_aggregation_fields(
        volume=round(volume, 8),
        quote_volume=first[0],
        trades=first[1],
        taker_buy_base=first[2],
        taker_buy_quote=first[3],
    )


def normalize_prevalidated_kline_aggregation_fields(
    *,
    normalized_volume: Any,
    fields: tuple[float | None, int | None, float | None, float | None],
) -> tuple[float | None, int | None, float | None, float | None]:
    """Apply only the legacy second validation pass to cached raw fields."""
    quote_volume, trades, taker_buy_base, taker_buy_quote = fields
    safe_volume = float(normalized_volume)
    safe_base_buy: float | None = None
    if taker_buy_base is not None:
        tolerance = max(1e-10, safe_volume * 1e-10)
        if taker_buy_base <= safe_volume + tolerance:
            safe_base_buy = min(taker_buy_base, safe_volume)
    safe_quote_buy: float | None = None
    if quote_volume is not None and taker_buy_quote is not None:
        tolerance = max(1e-10, quote_volume * 1e-10)
        if taker_buy_quote <= quote_volume + tolerance:
            safe_quote_buy = min(taker_buy_quote, quote_volume)
    if safe_volume > 0 and quote_volume == 0:
        quote_volume = None
        trades = None
        safe_base_buy = None
        safe_quote_buy = None
    # All inputs crossed the first eight-decimal serializer boundary already.
    # ``min`` can only retain one of those values, so a second ``round`` call
    # is mathematically idempotent and needlessly expensive on large pages.
    return quote_volume, trades, safe_base_buy, safe_quote_buy


def _raw_kline_aggregation_fields(
    *,
    volume: Any,
    quote_volume: Any,
    trades: Any,
    taker_buy_base: Any,
    taker_buy_quote: Any,
) -> tuple[float | None, int | None, float | None, float | None]:
    fast_numeric_inputs = bool(
        (
            (type(volume) is int and volume >= 0)
            or (
                type(volume) is float
                and volume >= 0
                and math.isfinite(volume)
            )
        )
        and (
            quote_volume is None
            or (type(quote_volume) is int and quote_volume >= 0)
            or (
                type(quote_volume) is float
                and quote_volume >= 0
                and math.isfinite(quote_volume)
            )
        )
        and (
            trades is None
            or (type(trades) is int and trades >= 0)
            or (
                type(trades) is float
                and trades >= 0
                and math.isfinite(trades)
                and int(trades) == trades
            )
        )
        and (
            taker_buy_base is None
            or (type(taker_buy_base) is int and taker_buy_base >= 0)
            or (
                type(taker_buy_base) is float
                and taker_buy_base >= 0
                and math.isfinite(taker_buy_base)
            )
        )
        and (
            taker_buy_quote is None
            or (type(taker_buy_quote) is int and taker_buy_quote >= 0)
            or (
                type(taker_buy_quote) is float
                and taker_buy_quote >= 0
                and math.isfinite(taker_buy_quote)
            )
        )
    )
    if fast_numeric_inputs:
        safe_volume = float(volume)
        safe_quote = None if quote_volume is None else float(quote_volume)
        safe_trades = None if trades is None else int(trades)
        safe_base_buy: float | None = None
        if taker_buy_base is not None:
            candidate = float(taker_buy_base)
            tolerance = max(1e-10, safe_volume * 1e-10)
            if candidate <= safe_volume + tolerance:
                safe_base_buy = min(candidate, safe_volume)
        safe_quote_buy: float | None = None
        if safe_quote is not None and taker_buy_quote is not None:
            candidate = float(taker_buy_quote)
            tolerance = max(1e-10, safe_quote * 1e-10)
            if candidate <= safe_quote + tolerance:
                safe_quote_buy = min(candidate, safe_quote)
        if safe_volume > 0 and safe_quote == 0:
            safe_quote = None
            safe_trades = None
            safe_base_buy = None
            safe_quote_buy = None
        return (
            None if safe_quote is None else round(safe_quote, 8),
            safe_trades,
            None if safe_base_buy is None else round(safe_base_buy, 8),
            None if safe_quote_buy is None else round(safe_quote_buy, 8),
        )

    safe_quote_volume, safe_trades, base_pair, quote_pair = (
        _validated_kline_components(
            volume=volume,
            quote_volume=quote_volume,
            trades=trades,
            taker_buy_base=taker_buy_base,
            taker_buy_quote=taker_buy_quote,
        )
    )
    return (
        _round_optional(safe_quote_volume),
        safe_trades,
        _round_optional(base_pair[0] if base_pair is not None else None),
        _round_optional(quote_pair[0] if quote_pair is not None else None),
    )


def _validated_kline_components(
    *,
    volume: Any,
    quote_volume: Any,
    trades: Any,
    taker_buy_base: Any,
    taker_buy_quote: Any,
) -> tuple[
    float | None,
    int | None,
    tuple[float, float] | None,
    tuple[float, float] | None,
]:
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
    return safe_quote_volume, safe_trades, base_pair, quote_pair


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


def _is_fast_nonnegative_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return bool(math.isfinite(value) and value >= 0)
    except (OverflowError, TypeError, ValueError):
        return False


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
