from __future__ import annotations

import asyncio

from app.data_engine.data_manager.config import EventBusConfig
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


def test_full_subscriber_queue_evicts_preview_for_closed_bar() -> None:
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
    )) == "queued"
    assert queue.offer(DataEvent(
        event_type=DataEventType.BAR_UPDATED,
        key=target,
        detail={"seq": 3},
    )) == "full"

    pending = queue.get_nowait()
    assert pending is not None
    assert pending.event.event_type == DataEventType.BAR_CLOSED
    assert pending.event.detail["seq"] == 2


def test_full_subscriber_queue_evicts_preview_for_lossless_amendment() -> None:
    queue = _SubscriberQueue(maxsize=1)
    target = SeriesKey("BTC-USDT", "1m")

    assert queue.offer(DataEvent(
        event_type=DataEventType.BAR_UPDATED,
        key=target,
        detail={"seq": 1},
    )) == "queued"
    assert queue.offer(DataEvent(
        event_type=DataEventType.BAR_AMENDED,
        key=target,
        detail={"seq": 2},
    )) == "queued"

    assert queue.qsize() == 1
    pending = queue.get_nowait()
    assert pending is not None
    assert pending.event.event_type == DataEventType.BAR_AMENDED
    assert pending.event.detail["seq"] == 2

    # The evicted forming slot was also removed from the coalescing index.
    assert queue.offer(DataEvent(
        event_type=DataEventType.BAR_UPDATED,
        key=target,
        detail={"seq": 3},
    )) == "queued"


def test_lossless_finality_lane_is_hard_bounded_and_ordered() -> None:
    async def _run() -> None:
        queue = _SubscriberQueue(maxsize=1)
        target = SeriesKey("BTC-USDT", "1m")
        first = DataEvent(
            event_type=DataEventType.BAR_CLOSED,
            key=target,
            detail={"seq": 1},
        )
        second = DataEvent(
            event_type=DataEventType.BACKFILL_COMPLETED,
            key=target,
            detail={"seq": 2, "request_id": "parent-2"},
        )

        assert queue.offer(first) == "queued"
        assert queue.offer(second) == "critical_full"
        put_task = asyncio.create_task(queue.put_lossless(second))
        await asyncio.sleep(0)
        assert not put_task.done()
        assert queue.qsize() == queue.maxsize == 1

        pending = queue.get_nowait()
        assert pending is not None and pending.event.detail["seq"] == 1
        assert await asyncio.wait_for(put_task, timeout=0.2) is True
        assert queue.qsize() == queue.maxsize == 1
        pending = queue.get_nowait()
        assert pending is not None and pending.event.detail["seq"] == 2

    asyncio.run(_run())


def test_event_bus_lossless_finality_does_not_increment_drop_metrics() -> None:
    async def _run() -> None:
        bus = DataEventBus(EventBusConfig(subscriber_queue_size=1))
        target = SeriesKey("BTC-USDT", "1m")
        delivered: list[int] = []
        release_first = asyncio.Event()

        async def _capture(event: DataEvent) -> None:
            delivered.append(int(event.detail["seq"]))
            if event.detail["seq"] == 1:
                await release_first.wait()

        handle = bus.subscribe(
            _capture,
            event_types={
                DataEventType.BAR_CLOSED,
                DataEventType.BAR_AMENDED,
                DataEventType.BACKFILL_COMPLETED,
            },
        )
        await bus.emit(DataEvent(
            event_type=DataEventType.BAR_CLOSED,
            key=target,
            detail={"seq": 1},
        ))
        await asyncio.sleep(0)
        assert delivered == [1]

        await bus.emit(DataEvent(
            event_type=DataEventType.BACKFILL_COMPLETED,
            key=target,
            detail={"seq": 2, "request_id": "parent-2"},
        ))
        third_emit = asyncio.create_task(bus.emit(DataEvent(
            event_type=DataEventType.BAR_AMENDED,
            key=target,
            detail={"seq": 3},
        )))
        loop_progressed = asyncio.Event()
        asyncio.get_running_loop().call_soon(loop_progressed.set)
        await asyncio.wait_for(loop_progressed.wait(), timeout=0.2)

        # The third parent is asynchronously backpressured, not stored beyond
        # the hard queue bound, while unrelated event-loop work still runs.
        assert not third_emit.done()
        sub = bus._callback_subs[handle.id]
        assert sub.queue.qsize() == sub.queue.maxsize == 1
        assert bus.snapshot()["callback_lag"][handle.id]["backpressured"] == 1

        release_first.set()
        await asyncio.wait_for(third_emit, timeout=0.2)

        for _ in range(20):
            if len(delivered) == 3:
                break
            await asyncio.sleep(0)
        assert delivered == [1, 2, 3]
        snapshot = bus.snapshot()
        assert snapshot["events_dropped"] == 0
        assert snapshot["callback_lag"][handle.id]["dropped"] == 0
        assert snapshot["callback_lag"][handle.id]["backpressured"] == 1
        await bus.close()

    asyncio.run(_run())


