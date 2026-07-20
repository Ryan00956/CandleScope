from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.data_engine.interval_policy import aggregate_kline_rows
from app.replay.bars.builder import ReplayBarBuilder, assess_bar_builder_capability
from app.replay.dataset import ReplayBar
from app.replay.sources.bar_source import BarReplaySource
from tests.fixtures.replay.bar_builder_fakes import (
    INTERVAL_MS,
    REPLAY_START_MS,
    make_bar_snapshot,
    make_replay_bar,
)


def _ms(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> int:
    return int(
        datetime(year, month, day, hour, minute, tzinfo=timezone.utc).timestamp()
        * 1_000
    )


def _bars(start_ms: int, count: int) -> tuple[ReplayBar, ...]:
    return tuple(
        make_replay_bar(
            start_ms + index * INTERVAL_MS,
            100 + index,
            volume=index + 1,
        )
        for index in range(count)
    )


def _signature(row) -> tuple[object, ...]:
    if hasattr(row, "to_dict"):
        payload = row.to_dict()
    else:
        payload = row
    return (
        int(payload.get("open_time_ms", payload.get("open_time"))),
        int(payload.get("close_time_ms", payload.get("close_time"))),
        round(float(payload["open"]), 8),
        round(float(payload["high"]), 8),
        round(float(payload["low"]), 8),
        round(float(payload["close"]), 8),
        round(float(payload["volume"]), 8),
        None
        if payload.get("quote_volume") is None
        else round(float(payload["quote_volume"]), 8),
        payload.get("trades"),
        None
        if payload.get("taker_buy_base") is None
        else round(float(payload["taker_buy_base"]), 8),
        None
        if payload.get("taker_buy_quote") is None
        else round(float(payload["taker_buy_quote"]), 8),
    )


@pytest.mark.parametrize(
    ("display_interval", "bar_count"),
    [("1m", 8), ("5m", 10), ("15m", 30), ("1h", 120)],
)
def test_closed_display_bars_match_shared_interval_aggregation(
    display_interval: str,
    bar_count: int,
) -> None:
    bars = _bars(REPLAY_START_MS, bar_count)
    builder = ReplayBarBuilder(
        base_interval="1m",
        display_interval=display_interval,
        replay_start_ms=REPLAY_START_MS,
        warmup_bars=(),
        max_closed_bars=bar_count,
    )
    for bar in bars:
        builder.apply_bar(bar)

    if display_interval == "1m":
        expected = bars
    else:
        expected = aggregate_kline_rows(
            [
                {
                    **bar.to_dict(),
                    "open_time": bar.open_time_ms,
                    "close_time": bar.close_time_ms,
                    "is_closed": True,
                }
                for bar in bars
            ],
            target_interval=display_interval,
            source_interval="1m",
            now_ms=bars[-1].close_time_ms + 3_600_001,
        )
    assert [_signature(bar) for bar in builder.closed_bars] == [
        _signature(bar) for bar in expected
    ]
    assert builder.active_bar is None


def test_utc_day_and_month_boundaries_use_shared_bucket_alignment() -> None:
    start_ms = _ms(2024, 1, 31, 23, 55)
    builder = ReplayBarBuilder(
        base_interval="1m",
        display_interval="5m",
        replay_start_ms=start_ms,
        warmup_bars=(),
    )
    for bar in _bars(start_ms, 10):
        builder.apply_bar(bar)

    assert [bar.open_time_ms for bar in builder.closed_bars] == [
        _ms(2024, 1, 31, 23, 55),
        _ms(2024, 2, 1, 0, 0),
    ]
    assert all(bar.is_closed for bar in builder.closed_bars)


def test_calendar_month_display_uses_actual_utc_month_lengths() -> None:
    day_ms = 24 * 60 * INTERVAL_MS
    start_ms = _ms(2024, 1, 1)
    builder = ReplayBarBuilder(
        base_interval="1d",
        display_interval="1M",
        replay_start_ms=start_ms,
        warmup_bars=(),
    )
    for index in range(60):
        builder.apply_bar(
            make_replay_bar(
                start_ms + index * day_ms,
                100 + index,
                interval_ms=day_ms,
            )
        )

    assert [bar.open_time_ms for bar in builder.closed_bars] == [
        _ms(2024, 1, 1),
        _ms(2024, 2, 1),
    ]
    assert [bar.expected_components for bar in builder.closed_bars] == [31, 29]
    assert builder.closed_bars[-1].close_time_ms == _ms(2024, 3, 1) - 1


@pytest.mark.parametrize(
    ("base", "display", "enabled", "reason"),
    [
        ("1m", "7m", True, None),
        ("3m", "5m", False, "DISPLAY_NOT_DIVISIBLE_BY_BASE"),
        ("5m", "1m", False, "DISPLAY_SHORTER_THAN_BASE"),
        ("1m", "1M", True, None),
        ("3d", "1M", False, "CALENDAR_BUCKET_NOT_EXACT"),
        ("bad", "5m", False, "INVALID_BASE_INTERVAL"),
    ],
)
def test_custom_interval_capability_fails_closed_when_exact_tiling_is_impossible(
    base: str,
    display: str,
    enabled: bool,
    reason: str | None,
) -> None:
    capability = assess_bar_builder_capability(base, display)
    assert capability.enabled is enabled
    assert capability.reason == reason
    assert capability.synthetic_policy == "reject"


def test_exact_custom_interval_closes_after_its_last_component() -> None:
    aligned_start_ms = REPLAY_START_MS - REPLAY_START_MS % (7 * INTERVAL_MS)
    builder = ReplayBarBuilder(
        base_interval="1m",
        display_interval="7m",
        replay_start_ms=aligned_start_ms,
        warmup_bars=(),
    )
    updates = [builder.apply_bar(bar) for bar in _bars(aligned_start_ms, 7)]
    assert updates[-1].bar.is_closed is True
    assert updates[-1].bar.expected_components == 7
    assert len(builder.closed_bars) == 1


def test_display_switch_rebuilds_only_from_the_source_revealed_prefix() -> None:
    snapshot = make_bar_snapshot(warmup_count=5, replay_count=20)
    source = BarReplaySource(snapshot)
    builder = ReplayBarBuilder(
        base_interval="1m",
        display_interval="5m",
        replay_start_ms=snapshot.replay_start_ms,
        warmup_bars=source.warmup_rows(),
    )
    for _ in range(7):
        bar = source.next()
        assert bar is not None
        builder.apply_bar(bar)

    switched = builder.rebuild_for_display_interval(
        "15m",
        source.revealed_replay_rows(),
    )

    assert source.cursor().source_sequence == 7
    assert switched.replay_events_applied == 7
    assert switched.active_bar is not None
    assert (
        switched.active_bar.last_base_open_ms == source.cursor().last_base_bar_open_ms
    )
    assert switched.active_bar.close == "112"
    assert snapshot.replay_rows[7] not in source.revealed_replay_rows()
    assert switched.replace_projection()["bars"][-1]["is_closed"] is False


def test_replay_builder_source_has_no_online_registry_or_event_bus_dependency() -> None:
    builder_path = Path(__file__).parents[1] / "app" / "replay" / "bars" / "builder.py"
    source = builder_path.read_text(encoding="utf-8").lower()
    assert "data_manager" not in source
    assert "eventbus" not in source
    assert "bar_aggregator" not in source
