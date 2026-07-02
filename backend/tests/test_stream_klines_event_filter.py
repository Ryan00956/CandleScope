from __future__ import annotations

from app.api.v1.stream_klines import should_forward_browser_event
from app.data_engine.data_manager.models import (
    BarData,
    DataEvent,
    DataEventType,
    SeriesKey,
)


def test_internal_backfill_completed_events_are_not_forwarded_to_browsers() -> None:
    event = DataEvent(
        event_type=DataEventType.BACKFILL_COMPLETED,
        key=SeriesKey("BTCUSDT", "1m"),
        audience="internal",
        detail={"reason": "background_gap_audit"},
    )

    assert should_forward_browser_event(event) is False


def test_user_backfill_completed_events_are_forwarded_to_browsers() -> None:
    event = DataEvent(
        event_type=DataEventType.BACKFILL_COMPLETED,
        key=SeriesKey("BTCUSDT", "1m"),
        audience="user",
        detail={"reason": "visible_range_gap"},
    )

    assert should_forward_browser_event(event) is True


def test_bar_events_are_forwarded_regardless_of_audience() -> None:
    event = DataEvent(
        event_type=DataEventType.BAR_UPDATED,
        key=SeriesKey("BTCUSDT", "1m"),
        audience="internal",
        bar=BarData(time=1_700_000_000, open=1, high=2, low=1, close=2, volume=10),
    )

    assert should_forward_browser_event(event) is True