def test_iterator_close_wakes_lossless_backpressure() -> None:
    async def _run() -> None:
        bus = DataEventBus(EventBusConfig(subscriber_queue_size=1))
        target = SeriesKey("BTC-USDT", "1m")
        iterator = bus.subscribe_iter(event_types={
            DataEventType.BAR_CLOSED,
            DataEventType.BAR_AMENDED,
            DataEventType.BACKFILL_COMPLETED,
        })
        first_next = asyncio.create_task(anext(iterator))
        await asyncio.sleep(0)
        assert len(bus._queue_subs) == 1
        sub = next(iter(bus._queue_subs.values()))

        await bus.emit(DataEvent(
            event_type=DataEventType.BAR_CLOSED,
            key=target,
            detail={"seq": 1},
        ))
        first = await asyncio.wait_for(first_next, timeout=0.2)
        assert first.detail["seq"] == 1

        await bus.emit(DataEvent(
            event_type=DataEventType.BAR_AMENDED,
            key=target,
            detail={"seq": 2},
        ))
        blocked_emit = asyncio.create_task(bus.emit(DataEvent(
            event_type=DataEventType.BACKFILL_COMPLETED,
            key=target,
            detail={"seq": 3, "request_id": "parent-3"},
        )))
        await asyncio.sleep(0)
        assert not blocked_emit.done()
        assert sub.queue.qsize() == sub.queue.maxsize == 1

        await iterator.aclose()
        await asyncio.wait_for(blocked_emit, timeout=0.2)

        assert bus._queue_subs == {}
        assert sub.backpressured == 1
        assert sub.dropped == 0
        assert sub.queue.qsize() == 1
        assert sub.queue.get_nowait() is None
        await bus.close()

    asyncio.run(_run())


def test_unsubscribe_wakes_lossless_backpressure_before_sentinel() -> None:
    async def _run() -> None:
        bus = DataEventBus(EventBusConfig(subscriber_queue_size=1))
        target = SeriesKey("BTC-USDT", "1m")
        release_first = asyncio.Event()

        async def _capture(event: DataEvent) -> None:
            if event.detail["seq"] == 1:
                await release_first.wait()

        handle = bus.subscribe(_capture)
        sub = bus._callback_subs[handle.id]
        await bus.emit(DataEvent(
            event_type=DataEventType.BAR_AMENDED,
            key=target,
            detail={"seq": 1},
        ))
        await asyncio.sleep(0)
        await bus.emit(DataEvent(
            event_type=DataEventType.BAR_AMENDED,
            key=target,
            detail={"seq": 2},
        ))
        blocked_emit = asyncio.create_task(bus.emit(DataEvent(
            event_type=DataEventType.BAR_AMENDED,
            key=target,
            detail={"seq": 3},
        )))
        await asyncio.sleep(0)
        assert not blocked_emit.done()
        assert sub.queue.qsize() == sub.queue.maxsize == 1

        bus.unsubscribe(handle)
        await asyncio.wait_for(blocked_emit, timeout=0.2)

        assert handle.id not in bus._callback_subs
        assert sub.queue.qsize() == 1
        assert sub.queue.get_nowait() is None
        assert sub.queue._latest_forming == {}
        assert sub.task is not None and sub.task.cancelled()
        await bus.close()

    asyncio.run(_run())
