from __future__ import annotations

import asyncio

from app.api.v1.stream_klines import (
    _KlineWsOutbox,
    _serialize_kline_event,
    should_forward_browser_event,
)
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


def test_kline_event_envelope_preserves_amended_semantics() -> None:
    event = DataEvent(
        event_type=DataEventType.BAR_AMENDED,
        key=SeriesKey("BTCUSDT", "1h"),
        bar=BarData(
            time=1_700_000_000,
            open=1,
            high=3,
            low=0.5,
            close=2,
            volume=10,
        ),
    )

    payload = _serialize_kline_event(event)

    assert payload["event_type"] == "bar.amended"
    assert payload["data"]["is_closed"] is True
    assert payload["data"]["time"] == 1_700_000_000


def test_multi_kline_outbox_keeps_latest_forming_update_without_crossing_final() -> None:
    async def _run() -> None:
        outbox = _KlineWsOutbox(maxsize=8)
        key = ("binance", "spot", "BTCUSDT", "1m")

        assert await outbox.put({"seq": 1}, key=key, replaceable=True)
        assert await outbox.put({"seq": 2}, key=key, replaceable=True)
        assert await outbox.put({"seq": 3, "closed": True}, key=key)
        assert await outbox.put({"seq": 4}, key=key, replaceable=True)

        assert await outbox.get() == {"seq": 2}
        assert await outbox.get() == {"seq": 3, "closed": True}
        assert await outbox.get() == {"seq": 4}

    asyncio.run(_run())


def test_multi_kline_outbox_keeps_forming_index_after_final_enqueue_timeout() -> None:
    async def _run() -> None:
        outbox = _KlineWsOutbox(maxsize=1)
        key = ("binance", "spot", "BTCUSDT", "1m")

        assert await outbox.put({"seq": 1}, key=key, replaceable=True)
        assert await outbox.put(
            {"seq": 2, "closed": True},
            key=key,
            timeout=0.01,
        )
        assert not await outbox.put({"seq": 3}, key=key, replaceable=True)
        assert outbox._queue.qsize() == 1
        assert await outbox.get() == {"seq": 1}
        assert await outbox.get() == {"seq": 2, "closed": True}

    asyncio.run(_run())
