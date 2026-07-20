from __future__ import annotations

import asyncio

from app.data_engine.data_manager.event_bus import DataEventBus, _SubscriberQueue
from app.data_engine.data_manager.models import DataEvent, DataEventType, SeriesKey


def test_event_bus_routes_only_wildcard_and_exact_topic_subscribers() -> None:
    async def _run() -> None:
        bus = DataEventBus()
        target = SeriesKey("BTC-USDT", "1m")
        delivered: list[str] = []

        async def _record(name: str, _event: DataEvent) -> None:
            delivered.append(name)

        wildcard = bus.subscribe(lambda event: _record("wildcard", event))
        exact = bus.subscribe(lambda event: _record("exact", event), key=target)
        for index in range(100):
            bus.subscribe(
                lambda event, index=index: _record(f"other-{index}", event),
                key=SeriesKey(f"OTHER-{index}", "1m"),
            )

        callbacks, queues = bus._matching_subscriptions(target)
        assert {sub_id for sub_id, _sub in callbacks} == {wildcard.id, exact.id}
        assert queues == []
        assert bus.get_subscriber_count(target) == 2

        await bus.emit(DataEvent(
            event_type=DataEventType.BAR_CLOSED,
            key=target,
        ))
        for _ in range(20):
            if len(delivered) == 2:
                break
            await asyncio.sleep(0)
        assert sorted(delivered) == ["exact", "wildcard"]

        bus.unsubscribe(exact)
        callbacks, _queues = bus._matching_subscriptions(target)
        assert [sub_id for sub_id, _sub in callbacks] == [wildcard.id]
        await bus.close()

    asyncio.run(_run())


def test_event_bus_routing_index_preserves_event_type_filters() -> None:
    async def _run() -> None:
        bus = DataEventBus()
        target = SeriesKey("BTC-USDT", "1m")
        delivered = asyncio.Event()

        async def _on_closed(_event: DataEvent) -> None:
            delivered.set()

        bus.subscribe(
            _on_closed,
            key=target,
            event_types={DataEventType.BAR_CLOSED},
        )
        await bus.emit(DataEvent(
            event_type=DataEventType.BAR_UPDATED,
            key=target,
        ))
        await asyncio.sleep(0)
        assert not delivered.is_set()

        await bus.emit(DataEvent(
            event_type=DataEventType.BAR_CLOSED,
            key=target,
        ))
        await asyncio.wait_for(delivered.wait(), timeout=1.0)
        await bus.close()

    asyncio.run(_run())


def test_event_bus_coalesces_only_pending_forming_updates_before_a_final() -> None:
    async def _run() -> None:
        bus = DataEventBus()
        target = SeriesKey("BTC-USDT", "1m")
        delivered: list[tuple[DataEventType, int]] = []

        async def _capture(event: DataEvent) -> None:
            delivered.append((event.event_type, int(event.detail["seq"])))

        handle = bus.subscribe(_capture, key=target)
        await bus.emit(DataEvent(
            event_type=DataEventType.BAR_UPDATED,
            key=target,
            detail={"seq": 1},
        ))
        await bus.emit(DataEvent(
            event_type=DataEventType.BAR_UPDATED,
            key=target,
            detail={"seq": 2},
        ))
        await bus.emit(DataEvent(
            event_type=DataEventType.BAR_CLOSED,
            key=target,
            detail={"seq": 3},
        ))
        await bus.emit(DataEvent(
            event_type=DataEventType.BAR_UPDATED,
            key=target,
            detail={"seq": 4},
        ))

        for _ in range(20):
            if len(delivered) == 3:
                break
            await asyncio.sleep(0)
        assert delivered == [
            (DataEventType.BAR_UPDATED, 2),
            (DataEventType.BAR_CLOSED, 3),
            (DataEventType.BAR_UPDATED, 4),
        ]
        assert bus.snapshot()["callback_lag"][handle.id]["coalesced"] == 1
        await bus.close()

    asyncio.run(_run())


def test_full_subscriber_queue_keeps_forming_slot_indexed_after_final_rejection() -> None:
    queue = _SubscriberQueue(maxsize=1)
    target = SeriesKey("BTC-USDT", "1m")

    assert queue.offer(DataEvent(
        event_type=DataEventType.BAR_UPDATED,
        key=target,
        detail={"seq": 1},
    )) == "queued"
    assert queue.offer(DataEvent(
        event_type=DataEventType.BAR_CLOSED,
        key=target,
        detail={"seq": 2},
    )) == "full"
    assert queue.offer(DataEvent(
        event_type=DataEventType.BAR_UPDATED,
        key=target,
        detail={"seq": 3},
    )) == "coalesced"

    pending = queue.get_nowait()
    assert pending is not None
    assert pending.event.detail["seq"] == 3
