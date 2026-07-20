from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.data_engine.bar_aggregator.time_bucket import MonthlyBucketCalculator
from app.data_engine.history import AlwaysOpenCalendar
from app.data_engine.interval_policy import (
    IntervalAlignment,
    compute_bucket_start_ms,
    interval_tiles,
    intervals_equivalent,
    parse_interval_spec,
)


def _ms(value: str) -> int:
    return int(datetime.fromisoformat(value).timestamp() * 1000)


@pytest.mark.parametrize(
    ("requested", "canonical"),
    [
        ("60m", "1h"),
        ("3600s", "1h"),
        ("24h", "1d"),
        ("120m", "2h"),
    ],
)
def test_fixed_interval_aliases_have_one_canonical_identity(
    requested: str,
    canonical: str,
) -> None:
    spec = parse_interval_spec(requested)

    assert spec is not None
    assert spec.canonical == canonical
    assert spec.alignment is IntervalAlignment.FIXED_EPOCH
    assert intervals_equivalent(requested, canonical)


@pytest.mark.parametrize(
    ("left", "right"),
    [("7d", "1w"), ("14d", "2w"), ("30d", "1M")],
)
def test_equal_nominal_width_does_not_cross_alignment_families(
    left: str,
    right: str,
) -> None:
    assert not intervals_equivalent(left, right)


@pytest.mark.parametrize("months", [1, 2, 3, 4, 5, 6, 7, 12, 13])
@pytest.mark.parametrize(
    "timestamp_ms",
    [
        _ms("2023-12-31T23:59:59+00:00"),
        _ms("2024-02-29T12:00:00+00:00"),
        _ms("2025-01-01T00:00:00+00:00"),
    ],
)
def test_arbitrary_calendar_months_share_one_absolute_anchor(
    months: int,
    timestamp_ms: int,
) -> None:
    interval = f"{months}M"
    spec = parse_interval_spec(interval)
    assert spec is not None
    bucket_ms = spec.floor_ms(timestamp_ms)
    next_ms = spec.next_ms(bucket_ms)
    previous_ms = spec.previous_ms(bucket_ms)

    assert bucket_ms <= timestamp_ms < next_ms
    assert spec.next_ms(previous_ms) == bucket_ms
    assert spec.previous_ms(next_ms) == bucket_ms
    assert compute_bucket_start_ms(
        timestamp_ms,
        spec.nominal_ms,
        interval=interval,
    ) == bucket_ms
    assert MonthlyBucketCalculator(months).compute_bucket(timestamp_ms) == bucket_ms

    calendar = AlwaysOpenCalendar()
    assert calendar.last_expected_open(bucket_ms, timestamp_ms, interval) == bucket_ms
    assert calendar.next_expected_open(bucket_ms, interval) == next_ms
    assert calendar.previous_expected_open(bucket_ms, interval) == previous_ms


def test_calendar_month_buckets_do_not_reset_at_new_year() -> None:
    spec = parse_interval_spec("5M")
    assert spec is not None
    opens = [spec.floor_ms(_ms("2023-11-15T00:00:00+00:00"))]
    for _ in range(5):
        opens.append(spec.next_ms(opens[-1]))

    assert all(left < right for left, right in zip(opens, opens[1:]))
    assert all(
        spec.previous_ms(right) == left
        for left, right in zip(opens, opens[1:])
    )


def test_cross_alignment_tiling_requires_daily_or_smaller_fixed_source() -> None:
    one_day = parse_interval_spec("1d")
    twelve_hours = parse_interval_spec("12h")
    three_days = parse_interval_spec("3d")
    one_week = parse_interval_spec("1w")
    one_month = parse_interval_spec("1M")
    assert all(item is not None for item in (
        one_day,
        twelve_hours,
        three_days,
        one_week,
        one_month,
    ))

    assert interval_tiles(one_day, one_week)  # type: ignore[arg-type]
    assert interval_tiles(twelve_hours, one_month)  # type: ignore[arg-type]
    assert not interval_tiles(three_days, one_week)  # type: ignore[arg-type]
    assert not interval_tiles(three_days, one_month)  # type: ignore[arg-type]


def test_interval_parser_rejects_subsecond_and_unbounded_values() -> None:
    assert parse_interval_spec("1ms") is None
    assert parse_interval_spec(f"{1 << 63}d") is None
    assert parse_interval_spec("12001M") is None
