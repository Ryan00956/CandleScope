from __future__ import annotations

import asyncio

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.delivery import DeliveryLayer
from app.data_engine.ingestion.models import (
    DataSource,
    GapMarker,
    MarketEvent,
    StreamDescriptor,
    StreamType,
)


def _descriptor() -> StreamDescriptor:
    return StreamDescriptor("BTCUSDT", StreamType.KLINE, interval="1m")


def _market_event(open_time: int = 60_000) -> MarketEvent:
    return MarketEvent(
        event_type=StreamType.KLINE,
        symbol="BTCUSDT",
        exchange="binance",
        event_time_ms=open_time,
        received_at_ms=open_time + 1,
        source=DataSource.WEBSOCKET,
        data={
            "interval": "1m",
            "open_time": open_time,
            "close_time": open_time + 59_999,
            "open": 1.0,
            "high": 2.0,
            "low": 0.5,
            "close": 1.5,
            "volume": 10.0,
            "is_closed": True,
        },
        stream_key="BTCUSDT@kline_1m",
        sequence=open_time,
    )


def _gap() -> GapMarker:
    return GapMarker(
        stream_key="BTCUSDT@kline_1m",
        symbol="BTCUSDT",
        stream_type=StreamType.KLINE,
        gap_start=60_000,
        gap_end=180_000,
        expected_count=1,
    )


def test_ordered_callback_backpressures_queue_delivery() -> None:
    async def _run() -> None:
        delivery = DeliveryLayer(IngestionConfig(delivery_queue_size=2), _descriptor())
        subscriber = delivery.create_queue_subscriber()
        callback_started = asyncio.Event()
        callback_release = asyncio.Event()
        calls: list[int] = []

        async def _core_callback(event: MarketEvent) -> None:
            callback_started.set()
            await callback_release.wait()
            calls.append(event.event_time_ms)

        delivery.on_market_event(_core_callback)

        task = asyncio.create_task(delivery.deliver_event(_market_event()))
        await asyncio.wait_for(callback_started.wait(), timeout=1)
        await asyncio.sleep(0)

        assert subscriber.queue_size == 0
        assert calls == []

        callback_release.set()
        await task
        assert calls == [60_000]
        assert subscriber.queue_size == 1

        await subscriber.close()

    asyncio.run(_run())


def test_queue_subscriber_drop_does_not_block_ordered_callback() -> None:
    async def _run() -> None:
        delivery = DeliveryLayer(IngestionConfig(delivery_queue_size=1), _descriptor())
        subscriber = delivery.create_queue_subscriber(maxsize=1)
        calls: list[int] = []

        async def _core_callback(event: MarketEvent) -> None:
            calls.append(event.event_time_ms)

        delivery.on_market_event(_core_callback)

        await delivery.deliver_event(_market_event(60_000))
        await delivery.deliver_event(_market_event(120_000))

        assert calls == [60_000, 120_000]
        assert subscriber.queue_size == 1
        assert delivery.metrics.get_counter("queue_drops") == 1

        await subscriber.close()

    asyncio.run(_run())


def test_gap_event_reaches_ordered_callback_and_queue_subscriber() -> None:
    async def _run() -> None:
        delivery = DeliveryLayer(IngestionConfig(delivery_queue_size=2), _descriptor())
        subscriber = delivery.create_queue_subscriber()
        gaps: list[GapMarker] = []

        async def _gap_callback(gap: GapMarker) -> None:
            gaps.append(gap)

        delivery.on_gap(_gap_callback)
        gap = _gap()

        await delivery.deliver_gap(gap)
        queued = await asyncio.wait_for(subscriber.__aiter__().__anext__(), timeout=1)

        assert gaps == [gap]
        assert queued.event_type == "gap"
        assert queued.gap is gap

        await subscriber.close()

    asyncio.run(_run())


def test_close_all_subscribers_unblocks_full_queue() -> None:
    async def _run() -> None:
        delivery = DeliveryLayer(IngestionConfig(delivery_queue_size=1), _descriptor())
        subscriber = delivery.create_queue_subscriber(maxsize=1)

        await delivery.deliver_event(_market_event())
        assert subscriber.queue_size == 1

        await delivery.close_all_subscribers()
        seen: list[object] = []
        async for event in subscriber:
            seen.append(event)

        assert seen == []
        assert delivery.metrics.get_counter("queue_close_drops") == 1
        assert delivery.snapshot()["active_subscribers"] == 0

    asyncio.run(_run())
