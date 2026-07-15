"""Bounded append/batch fanout for high-frequency market-data records.

Unlike :mod:`app.data_engine.market_data.hub`, this hub never coalesces records
by logical stream key.  Producers append every accepted record and an external
20--100 ms scheduler calls :meth:`AppendBatchHub.flush`.  Both the producer
buffer and every subscriber buffer are bounded, so a slow consumer cannot
apply backpressure to the ingestion path.
"""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import AsyncIterator, Callable, Iterable
from dataclasses import dataclass
from typing import Generic, TypeVar


RecordT = TypeVar("RecordT")


@dataclass(frozen=True, slots=True)
class AppendBatch(Generic[RecordT]):
    """One process-local, ordered batch of append-only records.

    ``sequence`` is diagnostic only: filtered subscriptions naturally observe
    gaps in the global sequence.  Consumers must use ``continuity`` and
    ``resync_required`` to decide whether their local cursor is still valid.
    """

    sequence: int
    records: tuple[RecordT, ...]
    continuity: bool = True
    resync_required: bool = False
    dropped_before: int = 0

    def __len__(self) -> int:
        return len(self.records)


class AppendBatchSubscription(Generic[RecordT]):
    """A bounded, non-blocking view of batches published by one hub."""

    def __init__(
        self,
        hub: AppendBatchHub[RecordT],
        *,
        max_pending_records: int,
        predicate: Callable[[RecordT], bool] | None,
    ) -> None:
        self._hub = hub
        self._max_pending_records = max(1, int(max_pending_records))
        self._predicate = predicate
        self._pending: deque[AppendBatch[RecordT]] = deque()
        self._pending_records = 0
        self._ready = asyncio.Event()
        self._closed = False
        self._dropped_batches = 0
        self._dropped_records = 0
        self._deferred_dropped_before = 0

    @property
    def pending_batch_count(self) -> int:
        return len(self._pending)

    @property
    def pending_record_count(self) -> int:
        return self._pending_records

    @property
    def dropped_batches(self) -> int:
        return self._dropped_batches

    @property
    def dropped_records(self) -> int:
        return self._dropped_records

    @property
    def closed(self) -> bool:
        return self._closed

    async def receive(self) -> AppendBatch[RecordT] | None:
        while True:
            if self._pending:
                batch = self._pending.popleft()
                self._pending_records -= len(batch)
                if not self._pending:
                    self._ready.clear()
                return batch
            if self._closed:
                return None
            await self._ready.wait()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._hub._remove_subscription(self)
        self._ready.set()

    def __aiter__(self) -> AsyncIterator[AppendBatch[RecordT]]:
        return self._iterate()

    async def _iterate(self) -> AsyncIterator[AppendBatch[RecordT]]:
        try:
            while True:
                batch = await self.receive()
                if batch is None:
                    return
                yield batch
        finally:
            await self.close()

    def _offer(self, batch: AppendBatch[RecordT]) -> tuple[int, int]:
        if self._closed:
            return 0, 0

        records = batch.records
        if self._predicate is not None:
            records = tuple(record for record in records if self._predicate(record))
        if not records:
            if not batch.continuity:
                self._deferred_dropped_before += max(1, batch.dropped_before)
            return 0, 0

        dropped_batches = 0
        dropped_records = 0
        incoming_discontinuity = self._deferred_dropped_before
        queue_discontinuity = 0
        self._deferred_dropped_before = 0
        if not batch.continuity:
            incoming_discontinuity += max(1, batch.dropped_before)
        if len(records) > self._max_pending_records:
            trimmed = len(records) - self._max_pending_records
            dropped_records += trimmed
            incoming_discontinuity += trimmed
            records = records[-self._max_pending_records :]

        while self._pending and (
            self._pending_records + len(records) > self._max_pending_records
        ):
            stale = self._pending.popleft()
            self._pending_records -= len(stale)
            dropped_batches += 1
            dropped_records += len(stale)
            queue_discontinuity += len(stale)
            if not stale.continuity:
                queue_discontinuity += stale.dropped_before

        if queue_discontinuity and self._pending:
            first = self._pending.popleft()
            first_dropped = first.dropped_before if not first.continuity else 0
            self._pending.appendleft(
                AppendBatch(
                    sequence=first.sequence,
                    records=first.records,
                    continuity=False,
                    resync_required=True,
                    dropped_before=first_dropped + queue_discontinuity,
                ),
            )
        else:
            incoming_discontinuity += queue_discontinuity

        offered = AppendBatch(
            sequence=batch.sequence,
            records=records,
            continuity=incoming_discontinuity == 0,
            resync_required=incoming_discontinuity > 0,
            dropped_before=incoming_discontinuity,
        )
        self._pending.append(offered)
        self._pending_records += len(offered)
        self._dropped_batches += dropped_batches
        self._dropped_records += dropped_records
        self._ready.set()
        return dropped_batches, dropped_records

    def _close_from_hub(self) -> None:
        self._closed = True
        self._ready.set()


