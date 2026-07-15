from __future__ import annotations

import asyncio
from functools import wraps

from app.data_engine.market_data.append_hub import AppendBatchHub


def _async_test(function):
    @wraps(function)
    def _wrapped():
        return asyncio.run(function())

    return _wrapped


@_async_test
async def test_append_records_are_not_coalesced_and_external_flush_batches_them() -> None:
    hub = AppendBatchHub[int](max_batch_size=8)
    subscription = hub.subscribe()
    hub.extend([1, 2, 3])

    assert subscription.pending_record_count == 0
    batch = hub.flush()
    assert batch is not None and batch.records == (1, 2, 3)
    delivered = await subscription.receive()
    assert delivered is not None
    assert delivered.sequence == 1
    assert delivered.records == (1, 2, 3)
    assert hub.diagnostics()["published_records"] == 3

    await hub.close()


@_async_test
async def test_slow_subscriber_is_bounded_and_reports_dropped_records() -> None:
    hub = AppendBatchHub[int](max_batch_size=2)
    subscription = hub.subscribe(max_pending_records=3)
    hub.extend([1, 2])
    hub.flush()
    hub.extend([3, 4])
    hub.flush()

    assert subscription.pending_batch_count == 1
    assert subscription.pending_record_count == 2
    assert subscription.dropped_records == 2
    delivered = await subscription.receive()
    assert delivered is not None and delivered.records == (3, 4)
    assert delivered.continuity is False
    assert delivered.resync_required is True
    assert delivered.dropped_before == 2
    diagnostics = hub.diagnostics()
    assert diagnostics["subscriber_batches_dropped"] == 1
    assert diagnostics["subscriber_records_dropped"] == 2

    await hub.close()


@_async_test
async def test_subscriber_drop_marks_earliest_retained_batch_discontinuous() -> None:
    hub = AppendBatchHub[int](max_batch_size=2)
    subscription = hub.subscribe(max_pending_records=5)
    for values in ([1, 2], [3, 4], [5, 6]):
        hub.extend(values)
        hub.flush()

    first = await subscription.receive()
    second = await subscription.receive()
    assert first is not None and first.records == (3, 4)
    assert first.continuity is False
    assert first.resync_required is True
    assert first.dropped_before == 2
    assert second is not None and second.records == (5, 6)
    assert second.continuity is True
    await hub.close()


def test_producer_pending_buffer_drops_oldest_and_flush_respects_batch_limit() -> None:
    hub = AppendBatchHub[int](max_pending_records=3, max_batch_size=2)
    hub.extend([1, 2, 3, 4])

    first = hub.flush()
    second = hub.flush()

    assert first is not None and first.records == (2, 3)
    assert first.continuity is False
    assert first.resync_required is True
    assert first.dropped_before == 1
    assert second is not None and second.records == (4,)
    assert second.continuity is True
    assert hub.diagnostics()["pending_records_dropped"] == 1


def test_explicit_source_gap_marks_next_batch_discontinuous() -> None:
    hub = AppendBatchHub[int](max_batch_size=8)
    hub.append(1)
    assert hub.mark_discontinuity(missing_records=2) is True
    hub.append(4)

    batch = hub.flush()

    assert batch is not None and batch.records == (1, 4)
    assert batch.continuity is False
    assert batch.resync_required is True
    assert batch.dropped_before == 2
    assert hub.diagnostics()["explicit_discontinuities"] == 1


@_async_test
async def test_producer_drop_marks_its_batch_not_an_older_queued_batch() -> None:
    hub = AppendBatchHub[int](max_pending_records=1, max_batch_size=1)
    subscription = hub.subscribe(max_pending_records=4)
    hub.append(1)
    hub.flush()
    hub.append(2)
    hub.append(3)
    hub.flush()

    older = await subscription.receive()
    discontinuous = await subscription.receive()
    assert older is not None and older.records == (1,)
    assert older.continuity is True
    assert discontinuous is not None and discontinuous.records == (3,)
    assert discontinuous.continuity is False
    assert discontinuous.dropped_before == 1
    await hub.close()


@_async_test
async def test_predicate_filters_without_affecting_other_subscribers_and_close_unblocks() -> None:
    hub = AppendBatchHub[int]()
    even = hub.subscribe(predicate=lambda item: item % 2 == 0)
    all_records = hub.subscribe()
    hub.extend([1, 2, 3, 4])
    hub.flush()

    even_batch = await even.receive()
    all_batch = await all_records.receive()
    assert even_batch is not None and even_batch.records == (2, 4)
    assert all_batch is not None and all_batch.records == (1, 2, 3, 4)

    waiting = asyncio.create_task(even.receive())
    await asyncio.sleep(0)
    await even.close()
    assert await waiting is None
    assert hub.diagnostics()["active_subscribers"] == 1
    await hub.close()


@_async_test
async def test_close_flushes_pending_records_before_ending_subscriptions() -> None:
    hub = AppendBatchHub[str]()
    subscription = hub.subscribe()
    hub.append("last")

    await hub.close(flush=True)

    batch = await subscription.receive()
    assert batch is not None and batch.records == ("last",)
    assert await subscription.receive() is None


@_async_test
async def test_close_without_flush_makes_later_flush_a_safe_noop() -> None:
    hub = AppendBatchHub[int]()
    hub.append(1)

    await hub.close(flush=False)

    assert hub.flush() is None
    assert hub.flush_all() == []
