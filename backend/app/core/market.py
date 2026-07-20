"""Market identity and the legacy facade for interval helpers.

Interval parsing, timeline alignment, and aggregation policy have exactly one
owner: :mod:`app.data_engine.interval_policy`.  This module retains the
historical import surface used by API and exchange code; it must not grow a
second implementation of interval semantics.
"""
from __future__ import annotations

import enum

from app.data_engine.interval_policy import (
    EPHEMERAL_INTERVALS,
    INTERVAL_SECONDS,
    VALID_INTERVALS,
    aggregate_rows_by_month,
    compute_bucket_end_ms,
    compute_bucket_start,
    compute_bucket_start_ms,
    compute_month_bucket,
    compute_month_bucket_ms,
    find_best_base_interval,
    find_optimal_fetch_plan,
    get_tier_for_interval,
    is_custom_interval,
    is_ephemeral_interval,
    is_monthly_interval,
    is_standard_interval,
    is_weekly_interval,
    next_month_bucket,
    parse_custom_interval,
    parse_interval_ms,
    parse_interval_spec,
    parse_monthly_count,
)


class MarketType(str, enum.Enum):
    """Supported market types."""

    SPOT = "spot"
    FUTURES = "futures"  # Binance USDT-M perpetual

    @classmethod
    def from_str(cls, value: str | None) -> "MarketType":
        """Parse a market type, retaining the historical SPOT fallback."""
        if value is None:
            return cls.SPOT
        normalized = value.strip().lower()
        if normalized in {"futures", "perpetual", "perp", "usdt-m"}:
            return cls.FUTURES
        return cls.SPOT


__all__ = [
    "MarketType",
    "VALID_INTERVALS",
    "INTERVAL_SECONDS",
    "EPHEMERAL_INTERVALS",
    "parse_interval_spec",
    "parse_custom_interval",
    "parse_interval_ms",
    "is_standard_interval",
    "is_custom_interval",
    "is_ephemeral_interval",
    "is_weekly_interval",
    "is_monthly_interval",
    "parse_monthly_count",
    "get_tier_for_interval",
    "compute_bucket_start",
    "compute_bucket_start_ms",
    "compute_bucket_end_ms",
    "compute_month_bucket",
    "compute_month_bucket_ms",
    "next_month_bucket",
    "aggregate_rows_by_month",
    "find_best_base_interval",
    "find_optimal_fetch_plan",
]
