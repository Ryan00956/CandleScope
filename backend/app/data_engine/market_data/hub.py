"""Latest-wins fanout for advanced market-data streams."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import AsyncIterator, Iterable

from .events import HubRecord, MarketStateEvent
from .models import MarketStreamKey


class MarketHubSubscription:
    """Per-consumer coalescing buffer bounded by distinct stream keys."""

    def __init__(
        self,
        hub: "MarketEventHub",
        keys: Iterable[MarketStreamKey],
        *,
        max_pending: int,
    ) -> None:
        self._hub = hub
        self._keys = set(keys)
        self._max_pending = max(1, int(max_pending))
        self._pending: OrderedDict[MarketStreamKey, HubRecord] = OrderedDict()
        self._ready = asyncio.Event()
        self._closed = False

    @property
    def keys(self) -> frozenset[MarketStreamKey]:
        return frozenset(self._keys)

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    @property
    def closed(self) -> bool:
        return self._closed

    def add_keys(self, keys: Iterable[MarketStreamKey], *, replay: bool = True) -> None:
        added = set(keys) - self._keys
        self._keys.update(added)
        if replay:
            for record in self._hub.snapshot(added):
                self._offer(record)

    def remove_keys(self, keys: Iterable[MarketStreamKey]) -> None:
        removed = set(keys)
        self._keys.difference_update(removed)
        for key in removed:
            self._pending.pop(key, None)
        if not self._pending:
            self._ready.clear()

    async def receive(self) -> HubRecord | None:
        while True:
            if self._pending:
                _key, record = self._pending.popitem(last=False)
                if not self._pending:
                    self._ready.clear()
                return record
            if self._closed:
                return None
            await self._ready.wait()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._hub._remove_subscription(self)
        self._ready.set()

    def __aiter__(self) -> AsyncIterator[HubRecord]:
        return self._iterate()

    async def _iterate(self) -> AsyncIterator[HubRecord]:
        try:
            while True:
                record = await self.receive()
                if record is None:
                    return
                yield record
        finally:
            await self.close()

    def _offer(self, record: HubRecord) -> tuple[bool, bool]:
        if self._closed or record.event.key not in self._keys:
            return False, False

        key = record.event.key
        coalesced = key in self._pending
        dropped = False
        if coalesced:
            self._pending[key] = record
            self._pending.move_to_end(key)
        else:
            if len(self._pending) >= self._max_pending:
                self._pending.popitem(last=False)
                dropped = True
            self._pending[key] = record
        self._ready.set()
        return coalesced, dropped

    def _close_from_hub(self) -> None:
        self._closed = True
        self._ready.set()


class MarketEventHub:
    """Typed, bounded, latest-state store and non-blocking fanout."""

    def __init__(self, *, max_states: int = 4096, default_max_pending: int = 64) -> None:
        self._max_states = max(1, int(max_states))
        self._default_max_pending = max(1, int(default_max_pending))
        self._latest: OrderedDict[MarketStreamKey, HubRecord] = OrderedDict()
        self._revisions: dict[MarketStreamKey, int] = {}
        self._subscriptions: set[MarketHubSubscription] = set()
        self._closed = False
        self._metrics = {
            "published": 0,
            "stale_rejected": 0,
            "capacity_rejected": 0,
            "capacity_evicted": 0,
            "subscriber_coalesced": 0,
            "subscriber_dropped": 0,
            "subscriptions_total": 0,
        }

    def publish(self, event: MarketStateEvent) -> HubRecord | None:
        """Publish without awaiting consumers; reject state regression."""

        if self._closed:
            return None
        current = self._latest.get(event.key)
        if current is not None and not self._is_newer(event, current.event):
            self._metrics["stale_rejected"] += 1
            return None
        if current is None and len(self._latest) >= self._max_states:
            if not self._evict_oldest_inactive():
                self._metrics["capacity_rejected"] += 1
                return None

        revision = self._revisions.get(event.key, 0) + 1
        record = HubRecord(event=event, revision=revision)
        self._latest[event.key] = record
        self._latest.move_to_end(event.key)
        self._revisions[event.key] = revision
        self._metrics["published"] += 1

        for subscription in tuple(self._subscriptions):
            coalesced, dropped = subscription._offer(record)
            if coalesced:
                self._metrics["subscriber_coalesced"] += 1
            if dropped:
                self._metrics["subscriber_dropped"] += 1
        return record

    def seed(self, events: Iterable[MarketStateEvent]) -> list[HubRecord]:
        records: list[HubRecord] = []
        for event in events:
            record = self.publish(event)
            if record is not None:
                records.append(record)
        return records

    def snapshot(
        self,
        keys: Iterable[MarketStreamKey] | None = None,
    ) -> list[HubRecord]:
        if keys is None:
            return list(self._latest.values())
        return [self._latest[key] for key in keys if key in self._latest]

    def subscribe(
        self,
        keys: Iterable[MarketStreamKey],
        *,
        max_pending: int | None = None,
        replay: bool = True,
    ) -> MarketHubSubscription:
        if self._closed:
            raise RuntimeError("market event hub is closed")
        subscription = MarketHubSubscription(
            self,
            keys,
            max_pending=max_pending or self._default_max_pending,
        )
        self._subscriptions.add(subscription)
        self._metrics["subscriptions_total"] += 1
        if replay:
            for record in self.snapshot(subscription.keys):
                subscription._offer(record)
        return subscription

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for subscription in tuple(self._subscriptions):
            subscription._close_from_hub()
        self._subscriptions.clear()

    def diagnostics(self) -> dict:
        return {
            "closed": self._closed,
            "states": len(self._latest),
            "max_states": self._max_states,
            "active_subscribers": len(self._subscriptions),
            "pending_records": sum(item.pending_count for item in self._subscriptions),
            **self._metrics,
        }

    def _remove_subscription(self, subscription: MarketHubSubscription) -> None:
        self._subscriptions.discard(subscription)

    def _evict_oldest_inactive(self) -> bool:
        active_keys = {
            key
            for subscription in self._subscriptions
            for key in subscription._keys
        }
        for key in tuple(self._latest):
            if key in active_keys:
                continue
            self._latest.pop(key, None)
            self._revisions.pop(key, None)
            self._metrics["capacity_evicted"] += 1
            return True
        return False

    @staticmethod
    def _is_newer(candidate: MarketStateEvent, current: MarketStateEvent) -> bool:
        if candidate.sequence is not None and current.sequence is not None:
            if candidate.sequence != current.sequence:
                return candidate.sequence > current.sequence
        return (
            candidate.event_time_ms,
            candidate.received_at_ms,
        ) > (
            current.event_time_ms,
            current.received_at_ms,
        )
