"""
Event Bus — topic-based pub/sub for Data Manager events.

The event bus sits at the center of the Data Manager, connecting
producers (ingestion → bar_aggregator, backfill, cache) to consumers
(WebSocket hub, indicator engine, strategy engine, logging, etc.).

Features:
  * **Topic routing** — events are keyed by ``SeriesKey`` (symbol@interval).
    Subscribers can listen to a specific topic or to all topics (wildcard).
  * **Callback delivery** — registered async callbacks are isolated behind
    per-subscriber bounded queues.
  * **Async-iterator delivery** — ``subscribe_iter()`` returns an
    ``AsyncIterator[DataEvent]`` backed by a bounded queue.
  * **Type filtering** — subscribers can filter by ``DataEventType``.
  * **Middleware** — pluggable pre-emit hooks for metrics, logging, etc.

Design constraints:
  * The bus is **in-process only** — no network transport.
  * Callbacks should still be reasonably fast, but a slow callback no longer
    blocks producers or other subscribers.
  * Queue-based subscribers that fall behind will have events dropped
    (bounded queue with backpressure).

Usage::

    bus = DataEventBus(config)

    # Callback style
    handle = bus.subscribe(
        key=SeriesKey("BTCUSDT", "1m"),
        event_types={DataEventType.BAR_CLOSED},
        callback=my_handler,
    )
    bus.unsubscribe(handle)

    # Async iterator style
    async for event in bus.subscribe_iter(
        key=SeriesKey("BTCUSDT", "1m"),
    ):
        process(event)

    # Wildcard — all events
    handle = bus.subscribe(callback=my_global_handler)

    # Emit an event
    await bus.emit(event)
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable, Awaitable

from .config import EventBusConfig
from .models import (
    DataEvent,
    DataEventType,
    EventCallback,
    SeriesKey,
    SubscriptionHandle,
)

logger = logging.getLogger("data_manager.event_bus")

# Type for middleware hooks
MiddlewareHook = Callable[[DataEvent], Awaitable[DataEvent | None]]


@dataclass(slots=True)
class _QueuedEvent:
    event: DataEvent
    enqueued_at: float


@dataclass(slots=True)
class _CallbackSubscription:
    queue: asyncio.Queue[_QueuedEvent | None]
    handle: SubscriptionHandle
    task: asyncio.Task | None = None
    dropped: int = 0
    last_error: str | None = None
    delivered: int = 0
    total_lag_ms: float = 0.0
    max_lag_ms: float = 0.0
    last_lag_ms: float = 0.0


@dataclass(slots=True)
class _QueueSubscription:
    queue: asyncio.Queue[_QueuedEvent | None]
    handle: SubscriptionHandle
    dropped: int = 0
    delivered: int = 0
    total_lag_ms: float = 0.0
    max_lag_ms: float = 0.0
    last_lag_ms: float = 0.0


class DataEventBus:
    """In-process, topic-based event bus for Data Manager events.

    Central nervous system of the Data Manager — all bar lifecycle
    events, stream events, and system events flow through here.

    Thread-safety: the bus is designed to be used from a single asyncio
    event loop.  ``emit()`` is async and should be awaited.
    """

    def __init__(
        self,
        config: EventBusConfig | None = None,
        *,
        protection_lock: Any | None = None,
        on_subscription_change: Callable[[], None] | None = None,
    ) -> None:
        self._cfg = config or EventBusConfig()
        self._protection_lock = protection_lock or threading.RLock()
        self._on_subscription_change = on_subscription_change

        # Callback subscriptions: handle.id → SubscriptionHandle
        self._subscriptions: dict[str, SubscriptionHandle] = {}

        # Callback subscriptions delivered through per-subscriber worker queues.
        self._callback_subs: dict[str, _CallbackSubscription] = {}

        # Queue-based subscriptions: handle.id → (queue, handle)
        self._queue_subs: dict[str, _QueueSubscription] = {}

        # Middleware chain (pre-emit hooks)
        self._middleware: list[MiddlewareHook] = []

        # Metrics
        self._events_emitted = 0
        self._events_dropped = 0
        self._callback_errors = 0

    # ── Public: Subscription (callback) ──────────────────────

    def subscribe(
        self,
        callback: EventCallback,
        key: SeriesKey | None = None,
        event_types: set[DataEventType] | None = None,
    ) -> SubscriptionHandle:
        """Register a callback to receive events.

        Args:
            callback:    Async function called for each matching event.
            key:         Filter to this (symbol, interval).  None = all.
            event_types: Filter to these event types.  None = all types.

        Returns:
            A ``SubscriptionHandle`` — pass to ``unsubscribe()`` to stop.

        Example::

            async def on_bar_closed(event: DataEvent):
                print(f"Bar closed: {event.bar}")

            handle = bus.subscribe(
                callback=on_bar_closed,
                key=SeriesKey("BTCUSDT", "1m"),
                event_types={DataEventType.BAR_CLOSED},
            )
        """
        handle = SubscriptionHandle(
            key=key,
            event_types=event_types,
            callback=callback,
        )
        queue: asyncio.Queue[_QueuedEvent | None] = asyncio.Queue(
            maxsize=self._cfg.subscriber_queue_size,
        )
        sub = _CallbackSubscription(queue=queue, handle=handle)
        with self._protection_lock:
            self._subscriptions[handle.id] = handle
            self._callback_subs[handle.id] = sub
            if self._on_subscription_change is not None:
                self._on_subscription_change()
        self._ensure_callback_worker(sub)
        logger.debug(
            "Subscription added: id=%s key=%s types=%s",
            handle.id, key, event_types,
        )
        return handle

    def unsubscribe(self, handle: SubscriptionHandle) -> None:
        """Remove a callback subscription."""
        with self._protection_lock:
            removed = self._subscriptions.pop(handle.id, None)
            callback_entry = self._callback_subs.pop(handle.id, None)
            entry = self._queue_subs.pop(handle.id, None)
            if (
                (removed is not None or callback_entry is not None or entry is not None)
                and self._on_subscription_change is not None
            ):
                self._on_subscription_change()
        if removed:
            logger.debug("Subscription removed: id=%s", handle.id)

        if callback_entry:
            self._put_sentinel(callback_entry.queue)
            if callback_entry.task is not None:
                callback_entry.task.cancel()
            logger.debug("Callback subscription removed: id=%s", handle.id)

        # Also check queue subscriptions
        if entry:
            self._put_sentinel(entry.queue)
            logger.debug("Queue subscription removed: id=%s", handle.id)

    # ── Public: Subscription (async iterator) ────────────────

    async def subscribe_iter(
        self,
        key: SeriesKey | None = None,
        event_types: set[DataEventType] | None = None,
    ) -> AsyncIterator[DataEvent]:
        """Subscribe as an async iterator.

        Yields ``DataEvent`` objects matching the optional filters.
        Break out of the loop to unsubscribe.

        Usage::

            async for event in bus.subscribe_iter(
                key=SeriesKey("BTCUSDT", "1m"),
                event_types={DataEventType.BAR_CLOSED, DataEventType.BAR_UPDATED},
            ):
                push_to_websocket(event)
        """
        queue: asyncio.Queue[_QueuedEvent | None] = asyncio.Queue(
            maxsize=self._cfg.subscriber_queue_size,
        )
        handle = SubscriptionHandle(
            key=key,
            event_types=event_types,
        )
        sub = _QueueSubscription(queue=queue, handle=handle)
        with self._protection_lock:
            self._queue_subs[handle.id] = sub
            if self._on_subscription_change is not None:
                self._on_subscription_change()
        logger.debug(
            "Iterator subscription added: id=%s key=%s", handle.id, key,
        )

        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                self._record_queue_lag(sub, item.enqueued_at)
                yield item.event
        finally:
            with self._protection_lock:
                removed = self._queue_subs.pop(handle.id, None)
                if removed is not None and self._on_subscription_change is not None:
                    self._on_subscription_change()
            logger.debug(
                "Iterator subscription removed: id=%s", handle.id,
            )

    # ── Public: Emit ─────────────────────────────────────────

    async def emit(self, event: DataEvent) -> None:
        """Emit an event to all matching subscribers.

        The event flows through the middleware chain first.  If any
        middleware returns ``None``, the event is suppressed.

        Then it is delivered to callback and iterator subscribers via
        non-blocking queue puts. Slow callbacks are isolated to their own
        queues and do not block this emit call.
        """
        # Apply config-level filters
        if not self._should_emit(event):
            return

        # Middleware chain
        processed: DataEvent | None = event
        for mw in self._middleware:
            try:
                processed = await mw(processed)
            except Exception as exc:
                logger.error("Middleware error: %s", exc, exc_info=True)
                processed = event  # fall through on error
            if processed is None:
                return  # middleware suppressed the event

        event = processed
        self._events_emitted += 1

        # Callback subscribers
        for sub_id, sub in list(self._callback_subs.items()):
            handle = sub.handle
            if not handle.matches(event):
                continue
            if handle.callback is None:
                continue
            self._ensure_callback_worker(sub)
            if not self._put_event_nowait(sub.queue, event):
                sub.dropped += 1
                self._events_dropped += 1
                logger.warning(
                    "Callback subscriber %s full, dropping event", sub_id,
                )

        # Queue subscribers
        for sub_id, sub in list(self._queue_subs.items()):
            handle = sub.handle
            if not handle.matches(event):
                continue
            if not self._put_event_nowait(sub.queue, event):
                sub.dropped += 1
                self._events_dropped += 1
                logger.warning(
                    "Queue subscriber %s full, dropping event", sub_id,
                )

    async def emit_many(self, events: list[DataEvent]) -> None:
        """Emit multiple events in sequence."""
        for event in events:
            await self.emit(event)

    # ── Public: Middleware ────────────────────────────────────

    def add_middleware(self, hook: MiddlewareHook) -> None:
        """Register a pre-emit middleware hook.

        Middleware runs **before** subscribers receive the event.
        The hook receives a ``DataEvent`` and must return either:
          * The same or modified ``DataEvent`` — continue delivery
          * ``None`` — suppress the event entirely

        Use cases:
          * Logging / metrics
          * Event transformation
          * Rate limiting
          * Access control

        Example::

            async def log_middleware(event: DataEvent) -> DataEvent:
                logger.info("Event: %s %s", event.event_type, event.key)
                return event

            bus.add_middleware(log_middleware)
        """
        self._middleware.append(hook)

    def remove_middleware(self, hook: MiddlewareHook) -> None:
        """Remove a previously registered middleware hook."""
        self._middleware = [m for m in self._middleware if m is not hook]

    # ── Public: Close ────────────────────────────────────────

    async def close(self) -> None:
        """Send sentinel to all queue subscribers and clear everything."""
        callback_tasks: list[asyncio.Task] = []
        for sub_id, sub in list(self._callback_subs.items()):
            self._put_sentinel(sub.queue)
            if sub.task is not None:
                sub.task.cancel()
                callback_tasks.append(sub.task)
            logger.debug("Callback subscription closed: id=%s", sub_id)
        if callback_tasks:
            await asyncio.gather(*callback_tasks, return_exceptions=True)
        for sub_id, sub in list(self._queue_subs.items()):
            self._put_sentinel(sub.queue)
        with self._protection_lock:
            changed = bool(
                self._callback_subs or self._queue_subs or self._subscriptions
            )
            self._callback_subs.clear()
            self._queue_subs.clear()
            self._subscriptions.clear()
            if changed and self._on_subscription_change is not None:
                self._on_subscription_change()
        logger.info("Event bus closed")

    # ── Public: Introspection ────────────────────────────────

    def get_subscriber_count(self, key: SeriesKey | None = None) -> int:
        """Count active subscribers, optionally filtered by key."""
        with self._protection_lock:
            count = 0
            for handle in self._subscriptions.values():
                if key is None or handle.key is None or handle.key == key:
                    count += 1
            for _, sub in self._queue_subs.items():
                handle = sub.handle
                if key is None or handle.key is None or handle.key == key:
                    count += 1
            return count

    def get_direct_subscriber_count(self, key: SeriesKey) -> int:
        """Count subscribers that explicitly retain one series.

        Wildcard subscriptions are event observers.  They receive matching
        events for every series, but they do not express lifecycle ownership
        of every cache entry or upstream stream.
        """
        with self._protection_lock:
            count = sum(
                1
                for handle in self._subscriptions.values()
                if handle.key == key
            )
            count += sum(
                1
                for sub in self._queue_subs.values()
                if sub.handle.key == key
            )
            return count

    def get_all_subscribed_keys(self) -> set[SeriesKey]:
        """Return all SeriesKeys that have at least one subscriber."""
        with self._protection_lock:
            keys: set[SeriesKey] = set()
            for handle in self._subscriptions.values():
                if handle.key is not None:
                    keys.add(handle.key)
            for _, sub in self._queue_subs.items():
                handle = sub.handle
                if handle.key is not None:
                    keys.add(handle.key)
            return keys

    # ── Public: Snapshot ─────────────────────────────────────

    def snapshot(self) -> dict:
        """JSON-serializable diagnostic snapshot."""
        return {
            "callback_subscriptions": len(self._subscriptions),
            "queue_subscriptions": len(self._queue_subs),
            "middleware_count": len(self._middleware),
            "events_emitted": self._events_emitted,
            "events_dropped": self._events_dropped,
            "callback_errors": self._callback_errors,
            "callback_queue_drops": {
                sub_id: sub.dropped
                for sub_id, sub in self._callback_subs.items()
                if sub.dropped
            },
            "callback_last_errors": {
                sub_id: sub.last_error
                for sub_id, sub in self._callback_subs.items()
                if sub.last_error
            },
            "callback_lag": {
                sub_id: self._lag_snapshot(sub)
                for sub_id, sub in self._callback_subs.items()
                if sub.delivered or sub.dropped or sub.queue.qsize()
            },
            "queue_lag": {
                sub_id: self._lag_snapshot(sub)
                for sub_id, sub in self._queue_subs.items()
                if sub.delivered or sub.dropped or sub.queue.qsize()
            },
            "subscribed_keys": [
                str(k) for k in self.get_all_subscribed_keys()
            ],
        }

    # ── Internal ─────────────────────────────────────────────

    def _should_emit(self, event: DataEvent) -> bool:
        """Apply config-level event filters."""
        et = event.event_type
        if et == DataEventType.BAR_UPDATED and not self._cfg.emit_bar_updated:
            return False
        if et == DataEventType.BAR_CREATED and not self._cfg.emit_bar_created:
            return False
        return True

    def _ensure_callback_worker(self, sub: _CallbackSubscription) -> None:
        if sub.task is not None and not sub.task.done():
            return
        try:
            asyncio.get_running_loop()
            sub.task = asyncio.create_task(
                self._callback_worker(sub),
                name=f"event-bus-callback:{sub.handle.id}",
            )
        except RuntimeError:
            # subscribe() may run during setup before an event loop exists.
            # The worker will be started on the first emit inside a loop.
            sub.task = None

    async def _callback_worker(self, sub: _CallbackSubscription) -> None:
        handle = sub.handle
        while True:
            item = await sub.queue.get()
            if item is None:
                return
            if handle.callback is None:
                continue
            self._record_queue_lag(sub, item.enqueued_at)
            try:
                await handle.callback(item.event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                sub.last_error = str(exc)
                self._callback_errors += 1
                logger.error(
                    "Event callback error (sub=%s): %s",
                    handle.id, exc, exc_info=True,
                )

    @staticmethod
    def _put_sentinel(queue: asyncio.Queue[_QueuedEvent | None]) -> None:
        try:
            queue.put_nowait(None)
            return
        except asyncio.QueueFull:
            pass
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
        try:
            queue.put_nowait(None)
        except asyncio.QueueFull:
            pass

    @staticmethod
    def _put_event_nowait(
        queue: asyncio.Queue[_QueuedEvent | None],
        event: DataEvent,
    ) -> bool:
        try:
            queue.put_nowait(_QueuedEvent(
                event=event,
                enqueued_at=time.perf_counter(),
            ))
            return True
        except asyncio.QueueFull:
            return False

    @staticmethod
    def _record_queue_lag(
        sub: _CallbackSubscription | _QueueSubscription,
        enqueued_at: float,
    ) -> None:
        lag_ms = max(0.0, (time.perf_counter() - enqueued_at) * 1000)
        sub.delivered += 1
        sub.total_lag_ms += lag_ms
        sub.max_lag_ms = max(sub.max_lag_ms, lag_ms)
        sub.last_lag_ms = lag_ms

    @staticmethod
    def _lag_snapshot(sub: _CallbackSubscription | _QueueSubscription) -> dict[str, Any]:
        avg = sub.total_lag_ms / sub.delivered if sub.delivered else 0.0
        return {
            "queue_size": sub.queue.qsize(),
            "queue_max_size": sub.queue.maxsize,
            "delivered": sub.delivered,
            "dropped": sub.dropped,
            "avg_lag_ms": round(avg, 2),
            "max_lag_ms": round(sub.max_lag_ms, 2),
            "last_lag_ms": round(sub.last_lag_ms, 2),
        }