class AppendBatchHub(Generic[RecordT]):
    """Append-only producer buffer with explicit batching and bounded fanout."""

    def __init__(
        self,
        *,
        max_pending_records: int = 8192,
        max_batch_size: int = 1024,
        default_subscriber_max_pending_records: int = 4096,
    ) -> None:
        self._max_pending_records = max(1, int(max_pending_records))
        self._max_batch_size = max(1, int(max_batch_size))
        self._default_subscriber_max_pending_records = max(
            1,
            int(default_subscriber_max_pending_records),
        )
        self._pending: deque[RecordT] = deque()
        self._subscriptions: set[AppendBatchSubscription[RecordT]] = set()
        self._sequence = 0
        self._pending_dropped_since_flush = 0
        self._closed = False
        self._metrics = {
            "appended_records": 0,
            "pending_records_dropped": 0,
            "published_batches": 0,
            "published_records": 0,
            "subscriber_batches_dropped": 0,
            "subscriber_records_dropped": 0,
            "subscriptions_total": 0,
            "explicit_discontinuities": 0,
        }

    def mark_discontinuity(self, *, missing_records: int = 1) -> bool:
        """Mark the next published batch as requiring a consumer resync.

        This is used for source-level gaps, where no producer-buffer record was
        dropped locally but the append sequence is nevertheless incomplete.
        Multiple markers before a flush accumulate conservatively.
        """

        if self._closed:
            return False
        missing = max(1, int(missing_records))
        self._pending_dropped_since_flush += missing
        self._metrics["explicit_discontinuities"] += 1
        return True

    def append(self, record: RecordT) -> bool:
        """Append one record without waiting for subscribers.

        The oldest unflushed record is discarded if the producer-side buffer
        is full.  ``False`` only means the hub has already been closed.
        """

        if self._closed:
            return False
        if len(self._pending) >= self._max_pending_records:
            self._pending.popleft()
            self._metrics["pending_records_dropped"] += 1
            self._pending_dropped_since_flush += 1
        self._pending.append(record)
        self._metrics["appended_records"] += 1
        return True

    def extend(self, records: Iterable[RecordT]) -> int:
        accepted = 0
        for record in records:
            if not self.append(record):
                break
            accepted += 1
        return accepted

    def flush(self, *, max_records: int | None = None) -> AppendBatch[RecordT] | None:
        """Publish the oldest pending records as one ordered batch."""

        if self._closed or not self._pending:
            return None
        requested = self._max_batch_size if max_records is None else max(1, int(max_records))
        count = min(len(self._pending), self._max_batch_size, requested)
        records = tuple(self._pending.popleft() for _ in range(count))
        self._sequence += 1
        dropped_before = self._pending_dropped_since_flush
        self._pending_dropped_since_flush = 0
        batch = AppendBatch(
            sequence=self._sequence,
            records=records,
            continuity=dropped_before == 0,
            resync_required=dropped_before > 0,
            dropped_before=dropped_before,
        )
        self._metrics["published_batches"] += 1
        self._metrics["published_records"] += len(batch)

        for subscription in tuple(self._subscriptions):
            dropped_batches, dropped_records = subscription._offer(batch)
            self._metrics["subscriber_batches_dropped"] += dropped_batches
            self._metrics["subscriber_records_dropped"] += dropped_records
        return batch

    def flush_all(self) -> list[AppendBatch[RecordT]]:
        batches: list[AppendBatch[RecordT]] = []
        while self._pending:
            batch = self.flush()
            if batch is None:
                break
            batches.append(batch)
        return batches

    def subscribe(
        self,
        *,
        max_pending_records: int | None = None,
        predicate: Callable[[RecordT], bool] | None = None,
    ) -> AppendBatchSubscription[RecordT]:
        if self._closed:
            raise RuntimeError("append batch hub is closed")
        subscription = AppendBatchSubscription(
            self,
            max_pending_records=(
                max_pending_records or self._default_subscriber_max_pending_records
            ),
            predicate=predicate,
        )
        self._subscriptions.add(subscription)
        self._metrics["subscriptions_total"] += 1
        return subscription

    async def close(self, *, flush: bool = True) -> None:
        if self._closed:
            return
        if flush:
            self.flush_all()
        self._closed = True
        for subscription in tuple(self._subscriptions):
            subscription._close_from_hub()
        self._subscriptions.clear()

    def diagnostics(self) -> dict[str, int | bool]:
        return {
            "closed": self._closed,
            "pending_records": len(self._pending),
            "max_pending_records": self._max_pending_records,
            "max_batch_size": self._max_batch_size,
            "active_subscribers": len(self._subscriptions),
            "subscriber_pending_batches": sum(
                item.pending_batch_count for item in self._subscriptions
            ),
            "subscriber_pending_records": sum(
                item.pending_record_count for item in self._subscriptions
            ),
            **self._metrics,
        }

    def _remove_subscription(self, subscription: AppendBatchSubscription[RecordT]) -> None:
        self._subscriptions.discard(subscription)
