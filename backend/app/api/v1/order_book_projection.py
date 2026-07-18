"""Presentation-only price grouping for order-book snapshots."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_FLOOR
from typing import Any, Literal, Mapping, Sequence

from app.api.v1.symbols import get_cached_symbol_metadata
from app.data_engine.market_data.models import MarketStreamKey


PriceGrouping = Literal["auto", "raw", "10", "100", "1000"]
FULL_PRICE_GROUPINGS: tuple[PriceGrouping, ...] = ("auto", "raw", "10", "100", "1000")
PARTIAL_PRICE_GROUPINGS: tuple[PriceGrouping, ...] = ("auto", "raw", "10")


@dataclass(frozen=True, slots=True)
class OrderBookProjection:
    bids: list[list[float]]
    asks: list[list[float]]
    price_tick_size: float | None
    price_step: float | None
    price_grouping: PriceGrouping
    aggregation_applied: bool
    source_bid_levels: int
    source_ask_levels: int
    bucket_bid_levels: int
    bucket_ask_levels: int
    price_window_bid_truncated: bool
    price_window_ask_truncated: bool
    incomplete_outer_bid_bucket_omitted: bool
    incomplete_outer_ask_bucket_omitted: bool


def normalize_price_grouping(
    value: object,
    *,
    allowed: Sequence[PriceGrouping] = FULL_PRICE_GROUPINGS,
) -> PriceGrouping:
    normalized = str(value or "").strip().lower()
    if normalized not in allowed:
        choices = ", ".join(allowed)
        raise ValueError(f"price_grouping must be one of {choices}")
    return normalized  # type: ignore[return-value]


def cached_price_tick_size(key: MarketStreamKey) -> Decimal | None:
    metadata = get_cached_symbol_metadata(key.exchange, key.market_type, key.symbol)
    if not metadata:
        return None
    return _positive_decimal(metadata.get("priceTickSize"))


def project_order_book_levels(
    data: Mapping[str, Any],
    *,
    price_grouping: PriceGrouping,
    price_tick_size: Decimal | None,
    limit: int | None = None,
    max_auto_multiplier: int = 1_000,
    omit_incomplete_outer_bucket: bool = False,
) -> OrderBookProjection:
    bids = _level_pairs(data.get("bids"), side="bids")
    asks = _level_pairs(data.get("asks"), side="asks")
    price_step = _effective_price_step(
        data,
        price_grouping=price_grouping,
        price_tick_size=price_tick_size,
        max_auto_multiplier=max_auto_multiplier,
    )
    aggregation_applied = (
        price_tick_size is not None
        and price_step is not None
        and price_step > price_tick_size
    )
    if aggregation_applied:
        bid_buckets = _aggregate_side(bids, price_step, side="bids")
        ask_buckets = _aggregate_side(asks, price_step, side="asks")
    else:
        bid_buckets = bids
        ask_buckets = asks

    all_bid_buckets = bid_buckets
    all_ask_buckets = ask_buckets
    bid_buckets = _price_window(all_bid_buckets, price_step, limit, side="bids")
    ask_buckets = _price_window(all_ask_buckets, price_step, limit, side="asks")
    price_window_bid_truncated = len(bid_buckets) < len(all_bid_buckets)
    price_window_ask_truncated = len(ask_buckets) < len(all_ask_buckets)

    incomplete_outer_bid_bucket_omitted = False
    incomplete_outer_ask_bucket_omitted = False
    if aggregation_applied and omit_incomplete_outer_bucket:
        # A bounded source can cut through the furthest price bucket.  That
        # bucket's quantity (and even its presence) then depends on the source
        # depth boundary rather than the market.  Keep the near-price buckets,
        # but never present a multi-bucket truncated edge as complete depth.
        if not price_window_bid_truncated and len(bid_buckets) > 1:
            bid_buckets = bid_buckets[:-1]
            incomplete_outer_bid_bucket_omitted = True
        if not price_window_ask_truncated and len(ask_buckets) > 1:
            ask_buckets = ask_buckets[:-1]
            incomplete_outer_ask_bucket_omitted = True

    visible_bids = bid_buckets if limit is None else bid_buckets[:limit]
    visible_asks = ask_buckets if limit is None else ask_buckets[:limit]
    return OrderBookProjection(
        bids=_float_levels(visible_bids),
        asks=_float_levels(visible_asks),
        price_tick_size=float(price_tick_size) if price_tick_size is not None else None,
        price_step=float(price_step) if price_step is not None else None,
        price_grouping=price_grouping,
        aggregation_applied=aggregation_applied,
        source_bid_levels=len(bids),
        source_ask_levels=len(asks),
        bucket_bid_levels=len(all_bid_buckets),
        bucket_ask_levels=len(all_ask_buckets),
        price_window_bid_truncated=price_window_bid_truncated,
        price_window_ask_truncated=price_window_ask_truncated,
        incomplete_outer_bid_bucket_omitted=incomplete_outer_bid_bucket_omitted,
        incomplete_outer_ask_bucket_omitted=incomplete_outer_ask_bucket_omitted,
    )


def _effective_price_step(
    data: Mapping[str, Any],
    *,
    price_grouping: PriceGrouping,
    price_tick_size: Decimal | None,
    max_auto_multiplier: int,
) -> Decimal | None:
    if price_tick_size is None:
        return None
    if price_grouping == "raw":
        return price_tick_size
    if price_grouping != "auto":
        return price_tick_size * Decimal(int(price_grouping))

    reference = _reference_price(data)
    if reference is None:
        return price_tick_size
    target = reference * Decimal("0.00001")
    multiplier = 1
    while multiplier < max_auto_multiplier and price_tick_size * multiplier < target:
        multiplier *= 10
    return price_tick_size * min(multiplier, max_auto_multiplier)


def _reference_price(data: Mapping[str, Any]) -> Decimal | None:
    for name in ("mid_price", "best_bid_price", "top_bid", "best_ask_price", "top_ask"):
        parsed = _positive_decimal(data.get(name))
        if parsed is not None:
            return parsed
    for side in ("bids", "asks"):
        raw_levels = data.get(side)
        if isinstance(raw_levels, (list, tuple)) and raw_levels:
            first = raw_levels[0]
            if isinstance(first, (list, tuple)) and first:
                parsed = _positive_decimal(first[0])
                if parsed is not None:
                    return parsed
    return None


def _level_pairs(value: object, *, side: str) -> list[tuple[Decimal, Decimal]]:
    if not isinstance(value, (list, tuple)):
        raise TypeError(f"order-book {side} must be a sequence")
    parsed: list[tuple[Decimal, Decimal]] = []
    for index, raw in enumerate(value):
        if not isinstance(raw, (list, tuple)) or len(raw) != 2:
            raise TypeError(f"order-book {side}[{index}] must be a price/quantity pair")
        price = _positive_decimal(raw[0])
        quantity = _positive_decimal(raw[1])
        if price is None or quantity is None:
            raise ValueError(f"order-book {side}[{index}] must contain positive values")
        parsed.append((price, quantity))
    return parsed


def _aggregate_side(
    levels: Sequence[tuple[Decimal, Decimal]],
    price_step: Decimal,
    *,
    side: Literal["bids", "asks"],
) -> list[tuple[Decimal, Decimal]]:
    rounding = ROUND_FLOOR if side == "bids" else ROUND_CEILING
    buckets: dict[Decimal, Decimal] = {}
    for price, quantity in levels:
        bucket = (price / price_step).to_integral_value(rounding=rounding) * price_step
        buckets[bucket] = buckets.get(bucket, Decimal(0)) + quantity
    return sorted(buckets.items(), key=lambda item: item[0], reverse=side == "bids")


def _price_window(
    levels: Sequence[tuple[Decimal, Decimal]],
    price_step: Decimal | None,
    limit: int | None,
    *,
    side: Literal["bids", "asks"],
) -> list[tuple[Decimal, Decimal]]:
    if limit is None or price_step is None or not levels:
        return list(levels)
    max_distance = price_step * Decimal(max(0, limit - 1))
    near_price = levels[0][0]
    if side == "bids":
        boundary = near_price - max_distance
        return [level for level in levels if level[0] >= boundary]
    boundary = near_price + max_distance
    return [level for level in levels if level[0] <= boundary]


def _float_levels(levels: Sequence[tuple[Decimal, Decimal]]) -> list[list[float]]:
    return [[float(price), float(quantity)] for price, quantity in levels]


def _positive_decimal(value: object) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None
    return parsed if parsed.is_finite() and parsed > 0 else None


__all__ = [
    "FULL_PRICE_GROUPINGS",
    "PARTIAL_PRICE_GROUPINGS",
    "OrderBookProjection",
    "PriceGrouping",
    "cached_price_tick_size",
    "normalize_price_grouping",
    "project_order_book_levels",
]
